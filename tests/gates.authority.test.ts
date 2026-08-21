import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateGate, bindEvaluationsToGate } from '../src/gates/engine.js';
import {
  ConditionRegistry,
  StoreWaiverAuthority,
  WAIVER_CANON_TYPE,
  type ApplicabilityAuthority,
  type ApplicabilityCondition,
  type WaiverAuthority,
  type WaiverRecord,
} from '../src/gates/authority.js';
import {
  CriterionResult,
  GateVerdict,
  QualificationKind,
  Severity,
  WaiverState,
} from '../src/vocab/index.js';
import { FixedClock } from '../src/core/clock.js';
import { SequentialIdSource } from '../src/core/ids.js';
import { ce, cleanup, criterion, freshStore } from './helpers.js';
import type { GateEngineDeps } from '../src/gates/engine.js';
import type { QualityGate } from '../src/gates/types.js';
import type { Store } from '../src/store/store.js';

/**
 * GATE AUTHORITY.
 *
 * Three fields carried by a CriterionEvaluation decide whether a criterion binds:
 * `severity`, `NOT_APPLICABLE`, and `WAIVED`. All three belong to the gate, not to
 * whoever answers it. These tests exist to prove there is no path by which a
 * caller-supplied value for any of them changes the canonical outcome.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

function setup(): { store: Store } {
  const s = freshStore();
  roots.push(s.root);
  return { store: s.store };
}

const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2027-01-01T00:00:00.000Z';
const EARLIER = '2025-01-01T00:00:00.000Z';

function deps(extra: Partial<GateEngineDeps> = {}): GateEngineDeps {
  return {
    ids: new SequentialIdSource(),
    clock: new FixedClock(NOW, 0),
    evaluator: 'TEST',
    ...extra,
  };
}

/** A gate whose three criteria carry three different severities. */
function gate(overrides: Partial<QualityGate> = {}): QualityGate {
  return {
    id: 'SC-GATE-CODE_REVIEW',
    name: 'Code Review',
    version: '1.0.0',
    blocking: true,
    invalidationSet: [],
    waivable: true,
    criteria: [
      criterion({ id: 'C1', severity: Severity.BLOCKING }),
      criterion({ id: 'C2', severity: Severity.MAJOR }),
      criterion({ id: 'C3', severity: Severity.ADVISORY }),
    ],
    ...overrides,
  };
}

/** All three criteria MET at their defined severities. The honest baseline. */
const allMet = () => [
  ce({ value: CriterionResult.MET, severity: Severity.BLOCKING, criterionRef: 'C1' }),
  ce({ value: CriterionResult.MET, severity: Severity.MAJOR, criterionRef: 'C2' }),
  ce({ value: CriterionResult.MET, severity: Severity.ADVISORY, criterionRef: 'C3' }),
];

function run(g: QualityGate, evaluations: ReturnType<typeof allMet>, d = deps()) {
  const { store } = setup();
  const tx = store.begin();
  const r = evaluateGate(tx, d, { gate: g, scope: 'SC-WI-000001', evaluations });
  tx.commit();
  return r;
}

/* ==================================================== severity is gate-owned */

