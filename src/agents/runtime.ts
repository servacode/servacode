import { EnvelopeStatus, RunOutcome } from '../vocab/index.js';
import { fail, isServaError } from '../core/errors.js';
import {
  AgentRunEventType,
  appendRunEvent,
  emitTerminalSnapshot,
  projectAgentRun,
} from '../events/agentRun.js';
import { AuditAction, audit } from '../events/audit.js';
import { buildStandardBundle, CONTEXT_BUDGET_CHARS } from '../context/bundle.js';
import { persistContextBundle } from '../context/store.js';
import { composeSystemPrompt, composeUserPrompt } from '../context/prompt.js';
import {
  OutputEnvelopeSchema,
  envelopeJsonSchema,
  hasFabricatedClaim,
  verifyEvidenceClaims,
  type ClaimAssessment,
  type OutputEnvelope,
} from './envelope.js';
import { assertPolicyNotWidened, resolveToolPolicy } from './toolPolicy.js';
import {
  TerminationReason,
  ToolCallOutcome,
  type EngineAdapter,
  type EngineObservation,
  type InvocationRequest,
  type ObservedToolCall,
  type RunBudget,
} from '../engine/types.js';
import type { ContractRegistry } from './registry.js';
import type { ContextBundle } from '../engine/types.js';
import type { Store, Transaction } from '../store/store.js';
import type { Clock } from '../core/clock.js';
import type { IdSource } from '../core/ids.js';

/**
 * AgentRuntime — one governed AI invocation, start to finish.
 *
 * SPEC: 19 §2, 05 §4 (event-sourced run), 04 §7.1 (collection checks).
 *
 * The order of operations is the design:
 *
 *   validate contract -> CREATE RUN -> bind context -> bind capability ->
 *   invoke engine -> capture -> validate output -> verify claims -> finalize
 *
 * `RUN_CREATED` is appended BEFORE the engine is touched (05 RI-1), so a crash during
 * invocation leaves a run with no terminal event: detectable, not silent. Everything
 * after invocation is Serva deciding what to believe. The engine's result is an input
 * to that decision and never the decision itself.
 *
 * The engine is never given a store handle. It receives a ContextBundle rendered to
 * text, and it returns a JSON object. That is the entire channel.
 */

export interface AgentRuntimeDeps {
  readonly store: Store;
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly registry: ContractRegistry;
  readonly engine: EngineAdapter;
  readonly enabledAgents: ReadonlySet<string>;
  readonly projectRoot: string;
}

export interface AgentRunRequest {
  readonly agentId: string;
  readonly workItemId: string;
  readonly taskId?: string;
  readonly taskDefinition: string;
  readonly scopeBoundary: string;
  readonly ownerRequest?: string;
  /**
   * The role-specific result shape, in TWO forms, and both are required.
   *
   *   resultSchema     JSON Schema, sent to the provider so it can shape its output
   *   resultValidator  Serva's OWN validator, applied to whatever comes back
   *
   * "The provider says it is valid" and "Serva accepts it" are different claims
   * (19 SO-2). Validating only the envelope left `result` as `unknown`, so a
   * structurally perfect envelope carrying a nonsense payload reached COMPLETED and
   * the orchestrator had to catch it later. AgentRuntime must be correct by itself.
   */
  readonly resultSchema: Record<string, unknown>;
  readonly resultValidator: ResultValidator;
  readonly canon?: readonly {
    source: string;
    kind: string;
    version: string;
    content: string;
    relevance: number;
  }[];
  readonly workspace?: readonly {
    source: string;
    version: string;
    content: string;
    relevance: number;
  }[];
  readonly budget?: Partial<RunBudget>;
  readonly maxContextChars?: number;
}

/**
 * A deterministic local check of the role-specific payload.
 *
 * A Zod schema satisfies this shape directly, so callers normally pass one; anything
 * with `safeParse` works. Deliberately not "parse the prose": the input is already a
 * structured object, and this decides whether Serva believes it is the right one.
 */
export interface ResultValidator {
  safeParse(value: unknown): { success: true } | { success: false; error: { issues: unknown[] } };
}

