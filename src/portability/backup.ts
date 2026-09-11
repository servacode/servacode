import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { fail } from '../core/errors.js';
import { canonicalJson, digestOf } from '../core/hash.js';
import { IsoSchema } from '../domain/schemas.js';
import { SERVA_DIR } from '../store/paths.js';
import { BACKUP_FORMAT_VERSION, SERVA_VERSION, SCHEMA_VERSION } from './version.js';
import { MACHINE_BOUND_KEYS, isMachineBound } from './machine.js';
import { scanText } from '../engineering/secrets.js';
import type { Clock } from '../core/clock.js';

/**
 * BACKUP — THE FEATURE THAT DECIDES WHETHER SERVA IS SOMETHING YOU CAN RELY ON.
 *
 * SPEC: §25, §26, §27, §32, 22 §5.
 *
 * Everything Serva knows about a project lives on one machine. That is the whole design —
 * local-first, single-owner, private — and it means the day the disk dies, the company
 * dies with it unless this file works. Not "mostly works": a backup that restores 95% of a
 * project is not a backup, because nobody can tell you which 5%.
 *
 * THE FORMAT IS A DIRECTORY, NOT AN ARCHIVE. Serva has one runtime dependency, and adding
 * a tar or zip parser to the one code path that consumes attacker-influenced input would
 * be the single worst place in the product to add an unaudited parser. A bundle is a
 * manifest plus a content tree, read with the same path confinement rules the Store uses.
 *
 * Four rules do the work:
 *
 *   NOTHING MACHINE-BOUND TRAVELS. Qualification, boundary fingerprints and OS
 *   measurements are excluded by the writer and refused by the reader. A restored machine
 *   starts UNQUALIFIED, whatever the source machine had achieved.
 *
 *   NO CREDENTIALS. Claude authentication, tokens, keys and environment files are excluded
 *   by path AND the content is scanned before it is written. A backup gets copied to a USB
 *   stick and emailed; a secret inside one is a secret forever.
 *
 *   A BACKUP IS NOT DONE UNTIL IT IS VERIFIED. The writer re-opens what it wrote, re-hashes
 *   every file and compares against the manifest. A half-written backup reporting SUCCESS
 *   is worse than a failure, because the owner stops worrying.
 *
 *   A BACKUP IS INPUT. On the way back in it is treated as hostile: every path is checked
 *   for traversal, every entry against the manifest, symlinks are refused outright, and
 *   totals are capped. It is not trusted because its filename ends in the right thing.
 */

/** Bounds. Generous for a real project, and finite, which is the point. */
export const BACKUP_LIMITS = Object.freeze({
  maxEntries: 200_000,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxFileBytes: 512 * 1024 * 1024,
});

/**
 * Paths never copied into a backup.
 *
 * Split by reason rather than merged into one list, because the two reasons have different
 * consequences: a regenerable directory being restored costs disk, and a credential being
 * restored costs the owner their account.
 */
export const EXCLUDED_REGENERABLE: readonly string[] = Object.freeze([
  'node_modules',
  'dist',
  'build',
  'out',
  '.turbo',
  '.next',
  '.cache',
  'coverage',
  '.vite',
]);

export const EXCLUDED_SENSITIVE: readonly string[] = Object.freeze([
  '.claude',
  '.claude.json',
  '.anthropic',
  '.aws',
  '.ssh',
  '.gnupg',
  '.npmrc',
  '.netrc',
  'id_rsa',
  'id_ed25519',
  'credentials.json',
  'secrets.json',
]);

/** Store subtrees that are scratch rather than truth. */
const EXCLUDED_STORE_SUBDIRS: readonly string[] = Object.freeze(['tmp', 'backups']);

/**
 * Credential shapes refused at write time.
 *
 * A deny-list cannot be complete and this one is not trying to be. It catches the specific
 * things that would end a Serva owner's day — a live Claude key, a GitHub token, a private
 * key — and its real job is to make a mistake loud rather than silent.
 */

export const BackupEntrySchema = z
  .object({
    /** Relative to the bundle's `content/` directory, with `/` separators always. */
    path: z.string().min(1),
    bytes: z.number().int().min(0),
    digest: z.string().min(1),
  })
  .strict();

