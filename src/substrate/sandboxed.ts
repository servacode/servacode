import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, digestOf } from '../core/hash.js';
import { EnforcementClass } from '../vocab/index.js';
import {
  EnforcementState,
  IsolationMethod,
  deriveEnforcementClass,
  type ExecuteRequest,
  type ExecuteResult,
  type ExecutionSubstrate,
  type Prerequisite,
  type QualificationResult,
  type SubstrateCapabilities,
  type SubstrateProbe,
  type SubstrateQualification,
} from './types.js';
import { QUALIFICATION_CASES } from './qualification.js';
import { TransportKind, type ExecTransport, type TransportCommand } from './transport.js';
import type { SandboxLauncher, SandboxSpec } from './sandboxLauncher.js';
import type { Clock } from '../core/clock.js';

/**
 * A substrate that actually contains, actually qualifies, and actually executes.
 *
 * SPEC: Phase 4 closure blocker 1, ADR-003.
 *
 * The implementation this replaces could never become HARD. It reported prerequisites,
 * and then — even with every one of them satisfied — returned Q-A…Q-K as NOT_RUN with
 * "no qualified sandbox executor is wired for this platform", and refused every
 * `execute()`. Installing the listed packages would not have changed the outcome. A
 * refusal that no amount of work can lift is not a fail-closed boundary; it is an
 * unimplemented feature wearing one.
 *
 * The path is now real and complete:
 *
 *   prerequisites detected -> Q-A…Q-K RUN through execute() -> HARD derived from what
 *   they proved -> execute() runs Producer commands through the SAME boundary
 *
 * Three properties hold by construction:
 *
 *   - **Qualification uses the production path.** Every adversarial case goes through
 *     `this.execute()`, so the thing that was measured is the thing that later runs. A
 *     suite that exercised a separate code path would prove nothing about the one that
 *     matters.
 *   - **HARD is never configured.** There is no option, flag or constructor argument
 *     that sets the enforcement class. It comes from `deriveEnforcementClass` over
 *     observed outcomes, and a NOT_RUN blocking case counts exactly as a failure.
 *   - **A broken assumption fails closed.** The launcher's argv template, the
 *     transport's argument fidelity, the guest's toolchain: each is asserted by the
 *     suite rather than trusted, and each failure mode ends in "not HARD".
 */

export interface SandboxedSubstrateOptions {
  readonly transport: ExecTransport;
  readonly launcher: SandboxLauncher;
  readonly clock: Clock;
  readonly engineVersion: string;
  /** The owner's checkout. Never writable, and its store is masked. */
  readonly projectRoot: string;
  /** Absolute host paths masked on every run: credentials and other runs' prompts. */
  readonly alwaysDenyRead?: readonly string[];
  /** Minimum engine version this qualification was written against. */
  readonly minEngineVersion?: string;
}

/** Binaries the guest must provide before anything can be proved about it. */
export const GUEST_REQUIRED_BINARIES: readonly { bin: string; why: string; remedy: string }[] =
  Object.freeze([
    {
      bin: 'node',
      why: 'The qualification programs and every Node recipe run inside the guest. A Node resolving under /mnt/ is the Windows binary reached through interop, which is not the same thing.',
      remedy: 'Install Node.js inside the distribution using its package manager.',
    },
    {
      bin: 'git',
      why: 'Serva computes every ChangeSet with git, inside the same environment the change was made in.',
      remedy: 'Install git inside the distribution.',
    },
    {
      bin: 'bwrap',
      why: 'bubblewrap is what enforces filesystem isolation; without it there is no boundary to measure.',
      remedy: 'sudo apt-get install bubblewrap',
    },
    {
      bin: 'socat',
      why: 'Relays traffic through the sandbox network proxy; the engine sandbox does not start without it.',
      remedy: 'sudo apt-get install socat',
    },
  ]);

/**
 * The seccomp filter package.
 *
 * Detected, never assumed. The previous implementation hard-coded this prerequisite as
 * unsatisfied, which made the substrate permanently unqualifiable and — worse — would
 * have kept reporting it as missing on a machine where it had been installed.
 */
export const SECCOMP_PACKAGE = '@anthropic-ai/sandbox-runtime';