/** Render a validator's complaint into one actionable line for the repair attempt. */
export function describeResultIssues(error: { issues: unknown[] }): string {
  return error.issues
    .slice(0, 8)
    .map((raw) => {
      const i = raw as { path?: unknown[]; message?: string };
      const path = Array.isArray(i.path) && i.path.length > 0 ? i.path.join('.') : '(root)';
      return path + ': ' + (i.message ?? 'invalid');
    })
    .join('; ');
}

export interface AgentRunResult {
  readonly runId: string;
  readonly outcome: RunOutcome;
  readonly bundle: ContextBundle;
  readonly envelope?: OutputEnvelope;
  readonly claimAssessments: readonly ClaimAssessment[];
  readonly attempts: number;
  readonly diagnostics: readonly string[];
  readonly sessionRef?: string;
}

export const DEFAULT_BUDGET: RunBudget = Object.freeze({
  maxWallTimeMs: 180_000,
  maxTurns: 12,
  maxToolCalls: 40,
  maxContextChars: 80_000,
  maxRetries: 1, // 19 SO-2: exactly one repair attempt, then INVALID_OUTPUT
});

export class AgentRuntime {
  constructor(private readonly deps: AgentRuntimeDeps) {}

  /**
   * Run one agent.
   *
   * Never throws for an engine or agent failure: those are outcomes the orchestrator
   * must route on (05 §7). It throws only for a Serva-side programming or capability
   * error, where continuing would mean pretending a governed run happened.
   */
  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    const contract = this.deps.registry.get(req.agentId);
    const taskId = req.taskId ?? this.deps.ids.next('SC-TASK');
    const budget: RunBudget = {
      ...DEFAULT_BUDGET,
      maxContextChars:
        req.maxContextChars ??
        CONTEXT_BUDGET_CHARS[contract.contextBudget] ??
        DEFAULT_BUDGET.maxContextChars,
      ...req.budget,
    };

    // Capability resolution happens BEFORE the run record exists: an agent that may
    // not run at all should not leave a run behind claiming it was attempted.
    const policy = resolveToolPolicy(contract, {
      enabled: this.deps.enabledAgents,
      projectRoot: this.deps.projectRoot,
    });

    const runId = this.deps.ids.next('SC-RUN');

    // 05 RI-1 — the run exists before the engine is touched.
    this.tx((tx) => {
      appendRunEvent(tx, runId, {
        type: AgentRunEventType.RUN_CREATED,
        payload: {
          taskId,
          workItemId: req.workItemId,
          agentId: contract.id,
          contractVersion: contract.version,
          roleInTask: contract.archetype,
          scopeDeclared: [req.scopeBoundary],
          budget,
        },
      });
    });

    let bundle: ContextBundle;
    try {
      bundle = buildStandardBundle(
        { ids: this.deps.ids, clock: this.deps.clock, store: this.deps.store },
        {
          contract,
          taskId,
          workItemId: req.workItemId,
          taskDefinition: req.taskDefinition,
          scopeBoundary: req.scopeBoundary,
          ...(req.ownerRequest === undefined ? {} : { ownerRequest: req.ownerRequest }),
          ...(req.canon === undefined ? {} : { canon: req.canon }),
          ...(req.workspace === undefined ? {} : { workspace: req.workspace }),
          maxChars: budget.maxContextChars,
        },
      );
    } catch (e) {
      // 19 CX-8: the run is terminated rather than dispatched with a known gap.
      const detail = isServaError(e) ? e.message : String(e);
      return this.terminate(runId, RunOutcome.BLOCKED, [detail], {
        bundle: undefined,
        attempts: 0,
      });
    }

