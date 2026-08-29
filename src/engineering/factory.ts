import { z } from 'zod';
import { GateVerdict } from '../vocab/index.js';
import { AuditAction, audit } from '../events/audit.js';
import { fail } from '../core/errors.js';
import { buildChangeSet, type ChangeSet, type ScopeOptions } from './changeset.js';
import { integrateVerifiedChangeSet } from './integration.js';
import {
  DEFAULT_REQUIRED_CHECKS,
  RuntimeComponent,
  runBuild,
  runLint,
  runScopeCheck,
  runSecretsScan,
  runTests,
  type ExecutorContext,
  type ExecutorOutcome,
  type RequiredChecks,
} from './executors.js';
import { evidenceForChangeSet, type EngineeringEvidence, type ExecutorDeps } from './execution.js';
import { evaluateEngineeringGate, type JudgedInput } from './gate.js';
import { judgedForChangeSet, listReviews } from './review.js';
import { producerRefusal } from './capability.js';
import {
  WorkspaceState,
  type EngineeringWorkspace,
  type EngineeringWorkspaceManager,
} from './workspace.js';
import type { GateEngineDeps } from '../gates/engine.js';
import type { GitService } from './git.js';
import type { RecipeRegistry } from './recipe.js';
import type { SubstrateQualification } from '../substrate/types.js';
import type { ExecutionBoundary } from '../substrate/boundary.js';
import type { ContractRegistry } from '../agents/registry.js';
import type { Store } from '../store/store.js';
import type { GateResult } from '../gates/types.js';

/**
 * The Engineering Factory. SPEC: Phase 4 §8, §20–§23.
 *
 * The flow, and the reason each arrow points the way it does:
 *
 *   work item -> worktree -> Producer -> ChangeSet -> deterministic checks
 *             -> independent reviewer -> gate -> accept | rework | escalate
 *
 * Two properties hold throughout, and everything else follows from them:
 *
 *   - **The ChangeSet is computed by Serva, from the repository.** Every piece of
 *     evidence names it. Change the code and the evidence still describes the old
 *     ChangeSet — truthfully — and simply no longer applies.
 *   - **Nothing an agent says becomes evidence.** A Producer's "tests pass" is a claim;
 *     `SC-RTC-012` observing exit code 0 is a measurement, and only the second reaches
 *     the gate.
 */

/** Contract authorities that permit judging somebody else's work. */
const VERIFIER_AUTHORITIES: ReadonlySet<string> = new Set(['VERIFY', 'REVIEW', 'ASSESS']);

export const WORKITEM_CANON_TYPE = 'engineeringWorkItem';

export const EngineeringWorkItemSchema = z
  .object({
    workItemId: z.string().min(1),
    requestRef: z.string().optional(),
    title: z.string().min(1),
    requirements: z.array(z.string()).min(1),
    acceptanceCriteria: z.array(z.string()).min(1),
    decisions: z.array(z.string()).default([]),
    /** The paths this change may touch. Empty means nothing is in scope. */
    allowedScope: z.array(z.string()).min(1),
    forbiddenScope: z.array(z.string()).default([]),
    producerAgentId: z.string().regex(/^SC-AGENT-\d{3}$/),
    reviewerAgentId: z.string().regex(/^SC-AGENT-\d{3}$/),
    /** Registered recipe ids. A model may recommend one; it never composes one. */
    recipes: z.array(z.string()).default([]),
    magnitude: z.string(),
    baseCommit: z.string().min(7),
    expectedOutputs: z.array(z.string()).default([]),
    maxAttempts: z.number().int().positive().max(5).default(2),
  })
  .strict()
  .refine((w) => w.producerAgentId !== w.reviewerAgentId, {
    // SC-POL-006 at the definition boundary: a work item that named one agent for both
    // roles would be asking for a self-certified change before anything even ran.
    message: 'The producer and the reviewer must be different agents (SC-POL-006).',
  });

export type EngineeringWorkItem = z.output<typeof EngineeringWorkItemSchema>;

