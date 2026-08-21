import { fail } from '../core/errors.js';
import { GUEST_PATH } from './transport.js';
import type { ExecTransport, TransportCommand } from './transport.js';
import type { LauncherDetection, SandboxLauncher, SandboxSpec } from './sandboxLauncher.js';

/**
 * The boundary that actually governs a Producer.
 *
 * SPEC: Phase 4 execution-binding closure §5–§6.
 *
 * There were two different mechanisms in this system and only one of them was ever
 * measured:
 *
 *   A. Serva's own `WslTransport + BubblewrapLauncher`, which contains the
 *      DETERMINISTIC RECIPES — the build, test and lint commands Serva runs itself.
 *   B. Claude Code's sandbox, configured through a settings file, which contains a
 *      PRODUCER: its Bash tool calls and every process they spawn.
 *
 * Qualifying A and then dispatching a Producer proves nothing about B. They are
 * different code, different configuration and different failure modes; the only thing
 * they share is that both happen to use bubblewrap underneath. So this launcher exists
 * to measure B — the mechanism the Producer will actually be subject to — using the
 * exact settings profile that Producer will receive.
 *
 * It also settles two prerequisites that were previously counted for merely existing:
 *
 *   socat            the sandbox's network proxy needs it. If it is absent the sandbox
 *                    does not start, so Q-A fails and nothing qualifies. It participates.
 *   sandbox-runtime  it IS this launcher. Detection is not a checkbox any more; the
 *                    binary is what wraps every qualification case, and Q-J measures
 *                    whether the interop escape it is supposed to close is actually
 *                    closed. Presence has stopped standing in for enforcement.
 *
 * ## The CLI contract is read, not assumed
 *
 * Every launcher encodes an assumption about a third-party command line. Rather than
 * guess this one, `detect()` reads `--help` and looks for the flag it needs. If the
 * surface is not what this code expects, the launcher reports itself UNAVAILABLE with
 * the help text it actually saw, and the substrate refuses to execute. A wrong guess
 * therefore produces a refusal and a legible reason, never a Producer running loose.
 */

export const SANDBOX_RUNTIME_BIN = 'srt';

/** Flags that can point the sandbox runtime at a settings file, in order of preference. */
const SETTINGS_FLAGS: readonly string[] = Object.freeze(['--settings', '--config']);

export interface ClaudeSandboxOptions {
  /** Path, as the GUEST sees it, of the settings profile the Producer will receive. */
  readonly settingsPath: string;
  readonly binary?: string;
}

export class ClaudeSandboxLauncher implements SandboxLauncher {
  readonly id = 'claude-sandbox-runtime';
  private readonly binary: string;
  /** Discovered by `detect`, never assumed. `wrap` refuses without it. */
  private settingsFlag: string | undefined;
  private version: string | undefined;

  constructor(private readonly opts: ClaudeSandboxOptions) {
    this.binary = opts.binary ?? SANDBOX_RUNTIME_BIN;
  }

  async detect(transport: ExecTransport): Promise<LauncherDetection> {
    const env = { PATH: GUEST_PATH };
    const help = await transport.run({
      executable: this.binary,
      args: ['--help'],
      cwd: '/',
      env,
      timeoutMs: 30_000,
      maxOutputBytes: 200_000,
    });

    if (help.spawnFailed || (help.exitCode !== 0 && help.stdout.length === 0)) {
      return {
        available: false,
        detail:
          'The Claude sandbox runtime (`' +
          this.binary +
          '`) could not be run in the execution environment. Without it there is no Producer boundary to measure.',
        remedy: 'npm install -g @anthropic-ai/sandbox-runtime (inside the execution environment)',
        observations: {},
      };
    }

    const text = (help.stdout + '\n' + help.stderr).replace(/\0/g, '');
    const flag = SETTINGS_FLAGS.find((f) => text.includes(f));
    if (flag === undefined) {
      return {
        available: false,
        detail:
          'The sandbox runtime responded but exposes none of the settings flags Serva knows how to use (' +
          SETTINGS_FLAGS.join(', ') +
          '). Serva will not guess a command line for a boundary. Observed help: ' +
          text.trim().slice(0, 400),
        remedy:
          'Update @anthropic-ai/sandbox-runtime inside the execution environment, or report the observed command line so Serva can learn it.',
        observations: { 'launcher:help': text.trim().slice(0, 400) },
      };
    }
    this.settingsFlag = flag;

    const ver = await transport.run({
      executable: this.binary,
      args: ['--version'],
      cwd: '/',
      env,
      timeoutMs: 20_000,
      maxOutputBytes: 20_000,
    });
    this.version =
      ver.spawnFailed || ver.exitCode !== 0
        ? 'unknown'
        : ver.stdout.replace(/\0/g, '').trim() || 'unknown';

    return {
      available: true,
      version: this.version,
      detail: 'Claude sandbox runtime ' + this.version + ', settings flag ' + flag + '.',
      observations: {
        'launcher:sandbox-runtime': this.version,
        'launcher:settings-flag': flag,
      },
    };
  }

  /**
   * Wrap a command in the Producer's own boundary.
   *
   * `spec` is deliberately NOT translated into flags. The Producer's boundary is
   * defined by its settings profile — allowed writes, denied reads, network — and
   * expressing the same policy twice, in two notations, would let the measured boundary
   * and the dispatched one drift apart while both looked correct. The spec is used only
   * to assert that the caller is asking for the boundary this launcher was built for.
   */
  wrap(command: TransportCommand, spec: SandboxSpec): TransportCommand {
    if (this.settingsFlag === undefined) {
      return fail({
        code: 'E_CAPABILITY_NOT_ENABLED',
        message: 'The Claude sandbox runtime was not detected, so no command may be wrapped',
        remedy:
          "Detection reads the runtime's own command line. Serva does not fall back to an assumed one.",
        details: { binary: this.binary },
        specRef: 'Phase 4 §5',
      });
    }
    if (spec.networkAllowed) {
      /*
       * A blanket network grant for the whole sandbox is refused.
       *
       * The engine needs to reach the provider; that is not the same as every command
       * a Producer spawns being able to reach anything. Granting the second to obtain
       * the first is the exact trade this phase must not make, and the profile's own
       * network policy is where a narrower grant belongs.
       */
      return fail({
        code: 'E_CAPABILITY_NOT_ENABLED',
        message: 'A blanket network grant is not available on the Producer boundary',
        remedy:
          'The engine reaches the provider through its own channel. Producer subprocesses do not get unrestricted egress so that it can.',
        details: { mechanism: this.id },
        specRef: 'Phase 4 §5',
      });
    }

    return {
      executable: this.binary,
      args: [this.settingsFlag, this.opts.settingsPath, '--', command.executable, ...command.args],
      cwd: command.cwd,
      env: command.env,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: command.maxOutputBytes,
    };
  }

  explain(): string {
    return [
      'Claude sandbox runtime (' + this.binary + '): the boundary a Producer actually runs under.',
      '  ENFORCES  whatever the settings profile declares — write scope, read denials,',
      '            network policy — and, on WSL2, the syscall filter that closes the',
      '            Unix socket used to launch Windows binaries.',
      '  MEASURED  by running the adversarial cases through this same runtime with the',
      '            same profile the Producer will receive.',
      "  DOES NOT  govern the model's own tool calls. Those are constrained separately",
      '            by the tool availability and permission rules Serva computes, and',
      '            that layer is measured by the Phase 3 capability tests, not here.',
    ].join('\n');
  }
}