export const BackupProjectSchema = z
  .object({
    projectId: z.string().min(1),
    name: z.string().min(1),
    /** Where this project's files live inside the bundle, relative to `content/`. */
    bundlePath: z.string().min(1),
    storeSchemaVersion: z.number().int().positive(),
    /** Git identity, recorded so a restore can prove the history came back intact. */
    git: z
      .object({
        head: z.string().min(1).optional(),
        branch: z.string().min(1).optional(),
        present: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const BackupManifestSchema = z
  .object({
    backupId: z.string().min(1),
    formatVersion: z.number().int().positive(),
    servaVersion: z.string().min(1),
    createdAt: IsoSchema,
    projects: z.array(BackupProjectSchema).min(1),
    inventory: z.array(BackupEntrySchema),
    totalBytes: z.number().int().min(0),
    /** What was left out, and why. An omission nobody recorded looks like an oversight. */
    excluded: z
      .array(
        z
          .object({
            path: z.string().min(1),
            reason: z.enum(['REGENERABLE', 'SENSITIVE', 'MACHINE_BOUND', 'SCRATCH']),
            detail: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    /** Machine-bound families deliberately not carried. Named, so a reader can check. */
    machineBoundExcluded: z.array(z.string().min(1)).default([]),
    /** Digest over the manifest without this field. The value verification compares. */
    integrityDigest: z.string().min(1),
  })
  .strict();
export type BackupManifest = z.output<typeof BackupManifestSchema>;

export const MANIFEST_NAME = 'serva-backup.json';
export const CONTENT_DIR = 'content';

export interface BackupDeps {
  readonly clock: Clock;
}

export interface BackupProjectInput {
  readonly projectId: string;
  readonly name: string;
  readonly root: string;
}

export interface BackupResult {
  readonly bundlePath: string;
  readonly manifest: BackupManifest;
  readonly verified: boolean;
  readonly summary: string;
  readonly warnings: readonly string[];
}

/* ------------------------------------------------------------------ path safety */

/** A manifest path is relative, normalized, forward-slashed, and inside the bundle. */
export function safeBundlePath(p: string): string | undefined {
  if (p === '' || isAbsolute(p) || p.includes('\0')) return undefined;
  if (/^[A-Za-z]:/.test(p)) return undefined;
  const normalized = normalize(p).split(sep).join('/');
  if (normalized.startsWith('../') || normalized === '..' || normalized.startsWith('/')) {
    return undefined;
  }
  if (normalized.split('/').some((seg) => seg === '..')) return undefined;
  return normalized;
}

/** Resolve a bundle-relative path under a root, refusing anything that escapes it. */
export function resolveInside(root: string, relPath: string): string {
  const safe = safeBundlePath(relPath);
  if (safe === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Refusing a backup entry whose path escapes the bundle: ' + relPath,
      remedy:
        'A backup is input. A path that leaves the bundle would let an archive write anywhere on the machine that restores it.',
      details: { path: relPath },
      specRef: '§32',
    });
  }
  const target = resolve(root, safe);
  const base = resolve(root);
  if (target !== base && !target.startsWith(base + sep)) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Refusing a backup entry that resolves outside the bundle: ' + relPath,
      remedy: 'Path confinement is checked after resolution, not before.',
      details: { path: relPath, resolved: target },
      specRef: '§32',
    });
  }
  return target;
}

function fileDigest(path: string): string {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return h.digest('hex');
}

/** The manifest digest, computed over everything except the digest itself. */
export function manifestDigest(m: Omit<BackupManifest, 'integrityDigest'>): string {
  return digestOf(canonicalJson(m));
}

/**
 * Dotenv files, by SHAPE rather than by the three somebody happened to list.
 *
 * SPEC: finding RELH-REV-M1 (MEDIUM), 1.0.1 security review.
 *
 * `EXCLUDED_SENSITIVE` named `.env`, `.env.local` and `.env.production`, so `.env.development`,
 * `.env.test` and `.env.staging` were copied verbatim. The three listed are not a rule, they
 * are the three that came to mind, and the convention they belong to has no fixed suffix.
 *
 * `.environment-notes.md` is deliberately not matched: the separator is required, so this
 * catches the convention and not every name that starts with the letters.
 */
const DOTENV = /^\.env(\..+)?$/;

export function isExcluded(
  name: string,
): { reason: BackupManifest['excluded'][number]['reason']; detail: string } | undefined {
  if (DOTENV.test(name)) {
    return {
      reason: 'SENSITIVE',
      detail: 'credential material never travels in a backup',
    };
  }
  if (EXCLUDED_SENSITIVE.includes(name)) {
    return {
      reason: 'SENSITIVE',
      detail: 'credential material never travels in a backup',
    };
  }
  if (EXCLUDED_REGENERABLE.includes(name)) {
    return {
      reason: 'REGENERABLE',
      detail: 'reproducible from source; restoring it would cost disk and prove nothing',
    };
  }
  return undefined;
}

/**
 * Scan text content for credential shapes. Returns what it found, never the value.
 *
 * ONE RULE SET, NOT A PRIVATE FIVE.
 *
 * SPEC: finding RELH-REV-M1 (MEDIUM), 1.0.1 security review - the third instance of this
 * class in the campaign, after SC-SSA-CRED-SHAPES in portabilityProof.ts.
 *
 * This module carried its own list of five patterns while `SECRET_RULES` in
 * engineering/secrets.ts carried the vendor shapes, connection strings, JWTs and generic
 * keyword assignments, and was widened twice during this work. A database URL with inline
 * credentials, a Google API key, a Slack token and a plain `password = ...` all passed the
 * local five - into the bundle the header says gets copied to a USB stick and emailed.
 *
 * Two rule sets for one question is how the weaker one survives. There is one now, and a
 * shape added to it protects the backup walk the day it is added.
 */
export function credentialScan(content: string): readonly string[] {
  return [...new Set(scanText('bundle', content).map((f) => f.description))];
}

/**
 * The longest credential shape the patterns can match.
 *
 * A chunked scan must overlap by at least this much, or a key straddling a chunk boundary is
 * split into two halves that match nothing. Generous on purpose: the cost of overlapping too
 * much is a little rescanning, and the cost of overlapping too little is a missed credential.
 */
const CREDENTIAL_WINDOW = 4096;

/** Chunks big enough to be efficient and small enough to stay off the heap. */
const SCAN_CHUNK_BYTES = 1024 * 1024;

/**
 * SCAN THE WHOLE FILE, WHATEVER ITS SIZE.
 *
 * SPEC: §32; HIGH finding BACKUP-RESTORE/SEC-1.
 *
 * `createBackup` scanned only files of 2MB or less, and copied everything larger into the
 * bundle unscanned — directly under a comment reading "THE CONTENT IS SCANNED, NOT ONLY THE
 * PATH". A log, a dump or a bundled config is exactly where a pasted key ends up, and exactly
 * the kind of file that clears 2MB. The cutoff protected the scan's running time at the
 * expense of the guarantee the scan exists to provide.
 *
 * Files here may be up to `maxFileBytes` (512MB), so this reads in overlapping chunks rather
 * than loading the file: bounded memory, and no boundary a credential can hide across.
 */
function scanFileForCredentials(absolute: string, bytes: number): readonly string[] {
  if (bytes <= SCAN_CHUNK_BYTES) {
    try {
      return credentialScan(readFileSync(absolute, 'utf8'));
    } catch {
      /* An unreadable file is excluded by the reader above; nothing to report here. */
      return [];
    }
  }

  const found = new Set<string>();
  const buffer = Buffer.alloc(SCAN_CHUNK_BYTES);
  let carry = '';
  let fd: number | undefined;
  try {
    fd = openSync(absolute, 'r');
    let position = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, SCAN_CHUNK_BYTES, position);
      if (read === 0) break;
      position += read;
      const text = carry + buffer.subarray(0, read).toString('utf8');
      for (const hit of credentialScan(text)) found.add(hit);
      /* Carry the tail so a credential spanning two chunks is still one string when scanned. */
      carry = text.slice(-CREDENTIAL_WINDOW);
    }
  } catch {
    return [...found];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return [...found];
}

interface WalkOutput {
  readonly entries: { path: string; absolute: string; bytes: number }[];
  readonly excluded: BackupManifest['excluded'][number][];
  readonly warnings: string[];
}

/**
 * Walk a project, collecting what belongs in a backup.
 *
 * Symlinks are recorded and skipped rather than followed. Following one would let a link
 * inside a project pull in anything the user can read — and a link that pointed at
 * `~/.claude` would put the owner's credentials in the bundle with no rule violated.
 */
function walkProject(root: string, bundlePrefix: string): WalkOutput {
  const entries: WalkOutput['entries'] = [];
  const excluded: WalkOutput['excluded'] = [];
  const warnings: string[] = [];

  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      warnings.push('could not read ' + rel + '; it is not in the backup');
      return;
    }
    for (const name of names) {
      const absolute = join(dir, name);
      const relPath = rel === '' ? name : rel + '/' + name;

      const skip = isExcluded(name);
      if (skip !== undefined) {
        excluded.push({ path: relPath, reason: skip.reason, detail: skip.detail });
        continue;
      }
      /*
       * NOTHING MACHINE-BOUND TRAVELS — ENFORCED BY THE WRITER, NOT ONLY THE READER.
       *
       * SPEC: §32; findings MIGR-1 and REL-HANDOVER-1.
       *
       * `MACHINE_BOUND_KEYS` was imported and used in exactly one place: to write
       * `machineBoundExcluded` into the manifest. Nothing here ever consulted it, so the field
       * described an exclusion that never happened, and enforcement existed only on the restore
       * path — which protects a bundle Serva restores and not a bundle somebody opens.
       *
       * The header's own threat scenario is the second one: "a backup gets copied to a USB
       * stick and emailed". `isMachineBound` is the same predicate the reader uses, so the two
       * sides cannot drift apart.
       */
      if (isMachineBound(relPath)) {
        excluded.push({
          path: relPath,
          reason: 'MACHINE_BOUND',
          detail:
            'qualification, identity and boundary facts are true of one machine, so they never travel',
        });
        continue;
      }
      if (rel === SERVA_DIR && EXCLUDED_STORE_SUBDIRS.includes(name)) {
        excluded.push({
          path: relPath,
          reason: 'SCRATCH',
          detail: 'working scratch inside the Store, not project truth',
        });
        continue;
      }

      let st;
      try {
        st = lstatSync(absolute);
      } catch {
        warnings.push('could not stat ' + relPath + '; it is not in the backup');
        continue;
      }
      if (st.isSymbolicLink()) {
        excluded.push({
          path: relPath,
          reason: 'SENSITIVE',
          detail:
            'a symbolic link is not followed: a link inside a project can point anywhere the user can read',
        });
        continue;
      }
      if (st.isDirectory()) {
        walk(absolute, relPath);
        continue;
      }
      if (!st.isFile()) {
        excluded.push({
          path: relPath,
          reason: 'SCRATCH',
          detail: 'not a regular file',
        });
        continue;
      }
      if (st.size > BACKUP_LIMITS.maxFileBytes) {
        excluded.push({
          path: relPath,
          reason: 'SCRATCH',
          detail:
            'larger than the ' +
            String(BACKUP_LIMITS.maxFileBytes) +
            ' byte per-file limit; it is named here rather than silently dropped',
        });
        continue;
      }
      entries.push({
        path: bundlePrefix + '/' + relPath,
        absolute,
        bytes: st.size,
      });
    }
  };

  walk(root, '');
  return { entries, excluded, warnings };
}