    this.tx((tx) => {
      /*
       * 19 CX-5 — persisted BEFORE invocation, so a run that dies mid-flight still
       * leaves behind exactly what it was given. The event below records the reference
       * and the digest; the bundle itself is the thing that makes "what did this run
       * see?" answerable, and counts alone never did.
       */
      persistContextBundle(tx, bundle);
      appendRunEvent(tx, runId, {
        type: AgentRunEventType.CONTEXT_BOUND,
        payload: {
          contextBundleRef: bundle.id,
          storeVersion: bundle.storeVersion,
          digest: bundle.digest,
          elements: bundle.elements.length,
          untrusted: bundle.elements.filter((e) => e.trust === 'UNTRUSTED').length,
          exclusions: bundle.exclusions.length,
          usedChars: bundle.budget.usedChars,
        },
      });
      // The capability grant is authoritative state: "what could run X do?" must be
      // answerable from the log, exactly as "what did run X see?" is (19 CX-5).
      appendRunEvent(tx, runId, {
        type: AgentRunEventType.CAPABILITY_BOUND,
        payload: {
          available: policy.available,
          approve: policy.approve,
          deny: policy.deny,
          filesystem: policy.filesystem,
          network: policy.network,
          maxToolCalls: policy.maxToolCalls,
          rationale: policy.rationale,
        },
      });
    });

    const request: InvocationRequest = {
      runId,
      agentId: contract.id,
      contractVersion: contract.version,
      systemPrompt: composeSystemPrompt(contract, bundle),
      prompt: composeUserPrompt(bundle),
      outputSchema: envelopeJsonSchema(req.resultSchema),
      tools: policy,
      sessionPolicy: 'NEW', // 19 SM-3: never reused across work items, tasks or days
      budget,
      cwd: this.deps.projectRoot,
      determinismHint: 'LOW_VARIANCE',
    };