describe('severity is owned by the gate definition, never by the caller', () => {
  it('1. BLOCKING criterion answered NOT_MET at ADVISORY severity is rejected', () => {
    const evaluations = [
      // The bypass: a proven failure of a blocking criterion, relabelled advisory.
      // Under the old code this composed to FINDING_ONLY and the gate reached PASS.
      ce({ value: CriterionResult.NOT_MET, severity: Severity.ADVISORY, criterionRef: 'C1' }),
      ce({ value: CriterionResult.MET, severity: Severity.MAJOR, criterionRef: 'C2' }),
      ce({ value: CriterionResult.MET, severity: Severity.ADVISORY, criterionRef: 'C3' }),
    ];
    expect(() => run(gate(), evaluations)).toThrowError(
      /claims severity ADVISORY but gate .* defines it as BLOCKING/,
    );
  });

  it('1b. and it can never reach PASS by any route', () => {
    const evaluations = [
      ce({ value: CriterionResult.NOT_MET, severity: Severity.ADVISORY, criterionRef: 'C1' }),
      ce({ value: CriterionResult.MET, severity: Severity.MAJOR, criterionRef: 'C2' }),
      ce({ value: CriterionResult.MET, severity: Severity.ADVISORY, criterionRef: 'C3' }),
    ];
    let verdict: GateVerdict | 'REJECTED' = 'REJECTED';
    try {
      verdict = run(gate(), evaluations).verdict;
    } catch {
      /* expected */
    }
    expect(verdict).toBe('REJECTED');
  });

  it('2. MAJOR criterion answered NOT_MET at ADVISORY severity is rejected', () => {
    const evaluations = [
      ce({ value: CriterionResult.MET, severity: Severity.BLOCKING, criterionRef: 'C1' }),
      ce({ value: CriterionResult.NOT_MET, severity: Severity.ADVISORY, criterionRef: 'C2' }),
      ce({ value: CriterionResult.MET, severity: Severity.ADVISORY, criterionRef: 'C3' }),
    ];
    expect(() => run(gate(), evaluations)).toThrowError(
      /claims severity ADVISORY but gate .* defines it as MAJOR/,
    );
  });

  it('2b. escalating severity is refused too — the caller does not set it either way', () => {
    const evaluations = [
      ce({ value: CriterionResult.MET, severity: Severity.BLOCKING, criterionRef: 'C1' }),
      ce({ value: CriterionResult.MET, severity: Severity.MAJOR, criterionRef: 'C2' }),
      ce({ value: CriterionResult.NOT_MET, severity: Severity.BLOCKING, criterionRef: 'C3' }),
    ];
    expect(() => run(gate(), evaluations)).toThrowError(/claims severity BLOCKING/);
  });

  it('3. matching severity is accepted', () => {
    expect(run(gate(), allMet()).verdict).toBe(GateVerdict.PASS);
  });

  it('3b. the honest answer at the defined severity still FAILs the gate', () => {
    const evaluations = [
      ce({ value: CriterionResult.NOT_MET, severity: Severity.BLOCKING, criterionRef: 'C1' }),
      ce({ value: CriterionResult.MET, severity: Severity.MAJOR, criterionRef: 'C2' }),
      ce({ value: CriterionResult.MET, severity: Severity.ADVISORY, criterionRef: 'C3' }),
    ];
    expect(run(gate(), evaluations).verdict).toBe(GateVerdict.FAIL);
  });

  it('11. no caller-supplied severity can change the canonical outcome', () => {
    // Exhaustive over (criterion, claimed severity, value). For every combination:
    // either the claim matches the definition — in which case the verdict is the
    // one the definition dictates — or it is rejected outright. There is no third
    // outcome, so severity cannot be used to steer a verdict.
    const g = gate();
    const severities = [Severity.BLOCKING, Severity.MAJOR, Severity.ADVISORY];
    const values = [CriterionResult.MET, CriterionResult.NOT_MET];
    let rejected = 0;
    let accepted = 0;

    for (const target of g.criteria) {
      for (const claimed of severities) {
        for (const value of values) {
          const evaluations = g.criteria.map((c) =>
            c.id === target.id
              ? ce({ value, severity: claimed, criterionRef: c.id })
              : ce({ value: CriterionResult.MET, severity: c.severity, criterionRef: c.id }),
          );
          if (claimed !== target.severity) {
            expect(() => bindEvaluationsToGate(g, 'SC-WI-000001', evaluations, deps())).toThrow();
            rejected += 1;
            continue;
          }
          const bound = bindEvaluationsToGate(g, 'SC-WI-000001', evaluations, deps());
          // Whatever was claimed, what composition sees is the definition's value.
          for (const b of bound) {
            expect(b.severity).toBe(g.criteria.find((c) => c.id === b.criterionRef)!.severity);
          }
          accepted += 1;
        }
      }
    }
    expect(rejected).toBe(12); // 3 criteria x 2 wrong severities x 2 values
    expect(accepted).toBe(6); // 3 criteria x 1 correct severity x 2 values
  });

  it('composition only ever sees gate-owned severity (re-stamped, not merely checked)', () => {
    const g = gate();
    const bound = bindEvaluationsToGate(g, 'SC-WI-000001', allMet(), deps());
    expect(bound.map((b) => b.severity)).toEqual([
      Severity.BLOCKING,
      Severity.MAJOR,
      Severity.ADVISORY,
    ]);
  });
});

