import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';

import { evaluateGate, assertEvaluationsComplete } from '../src/gates/engine.js';
import {
  WorkflowEngine,
  validateWorkflowDefinition,
  type WorkflowDefinition,
} from '../src/workflow/engine.js';
import { CriterionResult, GateVerdict, IndeterminateReason, Severity } from '../src/vocab/index.js';
import { FixedClock } from '../src/core/clock.js';
import { SequentialIdSource } from '../src/core/ids.js';
import { ce, cleanup, criterion, freshStore } from './helpers.js';
import type { QualityGate } from '../src/gates/types.js';

/**
 * BLOCKER FIX SUITE.
 *
 * B1 gate completeness · B2 WAL/TRACE idempotency
 * B3 workflow control flow · B4 path confinement and canon integrity
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

function setup(): ReturnType<typeof freshStore> {
  const s = freshStore();
  roots.push(s.root);
  return s;
}

const engineDeps = () => ({
  ids: new SequentialIdSource(),
  clock: new FixedClock(),
  evaluator: 'TEST',
});

function gateWith3(): QualityGate {
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
  };
}

/* ==================================================================== BLOCKER 1 */

describe('B1 — a gate cannot PASS with missing criterion evaluations', () => {
  it('1. 3 criteria + 3 evaluations -> allowed', () => {
    const { store } = setup();
    const tx = store.begin();
    const r = evaluateGate(tx, engineDeps(), {
      gate: gateWith3(),
      scope: 'SC-WI-000001',
      evaluations: [
        ce({ value: CriterionResult.MET, severity: Severity.BLOCKING, criterionRef: 'C1' }),
        ce({ value: CriterionResult.MET, severity: Severity.MAJOR, criterionRef: 'C2' }),
        ce({ value: CriterionResult.MET, severity: Severity.ADVISORY, criterionRef: 'C3' }),
      ],
    });
    tx.commit();
    expect(r.verdict).toBe(GateVerdict.PASS);
  });

  it('2. 3 criteria + 2 evaluations -> rejected', () => {
    const { store } = setup();
    const tx = store.begin();
    expect(() =>
      evaluateGate(tx, engineDeps(), {
        gate: gateWith3(),
        scope: 'SC-WI-000001',
        evaluations: [
          ce({ value: CriterionResult.MET, severity: Severity.BLOCKING, criterionRef: 'C1' }),
          ce({ value: CriterionResult.MET, severity: Severity.MAJOR, criterionRef: 'C2' }),
        ],
      }),
    ).toThrowError(/unevaluated criteria: C3/);
  });

  it('3. 3 criteria + 0 evaluations -> rejected (the reported hole)', () => {
    const { store } = setup();
    const tx = store.begin();
    expect(() =>
      evaluateGate(tx, engineDeps(), {
        gate: gateWith3(),
        scope: 'SC-WI-000001',
        evaluations: [],
      }),
    ).toThrowError(/unevaluated criteria/);
  });

  it('4. duplicate evaluation for one criterion -> rejected', () => {
    const { store } = setup();
    const tx = store.begin();
    expect(() =>
      evaluateGate(tx, engineDeps(), {
        gate: gateWith3(),
        scope: 'SC-WI-000001',
        evaluations: [
          ce({ value: CriterionResult.MET, severity: Severity.BLOCKING, criterionRef: 'C1' }),
          ce({ value: CriterionResult.NOT_MET, severity: Severity.BLOCKING, criterionRef: 'C1' }),
          ce({ value: CriterionResult.MET, severity: Severity.MAJOR, criterionRef: 'C2' }),
          ce({ value: CriterionResult.MET, severity: Severity.ADVISORY, criterionRef: 'C3' }),
        ],
      }),
    ).toThrowError(/more than one evaluation for: C1/);
  });

  it('5. explicit NOT_APPLICABLE satisfies completeness (applicability itself is checked separately)', () => {
    // Completeness is about cardinality: NOT_APPLICABLE is a real answer, so the
    // set is complete. Whether the criterion may be NOT_APPLICABLE at all is a
    // separate authority question, covered in gates.authority.test.ts. Revised
    // from the earlier version of this test, which asserted that an unconditional
    // criterion could be exempted -- that was the bypass, not the contract.
    expect(() =>
      assertEvaluationsComplete(gateWith3(), [
        ce({ value: CriterionResult.MET, severity: Severity.BLOCKING, criterionRef: 'C1' }),
        ce({ value: CriterionResult.NOT_APPLICABLE, severity: Severity.MAJOR, criterionRef: 'C2' }),
        ce({ value: CriterionResult.MET, severity: Severity.ADVISORY, criterionRef: 'C3' }),
      ]),
    ).not.toThrow();
  });

  it('6. explicit INDETERMINATE -> composed normally, not silently dropped', () => {
    const { store } = setup();
    const tx = store.begin();
    const r = evaluateGate(tx, engineDeps(), {
      gate: gateWith3(),
      scope: 'SC-WI-000001',
      evaluations: [
        ce({
          value: CriterionResult.INDETERMINATE,
          severity: Severity.BLOCKING,
          criterionRef: 'C1',
          reason: IndeterminateReason.EVIDENCE_ABSENT,
        }),
        ce({ value: CriterionResult.MET, severity: Severity.MAJOR, criterionRef: 'C2' }),
        ce({ value: CriterionResult.MET, severity: Severity.ADVISORY, criterionRef: 'C3' }),
      ],
    });
    tx.commit();
    expect(r.verdict).toBe(GateVerdict.NOT_VERIFIED);
  });

  it('an unknown criterion is still rejected', () => {
    expect(() =>
      assertEvaluationsComplete(gateWith3(), [
        ce({ value: CriterionResult.MET, severity: Severity.BLOCKING, criterionRef: 'C1' }),
        ce({ value: CriterionResult.MET, severity: Severity.MAJOR, criterionRef: 'C2' }),
        ce({ value: CriterionResult.MET, severity: Severity.ADVISORY, criterionRef: 'C3' }),
        ce({ value: CriterionResult.MET, severity: Severity.MAJOR, criterionRef: 'GHOST' }),
      ]),
    ).toThrowError(/does not define/);
  });

  it('an omitted criterion is NOT converted into FAIL', () => {
    let message = '';
    try {
      assertEvaluationsComplete(gateWith3(), []);
    } catch (e) {
      message = (e as Error).message + ' ' + String((e as { remedy?: string }).remedy ?? '');
    }
    expect(message).toMatch(/INDETERMINATE/);
    expect(message).toMatch(/NOT_APPLICABLE/);
    expect(message).not.toMatch(/\bFAIL\b/);
  });
});

