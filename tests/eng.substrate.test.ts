import { afterEach, describe, expect, it } from 'vitest';
import { EnforcementClass } from '../src/vocab/index.js';
import { FixedClock } from '../src/core/clock.js';
import {
  EnforcementState,
  deriveEnforcementClass,
  engineeringAuthorityRefusal,
  qualificationIsStale,
  type QualificationResult,
  type SubstrateCapabilities,
  type SubstrateQualification,
  ExecutionAvailability,
  NotRunReason,
  QualificationAttempt,
} from '../src/substrate/types.js';
import { BLOCKING_CASE_IDS, QUALIFICATION_CASES } from '../src/substrate/qualification.js';
import { compareVersions, selectExecutionSubstrate } from '../src/substrate/host.js';
import {
  PRODUCER_REQUIRED_BINARIES,
  RECIPE_REQUIRED_BINARIES,
  SandboxedExecutionSubstrate,
} from '../src/substrate/sandboxed.js';
import { ClaudeSandboxLauncher, srtConfigFrom } from '../src/substrate/claudeSandbox.js';
import { WslProcessLauncher } from '../src/engine/processLauncher.js';
import { BoundaryPurpose, boundaryMismatch, executionBoundary } from '../src/substrate/boundary.js';
import {
  BubblewrapLauncher,
  UnimplementedLauncher,
  type SandboxLauncher,
} from '../src/substrate/sandboxLauncher.js';
import {
  TransportKind,
  WslTransport,
  parseWslList,
  selectWslDistribution,
  toWslPath,
  type ExecTransport,
  type TransportCommand,
  type TransportResult,
  GuestReach,
} from '../src/substrate/transport.js';
import {
  SimulatedExecutionSubstrate,
  makeFixtureDir,
  removeFixtureDir,
  safeRealpath,
  withinAny,
} from '../src/substrate/fake.js';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

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
  /* A PASS from a probe that never reached the guest would be a contradiction. */
  reachedGuest: GuestReach.REACHED,
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
      /*
       * A measured attempt against a reachable environment, so these cases are about the
       * CLASS rather than about transport. The unmeasured and unreachable paths are covered
       * separately, and folding them in here would let a fixture that forgot to say pass by
       * accident.
       */
      attempt: QualificationAttempt.MEASURED,
      availability: ExecutionAvailability.AVAILABLE,
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

/* ======================================= substrate selection and the real path */

/**
 * A scriptable stand-in for the GUEST's responses.
 *
 * It is not a sandbox and does not pretend to be one. What it exercises is Serva's own
 * orchestration: does the probe detect what is there, does qualification actually RUN
 * the adversarial programs through `execute()`, and is the enforcement class derived
 * from their outcomes? Containment itself is proved on a real machine by the live
 * suite, never here.
 */
class StubTransport implements ExecTransport {
  readonly id = 'stub';
  readonly kind = TransportKind.LOCAL_POSIX;
  /** Every command it was asked to run, so a test can assert on the argv. */
  readonly seen: TransportCommand[] = [];

  constructor(
    private readonly answers: Record<string, { code: number | null; stdout?: string }>,
    /** Exit code per qualification program, keyed by case id. */
    private readonly programs: Record<string, number> = {},
  ) {}

  toGuestPath(p: string): string {
    return p.replace(/\\/g, '/');
  }

  environmentFor(hostEnv: Readonly<Record<string, string>>): Record<string, string> {
    return { ...hostEnv, PATH: '/usr/bin:/bin' };
  }

  async fingerprint(): Promise<Record<string, string>> {
    return { transport: this.id, kind: this.kind, kernel: '6.6.0-stub', guestOs: 'Stub Linux' };
  }

  async run(command: TransportCommand): Promise<TransportResult> {
    this.seen.push(command);

    /*
     * Serva now resolves an executable to an absolute guest path before running it, and
     * probes with `sh -c 'command -v <bin>'` rather than `which`. The fixture keys stay
     * readable by normalising both back to the short form.
     */
    let exe = basename(command.executable);
    let args = [...command.args];
    if (exe === 'sh' && args[0] === '-c' && args[1]?.startsWith('command -v ')) {
      const bin = args[1].slice('command -v '.length);
      const hit = this.answers['which ' + bin];
      return hit === undefined
        ? { ...blank(1), spawnFailed: true }
        : blank(hit.code, hit.stdout ?? '');
    }
    const sep = exe === 'bwrap' || exe === 'srt' ? args.indexOf('--') : -1;
    if (sep >= 0) {
      exe = basename(args[sep + 1] ?? '');
      args = args.slice(sep + 2);
    }

    const script = args.find((a) => a.endsWith('.cjs'));
    if (exe === 'node' && script !== undefined) {
      const id = /(Q-[A-K])\.cjs$/.exec(script)?.[1];
      const code = id === undefined ? 1 : (this.programs[id] ?? 1);
      return blank(code);
    }
    if (exe === 'node' && args[0] === '-e') {
      // The Q-K probe: a violating write, which the boundary must refuse.
      if (this.programs['Q-K-write'] === -1) {
        /*
         * A TRANSPORT failure, not a refusal. WSL's documented shape: a huge exit code, no
         * output, and nothing reached the guest at all.
         */
        return {
          ...blank(4294967295),
          spawnFailed: true,
          reach: GuestReach.NOT_REACHED,
          attempts: [
            {
              attempt: 1,
              reach: GuestReach.NOT_REACHED,
              exitCode: 4294967295,
              spawnFailed: true,
              timedOut: false,
              detail: 'wsl.exe exited 4294967295 with no output',
            },
          ],
        };
      }
      return blank(this.programs['Q-K-write'] ?? 1);
    }

    const hit = this.answers[[exe, ...args].join(' ')];
    if (hit === undefined) {
      return { ...blank(1), spawnFailed: true, reach: GuestReach.NOT_REACHED };
    }
    return blank(hit.code, hit.stdout ?? '');
  }
}

