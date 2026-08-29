import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

/**
 * DID THE COMMAND ACTUALLY RUN WHERE IT WAS SENT?
 *
 * SPEC: Phase 6 qualification transport invariant §1, §2.
 *
 * This is the distinction whose absence made engineering authority a coin flip. On this
 * machine, `wsl.exe` intermittently returns exit 4294967295 with no output: the host process
 * started, so `spawnFailed` is false, and the guest command never ran. Qualification read
 * that as a MEASURED result — `Q-A FAILED: the permitted write was REFUSED` — and concluded
 * the boundary was broken. Repeated runs of the same command on the same unchanged machine
 * alternated HARD, SOFT and NONE.
 *
 * A transport failure is not a measurement, and the only way to tell them apart is to make
 * the guest SAY it started. `REACHED` is never inferred from an exit code.
 */
export const GuestReach = {
  /** The guest demonstrably began executing the command. Its exit code means something. */
  REACHED: 'REACHED',
  /** It demonstrably did not. Nothing about the guest was measured. */
  NOT_REACHED: 'NOT_REACHED',
  /** No proof was requested. A caller must not treat this as either of the above. */
  UNKNOWN: 'UNKNOWN',
} as const;
export type GuestReach = (typeof GuestReach)[keyof typeof GuestReach];

/** One attempt at reaching the guest, kept whether it worked or not. */
export interface TransportAttempt {
  readonly attempt: number;
  readonly reach: GuestReach;
  readonly exitCode: number | null;
  readonly spawnFailed: boolean;
  readonly timedOut: boolean;
  /** Why this attempt is being retried, or why it is not. */
  readonly detail: string;
}

export interface TransportResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: { stdout: boolean; stderr: boolean };
  /** The process could not be started at all, as opposed to running and failing. */
  readonly spawnFailed: boolean;
  /**
   * Whether the GUEST began executing the command.
   *
   * Separate from `exitCode` on purpose: an exit code is only evidence about a command that
   * ran, and this is the field that says whether one did.
   */
  readonly reach: GuestReach;
  /**
   * Every attempt made, in order.
   *
   * Retries are kept rather than collapsed, because "succeeded on the third try" and
   * "succeeded immediately" describe different machines and an owner debugging an unstable
   * guest needs to see which one they have.
   */
  readonly attempts: readonly TransportAttempt[];
}

export interface ExecTransport {
  readonly id: string;
  readonly kind: TransportKind;
  /** A host path as the guest sees it. Identity for a local transport. */
  toGuestPath(hostPath: string): string;
  /**
   * A host environment as the execution environment should receive it.
   *
   * The counterpart of `toGuestPath`, and needed for the same reason. A recipe's
   * environment policy scrubs the HOST environment, so on Windows it yields
   * `PATH=C:\Users\…;C:\Program Files\Git\…` — which is not merely useless inside a
   * Linux guest, it silently broke the sandbox: `env -i PATH=<windows path> bwrap …`
   * could not resolve `bwrap`, and every recipe exited 127 with the failure attributed
   * to the test rather than to the environment.
   */
  environmentFor(hostEnv: Readonly<Record<string, string>>): Record<string, string>;
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
        /* Nothing was started, so nothing about the guest was observed. */
        reach: GuestReach.NOT_REACHED,
        attempts: [],
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
        /*
         * `runProcess` starts a HOST process and knows nothing about a guest. Callers that
         * need the distinction ask for it explicitly; a default of REACHED here would be the
         * original defect written down as a constant.
         */
        reach: GuestReach.UNKNOWN,
        attempts: [],
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

  /** Same machine: the host environment IS the execution environment. */
  environmentFor(hostEnv: Readonly<Record<string, string>>): Record<string, string> {
    return { ...hostEnv };
  }

