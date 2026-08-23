import { ARTIFACT_TYPES, repository } from './repository.js';
import { AcceptanceCriterionSchema, RequirementSchema } from './artifacts/requirements.js';
import { OwnerDecisionRequestSchema, RiskSchema } from './artifacts/governance.js';
import { ResearchFindingSchema } from './artifacts/market.js';
import {
  AcceptanceVerdictSchema,
  DefectSchema,
  PerformanceVerdictSchema,
  QAVerdictSchema,
  SecurityFindingSchema,
  SecurityVerdictSchema,
  VerificationVerdict,
} from './artifacts/quality.js';
import {
  HandoverPackageSchema,
  OperationalReadinessVerdictSchema,
  ReleaseSchema,
} from './artifacts/release.js';
import { assessFreshness } from './research/freshness.js';
import { ValidityState } from '../vocab/index.js';
import type { Store } from '../store/store.js';
import type { Clock } from '../core/clock.js';

/**
 * RELEASE READINESS — DERIVED, NEVER DECLARED.
 *
 * SPEC: §16, §17, §31, §59.
 *
 * `READY_TO_RELEASE` is the single most dangerous string in a software company, because
 * everybody wants it to be true and it costs nothing to say. An agent can produce it. A
 * green dashboard can imply it. A Release Manager under pressure will recommend it.
 *
 * So nothing here asks anybody. Every line below is a question answered from the Store,
 * and a question whose evidence is missing answers NOT_VERIFIED — which blocks, exactly
 * like a failure, because the difference between "we checked and it is fine" and "nobody
 * checked" is the entire point.
 *
 * The check that no amount of engineering excellence can satisfy is `ownerAuthorised`.
 * Everything else is Serva establishing that the work is sound; that one is a person
 * deciding it should exist in the world.
 */

export const ReleaseReadinessStatus = {
  READY: 'READY',
  /** Something is proven wrong. */
  BLOCKED: 'BLOCKED',
  /** Something was never established. Blocks just as hard, and reads differently. */
  NOT_VERIFIED: 'NOT_VERIFIED',
} as const;
export type ReleaseReadinessStatus =
  (typeof ReleaseReadinessStatus)[keyof typeof ReleaseReadinessStatus];

export const ConditionState = {
  MET: 'MET',
  NOT_MET: 'NOT_MET',
  /** No evidence either way. Never treated as either. */
  NOT_VERIFIED: 'NOT_VERIFIED',
  /** Genuinely does not apply, with the reason. */
  NOT_APPLICABLE: 'NOT_APPLICABLE',
} as const;
export type ConditionState = (typeof ConditionState)[keyof typeof ConditionState];

export interface ReadinessCondition {
  readonly id: string;
  readonly label: string;
  readonly state: ConditionState;
  readonly detail: string;
  /** Artifacts a reader can go and check. A condition with none is an assertion. */
  readonly evidence: readonly string[];
}

export interface ReleaseReadiness {
  readonly status: ReleaseReadinessStatus;
  readonly conditions: readonly ReadinessCondition[];
  readonly blockers: readonly string[];
  readonly unverified: readonly string[];
  readonly summary: string;
}

/** Verdicts that permit release. `PASS_WITH_QUALIFICATION` carries its qualification. */
function passes(v: { readonly verdict: string }): boolean {
  return (
    v.verdict === VerificationVerdict.PASS ||
    v.verdict === VerificationVerdict.PASS_WITH_QUALIFICATION
  );
}

/**
 * Is this verdict about the CURRENT version of what it judged?
 *
 * A verdict that judged version 2 says nothing about version 3, and a review that outlives
 * the thing it reviewed is how a stale approval keeps counting. Serva re-derives currency
 * rather than trusting a timestamp.
 */
function isCurrent(
  store: Store,
  type: string,
  subjects: readonly { readonly id: string; readonly version: number }[],
): boolean {
  return subjects.every((s) => {
    const versions = store.listCanonVersions(type, s.id);
    const head = versions.length === 0 ? undefined : Math.max(...versions);
    return head === undefined || head === s.version;
  });
}

/**
 * Assess release readiness from persisted truth alone.
 *
 * Every condition is returned, including the ones that pass, because an owner deciding
 * whether to ship needs to see what was established as much as what was not — a list of
 * only the problems reads as a punch list rather than a picture of the product.
 */