function blank(code: number | null, stdout = ''): TransportResult {
  return {
    exitCode: code,
    stdout,
    stderr: '',
    timedOut: false,
    truncated: { stdout: false, stderr: false },
    spawnFailed: false,
    /*
     * This fixture stands in for a transport that DID run the command; every case here is
     * about what the command then did. A fixture claiming REACHED is therefore honest, and a
     * fixture that left it UNKNOWN would make every test below assert against a state the
     * real transport treats as unmeasured.
     */
    reach: GuestReach.REACHED,
    attempts: [],
  };
}

/** A guest with everything installed. The starting point every test narrows from. */
function healthyGuest(): Record<string, { code: number; stdout?: string }> {
  return {
    'which node': { code: 0, stdout: '/usr/bin/node\n' },
    'which git': { code: 0, stdout: '/usr/bin/git\n' },
    'which bwrap': { code: 0, stdout: '/usr/bin/bwrap\n' },
    'which socat': { code: 0, stdout: '/usr/bin/socat\n' },
    'which claude': { code: 0, stdout: '/usr/local/bin/claude\n' },
    'which srt': { code: 0, stdout: '/usr/local/bin/srt\n' },
    'bwrap --version': { code: 0, stdout: 'bubblewrap 0.8.0\n' },
    'srt --help': { code: 0, stdout: 'usage: srt [--settings <file>] -- <command>\n' },
    'srt --version': { code: 0, stdout: 'sandbox-runtime 0.4.1\n' },
    'cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns': { code: 1 },
    'cat /proc/sys/fs/binfmt_misc/WSLInterop': { code: 1 },
  };
}

/** Every adversarial attempt refused, and the permitted one allowed. */
const CONTAINED: Record<string, number> = {
  'Q-A': 0,
  'Q-B': 1,
  'Q-C': 1,
  'Q-D': 1,
  'Q-E': 1,
  'Q-F': 1,
  'Q-G': 1,
  'Q-H': 1,
  'Q-I': 1,
  'Q-J': 1,
  'Q-K-write': 1,
};

function sandboxed(
  transport: ExecTransport,
  o: {
    launcher?: SandboxLauncher;
    engineVersion?: string;
    purpose?: BoundaryPurpose;
    boundaryId?: string;
    requiresEngine?: boolean;
    requiredBinaries?: readonly { bin: string; why: string; remedy: string }[];
    profileDigest?: string;
  } = {},
): SandboxedExecutionSubstrate {
  return new SandboxedExecutionSubstrate({
    transport,
    launcher: o.launcher ?? new BubblewrapLauncher(),
    clock: clock(),
    engineVersion: o.engineVersion ?? '2.1.218',
    projectRoot: process.cwd(),
    minEngineVersion: '2.1.216',
    purpose: o.purpose ?? BoundaryPurpose.RECIPE,
    boundaryId: o.boundaryId ?? 'SC-BOUNDARY-RECIPE',
    ...(o.requiredBinaries === undefined ? {} : { requiredBinaries: o.requiredBinaries }),
    ...(o.requiresEngine === undefined ? {} : { requiresEngine: o.requiresEngine }),
    ...(o.profileDigest === undefined ? {} : { profileDigest: o.profileDigest }),
  });
}

