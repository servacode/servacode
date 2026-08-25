import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fail } from '../core/errors.js';
import { SERVA_DIR } from '../store/paths.js';
import {
  CONTENT_DIR,
  MANIFEST_NAME,
  formatBytes,
  resolveInside,
  safeBundlePath,
  verifyBackup,
} from './backup.js';
import { MIGRATABLE_BACKUP_FORMATS, planMigration } from './migration.js';
import { backupCompatibility, VersionCompatibility } from './version.js';
import { MACHINE_QUALIFICATION_TYPE } from './machine.js';
import type { BackupManifest } from './backup.js';
import type { MigrationPlan } from './migration.js';

/**
 * RESTORE — LOOK BEFORE YOU TOUCH ANYTHING.
 *
 * SPEC: §27, §29, §31, §32.
 *
 * A restore is the operation an owner runs on the worst day they have had in a while, and
 * it is the operation with the most destructive potential in the product: it writes a
 * whole project tree from a file that came from somewhere else.
 *
 * So it happens in two halves, and the first half never writes.
 *
 * `inspectRestore` opens the bundle, verifies every digest, resolves the version, plans any
 * migration, and reports exactly what would happen — including what would be overwritten
 * and what will NOT come back. The owner sees that before anything moves.
 *
 * `performRestore` then writes, into a staging directory that is renamed into place, so an
 * interrupted restore leaves the destination untouched rather than half-replaced.
 *
 * The rule that matters most is the one about the machine: HARD does not travel. A restored
 * project arrives with its truth, its history, its decisions and its evidence, and with no
 * qualification at all — because qualification is a statement about a computer, and this is
 * a different computer until somebody measures it.
 */

export const RestoreConflict = {
  /** Nothing is there. The simple case. */
  EMPTY: 'EMPTY',
  /** A Serva project with the same id is already there. */
  SAME_PROJECT: 'SAME_PROJECT',
  /** A Serva project with a DIFFERENT id is already there. Never overwritten silently. */
  DIFFERENT_PROJECT: 'DIFFERENT_PROJECT',
  /** Files that are not a Serva project. */
  OCCUPIED: 'OCCUPIED',
} as const;
export type RestoreConflict = (typeof RestoreConflict)[keyof typeof RestoreConflict];

export interface RestorePlanProject {
  readonly projectId: string;
  readonly name: string;
  readonly destination: string;
  readonly conflict: RestoreConflict;
  readonly files: number;
  readonly bytes: number;
}

export interface RestoreInspection {
  readonly ok: boolean;
  readonly manifest?: BackupManifest;
  readonly compatibility: string;
  readonly migration?: MigrationPlan;
  readonly projects: readonly RestorePlanProject[];
  /** What the restore will NOT bring back, stated before it runs rather than after. */
  readonly notRestored: readonly string[];
  readonly problems: readonly string[];
  readonly summary: string;
}

export interface RestoreOptions {
  readonly bundlePath: string;
  /** Where projects land. Each project restores into `<destinationRoot>/<projectId>`. */
  readonly destinationRoot: string;
  /** Required to write over an existing project. Never inferred. */
  readonly overwrite?: boolean;
}

/**
 * What a restore would do, without doing any of it.
 *
 * Non-throwing wherever the answer is information: an unreadable backup, an incompatible
 * version and an occupied destination are all things the owner needs to see, not
 * exceptions to catch.
 */