/* ======================================================== NOT_APPLICABLE */

const CONDITIONAL = 'subject-is-a-public-api';

/** A gate whose C2 applies only conditionally. */
function conditionalGate(): QualityGate {
  return gate({
    criteria: [
      criterion({ id: 'C1', severity: Severity.BLOCKING }),
      criterion({
        id: 'C2',
        severity: Severity.MAJOR,
        applicability: { condition: CONDITIONAL },
      }),
      criterion({ id: 'C3', severity: Severity.ADVISORY }),
    ],
  });
}

function naEvaluations() {
  return [
    ce({ value: CriterionResult.MET, severity: Severity.BLOCKING, criterionRef: 'C1' }),
    ce({ value: CriterionResult.NOT_APPLICABLE, severity: Severity.MAJOR, criterionRef: 'C2' }),
    ce({ value: CriterionResult.MET, severity: Severity.ADVISORY, criterionRef: 'C3' }),
  ];
}

function registry(applies: boolean): { authority: ApplicabilityAuthority; store: Store } {
  const { store } = setup();
  const condition: ApplicabilityCondition = () => applies;
  return { authority: new ConditionRegistry(store, new Map([[CONDITIONAL, condition]])), store };
}

describe('NOT_APPLICABLE is a runtime determination, not a caller assertion', () => {
  it('4. an ALWAYS criterion can never be NOT_APPLICABLE', () => {
    // Previously this was accepted and composed to INERT — a universal bypass:
    // any criterion could be skipped simply by naming the value.
    const { authority } = registry(false);
    expect(() => run(gate(), naEvaluations(), deps({ applicability: authority }))).toThrowError(
      /applies ALWAYS and cannot be NOT_APPLICABLE/,
    );
  });

  it('5. a conditional NOT_APPLICABLE with no authority configured is rejected', () => {
    expect(() => run(conditionalGate(), naEvaluations(), deps())).toThrowError(
      /no applicability authority is configured/,
    );
  });

  it('5b. a condition the authority does not recognise is rejected, not assumed', () => {
    const { store } = setup();
    const empty = new ConditionRegistry(store, new Map());
    expect(() =>
      run(conditionalGate(), naEvaluations(), deps({ applicability: empty })),
    ).toThrowError(/is not registered/);
  });

  it('5c. NOT_APPLICABLE is rejected when the condition actually holds', () => {
    const { authority } = registry(true);
    expect(() =>
      run(conditionalGate(), naEvaluations(), deps({ applicability: authority })),
    ).toThrowError(/but condition .* holds/);
  });

  it('6. a conditional NOT_APPLICABLE with an authoritative basis is accepted', () => {
    const { authority } = registry(false);
    const r = run(conditionalGate(), naEvaluations(), deps({ applicability: authority }));
    expect(r.verdict).toBe(GateVerdict.PASS); // INERT contributes nothing
  });

  it('6b. the reason applicability was rejected is preserved on the record', () => {
    const { authority } = registry(false);
    const bound = bindEvaluationsToGate(
      conditionalGate(),
      'SC-WI-000001',
      naEvaluations(),
      deps({ applicability: authority }),
    );
    const na = bound.find((b) => b.criterionRef === 'C2')!;
    expect(na.applicabilityBasis).toEqual({
      condition: CONDITIONAL,
      resolvedBy: 'CONDITION_REGISTRY',
      resolvedAt: NOW,
    });
  });

  it('6c. a caller-supplied applicability basis is replaced by the resolved one', () => {
    const { authority } = registry(false);
    const forged = naEvaluations().map((e) =>
      e.criterionRef === 'C2'
        ? {
            ...e,
            applicabilityBasis: {
              condition: 'something-else',
              resolvedBy: 'THE_CALLER',
              resolvedAt: '1999-01-01T00:00:00.000Z',
            },
          }
        : e,
    );
    const bound = bindEvaluationsToGate(
      conditionalGate(),
      'SC-WI-000001',
      forged,
      deps({ applicability: authority }),
    );
    const na = bound.find((b) => b.criterionRef === 'C2')!;
    expect(na.applicabilityBasis?.resolvedBy).toBe('CONDITION_REGISTRY');
    expect(na.applicabilityBasis?.condition).toBe(CONDITIONAL);
  });

  it('the condition is resolved against the store, not against the request', () => {
    const { store } = setup();
    // A condition that reads stored state, the same shape as a step exitCondition.
    const condition: ApplicabilityCondition = (s, scope) =>
      s.getCanon('workItem', scope) !== undefined;
    const authority = new ConditionRegistry(store, new Map([[CONDITIONAL, condition]]));

    // Nothing stored: the criterion does not apply, and NOT_APPLICABLE stands.
    const tx = store.begin();
    expect(() =>
      evaluateGate(tx, deps({ applicability: authority }), {
        gate: conditionalGate(),
        scope: 'SC-WI-000001',
        evaluations: naEvaluations(),
      }),
    ).not.toThrow();

    // Store the subject: the condition now holds and the exemption is refused.
    tx.putCanon('workItem', 'SC-WI-000001', { title: 'public api' });
    tx.commit();
    const tx2 = store.begin();
    expect(() =>
      evaluateGate(tx2, deps({ applicability: authority }), {
        gate: conditionalGate(),
        scope: 'SC-WI-000001',
        evaluations: naEvaluations(),
      }),
    ).toThrowError(/holds/);
  });
});