interface CaseProgram {
  readonly id: string;
  /** JavaScript run inside the sandbox. Exit 0 means THE ATTEMPT SUCCEEDED. */
  readonly source: string;
  /** True when a HARD substrate should let the attempt succeed. Only Q-A. */
  readonly expectSuccess: boolean;
  readonly network?: boolean;
}

/** Paths the qualification fixture lays out, as the guest will see them. */
interface FixtureLayout {
  readonly root: string;
  readonly worktree: string;
  readonly checkout: string;
  readonly outside: string;
  readonly serva: string;
  readonly otherRun: string;
}

const q = (s: string): string => JSON.stringify(s);

/**
 * The adversarial programs.
 *
 * Written to files with their paths already interpolated, rather than passed as `node
 * -e` with arguments. `wsl.exe` re-parses a Windows command line, so every quoted
 * script and every argument containing a space is a fidelity risk on that boundary;
 * a file path is one token and a program that reads its own constants has none.
 */
function programs(f: FixtureLayout, kind: TransportKind): CaseProgram[] {
  const fsHead = 'const fs = require("fs");\n';
  return [
    {
      id: 'Q-A',
      expectSuccess: true,
      source: fsHead + 'fs.writeFileSync(' + q(f.worktree + '/qa.txt') + ', "ok");\n',
    },
    {
      id: 'Q-B',
      expectSuccess: false,
      source: fsHead + 'fs.writeFileSync(' + q(f.checkout + '/qb.txt') + ', "escaped");\n',
    },
    {
      id: 'Q-C',
      expectSuccess: false,
      source: fsHead + 'fs.writeFileSync(' + q(f.outside + '/qc.txt') + ', "escaped");\n',
    },
    {
      id: 'Q-D',
      expectSuccess: false,
      source:
        fsHead +
        'const d = fs.readFileSync(' +
        q(f.serva + '/secret.txt') +
        ', "utf8");\n' +
        'if (d.length === 0) process.exit(3);\n',
    },
    {
      id: 'Q-E',
      expectSuccess: false,
      source:
        fsHead +
        'const d = fs.readFileSync(' +
        q(f.otherRun + '/prompt.txt') +
        ', "utf8");\n' +
        'if (d.length === 0) process.exit(3);\n',
    },
    {
      id: 'Q-F',
      expectSuccess: false,
      source:
        'const { execFileSync } = require("child_process");\n' +
        '// A CHILD process, which tool-level rules cannot reach at all.\n' +
        'execFileSync(process.execPath, ["-e",\n' +
        '  "require(\'fs\').writeFileSync(" + ' +
        q(JSON.stringify(f.outside + '/qf.txt')) +
        ' + ", \'escaped\')"\n' +
        '], { stdio: "ignore" });\n',
    },
    {
      id: 'Q-G',
      expectSuccess: false,
      source:
        fsHead +
        'const link = ' +
        q(f.worktree + '/escape-link') +
        ';\n' +
        'try { fs.symlinkSync(' +
        q(f.outside) +
        ', link); } catch (e) { process.exit(4); }\n' +
        'fs.writeFileSync(link + "/qg.txt", "escaped");\n',
    },
    {
      id: 'Q-H',
      expectSuccess: false,
      source: fsHead + 'fs.writeFileSync(' + q(f.worktree + '/../qh.txt') + ', "escaped");\n',
    },
    {
      id: 'Q-I',
      expectSuccess: false,
      source:
        'const net = require("net");\n' +
        'const s = net.connect({ host: "1.1.1.1", port: 443 });\n' +
        's.setTimeout(4000);\n' +
        's.on("connect", () => { s.destroy(); process.exit(0); });\n' +
        's.on("timeout", () => { s.destroy(); process.exit(5); });\n' +
        's.on("error", () => process.exit(6));\n',
    },
    {
      id: 'Q-J',
      expectSuccess: false,
      source:
        kind === TransportKind.WSL2
          ? 'const { execFileSync } = require("child_process");\n' +
            'const candidates = ["/mnt/c/Windows/System32/cmd.exe", "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"];\n' +
            'for (const c of candidates) {\n' +
            '  try { execFileSync(c, ["/c", "ver"], { stdio: "ignore", timeout: 8000 }); process.exit(0); } catch (e) { /* keep trying */ }\n' +
            '}\n' +
            'process.exit(7);\n'
          : 'const fs = require("fs");\n' +
            '// No interop channel should exist on a native POSIX transport. Measured,\n' +
            '// not assumed: if one is present the case must fail like any other escape.\n' +
            'const channels = ["/proc/sys/fs/binfmt_misc/WSLInterop", "/mnt/c/Windows/System32/cmd.exe"];\n' +
            'if (channels.some((p) => fs.existsSync(p))) process.exit(0);\n' +
            'process.exit(8);\n',
    },
  ];
}

