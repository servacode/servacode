import { existsSync } from 'node:fs';
import { AuditAction, audit } from '../events/audit.js';
import {
  WorkspaceState,
  type EngineeringWorkspace,
  type EngineeringWorkspaceManager,
} from './workspace.js';
import { listChangeSets, type ChangeSet } from './changeset.js';
import { listEvidence } from './execution.js';
import type { GitService } from './git.js';
import type { Store } from '../store/store.js';
import type { Clock } from '../core/clock.js';

/**
 * Workspace reconciliation. SPEC: Phase 4 §24–§25, SC-POL-032.
 *
 * Phase 2 deferred this deliberately. The factory makes it unavoidable: once Serva
 * creates worktrees and commits, the store's account of the repository and the
 * repository itself can disagree, and a gate that trusts a stale account is a gate
 * that passes on evidence about something else.
 *
 * The governing rule, and the one worth being stubborn about:
 *
 *   **Serva never overwrites the owner's work to make reconciliation succeed.**
 *
 * An unexplained change is classified as EXTERNAL divergence and reported. It is not
 * reverted, not stashed, not "cleaned". A human editing their own repository is
 * allowed; what is not allowed is Serva pretending it authorized the edit, or quietly
 * destroying it to restore a state its records prefer.
 */

export const DivergenceKind = {
  /** A worktree Serva recorded but Git no longer knows about. */
  ABANDONED_WORKTREE: 'ABANDONED_WORKTREE',
  /** A worktree Git knows about that Serva never recorded. */
  UNTRACKED_WORKTREE: 'UNTRACKED_WORKTREE',
  /** Recorded, but the directory is gone. */
  MISSING_WORKTREE: 'MISSING_WORKTREE',
  /** The owner's checkout has uncommitted changes. */
  DIRTY_PRIMARY_CHECKOUT: 'DIRTY_PRIMARY_CHECKOUT',
  /** A worktree HEAD moved without Serva doing it. */
  WORKTREE_HEAD_MOVED: 'WORKTREE_HEAD_MOVED',
  /** A branch Serva created points somewhere Serva did not put it. */
  BRANCH_MOVED: 'BRANCH_MOVED',
  /** A Producer run started and never reached a verification. */
  INTERRUPTED_PRODUCER_RUN: 'INTERRUPTED_PRODUCER_RUN',
  /** A change set exists with no verification evidence at all. */
  UNVERIFIED_CHANGESET: 'UNVERIFIED_CHANGESET',
  /** Accepted, but never integrated. */
  ACCEPTED_NOT_INTEGRATED: 'ACCEPTED_NOT_INTEGRATED',
  /** Serva recorded an integration that the repository does not show. */
  INTEGRATION_NOT_IN_GIT: 'INTEGRATION_NOT_IN_GIT',
  /** Someone changed the repository outside Serva. Reported, never undone. */
  EXTERNAL_WORKSPACE_CHANGE: 'EXTERNAL_WORKSPACE_CHANGE',
} as const;
export type DivergenceKind = (typeof DivergenceKind)[keyof typeof DivergenceKind];

export interface Divergence {
  readonly kind: DivergenceKind;
  readonly subject: string;
  readonly detail: string;
  /**
   * Whether Serva may repair this on its own.
   *
   * Only bookkeeping is ever self-repairable. Anything touching a file the owner might
   * have written is `false`, because the cost of being wrong is somebody's work.
   */
  readonly selfRepairable: boolean;
  readonly remedy: string;
}

export interface ReconciliationReport {
  readonly divergences: readonly Divergence[];
  readonly workspacesChecked: number;
  readonly changeSetsChecked: number;
  readonly primaryCheckoutClean: boolean;
  readonly reconciledAt: string;
}

export interface ReconcileDeps {
  readonly store: Store;
  readonly git: GitService;
  readonly workspaces: EngineeringWorkspaceManager;
  readonly clock: Clock;
}

