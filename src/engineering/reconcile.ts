import { existsSync } from 'node:fs';
import { AuditAction, audit } from '../events/audit.js';
import {
  WorkspaceState,
  type EngineeringWorkspace,
  type EngineeringWorkspaceManager,
} from './workspace.js';
import { listChangeSets, type ChangeSet } from './changeset.js';
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

  const changeSets = listChangeSets(deps.store);
  for (const cs of changeSets) {
    const w = deps.workspaces.get(cs.workspaceId);
    if (w === undefined) continue;
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
  return report.divergences.filter(
    (d) =>
      d.kind === DivergenceKind.WORKTREE_HEAD_MOVED ||
      d.kind === DivergenceKind.EXTERNAL_WORKSPACE_CHANGE ||
      d.kind === DivergenceKind.INTEGRATION_NOT_IN_GIT,
  );
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export type { ChangeSet, EngineeringWorkspace };
