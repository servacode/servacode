import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fail } from '../core/errors.js';

/**
 * Deterministic Git authority. SPEC: Phase 4 §22, 14 (engineering governance).
 *
 * **Serva owns Git; the agent does not.** A Producer edits source artifacts. It does
 * not administer history, and it has no route to one: every Git operation in the
 * system goes through this module, which takes an argument array and never a string.
 *
 * Three properties, each of which is a test:
 *
 *   - **No shell.** `spawn` with `shell: false`, so a branch name or a path can never
 *     become syntax. There is nothing for it to escape into.
 *   - **A closed verb set.** Only the operations named here exist. `push`, `merge`,
 *     `rebase`, `remote` and `config` are absent by construction rather than blocked by
 *     a check somebody could forget to write.
 *   - **Arguments are validated before they are used**, because "it goes in an array"
 *     stops shell injection and does nothing about a branch called `--upload-pack=…`.
 */

/** Git operations Serva will never perform in Phase 4. Asserted by test. */
/**
 * THE VERB, NOT THE FIRST THING THAT DOES NOT LOOK LIKE A FLAG.
 *
 * SPEC: finding ENGINEERING-GIT-AND-COMMIT-INTEGRITY/F1 (MEDIUM), 1.0.1 security review.
 *
 * The guard read `args.find((a) => !a.startsWith('-'))`. Git's global options come BEFORE the
 * subcommand and some of them take a separate value, so for the argv this module's own
 * `commit()` builds —
 *
 *   ['-c', 'user.name=Serva Code', '-c', 'user.email=...', 'commit', ...]
 *
 * — that expression returns `user.name=Serva Code`. The real verb was never examined. Every
 * caller here constructs a literal safe verb, so nothing was reachable, but the module's stated
 * property is "a closed verb set enforced at the choke point" and the choke point was inspecting
 * the wrong token: `['-c', 'x=y', 'push']` would have passed it.
 *
 * EVERY value-taking global, not the two this file happens to use.
 *
 * SPEC: finding ENGINEERING-GIT-AND-COMMIT-INTEGRITY/F2 (MEDIUM), second pass.
 *
 * The first fix skipped `-c` and `-C`, because those are what `commit()` builds. Git has more
 * globals that consume the following token, and the reviewer named them: for
 * `['--git-dir', '/x', 'push']` the loop stepped over `--git-dir`, returned `/x` as the verb,
 * and `push` was never examined — the same desync the fix was for, one option across.
 *
 * So the set is enumerated from git's documented globals rather than from this module's usage,
 * because what a caller MAY write is the thing being guarded, and the next caller is not
 * obliged to write what the current ones do.
 *
 * The `--opt=value` forms need nothing: they are a single token beginning with `-`, so the flag
 * rule already covers them.
 */
const GIT_GLOBALS_TAKING_A_VALUE: ReadonlySet<string> = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
  '--config-env',
  '--attr-source',
]);

/**
 * Global flags this service passes that take NO value. Anything else is unknown.
 *
 * SPEC: finding GIT-INT-M1 (MEDIUM), 1.0.1 security review.
 */
const GIT_GLOBAL_FLAGS: ReadonlySet<string> = new Set(['--no-pager', '--literal-pathspecs']);

export function gitVerb(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === undefined) continue;
    if (GIT_GLOBALS_TAKING_A_VALUE.has(a)) {
      i += 1;
      continue;
    }
    if (GIT_GLOBAL_FLAGS.has(a)) continue;
    /*
     * `--option=value` is ONE token and cannot swallow the next one, so it is safe to skip
     * whatever the option is. The desync below is only possible with the separate-value form.
     */
    if (a.startsWith('--') && a.includes('=')) continue;
    /*
     * AN OPTION THIS PARSER DOES NOT KNOW IS NOT ASSUMED TO BE HARMLESS.
     *
     * SPEC: finding GIT-INT-M1 (MEDIUM), 1.0.1 security review.
     *
     * Skipping every unrecognised `-…` assumes it takes no value. A value-taking global absent
     * from the set above therefore made this return the option's VALUE as the verb — and if
     * that value happened to read as an allowed verb, the choke point approved one subcommand
     * while git ran another. That is the same desync the two earlier fixes here closed, one
     * option further out, and guessing is what made all three possible.
     *
     * `undefined` means "no verb could be determined", which the choke point refuses. Fail
     * closed on the unknown: an option nobody taught this parser is a reason to stop, not to
     * carry on and hope.
     */
    if (a.startsWith('-')) return undefined;
    return a;
  }
  return undefined;
}

