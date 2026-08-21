import { WorkflowRunState } from '../vocab/index.js';
import { fail } from '../core/errors.js';
import { AuditAction, audit } from '../events/audit.js';
import type { Store, Transaction } from '../store/store.js';
import type { WorkflowRun } from '../domain/schemas.js';
import type { IdSource } from '../core/ids.js';
import type { Clock } from '../core/clock.js';

/**
 * Deterministic workflow engine foundation.
 *
 * SPEC: 07 §2 (definition schema), 07 §6 (run + checkpointing), 31 V5b.
 *
 * Phase 2 scope: the state machine, step dependencies, blocking, rework, resume
 * and idempotency. AI orchestration is NOT implemented here and this module has
 * no provider dependency (27 NFR-17).
 */

export const WORKFLOW_STREAM = 'workflow';

export interface StepDefinition {
  readonly id: string;
  readonly name: string;
  readonly department: string;
  readonly dependsOn: readonly string[];
  /** 07 §2.1 — evaluated against stored state, never satisfied by self-report. */
  readonly exitCondition: (store: Store, run: WorkflowRun) => boolean;
  readonly optional?: boolean;
}

export interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly steps: readonly StepDefinition[];
}

export interface WorkflowDeps {
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly actor: string;
}

export const WorkflowEventType = {
  RUN_STARTED: 'WF_RUN_STARTED',
  STEP_STARTED: 'WF_STEP_STARTED',
  STEP_COMPLETED: 'WF_STEP_COMPLETED',
  STEP_FAILED: 'WF_STEP_FAILED',
  RUN_BLOCKED: 'WF_RUN_BLOCKED',
  RUN_REWORK: 'WF_RUN_REWORK',
  RUN_RESUMED: 'WF_RUN_RESUMED',
  RUN_COMPLETED: 'WF_RUN_COMPLETED',
  RUN_FAILED: 'WF_RUN_FAILED',
  RUN_ABORTED: 'WF_RUN_ABORTED',
  CHECKPOINT: 'WF_CHECKPOINT',
} as const;
export type WorkflowEventType = (typeof WorkflowEventType)[keyof typeof WorkflowEventType];

/** 31 V5b — legal transitions. An undeclared move is refused, not silently applied. */
const TRANSITIONS: Readonly<Record<WorkflowRunState, readonly WorkflowRunState[]>> = Object.freeze({
  [WorkflowRunState.PENDING]: [WorkflowRunState.RUNNING, WorkflowRunState.ABORTED],
  [WorkflowRunState.RUNNING]: [
    WorkflowRunState.WAITING,
    WorkflowRunState.GATING,
    WorkflowRunState.REWORK,
    WorkflowRunState.COMPLETED,
    WorkflowRunState.FAILED,
    WorkflowRunState.ABORTED,
  ],
  [WorkflowRunState.WAITING]: [
    WorkflowRunState.RUNNING,
    WorkflowRunState.ABORTED,
    WorkflowRunState.FAILED,
  ],
  [WorkflowRunState.GATING]: [
    WorkflowRunState.RUNNING,
    WorkflowRunState.REWORK,
    WorkflowRunState.WAITING,
    WorkflowRunState.COMPLETED,
    WorkflowRunState.FAILED,
  ],
  [WorkflowRunState.REWORK]: [
    WorkflowRunState.RUNNING,
    WorkflowRunState.ABORTED,
    WorkflowRunState.FAILED,
  ],
  [WorkflowRunState.COMPLETED]: [],
  [WorkflowRunState.FAILED]: [WorkflowRunState.SUPERSEDED],
  [WorkflowRunState.ABORTED]: [WorkflowRunState.RUNNING, WorkflowRunState.SUPERSEDED],
  [WorkflowRunState.SUPERSEDED]: [],
});