  async run(command: TransportCommand): Promise<TransportResult> {
    const raw = await runProcess(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: command.maxOutputBytes,
    });
    /*
     * There is no guest here: the execution environment IS this machine, so a process that
     * started is a command that ran. No sentinel is needed and none is added — the marker
     * exists to cross a boundary, and inventing one to cross nothing would only make a local
     * result look like it had been proved by something it had not.
     */
    return {
      ...raw,
      reach: raw.spawnFailed ? GuestReach.NOT_REACHED : GuestReach.REACHED,
      attempts: [
        {
          attempt: 1,
          reach: raw.spawnFailed ? GuestReach.NOT_REACHED : GuestReach.REACHED,
          exitCode: raw.exitCode,
          spawnFailed: raw.spawnFailed,
          timedOut: raw.timedOut,
          detail: raw.spawnFailed
            ? 'the process could not be started on this machine'
            : 'ran on this machine',
        },
      ],
    };
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
  /*
   * IDEMPOTENT. A path that is already a guest path comes back unchanged.
   *
   * It was not, and the bug was invisible until the positive control caught it. On
   * Windows, `path.resolve('/mnt/c/x')` returns `C:\mnt\c\x` — Node treats a POSIX
   * absolute path as absolute on the current drive — so translating an already-guest
   * path produced `/mnt/c/mnt/c/x`. Qualification then failed with a directory that
   * does not exist, and the only reason it was not read as "the sandbox refused the
   * write" is that Q-A exists to distinguish those two.
   */
  if (hostPath.startsWith('/')) return hostPath;
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
 * `--exec` rather than `--`, and that is not a stylistic choice. With `--`, `wsl.exe`
 * hands the remainder of the command line to the guest's default shell, which re-parses
 * it: an argument containing `(`, `{` or a quote becomes syntax. Measured directly —
 * `wsl.exe -d D -- /bin/echo 'a(b)'` fails with a bash syntax error, and the same
 * command with `--exec` prints `a(b)`. `--exec` bypasses the shell and preserves argv.
 *
 * This was previously written up as an assumption that was "not load-bearing because
 * Q-A runs through the same path". Q-A does run through this path and did pass, because
 * its arguments happen to be shell-clean. The engine launcher, whose argv carries a JSON
 * schema, hit it immediately. An assumption that only holds for the inputs you happened
 * to test is not a mitigated risk.
 */
export class WslTransport implements ExecTransport {
  readonly kind = TransportKind.WSL2;
  readonly id: string;
  private started: Promise<void> | undefined;

  constructor(readonly distro: string) {
    this.id = 'wsl:' + distro;
  }

  /**
   * Start the distribution once, before anything is timed.
   *
   * A cold WSL2 distribution takes many seconds to boot, and the first probe was paying
   * that cost inside its own timeout — so `bwrap` reported MISSING on a machine whose
   * `bwrap` answered correctly a second later. A probe that reports absent because the
   * guest was still waking up is the same class of false negative as the `which` bug:
   * it blocks a healthy machine and gives the owner nothing to fix.
   *
   * The warmup runs `true`, which is the smallest thing that forces a boot.
   */
  private warm(): Promise<void> {
    this.started ??= runProcess('wsl.exe', ['-d', this.distro, '--exec', '/bin/true'], {
      timeoutMs: 120_000,
      maxOutputBytes: 4_000,
    }).then(() => undefined);
    return this.started;
  }

  toGuestPath(hostPath: string): string {
    // `toWslPath` is idempotent, so applying this twice is safe. It happens: the
    // qualification builds a guest-path layout and then hands those paths to
    // `execute`, which translates its own inputs.
    return isAbsolute(hostPath) || /^[A-Za-z]:/.test(hostPath) ? toWslPath(hostPath) : hostPath;
  }

  /**
   * Windows values do not cross into the guest.
   *
   * `PATH` is replaced with the guest's own: a Windows PATH inside Linux resolves
   * nothing, and that is not a cosmetic problem. A recipe's `MINIMAL` environment
   * policy scrubs the HOST environment, so the guest received
   * `PATH=C:\Users\...;C:\Program Files\Git\...`; `env -i PATH=<that> bwrap ...` could
   * not find `bwrap`, and every recipe exited 127 — reported as a failing test suite
   * rather than as a broken environment.
   *
   * Any other value that still looks like a Windows path is dropped rather than
   * translated. `HOME=C:\Users\adzor` would point a tool at a directory that does not
   * exist, and guessing its Linux equivalent would be inventing a fact about the guest.
   */
  environmentFor(hostEnv: Readonly<Record<string, string>>): Record<string, string> {
    const windowsShaped = (v: string): boolean => /^[A-Za-z]:[\\/]/.test(v) || v.includes('\\');
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(hostEnv)) {
      if (k === 'PATH') continue;
      if (windowsShaped(v)) continue;
      out[k] = v;
    }
    out['PATH'] = GUEST_PATH;
    return out;
  }

