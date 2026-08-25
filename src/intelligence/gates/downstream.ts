import { EvidenceClass, OnMissingEvidence, Severity } from '../../vocab/index.js';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import { NfrSchema } from '../artifacts/requirements.js';
import {
  AcceptanceVerdictSchema,
  AccessibilityVerdictSchema,
  DefectSchema,
  PerformanceVerdictSchema,
  QAVerdictSchema,
  SecurityFindingSchema,
  SecurityVerdictSchema,
  VerificationVerdict,
} from '../artifacts/quality.js';
import {
  HandoverPackageSchema,
  OperationalReadinessVerdictSchema,
  ReleaseSchema,
} from '../artifacts/release.js';
import { IncidentSchema, IncidentState, PostIncidentReviewSchema } from '../artifacts/incident.js';
import type { Criterion, QualityGate } from '../../gates/types.js';
import type { Store } from '../../store/store.js';

/**
 * DOWNSTREAM GATE DEFINITIONS — the second half of the 19.
 *
 * SPEC: §31, 18, 30 §4, 03 §7.
 *
 * Phase 5 defined the eleven upstream gates and left the downstream ones undefined, which
 * was correct at the time and would have been dishonest to leave: an undefined gate blocks,
 * so a lifecycle that reached QA reported "not implemented" rather than a verdict about the
 * product. These close that, using the same `QualityGate` records and the same Phase 2 gate
 * engine. There is still no bespoke `if (green) ship` anywhere.
 *
 * `SC-GATE-CODE_REVIEW` is not here. Phase 4 already defines it against real engineering
 * evidence — build, tests, scope, secrets, independent review — and a second definition of
 * the same gate would be two answers to one question.
 *
 * Two properties do most of the work, and both are inherited rather than invented:
 *
 *   NO EVIDENCE = NOT VERIFIED. Every criterion defaults to INDETERMINATE on missing
 *   evidence, so an unverified area blocks instead of passing quietly.
 *
 *   `independence: true` on every verdict criterion. The actor that produced the work may
 *   not be the actor that clears it, and the gate reads WHO judged from the evaluation
 *   rather than trusting that somebody did.
 */

const criterion = (id: string, statement: string, o: Partial<Criterion> = {}): Criterion => ({
  id,
  statement,
  evaluation: { kind: 'STORE_QUERY', query: id },
  independence: false,
  severity: Severity.BLOCKING,
  testsExistence: false,
  onMissingEvidence: OnMissingEvidence.INDETERMINATE,
  policyRefs: [],
  applicability: 'ALWAYS',
  ...o,
});

/**
 * SC-GATE-IMPLEMENTATION — after 040.
 *
 * Deliberately thin, and that is the point rather than an omission. Everything a machine
 * can establish about a change is Phase 4's engineering gate, which runs on every
 * ChangeSet and owns the deterministic checks. This gate asks the one stage-level question
 * that survives above it: did implementation actually produce accepted work for the plan
 * it was given, or did the lifecycle walk past an empty stage?
 */
export const IMPLEMENTATION_GATE: QualityGate = {
  id: 'SC-GATE-IMPLEMENTATION',
  name: 'Implementation',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: ['eng.changeSet', 'intel.requirement'],
  criteria: [
    criterion('IM-1', 'At least one ChangeSet was accepted for this work'),
    criterion('IM-2', 'Every accepted ChangeSet passed the engineering gate', {
      requiredClass: EvidenceClass.EXECUTION,
    }),
  ],
};

/** SC-GATE-QA — after 042. Does it do what was asked, and is it usable? */
export const QA_GATE: QualityGate = {
  id: 'SC-GATE-QA',
  name: 'QA',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: [ARTIFACT_TYPES.QA_VERDICT, ARTIFACT_TYPES.DEFECT],
  criteria: [
    criterion('QA-1', 'An INDEPENDENT QA verifier accepted the change', {
      evaluation: {
        kind: 'VERIFIER_RESULT',
        role: 'SC-AGENT-214',
        criteria: ['acceptance criteria'],
      },
      independence: true,
      requiredClass: EvidenceClass.JUDGMENT,
    }),
    criterion('QA-2', 'No CRITICAL or HIGH defect is open'),
    criterion('QA-3', 'An INDEPENDENT verifier accepted accessibility', {
      evaluation: {
        kind: 'VERIFIER_RESULT',
        role: 'SC-AGENT-213',
        criteria: ['accessibility specification'],
      },
      independence: true,
      requiredClass: EvidenceClass.JUDGMENT,
      severity: Severity.MAJOR,
    }),
  ],
};

