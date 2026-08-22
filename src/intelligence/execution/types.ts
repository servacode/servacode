import type { z } from 'zod';
import type { Store, Transaction } from '../../store/store.js';
import type { Clock } from '../../core/clock.js';
import type { IdSource } from '../../core/ids.js';
import type { ContractRegistry } from '../../agents/registry.js';
import type { AgentRuntime } from '../../agents/runtime.js';
import type { StageApplicability, ApplicabilityPlan } from '../applicability.js';
import type { ArtifactType } from '../repository.js';
import type { GatewayDeps } from '../research/gateway.js';

/**
 * ONE EXECUTION SUBSTRATE, MANY DEPARTMENTS.
 *
 * SPEC: 04 (orchestrator), 05 (agent architecture), 06 (department contracts).
 *
 * A department is a CONFIGURATION, not an engine. Twenty-five bespoke runners would be
 * twenty-five places to get provenance binding, independence, budget, ledger transitions
 * and failure semantics subtly different — and the differences would only show up as a
 * governance hole in whichever one was written last and reviewed least.
 *
 * So everything common lives in `runner.ts` and a department declares only what genuinely
 * differs: which contract, what it needs to read, what it produces, who it may not be, and
 * which gate follows.
 */

/** What a department may read. The runner uses this and records what it excluded. */
export interface ContextElement {
  readonly source: string;
  readonly kind: string;
  readonly version: string;
  readonly content: string;
  /** Lower is dropped first under budget pressure (19 CX-7). */
  readonly relevance: number;
}

export interface ContextExclusion {
  readonly subject: string;
  readonly reason: string;
}

/**
 * The role-specific bundle a department asks for.
 *
 * SPEC: §41. The whole project is never sent. A UI designer gets flows and tokens, not the
 * backend; a test designer gets the specification, not the implementation. `excluded` is
 * returned rather than left implicit so the trace can show what was deliberately withheld
 * — an omission nobody recorded is indistinguishable from an oversight.
 */
export interface DepartmentContextSpec {
  readonly canon: readonly ContextElement[];
  readonly excluded: readonly ContextExclusion[];
}

export interface DepartmentContext {
  readonly workItemId: string;
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly plan: ApplicabilityPlan;
  readonly stage: StageApplicability;
  /** The owner's original words, where the department legitimately needs them. */
  readonly ownerRequest?: string;
  /** Present only for research-class departments. Absent everywhere else. */
  readonly gateway?: GatewayDeps;
}

/** The outcome of Serva's pre-run work for a department. */
export interface PrepareResult {
  /** Extra context the run may read — captured sources, fenced as untrusted data. */
  readonly canon: readonly ContextElement[];
  readonly notes: readonly string[];
  /** Set when the stage cannot honestly proceed. Stops before any model call. */
  readonly blocked?: string;
  /** Ids of anything Serva persisted while preparing, for the ledger. */
  readonly artifactIds?: readonly string[];
}

/** What a department produced, beyond the artifacts it wrote. */
export interface PersistResult {
  /** Artifact ids written, for the ledger and the evidence record. */
  readonly artifactIds: readonly string[];
  /**
   * Owner decisions this department could not make for itself.
   *
   * Returning one is a normal, correct outcome — not a failure. The orchestrator turns it
   * into WAITING_FOR_OWNER, which is why this is part of the substrate rather than
   * something each department invents.
   */
  readonly ownerDecisionIds?: readonly string[];
  /** Findings worth carrying to the gate as evidence. */
  readonly notes?: readonly string[];
  /**
   * Judgements this department made about gate criteria.
   *
   * A verifier does not write canon — its output IS a judgement, and this is how it
   * reaches the gate as evidence attributable to the actor that made it.
   */
  readonly judgements?: readonly {
    readonly criterionRef: string;
    readonly met: boolean;
    readonly by: string;
    readonly note: string;
  }[];
}

/**
 * A department, declared.
 *
 * Everything here is data or a pure function over context. Nothing here creates an
 * AgentRun, opens a transaction, or touches the ledger — that is the runner's job, and
 * keeping it that way is what makes the semantics uniform.
 */
