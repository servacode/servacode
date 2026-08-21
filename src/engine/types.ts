import type { AuthenticationKind, BillingMode, TrustLevel } from '../vocab/index.js';

/**
 * The engine boundary. SPEC: 19 §1.1.
 *
 * Everything Serva knows about an AI engine is in this file. Provider-specific
 * code — flag names, stream shapes, exit codes, auth parsing — lives behind an
 * implementation of `EngineAdapter` and is imported by nothing else. That is what
 * makes "changing engines is a Technology Decision, not a rewrite" true rather
 * than aspirational, and it is enforced by an automated boundary test.
 *
 * The engine never receives a store handle, and nothing here can reach one.
 */

/** 19 §1.1 — what a given engine can actually do, discovered rather than assumed. */
export interface EngineCapabilities {
  readonly provider: string;
  readonly transport: string;
  readonly version: string;
  readonly supportsTools: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsSessionContinuation: boolean;
  readonly supportsToolRestriction: boolean;
  readonly supportsNonInteractivePermissions: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsAmbientConfigIsolation: boolean;
  readonly supportsTurnLimit: boolean;
  readonly contextLimit?: number;
  readonly models: readonly string[];
  /** Provider-declared capability tokens, passed through unmodified. */
  readonly declared: readonly string[];
}

export const EngineHealthState = {
  READY: 'READY',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  UNAVAILABLE: 'UNAVAILABLE',
  BILLING_ROUTE_REFUSED: 'BILLING_ROUTE_REFUSED',
  DEGRADED: 'DEGRADED',
} as const;
export type EngineHealthState = (typeof EngineHealthState)[keyof typeof EngineHealthState];

/**
 * 33 §5 / SC-POL-035 — the owner-visible engine status.
 *
 * Deliberately carries no identity and no credential: not the account email, not an
 * organisation id, not a token, not a key prefix. The probe reads more than this from
 * the provider and discards the rest.
 */
export interface EngineStatus {
  readonly state: EngineHealthState;
  readonly provider: string;
  readonly transport: string;
  readonly version: string;
  readonly authenticated: boolean;
  readonly authenticationKind: AuthenticationKind;
  readonly billingMode: BillingMode;
  readonly capabilities: EngineCapabilities;
  readonly checkedAt: string;
  /** Present when the state is not READY. Never contains a secret. */
  readonly detail?: string;
  readonly remedy?: string;
}

/** 19 §5 — a resolved capability grant. Computed by Serva, never requested by an agent. */
export interface ToolPolicy {
  /** Tools the engine may call. Empty is valid and means "no tools" (19 IV-5). */
  readonly allow: readonly string[];
  /** Explicit denials, applied in addition to the allowlist. */
  readonly deny: readonly string[];
  readonly filesystem: { readonly read: readonly string[]; readonly write: readonly string[] };
  readonly network: 'NONE' | { readonly hosts: readonly string[] };
  readonly maxToolCalls: number;
  /** Why this policy is what it is, for the audit trail and for the owner. */
  readonly rationale: readonly string[];
}

/** 05 §5 / 19 §4 — one element of a context bundle, with its provenance. */
export interface ContextElement {
  readonly id: string;
  readonly source: string;
  readonly kind: string;
  readonly trust: TrustLevel;
  readonly version: string;
  readonly digest: string;
  readonly content: string;
  readonly reasonIncluded: string;
  /** Relevance rank; lower is dropped first under budget pressure (19 CX-7). */
  readonly relevance: number;
}

export interface ContextExclusion {
  readonly subject: string;
  readonly reason: string;
  readonly kind: 'BUDGET' | 'RELEVANCE' | 'ROLE_RESTRICTION' | 'POLICY';
}

export interface ContextBundle {
  readonly id: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly workItemId: string;
  readonly elements: readonly ContextElement[];
  readonly exclusions: readonly ContextExclusion[];
  readonly storeVersion: number;
  readonly budget: { readonly maxChars: number; readonly usedChars: number };
  readonly builtAt: string;
  readonly digest: string;
}