/** SC-GATE-SECURITY — after 043. Was the threat model tested against the built thing? */
export const SECURITY_GATE: QualityGate = {
  id: 'SC-GATE-SECURITY',
  name: 'Security Verification',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: [ARTIFACT_TYPES.SECURITY_VERDICT, ARTIFACT_TYPES.SECURITY_FINDING],
  criteria: [
    criterion('SEC-1', 'An INDEPENDENT security tester accepted the change', {
      evaluation: {
        kind: 'VERIFIER_RESULT',
        role: 'SC-AGENT-220',
        criteria: ['threat model', 'abuse cases'],
      },
      independence: true,
      requiredClass: EvidenceClass.JUDGMENT,
    }),
    criterion('SEC-2', 'No CRITICAL or HIGH security finding is open without owner acceptance'),
    criterion('SEC-3', 'Every modelled threat was exercised or explicitly recorded as unverified'),
  ],
};

/** SC-GATE-PERFORMANCE — after 044. Do the measured numbers meet the declared targets? */
export const PERFORMANCE_GATE: QualityGate = {
  id: 'SC-GATE-PERFORMANCE',
  name: 'Performance',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: [ARTIFACT_TYPES.PERFORMANCE_VERDICT, ARTIFACT_TYPES.NFR],
  criteria: [
    criterion('PF-1', 'Every measurable NFR target was actually measured', {
      requiredClass: EvidenceClass.EXECUTION,
    }),
    criterion('PF-2', 'Every measured target is met, or the shortfall is recorded', {
      severity: Severity.MAJOR,
    }),
  ],
};

/** SC-GATE-ACCEPTANCE — after 045. Is what was asked for actually there? */
export const ACCEPTANCE_GATE: QualityGate = {
  id: 'SC-GATE-ACCEPTANCE',
  name: 'Acceptance',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: [ARTIFACT_TYPES.ACCEPTANCE_VERDICT, ARTIFACT_TYPES.ACCEPTANCE_CRITERION],
  criteria: [
    criterion('AC-1', 'An INDEPENDENT verifier judged EVERY acceptance criterion', {
      evaluation: {
        kind: 'VERIFIER_RESULT',
        role: 'SC-AGENT-240',
        criteria: ['acceptance criteria'],
      },
      independence: true,
      requiredClass: EvidenceClass.JUDGMENT,
    }),
    criterion('AC-2', 'The acceptance verdict rests on the CURRENT criteria, not superseded ones'),
  ],
};

/**
 * SC-GATE-RELEASE — after 050.
 *
 * `RL-1` is the one that matters and the one an agent cannot satisfy: the owner authorised
 * this release. A Release Manager recommending RELEASE is advice, and treating advice as
 * authorisation is how software ships because a report looked positive.
 */
export const RELEASE_GATE: QualityGate = {
  id: 'SC-GATE-RELEASE',
  name: 'Release',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: [ARTIFACT_TYPES.RELEASE, ARTIFACT_TYPES.HANDOVER_PACKAGE],
  criteria: [
    criterion('RL-1', 'The OWNER authorised this release'),
    criterion('RL-2', 'The Release Manager recommends release', {
      evaluation: { kind: 'VERIFIER_RESULT', role: 'SC-AGENT-250', criteria: ['readiness'] },
      requiredClass: EvidenceClass.JUDGMENT,
      severity: Severity.MAJOR,
    }),
    criterion('RL-3', 'A handover package exists with deployment steps and a rollback plan'),
    criterion('RL-4', 'An INDEPENDENT verifier accepted operational readiness', {
      evaluation: {
        kind: 'VERIFIER_RESULT',
        role: 'SC-AGENT-262',
        criteria: ['runbooks', 'rollback'],
      },
      independence: true,
      requiredClass: EvidenceClass.JUDGMENT,
    }),
  ],
};

/** SC-GATE-INCIDENT_CLOSURE — after 054. An incident closes on understanding, not on relief. */
export const INCIDENT_CLOSURE_GATE: QualityGate = {
  id: 'SC-GATE-INCIDENT_CLOSURE',
  name: 'Incident Closure',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: [ARTIFACT_TYPES.INCIDENT, ARTIFACT_TYPES.POST_INCIDENT_REVIEW],
  criteria: [
    criterion('IC-1', 'The incident is contained or resolved'),
    criterion('IC-2', 'A post-incident review names contributing conditions, not only a cause', {
      evaluation: {
        kind: 'VERIFIER_RESULT',
        role: 'SC-AGENT-271',
        criteria: ['contributing conditions'],
      },
      independence: true,
      requiredClass: EvidenceClass.JUDGMENT,
    }),
    criterion(
      'IC-3',
      'Corrective actions are recorded as governed proposals, not applied directly',
    ),
  ],
};

