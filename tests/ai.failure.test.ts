import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ContractRegistry } from '../src/agents/registry.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { FakeEngineAdapter } from '../src/engine/fake.js';
import { ClaudeCliEngineAdapter } from '../src/engine/claude/adapter.js';
import { PHASE3_ENABLED_AGENTS } from '../src/app/ai.js';
import { EngineHealthState, TerminationReason } from '../src/engine/types.js';
import { EnvelopeStatus, RunOutcome } from '../src/vocab/index.js';
import { findIncompleteRuns, projectAgentRun, runStream } from '../src/events/agentRun.js';
import { FixedClock } from '../src/core/clock.js';
import { cleanup, freshStore } from './helpers.js';
import type { CommandRunner } from '../src/engine/claude/probe.js';
import type { InvocationRequest } from '../src/engine/types.js';

/**
 * FAILURE AND RECOVERY.
 *
 * SPEC: 19 §7 (the failure table), 22, 05 RI-1/RI-6/RI-7.
 *
 * Two properties matter more than the individual cases:
 *
 *   - Every failure has a NAME and a route. Nothing degrades into a plausible
 *     success, and nothing throws an unhandled error out of a governed run.
 *   - An interrupted run leaves a detectable trace. Recovery reconstructs from the
 *     store, never from the engine's lost conversation.
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

const RUN = {
  agentId: 'SC-AGENT-003',
  workItemId: 'SC-WI-000001',
  taskDefinition: 'Classify.',
  scopeBoundary: 'classification only',
  resultSchema: { type: 'object' },
};

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: EnvelopeStatus.COMPLETED,
    result: {},
    selfReview: {
      contractConformance: 'ok',
      scopeConformance: 'ok',
      knownGaps: [],
      confidence: 'MEDIUM',
      assumptionsMade: [],
    },
    observations: [],
    escalations: [],
    evidenceClaims: [],
    unresolved: [],
    ...over,
  };
}

/* ============================================= engine-level failures */

describe('every engine failure has a name and a route', () => {
  const CASES: readonly [TerminationReason, RunOutcome][] = [
    [TerminationReason.ENGINE_UNAVAILABLE, RunOutcome.BLOCKED],
    [TerminationReason.UNAUTHENTICATED, RunOutcome.BLOCKED],
    [TerminationReason.CONTEXT_LIMIT, RunOutcome.BLOCKED],
    [TerminationReason.TIMEOUT, RunOutcome.FAILED],
    [TerminationReason.BUDGET_EXCEEDED, RunOutcome.FAILED],
    [TerminationReason.RATE_LIMITED, RunOutcome.FAILED],
    [TerminationReason.ENGINE_ERROR, RunOutcome.FAILED],
    [TerminationReason.INTERRUPTED, RunOutcome.FAILED],
  ];

  for (const [reason, expected] of CASES) {
    it('maps ' + reason + ' to ' + expected + ' without throwing', async () => {
      const { engine, runtime } = setup();
      engine.script('SC-AGENT-003', { terminatedBy: reason });
      const r = await runtime.run(RUN);
      expect(r.outcome).toBe(expected);
      expect(r.diagnostics.join(' ')).toContain(reason);
    });
  }

  it('an unavailable engine blocks rather than failing, so the work item survives', async () => {
    const { engine, runtime } = setup();
    engine.script('SC-AGENT-003', { terminatedBy: TerminationReason.ENGINE_UNAVAILABLE });
    const r = await runtime.run(RUN);
    // BLOCKED: the work is fine, the engine is not. FAILED would blame the work.
    expect(r.outcome).toBe(RunOutcome.BLOCKED);
  });

  it('a rate-limit retry is visible in diagnostics rather than swallowed', async () => {
    const { engine, runtime } = setup();
    engine.script('SC-AGENT-003', {
      terminatedBy: TerminationReason.RATE_LIMITED,
      diagnostics: ['engine retry 1: rate_limit'],
    });
    const r = await runtime.run(RUN);
    expect(r.diagnostics.join(' ')).toMatch(/rate_limit/);
  });
});

