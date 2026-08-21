/**
 * Canonical outcome vocabularies.
 *
 * SPEC: 31_RESULT_AND_VERDICT_TAXONOMY.md (BASELINE R4) is the sole authority for
 * every value set in this module. 26_GLOSSARY_AND_IDENTIFIERS.md owns all other
 * enumerations.
 *
 * TX-1  the word "verdict" names V3 (GateVerdict) and V3b (ArtifactVerifierResult) only.
 * TX-1b `EvidenceState` is not a vocabulary. ValidityState (V2) applied to Evidence.
 */

/** V1 — CriterionResult. 31 §2. Outcome of evaluating ONE gate criterion. */
export const CriterionResult = {
  MET: 'MET',
  NOT_MET: 'NOT_MET',
  INDETERMINATE: 'INDETERMINATE',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  WAIVED: 'WAIVED',
} as const;
export type CriterionResult = (typeof CriterionResult)[keyof typeof CriterionResult];

/**
 * Criterion basis. 31 §2. A separate axis from the result value.
 * TX-2: JUDGED is a basis, NEVER a result value and NEVER a verdict.
 */
export const CriterionBasis = {
  MEASURED: 'MEASURED',
  JUDGED: 'JUDGED',
  DERIVED: 'DERIVED',
} as const;
export type CriterionBasis = (typeof CriterionBasis)[keyof typeof CriterionBasis];

/**
 * TX-3b — closed reason set, mandatory when value === INDETERMINATE.
 * Gate composition routes on this; without it NOT_VERIFIED / BLOCKED / ESCALATED
 * cannot be distinguished mechanically.
 */
export const IndeterminateReason = {
  EVIDENCE_ABSENT: 'EVIDENCE_ABSENT',
  EVIDENCE_INVALID: 'EVIDENCE_INVALID',
  TOOL_UNAVAILABLE: 'TOOL_UNAVAILABLE',
  PRECONDITION_ABSENT: 'PRECONDITION_ABSENT',
  AUTHORITY_REQUIRED: 'AUTHORITY_REQUIRED',
} as const;
export type IndeterminateReason = (typeof IndeterminateReason)[keyof typeof IndeterminateReason];

/** Criterion severity. 18 §2; drives composition per 31 §4.1.1. */
export const Severity = {
  BLOCKING: 'BLOCKING',
  MAJOR: 'MAJOR',
  ADVISORY: 'ADVISORY',
} as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

/**
 * 18 §2.1 — on_missing_evidence. V1 values only.
 * CR-EX1: NOT_MET is permitted ONLY when the criterion declares testsExistence.
 */
export const OnMissingEvidence = {
  INDETERMINATE: 'INDETERMINATE',
  NOT_MET: 'NOT_MET',
} as const;
export type OnMissingEvidence = (typeof OnMissingEvidence)[keyof typeof OnMissingEvidence];

/**
 * V2 — ValidityState. 31 §3. Derived, NEVER stored as a mutable field (VD-1).
 * INADMISSIBLE applies to Evidence subjects only (31 §3.1, KI-2c).
 */
export const ValidityState = {
  VALID: 'VALID',
  STALE: 'STALE',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
  DISPUTED: 'DISPUTED',
  INADMISSIBLE: 'INADMISSIBLE',
} as const;
export type ValidityState = (typeof ValidityState)[keyof typeof ValidityState];

/** V3 — GateVerdict. 31 §4. The outcome of a whole gate evaluation. */
export const GateVerdict = {
  PASS: 'PASS',
  PASS_WITH_QUALIFICATION: 'PASS_WITH_QUALIFICATION',
  FAIL: 'FAIL',
  NOT_VERIFIED: 'NOT_VERIFIED',
  BLOCKED: 'BLOCKED',
  ESCALATED: 'ESCALATED',
} as const;
export type GateVerdict = (typeof GateVerdict)[keyof typeof GateVerdict];

/**
 * V3b — ArtifactVerifierResult. 31 §4.3.
 * A strict subset of GateVerdict. AV-1: ESCALATED is excluded by definition —
 * an escalating verifier emits a RunOutcome and NO verifier result.
 */
export const ArtifactVerifierResultValue = {
  PASS: 'PASS',
  PASS_WITH_QUALIFICATION: 'PASS_WITH_QUALIFICATION',
  FAIL: 'FAIL',
  NOT_VERIFIED: 'NOT_VERIFIED',
  BLOCKED: 'BLOCKED',
} as const;
export type ArtifactVerifierResultValue =
  (typeof ArtifactVerifierResultValue)[keyof typeof ArtifactVerifierResultValue];

/** V4 — RunOutcome. 31 §5, detail in 05 §7. */
export const RunOutcome = {
  COMPLETED: 'COMPLETED',
  PARTIAL: 'PARTIAL',
  BLOCKED: 'BLOCKED',
  ESCALATED: 'ESCALATED',
  REFUSED: 'REFUSED',
  FAILED: 'FAILED',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  SCOPE_VIOLATION: 'SCOPE_VIOLATION',
  EVIDENCE_VIOLATION: 'EVIDENCE_VIOLATION',
} as const;
export type RunOutcome = (typeof RunOutcome)[keyof typeof RunOutcome];

/* ---------------------------------------------------------------- V5 ProcessState */

