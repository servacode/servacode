import { describe, expect, it } from 'vitest';
import { composeGateVerdict, SEVERITY_DISPOSITION } from '../src/gates/compose.js';
import {
  CriterionBasis,
  CriterionResult,
  GateVerdict,
  IndeterminateReason,
  QualificationKind,
  Severity,
} from '../src/vocab/index.js';
import { ce } from './helpers.js';

/**
 * TEST CATEGORY A — Gate taxonomy.
 *
 * Every normative vector in 31 §4.2, rows 1-19. These are specification test
 * vectors: an implementation disagreeing with any row is non-conformant.
 */

describe('31 §4.2 — normative composition vectors', () => {
  it('row 1: all MET, all MEASURED -> PASS', () => {
    const r = composeGateVerdict([
      ce({ value: CriterionResult.MET, severity: Severity.BLOCKING }),
      ce({ value: CriterionResult.MET, severity: Severity.MAJOR }),
    ]);
    expect(r.verdict).toBe(GateVerdict.PASS);
    expect(r.qualifications).toHaveLength(0);
  });

  it('row 2: all MET with one JUDGED basis -> PASS_WITH_QUALIFICATION', () => {
    const r = composeGateVerdict([
      ce({ value: CriterionResult.MET, severity: Severity.BLOCKING }),
      ce({ value: CriterionResult.MET, severity: Severity.BLOCKING, basis: CriterionBasis.JUDGED }),
    ]);
    expect(r.verdict).toBe(GateVerdict.PASS_WITH_QUALIFICATION);
    expect(r.qualifications.map((q) => q.kind)).toContain(QualificationKind.JUDGED_BASIS);
  });

  it('row 3: one WAIVED, rest MET/MEASURED -> PASS_WITH_QUALIFICATION', () => {
    const r = composeGateVerdict([
      ce({ value: CriterionResult.MET, severity: Severity.BLOCKING }),
      ce({ value: CriterionResult.WAIVED, severity: Severity.MAJOR, waiverRef: 'W-1' }),
    ]);
    expect(r.verdict).toBe(GateVerdict.PASS_WITH_QUALIFICATION);
    expect(r.qualifications.map((q) => q.kind)).toContain(QualificationKind.ACTIVE_WAIVER);
  });

  it('row 4: one NOT_MET BLOCKING -> FAIL', () => {
    const r = composeGateVerdict([
      ce({ value: CriterionResult.MET, severity: Severity.MAJOR }),
      ce({ value: CriterionResult.NOT_MET, severity: Severity.BLOCKING }),
    ]);
    expect(r.verdict).toBe(GateVerdict.FAIL);
  });

  it('row 5: INDETERMINATE(EVIDENCE_ABSENT) BLOCKING -> NOT_VERIFIED', () => {
    const r = composeGateVerdict([
      ce({
        value: CriterionResult.INDETERMINATE,
        severity: Severity.BLOCKING,
        reason: IndeterminateReason.EVIDENCE_ABSENT,
      }),
    ]);
    expect(r.verdict).toBe(GateVerdict.NOT_VERIFIED);
  });

  it('row 6: INDETERMINATE(PRECONDITION_ABSENT), any severity -> BLOCKED', () => {
    for (const severity of [Severity.BLOCKING, Severity.MAJOR, Severity.ADVISORY]) {
      const r = composeGateVerdict([
        ce({
          value: CriterionResult.INDETERMINATE,
          severity,
          reason: IndeterminateReason.PRECONDITION_ABSENT,
        }),
      ]);
      expect(r.verdict).toBe(GateVerdict.BLOCKED);
    }
  });

  it('row 7: INDETERMINATE(AUTHORITY_REQUIRED), any severity -> ESCALATED', () => {
    for (const severity of [Severity.BLOCKING, Severity.MAJOR, Severity.ADVISORY]) {
      const r = composeGateVerdict([
        ce({
          value: CriterionResult.INDETERMINATE,
          severity,
          reason: IndeterminateReason.AUTHORITY_REQUIRED,
        }),
      ]);
      expect(r.verdict).toBe(GateVerdict.ESCALATED);
    }
  });

  it('row 8: INDETERMINATE(TOOL_UNAVAILABLE) BLOCKING -> NOT_VERIFIED (22 DG-1)', () => {
    const r = composeGateVerdict([
      ce({
        value: CriterionResult.INDETERMINATE,
        severity: Severity.BLOCKING,
        reason: IndeterminateReason.TOOL_UNAVAILABLE,
      }),
    ]);
    expect(r.verdict).toBe(GateVerdict.NOT_VERIFIED);
  });

  it('row 9: NOT_MET MAJOR unwaived -> FAIL', () => {
    const r = composeGateVerdict([
      ce({ value: CriterionResult.MET, severity: Severity.BLOCKING }),
      ce({ value: CriterionResult.NOT_MET, severity: Severity.MAJOR }),
    ]);
    expect(r.verdict).toBe(GateVerdict.FAIL);
  });

  it('row 10: NOT_MET MAJOR waived -> PASS_WITH_QUALIFICATION', () => {
    // 18 GW-2: waiving converts the value to WAIVED, then branch 6/7 applies.
    const r = composeGateVerdict([
      ce({ value: CriterionResult.MET, severity: Severity.BLOCKING }),
      ce({ value: CriterionResult.WAIVED, severity: Severity.MAJOR, waiverRef: 'W-9' }),
    ]);
    expect(r.verdict).toBe(GateVerdict.PASS_WITH_QUALIFICATION);
  });

  it('row 11: NOT_MET ADVISORY -> PASS, findings only (TX-5d)', () => {
    const r = composeGateVerdict([
      ce({ value: CriterionResult.MET, severity: Severity.BLOCKING }),
      ce({ value: CriterionResult.NOT_MET, severity: Severity.ADVISORY }),
    ]);
    expect(r.verdict).toBe(GateVerdict.PASS);
    expect(r.qualifications).toHaveLength(0);
  });

  it('row 12: BLOCKING NOT_MET + PRECONDITION_ABSENT -> BLOCKED (branch order, TX-5b)', () => {
    const r = composeGateVerdict([
      ce({ value: CriterionResult.NOT_MET, severity: Severity.BLOCKING }),
      ce({
        value: CriterionResult.INDETERMINATE,
        severity: Severity.MAJOR,
        reason: IndeterminateReason.PRECONDITION_ABSENT,
      }),
    ]);
    expect(r.verdict).toBe(GateVerdict.BLOCKED);
  });

  it('row 13: all NOT_APPLICABLE -> PASS (inert)', () => {
    const r = composeGateVerdict([
      ce({ value: CriterionResult.NOT_APPLICABLE, severity: Severity.BLOCKING }),
      ce({ value: CriterionResult.NOT_APPLICABLE, severity: Severity.MAJOR }),
    ]);
    expect(r.verdict).toBe(GateVerdict.PASS);
    expect(r.qualifications).toHaveLength(0);
  });

  it('row 14 (R4): MAJOR + INDETERMINATE(EVIDENCE_ABSENT) -> PWQ + UNVERIFIED_ASPECT', () => {
    const r = composeGateVerdict([
      ce({ value: CriterionResult.MET, severity: Severity.BLOCKING }),
      ce({
        value: CriterionResult.INDETERMINATE,
        severity: Severity.MAJOR,
        reason: IndeterminateReason.EVIDENCE_ABSENT,
      }),
    ]);
    expect(r.verdict).toBe(GateVerdict.PASS_WITH_QUALIFICATION);
    const q = r.qualifications.find((x) => x.kind === QualificationKind.UNVERIFIED_ASPECT);
    expect(q).toBeDefined();
    expect(q?.detail).toBe(IndeterminateReason.EVIDENCE_ABSENT);
  });

  it('row 15 (R4): MAJOR + INDETERMINATE(EVIDENCE_INVALID) -> PWQ', () => {
    const r = composeGateVerdict([
      ce({
        value: CriterionResult.INDETERMINATE,
        severity: Severity.MAJOR,
        reason: IndeterminateReason.EVIDENCE_INVALID,
      }),
    ]);
    expect(r.verdict).toBe(GateVerdict.PASS_WITH_QUALIFICATION);
    expect(r.qualifications[0]?.detail).toBe(IndeterminateReason.EVIDENCE_INVALID);
  });

  it('row 16 (R4): MAJOR + INDETERMINATE(TOOL_UNAVAILABLE) -> PWQ', () => {
    const r = composeGateVerdict([
      ce({
        value: CriterionResult.INDETERMINATE,
        severity: Severity.MAJOR,
        reason: IndeterminateReason.TOOL_UNAVAILABLE,
      }),
    ]);
    expect(r.verdict).toBe(GateVerdict.PASS_WITH_QUALIFICATION);
    expect(r.qualifications[0]?.detail).toBe(IndeterminateReason.TOOL_UNAVAILABLE);
  });

  it('row 17 (R4): ADVISORY + INDETERMINATE -> PASS, no qualification (TX-5d)', () => {
    const r = composeGateVerdict([
      ce({ value: CriterionResult.MET, severity: Severity.BLOCKING }),
      ce({
        value: CriterionResult.INDETERMINATE,
        severity: Severity.ADVISORY,
        reason: IndeterminateReason.EVIDENCE_ABSENT,
      }),
    ]);
    expect(r.verdict).toBe(GateVerdict.PASS);
    expect(r.qualifications).toHaveLength(0);
  });

  it('row 19: MAJOR INDETERMINATE + BLOCKING NOT_MET -> FAIL (branch 3 precedes 6)', () => {
    const r = composeGateVerdict([
      ce({
        value: CriterionResult.INDETERMINATE,
        severity: Severity.MAJOR,
        reason: IndeterminateReason.EVIDENCE_ABSENT,
      }),
      ce({ value: CriterionResult.NOT_MET, severity: Severity.BLOCKING }),
    ]);
    expect(r.verdict).toBe(GateVerdict.FAIL);
  });
});

