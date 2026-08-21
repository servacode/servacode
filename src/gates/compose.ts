import {
  CriterionResult,
  CriterionBasis,
  GateVerdict,
  IndeterminateReason,
  QualificationKind,
  Severity,
} from '../vocab/index.js';
import { fail } from '../core/errors.js';
import type { CriterionEvaluation, Qualification } from './types.js';

/**
 * composeGateVerdict — the canonical gate-composition algorithm.
 *
 * SPEC: 31 §4.1.2 (BASELINE R4). This file is the single executable owner
 * (29 DC-27); 18 §4 references it and does not restate it.
 *
 * Branch order is normative (TX-5b). The severity disposition table (31 §4.1.1)
 * is TOTAL (TX-5c): there is no fall-through to PASS.
 */

export interface ComposedVerdict {
  readonly verdict: GateVerdict;
  readonly qualifications: readonly Qualification[];
}

/**
 * 31 §4.1.1 — severity disposition table, as data rather than as branching prose.
 * Exhaustive over Severity x CriterionResult. Exported so DC-37 can assert totality
 * against the specification table instead of trusting the implementation.
 */
export type Disposition =
  | 'FAIL'
  | 'NOT_VERIFIED'
  | 'QUALIFY_UNVERIFIED'
  | 'QUALIFY_WAIVED'
  | 'CONTRIBUTES_PASS'
  | 'INERT'
  | 'FINDING_ONLY';

export const SEVERITY_DISPOSITION: Readonly<
  Record<Severity, Readonly<Record<CriterionResult, Disposition>>>
> = Object.freeze({
  [Severity.BLOCKING]: Object.freeze({
    [CriterionResult.NOT_MET]: 'FAIL',
    [CriterionResult.INDETERMINATE]: 'NOT_VERIFIED',
    [CriterionResult.WAIVED]: 'QUALIFY_WAIVED',
    [CriterionResult.MET]: 'CONTRIBUTES_PASS',
    [CriterionResult.NOT_APPLICABLE]: 'INERT',
  }),
  [Severity.MAJOR]: Object.freeze({
    [CriterionResult.NOT_MET]: 'FAIL',
    // R4 — the hole closed. Never FAIL (absence is not proof), never a clean PASS.
    [CriterionResult.INDETERMINATE]: 'QUALIFY_UNVERIFIED',
    [CriterionResult.WAIVED]: 'QUALIFY_WAIVED',
    [CriterionResult.MET]: 'CONTRIBUTES_PASS',
    [CriterionResult.NOT_APPLICABLE]: 'INERT',
  }),
  [Severity.ADVISORY]: Object.freeze({
    [CriterionResult.NOT_MET]: 'FINDING_ONLY',
    [CriterionResult.INDETERMINATE]: 'FINDING_ONLY',
    [CriterionResult.WAIVED]: 'QUALIFY_WAIVED',
    [CriterionResult.MET]: 'CONTRIBUTES_PASS',
    [CriterionResult.NOT_APPLICABLE]: 'INERT',
  }),
});

function dispositionOf(e: CriterionEvaluation): Disposition {
  const bySeverity = SEVERITY_DISPOSITION[e.severity];
  const d = bySeverity[e.value];
  if (d === undefined) {
    // TX-5c: a pair with no defined disposition is non-conformance, not a default.
    return fail({
      code: 'E_GATE_DEFINITION',
      message: 'No disposition defined for severity=' + e.severity + ' value=' + e.value,
      remedy:
        'The severity disposition table must be total. Add the pair to 31 §4.1.1 and to SEVERITY_DISPOSITION.',
      details: { severity: e.severity, value: e.value, criterionRef: e.criterionRef },
      specRef: '31 §4.1.1 TX-5c',
    });
  }
  return d;
}

/** Structural validation of one evaluation before it can take part in composition. */
function assertWellFormed(e: CriterionEvaluation): void {
  if (e.value === CriterionResult.INDETERMINATE && e.reason === undefined) {
    fail({
      code: 'E_VALIDATION',
      message: 'CriterionEvaluation ' + e.id + ' is INDETERMINATE without a reason',
      remedy: 'Set reason to one of the closed set in 31 §2 TX-3b.',
      details: { criterionRef: e.criterionRef },
      specRef: '31 §2 TX-3b',
    });
  }
  if (e.value === CriterionResult.WAIVED && e.waiverRef === undefined) {
    fail({
      code: 'E_VALIDATION',
      message: 'CriterionEvaluation ' + e.id + ' is WAIVED without a waiverRef',
      remedy: 'A waived criterion must reference an active, unexpired waiver (09 §9).',
      details: { criterionRef: e.criterionRef },
      specRef: '08 KI-2b',
    });
  }
  if (e.basis === CriterionBasis.JUDGED && e.judgedBy === undefined) {
    fail({
      code: 'E_VALIDATION',
      message: 'CriterionEvaluation ' + e.id + ' has JUDGED basis without judgedBy',
      remedy: 'A judged basis requires reviewer role, criteria applied, and confidence.',
      details: { criterionRef: e.criterionRef },
      specRef: '08 KI-2b',
    });
  }
  if (e.value !== CriterionResult.INDETERMINATE && e.reason !== undefined) {
    fail({
      code: 'E_VALIDATION',
      message: 'CriterionEvaluation ' + e.id + ' carries a reason but is not INDETERMINATE',
      remedy: 'reason is permitted only when value is INDETERMINATE.',
      details: { criterionRef: e.criterionRef, value: e.value },
      specRef: '31 §2 TX-3b',
    });
  }
}

