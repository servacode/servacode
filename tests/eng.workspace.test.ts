import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  FORBIDDEN_GIT_VERBS,
  GitService,
  assertNotOptionLike,
  assertSafeRef,
  parseNameStatusZ,
  parsePorcelainZ,
} from '../src/engineering/git.js';
import { EngineeringWorkspaceManager, WorkspaceState } from '../src/engineering/workspace.js';
import { CHANGESET_CANON_TYPE } from '../src/engineering/changeset.js';
import {
  buildChangeSet,
  checkScopeConformance,
  matchesPrefix,
} from '../src/engineering/changeset.js';
import { reconcileWorkspaces, DivergenceKind } from '../src/engineering/reconcile.js';
import { buildSandboxProfile, sandboxProfileDrift } from '../src/engineering/sandboxProfile.js';
import { cleanup, freshStore } from './helpers.js';
import type { Store } from '../src/store/store.js';

/**
 * WORKSPACE ISOLATION, GIT AUTHORITY AND RECONCILIATION.
 *
 * These run against a REAL temporary Git repository, because the properties being
 * tested — a worktree is genuinely separate, the primary checkout is genuinely
 * untouched — are properties of Git, and a mock would only test the mock.
 */

const roots: string[] = [];
const repos: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
  for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A disposable repository with one commit. Never the Serva source tree. */
function makeRepo(): { repo: string; base: string } {
  const { root } = freshStore();
  roots.push(root);
  const repo = join(root, 'fixture-repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@localhost');
  git('config', 'user.name', 'Fixture');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# fixture\n', 'utf8');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n', 'utf8');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  return { repo, base };
}

function managerFor(repo: string): {
  mgr: EngineeringWorkspaceManager;
  git: GitService;
  store: Store;
} {
  const { store, root, deps } = freshStore();
  roots.push(root);
  const git = new GitService({ repoRoot: repo });
  const mgr = new EngineeringWorkspaceManager({
    store,
    git,
    clock: deps.clock,
    projectRoot: repo,
  });
  return { mgr, git, store };
}

const SCOPE = { allow: ['src/'], forbid: ['src/forbidden/'] };

/* ============================================= git authority */

describe('Serva owns Git, and the verb set is closed', () => {
  it('refuses every publishing and history-rewriting verb', async () => {
    const { repo } = makeRepo();
    const git = new GitService({ repoRoot: repo });
    for (const verb of ['push', 'merge', 'rebase', 'remote', 'config', 'reset']) {
      await expect(
        (git as unknown as { git: (a: string[]) => Promise<unknown> })['git']([verb]),
      ).rejects.toThrowError(/not a Phase 4 capability/);
    }
  });

  it('the forbidden list names what Phase 4 must never do', () => {
    for (const v of ['push', 'merge', 'rebase', 'remote', 'config']) {
      expect(FORBIDDEN_GIT_VERBS).toContain(v);
    }
  });

  it('an option-like value is refused even though it travels in an array', () => {
    // argv separation defeats the SHELL. It does nothing about git's own option parser,
    // which will happily read --upload-pack= from a position expecting a ref.
    expect(() => assertNotOptionLike('--upload-pack=evil', 'ref')).toThrowError(/may not begin/);
    expect(() => assertSafeRef('--exec=rm')).toThrowError();
  });

  it('a ref name is narrow by construction', () => {
    expect(() => assertSafeRef('serva/SC-WI-1/01')).not.toThrow();
    expect(() => assertSafeRef('a b')).toThrowError(/Unsafe git ref/);
    expect(() => assertSafeRef('a/../b')).toThrowError(/Unsafe git ref/);
    expect(() => assertSafeRef('x.lock')).toThrowError(/Unsafe git ref/);
  });

  it('parses NUL-delimited status and diff output', () => {
    expect(parsePorcelainZ('?? new.txt\0 M src/a.js\0')).toEqual([
      { status: '?', path: 'new.txt' },
      { status: 'M', path: 'src/a.js' },
    ]);
    const renamed = parseNameStatusZ('M\0src/a.js\0R100\0old.js\0new.js\0');
    expect(renamed[0]).toEqual({ status: 'M', path: 'src/a.js' });
    expect(renamed[1]).toMatchObject({ status: 'R', path: 'new.js', from: 'old.js' });
  });
});