export const AttemptOutcome = {
  ACCEPTED: 'ACCEPTED',
  REWORK: 'REWORK',
  BLOCKED: 'BLOCKED',
  ESCALATED: 'ESCALATED',
} as const;
export type AttemptOutcome = (typeof AttemptOutcome)[keyof typeof AttemptOutcome];

export interface VerificationResult {
  readonly changeSet: ChangeSet;
  readonly outcomes: readonly ExecutorOutcome[];
  readonly evidence: readonly EngineeringEvidence[];
  readonly staleEvidence: readonly EngineeringEvidence[];
  readonly gateResult: GateResult;
  readonly attemptOutcome: AttemptOutcome;
  readonly unresolved: readonly string[];
  /** True when a test seam supplied a judged input that no AgentRun backs. */
  readonly usedUnvalidatedJudgement: boolean;
}

export interface FactoryDeps {
  readonly store: Store;
  readonly git: GitService;
  readonly workspaces: EngineeringWorkspaceManager;
  readonly recipes: RecipeRegistry;
  readonly registry: ContractRegistry;
  readonly qualification: SubstrateQualification;
  readonly executorDeps: ExecutorDeps;
  readonly gateDeps: GateEngineDeps;
  readonly projectRoot: string;
  readonly enabledProducers: ReadonlySet<string>;
  /**
   * The boundary a Producer would actually run in, resolved from the engineering
   * engine. Absent means no engine has been resolved, which is itself a refusal:
   * there is nothing to compare the qualification against.
   */
  readonly producerBoundary?: ExecutionBoundary;
  /** TEST ONLY. Permits a simulated boundary; no production caller sets it. */
  readonly allowSimulatedBoundary?: boolean;
}

export class EngineeringFactory {
  constructor(private readonly deps: FactoryDeps) {}

  /**
   * May this work item be attempted at all?
   *
   * Asked before a worktree is created, so a refusal costs nothing and leaves nothing
   * behind. Returns the reason rather than a boolean: "no" without a reason is not an
   * answer the owner can act on.
   */
  refusal(item: EngineeringWorkItem, workspace?: EngineeringWorkspace): string | undefined {
    if (!this.deps.registry.has(item.producerAgentId)) {
      return 'Unknown producer agent ' + item.producerAgentId + '.';
    }
    if (!this.deps.registry.has(item.reviewerAgentId)) {
      return 'Unknown reviewer agent ' + item.reviewerAgentId + '.';
    }
    /*
     * A DIFFERENT AGENT IS HALF OF INDEPENDENCE. THE OTHER HALF IS BEING ABLE TO JUDGE.
     *
     * SPEC: 19 §5; finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SSA-REV-1.
     *
     * The schema refines `producerAgentId !== reviewerAgentId` and `reviewerAvailable` meant
     * only "this id is in the registry", so two different Producers satisfied both. A live
     * cross-phase run then dispatched SC-AGENT-180 — a Database Engineer, archetype PRODUCER,
     * authority EXECUTE — as the reviewer of SC-AGENT-150's work, and the engineering gate
     * accepted its PASS as an independent review. The run record says `roleInTask: PRODUCER`.
     *
     * The authority comes from the contract rather than from the work item, because the work
     * item is where the reviewer was named in the first place.
     */
    const reviewerAuthority = this.deps.registry.get(item.reviewerAgentId).authorityLevel;
    if (!VERIFIER_AUTHORITIES.has(reviewerAuthority.toUpperCase())) {
      return (
        'Reviewer ' +
        item.reviewerAgentId +
        ' holds ' +
        reviewerAuthority +
        ', which does not authorise review. An agent that produces cannot certify, so a work ' +
        'item must name a reviewer whose contract grants a verifier authority.'
      );
    }

    const conflict = this.deps.registry.conflicts(item.producerAgentId, item.reviewerAgentId);
    void conflict; // distinct agents on a CoI pair is the separation working, not a fault

    for (const recipeId of item.recipes) {
      if (!this.deps.recipes.has(recipeId)) {
        return 'Work item names unregistered recipe ' + recipeId + '.';
      }
    }

    if (this.deps.producerBoundary === undefined) {
      return 'No engineering engine has been resolved, so there is no execution boundary to compare the qualification against. Serva does not grant write authority to an unnamed environment.';
    }

    return producerRefusal({
      contract: this.deps.registry.get(item.producerAgentId),
      qualification: this.deps.qualification,
      enabledProducers: this.deps.enabledProducers,
      ...(workspace === undefined ? {} : { workspace }),
      projectRoot: this.deps.projectRoot,
      reviewerAvailable: this.deps.registry.has(item.reviewerAgentId),
      executorsAvailable: this.deps.recipes.all().length > 0,
      actualBoundary: this.deps.producerBoundary,
      ...(this.deps.allowSimulatedBoundary === undefined
        ? {}
        : { allowSimulatedBoundary: this.deps.allowSimulatedBoundary }),
    });
  }

