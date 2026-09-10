import { canonicalJson, digestOf } from '../core/hash.js';
import { fail } from '../core/errors.js';
import type { ChangeSet } from './changeset.js';
import type { ChangedPath, GitService } from './git.js';

/**
 * ChangeSet → staged → committed, with identity proved at every step.
 *
 * SPEC: Phase 4 §23, closure blocker 3.
 *
 * **An accepted commit must represent EXACTLY the verified ChangeSet.** Not
 * approximately, and not "the files we remembered to stage".
 *
 * The defect this module exists to close: acceptance staged only the entries whose
 * status was not `D`, with `git add -- <paths>`. That silently dropped every deletion
 * — git stages additions and modifications for a pathspec and leaves a removed file
 * staged as unchanged — and it mishandled renames, whose old side is a deletion. So a
 * change that passed the tests, the review and the gate could be recorded as accepted
 * while the commit contained something else. Nothing downstream would ever notice,
 * because every check had run against the worktree rather than against the commit.
 *
 * The fix is not a better `git add`. It is a comparison:
 *
 *   verified ChangeSet C
 *     -> stage exactly C            (scoped `git add -A -- <paths>`, deletions included)
 *     -> prove staged identity == C  (else CHANGESET_INTEGRATION_MISMATCH, no commit)
 *     -> commit
 *     -> prove commit identity == C  (derived independently from the object database)
 *     -> only then record acceptance
 *
 * ## Why identity is a content map rather than a diff
 *
 * The same change has more than one legitimate SHAPE. A rename in the worktree appears
 * as a deletion plus an untracked addition, because git cannot detect a rename into a
 * file it is not tracking; once staged, `--find-renames` reports one `R`. Both describe
 * the same result. Comparing statuses directly would reject a correct integration, and
 * comparing diff text would reject it too — untracked files are absent from a worktree
 * diff and present in a staged one.
 *
 * So identity is canonicalised to the only thing that is actually invariant: **which
 * paths ended up with which content**. A deleted path maps to DELETED; every other path
 * maps to its git blob id and whether it is a symlink. Rename detection, copy detection
 * and untracked-vs-added all collapse to the same map.
 */

export const DELETED = 'DELETED' as const;

export interface IntegrationFact {
  /** The git blob id of the path's final content, or DELETED. */
  readonly content: string;
  readonly symlink: boolean;
  /**
   * The git file mode — `100644`, `100755`, `120000` — or DELETED.
   *
   * SPEC: finding GIT-INT-MODE-1 (MEDIUM), 1.0.1 security review.
   *
   * Identity proved CONTENT equality and nothing else, so flipping a regular file to
   * executable produced the same blob id and compared equal: an accepted commit could differ
   * from the verified ChangeSet in the executable bit with nothing to notice. The invariant
   * this comparison exists for is "EXACTLY the verified ChangeSet", and the mode is an axis of
   * that. `treeEntries` already returned it; only the symlink test was reading it.
   */
  readonly mode: string;
}

export interface IntegrationIdentity {
  readonly baseCommit: string;
  /** path -> what that path holds afterwards. Sorted and digested for comparison. */
  readonly facts: ReadonlyMap<string, IntegrationFact>;
  readonly digest: string;
  /** How this identity was obtained, for the mismatch report. */
  readonly source: 'VERIFIED_CHANGESET' | 'INDEX' | 'COMMIT';
}

/** A symlink is mode 120000 in every tree git writes. */
const SYMLINK_MODE = '120000';

function digestFacts(baseCommit: string, facts: ReadonlyMap<string, IntegrationFact>): string {
  const sorted = [...facts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([path, f]) => ({ path, content: f.content, symlink: f.symlink, mode: f.mode }));
  return digestOf(canonicalJson({ baseCommit, entries: sorted }));
}

/**
 * The identity of the change Serva verified.
 *
 * Built from the STORED ChangeSet, never re-read from disk: re-reading would silently
 * absorb any edit made after the gate ran, which is precisely the divergence this
 * comparison exists to catch.
 */