/* ============================================= worktree isolation */

describe('a Producer never touches the primary checkout', () => {
  it('creates an isolated worktree on its own branch', async () => {
    const { repo, base } = makeRepo();
    const { mgr, git } = managerFor(repo);
    const w = await mgr.create({
      projectId: repo,
      workItemId: 'SC-WI-000001',
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });
    expect(existsSync(w.path)).toBe(true);
    expect(resolve(w.path)).not.toBe(resolve(repo));
    expect(w.branch).toBe('serva/SC-WI-000001/01');
    expect(await git.currentBranch(repo)).toBe('main');
    expect(await git.currentBranch(w.path)).toBe(w.branch);
  });

  it('editing the worktree leaves the primary checkout byte-clean', async () => {
    const { repo, base } = makeRepo();
    const { mgr, git } = managerFor(repo);
    const w = await mgr.create({
      projectId: repo,
      workItemId: 'SC-WI-000002',
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });
    const before = readFileSync(join(repo, 'src', 'app.js'), 'utf8');
    writeFileSync(join(w.path, 'src', 'app.js'), 'module.exports = 2;\n', 'utf8');

    expect(readFileSync(join(repo, 'src', 'app.js'), 'utf8')).toBe(before);
    expect(await git.isClean(repo)).toBe(true);
    expect(await git.isClean(w.path)).toBe(false);
  });

  it('two attempts get separate worktrees that cannot see each other', async () => {
    const { repo, base } = makeRepo();
    const { mgr } = managerFor(repo);
    const a = await mgr.create({
      projectId: repo,
      workItemId: 'SC-WI-000003',
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });
    const b = await mgr.create({
      projectId: repo,
      workItemId: 'SC-WI-000003',
      attempt: 2,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });
    expect(a.path).not.toBe(b.path);
    writeFileSync(join(a.path, 'src', 'app.js'), 'A\n', 'utf8');
    expect(readFileSync(join(b.path, 'src', 'app.js'), 'utf8')).not.toContain('A');
    expect(mgr.containsPath(a, join(b.path, 'src', 'app.js'))).toBe(false);
  });

  it('a workspace id that could traverse is refused before it becomes a path', () => {
    const { repo } = makeRepo();
    const { mgr } = managerFor(repo);
    for (const bad of ['..', '../../etc', 'a/b', '.']) {
      expect(() => mgr.pathFor(bad), bad).toThrowError();
    }
  });

  it('the same attempt cannot be opened twice', async () => {
    const { repo, base } = makeRepo();
    const { mgr } = managerFor(repo);
    const req = {
      projectId: repo,
      workItemId: 'SC-WI-000004',
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    };
    await mgr.create(req);
    await expect(mgr.create(req)).rejects.toThrowError(/already exists/);
  });

  it('the protected paths include the checkout, the store and git metadata', () => {
    const { repo } = makeRepo();
    const { mgr } = managerFor(repo);
    const p = mgr.protectedPaths().map((x) => resolve(x));
    expect(p).toContain(resolve(repo));
    expect(p).toContain(resolve(repo, '.serva'));
    expect(p).toContain(resolve(repo, '.git'));
  });

  it('removal is recorded and the directory is gone', async () => {
    const { repo, base } = makeRepo();
    const { mgr } = managerFor(repo);
    const w = await mgr.create({
      projectId: repo,
      workItemId: 'SC-WI-000005',
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });
    await mgr.remove(w.workspaceId);
    expect(existsSync(w.path)).toBe(false);
    expect(mgr.get(w.workspaceId)?.state).toBe(WorkspaceState.REMOVED);
  });
});

/* ============================================= change set and scope */