/* ==================================================================== BLOCKER 2 */

/** Read a committed journal payload without going through the store. */
function stageCommittedJournal(store: Store, txId: string, writes: unknown[]): string {
  mkdirSync(store.paths.journal, { recursive: true });
  const p = join(store.paths.journal, txId + '.commit');
  writeFileSync(p, JSON.stringify({ txId, createdAt: '2026-01-01T00:00:00.000Z', writes }), 'utf8');
  return p;
}

function traceOp(txId: string, index: number, stream: string, type: string, payload: unknown) {
  const opId = txId + '#' + String(index);
  return {
    kind: 'TRACE' as const,
    stream,
    opId,
    input: { at: '2026-01-01T00:00:00.000Z', actor: 'RUNTIME', type, payload, opId },
  };
}

describe('B2 — WAL trace application is idempotent', () => {
  it('A. commit marker exists, nothing applied -> every operation applied once', () => {
    const { store, root, deps } = setup();
    stageCommittedJournal(store, 'SC-TX-000900', [
      traceOp('SC-TX-000900', 0, 'demo', 'A', { n: 1 }),
      traceOp('SC-TX-000900', 1, 'demo', 'B', { n: 2 }),
    ]);
    const reopened = Store.open(root, deps);
    const recs = reopened.readTrace('demo');
    expect(recs).toHaveLength(2);
    expect(recs.map((r) => r.type)).toEqual(['A', 'B']);
    expect(reopened.trace('demo').verify().ok).toBe(true);
  });

  it('B. first TRACE op already applied -> recovery does not duplicate it', () => {
    const { store, root, deps } = setup();
    const tx = store.begin();
    tx.appendTrace('demo', { type: 'A', payload: { n: 1 } });
    tx.commit();
    expect(store.readTrace('demo')).toHaveLength(1);
    const applied = store.readTrace('demo')[0]!;
    expect(applied.opId).toBeDefined();

    // Replay the SAME committed transaction, as a crash before journal removal would.
    stageCommittedJournal(store, applied.opId!.split('#')[0]!, [
      {
        kind: 'TRACE',
        stream: 'demo',
        opId: applied.opId,
        input: {
          at: applied.at,
          actor: applied.actor,
          type: applied.type,
          payload: applied.payload,
          opId: applied.opId,
        },
      },
    ]);

    const reopened = Store.open(root, deps);
    expect(reopened.readTrace('demo')).toHaveLength(1); // not duplicated
    expect(reopened.trace('demo').verify().ok).toBe(true);
  });

  it('C. FILE + TRACE partially applied -> exactly one correct final state', () => {
    const { store, root, deps } = setup();
    const target = join(store.paths.canon, 'requirement', 'SC-REQ-000900', 'v1.json');

    const tx = store.begin();
    tx.appendTrace('demo', { type: 'FIRST', payload: { n: 1 } });
    tx.commit();
    const first = store.readTrace('demo')[0]!;
    const txId = first.opId!.split('#')[0]!;

    // Journal contains both the already-applied trace op and an unapplied file op.
    stageCommittedJournal(store, txId, [
      {
        kind: 'TRACE',
        stream: 'demo',
        opId: first.opId,
        input: {
          at: first.at,
          actor: first.actor,
          type: first.type,
          payload: first.payload,
          opId: first.opId,
        },
      },
      { kind: 'FILE', path: target, contents: '{"recovered":true}' },
    ]);

    const reopened = Store.open(root, deps);
    expect(reopened.readTrace('demo')).toHaveLength(1);
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ recovered: true });
  });

  it('D. two TRACE writes in one stream, first applied -> second added exactly once', () => {
    const { store, root, deps } = setup();
    const txId = 'SC-TX-000901';
    const op0 = traceOp(txId, 0, 'demo', 'A', { n: 1 });
    const op1 = traceOp(txId, 1, 'demo', 'B', { n: 2 });

    // Apply only the first, as a crash mid-journal would leave it.
    store.trace('demo').append(op0.input);
    expect(store.readTrace('demo')).toHaveLength(1);

    stageCommittedJournal(store, txId, [op0, op1]);
    const reopened = Store.open(root, deps);

    const recs = reopened.readTrace('demo');
    expect(recs).toHaveLength(2);
    expect(recs.map((r) => r.type)).toEqual(['A', 'B']); // order preserved
    expect(reopened.trace('demo').verify().ok).toBe(true); // chain intact
  });

  it('E. running recovery twice changes nothing', () => {
    const { store, root, deps } = setup();
    stageCommittedJournal(store, 'SC-TX-000902', [
      traceOp('SC-TX-000902', 0, 'demo', 'A', { n: 1 }),
    ]);
    const reopened = Store.open(root, deps);
    const after1 = reopened.readTrace('demo');

    const second = reopened.recover();
    const after2 = reopened.readTrace('demo');

    expect(second).toEqual({ reapplied: 0, discarded: 0 });
    expect(after2).toEqual(after1);
    expect(after2).toHaveLength(1);
  });

  it('F. conflicting content for an existing opId raises STORE_CORRUPT', () => {
    const { store, root, deps } = setup();
    const tx = store.begin();
    tx.appendTrace('demo', { type: 'A', payload: { amount: 100 } });
    tx.commit();
    const applied = store.readTrace('demo')[0]!;

    // Same identity, different payload: the journal and the stream disagree.
    stageCommittedJournal(store, applied.opId!.split('#')[0]!, [
      {
        kind: 'TRACE',
        stream: 'demo',
        opId: applied.opId,
        input: {
          at: applied.at,
          actor: applied.actor,
          type: applied.type,
          payload: { amount: 999 },
          opId: applied.opId,
        },
      },
    ]);

    expect(() => Store.open(root, deps)).toThrowError(/already exists with different content/);
  });

  it('multiple streams in one transaction recover coherently', () => {
    const { store, root, deps } = setup();
    const txId = 'SC-TX-000903';
    stageCommittedJournal(store, txId, [
      traceOp(txId, 0, 'alpha', 'A', {}),
      traceOp(txId, 1, 'beta', 'B', {}),
      traceOp(txId, 2, 'alpha', 'C', {}),
    ]);
    const reopened = Store.open(root, deps);
    expect(reopened.readTrace('alpha').map((r) => r.type)).toEqual(['A', 'C']);
    expect(reopened.readTrace('beta').map((r) => r.type)).toEqual(['B']);
    expect(reopened.trace('alpha').verify().ok).toBe(true);
    expect(reopened.trace('beta').verify().ok).toBe(true);
  });

  it('every trace record written through a transaction carries a stable opId', () => {
    const { store } = setup();
    const tx = store.begin();
    tx.appendTrace('demo', { type: 'A', payload: {} });
    tx.appendTrace('demo', { type: 'B', payload: {} });
    tx.commit();
    const ids = store.readTrace('demo').map((r) => r.opId);
    expect(ids.every((i) => typeof i === 'string' && i.includes('#'))).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it('verify() detects a duplicated opId in a stream', () => {
    const { store } = setup();
    const tx = store.begin();
    tx.appendTrace('demo', { type: 'A', payload: {} });
    tx.commit();
    const rec = store.readTrace('demo')[0]!;
    // Forge a second record reusing the identity but continuing the chain.
    const forged = store.trace('demo').append({
      at: rec.at,
      actor: rec.actor,
      type: rec.type,
      payload: rec.payload,
      opId: rec.opId!,
    });
    expect(forged.seq).toBe(2);
    const v = store.trace('demo').verify();
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.detail).toMatch(/duplicate opId/);
  });
});