export function inspectRestore(o: RestoreOptions): RestoreInspection {
  const verification = verifyBackup(o.bundlePath);
  if (!verification.ok || verification.manifest === undefined) {
    return {
      ok: false,
      compatibility: 'unknown',
      projects: [],
      notRestored: [],
      problems: verification.problems,
      summary: 'this backup did not verify, so nothing will be restored from it',
    };
  }
  const manifest = verification.manifest;

  const compat = backupCompatibility(manifest.formatVersion, MIGRATABLE_BACKUP_FORMATS);
  if (
    compat.state === VersionCompatibility.UNSUPPORTED_NEW ||
    compat.state === VersionCompatibility.UNSUPPORTED_OLD
  ) {
    return {
      ok: false,
      manifest,
      compatibility: compat.reason,
      projects: [],
      notRestored: [],
      problems: [compat.reason],
      summary: 'this backup cannot be restored by this build of Serva',
    };
  }

  const migration =
    compat.state === VersionCompatibility.MIGRATABLE
      ? planMigration(manifest.formatVersion, manifest.projects[0]?.storeSchemaVersion)
      : undefined;

  const destinationRoot = resolve(o.destinationRoot);

  /*
   * THE PROJECT ID IS PART OF THE BUNDLE, AND A BUNDLE IS INPUT.
   *
   * SPEC: §32; CRITICAL finding INSTALL-UPDATE-ROLLBACK/SEC-1.
   *
   * Every FILE path here went through `safeBundlePath`/`resolveInside`, and the header states
   * the rule: "A BACKUP IS INPUT... every path is checked for traversal." The directory those
   * files all land in never was. `join(destinationRoot, p.projectId)` accepted `../../escaped`,
   * and `performRestore` then drove `rmSync`, `mkdirSync` and `renameSync` from it — including
   * displacing whatever it found at the target.
   *
   * The manifest digest does not help: `manifestDigest` is exported, so anyone crafting a
   * bundle re-signs it. A digest proves a bundle is self-consistent, never that its contents
   * are safe to act on.
   *
   * So the id is confined by the SAME helper the entries use rather than by a second, weaker
   * check written beside it. Nested ids stay legal — confinement is not a ban on structure.
   */
  const unconfined = manifest.projects.filter((p) => safeBundlePath(p.projectId) === undefined);

  const projects = manifest.projects.map((p): RestorePlanProject => {
    const safeId = safeBundlePath(p.projectId);
    /*
     * An unconfined id still gets a plan row, because inspection must be able to REPORT it.
     * The destination is pinned inside the root so that nothing downstream can act on the
     * escaping path, and `ok` is false below, so nothing downstream runs at all.
     */
    const destination =
      safeId === undefined ? join(destinationRoot, '.refused') : join(destinationRoot, safeId);
    const files = manifest.inventory.filter((e) => e.path.startsWith(p.bundlePath + '/'));
    return {
      projectId: p.projectId,
      name: p.name,
      destination,
      conflict: conflictAt(destination, p.projectId),
      files: files.length,
      bytes: files.reduce((n, e) => n + e.bytes, 0),
    };
  });

  const blocking = projects.filter(
    (p) => p.conflict !== RestoreConflict.EMPTY && o.overwrite !== true,
  );

  /* An escaping id is refused outright: no overwrite flag and no conflict state excuses it. */
  const problems = unconfined.map(
    (p) =>
      'the bundle names a project id that escapes the destination root: ' +
      JSON.stringify(p.projectId) +
      '. A backup is input, and a project id that leaves the root would let an archive write ' +
      'anywhere on the machine that restores it.',
  );

  return {
    ok: blocking.length === 0 && problems.length === 0,
    manifest,
    compatibility: compat.reason,
    ...(problems.length === 0 ? {} : { problems }),
    ...(migration === undefined ? {} : { migration }),
    projects,
    /*
     * SAID BEFORE, NOT DISCOVERED AFTER. An owner who learns after a restore that
     * engineering is blocked assumes something went wrong; one who was told beforehand
     * knows it is the design.
     */
    notRestored: [
      'Machine qualification — HARD is a property of a computer, not of a project. This machine begins UNQUALIFIED and must be measured before write-capable engineering runs.',
      'Claude authentication — credentials are never carried in a backup. Sign in on this machine.',
      ...manifest.excluded
        .filter((e) => e.reason === 'REGENERABLE')
        .slice(0, 3)
        .map((e) => e.path + ' — ' + e.detail),
    ],
    problems: blocking.map(
      (p) =>
        p.destination +
        ' already contains ' +
        (p.conflict === RestoreConflict.DIFFERENT_PROJECT
          ? 'a DIFFERENT Serva project'
          : p.conflict === RestoreConflict.SAME_PROJECT
            ? 'this project'
            : 'files') +
        '. Restoring over it needs explicit confirmation.',
    ),
    summary:
      String(projects.length) +
      ' project(s), ' +
      String(manifest.inventory.length) +
      ' file(s), ' +
      formatBytes(manifest.totalBytes) +
      (blocking.length === 0
        ? ' — ready to restore'
        : ' — blocked by ' + String(blocking.length) + ' conflict(s)'),
  };
}

function conflictAt(destination: string, projectId: string): RestoreConflict {
  if (!existsSync(destination)) return RestoreConflict.EMPTY;
  let names: string[];
  try {
    names = readdirSync(destination);
  } catch {
    return RestoreConflict.OCCUPIED;
  }
  if (names.length === 0) return RestoreConflict.EMPTY;
  if (!names.includes(SERVA_DIR)) return RestoreConflict.OCCUPIED;
  /*
   * A Serva project is there. Whether it is THE project matters: restoring over the same
   * project is a rollback, and restoring over a different one destroys somebody's work.
   */
  return destination.split(sep).pop() === projectId
    ? RestoreConflict.SAME_PROJECT
    : RestoreConflict.DIFFERENT_PROJECT;
}

export interface RestoreResult {
  readonly restored: readonly { readonly projectId: string; readonly destination: string }[];
  readonly files: number;
  readonly bytes: number;
  readonly migrationApplied?: MigrationPlan;
  readonly summary: string;
  readonly notes: readonly string[];
}

/**
 * Restore, having inspected first.
 *
 * Re-inspects rather than trusting a plan the caller passed in: the plan may be minutes
 * old, the destination may have changed, and the whole point of the inspection is that it
 * describes the state at the moment of writing.
 */