/** What `git.head` was ever meant to hold, and nothing else. */
const COMMIT_ID = /^[0-9a-f]{7,40}$/i;
/** Git's own ref-name rules, narrowed: no spaces, no traversal, no control characters. */
const BRANCH_NAME = /^[A-Za-z0-9._\/-]{1,255}$/;

/** Git identity, read from the repository rather than asserted. */
function gitIdentity(root: string): { head?: string; branch?: string; present: boolean } {
  const gitDir = join(root, '.git');
  if (!existsSync(gitDir)) return { present: false };
  try {
    const headRaw = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (headRaw.startsWith('ref: ')) {
      const ref = headRaw.slice(5).trim();
      const branch = ref.split('/').slice(2).join('/');
      /*
       * A REF IS FILE CONTENT, SO IT IS INPUT.
       *
       * SPEC: §32; finding BACKUP-RESTORE/BACKUP-RESTORE-F1.
       *
       * This was the one place in the file that built a filesystem path out of content it had
       * just read, with no confinement. `join` collapses `..`, so a crafted
       * `ref: ../../../../secrets.txt` put that file's contents verbatim into `git.head` — a
       * field `credentialScan` never sees, because the scan runs over copied content only.
       *
       * `safeBundlePath` is the same predicate every other path here goes through, and a
       * commit id is all this field was ever meant to hold: anything that does not look like
       * one is dropped rather than shipped.
       */
      const safeRef = safeBundlePath(ref);
      const refPath = safeRef === undefined ? undefined : join(gitDir, ...safeRef.split('/'));
      const raw =
        refPath !== undefined && existsSync(refPath)
          ? readFileSync(refPath, 'utf8').trim()
          : undefined;
      const head = COMMIT_ID.test(raw ?? '') ? raw : undefined;
      /*
       * The branch name is content too, so it is bounded to what git will accept as a ref
       * rather than shipped verbatim: `refs/heads/<anything>` is a line somebody can write.
       */
      const named = BRANCH_NAME.test(branch) ? branch : undefined;
      return {
        present: true,
        ...(named === undefined ? {} : { branch: named }),
        ...(head === undefined ? {} : { head }),
      };
    }

    /*
     * DETACHED HEAD IS THE SAME QUESTION, AND WAS NOT ASKED.
     *
     * SPEC: finding RELEASE-HANDOVER/RELH-REVIEW-1 (MEDIUM), 1.0.1 security review.
     *
     * The branch above was hardened for BACKUP-RESTORE-F1 and its commit id checked against a
     * shape. This branch returned the raw contents of `.git/HEAD` unchecked into the manifest
     * — a field `credentialScan` never sees, because the scan runs over copied content only.
     * The guard went into one arm of the same `if` and not the other.
     */
    return { present: true, ...(COMMIT_ID.test(headRaw) ? { head: headRaw } : {}) };
  } catch {
    return { present: true };
  }
}

