import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_LINK,
  VERSIONS_DIR,
  installation,
  versionEntrypoint,
  versionPayload,
} from './install.js';

/**
 * THE POINTER HAS TO MOVE THE PROGRAM, OR IT IS NOT A ROLLBACK.
 *
 * SPEC: Phase 6 closure §11; the 1.0.1 packaging audit, section G/§17.2.
 *
 * `install.ts` was built on a promise: an update never deletes what it replaces, so going back
 * is a pointer move and costs what going forward did. Every part of that was implemented except
 * the part that makes it true. `install use` wrote `current`, and `current` was read by exactly
 * one thing — `install status`, to print it.
 *
 * So an owner could roll back, be told it worked, and keep running the build they had just
 * rolled away from. That is worse than having no rollback: it is a rollback that reports
 * success and changes nothing, discovered on the day they needed it.
 *
 * Two facts were missing, and both are here.
 *
 *   A VERSION DIRECTORY HAS TO CONTAIN A VERSION. `recordInstalled` writes a marker, which
 *   says a version exists without there being anything to run. `capture` puts the actual build
 *   next to the marker, so `versions/1.0.0/` is a Serva you can execute rather than a note
 *   saying you once could.
 *
 *   THE ENTRY POINT HAS TO ASK. `resolveActive` is called by `serva` before it does anything
 *   else. If `current` names a different version and that version is really there, the running
 *   process hands over to it.
 *
 * FAIL OPEN, DELIBERATELY. If the pointer names something damaged or missing, this runs the
 * build that was invoked and says so on stderr. The alternative — refusing to start — would
 * mean a corrupted pointer bricks the CLI an owner needs in order to fix the pointer.
 */

/** Set on the delegate so it cannot delegate again. One hop, never a chain. */
export const HANDOFF_ENV = 'SERVA_ACTIVE_VERSION';

/**
 * The directory of the package this code is running from.
 *
 * Walks up from the compiled module to the nearest `package.json`, because the answer differs
 * between a global npm install, a captured version, and a developer's checkout, and hard-coding
 * any one of them would break the other two.
 */
