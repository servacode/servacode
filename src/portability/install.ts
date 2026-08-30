import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SCHEMA_VERSION, SERVA_VERSION } from './version.js';
import { storePaths } from '../store/paths.js';
import { fail } from '../core/errors.js';

/**
 * INSTALLING, UPDATING, AND GOING BACK.
 *
 * SPEC: Phase 6 closure §11; §34, §35.
 *
 * An independent audit found no distribution path at all: nothing said where Serva lives on a
 * machine, how a new version replaces an old one, or what happens when the new one turns out
 * to be worse. For a product an owner runs on their own computer, that last question is the
 * one that matters — an update with no way back is not an update, it is a gamble.
 *
 * The layout is deliberately dull:
 *
 *   <root>/versions/1.0.0/     one directory per installed version, never overwritten
 *   <root>/versions/1.1.0/
 *   <root>/current             which one runs
 *
 * Three rules hold it up, and each exists because the obvious shortcut is dangerous.
 *
 *   AN UPDATE NEVER DELETES THE VERSION IT REPLACES. Switching is renaming a pointer, so
 *   going back is the same operation in the other direction and takes no longer.
 *
 *   NOTHING HERE TOUCHES A PROJECT. Installation moves Serva's own files. Project data is
 *   migrated by the Store's own versioned path, separately and deliberately, because an
 *   installer that reached into project directories would make every update a data risk.
 *
 *   ROLLBACK IS REFUSED WHEN IT WOULD LOSE DATA. A project written by a newer Store schema
 *   cannot be opened by an older build; going back to that build would either fail loudly or,
 *   far worse, silently drop fields it did not understand. So the projects are checked BEFORE
 *   the pointer moves, and the refusal names them.
 */

/**
 * Where Serva keeps its own versions when nobody says otherwise.
 *
 * Under the owner's own data directory rather than a shared system location: this is a
 * single-owner product, and an installation somewhere requiring administrator rights would
 * make every update an escalation.
 *
 * Exported from here rather than defined next to the CLI command that first needed it. The
 * entry point has to resolve the same root the installer writes to, and two functions that
 * agree today are two functions that can disagree later.
 */
export function defaultInstallRoot(): string {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? process.cwd();
  return join(home, '.serva-code');
}

/**
 * Where a captured build lives, and its entry point.
 *
 * SPEC: the 1.0.1 packaging audit, §17.2.
 *
 * The layout lives here with the rest of it. `versions/<v>/` held only a marker until 1.0.1,
 * which is why switching between versions switched nothing — there was nothing on the other
 * end of the pointer to run.
 */
export function versionPayload(root: string, version: string): string {
  return join(root, VERSIONS_DIR, version, 'package');
}

export function versionEntrypoint(root: string, version: string): string {
  return join(versionPayload(root, version), 'dist', 'cli', 'main.js');
}

/** Whether a recorded version is one this machine could actually run. */
export function isRunnable(root: string, version: string): boolean {
  return existsSync(versionEntrypoint(root, version));
}

export const CURRENT_LINK = 'current';
export const VERSIONS_DIR = 'versions';
const MARKER = 'serva-version.json';

export const InstalledVersionSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    /** The Store schema this build understands. Rollback safety is decided on this. */
    storeSchema: z.number().int().positive(),
    installedAt: z.string().min(1),
  })
  .strict();
export type InstalledVersion = z.output<typeof InstalledVersionSchema>;

export interface Installation {
  readonly root: string;
  /** Every version present, newest first. */
  readonly installed: readonly InstalledVersion[];
  /** Which one `current` points at, when it points at anything. */
  readonly current?: InstalledVersion;
  /** The build actually executing right now, which may differ mid-update. */
  readonly running: { readonly version: string; readonly storeSchema: number };
  readonly problems: readonly string[];
}

