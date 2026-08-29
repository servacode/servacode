import { GUEST_PATH, resolveGuestBinary } from './transport.js';
import type { ExecTransport, TransportCommand } from './transport.js';

/**
 * How a command is contained once the transport has decided where it runs.
 *
 * SPEC: Phase 4 closure blocker 1, ADR-003 §3.2.
 *
 * A launcher takes a command and returns a DIFFERENT command: the same program,
 * wrapped in whatever the platform uses to enforce a boundary. Nothing above this
 * interface knows the mechanism, and nothing below it knows what a ChangeSet is.
 *
 * ## Why the argv template is not a claim
 *
 * Every launcher encodes an assumption about a third-party CLI. That assumption is
 * never trusted here — it is ASSERTED BY QUALIFICATION. The adversarial suite runs
 * through `wrap()`, including the positive control Q-A, so:
 *
 *   - a template that over-restricts fails Q-A and the substrate does not qualify;
 *   - a template that under-restricts fails Q-B…Q-K and the substrate does not qualify;
 *   - a template that is simply wrong fails to launch and the substrate does not qualify.
 *
 * Every error in this file therefore fails in the same direction: refusal. There is no
 * arrangement of a broken template that produces a HARD substrate.
 */

export interface SandboxSpec {
  /** Guest paths the command may write. Everything else is read-only or masked. */
  readonly allowWrite: readonly string[];
  /** Guest paths that must remain readable. */
  readonly allowRead: readonly string[];
  /** Guest paths that must not be readable at all, masked rather than merely denied. */
  readonly denyRead: readonly string[];
  readonly networkAllowed: boolean;
}

export interface LauncherDetection {
  readonly available: boolean;
  readonly version?: string;
  /** What was actually observed. Never "should be present". */
  readonly detail: string;
  /** The exact step that would make it available. A refusal without one is a dead end. */
  readonly remedy?: string;
  /** Extra facts for the fingerprint: a launcher upgrade invalidates a qualification. */
  readonly observations: Readonly<Record<string, string>>;
}

export interface SandboxLauncher {
  readonly id: string;
  detect(transport: ExecTransport): Promise<LauncherDetection>;
  wrap(command: TransportCommand, spec: SandboxSpec): TransportCommand;
  /** Human account of what this mechanism does and does not enforce. */
  explain(): string;
}

/* ------------------------------------------------------------------ bubblewrap */

/**
 * Paths masked with an empty tmpfs on every run, whatever the caller asked for.
 *
 * `--tmpfs` over a path replaces it with an empty in-namespace filesystem, so the
 * content is not merely unreadable — it is not there. That matters for `/run/WSL`:
 * denying read on the socket directory would still leave the socket, and the socket is
 * the whole interop channel.
 */
export const ALWAYS_MASKED: readonly string[] = Object.freeze([
  // The WSL interop channel: the Unix socket over which a guest process asks Windows to
  // launch a binary. Masked rather than merely denied, because a denied directory still
  // contains a reachable socket.
  '/run/WSL',
  '/mnt/wsl',
]);

/*
 * Drive mounts are deliberately NOT masked here.
 *
 * `--ro-bind / /` already makes every one of them read-only, and on a Windows host the
 * worktree itself lives under `/mnt/<drive>`, so a blanket mask would destroy the one
 * grant a Producer needs. Containment is positive — enumerate what may be written —
 * rather than a blocklist of places somebody remembered.
 */

export interface BubblewrapOptions {
  /** Overridable for tests; the real binary is resolved on PATH inside the guest. */
  readonly binary?: string;
}

/**
 * Linux and WSL2 containment through bubblewrap.
 *
 * The shape of the argv, and why each piece is there:
 *
 *   --unshare-all            new namespaces for everything, INCLUDING the network. A
 *                            command with no network grant cannot reach one because
 *                            there is no interface, not because a rule refused it.
 *   --share-net              added back only on an explicit, justified grant.
 *   --die-with-parent        the contained process cannot outlive the run that owns it.
 *   --ro-bind / /            everything is readable and NOTHING is writable...
 *   --bind <p> <p>           ...except the paths that were granted, one at a time.
 *   --tmpfs <p>              masks a path entirely: credentials, the Serva store, and
 *                            the interop sockets.
 *   --proc /proc --dev /dev  a usable process needs both, and both are namespaced.
 *   --new-session            no controlling terminal, so no TIOCSTI keystroke injection.
 *
 * Order matters: bubblewrap applies operations left to right, so the read-only bind of
 * `/` comes first and every writable bind after it. Reversing them would silently make
 * the grant a no-op — which is exactly the sort of mistake Q-B and Q-C exist to catch.
 */
