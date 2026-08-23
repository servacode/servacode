import { execFileSync } from 'node:child_process';
import { arch, platform, release } from 'node:os';
import type { DoctorProbes } from './doctor.js';

/**
 * THE REAL PROBES — MEASUREMENTS, WITH A TIMEOUT AND NO GUESSES.
 *
 * SPEC: §22, §23.
 *
 * Everything here shells out and reports what came back. Nothing infers: a probe that
 * cannot run reports that it could not run, and the doctor turns that into UNKNOWN rather
 * than into a pass or into a missing prerequisite.
 *
 * These are separated from `doctor.ts` because the doctor's LOGIC — which states block
 * engineering, which remedies to show, how a qualification is invalidated — must be
 * testable on a machine that is not the one being described. A function that measures the
 * computer it runs on can only ever be tested on that computer.
 *
 * TWO MISTAKES THIS FILE HAS ALREADY MADE, both caught by running it against a real
 * machine rather than by reading it:
 *
 *   It treated "succeeded and printed nothing" as failure. `wsl -e true` is exactly that,
 *   so a healthy WSL installation was reported as absent and the owner was told to install
 *   something they already had. Whether a command RAN is now separate from what it SAID.
 *
 *   It asked the guest eight separate questions, each spawning a new `wsl.exe`. Under a
 *   cold guest that is eight chances to exceed the timeout, and the report came back a
 *   patchwork of READY and UNKNOWN describing one machine. The guest is now asked ONCE.
 */

const TIMEOUT_MS = 20_000;

interface Ran {
  /** The command started, ran and exited zero. */
  readonly ok: boolean;
  /** Its trimmed output, which may legitimately be empty. */
  readonly out: string;
}

/**
 * Run a command, and report whether it RAN separately from what it SAID.
 *
 * Never throws. A missing executable, a timeout and a non-zero exit are all `ok: false`,
 * because from a diagnostic's point of view they mean the same thing: this could not be
 * measured here.
 */
function run(command: string, args: readonly string[]): Ran {
  try {
    const out = execFileSync(command, [...args], {
      timeout: TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, out: out.trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

/** Output when the command ran and said something; undefined otherwise. */
function said(command: string, args: readonly string[]): string | undefined {
  const result = run(command, args);
  return result.ok && result.out !== '' ? result.out : undefined;
}

/**
 * Everything the guest can tell us, in one crossing.
 *
 * A single script emitting `key=value` lines. One process, one timeout, one answer — and
 * every field describes the same moment, which a sequence of eight invocations cannot
 * promise.
 *
 * `|| true` after each lookup keeps a missing tool from ending the script: an absent
 * `bwrap` is a FINDING, not a reason to stop measuring everything after it.
 */
const GUEST_SCRIPT = [
  'echo "responded=yes"',
  '. /etc/os-release 2>/dev/null && echo "distro=$PRETTY_NAME"',
  'echo "kernel=$(uname -r)"',
  'echo "user=$(whoami)"',
  'echo "claude=$(command -v claude || true)"',
  'echo "claudeVersion=$(claude --version 2>/dev/null || true)"',
  'test -f "$HOME/.claude/.credentials.json" && echo "signedIn=yes" || echo "signedIn=no"',
  'echo "bwrap=$(command -v bwrap || true)"',
  'echo "bwrapVersion=$(bwrap --version 2>/dev/null || true)"',
  'test -d /proc/sys/fs/binfmt_misc/WSLInterop && echo "interop=yes" || echo "interop=no"',
].join('; ');

interface GuestFacts {
  readonly responded: boolean;
  readonly values: ReadonlyMap<string, string>;
}

function readGuest(): GuestFacts {
  const result = run('wsl.exe', ['-e', 'sh', '-c', GUEST_SCRIPT]);
  if (!result.ok) return { responded: false, values: new Map() };
  const values = new Map<string, string>();
  for (const line of result.out.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const value = line.slice(at + 1).trim();
    if (value !== '') values.set(line.slice(0, at).trim(), value);
  }
  /* `responded` came from the guest itself, so it cannot be true unless the script ran. */
  return { responded: values.get('responded') === 'yes', values };
}

export function nodeDoctorProbes(): DoctorProbes {
  /*
   * Measured once, when the probe set is built. Every probe below reads from the same
   * crossing, so the report describes one machine at one moment rather than eight.
   */
  const guest = readGuest();
  const get = (key: string): string | undefined => guest.values.get(key);

  return {
    platform: () => ({ platform: platform(), release: release(), arch: arch() }),

    node: () => ({ version: process.version }),

    wsl: () => {
      if (!guest.responded && platform() !== 'win32') {
        return { installed: false, detail: 'not a Windows host; WSL does not apply here' };
      }
      return guest.responded
        ? { installed: true, version: '2', detail: 'a WSL guest responded' }
        : { installed: false, detail: 'no working WSL guest responded' };
    },

    distro: () => {
      if (!guest.responded) {
        return {
          measured: false,
          detail: 'no WSL guest responded, so the distribution could not be read',
        };
      }
      const name = get('distro');
      const kernel = get('kernel');
      const user = get('user');
      return {
        ...(name === undefined ? {} : { name }),
        ...(kernel === undefined ? {} : { kernel }),
        ...(user === undefined ? {} : { user }),
        detail:
          name === undefined
            ? 'the guest responded and did not identify itself'
            : name + (user === undefined ? '' : ' as ' + user),
      };
    },

    claude: () => {
      if (!guest.responded) {
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
      const location = get('claude');
      if (location === undefined) {
        return {
          installed: false,
          signedIn: false,
          detail: 'Claude Code was not found in the guest',
        };
      }
      const version = get('claudeVersion');
      /*
       * SIGNED IN, AND NOTHING ELSE. Serva never reads or displays who the account belongs
       * to: the only fact it needs is whether a subscription session exists, and an
       * account name on a diagnostics screen is a privacy leak with no diagnostic value.
       */
      const signedIn = get('signedIn') === 'yes';
      return {
        installed: true,
        location,
        ...(version === undefined ? {} : { version }),
        signedIn,
        detail: signedIn ? 'signed in' : 'installed, not signed in',
      };
    },

    sandbox: () => {
      if (!guest.responded) {
        return {
          available: false,
          measured: false,
          detail: 'no WSL guest responded, so the sandbox could not be looked for',
        };
      }
      const bwrap = get('bwrap');
      if (bwrap === undefined) {
        return { available: false, detail: 'bubblewrap was not found in the guest' };
      }
      const version = get('bwrapVersion');
      return {
        mechanism: 'bubblewrap',
        ...(version === undefined ? {} : { version }),
        available: true,
        detail: bwrap + (version === undefined ? '' : ' ' + version),
      };
    },

    git: () => {
      const version = said('git', ['--version']);
      return version === undefined
        ? { installed: false, detail: 'git was not found' }
        : { installed: true, version, detail: version };
    },

    interop: () => {
      if (platform() !== 'win32') {
        return { detail: 'not a Windows host; interop does not apply here' };
      }
      if (!guest.responded) {
        /*
         * `enabled` stays ABSENT, which the doctor reports as UNKNOWN. Returning
         * `enabled: false` here would have said "interop disabled" — a containment
         * property reported as safe because nothing answered, which is precisely the shape
         * of failure this whole phase refuses.
         */
        return { detail: 'no WSL guest responded, so interop could not be measured' };
      }
      const enabled = get('interop') === 'yes';
      return {
        enabled,
        detail: enabled ? 'the guest can start Windows executables' : 'interop disabled',
      };
    },
  };
}
