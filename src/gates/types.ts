import type {
  ArtifactVerifierResultValue,
  CriterionBasis,
  CriterionResult,
  EvidenceClass,
  IndeterminateReason,
  OnMissingEvidence,
  QualificationKind,
  Severity,
  ValidityState,
} from '../vocab/index.js';

/** 31 §8 — a caveat attached to a PASS_WITH_QUALIFICATION or verifier result. */
export interface Qualification {
  readonly kind: QualificationKind;
  readonly subject: string;
  readonly detail: string;
  readonly criterionRef?: string;
  readonly expiresAt?: string;
}

/** 31 §2 — reviewer attribution, required iff basis === JUDGED. */
export interface JudgedBy {
  readonly role: string;
  readonly criteriaApplied: readonly string[];
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface ArtifactVersionRef {
  readonly artifactId: string;
  readonly version: number;
  readonly digest: string;
}

/**
 * 31 §2.1 — CriterionEvaluation. The persisted form of one criterion result.
 * T-TRACE, immutable. Carries no validity field: ValidityState is derived (VD-1).
 */
export interface CriterionEvaluation {
  readonly id: string;
  readonly criterionRef: string;
  readonly value: CriterionResult;
  readonly basis: CriterionBasis;
  /** Required iff value === INDETERMINATE (TX-3b). */
  readonly reason?: IndeterminateReason;
  readonly severity: Severity;
  readonly evidenceRefs: readonly string[];
  /**
   * Required iff value === WAIVED. A reference is NOT authority: the gate engine
   * resolves it and validates target, scope, state, expiry and authority before
   * the value is accepted (09 §9, 18 GW-1..GW-5).
   */
  readonly waiverRef?: string;
  /**
   * Required iff value === NOT_APPLICABLE (31 §2 — "with a recorded reason").
   *
   * RUNTIME-WRITTEN. The gate engine resolves applicability through an authority
   * and stamps this field itself, replacing any caller-supplied value. A caller
   * cannot assert that a criterion does not apply.
   */
  readonly applicabilityBasis?: {
    readonly condition: string;
    readonly resolvedBy: string;
    readonly resolvedAt: string;
  };
  /** Required iff basis === JUDGED. */
  readonly judgedBy?: JudgedBy;
  readonly qualifications: readonly Qualification[];
  readonly artifactVersionsEvaluated: readonly ArtifactVersionRef[];
  readonly evaluatedAt: string;
}

/**
 * 31 §4.3 — ArtifactVerifierResult (V3b).
 * AV-1: ESCALATED is excluded by construction; the type cannot express it.
 */
export interface ArtifactVerifierResult {
  readonly id: string;
  readonly role: string;
  readonly subject: readonly ArtifactVersionRef[];
  readonly value: ArtifactVerifierResultValue;
  /** Required iff value is NOT_VERIFIED or BLOCKED (31 §4.3 cause field, R4). */
  readonly cause?: IndeterminateReason;
  readonly dimensionsChecked: readonly string[];
  /** Mandatory (AV-4) — may be empty, may not be absent. */
  readonly dimensionsNotChecked: readonly { readonly dimension: string; readonly reason: string }[];
  readonly findings: readonly Finding[];
  readonly basisSummary: {
    readonly measured: readonly string[];
    readonly judged: readonly string[];
    readonly derived: readonly string[];
  };
  readonly evidenceRefs: readonly string[];
  readonly actor: { readonly runRef: string; readonly agentId: string; readonly role: string };
  readonly criteriaApplied: readonly string[];
  readonly confidence?: 'HIGH' | 'MEDIUM' | 'LOW';
  readonly qualifications: readonly Qualification[];
  readonly artifactVersionsEvaluated: readonly ArtifactVersionRef[];
  readonly dependsOn: readonly string[];
  readonly evaluatedAt: string;
}

export interface Finding {
  readonly id: string;
  readonly severity: 'BLOCKING' | 'MAJOR' | 'MINOR' | 'SUGGESTION';
  readonly statement: string;
  readonly location?: string;
}

/** 18 §2 — how a criterion is evaluated. */
export type CriterionEvaluationMode =
  | { readonly kind: 'STORE_QUERY'; readonly query: string }
  | { readonly kind: 'EVIDENCE_CHECK'; readonly requirement: EvidenceRequirement }
  | {
      readonly kind: 'VERIFIER_RESULT';
      readonly role: string;
      readonly criteria: readonly string[];
    }
  | { readonly kind: 'COMPOSITE'; readonly children: readonly string[] };

/** 16 §7 — EvidenceRequirement. on_missing_evidence corrected to V1 values in R4. */
export interface EvidenceRequirement {
  readonly requiredClass: EvidenceClass;
  readonly requiredCount: number;
  readonly requiredCoverage?: string;
  readonly independence: boolean;
  /** Validity that evidence must derive to. 31 §3. */
  readonly validity: ValidityState;
  readonly maxAgeMs?: number;
  readonly substitutes?: readonly EvidenceClass[];
  readonly onMissingEvidence: OnMissingEvidence;
}

/** 18 §2 — a gate criterion definition. */
export interface Criterion {
  readonly id: string;
  readonly statement: string;
  readonly evaluation: CriterionEvaluationMode;
  readonly requiredClass?: EvidenceClass;
  readonly independence: boolean;
  readonly severity: Severity;
  /** 18 §2.1 — R4. When true, absent evidence IS the proven negative. */
  readonly testsExistence: boolean;
  /** 18 §2.1 — R4. V1 values only. NOT_MET permitted only with testsExistence (CR-EX1). */
  readonly onMissingEvidence: OnMissingEvidence;
  readonly policyRefs: readonly string[];
  readonly applicability: 'ALWAYS' | { readonly condition: string };
  /**
   * 18 GW-3 — criterion-level narrowing of the gate's waivability. Absent means
   * the criterion inherits `QualityGate.waivable`; false makes it unwaivable even
   * on a waivable gate, which is how the never-waivable list is expressed.
   */
  readonly waivable?: boolean;
}

/** 18 §2 — a gate definition. Note: no on_not_verified. Removed in R4. */
export interface QualityGate {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly blocking: boolean;
  readonly criteria: readonly Criterion[];
  readonly invalidationSet: readonly string[];
  readonly waivable: boolean;
}

/** 18 §4.2 — GateResult. T-TRACE, immutable, no stored validity field. */
export interface GateResult {
  readonly id: string;
  readonly gateRef: string;
  readonly gateVersion: string;
  readonly scope: string;
  readonly verdict: import('../vocab/index.js').GateVerdict;
  readonly criterionEvaluationIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly artifactVersionsEvaluated: readonly ArtifactVersionRef[];
  readonly qualifications: readonly Qualification[];
  readonly findings: readonly Finding[];
  readonly evaluatedAt: string;
  readonly evaluator: string;
  readonly storeVersion: number;
  readonly dependsOn: readonly string[];
}
