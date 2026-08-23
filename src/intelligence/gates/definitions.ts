import { EvidenceClass, OnMissingEvidence, Severity } from '../../vocab/index.js';
import { DOWNSTREAM_GATES } from './downstream.js';
import type { Criterion, QualityGate } from '../../gates/types.js';

/**
 * UPSTREAM GATE DEFINITIONS.
 *
 * SPEC: §31, 18, 30 §4.
 *
 * These are `QualityGate` records for the canonical upstream gates, expressed in the
 * Phase 2 vocabulary so the EXISTING gate engine evaluates them. There is no bespoke
 * `if (good) proceed` anywhere in Phase 5 — the verdict comes from CriterionEvaluations
 * composed by `composeGateVerdict`, exactly as every other gate in Serva.
 *
 * Two settings carry most of the meaning:
 *
 * `onMissingEvidence: INDETERMINATE` is the default, and it is what makes §31's rule
 * real — absent evidence produces NOT_VERIFIED, never PASS. A criterion only uses
 * `NOT_MET` when absence genuinely IS the proven negative, which requires
 * `testsExistence`.
 *
 * `independence: true` marks criteria whose evidence must come from an actor other than
 * the one that produced the artifact. The requirements gate leans on it, because a
 * verifier that wrote the requirements is not verification.
 */

/**
 * Most upstream criteria are answered by querying the Store — Serva computes them from
 * persisted canon rather than asking anybody. `STORE_QUERY` names that honestly; the ones
 * that genuinely need a judgement declare `VERIFIER_RESULT` and record who judged.
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

/** SC-GATE-INTAKE — is the problem understood well enough to spend money on it? */
export const INTAKE_GATE: QualityGate = {
  id: 'SC-GATE-INTAKE',
  name: 'Intake',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: ['intel.clientInput', 'intel.projectGoal'],
  criteria: [
    criterion('IN-1', 'The problem, audience and definition of success are recorded'),
    criterion('IN-2', 'At least one project goal exists, each with a success indicator'),
    criterion('IN-3', 'No question put to the owner is a decision Serva should have made', {
      severity: Severity.MAJOR,
    }),
  ],
};

/** SC-GATE-DISCOVERY — do we know who has this problem and what they do today? */
export const DISCOVERY_GATE: QualityGate = {
  id: 'SC-GATE-DISCOVERY',
  name: 'Discovery',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: ['intel.userSegment', 'intel.currentAlternative', 'intel.discoveryFindings'],
  criteria: [
    criterion('DI-1', 'At least one user segment is identified'),
    criterion('DI-2', 'EVERY segment has at least one current alternative recorded'),
    criterion('DI-3', 'No user research is claimed that was not performed', {
      requiredClass: EvidenceClass.OBSERVATION,
    }),
    criterion('DI-4', 'Load-bearing inferences are recorded as Assumptions', {
      evaluation: {
        kind: 'VERIFIER_RESULT',
        role: 'SC-AGENT-030',
        criteria: ['inference promoted to an assumption'],
      },
      severity: Severity.MAJOR,
    }),
  ],
};

/** SC-GATE-PRODUCT_VALIDATION — should this be built, and is the scope traceable? */
export const PRODUCT_VALIDATION_GATE: QualityGate = {
  id: 'SC-GATE-PRODUCT_VALIDATION',
  name: 'Product Validation',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: ['intel.productScope', 'intel.feature', 'intel.validationRecommendation'],
  criteria: [
    criterion('PV-1', 'A validation recommendation exists with a rationale'),
    criterion('PV-2', 'Every feature traces to a project goal or an approved proposal'),
    criterion('PV-3', 'Scope states what is out of scope and what is a non-goal', {
      severity: Severity.MAJOR,
    }),
  ],
};

/**
 * SC-GATE-REQUIREMENTS — the gate the vertical slice ends at.
 *
 * `RQ-4` is the independence criterion, and it is BLOCKING rather than advisory: a
 * requirements set nobody independent has read is exactly as likely to be ambiguous as
 * one that has never been reviewed, because the author reads their own intent into it.
 */