/** V5a — WorkItemState. 04 §8.1. */
export const WorkItemState = {
  RECEIVED: 'RECEIVED',
  CLASSIFIED: 'CLASSIFIED',
  PLANNED: 'PLANNED',
  EXECUTING: 'EXECUTING',
  GATING: 'GATING',
  ADVANCING: 'ADVANCING',
  REWORK: 'REWORK',
  AWAITING_OWNER: 'AWAITING_OWNER',
  AWAITING_EXPERT: 'AWAITING_EXPERT',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  BLOCKED: 'BLOCKED',
  HALTED: 'HALTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  SUPERSEDED: 'SUPERSEDED',
} as const;
export type WorkItemState = (typeof WorkItemState)[keyof typeof WorkItemState];

/** V5b — WorkflowRunState. 07 §6. */
export const WorkflowRunState = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  WAITING: 'WAITING',
  GATING: 'GATING',
  REWORK: 'REWORK',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  ABORTED: 'ABORTED',
  SUPERSEDED: 'SUPERSEDED',
} as const;
export type WorkflowRunState = (typeof WorkflowRunState)[keyof typeof WorkflowRunState];

/** V5c — StageExecutionState. 03 §1.3. Mutable live pointer. REWORK is legal here. */
export const StageExecutionState = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  IN_GATE: 'IN_GATE',
  REWORK: 'REWORK',
  BLOCKED: 'BLOCKED',
  COMPLETE: 'COMPLETE',
} as const;
export type StageExecutionState = (typeof StageExecutionState)[keyof typeof StageExecutionState];

/**
 * V5d — StageLedgerDisposition. 03 §10. Immutable, appended per attempt.
 * PS-1: REWORK is NOT a member. "We are trying again" is not an outcome;
 * the outcome of the failed attempt is FAILED.
 */
export const StageLedgerDisposition = {
  EXECUTED: 'EXECUTED',
  IN_PROGRESS: 'IN_PROGRESS',
  BLOCKED: 'BLOCKED',
  SKIPPED: 'SKIPPED',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  FAILED: 'FAILED',
  ABANDONED: 'ABANDONED',
} as const;
export type StageLedgerDisposition =
  (typeof StageLedgerDisposition)[keyof typeof StageLedgerDisposition];

/** V5h — GovernanceState. 20 §2. Derived. */
export const GovernanceState = {
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  DEGRADED: 'DEGRADED',
  SUSPENDED: 'SUSPENDED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type GovernanceState = (typeof GovernanceState)[keyof typeof GovernanceState];

/** 31 §8 — Qualification kinds. */
export const QualificationKind = {
  JUDGED_BASIS: 'JUDGED_BASIS',
  ACTIVE_WAIVER: 'ACTIVE_WAIVER',
  UNVALIDATED_ASSUMPTION: 'UNVALIDATED_ASSUMPTION',
  UNVERIFIED_ASPECT: 'UNVERIFIED_ASPECT',
  DEGRADED_ENFORCEMENT: 'DEGRADED_ENFORCEMENT',
  RESEARCH_UNAVAILABLE: 'RESEARCH_UNAVAILABLE',
} as const;
export type QualificationKind = (typeof QualificationKind)[keyof typeof QualificationKind];

/** 16 §3 — Evidence classes, with the S1..S5 strength ordering. */
export const EvidenceClass = {
  EXECUTION: 'EXECUTION',
  OBSERVATION: 'OBSERVATION',
  ARTIFACT: 'ARTIFACT',
  ANALYSIS: 'ANALYSIS',
  JUDGMENT: 'JUDGMENT',
  ATTESTATION: 'ATTESTATION',
} as const;
export type EvidenceClass = (typeof EvidenceClass)[keyof typeof EvidenceClass];

/** 16 §3 strength ordering. Lower number == stronger. ATTESTATION sits outside. */
export const EVIDENCE_STRENGTH: Readonly<Record<EvidenceClass, number>> = Object.freeze({
  EXECUTION: 1,
  OBSERVATION: 2,
  ARTIFACT: 3,
  ANALYSIS: 4,
  JUDGMENT: 5,
  ATTESTATION: 0,
});

/** 08 §3 — source marking on every entity envelope. */
export const SourceMarking = {
  OWNER_STATED: 'OWNER_STATED',
  DERIVED: 'DERIVED',
  RESEARCHED: 'RESEARCHED',
  INFERRED: 'INFERRED',
  SYSTEM: 'SYSTEM',
} as const;
export type SourceMarking = (typeof SourceMarking)[keyof typeof SourceMarking];

/** 08 §2 — durability tiers. */
export const Tier = {
  CANON: 'T-CANON',
  WORKING: 'T-WORKING',
  TRACE: 'T-TRACE',
  DERIVED: 'T-DERIVED',
} as const;
export type Tier = (typeof Tier)[keyof typeof Tier];

/** 01 §1.3 — violation severity. */
export const ViolationSeverity = { V1: 'V1', V2: 'V2', V3: 'V3' } as const;
export type ViolationSeverity = (typeof ViolationSeverity)[keyof typeof ViolationSeverity];

/** 33 PC-5 — capability enforcement class. */
export const EnforcementClass = { HARD: 'HARD', SOFT: 'SOFT', NONE: 'NONE' } as const;
export type EnforcementClass = (typeof EnforcementClass)[keyof typeof EnforcementClass];

/** 19 §3 — session policy. Renamed from FRESH in R3 (31 VD-5). */
export const SessionPolicy = { NEW: 'NEW', CONTINUE: 'CONTINUE' } as const;
export type SessionPolicy = (typeof SessionPolicy)[keyof typeof SessionPolicy];

/** Helper: is a GateVerdict value also a legal ArtifactVerifierResult? (AV-1) */
export function isArtifactVerifierResultValue(v: string): v is ArtifactVerifierResultValue {
  return Object.prototype.hasOwnProperty.call(ArtifactVerifierResultValue, v);
}