/* ============================================= output failures */

describe('malformed and invalid output', () => {
  it('malformed JSON never reaches project state', async () => {
    const { engine, runtime } = setup();
    engine.script('SC-AGENT-003', { structuredOutput: 'not an object at all' });
    engine.script('SC-AGENT-003', { structuredOutput: 42 });
    const r = await runtime.run(RUN);
    expect(r.outcome).toBe(RunOutcome.INVALID_OUTPUT);
    expect(r.envelope).toBeUndefined();
  });

  it('a missing required envelope field is rejected', async () => {
    const { engine, runtime } = setup();
    const bad = envelope();
    delete (bad as Record<string, unknown>)['observations'];
    engine.script('SC-AGENT-003', { structuredOutput: bad });
    engine.script('SC-AGENT-003', { structuredOutput: bad });
    const r = await runtime.run(RUN);
    expect(r.outcome).toBe(RunOutcome.INVALID_OUTPUT);
    expect(r.diagnostics.join(' ')).toMatch(/observations/);
  });

  it('an empty observations array is accepted, an absent one is not', async () => {
    const { engine, runtime } = setup();
    engine.script('SC-AGENT-003', { structuredOutput: envelope({ observations: [] }) });
    const r = await runtime.run(RUN);
    expect(r.outcome).toBe(RunOutcome.COMPLETED);
  });

  it('exactly one repair attempt is made, never a loop', async () => {
    const { engine, runtime } = setup();
    for (let i = 0; i < 5; i++) engine.script('SC-AGENT-003', { structuredOutput: { bad: i } });
    const r = await runtime.run(RUN);
    expect(r.attempts).toBe(2);
    expect(engine.seen).toHaveLength(2);
  });

  it('the second attempt succeeding is recorded as a success', async () => {
    const { store, engine, runtime } = setup();
    engine.script('SC-AGENT-003', { structuredOutput: { bad: true } });
    engine.script('SC-AGENT-003', { structuredOutput: envelope() });
    const r = await runtime.run(RUN);
    expect(r.outcome).toBe(RunOutcome.COMPLETED);
    const validations = store
      .readTrace(runStream(r.runId))
      .filter((e) => e.type === 'VALIDATION_RESULT');
    expect(validations).toHaveLength(2);
    expect((validations[0]?.payload as Record<string, unknown>)['valid']).toBe(false);
    expect((validations[1]?.payload as Record<string, unknown>)['valid']).toBe(true);
  });
});

/* ============================================= interruption and recovery */