describe('Serva computes the change set and judges it against the declared scope', () => {
  async function withChange(
    edit: (worktree: string) => void,
    workItemId = 'SC-WI-000010',
  ): Promise<{
    changeSet: Awaited<ReturnType<typeof buildChangeSet>>;
    workspace: Awaited<ReturnType<EngineeringWorkspaceManager['create']>>;
  }> {
    const { repo, base } = makeRepo();
    const { mgr, git, store } = managerFor(repo);
    const { deps } = freshStore();
    const workspace = await mgr.create({
      projectId: repo,
      workItemId,
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });
    edit(workspace.path);
    const changeSet = await buildChangeSet(
      { store, git, clock: deps.clock, ids: deps.ids },
      workspace,
    );
    return { changeSet, workspace };
  }

  it('observes a modification without being told about it', async () => {
    const { changeSet } = await withChange((w) => {
      writeFileSync(join(w, 'src', 'app.js'), 'module.exports = 2;\n', 'utf8');
    });
    expect(changeSet.entries.map((e) => e.path)).toContain('src/app.js');
    expect(changeSet.digest).toHaveLength(64);
  });

  it('observes an untracked addition, which a diff against a commit would miss', async () => {
    const { changeSet } = await withChange((w) => {
      writeFileSync(join(w, 'src', 'new.js'), 'x\n', 'utf8');
    });
    expect(changeSet.entries.map((e) => e.path)).toContain('src/new.js');
  });

  it('a change outside the declared scope is a finding', async () => {
    const { changeSet, workspace } = await withChange((w) => {
      writeFileSync(join(w, 'README.md'), '# changed\n', 'utf8');
    });
    const r = checkScopeConformance(workspace, changeSet, SCOPE);
    expect(r.conformant).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('OUTSIDE_ALLOWED_SCOPE');
  });

  it('a change inside the declared scope is conformant', async () => {
    const { changeSet, workspace } = await withChange((w) => {
      writeFileSync(join(w, 'src', 'app.js'), 'module.exports = 2;\n', 'utf8');
    });
    expect(checkScopeConformance(workspace, changeSet, SCOPE).conformant).toBe(true);
  });

  it('a credential-shaped file is a finding whatever the scope allows', async () => {
    const { changeSet, workspace } = await withChange((w) => {
      writeFileSync(join(w, 'src', '.env'), 'A=1\n', 'utf8');
    });
    const r = checkScopeConformance(workspace, changeSet, SCOPE);
    expect(r.findings.map((f) => f.kind)).toContain('CREDENTIAL_FILE');
  });

  it('an unauthorized lockfile change is a finding', async () => {
    const { changeSet, workspace } = await withChange((w) => {
      writeFileSync(join(w, 'package-lock.json'), '{}\n', 'utf8');
    });
    const r = checkScopeConformance(workspace, changeSet, { allow: [''], forbid: [] });
    expect(r.findings.map((f) => f.kind)).toContain('LOCKFILE_CHANGED');
  });

  it('an unexpected binary is a finding, because nobody can review it', async () => {
    const { changeSet, workspace } = await withChange((w) => {
      writeFileSync(join(w, 'src', 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]));
    });
    const r = checkScopeConformance(workspace, changeSet, SCOPE);
    expect(r.findings.map((f) => f.kind)).toContain('UNEXPECTED_BINARY');
  });

  it('a symlink is a finding, because it can redirect a later write', async () => {
    const { repo, base } = makeRepo();
    const { mgr, git, store } = managerFor(repo);
    const { deps } = freshStore();
    const workspace = await mgr.create({
      projectId: repo,
      workItemId: 'SC-WI-000020',
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });
    try {
      symlinkSync(join(repo, 'README.md'), join(workspace.path, 'src', 'link.md'));
    } catch {
      return; // symlink creation needs privilege on some Windows configurations
    }
    const changeSet = await buildChangeSet(
      { store, git, clock: deps.clock, ids: deps.ids },
      workspace,
    );
    const r = checkScopeConformance(workspace, changeSet, SCOPE);
    expect(
      r.findings.some((f) => f.kind === 'UNEXPECTED_SYMLINK' || f.kind === 'ESCAPES_WORKSPACE'),
    ).toBe(true);
  });

  it('a prefix match respects whole path segments', () => {
    expect(matchesPrefix('src/a.js', 'src')).toBe(true);
    expect(matchesPrefix('srcret/a.js', 'src')).toBe(false);
    expect(matchesPrefix('src/a.js', 'src/a.js')).toBe(true);
  });

  it('editing the code produces a different ChangeSet identity', async () => {
    const first = await withChange((w) => {
      writeFileSync(join(w, 'src', 'app.js'), 'A\n', 'utf8');
    });
    const second = await withChange((w) => {
      writeFileSync(join(w, 'src', 'app.js'), 'B\n', 'utf8');
    }, 'SC-WI-000011');
    expect(first.changeSet.digest).not.toBe(second.changeSet.digest);
  });
});