function readMarker(dir: string): InstalledVersion | undefined {
  try {
    const parsed = InstalledVersionSchema.safeParse(
      JSON.parse(readFileSync(join(dir, MARKER), 'utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Compare two `a.b.c` versions. Newest first when used as a sort comparator. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** What is installed on this machine, and what is running. */
export function installation(root: string): Installation {
  const problems: string[] = [];
  const versionsRoot = join(root, VERSIONS_DIR);

  const installed: InstalledVersion[] = [];
  if (existsSync(versionsRoot)) {
    for (const entry of readdirSync(versionsRoot)) {
      const dir = join(versionsRoot, entry);
      if (!statSync(dir).isDirectory()) continue;
      const marker = readMarker(dir);
      if (marker === undefined) {
        problems.push(entry + ' has no readable version marker, so Serva does not know what it is');
        continue;
      }
      if (marker.version !== entry) {
        problems.push(
          entry + ' contains version ' + marker.version + ', so the directory name is misleading',
        );
      }
      installed.push(marker);
    }
  }
  installed.sort((a, b) => compareVersions(a.version, b.version));

  const currentPath = join(root, CURRENT_LINK);
  let current: InstalledVersion | undefined;
  if (existsSync(currentPath)) {
    const named = readFileSync(currentPath, 'utf8').trim();
    current = installed.find((v) => v.version === named);
    if (current === undefined) {
      problems.push('`current` names ' + named + ', which is not installed');
    }
  }

  return {
    root,
    installed,
    ...(current === undefined ? {} : { current }),
    running: { version: SERVA_VERSION, storeSchema: SCHEMA_VERSION },
    problems,
  };
}

export const ChangeOutcome = {
  /** Serva will do it. */
  READY: 'READY',
  /** Already true. Nothing moves. */
  NOT_REQUIRED: 'NOT_REQUIRED',
  /** Refused, and the reason says what would have been lost. */
  REFUSED: 'REFUSED',
} as const;
export type ChangeOutcome = (typeof ChangeOutcome)[keyof typeof ChangeOutcome];

export interface ChangePlan {
  readonly outcome: ChangeOutcome;
  readonly from?: string;
  readonly to: string;
  /** What actually happens, in order, in the owner's terms. */
  readonly steps: readonly string[];
  /** True when this can be undone by pointing `current` back. */
  readonly reversible: boolean;
  readonly reason: string;
}

/**
 * Move `current` to another installed version.
 *
 * SPEC: §11.
 *
 * `projectRoots` are checked rather than assumed empty. Going BACK to a build whose Store
 * schema is older than a project on this machine is the one irreversible mistake available
 * here, and the check has to happen before anything moves — an installer that discovers this
 * afterwards has already broken the thing it was meant to protect.
 */
/**
 * COMPLETENESS IS SOMETHING A CALLER STATES, NOT SOMETHING A LIST IMPLIES.
 *
 * SPEC: HIGH findings INSTALL-UPDATE-ROLLBACK/IUR-1 and IUR-REVIEW-1.
 *
 * Two rounds at this defect, and the second was caused by the first fix.
 *
 *   IUR-1: the CLI passed `[]` outside a project, the schema loop ran zero times, and a
 *   rollback that could strand every project returned READY. I made the empty case refuse.
 *
 *   IUR-REVIEW-1: inside a project it passed `[rt.root]`, one project was checked, and
 *   `performSwitch` then wrote `<root>/current` — a single MACHINE-GLOBAL pointer selecting
 *   the build every project on this machine runs under. One checked project cannot establish
 *   safety for a global effect.
 *
 * I fixed n=0 and left n=1, which is the same error at a different arity. The list was never
 * the problem; treating a list AS PROOF OF COMPLETENESS was. So a bare array can no longer be
 * passed at all: a caller either says it knows the whole set and on what basis, or says it
 * does not know — and not knowing refuses.
 */
export const UNKNOWN_PROJECTS = Symbol('the affected project set is not established');

export interface CompleteProjectSet {
  readonly complete: true;
  readonly roots: readonly string[];
  /**
   * How the caller knows this is EVERY project the pointer would affect.
   *
   * Required, and required to be non-empty, because "on what basis?" is the question the old
   * shape let everybody skip. A sentence nobody can write is a completeness claim nobody
   * should be making.
   */
  readonly basis: string;
}

export type ProjectInventory = CompleteProjectSet | typeof UNKNOWN_PROJECTS;

/** State that this is every affected project on the machine, and why you can say so. */
export function knownCompleteProjects(roots: readonly string[], basis: string): CompleteProjectSet {
  if (basis.trim() === '') {
    return fail({
      code: 'E_VALIDATION',
      message: 'A complete project inventory must say how it knows it is complete.',
      remedy:
        'Serva moves one machine-global pointer. Claiming to know every affected project ' +
        'without being able to say how is the shape of the defect this exists to prevent.',
      specRef: '§11',
    });
  }
  return { complete: true, roots: [...roots], basis };
}

export function planSwitch(
  install: Installation,
  toVersion: string,
  projectRoots: ProjectInventory = UNKNOWN_PROJECTS,
): ChangePlan {
  const target = install.installed.find((v) => v.version === toVersion);
  const from = install.current?.version;

  if (target === undefined) {
    return {
      outcome: ChangeOutcome.REFUSED,
      ...(from === undefined ? {} : { from }),
      to: toVersion,
      steps: [],
      reversible: false,
      reason:
        'Serva ' +
        toVersion +
        ' is not installed here. Install it first; nothing is downloaded automatically.',
    };
  }

  /*
   * RECORDED IS NOT THE SAME AS RUNNABLE.
   *
   * SPEC: the 1.0.1 packaging audit, §17.2.
   *
   * Through 1.0.0 a version directory held a marker and nothing else, so this function happily
   * planned a switch to a version that did not exist as a program. The pointer moved, the plan
   * said READY, and the owner kept running what they had. Refusing here is the difference
   * between a rollback and a rollback-shaped message.
   */
  if (!isRunnable(install.root, toVersion)) {
    return {
      outcome: ChangeOutcome.REFUSED,
      ...(from === undefined ? {} : { from }),
      to: toVersion,
      steps: [],
      reversible: false,
      reason:
        'Serva ' +
        toVersion +
        ' is recorded on this machine but has no runnable build at ' +
        versionEntrypoint(install.root, toVersion) +
        ', so switching to it would move the pointer and change nothing.',
    };
  }

  if (from === toVersion) {
    return {
      outcome: ChangeOutcome.NOT_REQUIRED,
      from,
      to: toVersion,
      steps: [],
      reversible: true,
      reason: 'Serva ' + toVersion + ' is already the current version.',
    };
  }

  /*
   * The projects, read directly. A project whose Store schema is newer than the target build
   * would be unreadable by it — and a build that "handles" that by opening it anyway would
   * drop every field it did not recognise.
   */
  /*
   * A SWITCH THAT CANNOT LOWER THE SCHEMA CEILING CANNOT STRAND ANYTHING.
   *
   * SPEC: the 1.0.1 packaging audit, section H; finding INSTALL-UPDATE-ROLLBACK/IUR-REVIEW-1.
   *
   * The inventory below is consulted for exactly one purpose: finding a project whose store
   * schema is NEWER than the target build understands. So when the target already understands
   * as much as every build recorded on this machine, there is no such project to find, and the
   * inventory cannot change the answer.
   *
   * Without this the refusal was unconditional in practice. The CLI always passes
   * UNKNOWN_PROJECTS — deliberately, because Serva holds no governed inventory and inventing
   * one would be inventing authority — so `serva install use` could never succeed at all, not
   * even for an UPGRADE, where no data risk exists in either direction. A safety check that
   * refuses every case is not protecting anyone; it is a feature that does not work.
   *
   * This narrows the refusal to what the module's own header promised: ROLLBACK IS REFUSED
   * WHEN IT WOULD LOSE DATA. Going BACK to a build that understands less still requires
   * knowing the projects, and still refuses when it does not.
   */
  const ceiling = Math.max(
    install.running.storeSchema,
    ...install.installed.map((v) => v.storeSchema),
  );
  const cannotLoseData = target.storeSchema >= ceiling;

  /*
   * UNKNOWN FAILS CLOSED.
   *
   * There is no governed inventory of the projects on this machine, so when the caller has not
   * established which are affected, this cannot say the rollback is safe. Refusing is the only
   * honest answer, and it is the one the header already promised.
   */
  if (projectRoots === UNKNOWN_PROJECTS && !cannotLoseData) {
    return {
      outcome: ChangeOutcome.REFUSED,
      ...(from === undefined ? {} : { from }),
      to: toVersion,
      reason:
        'This changes the machine-global `current` pointer, so it changes the Serva build ' +
        'EVERY project on this machine runs under. Serva cannot prove that every one of them ' +
        'can be opened by ' +
        toVersion +
        ', so the pointer was NOT changed and nothing was moved. A rollback past a store ' +
        'schema silently drops every field the older build does not understand.',
      steps: [],
      reversible: true,
    };
  }

  /* Reached with UNKNOWN_PROJECTS only when the switch cannot lower the ceiling, and then
     there is nothing for this loop to find. */
  const tooNew: string[] = [];
  for (const projectRoot of projectRoots === UNKNOWN_PROJECTS ? [] : projectRoots.roots) {
    /*
     * AN UNREADABLE SCHEMA MARKER FAILS CLOSED.
     *
     * SPEC: finding INSTALL-UPDATE-ROLLBACK/SEC-INST-1.
     *
     * A missing file was `continue`d and unparseable content fell through `Number.isFinite`,
     * so either state was silently treated as compatible and the rollback proceeded READY.
     * This is the check the file's own header calls the reason rollback happens before
     * anything moves — "ROLLBACK IS REFUSED WHEN IT WOULD LOSE DATA" — and it failed OPEN on
     * exactly the corrupt-store case that most needs it.
     */
    const schemaFile = storePaths(projectRoot).schemaVersion;
    if (!existsSync(schemaFile)) {
      tooNew.push(projectRoot + ' (no store schema marker, so its version is unknown)');
      continue;
    }
    const schema = Number.parseInt(readFileSync(schemaFile, 'utf8').trim(), 10);
    if (!Number.isFinite(schema)) {
      tooNew.push(projectRoot + ' (store schema marker is unreadable, so its version is unknown)');
    } else if (schema > target.storeSchema) {
      tooNew.push(projectRoot + ' (store schema ' + String(schema) + ')');
    }
  }

  if (tooNew.length > 0) {
    return {
      outcome: ChangeOutcome.REFUSED,
      ...(from === undefined ? {} : { from }),
      to: toVersion,
      steps: [],
      reversible: false,
      reason:
        'Serva ' +
        toVersion +
        ' understands store schema ' +
        String(target.storeSchema) +
        ', and these projects have been written by a newer one: ' +
        tooNew.join(', ') +
        '. Going back would either refuse to open them or silently drop what it did not ' +
        'understand. Restore a backup taken before the upgrade instead.',
    };
  }

  const goingBack = from !== undefined && compareVersions(from, toVersion) < 0;

  return {
    outcome: ChangeOutcome.READY,
    ...(from === undefined ? {} : { from }),
    to: toVersion,
    steps: [
      'point `current` at ' + toVersion,
      from === undefined
        ? 'nothing is replaced, because no version was current'
        : 'leave ' + from + ' installed, so this can be undone',
      'no project directory is opened, read or written',
    ],
    /*
     * Reversible in both directions, because the previous version stays on disk. That is the
     * whole reason updates are a pointer move rather than a replacement.
     */
    reversible: true,
    reason:
      (goingBack ? 'Going back to ' : 'Moving to ') +
      toVersion +
      (from === undefined ? '' : ' from ' + from) +
      '. The version you are leaving stays installed.',
  };
}

/**
 * Record a version as installed.
 *
 * Writes the marker and nothing else — the files themselves are put in place by whatever
 * delivered them. Serva does not download, and there is no code here that could.
 */
export function recordInstalled(
  root: string,
  version: string,
  storeSchema: number,
  at: string,
): InstalledVersion {
  const dir = join(root, VERSIONS_DIR, version);
  mkdirSync(dir, { recursive: true });
  const marker = InstalledVersionSchema.parse({ version, storeSchema, installedAt: at });
  writeFileSync(join(dir, MARKER), JSON.stringify(marker, null, 2) + '\n', 'utf8');
  return marker;
}

/**
 * Carry out a switch that was planned.
 *
 * Re-plans rather than trusting the plan it is given. A plan is a statement about the world at
 * the moment it was made, and between making one and acting on it a project can be created, an
 * upgrade can run, and the answer can change.
 */
export function performSwitch(
  install: Installation,
  toVersion: string,
  projectRoots: ProjectInventory = UNKNOWN_PROJECTS,
): ChangePlan {
  const plan = planSwitch(install, toVersion, projectRoots);
  if (plan.outcome !== ChangeOutcome.READY) return plan;
  writeFileSync(join(install.root, CURRENT_LINK), toVersion + '\n', 'utf8');
  return plan;
}

/**
 * Remove an installed version that is not current.
 *
 * The only destructive operation in this file, and it refuses the two cases that would leave
 * an owner stranded: removing what is running, and removing the last thing they could go back
 * to.
 */
export function removeVersion(install: Installation, version: string): ChangePlan {
  const from = install.current?.version;
  if (version === from) {
    return {
      outcome: ChangeOutcome.REFUSED,
      ...(from === undefined ? {} : { from }),
      to: version,
      steps: [],
      reversible: false,
      reason: 'Serva ' + version + ' is the current version. Switch away from it first.',
    };
  }
  if (install.installed.length <= 1) {
    return {
      outcome: ChangeOutcome.REFUSED,
      ...(from === undefined ? {} : { from }),
      to: version,
      steps: [],
      reversible: false,
      reason: 'This is the only installed version, and removing it would leave nothing to run.',
    };
  }
  if (!install.installed.some((v) => v.version === version)) {
    return {
      outcome: ChangeOutcome.NOT_REQUIRED,
      ...(from === undefined ? {} : { from }),
      to: version,
      steps: [],
      reversible: false,
      reason: 'Serva ' + version + ' is not installed here.',
    };
  }

  rmSync(join(install.root, VERSIONS_DIR, version), { recursive: true, force: true });
  return {
    outcome: ChangeOutcome.READY,
    ...(from === undefined ? {} : { from }),
    to: version,
    steps: ['removed ' + version, 'no project directory was touched'],
    /* Gone. This is the one thing here that cannot be undone by moving a pointer. */
    reversible: false,
    reason: 'Serva ' + version + ' was removed. You can no longer go back to it.',
  };
}

/** The owner-facing rendering. */
export function renderInstallation(install: Installation): string {
  const lines = ['Serva installations at ' + install.root, ''];

  if (install.installed.length === 0) {
    lines.push('  (none recorded)');
  }
  for (const v of install.installed) {
    const marks: string[] = [];
    if (v.version === install.current?.version) marks.push('current');
    if (v.version === install.running.version) marks.push('running');
    lines.push(
      '  ' +
        v.version.padEnd(10) +
        ' store schema ' +
        String(v.storeSchema) +
        '   installed ' +
        v.installedAt +
        (marks.length > 0 ? '   [' + marks.join(', ') + ']' : ''),
    );
  }

  /*
   * Said plainly, because it is the difference between an update and a gamble: an owner who
   * does not know they can go back will not try one.
   */
  lines.push('');
  if (install.installed.length > 1) {
    lines.push('Every version listed stays on disk, so switching between them is a pointer move.');
  }
  lines.push('Updating never opens a project directory. Store data moves on its own path.');

  if (install.problems.length > 0) {
    lines.push('');
    for (const problem of install.problems) lines.push('  ! ' + problem);
  }

  return lines.join('\n');
}