describe('Windows delegates execution into a WSL2 guest', () => {
  const base = { clock: clock(), engineVersion: '2.1.218', projectRoot: process.cwd() };

  it('a WSL2 distribution becomes the candidate substrate', async () => {
    const sel = await selectExecutionSubstrate({
      ...base,
      platform: 'win32',
      env: {},
      listDistributions: async () => [{ name: 'Ubuntu', version: 2, isDefault: true }],
    });
    expect(sel.substrate).toBeInstanceOf(SandboxedExecutionSubstrate);
    // Native Windows is still non-HARD. What qualifies is the guest.
    expect(sel.basis).toMatch(/Native Windows remains NON-HARD/);
    expect(sel.basis).toContain('Ubuntu');
  });

  it('no WSL distribution gives a prerequisite the owner can actually satisfy', async () => {
    const sel = await selectExecutionSubstrate({
      ...base,
      platform: 'win32',
      env: {},
      listDistributions: async () => [],
    });
    const q = await sel.substrate.qualify('unused');
    const missing = q.probe.prerequisites.filter((p) => !p.satisfied);
    expect(missing.map((p) => p.id)).toEqual(['WSL_DISTRIBUTION']);
    /*
     * The defect this replaces: WIN_NO_NATIVE_SANDBOX was reported as unsatisfied and
     * could never become satisfied, so the documented remedy led nowhere. Every
     * prerequisite must name something a person can actually do.
     */
    expect(missing[0]?.remedy).toMatch(/Install WSL2/);
    expect(q.enforcementClass).toBe(EnforcementClass.NONE);
  });

  it('a WSL1 distribution is named with the exact conversion command', async () => {
    const sel = await selectExecutionSubstrate({
      ...base,
      platform: 'win32',
      env: { SERVA_WSL_DISTRO: 'Legacy' },
      listDistributions: async () => [{ name: 'Legacy', version: 1, isDefault: true }],
    });
    const q = await sel.substrate.qualify('unused');
    expect(q.probe.prerequisites[0]?.id).toBe('WSL_VERSION_2');
    expect(q.probe.prerequisites[0]?.remedy).toBe('wsl --set-version Legacy 2');
  });

  it('the distribution is selected deterministically, never "whichever answered"', () => {
    const list = [
      { name: 'Zeta', version: 2, isDefault: false },
      { name: 'Alpha', version: 2, isDefault: false },
      { name: 'Legacy', version: 1, isDefault: true },
    ];
    // No default among the v2 distributions: first by name, so two runs agree.
    expect(selectWslDistribution(list, {})?.name).toBe('Alpha');
    expect(selectWslDistribution(list, { SERVA_WSL_DISTRO: 'Zeta' })?.name).toBe('Zeta');
    expect(selectWslDistribution(list, { SERVA_WSL_DISTRO: 'Absent' })).toBeUndefined();
    expect(
      selectWslDistribution([{ name: 'D', version: 2, isDefault: true }, ...list], {})?.name,
    ).toBe('D');
  });

  it('parses the distribution list defensively', () => {
    const raw = 'NAME  STATE  VERSION\r\n* Ubuntu  Running  2\r\n  Legacy  Stopped  1\r\n';
    expect(parseWslList(raw)).toEqual([
      { name: 'Ubuntu', version: 2, isDefault: true },
      { name: 'Legacy', version: 1, isDefault: false },
    ]);
  });

  it('the WSL invocation bypasses the guest shell, so argv survives', () => {
    /*
     * `wsl.exe -d D -- cmd args` hands the remainder to the guest's default shell,
     * which re-parses it. Measured: `-- /bin/echo 'a(b)'` dies with
     * `bash: syntax error near unexpected token '('`; `--exec /bin/echo 'a(b)'` prints
     * `a(b)`. The engine's argv carries a JSON schema, so every real invocation failed
     * before the engine started.
     *
     * This had been written up as an assumption that was not load-bearing because Q-A
     * runs through the same path. Q-A does, and passed — its arguments happen to be
     * shell-clean. An assumption that only holds for the inputs you tested is not a
     * mitigated risk, so it is asserted here instead.
     */
    const spawned: { args: readonly string[] }[] = [];
    const launcher = new WslProcessLauncher({
      distro: 'Ubuntu',
      guestBin: '/usr/bin/claude',
      spawnFn: ((_bin: string, args: readonly string[]) => {
        spawned.push({ args });
        return { on: () => undefined } as never;
      }) as never,
    });
    launcher.spawn('/usr/bin/claude', ['--json-schema', '{"a":(1)}'], {
      cwd: 'C:\w',
      env: {},
    });

    const args = spawned[0]?.args ?? [];
    expect(args).toContain('--exec');
    expect(args).not.toContain('--');
    // The metacharacter-bearing argument survives as its own argv element.
    expect(args[args.length - 1]).toBe('{"a":(1)}');
  });

  it('translation is idempotent, because it is applied twice in practice', () => {
    /*
     * Qualification builds a guest-path layout and then hands those paths to
     * `execute`, which translates its own inputs. Without idempotence that produced
     * `/mnt/c/mnt/c/...`: on Windows `resolve('/mnt/c/x')` yields a path on the current
     * drive, which then translates a second time. The failure surfaced as Q-A refusing
     * a PERMITTED write, and the only thing that stopped it being read as successful
     * containment is that Q-A is a positive control.
     */
    const t = new WslTransport('Ubuntu');
    const once = t.toGuestPath('C:\\Users\\a\\tmp\\wt');
    expect(once).toBe('/mnt/c/Users/a/tmp/wt');
    expect(t.toGuestPath(once)).toBe(once);
    expect(toWslPath(toWslPath('D:\\x'))).toBe('/mnt/d/x');
  });

  it('translates a Windows path to the guest view', () => {
    expect(toWslPath('D:\\SEVACODE\\src')).toBe('/mnt/d/SEVACODE/src');
    expect(new WslTransport('Ubuntu').toGuestPath('C:\\a\\b')).toBe('/mnt/c/a/b');
  });

  it('an unsupported platform still names a satisfiable remedy', async () => {
    const sel = await selectExecutionSubstrate({ ...base, platform: 'aix' as NodeJS.Platform });
    const q = await sel.substrate.qualify('unused');
    expect(q.probe.prerequisites[0]?.id).toBe('SUPPORTED_PLATFORM');
    expect(q.enforcementClass).toBe(EnforcementClass.NONE);
  });

  it('macOS reports no launcher rather than running a Producer unconstrained', async () => {
    const sel = await selectExecutionSubstrate({ ...base, platform: 'darwin' });
    expect(sel.basis).toMatch(/no launcher implemented/);
  });
});