    return this.invokeWithRepair(runId, bundle, request, policy, budget, req.resultValidator);
  }

  private async invokeWithRepair(
    runId: string,
    bundle: ContextBundle,
    baseRequest: InvocationRequest,
    policy: InvocationRequest['tools'],
    budget: RunBudget,
    resultValidator: ResultValidator,
  ): Promise<AgentRunResult> {
    const diagnostics: string[] = [];
    let attempts = 0;
    let validationError: string | undefined;
    let sessionRef: string | undefined;

    // 19 SO-2: one retry with the validation error, then INVALID_OUTPUT. The loop is
    // bounded by maxRetries and cannot become an open-ended repair conversation.
    while (attempts <= budget.maxRetries) {
      attempts += 1;

      const request: InvocationRequest =
        validationError === undefined
          ? baseRequest
          : {
              ...baseRequest,
              // A repair attempt is a NEW session with the error appended to the task.
              // It is not a continuation: the engine does not get to remember its own
              // rejected answer (19 SM-2).
              prompt:
                baseRequest.prompt +
                '\n\nYour previous response was rejected by Serva schema validation:\n' +
                validationError +
                '\nReturn a corrected object. Do not explain the correction.',
            };

      // The policy handed over must be the one Serva computed (SC-POL-026).
      assertPolicyNotWidened(policy, request.tools);

      this.tx((tx) => {
        appendRunEvent(tx, runId, {
          type: AgentRunEventType.RUN_STARTED,
          payload: { attempt: attempts, engine: this.deps.engine.id, sessionPolicy: 'NEW' },
        });
      });

      /*
       * Tool facts are written to T-TRACE AS THEY HAPPEN, not after invoke() returns.
       *
       * An invocation that is killed never returns an InvocationResult, and recording
       * from the result meant a run that died after reading three files remembered
       * none of them. The engine hands facts out through a provider-neutral observer,
       * and each one is appended immediately.
       */
      const recorded = new Map<string, ToolCallOutcome>();
      /** Latest known state of each call, by useId. The result may refine what streamed. */
      const observedByUseId = new Map<string, ObservedToolCall>();
      const observe = (o: EngineObservation): void => {
        if (o.kind === 'DIAGNOSTIC') {
          diagnostics.push(o.message);
          return;
        }
        if (o.kind === 'SESSION') {
          sessionRef = o.sessionRef;
          return;
        }
        observedByUseId.set(o.call.useId, o.call);
        this.recordToolFact(runId, o.call, recorded);
      };

      const result = await this.deps.engine.invoke(request, { observe });
      sessionRef = result.sessionRef ?? sessionRef;
      for (const d of result.diagnostics) {
        if (!diagnostics.includes(d)) diagnostics.push(d);
      }

      // Anything the observer missed -- an adapter that does not stream at all -- is
      // caught here, so the trace is complete either way. `recorded` makes the second
      // pass idempotent: a fact already written is not written twice.
      for (const call of result.toolCalls) {
        observedByUseId.set(call.useId, call);
        this.recordToolFact(runId, call, recorded);
      }
      const observedCalls = [...observedByUseId.values()];

      this.tx((tx) => {
        appendRunEvent(tx, runId, {
          type: AgentRunEventType.CONSUMPTION_SAMPLED,
          payload: {
            ...result.consumption,
            ...(result.sessionRef === undefined ? {} : { sessionRef: result.sessionRef }),
          },
        });
      });

      if (!result.ok) {
        const mapped = outcomeForTermination(result.terminatedBy);
        return this.terminate(
          runId,
          mapped.outcome,
          [...diagnostics, 'terminated: ' + result.terminatedBy],
          {
            bundle,
            attempts,
            terminalEvent: mapped.event,
            ...(sessionRef === undefined ? {} : { sessionRef }),
          },
        );
      }

      this.tx((tx) => {
        appendRunEvent(tx, runId, {
          type: AgentRunEventType.OUTPUT_RECEIVED,
          payload: {
            hasStructuredOutput: result.structuredOutput !== undefined,
            textLength: (result.text ?? '').length,
          },
        });
      });

      // 19 SO-3 — prose is never parsed into state. If the engine returned no
      // structured object, that is an invalid output, not something to salvage.
      const parsed =
        result.structuredOutput === undefined
          ? { success: false as const, message: 'no structured output was returned' }
          : validateEnvelope(result.structuredOutput);

      if (!parsed.success) {
        validationError = parsed.message;
        this.tx((tx) => {
          appendRunEvent(tx, runId, {
            type: AgentRunEventType.VALIDATION_RESULT,
            payload: { valid: false, attempt: attempts, stage: 'ENVELOPE', error: parsed.message },
          });
        });
        diagnostics.push('attempt ' + String(attempts) + ' invalid: ' + parsed.message);
        continue;
      }

      const envelope = parsed.value;

      /*
       * BLOCKER 4. The envelope being well-formed says nothing about `result`, which
       * the envelope schema types as `unknown`. Serva validates the role-specific
       * payload with its OWN validator before it will call the run valid -- the
       * provider having accepted its own JSON Schema is not Serva accepting it.
       */
      const roleResult = resultValidator.safeParse(envelope.result);
      if (!roleResult.success) {
        const message =
          'role-specific result did not validate: ' + describeResultIssues(roleResult.error);
        validationError = message;
        this.tx((tx) => {
          appendRunEvent(tx, runId, {
            type: AgentRunEventType.VALIDATION_RESULT,
            payload: { valid: false, attempt: attempts, stage: 'RESULT', error: message },
          });
        });
        diagnostics.push('attempt ' + String(attempts) + ' invalid: ' + message);
        continue;
      }

      this.tx((tx) => {
        appendRunEvent(tx, runId, {
          type: AgentRunEventType.VALIDATION_RESULT,
          payload: {
            valid: true,
            attempt: attempts,
            stage: 'ENVELOPE+RESULT',
            status: envelope.status,
          },
        });
      });

      // 19 SO-5 / 04 §7.1 check 4 — claims are compared against observation.
      // Both lists: a name Serva GRANTED and a name Serva DENIED are equally real
      // tool identifiers, and a claim to have used a denied one is exactly the
      // fabrication this check exists for. Only a name in neither list is prose.
      // Both lists: a name Serva made AVAILABLE and a name Serva DENIED are equally
      // real tool identifiers, and a claim to have used a denied one is exactly the
      // fabrication this check exists for. Only a name in neither list is prose.
      const assessments = verifyEvidenceClaims(envelope.evidenceClaims, observedCalls, [
        ...policy.available,
        ...policy.deny,
      ]);
      this.tx((tx) => {
        for (const a of assessments) {
          appendRunEvent(tx, runId, {
            type: AgentRunEventType.EVIDENCE_CAPTURED,
            payload: {
              claim: a.claim.statement,
              kind: a.claim.kind,
              verification: a.verification,
              reason: a.reason,
            },
          });
        }
        appendRunEvent(tx, runId, {
          type: AgentRunEventType.SCOPE_COMPUTED,
          payload: {
            // Phase 3 agents cannot write, so the observed scope is empty by
            // construction. It is recorded rather than assumed (05 §4.2).
            scopeActual: [],
            basis: 'no write capability was granted to this run',
          },
        });
      });

      if (hasFabricatedClaim(assessments)) {
        const bad = assessments
          .filter((a) => a.verification === 'CONTRADICTED')
          .map((a) => a.claim.statement + ' (' + a.reason + ')');
        return this.terminate(
          runId,
          RunOutcome.EVIDENCE_VIOLATION,
          [...diagnostics, 'contradicted evidence claims: ' + bad.join('; ')],
          {
            bundle,
            envelope,
            claimAssessments: assessments,
            attempts,
            ...(sessionRef === undefined ? {} : { sessionRef }),
          },
        );
      }

      return this.terminate(runId, outcomeForEnvelope(envelope.status), diagnostics, {
        bundle,
        envelope,
        claimAssessments: assessments,
        attempts,
        ...(sessionRef === undefined ? {} : { sessionRef }),
      });
    }

    return this.terminate(
      runId,
      RunOutcome.INVALID_OUTPUT,
      [...diagnostics, 'output failed validation after ' + String(attempts) + ' attempt(s)'],
      { bundle, attempts, ...(sessionRef === undefined ? {} : { sessionRef }) },
    );
  }

  /**
   * Append the single terminal event and return the run result.
   *
   * The terminal EVENT type and the RunOutcome are separate axes on purpose. 31 V4
   * defines nine outcomes and none of them is TIMEOUT, ABORTED or BUDGET_EXCEEDED --
   * 05 §7 folds all three into FAILED ("execution error (engine, tool, timeout)").
   * 05 §4.2 does have RUN_TIMEOUT and RUN_ABORTED as distinct terminal events, so the
   * cause survives in the log without inventing a tenth outcome value.
   */
  private terminate(
    runId: string,
    outcome: RunOutcome,
    diagnostics: readonly string[],
    extra: {
      bundle: ContextBundle | undefined;
      envelope?: OutputEnvelope;
      claimAssessments?: readonly ClaimAssessment[];
      attempts: number;
      sessionRef?: string;
      terminalEvent?: AgentRunEventType;
    },
  ): AgentRunResult {
    const terminalType = extra.terminalEvent ?? AgentRunEventType.RUN_TERMINATED;

    const projection = projectAgentRun(this.deps.store, runId);
    if (projection.terminal) {
      // Already finalized. A second attempt -- a retry after a crash, a double call --
      // must not append a second terminal event or a second snapshot: the log is
      // append-only, so a conflicting terminal fact could never be withdrawn.
      return this.assemble(runId, projection.outcome ?? outcome, diagnostics, extra);
    }

    this.tx((tx) => {
      appendRunEvent(tx, runId, {
        type: terminalType,
        payload: {
          outcome,
          diagnostics: diagnostics.slice(0, 20),
          ...(extra.sessionRef === undefined ? {} : { sessionRef: extra.sessionRef }),
        },
      });
      audit(tx, {
        action: AuditAction.AGENT_RUN_TERMINATED,
        subject: runId,
        outcome: outcome === RunOutcome.COMPLETED ? 'OK' : 'REFUSED',
        detail: { outcome, attempts: extra.attempts },
      });
    });

    /*
     * 05 §4.3 -- the immutable terminal snapshot, emitted once, bound to the final
     * digest of the event chain it summarises. Phase 2 built this and Phase 3 was
     * appending the terminal EVENT without ever emitting the RECORD, so every governed
     * AI run ended without the artifact the model exists to produce.
     *
     * It is emitted after the terminal event so `event_log_digest` covers that event
     * too; a summary that did not include its own terminator could drift from the log.
     */
    this.tx((tx) => {
      emitTerminalSnapshot(tx, this.deps.store, runId, {
        ...(extra.envelope === undefined
          ? {}
          : {
              selfReview: extra.envelope.selfReview,
              observations: extra.envelope.observations,
              escalations: extra.envelope.escalations,
            }),
        ...(extra.sessionRef === undefined ? {} : { engineSessionRef: extra.sessionRef }),
        claimAssessments: (extra.claimAssessments ?? []).map((a) => ({
          kind: a.claim.kind,
          statement: a.claim.statement,
          verification: a.verification,
        })),
        attempts: extra.attempts,
      });
    });

    return this.assemble(runId, outcome, diagnostics, extra);
  }

  private assemble(
    runId: string,
    outcome: RunOutcome,
    diagnostics: readonly string[],
    extra: {
      bundle: ContextBundle | undefined;
      envelope?: OutputEnvelope;
      claimAssessments?: readonly ClaimAssessment[];
      attempts: number;
      sessionRef?: string;
    },
  ): AgentRunResult {
    return {
      runId,
      outcome,
      bundle: extra.bundle ?? emptyBundle(runId),
      ...(extra.envelope === undefined ? {} : { envelope: extra.envelope }),
      claimAssessments: extra.claimAssessments ?? [],
      attempts: extra.attempts,
      diagnostics,
      ...(extra.sessionRef === undefined ? {} : { sessionRef: extra.sessionRef }),
    };
  }

  /** Read the authoritative projection of a run from its event log. */
  projection(runId: string): ReturnType<typeof projectAgentRun> {
    return projectAgentRun(this.deps.store, runId);
  }

  /**
   * Append the trace events for one observed tool fact, exactly once per state.
   *
   * The provider reports the same call twice -- once when it is issued, once when it
   * returns -- so the recorder tracks what it has already written per `useId`. That
   * makes it safe to call from the live observer AND from the post-hoc sweep without
   * duplicating history in an append-only log.
   *
   * The three canonical events (05 §4.2) map to the three real transitions:
   *   TOOL_REQUESTED       the model asked
   *   TOOL_DECIDED         the permission layer ruled
   *   TOOL_RESULT_CAPTURED a result came back, or an error did
   */
  private recordToolFact(
    runId: string,
    call: ObservedToolCall,
    recorded: Map<string, ToolCallOutcome>,
  ): void {
    const already = recorded.get(call.useId);
    if (already === call.outcome) return;

    this.tx((tx) => {
      if (already === undefined) {
        appendRunEvent(tx, runId, {
          type: AgentRunEventType.TOOL_REQUESTED,
          payload: {
            tool: call.tool,
            useId: call.useId,
            at: call.at,
            ...(call.subject === undefined ? {} : { subject: call.subject }),
          },
        });
        appendRunEvent(tx, runId, {
          type: AgentRunEventType.TOOL_DECIDED,
          payload: {
            tool: call.tool,
            useId: call.useId,
            allowed: call.outcome !== ToolCallOutcome.DENIED,
            outcome: call.outcome,
            at: call.at,
          },
        });
      }

      // A result, success or failure, is a separate fact from the decision to allow.
      if (
        call.outcome === ToolCallOutcome.SUCCEEDED ||
        call.outcome === ToolCallOutcome.FAILED ||
        call.outcome === ToolCallOutcome.DENIED
      ) {
        appendRunEvent(tx, runId, {
          type: AgentRunEventType.TOOL_RESULT_CAPTURED,
          payload: {
            tool: call.tool,
            useId: call.useId,
            outcome: call.outcome,
            at: call.at,
            ...(call.subject === undefined ? {} : { subject: call.subject }),
            // A digest and a bounded excerpt, never the whole result: T-TRACE is
            // permanent, and tool output is unbounded and may carry secrets.
            ...(call.resultDigest === undefined ? {} : { resultDigest: call.resultDigest }),
            ...(call.excerpt === undefined ? {} : { excerpt: call.excerpt.slice(0, 240) }),
            ...(call.errorClass === undefined ? {} : { errorClass: call.errorClass }),
          },
        });
      }
    });

    recorded.set(call.useId, call.outcome);
  }

  private tx(f: (tx: Transaction) => void): void {
    const tx = this.deps.store.begin();
    f(tx);
    tx.commit();
  }
}