/**
 * Create a verified backup.
 *
 * Written to a temporary directory and renamed into place, so an interrupted run leaves no
 * bundle rather than half of one. A partial directory that looks like a backup is the
 * failure mode this exists to prevent: the owner sees a folder with the right name and
 * stops worrying.
 */
export function createBackup(
  deps: BackupDeps,
  o: {
    readonly projects: readonly BackupProjectInput[];
    readonly destination: string;
    readonly backupId?: string;
  },
): BackupResult {
  if (o.projects.length === 0) {
    return fail({
      code: 'E_VALIDATION',
      message: 'A backup with no project in it is not a backup',
      remedy: 'Name at least one project root.',
      specRef: '§24',
    });
  }

  const createdAt = deps.clock.now();
  const backupId = o.backupId ?? 'serva-backup-' + createdAt.replace(/[:.]/g, '-');
  const finalPath = resolve(o.destination);
  const stagingPath = finalPath + '.partial';

  if (existsSync(finalPath)) {
    return fail({
      code: 'E_VALIDATION',
      message: 'A backup already exists at ' + finalPath,
      remedy:
        'Backups are never overwritten in place. Choose another destination, or remove the existing one deliberately.',
      details: { destination: finalPath },
      specRef: '§24',
    });
  }
  rmSync(stagingPath, { recursive: true, force: true });
  mkdirSync(join(stagingPath, CONTENT_DIR), { recursive: true });

  const inventory: z.output<typeof BackupEntrySchema>[] = [];
  const excluded: BackupManifest['excluded'][number][] = [];
  const warnings: string[] = [];
  const projects: z.output<typeof BackupProjectSchema>[] = [];
  let totalBytes = 0;

  try {
    for (const project of o.projects) {
      const root = resolve(project.root);
      if (!existsSync(join(root, SERVA_DIR))) {
        return fail({
          code: 'E_VALIDATION',
          message: project.root + ' is not a Serva project (no ' + SERVA_DIR + ' directory)',
          remedy: 'Back up a project Serva actually governs.',
          details: { root },
          specRef: '§24',
        });
      }

      const prefix = 'projects/' + project.projectId;
      const walked = walkProject(root, prefix);
      excluded.push(...walked.excluded);
      warnings.push(...walked.warnings);

      for (const e of walked.entries) {
        if (inventory.length >= BACKUP_LIMITS.maxEntries) {
          return fail({
            code: 'E_VALIDATION',
            message:
              'This project has more than ' +
              String(BACKUP_LIMITS.maxEntries) +
              ' files, which is beyond what a backup will carry',
            remedy:
              'A bound that is never reached is still the difference between a slow backup and one that never finishes.',
            specRef: '§32',
          });
        }
        totalBytes += e.bytes;
        if (totalBytes > BACKUP_LIMITS.maxTotalBytes) {
          return fail({
            code: 'E_VALIDATION',
            message: 'The backup exceeds the ' + String(BACKUP_LIMITS.maxTotalBytes) + ' byte cap',
            remedy: 'Exclude large generated content, or back projects up separately.',
            specRef: '§32',
          });
        }

        /*
         * THE CONTENT IS SCANNED, NOT ONLY THE PATH.
         *
         * A deny-list of filenames catches `.env`; it does not catch a key somebody pasted
         * into a note. This refuses at write time rather than warning, because the owner
         * will not read the warning and the file will be on a USB stick by then.
         */
        {
          const found = scanFileForCredentials(e.absolute, e.bytes);
          if (found.length > 0) {
            excluded.push({
              path: e.path,
              reason: 'SENSITIVE',
              detail:
                'excluded: the file contains what looks like ' +
                found.join(' and ') +
                '. A backup travels; a credential inside one travels with it.',
            });
            totalBytes -= e.bytes;
            continue;
          }
        }

        const target = resolveInside(join(stagingPath, CONTENT_DIR), e.path);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(e.absolute, target);
        inventory.push({ path: e.path, bytes: e.bytes, digest: fileDigest(target) });
      }

      projects.push({
        projectId: project.projectId,
        name: project.name,
        bundlePath: prefix,
        storeSchemaVersion: readStoreSchema(root),
        git: gitIdentity(root),
      });
    }

    const withoutDigest = {
      backupId,
      formatVersion: BACKUP_FORMAT_VERSION,
      servaVersion: SERVA_VERSION,
      createdAt,
      projects,
      inventory,
      totalBytes,
      excluded,
      machineBoundExcluded: [...MACHINE_BOUND_KEYS],
    };
    const manifest = BackupManifestSchema.parse({
      ...withoutDigest,
      integrityDigest: manifestDigest(withoutDigest),
    });
    writeFileSync(join(stagingPath, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8');

    /*
     * VERIFY BEFORE IT IS CALLED A BACKUP. The staging directory is checked exactly as a
     * restore would check it, and only then renamed into place — so a bundle at the final
     * path is one that has already been read back successfully.
     */
    const verification = verifyBackup(stagingPath);
    if (!verification.ok) {
      rmSync(stagingPath, { recursive: true, force: true });
      return fail({
        code: 'E_STORE_CORRUPT',
        message: 'The backup did not verify after being written: ' + verification.problems[0],
        remedy:
          'A half-written backup reporting success is worse than a failure, because the owner stops worrying. Nothing was left behind.',
        details: { problems: verification.problems.slice(0, 5) },
        specRef: '§26',
      });
    }

    renameSync(stagingPath, finalPath);
    return {
      bundlePath: finalPath,
      manifest,
      verified: true,
      summary:
        String(projects.length) +
        ' project(s), ' +
        String(inventory.length) +
        ' file(s), ' +
        formatBytes(totalBytes) +
        ' — verified',
      warnings,
    };
  } catch (e) {
    rmSync(stagingPath, { recursive: true, force: true });
    throw e;
  }
}

function readStoreSchema(root: string): number {
  const p = join(root, SERVA_DIR, 'SCHEMA_VERSION');
  if (!existsSync(p)) return SCHEMA_VERSION;
  const parsed = Number.parseInt(readFileSync(p, 'utf8').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : SCHEMA_VERSION;
}

export function formatBytes(n: number): string {
  if (n < 1024) return String(n) + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly manifest?: BackupManifest;
  readonly problems: readonly string[];
  readonly summary: string;
}

/**
 * Re-open a bundle and prove it is what its manifest says.
 *
 * Every failure is collected rather than thrown on the first one, because an owner staring
 * at a possibly-corrupt backup needs to know whether one file is damaged or the whole
 * thing is. The result is non-throwing for the same reason: "this backup is bad" is
 * information, not an exception.
 */
export function verifyBackup(
  bundlePath: string,
  limits: {
    readonly maxEntries: number;
    readonly maxTotalBytes: number;
    readonly maxFileBytes: number;
  } = BACKUP_LIMITS,
): VerifyResult {
  const problems: string[] = [];
  const manifestPath = join(bundlePath, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      problems: ['no ' + MANIFEST_NAME + ' at ' + bundlePath + ': this is not a Serva backup'],
      summary: 'not a Serva backup',
    };
  }

  let manifest: BackupManifest;
  try {
    const parsed = BackupManifestSchema.safeParse(
      JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown,
    );
    if (!parsed.success) {
      return {
        ok: false,
        problems: [
          'the manifest is malformed: ' +
            parsed.error.issues
              .slice(0, 3)
              .map((i) => i.path.join('.') + ' ' + i.message)
              .join('; '),
        ],
        summary: 'malformed manifest',
      };
    }
    manifest = parsed.data;
  } catch (e) {
    return {
      ok: false,
      problems: ['the manifest could not be read: ' + String(e instanceof Error ? e.message : e)],
      summary: 'unreadable manifest',
    };
  }

  /* The manifest's own integrity, before anything it claims is believed. */
  const { integrityDigest, ...rest } = manifest;
  const recomputed = manifestDigest(rest);
  if (recomputed !== integrityDigest) {
    problems.push(
      'the manifest does not match its own integrity digest, so its inventory cannot be trusted',
    );
  }

  /*
   * THE CAP, ON THE SIDE THAT FACES A BUNDLE FROM SOMEWHERE ELSE.
   *
   * SPEC: finding RELEASE-HANDOVER/RELH-F1 (MEDIUM), 1.0.1 security review.
   *
   * BACKUP_LIMITS was enforced only while WRITING a backup - over a project this machine
   * already holds, where the totals are whatever they are. The header promised that on the way
   * back in a bundle is treated as hostile and totals are capped, and the reading side did not
   * cap anything: `BackupManifestSchema` puts no maximum on `inventory`, so a crafted manifest
   * declaring millions of entries was walked in full, by verify and then by restore.
   *
   * The same shape as RELH-1 directly below, which found the credential scan running on the
   * writing side only. A limit that binds the party who is not the threat is not a limit.
   *
   * Checked from the manifest's DECLARED totals and before the walk, because the walk is the
   * cost: refusing after iterating an inventory has already paid for it. The per-file cap is
   * declared here too, since `entry.bytes` is compared to the real size further down and a
   * bundle that lies about it fails there instead.
   */
  const declaredBytes = manifest.inventory.reduce((sum, e) => sum + e.bytes, 0);
  const oversized = manifest.inventory.filter((e) => e.bytes > limits.maxFileBytes);
  const tooBig: string[] = [];
  if (manifest.inventory.length > limits.maxEntries) {
    tooBig.push(
      'the manifest declares ' +
        String(manifest.inventory.length) +
        ' entries, over the ' +
        String(limits.maxEntries) +
        ' this build will read',
    );
  }
  if (declaredBytes > limits.maxTotalBytes) {
    tooBig.push(
      'the manifest declares ' +
        String(declaredBytes) +
        ' bytes, over the ' +
        String(limits.maxTotalBytes) +
        ' this build will read',
    );
  }
  if (oversized.length > 0) {
    tooBig.push(
      String(oversized.length) +
        ' entry/entries declare more than the ' +
        String(limits.maxFileBytes) +
        ' byte per-file limit, the first being ' +
        String(oversized[0]?.path),
    );
  }
  if (tooBig.length > 0) {
    /* Returned rather than accumulated: the walk below is the cost being refused. */
    return {
      ok: false,
      problems: [...problems, ...tooBig],
      summary: 'this bundle is larger than this build will read',
    };
  }

  const contentRoot = join(bundlePath, CONTENT_DIR);
  let checked = 0;
  const seen = new Set<string>();
  for (const entry of manifest.inventory) {
    const safe = safeBundlePath(entry.path);
    if (safe === undefined) {
      problems.push('inventory entry escapes the bundle: ' + entry.path);
      continue;
    }
    if (seen.has(safe)) {
      problems.push('inventory lists ' + safe + ' twice');
      continue;
    }
    seen.add(safe);

    const target = join(contentRoot, ...safe.split('/'));
    if (!existsSync(target)) {
      problems.push('missing from the bundle: ' + safe);
      continue;
    }
    const st = lstatSync(target);
    if (st.isSymbolicLink()) {
      problems.push('refusing a symbolic link inside the bundle: ' + safe);
      continue;
    }
    if (st.size !== entry.bytes) {
      problems.push(
        safe + ' is ' + String(st.size) + ' bytes, the manifest says ' + String(entry.bytes),
      );
      continue;
    }
    if (fileDigest(target) !== entry.digest) {
      problems.push(safe + ' does not match its recorded digest');
      continue;
    }

    /*
     * THE SAME RULE, READ IN THE OTHER DIRECTION.
     *
     * SPEC: finding RELEASE-HANDOVER/RELH-1 (MEDIUM), 1.0.1 security review.
     *
     * Writing a backup scans file CONTENT, because a deny-list of filenames catches `.env` and
     * not a key somebody pasted into a note. Verifying one used to check the NAME alone — so
     * the guarantee below, 'no credential ever comes back', held against a bundle this machine
     * wrote and not against a bundle that arrived. A live key inside notes.txt passed, and
     * `performRestore` copies content verbatim.
     *
     * A guarantee is only as real as the boundary that enforces it, and this boundary is the
     * one that faces a bundle from somewhere else. Scanned here rather than in the restore
     * loop so that verifying tells the owner BEFORE anything is written.
     */
    const credentials = scanFileForCredentials(target, st.size);
    if (credentials.length > 0) {
      problems.push(
        safe +
          ' contains what looks like ' +
          credentials.join(' and ') +
          ': no credential comes back',
      );
      continue;
    }

    checked += 1;
  }

  /* Files present in the bundle that the manifest never mentioned. */
  for (const found of listFiles(contentRoot)) {
    if (!seen.has(found)) {
      problems.push(
        'the bundle contains ' + found + ', which the manifest does not list: it was not verified',
      );
    }
  }

  /* And the rule that survives every version: no credential ever comes back. */
  for (const entry of manifest.inventory) {
    const name = basename(entry.path);
    if (EXCLUDED_SENSITIVE.includes(name)) {
      problems.push('the manifest lists a credential file: ' + entry.path);
    }
  }

  return {
    ok: problems.length === 0,
    manifest,
    problems,
    summary:
      problems.length === 0
        ? 'verified: ' +
          String(checked) +
          ' file(s), ' +
          formatBytes(manifest.totalBytes) +
          ', ' +
          String(manifest.projects.length) +
          ' project(s)'
        : String(problems.length) + ' problem(s) found',
  };
}

/** Every regular file under a root, bundle-relative with forward slashes. */
function listFiles(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const absolute = join(dir, name);
      const st = lstatSync(absolute);
      if (st.isDirectory()) {
        walk(absolute);
        continue;
      }
      out.push(relative(root, absolute).split(sep).join('/'));
    }
  };
  walk(root);
  return out;
}

/** Size on disk, for the owner-facing summary. */
export function bundleSize(bundlePath: string): number {
  let total = 0;
  for (const f of listFiles(join(bundlePath, CONTENT_DIR))) {
    total += statSync(join(bundlePath, CONTENT_DIR, ...f.split('/'))).size;
  }
  return total;
}
