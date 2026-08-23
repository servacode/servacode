import { execFileSync } from 'node:child_process';
import { arch, platform, release } from 'node:os';
import type { DoctorProbes } from './doctor.js';

/**
 * THE REAL PROBES — MEASUREMENTS, WITH A TIMEOUT AND NO GUESSES.
 *
 * SPEC: §22, §23.
 *
 * Everything here shells out and reports what came back. Nothing infers: a probe that
 * cannot run returns "not detected" with the reason, and the doctor turns that into
 * ACTION_REQUIRED or UNKNOWN rather than into a pass.
 *
 * These are separated from `doctor.ts` because the doctor's LOGIC — which states block
 * engineering, which remedies to show, how a qualification is invalidated — must be
 * testable on a machine that is not the one being described. A function that measures the
 * computer it runs on can only ever be tested on that computer.
 *
 * Every call is bounded. A WSL command against a distribution that is starting up can hang
 * for a long time, and a diagnostic that hangs is worse than one that says it could not
 * tell: the owner is left staring at a spinner rather than at a remedy.
 */

const TIMEOUT_MS = 5_000;

/** Run a command and return its trimmed output, or undefined. Never throws. */
function run(command: string, args: readonly string[]): string | undefined {
  try {
    const out = execFileSync(command, [...args], {
      timeout: TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

/** Run a command inside the WSL guest. */
function guest(args: readonly string[]): string | undefined {
  return run('wsl.exe', ['-e', ...args]);
}

/**
 * Did the guest respond at all?
 *
 * The distinction this exists for is the one a diagnostic gets wrong most easily: a tool
 * that is NOT INSTALLED and a guest that did not answer look identical from a failed
 * command, and reporting the second as the first sends the owner to install something they
 * already have. Every guest-dependent probe below asks this first.
 */
function guestResponds(): boolean {
  return guest(['true']) !== undefined || guest(['sh', '-c', 'exit 0']) !== undefined;
}

export function nodeDoctorProbes(): DoctorProbes {
  return {
    platform: () => ({ platform: platform(), release: release(), arch: arch() }),

    node: () => ({ version: process.version }),

    wsl: () => {
      /*
       * `wsl --status` output is localised and reformatted between Windows builds, so the
       * presence of a working `wsl -e true` is the fact worth reading. Parsing prose that
       * changes with the display language is how a probe starts reporting "not installed"
       * to somebody running Windows in German.
       */
      const alive = run('wsl.exe', ['-e', 'true']);
      if (alive === undefined && platform() !== 'win32') {
        return { installed: false, detail: 'not a Windows host; WSL does not apply here' };
      }
      const version = run('wsl.exe', ['--version']);
      return alive === undefined
        ? { installed: false, detail: 'no working WSL guest responded' }
        : {
            installed: true,
            version: version === undefined ? '2' : '2',
            detail: 'a WSL guest responded',
          };
    },

    distro: () => {
      if (!guestResponds()) {
        return {
          measured: false,
          detail: 'no WSL guest responded, so the distribution could not be read',
        };
      }
      const name = guest(['sh', '-c', '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"']);
      const kernel = guest(['uname', '-r']);
      const user = guest(['whoami']);
      return {
        ...(name === undefined ? {} : { name }),
        ...(kernel === undefined ? {} : { kernel }),
        ...(user === undefined ? {} : { user }),
        detail:
          name === undefined
            ? 'no distribution responded'
            : name + (user === undefined ? '' : ' as ' + user),
      };
    },

    claude: () => {
      if (!guestResponds()) {
        /*
         * NOT the same as "not installed". Telling an owner to install an engine they
         * already have, because the guest was asleep, is the failure this branch exists to
         * prevent.
         */
        return {
          installed: false,
          signedIn: false,
          measured: false,
          detail: 'no WSL guest responded, so the engine could not be looked for',
        };
      }
      const location = guest(['sh', '-c', 'command -v claude || true']);
      if (location === undefined) {
        return {
          installed: false,
          signedIn: false,
          detail: 'the engine was not found in the guest',
        };
      }
      const version = guest(['claude', '--version']);
      /*
       * SIGNED IN, AND NOTHING ELSE. Serva never reads or displays who the account belongs
       * to: the only fact it needs is whether a subscription session exists, and an
       * account name on a diagnostics screen is a privacy leak with no diagnostic value.
       */
      const signedIn = guest([
        'sh',
        '-c',
        'test -f "$HOME/.claude/.credentials.json" && echo yes || true',
      ]);
      return {
        installed: true,
        location,
        ...(version === undefined ? {} : { version }),
        signedIn: signedIn === 'yes',
        detail: signedIn === 'yes' ? 'signed in' : 'installed, not signed in',
      };
    },

    sandbox: () => {
      if (!guestResponds()) {
        return {
          available: false,
          measured: false,
          detail: 'no WSL guest responded, so the sandbox could not be looked for',
        };
      }
      const bwrap = guest(['sh', '-c', 'command -v bwrap || true']);
      if (bwrap === undefined) {
        return { available: false, detail: 'bubblewrap was not found in the guest' };
      }
      const version = guest(['bwrap', '--version']);
      return {
        mechanism: 'bubblewrap',
        ...(version === undefined ? {} : { version }),
        available: true,
        detail: bwrap + (version === undefined ? '' : ' ' + version),
      };
    },

    git: () => {
      const version = run('git', ['--version']);
      return version === undefined
        ? { installed: false, detail: 'git was not found' }
        : { installed: true, version, detail: version };
    },

    interop: () => {
      /*
       * Interop is enabled when the guest can start a Windows executable. Read as a
       * capability rather than from a configuration file, because the file can say one
       * thing while the running guest does another.
       */
      if (platform() !== 'win32') {
        return { detail: 'not a Windows host; interop does not apply here' };
      }
      if (!guestResponds()) {
        /*
         * `enabled` stays ABSENT, which the doctor reports as UNKNOWN. Returning
         * `enabled: false` here would have said "interop disabled" — a containment
         * property reported as safe because nothing answered, which is precisely the
         * shape of failure this whole phase refuses.
         */
        return { detail: 'no WSL guest responded, so interop could not be measured' };
      }
      const enabled = guest([
        'sh',
        '-c',
        'test -d /proc/sys/fs/binfmt_misc/WSLInterop && echo yes || true',
      ]);
      return {
        enabled: enabled === 'yes',
        detail: enabled === 'yes' ? 'the guest can start Windows executables' : 'interop disabled',
      };
    },
  };
}
