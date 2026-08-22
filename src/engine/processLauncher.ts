import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * WHERE the engine process runs. SPEC: Phase 4 execution-binding closure §3.
 *
 * The Claude adapter used to call `spawn` directly, which quietly hard-coded "on this
 * machine". On Windows that is fatal for engineering: the sandbox does not exist on
 * native Windows, so a Producer spawned here has no boundary at all — however carefully
 * Serva qualified a WSL2 guest a moment earlier.
 *
 * This abstraction is deliberately thin and provider-agnostic. It answers one question —
 * where does a process start, and how do paths look once it has — and nothing else. The
 * adapter keeps every other responsibility: argv, stdio, streaming, termination.
 */

export interface ProcessSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface LaunchLocation {
  /** `local`, or `wsl:<distro>`. Becomes part of the execution boundary identity. */
  readonly transport: string;
  /** The guest's identity, when execution crosses into one. */
  readonly guest?: string;
}

export interface ProcessLauncher {
  readonly id: string;
  readonly location: LaunchLocation;
  /**
   * A host path as the execution environment sees it.
   *
   * Every path that crosses into an argument — the working directory, the system-prompt
   * file, the settings file — goes through this. A path that did not is a path the
   * process cannot open.
   */
  toExecutionPath(hostPath: string): string;
  spawn(bin: string, argv: readonly string[], o: ProcessSpawnOptions): ChildProcess;
}

/** The engine runs on this machine. The Phase 3 default, and correct for read-only runs. */
export class LocalProcessLauncher implements ProcessLauncher {
  readonly id = 'local';
  readonly location: LaunchLocation = { transport: 'local' };
  private readonly spawnFn: typeof spawn;

  constructor(spawnFn: typeof spawn = spawn) {
    this.spawnFn = spawnFn;
  }

  toExecutionPath(hostPath: string): string {
    return resolve(hostPath);
  }

  spawn(bin: string, argv: readonly string[], o: ProcessSpawnOptions): ChildProcess {
    return this.spawnFn(bin, [...argv], {
      cwd: o.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: o.env,
    });
  }
}

/** `C:\a\b` as WSL sees it. Duplicated from the substrate transport on purpose: this
 * module must not depend on the substrate layer, and the mapping is two lines. */
export function toWslPath(hostPath: string): string {
  // Idempotent: an already-translated guest path comes back unchanged. See the
  // substrate transport for what happened when it was not.
  if (hostPath.startsWith('/')) return hostPath;
  const p = resolve(hostPath).replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\//.exec(p);
  if (drive === null) return p;
  return '/mnt/' + drive[1]!.toLowerCase() + p.slice(2);
}

export interface WslLauncherOptions {
  readonly distro: string;
  /** Absolute path of the executable INSIDE the guest. Never a host path. */
  readonly guestBin?: string;
  readonly spawnFn?: typeof spawn;
}

/**
 * The engine runs inside one named WSL2 distribution.
 *
 * The environment is deliberately NOT forwarded from Windows. Two reasons, and the
 * second is the important one:
 *
 *   - the guest has its own login environment, and the engine needs it (PATH, HOME, and
 *     the credentials the owner authenticated there);
 *   - forwarding would carry Windows-side variables across, including
 *     `ANTHROPIC_API_KEY`. That would silently move the owner from their subscription
 *     onto a separately billed route (SC-POL-035) — a real cost, chosen by nobody.
 *
 * `WSLENV` is left unset for exactly that reason: WSL forwards nothing by default, and
 * that default is the safe one.
 *
 * `--exec` rather than `--`. With `--`, `wsl.exe` passes the remainder to the guest's
 * default shell, which re-parses it. The engine's argv carries a JSON schema full of
 * `{`, `(` and quotes, so every invocation died with `bash: syntax error near
 * unexpected token '('` before the engine ever started. `--exec` bypasses the shell.
 */
export class WslProcessLauncher implements ProcessLauncher {
  readonly id: string;
  readonly location: LaunchLocation;
  private readonly spawnFn: typeof spawn;

  constructor(private readonly opts: WslLauncherOptions) {
    this.id = 'wsl:' + opts.distro;
    this.location = { transport: 'wsl:' + opts.distro, guest: opts.distro };
    this.spawnFn = opts.spawnFn ?? spawn;
  }

  toExecutionPath(hostPath: string): string {
    return toWslPath(hostPath);
  }

  spawn(bin: string, argv: readonly string[], o: ProcessSpawnOptions): ChildProcess {
    const guestBin = this.opts.guestBin ?? bin;
    return this.spawnFn(
      'wsl.exe',
      ['-d', this.opts.distro, '--cd', this.toExecutionPath(o.cwd), '--exec', guestBin, ...argv],
      {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Only WSLENV is cleared; the guest supplies its own environment.
        env: { ...o.env, WSLENV: '' },
      },
    );
  }
}
