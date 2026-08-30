import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ChangeOutcome,
  compareVersions,
  installation,
  performSwitch,
  UNKNOWN_PROJECTS,
  knownCompleteProjects,
  planSwitch,
  recordInstalled,
  removeVersion,
  renderInstallation,
  versionEntrypoint,
  isRunnable,
} from '../src/portability/install.js';
import { SCHEMA_VERSION, SERVA_VERSION } from '../src/portability/version.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { cleanup, tempRoot } from './helpers.js';
import { cmdInstall } from '../src/cli/commands/portability.js';
import { parseArgs } from '../src/cli/main.js';
import { resolveActive } from '../src/portability/activeVersion.js';

/**
 * AN UPDATE WITH NO WAY BACK IS A GAMBLE.
 *
 * SPEC: Phase 6 closure §11.
 *
 * There was no distribution path at all — nothing said where Serva lives, how a new version
 * replaces an old one, or what happens when the new one turns out to be worse. On a machine
 * somebody actually depends on, that last question is the important one.
 *
 * Most of what is worth testing here is what the installer REFUSES. An installer that always
 * succeeds is easy to write and is exactly how somebody loses a project.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

function installRoot(): string {
  const root = tempRoot();
  roots.push(root);
  return root;
}

/**
 * An install root with the given versions present, and one of them current.
 *
 * Each version gets an entry point as well as a marker.
 *
 * SPEC: the 1.0.1 packaging audit, §17.2.
 *
 * This used to write markers only, which is precisely the state 1.0.0 shipped in: a version
 * that is recorded and cannot run. Every switching test in this file was therefore switching
 * between two things that did not exist, and passed. The fixture now builds what the name
 * claims, and `installRunnable` below is the one that asserts the difference matters.
 */
function withVersions(versions: readonly (readonly [string, number])[], current?: string): string {
  const root = installRoot();
  for (const [version, schema] of versions) {
    recordInstalled(root, version, schema, '2026-08-24T00:00:00.000Z');
    const entry = versionEntrypoint(root, version);
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, '/* a stand-in for a real build */\n', 'utf8');
  }
  if (current !== undefined) writeFileSync(join(root, 'current'), current + '\n', 'utf8');
  return root;
}

/* ======================================================== what is actually installed */

describe('the installation is read from disk, not declared', () => {
  it('lists what is there, newest first, and says which runs', () => {
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['1.1.0', 4],
      ],
      '1.1.0',
    );
    const state = installation(root);
    expect(state.installed.map((v) => v.version)).toEqual(['1.1.0', '1.0.0']);
    expect(state.current?.version).toBe('1.1.0');
    expect(state.running.version).toBe(SERVA_VERSION);
    expect(state.running.storeSchema).toBe(SCHEMA_VERSION);
    expect(state.problems).toEqual([]);
  });

  it('reports a `current` pointing at something that is not installed', () => {
    const root = withVersions([['1.0.0', 3]], '9.9.9');
    const state = installation(root);
    expect(state.current).toBeUndefined();
    expect(state.problems.join(' ')).toContain('not installed');
  });

  it('reports a directory whose name disagrees with what is in it', () => {
    const root = installRoot();
    recordInstalled(root, '1.0.0', 3, 'T');
    /* The marker is the authority; the directory name is a convenience that can drift. */
    const dir = join(root, 'versions', '2.0.0');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'serva-version.json'),
      JSON.stringify({ version: '1.5.0', storeSchema: 3, installedAt: 'T' }),
      'utf8',
    );
    expect(installation(root).problems.join(' ')).toContain('misleading');
  });

  it('an empty root is not an error, it is a machine with nothing installed', () => {
    const state = installation(installRoot());
    expect(state.installed).toEqual([]);
    expect(state.problems).toEqual([]);
  });

  it('orders versions numerically rather than as strings', () => {
    /* `1.10.0` is newer than `1.9.0`, which string ordering gets backwards. */
    expect(compareVersions('1.10.0', '1.9.0')).toBeLessThan(0);
    const root = withVersions([
      ['1.9.0', 3],
      ['1.10.0', 3],
    ]);
    expect(installation(root).installed[0]?.version).toBe('1.10.0');
  });
});

