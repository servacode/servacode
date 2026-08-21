import { RunOutcome } from '../vocab/index.js';
import { fail } from '../core/errors.js';
import type { Store, Transaction } from '../store/store.js';

/**
 * Event-sourced AgentRun. SPEC: 05 §4 (BASELINE R4).
 *
 * Three parts, deliberately distinct:
 *   AgentRunEvent  T-TRACE   append-only, hash-chained  <- THE AUTHORITY
 *   AgentRun       T-WORKING mutable projection          <- a cache (RI-8)
 *   AgentRunRecord T-TRACE   immutable terminal snapshot
 *
 * RI-1: the RUN_CREATED event is appended BEFORE engine invocation, so a crash
 * leaves a run with no terminal event -- detectable, not silent.
 */

export const AgentRunEventType = {
  RUN_CREATED: 'RUN_CREATED',
  CONTEXT_BOUND: 'CONTEXT_BOUND',
  /**
   * Added in Phase 3. R4's 05 §4.2 event list records what a run SAW (CONTEXT_BOUND)
   * but not what it was ALLOWED TO DO. Both are runtime decisions taken before
   * invocation, and "what capability did run X have?" needs to be answerable from the
   * authoritative log for the same reason 19 CX-5 requires "what did run X see?".
   * Raised as SPEC_IMPLEMENTATION_FINDING SF-4 for an R5 amendment.
   */
  CAPABILITY_BOUND: 'CAPABILITY_BOUND',
  RUN_STARTED: 'RUN_STARTED',
  TOOL_REQUESTED: 'TOOL_REQUESTED',
  TOOL_DECIDED: 'TOOL_DECIDED',
  TOOL_RESULT_CAPTURED: 'TOOL_RESULT_CAPTURED',
  EVIDENCE_CAPTURED: 'EVIDENCE_CAPTURED',
  OUTPUT_RECEIVED: 'OUTPUT_RECEIVED',
  VALIDATION_RESULT: 'VALIDATION_RESULT',
  SCOPE_COMPUTED: 'SCOPE_COMPUTED',
  CONSUMPTION_SAMPLED: 'CONSUMPTION_SAMPLED',
  RUN_TERMINATED: 'RUN_TERMINATED',
  RUN_ABORTED: 'RUN_ABORTED',
  RUN_TIMEOUT: 'RUN_TIMEOUT',
} as const;
export type AgentRunEventType = (typeof AgentRunEventType)[keyof typeof AgentRunEventType];

const TERMINAL: ReadonlySet<string> = new Set([
  AgentRunEventType.RUN_TERMINATED,
  AgentRunEventType.RUN_ABORTED,
  AgentRunEventType.RUN_TIMEOUT,
]);

export interface AgentRunProjection {
  readonly runId: string;
  readonly taskId?: string;
  readonly workItemId?: string;
  readonly agentId?: string;
  readonly contractVersion?: string;
  readonly roleInTask?: string;
  readonly contextBundleRef?: string;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly outcome?: RunOutcome;
  readonly toolCalls: readonly { tool: string; allowed: boolean; at: string }[];
  readonly evidenceRefs: readonly string[];
  readonly scopeDeclared: readonly string[];
  readonly scopeActual: readonly string[];
  readonly consumption: Readonly<Record<string, number>>;
  readonly terminal: boolean;
  readonly eventCount: number;
}

/** Stream name for a run's event log. One stream per run keeps replay cheap. */
export function runStream(runId: string): string {
  return 'agentrun/' + runId;
}

export interface RunEventInput {
  readonly type: AgentRunEventType;
  readonly payload: Record<string, unknown>;
  readonly correlationId?: string;
  readonly causationId?: string;
}

/** Append one run event inside a transaction. The only way to advance a run. */
export function appendRunEvent(tx: Transaction, runId: string, ev: RunEventInput): void {
  tx.appendTrace(runStream(runId), {
    type: ev.type,
    payload: { runId, ...ev.payload },
    ...(ev.correlationId === undefined ? {} : { correlationId: ev.correlationId }),
    ...(ev.causationId === undefined ? {} : { causationId: ev.causationId }),
  });
}

/**
 * Rebuild the live projection by replaying the event log.
 * RI-8: where projection and log disagree, the log wins and the projection is rebuilt.
 */
