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

/**
 * 19 §5 — a resolved capability grant. Computed by Serva, never requested by an agent.
 *
 * **Availability and approval are different facts**, and collapsing them was a real
 * defect: a tool can be present in the model's toolset and still be refused at call
 * time by the permission layer. A policy that recorded "allowed" while the provider
 * would have denied the call is a governance record that does not describe reality.
 *
 *   available  the tool exists in the model's toolset at all
 *   approve    rules that PRE-APPROVE matching calls, so they execute without a prompt
 *   deny       rules that REFUSE matching calls; deny outranks approve in every mode
 *   filesystem the concrete paths those rules were derived from
 *
 * `approve` and `deny` hold provider-neutral rule strings in the form
 * `Tool(path-pattern)`; the adapter is responsible for emitting them in whatever
 * syntax its provider accepts.
 */
export interface ToolPolicy {
  /** Tools present in the model's toolset. Empty is valid and means none (19 IV-5). */
  readonly available: readonly string[];
  /** Pre-approval rules. A tool that is available but unapproved will be refused. */
  readonly approve: readonly string[];
  /** Refusal rules, applied on top of everything else. */
  readonly deny: readonly string[];
  readonly filesystem: {
    readonly read: readonly string[];
    readonly write: readonly string[];
    /** Paths inside the read roots that are nonetheless refused (Serva internals). */
    readonly readDenied: readonly string[];
  };
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
  /**
   * A Serva-generated settings file governing the engine's own sandbox for this run.
   *
   * Never inherited from ambient project or user configuration, for the same reason
   * the context bundle is constructed rather than discovered: a policy the repository
   * can influence is a policy the thing being governed can influence.
   */
  readonly settingsPath?: string;
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

/**
 * How far one tool interaction actually got.
 *
 * The states are distinct because collapsing them is how a system starts believing
 * things that did not happen. "The model asked to read a file" and "the file was read"
 * are different facts, and only the second can corroborate a claim about its contents.
 * A run that dies between the two leaves REQUESTED, which is the truth.
 */
export const ToolCallOutcome = {
  /** The model asked. Nothing has happened yet. */
  REQUESTED: 'REQUESTED',
  /** The permission layer permitted it. Still no result. */
  ALLOWED: 'ALLOWED',
  /** The permission layer refused it. There will be no result. */
  DENIED: 'DENIED',
  /** It ran and returned a result. This is the only state that corroborates anything. */
  SUCCEEDED: 'SUCCEEDED',
  /** It ran and returned an error: file not found, bad pattern, timeout. */
  FAILED: 'FAILED',
} as const;
export type ToolCallOutcome = (typeof ToolCallOutcome)[keyof typeof ToolCallOutcome];

/**
 * One observed tool interaction (19 TR-2 — denials are recorded, not discarded).
 *
 * `subject` is what the call was aimed at: the path for a read, the pattern for a
 * search. Evidence corroboration binds on it, because matching by tool NAME alone
 * would let a successful read of one file corroborate a claim about another.
 *
 * Deliberately absent: full tool output. A digest and a bounded excerpt go into the
 * trace; the whole result does not, because T-TRACE is permanent and tool output is
 * unbounded and may carry secrets.
 */
export interface ObservedToolCall {
  readonly tool: string;
  /** Provider-assigned id linking a request to its decision and its result. */
  readonly useId: string;
  readonly outcome: ToolCallOutcome;
  readonly at: string;
  /** The target of the call: a path, a glob, a search pattern. */
  readonly subject?: string;
  /** Digest of the result, so a later claim can be bound to what was actually seen. */
  readonly resultDigest?: string;
  /** Bounded, safe excerpt. Never the whole result. */
  readonly excerpt?: string;
  /** For FAILED and DENIED: the class of failure, not a stack trace. */
  readonly errorClass?: string;
}

/** True only for a call that ran to completion and returned a result. */
export function corroborates(call: ObservedToolCall): boolean {
  return call.outcome === ToolCallOutcome.SUCCEEDED;
}

/**
 * A provider-neutral fact observed while an invocation is still in flight.
 *
 * The four-method adapter interface is unchanged; `invoke` simply accepts an optional
 * sink. This exists because an invocation that dies never returns an
 * `InvocationResult`, and everything the stream had already revealed would die with
 * it. A crashed engine must not mean Serva forgets what it watched happen.
 */
export type EngineObservation =
  | { readonly kind: 'TOOL'; readonly call: ObservedToolCall }
  | { readonly kind: 'SESSION'; readonly sessionRef: string }
  | { readonly kind: 'DIAGNOSTIC'; readonly message: string };

export type EngineObserver = (observation: EngineObservation) => void;

export interface InvokeOptions {
  readonly signal?: AbortSignal;
  /**
   * Called as facts arrive, before the invocation completes. Must not throw: an
   * observer that fails is an observer defect, and it may not take the run down.
   */
  readonly observe?: EngineObserver;
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
  /**
   * Still four methods. `opts.observe` carries provider-neutral facts out as they
   * happen, so an invocation that never returns still leaves a record of what it did.
   */
  invoke(request: InvocationRequest, opts?: InvokeOptions): Promise<InvocationResult>;
}