/* ================================================================== switching versions */

describe('switching is a pointer move, in both directions', () => {
  it('moves current and leaves the version being left installed', () => {
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['1.1.0', 3],
      ],
      '1.1.0',
    );
    /* No projects on this fixture machine — stated, with the basis for saying so. */
    const plan = performSwitch(
      installation(root),
      '1.0.0',
      knownCompleteProjects([], 'this fixture machine holds no projects'),
    );
    expect(plan.outcome).toBe(ChangeOutcome.READY);
    expect(plan.reversible).toBe(true);

    const after = installation(root);
    expect(after.current?.version).toBe('1.0.0');
    /* The whole point: what you left is still there. */
    expect(after.installed.map((v) => v.version)).toContain('1.1.0');
    expect(existsSync(join(root, 'versions', '1.1.0'))).toBe(true);
  });

  it('going back and forward again are the same operation', () => {
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['1.1.0', 3],
      ],
      '1.1.0',
    );
    const none = knownCompleteProjects([], 'this fixture machine holds no projects');
    performSwitch(installation(root), '1.0.0', none);
    const forward = performSwitch(installation(root), '1.1.0', none);
    expect(forward.outcome).toBe(ChangeOutcome.READY);
    expect(installation(root).current?.version).toBe('1.1.0');
  });

  it('switching to what is already current changes nothing', () => {
    const root = withVersions([['1.1.0', 3]], '1.1.0');
    expect(planSwitch(installation(root), '1.1.0').outcome).toBe(ChangeOutcome.NOT_REQUIRED);
  });

  it('refuses a version that is not installed, rather than fetching it', () => {
    const root = withVersions([['1.0.0', 3]], '1.0.0');
    const plan = planSwitch(installation(root), '2.0.0');
    expect(plan.outcome).toBe(ChangeOutcome.REFUSED);
    expect(plan.reason).toContain('nothing is downloaded automatically');
  });

  it('the module has no way to download anything', () => {
    /*
     * Structural rather than behavioural. A local-first product that could fetch its own
     * updates has a network path nobody asked for, and the strongest statement available is
     * that the code to use one is not present.
     */
    const source = readFileSync('src/portability/install.ts', 'utf8');
    for (const forbidden of ['node:https', 'node:http', 'fetch(', 'node:net', 'undici']) {
      expect(source, 'the installer must not be able to ' + forbidden).not.toContain(forbidden);
    }
  });
});

/* ============================================ the refusal that actually protects data */

describe('rollback is refused when it would lose data', () => {
  function projectWithSchema(schema: number): string {
    const root = tempRoot();
    roots.push(root);
    const rt = ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root });
    rt.close();
    /* Simulate a project written by a newer build. */
    writeFileSync(join(root, '.serva', 'SCHEMA_VERSION'), String(schema), 'utf8');
    return root;
  }

  it('refuses to go back to a build older than a project on this machine', () => {
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['2.0.0', 9],
      ],
      '2.0.0',
    );
    const project = projectWithSchema(9);
    const plan = planSwitch(
      installation(root),
      '1.0.0',
      knownCompleteProjects([project], 'the only project here'),
    );

    expect(plan.outcome).toBe(ChangeOutcome.REFUSED);
    expect(plan.reason).toContain('store schema 3');
    expect(plan.reason).toContain('silently drop');
    /* And it names the project, so the owner can act rather than guess. */
    expect(plan.reason).toContain(project);
  });

  it('nothing moves when the switch is refused', () => {
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['2.0.0', 9],
      ],
      '2.0.0',
    );
    performSwitch(
      installation(root),
      '1.0.0',
      knownCompleteProjects([projectWithSchema(9)], 'the only project here'),
    );
    expect(installation(root).current?.version).toBe('2.0.0');
  });

  it('allows the rollback when every project is still readable by the older build', () => {
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['2.0.0', 9],
      ],
      '2.0.0',
    );
    const plan = planSwitch(
      installation(root),
      '1.0.0',
      knownCompleteProjects([projectWithSchema(3)], 'the only project here'),
    );
    expect(plan.outcome).toBe(ChangeOutcome.READY);
  });

  it('says out loud that it opens no project', () => {
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['1.1.0', 3],
      ],
      '1.1.0',
    );
    const plan = planSwitch(
      installation(root),
      '1.0.0',
      knownCompleteProjects([], 'this fixture machine holds no projects'),
    );
    expect(plan.steps.join(' ')).toContain('no project directory is opened');
  });
});