describe('prerequisites are detected, not assumed', () => {
  it('the recipe boundary does not require what bubblewrap never uses', async () => {
    /*
     * `socat` and the syscall filter used to be prerequisites of THIS boundary, and
     * neither was used by it: the launcher's argv mentions neither. A prerequisite
     * counted because a file exists on disk, rather than because it participates, is
     * a checkbox pretending to be a control.
     *
     * They moved to the Producer boundary, where the mechanism genuinely needs them.
     */
    const ids = RECIPE_REQUIRED_BINARIES.map((b) => b.bin);
    expect(ids).toContain('bwrap');
    expect(ids).not.toContain('socat');
    expect(PRODUCER_REQUIRED_BINARIES.map((b) => b.bin)).toContain('socat');

    const probe = await sandboxed(new StubTransport(healthyGuest())).probe();
    expect(probe.prerequisites.map((p) => p.id)).not.toContain('SECCOMP_FILTER');
  });

  it('the Producer boundary IS the sandbox runtime, so its absence stops everything', async () => {
    // Detection is no longer a checkbox: the runtime is what wraps every command, so
    // "not installed" and "no boundary" are the same fact rather than two.
    const guest = healthyGuest();
    delete guest['srt --help'];
    const probe = await sandboxed(new StubTransport(guest), {
      launcher: new ClaudeSandboxLauncher({
        configHostPath: join(fixture(), 'srt.json'),
        configGuestPath: '/tmp/srt.json',
      }),
      purpose: BoundaryPurpose.PRODUCER,
      boundaryId: 'SC-BOUNDARY-PRODUCER',
      requiredBinaries: PRODUCER_REQUIRED_BINARIES,
      requiresEngine: true,
    }).probe();

    const launcher = probe.prerequisites.find((p) => p.id === 'SANDBOX_LAUNCHER');
    expect(launcher?.satisfied).toBe(false);
    expect(launcher?.remedy).toMatch(/sandbox-runtime/);
  });

  it('the runtime config is written in the runtime OWN schema', () => {
    /*
     * Serva used to hand `srt` a Claude Code settings profile — `{"sandbox": {...}}` —
     * and the runtime rejected it with `network: Required, filesystem: Required` and
     * `Refusing to run with the default config`. Every case then failed identically,
     * Q-A included, which is how a positive control exposes "the boundary never
     * started" instead of letting it read as containment.
     */
    const cfg = srtConfigFrom({
      allowWrite: ['/w'],
      allowRead: ['/p'],
      denyRead: ['/p/.serva'],
      networkAllowed: false,
    }) as { network: Record<string, unknown>; filesystem: Record<string, unknown> };

    // Top level, not nested under `sandbox`.
    expect(Object.keys(cfg).sort()).toEqual(['filesystem', 'network']);
    expect(cfg.network['allowedDomains']).toEqual([]);
    expect(cfg.network['deniedDomains']).toEqual([]);
    expect(cfg.filesystem['allowWrite']).toEqual(['/w']);
    expect(cfg.filesystem['denyRead']).toEqual(['/p/.serva']);
    // The runtime has no `allowRead`: reads are permitted unless denied. Emitting one
    // would be emitting a key it validates against and rejects.
    expect(cfg.filesystem['allowRead']).toBeUndefined();
  });

  it('a sandbox runtime whose command line Serva cannot read is refused, not guessed', async () => {
    const guest = healthyGuest();
    guest['srt --help'] = { code: 0, stdout: 'usage: srt [--wat]\n' };
    const probe = await sandboxed(new StubTransport(guest), {
      launcher: new ClaudeSandboxLauncher({
        configHostPath: join(fixture(), 'srt.json'),
        configGuestPath: '/tmp/srt.json',
      }),
      purpose: BoundaryPurpose.PRODUCER,
      boundaryId: 'SC-BOUNDARY-PRODUCER',
    }).probe();
    const launcher = probe.prerequisites.find((p) => p.id === 'SANDBOX_LAUNCHER');
    expect(launcher?.satisfied).toBe(false);
    expect(probe.observations['launcher:detail']).toMatch(/will not guess a command line/);
  });

  it('a binary resolving under /mnt/ is the Windows one, and does not count', async () => {
    const guest = healthyGuest();
    guest['which node'] = { code: 0, stdout: '/mnt/c/Program Files/nodejs/node\n' };
    const s = sandboxed(new StubTransport(guest));
    const probe = await s.probe();
    const node = probe.prerequisites.find((p) => p.id === 'GUEST_NODE');
    expect(node?.satisfied).toBe(false);
    expect(node?.why).toMatch(/interop/);
  });

  it('a restricted user namespace policy is a prerequisite failure', async () => {
    const guest = healthyGuest();
    guest['cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns'] = {
      code: 0,
      stdout: '1\n',
    };
    const s = sandboxed(new StubTransport(guest));
    const probe = await s.probe();
    expect(probe.prerequisites.find((p) => p.id === 'USER_NAMESPACES')?.satisfied).toBe(false);
  });

  it('an engine older than the qualification was written for is a prerequisite failure', async () => {
    const s = sandboxed(new StubTransport(healthyGuest()), {
      engineVersion: '2.0.0',
      requiresEngine: true,
    });
    const probe = await s.probe();
    expect(probe.prerequisites.find((p) => p.id === 'ENGINE_VERSION')?.satisfied).toBe(false);
  });

  it('an unreadable engine version is not a pass', async () => {
    // `compareVersions` returns 0 for anything it cannot parse, so `'UNKNOWN' >= min`
    // used to be true: the prerequisite reported satisfied for a version nobody had
    // established. "We could not tell" is not "it is new enough".
    const s = sandboxed(new StubTransport(healthyGuest()), {
      engineVersion: 'UNKNOWN',
      requiresEngine: true,
    });
    const p = (await s.probe()).prerequisites.find((x) => x.id === 'ENGINE_VERSION');
    expect(p?.satisfied).toBe(false);
    expect(p?.why).toMatch(/could not read at all/);
  });

  it('the recipe boundary does not require an engine version at all', async () => {
    // No engine is involved in `bwrap npm test`. Gating it on one would be a
    // prerequisite that cannot affect the thing it gates.
    const probe = await sandboxed(new StubTransport(healthyGuest())).probe();
    expect(probe.prerequisites.map((x) => x.id)).not.toContain('ENGINE_VERSION');
  });

  it('compares versions numerically', () => {
    expect(compareVersions('2.1.218', '2.1.216')).toBe(1);
    expect(compareVersions('2.1.99', '2.1.216')).toBe(-1);
  });
});

