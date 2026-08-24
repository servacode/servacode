import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { EnforcementClass } from '../src/vocab/index.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { invokeAction } from '../src/app/actions.js';
import {
  Actor,
  MigrationPhase,
  migrationState,
  renderMigration,
} from '../src/portability/migrationWorkflow.js';
import { ExecutionAvailability, QualificationAttempt } from '../src/substrate/types.js';
import { cleanup, tempRoot } from './helpers.js';
import type { DoctorProbes } from '../src/portability/doctor.js';
import type { SubstrateQualification } from '../src/substrate/types.js';

/**
 * A MIGRATION THAT KNOWS WHERE IT HAS GOT TO.
 *
 * SPEC: Phase 6 closure §10.
 *
 * `serva migrate` printed seven numbered lines and exited zero. It said the same thing on the
 * machine being left as on the machine being moved to, which are the two states the whole
 * exercise is about.
 *
 * The property worth testing is that the phase is DERIVED. A workflow with a stored cursor
 * would pass a happy-path test and then, the first time somebody skipped a step, cheerfully
 * report progress that had not happened.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

function folder(): string {
  const root = tempRoot();
  roots.push(root);
  return root;
}

/** A machine with everything Serva needs. Individual tests spoil one thing. */
function probes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    platform: () => ({ platform: 'win32', release: '10', arch: 'x64' }),
    node: () => ({ version: 'v22.0.0' }),
    wsl: () => ({ installed: true, version: '2', detail: 'present' }),
    distro: () => ({ name: 'Ubuntu', kernel: '6.6', user: 'owner', measured: true, detail: 'ok' }),
    claude: () => ({
      installed: true,
      credentialsFilePresent: true,
      measured: true,
      detail: 'present',
    }),
    sandbox: () => ({
      mechanism: 'bubblewrap',
      available: true,
      producerLauncher: 'runtime',
      measured: true,
      detail: 'present',
    }),
    git: () => ({ installed: true, version: '2.43', detail: 'present' }),
    interop: () => ({ enabled: false, detail: 'disabled' }),
    ...over,
  };
}

const MEASURED_HARD = {
  attempt: QualificationAttempt.MEASURED,
  availability: ExecutionAvailability.AVAILABLE,
  enforcementClass: EnforcementClass.HARD,
} as unknown as SubstrateQualification;

async function backupOf(rt: ServaRuntime): Promise<string> {
  const destination = join(folder(), 'bundle');
  const result = await invokeAction(
    { rt },
    { id: 'backup.create', input: { destination }, confirmed: true },
  );
  expect(result.ok, String(result.refusal)).toBe(true);
  return destination;
}

/* ==================================================== the phase follows the world */

