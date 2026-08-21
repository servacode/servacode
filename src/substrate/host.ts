import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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
import type { Clock } from '../core/clock.js';

/**
 * The real host substrate. SPEC: 33 §2–§3, ADR-003.
 *
 * Probes what this machine actually is and decides, from evidence, whether it can
 * carry engineering authority. It installs nothing, enables nothing, and reboots
 * nothing: a system whose safety rests on a sandbox has no business silently
 * reconfiguring the machine that sandbox runs on.
 *
 * The two facts that drive almost every outcome here:
 *
 *   - the Bash sandbox runs on macOS, Linux and WSL2, and **native Windows is not
 *     supported**, so a Windows host has no enforcement mechanism to qualify;
 *   - on WSL2, launching a Windows binary travels over a Unix socket rather than the
 *     filesystem, so bubblewrap can be working perfectly while host escape is open.
 *     Only the optional seccomp filter closes it.
 *
 * The second is why WSL2 is treated as a CANDIDATE and never as a synonym for HARD.
 */

export interface HostSubstrateOptions {
  readonly clock: Clock;
  readonly engineVersion: string;
  /** Injected for tests, so the probe can be exercised without a real machine. */
  readonly run?: CommandRunner;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CommandRunner {
  (
    bin: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<{ code: number | null; stdout: string; stderr: string; spawnFailed?: boolean }>;
}

const defaultRunner: CommandRunner = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    const child = spawn(bin, [...args], { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', () => {
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, spawnFailed: true });
    });
    child.on('close', (code) => {
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

/** Minimum engine version whose sandbox behaviour this qualification was written for. */
export const MIN_SANDBOX_ENGINE_VERSION = '2.1.216';

/**
 * Binaries the candidate substrate must provide, each probed by a SEPARATE simple
 * command.
 *
 * An inline shell script would be shorter and does not work: `wsl.exe` receives a
 * single Windows command line and re-parses it, so a `for` loop's variable arrives
 * empty and every binary reports MISSING. A probe that silently reports everything
 * absent is worse than no probe -- it would have blocked a machine that was fine, and
 * on a different day it could report a present-but-broken dependency as present.
 *
 * One `which` per binary has no metacharacters and nothing to re-parse.
 */
export const WSL_REQUIRED_BINARIES: readonly string[] = Object.freeze([
  'claude',
  'node',
  'socat',
  'bwrap',
  'git',
  'python3',
]);

export class HostExecutionSubstrate implements ExecutionSubstrate {
  readonly id = 'host';
  private readonly run: CommandRunner;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly opts: HostSubstrateOptions) {
    this.run = opts.run ?? defaultRunner;
    this.platform = opts.platform ?? process.platform;
  }

  async probe(): Promise<SubstrateProbe> {
    const observations: Record<string, string> = {
      hostPlatform: this.platform,
      hostArch: process.arch,
      engineVersion: this.opts.engineVersion,
    };
    const prerequisites: Prerequisite[] = [];

    const versionOk = compareVersions(this.opts.engineVersion, MIN_SANDBOX_ENGINE_VERSION) >= 0;
    prerequisites.push({
      id: 'ENGINE_VERSION',
      what: 'Claude Code >= ' + MIN_SANDBOX_ENGINE_VERSION,
      why: 'Sandbox behaviour is version-dependent, and a qualification measured against one version does not carry to another.',
      remedy: 'Update Claude Code.',
      satisfied: versionOk,
    });

    if (this.platform !== 'win32') {
      // macOS or Linux: the engine and the sandbox live on the same machine.
      const isolation =
        this.platform === 'darwin' ? IsolationMethod.SEATBELT : IsolationMethod.BUBBLEWRAP;
      if (this.platform === 'linux') {
        for (const [bin, why, remedy] of [
          [
            'bwrap',
            'bubblewrap is what enforces filesystem isolation; without it the sandbox does not start.',
            'Install the bubblewrap package.',
          ],
          [
            'socat',
            'socat relays traffic through the sandbox network proxy; without it the sandbox does not start.',
            'Install the socat package.',
          ],
        ] as const) {
          const found = await this.which(bin);
          observations['bin:' + bin] = found ?? 'MISSING';
          prerequisites.push({
            id: 'LINUX_' + bin.toUpperCase(),
            what: bin,
            why,
            remedy,
            satisfied: found !== undefined,
          });
        }
      }
      return {
        substrateId: this.id,
        hostPlatform: this.platform,
        hostArch: process.arch,
        isolationMethod: isolation,
        engineVersion: this.opts.engineVersion,
        prerequisites,
        observations,
        probedAt: this.opts.clock.now(),
      };
    }

    /*
     * Native Windows. There is no sandbox here, and no amount of configuration
     * produces one, so the only route to enforcement is a WSL2 distribution running
     * its own copy of the engine.
     */
    prerequisites.push({
      id: 'WIN_NO_NATIVE_SANDBOX',
      what: 'A sandbox-capable platform (macOS, Linux or WSL2)',
      why: 'The Bash sandbox is not supported on native Windows, so there is no enforcement mechanism on this host to qualify.',
      remedy: 'Run the engineering engine inside a WSL2 distribution.',
      satisfied: false,
    });

    const wsl = await this.probeWsl(observations);
    for (const p of wsl) prerequisites.push(p);

    return {
      substrateId: this.id,
      hostPlatform: 'win32',
      hostArch: process.arch,
      ...(observations['wsl:distro'] === undefined
        ? {}
        : { guestPlatform: observations['wsl:distro'] }),
      isolationMethod: IsolationMethod.NONE,
      engineVersion: this.opts.engineVersion,
      prerequisites,
      observations,
      probedAt: this.opts.clock.now(),
    };
  }

  /** Read-only inspection of the WSL2 candidate. Nothing is installed or enabled. */
  private async probeWsl(observations: Record<string, string>): Promise<Prerequisite[]> {
    const out: Prerequisite[] = [];
    const listed = await this.run('wsl.exe', ['-l', '-v'], 15_000);
    const wslText = stripNulls(listed.stdout);
    const wslPresent = listed.spawnFailed !== true && listed.code === 0;
    observations['wsl:present'] = String(wslPresent);
    if (wslPresent) observations['wsl:distributions'] = wslText.trim().slice(0, 500);

    out.push({
      id: 'WSL_PRESENT',
      what: 'A WSL2 distribution',
      why: 'It is the only place on a Windows host where the sandbox can run at all.',
      remedy: 'Install WSL2 and a Linux distribution. Serva will not install it for you.',
      satisfied: wslPresent,
    });
    if (!wslPresent) return out;

    const isV2 = /\s2(\s|$)/m.test(wslText);
    out.push({
      id: 'WSL_VERSION_2',
      what: 'WSL version 2',
      why: 'WSL1 does not provide the kernel features the sandbox requires.',
      remedy: 'Convert the distribution with `wsl --set-version <distro> 2`.',
      satisfied: isV2,
    });

    // One simple command per fact. See WSL_REQUIRED_BINARIES for why.
    const kernel = await this.run('wsl.exe', ['--', 'uname', '-r'], 15_000);
    observations['wsl:kernel'] = stripNulls(kernel.stdout).trim();

    const found = new Map<string, string>();
    for (const bin of WSL_REQUIRED_BINARIES) {
      const r = await this.run('wsl.exe', ['--', 'which', bin], 15_000);
      const path = stripNulls(r.stdout).trim().split('\n')[0] ?? '';
      const ok = r.spawnFailed !== true && r.code === 0 && path.length > 0;
      observations['wsl:bin:' + bin] = ok ? path : 'MISSING';
      if (ok) found.set(bin, path);
    }

    /*
     * A binary resolving under /mnt/ is the WINDOWS executable reached through interop,
     * not a Linux one. Counting it would qualify a substrate on the strength of the
     * very escape route the qualification exists to close.
     */
    const has = (bin: string): boolean => {
      const path = found.get(bin);
      return path !== undefined && !path.startsWith('/mnt/');
    };

    out.push({
      id: 'WSL_CLAUDE',
      what: 'Claude Code installed inside the WSL2 distribution',
      why: 'The engine must run where the sandbox runs. A Windows-side install cannot be sandboxed.',
      remedy: 'Install Claude Code inside the distribution.',
      satisfied: has('claude'),
    });
    out.push({
      id: 'WSL_NODE',
      what: 'Node.js inside the WSL2 distribution',
      why: 'Required by the engine and by the seccomp filter package. A Node resolving under /mnt/ is the Windows binary reached through interop, which is not the same thing.',
      remedy: 'Install Node.js inside the distribution using its package manager.',
      satisfied: has('node'),
    });
    out.push({
      id: 'WSL_BUBBLEWRAP',
      what: 'bubblewrap',
      why: 'Enforces filesystem isolation; without it the sandbox does not start.',
      remedy: 'sudo apt-get install bubblewrap',
      satisfied: has('bwrap'),
    });
    out.push({
      id: 'WSL_SOCAT',
      what: 'socat',
      why: 'Relays traffic through the sandbox network proxy; without it the sandbox does not start.',
      remedy: 'sudo apt-get install socat',
      satisfied: has('socat'),
    });

    const interop = await this.run(
      'wsl.exe',
      ['--', 'test', '-e', '/proc/sys/fs/binfmt_misc/WSLInterop'],
      15_000,
    );
    const interopPresent = interop.spawnFailed !== true && interop.code === 0;
    observations['wsl:interop'] = interopPresent ? 'present' : 'absent';
    observations['wsl:interop_risk'] = interopPresent
      ? 'Windows binaries are launchable from the guest; only the seccomp filter blocks the Unix socket that carries the launch'
      : 'interop not detected';

    /*
     * The prerequisite that decides HARD on this platform.
     *
     * WSL hands a launch of cmd.exe, powershell.exe or anything under /mnt/c to the
     * Windows host over a Unix socket. That path does not go through the filesystem, so
     * bubblewrap does not touch it, and the optional seccomp filter is what blocks the
     * socket. Without it a "sandboxed" command can run arbitrary code on the Windows
     * host while the filesystem isolation works perfectly.
     *
     * Presence cannot be established without Node inside the distribution, and UNKNOWN
     * counts against a substrate exactly as a failure does.
     */
    out.push({
      id: 'WSL_SECCOMP_FILTER',
      what: '@anthropic-ai/sandbox-runtime (the optional seccomp filter)',
      why: 'It is the only thing that blocks the Unix socket WSL uses to launch Windows host binaries. Without it a sandboxed command can escape to the host even with bubblewrap working perfectly.',
      remedy: 'npm install -g @anthropic-ai/sandbox-runtime (inside the distribution)',
      satisfied: false,
    });

    const apparmor = await this.run(
      'wsl.exe',
      ['--', 'cat', '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'],
      15_000,
    );
    const apparmorValue =
      apparmor.spawnFailed === true || apparmor.code !== 0
        ? 'unset'
        : stripNulls(apparmor.stdout).trim();
    observations['wsl:apparmor_userns'] = apparmorValue;
    out.push({
      id: 'WSL_USERNS',
      what: 'Unprivileged user namespaces available to bubblewrap',
      why: 'Ubuntu 24.04 and later can restrict them by AppArmor policy, which stops bubblewrap creating the namespaces it needs.',
      remedy: 'Add an AppArmor profile granting bwrap userns capability.',
      satisfied: apparmorValue === 'unset' || apparmorValue === '0',
    });

    const osRelease = await this.run('wsl.exe', ['--', 'cat', '/etc/os-release'], 15_000);
    const pretty = /PRETTY_NAME="([^"]+)"/.exec(stripNulls(osRelease.stdout));
    if (pretty !== null) observations['wsl:distro'] = pretty[1]!;

    return out;
  }

  private async which(bin: string): Promise<string | undefined> {
    const r = await this.run(this.platform === 'win32' ? 'where' : 'which', [bin], 10_000);
    if (r.spawnFailed === true || r.code !== 0) return undefined;
    const first = r.stdout.split('\n')[0]?.trim();
    return first !== undefined && first.length > 0 ? first : undefined;
  }

  async capabilities(): Promise<SubstrateCapabilities> {
    const probe = await this.probe();
    const ready = probe.prerequisites.every((p) => p.satisfied);
    const state = ready ? EnforcementState.ENFORCED : EnforcementState.NOT_ENFORCED;
    return {
      filesystemEnforcement: state,
      processEnforcement: state,
      networkEnforcement: state,
      credentialProtection: state,
      hostEscapeProtection: state,
      canWrite: ready,
      canExecute: ready,
    };
  }

  /**
   * Run the adversarial suite.
   *
   * When a prerequisite is missing the tests are recorded as NOT_RUN with the reason,
   * never as PASSED and never quietly omitted. A missing test counts against the
   * substrate exactly as a failed one does: "we could not check whether it escapes" and
   * "it escapes" are the same fact for this decision.
   */
  async qualify(fixtureDir: string): Promise<SubstrateQualification> {
    const probe = await this.probe();
    const at = this.opts.clock.now();
    const missing = probe.prerequisites.filter((p) => !p.satisfied);

    if (missing.length > 0) {
      const reason =
        'PLATFORM_PREREQUISITE_REQUIRED: ' +
        missing.map((p) => p.id + ' (' + p.what + ')').join(', ');
      const tests: QualificationResult[] = QUALIFICATION_CASES.map((c) => ({
        id: c.id,
        title: c.title,
        expectation: c.expectation,
        outcome: 'NOT_RUN' as const,
        detail: 'Not attempted: ' + reason,
        blocking: c.blocking,
        at,
      }));
      const capabilities: SubstrateCapabilities = {
        filesystemEnforcement: EnforcementState.NOT_ENFORCED,
        processEnforcement: EnforcementState.NOT_ENFORCED,
        networkEnforcement: EnforcementState.NOT_ENFORCED,
        credentialProtection: EnforcementState.NOT_ENFORCED,
        hostEscapeProtection: EnforcementState.NOT_ENFORCED,
        canWrite: false,
        canExecute: false,
      };
      return {
        probe,
        capabilities,
        tests,
        enforcementClass: EnforcementClass.NONE,
        blockedBy: reason,
        qualifiedAt: at,
        engineVersion: this.opts.engineVersion,
      };
    }

    // Prerequisites are satisfied, so the adversarial suite can actually run. The
    // executor for it is substrate-specific and is supplied by a qualified adapter;
    // reaching here on an unqualified host is a programming error, not a state.
    void fixtureDir;
    const capabilities = await this.capabilities();
    const tests: QualificationResult[] = QUALIFICATION_CASES.map((c) => ({
      id: c.id,
      title: c.title,
      expectation: c.expectation,
      outcome: 'NOT_RUN' as const,
      detail:
        'Prerequisites are satisfied but no qualified sandbox executor is wired for this platform, so nothing was proved.',
      blocking: c.blocking,
      at,
    }));
    const derived = deriveEnforcementClass(tests, capabilities);
    return {
      probe,
      capabilities,
      tests,
      ...derived,
      qualifiedAt: at,
      engineVersion: this.opts.engineVersion,
    };
  }

  async execute(request: ExecuteRequest): Promise<ExecuteResult> {
    const startedAt = this.opts.clock.now();
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: { stdout: false, stderr: false },
      startedAt,
      endedAt: this.opts.clock.now(),
      durationMs: 0,
      refusedBySubstrate: true,
      refusalReason:
        'This host is not qualified for engineering execution. ' +
        'Serva does not run a Producer command outside a boundary it has measured. Command: ' +
        request.executable,
    };
  }

  async explain(): Promise<string> {
    const probe = await this.probe();
    const lines = [
      'Execution substrate: ' + probe.substrateId,
      '  host:      ' + probe.hostPlatform + '/' + probe.hostArch,
      '  guest:     ' + (probe.guestPlatform ?? '(none)'),
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
      'What a qualification would test:',
      ...QUALIFICATION_CASES.map((c) => '  ' + c.id + '  ' + c.title + ' — ' + c.expectation),
      '',
      'What it does NOT test: escapes nobody thought of. A qualification is a',
      'measurement on one machine at one moment, not a proof of containment.',
    );
    if (existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) {
      lines.push('', 'Note: WSL interoperability is present on this machine.');
    }
    return lines.join('\n');
  }
}

function stripNulls(s: string): string {
  // `wsl.exe` emits UTF-16-ish output on Windows; the NULs are noise, not data.
  return s.replace(/\0/g, '');
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
