import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  AgentRunEventType,
  appendRunEvent,
  emitTerminalSnapshot,
  findIncompleteRuns,
  projectAgentRun,
  refreshProjection,
  runStream,
} from '../src/events/agentRun.js';
import { RunOutcome } from '../src/vocab/index.js';
import { traceFile } from '../src/store/paths.js';
import { Store } from '../src/store/store.js';
import { cleanup, freshStore } from './helpers.js';

/**
 * TEST CATEGORY G — AgentRun recovery model (05 §4).
 *
 * The event log is the authority; the live projection is a cache (RI-8).
 * Interrupting between events must leave a reconstructible run.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

function setup(): { store: Store; root: string; deps: ReturnType<typeof freshStore>['deps'] } {
  const s = freshStore();
  roots.push(s.root);
  return s;
}

const RUN = 'SC-RUN-000001';

function createRun(store: Store, runId = RUN): void {
  const tx = store.begin();
  appendRunEvent(tx, runId, {
    type: AgentRunEventType.RUN_CREATED,
    payload: {
      taskId: 'SC-TASK-000001',
      workItemId: 'SC-WI-000001',
      agentId: 'SC-AGENT-150',
      contractVersion: '1.0.0',
      roleInTask: 'PRODUCER',
      scopeDeclared: ['src/a.ts'],
    },
  });
  tx.commit();
}

describe('G — AgentRun event sourcing and recovery', () => {
  it('RI-1: RUN_CREATED is recorded before anything else, so a crash is detectable', () => {
    const { store } = setup();
    createRun(store);

    const p = projectAgentRun(store, RUN);
    expect(p.eventCount).toBe(1);
    expect(p.terminal).toBe(false);
    expect(p.agentId).toBe('SC-AGENT-150');
    expect(findIncompleteRuns(store)).toEqual([RUN]);
  });

  it('reconstructs the live projection by replaying the event log', () => {
    const { store } = setup();
    createRun(store);

    const tx = store.begin();
    appendRunEvent(tx, RUN, {
      type: AgentRunEventType.CONTEXT_BOUND,
      payload: { contextBundleRef: 'SC-CTX-000001' },
    });
    appendRunEvent(tx, RUN, { type: AgentRunEventType.RUN_STARTED, payload: {} });
    appendRunEvent(tx, RUN, {
      type: AgentRunEventType.TOOL_DECIDED,
      payload: { tool: 'fs.write', allowed: true },
    });
    appendRunEvent(tx, RUN, {
      type: AgentRunEventType.TOOL_DECIDED,
      payload: { tool: 'net.fetch', allowed: false },
    });
    appendRunEvent(tx, RUN, {
      type: AgentRunEventType.EVIDENCE_CAPTURED,
      payload: { evidenceId: 'SC-EV-000001' },
    });
    appendRunEvent(tx, RUN, {
      type: AgentRunEventType.SCOPE_COMPUTED,
      payload: { scopeActual: ['src/a.ts'] },
    });
    appendRunEvent(tx, RUN, {
      type: AgentRunEventType.CONSUMPTION_SAMPLED,
      payload: { tokens: 1200, toolCalls: 2 },
    });
    tx.commit();

    const p = projectAgentRun(store, RUN);
    expect(p.contextBundleRef).toBe('SC-CTX-000001');
    expect(p.startedAt).toBeDefined();
    expect(p.toolCalls).toHaveLength(2);
    expect(p.toolCalls.filter((t) => !t.allowed)).toHaveLength(1); // denials are permanent
    expect(p.evidenceRefs).toEqual(['SC-EV-000001']);
    expect(p.scopeActual).toEqual(['src/a.ts']);
    expect(p.consumption['tokens']).toBe(1200);
    expect(p.terminal).toBe(false);
  });

  it('simulates interruption mid-run and rebuilds the projection from the log', () => {
    const { store, root, deps } = setup();
    createRun(store);

    const tx = store.begin();
    appendRunEvent(tx, RUN, { type: AgentRunEventType.RUN_STARTED, payload: {} });
    appendRunEvent(tx, RUN, {
      type: AgentRunEventType.TOOL_REQUESTED,
      payload: { tool: 'exec.build' },
    });
    tx.commit();

    // Process dies here: no terminal event, no persisted projection.
    const reopened = Store.open(root, deps);
    const incomplete = findIncompleteRuns(reopened);
    expect(incomplete).toEqual([RUN]);

    const rebuilt = projectAgentRun(reopened, RUN);
    expect(rebuilt.eventCount).toBe(3);
    expect(rebuilt.terminal).toBe(false);
    expect(rebuilt.startedAt).toBeDefined();
    expect(rebuilt.endedAt).toBeUndefined();
  });

  it('RI-8: where the stored projection disagrees with the log, the log wins', () => {
    const { store } = setup();
    createRun(store);

    // Poison the cached projection.
    const tx1 = store.begin();
    tx1.putWorking('agentRun', RUN, {
      runId: RUN,
      agentId: 'WRONG',
      terminal: true,
      eventCount: 999,
      toolCalls: [],
      evidenceRefs: [],
      scopeDeclared: [],
      scopeActual: [],
      consumption: {},
    });
    tx1.commit();

    const fromLog = projectAgentRun(store, RUN);
    expect(fromLog.agentId).toBe('SC-AGENT-150');
    expect(fromLog.terminal).toBe(false);
    expect(fromLog.eventCount).toBe(1);

    // Rebuilding overwrites the poisoned cache.
    const tx2 = store.begin();
    const refreshed = refreshProjection(tx2, store, RUN);
    tx2.commit();
    expect(refreshed.agentId).toBe('SC-AGENT-150');
    expect(store.getWorking<{ agentId: string }>('agentRun', RUN)?.body.agentId).toBe(
      'SC-AGENT-150',
    );
  });

  it('emits an immutable terminal snapshot bound to the event log digest', () => {
    const { store } = setup();
    createRun(store);

    const tx1 = store.begin();
    appendRunEvent(tx1, RUN, { type: AgentRunEventType.RUN_STARTED, payload: {} });
    appendRunEvent(tx1, RUN, {
      type: AgentRunEventType.RUN_TERMINATED,
      payload: { outcome: RunOutcome.COMPLETED },
    });
    tx1.commit();

    const tx2 = store.begin();
    const snap = emitTerminalSnapshot(tx2, store, RUN);
    tx2.commit();

    expect(snap.terminal).toBe(true);
    expect(snap.outcome).toBe(RunOutcome.COMPLETED);
    expect(findIncompleteRuns(store)).toEqual([]);

    const record = store.getCanon<{ eventLogDigest: string }>('agentRunRecord', RUN);
    expect(record?.body.eventLogDigest).toBe(store.trace(runStream(RUN)).head().digest);
  });

  it('refuses to snapshot a run with no terminal event', () => {
    const { store } = setup();
    createRun(store);
    const tx = store.begin();
    expect(() => emitTerminalSnapshot(tx, store, RUN)).toThrowError(/no terminal event/);
  });

  it('an aborted run is terminal and no longer reported incomplete', () => {
    const { store } = setup();
    createRun(store);
    const tx = store.begin();
    appendRunEvent(tx, RUN, {
      type: AgentRunEventType.RUN_ABORTED,
      payload: { reason: 'process killed' },
    });
    tx.commit();

    const p = projectAgentRun(store, RUN);
    expect(p.terminal).toBe(true);
    expect(p.outcome).toBe(RunOutcome.FAILED);
    expect(findIncompleteRuns(store)).toEqual([]);
  });

  it('the run event log is hash-chained and tamper-evident', () => {
    const { store } = setup();
    createRun(store);
    const tx = store.begin();
    appendRunEvent(tx, RUN, {
      type: AgentRunEventType.RUN_TERMINATED,
      payload: { outcome: RunOutcome.COMPLETED },
    });
    tx.commit();

    expect(store.trace(runStream(RUN)).verify().ok).toBe(true);

    const path = traceFile(store.paths, runStream(RUN));
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('RUN_CREATED');
    expect(raw).toContain('prevDigest');
  });

  it('reports an unknown run rather than inventing an empty projection', () => {
    const { store } = setup();
    expect(() => projectAgentRun(store, 'SC-RUN-999999')).toThrowError(/No event log/);
  });
});