describe('qualification actually runs, and HARD is derived from what it observed', () => {
  it('a missing prerequisite records every case as NOT_RUN, never as passed', async () => {
    const s = sandboxed(new StubTransport({}));
    const q = await s.qualify(fixture());
    expect(q.tests).toHaveLength(QUALIFICATION_CASES.length);
    for (const t of q.tests) {
      expect(t.outcome, t.id).toBe('NOT_RUN');
      expect(t.detail).toMatch(/PLATFORM_PREREQUISITE_REQUIRED/);
    }
    expect(q.enforcementClass).toBe(EnforcementClass.NONE);
  });

  it('with prerequisites satisfied the adversarial programs are EXECUTED', async () => {
    /*
     * The blocker this closes: the previous implementation reached this point and
     * returned every case as NOT_RUN with "no qualified sandbox executor is wired for
     * this platform". Installing everything it asked for changed nothing at all.
     */
    const transport = new StubTransport(healthyGuest(), CONTAINED);
    const q = await sandboxed(transport).qualify(fixture());

    for (const t of q.tests) expect(t.outcome, t.id).toBe('PASSED');
    expect(q.enforcementClass).toBe(EnforcementClass.HARD);

    // Every case went through the sandbox launcher, not around it.
    const wrapped = transport.seen.filter((c) => c.executable === 'bwrap');
    expect(wrapped.length).toBeGreaterThanOrEqual(QUALIFICATION_CASES.length);
  });

  it('one escape that succeeds costs the substrate HARD', async () => {
    const escaped = { ...CONTAINED, 'Q-F': 0 };
    const q = await sandboxed(new StubTransport(healthyGuest(), escaped)).qualify(fixture());
    const qf = q.tests.find((t) => t.id === 'Q-F');
    expect(qf?.outcome).toBe('FAILED');
    expect(qf?.detail).toMatch(/THE ATTEMPT SUCCEEDED/);
    expect(q.enforcementClass).not.toBe(EnforcementClass.HARD);
    expect(q.capabilities.processEnforcement).toBe(EnforcementState.NOT_ENFORCED);
  });

  it('a boundary that refuses the PERMITTED write also fails to qualify', async () => {
    // A substrate that refuses everything is not a boundary, it is broken — and a
    // Producer that cannot write cannot work.
    const q = await sandboxed(
      new StubTransport(healthyGuest(), { ...CONTAINED, 'Q-A': 1 }),
    ).qualify(fixture());
    expect(q.tests.find((t) => t.id === 'Q-A')?.outcome).toBe('FAILED');
    expect(q.enforcementClass).not.toBe(EnforcementClass.HARD);
  });

  it('Q-K counts transport invocations, so a silent retry could not hide', async () => {
    const transport = new StubTransport(healthyGuest(), CONTAINED);
    const q = await sandboxed(transport).qualify(fixture());
    expect(q.tests.find((t) => t.id === 'Q-K')?.detail).toMatch(/invoked exactly once/);
  });

  it('the qualification is fingerprinted, so a changed machine invalidates it', async () => {
    const a = await sandboxed(new StubTransport(healthyGuest(), CONTAINED)).qualify(fixture());
    const guest = healthyGuest();
    guest['bwrap --version'] = { code: 0, stdout: 'bubblewrap 0.9.0\n' };
    const b = await sandboxed(new StubTransport(guest, CONTAINED)).qualify(fixture());

    expect(a.fingerprint).not.toBe(b.fingerprint);
    // A timestamp could not answer this: an hour-old qualification on an unchanged
    // machine is fine, and a minute-old one is worthless after a kernel upgrade.
    expect(qualificationIsStale(a, b.fingerprint)).toBe(true);
    expect(qualificationIsStale(a, a.fingerprint)).toBe(false);
  });
});

