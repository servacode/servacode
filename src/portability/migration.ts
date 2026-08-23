import { SCHEMA_VERSION } from '../store/store.js';
import { BACKUP_FORMAT_VERSION } from './version.js';

/**
 * SCHEMA MIGRATION — FORWARD, VISIBLE, AND REVERSIBLE WHERE IT CAN BE.
 *
 * SPEC: §28, §31, 22 §5.
 *
 * A project written by Serva 1.0 will be opened by Serva 1.4, and a backup taken today
 * will be restored on a machine that does not exist yet. Migration is the thing standing
 * between those facts and silent data loss.
 *
 * Four rules, and the last one is the one that gets skipped in most systems:
 *
 *   FORWARD ONLY unless a step declares otherwise. Going backwards means deciding what to
 *   do with fields the older build has no concept of, and the honest answer is usually
 *   "lose them", which is not a migration.
 *
 *   VISIBLE BEFORE IT RUNS. The plan is computed and shown; nothing mutates during
 *   planning. An owner who can see the steps can refuse them.
 *
 *   A SNAPSHOT FIRST. Any migration that changes stored truth takes a backup of that truth
 *   before it starts, because a migration that fails halfway through is the worst state a
 *   Store can be in.
 *
 *   UNKNOWN IS REFUSED. A version this build has never heard of is not "probably fine".
 *   Deserialising unknown data and hoping is how a restore quietly discards the fields it
 *   did not recognise, and nobody finds out until the decision that relied on one is
 *   questioned.
 *
 * The registry is EMPTY at 1.0, and that is the honest state: there is no earlier released
 * format to migrate from. The machinery exists and is tested so the first real migration
 * is a data change rather than an architecture change written under pressure.
 */

export interface MigrationStep {
  readonly id: string;
  readonly fromFormat: number;
  readonly toFormat: number;
  readonly description: string;
  /** Whether this step can be undone if the one after it fails. */
  readonly reversible: boolean;
  /** True when the step rewrites stored project truth rather than metadata. */
  readonly touchesProjectTruth: boolean;
}

/**
 * Every migration this build knows how to perform.
 *
 * Empty at 1.0. A step is added here and nowhere else, so `MIGRATABLE_BACKUP_FORMATS` and
 * the plan can never disagree about what is possible — two lists would diverge the first
 * time somebody added a migration and forgot the other one.
 */
export const MIGRATION_STEPS: readonly MigrationStep[] = Object.freeze([]);

export const MIGRATABLE_BACKUP_FORMATS: ReadonlySet<number> = new Set(
  MIGRATION_STEPS.map((s) => s.fromFormat),
);

export const MigrationOutcome = {
  /** Already current. Nothing to do, and nothing is touched. */
  NOT_REQUIRED: 'NOT_REQUIRED',
  /** A path exists, and these are the steps. */
  PLANNED: 'PLANNED',
  /** Older than anything this build can move forward. */
  UNSUPPORTED: 'UNSUPPORTED',
  /** Newer than this build. Always refused. */
  FROM_THE_FUTURE: 'FROM_THE_FUTURE',
} as const;
export type MigrationOutcome = (typeof MigrationOutcome)[keyof typeof MigrationOutcome];

export interface MigrationPlan {
  readonly outcome: MigrationOutcome;
  readonly fromFormat: number;
  readonly toFormat: number;
  readonly fromStoreSchema?: number;
  readonly toStoreSchema: number;
  readonly steps: readonly MigrationStep[];
  /** True when a pre-migration snapshot is required before anything runs. */
  readonly snapshotRequired: boolean;
  readonly reversible: boolean;
  readonly explanation: string;
}

/**
 * Work out how to bring a backup forward, without changing anything.
 *
 * Returns a plan in every case including the refusals, because "this cannot be migrated"
 * is something the owner has to be able to read rather than an exception somebody catches
 * and turns into a shrug.
 */
export function planMigration(fromFormat: number, fromStoreSchema?: number): MigrationPlan {
  const base = {
    fromFormat,
    toFormat: BACKUP_FORMAT_VERSION,
    ...(fromStoreSchema === undefined ? {} : { fromStoreSchema }),
    toStoreSchema: SCHEMA_VERSION,
  };

  if (fromFormat > BACKUP_FORMAT_VERSION) {
    return {
      ...base,
      outcome: MigrationOutcome.FROM_THE_FUTURE,
      steps: [],
      snapshotRequired: false,
      reversible: false,
      explanation:
        'This backup was written by a newer Serva (format ' +
        String(fromFormat) +
        '). It is refused rather than read partially: a newer format may carry fields this build would drop, and a restore that silently discards what it did not understand leaves the owner no way to know what went missing.',
    };
  }

  if (
    fromFormat === BACKUP_FORMAT_VERSION &&
    (fromStoreSchema ?? SCHEMA_VERSION) === SCHEMA_VERSION
  ) {
    return {
      ...base,
      outcome: MigrationOutcome.NOT_REQUIRED,
      steps: [],
      snapshotRequired: false,
      reversible: true,
      explanation: 'The backup format and Store schema are current; nothing needs migrating.',
    };
  }

  const steps = chainFrom(fromFormat);
  if (steps === undefined) {
    return {
      ...base,
      outcome: MigrationOutcome.UNSUPPORTED,
      steps: [],
      snapshotRequired: false,
      reversible: false,
      explanation:
        'No migration path leads from format ' +
        String(fromFormat) +
        ' to ' +
        String(BACKUP_FORMAT_VERSION) +
        '. Restore it with a Serva build that understands it, take a fresh backup, and bring that forward.',
    };
  }

  return {
    ...base,
    outcome: MigrationOutcome.PLANNED,
    steps,
    snapshotRequired: steps.some((s) => s.touchesProjectTruth),
    reversible: steps.every((s) => s.reversible),
    explanation:
      String(steps.length) +
      ' step(s) bring this from format ' +
      String(fromFormat) +
      ' to ' +
      String(BACKUP_FORMAT_VERSION) +
      '. ' +
      (steps.some((s) => s.touchesProjectTruth)
        ? 'Project truth is rewritten, so a snapshot is taken first.'
        : 'No project truth is rewritten.'),
  };
}

/** Follow the steps forward, or return undefined if the chain does not reach the target. */
function chainFrom(fromFormat: number): readonly MigrationStep[] | undefined {
  const steps: MigrationStep[] = [];
  let current = fromFormat;
  /* Bounded: a cycle in the registry is a configuration error, not a hang. */
  for (let guard = 0; guard <= MIGRATION_STEPS.length; guard += 1) {
    if (current === BACKUP_FORMAT_VERSION) return steps;
    const next = MIGRATION_STEPS.find((s) => s.fromFormat === current);
    if (next === undefined) return undefined;
    steps.push(next);
    current = next.toFormat;
  }
  return undefined;
}

/**
 * Is the plan safe to run unattended?
 *
 * Anything that rewrites project truth needs the owner, even when it is reversible. A
 * migration is not a background task: it is the moment a project stops being the thing the
 * last backup described.
 */
export function migrationNeedsOwner(plan: MigrationPlan): boolean {
  return plan.outcome === MigrationOutcome.PLANNED && plan.snapshotRequired;
}
