import { z } from 'zod';
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { canonicalJson, digestOf } from '../core/hash.js';
import { AuditAction, audit } from '../events/audit.js';
import { safeRealpath } from '../substrate/fake.js';
import { gitBlobId } from './git.js';
import type { ChangedPath, GitService } from './git.js';
import type { EngineeringWorkspace } from './workspace.js';
import type { Store, Transaction } from '../store/store.js';
import type { Clock } from '../core/clock.js';
import type { IdSource } from '../core/ids.js';

/**
 * ChangeSet identity and scope conformance.
 *
 * SPEC: Phase 4 §15–§16, 04 §7.1 check 3, SC-POL-009.
 *
 * Two rules, and the second follows from the first:
 *
 *   1. **Serva computes the change set itself**, from the repository. A model-supplied
 *      list of what it changed is a claim, and this is the observation. An agent that
 *      could name its own diff could omit a line from it.
 *   2. **Every piece of evidence names a ChangeSet.** That is what makes "the tests
 *      passed earlier" answerable: they did, against a different ChangeSet, and the
 *      result is stale rather than wrong.
 */

export const CHANGESET_CANON_TYPE = 'changeSet';
export const CHANGESET_STREAM = 'engineering/changesets';

export const ChangedEntrySchema = z
  .object({
    status: z.enum(['A', 'M', 'D', 'R', 'C', 'T', 'U', '?']),
    path: z.string().min(1),
    from: z.string().optional(),
    isBinary: z.boolean(),
    isSymlink: z.boolean(),
    /**
     * The git file mode this path holds — `100644`, `100755`, `120000`, or DELETED.
     *
     * SPEC: finding GIT-INT-MODE-1 (MEDIUM), 1.0.1 security review.
     *
     * The integration check proves the accepted commit is EXACTLY the verified ChangeSet, and
     * it could only prove CONTENT equality: flipping a regular file to executable leaves the
     * blob id untouched, so the two compared equal and an accepted commit could differ from
     * what was verified in the executable bit with nothing to notice.
     *
     * Required rather than optional, because an entry that cannot say what mode it held cannot
     * be compared on one — and a comparison that quietly skips is the defect, not the fix.
     */
    gitMode: z.string().min(1),
    /** Digest of the file as it stands. Absent for a deletion. */
    digest: z.string().optional(),
    /**
     * Git's own blob id for the same bytes. Absent for a deletion.
     *
     * Carried so the verified change can be compared to what git actually holds in the
     * index or in a commit, without decoding either side. The content digest above is
     * a UTF-8 digest and cannot be compared to a git object; this can.
     */
    blobId: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ChangedEntry = z.output<typeof ChangedEntrySchema>;

export const ChangeSetSchema = z
  .object({
    changeSetId: z.string().min(1),
    workItemId: z.string().min(1),
    workspaceId: z.string().min(1),
    attempt: z.number().int().positive(),
    producerAgentId: z.string(),
    producerRunId: z.string().optional(),
    baseCommit: z.string().min(7),
    headCommit: z.string(),
    entries: z.array(ChangedEntrySchema),
    /** Digest over the diff text: two identical changes have one identity. */
    diffDigest: z.string().length(64),
    /** Digest over the identity-bearing fields, used to bind evidence. */
    digest: z.string().length(64),
    createdAt: z.string(),
  })
  .strict();

export type ChangeSet = z.output<typeof ChangeSetSchema>;

const MAX_TEXT_PROBE = 8_000;

/** Heuristic, and labelled as one: a NUL in the first block means "treat as binary". */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, MAX_TEXT_PROBE);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export interface ChangeSetDeps {
  readonly store: Store;
  readonly git: GitService;
  readonly clock: Clock;
  readonly ids: IdSource;
}

/**
 * Build the ChangeSet by observing the worktree.
 *
 * `lstat` rather than `stat`, so a symlink is recorded as a symlink instead of being
 * silently followed to whatever it points at. A change set that reported a symlink as
 * an ordinary file would hide the most interesting thing about it.
 */
export async function buildChangeSet(
  deps: ChangeSetDeps,
  workspace: EngineeringWorkspace,
  producerRunId?: string,
): Promise<ChangeSet> {
  const changed = await deps.git.changedPaths(workspace.baseCommit, workspace.path);
  const headCommit = await deps.git.headCommit(workspace.path);
  const diff = await deps.git.diff(workspace.baseCommit, workspace.path);

  /*
   * One call for every path that still exists, so each entry's identity is the one git
   * would store rather than a hash of the bytes on disk. A deleted path has no content
   * to hash and is skipped.
   */
  const present = changed
    .filter((c) => c.status !== 'D' && existsSync(join(workspace.path, c.path)))
    .map((c) => c.path);
  const blobIds = await deps.git.blobIdsFor(present, workspace.path);

  const entries: ChangedEntry[] = changed.map((c) => describeEntry(workspace.path, c, blobIds));

  const identity = {
    workItemId: workspace.workItemId,
    workspaceId: workspace.workspaceId,
    baseCommit: workspace.baseCommit,
    headCommit,
    entries: entries.map((e) => ({
      status: e.status,
      path: e.path,
      digest: e.digest ?? null,
      blobId: e.blobId ?? null,
      isSymlink: e.isSymlink,
      /*
       * SPEC: finding ENG-GIT-F1 (MEDIUM), 1.0.1 security review — the half of GIT-INT-MODE-1
       * that the first fix missed.
       *
       * The mode was added to the entry and to the integration comparison, and left out of the
       * identity this digest is built from. `chmod +x` on a tracked file leaves content and
       * blob id untouched, so the identity collided with the earlier ChangeSet and the stale
       * one was returned — meaning evidence gathered before the mode changed was treated as
       * still applying to a change that now differs in the executable bit.
       *
       * The comment below says the digest covers content so that editing a file moves it. The
       * mode is part of what the path holds, and covering it is the same idea one axis over.
       */
      gitMode: e.gitMode,
      /*
       * SPEC: finding ENG-GIT-REV-1 (MEDIUM), 1.0.1 security review — the same omission again,
       * one field along, found the same way.
       *
       * This projection is a hand-written list of the entry fields that count, so a field that
       * is not typed here is a difference the identity cannot see. `from` carries the source of
       * a rename or copy, and integration DOES honour it: identityFromChangeSet uses it to mark
       * the old side DELETED. The two halves of the system disagreed about what makes two
       * changes different.
       *
       * Rename A to C, or rename B to C with identical content, and every field above matched —
       * same status, same destination path, same digest, same blob id, same mode. The digest
       * collided, the earlier ChangeSet came back, and evidence bound to a change that deletes A
       * was treated as applying to one that deletes B.
       */
      from: e.from ?? null,
    })),
  };

  /*
   * Same change, same identity.
   *
   * Minting a fresh id every time the worktree was inspected made re-verification
   * destroy its own inputs: measuring, then measuring again with a reviewer required,
   * produced a second ChangeSet whose evidence set was empty — so a change that had
   * just passed every check came back NOT_VERIFIED. Identity has to be a function of
   * the change, not of when somebody looked at it.
   *
   * Staleness is unaffected, and is the whole reason the digest covers content: edit a
   * file and the digest moves, so the earlier evidence stops applying exactly as before.
   */
  const identityDigest = digestOf(canonicalJson(identity));
  const existing = listChangeSets(deps.store).find(
    (c) =>
      c.digest === identityDigest &&
      c.workspaceId === workspace.workspaceId &&
      c.baseCommit === workspace.baseCommit,
  );
  if (existing !== undefined) return existing;

  const changeSet = ChangeSetSchema.parse({
    changeSetId: deps.ids.next('SC-CS'),
    workItemId: workspace.workItemId,
    workspaceId: workspace.workspaceId,
    attempt: workspace.attempt,
    producerAgentId: workspace.producerAgentId,
    ...(producerRunId === undefined ? {} : { producerRunId }),
    baseCommit: workspace.baseCommit,
    headCommit,
    entries,
    diffDigest: digestOf(diff),
    digest: identityDigest,
    createdAt: deps.clock.now(),
  });

  const tx = deps.store.begin();
  tx.putCanon(CHANGESET_CANON_TYPE, changeSet.changeSetId, changeSet);
  tx.appendTrace(CHANGESET_STREAM, {
    type: 'CHANGESET_RECORDED',
    payload: {
      changeSetId: changeSet.changeSetId,
      workspaceId: workspace.workspaceId,
      entries: entries.length,
      digest: changeSet.digest,
    },
  });
  audit(tx, {
    action: AuditAction.CHANGESET_RECORDED,
    subject: changeSet.changeSetId,
    outcome: 'OK',
    detail: { workItemId: workspace.workItemId, entries: entries.length },
  });
  tx.commit();

  return changeSet;
}

/** The sentinel `IntegrationFact` uses for a path that is not there afterwards. */
const DELETED_MODE = 'DELETED';

function describeEntry(
  workspacePath: string,
  c: ChangedPath,
  blobIds: ReadonlyMap<string, string>,
): ChangedEntry {
  const abs = join(workspacePath, c.path);
  if (c.status === 'D' || !existsSync(abs)) {
    return ChangedEntrySchema.parse({
      status: c.status,
      path: c.path,
      ...(c.from === undefined ? {} : { from: c.from }),
      isBinary: false,
      isSymlink: false,
      gitMode: DELETED_MODE,
    });
  }
  // lstat, never stat: a symlink must be recorded as a symlink rather than
  // silently followed to whatever it points at.
  const l = lstatSync(abs);
  if (l.isSymbolicLink()) {
    // A symlink's identity IS its target, and git stores exactly that as the blob.
    // Recording no identity at all would let a link be repointed between verification
    // and integration without the comparison noticing.
    const target = Buffer.from(readlinkSync(abs), 'utf8');
    return ChangedEntrySchema.parse({
      status: c.status,
      path: c.path,
      ...(c.from === undefined ? {} : { from: c.from }),
      isBinary: false,
      isSymlink: true,
      gitMode: '120000',
      digest: digestOf(target.toString('utf8')),
      blobId: gitBlobId(target),
      sizeBytes: target.length,
    });
  }
  if (l.isDirectory()) {
    return ChangedEntrySchema.parse({
      status: c.status,
      path: c.path,
      ...(c.from === undefined ? {} : { from: c.from }),
      isBinary: false,
      isSymlink: false,
      gitMode: DELETED_MODE,
    });
  }
  const buf = readFileSync(abs);
  /*
   * `digest` stays a digest of the bytes on disk — that is what Serva saw. `blobId` is
   * what GIT would store, which is a different number whenever a filter is in play, and
   * it is the one the integration check compares against the index.
   */
  const blobId = blobIds.get(c.path);
  /* Git records exactly two modes for a regular file, and the executable bit is the axis. */
  const gitMode = (l.mode & 0o111) === 0 ? '100644' : '100755';
  return ChangedEntrySchema.parse({
    status: c.status,
    path: c.path,
    gitMode,
    ...(c.from === undefined ? {} : { from: c.from }),
    isBinary: looksBinary(buf),
    isSymlink: false,
    digest: digestOf(buf.toString('utf8')),
    ...(blobId === undefined ? {} : { blobId }),
    sizeBytes: statSync(abs).size,
  });
}

export function readChangeSet(store: Store, id: string): ChangeSet | undefined {
  const env = store.getCanon<unknown>(CHANGESET_CANON_TYPE, id);
  if (env === undefined) return undefined;
  const parsed = ChangeSetSchema.safeParse(env.body);
  return parsed.success ? parsed.data : undefined;
}

export function listChangeSets(store: Store): ChangeSet[] {
  return store
    .listCanonIds(CHANGESET_CANON_TYPE)
    .map((id) => readChangeSet(store, id))
    .filter((c): c is ChangeSet => c !== undefined);
}

/* ---------------------------------------------------- SC-RTC-005 scope conformance */

export const ScopeFindingKind = {
  OUTSIDE_ALLOWED_SCOPE: 'OUTSIDE_ALLOWED_SCOPE',
  FORBIDDEN_PATH: 'FORBIDDEN_PATH',
  ESCAPES_WORKSPACE: 'ESCAPES_WORKSPACE',
  UNEXPECTED_BINARY: 'UNEXPECTED_BINARY',
  UNEXPECTED_SYMLINK: 'UNEXPECTED_SYMLINK',
  CREDENTIAL_FILE: 'CREDENTIAL_FILE',
  LOCKFILE_CHANGED: 'LOCKFILE_CHANGED',
  GIT_METADATA: 'GIT_METADATA',
} as const;
export type ScopeFindingKind = (typeof ScopeFindingKind)[keyof typeof ScopeFindingKind];

export interface ScopeFinding {
  readonly kind: ScopeFindingKind;
  readonly path: string;
  readonly detail: string;
}

export interface ScopeConformanceResult {
  readonly conformant: boolean;
  readonly findings: readonly ScopeFinding[];
  readonly checked: number;
}

/** Files whose appearance in a change set is a finding whatever the scope says. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.aws\//i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)service-account.*\.json$/i,
]);

const LOCKFILE_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
]);

export interface ScopeOptions {
  /** Glob-ish prefixes the change may touch. Empty means nothing is in scope. */
  readonly allow: readonly string[];
  readonly forbid: readonly string[];
  readonly allowLockfileChanges?: boolean;
  readonly allowBinaryAdditions?: boolean;
  readonly allowSymlinks?: boolean;
}