export const DOWNSTREAM_GATES: readonly QualityGate[] = Object.freeze([
  IMPLEMENTATION_GATE,
  QA_GATE,
  SECURITY_GATE,
  PERFORMANCE_GATE,
  ACCEPTANCE_GATE,
  RELEASE_GATE,
  INCIDENT_CLOSURE_GATE,
]);

export function downstreamGateById(id: string): QualityGate | undefined {
  return DOWNSTREAM_GATES.find((g) => g.id === id);
}

/**
 * What the Store says about a downstream criterion.
 *
 * `undefined` means "no evidence", which the evaluator turns into INDETERMINATE. That
 * distinction is carried in the return type rather than collapsed into a boolean, because
 * a boolean forces every unknown into a false and a false reads as a proven negative.
 */
export function downstreamStoreAnswer(store: Store, criterionId: string): boolean | undefined {
  switch (criterionId) {
    /* ------------------------------------------------------------- implementation */
    case 'IM-1': {
      return store.listCanonIds('eng.changeSet').length > 0 ? true : undefined;
    }
    case 'IM-2': {
      const sets = store.listCanonIds('eng.changeSet');
      if (sets.length === 0) return undefined;
      /*
       * Phase 4 records an accepted ChangeSet by moving it to ACCEPTED. A set in any other
       * state has not passed the engineering gate, and the difference is exactly what this
       * criterion exists to notice.
       */
      const accepted = sets.filter((id) => {
        const env = store.getCanon<{ readonly state?: string }>('eng.changeSet', id);
        return env?.body.state === 'ACCEPTED';
      });
      return accepted.length === sets.length;
    }

    /* ------------------------------------------------------------------------- QA */
    case 'QA-2': {
      const defects = repository(store, ARTIFACT_TYPES.DEFECT, DefectSchema).list();
      return !defects.some(
        (d) => d.state === 'OPEN' && (d.severity === 'CRITICAL' || d.severity === 'HIGH'),
      );
    }

    /* ------------------------------------------------------------------- security */
    case 'SEC-2': {
      const findings = repository(
        store,
        ARTIFACT_TYPES.SECURITY_FINDING,
        SecurityFindingSchema,
      ).list();
      return !findings.some(
        (f) =>
          f.state === 'OPEN' &&
          (f.severity === 'CRITICAL' || f.severity === 'HIGH') &&
          f.acceptedByOwnerDecisionRef === undefined,
      );
    }
    case 'SEC-3': {
      const verdicts = repository(
        store,
        ARTIFACT_TYPES.SECURITY_VERDICT,
        SecurityVerdictSchema,
      ).list();
      if (verdicts.length === 0) return undefined;
      const threats = store.listCanonIds(ARTIFACT_TYPES.THREAT_MODEL);
      const covered = new Set(
        verdicts.flatMap((v) => [
          ...v.threatsExercised.map((t) => t.id),
          ...v.notVerified.map((n) => n.area),
        ]),
      );
      return threats.every((t) => covered.has(t));
    }

    /* ---------------------------------------------------------------- performance */
    case 'PF-1': {
      const verdicts = repository(
        store,
        ARTIFACT_TYPES.PERFORMANCE_VERDICT,
        PerformanceVerdictSchema,
      ).list();
      if (verdicts.length === 0) return undefined;
      const nfrs = repository(store, ARTIFACT_TYPES.NFR, NfrSchema).list();
      const measured = new Set(
        verdicts.flatMap((v) =>
          v.measurements.filter((m) => m.measured !== undefined).map((m) => m.nfrRef.id),
        ),
      );
      return nfrs.every((n) => measured.has(n.id));
    }
    case 'PF-2': {
      const verdicts = repository(
        store,
        ARTIFACT_TYPES.PERFORMANCE_VERDICT,
        PerformanceVerdictSchema,
      ).list();
      if (verdicts.length === 0) return undefined;
      return verdicts.every((v) =>
        v.measurements.every((m) => m.measured === undefined || m.met === true),
      );
    }

    /* ----------------------------------------------------------------- acceptance */
    case 'AC-2': {
      const verdicts = repository(
        store,
        ARTIFACT_TYPES.ACCEPTANCE_VERDICT,
        AcceptanceVerdictSchema,
      ).list();
      if (verdicts.length === 0) return undefined;
      /*
       * CURRENCY, not existence. A verdict that judged version 2 of a criterion says
       * nothing about version 3 — and a review that outlives the thing it reviewed is the
       * exact failure the subjects field was added to catch.
       */
      return verdicts.some((v) =>
        v.subjects.every((s) => {
          const versions = store.listCanonVersions(ARTIFACT_TYPES.ACCEPTANCE_CRITERION, s.id);
          const head = versions.length === 0 ? undefined : Math.max(...versions);
          return head === undefined || head === s.version;
        }),
      );
    }

    /* -------------------------------------------------------------------- release */
    case 'RL-1': {
      const releases = repository(store, ARTIFACT_TYPES.RELEASE, ReleaseSchema).list();
      if (releases.length === 0) return undefined;
      /*
       * An owner decision on THIS release, or nothing.
       *
       * SPEC: finding SEC-REV-1. This asked `releases.some(...)` across every release the
       * store had ever held, so one approval, ever, satisfied the criterion for every release
       * afterwards — including one the owner had never seen. The comment below was true and
       * beside the point: nothing needed to produce an approval when an old one stood in.
       *
       * There is still deliberately no branch accepting a recommendation, a verdict or a
       * confident summary. Authorisation to ship is the one thing in this file no agent output
       * can produce — and now also the one thing an earlier release cannot lend to a later one.
       */
      const current = releases.reduce((latest, r) =>
        r.createdAt >= latest.createdAt ? r : latest,
      );
      return current.approvedByOwnerDecisionRef !== undefined;
    }
    case 'RL-3': {
      const packages = repository(
        store,
        ARTIFACT_TYPES.HANDOVER_PACKAGE,
        HandoverPackageSchema,
      ).list();
      if (packages.length === 0) return undefined;
      return packages.some((p) => p.rollbackPlan.trim() !== '' && p.deploymentSteps.length > 0);
    }

    /* ------------------------------------------------------------------- incident */
    case 'IC-1': {
      const incidents = repository(store, ARTIFACT_TYPES.INCIDENT, IncidentSchema).list();
      if (incidents.length === 0) return undefined;
      return incidents.every(
        (i) =>
          i.state === IncidentState.CONTAINED ||
          i.state === IncidentState.RESOLVED ||
          i.state === IncidentState.CLOSED,
      );
    }
    case 'IC-3': {
      const reviews = repository(
        store,
        ARTIFACT_TYPES.POST_INCIDENT_REVIEW,
        PostIncidentReviewSchema,
      ).list();
      if (reviews.length === 0) return undefined;
      /*
       * A review with no corrective proposals is legitimate — sometimes nothing needs to
       * change. What is not legitimate is corrective work that happened without one, and
       * that shows up as a review claiming actions it cannot point at.
       */
      return reviews.every((r) =>
        r.correctiveProposalRefs.every(
          (p) => store.getCanon(ARTIFACT_TYPES.PROPOSAL, p.id) !== undefined,
        ),
      );
    }

    default:
      return undefined;
  }
}