function validateEnvelope(
  value: unknown,
): { success: true; value: OutputEnvelope } | { success: false; message: string } {
  const parsed = OutputEnvelopeSchema.safeParse(value);
  if (parsed.success) return { success: true, value: parsed.data };
  const message = parsed.error.issues
    .slice(0, 8)
    .map((i) => (i.path.length === 0 ? '(root)' : i.path.join('.')) + ': ' + i.message)
    .join('; ');
  return { success: false, message };
}

function outcomeForEnvelope(status: EnvelopeStatus): RunOutcome {
  switch (status) {
    case EnvelopeStatus.COMPLETED:
      return RunOutcome.COMPLETED;
    case EnvelopeStatus.PARTIAL:
      return RunOutcome.PARTIAL;
    case EnvelopeStatus.BLOCKED:
      return RunOutcome.BLOCKED;
    case EnvelopeStatus.ESCALATED:
      return RunOutcome.ESCALATED;
    case EnvelopeStatus.REFUSED:
      // 05 §6.2 — a correct refusal is a healthy outcome, recorded as itself.
      return RunOutcome.REFUSED;
    case EnvelopeStatus.FAILED:
      return RunOutcome.FAILED;
    default:
      return RunOutcome.FAILED;
  }
}

/**
 * Map an engine termination onto the outcome vocabulary (31 V4) and the terminal
 * event (05 §4.2). Two values, because the vocabulary is deliberately narrower than
 * the set of things that can go wrong and the log must not lose the difference.
 */