export function projectAgentRun(store: Store, runId: string): AgentRunProjection {
  const events = store.readTrace(runStream(runId));
  if (events.length === 0) {
    fail({
      code: 'E_NOT_FOUND',
      message: 'No event log for run ' + runId,
      remedy: 'The run does not exist, or its trace stream was pruned.',
      details: { runId },
      specRef: '05 §4.2',
    });
  }

  const toolCalls: { tool: string; allowed: boolean; at: string }[] = [];
  const evidenceRefs: string[] = [];
  const consumption: Record<string, number> = {};
  let scopeDeclared: string[] = [];
  let scopeActual: string[] = [];
  let taskId: string | undefined;
  let workItemId: string | undefined;
  let agentId: string | undefined;
  let contractVersion: string | undefined;
  let roleInTask: string | undefined;
  let contextBundleRef: string | undefined;
  let createdAt: string | undefined;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let outcome: RunOutcome | undefined;
  let terminal = false;

  const str = (p: Record<string, unknown>, k: string): string | undefined =>
    typeof p[k] === 'string' ? (p[k] as string) : undefined;
  const arr = (p: Record<string, unknown>, k: string): string[] =>
    Array.isArray(p[k])
      ? (p[k] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];

  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    switch (e.type) {
      case AgentRunEventType.RUN_CREATED:
        createdAt = e.at;
        taskId = str(p, 'taskId');
        workItemId = str(p, 'workItemId');
        agentId = str(p, 'agentId');
        contractVersion = str(p, 'contractVersion');
        roleInTask = str(p, 'roleInTask');
        scopeDeclared = arr(p, 'scopeDeclared');
        break;
      case AgentRunEventType.CONTEXT_BOUND:
        contextBundleRef = str(p, 'contextBundleRef');
        break;
      case AgentRunEventType.RUN_STARTED:
        startedAt = e.at;
        break;
      case AgentRunEventType.TOOL_DECIDED:
        toolCalls.push({
          tool: str(p, 'tool') ?? 'unknown',
          allowed: p['allowed'] === true,
          at: e.at,
        });
        break;
      case AgentRunEventType.EVIDENCE_CAPTURED: {
        const ref = str(p, 'evidenceId');
        if (ref !== undefined) evidenceRefs.push(ref);
        break;
      }
      case AgentRunEventType.SCOPE_COMPUTED:
        scopeActual = arr(p, 'scopeActual');
        break;
      case AgentRunEventType.CONSUMPTION_SAMPLED:
        for (const [k, v] of Object.entries(p)) {
          if (typeof v === 'number') consumption[k] = v;
        }
        break;
      case AgentRunEventType.RUN_TERMINATED:
      case AgentRunEventType.RUN_ABORTED:
      case AgentRunEventType.RUN_TIMEOUT: {
        terminal = true;
        endedAt = e.at;
        const o = str(p, 'outcome');
        if (o !== undefined && Object.prototype.hasOwnProperty.call(RunOutcome, o)) {
          outcome = o as RunOutcome;
        } else if (e.type === AgentRunEventType.RUN_ABORTED) {
          outcome = RunOutcome.FAILED;
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    runId,
    ...(taskId === undefined ? {} : { taskId }),
    ...(workItemId === undefined ? {} : { workItemId }),
    ...(agentId === undefined ? {} : { agentId }),
    ...(contractVersion === undefined ? {} : { contractVersion }),
    ...(roleInTask === undefined ? {} : { roleInTask }),
    ...(contextBundleRef === undefined ? {} : { contextBundleRef }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(outcome === undefined ? {} : { outcome }),
    toolCalls,
    evidenceRefs,
    scopeDeclared,
    scopeActual,
    consumption,
    terminal,
    eventCount: events.length,
  };
}

/** Persist the rebuilt projection to T-WORKING. Cache only; never authoritative. */
export function refreshProjection(
  tx: Transaction,
  store: Store,
  runId: string,
): AgentRunProjection {
  const projection = projectAgentRun(store, runId);
  tx.putWorking('agentRun', runId, projection);
  return projection;
}

/**
 * 05 §4.3 — the immutable terminal snapshot.
 * Emitted once, at the terminal event, and bound to the event log by its digest.
 */
export function emitTerminalSnapshot(
  tx: Transaction,
  store: Store,
  runId: string,
): AgentRunProjection {
  const projection = projectAgentRun(store, runId);
  if (!projection.terminal) {
    fail({
      code: 'E_INVALID_TRANSITION',
      message: 'Run ' + runId + ' has no terminal event',
      remedy: 'Append RUN_TERMINATED, RUN_ABORTED or RUN_TIMEOUT before snapshotting.',
      details: { runId, eventCount: projection.eventCount },
      specRef: '05 §4.3',
    });
  }
  const head = store.trace(runStream(runId)).head();
  tx.putCanon('agentRunRecord', runId, { ...projection, eventLogDigest: head.digest });
  return projection;
}

/** Runs with no terminal event. 22 §4.2 — detectable, not silent. */
export function findIncompleteRuns(store: Store): string[] {
  const out: string[] = [];
  for (const stream of store.listTraceStreams()) {
    if (!stream.startsWith('agentrun/')) continue;
    const runId = stream.slice('agentrun/'.length);
    const events = store.readTrace(stream);
    const last = events[events.length - 1];
    if (last === undefined || !TERMINAL.has(last.type)) out.push(runId);
  }
  return out;
}