export async function reconcileWorkspaces(deps: ReconcileDeps): Promise<ReconciliationReport> {
  const divergences: Divergence[] = [];
  const recorded = deps.workspaces.list();
  const gitWorktrees = await deps.git.listWorktrees();
  const gitPaths = new Set(gitWorktrees.map((w) => normalize(w.path)));

  const primaryStatus = await deps.git.status();
  const primaryClean = primaryStatus.length === 0;
  if (!primaryClean) {
    divergences.push({
      kind: DivergenceKind.DIRTY_PRIMARY_CHECKOUT,
      subject: deps.git.repoRoot,
      detail:
        String(primaryStatus.length) +
        ' uncommitted path(s) in the primary checkout, for example ' +
        primaryStatus
          .slice(0, 3)
          .map((p) => p.status + ' ' + p.path)
          .join(', '),
      selfRepairable: false,
      remedy:
        "These are the owner's changes. Serva does not stash, revert or clean them; commit or set them aside before relying on evidence measured against this base.",
    });
  }

  for (const w of recorded) {
    if (w.state === WorkspaceState.REMOVED) continue;

    if (!existsSync(w.path)) {
      divergences.push({
        kind: DivergenceKind.MISSING_WORKTREE,
        subject: w.workspaceId,
        detail: 'Recorded at ' + w.path + ', which no longer exists.',
        selfRepairable: true,
        remedy: 'Mark the workspace ABANDONED and prune the worktree registration.',
      });
      continue;
    }
    if (!gitPaths.has(normalize(w.path))) {
      divergences.push({
        kind: DivergenceKind.ABANDONED_WORKTREE,
        subject: w.workspaceId,
        detail: 'The directory exists but git no longer registers it as a worktree.',
        selfRepairable: false,
        remedy:
          'The directory may hold work. Inspect it before removing anything; `git worktree prune` will not delete files but Serva will not delete them either.',
      });
      continue;
    }

    const head = await deps.git.headCommit(w.path);
    if (w.headCommit !== undefined && head !== '' && head !== w.headCommit) {
      divergences.push({
        kind: DivergenceKind.WORKTREE_HEAD_MOVED,
        subject: w.workspaceId,
        detail:
          'Recorded HEAD ' + w.headCommit.slice(0, 12) + ', actual ' + head.slice(0, 12) + '.',
        selfRepairable: false,
        remedy:
          'Something advanced this worktree outside Serva. Evidence measured against the recorded HEAD is stale; re-verify rather than reusing it.',
      });
    }

    const dirty = await deps.git.status(w.path);
    if (dirty.length > 0 && w.state === WorkspaceState.VERIFIED) {
      divergences.push({
        kind: DivergenceKind.EXTERNAL_WORKSPACE_CHANGE,
        subject: w.workspaceId,
        detail:
          'A verified workspace has ' +
          String(dirty.length) +
          ' uncommitted change(s), so its verification no longer describes its contents.',
        selfRepairable: false,
        remedy:
          'Re-run verification against a new ChangeSet. Do not carry the earlier result forward.',
      });
    }
  }

  const recordedPaths = new Set(recorded.map((w) => normalize(w.path)));
  for (const gw of gitWorktrees) {
    if (normalize(gw.path) === normalize(deps.git.repoRoot)) continue;
    if (recordedPaths.has(normalize(gw.path))) continue;
    if (!normalize(gw.path).includes('serva-workspaces')) continue;
    divergences.push({
      kind: DivergenceKind.UNTRACKED_WORKTREE,
      subject: gw.path,
      detail: 'A worktree under the Serva workspaces root that Serva has no record of.',
      selfRepairable: false,
      remedy:
        'It may be from an interrupted run or created by hand. Inspect it; Serva will not remove a worktree it cannot account for.',
    });
  }

  /*
   * FOUR KINDS THAT WERE VOCABULARY RATHER THAN DETECTION.
   *
   * SPEC: finding RECONCILIATION/RECON-1.
   *
   * `DivergenceKind` declared BRANCH_MOVED, INTERRUPTED_PRODUCER_RUN, UNVERIFIED_CHANGESET and
   * ACCEPTED_NOT_INTEGRATED — four categories central to this module's stated purpose of
   * keeping a gate from trusting stale evidence — and nothing here ever constructed one. An
   * enum value nothing can emit is worse than a missing feature: the vocabulary reads as a
   * finished threat model, and `invalidatesEvidence()` looks like it filters for conditions
   * that could never arrive.
   *
   * Every one of these is REPORTED and never repaired, like everything else here. A
   * reconciliation that fixed what it found would be deciding, on its own, which of two
   * disagreeing records is the true one.
   */
  const branchTips = new Map(
    gitWorktrees.filter((w) => w.branch !== undefined).map((w) => [w.branch as string, w.head]),
  );

  for (const w of recorded) {
    if (w.branch === undefined || w.branch === '') continue;
    if (w.state === WorkspaceState.REMOVED || w.state === WorkspaceState.ABANDONED) continue;
    const tip = branchTips.get(w.branch);
    /*
     * A branch Serva created that now points somewhere Serva did not put it.
     *
     * The reference is the head Serva last recorded, or the base it created the branch at when
     * no head has been recorded yet — a fresh worktree whose branch has already moved is
     * exactly the case worth catching, and requiring `headCommit` would have skipped it.
     *
     * Only checked against a tip git actually reports: a branch git no longer knows about is
     * an abandoned worktree, which is already its own finding above.
     */
    const expected =
      w.headCommit !== undefined && w.headCommit !== '' ? w.headCommit : w.baseCommit;
    if (tip !== undefined && expected !== '' && tip !== expected) {
      divergences.push({
        kind: DivergenceKind.BRANCH_MOVED,
        subject: w.branch,
        detail:
          'Serva recorded ' +
          w.branch +
          ' at ' +
          expected.slice(0, 12) +
          ' and the repository has it at ' +
          tip.slice(0, 12) +
          '.',
        selfRepairable: false,
        remedy:
          'Something moved this branch outside Serva. Establish which commit is the intended one before any evidence bound to it is trusted.',
      });
    }
  }

  const changeSets = listChangeSets(deps.store);
  for (const cs of changeSets) {
    const w = deps.workspaces.get(cs.workspaceId);
    if (w === undefined) continue;

    /*
     * A Producer run that started and never reached a terminal record. Its change set cannot
     * be trusted as finished work, because nothing recorded how it ended.
     */
    if (cs.producerRunId !== undefined) {
      const run = deps.store.getCanon<{ terminal?: boolean; outcome?: string }>(
        'agentRunRecord',
        cs.producerRunId,
      )?.body;
      if (run !== undefined && run.terminal !== true && run.outcome === undefined) {
        divergences.push({
          kind: DivergenceKind.INTERRUPTED_PRODUCER_RUN,
          subject: cs.producerRunId,
          detail:
            'Run ' +
            cs.producerRunId +
            ' produced ' +
            cs.changeSetId +
            ' and never reached a terminal record, so how it ended was never written down.',
          selfRepairable: false,
          remedy:
            'An interrupted run leaves work whose completeness nobody established. Inspect the change set before any gate consumes it.',
        });
      }
    }

    const evidence = listEvidence(deps.store).filter((e) => e.changeSetId === cs.changeSetId);
    if (evidence.length === 0 && w.state !== WorkspaceState.CREATED) {
      divergences.push({
        kind: DivergenceKind.UNVERIFIED_CHANGESET,
        subject: cs.changeSetId,
        detail:
          'Change set ' +
          cs.changeSetId +
          ' exists in workspace state ' +
          w.state +
          ' with no verification evidence bound to it at all.',
        selfRepairable: false,
        remedy:
          'Nothing measured this change. Run the required checks against it, or discard it; do not accept it on the strength of its existence.',
      });
    }

    if (w.state === WorkspaceState.ACCEPTED && cs.headCommit === '') {
      divergences.push({
        kind: DivergenceKind.ACCEPTED_NOT_INTEGRATED,
        subject: cs.changeSetId,
        detail:
          'Workspace ' +
          cs.workspaceId +
          ' is recorded ACCEPTED and ' +
          cs.changeSetId +
          ' names no integrated commit, so the acceptance points at nothing in the repository.',
        selfRepairable: false,
        remedy:
          'An acceptance with no commit behind it cannot be relied on. Establish whether the integration happened before treating this work as landed.',
      });
    }

    if (w.state === WorkspaceState.ACCEPTED && cs.headCommit !== '') {
      const exists = await deps.git.commitExists(cs.headCommit);
      if (!exists) {
        divergences.push({
          kind: DivergenceKind.INTEGRATION_NOT_IN_GIT,
          subject: cs.changeSetId,
          detail:
            'Recorded as accepted at ' +
            cs.headCommit.slice(0, 12) +
            ', which the repository does not contain.',
          selfRepairable: false,
          remedy:
            'The store and the repository disagree about what was integrated. Do not re-apply; establish which is right first.',
        });
      }
    }
  }

  const report: ReconciliationReport = {
    divergences,
    workspacesChecked: recorded.length,
    changeSetsChecked: changeSets.length,
    primaryCheckoutClean: primaryClean,
    reconciledAt: deps.clock.now(),
  };

  if (divergences.length > 0) {
    const tx = deps.store.begin();
    audit(tx, {
      action: AuditAction.EXTERNAL_WORKSPACE_CHANGE,
      subject: deps.git.repoRoot,
      outcome: 'OK',
      detail: {
        divergences: divergences.length,
        kinds: [...new Set(divergences.map((d) => d.kind))],
      },
    });
    tx.commit();
  }

  return report;
}