/* ================================================================ WAIVED */

function waiver(over: Partial<WaiverRecord> = {}): WaiverRecord {
  return {
    id: 'SC-WV-000001',
    gateRef: 'SC-GATE-CODE_REVIEW',
    criterionRef: 'C2',
    scope: 'SC-WI-000001',
    state: WaiverState.ACTIVE,
    expiresAt: LATER,
    authority: 'OWNER',
    justification: 'accepted for the pilot release, remediation tracked',
    ...over,
  };
}

/** A store-backed authority holding one waiver record in T-CANON. */
function withWaiver(rec: WaiverRecord | undefined): { authority: WaiverAuthority; store: Store } {
  const { store } = setup();
  if (rec !== undefined) {
    const tx = store.begin();
    tx.putCanon(WAIVER_CANON_TYPE, rec.id, rec);
    tx.commit();
  }
  return { authority: new StoreWaiverAuthority(store), store };
}

function waivedEvaluations(waiverRef = 'SC-WV-000001') {
  return [
    ce({ value: CriterionResult.MET, severity: Severity.BLOCKING, criterionRef: 'C1' }),
    ce({
      value: CriterionResult.WAIVED,
      severity: Severity.MAJOR,
      criterionRef: 'C2',
      waiverRef,
    }),
    ce({ value: CriterionResult.MET, severity: Severity.ADVISORY, criterionRef: 'C3' }),
  ];
}

