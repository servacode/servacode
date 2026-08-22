import { GateVerdict, ValidityState } from '../vocab/index.js';
import { ARTIFACT_TYPES, repository } from './repository.js';
import { ProjectGoalSchema } from './artifacts/framing.js';
import { FeatureSchema, ProductScopeSchema } from './artifacts/product.js';
import { BusinessRuleSchema } from './artifacts/business.js';
import {
  AcceptanceCriterionSchema,
  NfrSchema,
  RequirementSchema,
} from './artifacts/requirements.js';
import {
  AdrSchema,
  ArchitectureModelSchema,
  ComplexityJustificationSchema,
} from './artifacts/architecture.js';
import { DataModelSchema } from './artifacts/data.js';
import { ThreatModelSchema } from './artifacts/security.js';
import { FlowSchema, StateCoverageSchema } from './artifacts/ux.js';
import {
  ComponentSpecSchema,
  DesignExceptionSchema,
  DesignTokenSetSchema,
} from './artifacts/design.js';
import {
  AdminAuditRequirementSchema,
  AdminOperabilityReviewSchema,
  ConfigurationRegisterSchema,
  OperationalControlSchema,
  ProtectedRuleSchema,
} from './artifacts/admin.js';
import { TestCaseSchema, TestStrategySchema } from './artifacts/testing.js';
import {
  EngineeringReadinessPackageSchema,
  OwnerDecisionRequestSchema,
  ProposalSchema,
  ReadinessStatus,
  RiskSchema,
} from './artifacts/governance.js';
import { CompetitivePositionSchema } from './artifacts/market.js';
import { checkTraceability, blockingFindings } from './checks/traceability.js';
import { checkConfiguration } from './checks/configuration.js';
import { checkDesign } from './checks/design.js';
import { assessFreshness, staleSubjects } from './research/freshness.js';
import { marketFreshnessSubjects } from './research/subjects.js';
import { readOrchestratorRecord } from './execution/orchestrator.js';
import { outstandingChanges } from './change.js';
import { resolveApplicability, upstreamGatesFor } from './applicability.js';
import { UPSTREAM_GATES } from './gates/definitions.js';
import type { EngineeringReadinessPackage } from './artifacts/governance.js';
import type { TraceFinding } from './checks/traceability.js';
import type { Store } from '../store/store.js';
import type { Clock } from '../core/clock.js';
import type { IdSource } from '../core/ids.js';

/**
 * THE ENGINEERING READINESS PACKAGE — DERIVED, and blocked by construction.
 *
 * SPEC: §10, §35.
 *
 * No model produces this and no model may declare READY. The status is computed from
 * persisted canon, and each blocker below is a fact about the Store rather than an
 * opinion about it:
 *
 *   a required gate that did not accept
 *   an unresolved owner decision
 *   a STALE artifact that something load-bearing depends on
 *   a traceability failure
 *   a feature with no admin operability review
 *   a missing independent review
 *   research that expired or was never verified
 *
 * The package itself is a set of REFERENCES, not copies. A readiness package that
 * embedded the requirements would become a second source of truth that starts drifting
 * the moment anything upstream changes; version pins are what make "what did we actually
 * hand over" answerable later.
 */

/**
 * The gates that must have accepted, DERIVED from the profile actually being run.
 *
 * Not a hand-kept list. A hand-kept list is a list that stops being updated: a gate gets
 * defined, its stage gets wired, the run starts evaluating it — and readiness carries on
 * ignoring it, so a FAIL verdict sits in the record while the status reads READY. Taking
 * the profile's own gate sequence means a gate becomes mandatory at the moment its stage
 * enters the plan, with nobody having to remember.
 *
 * A gate in the plan that this build cannot evaluate does not become optional. It has no
 * result, so it blocks as "has not been evaluated" — which is the truth.
 */
function requiredGates(profileId: string): readonly string[] {
  const blocking = new Set(UPSTREAM_GATES.filter((g) => g.blocking).map((g) => g.id));
  return upstreamGatesFor(resolveApplicability(profileId)).filter((id) => blocking.has(id));
}

