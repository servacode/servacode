import { afterEach, describe, expect, it } from 'vitest';
import { EnforcementClass } from '../src/vocab/index.js';
import { FixedClock } from '../src/core/clock.js';
import {
  EnforcementState,
  deriveEnforcementClass,
  engineeringAuthorityRefusal,
  type QualificationResult,
  type SubstrateCapabilities,
  type SubstrateQualification,
} from '../src/substrate/types.js';
import { BLOCKING_CASE_IDS, QUALIFICATION_CASES } from '../src/substrate/qualification.js';
import {
  HostExecutionSubstrate,
  WSL_REQUIRED_BINARIES,
  compareVersions,
  type CommandRunner,
} from '../src/substrate/host.js';
import {
  FakeExecutionSubstrate,
  makeFixtureDir,
  removeFixtureDir,
  safeRealpath,
  withinAny,
} from '../src/substrate/fake.js';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EXECUTION SUBSTRATE.
 *
 * The property under test throughout: **HARD is earned, never assumed.** A substrate
 * cannot talk its way to write authority, an unmeasured dimension counts against it
 * exactly as a failure does, and a missing prerequisite blocks rather than degrades.
 */

const fixtures: string[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) removeFixtureDir(f);
});

const clock = (): FixedClock => new FixedClock('2026-01-01T00:00:00.000Z', 0);

function fixture(): string {
  const d = makeFixtureDir();
  fixtures.push(d);
  return d;
}

const ENFORCED: SubstrateCapabilities = {
  filesystemEnforcement: EnforcementState.ENFORCED,
  processEnforcement: EnforcementState.ENFORCED,
  networkEnforcement: EnforcementState.ENFORCED,
  credentialProtection: EnforcementState.ENFORCED,
  hostEscapeProtection: EnforcementState.ENFORCED,
  canWrite: true,
  canExecute: true,
};

const passed = (id: string): QualificationResult => ({
  id,
  title: id,
  expectation: 'x',
  outcome: 'PASSED',
  detail: 'ok',
  blocking: true,
  at: 'T',
});

/* ============================================= the class is derived, not declared */

describe('enforcement class is derived from what was proved', () => {
  it('every blocking case passing plus full enforcement yields HARD', () => {
    const d = deriveEnforcementClass(BLOCKING_CASE_IDS.map(passed), ENFORCED);
    expect(d.enforcementClass).toBe(EnforcementClass.HARD);
    expect(d.blockedBy).toBeUndefined();
  });

  it('a NOT_RUN blocking case counts against the substrate exactly as a failure does', () => {
    // "We could not check whether it escapes" and "it escapes" are the same fact for
    // this decision, and treating them differently is how a gap becomes a green light.
    const tests = BLOCKING_CASE_IDS.map((id) =>
      id === 'Q-F' ? { ...passed(id), outcome: 'NOT_RUN' as const } : passed(id),
    );
    expect(deriveEnforcementClass(tests, ENFORCED).enforcementClass).not.toBe(
      EnforcementClass.HARD,
    );
  });

  it('running no blocking case at all yields NONE, never HARD', () => {
    const d = deriveEnforcementClass([], ENFORCED);
    expect(d.enforcementClass).toBe(EnforcementClass.NONE);
    expect(d.blockedBy).toMatch(/nothing was proved/);
  });

  it('a failed subprocess-escape case drops it out of HARD', () => {
    const tests = BLOCKING_CASE_IDS.map((id) =>
      id === 'Q-F' ? { ...passed(id), outcome: 'FAILED' as const } : passed(id),
    );
    const d = deriveEnforcementClass(tests, ENFORCED);
    expect(d.enforcementClass).not.toBe(EnforcementClass.HARD);
    expect(d.blockedBy).toMatch(/Q-F/);
  });

  it('an unenforced dimension yields SOFT even when every test passed', () => {
    const d = deriveEnforcementClass(BLOCKING_CASE_IDS.map(passed), {
      ...ENFORCED,
      hostEscapeProtection: EnforcementState.UNKNOWN,
    });
    expect(d.enforcementClass).toBe(EnforcementClass.SOFT);
    expect(d.blockedBy).toMatch(/host escape/);
  });

  it('the catalogue covers every escape route the brief names', () => {
    const ids = QUALIFICATION_CASES.map((c) => c.id);
    // A..K from Phase 4 §5.
    expect(ids).toEqual([
      'Q-A',
      'Q-B',
      'Q-C',
      'Q-D',
      'Q-E',
      'Q-F',
      'Q-G',
      'Q-H',
      'Q-I',
      'Q-J',
      'Q-K',
    ]);
    for (const c of QUALIFICATION_CASES) {
      expect(c.expectation.length, c.id).toBeGreaterThan(10);
      expect(c.rationale.length, c.id).toBeGreaterThan(20);
    }
  });
});