export function assessReleaseReadiness(o: {
  readonly store: Store;
  readonly clock: Clock;
  readonly workItemId?: string;
}): ReleaseReadiness {
  const { store, clock } = o;
  const conditions: ReadinessCondition[] = [];

  const add = (
    id: string,
    label: string,
    state: ConditionState,
    detail: string,
    evidence: readonly string[] = [],
  ): void => {
    conditions.push({ id, label, state, detail, evidence });
  };

  /* ------------------------------------------------------- 1. accepted requirements */

  const requirements = repository(store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
  add(
    'RR-REQUIREMENTS',
    'Current requirements exist',
    requirements.length === 0 ? ConditionState.NOT_VERIFIED : ConditionState.MET,
    requirements.length === 0
      ? 'no requirement is recorded, so there is nothing to have delivered'
      : String(requirements.length) + ' requirement(s) on record',
    requirements.slice(0, 5).map((r) => r.id),
  );

  /* ------------------------------------------------------------ 2. a change to ship */

  const changeSets = store.listCanonIds('eng.changeSet');
  const accepted = changeSets.filter((id) => {
    const env = store.getCanon<{ readonly state?: string }>('eng.changeSet', id);
    return env?.body.state === 'ACCEPTED';
  });
  add(
    'RR-CHANGESET',
    'An accepted ChangeSet exists',
    changeSets.length === 0
      ? ConditionState.NOT_VERIFIED
      : accepted.length === changeSets.length
        ? ConditionState.MET
        : ConditionState.NOT_MET,
    changeSets.length === 0
      ? 'no engineering work has been accepted'
      : String(accepted.length) + ' of ' + String(changeSets.length) + ' change set(s) accepted',
    accepted.slice(0, 5),
  );

  /* --------------------------------------------------------------- 3. QA and defects */

  const qa = repository(store, ARTIFACT_TYPES.QA_VERDICT, QAVerdictSchema).list();
  const currentQa = qa.filter((v) =>
    isCurrent(store, ARTIFACT_TYPES.ACCEPTANCE_CRITERION, v.subjects),
  );
  add(
    'RR-QA',
    'An independent QA verifier accepted the change',
    qa.length === 0
      ? ConditionState.NOT_VERIFIED
      : currentQa.length === 0
        ? ConditionState.NOT_VERIFIED
        : currentQa.some(passes)
          ? ConditionState.MET
          : ConditionState.NOT_MET,
    qa.length === 0
      ? 'no QA verdict exists'
      : currentQa.length === 0
        ? 'every QA verdict judged a version of the criteria that has since changed'
        : String(currentQa.filter(passes).length) + ' current passing verdict(s)',
    currentQa.slice(0, 3).map((v) => v.id),
  );

  const defects = repository(store, ARTIFACT_TYPES.DEFECT, DefectSchema).list();
  const blockingDefects = defects.filter(
    (d) => d.state === 'OPEN' && (d.severity === 'CRITICAL' || d.severity === 'HIGH'),
  );
  add(
    'RR-DEFECTS',
    'No CRITICAL or HIGH defect is open',
    blockingDefects.length === 0 ? ConditionState.MET : ConditionState.NOT_MET,
    blockingDefects.length === 0
      ? String(defects.length) + ' defect(s) recorded, none blocking'
      : blockingDefects.map((d) => d.severity + ': ' + d.title).join('; '),
    blockingDefects.slice(0, 5).map((d) => d.id),
  );

  /* ------------------------------------------------------------------- 4. security */

  const security = repository(store, ARTIFACT_TYPES.SECURITY_VERDICT, SecurityVerdictSchema).list();
  add(
    'RR-SECURITY',
    'Security verification accepted the change',
    security.length === 0
      ? ConditionState.NOT_VERIFIED
      : security.some(passes)
        ? ConditionState.MET
        : ConditionState.NOT_MET,
    security.length === 0
      ? 'no security verification exists; the threat model was never tested against what was built'
      : String(security.filter(passes).length) + ' passing verdict(s)',
    security.slice(0, 3).map((v) => v.id),
  );

  const findings = repository(store, ARTIFACT_TYPES.SECURITY_FINDING, SecurityFindingSchema).list();
  const openHigh = findings.filter(
    (f) =>
      f.state === 'OPEN' &&
      (f.severity === 'CRITICAL' || f.severity === 'HIGH') &&
      f.acceptedByOwnerDecisionRef === undefined,
  );
  add(
    'RR-SECURITY-FINDINGS',
    'No unaccepted CRITICAL or HIGH security finding',
    openHigh.length === 0 ? ConditionState.MET : ConditionState.NOT_MET,
    openHigh.length === 0
      ? 'nothing open that the owner has not accepted'
      : /* Accepting a security risk is the owner's decision and nobody else's. */
        openHigh.length === 1
        ? '1 finding is open and no owner decision accepts it'
        : String(openHigh.length) + ' findings are open and no owner decision accepts them',
    openHigh.slice(0, 5).map((f) => f.id),
  );

  /* ---------------------------------------------------------------- 5. performance */

  const nfrs = store.listCanonIds(ARTIFACT_TYPES.NFR);
  const performance = repository(
    store,
    ARTIFACT_TYPES.PERFORMANCE_VERDICT,
    PerformanceVerdictSchema,
  ).list();
  add(
    'RR-PERFORMANCE',
    'Declared performance targets were measured',
    nfrs.length === 0
      ? ConditionState.NOT_APPLICABLE
      : performance.length === 0
        ? ConditionState.NOT_VERIFIED
        : performance.some(passes)
          ? ConditionState.MET
          : ConditionState.NOT_MET,
    nfrs.length === 0
      ? 'this project declares no measurable NFR'
      : performance.length === 0
        ? 'targets exist and nothing measured them'
        : String(performance.filter(passes).length) + ' passing verdict(s)',
    performance.slice(0, 3).map((v) => v.id),
  );

  /* ----------------------------------------------------------------- 6. acceptance */

  const criteria = repository(
    store,
    ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
    AcceptanceCriterionSchema,
  ).list();
  const acceptance = repository(
    store,
    ARTIFACT_TYPES.ACCEPTANCE_VERDICT,
    AcceptanceVerdictSchema,
  ).list();
  const currentAcceptance = acceptance.filter((v) =>
    isCurrent(store, ARTIFACT_TYPES.ACCEPTANCE_CRITERION, v.subjects),
  );
  const fullyJudged = currentAcceptance.filter(
    (v) => criteria.length > 0 && v.criteria.length === criteria.length,
  );
  add(
    'RR-ACCEPTANCE',
    'Every acceptance criterion was independently judged',
    criteria.length === 0
      ? ConditionState.NOT_VERIFIED
      : fullyJudged.length === 0
        ? ConditionState.NOT_VERIFIED
        : fullyJudged.some(passes)
          ? ConditionState.MET
          : ConditionState.NOT_MET,
    criteria.length === 0
      ? 'no acceptance criteria exist to judge'
      : fullyJudged.length === 0
        ? 'no current verdict covers all ' + String(criteria.length) + ' criteria'
        : String(fullyJudged.filter(passes).length) + ' complete passing verdict(s)',
    fullyJudged.slice(0, 3).map((v) => v.id),
  );

  /* ---------------------------------------------------------- 7. owner decisions */

  const decisions = repository(
    store,
    ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
    OwnerDecisionRequestSchema,
  ).list();
  const blockingOpen = decisions.filter((d) => d.state === 'OPEN' && d.blocksWork);
  add(
    'RR-OWNER-DECISIONS',
    'No blocking owner decision is outstanding',
    blockingOpen.length === 0 ? ConditionState.MET : ConditionState.NOT_MET,
    blockingOpen.length === 0
      ? 'nothing is waiting on the owner'
      : blockingOpen.map((d) => d.question).join('; '),
    blockingOpen.slice(0, 5).map((d) => d.id),
  );

  /* ------------------------------------------------------------------- 8. risks */

  const risks = repository(store, ARTIFACT_TYPES.RISK, RiskSchema).list();
  /*
   * OPEN and severe. A risk that was mitigated, accepted or closed has been dealt with —
   * treating every high risk a project ever recorded as a blocker would make the check
   * unpassable and therefore ignored.
   */
  const openHighRisk = risks.filter(
    (r) => r.state === 'OPEN' && (r.severity === 'CRITICAL' || r.severity === 'HIGH'),
  );
  add(
    'RR-RISKS',
    'No unresolved Critical or High risk',
    openHighRisk.length === 0 ? ConditionState.MET : ConditionState.NOT_MET,
    openHighRisk.length === 0
      ? String(risks.length) + ' risk(s) recorded, none critical or high'
      : openHighRisk.map((r) => r.severity + ': ' + r.statement).join('; '),
    openHighRisk.slice(0, 5).map((r) => r.id),
  );

  /* --------------------------------------------------------------- 9. stale facts */

  const findingsFreshness = assessFreshness(
    repository(store, ARTIFACT_TYPES.RESEARCH_FINDING, ResearchFindingSchema)
      .list()
      .map((f) => ({
        id: f.id,
        validUntil: f.freshness.validUntil,
      })),
    clock,
  );
  const stale = findingsFreshness.filter((v) => v.state === ValidityState.STALE);
  add(
    'RR-FRESHNESS',
    'No blocking evidence has expired',
    stale.length === 0 ? ConditionState.MET : ConditionState.NOT_MET,
    stale.length === 0
      ? 'nothing research-backed has expired'
      : String(stale.length) + ' research finding(s) expired: ' + stale[0]?.reason,
    stale.slice(0, 5).map((v) => v.id),
  );

  /* ------------------------------------------------- 10. handover and operability */

  const handover = repository(store, ARTIFACT_TYPES.HANDOVER_PACKAGE, HandoverPackageSchema).list();
  const usable = handover.filter(
    (h) => h.rollbackPlan.trim() !== '' && h.deploymentSteps.length > 0,
  );
  add(
    'RR-HANDOVER',
    'A handover package with a rollback plan exists',
    handover.length === 0
      ? ConditionState.NOT_VERIFIED
      : usable.length > 0
        ? ConditionState.MET
        : ConditionState.NOT_MET,
    handover.length === 0
      ? 'nothing describes how to deploy this or how to undo it'
      : usable.length > 0
        ? 'deployment steps and a rollback plan are recorded'
        : 'a package exists with no rollback plan or no deployment steps',
    usable.slice(0, 3).map((h) => h.id),
  );

  const ops = repository(
    store,
    ARTIFACT_TYPES.OPERATIONAL_READINESS_VERDICT,
    OperationalReadinessVerdictSchema,
  ).list();
  add(
    'RR-OPERATIONS',
    'Operational readiness was independently verified',
    ops.length === 0
      ? ConditionState.NOT_VERIFIED
      : ops.some(passes)
        ? ConditionState.MET
        : ConditionState.NOT_MET,
    ops.length === 0
      ? 'nobody has judged whether somebody else could operate this'
      : String(ops.filter(passes).length) + ' passing verdict(s)',
    ops.slice(0, 3).map((v) => v.id),
  );

  /* ---------------------------------------------------------- 11. owner authority */

  const releases = repository(store, ARTIFACT_TYPES.RELEASE, ReleaseSchema).list();
  const authorised = releases.filter((r) => r.approvedByOwnerDecisionRef !== undefined);
  add(
    'RR-OWNER-AUTHORITY',
    'The owner authorised this release',
    releases.length === 0
      ? ConditionState.NOT_VERIFIED
      : authorised.length > 0
        ? ConditionState.MET
        : ConditionState.NOT_MET,
    releases.length === 0
      ? 'no release candidate exists'
      : authorised.length > 0
        ? 'authorised by owner decision ' + String(authorised[0]?.approvedByOwnerDecisionRef?.id)
        : /*
           * The one line no amount of engineering can satisfy. A Release Manager
           * recommending RELEASE is advice; shipping is a person deciding this should
           * exist in the world.
           */
          'a candidate exists and no owner decision authorises it',
    authorised.slice(0, 1).map((r) => r.id),
  );

  /* ------------------------------------------------------------------ the verdict */

  const blockers = conditions
    .filter((c) => c.state === ConditionState.NOT_MET)
    .map((c) => c.label + ': ' + c.detail);
  const unverified = conditions
    .filter((c) => c.state === ConditionState.NOT_VERIFIED)
    .map((c) => c.label + ': ' + c.detail);

  const status =
    blockers.length > 0
      ? ReleaseReadinessStatus.BLOCKED
      : unverified.length > 0
        ? ReleaseReadinessStatus.NOT_VERIFIED
        : ReleaseReadinessStatus.READY;

  return {
    status,
    conditions,
    blockers,
    unverified,
    summary:
      status === ReleaseReadinessStatus.READY
        ? 'Every release condition is met and the owner has authorised it.'
        : status === ReleaseReadinessStatus.BLOCKED
          ? String(blockers.length) +
            ' condition(s) are proven unmet' +
            (unverified.length === 0
              ? '.'
              : ', and ' + String(unverified.length) + ' were never established.')
          : String(unverified.length) +
            ' condition(s) were never established. NO EVIDENCE = NOT VERIFIED: this is not a failure, and it is not a pass.',
  };
}