describe('the phase is derived from what is true, not from a cursor', () => {
  it('on the source machine with nothing captured, the next step is to capture', () => {
    const rt = ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root: folder() });
    try {
      const state = migrationState({ root: rt.root, probes: probes() });
      expect(state.phase).toBe(MigrationPhase.CAPTURE);
      expect(state.next?.actor).toBe(Actor.SERVA);
      /*
       * Not "nothing is done": this machine is already prepared, and that is a fact about the
       * computer rather than about the migration. What must be undone is everything the
       * migration itself has to produce.
       */
      for (const phase of [
        MigrationPhase.CAPTURE,
        MigrationPhase.VERIFY,
        MigrationPhase.CARRY,
        MigrationPhase.QUALIFY,
      ]) {
        expect(state.steps.find((x) => x.phase === phase)?.done, phase).toBe(false);
      }
    } finally {
      rt.close();
    }
  });

  it('a bundle that exists and verifies moves the workflow on by itself', async () => {
    const rt = ServaRuntime.init('RahalGo', 'idea', { root: folder() });
    try {
      const bundlePath = await backupOf(rt);
      const state = migrationState({
        root: rt.root,
        bundlePath,
        probes: probes(),
        engineAuthenticated: true,
      });
      /*
       * Capture and verify are both done, and nobody told the workflow so. The project is
       * still here, so the owner has not carried anything yet.
       */
      expect(state.steps.find((s) => s.phase === MigrationPhase.CAPTURE)?.done).toBe(true);
      expect(state.steps.find((s) => s.phase === MigrationPhase.VERIFY)?.done).toBe(true);
      /*
       * The project is still here and this machine is ready, so the only thing the migration
       * itself has left is the target measuring itself.
       */
      expect(state.phase).toBe(MigrationPhase.QUALIFY);
    } finally {
      rt.close();
    }
  });

  it('on a machine with no project, a verified bundle means restore is next', async () => {
    const source = ServaRuntime.init('RahalGo', 'idea', { root: folder() });
    let bundlePath: string;
    try {
      bundlePath = await backupOf(source);
    } finally {
      source.close();
    }
    /* A folder with nothing in it: the new computer. */
    const state = migrationState({ root: folder(), bundlePath, probes: probes() });
    expect(state.phase).toBe(MigrationPhase.RESTORE);
    expect(state.steps.find((s) => s.phase === MigrationPhase.CARRY)?.done).toBe(true);
    expect(state.steps.find((s) => s.phase === MigrationPhase.RESTORE)?.done).toBe(false);
  });

  it('a restored project with a half-built machine asks for the machine next', async () => {
    const source = ServaRuntime.init('RahalGo', 'idea', { root: folder() });
    let bundlePath: string;
    try {
      bundlePath = await backupOf(source);
    } finally {
      source.close();
    }
    const destinationRoot = folder();
    const restore = await invokeAction(
      {},
      { id: 'restore.perform', input: { bundlePath, destinationRoot }, confirmed: true },
    );
    const landed = String(
      (restore.data as { restored: { destination: string }[] }).restored[0]?.destination,
    );

    const state = migrationState({
      root: landed,
      bundlePath,
      probes: probes({ git: () => ({ installed: false, detail: 'no git in the guest' }) }),
    });
    expect(state.steps.find((s) => s.phase === MigrationPhase.RESTORE)?.done).toBe(true);
    expect(state.phase).toBe(MigrationPhase.PREPARE_MACHINE);
    expect(state.next?.actor).toBe(Actor.OWNER);
  });

  it('a ready machine that has not measured itself asks for qualification', async () => {
    const rt = ServaRuntime.init('RahalGo', 'idea', { root: folder() });
    try {
      const bundlePath = await backupOf(rt);
      const state = migrationState({
        root: rt.root,
        bundlePath,
        probes: probes(),
        engineAuthenticated: true,
      });
      /* The project is here and the machine is ready, so only the measurement is left. */
      expect(state.steps.find((s) => s.phase === MigrationPhase.PREPARE_MACHINE)?.done).toBe(true);
      expect(state.phase).toBe(MigrationPhase.QUALIFY);
    } finally {
      rt.close();
    }
  });

  it('a machine nobody asked about sign-in is not a prepared machine', async () => {
    /*
     * `engineAuthenticated` absent means nobody asked the engine, which is not the same as a
     * signed-in machine and must never be flattened into one. The migration therefore stops
     * at the step where a person has something to do.
     */
    const rt = ServaRuntime.init('RahalGo', 'idea', { root: folder() });
    try {
      const bundlePath = await backupOf(rt);
      const state = migrationState({ root: rt.root, bundlePath, probes: probes() });
      expect(state.phase).toBe(MigrationPhase.PREPARE_MACHINE);
      expect(state.steps.find((s) => s.phase === MigrationPhase.PREPARE_MACHINE)?.done).toBe(false);
    } finally {
      rt.close();
    }
  });

  it('is complete only when this computer has measured itself', async () => {
    const rt = ServaRuntime.init('RahalGo', 'idea', { root: folder() });
    try {
      const bundlePath = await backupOf(rt);
      const state = migrationState({
        root: rt.root,
        bundlePath,
        probes: probes(),
        engineAuthenticated: true,
        qualification: MEASURED_HARD,
      });
      expect(state.phase).toBe(MigrationPhase.COMPLETE);
      expect(state.next).toBeUndefined();
    } finally {
      rt.close();
    }
  });
});

/* ================================================ what it refuses to believe */