/* ============================================= sandbox profile */

describe('the sandbox profile is generated by Serva and fails closed', () => {
  it('enables the sandbox and closes both escape hatches', () => {
    const p = buildSandboxProfile({ worktreePath: 'D:/p/wt', projectRoot: 'D:/p' });
    const sandbox = p.settings['sandbox'] as Record<string, unknown>;
    expect(sandbox['enabled']).toBe(true);
    // A sandbox that cannot start must stop the run rather than warn and continue.
    expect(sandbox['failIfUnavailable']).toBe(true);
    // No retry-without-the-sandbox; dangerouslyDisableSandbox becomes inert.
    expect(sandbox['allowUnsandboxedCommands']).toBe(false);
    expect(sandbox['excludedCommands']).toEqual([]);
  });

  it('grants write to the worktree and denies the checkout and the store', () => {
    const p = buildSandboxProfile({ worktreePath: 'D:/p/wt', projectRoot: 'D:/p' });
    const fs = (p.settings['sandbox'] as Record<string, unknown>)['filesystem'] as Record<
      string,
      string[]
    >;
    expect(fs['allowWrite']).toEqual([resolve('D:/p/wt')]);
    expect(fs['denyWrite']).toContain(resolve('D:/p'));
    const denyRead = fs['denyRead'] ?? [];
    expect(denyRead.some((x) => x.includes('.ssh'))).toBe(true);
    expect(denyRead.some((x) => x.includes('.claude'))).toBe(true);
  });

  it('network is an EMPTY ALLOWLIST unless explicitly granted', () => {
    /*
     * `{ enabled: false }` was not a key the engine validates, and a settings file that
     * fails validation is silently ignored — so this one malformed key voided the whole
     * profile. The write protections still looked right because they come from the
     * default policy; the read protections were simply gone, and a real Producer read
     * the Serva store through Bash.
     */
    const off = buildSandboxProfile({ worktreePath: 'D:/p/wt', projectRoot: 'D:/p' });
    const network = (off.settings['sandbox'] as Record<string, Record<string, unknown>>)['network'];
    /*
     * An empty allowlist alone is not a denial: without `strictAllowlist` an unlisted
     * host is a PROMPT, and a noninteractive Producer's prompt is answered by the
     * permission mode rather than by a person. The pair is what makes it "no egress".
     */
    expect(network).toEqual({ allowedDomains: [], strictAllowlist: true });
    expect(network).not.toHaveProperty('enabled');
  });

  it('drift between the intended and the effective policy is detected', () => {
    const intended = buildSandboxProfile({ worktreePath: 'D:/p/wt', projectRoot: 'D:/p' });
    expect(sandboxProfileDrift(intended, undefined)).toMatch(/no effective sandbox policy/);
    expect(
      sandboxProfileDrift(intended, { sandbox: { enabled: true, failIfUnavailable: false } }),
    ).toMatch(/failIfUnavailable/);
    expect(
      sandboxProfileDrift(intended, {
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          excludedCommands: ['npm'],
        },
      }),
    ).toMatch(/excludes commands/);
    expect(
      sandboxProfileDrift(intended, {
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          allowUnsandboxedCommands: false,
          excludedCommands: [],
        },
      }),
    ).toBeUndefined();
  });

  it('the digest changes when the policy changes', () => {
    const a = buildSandboxProfile({ worktreePath: 'D:/p/wt', projectRoot: 'D:/p' });
    const b = buildSandboxProfile({
      worktreePath: 'D:/p/wt',
      projectRoot: 'D:/p',
      networkAllowed: true,
    });
    expect(a.digest).not.toBe(b.digest);
  });
});

/* ============================================= reconciliation */