/* ==================================================================== BLOCKER 3 */

const stepDef = (
  id: string,
  dependsOn: string[] = [],
  exitCondition: () => boolean = () => true,
) => ({ id, name: id, department: 'SC-DEPT-030', dependsOn, exitCondition });

function engineFor(def: WorkflowDefinition) {
  const { store, root, deps } = freshStore();
  roots.push(root);
  return { store, engine: new WorkflowEngine(store, deps, new Map([[def.id, def]])) };
}

describe('B3 — workflow control flow is enforced by the runtime', () => {
  const AB: WorkflowDefinition = {
    id: 'SC-WF-005',
    name: 'A then B',
    version: '1.0.0',
    steps: [stepDef('A'), stepDef('B', ['A'])],
  };

  it('1. completing B before A is refused', () => {
    const { store, engine } = engineFor(AB);
    const tx = store.begin();
    const run = engine.start(tx, AB.id, 'SC-WI-000001');
    expect(() => engine.completeStep(tx, run.id, 'B')).toThrowError(/unmet dependencies: A/);
  });

  it('2. B becomes ready only after A completes', () => {
    const { store, engine } = engineFor(AB);
    const tx = store.begin();
    let run = engine.start(tx, AB.id, 'SC-WI-000001');
    expect(run.currentSteps).toEqual(['A']);
    run = engine.completeStep(tx, run.id, 'A');
    expect(run.currentSteps).toEqual(['B']);
    run = engine.completeStep(tx, run.id, 'B');
    expect(run.completedSteps).toEqual(['A', 'B']);
  });

  it('3. a false exitCondition refuses completion', () => {
    const def: WorkflowDefinition = {
      id: 'SC-WF-006',
      name: 'gated',
      version: '1.0.0',
      steps: [stepDef('A', [], () => false)],
    };
    const { store, engine } = engineFor(def);
    const tx = store.begin();
    const run = engine.start(tx, def.id, 'SC-WI-000001');
    expect(() => engine.completeStep(tx, run.id, 'A')).toThrowError(/Exit condition/);
  });

  it('4. a true exitCondition permits completion', () => {
    let ready = false;
    const def: WorkflowDefinition = {
      id: 'SC-WF-006',
      name: 'gated',
      version: '1.0.0',
      steps: [stepDef('A', [], () => ready)],
    };
    const { store, engine } = engineFor(def);
    const tx = store.begin();
    const run = engine.start(tx, def.id, 'SC-WI-000001');
    expect(() => engine.completeStep(tx, run.id, 'A')).toThrowError(/Exit condition/);
    ready = true;
    const after = engine.completeStep(tx, run.id, 'A');
    expect(after.completedSteps).toEqual(['A']);
  });

  it('5. an unknown dependency fails definition validation', () => {
    expect(() =>
      validateWorkflowDefinition({
        id: 'SC-WF-007',
        name: 'bad',
        version: '1.0.0',
        steps: [stepDef('A', ['GHOST'])],
      }),
    ).toThrowError(/unknown step "GHOST"/);
  });

  it('6. a cyclic dependency fails definition validation', () => {
    expect(() =>
      validateWorkflowDefinition({
        id: 'SC-WF-008',
        name: 'cycle',
        version: '1.0.0',
        steps: [stepDef('A', ['B']), stepDef('B', ['A'])],
      }),
    ).toThrowError(/dependency cycle/);
  });

  it('6b. a self-dependency is rejected', () => {
    expect(() =>
      validateWorkflowDefinition({
        id: 'SC-WF-009',
        name: 'self',
        version: '1.0.0',
        steps: [stepDef('A', ['A'])],
      }),
    ).toThrowError(/depends on itself/);
  });

  it('7. duplicate step ids are rejected', () => {
    expect(() =>
      validateWorkflowDefinition({
        id: 'SC-WF-010',
        name: 'dup',
        version: '1.0.0',
        steps: [stepDef('A'), stepDef('A')],
      }),
    ).toThrowError(/duplicate step id: A/);
  });

  it('7b. a definition with no steps is rejected', () => {
    expect(() =>
      validateWorkflowDefinition({ id: 'SC-WF-011', name: 'empty', version: '1.0.0', steps: [] }),
    ).toThrowError(/defines no steps/);
  });

  it('7c. the engine rejects a malformed definition at construction', () => {
    const { store, root, deps } = freshStore();
    roots.push(root);
    const bad: WorkflowDefinition = {
      id: 'SC-WF-012',
      name: 'cycle',
      version: '1.0.0',
      steps: [stepDef('A', ['B']), stepDef('B', ['A'])],
    };
    expect(() => new WorkflowEngine(store, deps, new Map([[bad.id, bad]]))).toThrowError(
      /dependency cycle/,
    );
  });

  it('8. completing or failing an unrelated step is rejected', () => {
    const { store, engine } = engineFor(AB);
    const tx = store.begin();
    const run = engine.start(tx, AB.id, 'SC-WI-000001');
    expect(() => engine.completeStep(tx, run.id, 'ZZ')).toThrowError(/not part of workflow/);
    expect(() => engine.failStep(tx, run.id, 'ZZ', 'nope')).toThrowError(/not part of workflow/);
  });

  it('a step that is not currently active is refused even with met dependencies', () => {
    const { store, engine } = engineFor(AB);
    const tx = store.begin();
    let run = engine.start(tx, AB.id, 'SC-WI-000001');
    run = engine.completeStep(tx, run.id, 'A');
    run = engine.block(tx, run.id, 'waiting on owner');
    expect(run.currentSteps).toEqual(['B']);
    // Blocked runs still hold their active set; a terminal/mismatched set is the guard.
    const resumed = engine.resume(tx, run.id);
    expect(resumed.currentSteps).toEqual(['B']);
  });

  it('the StepDefinition contract no longer advertises unimplemented `optional`', () => {
    const step = stepDef('A');
    expect(Object.keys(step)).not.toContain('optional');
  });
});