  /**
   * Run in the guest, and PROVE the guest ran it.
   *
   * SPEC: Phase 6 qualification transport invariant §2, §3.
   *
   * The guest emits a per-call nonce on stderr before it execs anything. Finding that nonce
   * is the only evidence accepted that the command started; its absence means the guest was
   * never reached, whatever exit code Windows reported. That distinction is the whole point:
   * `wsl.exe` on this machine intermittently exits 4294967295 with no output, and
   * qualification was reading that as a measured containment failure.
   *
   * The script is a FIXED string and every variable part travels as a separate argv entry.
   * `sh -c 'script' name a b c` binds `$1`, `$2`, `$3` without re-parsing them, so this keeps
   * the property `--exec` was chosen for — nothing an argument contains can become syntax.
   *
   * Retries cover ONLY unreached attempts. A command that reached the guest and failed is a
   * measurement, and retrying a measurement until it agrees with you is how a boundary check
   * becomes a formality.
   */
  async run(command: TransportCommand): Promise<TransportResult> {
    await this.warm();
    const envArgs: string[] = ['-i'];
    for (const [k, v] of Object.entries(command.env)) envArgs.push(k + '=' + v);

    const attempts: TransportAttempt[] = [];
    let last: TransportResult | undefined;

    for (let attempt = 1; attempt <= TRANSPORT_ATTEMPTS; attempt += 1) {
      const nonce = 'serva-reach-' + randomBytes(12).toString('hex');
      const raw = await runProcess(
        'wsl.exe',
        [
          '-d',
          this.distro,
          '--cd',
          command.cwd,
          '--exec',
          '/bin/sh',
          '-c',
          GUEST_REACH_SCRIPT,
          'serva',
          nonce,
          'env',
          ...envArgs,
          command.executable,
          ...command.args,
        ],
        { timeoutMs: command.timeoutMs, maxOutputBytes: command.maxOutputBytes },
      );

      const reached = raw.stderr.includes(nonce);
      /* The marker is Serva's, not the command's, so it never reaches a caller. */
      const stderr = raw.stderr
        .split(/\r?\n/)
        .filter((line) => line.trim() !== nonce)
        .join('\n');

      last = {
        ...raw,
        stderr,
        reach: reached ? GuestReach.REACHED : GuestReach.NOT_REACHED,
        attempts: [],
      };

      attempts.push({
        attempt,
        reach: last.reach,
        exitCode: raw.exitCode,
        spawnFailed: raw.spawnFailed,
        timedOut: raw.timedOut,
        detail: reached
          ? 'the guest started the command'
          : 'the guest never started the command' +
            (raw.spawnFailed ? '; wsl.exe could not be spawned' : '') +
            (raw.timedOut ? '; timed out' : '') +
            '; wsl.exe exit ' +
            String(raw.exitCode),
      });

      if (reached) break;

      /*
       * A deterministic, bounded back-off. Long enough for a distribution that is still
       * settling, short enough that an owner is not left watching a prompt — and fixed
       * rather than random so two runs of the same command take the same shape.
       */
      if (attempt < TRANSPORT_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, TRANSPORT_BACKOFF_MS[attempt - 1] ?? 1_000));
      }
    }

    return { ...(last as TransportResult), attempts };
  }

  /** One simple command per fact; see WSL_REQUIRED_BINARIES for why never a script. */
  async raw(args: readonly string[], timeoutMs = 30_000): Promise<TransportResult> {
    await this.warm();
    return runProcess('wsl.exe', ['-d', this.distro, '--exec', ...args], {
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

/** A program name safe to name in a resolver. Matches the recipe schema's rule. */
const SAFE_BINARY = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * How many times a transport failure is retried before Serva stops guessing.
 *
 * Three, and no configuration knob. A number an owner could raise would eventually be raised
 * until an unreachable guest looked reachable, and the honest answer after three failures is
 * NOT_MEASURED rather than a fourth attempt.
 */
export const TRANSPORT_ATTEMPTS = 3;

/** Fixed, so two runs of the same command take the same shape. */
export const TRANSPORT_BACKOFF_MS: readonly number[] = Object.freeze([250, 1_000]);

/**
 * The guest-side preamble.
 *
 * `$1` is the nonce and `$@` after the shift is the real command. Nothing is interpolated
 * into this string, ever: the moment a caller's value is concatenated here, the argument
 * safety that `--exec` was chosen for is gone.
 *
 * THE FORMAT STRING IS QUOTED, and that is not cosmetic. Written as `printf %s
`, the shell
 * strips the backslash before `printf` ever sees it, so the format becomes `%sn`: the nonce is
 * emitted with a literal `n` appended and NO newline. Every contained command's first line of
 * stderr then arrived glued to the marker —
 *
 *   serva-reach-3b7f88ff937c174abd5e06eenfile:///mnt/d/...
 *
 * — which corrupted the diagnostics of the very probes this transport exists to make
 * trustworthy. A live qualification run is what surfaced it.
 */
export const GUEST_REACH_SCRIPT = 'printf \'%s\\n\' "$1" >&2; shift; exec "$@"';

export const GUEST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * Where does `bin` actually live in the execution environment?
 *
 * `which` was the obvious answer and it silently failed: run under `env -i PATH=…`,
 * GNU `env` resolves the program name against its OWN environment, which `-i` has just
 * emptied — so `which` itself is not found and every binary reports MISSING. The live
 * report caught it as `GUEST_BWRAP: MISS` sitting next to a launcher that had just
 * printed `bubblewrap 0.11.1`, which is the kind of contradiction a probe should never
 * be able to produce.
 *
 * `sh -c 'command -v <bin>'` resolves inside the shell, after the environment is in
 * place. The name is interpolated into that one-line script, which is only safe
 * because it is a program name from Serva's own closed lists and is re-validated here
 * against the same pattern the recipe schema enforces. Anything else is refused rather
 * than quoted.
 */
/**
 * Where a binary lives in the guest, AND whether the guest answered at all.
 *
 * SPEC: Phase 6 qualification transport invariant; HIGH finding
 * QUALIFICATION-TRANSPORT-SEMANTICS/QTS-A.
 *
 * This used to be `string | undefined`, and that single `undefined` meant two incompatible
 * things: the guest replied that the binary is not installed, or the guest never replied. A
 * caller could not tell them apart, and `qualify()` read both as MISSING — recording
 * `attempt: MEASURED` for a machine it had not measured, and overwriting a preserved HARD
 * qualification with a NONE nothing supported.
 *
 * `reach` is not optional here, so absence can no longer be read without first reading whether
 * anything was reached.
 */
export interface GuestBinaryLookup {
  readonly reach: GuestReach;
  /** Set only when the guest was REACHED and reported a path. */
  readonly path?: string;
}

export async function resolveGuestBinary(
  transport: ExecTransport,
  bin: string,
): Promise<GuestBinaryLookup> {
  /* Never asked, so nothing about the guest is known either way. */
  if (!SAFE_BINARY.test(bin)) return { reach: GuestReach.UNKNOWN };

  const r = await transport.run({
    executable: '/bin/sh',
    args: ['-c', 'command -v ' + bin],
    cwd: '/',
    env: { PATH: GUEST_PATH },
    timeoutMs: 20_000,
    maxOutputBytes: 20_000,
  });

  /*
   * A process that never started measured nothing, whatever the transport says about reach.
   * Its own field is not taken at face value in the one case where it cannot be right.
   */
  if (r.spawnFailed) return { reach: GuestReach.NOT_REACHED };
  if (r.reach !== GuestReach.REACHED) return { reach: r.reach };

  /* The guest answered. A non-zero exit here IS the guest saying "not installed". */
  if (r.exitCode !== 0) return { reach: GuestReach.REACHED };

  const first = r.stdout.replace(/\0/g, '').trim().split('\n')[0]?.trim();
  return first !== undefined && first.length > 0
    ? { reach: GuestReach.REACHED, path: first }
    : { reach: GuestReach.REACHED };
}

export { runProcess as runHostProcess };