export class SandboxedExecutionSubstrate implements ExecutionSubstrate {
  readonly id: string;
  /** Every transport invocation, so Q-K can prove there was no unsandboxed retry. */
  private transportCalls = 0;

  constructor(private readonly opts: SandboxedSubstrateOptions) {
    this.id = 'sandboxed:' + opts.transport.id;
  }

  /* ------------------------------------------------------------------ probe */

  async probe(): Promise<SubstrateProbe> {
    const t = this.opts.transport;
    const observations: Record<string, string> = {
      hostPlatform: process.platform,
      hostArch: process.arch,
      transport: t.id,
      transportKind: t.kind,
      engineVersion: this.opts.engineVersion,
    };
    const prerequisites: Prerequisite[] = [];

    for (const [k, v] of Object.entries(await t.fingerprint())) {
      observations['transport:' + k] = v;
    }

    // Binaries. A path under /mnt/ is the Windows executable reached through interop,
    // and counting it would qualify the substrate on the strength of the very escape
    // route the qualification exists to close.
    for (const req of GUEST_REQUIRED_BINARIES) {
      const found = await this.which(req.bin);
      const usable = found !== undefined && !found.startsWith('/mnt/');
      observations['bin:' + req.bin] = found ?? 'MISSING';
      prerequisites.push({
        id: 'GUEST_' + req.bin.toUpperCase(),
        what: req.bin + ' inside the execution environment',
        why: req.why,
        remedy: req.remedy,
        satisfied: usable,
      });
    }

    const engineBin = await this.which('claude');
    observations['bin:claude'] = engineBin ?? 'MISSING';
    prerequisites.push({
      id: 'GUEST_ENGINE',
      what: 'Claude Code installed where the sandbox runs',
      why: 'The engine must run inside the boundary. An install on the other side of the transport cannot be contained by it.',
      remedy: 'Install Claude Code in the execution environment.',
      satisfied: engineBin !== undefined && !engineBin.startsWith('/mnt/'),
    });

    // The seccomp filter, DETECTED. Two ways, because a global npm install and a
    // packaged binary put it in different places.
    const seccomp = await this.detectSeccomp();
    observations['seccomp:detected'] = String(seccomp.present);
    observations['seccomp:detail'] = seccomp.detail;
    prerequisites.push({
      id: 'SECCOMP_FILTER',
      what: SECCOMP_PACKAGE + ' (the syscall filter)',
      why: 'On WSL2 a host binary is launched over a Unix socket rather than through the filesystem, so bubblewrap can be working perfectly while host escape is wide open. The filter is what closes the socket.',
      remedy: 'npm install -g ' + SECCOMP_PACKAGE + ' (inside the execution environment)',
      satisfied: seccomp.present,
    });

    const launcher = await this.opts.launcher.detect(t);
    observations['launcher'] = this.opts.launcher.id;
    observations['launcher:detail'] = launcher.detail;
    for (const [k, v] of Object.entries(launcher.observations)) observations[k] = v;
    prerequisites.push({
      id: 'SANDBOX_LAUNCHER',
      what: 'A working sandbox launcher (' + this.opts.launcher.id + ')',
      why: 'It is the mechanism that contains a process. Without it nothing above can be measured, let alone enforced.',
      remedy: 'Install the launcher in the execution environment.',
      satisfied: launcher.available,
    });

    // Unprivileged user namespaces: bubblewrap cannot create its namespaces without
    // them, and Ubuntu 24.04+ restricts them by AppArmor policy.
    const userns = await this.readGuestFile(
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns',
    );
    const usernsValue = userns?.trim() ?? 'unset';
    observations['kernel:apparmor_userns'] = usernsValue;
    prerequisites.push({
      id: 'USER_NAMESPACES',
      what: 'Unprivileged user namespaces available to the launcher',
      why: 'bubblewrap builds its boundary out of them; a policy that restricts them stops the sandbox starting at all.',
      remedy: 'Add an AppArmor profile granting bwrap userns capability, or set the sysctl to 0.',
      satisfied: usernsValue === 'unset' || usernsValue === '0',
    });

    if (this.opts.minEngineVersion !== undefined) {
      const ok = compareVersions(this.opts.engineVersion, this.opts.minEngineVersion) >= 0;
      prerequisites.push({
        id: 'ENGINE_VERSION',
        what: 'Claude Code >= ' + this.opts.minEngineVersion,
        why: 'Sandbox behaviour is version-dependent, and a qualification measured against one version does not carry to another.',
        remedy: 'Update Claude Code.',
        satisfied: ok,
      });
    }

    const interop = await this.readGuestFile('/proc/sys/fs/binfmt_misc/WSLInterop');
    observations['guest:interop'] = interop === undefined ? 'absent' : 'present';

    return {
      substrateId: this.id,
      hostPlatform: process.platform,
      hostArch: process.arch,
      ...(observations['transport:guestOs'] === undefined
        ? {}
        : { guestPlatform: observations['transport:guestOs'] }),
      isolationMethod:
        this.opts.launcher.id === 'bubblewrap' ? IsolationMethod.BUBBLEWRAP : IsolationMethod.NONE,
      engineVersion: this.opts.engineVersion,
      ...(launcher.version === undefined ? {} : { sandboxVersion: launcher.version }),
      prerequisites,
      observations,
      probedAt: this.opts.clock.now(),
    };
  }