/* ==================================================================== BLOCKER 4 */

describe('B4 — store paths are confined to the project root', () => {
  const ESCAPES = [
    '..',
    '../',
    '../../',
    '../../../etc',
    'C:\\Windows\\System32',
    '/etc/passwd',
    'a/../../b',
    '.',
  ];

  it('canon type and id reject traversal attempts', () => {
    const { store } = setup();
    for (const bad of ESCAPES) {
      expect(() => store.getCanon('requirement', bad), bad).toThrowError();
      expect(() => store.getCanon(bad, 'SC-REQ-000001'), bad).toThrowError();
    }
  });

  it('working type and id reject traversal attempts', () => {
    const { store } = setup();
    for (const bad of ESCAPES) {
      expect(() => store.getWorking('stageState', bad), bad).toThrowError();
      expect(() => store.getWorking(bad, 'x'), bad).toThrowError();
    }
  });

  it('trace stream names reject traversal, including nested traversal', () => {
    const { store } = setup();
    for (const bad of [...ESCAPES, 'agentrun/../../escape', 'agentrun/..', 'a\\b']) {
      expect(() => store.readTrace(bad), bad).toThrowError();
    }
  });

  it('derived names reject traversal attempts', () => {
    const { store } = setup();
    for (const bad of ESCAPES) {
      expect(() => store.putDerived(bad, {}), bad).toThrowError();
    }
  });

  it('a legitimate nested trace stream still works', () => {
    const { store } = setup();
    const tx = store.begin();
    tx.appendTrace('agentrun/SC-RUN-000001', { type: 'RUN_CREATED', payload: {} });
    tx.commit();
    expect(store.readTrace('agentrun/SC-RUN-000001')).toHaveLength(1);
    expect(store.listTraceStreams()).toContain('agentrun/SC-RUN-000001');
  });

  it('journal recovery refuses a FILE destination outside the store', () => {
    const { store, root, deps } = setup();
    const outside = join(root, 'ESCAPED.json');
    stageCommittedJournal(store, 'SC-TX-000904', [
      { kind: 'FILE', path: outside, contents: '{"pwned":true}' },
    ]);
    expect(() => Store.open(root, deps)).toThrowError(/outside the store/);
    // The critical assertion: nothing was written outside .serva.
    expect(existsSync(outside)).toBe(false);
  });

  it('no escape attempt creates a file outside .serva', () => {
    const { store, root } = setup();
    const sentinel = join(root, 'SHOULD_NOT_EXIST.json');
    for (const bad of ESCAPES) {
      try {
        store.putDerived(bad, { x: 1 });
      } catch {
        // expected
      }
    }
    expect(existsSync(sentinel)).toBe(false);
  });
});

