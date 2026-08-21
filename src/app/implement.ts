import { EnforcementClass } from '../vocab/index.js';
import { AgentRuntime } from '../agents/runtime.js';
import { ContractRegistry } from '../agents/registry.js';
import { GitService } from '../engineering/git.js';
import { EngineeringWorkspaceManager } from '../engineering/workspace.js';
import { RecipeRegistry } from '../engineering/recipe.js';
import { EngineeringFactory } from '../engineering/factory.js';
import { DEFAULT_REQUIRED_CHECKS } from '../engineering/executors.js';
import { dispatchProducer, dispatchReviewer } from '../engineering/dispatch.js';
import { resolveEngineeringEngine, type EngineeringEngine } from '../engineering/engine.js';
import { PHASE4_CANDIDATE_PRODUCERS } from './engineering.js';
import type { EngineeringWorkItem, VerificationResult } from '../engineering/factory.js';
import type { RequiredChecks } from '../engineering/executors.js';
import type { EngineeringWorkspace } from '../engineering/workspace.js';
import type { ExecutorDeps } from '../engineering/execution.js';
import type { ExecutionSubstrate, SubstrateQualification } from '../substrate/types.js';
import type { ServaRuntime } from './runtime.js';

/**
 * The production engineering flow. SPEC: Phase 4 §8, execution-binding closure §9–§10.
 *
 * `dispatchProducer` and `dispatchReviewer` existed and were tested, and nothing in
 * `src/` called either of them. The only complete flow lived in a test file, which
 * meant the governed path was demonstrated rather than shipped — and a demonstration
 * cannot be run by an owner.
 *
 * This is the one place the whole sequence lives. It composes the existing pieces and
 * reimplements none of them:
 *
 *   validate work item
 *     -> resolve the engineering ENGINE and qualify the boundary it runs in
 *     -> refuse unless that exact boundary earned HARD
 *     -> open an isolated worktree
 *     -> dispatchProducer      a real AgentRun, in that boundary
 *     -> buildChangeSet        computed by Serva, from the repository
 *     -> deterministic checks  scope, secrets, build, test, lint
 *     -> dispatchReviewer      a real, separate, read-only AgentRun
 *     -> Engineering Gate      the Phase 2 engine, over persisted evidence
 *     -> acceptChange | bounded rework | blocked
 *
 * There is no `writeFileSync` standing in for a Producer here, and no literal standing
 * in for a review. If either were acceptable, none of the rest would mean anything.
 */

export interface ImplementDeps {
  readonly rt: ServaRuntime;
  readonly registry?: ContractRegistry;
  readonly recipes?: RecipeRegistry;
  /** The substrate that runs deterministic RECIPES. A different boundary to the engine. */
  readonly recipeSubstrate: ExecutionSubstrate;
  readonly recipeQualification: SubstrateQualification;
  /** Injected in tests; resolved from the machine otherwise. */
  readonly engine?: EngineeringEngine;
  readonly enabledProducers?: ReadonlySet<string>;
  readonly required?: RequiredChecks;
  /**
   * TEST ONLY. Permits a simulated boundary so orchestration can be tested offline.
   *
   * Threaded explicitly rather than defaulted, and never set by the CLI. A test asserts
   * that no production caller passes it.
   */
  readonly allowSimulatedBoundary?: boolean;
}

export const ImplementOutcome = {
  ACCEPTED: 'ACCEPTED',
  REWORK_EXHAUSTED: 'REWORK_EXHAUSTED',
  BLOCKED: 'BLOCKED',
  ESCALATED: 'ESCALATED',
} as const;
export type ImplementOutcome = (typeof ImplementOutcome)[keyof typeof ImplementOutcome];

export interface AttemptTrace {
  readonly attempt: number;
  readonly workspaceId: string;
  readonly producerRunId?: string;
  readonly reviewerRunId?: string;
  readonly changeSetId?: string;
  readonly verdict?: string;
  readonly notes: readonly string[];
}

export interface ImplementResult {
  readonly outcome: ImplementOutcome;
  readonly workItemId: string;
  /** Why nothing was dispatched, when nothing was. */
  readonly refusal?: string;
  readonly boundary?: string;
  readonly boundaryFingerprint?: string;
  readonly attempts: readonly AttemptTrace[];
  readonly commit?: string;
  readonly branch?: string;
  readonly verification?: VerificationResult;
}