  private async which(bin: string): Promise<string | undefined> {
    const r = await this.opts.transport.run({
      executable: 'which',
      args: [bin],
      cwd: '/',
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
      timeoutMs: 20_000,
      maxOutputBytes: 20_000,
    });
    if (r.spawnFailed || r.exitCode !== 0) return undefined;
    const first = r.stdout.replace(/\0/g, '').trim().split('\n')[0]?.trim();
    return first !== undefined && first.length > 0 ? first : undefined;
  }

  private async readGuestFile(path: string): Promise<string | undefined> {
    const r = await this.opts.transport.run({
      executable: 'cat',
      args: [path],
      cwd: '/',
      env: { PATH: '/usr/bin:/bin' },
      timeoutMs: 15_000,
      maxOutputBytes: 20_000,
    });
    if (r.spawnFailed || r.exitCode !== 0) return undefined;
    return r.stdout.replace(/\0/g, '');
  }

  /**
   * Is the syscall filter actually installed?
   *
   * Two independent probes because a global npm install and a distribution package put
   * it in different places, and reporting "absent" for a machine that has it would send
   * the owner to install something twice.
   */
  private async detectSeccomp(): Promise<{ present: boolean; detail: string }> {
    const bin = await this.which('srt');
    if (bin !== undefined && !bin.startsWith('/mnt/')) {
      return { present: true, detail: 'sandbox runtime binary at ' + bin };
    }
    const r = await this.opts.transport.run({
      executable: 'npm',
      args: ['ls', '-g', '--depth', '0', '--parseable', SECCOMP_PACKAGE],
      cwd: '/',
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root' },
      timeoutMs: 60_000,
      maxOutputBytes: 50_000,
    });
    const out = r.stdout.replace(/\0/g, '');
    if (!r.spawnFailed && r.exitCode === 0 && out.includes('sandbox-runtime')) {
      return { present: true, detail: 'npm reports the package installed globally' };
    }
    return {
      present: false,
      detail:
        'neither an `srt` binary nor a global npm install of ' +
        SECCOMP_PACKAGE +
        ' was found in the execution environment',
    };
  }

  /* -------------------------------------------------------------- execute */

  /**
   * Run one command inside the boundary.
   *
   * Refuses rather than falling back. There is no branch here that runs the command
   * unwrapped: if the launcher is unavailable the answer is a refusal, which is what
   * `failIfUnavailable` means when it is a property of the code rather than a setting.
   */
  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const startedAt = this.opts.clock.now();
    const began = Date.now();
    const refuse = (reason: string): ExecuteResult => ({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: { stdout: false, stderr: false },
      startedAt,
      endedAt: this.opts.clock.now(),
      durationMs: Date.now() - began,
      refusedBySubstrate: true,
      refusalReason: reason,
    });

    const detection = await this.opts.launcher.detect(this.opts.transport);
    if (!detection.available) {
      return refuse(
        'The sandbox launcher is not available, and Serva does not run a Producer command outside a boundary: ' +
          detection.detail,
      );
    }