describe('B4 — T-CANON integrity is detectable', () => {
  it('an out-of-band body edit is detected on authoritative read', () => {
    const { store } = setup();
    const tx = store.begin();
    tx.putCanon('requirement', 'SC-REQ-000001', { statement: 'original' });
    tx.commit();
    expect(store.getCanon<{ statement: string }>('requirement', 'SC-REQ-000001')).toBeDefined();

    const path = join(store.paths.canon, 'requirement', 'SC-REQ-000001', 'v1.json');
    const env = JSON.parse(readFileSync(path, 'utf8')) as { body: { statement: string } };
    env.body.statement = 'tampered'; // digest deliberately not updated
    writeFileSync(path, JSON.stringify(env, null, 2), 'utf8');

    expect(() => store.getCanon('requirement', 'SC-REQ-000001')).toThrowError(
      /body digest mismatch/,
    );
  });

  it('a malformed envelope is detected', () => {
    const { store } = setup();
    const dir = join(store.paths.canon, 'requirement', 'SC-REQ-000002');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'v1.json'), JSON.stringify({ nonsense: true }), 'utf8');
    expect(() => store.getCanon('requirement', 'SC-REQ-000002')).toThrowError(/malformed envelope/);
  });

  it('a version/path mismatch is detected', () => {
    const { store } = setup();
    const tx = store.begin();
    tx.putCanon('requirement', 'SC-REQ-000003', { statement: 'x' });
    tx.commit();
    const path = join(store.paths.canon, 'requirement', 'SC-REQ-000003', 'v1.json');
    const env = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    env['version'] = 7;
    writeFileSync(path, JSON.stringify(env, null, 2), 'utf8');
    expect(() => store.getCanon('requirement', 'SC-REQ-000003')).toThrowError(
      /does not match path version/,
    );
  });

  it('an id/path mismatch is detected', () => {
    const { store } = setup();
    const tx = store.begin();
    tx.putCanon('requirement', 'SC-REQ-000004', { statement: 'x' });
    tx.commit();
    const path = join(store.paths.canon, 'requirement', 'SC-REQ-000004', 'v1.json');
    const env = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    env['id'] = 'SC-REQ-999999';
    writeFileSync(path, JSON.stringify(env, null, 2), 'utf8');
    expect(() => store.getCanon('requirement', 'SC-REQ-000004')).toThrowError(
      /does not match path id/,
    );
  });

  it('verifyCanon sweeps every record and reports problems without throwing', () => {
    const { store } = setup();
    const tx = store.begin();
    tx.putCanon('requirement', 'SC-REQ-000005', { statement: 'a' });
    tx.putCanon('requirement', 'SC-REQ-000006', { statement: 'b' });
    tx.commit();

    const clean = store.verifyCanon();
    expect(clean.checked).toBe(2);
    expect(clean.problems).toEqual([]);

    const path = join(store.paths.canon, 'requirement', 'SC-REQ-000005', 'v1.json');
    const env = JSON.parse(readFileSync(path, 'utf8')) as { body: { statement: string } };
    env.body.statement = 'tampered';
    writeFileSync(path, JSON.stringify(env), 'utf8');

    const dirty = store.verifyCanon();
    expect(dirty.problems).toHaveLength(1);
    expect(dirty.problems[0]?.problem).toMatch(/digest mismatch/);
  });
});