/**
 * SC-RTC-005 — Scope Conformance Checker.
 *
 * Deterministic, no model involved. Compares what Serva OBSERVED against what the work
 * item declared, and resolves every path through symlinks before judging it, so a
 * rename or a link cannot carry a write out of scope while the recorded path still
 * looks innocent.
 */
export function checkScopeConformance(
  workspace: EngineeringWorkspace,
  changeSet: ChangeSet,
  options: ScopeOptions,
): ScopeConformanceResult {
  const findings: ScopeFinding[] = [];
  const workspaceReal = safeRealpath(workspace.path);

  for (const entry of changeSet.entries) {
    const candidates = [entry.path, ...(entry.from === undefined ? [] : [entry.from])];

    for (const rel of candidates) {
      // A path is judged where it actually lands, not where it says it is.
      const real = safeRealpath(join(workspace.path, rel));
      const inside =
        real === workspaceReal ||
        real.startsWith(workspaceReal.endsWith(sep) ? workspaceReal : workspaceReal + sep);
      if (!inside) {
        findings.push({
          kind: ScopeFindingKind.ESCAPES_WORKSPACE,
          path: rel,
          detail: 'Resolves to ' + real + ', which is outside the worktree.',
        });
        continue;
      }

      const normal = normalizePath(rel);
      if (normal.startsWith('.git/') || normal === '.git') {
        findings.push({
          kind: ScopeFindingKind.GIT_METADATA,
          path: rel,
          detail: 'Serva owns Git state; a Producer edits source artifacts, not history.',
        });
      }
      if (CREDENTIAL_PATTERNS.some((re) => re.test(normal))) {
        findings.push({
          kind: ScopeFindingKind.CREDENTIAL_FILE,
          path: rel,
          detail: 'A credential-shaped file may not be introduced or modified by a Producer.',
        });
      }
      if (options.forbid.some((f) => matchesPrefix(normal, f))) {
        findings.push({
          kind: ScopeFindingKind.FORBIDDEN_PATH,
          path: rel,
          detail: 'The work item forbids this path.',
        });
      }
      /*
       * AN EMPTY ALLOW LIST ALLOWS NOTHING, WHICH IS WHAT IT SAYS IT DOES.
       *
       * SPEC: finding ENGINEERING-GIT-AND-COMMIT-INTEGRITY/F1 (HIGH), 1.0.1 security review.
       *
       * `ScopeOptions.allow` is documented "Empty means nothing is in scope", and the guard
       * read `options.allow.length > 0 && …` — so an empty list produced no finding at all and
       * every path was reported conformant. The comment described a closed door and the code
       * held it open.
       *
       * Not reachable through the factory, whose schema requires `allowedScope` to have at
       * least one entry, and that is exactly why it survived: nothing exercised the case the
       * contract was written for. `assessScope` is exported, its contract is what a caller
       * reads, and a fail-open that only a future caller can reach is still a fail-open.
       */
      if (!options.allow.some((a) => matchesPrefix(normal, a))) {
        findings.push({
          kind: ScopeFindingKind.OUTSIDE_ALLOWED_SCOPE,
          path: rel,
          detail:
            options.allow.length === 0
              ? 'No scope was declared for this change, so nothing is in scope. Material ' +
                'discoveries outside scope become an Observation, not a silent edit.'
              : 'Not within the declared scope [' +
                options.allow.join(', ') +
                ']. Material discoveries outside scope become an Observation, not a silent edit.',
        });
      }
      if (
        LOCKFILE_PATTERNS.some((re) => re.test(normal)) &&
        options.allowLockfileChanges !== true
      ) {
        findings.push({
          kind: ScopeFindingKind.LOCKFILE_CHANGED,
          path: rel,
          detail: 'A dependency lockfile changed without authorization.',
        });
      }
    }

    if (entry.isBinary && options.allowBinaryAdditions !== true) {
      findings.push({
        kind: ScopeFindingKind.UNEXPECTED_BINARY,
        path: entry.path,
        detail: 'A binary artifact was added or modified; its contents cannot be reviewed.',
      });
    }
    if (entry.isSymlink && options.allowSymlinks !== true) {
      findings.push({
        kind: ScopeFindingKind.UNEXPECTED_SYMLINK,
        path: entry.path,
        detail: 'A symlink was added or modified; symlinks can redirect a later write.',
      });
    }
  }

  return { conformant: findings.length === 0, findings, checked: changeSet.entries.length };
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** Prefix match on whole path segments, so `src` never matches `srcret/`. */
export function matchesPrefix(path: string, prefix: string): boolean {
  const a = normalizePath(path);
  const b = normalizePath(prefix).replace(/\/+$/, '');
  /*
   * AN EMPTY PREFIX MATCHES NOTHING, RATHER THAN EVERYTHING.
   *
   * SPEC: finding GIT-INT-REVIEW-2 (MEDIUM), 1.0.1 security review.
   *
   * This returned true, and the scope check reads `!allow.some(a => matchesPrefix(path, a))`.
   * So a single empty string anywhere in `allowedScope` put the WHOLE repository in scope —
   * the fail-open this module had already been corrected for once, arriving through a data
   * value instead of a branch.
   *
   * Both callers are safer this way: an empty allow entry now allows nothing, and an empty
   * forbid entry forbids nothing. The schema refuses empty entries as well, because a value
   * that can only be a mistake should not be storable.
   */
  if (b.length === 0) return false;
  return a === b || a.startsWith(b + '/');
}

export function recordScopeResult(
  tx: Transaction,
  changeSet: ChangeSet,
  result: ScopeConformanceResult,
): void {
  audit(tx, {
    action: result.conformant
      ? AuditAction.CHANGESET_RECORDED
      : AuditAction.SCOPE_VIOLATION_DETECTED,
    subject: changeSet.changeSetId,
    outcome: result.conformant ? 'OK' : 'REFUSED',
    detail: {
      conformant: result.conformant,
      findings: result.findings.slice(0, 10).map((f) => f.kind + ':' + f.path),
    },
  });
}

/** Relative path of `abs` inside `root`, or undefined when it is outside. */
export function relativeInside(root: string, abs: string): string | undefined {
  const r = relative(safeRealpath(root), safeRealpath(abs));
  if (r.startsWith('..') || r.length === 0) return undefined;
  return r.replace(/\\/g, '/');
}