export interface DepartmentConfig<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly id: string;
  readonly stageId: string;
  /** The canonical AgentContract. Authority, tools and network all come from it. */
  readonly agentId: string;
  readonly title: string;

  /** Serva's own validator for the role payload. */
  readonly outputSchema: S;
  /** The JSON Schema sent to the provider, so it can shape its output. */
  readonly outputJsonSchema: Record<string, unknown>;

  /** Artifact families that must already exist. Missing ones block, they do not warn. */
  readonly requires?: readonly ArtifactType[];

  /**
   * Actors this run must NOT be.
   *
   * SPEC: §40. A requirements verifier that is the requirements author verifies nothing;
   * an architecture reviewer that is the architect reviews nothing. Declared per
   * department and enforced once, in the runner.
   */
  readonly independentOf?: readonly string[];

  /** True only for departments whose canonical contract declares network scope. */
  readonly usesResearchGateway?: boolean;

  /**
   * A stage Serva COMPUTES rather than reasons about.
   *
   * SPEC §17 asks for the risk stage without inventing a new sovereign agent, and risk is
   * genuinely an aggregation: unvalidated load-bearing assumptions, residual security
   * risks, unresolved owner decisions. Asking a model to "identify the risks" produces a
   * plausible list; computing it produces the actual ones, each pointing at the artifact
   * it came from.
   *
   * A deterministic department makes NO model call. It still passes every governance
   * check, still records a ledger disposition, and still writes canon through the one
   * write path — it simply has nothing to ask.
   */
  readonly deterministic?: boolean;

  /**
   * Work Serva does BEFORE the run, on the department's behalf.
   *
   * This exists for exactly one reason: retrieval. The research gateway fetches and
   * captures sources under Serva's authority, and the agent then reasons over the
   * captured evidence with no network capability of its own. Putting it here rather than
   * inside the department keeps the ordering in the runner, where the authority check
   * already lives — a department cannot fetch first and ask permission afterwards.
   *
   * Returning `blocked` stops the stage before any model call, which is what "research
   * was unavailable" must look like: a recorded refusal, never an invented landscape.
   */
  prepare?(ctx: DepartmentContext): Promise<PrepareResult>;

  buildContext(ctx: DepartmentContext): DepartmentContextSpec;
  task(ctx: DepartmentContext): string;
  scopeBoundary(ctx: DepartmentContext): string;

  /**
   * Turn validated output into canon.
   *
   * The runner owns the transaction and commits it. A department that opened its own
   * would be able to leave half its artifacts behind on a failure.
   */
  persist(tx: Transaction, output: z.output<S>, ctx: DepartmentContext): PersistResult;
}

export const DepartmentOutcome = {
  COMPLETED: 'COMPLETED',
  /** The department did its job and produced a question only the owner can answer. */
  OWNER_DECISION_REQUIRED: 'OWNER_DECISION_REQUIRED',
  /**
   * The run stopped BEFORE producing anything, on a blocking escalation.
   *
   * Distinct from OWNER_DECISION_REQUIRED because of what resuming must do. There, the
   * department finished and its canon is written, so a resume continues at the gate. Here
   * nothing was written, so the department must run AGAIN once the owner has answered —
   * and treating the two the same would leave a stage permanently empty and a lifecycle
   * that believed it ran.
   */
  ESCALATED_TO_OWNER: 'ESCALATED_TO_OWNER',
  /** A prerequisite artifact was absent. Deterministic, decided before any model call. */
  PREREQUISITE_MISSING: 'PREREQUISITE_MISSING',
  /** The run failed, produced an invalid payload, or was refused. */
  FAILED: 'FAILED',
  /** Refused before dispatch: independence, authority, or enablement. */
  REFUSED: 'REFUSED',
} as const;
export type DepartmentOutcome = (typeof DepartmentOutcome)[keyof typeof DepartmentOutcome];

export interface DepartmentResult {
  readonly departmentId: string;
  readonly stageId: string;
  readonly agentId: string;
  readonly outcome: DepartmentOutcome;
  readonly runId?: string;
  readonly artifactIds: readonly string[];
  readonly ownerDecisionIds: readonly string[];
  readonly diagnostics: readonly string[];
  readonly judgements?: readonly {
    readonly criterionRef: string;
    readonly met: boolean;
    readonly by: string;
    readonly note: string;
  }[];
  /** Present when the outcome is not COMPLETED. */
  readonly reason?: string;
}

export interface RunnerDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly registry: ContractRegistry;
  readonly runtime: AgentRuntime;
  readonly projectRoot: string;
  readonly enabledAgents: ReadonlySet<string>;
}