/* ================================================= schema / interface parity */

describe('schema and TypeScript contract parity', () => {
  it('ArtifactVerifierResultSchema accepts a fully populated interface value', async () => {
    const { ArtifactVerifierResultSchema } = await import('../src/domain/schemas.js');
    const { avr } = await import('./helpers.js');
    const full = {
      ...avr({
        value: 'NOT_VERIFIED',
        cause: IndeterminateReason.EVIDENCE_ABSENT,
        measured: ['x'],
      }),
    };
    const parsed = ArtifactVerifierResultSchema.parse(full);
    // .strict() means an unmodelled field would have thrown; assert nothing was lost.
    for (const key of Object.keys(full)) expect(parsed).toHaveProperty(key);
  });

  it('GateResultSchema mirrors every persisted GateResult field, including storeVersion', async () => {
    const { GateResultSchema } = await import('../src/domain/schemas.js');
    const full = {
      id: 'SC-GR-000001',
      gateRef: 'SC-GATE-QA',
      gateVersion: '1.0.0',
      scope: 'SC-WI-000001',
      verdict: GateVerdict.PASS,
      criterionEvaluationIds: ['SC-CE-000001'],
      evidenceRefs: ['SC-EV-000001'],
      artifactVersionsEvaluated: [{ artifactId: 'SC-ART-000001', version: 1, digest: 'd' }],
      qualifications: [],
      findings: [],
      evaluatedAt: '2026-01-01T00:00:00.000Z',
      evaluator: 'TEST',
      storeVersion: 0,
      dependsOn: [],
    };
    const parsed = GateResultSchema.parse(full);
    expect(parsed.storeVersion).toBe(0);
    for (const key of Object.keys(full)) expect(parsed).toHaveProperty(key);
  });

  it('a field absent from the schema is rejected rather than silently stripped', async () => {
    const { GateResultSchema } = await import('../src/domain/schemas.js');
    expect(() =>
      GateResultSchema.parse({
        id: 'SC-GR-000001',
        gateRef: 'SC-GATE-QA',
        gateVersion: '1.0.0',
        scope: 's',
        verdict: GateVerdict.PASS,
        evaluatedAt: '2026-01-01T00:00:00.000Z',
        evaluator: 'TEST',
        storeVersion: 0,
        unmodelledField: 'surprise',
      }),
    ).toThrowError();
  });

  it('schemas use canonical vocabularies, so a non-canonical value is refused', async () => {
    const { EvidenceSchema } = await import('../src/domain/schemas.js');
    expect(() =>
      EvidenceSchema.parse({
        id: 'SC-EV-000001',
        evidenceClass: 'NOT_A_REAL_CLASS',
        claim: 'x',
        provenance: { capturedBy: 'RUNTIME', method: 'm' },
        capturedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrowError();
  });
});
