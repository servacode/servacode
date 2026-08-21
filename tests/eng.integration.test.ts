import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitService, gitBlobId } from '../src/engineering/git.js';
import { EngineeringWorkspaceManager } from '../src/engineering/workspace.js';
import { buildChangeSet, type ChangeSet } from '../src/engineering/changeset.js';
import {
  compareIdentities,
  identityFromChangeSet,
  identityFromGit,
  integrateVerifiedChangeSet,
} from '../src/engineering/integration.js';
import { cleanup, freshStore } from './helpers.js';
import type { EngineeringWorkspace } from '../src/engineering/workspace.js';

/**
 * ACCEPTED COMMIT == VERIFIED CHANGESET.
 *
 * The defect these tests exist for: acceptance staged only entries whose status was not
 * `D`, so every deletion vanished and every rename lost its old side. The commit Serva
 * recorded as accepted could differ from the change that passed the tests, the review
 * and the gate — and nothing downstream would notice, because every check had run
 * against the worktree rather than against the commit.
 *
 * Each test below builds a real repository, makes a real change of one shape, and
 * proves the commit reproduces it exactly.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

interface Fixture {
  readonly repo: string;
  readonly base: string;
  readonly git: GitService;
  readonly workspace: EngineeringWorkspace;
  readonly store: ReturnType<typeof freshStore>['store'];
  readonly deps: ReturnType<typeof freshStore>['deps'];
}

async function fixture(): Promise<Fixture> {
  const { store, root, deps } = freshStore();
  roots.push(root);
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const g = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  writeFileSync(join(repo, 'src', 'keep.js'), 'module.exports = 1;\n', 'utf8');
  writeFileSync(join(repo, 'src', 'doomed.js'), 'module.exports = 2;\n', 'utf8');
  writeFileSync(join(repo, 'src', 'moving.js'), 'module.exports = 3;\n', 'utf8');
  writeFileSync(join(repo, 'README.md'), 'fixture\n', 'utf8');

  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'fixture@localhost');
  g('config', 'user.name', 'Fixture');
  g('config', 'commit.gpgsign', 'false');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD').trim();

  const git = new GitService({ repoRoot: repo });
  const workspaces = new EngineeringWorkspaceManager({
    store,
    git,
    clock: deps.clock,
    projectRoot: repo,
  });
  const workspace = await workspaces.create({
    projectId: repo,
    workItemId: 'SC-WI-000700',
    attempt: 1,
    producerAgentId: 'SC-AGENT-150',
    baseCommit: base,
    expectedScope: { allow: ['src/'], forbid: [] },
    sandboxProfileDigest: 'd'.repeat(64),
    substrateClass: 'HARD',
  });

  return { repo, base, git, workspace, store, deps };
}

async function changeSetOf(f: Fixture): Promise<ChangeSet> {
  return buildChangeSet(
    { store: f.store, git: f.git, clock: f.deps.clock, ids: f.deps.ids },
    f.workspace,
  );
}

async function accept(f: Fixture, changeSet: ChangeSet) {
  return integrateVerifiedChangeSet(f.git, {
    changeSet,
    worktreePath: f.workspace.path,
    branch: f.workspace.branch,
    message: 'accepted ' + changeSet.changeSetId,
  });
}

/** What the commit actually changed, read back from git and nothing else. */
function commitStatuses(f: Fixture, commit: string): string[] {
  return execFileSync('git', ['diff', '--name-status', '--find-renames', f.base, commit], {
    cwd: f.workspace.path,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .sort();
}

const W = (f: Fixture, p: string): string => join(f.workspace.path, p);

describe('every change shape integrates exactly', () => {
  it('accepts a modified file', async () => {
    const f = await fixture();
    writeFileSync(W(f, 'src/keep.js'), 'module.exports = 11;\n', 'utf8');
    const cs = await changeSetOf(f);
    const r = await accept(f, cs);

    expect(commitStatuses(f, r.commit)).toEqual(['M\tsrc/keep.js']);
    expect(compareIdentities(identityFromChangeSet(cs), r.committedIdentity)).toEqual([]);
  }, 60_000);

  it('accepts a new file', async () => {
    const f = await fixture();
    writeFileSync(W(f, 'src/added.js'), 'module.exports = 4;\n', 'utf8');
    const cs = await changeSetOf(f);
    // Serva observed it as untracked; the commit records it as an addition. Same change.
    expect(cs.entries.map((e) => e.status)).toEqual(['?']);
    const r = await accept(f, cs);

    expect(commitStatuses(f, r.commit)).toEqual(['A\tsrc/added.js']);
    expect(compareIdentities(identityFromChangeSet(cs), r.committedIdentity)).toEqual([]);
  }, 60_000);

  it('accepts a deletion', async () => {
    /*
     * The case the old implementation dropped entirely: it filtered out every `D`
     * entry before staging, so the file stayed in the commit and the accepted change
     * was not the verified one.
     */
    const f = await fixture();
    rmSync(W(f, 'src/doomed.js'));
    const cs = await changeSetOf(f);
    expect(cs.entries.map((e) => e.status)).toEqual(['D']);

    const r = await accept(f, cs);
    expect(commitStatuses(f, r.commit)).toEqual(['D\tsrc/doomed.js']);
    expect(compareIdentities(identityFromChangeSet(cs), r.committedIdentity)).toEqual([]);
  }, 60_000);

  it('accepts a rename, including its old side', async () => {
    const f = await fixture();
    const body = execFileSync('git', ['show', 'HEAD:src/moving.js'], {
      cwd: f.workspace.path,
      encoding: 'utf8',
    });
    rmSync(W(f, 'src/moving.js'));
    writeFileSync(W(f, 'src/moved.js'), body, 'utf8');

    const cs = await changeSetOf(f);
    // In the worktree this is a deletion plus an untracked addition: git cannot detect
    // a rename into a file it is not tracking yet.
    expect(cs.entries.map((e) => e.status).sort()).toEqual(['?', 'D']);

    const r = await accept(f, cs);
    // Once staged, git reports one rename. Different shape, same result — which is
    // exactly why identity is a content map and not a status list.
    expect(commitStatuses(f, r.commit)).toEqual(['R100\tsrc/moving.js\tsrc/moved.js']);
    expect(compareIdentities(identityFromChangeSet(cs), r.committedIdentity)).toEqual([]);
  }, 60_000);

  it('accepts a mixed add, modify and delete', async () => {
    const f = await fixture();
    writeFileSync(W(f, 'src/keep.js'), 'module.exports = 111;\n', 'utf8');
    writeFileSync(W(f, 'src/new.js'), 'module.exports = 5;\n', 'utf8');
    rmSync(W(f, 'src/doomed.js'));

    const cs = await changeSetOf(f);
    const r = await accept(f, cs);

    expect(commitStatuses(f, r.commit)).toEqual([
      'A\tsrc/new.js',
      'D\tsrc/doomed.js',
      'M\tsrc/keep.js',
    ]);
    expect(compareIdentities(identityFromChangeSet(cs), r.committedIdentity)).toEqual([]);
  }, 60_000);

  it('the committed content is byte-identical to what was verified', async () => {
    const f = await fixture();
    const content = 'module.exports = { exact: true };\n';
    writeFileSync(W(f, 'src/keep.js'), content, 'utf8');
    const cs = await changeSetOf(f);
    const r = await accept(f, cs);

    const entry = cs.entries.find((e) => e.path === 'src/keep.js');
    expect(entry?.blobId).toBe(gitBlobId(Buffer.from(content, 'utf8')));
    expect(r.committedIdentity.facts.get('src/keep.js')?.content).toBe(entry?.blobId);
    expect(r.committedIdentity.digest).toBe(identityFromChangeSet(cs).digest);
  }, 60_000);
});

describe('nothing the gate did not see reaches the commit', () => {
  it('an unrelated dirty path is not staged and not committed', async () => {
    const f = await fixture();
    writeFileSync(W(f, 'src/keep.js'), 'module.exports = 12;\n', 'utf8');
    const cs = await changeSetOf(f);

    // Appears AFTER verification. It is not part of the verified change, so it must
    // not ride along — `git add .` would have swept it in.
    writeFileSync(W(f, 'src/sneaky.js'), 'module.exports = "unreviewed";\n', 'utf8');

    const r = await accept(f, cs);
    expect(commitStatuses(f, r.commit)).toEqual(['M\tsrc/keep.js']);
    expect(r.notStaged).toContain('src/sneaky.js');

    // And it is still sitting in the worktree, untouched rather than quietly discarded.
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: f.workspace.path,
      encoding: 'utf8',
    });
    expect(status).toContain('src/sneaky.js');
  }, 60_000);

  it('a verified file modified after the gate is refused', async () => {
    const f = await fixture();
    writeFileSync(W(f, 'src/keep.js'), 'module.exports = 13;\n', 'utf8');
    const cs = await changeSetOf(f);

    // The gate passed on the content above. This is different content.
    writeFileSync(W(f, 'src/keep.js'), 'module.exports = 99; // slipped in\n', 'utf8');

    await expect(accept(f, cs)).rejects.toThrowError(/CHANGESET_INTEGRATION_MISMATCH \(staged\)/);
    // Refused BEFORE the commit: the branch is still at the base.
    expect(await f.git.headCommit(f.workspace.path)).toBe(f.base);
  }, 60_000);

  it('a verified file deleted after the gate is refused', async () => {
    const f = await fixture();
    writeFileSync(W(f, 'src/keep.js'), 'module.exports = 14;\n', 'utf8');
    const cs = await changeSetOf(f);
    rmSync(W(f, 'src/keep.js'));

    await expect(accept(f, cs)).rejects.toThrowError(/CHANGESET_INTEGRATION_MISMATCH/);
    expect(await f.git.headCommit(f.workspace.path)).toBe(f.base);
  }, 60_000);

  it('a pre-staged index is refused rather than cleared', async () => {
    const f = await fixture();
    writeFileSync(W(f, 'src/keep.js'), 'module.exports = 15;\n', 'utf8');
    writeFileSync(W(f, 'src/other.js'), 'module.exports = 16;\n', 'utf8');
    const cs = await changeSetOf(f);
    execFileSync('git', ['add', '--', 'src/other.js'], { cwd: f.workspace.path });

    // `git reset` is not in Serva's verb set, and discarding somebody's staged work to
    // make an integration succeed would be a destructive act taken for convenience.
    await expect(accept(f, cs)).rejects.toThrowError(/index already holds staged content/);
    expect(await f.git.headCommit(f.workspace.path)).toBe(f.base);
  }, 60_000);
});

