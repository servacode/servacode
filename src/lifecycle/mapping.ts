import {
  GateVerdict,
  StageExecutionState,
  StageLedgerDisposition,
  WorkItemState,
  WorkflowRunState,
} from '../vocab/index.js';

/**
 * Gate outcome -> process state mapping.
 *
 * SPEC: 31 §6.2 (BASELINE R4). Four distinct state machines advance together on
 * every gate evaluation, and the mapping between them is deterministic.
 *
 * The FAIL row is the R3 correction: the ledger records FAILED for the attempt
 * that just failed, while the live stage state becomes REWORK. PS-1 forbids
 * REWORK from ever being a ledger disposition.
 */

export interface GateOutcomeMapping {
  /** V5d — appended, immutable, per attempt. */
  readonly ledgerDisposition: StageLedgerDisposition;
  /** V5c — live pointer immediately after the gate. */
  readonly stageState: StageExecutionState;
  /** V5c — where the live pointer settles for the next attempt, if it moves again. */
  readonly stageStateNext?: StageExecutionState;
  /** V5a */
  readonly workItemState: WorkItemState;
  /** V5b */
  readonly workflowState: WorkflowRunState;
  /** What work the verdict dispatches. 18 §5 — differs even where states agree. */
  readonly dispatches:
    'ADVANCE' | 'REWORK_ARTIFACT' | 'PRODUCE_EVIDENCE' | 'RESOLVE_DEPENDENCY' | 'ROUTE_AUTHORITY';
}

export const GATE_OUTCOME_MAPPING: Readonly<Record<GateVerdict, GateOutcomeMapping>> =
  Object.freeze({
    [GateVerdict.PASS]: {
      ledgerDisposition: StageLedgerDisposition.EXECUTED,
      stageState: StageExecutionState.COMPLETE,
      workItemState: WorkItemState.ADVANCING,
      workflowState: WorkflowRunState.RUNNING,
      dispatches: 'ADVANCE',
    },
    [GateVerdict.PASS_WITH_QUALIFICATION]: {
      ledgerDisposition: StageLedgerDisposition.EXECUTED,
      stageState: StageExecutionState.COMPLETE,
      workItemState: WorkItemState.ADVANCING,
      workflowState: WorkflowRunState.RUNNING,
      dispatches: 'ADVANCE',
    },
    [GateVerdict.FAIL]: {
      ledgerDisposition: StageLedgerDisposition.FAILED,
      stageState: StageExecutionState.REWORK,
      stageStateNext: StageExecutionState.IN_PROGRESS,
      workItemState: WorkItemState.REWORK,
      workflowState: WorkflowRunState.REWORK,
      dispatches: 'REWORK_ARTIFACT',
    },
    [GateVerdict.NOT_VERIFIED]: {
      ledgerDisposition: StageLedgerDisposition.FAILED,
      stageState: StageExecutionState.REWORK,
      stageStateNext: StageExecutionState.IN_PROGRESS,
      workItemState: WorkItemState.REWORK,
      workflowState: WorkflowRunState.REWORK,
      // Same states as FAIL, different work: the artifact may be fine; the
      // verification is absent. 18 §5.
      dispatches: 'PRODUCE_EVIDENCE',
    },
    [GateVerdict.BLOCKED]: {
      ledgerDisposition: StageLedgerDisposition.BLOCKED,
      stageState: StageExecutionState.BLOCKED,
      workItemState: WorkItemState.BLOCKED,
      workflowState: WorkflowRunState.WAITING,
      dispatches: 'RESOLVE_DEPENDENCY',
    },
    [GateVerdict.ESCALATED]: {
      ledgerDisposition: StageLedgerDisposition.BLOCKED,
      stageState: StageExecutionState.BLOCKED,
      workItemState: WorkItemState.AWAITING_OWNER,
      workflowState: WorkflowRunState.WAITING,
      dispatches: 'ROUTE_AUTHORITY',
    },
  });

export function mapGateOutcome(verdict: GateVerdict): GateOutcomeMapping {
  return GATE_OUTCOME_MAPPING[verdict];
}