/* ==================================================================== removing versions */

describe('removing a version is the one thing that cannot be undone', () => {
  it('refuses to remove what is current', () => {
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['1.1.0', 3],
      ],
      '1.1.0',
    );
    const plan = removeVersion(installation(root), '1.1.0');
    expect(plan.outcome).toBe(ChangeOutcome.REFUSED);
    expect(existsSync(join(root, 'versions', '1.1.0'))).toBe(true);
  });

  it('refuses to remove the only thing installed', () => {
    const root = withVersions([['1.0.0', 3]]);
    const plan = removeVersion(installation(root), '1.0.0');
    expect(plan.outcome).toBe(ChangeOutcome.REFUSED);
    expect(plan.reason).toContain('nothing to run');
  });

  it('removes an older version, and says the way back is gone', () => {
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['1.1.0', 3],
      ],
      '1.1.0',
    );
    const plan = removeVersion(installation(root), '1.0.0');
    expect(plan.outcome).toBe(ChangeOutcome.READY);
    expect(plan.reversible).toBe(false);
    expect(plan.reason).toContain('no longer go back');
    expect(existsSync(join(root, 'versions', '1.0.0'))).toBe(false);
  });
});

/* ========================================================================= the rendering */

describe('the owner can see whether they can go back', () => {
  it('says the versions stay on disk when more than one is installed', () => {
    const rendered = renderInstallation(
      installation(
        withVersions(
          [
            ['1.0.0', 3],
            ['1.1.0', 3],
          ],
          '1.1.0',
        ),
      ),
    );
    expect(rendered).toContain('stays on disk');
    expect(rendered).toContain('[current]');
  });

  it('always says that updating does not touch a project', () => {
    expect(renderInstallation(installation(installRoot()))).toContain(
      'never opens a project directory',
    );
  });
});

/* ====== a machine-global pointer needs machine-wide evidence ====== */