  recordWorkItem(item: EngineeringWorkItem): EngineeringWorkItem {
    const parsed = EngineeringWorkItemSchema.parse(item);
    const tx = this.deps.store.begin();
    tx.putCanon(WORKITEM_CANON_TYPE, parsed.workItemId, parsed);
    tx.commit();
    return parsed;
  }

  getWorkItem(workItemId: string): EngineeringWorkItem | undefined {
    const env = this.deps.store.getCanon<unknown>(WORKITEM_CANON_TYPE, workItemId);
    if (env === undefined) return undefined;
    const parsed = EngineeringWorkItemSchema.safeParse(env.body);
    return parsed.success ? parsed.data : undefined;
  }

  /** Create the isolated worktree for one attempt. */
  async openWorkspace(
    item: EngineeringWorkItem,
    attempt: number,
    sandboxProfileDigest: string,
  ): Promise<EngineeringWorkspace> {
    const refusal = this.refusal(item);
    // A missing workspace is the expected state here, so that specific reason is not
    // a refusal at this point; anything else is.
    if (refusal !== undefined && !refusal.includes('No isolated worktree')) {
      return fail({
        code: 'E_CAPABILITY_NOT_ENABLED',
        message: 'Cannot open an engineering workspace: ' + refusal,
        remedy:
          'Engineering execution requires a qualified substrate and a coherent work item. Nothing was created.',
        details: { workItemId: item.workItemId, attempt },
        specRef: 'Phase 4 §9',
      });
    }
    return this.deps.workspaces.create({
      projectId: this.deps.projectRoot,
      workItemId: item.workItemId,
      attempt,
      producerAgentId: item.producerAgentId,
      baseCommit: item.baseCommit,
      expectedScope: { allow: item.allowedScope, forbid: item.forbiddenScope },
      sandboxProfileDigest,
      substrateClass: this.deps.qualification.enforcementClass,
    });
  }