    if (request.writeScope.length === 0) {
      return refuse(
        'No write scope was granted. A command with nothing to write is a configuration error, not a boundary.',
      );
    }

    const t = this.opts.transport;
    const guestCwd = t.toGuestPath(request.cwd);
    const spec: SandboxSpec = {
      allowWrite: request.writeScope.map((p) => t.toGuestPath(p)),
      allowRead: [
        ...(request.readScope ?? []).map((p) => t.toGuestPath(p)),
        ...request.writeScope.map((p) => t.toGuestPath(p)),
      ],
      denyRead: [
        ...(request.denyRead ?? []).map((p) => t.toGuestPath(p)),
        ...(this.opts.alwaysDenyRead ?? []).map((p) => t.toGuestPath(p)),
      ],
      networkAllowed: request.networkAllowed,
    };

    const command: TransportCommand = {
      executable: request.executable,
      args: [...request.args],
      cwd: guestCwd,
      env: { ...request.env },
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
    };

    this.transportCalls += 1;
    const r = await t.run(this.opts.launcher.wrap(command, spec));

    /*
     * A command that violated the boundary is NOT retried. There is deliberately no
     * code below this line: the result is returned exactly as observed, whatever it
     * was. Q-K asserts the absence by counting transport invocations, because a rule
     * that only exists in a comment is not a rule.
     */
    return {
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: r.timedOut,
      truncated: r.truncated,
      startedAt,
      endedAt: this.opts.clock.now(),
      durationMs: Date.now() - began,
      refusedBySubstrate: false,
    };
  }

  /* ------------------------------------------------------------- qualify */

  async qualify(fixtureDir: string): Promise<SubstrateQualification> {
    const probe = await this.probe();
    const at = this.opts.clock.now();
    const fingerprint = await this.fingerprint(probe);
    const missing = probe.prerequisites.filter((p) => !p.satisfied);

    if (missing.length > 0) {
      const reason =
        'PLATFORM_PREREQUISITE_REQUIRED: ' +
        missing.map((p) => p.id + ' (' + p.what + ')').join(', ');
      return {
        probe,
        capabilities: unenforced(),
        tests: QUALIFICATION_CASES.map((c) => ({
          id: c.id,
          title: c.title,
          expectation: c.expectation,
          outcome: 'NOT_RUN' as const,
          detail: 'Not attempted: ' + reason,
          blocking: c.blocking,
          at,
        })),
        enforcementClass: EnforcementClass.NONE,
        blockedBy: reason,
        qualifiedAt: at,
        engineVersion: this.opts.engineVersion,
        fingerprint,
      };
    }

    const layout = this.materialiseFixture(fixtureDir);
    const results = new Map<string, QualificationResult>();
    const record = (id: string, outcome: QualificationResult['outcome'], detail: string): void => {
      const c = QUALIFICATION_CASES.find((x) => x.id === id)!;
      results.set(id, {
        id,
        title: c.title,
        expectation: c.expectation,
        outcome,
        detail,
        blocking: c.blocking,
        at: this.opts.clock.now(),
      });
    };

    for (const program of programs(layout, this.opts.transport.kind)) {
      const scriptHost = join(fixtureDir, 'programs', program.id + '.js');
      writeFileSync(scriptHost, program.source, 'utf8');
      const scriptGuest = this.opts.transport.toGuestPath(scriptHost);

      const result = await this.execute({
        executable: 'node',
        args: [scriptGuest],
        cwd: layout.worktree,
        env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
        timeoutMs: 60_000,
        maxOutputBytes: 200_000,
        writeScope: [layout.worktree],
        // The fixture root must be readable or the program cannot be loaded; the
        // masked subtrees below are re-masked after the grant, so deny still wins.
        readScope: [layout.root],
        denyRead: [layout.serva, layout.otherRun],
        networkAllowed: program.network === true,
      });

      if (result.refusedBySubstrate) {
        // A refusal is not a proof of containment for the negative cases: nothing ran,
        // so nothing was demonstrated.
        record(program.id, 'NOT_RUN', 'Substrate refused to execute: ' + result.refusalReason);
        continue;
      }

      const attemptSucceeded = result.exitCode === 0 && !result.timedOut;
      const passed = program.expectSuccess ? attemptSucceeded : !attemptSucceeded;
      const observed =
        'exit ' +
        String(result.exitCode) +
        (result.timedOut ? ' (timed out)' : '') +
        (result.stderr.trim().length > 0 ? ': ' + result.stderr.trim().slice(0, 240) : '');
      record(
        program.id,
        passed ? 'PASSED' : 'FAILED',
        (program.expectSuccess
          ? passed
            ? 'The permitted write succeeded, so the boundary is not simply refusing everything. '
            : 'The permitted write was REFUSED, so this boundary would stop a Producer working. '
          : passed
            ? 'The attempt was refused, as required. '
            : 'THE ATTEMPT SUCCEEDED — the boundary did not hold. ') + observed,
      );
    }

    await this.qualifyNoUnsandboxedRetry(layout, record);

    const tests = QUALIFICATION_CASES.map(
      (c) =>
        results.get(c.id) ?? {
          id: c.id,
          title: c.title,
          expectation: c.expectation,
          outcome: 'NOT_RUN' as const,
          detail: 'No program is defined for this case, so nothing was proved.',
          blocking: c.blocking,
          at,
        },
    );

    const capabilities = capabilitiesFrom(tests);
    const derived = deriveEnforcementClass(tests, capabilities);
    return {
      probe,
      capabilities,
      tests,
      ...derived,
      qualifiedAt: at,
      engineVersion: this.opts.engineVersion,
      fingerprint,
    };
  }

  /**
   * Q-K — a violating command is not re-run without the sandbox.
   *
   * Measured on Serva's own code rather than on the guest's: run a command that the
   * boundary must refuse, and count how many times the transport was invoked. Exactly
   * one invocation means there was no second, unsandboxed attempt. A test that only
   * checked the exit code could not tell a single refusal from a refusal followed by a
   * successful retry.
   */
  private async qualifyNoUnsandboxedRetry(
    layout: FixtureLayout,
    record: (id: string, outcome: QualificationResult['outcome'], detail: string) => void,
  ): Promise<void> {
    const before = this.transportCalls;
    const result = await this.execute({
      executable: 'node',
      args: ['-e', 'require("fs").writeFileSync(' + q(layout.outside + '/qk.txt') + ', "x")'],
      cwd: layout.worktree,
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
      timeoutMs: 30_000,
      maxOutputBytes: 50_000,
      writeScope: [layout.worktree],
      readScope: [layout.root],
      denyRead: [layout.serva, layout.otherRun],
      networkAllowed: false,
    });
    const attempts = this.transportCalls - before;

    if (result.refusedBySubstrate) {
      record('Q-K', 'PASSED', 'The substrate refused outright and made no attempt to run it.');
      return;
    }
    if (result.exitCode === 0) {
      record(
        'Q-K',
        'FAILED',
        'The violating command SUCCEEDED, so there is no refusal for a fallback to be measured against.',
      );
      return;
    }
    record(
      'Q-K',
      attempts === 1 ? 'PASSED' : 'FAILED',
      attempts === 1
        ? 'The command was refused and the transport was invoked exactly once: no unsandboxed retry.'
        : 'The transport was invoked ' + String(attempts) + ' times for one command.',
    );
  }

  /** The disposable world the adversarial programs attack. */
  private materialiseFixture(fixtureDir: string): FixtureLayout {
    const t = this.opts.transport;
    const dirs = {
      programs: join(fixtureDir, 'programs'),
      worktree: join(fixtureDir, 'worktree'),
      checkout: join(fixtureDir, 'checkout'),
      outside: join(fixtureDir, 'outside'),
      serva: join(fixtureDir, 'serva'),
      otherRun: join(fixtureDir, 'other-run'),
    };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    writeFileSync(join(dirs.checkout, 'owner-work.txt'), 'uncommitted owner work\n', 'utf8');
    writeFileSync(join(dirs.serva, 'secret.txt'), 'audit trail and other runs\n', 'utf8');
    writeFileSync(join(dirs.otherRun, 'prompt.txt'), "another run's instructions\n", 'utf8');

    return {
      root: t.toGuestPath(fixtureDir),
      worktree: t.toGuestPath(dirs.worktree),
      checkout: t.toGuestPath(dirs.checkout),
      outside: t.toGuestPath(dirs.outside),
      serva: t.toGuestPath(dirs.serva),
      otherRun: t.toGuestPath(dirs.otherRun),
    };
  }

  async capabilities(): Promise<SubstrateCapabilities> {
    // Capability is a RESULT of qualification, so an un-qualified answer claims nothing.
    return unenforced();
  }

  /**
   * What this qualification is a measurement OF.
   *
   * Engine version, transport, guest kernel and distribution, launcher and its version.
   * Change any of them and the earlier measurement describes a machine that no longer
   * exists, which is why `qualificationIsStale` compares this rather than a timestamp.
   */
  async fingerprint(probe?: SubstrateProbe): Promise<string> {
    const p = probe ?? (await this.probe());
    return digestOf(
      canonicalJson({
        substrateId: this.id,
        engineVersion: this.opts.engineVersion,
        launcher: this.opts.launcher.id,
        sandboxVersion: p.sandboxVersion ?? 'none',
        transport: p.observations['transport'] ?? this.opts.transport.id,
        kernel: p.observations['transport:kernel'] ?? 'unknown',
        guestOs: p.observations['transport:guestOs'] ?? 'unknown',
        seccomp: p.observations['seccomp:detected'] ?? 'unknown',
      }),
    );
  }

  async explain(): Promise<string> {
    const probe = await this.probe();
    const lines = [
      'Execution substrate: ' + this.id,
      '  transport: ' + this.opts.transport.id + ' (' + this.opts.transport.kind + ')',
      '  launcher:  ' + this.opts.launcher.id,
      '  guest:     ' + (probe.guestPlatform ?? '(same machine)'),
      '  isolation: ' + probe.isolationMethod,
      '  engine:    ' + probe.engineVersion,
      '',
      'Prerequisites:',
    ];
    for (const p of probe.prerequisites) {
      lines.push('  [' + (p.satisfied ? ' ok ' : 'MISS') + '] ' + p.id + '  ' + p.what);
      if (!p.satisfied) {
        lines.push('         why:    ' + p.why);
        lines.push('         remedy: ' + p.remedy);
      }
    }
    lines.push(
      '',
      this.opts.launcher.explain(),
      '',
      'Qualification runs these through execute() — the same method a Producer command',
      'uses — against a disposable fixture:',
      ...QUALIFICATION_CASES.map((c) => '  ' + c.id + '  ' + c.title + ' — ' + c.expectation),
      '',
      'What it does NOT test: escapes nobody thought of. A qualification is a',
      'measurement on one machine at one moment, not a proof of containment.',
    );
    return lines.join('\n');
  }
}

