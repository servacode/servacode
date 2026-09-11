import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  renameSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ALLOWED_GIT_VERBS,
  FORBIDDEN_GIT_VERBS,
  GitService,
  assertNotOptionLike,
  assertSafeRef,
  parseNameStatusZ,
  parsePorcelainZ,
} from '../src/engineering/git.js';
import type { GitRunner } from '../src/engineering/git.js';
import { EngineeringWorkspaceManager, WorkspaceState } from '../src/engineering/workspace.js';
import { CHANGESET_CANON_TYPE } from '../src/engineering/changeset.js';
import {
  buildChangeSet,
  checkScopeConformance,
  matchesPrefix,
} from '../src/engineering/changeset.js';
import { reconcileWorkspaces, DivergenceKind } from '../src/engineering/reconcile.js';
import { buildSandboxProfile, sandboxProfileDrift } from '../src/engineering/sandboxProfile.js';
import { scanChangeSetForSecrets } from '../src/engineering/secrets.js';
import { recordEvidence } from '../src/engineering/execution.js';
import { EvidenceClass } from '../src/vocab/index.js';
import type { SecretsScanResult } from '../src/engineering/secrets.js';
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
      ).rejects.toThrowError(/not one of the operations this service performs/);
    }
  });

  it('refuses a verb nobody thought to forbid, because the set is CLOSED', async () => {
    /*
     * SPEC: finding GIT-INTEGRITY-01 (MEDIUM), 1.0.1 security review.
     *
     * The header promised a closed verb set "absent by construction rather than blocked by a
     * check somebody could forget to write", and the choke point was a denylist — so every
     * verb nobody had thought of went through. None of these is on the forbidden list, and
     * `checkout`, `apply` and `update-ref` are quite enough to move a branch or rewrite a
     * worktree under an accepted change.
     */
    const { repo } = makeRepo();
    const git = new GitService({ repoRoot: repo });
    for (const verb of [
      'checkout',
      'restore',
      'stash',
      'update-ref',
      'symbolic-ref',
      'apply',
      'am',
      'cherry-pick',
      'revert',
      'tag',
      'mv',
      'rm',
      'gc',
      'reflog',
    ]) {
      expect(FORBIDDEN_GIT_VERBS, verb + ' is the point: nobody forbade it').not.toContain(verb);
      await expect(
        (git as unknown as { git: (a: string[]) => Promise<unknown> })['git']([verb]),
        verb + ' passed a closed verb set',
      ).rejects.toThrowError(/not one of the operations this service performs/);
    }
  });

  it('an invocation carrying no subcommand at all is refused', async () => {
    /* All flags and no verb is not an operation; it used to fall through the guard entirely. */
    const { repo } = makeRepo();
    const git = new GitService({ repoRoot: repo });
    await expect(
      (git as unknown as { git: (a: string[]) => Promise<unknown> })['git'](['--no-pager']),
    ).rejects.toThrowError(/no subcommand/);
  });

  it('a repository hook does not execute on the host when Serva commits', async () => {
    /*
     * SPEC: finding GIT-INT-REVIEW-1 (MEDIUM), 1.0.1 security review.
     *
     * The git runner spawns on the HOST, outside the sandbox. Without --no-verify, a ChangeSet
     * produced by a governed agent makes `.git/hooks/pre-commit` — arbitrary code supplied by
     * the repository being changed — run unsandboxed, which is the thing the HARD boundary
     * exists to prevent.
     *
     * Proven by consequence rather than by reading the argv: the hook writes a file, and the
     * absence of that file is the evidence it did not run.
     */
    const { repo } = makeRepo();
    const git = new GitService({ repoRoot: repo });
    const hookDir = join(repo, '.git', 'hooks');
    mkdirSync(hookDir, { recursive: true });
    const marker = join(repo, 'HOOK_RAN.txt');
    const hook = join(hookDir, 'pre-commit');
    const NL = String.fromCharCode(10);
    const posixMarker = marker.split(String.fromCharCode(92)).join('/');
    writeFileSync(hook, '#!/bin/sh' + NL + 'touch "' + posixMarker + '"' + NL, 'utf8');
    chmodSync(hook, 0o755);

    writeFileSync(join(repo, 'hooked.txt'), 'x' + String.fromCharCode(10), 'utf8');
    await git.stagePaths(['hooked.txt'], repo);
    await git.commit('a change that must not run repository code', repo);

    expect(existsSync(marker), 'the repository hook ran on the host').toBe(false);
  }, 30_000);

  it('nothing forbidden can appear in the allowed set, by construction', () => {
    /*
     * The two lists are tied together in the SOURCE — the allowed set is derived by removing
     * the forbidden one — so this cannot be broken by editing a list, only by removing the
     * derivation. Asserted anyway: the property is what matters, not how it is currently got.
     */
    for (const v of FORBIDDEN_GIT_VERBS) {
      expect(ALLOWED_GIT_VERBS, v + ' is both allowed and forbidden').not.toContain(v);
    }
    expect(ALLOWED_GIT_VERBS.length, 'the verb set is small and deliberate').toBe(11);
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

  it('an empty scope entry allows nothing, rather than everything', async () => {
    /*
     * SPEC: finding GIT-INT-REVIEW-2 (MEDIUM), 1.0.1 security review.
     *
     * `matchesPrefix` returned true for an empty prefix, and the conformance check reads
     * `!allow.some((a) => matchesPrefix(path, a))`. So one empty string anywhere in
     * `allowedScope` put the WHOLE repository in scope — the fail-open this module was already
     * corrected for once, arriving through a data value instead of through a branch.
     *
     * The direction matters in both callers: an empty allow entry now allows nothing, and an
     * empty forbid entry forbids nothing.
     */
    expect(matchesPrefix('README.md', ''), 'an empty prefix matches nothing').toBe(false);

    const { changeSet, workspace } = await withChange((w) => {
      writeFileSync(join(w, 'README.md'), '# changed' + String.fromCharCode(10), 'utf8');
    });
    const r = checkScopeConformance(workspace, changeSet, { allow: ['', 'src/'], forbid: [] });
    expect(r.conformant, 'an empty entry must not put the repository in scope').toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain('OUTSIDE_ALLOWED_SCOPE');
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

  describe('a scope that allows nothing allows nothing', () => {
    /*
     * SPEC: finding ENGINEERING-GIT-AND-COMMIT-INTEGRITY/F1 (HIGH), 1.0.1 security review.
     *
     * `ScopeOptions.allow` is documented "Empty means nothing is in scope", and the guard read
     * `options.allow.length > 0 && …` — so an empty list produced no finding at all and every
     * path was reported conformant. The comment described a closed door and the code held it
     * open.
     *
     * The factory cannot reach it: its schema requires `allowedScope` to have at least one
     * entry. That is exactly why it survived — nothing exercised the case the contract was
     * written for. `checkScopeConformance` is exported, its contract is what a caller reads,
     * and a fail-open only a future caller can reach is still a fail-open.
     */
    it('an empty allow list puts every path out of scope', async () => {
      const { changeSet, workspace } = await withChange((w) => {
        writeFileSync(join(w, 'src', 'app.js'), 'module.exports = 2;\n', 'utf8');
      });

      const r = checkScopeConformance(workspace, changeSet, { allow: [], forbid: [] });

      expect(r.conformant, 'an undeclared scope must not wave everything through').toBe(false);
      expect(r.findings.map((finding) => finding.kind)).toContain('OUTSIDE_ALLOWED_SCOPE');
    });

    it('and says the scope was never declared, rather than naming an empty list', async () => {
      const { changeSet, workspace } = await withChange((w) => {
        writeFileSync(join(w, 'src', 'app.js'), 'module.exports = 3;\n', 'utf8');
      });

      const r = checkScopeConformance(workspace, changeSet, { allow: [], forbid: [] });
      const outside = r.findings.find((finding) => finding.kind === 'OUTSIDE_ALLOWED_SCOPE');

      expect(outside?.detail).toContain('No scope was declared');
    });

    it('a declared scope still admits what it declares', async () => {
      /* The fix must not put every change out of scope. */
      const { changeSet, workspace } = await withChange((w) => {
        writeFileSync(join(w, 'src', 'app.js'), 'module.exports = 4;\n', 'utf8');
      });

      const r = checkScopeConformance(workspace, changeSet, { allow: ['src/'], forbid: [] });

      expect(r.findings.map((finding) => finding.kind)).not.toContain('OUTSIDE_ALLOWED_SCOPE');
    });
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

/* ============================================= a failed observation is not "nothing changed" */

describe('the observer cannot report nothing when it could not tell', () => {
  /*
   * SPEC: finding ENGINEERING-GIT-AND-COMMIT-INTEGRITY/ENG-GIT-OBS-1 (MEDIUM), 1.0.1 review.
   *
   * Every one of these reads the SAME failure from git and used to answer with the empty
   * value for its return type: no changed paths, an empty diff, an empty blob map, a clean
   * status. The module's stated property is that Serva OBSERVES the change authoritatively,
   * and an observation that failed is not an observation that found nothing.
   */
  const failing: GitRunner = async () => ({
    ok: false,
    stdout: '',
    stderr: 'fatal: not a git repository',
    exitCode: 128,
  });

  it('refuses rather than reporting an empty change set when the diff fails', async () => {
    const git = new GitService({ repoRoot: process.cwd(), runner: failing });
    await expect(git.changedPaths('abc1234', process.cwd())).rejects.toThrow(/could not/i);
  });

  it('refuses rather than reporting an empty diff', async () => {
    const git = new GitService({ repoRoot: process.cwd(), runner: failing });
    await expect(git.diff('abc1234', process.cwd())).rejects.toThrow(/could not/i);
  });

  it('refuses rather than reporting an empty blob map', async () => {
    const git = new GitService({ repoRoot: process.cwd(), runner: failing });
    await expect(git.blobIdsFor(['a.ts'], process.cwd())).rejects.toThrow(/could not/i);
  });

  it('refuses rather than reporting a clean checkout it never read', async () => {
    /*
     * The one the finding did not name and the worst of the four: `isClean` is built on
     * `status`, so a git failure answered the question "is this checkout dirty?" with "no".
     */
    const git = new GitService({ repoRoot: process.cwd(), runner: failing });
    await expect(git.status(process.cwd())).rejects.toThrow(/could not/i);
    await expect(git.isClean(process.cwd())).rejects.toThrow(/could not/i);
  });

  it('still refuses when only the untracked half fails, since that half is the point', async () => {
    /*
     * An untracked file is how a producer writes outside its scope. Losing that listing
     * silently is losing the case the listing exists for.
     */
    let call = 0;
    const halfFailing: GitRunner = async () => {
      call += 1;
      return call === 1
        ? { ok: true, stdout: '', stderr: '', exitCode: 0 }
        : { ok: false, stdout: '', stderr: 'fatal: ls-files died', exitCode: 128 };
    };
    const git = new GitService({ repoRoot: process.cwd(), runner: halfFailing });
    await expect(git.changedPaths('abc1234', process.cwd())).rejects.toThrow(/could not/i);
  });

  it('refuses a blob listing git answered short, rather than pairing the wrong file', async () => {
    const short: GitRunner = async () => ({
      ok: true,
      stdout: 'a'.repeat(40) + '\n',
      stderr: '',
      exitCode: 0,
    });
    const git = new GitService({ repoRoot: process.cwd(), runner: short });
    await expect(git.blobIdsFor(['a.ts', 'b.ts'], process.cwd())).rejects.toThrow(/could not/i);
  });
});

/* ============================================= a file that was never read is not a clean file */

describe('the credential gate cannot pass a file it did not scan', () => {
  /*
   * SPEC: findings SEC-SCAN-LARGEFILE-1 and SEC-SCAN-SKIP-SILENT-2 (both MEDIUM), 1.0.1 review.
   *
   * EC-SECRETS states "The change introduces no committed credential" and is BLOCKING. The
   * scan answered that sentence from the files it managed to read, and computed `blocking`
   * from findings alone - so a credential in a file the scan skipped produced a clean PASS.
   *
   * Two skips, one class. A file over MAX_SCAN_BYTES was disclosed but not counted; a file
   * whose PATH ended in an image extension, or whose entry carried isBinary, was not even
   * disclosed. A guess about a file's content is not a measurement of it.
   */
  /*
   * NOT AWS's documented example key: the rules downgrade a value containing EXAMPLE on
   * purpose, so testing with one would prove the placeholder rule and not the skip rule.
   */
  const AWS = 'AKIA' + 'Z3K7QW9TR5MB2XCD';

  function scanRepo(
    files: { path: string; body: string | Buffer; isBinary?: boolean }[],
  ): SecretsScanResult {
    const { root } = freshStore();
    roots.push(root);
    const dir = join(root, 'scan-fixture');
    mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const abs = join(dir, ...f.path.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.body as never);
    }
    return scanChangeSetForSecrets(
      { path: dir } as never,
      {
        entries: files.map((f) => ({
          path: f.path,
          status: 'A',
          isBinary: f.isBinary === true,
          isSymlink: false,
        })),
      } as never,
    );
  }

  it('does not pass a credential sitting in a file too large to scan', () => {
    const padding = 'x'.repeat(2_000_001);
    const r = scanRepo([{ path: 'src/big.ts', body: padding + '\nconst k = "' + AWS + '";\n' }]);
    expect(r.notScanned.map((n) => n.path)).toContain('src/big.ts');
    expect(r.complete).toBe(false);
    expect(r.blocking).toBe(true);
  });

  it('scans a text file whose extension merely claims it is an image', () => {
    /* The extension is the committer's claim. The content is the measurement. */
    const r = scanRepo([{ path: 'src/logo.png', body: 'const k = "' + AWS + '";\n' }]);
    expect(r.findings.map((f) => f.path)).toContain('src/logo.png');
    expect(r.blocking).toBe(true);
  });

  it('scans an entry marked binary rather than excusing it', () => {
    const r = scanRepo([
      { path: 'src/blob.bin', body: Buffer.from(' ' + AWS + ' '), isBinary: true },
    ]);
    expect(r.findings.map((f) => f.path)).toContain('src/blob.bin');
    expect(r.blocking).toBe(true);
  });

  it('discloses a changed file that is not on disk, rather than counting it clean', () => {
    const missing = scanChangeSetForSecrets(
      { path: join('no', 'such', 'dir') } as never,
      {
        entries: [{ path: 'src/gone.ts', status: 'A', isBinary: false, isSymlink: false }],
      } as never,
    );
    expect(missing.notScanned.map((n) => n.path)).toContain('src/gone.ts');
    expect(missing.complete).toBe(false);
  });

  it('still reports complete, and does not block, when it read everything', () => {
    const r = scanRepo([{ path: 'src/ok.ts', body: 'const n = 1;\n' }]);
    expect(r.complete).toBe(true);
    expect(r.blocking).toBe(false);
    expect(r.notScanned).toHaveLength(0);
  });

  it('still excludes by LOCATION silently, because that is policy and not a gap', () => {
    const r = scanRepo([{ path: 'node_modules/p/i.js', body: 'const k = "' + AWS + '";\n' }]);
    expect(r.notScanned).toHaveLength(0);
    expect(r.complete).toBe(true);
    expect(r.blocking).toBe(false);
  });
});

/* ============================================= identity covers the whole of what changed */

describe('a rename from a different source is a different change', () => {
  /*
   * SPEC: finding ENG-GIT-REV-1 (MEDIUM), 1.0.1 security review.
   *
   * The second half of ENG-GIT-F1, found the same way that one was: the identity projection
   * is a hand-written list of the entry fields that count, and `from` was not on it. The
   * integration comparison DOES honour `from` - it marks the old side DELETED - so the two
   * halves of the system disagreed about what makes two changes different.
   *
   * Rename A to C, or rename B to C with identical content, and everything the identity
   * looked at was equal: same status, same path, same digest, same blob id, same mode. The
   * digest collided, `buildChangeSet` returned the earlier ChangeSet, and evidence bound to a
   * change that deleted A was treated as applying to one that deletes B.
   */
  function twinRepo(): { repo: string; base: string } {
    const { root } = freshStore();
    roots.push(root);
    const repo = join(root, 'twin-repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'fixture@localhost');
    git('config', 'user.name', 'Fixture');
    git('config', 'commit.gpgsign', 'false');
    /* Two tracked files with byte-identical content: the only thing a rename of either to
       the same destination can differ in is where it came from. */
    writeFileSync(join(repo, 'src', 'a.js'), 'module.exports = 1;\n', 'utf8');
    writeFileSync(join(repo, 'src', 'b.js'), 'module.exports = 1;\n', 'utf8');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    return { repo, base: git('rev-parse', 'HEAD').trim() };
  }

  it('does not collapse onto the ChangeSet recorded for the other source', async () => {
    const { repo, base } = twinRepo();
    const { mgr, git, store } = managerFor(repo);
    const { deps } = freshStore();
    const workspace = await mgr.create({
      projectId: repo,
      workItemId: 'SC-WI-000012',
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });
    const deps2 = { store, git, clock: deps.clock, ids: deps.ids };
    const wt = workspace.path;

    /* a.js -> c.js */
    renameSync(join(wt, 'src', 'a.js'), join(wt, 'src', 'c.js'));
    await git.stagePaths(['src/a.js', 'src/c.js'], wt);
    const first = await buildChangeSet(deps2, workspace);

    /* undo, then b.js -> c.js, with c.js byte-identical to before */
    rmSync(join(wt, 'src', 'c.js'), { force: true });
    writeFileSync(join(wt, 'src', 'a.js'), 'module.exports = 1;\n', 'utf8');
    renameSync(join(wt, 'src', 'b.js'), join(wt, 'src', 'c.js'));
    await git.stagePaths(['src/a.js', 'src/b.js', 'src/c.js'], wt);
    const second = await buildChangeSet(deps2, workspace);

    const froms = (cs: typeof first): string[] =>
      cs.entries.map((e) => (e as { from?: string }).from ?? '-');
    expect(
      second.changeSetId,
      'the second change deletes a different file and must not reuse the first ChangeSet: ' +
        froms(first).join(',') +
        ' vs ' +
        froms(second).join(','),
    ).not.toBe(first.changeSetId);
    expect(second.digest).not.toBe(first.digest);
  });
});

/* ============================================= the whole record, as the comment promised */

describe('evidence redaction covers the record and not a list of names', () => {
  /*
   * SPEC: finding EVIDENCE-REDACT-NAMED-FIELDS-ONLY (MEDIUM), 1.0.1 security review.
   *
   * recordEvidence's own comment promised "the whole record is redacted rather than two named
   * fields, so a field added to the schema later is covered the day it is written", and the
   * code spread the record and overrode `claim` and `detail`. The next free-text field would
   * have reached immutable canon unredacted - the same asymmetry the fix was written to close.
   *
   * The extra field below stands for that future field: it is what a schema addition looks
   * like arriving at this function.
   */
  it('redacts a field the schema does not name yet', () => {
    const f = freshStore();
    roots.push(f.root);
    const key = 'AKIA' + 'Z3K7QW9TR5MB2XCD';
    const tx = f.store.begin();
    recordEvidence(tx, {
      id: 'SC-EEV-000001',
      evidenceClass: EvidenceClass.ANALYSIS,
      claim: 'ran the check',
      basis: 'DERIVED',
      workItemId: 'SC-WI-000001',
      changeSetId: 'SC-CS-000001',
      workspaceId: 'SC-WS-000001',
      headCommit: 'a'.repeat(40),
      outcome: 'PASS',
      detail: 'nothing to report',
      capturedAt: '2026-09-11T00:00:00.000Z',
      capturedBy: 'RUNTIME',
      futureNote: 'the runner logged ' + key + ' while it worked',
    } as never);
    tx.commit();

    const body = JSON.stringify(f.store.getCanon('engineeringEvidence', 'SC-EEV-000001')?.body);
    expect(body, 'a credential reached immutable canon').not.toContain(key);
  });

  it('applies the same whole-record rule to the execution record', () => {
    /*
     * SPEC: finding SECREV-EXEC-NAMEDFIELD-1 (MEDIUM), 1.0.1 security review.
     *
     * The sibling of the evidence path, which kept the named-field shape the evidence fix was
     * raised to remove. Asserted structurally, because the field that matters is the one
     * nobody has added yet: the persisted record must go through redactDeep rather than a
     * list of names.
     */
    const source = readFileSync('src/engineering/execution.ts', 'utf8');
    expect(source).toContain('tx.putCanon(EXECUTION_CANON_TYPE, record.executionId, redactDeep(');
  });

  it('leaves ids, digests and commits alone, because they are not credential shapes', () => {
    const f = freshStore();
    roots.push(f.root);
    const commit = 'b'.repeat(40);
    const tx = f.store.begin();
    recordEvidence(tx, {
      id: 'SC-EEV-000002',
      evidenceClass: EvidenceClass.ANALYSIS,
      claim: 'ran the check',
      basis: 'DERIVED',
      workItemId: 'SC-WI-000001',
      changeSetId: 'SC-CS-000001',
      workspaceId: 'SC-WS-000001',
      headCommit: commit,
      outcome: 'PASS',
      detail: 'nothing to report',
      capturedAt: '2026-09-11T00:00:00.000Z',
      capturedBy: 'RUNTIME',
    });
    tx.commit();

    const body = f.store.getCanon('engineeringEvidence', 'SC-EEV-000002')?.body as Record<
      string,
      unknown
    >;
    expect(body['headCommit']).toBe(commit);
    expect(body['id']).toBe('SC-EEV-000002');
    expect(body['changeSetId']).toBe('SC-CS-000001');
  });
});

/* ============================================= scope is judged where the path lands */

describe('a path is judged where it lands, on every axis', () => {
  /*
   * SPEC: finding ENG-GIT-SCOPE-LEXICAL-1 (MEDIUM), 1.0.1 security review.
   *
   * checkScopeConformance says a path is judged where it actually lands, and only the escape
   * test resolved anything. Allow, forbid, credential shape and lockfile all judged the
   * lexically normalized name, which does not collapse '..' - so a path under an allowed
   * prefix that lands somewhere else inside the worktree passed every one of them, and the
   * escape test had nothing to report because it never left the worktree.
   */
  it('does not admit a ..-bearing path because its name starts with an allowed prefix', async () => {
    const { repo, base } = makeRepo();
    const { mgr, store } = managerFor(repo);
    const { deps } = freshStore();
    void store;
    void deps;
    const workspace = await mgr.create({
      projectId: repo,
      workItemId: 'SC-WI-000013',
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });
    mkdirSync(join(workspace.path, 'secrets'), { recursive: true });
    writeFileSync(join(workspace.path, 'secrets', 'notes.txt'), 'x', 'utf8');

    const changeSet = {
      entries: [
        {
          status: 'A',
          path: 'src/../secrets/notes.txt',
          isBinary: false,
          isSymlink: false,
          gitMode: '100644',
        },
      ],
    } as never;

    const r = checkScopeConformance(workspace, changeSet, { allow: ['src/'], forbid: [] });

    expect(
      r.findings.map((f) => f.kind),
      'a path that lands in secrets/ is not in src/',
    ).toContain('OUTSIDE_ALLOWED_SCOPE');
    expect(r.conformant).toBe(false);
  });

  it('still admits an ordinary path under the allowed prefix', async () => {
    /* The fix must judge more accurately, not refuse more. */
    const { repo, base } = makeRepo();
    const { mgr } = managerFor(repo);
    const workspace = await mgr.create({
      projectId: repo,
      workItemId: 'SC-WI-000014',
      attempt: 1,
      producerAgentId: 'SC-AGENT-150',
      baseCommit: base,
      expectedScope: SCOPE,
      sandboxProfileDigest: 'd'.repeat(64),
      substrateClass: 'HARD',
    });
    const changeSet = {
      entries: [
        { status: 'M', path: 'src/app.js', isBinary: false, isSymlink: false, gitMode: '100644' },
      ],
    } as never;
    const r = checkScopeConformance(workspace, changeSet, { allow: ['src/'], forbid: [] });
    expect(r.findings.map((f) => f.kind)).not.toContain('OUTSIDE_ALLOWED_SCOPE');
  });
});