export function identityFromChangeSet(changeSet: ChangeSet): IntegrationIdentity {
  const facts = new Map<string, IntegrationFact>();
  for (const e of changeSet.entries) {
    if (e.status === 'D') {
      facts.set(e.path, { content: DELETED, symlink: false, mode: DELETED });
      continue;
    }
    // A rename's old side is a deletion. A copy's is not.
    if (e.status === 'R' && e.from !== undefined) {
      facts.set(e.from, { content: DELETED, symlink: false, mode: DELETED });
    }
    if (e.blobId === undefined) {
      return fail({
        code: 'E_VALIDATION',
        message: 'ChangeSet ' + changeSet.changeSetId + ' entry ' + e.path + ' has no blob id',
        remedy:
          'A change set without a content identity cannot be proved equal to a commit. Rebuild it.',
        details: { changeSetId: changeSet.changeSetId, path: e.path, status: e.status },
        specRef: 'Phase 4 §23',
      });
    }
    facts.set(e.path, { content: e.blobId, symlink: e.isSymlink, mode: e.gitMode });
  }
  return {
    baseCommit: changeSet.baseCommit,
    facts,
    digest: digestFacts(changeSet.baseCommit, facts),
    source: 'VERIFIED_CHANGESET',
  };
}

/** Every path a set of git name-status records touches, both sides of a rename. */
function touchedPaths(entries: readonly ChangedPath[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    out.add(e.path);
    if (e.from !== undefined) out.add(e.from);
  }
  return [...out];
}

/**
 * The identity of what git actually holds, in the index or in a commit.
 *
 * Derived from git's own object database rather than from anything Serva remembered,
 * so the post-commit check is genuinely independent of the pre-commit one.
 */
export async function identityFromGit(
  git: GitService,
  o: {
    readonly rev: string;
    readonly baseCommit: string;
    readonly cwd: string;
    readonly source: 'INDEX' | 'COMMIT';
  },
): Promise<IntegrationIdentity> {
  const entries =
    o.source === 'INDEX'
      ? await git.stagedPaths(o.baseCommit, o.cwd)
      : await git.commitPaths(o.baseCommit, o.rev, o.cwd);

  const paths = touchedPaths(entries);
  const tree = await git.treeEntries(o.rev, paths, o.cwd);

  const facts = new Map<string, IntegrationFact>();
  for (const e of entries) {
    if (e.status === 'D') {
      facts.set(e.path, { content: DELETED, symlink: false, mode: DELETED });
      continue;
    }
    if (e.status === 'R' && e.from !== undefined) {
      facts.set(e.from, { content: DELETED, symlink: false, mode: DELETED });
    }
    const blob = tree.get(e.path);
    facts.set(e.path, {
      content: blob?.blobId ?? 'MISSING',
      symlink: blob?.mode === SYMLINK_MODE,
      mode: blob?.mode ?? 'MISSING',
    });
  }

  return {
    baseCommit: o.baseCommit,
    facts,
    digest: digestFacts(o.baseCommit, facts),
    source: o.source,
  };
}

export interface IdentityDifference {
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
}

/** Every way the two identities disagree, named path by path. */
export function compareIdentities(
  expected: IntegrationIdentity,
  actual: IntegrationIdentity,
): IdentityDifference[] {
  const diffs: IdentityDifference[] = [];
  if (expected.baseCommit !== actual.baseCommit) {
    diffs.push({
      path: '(base)',
      expected: expected.baseCommit,
      actual: actual.baseCommit,
    });
  }
  const render = (f: IntegrationFact | undefined): string =>
    f === undefined ? 'absent' : (f.symlink ? 'symlink ' : '') + f.content + ' mode ' + f.mode;

  for (const [path, want] of expected.facts) {
    const got = actual.facts.get(path);
    if (
      got === undefined ||
      got.content !== want.content ||
      got.symlink !== want.symlink ||
      got.mode !== want.mode
    ) {
      diffs.push({ path, expected: render(want), actual: render(got) });
    }
  }
  for (const [path, got] of actual.facts) {
    if (!expected.facts.has(path)) {
      diffs.push({ path, expected: 'absent', actual: render(got) });
    }
  }
  return diffs;
}

export interface IntegrationResult {
  readonly commit: string;
  readonly branch: string;
  readonly stagedIdentity: IntegrationIdentity;
  readonly committedIdentity: IntegrationIdentity;
  /** Paths dirty in the worktree that were deliberately NOT staged. */
  readonly notStaged: readonly string[];
}

export interface IntegrationRequest {
  readonly changeSet: ChangeSet;
  readonly worktreePath: string;
  readonly branch: string;
  readonly message: string;
}