export const REQUIREMENTS_GATE: QualityGate = {
  id: 'SC-GATE-REQUIREMENTS',
  name: 'Requirements',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: ['intel.requirement', 'intel.acceptanceCriterion', 'intel.nfr'],
  criteria: [
    criterion('RQ-1', 'Every MUST requirement has at least one acceptance criterion'),
    criterion('RQ-2', 'Every NFR states a measurable target and how it will be measured'),
    criterion('RQ-3', 'Every requirement traces upward to a feature, goal or business rule', {
      severity: Severity.MAJOR,
    }),
    criterion('RQ-4', 'An INDEPENDENT verifier judged the requirements acceptable', {
      evaluation: {
        kind: 'VERIFIER_RESULT',
        role: 'SC-AGENT-052',
        criteria: ['atomicity', 'testability', 'traceability', 'consistency'],
      },
      independence: true,
      requiredClass: EvidenceClass.JUDGMENT,
    }),
    criterion('RQ-5', 'Every project goal is covered by a requirement or explicitly deferred'),
  ],
};

/** SC-GATE-COMPETITIVE — market truth must be sourced, verified and current. */
export const COMPETITIVE_GATE: QualityGate = {
  id: 'SC-GATE-COMPETITIVE',
  name: 'Competitive',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: ['intel.researchFinding', 'intel.competitivePosition', 'intel.differentiator'],
  criteria: [
    criterion('CO-1', 'Research findings cite captured sources'),
    criterion('CO-2', 'Material claims were verified by an actor that did not make them', {
      evaluation: {
        kind: 'VERIFIER_RESULT',
        role: 'SC-AGENT-063',
        criteria: ['claim is supported by the captured source'],
      },
      independence: true,
      requiredClass: EvidenceClass.JUDGMENT,
    }),
    criterion('CO-3', 'No competitive conclusion rests on expired research'),
    criterion('CO-4', 'A competitive position states why anyone would switch, and why not'),
  ],
};

/** SC-GATE-FEASIBILITY — can this be built, at this cost, with these risks visible? */
export const FEASIBILITY_GATE: QualityGate = {
  id: 'SC-GATE-FEASIBILITY',
  name: 'Feasibility',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: ['intel.costModel', 'intel.risk', 'intel.costAssessment'],
  criteria: [
    criterion('FE-1', 'A cost model exists and every figure states a source or a basis'),
    criterion('FE-2', 'Cost does not exceed a stated budget without an owner decision'),
    criterion('FE-3', 'Risks are recorded, and UNKNOWN has not been recorded as LOW', {
      severity: Severity.MAJOR,
    }),
  ],
};

/** SC-GATE-ARCHITECTURE — is the design justified and independently reviewed? */
export const ARCHITECTURE_GATE: QualityGate = {
  id: 'SC-GATE-ARCHITECTURE',
  name: 'Architecture',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: ['intel.architectureModel', 'intel.dataModel', 'intel.nfrMapping'],
  criteria: [
    criterion('AR-1', 'Every NFR is mapped to a mechanism or explicitly flagged unsatisfied', {
      evaluation: {
        kind: 'VERIFIER_RESULT',
        role: 'SC-AGENT-070',
        criteria: ['every NFR addressed'],
      },
    }),
    criterion('AR-2', 'An INDEPENDENT reviewer accepted the architecture', {
      evaluation: {
        kind: 'VERIFIER_RESULT',
        role: 'SC-AGENT-072',
        criteria: ['complexity justified', 'NFRs mapped', 'ownership unambiguous'],
      },
      independence: true,
      requiredClass: EvidenceClass.JUDGMENT,
    }),
    criterion('AR-3', 'Every complexity pattern names the requirement that forces it'),
    criterion('DA-1', 'An INDEPENDENT reviewer accepted the data model', {
      evaluation: {
        kind: 'VERIFIER_RESULT',
        role: 'SC-AGENT-082',
        criteria: ['ownership', 'transaction boundaries', 'retention'],
      },
      independence: true,
      requiredClass: EvidenceClass.JUDGMENT,
    }),
  ],
};