describe('execution goes through the boundary or does not happen', () => {
  const request = (dir: string) => ({
    executable: 'node',
    args: ['-e', '1'],
    cwd: dir,
    env: {},
    timeoutMs: 5_000,
    maxOutputBytes: 1_000,
    writeScope: [dir],
    networkAllowed: false,
  });

  it('a wrapped command carries the write scope and no network', async () => {
    const transport = new StubTransport(healthyGuest());
    const dir = fixture();
    await sandboxed(transport).execute(request(dir));

    // `find` would return the launcher's own `--version` probe; the wrapped run is
    // the one that carries the namespace flags.
    const cmd = transport.seen.find((c) => c.args.includes('--unshare-all'));
    expect(cmd).toBeDefined();
    expect(cmd?.args).toContain('--unshare-all');
    expect(cmd?.args).not.toContain('--share-net');
    expect(cmd?.args).toContain('--bind-try');
    expect(cmd?.args).toContain(dir.replace(/\\/g, '/'));
  });

  it('network is added back only on an explicit grant', async () => {
    const transport = new StubTransport(healthyGuest());
    const dir = fixture();
    await sandboxed(transport).execute({ ...request(dir), networkAllowed: true });
    expect(transport.seen.find((c) => c.args.includes('--unshare-all'))?.args).toContain(
      '--share-net',
    );
  });

  it('masks come after grants, so a denial cannot be re-opened by a parent grant', () => {
    const wrapped = new BubblewrapLauncher().wrap(
      { executable: 'node', args: [], cwd: '/w', env: {}, timeoutMs: 1, maxOutputBytes: 1 },
      {
        allowWrite: ['/w'],
        allowRead: ['/project'],
        denyRead: ['/project/.serva'],
        networkAllowed: false,
      },
    );
    const args = wrapped.args;
    const readGrant = args.indexOf('/project');
    const mask = args.lastIndexOf('/project/.serva');
    expect(readGrant).toBeGreaterThan(-1);
    // bubblewrap applies operations left to right, so the last word wins and the last
    // word has to be the denial.
    expect(mask).toBeGreaterThan(readGrant);
    expect(args).toContain('/run/WSL');
  });

  it('an unavailable launcher refuses; it never falls back to running unwrapped', async () => {
    const guest = healthyGuest();
    delete guest['bwrap --version'];
    const transport = new StubTransport(guest);
    const r = await sandboxed(transport).execute(request(fixture()));

    expect(r.refusedBySubstrate).toBe(true);
    expect(r.refusalReason).toMatch(/does not run a Producer command outside a boundary/);
    // The decisive assertion: nothing was spawned at all.
    expect(transport.seen.filter((c) => c.executable === 'node')).toHaveLength(0);
  });

  it('an unimplemented launcher refuses, and its passthrough is never reached', async () => {
    const transport = new StubTransport(healthyGuest());
    const launcher = new UnimplementedLauncher('nothing here');
    const r = await sandboxed(transport, { launcher }).execute(request(fixture()));
    expect(r.refusedBySubstrate).toBe(true);
    expect(transport.seen.filter((c) => c.executable === 'node')).toHaveLength(0);
  });

  it('a command with no write scope is refused rather than given the whole machine', async () => {
    const r = await sandboxed(new StubTransport(healthyGuest())).execute({
      ...request(fixture()),
      writeScope: [],
    });
    expect(r.refusedBySubstrate).toBe(true);
    expect(r.refusalReason).toMatch(/No write scope/);
  });
});