export function runningPackageRoot(fromDir: string): string | undefined {
  let dir = fromDir;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export interface ActiveVersion {
  /** Hand over to another build. */
  readonly handOffTo?: string;
  /** Said on stderr when the pointer could not be honoured. Never fatal. */
  readonly problem?: string;
}

/**
 * Commands that must be answered by the build the owner actually invoked.
 *
 * SPEC: the 1.0.1 packaging audit, §17.2.
 *
 * `install adopt` means "record the build I just ran". Handing that off makes the delegate
 * record ITSELF, so upgrading and adopting left the new version unrecorded and re-recorded the
 * old one — which is the precise opposite of what was asked. Found by upgrading for real.
 */
export function mustRunLocally(argv: readonly string[]): boolean {
  return argv[0] === 'install' && argv[1] === 'adopt';
}

/**
 * Decide whether this process should be the one that runs.
 *
 * Answers "no, run yourself" in every uncertain case. The only path to a handoff is an
 * unambiguous one: a pointer naming a different version whose entry point is on disk.
 */
export function resolveActive(input: {
  readonly root: string;
  readonly runningVersion: string;
  readonly alreadyHandedOff: boolean;
  readonly argv?: readonly string[];
}): ActiveVersion {
  /* A delegate never delegates. Without this a mutually-pointing pair would fork forever. */
  if (input.alreadyHandedOff) return {};
  if (input.argv !== undefined && mustRunLocally(input.argv)) return {};

  const pointer = join(input.root, CURRENT_LINK);
  if (!existsSync(pointer)) return {};

  let named: string;
  try {
    named = readFileSync(pointer, 'utf8').trim();
  } catch {
    return {};
  }
  if (named === '' || named === input.runningVersion) return {};

  /*
   * THE POINTER NAMES A VERSION. IT DOES NOT NAME A PATH.
   *
   * SPEC: findings IUR-SEC-A and IUR-CS-1 (MEDIUM), 1.0.1 security review.
   *
   * This took the pointer's contents and handed them straight to `versionEntrypoint`, which
   * builds a path with `join`. A pointer containing `../../..` therefore resolved OUTSIDE
   * `versions/`, and if a `dist/cli/main.js` existed at the far end, `main.ts` executed it as
   * the active Serva before any other logic ran.
   *
   * `installation()` in install.ts already cross-checks the name against what is installed and
   * records a problem when it does not match. The READ path validated and the EXECUTE path did
   * not — which is the wrong way round, because only one of them starts a process.
   *
   * Both checks are applied here. The format check is the same expression
   * `InstalledVersionSchema` enforces, so a name that could never have been recorded cannot be
   * obeyed; `..` and separators fail it outright. The installed-set check then requires the
   * version to be one this machine actually has.
   */
  if (!/^\d+\.\d+\.\d+$/.test(named)) {
    return {
      problem:
        'serva: `current` contains ' +
        JSON.stringify(named) +
        ', which is not a version number. Ignoring it and running ' +
        input.runningVersion +
        '.',
    };
  }

  const entry = versionEntrypoint(input.root, named);

  /*
   * Belt and braces: even a well-formed version must resolve inside `versions/`. The format
   * check above already excludes separators, so this can only fail if the layout helpers
   * change — which is exactly when a confinement check earns its keep.
   */
  const versionsRoot = resolve(input.root, VERSIONS_DIR);
  if (!resolve(entry).startsWith(versionsRoot + sep)) {
    return {
      problem:
        'serva: `current` resolves outside the versions directory, so it was not run. ' +
        'Running ' +
        input.runningVersion +
        '.',
    };
  }
  /*
   * And it must be a version this machine actually INSTALLED.
   *
   * Through `installation()` rather than by testing for the marker file here, so the execute
   * path and the read path agree by construction. A directory someone dropped into `versions/`
   * is not an installation, and the marker is what makes the difference.
   */
  if (!installation(input.root).installed.some((v) => v.version === named)) {
    return {
      problem:
        'serva: `current` names ' +
        named +
        ', which is not an installed version on this machine. Running ' +
        input.runningVersion +
        ' instead. `serva install status` lists what is installed.',
    };
  }

  if (!existsSync(entry)) {
    /*
     * The pointer is honest about intent and wrong about the world — which is what a version
     * removed by hand, or recorded before `capture` existed, looks like.
     */
    return {
      problem:
        'serva: `current` names ' +
        named +
        ', which is recorded but has no runnable build at ' +
        entry +
        '.\n' +
        'serva: running ' +
        input.runningVersion +
        ' instead. `serva install adopt` re-captures the build you are running.',
    };
  }

  return { handOffTo: entry };
}

/**
 * Copy the running build into the install root so it can be returned to later.
 *
 * The dependencies are copied too. Node resolves them by walking upward from the entry point,
 * and a global npm install puts `zod` BESIDE `serva-code` rather than inside it — so a captured
 * build that copied only the package directory would install cleanly and fail on first import,
 * which is the same defect this whole audit started from.
 */
export function capture(input: {
  readonly root: string;
  readonly version: string;
  readonly packageRoot: string;
}): {
  readonly captured: string;
  readonly dependencies: readonly string[];
  readonly alreadyThere?: boolean;
} {
  const target = versionPayload(input.root, input.version);

  /*
   * NEVER DELETE THE BUILD THAT IS RUNNING THIS CODE.
   *
   * Found by running it. `install adopt` under one version handed off to the captured build of
   * another, which then adopted ITSELF — and the `rmSync` below removed the directory it was
   * executing from, leaving a version recorded, current, and gone.
   *
   * A build asked to capture itself into the place it already lives is already captured.
   */
  if (resolve(input.packageRoot) === resolve(target)) {
    return { captured: target, dependencies: [], alreadyThere: true };
  }

  /* Replaced wholesale rather than merged: half of an old build under a new one is a state
     nobody can reason about, and this directory is Serva's to own. */
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  /*
   * WHAT THE PACKAGE SHIPS, NOT WHAT THE DIRECTORY HAPPENS TO CONTAIN.
   *
   * The first version of this copied the whole package root, which is right for a global npm
   * install and catastrophic in a developer checkout: `packageRoot` is then the repository, and
   * capturing it meant copying `src/`, `out/`, `evidence/` and `.git` — seven minutes, and a
   * "version" that is a snapshot of somebody's working tree.
   *
   * `dist` and the manifest ARE the runtime package — that is exactly what `files: ["dist"]`
   * puts in the tarball. Anything else in the directory is not part of the program.
   */
  for (const entry of ['dist', 'package.json', 'README.md', 'LICENSE']) {
    const from = join(input.packageRoot, entry);
    if (existsSync(from)) cpSync(from, join(target, entry), { recursive: true, dereference: true });
  }

  const manifest = JSON.parse(readFileSync(join(input.packageRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const names = Object.keys(manifest.dependencies ?? {});
  const require = createRequire(join(input.packageRoot, 'package.json'));

  const copied: string[] = [];
  const pending = [...names];
  const seen = new Set<string>();

  /* Transitively, because a dependency's dependencies are equally not optional. */
  while (pending.length > 0) {
    const name = String(pending.shift());
    if (seen.has(name)) continue;
    seen.add(name);

    let depManifest: string;
    try {
      depManifest = require.resolve(name + '/package.json');
    } catch {
      /* Recorded as absent rather than thrown: the capture is still better than none, and
         the delegate would fail loudly on import if this actually mattered. */
      continue;
    }
    const depRoot = dirname(depManifest);
    cpSync(depRoot, join(target, 'node_modules', name), { recursive: true, dereference: true });
    copied.push(name);

    const nested = JSON.parse(readFileSync(depManifest, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    pending.push(...Object.keys(nested.dependencies ?? {}));
  }

  return { captured: target, dependencies: copied };
}

/** The package directory of the build executing right now, from a compiled module's URL. */
export function packageRootFromUrl(moduleUrl: string): string | undefined {
  return runningPackageRoot(dirname(fileURLToPath(moduleUrl)));
}