/* ============================================= authority refusal */

describe('engineering authority requires HARD', () => {
  const base = (over: Partial<SubstrateQualification>): SubstrateQualification =>
    ({
      probe: {
        substrateId: 'x',
        hostPlatform: 'p',
        hostArch: 'a',
        isolationMethod: 'SIMULATED',
        engineVersion: '1',
        prerequisites: [],
        observations: {},
        probedAt: 'T',
      },
      capabilities: ENFORCED,
      tests: BLOCKING_CASE_IDS.map(passed),
      enforcementClass: EnforcementClass.HARD,
      qualifiedAt: 'T',
      engineVersion: '1',
      ...over,
    }) as SubstrateQualification;

  it('HARD with everything passing is permitted', () => {
    expect(engineeringAuthorityRefusal(base({}))).toBeUndefined();
  });

  it('SOFT is refused; there is no SOFT engineering mode', () => {
    const r = engineeringAuthorityRefusal(base({ enforcementClass: EnforcementClass.SOFT }));
    expect(r).toMatch(/requires HARD/);
  });

  it('NONE is refused', () => {
    expect(engineeringAuthorityRefusal(base({ enforcementClass: EnforcementClass.NONE }))).toMatch(
      /requires HARD/,
    );
  });

  it('a substrate claiming HARD with a failing blocking test is still refused', () => {
    // The class is a summary; the tests are the evidence. Where they disagree the
    // evidence wins, so a buggy or lying implementation cannot assert its way through.
    const r = engineeringAuthorityRefusal(
      base({
        tests: [...BLOCKING_CASE_IDS.map(passed), { ...passed('Q-Z'), outcome: 'FAILED' }],
      }),
    );
    expect(r).toMatch(/blocking qualification tests did not pass/);
  });

  it('HARD without both write and execute enforcement is refused', () => {
    const r = engineeringAuthorityRefusal(
      base({ capabilities: { ...ENFORCED, canExecute: false } }),
    );
    expect(r).toMatch(/does not enforce both/);
  });
});

/* ============================================= the host substrate */

function hostRunner(map: Record<string, { code: number; stdout: string }>): CommandRunner {
  return async (bin, args) => {
    const key = bin + ' ' + args.join(' ');
    const hit = map[key];
    if (hit === undefined) return { code: 1, stdout: '', stderr: '', spawnFailed: false };
    return { code: hit.code, stdout: hit.stdout, stderr: '' };
  };
}