describe('an interrupted run is detectable and re-dispatchable', () => {
  it('a run killed mid-flight leaves no terminal event when the process dies', async () => {
    // Simulate the crash directly: RUN_CREATED is appended, then nothing.
    const { store, root, deps } = freshStore();
    roots.push(root);
    const { appendRunEvent, AgentRunEventType } = await import('../src/events/agentRun.js');
    const tx = store.begin();
    appendRunEvent(tx, 'SC-RUN-CRASHED', {
      type: AgentRunEventType.RUN_CREATED,
      payload: { agentId: 'SC-AGENT-003', workItemId: 'SC-WI-1' },
    });
    tx.commit();
    void deps;

    expect(findIncompleteRuns(store)).toContain('SC-RUN-CRASHED');
    const p = projectAgentRun(store, 'SC-RUN-CRASHED');
    expect(p.terminal).toBe(false);
    expect(p.outcome).toBeUndefined();
  });

  it('recovery re-dispatches from the store, not from engine memory', async () => {
    const { engine, runtime, store } = setup();
    engine.script('SC-AGENT-003', { terminatedBy: TerminationReason.INTERRUPTED });
    const first = await runtime.run({ ...RUN, ownerRequest: 'the original request' });

    engine.script('SC-AGENT-003', { structuredOutput: envelope() });
    const second = await runtime.run({ ...RUN, ownerRequest: 'the original request' });

    expect(second.runId).not.toBe(first.runId);
    // The second run was given a freshly BUILT bundle, not a resumed conversation.
    expect(engine.seen[1]?.sessionPolicy).toBe('NEW');
    expect(engine.seen[1]?.systemPrompt).toContain('the original request');
    // Both runs are in the store; neither overwrote the other (05 RI-7).
    const streams = store.listTraceStreams().filter((s) => s.startsWith('agentrun/'));
    expect(streams).toHaveLength(2);
  });

  it('the first run remains permanently visible after re-dispatch', async () => {
    const { engine, runtime, store } = setup();
    engine.script('SC-AGENT-003', { terminatedBy: TerminationReason.INTERRUPTED });
    const first = await runtime.run(RUN);
    engine.script('SC-AGENT-003', { structuredOutput: envelope() });
    await runtime.run(RUN);
    const p = projectAgentRun(store, first.runId);
    expect(p.terminal).toBe(true);
    expect(store.trace(runStream(first.runId)).verify().ok).toBe(true);
  });

  it('an abort signal terminates the invocation deterministically', async () => {
    const { deps } = freshStore();
    const engine = new FakeEngineAdapter({ clock: deps.clock });
    engine.script('SC-AGENT-003', { delayMs: 10_000, structuredOutput: envelope() });
    const ac = new AbortController();
    const req: InvocationRequest = {
      runId: 'SC-RUN-X',
      agentId: 'SC-AGENT-003',
      contractVersion: '1.0.0',
      systemPrompt: 'S',
      prompt: 'P',
      outputSchema: {},
      tools: {
        allow: [],
        deny: [],
        filesystem: { read: [], write: [] },
        network: 'NONE',
        maxToolCalls: 0,
        rationale: [],
      },
      sessionPolicy: 'NEW',
      budget: {
        maxWallTimeMs: 1,
        maxTurns: 1,
        maxToolCalls: 0,
        maxContextChars: 10,
        maxRetries: 0,
      },
      cwd: 'D:/p',
    };
    const p = engine.invoke(req, ac.signal);
    ac.abort();
    expect((await p).terminatedBy).toBe(TerminationReason.INTERRUPTED);
  });
});

/* ============================================= transport-level failures */

