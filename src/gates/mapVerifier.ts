import {
  ArtifactVerifierResultValue,
  CriterionBasis,
  CriterionResult,
  IndeterminateReason,
  QualificationKind,
} from '../vocab/index.js';
import { fail } from '../core/errors.js';
import type { IdSource } from '../core/ids.js';
import type { Clock } from '../core/clock.js';
import type {
  ArtifactVerifierResult,
  Criterion,
  CriterionEvaluation,
  Qualification,
} from './types.js';

/**
 * mapVerifierResult — canonical V3b -> V1 mapping.
 *
 * SPEC: 31 §4.4 (BASELINE R4). Total, deterministic, executable without
 * interpretation (MV-8). Rules MV-1 .. MV-8 are enforced here.
 */

export interface MapDeps {
  readonly ids: IdSource;
  readonly clock: Clock;
}

/**
 * MV-7 — basis is DERIVED FROM basis_summary, not fixed at JUDGED.
 * A verifier result resting entirely on measured dimensions yields a MEASURED
 * criterion and therefore does not force PASS_WITH_QUALIFICATION.
 */
export function deriveBasis(avr: ArtifactVerifierResult): CriterionBasis {
  if (avr.basisSummary.judged.length > 0) return CriterionBasis.JUDGED;
  if (avr.basisSummary.measured.length > 0) return CriterionBasis.MEASURED;
  return CriterionBasis.DERIVED;
}

function assertCausePresent(avr: ArtifactVerifierResult): IndeterminateReason {
  if (avr.cause === undefined) {
    return fail({
      code: 'E_MAPPING',
      message: 'ArtifactVerifierResult ' + avr.id + ' is ' + avr.value + ' but carries no cause',
      remedy:
        'A NOT_VERIFIED or BLOCKED verifier result must carry a cause so the criterion inherits the right INDETERMINATE reason.',
      details: { id: avr.id, value: avr.value },
      specRef: '31 §4.3 cause field, MV-3 / MV-4',
    });
  }
  return avr.cause;
}

/**
 * 31 §4.4 mapVerifierResult.
 *
 * MV-6: severity comes from the GATE DEFINITION, never from the verifier.
 * A verifier judges the artifact; the gate decides how much that matters.
 */
export function mapVerifierResult(
  avr: ArtifactVerifierResult,
  criterion: Criterion,
  deps: MapDeps,
): CriterionEvaluation {
  const basis = deriveBasis(avr);
  const qualifications: Qualification[] = [...avr.qualifications]; // MV-5

  let value: CriterionResult;
  let reason: IndeterminateReason | undefined;

  switch (avr.value) {
    case ArtifactVerifierResultValue.PASS:
      value = CriterionResult.MET;
      break;

    case ArtifactVerifierResultValue.PASS_WITH_QUALIFICATION:
      value = CriterionResult.MET;
      break;

    case ArtifactVerifierResultValue.FAIL:
      // MV-2 — there is no path from a failing verifier result to a satisfied criterion.
      value = CriterionResult.NOT_MET;
      break;

    case ArtifactVerifierResultValue.NOT_VERIFIED: {
      value = CriterionResult.INDETERMINATE;
      const cause = assertCausePresent(avr);
      if (cause === IndeterminateReason.PRECONDITION_ABSENT) {
        fail({
          code: 'E_MAPPING',
          message:
            'ArtifactVerifierResult ' + avr.id + ' is NOT_VERIFIED with cause PRECONDITION_ABSENT',
          remedy: 'PRECONDITION_ABSENT belongs to a BLOCKED result, not NOT_VERIFIED.',
          details: { id: avr.id },
          specRef: '31 §4.3 cause field',
        });
      }
      reason = cause; // MV-3 — verbatim, never re-derived or defaulted.
      qualifications.push({
        kind: QualificationKind.UNVERIFIED_ASPECT,
        subject: criterion.id,
        detail: cause,
        criterionRef: criterion.id,
      });
      break;
    }

    case ArtifactVerifierResultValue.BLOCKED: {
      value = CriterionResult.INDETERMINATE;
      const cause = assertCausePresent(avr);
      if (cause !== IndeterminateReason.PRECONDITION_ABSENT) {
        fail({
          code: 'E_MAPPING',
          message: 'ArtifactVerifierResult ' + avr.id + ' is BLOCKED with cause ' + cause,
          remedy: 'A BLOCKED verifier result carries PRECONDITION_ABSENT only.',
          details: { id: avr.id, cause },
          specRef: '31 §4.3 cause field, MV-4',
        });
      }
      // MV-4 — preserves the missing-precondition distinction so branch 1 still fires.
      reason = IndeterminateReason.PRECONDITION_ABSENT;
      break;
    }

    default: {
      // MV-1 — the mapping is total. ESCALATED cannot reach here: it is not a
      // member of V3b (AV-1) and the type system excludes it.
      const unreachable: never = avr.value;
      return fail({
        code: 'E_MAPPING',
        message: 'Unmapped ArtifactVerifierResult value: ' + String(unreachable),
        remedy: 'Every V3b value must have a branch in 31 §4.4.',
        specRef: '31 §4.4 MV-1',
      });
    }
  }

  const judgedBy =
    basis === CriterionBasis.JUDGED
      ? {
          role: avr.actor.role,
          criteriaApplied: avr.criteriaApplied,
          confidence: avr.confidence ?? ('MEDIUM' as const),
        }
      : undefined;

  const base = {
    id: deps.ids.next('SC-CE'),
    criterionRef: criterion.id,
    value,
    basis,
    severity: criterion.severity, // MV-6
    evidenceRefs: avr.evidenceRefs,
    qualifications,
    artifactVersionsEvaluated: avr.artifactVersionsEvaluated,
    evaluatedAt: deps.clock.now(),
  };

  return {
    ...base,
    ...(reason === undefined ? {} : { reason }),
    ...(judgedBy === undefined ? {} : { judgedBy }),
  };
}