describe('rollback refuses unless the affected project set is COMPLETE', () => {
  /*
   * SPEC: HIGH findings INSTALL-UPDATE-ROLLBACK/IUR-1 and IUR-REVIEW-1.
   *
   * Two rounds at the same defect, and the second was caused by the first fix.
   *
   *   IUR-1: the CLI passed `[]` outside a project, the schema loop ran zero times, `tooNew`
   *   stayed empty, and rollback returned READY. I made the empty case fail closed.
   *
   *   IUR-REVIEW-1: inside a project it passed `[rt.root]`, one project was checked, and
   *   `performSwitch` then wrote `<root>/current` — a single MACHINE-GLOBAL pointer selecting
   *   the build every project on the machine runs under. One checked project cannot establish
   *   safety for a global effect, so a rollback across a schema bump stranded the others.
   *
   * I fixed n=0 and left n=1, which is the same error at a different arity. The list was never
   * the problem: treating a list AS PROOF OF COMPLETENESS was. Completeness is now something a
   * caller states, with the basis on which it claims it, and no array length implies it.
   */
  function machine(): string {
    return withVersions(
      [
        ['1.0.0', 3],
        ['1.1.0', 4],
      ],
      '1.1.0',
    );
  }

  /** A project directory with a store schema marker of the given version. */
  function projectAt(schema: number): string {
    const root = tempRoot();
    roots.push(root);
    mkdirSync(join(root, '.serva'), { recursive: true });
    writeFileSync(join(root, '.serva', 'SCHEMA_VERSION'), String(schema) + '\n', 'utf8');
    return root;
  }

  it('1. inside a project, with the machine inventory unknown, refuses', () => {
    /* The regression that matters: ONE project is a partial inventory, not a complete one. */
    const plan = planSwitch(installation(machine()), '1.0.0', UNKNOWN_PROJECTS);
    expect(plan.outcome).toBe(ChangeOutcome.REFUSED);
    expect(plan.reason).toMatch(/machine-global|every|complete/i);
  });

  it('2. outside a project, with the inventory unknown, refuses', () => {
    expect(planSwitch(installation(machine()), '1.0.0', UNKNOWN_PROJECTS).outcome).toBe(
      ChangeOutcome.REFUSED,
    );
  });

  it('3. a compatible current project does not license the ones nobody checked', () => {
    /*
     * The exact shape of IUR-REVIEW-1: the project in front of you is fine, and that says
     * nothing about the others the pointer also moves.
     */
    const plan = planSwitch(installation(machine()), '1.0.0', UNKNOWN_PROJECTS);
    void projectAt(3);
    expect(plan.outcome).toBe(ChangeOutcome.REFUSED);
  });

  it('4. a COMPLETE inventory of compatible projects is allowed', () => {
    const inventory = knownCompleteProjects(
      [projectAt(3), projectAt(3)],
      'the test enumerated them',
    );
    expect(planSwitch(installation(machine()), '1.0.0', inventory).outcome).toBe(
      ChangeOutcome.READY,
    );
  });

  it('5. a COMPLETE inventory with one incompatible project refuses', () => {
    const inventory = knownCompleteProjects(
      [projectAt(3), projectAt(99)],
      'the test enumerated them',
    );
    const plan = planSwitch(installation(machine()), '1.0.0', inventory);
    expect(plan.outcome).toBe(ChangeOutcome.REFUSED);
    expect(plan.reason).toMatch(/newer|schema/i);
  });

  it('6. an EMPTY set is fine only when its completeness is stated', () => {
    /* "I looked and there are none" is a real answer; "[]" on its own is not. */
    expect(
      planSwitch(installation(machine()), '1.0.0', knownCompleteProjects([], 'no projects exist'))
        .outcome,
    ).toBe(ChangeOutcome.READY);
  });

  it('7. a ONE-element set proves nothing without that statement', () => {
    /*
     * The structural heart of it. A bare array cannot be passed at all now, so the n=1 case
     * cannot be spelled the way it was — and if it is stated complete, it is the caller
     * asserting a fact about the machine rather than the code inferring one.
     */
    const complete = knownCompleteProjects([projectAt(3)], 'the only project on this machine');
    expect(planSwitch(installation(machine()), '1.0.0', complete).outcome).toBe(
      ChangeOutcome.READY,
    );
    expect(planSwitch(installation(machine()), '1.0.0', UNKNOWN_PROJECTS).outcome).toBe(
      ChangeOutcome.REFUSED,
    );
  });

  it('8. a refusal writes nothing to the machine-global pointer', () => {
    const root = machine();
    const before = readFileSync(join(root, 'current'), 'utf8');
    const plan = performSwitch(installation(root), '1.0.0', UNKNOWN_PROJECTS);
    expect(plan.outcome).toBe(ChangeOutcome.REFUSED);
    expect(readFileSync(join(root, 'current'), 'utf8'), 'the pointer moved').toBe(before);
  });

  it('9. an incompatible project is detected BEFORE the pointer moves', () => {
    const root = machine();
    const before = readFileSync(join(root, 'current'), 'utf8');
    const inventory = knownCompleteProjects([projectAt(99)], 'the only project on this machine');
    expect(performSwitch(installation(root), '1.0.0', inventory).outcome).toBe(
      ChangeOutcome.REFUSED,
    );
    expect(readFileSync(join(root, 'current'), 'utf8')).toBe(before);
  });

  it('the CLI has no way to claim completeness it cannot establish', () => {
    /*
     * Serva holds no governed inventory of the projects on a machine, so the command that
     * moves the pointer passes UNKNOWN_PROJECTS unconditionally. Building a registry to make
     * this green would be inventing an authority to satisfy a check.
     */
    const source = readFileSync('src/cli/commands/portability.ts', 'utf8');
    expect(source).toContain('UNKNOWN_PROJECTS');
    expect(source, 'the CLI must not assemble an inventory from the open project').not.toMatch(
      /knownCompleteProjects/,
    );
  });
});