export function assertTransition(from: WorkflowRunState, to: WorkflowRunState): void {
  if (from === to) return;
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    fail({
      code: 'E_INVALID_TRANSITION',
      message: 'Workflow run cannot move ' + from + ' -> ' + to,
      remedy:
        'Permitted from ' +
        from +
        ': ' +
        (allowed.length === 0 ? '(terminal)' : allowed.join(', ')),
      details: { from, to },
      specRef: '31 V5b',
    });
  }
}

export function isTerminal(state: WorkflowRunState): boolean {
  return (
    state === WorkflowRunState.COMPLETED ||
    state === WorkflowRunState.FAILED ||
    state === WorkflowRunState.SUPERSEDED
  );
}

export class WorkflowEngine {
  constructor(
    private readonly store: Store,
    private readonly deps: WorkflowDeps,
    private readonly definitions: ReadonlyMap<string, WorkflowDefinition>,
  ) {}

  definition(ref: string): WorkflowDefinition {
    const d = this.definitions.get(ref);
    if (d === undefined) {
      return fail({
        code: 'E_NOT_FOUND',
        message: 'Unknown workflow definition: ' + ref,
        remedy: 'Register the definition before starting a run. See 30 §8 for the catalogue.',
        details: { ref, known: [...this.definitions.keys()] },
        specRef: '30 §8',
      });
    }
    return d;
  }

  get(runId: string, tx?: Transaction): WorkflowRun | undefined {
    const src = tx ?? this.store;
    return src.getWorking<WorkflowRun>('workflowRun', runId)?.body;
  }

  private require(runId: string, tx?: Transaction): WorkflowRun {
    const run = this.get(runId, tx);
    if (run === undefined) {
      return fail({
        code: 'E_NOT_FOUND',
        message: 'No workflow run ' + runId,
        remedy: 'Start the run first, or check the identifier.',
        details: { runId },
      });
    }
    return run;
  }

  private persist(
    tx: Transaction,
    run: WorkflowRun,
    event: WorkflowEventType,
    detail?: Record<string, unknown>,
  ): WorkflowRun {
    const next: WorkflowRun = { ...run, updatedAt: this.deps.clock.now() };
    tx.putWorking('workflowRun', next.id, next);
    tx.appendTrace(WORKFLOW_STREAM, {
      type: event,
      payload: { runId: next.id, state: next.state, ...(detail ?? {}) },
      correlationId: next.id,
    });
    audit(tx, {
      action: AuditAction.WORKFLOW_TRANSITION,
      subject: next.id,
      outcome: 'OK',
      detail: { event, state: next.state },
    });
    return next;
  }

  start(tx: Transaction, workflowRef: string, workItemId: string): WorkflowRun {
    const def = this.definition(workflowRef);
    const now = this.deps.clock.now();
    const run: WorkflowRun = {
      id: this.deps.ids.next('SC-WFR'),
      workflowRef: def.id,
      workflowVersion: def.version,
      workItemId,
      state: WorkflowRunState.RUNNING,
      currentSteps: this.readySteps(def, []),
      completedSteps: [],
      failedSteps: [],
      startedAt: now,
      updatedAt: now,
    };
    return this.persist(tx, run, WorkflowEventType.RUN_STARTED, { workflowRef: def.id });
  }

  /** Steps whose dependencies are all satisfied and which are not yet done. */
  private readySteps(def: WorkflowDefinition, completed: readonly string[]): string[] {
    return def.steps
      .filter((s) => !completed.includes(s.id))
      .filter((s) => s.dependsOn.every((d) => completed.includes(d)))
      .map((s) => s.id);
  }