/**
 * WHAT THIS PHASE MUST NEVER DO.
 *
 * Not the gate any more, and not decoration either: the allowed set below is DERIVED by
 * removing these, so a verb named here cannot be admitted by anyone adding to that list. A
 * safeguard nothing consumes is a comment, and this repository refuses those.
 */
export const FORBIDDEN_GIT_VERBS: readonly string[] = Object.freeze([
  'push',
  'merge',
  'rebase',
  'remote',
  'config',
  'submodule',
  'clone',
  'fetch',
  'pull',
  'reset',
  'clean',
  'filter-branch',
]);

/**
 * THE CLOSED VERB SET, ACTUALLY CLOSED.
 *
 * SPEC: finding GIT-INTEGRITY-01 (MEDIUM), 1.0.1 security review.
 *
 * The header of this module promises "a closed verb set — only the operations named here
 * exist, absent by construction rather than blocked by a check somebody could forget to
 * write". The choke point implemented a DENYLIST, so everything nobody had thought to forbid
 * was permitted: `checkout`, `stash`, `update-ref`, `apply`, `cherry-pick`, `revert`, `tag`,
 * `rm`, `gc` and the rest all passed it — measured, not supposed: `git checkout` ran.
 *
 * Nothing reached them, because every method here builds a literal verb. That is the argument
 * for closing the set rather than against it: the guarantee rested on every future caller
 * continuing to write a literal, which is exactly what the header says it does not rest on.
 *
 * These eleven are what this service issues, minus anything forbidden — so the two lists
 * cannot disagree, and widening this one cannot re-admit a forbidden verb.
 */
const PERFORMED_GIT_VERBS: readonly string[] = Object.freeze([
  'add',
  'branch',
  'cat-file',
  'commit',
  'diff',
  'hash-object',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'status',
  'worktree',
]);

export const ALLOWED_GIT_VERBS: readonly string[] = Object.freeze(
  PERFORMED_GIT_VERBS.filter((verb) => !FORBIDDEN_GIT_VERBS.includes(verb)),
);

/** A ref name Serva is willing to create. Deliberately narrow. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;

/**
 * An argument must never be mistaken for an option.
 *
 * Git reads `--upload-pack=...` and friends from positions where a caller expects a
 * ref or a path, so a value that begins with `-` is refused outright rather than
 * escaped. Passing it in an array does not help: argv separation defeats the shell,
 * not the program's own option parser.
 */
export function assertNotOptionLike(value: string, what: string): void {
  if (value.startsWith('-')) {
    fail({
      code: 'E_VALIDATION',
      message: what + ' may not begin with "-": ' + value,
      remedy:
        'A value that looks like an option can be read as one by git regardless of argv separation. Use a plain name.',
      details: { what, value },
      specRef: 'Phase 4 §22',
    });
  }
}

export function assertSafeRef(ref: string): void {
  assertNotOptionLike(ref, 'ref');
  if (!SAFE_REF.test(ref) || ref.includes('..') || ref.endsWith('.lock')) {
    fail({
      code: 'E_VALIDATION',
      message: 'Unsafe git ref: ' + ref,
      remedy: 'Serva creates refs from its own identifiers; a ref name is never free text.',
      details: { ref },
      specRef: 'Phase 4 §22',
    });
  }
}

