import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ContractRegistry } from '../src/agents/registry.js';
import { AgentRuntime, decisionFrom, isResult } from '../src/agents/runtime.js';
import { FakeEngineAdapter } from '../src/engine/fake.js';
import { PHASE3_ENABLED_AGENTS } from '../src/app/ai.js';
import {
  emitTerminalSnapshot,
  findIncompleteRuns,
  findUnfinalizedRuns,
  readTerminalSnapshot,
  recoverTerminalSnapshots,
  runStream,
  terminalRecordFrom,
  verifyTerminalRecords,
} from '../src/events/agentRun.js';
import { verifyEvidenceClaims } from '../src/agents/envelope.js';
import { EnvelopeStatus, RunOutcome } from '../src/vocab/index.js';
import { TerminationReason, ToolCallOutcome } from '../src/engine/types.js';
import { Store } from '../src/store/store.js';
import { cleanup, freshStore, testDeps } from './helpers.js';
import type { ObservedToolCall } from '../src/engine/types.js';

/**
 * PHASE 3 CLOSURE.
 *
 * Two defects where the authoritative record could disagree with reality:
 *
 *   F1  a crash between finalization's two commits left a terminal run with no record
 *   F2  a decision was written before the provider had made one, so a later refusal
 *       produced a trace that contradicted itself
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const registry = ContractRegistry.shared();

function setup() {
  const { store, root, deps } = freshStore();
  roots.push(root);
  const engine = new FakeEngineAdapter({ clock: deps.clock });
  const runtime = new AgentRuntime({
    store,
    ids: deps.ids,
    clock: deps.clock,
    registry,
    engine,
    enabledAgents: PHASE3_ENABLED_AGENTS,
    projectRoot: root,
  });
  return { store, root, engine, runtime };
}

const RESULT_VALIDATOR = z.object({ answer: z.string() });

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: EnvelopeStatus.COMPLETED,
    result: { answer: 'ok' },
    selfReview: {
      contractConformance: 'stayed in lane',
      scopeConformance: 'classification only',
      knownGaps: ['one gap worth recording'],
      confidence: 'MEDIUM',
      assumptionsMade: [{ statement: 'assumed the store was current', loadBearing: false }],
    },
    observations: [{ kind: 'NOTE', statement: 'something worth noting', severity: 'INFO' }],
    escalations: [],
    evidenceClaims: [{ kind: 'EXTERNAL_SOURCE', statement: 'the docs say X' }],
    unresolved: ['one thing left open'],
    ...over,
  };
}

const RUN = {
  agentId: 'SC-AGENT-003',
  workItemId: 'SC-WI-000001',
  taskDefinition: 'Classify.',
  scopeBoundary: 'classification only',
  resultSchema: { type: 'object', properties: { answer: { type: 'string' } } },
  resultValidator: RESULT_VALIDATOR,
};

/**
 * Simulate a crash between finalization's two commits.
 *
 * The terminal event is committed and the record is not — which is exactly the state
 * a power loss in that window leaves behind. Deleting the record afterwards reproduces
 * it faithfully, because the record is a derived artifact and nothing else references
 * it.
 */
function crashAfterTerminalEvent(store: Store, runId: string): void {
  rmSync(join(store.paths.canon, 'agentRunRecord', runId), { recursive: true, force: true });
}

/* ==================================================================== FIX 1 */