function unenforced(): SubstrateCapabilities {
  return {
    filesystemEnforcement: EnforcementState.NOT_ENFORCED,
    processEnforcement: EnforcementState.NOT_ENFORCED,
    networkEnforcement: EnforcementState.NOT_ENFORCED,
    credentialProtection: EnforcementState.NOT_ENFORCED,
    hostEscapeProtection: EnforcementState.NOT_ENFORCED,
    canWrite: false,
    canExecute: false,
  };
}

/**
 * Capabilities derived from what the suite proved, dimension by dimension.
 *
 * They are separate because they FAIL separately: on WSL2 the filesystem isolation can
 * be perfect while host escape is wide open, because that escape does not go through
 * the filesystem at all.
 */
export function capabilitiesFrom(tests: readonly QualificationResult[]): SubstrateCapabilities {
  const passed = (id: string): boolean => tests.find((t) => t.id === id)?.outcome === 'PASSED';
  const state = (ids: readonly string[]): EnforcementState =>
    ids.every((id) => passed(id)) ? EnforcementState.ENFORCED : EnforcementState.NOT_ENFORCED;

  const filesystem = state(['Q-A', 'Q-B', 'Q-C', 'Q-G', 'Q-H']);
  const process_ = state(['Q-F']);
  const network = state(['Q-I']);
  const credential = state(['Q-D', 'Q-E']);
  const host = state(['Q-J', 'Q-K']);

  return {
    filesystemEnforcement: filesystem,
    processEnforcement: process_,
    networkEnforcement: network,
    credentialProtection: credential,
    hostEscapeProtection: host,
    canWrite: filesystem === EnforcementState.ENFORCED,
    canExecute: filesystem === EnforcementState.ENFORCED && process_ === EnforcementState.ENFORCED,
  };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