  /**
   * Verify one attempt: observe the change, measure it, judge it, gate it.
   *
   * The order is not arbitrary. The ChangeSet is built FIRST, before any check runs, so
   * every measurement that follows is bound to the same identity — and a Producer that
   * edited a file after the tests ran produces a different ChangeSet, whose evidence
   * set is empty rather than green.
   */
  async verifyAttempt(
    item: EngineeringWorkItem,
    workspace: EngineeringWorkspace,
    o: {
      readonly required?: RequiredChecks;
      readonly producerRunId?: string;
      readonly scopeOptions?: Partial<ScopeOptions>;
      /**
       * TEST ONLY. A judged verdict that no AgentRun backs.
       *
       * This used to be the ordinary `judged` parameter, and it was a hole straight
       * through the most important criterion in the system: a caller could satisfy a
       * required, BLOCKING review with a literal, and the accepted record would then
       * claim an independent review that never happened.
       *
       * The production path takes judged inputs from `judgedForChangeSet`, which
       * returns only reviews validated against a real reviewer AgentRun. This seam
       * exists so gate composition can be tested without spending a model call, it is
       * named so nobody reaches for it by accident, and every result it touches is
       * flagged `usedUnvalidatedJudgement` — which `acceptChange` refuses on.
       */
      readonly testOnlyJudged?: readonly JudgedInput[];
    } = {},
  ): Promise<VerificationResult> {
    const required = o.required ?? DEFAULT_REQUIRED_CHECKS;
    const changeSet = await buildChangeSet(
      {
        store: this.deps.store,
        git: this.deps.git,
        clock: this.deps.executorDeps.clock,
        ids: this.deps.executorDeps.ids,
      },
      workspace,
      o.producerRunId,
    );

    const ctx: ExecutorContext = {
      deps: this.deps.executorDeps,
      recipes: this.deps.recipes,
      workspace,
      changeSet,
      projectRoot: this.deps.projectRoot,
      ...(o.producerRunId === undefined ? {} : { correlationId: o.producerRunId }),
    };

    const outcomes: ExecutorOutcome[] = [];
    const unresolved: string[] = [];

    /*
     * An empty ChangeSet is never an acceptance.
     *
     * Every deterministic check passes vacuously against no change — scope is trivially
     * conformant, the suite still goes green — so a Producer that edited nothing would
     * sail through the gate and reach `acceptChange`, which then fails at `git commit`
     * with "nothing to commit". The gate would have said PASS about work that does not
     * exist, and the only thing standing between that and a recorded acceptance was an
     * error message from git.
     */
    const emptyChange = changeSet.entries.length === 0;
    if (emptyChange) {
      unresolved.push(
        'The Producer left the worktree unchanged. An empty ChangeSet satisfies every check vacuously, so it is routed to rework rather than accepted.',
      );
    }

    /*
     * Scope first, and unconditionally.
     *
     * A change that escaped its boundary should not have its tests run: the result
     * would be a true statement about a change nobody authorized, and reporting it
     * alongside a scope violation invites treating the green as the headline.
     */
    if (required.scope) {
      outcomes.push(
        runScopeCheck(ctx, {
          allow: item.allowedScope,
          forbid: item.forbiddenScope,
          ...o.scopeOptions,
        }),
      );
    }
    if (required.secrets) outcomes.push(runSecretsScan(ctx));

    const scopeFailed = outcomes.some(
      (x) => x.component === RuntimeComponent.SCOPE && x.evidence.outcome === 'FAIL',
    );
    if (scopeFailed) {
      unresolved.push(
        'Deterministic checks were not run: the change is outside its declared scope, and measuring an unauthorized change would produce true statements about work nobody asked for.',
      );
    } else {
      // Each executor records its own evidence and never throws for a command failure:
      // a failing build is an outcome the gate must see, not an exception.
      if (required.build) outcomes.push(await runBuild(ctx));
      if (required.tests) outcomes.push(await runTests(ctx));
      if (required.lint) outcomes.push(await runLint(ctx));
    }

    const { valid, stale } = evidenceForChangeSet(this.deps.store, changeSet.changeSetId);

    /*
     * Judged inputs come from PERSISTED reviews, each already tied to a terminated,
     * independent, read-only AgentRun bound to this exact ChangeSet. A verdict about a
     * different ChangeSet is not carried forward: the reviewer looked at other code.
     */
    const validatedJudged = judgedForChangeSet(this.deps.store, changeSet.changeSetId);
    const usedUnvalidatedJudgement = (o.testOnlyJudged ?? []).length > 0;
    if (usedUnvalidatedJudgement) {
      unresolved.push(
        'A judged verdict was supplied directly rather than by a reviewer AgentRun. This is a test seam; the result cannot be accepted.',
      );
    }
    const judged = [...validatedJudged, ...(o.testOnlyJudged ?? [])];

    const tx = this.deps.store.begin();
    const gateResult = evaluateEngineeringGate(tx, this.deps.gateDeps, {
      changeSet,
      evidence: valid,
      judged,
      required,
    });
    tx.commit();

    const attemptOutcome = emptyChange ? AttemptOutcome.REWORK : routeVerdict(gateResult.verdict);
    if (attemptOutcome !== AttemptOutcome.ACCEPTED) {
      for (const q of gateResult.qualifications) {
        unresolved.push(q.kind + ' on ' + q.subject + ': ' + q.detail);
      }
    }

    this.deps.workspaces.update(workspace.workspaceId, {
      state:
        attemptOutcome === AttemptOutcome.ACCEPTED
          ? WorkspaceState.VERIFIED
          : WorkspaceState.IN_USE,
      headCommit: changeSet.headCommit,
    });

    return {
      changeSet,
      outcomes,
      evidence: valid,
      staleEvidence: stale,
      gateResult,
      attemptOutcome,
      unresolved,
      usedUnvalidatedJudgement,
    };
  }

