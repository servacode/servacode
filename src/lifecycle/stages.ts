import { StageExecutionState, StageLedgerDisposition, type GateVerdict } from '../vocab/index.js';
import { fail } from '../core/errors.js';
import { AuditAction, audit } from '../events/audit.js';
import { mapGateOutcome } from './mapping.js';
import { getCatalogues } from '../catalogue/index.js';
import type { Store, Transaction } from '../store/store.js';
import type { StageLedgerEntry, StageState } from '../domain/schemas.js';
import type { IdSource } from '../core/ids.js';
import type { Clock } from '../core/clock.js';

/**
 * Lifecycle / stage engine.
 *
 * SPEC: 03 §1.3 (two distinct machines), 03 §10 (stage ledger), 31 §6.
 *
 * StageExecutionState  V5c  mutable live pointer      -- REWORK is legal
 * StageLedgerEntry     V5d  immutable, per attempt    -- REWORK is NOT a member (PS-1)
 */

export const STAGE_LEDGER_STREAM = 'stage-ledger';

export interface StageDeps {
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly actor: string;
}

const LIVE_TRANSITIONS: Readonly<Record<StageExecutionState, readonly StageExecutionState[]>> =
  Object.freeze({
    [StageExecutionState.NOT_STARTED]: [
      StageExecutionState.IN_PROGRESS,
      StageExecutionState.BLOCKED,
    ],
    [StageExecutionState.IN_PROGRESS]: [
      StageExecutionState.IN_GATE,
      StageExecutionState.BLOCKED,
      StageExecutionState.COMPLETE,
    ],
    [StageExecutionState.IN_GATE]: [
      StageExecutionState.COMPLETE,
      StageExecutionState.REWORK,
      StageExecutionState.BLOCKED,
    ],
    [StageExecutionState.REWORK]: [StageExecutionState.IN_PROGRESS, StageExecutionState.BLOCKED],
    [StageExecutionState.BLOCKED]: [
      StageExecutionState.IN_PROGRESS,
      StageExecutionState.NOT_STARTED,
    ],
    [StageExecutionState.COMPLETE]: [],
  });

function stateKey(workItemId: string, stageId: string): string {
  return workItemId + '__' + stageId;
}

export function assertKnownStage(stageId: string): void {
  if (!getCatalogues().stageIds.includes(stageId)) {
    fail({
      code: 'E_VALIDATION',
      message: 'Unknown lifecycle stage: ' + stageId,
      remedy: 'Use a stage catalogued in 30 §6. Run `serva doctor` to list them.',
      details: { stageId },
      specRef: '30 §6',
    });
  }
}

export function getStageState(
  store: Store,
  workItemId: string,
  stageId: string,
  tx?: Transaction,
): StageState | undefined {
  const src = tx ?? store;
  return src.getWorking<StageState>('stageState', stateKey(workItemId, stageId))?.body;
}

export function startStage(
  tx: Transaction,
  store: Store,
  deps: StageDeps,
  workItemId: string,
  stageId: string,
): StageState {
  assertKnownStage(stageId);
  const existing = getStageState(store, workItemId, stageId, tx);
  const from = existing?.state ?? StageExecutionState.NOT_STARTED;
  return transitionStage(tx, store, deps, workItemId, stageId, StageExecutionState.IN_PROGRESS, {
    attempt: from === StageExecutionState.NOT_STARTED ? 1 : (existing?.attempt ?? 0) + 1,
  });
}

