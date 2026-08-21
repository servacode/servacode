import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { fail } from '../core/errors.js';
import { assertSafeSegment } from '../store/paths.js';
import { digestOf } from '../core/hash.js';
import { AuditAction, audit } from '../events/audit.js';
import { safeRealpath } from '../substrate/fake.js';
import type { GitService } from './git.js';
import type { Store, Transaction } from '../store/store.js';
import type { Clock } from '../core/clock.js';

/**
 * EngineeringWorkspaceManager. SPEC: Phase 4 §6–§7, 14, 21 §8.
 *
 * Every engineering attempt gets its own Git worktree, and **the Producer never edits
 * the owner's primary checkout**. That is the one boundary in this phase that cannot
 * be re-earned: everything inside a worktree is reconstructible from Git, and
 * uncommitted work in the owner's tree is not.
 *
 * Paths are built from Serva's own identifiers and validated segment by segment
 * against the Phase 2 confinement rules, then resolved through symlinks and proved to
 * lie under the workspaces root. A worktree path is never assembled from free text.
 */

export const WORKSPACE_CANON_TYPE = 'engineeringWorkspace';
/** Worktrees live beside the store, never inside it: `.serva` is denied to every run. */
export const WORKSPACES_DIRNAME = 'workspaces';

export const WorkspaceState = {
  CREATED: 'CREATED',
  IN_USE: 'IN_USE',
  VERIFIED: 'VERIFIED',
  ACCEPTED: 'ACCEPTED',
  ABANDONED: 'ABANDONED',
  REMOVED: 'REMOVED',
} as const;
export type WorkspaceState = (typeof WorkspaceState)[keyof typeof WorkspaceState];

export const EngineeringWorkspaceSchema = z
  .object({
    workspaceId: z.string().min(1),
    projectId: z.string().min(1),
    workItemId: z.string().min(1),
    attempt: z.number().int().positive(),
    producerAgentId: z.string().regex(/^SC-AGENT-\d{3}$/),
    baseCommit: z.string().min(7),
    branch: z.string().min(1),
    path: z.string().min(1),
    createdAt: z.string(),
    state: z.nativeEnum(WorkspaceState),
    expectedScope: z.object({
      allow: z.array(z.string()),
      forbid: z.array(z.string()),
    }),
    sandboxProfileDigest: z.string(),
    substrateClass: z.string(),
    headCommit: z.string().optional(),
    cleanupState: z.enum(['PENDING', 'DONE', 'FAILED', 'RETAINED']).default('PENDING'),
  })
  .strict();

export type EngineeringWorkspace = z.output<typeof EngineeringWorkspaceSchema>;

export interface WorkspaceManagerDeps {
  readonly store: Store;
  readonly git: GitService;
  readonly clock: Clock;
  readonly projectRoot: string;
}

export interface CreateWorkspaceRequest {
  readonly projectId: string;
  readonly workItemId: string;
  readonly attempt: number;
  readonly producerAgentId: string;
  readonly baseCommit: string;
  readonly expectedScope: { allow: readonly string[]; forbid: readonly string[] };
  readonly sandboxProfileDigest: string;
  readonly substrateClass: string;
}

export class EngineeringWorkspaceManager {
  constructor(private readonly deps: WorkspaceManagerDeps) {}

  /**
   * Worktrees live OUTSIDE the repository, as a sibling of the project directory.
   *
   * Putting them inside was the obvious choice and it is wrong: a worktree under the
   * project root appears in the primary checkout's `git status` as untracked content,
   * so the owner's tree is no longer clean, `git add .` would sweep an entire
   * engineering attempt into a commit, and the reconciliation check for a dirty
   * checkout would fire on Serva's own scaffolding.
   *
   * They also cannot live under `.serva`: every governed run is denied that path, and
   * a Producer has to be able to write to its own worktree.
   *
   * The project root's digest is in the directory name so two projects with the same
   * basename cannot collide.
   */
  workspacesRoot(): string {
    const root = resolve(this.deps.projectRoot);
    const name = basename(root) + '-' + digestOf(root).slice(0, 8);
    return resolve(root, '..', '.serva-' + WORKSPACES_DIRNAME, name);
  }