  /**
   * Accept a verified change and integrate it locally.
   *
   * Phase 4 performs NO remote write: no push, no PR, no remote branch. The accepted
   * change becomes a deterministic local commit on its own branch, and that is where
   * this phase stops.
   */
  async acceptChange(
    item: EngineeringWorkItem,
    workspace: EngineeringWorkspace,
    verification: VerificationResult,
  ): Promise<{ commit: string; branch: string }> {
    /*
     * A second, independent check at the integration boundary.
     *
     * The gate already required a review, and this asks the store directly whether one
     * exists for this ChangeSet. Two checks against the same fact from different
     * directions is the point: the first can be satisfied by a verdict handed in, and
     * this one cannot be satisfied by anything except a persisted, validated review.
     */
    if (verification.usedUnvalidatedJudgement) {
      return fail({
        code: 'E_VALIDATION',
        message:
          'ChangeSet ' +
          verification.changeSet.changeSetId +
          ' was verified with a judged verdict that no AgentRun backs',
        remedy:
          'A change is integrated only after a real independent reviewer accepted it. The test seam is not an acceptance path.',
        details: { changeSetId: verification.changeSet.changeSetId },
        specRef: 'Phase 4 §19, SC-POL-006',
      });
    }
    const reviews = listReviews(this.deps.store).filter(
      (r) => r.changeSetId === verification.changeSet.changeSetId,
    );
    if (reviews.length === 0) {
      return fail({
        code: 'E_VALIDATION',
        message:
          'No independent review is recorded for ChangeSet ' + verification.changeSet.changeSetId,
        remedy:
          'NO EVIDENCE = NOT VERIFIED. Dispatch the reviewer, or accept that this change is not accepted.',
        details: { changeSetId: verification.changeSet.changeSetId },
        specRef: 'Phase 4 §19',
      });
    }
    if (reviews.some((r) => r.reviewerAgentId === item.producerAgentId)) {
      return fail({
        code: 'E_VALIDATION',
        message: 'The recorded review was produced by the producing agent',
        remedy: 'An agent never certifies its own work (SC-POL-006).',
        details: { changeSetId: verification.changeSet.changeSetId },
        specRef: 'SC-POL-006',
      });
    }

    if (verification.attemptOutcome !== AttemptOutcome.ACCEPTED) {
      return fail({
        code: 'E_INVALID_TRANSITION',
        message:
          'ChangeSet ' +
          verification.changeSet.changeSetId +
          ' is not accepted (' +
          verification.gateResult.verdict +
          ')',
        remedy: 'A change is integrated only after its gate permits it.',
        details: { verdict: verification.gateResult.verdict },
        specRef: 'Phase 4 §23',
      });
    }

    const message = [
      item.title,
      '',
      'Work item: ' + item.workItemId,
      'ChangeSet: ' + verification.changeSet.changeSetId,
      'Producer:  ' + item.producerAgentId + ' (attempt ' + String(workspace.attempt) + ')',
      'Reviewer:  ' + item.reviewerAgentId,
      'Gate:      ' + verification.gateResult.verdict + ' (' + verification.gateResult.id + ')',
      'Evidence:  ' + verification.evidence.map((e) => e.id).join(', '),
    ].join('\n');

    /*
     * Stage exactly the verified change, prove the index matches it, commit, then prove
     * the COMMIT matches it — independently, from the object database.
     *
     * Nothing below this line runs unless both proofs held. Recording acceptance before
     * the post-commit check would mean the audit trail asserts a provenance nobody
     * verified, which is the failure mode this whole phase exists to prevent.
     */
    const integration = await integrateVerifiedChangeSet(this.deps.git, {
      changeSet: verification.changeSet,
      worktreePath: workspace.path,
      branch: workspace.branch,
      message,
    });
    const commit = integration.commit;

    this.deps.workspaces.update(workspace.workspaceId, {
      state: WorkspaceState.ACCEPTED,
      headCommit: commit,
    });

    const tx = this.deps.store.begin();
    audit(tx, {
      action: AuditAction.CHANGE_ACCEPTED,
      subject: verification.changeSet.changeSetId,
      outcome: 'OK',
      detail: {
        workItemId: item.workItemId,
        commit,
        branch: workspace.branch,
        gateResult: verification.gateResult.id,
        verdict: verification.gateResult.verdict,
        evidence: verification.evidence.map((e) => e.id),
        producerAgentId: item.producerAgentId,
        reviewerAgentId: item.reviewerAgentId,
        // The proof, not the intention: both digests are over the same canonical form.
        verifiedIdentity: integration.stagedIdentity.digest,
        committedIdentity: integration.committedIdentity.digest,
        // Dirty paths deliberately left out of the commit, so the record says so rather
        // than leaving the reader to infer that the worktree was pristine.
        notStaged: integration.notStaged,
      },
    });
    tx.commit();

    return { commit, branch: workspace.branch };
  }