describe('reconciliation reports divergence and never repairs by overwriting', () => {
  it('a clean project with no workspaces reports nothing', async () => {
    const { repo } = makeRepo();
    const { mgr, git, store } = managerFor(repo);
    const { deps } = freshStore();
    const report = await reconcileWorkspaces({ store, git, workspaces: mgr, clock: deps.clock });
    expect(report.primaryCheckoutClean).toBe(true);
    expect(report.divergences).toEqual([]);
  });

  it('a dirty primary checkout is reported and is never self-repairable', async () => {
    const { repo } = makeRepo();
    const { mgr, git, store } = managerFor(repo);
    const { deps } = freshStore();
    writeFileSync(join(repo, 'src', 'app.js'), 'owner edit\n', 'utf8');

    const report = await reconcileWorkspaces({ store, git, workspaces: mgr, clock: deps.clock });
    const d = report.divergences.find((x) => x.kind === DivergenceKind.DIRTY_PRIMARY_CHECKOUT)!;
    expect(d).toBeDefined();
    expect(d.selfRepairable).toBe(false);
    expect(d.remedy).toMatch(/does not stash, revert or clean/);
    // And the owner's edit is still there afterwards.
    expect(readFileSync(join(repo, 'src', 'app.js'), 'utf8')).toBe('owner edit\n');
  });

  it('a missing worktree directory is detected as its own condition', async () => {
    const { repo, base } = makeRepo();
    const { mgr, git, store } = managerFor(repo);
    const { deps } = freshStore();
    const w = await mgr.create({
      projectId: repo,
      workItemId: 'SC-WI-000030',
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });
    rmSync(w.path, { recursive: true, force: true });

    const report = await reconcileWorkspaces({ store, git, workspaces: mgr, clock: deps.clock });
    expect(report.divergences.map((d) => d.kind)).toContain(DivergenceKind.MISSING_WORKTREE);
  });

  it('an external edit to a verified workspace makes its verification stale', async () => {
    const { repo, base } = makeRepo();
    const { mgr, git, store } = managerFor(repo);
    const { deps } = freshStore();
    const w = await mgr.create({
      projectId: repo,
      workItemId: 'SC-WI-000031',
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });
    mgr.update(w.workspaceId, { state: WorkspaceState.VERIFIED });
    writeFileSync(join(w.path, 'src', 'app.js'), 'edited outside serva\n', 'utf8');

    const report = await reconcileWorkspaces({ store, git, workspaces: mgr, clock: deps.clock });
    const d = report.divergences.find((x) => x.kind === DivergenceKind.EXTERNAL_WORKSPACE_CHANGE)!;
    expect(d).toBeDefined();
    expect(d.remedy).toMatch(/Do not carry the earlier result forward/);
  });
});

/* ====== HIGH: four DivergenceKind values that could never be produced ====== */