/**
 * Git's own object id for a blob: `sha1("blob " + length + NUL + bytes)`.
 *
 * Computed in-process from the exact bytes, so a worktree file and a blob already in
 * the object database can be compared without decoding either of them.
 */
export function gitBlobId(content: Buffer): string {
  const header = Buffer.from('blob ' + String(content.length) + '\0', 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([header, content]))
    .digest('hex');
}

export interface GitResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitRunner {
  (args: readonly string[], cwd: string, timeoutMs: number): Promise<GitResult>;
}

const defaultRunner: GitRunner = (args, cwd, timeoutMs) =>
  new Promise((resolveP) => {
    let settled = false;
    const child = spawn('git', [...args], { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (e: Error) => {
      settled = true;
      clearTimeout(timer);
      resolveP({ ok: false, exitCode: null, stdout, stderr: stderr + e.message });
    });
    child.on('close', (code) => {
      settled = true;
      clearTimeout(timer);
      resolveP({ ok: code === 0, exitCode: code, stdout, stderr });
    });
  });

export interface GitOptions {
  readonly repoRoot: string;
  readonly runner?: GitRunner;
  readonly timeoutMs?: number;
}

export interface ChangedPath {
  readonly status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';
  readonly path: string;
  readonly from?: string;
}

export class GitService {
  private readonly runner: GitRunner;
  private readonly timeoutMs: number;
  readonly repoRoot: string;
  /** Every argument array this service ran. Tests assert on it. */
  readonly invocations: string[][] = [];

  constructor(opts: GitOptions) {
    this.repoRoot = resolve(opts.repoRoot);
    this.runner = opts.runner ?? defaultRunner;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** The single choke point. Every Git call in Serva passes through here. */
  private async git(args: readonly string[], cwd = this.repoRoot): Promise<GitResult> {
    const verb = gitVerb(args);
    if (verb === undefined || !ALLOWED_GIT_VERBS.includes(verb)) {
      return fail({
        code: 'E_CAPABILITY_NOT_ENABLED',
        message:
          verb === undefined
            ? 'a git invocation with no subcommand is not an operation this service performs'
            : 'git ' + verb + ' is not one of the operations this service performs',
        remedy:
          'The verb set is closed. Phase 4 performs no remote Git write and does not rewrite shared history; anything else is added deliberately, to ALLOWED_GIT_VERBS, or not at all.',
        details: { verb, args: [...args] },
        specRef: 'Phase 4 §22, §31',
      });
    }
    this.invocations.push([...args]);
    return this.runner(args, cwd, this.timeoutMs);
  }

  async isRepo(): Promise<boolean> {
    const r = await this.git(['rev-parse', '--is-inside-work-tree']);
    return r.ok && r.stdout.trim() === 'true';
  }

  async revParse(ref: string): Promise<string> {
    assertSafeRef(ref);
    const r = await this.git(['rev-parse', ref]);
    if (!r.ok) {
      return fail({
        code: 'E_NOT_FOUND',
        message: 'Cannot resolve git ref ' + ref,
        remedy: 'The ref does not exist in this repository.',
        details: { ref, stderr: r.stderr.slice(0, 400) },
      });
    }
    return r.stdout.trim();
  }

  async currentBranch(cwd = this.repoRoot): Promise<string> {
    const r = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    return r.ok ? r.stdout.trim() : 'HEAD';
  }

  /** Porcelain v1 status, parsed. Used to detect a dirty checkout, never to fix one. */
  async status(cwd = this.repoRoot): Promise<ChangedPath[]> {
    const r = await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
    if (!r.ok) return [];
    return parsePorcelainZ(r.stdout);
  }

  async isClean(cwd = this.repoRoot): Promise<boolean> {
    return (await this.status(cwd)).length === 0;
  }

  /**
   * The change set, computed by SERVA from the repository.
   *
   * Never from a model-reported file list: 04 §7.1 check 3 exists because an agent's
   * account of what it changed is a claim, and this is the observation.
   */
  async changedPaths(baseCommit: string, cwd: string): Promise<ChangedPath[]> {
    assertNotOptionLike(baseCommit, 'base commit');
    const tracked = await this.git(
      ['diff', '--name-status', '-z', '--find-renames', baseCommit],
      cwd,
    );
    const out = tracked.ok ? parseNameStatusZ(tracked.stdout) : [];
    // An untracked file is a change the diff against a commit will not show, and an
    // agent writing a new file outside its scope is precisely the case that matters.
    const untracked = await this.git(['ls-files', '--others', '--exclude-standard', '-z'], cwd);
    if (untracked.ok) {
      for (const p of untracked.stdout.split('\0')) {
        if (p.length > 0) out.push({ status: '?', path: p });
      }
    }
    return out;
  }

  /**
   * The blob ids git WOULD store for these paths, filters and all.
   *
   * Serva used to compute these itself by hashing the bytes on disk. That is only the
   * same number when the working tree and the object store agree byte for byte, and
   * `core.autocrlf` — set globally on many Windows machines, including the one this was
   * measured on — means they routinely do not. The verified ChangeSet then named one
   * blob, `git add` produced another, and integration refused a correct commit with
   * CHANGESET_INTEGRATION_MISMATCH.
   *
   * Asking git is not a softening of that check; it is what makes the check compare two
   * of the same kind of thing. The comparison itself is unchanged, and still refuses a
   * commit whose content differs from what was verified.
   *
   * `--` separates paths from options, and each path is hashed through its own filters
   * because git knows the path it is hashing.
   */
  async blobIdsFor(paths: readonly string[], cwd: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (paths.length === 0) return out;
    for (const p of paths) assertNotOptionLike(p, 'path');
    const r = await this.git(['hash-object', '--', ...paths], cwd);
    if (!r.ok) return out;
    const ids = r.stdout.split(/\r?\n/).filter((x) => x.length > 0);
    /*
     * Only pair them up when the counts agree. A short read means git skipped something,
     * and zipping a short list against the paths would attach one file's identity to
     * another — the exact failure this whole comparison exists to catch.
     */
    if (ids.length !== paths.length) return out;
    for (let i = 0; i < paths.length; i++) out.set(paths[i] as string, ids[i] as string);
    return out;
  }

  async diff(baseCommit: string, cwd: string): Promise<string> {
    assertNotOptionLike(baseCommit, 'base commit');
    const r = await this.git(['diff', '--no-color', '--find-renames', baseCommit], cwd);
    return r.ok ? r.stdout : '';
  }

  async addWorktree(path: string, branch: string, baseCommit: string): Promise<GitResult> {
    assertSafeRef(branch);
    assertNotOptionLike(baseCommit, 'base commit');
    assertNotOptionLike(path, 'worktree path');
    return this.git(['worktree', 'add', '-b', branch, path, baseCommit]);
  }

  async removeWorktree(path: string, force = false): Promise<GitResult> {
    assertNotOptionLike(path, 'worktree path');
    return this.git(['worktree', 'remove', ...(force ? ['--force'] : []), path]);
  }

  async listWorktrees(): Promise<{ path: string; head: string; branch?: string }[]> {
    const r = await this.git(['worktree', 'list', '--porcelain']);
    if (!r.ok) return [];
    const out: { path: string; head: string; branch?: string }[] = [];
    let current: { path?: string; head?: string; branch?: string } = {};
    for (const line of r.stdout.split('\n')) {
      const t = line.trim();
      if (t.startsWith('worktree ')) current = { path: t.slice(9) };
      else if (t.startsWith('HEAD ')) current.head = t.slice(5);
      else if (t.startsWith('branch ')) current.branch = t.slice(7).replace('refs/heads/', '');
      else if (t.length === 0 && current.path !== undefined) {
        out.push({
          path: current.path,
          head: current.head ?? '',
          ...(current.branch === undefined ? {} : { branch: current.branch }),
        });
        current = {};
      }
    }
    if (current.path !== undefined) {
      out.push({
        path: current.path,
        head: current.head ?? '',
        ...(current.branch === undefined ? {} : { branch: current.branch }),
      });
    }
    return out;
  }

  async pruneWorktrees(): Promise<GitResult> {
    return this.git(['worktree', 'prune']);
  }

  /**
   * Stage exactly the named paths, INCLUDING deletions.
   *
   * `git add -- <paths>` was the first attempt and it silently dropped every deletion:
   * without `-A` git stages additions and modifications for a pathspec and leaves a
   * removed file staged as unchanged. The accepted commit then differed from the
   * ChangeSet that passed the tests, the review and the gate — a provenance break that
   * no later check would have caught, because every check ran against the worktree.
   *
   * `-A` is scoped to an EXACT pathspec list, never to `.`: it must stage deletions
   * without sweeping in anything the gate never saw.
   */
  async stagePathsExact(paths: readonly string[], cwd: string): Promise<GitResult> {
    for (const p of paths) assertNotOptionLike(p, 'staged path');
    if (paths.length === 0) {
      return { ok: true, exitCode: 0, stdout: '', stderr: '' };
    }
    return this.git(['add', '-A', '--', ...paths], cwd);
  }

  /** Kept for callers that must stage additions only. Does NOT stage deletions. */
  async stagePaths(paths: readonly string[], cwd: string): Promise<GitResult> {
    for (const p of paths) assertNotOptionLike(p, 'staged path');
    if (paths.length === 0) {
      return { ok: true, exitCode: 0, stdout: '', stderr: '' };
    }
    return this.git(['add', '--', ...paths], cwd);
  }

  /** Is the index identical to HEAD? A precondition for a scoped, exact staging. */
  async indexIsEmpty(cwd: string): Promise<boolean> {
    const r = await this.git(['diff', '--cached', '--name-only', '-z'], cwd);
    return r.ok && r.stdout.replace(/\0/g, '').trim().length === 0;
  }

  /** What the INDEX holds, relative to a base commit. */
  async stagedPaths(baseCommit: string, cwd: string): Promise<ChangedPath[]> {
    assertNotOptionLike(baseCommit, 'base commit');
    const r = await this.git(
      ['diff', '--cached', '--name-status', '-z', '--find-renames', baseCommit],
      cwd,
    );
    return r.ok ? parseNameStatusZ(r.stdout) : [];
  }

  /** What a COMMIT changed, relative to a base commit. Derived independently. */
  async commitPaths(baseCommit: string, commit: string, cwd: string): Promise<ChangedPath[]> {
    assertNotOptionLike(baseCommit, 'base commit');
    assertNotOptionLike(commit, 'commit');
    const r = await this.git(
      ['diff', '--name-status', '-z', '--find-renames', baseCommit, commit],
      cwd,
    );
    return r.ok ? parseNameStatusZ(r.stdout) : [];
  }

  /**
   * The blob id and mode git holds for each of `paths`, in a tree-ish.
   *
   * `rev` is `:` for the index or a commit sha. Blob ids rather than decoded text:
   * comparing content by reading stdout as UTF-8 corrupts binary files and can split a
   * multi-byte sequence across chunk boundaries, so the comparison would be unreliable
   * in exactly the cases it needs to be exact. A blob id is a hash of the bytes.
   */
  async treeEntries(
    rev: string,
    paths: readonly string[],
    cwd: string,
  ): Promise<Map<string, { mode: string; blobId: string }>> {
    const out = new Map<string, { mode: string; blobId: string }>();
    if (paths.length === 0) return out;
    for (const p of paths) assertNotOptionLike(p, 'blob path');
    if (rev !== ':') assertNotOptionLike(rev, 'revision');

    const r =
      rev === ':'
        ? await this.git(['ls-files', '--stage', '-z', '--', ...paths], cwd)
        : await this.git(['ls-tree', '-r', '-z', rev, '--', ...paths], cwd);
    if (!r.ok) return out;

    for (const line of r.stdout.split('\0')) {
      if (line.length === 0) continue;
      // `<mode> <sha> <stage>` TAB `<path>` (index), `<mode> blob <sha>` TAB `<path>` (tree).
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const head = line.slice(0, tab).split(/\s+/);
      const mode = head[0];
      const blobId = rev === ':' ? head[1] : head[2];
      if (mode === undefined || blobId === undefined) continue;
      out.set(line.slice(tab + 1), { mode, blobId });
    }
    return out;
  }

  /**
   * Create a commit with an author Serva controls.
   *
   * The identity is set per invocation with `-c`, not by writing repository config: a
   * Producer run must not leave configuration behind, and Serva must not quietly change
   * the owner's Git identity.
   */
  async commit(
    message: string,
    cwd: string,
    author = 'Serva Code <serva@localhost>',
  ): Promise<GitResult> {
    return this.git(
      [
        '-c',
        'user.name=' + author.split('<')[0]!.trim(),
        '-c',
        'user.email=' + (author.match(/<(.+)>/)?.[1] ?? 'serva@localhost'),
        'commit',
        '--no-gpg-sign',
        '-m',
        message,
      ],
      cwd,
    );
  }

  async headCommit(cwd: string): Promise<string> {
    const r = await this.git(['rev-parse', 'HEAD'], cwd);
    return r.ok ? r.stdout.trim() : '';
  }

  async commitExists(sha: string, cwd = this.repoRoot): Promise<boolean> {
    assertNotOptionLike(sha, 'commit');
    const r = await this.git(['cat-file', '-e', sha + '^{commit}'], cwd);
    return r.ok;
  }

  async createBranch(branch: string, at: string): Promise<GitResult> {
    assertSafeRef(branch);
    assertNotOptionLike(at, 'branch point');
    return this.git(['branch', branch, at]);
  }

  async branchExists(branch: string): Promise<boolean> {
    assertSafeRef(branch);
    const r = await this.git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]);
    return r.ok;
  }
}