describe('nothing can be asserted into being done', () => {
  it('a bundle that does not exist blocks, and says so', () => {
    const state = migrationState({
      root: folder(),
      bundlePath: join(folder(), 'nowhere'),
      probes: probes(),
    });
    expect(state.phase).toBe(MigrationPhase.BLOCKED);
    expect(state.problems.join(' ')).toContain('nothing at');
  });

  it('a bundle that does not verify blocks rather than counting as captured', () => {
    const bogus = folder();
    const state = migrationState({ root: folder(), bundlePath: bogus, probes: probes() });
    expect(state.phase).toBe(MigrationPhase.BLOCKED);
    expect(state.problems.join(' ')).toContain('did not verify');
    expect(state.steps.find((s) => s.phase === MigrationPhase.VERIFY)?.done).toBe(false);
  });

  it('a qualification that never reached the guest does not complete the migration', async () => {
    /*
     * The transport invariant, reaching this far. An attempt that measured nothing must not
     * be able to finish a migration — otherwise a busy WSL would silently declare a new
     * computer ready to do engineering.
     */
    const rt = ServaRuntime.init('RahalGo', 'idea', { root: folder() });
    try {
      const bundlePath = await backupOf(rt);
      const unmeasured = {
        attempt: QualificationAttempt.NOT_MEASURED,
        availability: ExecutionAvailability.UNREACHABLE,
        enforcementClass: EnforcementClass.NONE,
      } as unknown as SubstrateQualification;

      const state = migrationState({
        root: rt.root,
        bundlePath,
        probes: probes(),
        engineAuthenticated: true,
        qualification: unmeasured,
      });
      expect(state.phase).toBe(MigrationPhase.QUALIFY);
      expect(state.steps.find((s) => s.phase === MigrationPhase.QUALIFY)?.done).toBe(false);
    } finally {
      rt.close();
    }
  });

  it('every step says how Serva will know it happened', () => {
    /* No step may be satisfied by an owner saying they did it. */
    const state = migrationState({ root: folder(), probes: probes() });
    for (const step of state.steps) {
      expect(step.provenBy.length, step.title + ' has no evidence rule').toBeGreaterThan(0);
      /*
       * The forbidden thing is an owner ASSERTING completion. Naming what Serva cannot see —
       * which computer you are standing at — is the opposite of that, so the rule targets the
       * phrasing of a self-report rather than the word "tell".
       */
      expect(step.provenBy).not.toMatch(
        /tell me|let me know|confirm that you|when you say|mark (it|this) done/i,
      );
    }
  });
});

/* ======================================================= what does not travel */

describe('the migration is honest about what stays behind', () => {
  it('says machine qualification does not move', () => {
    const rendered = renderMigration(migrationState({ root: folder(), probes: probes() }));
    expect(rendered).toContain('Machine qualification does not');
    expect(rendered).toContain('different computer');
  });

  it('names what the bundle deliberately left behind', async () => {
    const rt = ServaRuntime.init('RahalGo', 'idea', { root: folder() });
    try {
      const bundlePath = await backupOf(rt);
      const state = migrationState({ root: rt.root, bundlePath, probes: probes() });
      expect(state.manifest).toBeDefined();
      /* The workflow reads it from the manifest rather than restating a rule from memory. */
      const rendered = renderMigration(state);
      expect(rendered).toContain('The bundle holds');
    } finally {
      rt.close();
    }
  });

  it('the CLI reports the same state, and exits non-zero while work is outstanding', () => {
    const root = folder();
    execFileSync(
      process.execPath,
      [join('dist', 'cli', 'main.js'), 'init', 'M', '--idea', 'x', '--root', root],
      {
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    let code = 0;
    let output = '';
    try {
      output = execFileSync(
        process.execPath,
        [join('dist', 'cli', 'main.js'), 'migrate', '--root', root],
        { encoding: 'utf8', timeout: 300_000 },
      );
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      code = err.status ?? 0;
      output = String(err.stdout ?? '');
    }
    expect(output).toContain('Capture everything on the machine you are leaving');
    expect(code, 'migrate exited zero with work outstanding').not.toBe(0);
  });
});