  /**
   * Complete a step. Idempotent (07 §5.2 ID-1): completing an already-completed
   * step is a no-op rather than a duplicate advance.
   */
  completeStep(tx: Transaction, runId: string, stepId: string): WorkflowRun {
    const run = this.require(runId, tx);
    const def = this.definition(run.workflowRef);
    if (def.steps.find((s) => s.id === stepId) === undefined) {
      fail({
        code: 'E_NOT_FOUND',
        message: 'Step ' + stepId + ' is not part of workflow ' + def.id,
        remedy: 'Check the step identifier against the workflow definition.',
        details: { runId, stepId },
      });
    }
    if (run.completedSteps.includes(stepId)) return run; // ID-1
    if (isTerminal(run.state)) {
      fail({
        code: 'E_INVALID_TRANSITION',
        message: 'Workflow run ' + runId + ' is ' + run.state,
        remedy: 'A terminal run cannot accept further step completions.',
        details: { runId, state: run.state },
        specRef: '31 V5b',
      });
    }

    const completed = [...run.completedSteps, stepId];
    const ready = this.readySteps(def, completed);
    const allDone = completed.length === def.steps.length;
    const nextState = allDone ? WorkflowRunState.COMPLETED : WorkflowRunState.RUNNING;
    assertTransition(run.state, nextState);

    const next: WorkflowRun = {
      ...run,
      state: nextState,
      completedSteps: completed,
      currentSteps: allDone ? [] : ready,
      failedSteps: run.failedSteps.filter((s) => s !== stepId),
      ...(allDone ? { endedAt: this.deps.clock.now() } : {}),
    };
    return this.persist(
      tx,
      next,
      allDone ? WorkflowEventType.RUN_COMPLETED : WorkflowEventType.STEP_COMPLETED,
      { stepId },
    );
  }

  failStep(tx: Transaction, runId: string, stepId: string, reason: string): WorkflowRun {
    const run = this.require(runId, tx);
    assertTransition(run.state, WorkflowRunState.REWORK);
    const next: WorkflowRun = {
      ...run,
      state: WorkflowRunState.REWORK,
      failedSteps: run.failedSteps.includes(stepId)
        ? run.failedSteps
        : [...run.failedSteps, stepId],
      currentSteps: [stepId],
    };
    return this.persist(tx, next, WorkflowEventType.STEP_FAILED, { stepId, reason });
  }

  block(tx: Transaction, runId: string, reason: string): WorkflowRun {
    const run = this.require(runId, tx);
    assertTransition(run.state, WorkflowRunState.WAITING);
    const next: WorkflowRun = { ...run, state: WorkflowRunState.WAITING };
    return this.persist(tx, next, WorkflowEventType.RUN_BLOCKED, { reason });
  }

  /** Resume from WAITING, REWORK or ABORTED. 07 §6.1 — checkpoint-based. */
  resume(tx: Transaction, runId: string): WorkflowRun {
    const run = this.require(runId, tx);
    assertTransition(run.state, WorkflowRunState.RUNNING);
    const def = this.definition(run.workflowRef);
    const next: WorkflowRun = {
      ...run,
      state: WorkflowRunState.RUNNING,
      currentSteps: this.readySteps(def, run.completedSteps),
    };
    return this.persist(tx, next, WorkflowEventType.RUN_RESUMED);
  }

  abort(tx: Transaction, runId: string, reason: string): WorkflowRun {
    const run = this.require(runId, tx);
    assertTransition(run.state, WorkflowRunState.ABORTED);
    const next: WorkflowRun = {
      ...run,
      state: WorkflowRunState.ABORTED,
      endedAt: this.deps.clock.now(),
    };
    return this.persist(tx, next, WorkflowEventType.RUN_ABORTED, { reason });
  }

  markFailed(tx: Transaction, runId: string, reason: string): WorkflowRun {
    const run = this.require(runId, tx);
    assertTransition(run.state, WorkflowRunState.FAILED);
    const next: WorkflowRun = {
      ...run,
      state: WorkflowRunState.FAILED,
      endedAt: this.deps.clock.now(),
    };
    return this.persist(tx, next, WorkflowEventType.RUN_FAILED, { reason });
  }

  /** Rebuild currentSteps from completedSteps. Used after interruption. */
  recompute(runId: string): string[] {
    const run = this.require(runId);
    return this.readySteps(this.definition(run.workflowRef), run.completedSteps);
  }

  list(): WorkflowRun[] {
    return this.store
      .listWorkingIds('workflowRun')
      .map((id) => this.get(id))
      .filter((r): r is WorkflowRun => r !== undefined);
  }
}