const ACCEPTING: readonly string[] = Object.freeze([
  GateVerdict.PASS,
  GateVerdict.PASS_WITH_QUALIFICATION,
]);

/** Reviews whose absence means nobody independent looked. */
const REQUIRED_REVIEWS: readonly { readonly criterion: string; readonly what: string }[] =
  Object.freeze([
    { criterion: 'RQ-4', what: 'requirements' },
    { criterion: 'AR-2', what: 'architecture' },
    { criterion: 'DA-1', what: 'the data model' },
    { criterion: 'UX-2', what: 'the user experience' },
    { criterion: 'DS-1', what: 'the design system' },
  ]);

export interface ReadinessInput {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly workItemId: string;
  /**
   * Independent reviews recorded this cycle, by criterion.
   *
   * Passed rather than re-derived, for the same reason a gate takes them: a judgement
   * belongs to the run that made it. Absent means nobody looked, which blocks.
   */
  readonly reviews?: ReadonlySet<string>;
  /** Gates whose evidence Phase 5 does not yet produce may be excused, explicitly. */
  readonly waiveGates?: ReadonlySet<string>;
}

export interface ReadinessAssessment {
  readonly status: ReadinessStatus;
  readonly blockers: readonly string[];
  readonly findings: readonly TraceFinding[];
  readonly package: EngineeringReadinessPackage;
}

/**
 * Assess readiness. Never asks anybody.
 *
 * Returns the blockers rather than the first one: an operator fixing readiness wants the
 * whole list, not a queue of one-at-a-time refusals.
 */