/** A fake child process, so transport failures are testable without spawning. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed: string[] = [];
  kill(sig: string): boolean {
    this.killed.push(sig);
    return true;
  }
}

function adapterWith(
  runner: CommandRunner,
  child: FakeChild,
  env: NodeJS.ProcessEnv = {},
): ClaudeCliEngineAdapter {
  return new ClaudeCliEngineAdapter({
    clock: new FixedClock('2026-01-01T00:00:00.000Z', 0),
    run: runner,
    env,
    spawnFn: (() => child) as never,
    probeTtlMs: 0,
  });
}

const AUTH_OK = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  subscriptionType: 'max',
});
const okRunner: CommandRunner = async (_b, args) =>
  args[0] === '--version'
    ? { code: 0, stdout: '2.1.218', stderr: '' }
    : { code: 0, stdout: AUTH_OK, stderr: '' };

function invocation(root: string): InvocationRequest {
  return {
    runId: 'SC-RUN-T1',
    agentId: 'SC-AGENT-003',
    contractVersion: '1.0.0',
    systemPrompt: 'SYSTEM',
    prompt: 'USER',
    outputSchema: { type: 'object' },
    tools: {
      allow: [],
      deny: [],
      filesystem: { read: [], write: [] },
      network: 'NONE',
      maxToolCalls: 0,
      rationale: [],
    },
    sessionPolicy: 'NEW',
    budget: {
      maxWallTimeMs: 60_000,
      maxTurns: 2,
      maxToolCalls: 0,
      maxContextChars: 1000,
      maxRetries: 0,
    },
    cwd: root,
  };
}

describe('the Claude transport handles a hostile stream', () => {
  it('refuses to spawn when the engine is absent', async () => {
    const adapter = adapterWith(
      async () => ({ code: null, stdout: '', stderr: '', spawnFailed: true }),
      new FakeChild(),
    );
    const { root } = freshStore();
    roots.push(root);
    const r = await adapter.invoke(invocation(root));
    expect(r.terminatedBy).toBe(TerminationReason.ENGINE_UNAVAILABLE);
    expect(r.ok).toBe(false);
  });

  it('refuses to spawn when unauthenticated', async () => {
    const adapter = adapterWith(
      async (_b, args) =>
        args[0] === '--version'
          ? { code: 0, stdout: '2.1.218', stderr: '' }
          : { code: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '' },
      new FakeChild(),
    );
    const { root } = freshStore();
    roots.push(root);
    const r = await adapter.invoke(invocation(root));
    expect(r.terminatedBy).toBe(TerminationReason.UNAUTHENTICATED);
  });

  it('refuses to spawn when an API key would change the billing route', async () => {
    const adapter = adapterWith(okRunner, new FakeChild(), { ANTHROPIC_API_KEY: 'sk-x' });
    const health = await adapter.health();
    expect(health.state).toBe(EngineHealthState.BILLING_ROUTE_REFUSED);
    const { root } = freshStore();
    roots.push(root);
    const r = await adapter.invoke(invocation(root));
    expect(r.ok).toBe(false);
    expect(r.diagnostics.join(' ')).toMatch(/separately billed/);
  });

  it('reports a non-zero exit as an engine error with the code', async () => {
    const child = new FakeChild();
    const adapter = adapterWith(okRunner, child);
    const { root } = freshStore();
    roots.push(root);
    const p = adapter.invoke(invocation(root));
    setTimeout(() => {
      child.stderr.write('something went wrong\n');
      child.emit('close', 2);
    }, 5);
    const r = await p;
    expect(r.terminatedBy).toBe(TerminationReason.ENGINE_ERROR);
    expect(r.diagnostics.join(' ')).toMatch(/exit code 2/);
    expect(r.diagnostics.join(' ')).toMatch(/something went wrong/);
  });

  it('treats exit 143 as an interruption, not an error', async () => {
    const child = new FakeChild();
    const adapter = adapterWith(okRunner, child);
    const { root } = freshStore();
    roots.push(root);
    const p = adapter.invoke(invocation(root));
    setTimeout(() => child.emit('close', 143), 5);
    expect((await p).terminatedBy).toBe(TerminationReason.INTERRUPTED);
  });

  it('surfaces malformed stream lines as diagnostics without failing the run', async () => {
    const child = new FakeChild();
    const adapter = adapterWith(okRunner, child);
    const { root } = freshStore();
    roots.push(root);
    const p = adapter.invoke(invocation(root));
    setTimeout(() => {
      child.stdout.write('{ this is not json\n');
      child.stdout.write(
        JSON.stringify({ type: 'result', is_error: false, structured_output: { ok: true } }) + '\n',
      );
      child.emit('close', 0);
    }, 5);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.structuredOutput).toEqual({ ok: true });
    expect(r.diagnostics.join(' ')).toMatch(/unparseable stream line/);
  });

  it('reassembles a result split across chunk boundaries', async () => {
    const child = new FakeChild();
    const adapter = adapterWith(okRunner, child);
    const { root } = freshStore();
    roots.push(root);
    const p = adapter.invoke(invocation(root));
    const line =
      JSON.stringify({ type: 'result', is_error: false, structured_output: { split: true } }) +
      '\n';
    setTimeout(() => {
      child.stdout.write(line.slice(0, 15));
      child.stdout.write(line.slice(15));
      child.emit('close', 0);
    }, 5);
    expect((await p).structuredOutput).toEqual({ split: true });
  });

  it('kills a wedged child at the deadline', async () => {
    const child = new FakeChild();
    const adapter = adapterWith(okRunner, child);
    const { root } = freshStore();
    roots.push(root);
    const req = { ...invocation(root), budget: { ...invocation(root).budget, maxWallTimeMs: 20 } };
    const p = adapter.invoke(req);
    setTimeout(() => child.emit('close', null), 60);
    const r = await p;
    expect(r.terminatedBy).toBe(TerminationReason.TIMEOUT);
    expect(child.killed).toContain('SIGTERM');
  });

  it('flags an isolation failure if the engine reports an MCP server', async () => {
    const child = new FakeChild();
    const adapter = adapterWith(okRunner, child);
    const { root } = freshStore();
    roots.push(root);
    const p = adapter.invoke(invocation(root));
    setTimeout(() => {
      child.stdout.write(
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          mcp_servers: [{ name: 'github' }],
        }) + '\n',
      );
      child.stdout.write(JSON.stringify({ type: 'result', is_error: false }) + '\n');
      child.emit('close', 0);
    }, 5);
    const r = await p;
    expect(r.diagnostics.join(' ')).toMatch(/ISOLATION: engine reported MCP servers: github/);
  });

  it('records a denied tool call rather than discarding it', async () => {
    const child = new FakeChild();
    const adapter = adapterWith(okRunner, child);
    const { root } = freshStore();
    roots.push(root);
    const p = adapter.invoke(invocation(root));
    setTimeout(() => {
      child.stdout.write(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'Bash', id: 't1' }] },
        }) + '\n',
      );
      child.stdout.write(
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                is_error: true,
                content: 'Permission denied for tool Bash',
              },
            ],
          },
        }) + '\n',
      );
      child.stdout.write(JSON.stringify({ type: 'result', is_error: false }) + '\n');
      child.emit('close', 0);
    }, 5);
    const r = await p;
    expect(r.toolCalls.some((t) => t.tool === 'Bash' && !t.allowed)).toBe(true);
  });

  it('reports cost basis honestly on a subscription route', async () => {
    const child = new FakeChild();
    const adapter = adapterWith(okRunner, child);
    const { root } = freshStore();
    roots.push(root);
    const p = adapter.invoke(invocation(root));
    setTimeout(() => {
      child.stdout.write(JSON.stringify({ type: 'result', is_error: false }) + '\n');
      child.emit('close', 0);
    }, 5);
    const r = await p;
    // No provider figure supplied -> UNKNOWN, never an invented zero.
    expect(r.consumption.costBasis).toBe('UNKNOWN');
    expect(r.consumption.costUsd).toBeUndefined();
  });

  it('labels a provider cost figure as an estimate, not as the bill', async () => {
    const child = new FakeChild();
    const adapter = adapterWith(okRunner, child);
    const { root } = freshStore();
    roots.push(root);
    const p = adapter.invoke(invocation(root));
    setTimeout(() => {
      child.stdout.write(
        JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0.031 }) + '\n',
      );
      child.emit('close', 0);
    }, 5);
    const r = await p;
    expect(r.consumption.costBasis).toBe('PROVIDER_ESTIMATE');
    expect(r.consumption.costUsd).toBe(0.031);
  });

  it('removes the prompt file after the run', async () => {
    const child = new FakeChild();
    const adapter = adapterWith(okRunner, child);
    const { root } = freshStore();
    roots.push(root);
    const p = adapter.invoke(invocation(root));
    setTimeout(() => {
      child.stdout.write(JSON.stringify({ type: 'result', is_error: false }) + '\n');
      child.emit('close', 0);
    }, 5);
    await p;
    const { existsSync, readdirSync } = await import('node:fs');
    const tmp = root + '/.serva/tmp';
    if (existsSync(tmp)) expect(readdirSync(tmp)).toEqual([]);
  });

  it('a version change under Serva is detected rather than assumed away', async () => {
    const adapter = adapterWith(
      async (_b, args) =>
        args[0] === '--version'
          ? { code: 0, stdout: '1.9.0', stderr: '' }
          : { code: 0, stdout: AUTH_OK, stderr: '' },
      new FakeChild(),
    );
    const health = await adapter.health();
    expect(health.state).toBe(EngineHealthState.DEGRADED);
    expect(health.detail).toMatch(/predates reliable --json-schema/);
  });
});