  /**
   * Is another attempt permitted?
   *
   * Bounded by the work item's own `maxAttempts`. Past the limit the answer is
   * ESCALATED with the unresolved evidence named — an unbounded repair loop is how a
   * system spends a budget producing nothing and calls it persistence.
   */
  canRework(item: EngineeringWorkItem, attempt: number): { allowed: boolean; reason: string } {
    if (attempt >= item.maxAttempts) {
      return {
        allowed: false,
        reason:
          'Attempt ' +
          String(attempt) +
          ' of ' +
          String(item.maxAttempts) +
          ' reached. Further attempts require an owner decision, not another retry.',
      };
    }
    return { allowed: true, reason: 'Attempt ' + String(attempt + 1) + ' permitted.' };
  }

  /**
   * The structured context a rework attempt receives.
   *
   * Deliberately built from EVIDENCE rather than from the previous run's reasoning: a
   * fresh session gets what was measured, not what the last attempt thought (19 CX-2).
   */
  reworkContext(verification: VerificationResult): string {
    const lines = [
      'The previous attempt did not pass the Engineering Gate.',
      'Gate verdict: ' + verification.gateResult.verdict,
      '',
      'What was measured against ChangeSet ' + verification.changeSet.changeSetId + ':',
    ];
    for (const e of verification.evidence) {
      lines.push('  [' + e.outcome + '] ' + (e.runtimeComponentId ?? 'JUDGED') + ' — ' + e.detail);
    }
    if (verification.unresolved.length > 0) {
      lines.push('', 'Unresolved:');
      for (const u of verification.unresolved) lines.push('  - ' + u);
    }
    lines.push(
      '',
      'Every result above describes the PREVIOUS ChangeSet. Editing the code produces a',
      'new one, and all of it must be measured again — nothing carries forward.',
    );
    return lines.join('\n');
  }
}

/** 31 §4 — the gate verdict decides the route; the factory does not re-decide it. */
export function routeVerdict(verdict: GateVerdict): AttemptOutcome {
  switch (verdict) {
    case GateVerdict.PASS:
    case GateVerdict.PASS_WITH_QUALIFICATION:
      return AttemptOutcome.ACCEPTED;
    case GateVerdict.FAIL:
      return AttemptOutcome.REWORK;
    case GateVerdict.NOT_VERIFIED:
      // Nobody looked. Rework, because re-measuring is exactly what is missing.
      return AttemptOutcome.REWORK;
    case GateVerdict.BLOCKED:
      return AttemptOutcome.BLOCKED;
    case GateVerdict.ESCALATED:
      return AttemptOutcome.ESCALATED;
    default:
      return AttemptOutcome.BLOCKED;
  }
}
