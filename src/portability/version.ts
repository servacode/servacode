import { SCHEMA_VERSION } from '../store/store.js';

/**
 * SERVA CODE VERSION IDENTITY.
 *
 * SPEC: §34, 22 §5.
 *
 * Three numbers that are deliberately not the same number.
 *
 * `SERVA_VERSION` is the product: what the owner installed. It moves when features move
 * and it means nothing to a stored project.
 *
 * `SCHEMA_VERSION` is the Store on disk, and it is Phase 2's. A project written by an
 * older Serva is readable by a newer one only if this matches or a migration exists.
 *
 * `BACKUP_FORMAT_VERSION` is the archive. It moves independently of both, because a
 * backup written today has to be understood by a Serva installed in two years on a
 * machine that no longer exists — which is the entire point of writing one.
 *
 * Keeping them separate is not bureaucracy. Collapsing them means a cosmetic release
 * invalidates every backup, or worse, a real format change slides through under a version
 * that did not move.
 */

/** The product. Phase 6 is the final implementation phase for 1.0. */
export const SERVA_VERSION = '1.0.0';

/** The archive format this build writes and can read. */
export const BACKUP_FORMAT_VERSION = 1;

/** The Store schema this build understands, re-exported so callers need one import. */
export { SCHEMA_VERSION };

export interface VersionIdentity {
  readonly serva: string;
  readonly storeSchema: number;
  readonly backupFormat: number;
}

export function versionIdentity(): VersionIdentity {
  return {
    serva: SERVA_VERSION,
    storeSchema: SCHEMA_VERSION,
    backupFormat: BACKUP_FORMAT_VERSION,
  };
}

export const VersionCompatibility = {
  /** Same version. Nothing to do. */
  CURRENT: 'CURRENT',
  /** Older, and a migration path exists. */
  MIGRATABLE: 'MIGRATABLE',
  /** Older, and nothing knows how to move it forward. */
  UNSUPPORTED_OLD: 'UNSUPPORTED_OLD',
  /**
   * NEWER than this build.
   *
   * Refused, always. A newer format may contain fields this build would silently drop,
   * and a restore that quietly discards data it did not understand is worse than one that
   * refuses — the owner would have no way to know what went missing.
   */
  UNSUPPORTED_NEW: 'UNSUPPORTED_NEW',
} as const;
export type VersionCompatibility = (typeof VersionCompatibility)[keyof typeof VersionCompatibility];

export interface CompatibilityVerdict {
  readonly state: VersionCompatibility;
  readonly reason: string;
}

/**
 * Can this build read that backup?
 *
 * `migratableFrom` is passed in rather than hard-coded so the migration registry stays the
 * single source of truth about what can move forward — two lists would disagree the first
 * time somebody added a migration and forgot the other one.
 */
export function backupCompatibility(
  formatVersion: number,
  migratableFrom: ReadonlySet<number>,
): CompatibilityVerdict {
  if (formatVersion === BACKUP_FORMAT_VERSION) {
    return { state: VersionCompatibility.CURRENT, reason: 'the backup format is current' };
  }
  if (formatVersion > BACKUP_FORMAT_VERSION) {
    return {
      state: VersionCompatibility.UNSUPPORTED_NEW,
      reason:
        'this backup was written by a newer Serva (format ' +
        String(formatVersion) +
        ', this build reads ' +
        String(BACKUP_FORMAT_VERSION) +
        '). Restoring it here could silently drop data this build does not understand.',
    };
  }
  if (migratableFrom.has(formatVersion)) {
    return {
      state: VersionCompatibility.MIGRATABLE,
      reason:
        'the backup is format ' +
        String(formatVersion) +
        ' and a migration to ' +
        String(BACKUP_FORMAT_VERSION) +
        ' exists',
    };
  }
  return {
    state: VersionCompatibility.UNSUPPORTED_OLD,
    reason:
      'the backup is format ' +
      String(formatVersion) +
      ' and no migration to ' +
      String(BACKUP_FORMAT_VERSION) +
      ' is registered',
  };
}