/**
 * Implement one work item, end to end, under a measured boundary.
 *
 * Refuses BEFORE creating a worktree, dispatching a model or running a command when the
 * boundary is not HARD. The order matters: a refusal that had already spent a model call
 * or mutated a repository is not a refusal, it is a partial execution with an apology.
 */
export async function implementWorkItem(
  deps: ImplementDeps,
  item: EngineeringWorkItem,
): Promise<ImplementResult> {
  const rt = deps.rt;
  const registry = deps.registry ?? ContractRegistry.shared();
  const recipes = deps.recipes ?? new RecipeRegistry();
  const attempts: AttemptTrace[] = [];

  /* ------------------------------------------------ 1. the engine and its boundary */

  const engine =
    deps.engine ?? (await resolveEngineeringEngine({ clock: rt.clock, projectRoot: rt.root }));

  if (
    engine.refusal !== undefined ||
    engine.adapter === undefined ||
    engine.qualification === undefined ||
    engine.boundary === undefined ||
    engine.capabilities === undefined ||
    engine.status === undefined
  ) {
    return {
      outcome: ImplementOutcome.BLOCKED,
      workItemId: item.workItemId,
      refusal:
        engine.refusal ??
        'No engineering engine could be resolved for this machine, so there is no boundary to run a Producer in.',
      attempts,
    };
  }

  if (engine.qualification.enforcementClass !== EnforcementClass.HARD) {
    return {
      outcome: ImplementOutcome.BLOCKED,
      workItemId: item.workItemId,
      refusal:
        'The Producer boundary measured ' +
        engine.qualification.enforcementClass +
        '. ' +
        (engine.qualification.blockedBy ?? ''),
      boundary: engine.boundary.boundaryId,
      boundaryFingerprint: engine.boundary.fingerprint,
      attempts,
    };
  }

  /* ------------------------------------------------------ 2. wire the layer once */

  const git = new GitService({ repoRoot: rt.root });
  const workspaces = new EngineeringWorkspaceManager({
    store: rt.store,
    git,
    clock: rt.clock,
    projectRoot: rt.root,
  });
  const runtime = new AgentRuntime({
    store: rt.store,
    ids: rt.ids,
    clock: rt.clock,
    registry,
    engine: engine.adapter,
    enabledAgents: new Set([item.producerAgentId, item.reviewerAgentId]),
    projectRoot: rt.root,
  });
  const executorDeps: ExecutorDeps = {
    store: rt.store,
    clock: rt.clock,
    ids: rt.ids,
    substrate: deps.recipeSubstrate,
    qualification: deps.recipeQualification,
    env: process.env,
  };
  const factory = new EngineeringFactory({
    store: rt.store,
    git,
    workspaces,
    recipes,
    registry,
    qualification: engine.qualification,
    executorDeps,
    gateDeps: { ids: rt.ids, clock: rt.clock, evaluator: 'ENGINEERING_GATE' },
    projectRoot: rt.root,
    enabledProducers: deps.enabledProducers ?? PHASE4_CANDIDATE_PRODUCERS,
    producerBoundary: engine.boundary,
    ...(deps.allowSimulatedBoundary === undefined
      ? {}
      : { allowSimulatedBoundary: deps.allowSimulatedBoundary }),
  });
  const dispatchDeps = {
    store: rt.store,
    clock: rt.clock,
    ids: rt.ids,
    runtime,
    registry,
    substrate: deps.recipeSubstrate,
    qualification: engine.qualification,
    projectRoot: rt.root,
    enabledProducers: deps.enabledProducers ?? PHASE4_CANDIDATE_PRODUCERS,
    engineCapabilities: engine.capabilities,
    engineVersion: engine.status.version,
    ...(deps.allowSimulatedBoundary === undefined
      ? {}
      : { allowSimulatedBoundary: deps.allowSimulatedBoundary }),
  };

  // Asked once, before anything is created. A refusal here costs nothing.
  const refusal = factory.refusal(item);
  if (refusal !== undefined && !refusal.includes('No isolated worktree')) {
    return {
      outcome: ImplementOutcome.BLOCKED,
      workItemId: item.workItemId,
      refusal,
      boundary: engine.boundary.boundaryId,
      boundaryFingerprint: engine.boundary.fingerprint,
      attempts,
    };
  }

  /* ---------------------------------------------------- 3. attempt, verify, route */

  const required = deps.required ?? DEFAULT_REQUIRED_CHECKS;
  let reworkContext: string | undefined;
  let lastVerification: VerificationResult | undefined;

  for (let attempt = 1; attempt <= item.maxAttempts; attempt++) {
    const notes: string[] = [];
    let workspace: EngineeringWorkspace;
    try {
      workspace = await factory.openWorkspace(item, attempt, engine.boundary.fingerprint);
    } catch (e) {
      return {
        outcome: ImplementOutcome.BLOCKED,
        workItemId: item.workItemId,
        refusal: e instanceof Error ? e.message : String(e),
        boundary: engine.boundary.boundaryId,
        boundaryFingerprint: engine.boundary.fingerprint,
        attempts,
      };
    }

    const producer = await dispatchProducer(dispatchDeps, {
      item,
      workspace,
      taskDefinition: producerTask(item),
      reviewerAvailable: registry.has(item.reviewerAgentId),
      executorsAvailable: recipes.all().length > 0,
      ...(reworkContext === undefined ? {} : { reworkContext }),
    });
    notes.push(...producer.unprovedBoundary);

    // Serva computes the change and measures it. The Producer's own account of what it
    // changed is recorded and is not an input to any of this.
    const measured = await factory.verifyAttempt(item, workspace, {
      required: { ...required, codeReview: false, qaVerification: false },
      producerRunId: producer.runId,
    });

    let reviewerRunId: string | undefined;
    if (required.codeReview) {
      const review = await dispatchReviewer(dispatchDeps, {
        item,
        workspace,
        changeSet: measured.changeSet,
        evidence: measured.evidence,
        diff: await git.diff(item.baseCommit, workspace.path),
        producerRunRef: producer.runId,
      });
      reviewerRunId = review.runId;
      notes.push(...review.problems);
    }

    // Re-verify with everything required. Judged inputs come from the store, so this
    // reads the persisted review rather than anything the caller could supply.
    const verification = await factory.verifyAttempt(item, workspace, {
      required,
      producerRunId: producer.runId,
    });
    lastVerification = verification;
    notes.push(...verification.unresolved);

    attempts.push({
      attempt,
      workspaceId: workspace.workspaceId,
      producerRunId: producer.runId,
      ...(reviewerRunId === undefined ? {} : { reviewerRunId }),
      changeSetId: verification.changeSet.changeSetId,
      verdict: verification.gateResult.verdict,
      notes,
    });

    if (verification.attemptOutcome === 'ACCEPTED') {
      const { commit, branch } = await factory.acceptChange(item, workspace, verification);
      return {
        outcome: ImplementOutcome.ACCEPTED,
        workItemId: item.workItemId,
        boundary: engine.boundary.boundaryId,
        boundaryFingerprint: engine.boundary.fingerprint,
        attempts,
        commit,
        branch,
        verification,
      };
    }

    if (verification.attemptOutcome === 'BLOCKED' || verification.attemptOutcome === 'ESCALATED') {
      return {
        outcome:
          verification.attemptOutcome === 'BLOCKED'
            ? ImplementOutcome.BLOCKED
            : ImplementOutcome.ESCALATED,
        workItemId: item.workItemId,
        boundary: engine.boundary.boundaryId,
        boundaryFingerprint: engine.boundary.fingerprint,
        attempts,
        verification,
      };
    }

    // Rework. The next attempt is given EVIDENCE, not the previous attempt's reasoning.
    const next = factory.canRework(item, attempt);
    if (!next.allowed) break;
    reworkContext = factory.reworkContext(verification);
  }

  return {
    outcome: ImplementOutcome.REWORK_EXHAUSTED,
    workItemId: item.workItemId,
    boundary: engine.boundary.boundaryId,
    boundaryFingerprint: engine.boundary.fingerprint,
    attempts,
    ...(lastVerification === undefined ? {} : { verification: lastVerification }),
  };
}

/** The Producer's task, composed from the work item and nothing else. */
function producerTask(item: EngineeringWorkItem): string {
  return [
    item.title,
    '',
    'Requirements:',
    ...item.requirements.map((r) => '  - ' + r),
    '',
    'Acceptance criteria:',
    ...item.acceptanceCriteria.map((a) => '  - ' + a),
    '',
    'Change only files under: ' + item.allowedScope.join(', ') + '.',
    'Anything you notice outside that scope is an observation to report, not an edit to make.',
  ].join('\n');
}
