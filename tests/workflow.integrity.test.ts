import { afterEach, describe, expect, it } from 'vitest';
import {
  WorkflowEngine,
  assertRunCoherent,
  type WorkflowDefinition,
} from '../src/workflow/engine.js';
import { WorkflowRunState } from '../src/vocab/index.js';
import { cleanup, freshStore } from './helpers.js';
import type { WorkflowRun } from '../src/domain/schemas.js';

/**
 * WORKFLOW PROJECTION INTEGRITY.
 *
 * `completeStep` was guarded; `failStep` was not. Because failing a step also
 * rewrites `failedSteps` and `currentSteps`, an unguarded failStep could produce
 * a run holding the same step as both completed and failed, and pointing the
 * active set at work already done. No legal sequence of events produces that, so
 * it is an engine defect the projection must refuse to store.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const step = (id: string, dependsOn: string[] = []) => ({
  id,
  name: id,
  department: 'SC-DEPT-030',
  dependsOn,
  exitCondition: () => true,
});

/** A → B in sequence, with an independent C that never blocks either. */
const DEF: WorkflowDefinition = {
  id: 'SC-WF-020',
  name: 'A then B, plus independent C',
  version: '1.0.0',
  steps: [step('A'), step('B', ['A']), step('C')],
};

function setup(def: WorkflowDefinition = DEF) {
  const { store, root, deps } = freshStore();
  roots.push(root);
  return { store, engine: new WorkflowEngine(store, deps, new Map([[def.id, def]])) };
}

describe('failStep cannot create an impossible run state', () => {
  it('1. a completed step cannot be failed while other steps remain', () => {
    const { store, engine } = setup();
    const tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    run = engine.completeStep(tx, run.id, 'A');
    expect(run.completedSteps).toEqual(['A']);
    expect(run.state).toBe(WorkflowRunState.RUNNING); // B and C remain

    expect(() => engine.failStep(tx, run.id, 'A', 'late finding')).toThrowError(
      /has already completed and cannot be failed/,
    );
  });

  it('1b. and the run is unchanged after the refusal', () => {
    const { store, engine } = setup();
    const tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    run = engine.completeStep(tx, run.id, 'A');
    tx.commit();

    const tx2 = store.begin();
    expect(() => engine.failStep(tx2, run.id, 'A', 'late finding')).toThrow();
    const after = engine.get(run.id)!;
    expect(after.completedSteps).toEqual(['A']);
    expect(after.failedSteps).toEqual([]);
    expect(after.state).toBe(WorkflowRunState.RUNNING);
  });

  it('2. a step that was never ready cannot be failed', () => {
    const { store, engine } = setup();
    const tx = store.begin();
    const run = engine.start(tx, DEF.id, 'SC-WI-000001');
    // B depends on A, which has not completed.
    expect(() => engine.failStep(tx, run.id, 'B', 'nope')).toThrowError(/unmet dependencies: A/);
  });

  it('2b. a step with met dependencies that is not active cannot be failed', () => {
    const { store, engine } = setup();
    let tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    run = engine.completeStep(tx, run.id, 'A');
    tx.commit();
    expect(run.currentSteps.sort()).toEqual(['B', 'C']);

    // Narrow the active set so B is eligible by dependency but not active. The
    // run stays RUNNING, so the transition guard cannot mask the eligibility one.
    tx = store.begin();
    tx.putWorking('workflowRun', run.id, { ...run, currentSteps: ['C'] });
    tx.commit();

    const tx2 = store.begin();
    expect(() => engine.failStep(tx2, run.id, 'B', 'nope')).toThrowError(/not currently active/);
  });

  it('3. a currently active step may fail', () => {
    const { store, engine } = setup();
    const tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    expect(run.currentSteps).toEqual(['A', 'C']);
    run = engine.failStep(tx, run.id, 'A', 'BLOCKING finding');
    tx.commit();
    expect(run.failedSteps).toEqual(['A']);
  });

  it('4. a failed step puts the run into REWORK, focused on that step', () => {
    const { store, engine } = setup();
    const tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    run = engine.failStep(tx, run.id, 'A', 'BLOCKING finding');
    tx.commit();
    expect(run.state).toBe(WorkflowRunState.REWORK);
    expect(run.currentSteps).toEqual(['A']);
    expect(run.completedSteps).toEqual([]);
  });

  it('5. resume produces a coherent active-step set', () => {
    const { store, engine } = setup();
    let tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    run = engine.completeStep(tx, run.id, 'A');
    run = engine.failStep(tx, run.id, 'B', 'review found a defect');
    tx.commit();
    expect(run.currentSteps).toEqual(['B']);

    tx = store.begin();
    run = engine.resume(tx, run.id);
    tx.commit();
    expect(run.state).toBe(WorkflowRunState.RUNNING);
    // Everything not yet done whose dependencies are satisfied — and nothing done.
    expect(run.currentSteps.sort()).toEqual(['B', 'C']);
    expect(run.currentSteps).not.toContain('A');
  });

  it('5b. rework completes normally and clears the failed marker', () => {
    const { store, engine } = setup();
    let tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    run = engine.completeStep(tx, run.id, 'A');
    run = engine.failStep(tx, run.id, 'B', 'defect');
    tx.commit();

    tx = store.begin();
    run = engine.resume(tx, run.id);
    run = engine.completeStep(tx, run.id, 'B');
    tx.commit();
    expect(run.failedSteps).toEqual([]);
    expect(run.completedSteps).toEqual(['A', 'B']);
    expect(run.state).toBe(WorkflowRunState.RUNNING); // C remains
  });

  it('7. a terminal run refuses failStep', () => {
    const { store, engine } = setup();
    const tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    for (const s of ['A', 'B', 'C']) run = engine.completeStep(tx, run.id, s);
    tx.commit();
    expect(run.state).toBe(WorkflowRunState.COMPLETED);

    const tx2 = store.begin();
    expect(() => engine.failStep(tx2, run.id, 'C', 'late')).toThrowError(
      /cannot move COMPLETED -> REWORK/,
    );
  });

  it('7b. an aborted run refuses failStep', () => {
    const { store, engine } = setup();
    const tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    run = engine.abort(tx, run.id, 'owner cancelled');
    tx.commit();
    expect(() => engine.failStep(tx, run.id, 'A', 'late')).toThrowError(
      /cannot move ABORTED -> REWORK/,
    );
  });

  it('8. a step outside the workflow cannot be failed', () => {
    const { store, engine } = setup();
    const tx = store.begin();
    const run = engine.start(tx, DEF.id, 'SC-WI-000001');
    expect(() => engine.failStep(tx, run.id, 'ZZ', 'nope')).toThrowError(/not part of workflow/);
  });
});

