import { describe, expect, it } from 'vitest';
import { composeGateVerdict } from '../src/gates/compose.js';
import {
  evaluateEvidenceCriterion,
  evaluateToolUnavailable,
  assertCriterionWellFormed,
} from '../src/gates/evaluate.js';
import {
  CriterionResult,
  GateVerdict,
  IndeterminateReason,
  QualificationKind,
  Severity,
  ValidityState,
} from '../src/vocab/index.js';
import { FixedClock } from '../src/core/clock.js';
import { SequentialIdSource } from '../src/core/ids.js';
import { ce, criterion } from './helpers.js';
import type { EvidenceRequirement } from '../src/gates/types.js';

/**
 * TEST CATEGORY C — critical regression.
 * TEST CATEGORY D — evidence semantics.
 *
 * These are the tests the R4 audit demanded explicitly. They exist to make the
 * R3 defect impossible to reintroduce silently.
 */

const deps = () => ({ ids: new SequentialIdSource(), clock: new FixedClock() });

const req = (over: Partial<EvidenceRequirement> = {}): EvidenceRequirement => ({
  requiredClass: 'EXECUTION',
  requiredCount: 1,
  independence: false,
  validity: ValidityState.VALID,
  onMissingEvidence: 'INDETERMINATE',
  ...over,
});

describe('C — MAJOR + INDETERMINATE must never produce an unqualified PASS', () => {
  const causes = [
    IndeterminateReason.EVIDENCE_ABSENT,
    IndeterminateReason.EVIDENCE_INVALID,
    IndeterminateReason.TOOL_UNAVAILABLE,
  ] as const;

  for (const cause of causes) {
    it('MAJOR + INDETERMINATE(' + cause + ') !== PASS', () => {
      const r = composeGateVerdict([
        ce({ value: CriterionResult.MET, severity: Severity.BLOCKING }),
        ce({ value: CriterionResult.INDETERMINATE, severity: Severity.MAJOR, reason: cause }),
      ]);
      expect(r.verdict).not.toBe(GateVerdict.PASS);
      expect(r.verdict).toBe(GateVerdict.PASS_WITH_QUALIFICATION);
      expect(r.qualifications.some((q) => q.kind === QualificationKind.UNVERIFIED_ASPECT)).toBe(
        true,
      );
    });

    it('MAJOR + INDETERMINATE(' + cause + ') is also never FAIL (absence is not proof)', () => {
      const r = composeGateVerdict([
        ce({ value: CriterionResult.INDETERMINATE, severity: Severity.MAJOR, reason: cause }),
      ]);
      expect(r.verdict).not.toBe(GateVerdict.FAIL);
    });
  }

  it('the qualification travels with the verdict and names the cause', () => {
    const r = composeGateVerdict([
      ce({
        value: CriterionResult.INDETERMINATE,
        severity: Severity.MAJOR,
        reason: IndeterminateReason.TOOL_UNAVAILABLE,
        criterionRef: 'PERF-01',
      }),
    ]);
    const q = r.qualifications.find((x) => x.kind === QualificationKind.UNVERIFIED_ASPECT);
    expect(q?.criterionRef).toBe('PERF-01');
    expect(q?.detail).toBe(IndeterminateReason.TOOL_UNAVAILABLE);
  });

  it('a single MAJOR indeterminate among many MET criteria still qualifies the gate', () => {
    const evals = [
      ...Array.from({ length: 8 }, () =>
        ce({ value: CriterionResult.MET, severity: Severity.BLOCKING }),
      ),
      ce({
        value: CriterionResult.INDETERMINATE,
        severity: Severity.MAJOR,
        reason: IndeterminateReason.EVIDENCE_ABSENT,
      }),
    ];
    expect(composeGateVerdict(evals).verdict).toBe(GateVerdict.PASS_WITH_QUALIFICATION);
  });
});

describe('D — missing evidence is not proven failure', () => {
  it('absent evidence yields INDETERMINATE, not NOT_MET, by default', () => {
    const c = criterion({ id: 'C-DEFAULT', severity: Severity.MAJOR });
    const e = evaluateEvidenceCriterion(c, req(), [], deps());
    expect(e.value).toBe(CriterionResult.INDETERMINATE);
    expect(e.reason).toBe(IndeterminateReason.EVIDENCE_ABSENT);
    expect(e.value).not.toBe(CriterionResult.NOT_MET);
  });

  it('EXCEPTION: an existence-testing criterion treats absence as the proven negative', () => {
    const c = criterion({
      id: 'C-EXISTS',
      severity: Severity.BLOCKING,
      testsExistence: true,
      onMissingEvidence: 'NOT_MET',
      statement: 'a rollback test was executed',
    });
    const e = evaluateEvidenceCriterion(c, req({ onMissingEvidence: 'NOT_MET' }), [], deps());
    expect(e.value).toBe(CriterionResult.NOT_MET);
    expect(composeGateVerdict([e]).verdict).toBe(GateVerdict.FAIL);
  });

  it('CR-EX1: NOT_MET without testsExistence is refused as a gate-definition defect', () => {
    const bad = criterion({
      id: 'C-BAD',
      testsExistence: false,
      onMissingEvidence: 'NOT_MET',
    });
    expect(() => assertCriterionWellFormed(bad)).toThrowError(/without testsExistence/);
  });

  it('evidence present but not VALID yields INDETERMINATE(EVIDENCE_INVALID), not NOT_MET', () => {
    const c = criterion({ id: 'C-STALE', severity: Severity.MAJOR });
    const e = evaluateEvidenceCriterion(
      c,
      req(),
      [{ id: 'SC-EV-000001', class: 'EXECUTION', validity: ValidityState.STALE, capturedAt: 'x' }],
      deps(),
    );
    expect(e.value).toBe(CriterionResult.INDETERMINATE);
    expect(e.reason).toBe(IndeterminateReason.EVIDENCE_INVALID);
  });

  it('valid evidence meeting the required count yields MET', () => {
    const c = criterion({ id: 'C-OK', severity: Severity.BLOCKING });
    const e = evaluateEvidenceCriterion(
      c,
      req(),
      [{ id: 'SC-EV-000001', class: 'EXECUTION', validity: ValidityState.VALID, capturedAt: 'x' }],
      deps(),
    );
    expect(e.value).toBe(CriterionResult.MET);
    expect(composeGateVerdict([e]).verdict).toBe(GateVerdict.PASS);
  });

  it('22 DG-1: an unavailable runtime component yields INDETERMINATE, never PASS', () => {
    const c = criterion({ id: 'C-TOOL', severity: Severity.BLOCKING });
    const e = evaluateToolUnavailable(c, deps());
    expect(e.value).toBe(CriterionResult.INDETERMINATE);
    expect(e.reason).toBe(IndeterminateReason.TOOL_UNAVAILABLE);
    expect(composeGateVerdict([e]).verdict).toBe(GateVerdict.NOT_VERIFIED);
  });
});