describe('the comparison itself', () => {
  it('a staged identity is derived from git, not from what Serva remembered', async () => {
    const f = await fixture();
    writeFileSync(W(f, 'src/keep.js'), 'module.exports = 17;\n', 'utf8');
    const cs = await changeSetOf(f);
    await accept(f, cs);

    const fromGit = await identityFromGit(f.git, {
      rev: await f.git.headCommit(f.workspace.path),
      baseCommit: f.base,
      cwd: f.workspace.path,
      source: 'COMMIT',
    });
    expect(fromGit.source).toBe('COMMIT');
    expect(fromGit.digest).toBe(identityFromChangeSet(cs).digest);
  }, 60_000);

  it('a differing base is itself a difference', () => {
    const a = identityFromChangeSet({
      changeSetId: 'SC-CS-1',
      baseCommit: 'aaaaaaa',
      entries: [],
    } as unknown as ChangeSet);
    const b = identityFromChangeSet({
      changeSetId: 'SC-CS-2',
      baseCommit: 'bbbbbbb',
      entries: [],
    } as unknown as ChangeSet);
    expect(compareIdentities(a, b)[0]?.path).toBe('(base)');
  });

  it('an entry with no content identity cannot be proved and is refused', () => {
    expect(() =>
      identityFromChangeSet({
        changeSetId: 'SC-CS-3',
        baseCommit: 'aaaaaaa',
        entries: [{ status: 'M', path: 'a.js', isBinary: false, isSymlink: false }],
      } as unknown as ChangeSet),
    ).toThrowError(/has no blob id/);
  });
});