/**
 * 31 §4.1.2. Returns the gate verdict and the accumulated qualifications.
 *
 * Pure: no I/O, no clock, no randomness. Deterministic for a given input set,
 * which is what makes gate verdicts reproducible (27 NFR-15).
 */
export function composeGateVerdict(evaluations: readonly CriterionEvaluation[]): ComposedVerdict {
  for (const e of evaluations) assertWellFormed(e);

  const qualifications: Qualification[] = [];

  // 1. Precondition failure: the gate could not be run at all.
  for (const e of evaluations) {
    if (
      e.value === CriterionResult.INDETERMINATE &&
      e.reason === IndeterminateReason.PRECONDITION_ABSENT
    ) {
      return { verdict: GateVerdict.BLOCKED, qualifications: [] };
    }
  }

  // 2. Authority escalation outranks substantive outcomes.
  for (const e of evaluations) {
    if (
      e.value === CriterionResult.INDETERMINATE &&
      e.reason === IndeterminateReason.AUTHORITY_REQUIRED
    ) {
      return { verdict: GateVerdict.ESCALATED, qualifications: [] };
    }
  }

  // 3. Proven failure of a blocking criterion.
  for (const e of evaluations) {
    if (dispositionOf(e) === 'FAIL' && e.severity === Severity.BLOCKING) {
      return { verdict: GateVerdict.FAIL, qualifications: [] };
    }
  }

  // 4. Unverifiability of a blocking criterion. Never softened (TX-5).
  for (const e of evaluations) {
    if (dispositionOf(e) === 'NOT_VERIFIED') {
      return { verdict: GateVerdict.NOT_VERIFIED, qualifications: [] };
    }
  }

  // 5. Unwaived major failure.
  for (const e of evaluations) {
    if (dispositionOf(e) === 'FAIL' && e.severity === Severity.MAJOR) {
      return { verdict: GateVerdict.FAIL, qualifications: [] };
    }
  }

  // 6..7. Qualification accumulation. ADVISORY never contributes here (TX-5d).
  for (const e of evaluations) {
    const d = dispositionOf(e);
    if (d === 'QUALIFY_UNVERIFIED') {
      qualifications.push({
        kind: QualificationKind.UNVERIFIED_ASPECT,
        subject: e.criterionRef,
        detail: e.reason ?? IndeterminateReason.EVIDENCE_ABSENT,
        criterionRef: e.criterionRef,
      });
    } else if (d === 'QUALIFY_WAIVED') {
      qualifications.push({
        kind: QualificationKind.ACTIVE_WAIVER,
        subject: e.criterionRef,
        detail: e.waiverRef ?? '',
        criterionRef: e.criterionRef,
      });
    }
    // Judged basis qualifies regardless of disposition, provided the criterion
    // is not inert. 31 §4.1.2 branch 7.
    if (e.basis === CriterionBasis.JUDGED && d !== 'INERT' && d !== 'FINDING_ONLY') {
      qualifications.push({
        kind: QualificationKind.JUDGED_BASIS,
        subject: e.criterionRef,
        detail: e.judgedBy === undefined ? '' : e.judgedBy.role,
        criterionRef: e.criterionRef,
      });
    }
    // Inherited qualifications (e.g. propagated from a verifier result) travel with
    // the gate result (TX-7) -- but ADVISORY criteria contribute nothing to the
    // verdict, qualifications included (TX-5d). Otherwise "advisory" would quietly
    // become "qualifying" and every gate would drift to PASS_WITH_QUALIFICATION.
    if (d !== 'INERT' && d !== 'FINDING_ONLY') {
      for (const q of e.qualifications) qualifications.push(q);
    }
  }

  if (qualifications.length > 0) {
    return { verdict: GateVerdict.PASS_WITH_QUALIFICATION, qualifications };
  }
  return { verdict: GateVerdict.PASS, qualifications: [] };
}
