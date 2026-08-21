import { AuthenticationKind, BillingMode } from '../vocab/index.js';
import {
  EngineHealthState,
  TerminationReason,
  type EngineAdapter,
  type EngineCapabilities,
  type EngineStatus,
  type Estimate,
  type InvocationRequest,
  type InvocationResult,
  type ObservedToolCall,
} from './types.js';
import type { Clock } from '../core/clock.js';

/**
 * FakeEngineAdapter — a deterministic engine for the automated suite.
 *
 * SPEC: 27 (self-requirements), 19 §1.1.
 *
 * This exists so that **no automated test needs a paid model call**. It implements
 * the same four-method interface as the real adapter, so a test that passes here is
 * testing Serva's governance rather than Claude's behaviour — which is the correct
 * split, because Serva's job is to be right about an engine it does not trust.
 *
 * Scripted responses are matched by agent id, so one fake can serve a whole
 * orchestration flow. Anything unscripted is a loud failure rather than a plausible
 * default: a test that silently got a stub answer proves nothing.
 */

export interface FakeResponse {
  readonly structuredOutput?: unknown;
  readonly text?: string;
  readonly terminatedBy?: TerminationReason;
  readonly toolCalls?: readonly ObservedToolCall[];
  readonly diagnostics?: readonly string[];
  readonly turns?: number;
  readonly wallTimeMs?: number;
  readonly costUsd?: number;
  /** Delay before resolving, so timeout handling can be exercised deterministically. */
  readonly delayMs?: number;
}

export interface FakeEngineOptions {
  readonly clock: Clock;
  readonly status?: Partial<EngineStatus>;
  readonly capabilities?: Partial<EngineCapabilities>;
}

export const FAKE_CAPABILITIES: EngineCapabilities = Object.freeze({
  provider: 'fake',
  transport: 'in-process',
  version: '1.0.0',
  supportsTools: true,
  supportsStructuredOutput: true,
  supportsSessionContinuation: false,
  supportsToolRestriction: true,
  supportsNonInteractivePermissions: true,
  supportsStreaming: false,
  supportsAmbientConfigIsolation: true,
  supportsTurnLimit: true,
  models: ['fake-model'],
  declared: [],
});

export class FakeEngineAdapter implements EngineAdapter {
  readonly id = 'fake';
  /** Every request this adapter was asked to run, in order. Tests assert on it. */
  readonly seen: InvocationRequest[] = [];
  private readonly byAgent = new Map<string, FakeResponse[]>();
  private fallback: FakeResponse | undefined;

  constructor(private readonly opts: FakeEngineOptions) {}

  /** Queue a response for one agent. Repeated calls queue in order (for retry tests). */
  script(agentId: string, response: FakeResponse): this {
    const q = this.byAgent.get(agentId) ?? [];
    q.push(response);
    this.byAgent.set(agentId, q);
    return this;
  }

  /** Answer anything unscripted. Use sparingly; the default is to fail loudly. */
  scriptDefault(response: FakeResponse): this {
    this.fallback = response;
    return this;
  }

  async health(): Promise<EngineStatus> {
    return {
      state: EngineHealthState.READY,
      provider: 'fake',
      transport: 'in-process',
      version: '1.0.0',
      authenticated: true,
      authenticationKind: AuthenticationKind.SUBSCRIPTION_OAUTH,
      billingMode: BillingMode.SUBSCRIPTION,
      capabilities: { ...FAKE_CAPABILITIES, ...this.opts.capabilities },
      checkedAt: this.opts.clock.now(),
      ...this.opts.status,
    };
  }

  async capabilities(): Promise<EngineCapabilities> {
    return { ...FAKE_CAPABILITIES, ...this.opts.capabilities };
  }

  async estimate(request: InvocationRequest): Promise<Estimate> {
    const chars = request.systemPrompt.length + request.prompt.length;
    return {
      expectedDurationMs: 1,
      costBasis: 'UNKNOWN',
      contextChars: chars,
      withinContextLimit: chars <= request.budget.maxContextChars,
    };
  }

  async invoke(request: InvocationRequest, signal?: AbortSignal): Promise<InvocationResult> {
    this.seen.push(request);
    const startedAt = this.opts.clock.now();
    const queued = this.byAgent.get(request.agentId);
    const response = (queued !== undefined && queued.length > 0 ? queued.shift() : undefined) ??
      this.fallback ?? {
        terminatedBy: TerminationReason.ENGINE_ERROR,
        diagnostics: [
          'FakeEngineAdapter has no scripted response for ' +
            request.agentId +
            '. A test that reaches an unscripted agent is asserting nothing; script it explicitly.',
        ],
      };

    if (response.delayMs !== undefined && response.delayMs > 0) {
      const aborted = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), response.delayMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve(true);
          },
          { once: true },
        );
      });
      if (aborted) {
        return {
          runId: request.runId,
          ok: false,
          terminatedBy: TerminationReason.INTERRUPTED,
          toolCalls: [],
          consumption: {
            invocations: 1,
            turns: 0,
            toolCalls: 0,
            wallTimeMs: response.delayMs,
            costBasis: 'UNKNOWN',
          },
          diagnostics: ['interrupted before completion'],
          startedAt,
          endedAt: this.opts.clock.now(),
        };
      }
    }

    const terminatedBy = response.terminatedBy ?? TerminationReason.COMPLETED;
    const toolCalls = response.toolCalls ?? [];
    return {
      runId: request.runId,
      ok: terminatedBy === TerminationReason.COMPLETED,
      terminatedBy,
      ...(response.structuredOutput === undefined
        ? {}
        : { structuredOutput: response.structuredOutput }),
      ...(response.text === undefined ? {} : { text: response.text }),
      toolCalls,
      consumption: {
        invocations: 1,
        turns: response.turns ?? 1,
        toolCalls: toolCalls.length,
        wallTimeMs: response.wallTimeMs ?? 1,
        ...(response.costUsd === undefined ? {} : { costUsd: response.costUsd }),
        costBasis: response.costUsd === undefined ? 'UNKNOWN' : 'PROVIDER_ESTIMATE',
      },
      sessionRef: 'fake-session-' + request.runId,
      diagnostics: response.diagnostics ?? [],
      startedAt,
      endedAt: this.opts.clock.now(),
    };
  }
}