/** Verdict families whose PASS a judged criterion may rest on, for the report surface. */
export const DOWNSTREAM_VERDICT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  'QA-1': ARTIFACT_TYPES.QA_VERDICT,
  'QA-3': ARTIFACT_TYPES.ACCESSIBILITY_VERDICT,
  'SEC-1': ARTIFACT_TYPES.SECURITY_VERDICT,
  'AC-1': ARTIFACT_TYPES.ACCEPTANCE_VERDICT,
  'RL-4': ARTIFACT_TYPES.OPERATIONAL_READINESS_VERDICT,
});

/** Verdict readers used by the report surface and the readiness derivation. */
export const DOWNSTREAM_VERDICT_READERS = Object.freeze({
  qa: (store: Store) => repository(store, ARTIFACT_TYPES.QA_VERDICT, QAVerdictSchema).list(),
  accessibility: (store: Store) =>
    repository(store, ARTIFACT_TYPES.ACCESSIBILITY_VERDICT, AccessibilityVerdictSchema).list(),
  security: (store: Store) =>
    repository(store, ARTIFACT_TYPES.SECURITY_VERDICT, SecurityVerdictSchema).list(),
  performance: (store: Store) =>
    repository(store, ARTIFACT_TYPES.PERFORMANCE_VERDICT, PerformanceVerdictSchema).list(),
  acceptance: (store: Store) =>
    repository(store, ARTIFACT_TYPES.ACCEPTANCE_VERDICT, AcceptanceVerdictSchema).list(),
  operational: (store: Store) =>
    repository(
      store,
      ARTIFACT_TYPES.OPERATIONAL_READINESS_VERDICT,
      OperationalReadinessVerdictSchema,
    ).list(),
});

/** Did this verdict family reach a passing conclusion? Shared by gate and readiness. */
export function verdictPasses(v: { readonly verdict: string }): boolean {
  return (
    v.verdict === VerificationVerdict.PASS ||
    v.verdict === VerificationVerdict.PASS_WITH_QUALIFICATION
  );
}
