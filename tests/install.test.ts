import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
} from '../src/portability/install.js';
import { SCHEMA_VERSION, SERVA_VERSION } from '../src/portability/version.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { cleanup, tempRoot } from './helpers.js';
import { cmdInstall } from '../src/cli/commands/portability.js';
import { parseArgs } from '../src/cli/main.js';

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

/** An install root with the given versions present, and one of them current. */
function withVersions(versions: readonly (readonly [string, number])[], current?: string): string {
  const root = installRoot();
  for (const [version, schema] of versions) {
    recordInstalled(root, version, schema, '2026-08-24T00:00:00.000Z');
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
