import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ChangeOutcome,
  compareVersions,
  installation,
  performSwitch,
  UNKNOWN_PROJECTS,
  planSwitch,
  recordInstalled,
  removeVersion,
  renderInstallation,
} from '../src/portability/install.js';
import { SCHEMA_VERSION, SERVA_VERSION } from '../src/portability/version.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { cleanup, tempRoot } from './helpers.js';

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
    /* No projects on this fixture machine — stated, not defaulted. */
    const plan = performSwitch(installation(root), '1.0.0', []);
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
    performSwitch(installation(root), '1.0.0', []);
    const forward = performSwitch(installation(root), '1.1.0', []);
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
    const plan = planSwitch(installation(root), '1.0.0', [project]);

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
    performSwitch(installation(root), '1.0.0', [projectWithSchema(9)]);
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
    const plan = planSwitch(installation(root), '1.0.0', [projectWithSchema(3)]);
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
    const plan = planSwitch(installation(root), '1.0.0', []);
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

/* ====== HIGH 2: an empty loop is not a safety proof ====== */

describe('rollback refuses when it cannot establish that nothing is lost', () => {
  /*
   * SPEC: HIGH finding INSTALL-UPDATE-ROLLBACK/IUR-1.
   *
   * `planSwitch` checked each project's store schema, and the CLI built
   * `projectRoots = rt === undefined ? [] : [rt.root]`. Run `serva install use <older>` outside
   * a project — the natural way to manage a machine-global install — and the list was empty,
   * the loop ran zero times, `tooNew` stayed empty, and it returned READY.
   *
   * The header says "ROLLBACK IS REFUSED WHEN IT WOULD LOSE DATA". An empty collection was
   * read as "nothing would be lost" when it meant "nobody looked", and those are the two
   * things a safety check must never confuse.
   *
   * No governed project inventory exists on this machine, so the honest answer is to fail
   * closed and say why. `[]` can no longer be spelled where "unknown" is meant.
   */
  /** A project directory with a store schema marker of the given version. */
  function projectAt(schema: number): string {
    const root = tempRoot();
    roots.push(root);
    mkdirSync(join(root, '.serva'), { recursive: true });
    writeFileSync(join(root, '.serva', 'SCHEMA_VERSION'), String(schema) + '\n', 'utf8');
    return root;
  }

  it('refuses when the affected projects are unknown', () => {
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['1.1.0', 4],
      ],
      '1.1.0',
    );
    const plan = planSwitch(installation(root), '1.0.0', UNKNOWN_PROJECTS);
    expect(plan.outcome).toBe(ChangeOutcome.REFUSED);
    expect(plan.reason).toMatch(/could not|cannot|unknown/i);
  });

  it('allows a rollback when the machine genuinely holds no projects', () => {
    /* Explicitly nothing to lose is a different claim from nobody having looked. */
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['1.1.0', 4],
      ],
      '1.1.0',
    );
    expect(planSwitch(installation(root), '1.0.0', []).outcome).toBe(ChangeOutcome.READY);
  });

  it('allows a rollback when every known project is compatible', () => {
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['1.1.0', 4],
      ],
      '1.1.0',
    );
    expect(planSwitch(installation(root), '1.0.0', [projectAt(3)]).outcome).toBe(
      ChangeOutcome.READY,
    );
  });

  it('refuses when one known project is too new', () => {
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['1.1.0', 4],
      ],
      '1.1.0',
    );
    const plan = planSwitch(installation(root), '1.0.0', [projectAt(99)]);
    expect(plan.outcome).toBe(ChangeOutcome.REFUSED);
    expect(plan.reason).toMatch(/newer|schema/i);
  });

  it('refuses when one of several projects is too new', () => {
    const root = withVersions(
      [
        ['1.0.0', 3],
        ['1.1.0', 4],
      ],
      '1.1.0',
    );
    expect(planSwitch(installation(root), '1.0.0', [projectAt(3), projectAt(99)]).outcome).toBe(
      ChangeOutcome.REFUSED,
    );
  });

  it('the unknown case cannot be spelled as an empty list', () => {
    /*
     * The structural half. `UNKNOWN_PROJECTS` is a distinct value rather than an empty array,
     * so a caller that has not looked cannot accidentally spell it the same way as a caller
     * that looked and found nothing.
     */
    expect(Array.isArray(UNKNOWN_PROJECTS)).toBe(false);
  });
});