export function assessReadiness(input: ReadinessInput): ReadinessAssessment {
  const { store, clock } = input;
  const at = clock.now();
  const blockers: string[] = [];

  const goals = repository(store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).list();
  const features = repository(store, ARTIFACT_TYPES.FEATURE, FeatureSchema).list();
  const requirements = repository(store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
  const acceptance = repository(
    store,
    ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
    AcceptanceCriterionSchema,
  ).list();
  const nfrs = repository(store, ARTIFACT_TYPES.NFR, NfrSchema).list();
  const rules = repository(store, ARTIFACT_TYPES.BUSINESS_RULE, BusinessRuleSchema).list();
  const complexity = repository(
    store,
    ARTIFACT_TYPES.COMPLEXITY_JUSTIFICATION,
    ComplexityJustificationSchema,
  ).list();
  const reviews = repository(
    store,
    ARTIFACT_TYPES.ADMIN_OPERABILITY_REVIEW,
    AdminOperabilityReviewSchema,
  ).list();
  const flows = repository(store, ARTIFACT_TYPES.FLOW, FlowSchema).list();
  const testCases = repository(store, ARTIFACT_TYPES.TEST_CASE, TestCaseSchema).list();
  const scope = repository(store, ARTIFACT_TYPES.PRODUCT_SCOPE, ProductScopeSchema).list();
  const architecture = repository(
    store,
    ARTIFACT_TYPES.ARCHITECTURE_MODEL,
    ArchitectureModelSchema,
  ).list();
  const adrs = repository(store, ARTIFACT_TYPES.ADR, AdrSchema).list();
  const dataModels = repository(store, ARTIFACT_TYPES.DATA_MODEL, DataModelSchema).list();
  const threats = repository(store, ARTIFACT_TYPES.THREAT_MODEL, ThreatModelSchema).list();
  const tokens = repository(store, ARTIFACT_TYPES.DESIGN_TOKEN_SET, DesignTokenSetSchema).list();
  const components = repository(store, ARTIFACT_TYPES.COMPONENT_SPEC, ComponentSpecSchema).list();
  const coverage = repository(store, ARTIFACT_TYPES.STATE_COVERAGE, StateCoverageSchema).list();
  const exceptions = repository(
    store,
    ARTIFACT_TYPES.DESIGN_EXCEPTION,
    DesignExceptionSchema,
  ).list();
  const strategies = repository(store, ARTIFACT_TYPES.TEST_STRATEGY, TestStrategySchema).list();
  const risks = repository(store, ARTIFACT_TYPES.RISK, RiskSchema).list();
  const proposals = repository(store, ARTIFACT_TYPES.PROPOSAL, ProposalSchema).list();
  const decisions = repository(
    store,
    ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
    OwnerDecisionRequestSchema,
  ).list();
  const positions = repository(
    store,
    ARTIFACT_TYPES.COMPETITIVE_POSITION,
    CompetitivePositionSchema,
  ).list();
  const register = repository(
    store,
    ARTIFACT_TYPES.CONFIGURATION_REGISTER,
    ConfigurationRegisterSchema,
  ).list();
  const protectedRules = repository(
    store,
    ARTIFACT_TYPES.PROTECTED_RULE,
    ProtectedRuleSchema,
  ).list();
  const audits = repository(
    store,
    ARTIFACT_TYPES.ADMIN_AUDIT_REQUIREMENT,
    AdminAuditRequirementSchema,
  ).list();
  const controls = repository(
    store,
    ARTIFACT_TYPES.OPERATIONAL_CONTROL,
    OperationalControlSchema,
  ).list();

  /* ------------------------------------------------------------ 1. gates accepted */

  const record = readOrchestratorRecord(store, input.workItemId);
  const gateResults = record?.gateResults ?? [];
  /*
   * No record means no run: nothing has been gated, so nothing may be handed over. Saying
   * so once is clearer than emitting a blocker per gate for a project that never started.
   */
  if (record === undefined) blockers.push('no intelligence run exists for ' + input.workItemId);
  for (const gateId of record === undefined ? [] : requiredGates(record.profileId)) {
    if (input.waiveGates?.has(gateId) === true) continue;
    const result = gateResults.find((g) => g.gateId === gateId);
    if (result === undefined) {
      blockers.push(gateId + ' has not been evaluated');
      continue;
    }
    if (!ACCEPTING.includes(result.verdict)) {
      blockers.push(gateId + ' returned ' + result.verdict);
    }
  }

  /* --------------------------------------------------- 2. unresolved owner decisions */

  const open = decisions.filter((d) => d.state === 'OPEN');
  for (const d of open) {
    blockers.push('an owner decision is unanswered: ' + d.question.slice(0, 100));
  }

  /* ------------------------------------------- 2b. changes not yet carried through */

  /*
   * SPEC: §34. A raised change is a statement that the canon below is out of date. Handing
   * over while one is outstanding hands over a description of a product somebody has
   * already asked to alter — and the implementation would be correct against a
   * specification the owner has stopped agreeing with.
   */
  for (const c of outstandingChanges(store)) {
    blockers.push(
      'change ' +
        c.id +
        ' is ' +
        c.state +
        ' and not carried through: ' +
        c.description.slice(0, 80),
    );
  }

  /* ------------------------------------------------------------- 3. staleness */

  const stale = staleSubjects(assessFreshness(marketFreshnessSubjects(store), clock));
  for (const s of stale) {
    blockers.push('load-bearing research is STALE: ' + s.id + ' — ' + s.reason);
  }

  /* -------------------------------------------------- 4. traceability and orphans */

  const traceFindings = checkTraceability({
    goals,
    features,
    requirements,
    acceptanceCriteria: acceptance,
    nfrs,
    businessRules: rules,
    complexity,
    operabilityReviews: reviews,
    flows,
    testCases,
    ...(scope[0] === undefined ? {} : { productScope: scope[0] }),
  });
  const configFindings = checkConfiguration({
    features,
    reviews,
    ...(register[0] === undefined ? {} : { register: register[0] }),
    protectedRules,
    auditRequirements: audits,
    controls,
  });
  const designFindings = checkDesign({
    ...(tokens[0] === undefined ? {} : { tokens: tokens[0] }),
    components,
    coverage,
    exceptions,
    clock,
  });

  const allFindings = [...traceFindings, ...configFindings, ...designFindings];
  for (const f of blockingFindings(allFindings)) {
    blockers.push(f.code + ' — ' + f.statement);
  }

  /* ---------------------------------------------------- 5. independent reviews */

  for (const r of REQUIRED_REVIEWS) {
    if (input.reviews?.has(r.criterion) === true) continue;
    blockers.push('no independent review of ' + r.what + ' is recorded (' + r.criterion + ')');
  }

  /* ------------------------------------------------- 6. the minimum canon must exist */

  const required: readonly [string, number][] = [
    ['a product scope', scope.length],
    ['requirements', requirements.length],
    ['NFRs', nfrs.length],
    ['an architecture', architecture.length],
    ['a data model', dataModels.length],
    ['a threat model', threats.length],
    ['UX flows', flows.length],
    ['a design system', tokens.length],
    ['a test strategy', strategies.length],
  ];
  for (const [what, count] of required) {
    if (count === 0) blockers.push('implementation needs ' + what + ', and none exists');
  }

  /* ---------------------------------------------------------------- the package */

  const status =
    blockers.length === 0
      ? ReadinessStatus.READY
      : open.length > 0
        ? ReadinessStatus.BLOCKED
        : ReadinessStatus.NOT_READY;

  const pkg = EngineeringReadinessPackageSchema.parse({
    id: input.ids.next('SC-ERP'),
    createdAt: at,
    status,
    refs: {
      ...(scope[0] === undefined ? {} : { productScope: { id: scope[0].id } }),
      acceptanceCriteria: acceptance.map((a) => ({ id: a.id, version: a.version })),
      nfrs: nfrs.map((n) => ({ id: n.id, version: n.version })),
      businessRules: rules.map((r) => ({ id: r.id, version: r.version })),
      architecture: [...architecture, ...adrs].map((a) => ({ id: a.id, version: a.version })),
      dataModel: dataModels.map((d) => ({ id: d.id, version: d.version })),
      security: threats.map((t) => ({ id: t.id, version: t.version })),
      ux: flows.map((f) => ({ id: f.id, version: f.version })),
      designSystem: [...tokens, ...components].map((t) => ({ id: t.id, version: t.version })),
      adminOperability: reviews.map((r) => ({ id: r.id, version: r.version })),
      testStrategy: strategies.map((s) => ({ id: s.id, version: s.version })),
      risks: risks.map((r) => ({ id: r.id, version: r.version })),
      ...(positions[0] === undefined ? {} : { competitivePosition: { id: positions[0].id } }),
      acceptedProposals: proposals
        .filter((p) => p.state === 'ACCEPTED' || p.state === 'INCORPORATED')
        .map((p) => ({ id: p.id })),
    },
    gateResults: gateResults.map((g) => ({ gateId: g.gateId, verdict: g.verdict })),
    openOwnerDecisions: open.map((d) => ({ id: d.id })),
    blockers,
    meta: {
      /* SYSTEM: nobody reasoned about this. It is computed. */
      provenance: { marking: 'SYSTEM', component: 'engineering-readiness' },
      attribution: { at },
      workItemId: input.workItemId,
    },
  });

  return { status, blockers, findings: allFindings, package: pkg };
}

/** Persist the assessment. The package is canon; the assessment that produced it is not. */
export function recordReadiness(input: ReadinessInput): ReadinessAssessment {
  const assessment = assessReadiness(input);
  const tx = input.store.begin();
  try {
    repository(
      input.store,
      ARTIFACT_TYPES.READINESS_PACKAGE,
      EngineeringReadinessPackageSchema,
    ).put(tx, assessment.package);
    tx.commit();
  } catch (e) {
    tx.rollback();
    throw e;
  }
  return assessment;
}

/** True only when nothing blocks. There is no path to READY that skips a blocker. */
export function isReady(a: ReadinessAssessment): boolean {
  return a.status === ReadinessStatus.READY && a.blockers.length === 0;
}

export { ValidityState };