/** `status --porcelain=v1 -z` records: `XY path` NUL, with renames adding a second NUL field. */
export function parsePorcelainZ(raw: string): ChangedPath[] {
  const parts = raw.split('\0').filter((p) => p.length > 0);
  const out: ChangedPath[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const x = entry[0]!;
    const path = entry.slice(3);
    const code = (x === ' ' ? entry[1]! : x) as ChangedPath['status'];
    if (code === 'R' || code === 'C') {
      const from = parts[i + 1];
      i += 1;
      out.push({ status: code, path, ...(from === undefined ? {} : { from }) });
      continue;
    }
    out.push({ status: normalizeStatus(code), path });
  }
  return out;
}

/** `diff --name-status -z` records: status NUL path NUL (renames add the new path). */
export function parseNameStatusZ(raw: string): ChangedPath[] {
  const parts = raw.split('\0').filter((p) => p.length > 0);
  const out: ChangedPath[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const code = parts[i];
    const path = parts[i + 1];
    if (code === undefined || path === undefined) break;
    const letter = code[0]!;
    if (letter === 'R' || letter === 'C') {
      const to = parts[i + 2];
      i += 1;
      out.push({
        status: letter as 'R' | 'C',
        path: to ?? path,
        from: path,
      });
      continue;
    }
    out.push({ status: normalizeStatus(letter), path });
  }
  return out;
}

function normalizeStatus(code: string): ChangedPath['status'] {
  const allowed: ChangedPath['status'][] = ['A', 'M', 'D', 'R', 'C', 'T', 'U', '?'];
  return (allowed as string[]).includes(code) ? (code as ChangedPath['status']) : 'M';
}