/** SC-GATE-SECURITY_DESIGN — is the security modelled rather than asserted? */
export const SECURITY_DESIGN_GATE: QualityGate = {
  id: 'SC-GATE-SECURITY_DESIGN',
  name: 'Security Design',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: ['intel.threatModel', 'intel.authorizationModel', 'intel.privacyDesign'],
  criteria: [
    criterion('SE-1', 'A threat model exists with trust boundaries and abuse cases'),
    criterion('SE-2', 'An authorization model states who may do what, defaulting to DENY'),
    criterion('SE-3', 'Privacy records what data exists, why, and who can reach it'),
    criterion('SE-4', 'No residual risk is accepted without an owner disposition', {
      severity: Severity.MAJOR,
    }),
  ],
};

/** SC-GATE-TECHNOLOGY — was the choice a comparison, and was it made in the right order? */
export const TECHNOLOGY_GATE: QualityGate = {
  id: 'SC-GATE-TECHNOLOGY',
  name: 'Technology',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: ['intel.technologyEvaluation', 'intel.adr'],
  criteria: [
    criterion('TE-1', 'Every material decision compared at least two real candidates'),
    criterion('TE-2', 'Criteria were declared before candidates were scored'),
    criterion('TE-3', 'Every decision records its reversal cost and re-evaluation trigger'),
  ],
};

/** SC-GATE-DESIGN — is the experience complete and the system usable? */
export const DESIGN_GATE: QualityGate = {
  id: 'SC-GATE-DESIGN',
  name: 'Design',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: ['intel.flow', 'intel.designTokenSet', 'intel.adminOperabilityReview'],
  criteria: [
    criterion('UX-1', 'Every screen accounts for every required state', {
      evaluation: {
        kind: 'VERIFIER_RESULT',
        role: 'SC-AGENT-120',
        criteria: ['state coverage complete'],
      },
    }),
    criterion('UX-2', 'An INDEPENDENT reviewer accepted the experience', {
      evaluation: { kind: 'VERIFIER_RESULT', role: 'SC-AGENT-123', criteria: ['flows', 'states'] },
      independence: true,
      requiredClass: EvidenceClass.JUDGMENT,
    }),
    criterion('DS-1', 'An INDEPENDENT reviewer accepted the design system', {
      evaluation: {
        kind: 'VERIFIER_RESULT',
        role: 'SC-AGENT-133',
        criteria: ['tokens', 'component states', 'RTL'],
      },
      independence: true,
      requiredClass: EvidenceClass.JUDGMENT,
    }),
    criterion('DS-2', 'The deterministic design checks find nothing blocking'),
    criterion('AO-1', 'EVERY feature has an AdminOperabilityReview'),
    criterion('AO-2', 'No protected rule is exposed as an ordinary operator setting'),
  ],
};

/** SC-GATE-PLAN — is there a test strategy, and does everything still trace? */
export const PLAN_GATE: QualityGate = {
  id: 'SC-GATE-PLAN',
  name: 'Plan',
  version: '1.0.0',
  blocking: true,
  waivable: false,
  invalidationSet: ['intel.testStrategy', 'intel.testCase'],
  criteria: [
    criterion('PL-1', 'A test strategy maps every promise to a verification approach'),
    criterion('PL-2', 'Nothing is orphaned: the traceability checker finds nothing blocking'),
  ],
};

export const UPSTREAM_GATES: readonly QualityGate[] = Object.freeze([
  INTAKE_GATE,
  DISCOVERY_GATE,
  PRODUCT_VALIDATION_GATE,
  REQUIREMENTS_GATE,
  COMPETITIVE_GATE,
  FEASIBILITY_GATE,
  ARCHITECTURE_GATE,
  SECURITY_DESIGN_GATE,
  TECHNOLOGY_GATE,
  DESIGN_GATE,
  PLAN_GATE,
]);

/**
 * Every gate Serva defines, upstream and downstream.
 *
 * Phase 4 owns SC-GATE-CODE_REVIEW against real engineering evidence and is deliberately
 * NOT re-declared here: two definitions of one gate would be two answers to one question,
 * and the one that lost would be whichever module a caller happened to import.
 */
export const INTELLIGENCE_GATES: readonly QualityGate[] = Object.freeze([
  ...UPSTREAM_GATES,
  ...DOWNSTREAM_GATES,
]);

export function gateById(id: string): QualityGate | undefined {
  return INTELLIGENCE_GATES.find((g) => g.id === id);
}