export class BubblewrapLauncher implements SandboxLauncher {
  readonly id = 'bubblewrap';
  private readonly binary: string;
  /**
   * The absolute path detection found, used in place of the bare name.
   *
   * A bare `bwrap` is resolved against whatever PATH the command happens to carry, and
   * a recipe's environment policy is free to scrub PATH down to something that cannot
   * find it. The launcher must not depend on the environment of the thing it contains.
   */
  private resolved: string | undefined;

  constructor(opts: BubblewrapOptions = {}) {
    this.binary = opts.binary ?? 'bwrap';
  }

  async detect(transport: ExecTransport): Promise<LauncherDetection> {
    const r = await transport.run({
      executable: this.binary,
      args: ['--version'],
      cwd: '/',
      env: { PATH: GUEST_PATH },
      timeoutMs: 20_000,
      maxOutputBytes: 20_000,
    });
    if (r.spawnFailed || r.exitCode !== 0) {
      return {
        available: false,
        detail:
          '`' +
          this.binary +
          ' --version` did not succeed in the guest: ' +
          (r.stderr.trim() || 'no output').slice(0, 200),
        remedy: 'sudo apt-get install bubblewrap (inside the execution environment)',
        observations: {},
      };
    }
    const version = r.stdout.replace(/\0/g, '').trim();
    this.resolved = (await resolveGuestBinary(transport, this.binary)).path;
    return {
      available: true,
      version,
      detail: 'bubblewrap responded: ' + version + ' at ' + (this.resolved ?? '(unresolved)'),
      observations: {
        'launcher:bubblewrap': version,
        ...(this.resolved === undefined ? {} : { 'launcher:bubblewrap:path': this.resolved }),
      },
    };
  }

  wrap(command: TransportCommand, spec: SandboxSpec): TransportCommand {
    const args: string[] = [
      '--unshare-all',
      ...(spec.networkAllowed ? ['--share-net'] : []),
      '--die-with-parent',
      '--new-session',
      '--ro-bind',
      '/',
      '/',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
    ];

    /*
     * Grants first, masks LAST. bubblewrap applies operations left to right, so the
     * final word wins — and the final word has to be the denial. Masking first and
     * granting after would let a read grant on a parent directory silently re-expose
     * the store or a credential directory underneath it.
     */
    for (const p of spec.allowRead) {
      args.push('--ro-bind-try', p, p);
    }
    for (const p of spec.allowWrite) {
      args.push('--bind-try', p, p);
    }
    for (const p of [...ALWAYS_MASKED, ...spec.denyRead]) {
      args.push('--tmpfs', p);
    }

    args.push('--chdir', command.cwd, '--', command.executable, ...command.args);

    return {
      // Absolute where detection could resolve it, so the launcher does not depend on
      // the PATH of the command it is containing.
      executable: this.resolved ?? this.binary,
      args,
      cwd: command.cwd,
      env: command.env,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: command.maxOutputBytes,
    };
  }

  explain(): string {
    return [
      'bubblewrap: unprivileged Linux namespaces.',
      '  ENFORCES  filesystem write scope (bind mounts), read masking (tmpfs),',
      '            network absence (--unshare-all), and process lifetime.',
      '  DOES NOT  enforce anything by syscall filtering. On WSL2 a host binary is',
      '            launched over a Unix socket rather than through the filesystem, so',
      '            masking /run/WSL is a mitigation and the seccomp filter is the real',
      '            answer. Q-J is what decides whether this machine is actually closed.',
    ].join('\n');
  }
}

/**
 * The safe default when no launcher is implemented for a platform.
 *
 * It reports unavailable and wraps nothing, so a substrate built on it refuses to
 * execute rather than running a Producer command unconstrained. macOS Seatbelt belongs
 * here when it is implemented; until then, saying so is the honest state.
 */
export class UnimplementedLauncher implements SandboxLauncher {
  readonly id: string;
  constructor(
    private readonly reason: string,
    id = 'none',
  ) {
    this.id = id;
  }

  async detect(): Promise<LauncherDetection> {
    return { available: false, detail: this.reason, observations: {} };
  }

  wrap(command: TransportCommand): TransportCommand {
    // Deliberately returns the command unchanged AND is never reachable: the substrate
    // refuses to execute when `detect()` reports unavailable. Returning the bare
    // command from a launcher that cannot contain it would be the single most dangerous
    // line in the system if that guard were ever removed, so it is asserted by test.
    return command;
  }

  explain(): string {
    return 'No sandbox launcher is implemented here: ' + this.reason;
  }
}