describe('31 §4.1.1 — severity disposition table is TOTAL (TX-5c, DC-37)', () => {
  it('defines a disposition for every (severity, value) pair', () => {
    const severities = Object.values(Severity);
    const values = Object.values(CriterionResult);
    expect(severities).toHaveLength(3);
    expect(values).toHaveLength(5);
    for (const s of severities) {
      for (const v of values) {
        expect(SEVERITY_DISPOSITION[s][v], s + ' x ' + v).toBeDefined();
      }
    }
  });

  it('MAJOR + INDETERMINATE is QUALIFY_UNVERIFIED, not a pass-through', () => {
    expect(SEVERITY_DISPOSITION[Severity.MAJOR][CriterionResult.INDETERMINATE]).toBe(
      'QUALIFY_UNVERIFIED',
    );
  });
});

describe('composition structural validation', () => {
  it('rejects INDETERMINATE without a reason (TX-3b)', () => {
    const bad = { ...ce({ value: CriterionResult.MET, severity: Severity.BLOCKING }) };
    const broken = { ...bad, value: CriterionResult.INDETERMINATE } as typeof bad;
    expect(() => composeGateVerdict([broken])).toThrowError(/INDETERMINATE without a reason/);
  });

  it('rejects WAIVED without a waiverRef', () => {
    const base = ce({ value: CriterionResult.MET, severity: Severity.MAJOR });
    const broken = { ...base, value: CriterionResult.WAIVED };
    expect(() => composeGateVerdict([broken])).toThrowError(/WAIVED without a waiverRef/);
  });

  it('rejects a reason on a non-INDETERMINATE result', () => {
    const base = ce({ value: CriterionResult.MET, severity: Severity.MAJOR });
    const broken = { ...base, reason: IndeterminateReason.EVIDENCE_ABSENT };
    expect(() => composeGateVerdict([broken])).toThrowError(/not INDETERMINATE/);
  });

  it('empty criterion set yields PASS (nothing applicable in scope)', () => {
    expect(composeGateVerdict([]).verdict).toBe(GateVerdict.PASS);
  });
});
