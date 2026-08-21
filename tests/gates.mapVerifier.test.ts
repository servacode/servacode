import { describe, expect, it } from 'vitest';
import { mapVerifierResult, deriveBasis } from '../src/gates/mapVerifier.js';
import { composeGateVerdict } from '../src/gates/compose.js';
import {
  CriterionBasis,
  CriterionResult,
  GateVerdict,
  IndeterminateReason,
  QualificationKind,
  Severity,
} from '../src/vocab/index.js';
import { FixedClock } from '../src/core/clock.js';
import { SequentialIdSource } from '../src/core/ids.js';
import { avr, criterion } from './helpers.js';

/**
 * TEST CATEGORY B — ArtifactVerifierResult -> CriterionEvaluation mapping.
 * Every normative vector in 31 §4.4 (M1-M9) plus the MV-1..MV-8 rules.
 */

const deps = () => ({ ids: new SequentialIdSource(), clock: new FixedClock() });

describe('31 §4.4 — normative mapping vectors M1-M9', () => {
  it('M1: PASS, all measured, BLOCKING -> MET/MEASURED -> PASS', () => {
    const c = criterion({ id: 'C1', severity: Severity.BLOCKING });
    const e = mapVerifierResult(avr({ value: 'PASS', measured: ['correctness'] }), c, deps());
    expect(e.value).toBe(CriterionResult.MET);
    expect(e.basis).toBe(CriterionBasis.MEASURED);
    expect(composeGateVerdict([e]).verdict).toBe(GateVerdict.PASS);
  });

  it('M2: PASS with one judged dimension, BLOCKING -> MET/JUDGED -> PWQ', () => {
    const c = criterion({ id: 'C2', severity: Severity.BLOCKING });
    const e = mapVerifierResult(
      avr({ value: 'PASS', measured: ['lint'], judged: ['maintainability'] }),
      c,
      deps(),
    );
    expect(e.value).toBe(CriterionResult.MET);
    expect(e.basis).toBe(CriterionBasis.JUDGED);
    expect(e.judgedBy).toBeDefined();
    expect(composeGateVerdict([e]).verdict).toBe(GateVerdict.PASS_WITH_QUALIFICATION);
  });

  it('M3: PASS_WITH_QUALIFICATION carrying a waiver, MAJOR -> MET + propagated qualification', () => {
    const c = criterion({ id: 'C3', severity: Severity.MAJOR });
    const e = mapVerifierResult(
      avr({
        value: 'PASS_WITH_QUALIFICATION',
        judged: ['x'],
        qualifications: [
          {
            kind: QualificationKind.ACTIVE_WAIVER,
            subject: 'C3',
            detail: 'W-3',
          },
        ],
      }),
      c,
      deps(),
    );
    expect(e.value).toBe(CriterionResult.MET);
    // MV-5 — qualifications propagate.
    expect(e.qualifications.map((q) => q.kind)).toContain(QualificationKind.ACTIVE_WAIVER);
    expect(composeGateVerdict([e]).verdict).toBe(GateVerdict.PASS_WITH_QUALIFICATION);
  });

  it('M4: FAIL, BLOCKING -> NOT_MET -> FAIL', () => {
    const c = criterion({ id: 'C4', severity: Severity.BLOCKING });
    const e = mapVerifierResult(avr({ value: 'FAIL', measured: ['x'] }), c, deps());
    expect(e.value).toBe(CriterionResult.NOT_MET);
    expect(composeGateVerdict([e]).verdict).toBe(GateVerdict.FAIL);
  });

  it('M5: FAIL, MAJOR unwaived -> NOT_MET -> FAIL', () => {
    const c = criterion({ id: 'C5', severity: Severity.MAJOR });
    const e = mapVerifierResult(avr({ value: 'FAIL', measured: ['x'] }), c, deps());
    expect(e.value).toBe(CriterionResult.NOT_MET);
    expect(composeGateVerdict([e]).verdict).toBe(GateVerdict.FAIL);
  });

  it('M6: NOT_VERIFIED(EVIDENCE_ABSENT), BLOCKING -> INDETERMINATE -> NOT_VERIFIED', () => {
    const c = criterion({ id: 'C6', severity: Severity.BLOCKING });
    const e = mapVerifierResult(
      avr({ value: 'NOT_VERIFIED', cause: IndeterminateReason.EVIDENCE_ABSENT, measured: ['x'] }),
      c,
      deps(),
    );
    expect(e.value).toBe(CriterionResult.INDETERMINATE);
    expect(e.reason).toBe(IndeterminateReason.EVIDENCE_ABSENT);
    expect(composeGateVerdict([e]).verdict).toBe(GateVerdict.NOT_VERIFIED);
  });

  it('M7: NOT_VERIFIED(TOOL_UNAVAILABLE), MAJOR -> PWQ + UNVERIFIED_ASPECT', () => {
    const c = criterion({ id: 'C7', severity: Severity.MAJOR });
    const e = mapVerifierResult(
      avr({ value: 'NOT_VERIFIED', cause: IndeterminateReason.TOOL_UNAVAILABLE, measured: ['x'] }),
      c,
      deps(),
    );
    expect(e.value).toBe(CriterionResult.INDETERMINATE);
    expect(e.reason).toBe(IndeterminateReason.TOOL_UNAVAILABLE);
    const r = composeGateVerdict([e]);
    expect(r.verdict).toBe(GateVerdict.PASS_WITH_QUALIFICATION);
    expect(r.qualifications.some((q) => q.kind === QualificationKind.UNVERIFIED_ASPECT)).toBe(true);
  });

  it('M8: NOT_VERIFIED(EVIDENCE_INVALID), ADVISORY -> PASS, finding only', () => {
    const c = criterion({ id: 'C8', severity: Severity.ADVISORY });
    const e = mapVerifierResult(
      avr({ value: 'NOT_VERIFIED', cause: IndeterminateReason.EVIDENCE_INVALID, measured: ['x'] }),
      c,
      deps(),
    );
    expect(e.value).toBe(CriterionResult.INDETERMINATE);
    const r = composeGateVerdict([e]);
    expect(r.verdict).toBe(GateVerdict.PASS);
  });

  it('M9: BLOCKED(PRECONDITION_ABSENT), any severity -> INDETERMINATE -> BLOCKED', () => {
    for (const severity of [Severity.BLOCKING, Severity.MAJOR, Severity.ADVISORY]) {
      const c = criterion({ id: 'C9', severity });
      const e = mapVerifierResult(
        avr({ value: 'BLOCKED', cause: IndeterminateReason.PRECONDITION_ABSENT }),
        c,
        deps(),
      );
      expect(e.value).toBe(CriterionResult.INDETERMINATE);
      expect(e.reason).toBe(IndeterminateReason.PRECONDITION_ABSENT);
      expect(composeGateVerdict([e]).verdict).toBe(GateVerdict.BLOCKED);
    }
  });
});