export function outcomeForTermination(reason: TerminationReason): {
  outcome: RunOutcome;
  event: AgentRunEventType;
} {
  const t = (
    outcome: RunOutcome,
    event: AgentRunEventType = AgentRunEventType.RUN_TERMINATED,
  ): { outcome: RunOutcome; event: AgentRunEventType } => ({ outcome, event });

  switch (reason) {
    case TerminationReason.TIMEOUT:
      // 05 §7 folds a timeout into FAILED; RUN_TIMEOUT keeps the cause visible.
      return t(RunOutcome.FAILED, AgentRunEventType.RUN_TIMEOUT);
    case TerminationReason.INTERRUPTED:
      // 19 §8 — an owner interrupt terminates the run; the record persists.
      return t(RunOutcome.FAILED, AgentRunEventType.RUN_ABORTED);
    case TerminationReason.BUDGET_EXCEEDED:
      // 19 IV-3 — a defined failure, never a partial success.
      return t(RunOutcome.FAILED);
    case TerminationReason.UNAUTHENTICATED:
    case TerminationReason.ENGINE_UNAVAILABLE:
      // 19 §7 — an absent or unauthenticated engine BLOCKS the work item rather than
      // failing it. The work is fine; the engine is not, and that is a different fact.
      return t(RunOutcome.BLOCKED);
    case TerminationReason.CONTEXT_LIMIT:
      return t(RunOutcome.BLOCKED);
    case TerminationReason.INVALID_OUTPUT:
      return t(RunOutcome.INVALID_OUTPUT);
    case TerminationReason.RATE_LIMITED:
      return t(RunOutcome.FAILED);
    default:
      return t(RunOutcome.FAILED);
  }
}

