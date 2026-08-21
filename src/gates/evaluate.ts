import {
  CriterionBasis,
  CriterionResult,
  IndeterminateReason,
  OnMissingEvidence,
  ValidityState,
} from '../vocab/index.js';
import { fail } from '../core/errors.js';
import type { IdSource } from '../core/ids.js';
import type { Clock } from '../core/clock.js';
import type { ApplicabilityDetermination } from './authority.js';
import type { Criterion, CriterionEvaluation, EvidenceRequirement } from './types.js';

/**
 * Criterion evaluation for EVIDENCE_CHECK criteria.
 *
 * SPEC: 18 §2.1 (on_missing_evidence / tests_existence, R4) and 31 §2.
 *
 * The governing invariant (SC-POL-005, 31 §4.1.1):
 *   absence of evidence is NOT proof of failure, EXCEPT where the criterion
 *   explicitly tests for existence.
 */

export interface EvidenceView {
  readonly id: string;
  readonly class: string;
  /** Derived, never stored. 31 §3.2. */
  readonly validity: ValidityState;
  readonly capturedAt: string;
}

export interface EvaluateDeps {
  readonly ids: IdSource;
  readonly clock: Clock;
}

/** CR-EX1 — NOT_MET is permitted only when the criterion declares testsExistence. */
export function assertCriterionWellFormed(c: Criterion): void {
  if (c.onMissingEvidence === OnMissingEvidence.NOT_MET && !c.testsExistence) {
    fail({
      code: 'E_GATE_DEFINITION',
      message: 'Criterion ' + c.id + ' sets onMissingEvidence=NOT_MET without testsExistence',
      remedy:
        'Absence of evidence may only be treated as a proven negative for an existence-testing criterion. Set testsExistence, or use INDETERMINATE.',
      details: { criterionId: c.id },
      specRef: '18 §2.1 CR-EX1',
    });
  }
}

/**
 * Evaluate one EVIDENCE_CHECK criterion against the evidence available to it.
 *
 * Returns a CriterionEvaluation; composition (31 §4.1) turns it into a verdict.
 */
export function evaluateEvidenceCriterion(
  criterion: Criterion,
  requirement: EvidenceRequirement,
  evidence: readonly EvidenceView[],
  deps: EvaluateDeps,
): CriterionEvaluation {
  assertCriterionWellFormed(criterion);

  const now = deps.clock.now();
  const mk = (value: CriterionResult, reason?: IndeterminateReason): CriterionEvaluation => ({
    id: deps.ids.next('SC-CE'),
    criterionRef: criterion.id,
    value,
    basis: CriterionBasis.MEASURED,
    ...(reason === undefined ? {} : { reason }),
    severity: criterion.severity,
    evidenceRefs: evidence.map((e) => e.id),
    qualifications: [],
    artifactVersionsEvaluated: [],
    evaluatedAt: now,
  });

  const admissible = evidence.filter((e) => e.class === requirement.requiredClass);

  // No evidence at all for this criterion.
  if (admissible.length === 0) {
    if (criterion.onMissingEvidence === OnMissingEvidence.NOT_MET) {
      // The criterion IS an existence test: absence is the proven negative.
      return mk(CriterionResult.NOT_MET);
    }
    // Absence of evidence is not proof of failure.
    return mk(CriterionResult.INDETERMINATE, IndeterminateReason.EVIDENCE_ABSENT);
  }

  // TX-4 — only VALID evidence may support MET.
  const valid = admissible.filter((e) => e.validity === ValidityState.VALID);
  if (valid.length === 0) {
    return mk(CriterionResult.INDETERMINATE, IndeterminateReason.EVIDENCE_INVALID);
  }

  if (valid.length < requirement.requiredCount) {
    return mk(CriterionResult.INDETERMINATE, IndeterminateReason.EVIDENCE_ABSENT);
  }

  return mk(CriterionResult.MET);
}

/**
 * Evaluate a criterion whose producing runtime component could not run.
 * 22 DG-1: an absent tool yields INDETERMINATE, never PASS.
 */
export function evaluateToolUnavailable(
  criterion: Criterion,
  deps: EvaluateDeps,
): CriterionEvaluation {
  return {
    id: deps.ids.next('SC-CE'),
    criterionRef: criterion.id,
    value: CriterionResult.INDETERMINATE,
    basis: CriterionBasis.MEASURED,
    reason: IndeterminateReason.TOOL_UNAVAILABLE,
    severity: criterion.severity,
    evidenceRefs: [],
    qualifications: [],
    artifactVersionsEvaluated: [],
    evaluatedAt: deps.clock.now(),
  };
}

/**
 * A criterion that does not apply in this scope. Inert in composition.
 *
 * The determination is a REQUIRED argument, not an assumption: 31 §2 defines
 * NOT_APPLICABLE as "does not apply, with a recorded reason", and this producer
 * must not be a way to mint one without it. The caller obtains the determination
 * from an ApplicabilityAuthority; the gate engine re-resolves it independently at
 * the boundary, so this is a convenience, never the proof.
 */
export function evaluateNotApplicable(
  criterion: Criterion,
  determination: ApplicabilityDetermination,
  deps: EvaluateDeps,
): CriterionEvaluation {
  if (determination.applies) {
    fail({
      code: 'E_GATE_AUTHORITY',
      message: 'Criterion ' + criterion.id + ' cannot be NOT_APPLICABLE: its condition holds',
      remedy: 'Evaluate the criterion rather than exempting it.',
      details: { criterionId: criterion.id, condition: determination.condition },
      specRef: '31 §2',
    });
  }
  const now = deps.clock.now();
  return {
    id: deps.ids.next('SC-CE'),
    criterionRef: criterion.id,
    value: CriterionResult.NOT_APPLICABLE,
    basis: CriterionBasis.DERIVED,
    severity: criterion.severity,
    evidenceRefs: [],
    applicabilityBasis: {
      condition: determination.condition,
      resolvedBy: determination.resolvedBy,
      resolvedAt: now,
    },
    qualifications: [],
    artifactVersionsEvaluated: [],
    evaluatedAt: now,
  };
}
