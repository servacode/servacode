import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digestOf } from '../../core/hash.js';
import { fail } from '../../core/errors.js';
import { BillingMode } from '../../vocab/index.js';
import {
  EngineHealthState,
  TerminationReason,
  type Consumption,
  type EngineAdapter,
  type EngineCapabilities,
  type EngineStatus,
  type Estimate,
  type InvocationRequest,
  type InvocationResult,
  type ObservedToolCall,
} from '../types.js';
import { CLAUDE_BIN, buildArgv, sessionUuidFor } from './argv.js';
import { StreamParser, type StreamEvent } from './stream.js';
import { billingRouteRefusal, DEFAULT_ALLOWED_BILLING } from './billing.js';
import { probeClaude, type CommandRunner } from './probe.js';
import { PROVIDER_INTERNAL_TOOLS } from '../../agents/envelope.js';
import type { Clock } from '../../core/clock.js';

/**
 * ClaudeCliEngineAdapter — the only file in Serva that spawns Claude.
 *
 * SPEC: ADR-002 §3, 19 §1.1, §2, §3, §5, §7.
 *
 * Design commitments, each of which is a test:
 *
 *   - **No shell.** `spawn` with an argument array and `shell: false`. Untrusted text
 *     never becomes shell syntax because there is no shell to interpret it.
 *   - **Prompt on stdin.** The owner's request never appears in argv at all.
 *   - **cwd is the project root**, passed explicitly rather than inherited.
 *   - **Fail closed on billing.** `invoke` refuses before spawning if the detected
 *     route is not one the project accepts (SC-POL-035).
 *   - **A deadline that actually ends the process.** SIGTERM, then SIGKILL, so a
 *     wedged child cannot hold a governed run open.
 */

export interface ClaudeAdapterOptions {
  readonly clock: Clock;
  readonly bin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowedBilling?: readonly BillingMode[];
  /** Injected for tests; defaults to a real child-process runner. */
  readonly run?: CommandRunner;
  readonly spawnFn?: typeof spawn;
  readonly probeTtlMs?: number;
}