describe('every declared divergence kind can actually be detected', () => {
  /*
   * SPEC: HIGH finding RECONCILIATION/RECON-1.
   *
   * `DivergenceKind` declared BRANCH_MOVED, INTERRUPTED_PRODUCER_RUN, UNVERIFIED_CHANGESET and
   * ACCEPTED_NOT_INTEGRATED — four categories central to the module's own stated purpose of
   * stopping a gate from trusting stale evidence — and `reconcileWorkspaces()` never
   * constructed any of them. They were vocabulary, not detection.
   *
   * An enum value nothing can emit is worse than a missing feature: the vocabulary reads as a
   * completed threat model, and `invalidatesEvidence()` looks like it filters for conditions
   * that in fact could never arrive.
   */
  it('reports an UNVERIFIED_CHANGESET when a change set has no evidence at all', async () => {
    const { repo, base } = makeRepo();
    const { mgr, git, store } = managerFor(repo);
    const { deps } = freshStore();
    const w = await mgr.create({
      projectId: repo,
      workItemId: 'SC-WI-000040',
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });

    /*
     * The workspace has been used: a change set exists. A freshly CREATED workspace with no
     * evidence yet is the ordinary state at the start of a run, not a divergence.
     */
    mgr.update(w.workspaceId, { state: WorkspaceState.IN_USE });

    const tx = store.begin();
    tx.putCanon(CHANGESET_CANON_TYPE, 'SC-CS-000040', {
      changeSetId: 'SC-CS-000040',
      workItemId: 'SC-WI-000040',
      workspaceId: w.workspaceId,
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      producerRunId: 'SC-RUN-000040',
      baseCommit: base,
      headCommit: '',
      entries: [],
      diffDigest: 'd'.repeat(64),
      digest: 'e'.repeat(64),
      createdAt: '2026-08-25T00:00:00.000Z',
    });
    tx.commit();

    const report = await reconcileWorkspaces({ store, git, workspaces: mgr, clock: deps.clock });
    expect(report.divergences.map((d) => d.kind)).toContain(DivergenceKind.UNVERIFIED_CHANGESET);
  });

  it('reports an INTERRUPTED_PRODUCER_RUN when a producer run never terminated', async () => {
    const { repo, base } = makeRepo();
    const { mgr, git, store } = managerFor(repo);
    const { deps } = freshStore();
    const w = await mgr.create({
      projectId: repo,
      workItemId: 'SC-WI-000041',
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });

    const tx = store.begin();
    tx.putCanon(CHANGESET_CANON_TYPE, 'SC-CS-000041', {
      changeSetId: 'SC-CS-000041',
      workItemId: 'SC-WI-000041',
      workspaceId: w.workspaceId,
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      producerRunId: 'SC-RUN-000041',
      baseCommit: base,
      headCommit: '',
      entries: [],
      diffDigest: 'd'.repeat(64),
      digest: 'e'.repeat(64),
      createdAt: '2026-08-25T00:00:00.000Z',
    });
    /* A run record that exists but never reached a terminal outcome. */
    tx.putCanon('agentRunRecord', 'SC-RUN-000041', {
      runId: 'SC-RUN-000041',
      agentId: 'SC-AGENT-150',
      terminal: false,
    });
    tx.commit();

    const report = await reconcileWorkspaces({ store, git, workspaces: mgr, clock: deps.clock });
    expect(report.divergences.map((d) => d.kind)).toContain(
      DivergenceKind.INTERRUPTED_PRODUCER_RUN,
    );
  });

  it('reports ACCEPTED_NOT_INTEGRATED when an accepted change set never landed', async () => {
    const { repo, base } = makeRepo();
    const { mgr, git, store } = managerFor(repo);
    const { deps } = freshStore();
    const w = await mgr.create({
      projectId: repo,
      workItemId: 'SC-WI-000042',
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });
    mgr.update(w.workspaceId, { state: WorkspaceState.ACCEPTED });

    const tx = store.begin();
    tx.putCanon(CHANGESET_CANON_TYPE, 'SC-CS-000042', {
      changeSetId: 'SC-CS-000042',
      workItemId: 'SC-WI-000042',
      workspaceId: w.workspaceId,
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      producerRunId: 'SC-RUN-000042',
      baseCommit: base,
      /* Accepted, and never integrated: no head commit was ever recorded. */
      headCommit: '',
      entries: [],
      diffDigest: 'd'.repeat(64),
      digest: 'e'.repeat(64),
      createdAt: '2026-08-25T00:00:00.000Z',
    });
    tx.commit();

    const report = await reconcileWorkspaces({ store, git, workspaces: mgr, clock: deps.clock });
    expect(report.divergences.map((d) => d.kind)).toContain(DivergenceKind.ACCEPTED_NOT_INTEGRATED);
  });

  it('reports BRANCH_MOVED when a recorded branch points somewhere Serva did not put it', async () => {
    const { repo, base } = makeRepo();
    const { mgr, git, store } = managerFor(repo);
    const { deps } = freshStore();
    const w = await mgr.create({
      projectId: repo,
      workItemId: 'SC-WI-000043',
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });

    /* Someone commits on the branch outside Serva, so its tip is no longer what Serva knows. */
    writeFileSync(join(w.path, 'outside.txt'), 'not through Serva\n', 'utf8');
    await git.stagePaths(['outside.txt'], w.path);
    await git.commit('outside Serva', w.path);

    const report = await reconcileWorkspaces({ store, git, workspaces: mgr, clock: deps.clock });
    const kinds = report.divergences.map((d) => d.kind);
    expect(
      kinds.includes(DivergenceKind.BRANCH_MOVED) ||
        kinds.includes(DivergenceKind.WORKTREE_HEAD_MOVED),
    ).toBe(true);
  });

  it('every declared kind is reachable from the detector', () => {
    /*
     * The structural property, so a kind added later cannot quietly become vocabulary again.
     * Read from the source rather than from a list a test maintains beside it.
     */
    const source = readFileSync('src/engineering/reconcile.ts', 'utf8');
    for (const kind of Object.values(DivergenceKind)) {
      const emitted = source.includes('kind: DivergenceKind.' + kind);
      expect(emitted, kind + ' is declared but never emitted').toBe(true);
    }
  });
});