/**
 * Does any divergence make previously measured evidence untrustworthy?
 *
 * Used before a gate consumes evidence. A moved HEAD or an external edit does not make
 * the old measurement false — it makes it a measurement of something else, which is
 * the same reason a ChangeSet change makes evidence stale.
 */
export function invalidatesEvidence(report: ReconciliationReport): Divergence[] {
  /*
   * Four of these were unreachable until the detector could produce them, so this filter looked
   * complete while covering only the three kinds that could actually arrive. A gate consuming
   * evidence must react to all of them: each one means the thing the evidence describes is not
   * the thing on disk.
   */
  return report.divergences.filter(
    (d) =>
      d.kind === DivergenceKind.WORKTREE_HEAD_MOVED ||
      d.kind === DivergenceKind.EXTERNAL_WORKSPACE_CHANGE ||
      d.kind === DivergenceKind.INTEGRATION_NOT_IN_GIT ||
      d.kind === DivergenceKind.BRANCH_MOVED ||
      d.kind === DivergenceKind.INTERRUPTED_PRODUCER_RUN ||
      d.kind === DivergenceKind.UNVERIFIED_CHANGESET ||
      d.kind === DivergenceKind.ACCEPTED_NOT_INTEGRATED,
  );
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export type { ChangeSet, EngineeringWorkspace };