/** 19 §2 — the request. Note what is absent: any store handle, any credential. */
export interface InvocationRequest {
  readonly runId: string;
  readonly agentId: string;
  readonly contractVersion: string;
  /** The composed system prompt: authority, contract, task, trusted, untrusted. */
  readonly systemPrompt: string;
  /** The user-role message. Untrusted content is delimited, never merged. */
  readonly prompt: string;
  readonly outputSchema: Record<string, unknown>;
  readonly tools: ToolPolicy;
  readonly sessionPolicy: 'NEW' | { readonly continue: string };
  readonly budget: RunBudget;
  readonly cwd: string;
  readonly determinismHint?: 'LOW_VARIANCE' | 'DEFAULT';
  readonly model?: string;
}

/** 19 §2 / 18 CC-1 — enforced by the runtime, never by the engine (19 IV-3). */
export interface RunBudget {
  readonly maxWallTimeMs: number;
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxContextChars: number;
  readonly maxRetries: number;
}

export const TerminationReason = {
  COMPLETED: 'COMPLETED',
  TIMEOUT: 'TIMEOUT',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  ENGINE_ERROR: 'ENGINE_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  ENGINE_UNAVAILABLE: 'ENGINE_UNAVAILABLE',
  INVALID_OUTPUT: 'INVALID_OUTPUT',
  INTERRUPTED: 'INTERRUPTED',
  RATE_LIMITED: 'RATE_LIMITED',
  CONTEXT_LIMIT: 'CONTEXT_LIMIT',
} as const;
export type TerminationReason = (typeof TerminationReason)[keyof typeof TerminationReason];

/** One observed tool interaction. `allowed: false` is as important as `true` (19 TR-2). */
export interface ObservedToolCall {
  readonly tool: string;
  readonly allowed: boolean;
  readonly at: string;
  readonly detail?: string;
}

/**
 * What an invocation consumed.
 *
 * `costUsd` is deliberately optional and `costBasis` says what it means. On a
 * subscription route the provider's figure is a client-side estimate of API-equivalent
 * spend, not the owner's bill, and reporting it as a cost would be a small lie that
 * compounds (SC-POL-028, 19 §9).
 */
export interface Consumption {
  readonly invocations: number;
  readonly turns: number;
  readonly toolCalls: number;
  readonly wallTimeMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly costBasis: 'PROVIDER_ESTIMATE' | 'UNKNOWN';
}

export interface InvocationResult {
  readonly runId: string;
  readonly ok: boolean;
  readonly terminatedBy: TerminationReason;
  /** The parsed structured output, if the engine produced one. Never trusted yet. */
  readonly structuredOutput?: unknown;
  /** Free text the engine returned. Recorded, never parsed into state (19 SO-3). */
  readonly text?: string;
  readonly toolCalls: readonly ObservedToolCall[];
  readonly consumption: Consumption;
  /** Opaque, diagnostic only. Not authoritative for anything (19 SM-4). */
  readonly sessionRef?: string;
  readonly diagnostics: readonly string[];
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface Estimate {
  readonly expectedDurationMs: number;
  readonly expectedCostUsd?: number;
  readonly costBasis: 'PROVIDER_ESTIMATE' | 'UNKNOWN';
  readonly contextChars: number;
  readonly withinContextLimit: boolean;
}

/**
 * 19 §1.1 — the entire contract between Serva and any AI engine.
 *
 * Four methods, no more. An engine that needs a fifth is telling you the boundary is
 * in the wrong place.
 */
export interface EngineAdapter {
  readonly id: string;
  health(): Promise<EngineStatus>;
  capabilities(): Promise<EngineCapabilities>;
  estimate(request: InvocationRequest): Promise<Estimate>;
  invoke(request: InvocationRequest, signal?: AbortSignal): Promise<InvocationResult>;
}