export function performRestore(o: RestoreOptions): RestoreResult {
  const inspection = inspectRestore(o);
  if (inspection.manifest === undefined) {
    return fail({
      code: 'E_STORE_CORRUPT',
      message: 'Refusing to restore an unverified backup: ' + inspection.problems[0],
      remedy: 'A backup is input. It is not trusted because its filename ends in the right thing.',
      details: { problems: inspection.problems.slice(0, 5) },
      specRef: '§32',
    });
  }
  /*
   * CONFINEMENT IS NOT A CONFLICT, SO `overwrite` DOES NOT WAIVE IT.
   *
   * SPEC: CRITICAL finding INSTALL-UPDATE-ROLLBACK/SEC-1.
   *
   * The refusal below is waived by `overwrite`, which is right for its own case: an owner who
   * says "yes, replace what is there" has answered the question that check asks. Nobody has
   * answered "yes, write outside the directory I named", and no flag on this call means that.
   * So this is checked first, separately, and admits no override.
   */
  const escaping = inspection.manifest.projects.filter(
    (p) => safeBundlePath(p.projectId) === undefined,
  );
  if (escaping.length > 0) {
    return fail({
      code: 'E_VALIDATION',
      message:
        'Refusing to restore a bundle whose project id escapes the destination root: ' +
        escaping.map((p) => JSON.stringify(p.projectId)).join(', '),
      remedy:
        'A backup is input. A project id that leaves the destination root would let an archive ' +
        'delete or replace files anywhere on the machine that restores it.',
      details: { projectIds: escaping.map((p) => p.projectId) },
      specRef: '§32',
    });
  }

  if (!inspection.ok && o.overwrite !== true) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Refusing to restore: ' + inspection.problems.join('; '),
      remedy:
        'Restoring over an existing project destroys what is there. Choose another destination, or pass overwrite deliberately.',
      details: { problems: inspection.problems },
      specRef: '§27',
    });
  }

  const manifest = inspection.manifest;
  const contentRoot = join(o.bundlePath, CONTENT_DIR);
  const restored: { projectId: string; destination: string }[] = [];
  const notes: string[] = [];
  let files = 0;
  let bytes = 0;

  for (const project of inspection.projects) {
    const staging = project.destination + '.restoring';
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });

    try {
      const source = manifest.projects.find((p) => p.projectId === project.projectId);
      if (source === undefined) continue;
      const prefix = source.bundlePath + '/';

      for (const entry of manifest.inventory) {
        if (!entry.path.startsWith(prefix)) continue;
        const withinProject = entry.path.slice(prefix.length);
        const safe = safeBundlePath(withinProject);
        if (safe === undefined) {
          return fail({
            code: 'E_VALIDATION',
            message: 'Refusing a backup entry that escapes the project: ' + entry.path,
            remedy: 'Path confinement is checked on the way in, every time.',
            specRef: '§32',
          });
        }
        /*
         * MACHINE-BOUND TRUTH DOES NOT COME BACK. Checked here as well as at write time,
         * because the bundle may have been written by an older build that did not know to
         * leave it out — and this is the side that runs on the machine being protected.
         */
        if (isMachineBound(safe)) {
          notes.push('not restored (machine-bound): ' + safe);
          continue;
        }

        const from = resolveInside(contentRoot, entry.path);
        const to = resolveInside(staging, safe);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        files += 1;
        bytes += entry.bytes;
      }

      if (existsSync(project.destination)) {
        const displaced =
          project.destination + '.replaced-' + String(manifest.createdAt).replace(/[:.]/g, '-');
        renameSync(project.destination, displaced);
        notes.push(
          'the previous contents of ' + project.destination + ' were moved to ' + displaced,
        );
      }
      mkdirSync(dirname(project.destination), { recursive: true });
      renameSync(staging, project.destination);
      restored.push({ projectId: project.projectId, destination: project.destination });
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw e;
    }
  }

  return {
    restored,
    files,
    bytes,
    ...(inspection.migration === undefined ? {} : { migrationApplied: inspection.migration }),
    summary:
      String(restored.length) +
      ' project(s) restored, ' +
      String(files) +
      ' file(s), ' +
      formatBytes(bytes),
    notes: [
      ...notes,
      'This machine is UNQUALIFIED. Project truth, history, decisions and evidence are restored; the authority to run write-capable engineering is not, because it was never a property of the project.',
    ],
  };
}

/** Does this path carry a fact about a machine rather than about a project? */
export function isMachineBound(relPath: string): boolean {
  const p = relPath.split('/');
  if (p[0] !== SERVA_DIR) return false;
  const joined = p.join('/');
  return (
    joined.includes(MACHINE_QUALIFICATION_TYPE) ||
    joined.includes('machine.identity') ||
    joined.includes('engineering.boundary') ||
    joined.includes('engineering.osQualification')
  );
}

/** A backup bundle is a directory with a manifest in it. Cheap enough to call anywhere. */
export function looksLikeBackup(path: string): boolean {
  return existsSync(join(path, MANIFEST_NAME));
}