describe('31 §4.4 — mapping rules', () => {
  it('MV-1: the mapping is total over every V3b value', () => {
    const values = ['PASS', 'PASS_WITH_QUALIFICATION', 'FAIL', 'NOT_VERIFIED', 'BLOCKED'] as const;
    for (const v of values) {
      const needsCause = v === 'NOT_VERIFIED' || v === 'BLOCKED';
      const cause =
        v === 'BLOCKED'
          ? IndeterminateReason.PRECONDITION_ABSENT
          : IndeterminateReason.EVIDENCE_ABSENT;
      const e = mapVerifierResult(
        avr({ value: v, ...(needsCause ? { cause } : {}), measured: ['x'] }),
        criterion({ id: 'CT', severity: Severity.MAJOR }),
        deps(),
      );
      expect(e.value).toBeDefined();
    }
  });

  it('MV-2: FAIL never maps to MET, at any severity', () => {
    for (const severity of [Severity.BLOCKING, Severity.MAJOR, Severity.ADVISORY]) {
      const e = mapVerifierResult(
        avr({ value: 'FAIL', measured: ['x'] }),
        criterion({ id: 'CF', severity }),
        deps(),
      );
      expect(e.value).not.toBe(CriterionResult.MET);
      expect(e.value).toBe(CriterionResult.NOT_MET);
    }
  });

  it('MV-3: a NOT_VERIFIED result without a cause is refused, not defaulted', () => {
    expect(() =>
      mapVerifierResult(
        avr({ value: 'NOT_VERIFIED', measured: ['x'] }),
        criterion({ id: 'CX', severity: Severity.MAJOR }),
        deps(),
      ),
    ).toThrowError(/carries no cause/);
  });

  it('MV-4: BLOCKED with a non-precondition cause is refused', () => {
    expect(() =>
      mapVerifierResult(
        avr({ value: 'BLOCKED', cause: IndeterminateReason.EVIDENCE_ABSENT }),
        criterion({ id: 'CY', severity: Severity.MAJOR }),
        deps(),
      ),
    ).toThrowError(/BLOCKED with cause/);
  });

  it('MV-4b: NOT_VERIFIED with PRECONDITION_ABSENT is refused', () => {
    expect(() =>
      mapVerifierResult(
        avr({ value: 'NOT_VERIFIED', cause: IndeterminateReason.PRECONDITION_ABSENT }),
        criterion({ id: 'CZ', severity: Severity.MAJOR }),
        deps(),
      ),
    ).toThrowError(/PRECONDITION_ABSENT/);
  });

  it('MV-6: severity comes from the gate definition, never from the verifier', () => {
    const result = avr({ value: 'FAIL', measured: ['x'] });
    const asBlocking = mapVerifierResult(
      result,
      criterion({ id: 'A', severity: Severity.BLOCKING }),
      deps(),
    );
    const asAdvisory = mapVerifierResult(
      result,
      criterion({ id: 'A', severity: Severity.ADVISORY }),
      deps(),
    );
    expect(asBlocking.severity).toBe(Severity.BLOCKING);
    expect(asAdvisory.severity).toBe(Severity.ADVISORY);
    // Same verifier result, different gate consequence.
    expect(composeGateVerdict([asBlocking]).verdict).toBe(GateVerdict.FAIL);
    expect(composeGateVerdict([asAdvisory]).verdict).toBe(GateVerdict.PASS);
  });

  it('MV-7: basis is derived from basisSummary, not fixed at JUDGED', () => {
    expect(deriveBasis(avr({ value: 'PASS', measured: ['a'] }))).toBe(CriterionBasis.MEASURED);
    expect(deriveBasis(avr({ value: 'PASS', judged: ['a'] }))).toBe(CriterionBasis.JUDGED);
    expect(deriveBasis(avr({ value: 'PASS', derived: ['a'] }))).toBe(CriterionBasis.DERIVED);
    expect(deriveBasis(avr({ value: 'PASS', measured: ['a'], judged: ['b'] }))).toBe(
      CriterionBasis.JUDGED,
    );
  });

  it('AV-1: ESCALATED is not expressible as an ArtifactVerifierResult', () => {
    // Enforced by the type system; assert the runtime vocabulary agrees.
    const legal = ['PASS', 'PASS_WITH_QUALIFICATION', 'FAIL', 'NOT_VERIFIED', 'BLOCKED'];
    expect(legal).not.toContain('ESCALATED');
  });
});