function emptyBundle(runId: string): ContextBundle {
  return {
    id: 'SC-CTX-NONE',
    agentId: '',
    taskId: '',
    workItemId: '',
    elements: [],
    exclusions: [
      {
        subject: 'entire bundle',
        kind: 'POLICY',
        reason: 'run ' + runId + ' terminated before a context bundle could be built',
      },
    ],
    storeVersion: 0,
    budget: { maxChars: 0, usedChars: 0 },
    builtAt: '',
    digest: '',
  };
}

export function assertNoRunReuse(requests: readonly InvocationRequest[]): void {
  const seen = new Set<string>();
  for (const r of requests) {
    if (r.sessionPolicy !== 'NEW') {
      fail({
        code: 'E_ISOLATION',
        message: 'Run ' + r.runId + ' requested session continuation across a dispatch',
        remedy: 'Every dispatched agent run uses a NEW session (19 SM-1, SM-3).',
        details: { runId: r.runId },
        specRef: '19 §3',
      });
    }
    if (seen.has(r.runId)) {
      fail({
        code: 'E_CONFLICT',
        message: 'Run id ' + r.runId + ' was dispatched twice',
        remedy: 'Re-running a task creates a NEW run with a new event log (05 RI-7).',
        details: { runId: r.runId },
        specRef: '05 RI-7',
      });
    }
    seen.add(r.runId);
  }
}