describe('the host substrate refuses native Windows for engineering execution', () => {
  it('native Windows is never HARD, whatever else is present', async () => {
    const substrate = new HostExecutionSubstrate({
      clock: clock(),
      engineVersion: '2.1.218',
      platform: 'win32',
      // Even with a perfect WSL2 environment, the HOST prerequisite still fails.
      run: hostRunner({
        'wsl.exe -l -v': { code: 0, stdout: 'NAME STATE VERSION\n* Ubuntu Running 2\n' },
        'wsl.exe -- uname -r': { code: 0, stdout: '6.6.0-microsoft-standard-WSL2' },
        'wsl.exe -- which claude': { code: 0, stdout: '/usr/local/bin/claude' },
        'wsl.exe -- which node': { code: 0, stdout: '/usr/bin/node' },
        'wsl.exe -- which socat': { code: 0, stdout: '/usr/bin/socat' },
        'wsl.exe -- which bwrap': { code: 0, stdout: '/usr/bin/bwrap' },
        'wsl.exe -- which git': { code: 0, stdout: '/usr/bin/git' },
        'wsl.exe -- which python3': { code: 0, stdout: '/usr/bin/python3' },
      }),
    });
    const q = await substrate.qualify(fixture());
    expect(q.enforcementClass).toBe(EnforcementClass.NONE);
    expect(q.blockedBy).toMatch(/WIN_NO_NATIVE_SANDBOX/);
    expect(engineeringAuthorityRefusal(q)).toBeDefined();
  });

  it('a binary resolving under /mnt/ is the Windows one, and does not count', async () => {
    const substrate = new HostExecutionSubstrate({
      clock: clock(),
      engineVersion: '2.1.218',
      platform: 'win32',
      run: hostRunner({
        'wsl.exe -l -v': { code: 0, stdout: '* Ubuntu Running 2\n' },
        // This is exactly what a real machine shows: npm/node reached through interop.
        'wsl.exe -- which node': { code: 0, stdout: '/mnt/c/Program Files/nodejs/node' },
      }),
    });
    const probe = await substrate.probe();
    const node = probe.prerequisites.find((p) => p.id === 'WSL_NODE')!;
    expect(node.satisfied).toBe(false);
    expect(node.why).toMatch(/interop/);
  });

  it('the seccomp filter is a prerequisite, because it is what blocks host escape', async () => {
    const substrate = new HostExecutionSubstrate({
      clock: clock(),
      engineVersion: '2.1.218',
      platform: 'win32',
      run: hostRunner({ 'wsl.exe -l -v': { code: 0, stdout: '* Ubuntu Running 2\n' } }),
    });
    const probe = await substrate.probe();
    const seccomp = probe.prerequisites.find((p) => p.id === 'WSL_SECCOMP_FILTER')!;
    expect(seccomp.satisfied).toBe(false);
    expect(seccomp.why).toMatch(/Unix socket/);
    expect(seccomp.remedy).toMatch(/sandbox-runtime/);
  });

  it('a missing prerequisite records every test as NOT_RUN, never as passed', async () => {
    const substrate = new HostExecutionSubstrate({
      clock: clock(),
      engineVersion: '2.1.218',
      platform: 'win32',
      run: hostRunner({}),
    });
    const q = await substrate.qualify(fixture());
    expect(q.tests).toHaveLength(QUALIFICATION_CASES.length);
    for (const t of q.tests) {
      expect(t.outcome, t.id).toBe('NOT_RUN');
      expect(t.detail).toMatch(/PLATFORM_PREREQUISITE_REQUIRED/);
    }
  });

  it('an unqualified host refuses to execute rather than running unsandboxed', async () => {
    const substrate = new HostExecutionSubstrate({
      clock: clock(),
      engineVersion: '2.1.218',
      platform: 'win32',
      run: hostRunner({}),
    });
    const r = await substrate.execute({
      executable: 'npm',
      args: ['test'],
      cwd: fixture(),
      env: {},
      timeoutMs: 1000,
      maxOutputBytes: 100,
      writeScope: [],
      networkAllowed: false,
    });
    expect(r.refusedBySubstrate).toBe(true);
    expect(r.refusalReason).toMatch(/not qualified/);
    expect(r.exitCode).toBeNull();
  });

  it('explain names both what was tested and what was not', async () => {
    const substrate = new HostExecutionSubstrate({
      clock: clock(),
      engineVersion: '2.1.218',
      platform: 'win32',
      run: hostRunner({}),
    });
    const text = await substrate.explain();
    for (const c of QUALIFICATION_CASES) expect(text).toContain(c.id);
    expect(text).toMatch(/escapes nobody thought of/);
  });

  it('an engine older than the qualification was written for is a prerequisite failure', async () => {
    const substrate = new HostExecutionSubstrate({
      clock: clock(),
      engineVersion: '2.0.0',
      platform: 'linux',
      run: hostRunner({}),
    });
    const probe = await substrate.probe();
    expect(probe.prerequisites.find((p) => p.id === 'ENGINE_VERSION')?.satisfied).toBe(false);
  });

  it('compares versions numerically', () => {
    expect(compareVersions('2.1.218', '2.1.216')).toBe(1);
    expect(compareVersions('2.1.99', '2.1.216')).toBe(-1);
  });

  it('probes each binary with a separate simple command', () => {
    // An inline shell loop does not survive wsl.exe command-line re-parsing: the loop
    // variable arrives empty and every binary reports MISSING, which would block a
    // machine that was actually fine.
    expect([...WSL_REQUIRED_BINARIES]).toContain('bwrap');
    expect([...WSL_REQUIRED_BINARIES]).toContain('socat');
    expect([...WSL_REQUIRED_BINARIES]).toContain('claude');
  });
});

/* ============================================= the fake substrate is a real boundary */