  /**
   * Deterministic identity: `serva/<work-item>/<attempt>`.
   *
   * Every segment is validated against the store's confinement rule, so an identifier
   * that could traverse is refused before it becomes a path (Phase 2 blocker 4).
   */
  identityFor(workItemId: string, attempt: number): { workspaceId: string; branch: string } {
    assertSafeSegment(workItemId, 'work item id');
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 999) {
      return fail({
        code: 'E_VALIDATION',
        message: 'Attempt number out of range: ' + String(attempt),
        remedy: 'Attempts are small positive integers assigned by the rework loop.',
        details: { attempt },
      });
    }
    const suffix = String(attempt).padStart(2, '0');
    return {
      workspaceId: workItemId + '-a' + suffix,
      branch: 'serva/' + workItemId + '/' + suffix,
    };
  }

  pathFor(workspaceId: string): string {
    assertSafeSegment(workspaceId, 'workspace id');
    const root = this.workspacesRoot();
    const p = resolve(root, workspaceId);
    // Belt and braces: even a validated segment is proved to land inside the root.
    if (!(p === root || p.startsWith(root.endsWith(sep) ? root : root + sep))) {
      return fail({
        code: 'E_ISOLATION',
        message: 'Workspace path escapes the workspaces root: ' + p,
        remedy: 'Workspace paths are derived from Serva identifiers and never from input.',
        details: { root, path: p },
        specRef: 'Phase 4 §6',
      });
    }
    return p;
  }

  async create(req: CreateWorkspaceRequest): Promise<EngineeringWorkspace> {
    const { workspaceId, branch } = this.identityFor(req.workItemId, req.attempt);
    const path = this.pathFor(workspaceId);

    if (existsSync(path)) {
      return fail({
        code: 'E_CONFLICT',
        message: 'Workspace ' + workspaceId + ' already exists at ' + path,
        remedy:
          'Each attempt gets a fresh worktree. Remove the previous one, or use the next attempt number.',
        details: { workspaceId, path },
      });
    }

    if (await this.deps.git.branchExists(branch)) {
      return fail({
        code: 'E_CONFLICT',
        message: 'Branch ' + branch + ' already exists',
        remedy: 'Serva derives one branch per attempt; reusing one would blur two attempts.',
        details: { branch },
      });
    }

    mkdirSync(this.workspacesRoot(), { recursive: true });
    const added = await this.deps.git.addWorktree(path, branch, req.baseCommit);
    if (!added.ok) {
      return fail({
        code: 'E_INTERNAL',
        message: 'Could not create the engineering worktree for ' + workspaceId,
        remedy: 'The repository refused the worktree. Nothing was changed.',
        details: { path, branch, stderr: added.stderr.slice(0, 500) },
      });
    }

    const workspace = EngineeringWorkspaceSchema.parse({
      workspaceId,
      projectId: req.projectId,
      workItemId: req.workItemId,
      attempt: req.attempt,
      producerAgentId: req.producerAgentId,
      baseCommit: req.baseCommit,
      branch,
      path,
      createdAt: this.deps.clock.now(),
      state: WorkspaceState.CREATED,
      expectedScope: { allow: [...req.expectedScope.allow], forbid: [...req.expectedScope.forbid] },
      sandboxProfileDigest: req.sandboxProfileDigest,
      substrateClass: req.substrateClass,
      cleanupState: 'PENDING',
    });

    this.tx((tx) => {
      tx.putWorking(WORKSPACE_CANON_TYPE, workspaceId, workspace);
      audit(tx, {
        action: AuditAction.WORKSPACE_CREATED,
        subject: workspaceId,
        outcome: 'OK',
        detail: { workItemId: req.workItemId, attempt: req.attempt, branch },
      });
    });
    return workspace;
  }

  get(workspaceId: string): EngineeringWorkspace | undefined {
    assertSafeSegment(workspaceId, 'workspace id');
    const env = this.deps.store.getWorking<unknown>(WORKSPACE_CANON_TYPE, workspaceId);
    if (env === undefined) return undefined;
    const parsed = EngineeringWorkspaceSchema.safeParse(env.body);
    return parsed.success ? parsed.data : undefined;
  }

  list(): EngineeringWorkspace[] {
    return this.deps.store
      .listWorkingIds(WORKSPACE_CANON_TYPE)
      .map((id) => this.get(id))
      .filter((w): w is EngineeringWorkspace => w !== undefined);
  }

  update(workspaceId: string, patch: Partial<EngineeringWorkspace>): EngineeringWorkspace {
    const current = this.get(workspaceId);
    if (current === undefined) {
      return fail({
        code: 'E_NOT_FOUND',
        message: 'No engineering workspace ' + workspaceId,
        remedy: 'Workspaces are created by the factory and recorded before use.',
        details: { workspaceId },
      });
    }
    const next = EngineeringWorkspaceSchema.parse({ ...current, ...patch });
    this.tx((tx) => {
      tx.putWorking(WORKSPACE_CANON_TYPE, workspaceId, next);
    });
    return next;
  }

  /**
   * Remove a worktree.
   *
   * `force` exists because an abandoned worktree with local edits cannot be removed
   * otherwise — but it is never the default, and the caller has to decide. Discarding
   * work is a choice somebody makes, not something cleanup does on the way past.
   */
  async remove(workspaceId: string, force = false): Promise<void> {
    const w = this.get(workspaceId);
    if (w === undefined) return;
    const r = await this.deps.git.removeWorktree(w.path, force);
    if (!r.ok && existsSync(w.path)) {
      this.update(workspaceId, { cleanupState: 'FAILED' });
      fail({
        code: 'E_INTERNAL',
        message: 'Could not remove worktree ' + workspaceId,
        remedy:
          'The worktree still holds changes git will not discard. Inspect it before forcing removal.',
        details: { path: w.path, stderr: r.stderr.slice(0, 400) },
      });
    }
    rmSync(w.path, { recursive: true, force: true });
    this.update(workspaceId, { state: WorkspaceState.REMOVED, cleanupState: 'DONE' });
    this.tx((tx) => {
      audit(tx, {
        action: AuditAction.WORKSPACE_REMOVED,
        subject: workspaceId,
        outcome: 'OK',
        detail: { path: w.path, forced: force },
      });
    });
  }

  /**
   * Is `candidate` inside this workspace, after resolving symlinks?
   *
   * Used to prove a write landed where it was allowed to. Resolving first is the point:
   * a check on the path as written is a check with a documented bypass.
   */
  containsPath(workspace: EngineeringWorkspace, candidate: string): boolean {
    const root = safeRealpath(workspace.path);
    const real = safeRealpath(candidate);
    return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
  }

  /** Paths that must never be writable by a Producer, whatever its scope says. */
  protectedPaths(): string[] {
    const root = resolve(this.deps.projectRoot);
    return [root, join(root, '.serva'), join(root, '.git'), this.workspacesRoot()];
  }

  private tx(f: (tx: Transaction) => void): void {
    const tx = this.deps.store.begin();
    f(tx);
    tx.commit();
  }
}