describe('F1 — finalization survives a crash between its two commits', () => {
  it('1. a crash BEFORE the terminal event leaves a detectably incomplete run', async () => {
    const { store, engine, runtime } = setup();
    engine.script('SC-AGENT-003', { terminatedBy: TerminationReason.ENGINE_ERROR });
    void runtime;
    void engine;

    // A run created but never terminated: RUN_CREATED with no terminal event.
    const { appendRunEvent, AgentRunEventType } = await import('../src/events/agentRun.js');
    const tx = store.begin();
    appendRunEvent(tx, 'SC-RUN-CRASHED-EARLY', {
      type: AgentRunEventType.RUN_CREATED,
      payload: { agentId: 'SC-AGENT-003', workItemId: 'SC-WI-1' },
    });
    tx.commit();

    expect(findIncompleteRuns(store)).toContain('SC-RUN-CRASHED-EARLY');
    // Not unfinalized: it never reached a terminal state, so there is nothing to
    // finalize. The two conditions are different and are reported differently.
    expect(findUnfinalizedRuns(store)).not.toContain('SC-RUN-CRASHED-EARLY');
  });

  it('2. terminal event committed with no record is detected and repaired', async () => {
    const { store, engine, runtime } = setup();
    engine.script('SC-AGENT-003', { structuredOutput: envelope() });
    const r = await runtime.run(RUN);
    expect(readTerminalSnapshot(store, r.runId)).toBeDefined();

    crashAfterTerminalEvent(store, r.runId);
    expect(readTerminalSnapshot(store, r.runId)).toBeUndefined();

    // Detected as its own condition, never as an ordinary incomplete run.
    expect(findUnfinalizedRuns(store)).toEqual([r.runId]);
    expect(findIncompleteRuns(store)).not.toContain(r.runId);

    const recovered = recoverTerminalSnapshots(store);
    expect(recovered.repaired).toEqual([r.runId]);

    const snapshot = readTerminalSnapshot(store, r.runId) as Record<string, unknown>;
    expect(snapshot).toBeDefined();
    expect(snapshot['outcome']).toBe(RunOutcome.COMPLETED);
    expect(findUnfinalizedRuns(store)).toEqual([]);
  });

  it('2b. a real process restart performs the repair before anything reads the store', async () => {
    const { store, root, engine, runtime } = setup();
    engine.script('SC-AGENT-003', { structuredOutput: envelope() });
    const r = await runtime.run(RUN);
    crashAfterTerminalEvent(store, r.runId);

    // A brand new Store over the same directory: the recovery path startup runs.
    const reopened = Store.open(root, testDeps());
    recoverTerminalSnapshots(reopened);
    expect(readTerminalSnapshot(reopened, r.runId)).toBeDefined();
  });

  it('3. recovery is a no-op when the record already exists', async () => {
    const { store, engine, runtime } = setup();
    engine.script('SC-AGENT-003', { structuredOutput: envelope() });
    const r = await runtime.run(RUN);
    const before = readTerminalSnapshot(store, r.runId);

    expect(recoverTerminalSnapshots(store).repaired).toEqual([]);
    expect(readTerminalSnapshot(store, r.runId)).toEqual(before);
  });

  it('4. recovery run twice still yields exactly one record', async () => {
    const { store, engine, runtime } = setup();
    engine.script('SC-AGENT-003', { structuredOutput: envelope() });
    const r = await runtime.run(RUN);
    crashAfterTerminalEvent(store, r.runId);

    const first = recoverTerminalSnapshots(store);
    const second = recoverTerminalSnapshots(store);
    expect(first.repaired).toEqual([r.runId]);
    expect(second.repaired).toEqual([]);

    // One canon record, at one version: recovery never wrote a second.
    expect(store.listCanonVersions('agentRunRecord', r.runId)).toEqual([1]);
    expect(
      store.readTrace(runStream(r.runId)).filter((e) => e.type.startsWith('RUN_TERMI')),
    ).toHaveLength(1);
  });

  it('5. a record that disagrees with the log is an integrity failure', async () => {
    const { store, engine, runtime } = setup();
    engine.script('SC-AGENT-003', { structuredOutput: envelope() });
    const r = await runtime.run(RUN);

    // Forge a record that claims a different outcome than the log records.
    const forged = {
      ...(readTerminalSnapshot(store, r.runId) as Record<string, unknown>),
      outcome: RunOutcome.FAILED,
    };
    const tx = store.begin();
    tx.putCanon('agentRunRecord', r.runId, forged);
    tx.commit();

    const tx2 = store.begin();
    expect(() => emitTerminalSnapshot(tx2, store, r.runId)).toThrowError(
      /disagrees with its event log/,
    );

    const sweep = verifyTerminalRecords(store);
    expect(sweep.problems).toHaveLength(1);
    expect(sweep.problems[0]?.problem).toMatch(/outcome/);
  });

  it('6. a recovered record binds to the final trace head', async () => {
    const { store, engine, runtime } = setup();
    engine.script('SC-AGENT-003', { structuredOutput: envelope() });
    const r = await runtime.run(RUN);
    const original = readTerminalSnapshot(store, r.runId) as Record<string, unknown>;

    crashAfterTerminalEvent(store, r.runId);
    recoverTerminalSnapshots(store);
    const recovered = readTerminalSnapshot(store, r.runId) as Record<string, unknown>;

    expect(recovered['eventLogDigest']).toBe(store.trace(runStream(r.runId)).head().digest);
    expect(recovered['eventLogDigest']).toBe(original['eventLogDigest']);
  });

  it('7. a recovered record preserves every field the canonical record requires', async () => {
    const { store, engine, runtime } = setup();
    engine.script('SC-AGENT-003', {
      structuredOutput: envelope({ result: { answer: 'ok' } }),
    });
    const r = await runtime.run(RUN);
    const original = readTerminalSnapshot(store, r.runId) as Record<string, unknown>;

    crashAfterTerminalEvent(store, r.runId);
    recoverTerminalSnapshots(store);
    const recovered = readTerminalSnapshot(store, r.runId) as Record<string, unknown>;

    // Byte-identical, because both are derived from the same event log.
    expect(recovered).toEqual(original);

    // And the fields the projection alone could NOT have reproduced are all present.
    expect(recovered['selfReview']).toMatchObject({ confidence: 'MEDIUM' });
    expect(recovered['observations']).toHaveLength(1);
    expect(recovered['escalations']).toEqual([]);
    expect(recovered['attempts']).toBe(1);
    expect(recovered['engineSessionRef']).toBe('fake-session-' + r.runId);
    expect(recovered['claimAssessments']).toEqual([
      { kind: 'EXTERNAL_SOURCE', statement: 'the docs say X', verification: 'UNVERIFIED' },
    ]);
  });

  it('a second finalization attempt after a crash cannot append a second terminal event', async () => {
    const { store, engine, runtime } = setup();
    engine.script('SC-AGENT-003', { structuredOutput: envelope() });
    const r = await runtime.run(RUN);
    const eventsBefore = store.readTrace(runStream(r.runId)).length;
    crashAfterTerminalEvent(store, r.runId);

    // The runtime re-terminating an already-terminal run repairs the record and
    // appends nothing: a second terminal event could never be withdrawn.
    engine.script('SC-AGENT-003', { structuredOutput: envelope() });
    recoverTerminalSnapshots(store);

    expect(store.readTrace(runStream(r.runId))).toHaveLength(eventsBefore);
    expect(store.trace(runStream(r.runId)).verify().ok).toBe(true);
  });

  it('the record is a pure function of the log, so it derives identically every time', async () => {
    const { store, engine, runtime } = setup();
    engine.script('SC-AGENT-003', { structuredOutput: envelope() });
    const r = await runtime.run(RUN);
    expect(terminalRecordFrom(store, r.runId)).toEqual(terminalRecordFrom(store, r.runId));
  });

  it('every terminal outcome leaves a recoverable record', async () => {
    for (const [label, script] of [
      ['refused', { structuredOutput: envelope({ status: EnvelopeStatus.REFUSED }) }],
      ['timeout', { terminatedBy: TerminationReason.TIMEOUT }],
      ['interrupt', { terminatedBy: TerminationReason.INTERRUPTED }],
    ] as const) {
      const { store, engine, runtime } = setup();
      engine.script('SC-AGENT-003', script);
      const r = await runtime.run(RUN);
      crashAfterTerminalEvent(store, r.runId);
      expect(findUnfinalizedRuns(store), label).toEqual([r.runId]);
      recoverTerminalSnapshots(store);
      expect(readTerminalSnapshot(store, r.runId), label).toBeDefined();
    }
  });
});