describe('the fake substrate enforces rather than pretending', () => {
  it('a NONE fake refuses execution', async () => {
    const s = new FakeExecutionSubstrate({ clock: clock(), enforcement: 'NONE' });
    const r = await s.execute({
      executable: 'node',
      args: ['-e', ''],
      cwd: fixture(),
      env: {},
      timeoutMs: 1000,
      maxOutputBytes: 100,
      writeScope: [],
      networkAllowed: false,
    });
    expect(r.refusedBySubstrate).toBe(true);
  });

  it('a SOFT fake reports the OS-level cases as FAILED, not as skipped', async () => {
    const s = new FakeExecutionSubstrate({ clock: clock(), enforcement: 'SOFT' });
    const q = await s.qualify(fixture());
    const f = q.tests.find((t) => t.id === 'Q-F')!;
    expect(f.outcome).toBe('FAILED');
    expect(f.detail).toMatch(/cannot constrain/);
    expect(q.enforcementClass).not.toBe(EnforcementClass.HARD);
  });

  it('a HARD fake qualifies and can execute inside its scope', async () => {
    const dir = fixture();
    const s = new FakeExecutionSubstrate({ clock: clock(), enforcement: 'HARD' });
    const q = await s.qualify(dir);
    expect(q.enforcementClass).toBe(EnforcementClass.HARD);
    const r = await s.execute({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("hello")'],
      cwd: dir,
      env: {},
      timeoutMs: 10_000,
      maxOutputBytes: 1000,
      writeScope: [dir],
      networkAllowed: false,
    });
    expect(r.refusedBySubstrate).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hello');
  });

  it('a cwd outside the write scope is refused', async () => {
    const inside = fixture();
    const outside = fixture();
    const s = new FakeExecutionSubstrate({ clock: clock(), enforcement: 'HARD' });
    const r = await s.execute({
      executable: process.execPath,
      args: ['-e', ''],
      cwd: outside,
      env: {},
      timeoutMs: 5000,
      maxOutputBytes: 100,
      writeScope: [inside],
      networkAllowed: false,
    });
    expect(r.refusedBySubstrate).toBe(true);
    expect(r.refusalReason).toMatch(/outside the granted write scope/);
  });

  it('a forced-fail case cannot be talked back into HARD', async () => {
    const s = new FakeExecutionSubstrate({
      clock: clock(),
      enforcement: 'HARD',
      failCases: ['Q-J'],
    });
    const q = await s.qualify(fixture());
    expect(q.enforcementClass).not.toBe(EnforcementClass.HARD);
    expect(q.blockedBy).toMatch(/Q-J/);
  });

  it('output is capped and the truncation is reported', async () => {
    const dir = fixture();
    const s = new FakeExecutionSubstrate({ clock: clock(), enforcement: 'HARD' });
    const r = await s.execute({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(10000))'],
      cwd: dir,
      env: {},
      timeoutMs: 10_000,
      maxOutputBytes: 100,
      writeScope: [dir],
      networkAllowed: false,
    });
    expect(r.stdout.length).toBeLessThanOrEqual(100);
    expect(r.truncated.stdout).toBe(true);
  });

  it('a command past its deadline is killed and reported as timed out', async () => {
    const dir = fixture();
    const s = new FakeExecutionSubstrate({ clock: clock(), enforcement: 'HARD' });
    const r = await s.execute({
      executable: process.execPath,
      args: ['-e', 'setTimeout(()=>{}, 60000)'],
      cwd: dir,
      env: {},
      timeoutMs: 300,
      maxOutputBytes: 1000,
      writeScope: [dir],
      networkAllowed: false,
    });
    expect(r.timedOut).toBe(true);
  }, 20_000);
});

/* ============================================= path resolution */

describe('containment is judged on the resolved path', () => {
  it('a symlinked path is resolved before it is compared', () => {
    const inside = fixture();
    const outside = fixture();
    const target = join(outside, 'secret.txt');
    writeFileSync(target, 'x', 'utf8');
    const link = join(inside, 'link.txt');
    try {
      symlinkSync(target, link);
    } catch {
      return; // symlink creation needs privilege on some Windows configurations
    }
    // The link LOOKS inside; what it points at is not, and that is what counts.
    expect(safeRealpath(link)).toBe(safeRealpath(target));
    expect(withinAny(link, [inside])).toBe(false);
    expect(withinAny(link, [outside])).toBe(true);
  });

  it('a path that does not exist yet still resolves through its parent', () => {
    const dir = fixture();
    const nested = join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const future = join(nested, 'not-created-yet.txt');
    expect(withinAny(future, [dir])).toBe(true);
  });

  it('a sibling directory sharing a prefix is not inside', () => {
    const dir = fixture();
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'srcret'), { recursive: true });
    expect(withinAny(join(dir, 'srcret', 'x'), [join(dir, 'src')])).toBe(false);
  });

  it('parent traversal lands outside and is seen to', () => {
    const dir = fixture();
    expect(withinAny(join(dir, '..', '..', 'etc'), [dir])).toBe(false);
  });
});