describe('WAIVED requires a resolved, valid, authorised waiver', () => {
  it('7. WAIVED on a non-waivable gate is rejected', () => {
    const { authority } = withWaiver(waiver());
    expect(() =>
      run(gate({ waivable: false }), waivedEvaluations(), deps({ waivers: authority })),
    ).toThrowError(/is not waivable/);
  });

  it('7b. WAIVED on a criterion marked unwaivable is rejected even on a waivable gate', () => {
    const { authority } = withWaiver(waiver());
    const g = gate({
      criteria: [
        criterion({ id: 'C1', severity: Severity.BLOCKING }),
        criterion({ id: 'C2', severity: Severity.MAJOR, waivable: false }),
        criterion({ id: 'C3', severity: Severity.ADVISORY }),
      ],
    });
    expect(() => run(g, waivedEvaluations(), deps({ waivers: authority }))).toThrowError(
      /is not waivable/,
    );
  });

  it('7c. WAIVED with no waiver authority configured is rejected, never trusted', () => {
    expect(() => run(gate(), waivedEvaluations(), deps())).toThrowError(
      /no waiver authority is configured/,
    );
  });

  it('8. WAIVED with an unknown waiverRef is rejected', () => {
    const { authority } = withWaiver(undefined);
    expect(() => run(gate(), waivedEvaluations(), deps({ waivers: authority }))).toThrowError(
      /Waiver SC-WV-000001 does not exist/,
    );
  });

  it('8b. an arbitrary non-empty string is not a waiver', () => {
    const { authority } = withWaiver(waiver());
    expect(() =>
      run(gate(), waivedEvaluations('trust-me'), deps({ waivers: authority })),
    ).toThrowError(/does not exist/);
  });

  it('9. an expired waiver is rejected (W-4/GW-5 — expiry re-blocks)', () => {
    const { authority } = withWaiver(waiver({ expiresAt: EARLIER }));
    expect(() => run(gate(), waivedEvaluations(), deps({ waivers: authority }))).toThrowError(
      /waiver expired at/,
    );
  });

  it('9b. a REVOKED waiver is rejected', () => {
    const { authority } = withWaiver(waiver({ state: WaiverState.REVOKED }));
    expect(() => run(gate(), waivedEvaluations(), deps({ waivers: authority }))).toThrowError(
      /waiver state is REVOKED/,
    );
  });

  it('9c. a waiver targeting a different criterion is rejected (GW-1)', () => {
    const { authority } = withWaiver(waiver({ criterionRef: 'C3' }));
    expect(() => run(gate(), waivedEvaluations(), deps({ waivers: authority }))).toThrowError(
      /waiver targets criterion C3, not C2/,
    );
  });

  it('9d. a waiver scoped to a different subject is rejected (GW-1)', () => {
    const { authority } = withWaiver(waiver({ scope: 'SC-WI-000999' }));
    expect(() => run(gate(), waivedEvaluations(), deps({ waivers: authority }))).toThrowError(
      /waiver is scoped to SC-WI-000999/,
    );
  });

  it('9e. a waiver targeting a different gate is rejected', () => {
    const { authority } = withWaiver(waiver({ gateRef: 'SC-GATE-RELEASE' }));
    expect(() => run(gate(), waivedEvaluations(), deps({ waivers: authority }))).toThrowError(
      /waiver targets gate SC-GATE-RELEASE/,
    );
  });

  it('9f. a waiver granted by anyone but the owner is rejected (09 §2)', () => {
    const { authority } = withWaiver(waiver({ authority: 'SC-AGENT-200' }));
    expect(() => run(gate(), waivedEvaluations(), deps({ waivers: authority }))).toThrowError(
      /a policy waiver requires OWNER/,
    );
  });

  it('9g. a malformed waiver record grants nothing', () => {
    const { store } = setup();
    const tx = store.begin();
    tx.putCanon(WAIVER_CANON_TYPE, 'SC-WV-000001', { id: 'SC-WV-000001', nonsense: true });
    tx.commit();
    const authority = new StoreWaiverAuthority(store);
    expect(() => run(gate(), waivedEvaluations(), deps({ waivers: authority }))).toThrowError(
      /does not exist/,
    );
  });

  it('10. a valid, authorised, active waiver yields PASS_WITH_QUALIFICATION', () => {
    const { authority } = withWaiver(waiver());
    const r = run(gate(), waivedEvaluations(), deps({ waivers: authority }));
    expect(r.verdict).toBe(GateVerdict.PASS_WITH_QUALIFICATION);
    expect(r.qualifications.map((q) => q.kind)).toContain(QualificationKind.ACTIVE_WAIVER);
    expect(r.qualifications.find((q) => q.criterionRef === 'C2')?.detail).toBe('SC-WV-000001');
  });

  it('10b. a waiver never yields a clean PASS (GW-2)', () => {
    const { authority } = withWaiver(waiver());
    const r = run(gate(), waivedEvaluations(), deps({ waivers: authority }));
    expect(r.verdict).not.toBe(GateVerdict.PASS);
  });

  it('an out-of-band edit to a waiver record is detected, not honoured', () => {
    const { authority, store } = withWaiver(waiver());
    // Canon integrity: rewriting the body without its digest fails the read.
    const path = join(store.paths.canon, WAIVER_CANON_TYPE, 'SC-WV-000001', 'v1.json');
    const env = JSON.parse(readFileSync(path, 'utf8')) as { body: WaiverRecord };
    env.body = { ...env.body, criterionRef: 'C1' };
    writeFileSync(path, JSON.stringify(env, null, 2), 'utf8');
    expect(() => authority.resolve('SC-WV-000001')).toThrowError(/body digest mismatch/);
  });
});