const defaultRunner: CommandRunner = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    let done = false;
    const child = spawn(bin, [...args], { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (!done) child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', () => {
      done = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, spawnFailed: true });
    });
    child.on('close', (code) => {
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

export class ClaudeCliEngineAdapter implements EngineAdapter {
  readonly id = 'claude-cli';
  private readonly bin: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runner: CommandRunner;
  private readonly spawnFn: typeof spawn;
  private readonly allowedBilling: readonly BillingMode[];
  private readonly ttl: number;
  private cachedStatus: EngineStatus | undefined;
  private cachedAt = 0;

  constructor(private readonly opts: ClaudeAdapterOptions) {
    this.bin = opts.bin ?? CLAUDE_BIN;
    this.env = opts.env ?? process.env;
    this.runner = opts.run ?? defaultRunner;
    this.spawnFn = opts.spawnFn ?? spawn;
    this.allowedBilling = opts.allowedBilling ?? DEFAULT_ALLOWED_BILLING;
    this.ttl = opts.probeTtlMs ?? 60_000;
  }

  async health(): Promise<EngineStatus> {
    const now = this.opts.clock.epochMs();
    if (this.cachedStatus !== undefined && now - this.cachedAt < this.ttl) return this.cachedStatus;

    const { status, assessment } = await probeClaude({
      run: this.runner,
      now: () => this.opts.clock.now(),
      env: this.env,
      bin: this.bin,
    });

    // SC-POL-035: an unacceptable route is a health state, not a surprise at dispatch.
    const refusal = billingRouteRefusal(assessment, this.allowedBilling);
    const final: EngineStatus =
      refusal !== undefined && status.state === EngineHealthState.READY
        ? {
            ...status,
            state: EngineHealthState.BILLING_ROUTE_REFUSED,
            detail: refusal,
            remedy:
              'Unset the conflicting variable, or configure this project to accept that billing route explicitly. Serva will not choose one for you.',
          }
        : status;

    this.cachedStatus = final;
    this.cachedAt = now;
    return final;
  }

  async capabilities(): Promise<EngineCapabilities> {
    return (await this.health()).capabilities;
  }

  async estimate(request: InvocationRequest): Promise<Estimate> {
    const chars = request.systemPrompt.length + request.prompt.length;
    const caps = await this.capabilities();
    const limit = caps.contextLimit;
    return {
      expectedDurationMs: Math.min(request.budget.maxWallTimeMs, 30_000),
      // 19 §9 / ADR-002 F-7: on a subscription route the provider's figure is a
      // client-side estimate of API-equivalent spend, not the owner's bill.
      costBasis: 'UNKNOWN',
      contextChars: chars,
      withinContextLimit: limit === undefined ? true : chars <= limit,
    };
  }

  async invoke(request: InvocationRequest, signal?: AbortSignal): Promise<InvocationResult> {
    const startedAt = this.opts.clock.now();
    const status = await this.health();

    if (status.state !== EngineHealthState.READY) {
      return this.terminal(request, startedAt, {
        reason:
          status.state === EngineHealthState.UNAUTHENTICATED
            ? TerminationReason.UNAUTHENTICATED
            : status.state === EngineHealthState.BILLING_ROUTE_REFUSED
              ? TerminationReason.ENGINE_ERROR
              : TerminationReason.ENGINE_UNAVAILABLE,
        diagnostics: [status.state, status.detail ?? '', status.remedy ?? ''].filter(
          (s) => s.length > 0,
        ),
      });
    }

    const sessionId = sessionUuidFor(request.runId, digestOf);

    // The composed prompt goes to a file inside the project's own store rather than
    // to the OS temp directory: it carries repository excerpts and the owner's
    // request, and a project's content should not leave the project (21 §8).
    const promptDir = join(request.cwd, '.serva', 'tmp');
    const promptFile = join(promptDir, 'prompt-' + sessionId + '.txt');
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(promptFile, request.systemPrompt, 'utf8');

    const argv = buildArgv(request, {
      supportsTurnLimit: status.capabilities.supportsTurnLimit,
      supportsAmbientConfigIsolation: status.capabilities.supportsAmbientConfigIsolation,
      sessionId,
      systemPromptFile: promptFile,
    });

    try {
      return await this.spawnAndCollect(request, argv, startedAt, signal);
    } finally {
      // Transient by contract. Removed whether the run succeeded, failed or threw, so
      // a crashed run cannot leave project content lying in a scratch file.
      rmSync(promptFile, { force: true });
    }
  }

  private spawnAndCollect(
    request: InvocationRequest,
    argv: readonly string[],
    startedAt: string,
    signal?: AbortSignal,
  ): Promise<InvocationResult> {
    return new Promise<InvocationResult>((resolve) => {
      const parser = new StreamParser();
      const events: StreamEvent[] = [];
      const diagnostics: string[] = [];
      const toolCalls: ObservedToolCall[] = [];
      const toolNameById = new Map<string, string>();
      let stderr = '';
      let settled = false;
      let killedBy: TerminationReason | undefined;
      const began = this.opts.clock.epochMs();

      const child = this.spawnFn(this.bin, [...argv], {
        cwd: request.cwd,
        shell: false, // there is no shell; argv elements are never re-parsed
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.env,
      });

      const finish = (reason: TerminationReason, extra: string[] = []): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        for (const ev of parser.end()) events.push(ev);
        absorb(events, toolCalls, toolNameById, diagnostics, this.opts.clock);
        resolve(
          buildResult(
            request,
            events,
            toolCalls,
            [
              ...diagnostics,
              ...extra,
              ...(stderr.trim().length > 0 ? ['stderr: ' + stderr.trim().slice(0, 2000)] : []),
            ],
            reason,
            startedAt,
            this.opts.clock.now(),
            this.opts.clock.epochMs() - began,
          ),
        );
      };

      const deadline = setTimeout(() => {
        killedBy = TerminationReason.TIMEOUT;
        // SIGTERM first so the child can end its turn; SIGKILL if it will not.
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
      }, request.budget.maxWallTimeMs);

      const onAbort = (): void => {
        killedBy = TerminationReason.INTERRUPTED;
        child.kill('SIGTERM');
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (d: Buffer) => {
        for (const ev of parser.push(d.toString('utf8'))) events.push(ev);
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8');
      });

      child.on('error', (e: Error) => {
        finish(TerminationReason.ENGINE_UNAVAILABLE, ['spawn failed: ' + e.message]);
      });

      child.on('close', (code: number | null) => {
        signal?.removeEventListener('abort', onAbort);
        if (killedBy !== undefined) return finish(killedBy);
        if (code === 0) return finish(TerminationReason.COMPLETED);
        // 143 = SIGTERM.
        if (code === 143) return finish(TerminationReason.INTERRUPTED);

        // A non-zero exit is not automatically anonymous. `--max-turns` exits with an
        // error when the limit is reached, and that is a BUDGET outcome Serva must
        // route on (19 IV-3) rather than a generic engine fault.
        const reason = classifyFailure(events, stderr);
        finish(reason, ['exit code ' + String(code)]);
      });

      // 19 §4: the prompt goes to stdin, never into argv.
      child.stdin?.on('error', () => {
        /* a child that exits early closes stdin; the close handler reports it */
      });
      child.stdin?.end(request.prompt, 'utf8');
    });
  }

  private terminal(
    request: InvocationRequest,
    startedAt: string,
    o: { reason: TerminationReason; diagnostics: string[] },
  ): InvocationResult {
    return {
      runId: request.runId,
      ok: false,
      terminatedBy: o.reason,
      toolCalls: [],
      consumption: {
        invocations: 0,
        turns: 0,
        toolCalls: 0,
        wallTimeMs: 0,
        costBasis: 'UNKNOWN',
      },
      diagnostics: o.diagnostics,
      startedAt,
      endedAt: this.opts.clock.now(),
    };
  }
}

/**
 * Give a non-zero exit the most specific name the stream supports.
 *
 * The provider signals the reason in the terminal `result` message's `subtype` (for
 * example `error_max_turns`) and, for some failures, only on stderr. Reading both
 * keeps a budget exhaustion from being reported as an unexplained engine error, which
 * would send the orchestrator down the wrong route.
 */
function classifyFailure(events: readonly StreamEvent[], stderr: string): TerminationReason {
  const result = [...events].reverse().find((e) => e.kind === 'result');
  const subtype = (result?.subtype ?? '').toLowerCase();
  const text = (stderr + ' ' + subtype).toLowerCase();

  if (subtype.includes('max_turns') || text.includes('max turns')) {
    return TerminationReason.BUDGET_EXCEEDED;
  }
  if (text.includes('rate limit') || text.includes('rate_limit')) {
    return TerminationReason.RATE_LIMITED;
  }
  if (
    text.includes('not authenticated') ||
    text.includes('unauthorized') ||
    text.includes('login')
  ) {
    return TerminationReason.UNAUTHENTICATED;
  }
  if (text.includes('context') && text.includes('too long')) {
    return TerminationReason.CONTEXT_LIMIT;
  }
  if (events.some((e) => e.kind === 'retry' && e.error === 'rate_limit')) {
    return TerminationReason.RATE_LIMITED;
  }
  return TerminationReason.ENGINE_ERROR;
}

function absorb(
  events: readonly StreamEvent[],
  toolCalls: ObservedToolCall[],
  toolNameById: Map<string, string>,
  diagnostics: string[],
  clock: Clock,
): void {
  toolCalls.length = 0;
  toolNameById.clear();
  for (const ev of events) {
    switch (ev.kind) {
      case 'init':
        if (ev.mcpServers.length > 0) {
          // Isolation failure: a governed run must see no MCP server (19 §4, ADR-002 F-4).
          diagnostics.push('ISOLATION: engine reported MCP servers: ' + ev.mcpServers.join(', '));
        }
        break;
      case 'tool_use':
        toolNameById.set(ev.id, ev.name);
        // The provider's own structured-output mechanism surfaces as a tool call. It
        // is not a capability Serva granted, so recording it as one would misreport
        // every structured run as having used a tool -- and would then contradict an
        // agent that truthfully said it used none.
        if (!PROVIDER_INTERNAL_TOOLS.has(ev.name)) {
          toolCalls.push({ tool: ev.name, allowed: true, at: clock.now() });
        }
        break;
      case 'tool_result': {
        if (!ev.isError) break;
        const name = toolNameById.get(ev.forId) ?? 'UNKNOWN';
        // A denial surfaces as an error result. It is recorded as a denied call
        // rather than discarded: 19 TR-2 calls denials diagnostic gold.
        const denied = /permission|denied|not allowed|disallow/i.test(ev.excerpt);
        if (denied)
          toolCalls.push({ tool: name, allowed: false, at: clock.now(), detail: ev.excerpt });
        break;
      }
      case 'retry':
        diagnostics.push('engine retry ' + String(ev.attempt) + ': ' + ev.error);
        break;
      case 'result':
        if (ev.isError) {
          diagnostics.push(
            'engine result error' + (ev.subtype === undefined ? '' : ': ' + ev.subtype),
          );
        }
        break;
      case 'unparseable':
        diagnostics.push('unparseable stream line (' + ev.reason + '): ' + ev.line.slice(0, 200));
        break;
      default:
        break;
    }
  }
}

function buildResult(
  request: InvocationRequest,
  events: readonly StreamEvent[],
  toolCalls: readonly ObservedToolCall[],
  diagnostics: readonly string[],
  reason: TerminationReason,
  startedAt: string,
  endedAt: string,
  wallTimeMs: number,
): InvocationResult {
  const result = [...events].reverse().find((e) => e.kind === 'result');
  const init = events.find((e) => e.kind === 'init');
  const rateLimited = events.some((e) => e.kind === 'retry' && e.error === 'rate_limit');

  let terminatedBy = reason;
  if (reason === TerminationReason.COMPLETED && result?.isError === true) {
    terminatedBy = rateLimited ? TerminationReason.RATE_LIMITED : TerminationReason.ENGINE_ERROR;
  }

  const consumption: Consumption = {
    invocations: 1,
    turns: result?.numTurns ?? 0,
    toolCalls: toolCalls.length,
    wallTimeMs: result?.durationMs ?? wallTimeMs,
    ...(result?.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
    ...(result?.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
    ...(result?.totalCostUsd === undefined ? {} : { costUsd: result.totalCostUsd }),
    costBasis: result?.totalCostUsd === undefined ? 'UNKNOWN' : 'PROVIDER_ESTIMATE',
  };

  const sessionRef = result?.sessionId ?? init?.sessionId;
  return {
    runId: request.runId,
    ok: terminatedBy === TerminationReason.COMPLETED,
    terminatedBy,
    ...(result?.structuredOutput === undefined
      ? {}
      : { structuredOutput: result.structuredOutput }),
    ...(result?.text === undefined ? {} : { text: result.text }),
    toolCalls,
    consumption,
    ...(sessionRef === undefined ? {} : { sessionRef }),
    diagnostics,
    startedAt,
    endedAt,
  };
}

/** Guard used by the runtime: an adapter must never be handed a store. */
export function assertNoStoreHandle(value: object): void {
  if ('store' in value || 'begin' in value) {
    fail({
      code: 'E_ISOLATION',
      message: 'An engine invocation was constructed with a store handle',
      remedy: 'The engine never talks to the store (19 §1). Pass a ContextBundle instead.',
      details: { keys: Object.keys(value).slice(0, 10) },
      specRef: '19 §1',
    });
  }
}
