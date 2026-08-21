import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

/**
 * Where a command actually runs. SPEC: Phase 4 closure blocker 1, ADR-003.
 *
 * The substrate has two independent questions to answer, and conflating them is what
 * left the previous implementation unable to ever reach HARD:
 *
 *   1. **Where** does the process run? A Windows host has no sandbox at all, so the
 *      only answer that can carry engineering authority is "inside a Linux guest".
 *   2. **How** is it contained once it is there? That is the sandbox launcher, and it
 *      is a separate concern with a separate failure mode.
 *
 * `ExecTransport` is the first question. It is deliberately dumb: it runs an argv in an
 * environment and reports what happened. It contains nothing and claims to contain
 * nothing — a transport that also enforced would make it impossible to tell a transport
 * failure from a containment success, and "the command failed" would start meaning
 * "the boundary held".
 */

export const TransportKind = {
  /** This machine, running a POSIX kernel. */
  LOCAL_POSIX: 'LOCAL_POSIX',
  /** A named WSL2 distribution reached from a Windows host. */
  WSL2: 'WSL2',
} as const;
export type TransportKind = (typeof TransportKind)[keyof typeof TransportKind];

export interface TransportCommand {
  readonly executable: string;
  readonly args: readonly string[];
  /** A path as the GUEST sees it. Callers translate with `toGuestPath` first. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface TransportResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: { stdout: boolean; stderr: boolean };
  /** The process could not be started at all, as opposed to running and failing. */
  readonly spawnFailed: boolean;
}

export interface ExecTransport {
  readonly id: string;
  readonly kind: TransportKind;
  /** A host path as the guest sees it. Identity for a local transport. */
  toGuestPath(hostPath: string): string;
  run(command: TransportCommand): Promise<TransportResult>;
  /**
   * Stable facts about this transport, hashed into the qualification fingerprint.
   *
   * A qualification is a measurement of one machine in one configuration. When the
   * kernel, the distribution or the toolchain changes underneath it, the measurement
   * describes something that no longer exists.
   */
  fingerprint(): Promise<Record<string, string>>;
}

/* ------------------------------------------------------------------ raw spawn */

function runProcess(
  executable: string,
  args: readonly string[],
  o: {
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    timeoutMs: number;
    maxOutputBytes: number;
  },
): Promise<TransportResult> {
  return new Promise((resolveP) => {
    let stdout = '';
    let stderr = '';
    let outTrunc = false;
    let errTrunc = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(executable, [...args], {
      ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
      ...(o.env === undefined ? {} : { env: { ...o.env } }),
      // No shell, ever. There is nothing for an argument to escape into.
      shell: false,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, o.timeoutMs);

    const cap = (chunk: string, current: string, truncated: boolean): [string, boolean] => {
      if (truncated) return [current, true];
      const next = current + chunk;
      if (next.length > o.maxOutputBytes) return [next.slice(0, o.maxOutputBytes), true];
      return [next, false];
    };

    child.stdout?.on('data', (d: Buffer) => {
      [stdout, outTrunc] = cap(d.toString('utf8'), stdout, outTrunc);
    });
    child.stderr?.on('data', (d: Buffer) => {
      [stderr, errTrunc] = cap(d.toString('utf8'), stderr, errTrunc);
    });
    child.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({
        exitCode: null,
        stdout,
        stderr: stderr + '\n' + e.message,
        timedOut,
        truncated: { stdout: outTrunc, stderr: errTrunc },
        spawnFailed: true,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        truncated: { stdout: outTrunc, stderr: errTrunc },
        spawnFailed: false,
      });
    });
  });
}

/* ------------------------------------------------------------- local (POSIX) */

/** macOS or Linux: the engine and the sandbox live on the same machine. */
export class LocalPosixTransport implements ExecTransport {
  readonly id = 'local';
  readonly kind = TransportKind.LOCAL_POSIX;

  toGuestPath(hostPath: string): string {
    return resolve(hostPath);
  }

  async run(command: TransportCommand): Promise<TransportResult> {
    return runProcess(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: command.maxOutputBytes,
    });
  }

  async fingerprint(): Promise<Record<string, string>> {
    const uname = await runProcess('uname', ['-sr'], { timeoutMs: 10_000, maxOutputBytes: 4_000 });
    return {
      transport: this.id,
      kind: this.kind,
      kernel: uname.spawnFailed ? 'unknown' : uname.stdout.trim(),
      platform: process.platform,
      arch: process.arch,
    };
  }
}

/* ---------------------------------------------------------------------- WSL2 */

/** `C:\a\b` as WSL sees it. */
export function toWslPath(hostPath: string): string {
  const p = resolve(hostPath).replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\//.exec(p);
  if (drive === null) return p;
  return '/mnt/' + drive[1]!.toLowerCase() + p.slice(2);
}

export interface WslDistribution {
  readonly name: string;
  readonly version: number;
  readonly isDefault: boolean;
}

