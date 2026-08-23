import type { z } from 'zod';
import type { TrustLevel } from '../../vocab/index.js';
import type { Store } from '../../store/store.js';
import type { ScopedCanonWriter } from './authority.js';
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
  /**
   * Whether this may be believed. Carried, never inferred.
   *
   * SPEC: 19 §4.2. The ContextBundle's structural marking is the authoritative one: a
   * paragraph inside a TRUSTED element announcing that it is untrusted proves only that
   * somebody wrote the paragraph. Retrieved evidence went through exactly that shape —
   * fenced prose, trusted element — until this field existed, so the fence said one thing
   * and the bundle said another.
   *
   * Absent means TRUSTED, because a department's `buildContext` reads governed canon out
   * of the Store and that is what trusted means. Anything whose text was authored outside
   * Serva's governance must say UNTRUSTED here, and the runner refuses a bundle that
   * would carry a SourceCapture as trusted whatever the department declared.
   */
  readonly trust?: TrustLevel;
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
  /**
   * Exact canon the runner is handing back after a question it could answer.
   *
   * Set only on a bounded retry, and only with the artifacts the run's own questions
   * named. Not a widening of context: a department that asked about SC-REQ-000003 gets
   * SC-REQ-000003, not the requirements baseline.
   */
  readonly supplied?: readonly ContextElement[];
  /**
   * The exact obligation this run exists to discharge.
   *
   * Set only by the obligation controller, and only on the department that owes the
   * answer. It is what makes "consume the request another department raised" different
   * from "do your usual job": the research authority given an obligation answers THAT
   * question, under THAT request's declared policy, rather than composing a generic one
   * of its own and leaving the original outstanding forever.
   */
  readonly obligation?: {
    readonly questionId: string;
    readonly requestId?: string;
    readonly question: string;
  };
  /**
   * The governed run that produced the output being persisted.
   *
   * Set by the RUNNER, immediately before `persist`, and never by a caller — it does not
   * exist until the run does. It is what lets an artifact record the act that produced it
   * rather than only the actor: `acceptanceRefusal` reads exactly this to check that a
   * proposal ruling came from a run that actually completed, and an artifact that cannot
   * name its run cannot be told apart from one somebody wrote by hand.
   */
  readonly runId?: string;
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
   * A verifier does not write canon - its output IS a judgement, and this is how it
   * reaches the gate as evidence attributable to the actor that made it.
   *
   * `subjects` is what makes the judgement checkable later. "Somebody accepted the
   * architecture" cannot be re-examined; "SC-AGENT-072 accepted SC-ARCH-000001 at version
   * 2" can, and readiness refuses it once version 3 exists. Without the versions, a review
   * survives the thing it reviewed.
   */
  readonly judgements?: readonly {
    readonly criterionRef: string;
    readonly met: boolean;
    readonly by: string;
    readonly note: string;
    readonly subjects?: readonly { readonly id: string; readonly version: number }[];
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
   * The canonical artifact families this department writes.
   *
   * REQUIRED, and validated at construction against the agent's contract in `32`. The
   * runner turns it into a writer that physically cannot commit anything else, so a
   * persist function is constrained rather than trusted.
   *
   * Declaring it is not a formality. A department with no declaration cannot be scoped,
   * and an unscoped writer is how the Admin Operability department came to write
   * SC-AGENT-141's canon while running only SC-AGENT-140.
   */
  readonly produces: readonly ArtifactType[];

  /**
   * Artifacts this department writes that NO canonical contract claims.
   *
   * Not a loophole — a record of a gap in R4, kept where the gap actually bites. Three
   * kinds of artifact fall here today:
   *
   *   the intake framing artifacts (ClientInput, ProjectGoal, Constraint, OpenQuestion),
   *   which every downstream stage depends on and which `32` assigns to nobody;
   *
   *   Feature, where SC-AGENT-020's contract names ProductScope and FeaturePriority[] —
   *   the thing prioritised and the scope it sits in — but not the Feature itself;
   *
   *   Risk, which Serva COMPUTES from persisted canon rather than asking anybody, so it
   *   is not agent output at all.
   *
   * Each entry states why. `authorityRefusal` accepts them and refuses one with no reason,
   * and a catalogue test enumerates the whole set — so this list can grow, but only
   * deliberately and only in a diff somebody has to read. See SF-12.
   */
  readonly producesBeyondContract?: readonly {
    readonly type: ArtifactType;
    readonly why: string;
  }[];

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
  persist(tx: ScopedCanonWriter, output: z.output<S>, ctx: DepartmentContext): PersistResult;
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
    readonly subjects?: readonly { readonly id: string; readonly version: number }[];
  }[];
  /** Present when the outcome is not COMPLETED. */
  readonly reason?: string;
}

export interface RunnerDeps {
  readonly store: Store;
  /**
   * Every registered department, so the runner can resolve which stage owes a canon family.
   *
   * Read-only, and used for exactly that: routing an upstream obligation needs to know who
   * produces the missing artifact, and guessing from a naming convention would be a second
   * source of truth about ownership.
   */
  readonly departments?: readonly {
    readonly id: string;
    readonly stageId: string;
    readonly produces: readonly ArtifactType[];
    /** Present on a full DepartmentConfig; used to resolve the research authority. */
    readonly agentId?: string;
    readonly usesResearchGateway?: boolean;
  }[];
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly registry: ContractRegistry;
  readonly runtime: AgentRuntime;
  readonly projectRoot: string;
  readonly enabledAgents: ReadonlySet<string>;
}