export function transitionStage(
  tx: Transaction,
  store: Store,
  deps: StageDeps,
  workItemId: string,
  stageId: string,
  to: StageExecutionState,
  opts?: { attempt?: number; force?: boolean },
): StageState {
  assertKnownStage(stageId);
  const existing = getStageState(store, workItemId, stageId, tx);
  const from = existing?.state ?? StageExecutionState.NOT_STARTED;

  if (opts?.force !== true && from !== to) {
    const allowed = LIVE_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      fail({
        code: 'E_INVALID_TRANSITION',
        message: 'Stage ' + stageId + ' cannot move ' + from + ' -> ' + to,
        remedy:
          'Permitted from ' +
          from +
          ': ' +
          (allowed.length === 0 ? '(terminal)' : allowed.join(', ')),
        details: { workItemId, stageId, from, to },
        specRef: '03 §1.3',
      });
    }
  }

  const next: StageState = {
    stageId,
    workItemId,
    state: to,
    attempt: opts?.attempt ?? existing?.attempt ?? 1,
    updatedAt: deps.clock.now(),
  };
  tx.putWorking('stageState', stateKey(workItemId, stageId), next);
  return next;
}

/**
 * Append one immutable ledger entry. 03 §10, 31 PS-2.
 * A stage attempted three times has three entries, not one edited twice.
 */
export function appendLedgerEntry(
  tx: Transaction,
  deps: StageDeps,
  entry: Omit<StageLedgerEntry, 'id' | 'at' | 'decidedBy'>,
): StageLedgerEntry {
  if ((StageLedgerDisposition as Record<string, string>)[entry.disposition] === undefined) {
    fail({
      code: 'E_VALIDATION',
      message: 'Invalid stage ledger disposition: ' + entry.disposition,
      remedy: 'REWORK is not a ledger disposition. Use FAILED for the attempt (31 PS-1).',
      details: { disposition: entry.disposition },
      specRef: '31 PS-1',
    });
  }
  const full: StageLedgerEntry = {
    ...entry,
    id: deps.ids.next('SC-SLE'),
    decidedBy: deps.actor,
    at: deps.clock.now(),
  };
  tx.appendTrace(STAGE_LEDGER_STREAM, { type: 'STAGE_LEDGER_ENTRY', payload: full });
  audit(tx, {
    action: AuditAction.STAGE_LEDGER_APPENDED,
    subject: entry.stageId,
    outcome: 'OK',
    detail: {
      workItemId: entry.workItemId,
      disposition: entry.disposition,
      attempt: entry.attempt,
    },
  });
  return full;
}

export function readLedger(store: Store, workItemId?: string): StageLedgerEntry[] {
  const rows = store.readTrace(STAGE_LEDGER_STREAM).map((r) => r.payload as StageLedgerEntry);
  return workItemId === undefined ? rows : rows.filter((r) => r.workItemId === workItemId);
}

/**
 * Apply a gate verdict across all four state machines. 31 §6.2.
 *
 * Returns the ledger entry that was appended and the resulting live stage state,
 * so callers can see both facts rather than inferring one from the other.
 */
export function applyGateOutcome(
  tx: Transaction,
  store: Store,
  deps: StageDeps,
  args: {
    workItemId: string;
    stageId: string;
    verdict: GateVerdict;
    profileRef: string;
    gateResultRef?: string;
  },
): { ledger: StageLedgerEntry; stage: StageState; dispatches: string } {
  const mapping = mapGateOutcome(args.verdict);
  const current = getStageState(store, args.workItemId, args.stageId, tx);
  const attempt = current?.attempt ?? 1;

  const ledger = appendLedgerEntry(tx, deps, {
    stageId: args.stageId,
    workItemId: args.workItemId,
    attempt,
    disposition: mapping.ledgerDisposition,
    profileRef: args.profileRef,
    ...(args.gateResultRef === undefined ? {} : { gateResultRef: args.gateResultRef }),
  });

  // Live pointer. Force is used because the gate is authoritative over the
  // live machine; the guard exists for hand-driven transitions.
  let stage = transitionStage(tx, store, deps, args.workItemId, args.stageId, mapping.stageState, {
    attempt,
    force: true,
  });

  if (mapping.stageStateNext !== undefined) {
    // A failed attempt settles into IN_PROGRESS for a NEW attempt.
    stage = transitionStage(
      tx,
      store,
      deps,
      args.workItemId,
      args.stageId,
      mapping.stageStateNext,
      { attempt: attempt + 1, force: true },
    );
  }

  return { ledger, stage, dispatches: mapping.dispatches };
}