/* ============================ the simulated substrate: deterministic, not contained */

describe('the simulated substrate is deterministic and claims no containment', () => {
  it('a NONE fake refuses execution', async () => {
    const s = new SimulatedExecutionSubstrate({ clock: clock(), enforcement: 'NONE' });
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
    const s = new SimulatedExecutionSubstrate({ clock: clock(), enforcement: 'SOFT' });
    const q = await s.qualify(fixture());
    const f = q.tests.find((t) => t.id === 'Q-F')!;
    expect(f.outcome).toBe('FAILED');
    expect(f.detail).toMatch(/cannot constrain/);
    expect(q.enforcementClass).not.toBe(EnforcementClass.HARD);
  });

  it('a HARD fake qualifies and can execute inside its scope', async () => {
    const dir = fixture();
    const s = new SimulatedExecutionSubstrate({ clock: clock(), enforcement: 'HARD' });
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
    const s = new SimulatedExecutionSubstrate({ clock: clock(), enforcement: 'HARD' });
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
    const s = new SimulatedExecutionSubstrate({
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
    const s = new SimulatedExecutionSubstrate({ clock: clock(), enforcement: 'HARD' });
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
    const s = new SimulatedExecutionSubstrate({ clock: clock(), enforcement: 'HARD' });
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

/* ================================================= execution boundary identity */

describe('a qualification is a measurement OF something', () => {
  const wsl = () =>
    executionBoundary({
      boundaryId: 'SC-BOUNDARY-PRODUCER',
      purpose: BoundaryPurpose.PRODUCER,
      transport: 'wsl:Ubuntu',
      guest: 'Ubuntu 26.04 LTS',
      engineLocation: '/usr/local/bin/claude',
      engineVersion: '2.1.218',
      sandboxMechanism: 'claude-sandbox-runtime',
      sandboxVersion: '0.4.1',
      profileDigest: 'p'.repeat(64),
    });

  it('a WSL qualification does not authorize a native Windows engine', () => {
    /*
     * The defect this closes, exactly: Serva qualified the guest and dispatched onto
     * the host, and every other check passed because the only question asked was
     * whether an enforcement class said HARD.
     */
    const nativeWindows = executionBoundary({
      ...wsl(),
      transport: 'local',
      engineLocation: 'C:\\Program Files\\claude\\claude.exe',
    });
    const why = boundaryMismatch(wsl(), nativeWindows);
    expect(why).toMatch(/EXECUTION_BOUNDARY_MISMATCH/);
    expect(why).toMatch(/transport: qualified wsl:Ubuntu, actual local/);
    expect(why).toMatch(/engine location/);
  });

  it('distribution A does not authorize distribution B', () => {
    const other = executionBoundary({ ...wsl(), transport: 'wsl:Debian', guest: 'Debian 12' });
    expect(boundaryMismatch(wsl(), other)).toMatch(
      /transport: qualified wsl:Ubuntu, actual wsl:Debian/,
    );
  });

  it('engine version X does not authorize engine version Y', () => {
    const upgraded = executionBoundary({ ...wsl(), engineVersion: '2.2.0' });
    expect(boundaryMismatch(wsl(), upgraded)).toMatch(/engine version/);
  });

  it('a changed sandbox profile invalidates the qualification', () => {
    const relaxed = executionBoundary({ ...wsl(), profileDigest: 'q'.repeat(64) });
    expect(boundaryMismatch(wsl(), relaxed)).toMatch(/sandbox profile/);
  });

  it('a changed sandbox mechanism or version invalidates it', () => {
    expect(
      boundaryMismatch(wsl(), executionBoundary({ ...wsl(), sandboxMechanism: 'bubblewrap' })),
    ).toMatch(/sandbox mechanism/);
    expect(
      boundaryMismatch(wsl(), executionBoundary({ ...wsl(), sandboxVersion: '0.5.0' })),
    ).toMatch(/sandbox version/);
  });

  it('a simulated boundary never matches a measured one', () => {
    const simulated = executionBoundary({ ...wsl(), simulated: true });
    expect(boundaryMismatch(wsl(), simulated)).toMatch(/simulated/);
  });

  it('the identical boundary matches', () => {
    expect(boundaryMismatch(wsl(), wsl())).toBeUndefined();
  });

  it('guest is the ADDRESSABLE environment, so both sides can populate it', async () => {
    /*
     * The two sides once meant different things by `guest`: qualification read
     * /etc/os-release and got "Ubuntu 26.04 LTS", dispatch read the launcher and got
     * "Ubuntu". They could never be equal, so a Producer could never be dispatched
     * however well the machine qualified. The comparison was right; the field was not.
     *
     * `guest` is now the WSL distribution name — the thing a launcher can actually
     * name. The OS release still invalidates a measurement, through the qualification
     * fingerprint rather than through this field.
     */
    const q = await sandboxed(new StubTransport(healthyGuest(), CONTAINED), {
      purpose: BoundaryPurpose.PRODUCER,
      boundaryId: 'SC-BOUNDARY-PRODUCER',
      requiresEngine: true,
    }).qualify(fixture());

    // The stub transport is `stub`, not `wsl:…`, so there is no addressable guest.
    expect(q.boundary.guest).toBeUndefined();
    // ...and the OS release is still reported for humans, and still in the
    // qualification fingerprint.
    expect(q.probe.guestPlatform).toBe('Stub Linux');

    const viaWsl = new WslTransport('Ubuntu');
    expect(viaWsl.id).toBe('wsl:Ubuntu');
    // Which is exactly what WslProcessLauncher reports as its location guest.
    expect(new WslProcessLauncher({ distro: 'Ubuntu' }).location.guest).toBe('Ubuntu');
  });

  it('the qualification carries the boundary it measured', async () => {
    const q = await sandboxed(new StubTransport(healthyGuest(), CONTAINED), {
      purpose: BoundaryPurpose.PRODUCER,
      boundaryId: 'SC-BOUNDARY-PRODUCER',
      requiresEngine: true,
      profileDigest: 'p'.repeat(64),
    }).qualify(fixture());

    expect(q.boundary.purpose).toBe(BoundaryPurpose.PRODUCER);
    expect(q.boundary.engineLocation).toBe('/usr/local/bin/claude');
    expect(q.boundary.profileDigest).toBe('p'.repeat(64));
    expect(q.boundary.simulated).toBe(false);
    // Same machine, different profile: a different boundary, and it says so.
    const other = await sandboxed(new StubTransport(healthyGuest(), CONTAINED), {
      purpose: BoundaryPurpose.PRODUCER,
      boundaryId: 'SC-BOUNDARY-PRODUCER',
      requiresEngine: true,
      profileDigest: 'z'.repeat(64),
    }).qualify(fixture());
    expect(boundaryMismatch(q.boundary, other.boundary)).toMatch(/sandbox profile/);
  });
});

/* ====== HIGH: a transport failure on Q-K is not a measurement of containment ====== */

describe('Q-K refuses to call a command it never ran a pass', () => {
  /*
   * SPEC: Phase 6 qualification transport invariant; HIGH finding
   * QUALIFICATION-TRANSPORT-SEMANTICS/QTS-1.
   *
   * Every other adversarial case in `qualify()` opens with
   * `if (result.reach !== GuestReach.REACHED) { record(..., NOT_RUN, TRANSPORT_FAILURE) }`.
   * Q-K, measured separately because it counts transport invocations rather than reading an
   * exit code, never inspected `reach` at all.
   *
   * On a WSL transport failure — exit 4294967295, no output, nothing reached the guest — Q-K
   * took neither the refused branch nor the exit-0 branch, `attempts === 1` held because the
   * substrate counter increments once regardless of the transport's internal retries, and Q-K
   * was recorded PASSED with "the transport was invoked exactly once: no unsandboxed retry".
   *
   * That is a measured-containment claim about a command that never ran, and it fails OPEN:
   * `deriveEnforcementClass`'s unreached guard counts only NOT_RUN/TRANSPORT_FAILURE, so a
   * PASSED Q-K sails past it and `capabilitiesFrom` credits it toward host-escape enforcement.
   * The one probe that was not guarded is the one guarding Producer dispatch authority.
   */
  it('records NOT_RUN with a transport reason, not PASSED', async () => {
    const transport = new StubTransport(healthyGuest(), { ...CONTAINED, 'Q-K-write': -1 });
    const s = sandboxed(transport);
    const q = await s.qualify(fixture());

    const qk = q.tests.find((t) => t.id === 'Q-K')!;
    expect(qk.outcome).toBe('NOT_RUN');
    expect(qk.notRunReason).toBe(NotRunReason.TRANSPORT_FAILURE);
    expect(qk.reachedGuest).toBe(GuestReach.NOT_REACHED);
    expect(qk.detail).toMatch(/never reached|transport/i);
  });

  it('does not grant HARD on the strength of a probe that never ran', async () => {
    /*
     * The consequence, stated as its own test: every other probe contained, and this one
     * unmeasured, must not add up to a measured HARD boundary.
     */
    const transport = new StubTransport(healthyGuest(), { ...CONTAINED, 'Q-K-write': -1 });
    const s = sandboxed(transport);
    const q = await s.qualify(fixture());
    expect(q.enforcementClass).not.toBe(EnforcementClass.HARD);
  });

  it('still PASSES Q-K when the command genuinely reached the guest and was refused', () => {
    /* The fix must not turn a real refusal into a non-measurement. */
    return (async () => {
      const transport = new StubTransport(healthyGuest(), CONTAINED);
      const s = sandboxed(transport);
      const q = await s.qualify(fixture());
      const qk = q.tests.find((t) => t.id === 'Q-K')!;
      expect(qk.outcome).toBe('PASSED');
    })();
  });
});