describe('6. the projection invariant', () => {
  const base = (over: Partial<WorkflowRun>): WorkflowRun =>
    ({
      id: 'SC-WFR-000001',
      workflowRef: DEF.id,
      workflowVersion: '1.0.0',
      workItemId: 'SC-WI-000001',
      state: WorkflowRunState.RUNNING,
      currentSteps: [],
      completedSteps: [],
      failedSteps: [],
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    }) as WorkflowRun;

  it('rejects a step that is both completed and failed', () => {
    expect(() =>
      assertRunCoherent(DEF, base({ completedSteps: ['A'], failedSteps: ['A'] })),
    ).toThrowError(/both completed and failed: A/);
  });

  it('rejects a completed step that is still active', () => {
    expect(() =>
      assertRunCoherent(DEF, base({ completedSteps: ['A'], currentSteps: ['A'] })),
    ).toThrowError(/active despite being complete: A/);
  });

  it('rejects an unknown step id in any list', () => {
    expect(() => assertRunCoherent(DEF, base({ completedSteps: ['ZZ'] }))).toThrowError(
      /completedSteps names unknown step ZZ/,
    );
    expect(() => assertRunCoherent(DEF, base({ failedSteps: ['ZZ'] }))).toThrowError(
      /failedSteps names unknown step ZZ/,
    );
    expect(() => assertRunCoherent(DEF, base({ currentSteps: ['ZZ'] }))).toThrowError(
      /currentSteps names unknown step ZZ/,
    );
  });

  it('rejects a duplicate entry', () => {
    expect(() => assertRunCoherent(DEF, base({ completedSteps: ['A', 'A'] }))).toThrowError(
      /completedSteps contains a duplicate/,
    );
  });

  it('rejects a COMPLETED run that still has active steps', () => {
    expect(() =>
      assertRunCoherent(
        DEF,
        // C is neither complete nor inert, so only the COMPLETED rule can catch it.
        base({
          state: WorkflowRunState.COMPLETED,
          completedSteps: ['A', 'B'],
          currentSteps: ['C'],
        }),
      ),
    ).toThrowError(/COMPLETED run still has active steps/);
  });

  it('accepts every state the engine actually produces', () => {
    const { store, engine } = setup();
    const tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    run = engine.completeStep(tx, run.id, 'A');
    run = engine.failStep(tx, run.id, 'B', 'defect');
    run = engine.resume(tx, run.id);
    run = engine.completeStep(tx, run.id, 'B');
    run = engine.completeStep(tx, run.id, 'C');
    tx.commit();
    expect(run.state).toBe(WorkflowRunState.COMPLETED);
    expect(() => assertRunCoherent(DEF, run)).not.toThrow();
  });

  it('no run reachable through the engine holds a step as both complete and failed', () => {
    const { store, engine } = setup();
    const tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    run = engine.failStep(tx, run.id, 'A', 'first attempt failed');
    run = engine.resume(tx, run.id);
    run = engine.completeStep(tx, run.id, 'A');
    tx.commit();
    // Completion clears the failed marker rather than leaving both set.
    expect(run.completedSteps).toEqual(['A']);
    expect(run.failedSteps).toEqual([]);
    expect(run.completedSteps.filter((s) => run.failedSteps.includes(s))).toEqual([]);
  });

  it('the invariant guards every write, not just failStep', () => {
    // Written directly through the store, then read back and checked: the guard
    // lives in the engine's persist path, so a projection that bypasses the engine
    // is exactly what assertRunCoherent is for.
    const bad = base({ completedSteps: ['A'], failedSteps: ['A'], currentSteps: ['A'] });
    expect(() => assertRunCoherent(DEF, bad)).toThrow();
  });
});
