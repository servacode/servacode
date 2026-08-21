import { afterEach, describe, expect, it } from 'vitest';
import {
  WorkflowEngine,
  assertTransition,
  type WorkflowDefinition,
} from '../src/workflow/engine.js';
import {
  applyGateOutcome,
  appendLedgerEntry,
  getStageState,
  readLedger,
  startStage,
  transitionStage,
  assertKnownStage,
} from '../src/lifecycle/stages.js';
import { mapGateOutcome, GATE_OUTCOME_MAPPING } from '../src/lifecycle/mapping.js';
import {
  GateVerdict,
  StageExecutionState,
  StageLedgerDisposition,
  WorkItemState,
  WorkflowRunState,
} from '../src/vocab/index.js';
import { Store } from '../src/store/store.js';
import { cleanup, freshStore } from './helpers.js';

/**
 * TEST CATEGORY H — workflow state machine.
 * TEST CATEGORY I — stage mapping (31 §6.2).
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const DEF: WorkflowDefinition = {
  id: 'SC-WF-005',
  name: 'Feature Implementation',
  version: '1.0.0',
  steps: [
    {
      id: 'prepare',
      name: 'Task preparation',
      department: 'SC-DEPT-001',
      dependsOn: [],
      exitCondition: () => true,
    },
    {
      id: 'implement',
      name: 'Implementation',
      department: 'SC-DEPT-030',
      dependsOn: ['prepare'],
      exitCondition: () => true,
    },
    {
      id: 'review',
      name: 'Code Review',
      department: 'SC-DEPT-050',
      dependsOn: ['implement'],
      exitCondition: () => true,
    },
    {
      id: 'qa',
      name: 'QA',
      department: 'SC-DEPT-051',
      dependsOn: ['review'],
      exitCondition: () => true,
    },
  ],
};

function setup(): {
  store: Store;
  engine: WorkflowEngine;
  deps: ReturnType<typeof freshStore>['deps'];
} {
  const { store, root, deps } = freshStore();
  roots.push(root);
  const engine = new WorkflowEngine(store, deps, new Map([[DEF.id, DEF]]));
  return { store, engine, deps };
}

describe('H — workflow state machine', () => {
  it('normal progression completes when every step is done', () => {
    const { store, engine } = setup();
    let tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    tx.commit();
    expect(run.state).toBe(WorkflowRunState.RUNNING);
    expect(run.currentSteps).toEqual(['prepare']);

    for (const step of ['prepare', 'implement', 'review', 'qa']) {
      tx = store.begin();
      run = engine.completeStep(tx, run.id, step);
      tx.commit();
    }
    expect(run.state).toBe(WorkflowRunState.COMPLETED);
    expect(run.completedSteps).toHaveLength(4);
    expect(run.currentSteps).toEqual([]);
    expect(run.endedAt).toBeDefined();
  });

  it('only dependency-satisfied steps become ready', () => {
    const { store, engine } = setup();
    let tx = store.begin();
    const run = engine.start(tx, DEF.id, 'SC-WI-000001');
    tx.commit();
    expect(run.currentSteps).toEqual(['prepare']);

    tx = store.begin();
    const after = engine.completeStep(tx, run.id, 'prepare');
    tx.commit();
    expect(after.currentSteps).toEqual(['implement']);
  });

  it('blocked -> waiting, then resume recomputes ready steps', () => {
    const { store, engine } = setup();
    let tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    run = engine.completeStep(tx, run.id, 'prepare');
    tx.commit();

    tx = store.begin();
    run = engine.block(tx, run.id, 'awaiting owner approval');
    tx.commit();
    expect(run.state).toBe(WorkflowRunState.WAITING);

    tx = store.begin();
    run = engine.resume(tx, run.id);
    tx.commit();
    expect(run.state).toBe(WorkflowRunState.RUNNING);
    expect(run.currentSteps).toEqual(['implement']);
  });

  it('step failure moves the run to REWORK and focuses the failing step', () => {
    const { store, engine } = setup();
    let tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    run = engine.completeStep(tx, run.id, 'prepare');
    run = engine.completeStep(tx, run.id, 'implement');
    tx.commit();

    tx = store.begin();
    run = engine.failStep(tx, run.id, 'review', 'BLOCKING finding');
    tx.commit();
    expect(run.state).toBe(WorkflowRunState.REWORK);
    expect(run.failedSteps).toEqual(['review']);
    expect(run.currentSteps).toEqual(['review']);

    tx = store.begin();
    run = engine.resume(tx, run.id);
    run = engine.completeStep(tx, run.id, 'review');
    tx.commit();
    expect(run.failedSteps).toEqual([]);
    expect(run.state).toBe(WorkflowRunState.RUNNING);
  });

  it('completing a step twice is idempotent (07 ID-1)', () => {
    const { store, engine } = setup();
    const tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    run = engine.completeStep(tx, run.id, 'prepare');
    const first = run.completedSteps.length;
    run = engine.completeStep(tx, run.id, 'prepare');
    tx.commit();
    expect(run.completedSteps.length).toBe(first);
  });

  it('a terminal run refuses further step completions', () => {
    const { store, engine } = setup();
    const tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    for (const s of ['prepare', 'implement', 'review', 'qa'])
      run = engine.completeStep(tx, run.id, s);
    tx.commit();

    const tx2 = store.begin();
    expect(() => engine.completeStep(tx2, run.id, 'prepare')).not.toThrow(); // idempotent no-op
    expect(() => engine.failStep(tx2, run.id, 'qa', 'late')).toThrowError(/cannot move/);
  });

  it('rejects invalid transitions explicitly (31 V5b)', () => {
    expect(() =>
      assertTransition(WorkflowRunState.COMPLETED, WorkflowRunState.RUNNING),
    ).toThrowError(/cannot move COMPLETED -> RUNNING/);
    expect(() =>
      assertTransition(WorkflowRunState.PENDING, WorkflowRunState.COMPLETED),
    ).toThrowError(/cannot move/);
    expect(() =>
      assertTransition(WorkflowRunState.RUNNING, WorkflowRunState.RUNNING),
    ).not.toThrow();
  });

  it('an unknown step or workflow is refused, not silently ignored', () => {
    const { store, engine } = setup();
    const tx = store.begin();
    const run = engine.start(tx, DEF.id, 'SC-WI-000001');
    tx.commit();
    expect(() => engine.completeStep(store.begin(), run.id, 'nope')).toThrowError(
      /not part of workflow/,
    );
    expect(() => engine.definition('SC-WF-999')).toThrowError(/Unknown workflow definition/);
  });

  it('resumes after interruption using only persisted state', () => {
    const { store, engine, deps } = setup();
    const tx = store.begin();
    let run = engine.start(tx, DEF.id, 'SC-WI-000001');
    run = engine.completeStep(tx, run.id, 'prepare');
    tx.commit();

    // New engine instance over the same store, as after a restart.
    const engine2 = new WorkflowEngine(store, deps, new Map([[DEF.id, DEF]]));
    expect(engine2.recompute(run.id)).toEqual(['implement']);
    expect(engine2.get(run.id)?.completedSteps).toEqual(['prepare']);
  });
});

describe('I — gate outcome to process state mapping (31 §6.2)', () => {
  const STAGE = 'SC-STAGE-041'; // CODE_REVIEW

  it('FAIL: ledger records FAILED, live stage goes to REWORK then IN_PROGRESS for a new attempt', () => {
    const { store, deps } = setup();
    let tx = store.begin();
    startStage(tx, store, deps, 'SC-WI-000001', STAGE);
    tx.commit();
    expect(getStageState(store, 'SC-WI-000001', STAGE)?.attempt).toBe(1);

    tx = store.begin();
    const out = applyGateOutcome(tx, store, deps, {
      workItemId: 'SC-WI-000001',
      stageId: STAGE,
      verdict: GateVerdict.FAIL,
      profileRef: 'PRF-FEATURE',
      gateResultRef: 'SC-GR-000001',
    });
    tx.commit();

    // The ledger records the outcome of the attempt that failed.
    expect(out.ledger.disposition).toBe(StageLedgerDisposition.FAILED);
    expect(out.ledger.attempt).toBe(1);
    // The live machine has moved on to a NEW attempt.
    expect(getStageState(store, 'SC-WI-000001', STAGE)?.state).toBe(
      StageExecutionState.IN_PROGRESS,
    );
    expect(getStageState(store, 'SC-WI-000001', STAGE)?.attempt).toBe(2);
    expect(out.dispatches).toBe('REWORK_ARTIFACT');
  });

  it('PS-1: REWORK never appears as a ledger disposition', () => {
    const { store, deps } = setup();
    const tx = store.begin();
    startStage(tx, store, deps, 'SC-WI-000001', STAGE);
    for (const verdict of Object.values(GateVerdict)) {
      applyGateOutcome(tx, store, deps, {
        workItemId: 'SC-WI-000001',
        stageId: STAGE,
        verdict,
        profileRef: 'PRF-FEATURE',
      });
    }
    tx.commit();

    const ledger = readLedger(store, 'SC-WI-000001');
    expect(ledger.length).toBeGreaterThan(0);
    for (const e of ledger) {
      expect(Object.values(StageLedgerDisposition)).toContain(e.disposition);
      expect(String(e.disposition)).not.toBe('REWORK');
    }
  });

  it('NOT_VERIFIED maps to the same states as FAIL but dispatches different work (18 §5)', () => {
    const fail = mapGateOutcome(GateVerdict.FAIL);
    const nv = mapGateOutcome(GateVerdict.NOT_VERIFIED);
    expect(nv.ledgerDisposition).toBe(fail.ledgerDisposition);
    expect(nv.stageState).toBe(fail.stageState);
    expect(nv.workItemState).toBe(fail.workItemState);
    expect(nv.workflowState).toBe(fail.workflowState);
    expect(nv.dispatches).not.toBe(fail.dispatches);
    expect(nv.dispatches).toBe('PRODUCE_EVIDENCE');
  });

  it('PASS and PASS_WITH_QUALIFICATION both advance and record EXECUTED', () => {
    for (const v of [GateVerdict.PASS, GateVerdict.PASS_WITH_QUALIFICATION]) {
      const m = mapGateOutcome(v);
      expect(m.ledgerDisposition).toBe(StageLedgerDisposition.EXECUTED);
      expect(m.stageState).toBe(StageExecutionState.COMPLETE);
      expect(m.workItemState).toBe(WorkItemState.ADVANCING);
    }
  });

  it('ESCALATED routes to owner authority; BLOCKED waits on a dependency', () => {
    expect(mapGateOutcome(GateVerdict.ESCALATED).workItemState).toBe(WorkItemState.AWAITING_OWNER);
    expect(mapGateOutcome(GateVerdict.BLOCKED).workItemState).toBe(WorkItemState.BLOCKED);
    expect(mapGateOutcome(GateVerdict.BLOCKED).workflowState).toBe(WorkflowRunState.WAITING);
  });

  it('the mapping is total over every GateVerdict', () => {
    for (const v of Object.values(GateVerdict)) {
      expect(GATE_OUTCOME_MAPPING[v]).toBeDefined();
    }
  });

  it('ledger entries are appended per attempt, never edited', () => {
    const { store, deps } = setup();
    const tx = store.begin();
    startStage(tx, store, deps, 'SC-WI-000002', STAGE);
    applyGateOutcome(tx, store, deps, {
      workItemId: 'SC-WI-000002',
      stageId: STAGE,
      verdict: GateVerdict.FAIL,
      profileRef: 'PRF-FEATURE',
    });
    applyGateOutcome(tx, store, deps, {
      workItemId: 'SC-WI-000002',
      stageId: STAGE,
      verdict: GateVerdict.PASS,
      profileRef: 'PRF-FEATURE',
    });
    tx.commit();

    const ledger = readLedger(store, 'SC-WI-000002');
    expect(ledger).toHaveLength(2);
    expect(ledger[0]?.disposition).toBe(StageLedgerDisposition.FAILED);
    expect(ledger[0]?.attempt).toBe(1);
    expect(ledger[1]?.disposition).toBe(StageLedgerDisposition.EXECUTED);
    expect(ledger[1]?.attempt).toBe(2);
    expect(store.trace('stage-ledger').verify().ok).toBe(true);
  });

  it('rejects an unknown stage identifier', () => {
    expect(() => assertKnownStage('SC-STAGE-999')).toThrowError(/Unknown lifecycle stage/);
    // Retired stages must not be usable (30 §10.5).
    expect(() => assertKnownStage('SC-STAGE-001')).toThrowError(/Unknown lifecycle stage/);
    expect(() => assertKnownStage('SC-STAGE-051')).toThrowError(/Unknown lifecycle stage/);
  });

  it('rejects an illegal live stage transition', () => {
    const { store, deps } = setup();
    const tx = store.begin();
    startStage(tx, store, deps, 'SC-WI-000003', STAGE);
    transitionStage(tx, store, deps, 'SC-WI-000003', STAGE, StageExecutionState.COMPLETE);
    tx.commit();
    expect(() =>
      transitionStage(
        store.begin(),
        store,
        deps,
        'SC-WI-000003',
        STAGE,
        StageExecutionState.IN_PROGRESS,
      ),
    ).toThrowError(/cannot move COMPLETE/);
  });

  it('refuses a ledger entry with a non-canonical disposition', () => {
    const { store, deps } = setup();
    const tx = store.begin();
    expect(() =>
      appendLedgerEntry(tx, deps, {
        stageId: STAGE,
        workItemId: 'SC-WI-000004',
        attempt: 1,
        disposition: 'REWORK' as never,
        profileRef: 'PRF-FEATURE',
      }),
    ).toThrowError(/Invalid stage ledger disposition/);
  });
});