function mismatch(stage: string, diffs: readonly IdentityDifference[], details: object): never {
  return fail({
    code: 'E_CONFLICT',
    message:
      'CHANGESET_INTEGRATION_MISMATCH (' +
      stage +
      '): ' +
      diffs
        .slice(0, 10)
        .map((d) => d.path + ' expected ' + d.expected + ', found ' + d.actual)
        .join('; '),
    remedy:
      'The change git holds is not the change Serva verified, so it must not be recorded as accepted. Nothing was integrated. Re-verify the workspace.',
    details: { ...details, differences: diffs.slice(0, 20) },
    specRef: 'Phase 4 §23',
  });
}

/**
 * Stage, prove, commit, prove again.
 *
 * Throws on any mismatch, having committed nothing on the pre-commit path. The
 * post-commit path can leave a commit behind on the attempt branch — that is the
 * honest outcome: the commit exists on an unmerged branch and acceptance is NOT
 * recorded, so nothing downstream will treat it as verified.
 */
export async function integrateVerifiedChangeSet(
  git: GitService,
  req: IntegrationRequest,
): Promise<IntegrationResult> {
  const expected = identityFromChangeSet(req.changeSet);
  const cwd = req.worktreePath;
  const base = req.changeSet.baseCommit;

  /*
   * A non-empty index is refused rather than cleared. `git reset` is not in Serva's
   * verb set (Phase 4 §22), and quietly discarding whatever somebody staged would be a
   * destructive act taken to make an integration succeed.
   */
  if (!(await git.indexIsEmpty(cwd))) {
    return fail({
      code: 'E_CONFLICT',
      message: 'The workspace index already holds staged content',
      remedy:
        'Serva stages exactly the verified change and will not commit alongside content it did not verify. Inspect the worktree; Serva does not clear an index it did not create.',
      details: { workspace: cwd, changeSetId: req.changeSet.changeSetId },
      specRef: 'Phase 4 §23',
    });
  }

  // Both sides of every entry, so a rename's old path is staged as the deletion it is.
  const pathspec = [
    ...new Set(
      req.changeSet.entries.flatMap((e) => (e.from === undefined ? [e.path] : [e.path, e.from])),
    ),
  ];

  const dirtyBefore = await git.changedPaths(base, cwd);

  const staged = await git.stagePathsExact(pathspec, cwd);
  if (!staged.ok) {
    return fail({
      code: 'E_INTERNAL',
      message: 'Could not stage the verified change set',
      remedy: 'Nothing was committed. Inspect the worktree.',
      details: { stderr: staged.stderr.slice(0, 400), paths: pathspec.slice(0, 20) },
    });
  }

  const stagedIdentity = await identityFromGit(git, {
    rev: ':',
    baseCommit: base,
    cwd,
    source: 'INDEX',
  });
  const preDiffs = compareIdentities(expected, stagedIdentity);
  if (preDiffs.length > 0) {
    mismatch('staged', preDiffs, {
      changeSetId: req.changeSet.changeSetId,
      verifiedDigest: expected.digest,
      stagedDigest: stagedIdentity.digest,
    });
  }

  const committed = await git.commit(req.message, cwd);
  if (!committed.ok) {
    return fail({
      code: 'E_INTERNAL',
      message: 'Could not create the accepted commit',
      remedy: 'The worktree is unchanged. Nothing was integrated.',
      details: { stderr: committed.stderr.slice(0, 400) },
    });
  }
  const commit = await git.headCommit(cwd);

  /*
   * Derived from the object database, not from what was staged a moment ago. A check
   * that reused the staged result would only prove `git commit` did not crash.
   */
  const committedIdentity = await identityFromGit(git, {
    rev: commit,
    baseCommit: base,
    cwd,
    source: 'COMMIT',
  });
  const postDiffs = compareIdentities(expected, committedIdentity);
  if (postDiffs.length > 0) {
    mismatch('committed', postDiffs, {
      changeSetId: req.changeSet.changeSetId,
      commit,
      verifiedDigest: expected.digest,
      committedDigest: committedIdentity.digest,
    });
  }

  const verifiedPaths = new Set(pathspec);
  const notStaged = dirtyBefore.map((c) => c.path).filter((p) => !verifiedPaths.has(p));

  return { commit, branch: req.branch, stagedIdentity, committedIdentity, notStaged };
}