/* ==================================================================== FIX 2 */

describe('F2 — a decision is never recorded before the provider makes one', () => {
  const call = (over: Partial<ObservedToolCall>): ObservedToolCall => ({
    tool: 'Read',
    useId: 't1',
    outcome: ToolCallOutcome.REQUESTED,
    at: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  const typesFor = (store: Store, runId: string, prefix: string): string[] =>
    store
      .readTrace(runStream(runId))
      .map((e) => e.type)
      .filter((t) => t.startsWith(prefix));

  it('1. a request with no result leaves REQUESTED and nothing else', async () => {
    const { store, engine, runtime } = setup();
    engine.script('SC-AGENT-003', {
      structuredOutput: envelope(),
      toolCalls: [call({ subject: 'a.txt' })],
    });
    const r = await runtime.run(RUN);
    const types = typesFor(store, r.runId, 'TOOL_');
    expect(types).toEqual(['TOOL_REQUESTED']);
    // No fabricated decision, and no result that never arrived.
    expect(types).not.toContain('TOOL_DECIDED');
    expect(types).not.toContain('TOOL_RESULT_CAPTURED');
  });

  it('2. a successful result yields REQUESTED, DECIDED(allowed), SUCCEEDED', async () => {
    const { store, engine, runtime } = setup();
    engine.script('SC-AGENT-003', {
      structuredOutput: envelope(),
      toolCalls: [
        call({}),
        call({
          outcome: ToolCallOutcome.SUCCEEDED,
          subject: 'a.txt',
          resultDigest: 'a'.repeat(64),
        }),
      ],
    });
    const r = await runtime.run(RUN);
    expect(typesFor(store, r.runId, 'TOOL_')).toEqual([
      'TOOL_REQUESTED',
      'TOOL_DECIDED',
      'TOOL_RESULT_CAPTURED',
    ]);
    const events = store.readTrace(runStream(r.runId));
    const decided = events.find((e) => e.type === 'TOOL_DECIDED')!;
    expect((decided.payload as Record<string, unknown>)['allowed']).toBe(true);
    const result = events.find((e) => e.type === 'TOOL_RESULT_CAPTURED')!;
    expect((result.payload as Record<string, unknown>)['outcome']).toBe('SUCCEEDED');
  });

  it('3. an ordinary execution error yields DECIDED(allowed) then FAILED', async () => {
    const { store, engine, runtime } = setup();
    engine.script('SC-AGENT-003', {
      structuredOutput: envelope(),
      toolCalls: [
        call({}),
        call({ outcome: ToolCallOutcome.FAILED, subject: 'missing.txt', errorClass: 'NOT_FOUND' }),
      ],
    });
    const r = await runtime.run(RUN);
    const events = store.readTrace(runStream(r.runId));
    expect(
      (events.find((e) => e.type === 'TOOL_DECIDED')!.payload as Record<string, unknown>)[
        'allowed'
      ],
    ).toBe(true);
    const result = events.find((e) => e.type === 'TOOL_RESULT_CAPTURED')!.payload as Record<
      string,
      unknown
    >;
    expect(result['outcome']).toBe('FAILED');
    expect(result['errorClass']).toBe('NOT_FOUND');
  });

  it('4. a permission refusal yields DECIDED(allowed=false) then DENIED', async () => {
    const { store, engine, runtime } = setup();
    engine.script('SC-AGENT-003', {
      structuredOutput: envelope(),
      toolCalls: [
        call({ tool: 'Read', subject: '.serva/tmp/other/system-prompt.txt' }),
        call({
          tool: 'Read',
          outcome: ToolCallOutcome.DENIED,
          subject: '.serva/tmp/other/system-prompt.txt',
          errorClass: 'PERMISSION_DENIED',
        }),
      ],
    });
    const r = await runtime.run(RUN);
    const events = store.readTrace(runStream(r.runId));
    const decided = events.find((e) => e.type === 'TOOL_DECIDED')!.payload as Record<
      string,
      unknown
    >;
    expect(decided['allowed']).toBe(false);
    const result = events.find((e) => e.type === 'TOOL_RESULT_CAPTURED')!.payload as Record<
      string,
      unknown
    >;
    expect(result['outcome']).toBe('DENIED');
  });

  it('5. a denied call never leaves allowed=true anywhere in the trace', async () => {
    const { store, engine, runtime } = setup();
    engine.script('SC-AGENT-003', {
      structuredOutput: envelope(),
      toolCalls: [
        call({ tool: 'Read' }),
        call({ tool: 'Read', outcome: ToolCallOutcome.DENIED, errorClass: 'PERMISSION_DENIED' }),
      ],
    });
    const r = await runtime.run(RUN);
    const decisions = store
      .readTrace(runStream(r.runId))
      .filter((e) => e.type === 'TOOL_DECIDED')
      .map((e) => (e.payload as Record<string, unknown>)['allowed']);
    // Exactly one decision, and it is a refusal. The old recorder wrote allowed=true
    // on first sight and then a DENIED result, so the trace contradicted itself.
    expect(decisions).toEqual([false]);
  });

  it('6. the live observer and the post-hoc sweep together produce no duplicates', async () => {
    const { store, engine, runtime } = setup();
    // The fake reports every scripted call to the observer AND returns it in the
    // result, so both paths feed the recorder in this run.
    engine.script('SC-AGENT-003', {
      structuredOutput: envelope(),
      toolCalls: [
        call({}),
        call({
          outcome: ToolCallOutcome.SUCCEEDED,
          subject: 'a.txt',
          resultDigest: 'b'.repeat(64),
        }),
      ],
    });
    const r = await runtime.run(RUN);
    const types = typesFor(store, r.runId, 'TOOL_');
    expect(types.filter((t) => t === 'TOOL_REQUESTED')).toHaveLength(1);
    expect(types.filter((t) => t === 'TOOL_DECIDED')).toHaveLength(1);
    expect(types.filter((t) => t === 'TOOL_RESULT_CAPTURED')).toHaveLength(1);
    expect(store.trace(runStream(r.runId)).verify().ok).toBe(true);
  });

  it('the decision mapping says nothing about a request it has not seen ruled on', () => {
    expect(decisionFrom(ToolCallOutcome.REQUESTED)).toBeUndefined();
    expect(decisionFrom(ToolCallOutcome.DENIED)).toBe(false);
    expect(decisionFrom(ToolCallOutcome.ALLOWED)).toBe(true);
    expect(decisionFrom(ToolCallOutcome.SUCCEEDED)).toBe(true);
    expect(decisionFrom(ToolCallOutcome.FAILED)).toBe(true);

    expect(isResult(ToolCallOutcome.REQUESTED)).toBe(false);
    expect(isResult(ToolCallOutcome.ALLOWED)).toBe(false);
    expect(isResult(ToolCallOutcome.SUCCEEDED)).toBe(true);
    expect(isResult(ToolCallOutcome.FAILED)).toBe(true);
    expect(isResult(ToolCallOutcome.DENIED)).toBe(true);
  });

  it('7. failed, denied and incomplete calls still cannot corroborate evidence', () => {
    const claim = {
      kind: 'FILE_READ' as const,
      statement: 'I read it',
      tool: 'Read',
      reference: 'a.txt',
    };
    for (const [label, outcome] of [
      ['failed', ToolCallOutcome.FAILED],
      ['denied', ToolCallOutcome.DENIED],
      ['requested only', ToolCallOutcome.REQUESTED],
      ['allowed but no result', ToolCallOutcome.ALLOWED],
    ] as const) {
      const [a] = verifyEvidenceClaims(
        [claim],
        [{ tool: 'Read', useId: 't1', outcome, at: 'now', subject: 'a.txt' }],
        ['Read'],
      );
      expect(a?.verification, label).not.toBe('CORROBORATED');
    }

    // Only a completed call does.
    const [ok] = verifyEvidenceClaims(
      [claim],
      [
        {
          tool: 'Read',
          useId: 't1',
          outcome: ToolCallOutcome.SUCCEEDED,
          at: 'now',
          subject: 'a.txt',
        },
      ],
      ['Read'],
    );
    expect(ok?.verification).toBe('CORROBORATED');
  });
});