describe('an installation nothing ever recorded is an empty one', () => {
  /*
   * SPEC: the 1.0.1 packaging audit, section G.
   *
   * Every test in this file built its fixtures by writing version markers by hand, so the
   * whole update-and-rollback story was proven against a table that only a test ever filled
   * in. `recordInstalled` had no caller in the product: an owner who installed Serva and ran
   * `serva install status` saw nothing installed, and `install use` could only refuse, because
   * there was never anything to switch between.
   *
   * These tests fail against 1.0.0 by construction — they run the CLI rather than the fixture.
   */
  function scratch(): string {
    return mkdtempSync(join(tmpdir(), 'serva-adopt-'));
  }

  it('reports nothing installed until something records itself', () => {
    const root = scratch();
    try {
      expect(installation(root).installed).toEqual([]);
      expect(installation(root).current).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('`install adopt` records the RUNNING build, and claims an unheld pointer', () => {
    const root = scratch();
    try {
      const code = cmdInstall(parseArgs(['install', 'adopt', '--install-root', root]));
      expect(code).toBe(0);

      const after = installation(root);
      expect(after.installed.map((v) => v.version)).toEqual([SERVA_VERSION]);
      expect(after.current?.version, 'nothing held the pointer, so it should now').toBe(
        SERVA_VERSION,
      );
      /* The recorded schema is the one this build understands — rollback safety reads it. */
      expect(after.current?.storeSchema).toBe(SCHEMA_VERSION);
      expect(after.problems).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not move a pointer an owner has deliberately placed elsewhere', () => {
    /*
     * The dangerous case. An owner pinned to an older build who runs the newer one once must
     * not silently be switched to it — moving the pointer is `install use`, which refuses
     * first if the move would strand a project.
     */
    const root = scratch();
    try {
      mkdirSync(join(root, 'versions', '9.9.9'), { recursive: true });
      writeFileSync(
        join(root, 'versions', '9.9.9', 'serva-version.json'),
        JSON.stringify({ version: '9.9.9', storeSchema: SCHEMA_VERSION, installedAt: 'T' }),
        'utf8',
      );
      writeFileSync(join(root, 'current'), '9.9.9\n', 'utf8');

      expect(cmdInstall(parseArgs(['install', 'adopt', '--install-root', root]))).toBe(0);

      const after = installation(root);
      expect(after.current?.version, 'the pinned version must survive').toBe('9.9.9');
      expect(
        after.installed.map((v) => v.version).includes(SERVA_VERSION),
        'and the running build is still recorded as present',
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent, so an owner can run it as often as they like', () => {
    const root = scratch();
    try {
      cmdInstall(parseArgs(['install', 'adopt', '--install-root', root]));
      cmdInstall(parseArgs(['install', 'adopt', '--install-root', root]));
      expect(installation(root).installed.map((v) => v.version)).toEqual([SERVA_VERSION]);
      expect(installation(root).problems).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the pointer moves the program, or it is not a rollback', () => {
  /*
   * SPEC: the 1.0.1 packaging audit, §17.2.
   *
   * 1.0.0 shipped `install use` writing `current`, and `current` being read by exactly one
   * thing: `install status`, to print it. So a rollback reported success and left the owner
   * running the build they had just rolled away from — worse than no rollback, because it is
   * a rollback that lies, discovered on the day it is needed.
   *
   * These fail against 1.0.0 by construction.
   */
  it('refuses to switch to a version that is recorded but has nothing to run', () => {
    const root = installRoot();
    recordInstalled(root, '1.0.0', SCHEMA_VERSION, 'T');
    recordInstalled(root, '1.1.0', SCHEMA_VERSION, 'T');
    mkdirSync(join(root, 'versions', '1.1.0', 'package', 'dist', 'cli'), { recursive: true });
    writeFileSync(join(root, 'versions', '1.1.0', 'package', 'dist', 'cli', 'main.js'), '', 'utf8');

    /* 1.0.0 is a marker and nothing else — exactly the state the old fixture created. */
    expect(isRunnable(root, '1.0.0')).toBe(false);

    const plan = planSwitch(
      installation(root),
      '1.0.0',
      knownCompleteProjects([], 'no projects on this fixture machine'),
    );
    expect(plan.outcome).toBe(ChangeOutcome.REFUSED);
    expect(plan.reason).toContain('would move the pointer and change nothing');
  });

  it('does not move the pointer when it refuses', () => {
    /* A refusal that had already written `current` would be the same bug wearing a warning. */
    const root = installRoot();
    recordInstalled(root, '1.0.0', SCHEMA_VERSION, 'T');
    recordInstalled(root, '1.1.0', SCHEMA_VERSION, 'T');
    mkdirSync(join(root, 'versions', '1.1.0', 'package', 'dist', 'cli'), { recursive: true });
    writeFileSync(join(root, 'versions', '1.1.0', 'package', 'dist', 'cli', 'main.js'), '', 'utf8');
    writeFileSync(join(root, 'current'), '1.1.0\n', 'utf8');

    performSwitch(
      installation(root),
      '1.0.0',
      knownCompleteProjects([], 'no projects on this fixture machine'),
    );
    expect(installation(root).current?.version, 'the pointer must not have moved').toBe('1.1.0');
  });

  it('`adopt` captures a build that can actually be run', () => {
    const root = mkdtempSync(join(tmpdir(), 'serva-capture-'));
    try {
      expect(cmdInstall(parseArgs(['install', 'adopt', '--install-root', root]))).toBe(0);
      /* The marker alone was 1.0.0's whole story. This is the part that was missing. */
      expect(isRunnable(root, SERVA_VERSION), 'adopt must capture a runnable build').toBe(true);
      expect(existsSync(join(root, 'versions', SERVA_VERSION, 'package', 'package.json'))).toBe(
        true,
      );
      /* Its dependencies came too: a captured build resolves them from beside itself, and a
         global npm install puts them beside the package rather than inside it. */
      expect(
        existsSync(join(root, 'versions', SERVA_VERSION, 'package', 'node_modules', 'zod')),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('captures the program, not whatever else is in the directory', () => {
    /*
     * `packageRoot` is the repository in a developer checkout. The first version of `capture`
     * copied all of it — `src/`, `out/`, `evidence/`, `.git` — which is both enormously slow
     * and not a version of Serva but a snapshot of somebody's working tree.
     */
    const root = mkdtempSync(join(tmpdir(), 'serva-capture-scope-'));
    try {
      cmdInstall(parseArgs(['install', 'adopt', '--install-root', root]));
      const payload = join(root, 'versions', SERVA_VERSION, 'package');
      for (const unwanted of ['src', 'tests', 'evidence', 'out', '.git', 'scripts']) {
        expect(existsSync(join(payload, unwanted)), unwanted + ' is not part of the program').toBe(
          false,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the entry point asks which version should run', () => {
  /*
   * SPEC: the 1.0.1 packaging audit, §17.2.
   *
   * `resolveActive` is the read that 1.0.0 never performed. Every uncertain case answers "run
   * yourself" — a pointer that cannot be honoured must not stop `serva` from starting, because
   * `serva install` is how an owner would fix the pointer.
   */
  function root(): string {
    const r = mkdtempSync(join(tmpdir(), 'serva-active-'));
    roots.push(r);
    return r;
  }

  it('runs in place when nothing is current', () => {
    const decision = resolveActive({
      root: root(),
      runningVersion: SERVA_VERSION,
      alreadyHandedOff: false,
    });
    expect(decision.handOffTo).toBeUndefined();
    expect(decision.problem).toBeUndefined();
  });

  it('runs in place when current names the version already running', () => {
    const r = root();
    writeFileSync(join(r, 'current'), SERVA_VERSION + '\n', 'utf8');
    expect(
      resolveActive({ root: r, runningVersion: SERVA_VERSION, alreadyHandedOff: false }).handOffTo,
    ).toBeUndefined();
  });

  it('hands off when current names another version that is really there', () => {
    const r = root();
    const entry = versionEntrypoint(r, '0.9.0');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, '', 'utf8');
    writeFileSync(join(r, 'current'), '0.9.0\n', 'utf8');

    const decision = resolveActive({
      root: r,
      runningVersion: SERVA_VERSION,
      alreadyHandedOff: false,
    });
    expect(decision.handOffTo).toBe(entry);
  });

  it('runs in place and says so when current names something unrunnable', () => {
    /* Fail open. Refusing to start would mean a bad pointer bricks the tool that fixes it. */
    const r = root();
    writeFileSync(join(r, 'current'), '0.9.0\n', 'utf8');
    const decision = resolveActive({
      root: r,
      runningVersion: SERVA_VERSION,
      alreadyHandedOff: false,
    });
    expect(decision.handOffTo).toBeUndefined();
    expect(decision.problem).toContain('no runnable build');
  });

  it('never hands off twice', () => {
    /* Two builds whose pointers name each other would otherwise fork until the machine died. */
    const r = root();
    const entry = versionEntrypoint(r, '0.9.0');
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, '', 'utf8');
    writeFileSync(join(r, 'current'), '0.9.0\n', 'utf8');

    expect(
      resolveActive({ root: r, runningVersion: SERVA_VERSION, alreadyHandedOff: true }).handOffTo,
      'a delegate must never delegate',
    ).toBeUndefined();
  });
});

describe('an unknown inventory only blocks what it could actually protect', () => {
  /*
   * SPEC: the 1.0.1 packaging audit, section H.
   *
   * The inventory is consulted for one purpose: a project whose store schema is newer than the
   * target build understands. The refusal did not check that, so it fired on every switch —
   * and because the CLI always passes UNKNOWN_PROJECTS by design, `serva install use` could
   * never succeed at all. A safety check that refuses every case protects nobody.
   */
  it('allows a same-schema switch without knowing the projects', () => {
    const root = withVersions(
      [
        ['1.0.1', SCHEMA_VERSION],
        ['1.0.2', SCHEMA_VERSION],
      ],
      '1.0.1',
    );
    const plan = planSwitch(installation(root), '1.0.2', UNKNOWN_PROJECTS);
    expect(plan.outcome, plan.reason).toBe(ChangeOutcome.READY);
  });

  it('allows going back to a build that understands the same schema', () => {
    /* The rollback an owner actually performs: two builds, one store format. */
    const root = withVersions(
      [
        ['1.0.1', SCHEMA_VERSION],
        ['1.0.2', SCHEMA_VERSION],
      ],
      '1.0.2',
    );
    const plan = planSwitch(installation(root), '1.0.1', UNKNOWN_PROJECTS);
    expect(plan.outcome, plan.reason).toBe(ChangeOutcome.READY);
  });

  it('still refuses to go back to a build that understands LESS, inventory unknown', () => {
    /*
     * The case the refusal exists for, and it must survive this change untouched. A project
     * written at schema 9 cannot be opened by a build that knows 3, and Serva cannot prove
     * no such project exists.
     */
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['2.0.0', 9],
      ],
      '2.0.0',
    );
    const plan = planSwitch(installation(root), '1.0.0', UNKNOWN_PROJECTS);
    expect(plan.outcome).toBe(ChangeOutcome.REFUSED);
    expect(plan.reason).toContain('cannot prove');
  });

  it('the ceiling counts every installed build, not just the current one', () => {
    /*
     * A build that is installed but not current still wrote projects. Comparing only against
     * `current` would call a downgrade safe whenever the owner had already stepped back once.
     */
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['1.5.0', 7],
        ['2.0.0', 9],
      ],
      '1.5.0',
    );
    const plan = planSwitch(installation(root), '1.0.0', UNKNOWN_PROJECTS);
    expect(plan.outcome, 'schema 9 is installed, so 3 is still a downgrade').toBe(
      ChangeOutcome.REFUSED,
    );
  });
});