/**
 * The distributions `wsl.exe -l -v` reports.
 *
 * The output is UTF-16 with a decorative header and a `*` marking the default. Parsed
 * defensively: a name Serva cannot read is skipped rather than guessed at, because the
 * distribution name becomes an argument to every subsequent command.
 */
export function parseWslList(raw: string): WslDistribution[] {
  const out: WslDistribution[] = [];
  for (const line of raw.replace(/\0/g, '').split(/\r?\n/)) {
    const t = line.trim();
    if (t.length === 0) continue;
    const m = /^(\*?)\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s+\S+\s+(\d+)\s*$/.exec(t);
    if (m === null) continue;
    const name = m[2]!;
    if (name.toUpperCase() === 'NAME') continue;
    out.push({ name, version: Number.parseInt(m[3]!, 10), isDefault: m[1] === '*' });
  }
  return out;
}

/**
 * Choose the distribution deterministically.
 *
 * `SERVA_WSL_DISTRO` wins when set, so an owner with several distributions can name the
 * one Serva is allowed to use. Otherwise the default WSL2 distribution, and otherwise
 * the first WSL2 one by name — never "whichever came back first", because a
 * qualification measured against one distribution says nothing about another.
 */
export function selectWslDistribution(
  distributions: readonly WslDistribution[],
  env: NodeJS.ProcessEnv = process.env,
): WslDistribution | undefined {
  const requested = env['SERVA_WSL_DISTRO'];
  if (requested !== undefined && requested.length > 0) {
    return distributions.find((d) => d.name === requested);
  }
  const v2 = distributions.filter((d) => d.version === 2);
  return v2.find((d) => d.isDefault) ?? [...v2].sort((a, b) => (a.name < b.name ? -1 : 1))[0];
}

/**
 * A Windows host reaching into one named WSL2 distribution.
 *
 * The environment is applied with `env -i K=V … cmd` INSIDE the guest rather than
 * through `WSLENV`. Two reasons: `env -i` starts from an empty environment, which is
 * exactly the scrubbing policy the recipe already asked for; and it keeps every value
 * in its own argv element instead of a delimited variable the guest has to re-split.
 *
 * A caveat stated rather than hidden: `wsl.exe` receives a single Windows command line
 * and re-parses it, so argument fidelity across this boundary is an assumption. It is
 * not a load-bearing one — the qualification's positive control (Q-A) runs through this
 * exact path, so a transport that mangles arguments fails to qualify and the substrate
 * never reaches HARD. The failure direction is refusal, not false confidence.
 */
export class WslTransport implements ExecTransport {
  readonly kind = TransportKind.WSL2;
  readonly id: string;

  constructor(readonly distro: string) {
    this.id = 'wsl:' + distro;
  }

  toGuestPath(hostPath: string): string {
    return isAbsolute(hostPath) || /^[A-Za-z]:/.test(hostPath) ? toWslPath(hostPath) : hostPath;
  }

  async run(command: TransportCommand): Promise<TransportResult> {
    const envArgs: string[] = ['-i'];
    for (const [k, v] of Object.entries(command.env)) envArgs.push(k + '=' + v);

    return runProcess(
      'wsl.exe',
      [
        '-d',
        this.distro,
        '--cd',
        command.cwd,
        '--',
        'env',
        ...envArgs,
        command.executable,
        ...command.args,
      ],
      { timeoutMs: command.timeoutMs, maxOutputBytes: command.maxOutputBytes },
    );
  }

  /** One simple command per fact; see WSL_REQUIRED_BINARIES for why never a script. */
  async raw(args: readonly string[], timeoutMs = 15_000): Promise<TransportResult> {
    return runProcess('wsl.exe', ['-d', this.distro, '--', ...args], {
      timeoutMs,
      maxOutputBytes: 200_000,
    });
  }

  async fingerprint(): Promise<Record<string, string>> {
    const kernel = await this.raw(['uname', '-r']);
    const os = await this.raw(['cat', '/etc/os-release']);
    const pretty = /PRETTY_NAME="([^"]+)"/.exec(os.stdout.replace(/\0/g, ''));
    return {
      transport: this.id,
      kind: this.kind,
      distro: this.distro,
      kernel: kernel.spawnFailed ? 'unknown' : kernel.stdout.replace(/\0/g, '').trim(),
      guestOs: pretty?.[1] ?? 'unknown',
      arch: process.arch,
    };
  }
}

/** List the WSL distributions this host has, without changing anything. */
export async function listWslDistributions(): Promise<WslDistribution[]> {
  const r = await runProcess('wsl.exe', ['-l', '-v'], {
    timeoutMs: 20_000,
    maxOutputBytes: 100_000,
  });
  if (r.spawnFailed || r.exitCode !== 0) return [];
  return parseWslList(r.stdout);
}

export { runProcess as runHostProcess };
