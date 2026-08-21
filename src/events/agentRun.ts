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
/**
 * 05 §4.3 — the immutable terminal snapshot.
 *
 * Emitted once, at the terminal event, and bound to the final digest of the event
 * chain it summarises, so the summary cannot drift from the log.
 *
 * `extra` carries the parts of the record that live outside the projection: the
 * agent's self-review, its observations and escalations, and how its evidence claims
 * were adjudicated. They are inputs to the snapshot, never to the projection, because
 * the projection is derived purely from events.
 *
 * Idempotent by construction: a run already holding a snapshot is left alone. A
 * second finalization — a crash-recovery retry, a double call — must not create a
 * second, possibly conflicting, terminal truth in an append-only system.
 */
/**
 * Build the terminal record for a run from the TRACE alone.
 *
 * SPEC: 05 §4.3.
 *
 * This is the heart of the crash fix. Finalization used to be two commits — the
 * terminal event, then the snapshot — with a real window between them. A crash there
 * left a run that projects as terminal and has no record, forever: the early-return
 * guard treated "already terminal" as "already finalized", and the incomplete-run
 * check only asked whether a terminal event existed.
 *
 * The repair is not a try/catch. It is to make the second write DERIVABLE from the
 * first. The terminal event now carries every part of the record that the projection
 * cannot reproduce — self-review, observations, escalations, claim adjudications,
 * attempt count, session reference — so the record is a pure function of the event
 * log. Recovery re-derives it byte for byte, and re-deriving it twice yields the same
 * bytes, because nothing outside the log is consulted.
 *
 * `eventLogDigest` is the run stream's head. The snapshot is written to T-CANON, not
 * to the run stream, so emitting it does not move the head: the digest a recovered
 * record computes is the same one the original would have.
 */
export function terminalRecordFrom(store: Store, runId: string): Record<string, unknown> {
  const projection = projectAgentRun(store, runId);
  if (!projection.terminal) {
    return fail({
      code: 'E_INVALID_TRANSITION',
      message: 'Run ' + runId + ' has no terminal event',
      remedy: 'Append RUN_TERMINATED, RUN_ABORTED or RUN_TIMEOUT before snapshotting.',
      details: { runId, eventCount: projection.eventCount },
      specRef: '05 §4.3',
    });
  }

  const events = store.readTrace(runStream(runId));
  const terminal = [...events].reverse().find((e) => TERMINAL.has(e.type));
  const payload = (terminal?.payload ?? {}) as Record<string, unknown>;

  // Everything the projection cannot derive travels on the terminal event itself.
  const carried: Record<string, unknown> = {};
  for (const key of TERMINAL_RECORD_FIELDS) {
    if (payload[key] !== undefined) carried[key] = payload[key];
  }

  return {
    ...projection,
    ...carried,
    eventLogDigest: store.trace(runStream(runId)).head().digest,
  };
}

/**
 * Fields the terminal event must carry for the record to be reconstructible.
 *
 * Named explicitly rather than spread wholesale: a field that belongs in the record
 * has to be a field finalization deliberately put on the event, and a reader can see
 * at a glance what survives a crash.
 */
export const TERMINAL_RECORD_FIELDS: readonly string[] = Object.freeze([
  'selfReview',
  'observations',
  'escalations',
  'claimAssessments',
  'attempts',
  'engineSessionRef',
  'diagnostics',
]);

/**
 * Emit the immutable terminal snapshot. Idempotent, and safe to call during recovery.
 *
 * Three outcomes:
 *   - no record yet          -> write the reconstructed one
 *   - record already present -> verify it still matches, then no-op
 *   - record disagrees       -> E_STORE_CORRUPT, never silently accepted
 */
export function emitTerminalSnapshot(
  tx: Transaction,
  store: Store,
  runId: string,
): Record<string, unknown> {
  const rebuilt = terminalRecordFrom(store, runId);
  const existing = tx.getCanon<Record<string, unknown>>('agentRunRecord', runId);

  if (existing !== undefined) {
    const problem = snapshotDisagreement(existing.body, rebuilt);
    if (problem !== undefined) {
      return fail({
        code: 'E_STORE_CORRUPT',
        message: 'Terminal record for ' + runId + ' disagrees with its event log: ' + problem,
        remedy:
          'The immutable record and the trace it summarises are no longer the same story. One of them was altered out of band; quarantine and restore from a verified backup (22 §5.1).',
        details: { runId, problem },
        specRef: '05 §4.3, 08 KI-1',
      });
    }
    return existing.body;
  }

  tx.putCanon('agentRunRecord', runId, rebuilt);
  return rebuilt;
}

