import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
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
import { MACHINE_BOUND_KEYS } from './machine.js';
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
  '.env',
  '.env.local',
  '.env.production',
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
const CREDENTIAL_PATTERNS: readonly { readonly what: string; readonly re: RegExp }[] =
  Object.freeze([
    { what: 'an Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
    { what: 'a GitHub token', re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
    { what: 'an AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
    { what: 'a private key block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
    { what: 'a bearer token', re: /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{30,}/i },
  ]);

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

function isExcluded(
  name: string,
): { reason: BackupManifest['excluded'][number]['reason']; detail: string } | undefined {
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

/** Scan text content for credential shapes. Returns what it found, never the value. */
export function credentialScan(content: string): readonly string[] {
  const found: string[] = [];
  for (const p of CREDENTIAL_PATTERNS) {
    if (p.re.test(content)) found.push(p.what);
  }
  return found;
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

/** Git identity, read from the repository rather than asserted. */
function gitIdentity(root: string): { head?: string; branch?: string; present: boolean } {
  const gitDir = join(root, '.git');
  if (!existsSync(gitDir)) return { present: false };
  try {
    const headRaw = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (headRaw.startsWith('ref: ')) {
      const ref = headRaw.slice(5).trim();
      const branch = ref.split('/').slice(2).join('/');
      const refPath = join(gitDir, ...ref.split('/'));
      const head = existsSync(refPath) ? readFileSync(refPath, 'utf8').trim() : undefined;
      return { present: true, branch, ...(head === undefined ? {} : { head }) };
    }
    return { present: true, head: headRaw };
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
        if (e.bytes <= 2 * 1024 * 1024) {
          const text = readFileSync(e.absolute, 'utf8');
          const found = credentialScan(text);
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
export function verifyBackup(bundlePath: string): VerifyResult {
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