/**
 * Does a stored record still say what the log says?
 *
 * Compared on the fields that carry terminal truth. `eventLogDigest` is the strongest
 * of them: it binds the summary to the exact chain it summarises, so an appended or
 * edited event shows up here even when every other field still matches.
 */
export function snapshotDisagreement(
  stored: Record<string, unknown>,
  rebuilt: Record<string, unknown>,
): string | undefined {
  for (const key of ['outcome', 'agentId', 'runId', 'eventLogDigest', 'eventCount']) {
    const a = stored[key];
    const b = rebuilt[key];
    if (a === undefined && b === undefined) continue;
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      return key + ': record has ' + JSON.stringify(a) + ', log implies ' + JSON.stringify(b);
    }
  }
  return undefined;
}

/** Read the immutable terminal record for a run, if it has one. */
export function readTerminalSnapshot(store: Store, runId: string): unknown | undefined {
  return store.getCanon('agentRunRecord', runId)?.body;
}

/** Runs with no terminal event. 22 §4.2 — detectable, not silent. */
/** Every run this project holds a trace stream for. */
export function listRunIds(store: Store): string[] {
  return store
    .listTraceStreams()
    .filter((s) => s.startsWith('agentrun/'))
    .map((s) => s.slice('agentrun/'.length));
}

/** A run with no terminal event: it was interrupted before it could finish (05 RI-1). */
export function findIncompleteRuns(store: Store): string[] {
  const out: string[] = [];
  for (const runId of listRunIds(store)) {
    const events = store.readTrace(runStream(runId));
    const last = events[events.length - 1];
    if (last === undefined || !TERMINAL.has(last.type)) out.push(runId);
  }
  return out;
}

/**
 * A run that ENDED but has no immutable record: finalization was interrupted between
 * its two commits.
 *
 * A distinct condition from an incomplete run, and reported as one. An incomplete run
 * needs re-dispatching; this one needs nothing re-run at all, because every fact it
 * requires is already in the log — it needs the record written. Conflating them would
 * send a finished run back through an engine it never needs to touch again.
 */
export function findUnfinalizedRuns(store: Store): string[] {
  const out: string[] = [];
  for (const runId of listRunIds(store)) {
    const events = store.readTrace(runStream(runId));
    const last = events[events.length - 1];
    if (last === undefined || !TERMINAL.has(last.type)) continue;
    if (store.getCanon('agentRunRecord', runId) === undefined) out.push(runId);
  }
  return out;
}

/**
 * Write the missing terminal record for every run that ended without one.
 *
 * Deterministic and idempotent: the record is derived from the log, so running
 * recovery twice produces the same bytes and the second pass is a no-op. Called at
 * startup, so a crash during finalization is repaired before anything reads the store.
 */
export function recoverTerminalSnapshots(store: Store): { repaired: string[] } {
  const repaired: string[] = [];
  for (const runId of findUnfinalizedRuns(store)) {
    const tx = store.begin();
    emitTerminalSnapshot(tx, store, runId);
    tx.commit();
    repaired.push(runId);
  }
  return { repaired };
}

/**
 * Non-throwing integrity sweep: does every terminal run have exactly one record that
 * still agrees with its log? Used by `serva doctor`.
 */
export function verifyTerminalRecords(store: Store): {
  checked: number;
  missing: string[];
  problems: { runId: string; problem: string }[];
} {
  const missing: string[] = [];
  const problems: { runId: string; problem: string }[] = [];
  let checked = 0;
  for (const runId of listRunIds(store)) {
    const events = store.readTrace(runStream(runId));
    const last = events[events.length - 1];
    if (last === undefined || !TERMINAL.has(last.type)) continue;
    checked += 1;
    const stored = store.getCanon<Record<string, unknown>>('agentRunRecord', runId);
    if (stored === undefined) {
      missing.push(runId);
      continue;
    }
    try {
      const problem = snapshotDisagreement(stored.body, terminalRecordFrom(store, runId));
      if (problem !== undefined) problems.push({ runId, problem });
    } catch (e) {
      problems.push({ runId, problem: e instanceof Error ? e.message : String(e) });
    }
  }
  return { checked, missing, problems };
}
