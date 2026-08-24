import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SERVA_DIR } from '../store/paths.js';
import { SERVA_VERSION } from './version.js';
import { MachineQualificationState, machineIdentity, qualificationRefusal } from './machine.js';
import { verifyBackup } from './backup.js';
import type { MachineIdentity, MachineQualification } from './machine.js';

/**
 * MACHINE DOCTOR — INSPECT, NEVER GUESS, NEVER FIX WITHOUT BEING ASKED.
 *
 * SPEC: §22, §50, §48.
 *
 * The owner's question is "why can't Serva do the thing", and the honest answer is almost
 * always one specific missing prerequisite. What they get from most tools is a wall of
 * diagnostics, or worse, a green tick that means the program started.
 *
 * Three rules shape this:
 *
 *   EVERY CHECK IS A MEASUREMENT. A probe that cannot run reports UNKNOWN, not READY.
 *   `UNKNOWN != success` is the whole fail-closed rule applied to diagnostics, and it is
 *   the one people break first because an unknown looks like a nuisance.
 *
 *   IT DOES NOT MUTATE. Diagnosis and repair are separate acts; a doctor that quietly
 *   fixed things would make the next diagnosis meaningless.
 *
 *   IT SAYS WHAT TO DO. A check that fails without a remedy has told the owner they have a
 *   problem and left them exactly where they started.
 *
 * The probes are INJECTED. Real ones shell out to WSL, Node and Claude; the tests supply
 * deterministic ones. That is not test convenience — it is what lets the doctor's logic be
 * verified at all, because a function that measures the machine it runs on can only ever
 * be tested on that machine.
 */

export const CheckState = {
  READY: 'READY',
  /** Present, and not sufficient on its own. */
  DEGRADED: 'DEGRADED',
  /** Missing or wrong, and the owner can fix it. */
  ACTION_REQUIRED: 'ACTION_REQUIRED',
  /** The probe could not run. Never treated as READY. */
  UNKNOWN: 'UNKNOWN',
} as const;
export type CheckState = (typeof CheckState)[keyof typeof CheckState];

export interface CheckResult {
  readonly id: string;
  readonly label: string;
  readonly state: CheckState;
  readonly detail: string;
  /** What the owner does next. Required whenever the state is not READY. */
  readonly remedy?: string;
  /** True when this check must pass before write-capable engineering may run. */
  readonly blocksEngineering: boolean;
}

/**
 * What the doctor is allowed to look at.
 *
 * Deliberately narrow, and deliberately not the whole environment: everything here is a
 * fact that changes what containment means or whether a run can happen at all. Anything
 * else would be diagnostics for their own sake.
 */
export interface DoctorProbes {
  platform(): { readonly platform: string; readonly release: string; readonly arch: string };
  node(): { readonly version: string };
  wsl(): { readonly installed: boolean; readonly version?: string; readonly detail: string };
  distro(): {
    readonly name?: string;
    readonly kernel?: string;
    readonly user?: string;
    /**
     * False when the probe could not run at all.
     *
     * The distinction a diagnostic gets wrong most easily: a tool that is NOT INSTALLED
     * and a guest that did not answer look identical from a failed command, and reporting
     * the second as the first sends the owner to install something they already have.
     */
    readonly measured?: boolean;
    readonly detail: string;
  };
  claude(): {
    readonly installed: boolean;
    readonly location?: string;
    readonly version?: string;
    /**
     * A credentials file is present in the guest.
     *
     * NOT the same as an authenticated session, and the difference is not academic: the
     * live acceptance found this doctor reporting "Claude subscription READY" on a machine
     * whose engine reported `authenticated: false`, and Phase 4 then refused the Producer.
     * A green line above a refusal is the "UI green does not mean runtime green" failure
     * this whole product refuses to make.
     *
     * The authoritative check is the engine's own health report, which Phase 4 performs.
     * This one reports what a file tells it, and says so.
     */
    readonly credentialsFilePresent: boolean;
    /** False when the probe could not run. Absent means it did. */
    readonly measured?: boolean;
    readonly detail: string;
  };
  sandbox(): {
    readonly mechanism?: string;
    readonly version?: string;
    readonly available: boolean;
    /**
     * The launcher that contains a PRODUCER, which is a different mechanism from the one
     * that contains a recipe.
     *
     * `bubblewrap` contains Serva's own build and test commands. A Producer runs inside
     * the engine's own sandbox runtime, and having one is no evidence of the other —
     * which is exactly what the live acceptance found when this doctor said READY and the
     * factory refused for a missing `claude-sandbox-runtime`.
     */
    readonly producerLauncher?: string;
    /** False when the probe could not run. Absent means it did. */
    readonly measured?: boolean;
    readonly detail: string;
  };
  git(): { readonly installed: boolean; readonly version?: string; readonly detail: string };
  /** Windows interop inside the guest. A containment property, not a convenience. */
  interop(): { readonly enabled?: boolean; readonly detail: string };
}

export interface DoctorInput {
  readonly probes: DoctorProbes;
  readonly qualification?: MachineQualification;
  /** Project roots to sanity-check, where the caller knows of any. */
  readonly projectRoots?: readonly string[];
  /** The most recent backup bundle, for the freshness line. */
  readonly lastBackupPath?: string;
}

export interface DoctorReport {
  readonly servaVersion: string;
  readonly checks: readonly CheckResult[];
  /**
   * The identity this machine was measured as, INCLUDING its fingerprint.
   *
   * Declared as the facts alone for most of Phase 6, while `machineIdentity()` was already
   * returning the built identity — so the fingerprint was there at runtime and invisible to
   * every caller through the type. The live acceptance found it by trying to read it.
   */
  readonly identity?: MachineIdentity;
  readonly qualification: MachineQualificationState;
  readonly qualificationReason: string;
  readonly engineeringReady: boolean;
  readonly summary: string;
}

/** Run every probe and report. Nothing here writes, and nothing here repairs. */
export function machineDoctor(input: DoctorInput): DoctorReport {
  const checks: CheckResult[] = [];
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  const platform = safe(() => input.probes.platform(), {
    platform: 'unknown',
    release: 'unknown',
    arch: 'unknown',
  });
  checks.push({
    id: 'PLATFORM',
    label: 'Machine',
    state: platform.platform === 'unknown' ? CheckState.UNKNOWN : CheckState.READY,
    detail: platform.platform + ' ' + platform.release + ' (' + platform.arch + ')',
    ...(platform.platform === 'unknown'
      ? { remedy: 'Serva could not read the host platform, so nothing below can be relied on.' }
      : {}),
    blocksEngineering: false,
  });

  const node = safe(() => input.probes.node(), { version: 'unknown' });
  checks.push({
    id: 'NODE',
    label: 'Node',
    state: node.version === 'unknown' ? CheckState.UNKNOWN : CheckState.READY,
    detail: node.version,
    blocksEngineering: false,
  });

  const wsl = safe(() => input.probes.wsl(), { installed: false, detail: 'the probe did not run' });
  checks.push({
    id: 'WSL2',
    label: 'WSL2',
    state: wsl.installed ? CheckState.READY : CheckState.ACTION_REQUIRED,
    detail: wsl.detail,
    ...(wsl.installed
      ? {}
      : {
          remedy:
            'Install WSL2 (`wsl --install`) and restart. Engineering runs inside a Linux guest; without one there is no boundary to contain a Producer.',
        }),
    blocksEngineering: true,
  });

  const distro = safe(() => input.probes.distro(), { detail: 'the probe did not run' });
  const distroReady =
    distro.name !== undefined && distro.user !== undefined && distro.user !== 'root';
  checks.push({
    id: 'DISTRO',
    label: 'Linux guest',
    state:
      distro.measured === false
        ? CheckState.UNKNOWN
        : distro.name === undefined
          ? CheckState.ACTION_REQUIRED
          : distro.user === 'root'
            ? CheckState.DEGRADED
            : distroReady
              ? CheckState.READY
              : CheckState.UNKNOWN,
    detail: distro.detail,
    ...(distro.measured === false
      ? {
          remedy:
            'The guest did not answer, so nothing about it could be established. Fix WSL first.',
        }
      : distro.name === undefined
        ? { remedy: 'Install a distribution: `wsl --install -d Ubuntu`.' }
        : distro.user === 'root'
          ? {
              remedy:
                'The guest default user is root. Create a normal user and set it as the default: a Producer running as root is not contained by a sandbox that assumes it is not.',
            }
          : {}),
    blocksEngineering: true,
  });

  const claude = safe(() => input.probes.claude(), {
    installed: false,
    credentialsFilePresent: false,
    detail: 'the probe did not run',
  });
  checks.push({
    id: 'CLAUDE',
    label: 'Claude Code',
    state:
      claude.measured === false
        ? CheckState.UNKNOWN
        : claude.installed
          ? CheckState.READY
          : CheckState.ACTION_REQUIRED,
    detail: claude.installed
      ? (claude.location ?? 'installed') + ' ' + (claude.version ?? '')
      : claude.detail,
    ...(claude.measured === false
      ? {
          remedy: 'The guest did not answer, so the engine could not be looked for. Fix WSL first.',
        }
      : claude.installed
        ? {}
        : { remedy: 'Install Claude Code inside the guest distribution.' }),
    blocksEngineering: true,
  });
  checks.push({
    id: 'CLAUDE_AUTH',
    label: 'Claude subscription',
    /*
     * NEVER READY FROM A FILE.
     *
     * A credentials file present is evidence that somebody signed in once, on some
     * machine, at some point. It is not evidence of a session the engine will accept now —
     * and reporting READY from it produced exactly the failure this product exists to
     * prevent: a green diagnostic line sitting above a refusal from the factory.
     *
     * So the best this check reaches is UNKNOWN, and it names the command that actually
     * knows. There is no branch here that returns READY.
     */
    state:
      claude.measured === false || !claude.credentialsFilePresent
        ? claude.measured === false
          ? CheckState.UNKNOWN
          : CheckState.ACTION_REQUIRED
        : CheckState.UNKNOWN,
    /* Never the account, the email or the organisation. */
    detail:
      claude.measured === false
        ? 'not measured'
        : claude.credentialsFilePresent
          ? 'a credentials file is present; an authenticated SESSION is not established here'
          : 'no credentials file in the guest',
    remedy:
      claude.measured === false
        ? 'The guest did not answer, so nothing about sign-in could be read.'
        : claude.credentialsFilePresent
          ? 'Run `serva engineering doctor` for the authoritative answer: it asks the engine itself. This check only sees a file.'
          : 'Run `claude` in the guest and sign in. Serva uses your Claude subscription; it never creates an API key and never copies credentials from another machine.',
    blocksEngineering: true,
  });

  const sandbox = safe(() => input.probes.sandbox(), {
    available: false,
    detail: 'the probe did not run',
  });
  checks.push({
    id: 'SANDBOX',
    label: 'Sandbox (recipes)',
    state:
      sandbox.measured === false
        ? CheckState.UNKNOWN
        : sandbox.available
          ? CheckState.READY
          : CheckState.ACTION_REQUIRED,
    detail: sandbox.available
      ? (sandbox.mechanism ?? 'available') + ' ' + (sandbox.version ?? '')
      : sandbox.detail,
    ...(sandbox.measured === false
      ? {
          remedy:
            'The guest did not answer, so the sandbox could not be looked for. Fix WSL first.',
        }
      : sandbox.available
        ? {}
        : {
            remedy:
              'Install the sandbox mechanism inside the guest (`bubblewrap`). Without it, engineering stays read-only rather than running unconfined.',
          }),
    blocksEngineering: true,
  });

  /*
   * The PRODUCER launcher, separately. Two boundaries, two mechanisms, and satisfying one
   * is no evidence about the other — which is what the live acceptance demonstrated.
   */
  checks.push({
    id: 'SANDBOX_PRODUCER',
    label: 'Sandbox (producer)',
    state:
      sandbox.measured === false
        ? CheckState.UNKNOWN
        : sandbox.producerLauncher === undefined
          ? CheckState.ACTION_REQUIRED
          : CheckState.READY,
    detail:
      sandbox.measured === false
        ? 'no WSL guest responded'
        : (sandbox.producerLauncher ?? 'claude-sandbox-runtime was not found in the guest'),
    ...(sandbox.measured === false || sandbox.producerLauncher === undefined
      ? {
          remedy:
            'Install the engine sandbox runtime inside the guest: `npm install -g @anthropic-ai/sandbox-runtime`. It is what contains a Producer, and bubblewrap is not a substitute for it.',
        }
      : {}),
    blocksEngineering: true,
  });

  const interop = safe(() => input.probes.interop(), { detail: 'the probe did not run' });
  checks.push({
    id: 'INTEROP',
    label: 'Windows interop',
    state:
      interop.enabled === undefined
        ? CheckState.UNKNOWN
        : interop.enabled
          ? CheckState.DEGRADED
          : CheckState.READY,
    detail: interop.detail,
    ...(interop.enabled === true
      ? {
          remedy:
            'Windows interop is enabled inside the guest, which lets a guest process start Windows executables. Disable it for engineering work; it is a hole in the boundary, not a setting.',
        }
      : {}),
    blocksEngineering: false,
  });

  const git = safe(() => input.probes.git(), { installed: false, detail: 'the probe did not run' });
  checks.push({
    id: 'GIT',
    label: 'Git',
    state: git.installed ? CheckState.READY : CheckState.ACTION_REQUIRED,
    detail: git.installed ? (git.version ?? 'installed') : git.detail,
    ...(git.installed
      ? {}
      : { remedy: 'Install Git. Serva records every accepted change as a commit.' }),
    blocksEngineering: true,
  });

  for (const root of input.projectRoots ?? []) {
    const ok = existsSync(join(root, SERVA_DIR));
    checks.push({
      id: 'PROJECT:' + root,
      label: 'Project ' + root,
      state: ok ? CheckState.READY : CheckState.ACTION_REQUIRED,
      detail: ok ? 'store present' : 'no ' + SERVA_DIR + ' directory',
      ...(ok
        ? {}
        : { remedy: 'Run `serva init` in this directory, or point Serva at another one.' }),
      blocksEngineering: false,
    });
  }

  if (input.lastBackupPath !== undefined) {
    const verification = verifyBackup(input.lastBackupPath);
    checks.push({
      id: 'BACKUP',
      label: 'Backup',
      state: verification.ok ? CheckState.READY : CheckState.ACTION_REQUIRED,
      detail: verification.summary,
      ...(verification.ok
        ? {}
        : {
            remedy:
              'This backup does not verify, so it will not restore. Take a fresh one before relying on it.',
          }),
      blocksEngineering: false,
    });
  }

  /* ------------------------------------------------ the qualification, derived */

  const identity =
    platform.platform === 'unknown'
      ? undefined
      : machineIdentity({
          platform: platform.platform,
          release: platform.release,
          architecture: platform.arch,
          nodeVersion: node.version,
          ...(wsl.version === undefined ? {} : { wslVersion: wsl.version }),
          ...(distro.name === undefined ? {} : { guestDistro: distro.name }),
          ...(distro.kernel === undefined ? {} : { guestKernel: distro.kernel }),
          ...(distro.user === undefined ? {} : { guestUser: distro.user }),
          ...(claude.location === undefined ? {} : { claudeLocation: claude.location }),
          ...(claude.version === undefined ? {} : { claudeVersion: claude.version }),
          ...(sandbox.mechanism === undefined ? {} : { sandboxMechanism: sandbox.mechanism }),
          ...(sandbox.version === undefined ? {} : { sandboxVersion: sandbox.version }),
          ...(interop.enabled === undefined ? {} : { interopEnabled: interop.enabled }),
        });

  const refusal =
    identity === undefined
      ? 'the machine could not be identified, so no qualification can apply to it'
      : qualificationRefusal(input.qualification, identity);

  const blocking = checks.filter((c) => c.blocksEngineering && c.state !== CheckState.READY);
  const state =
    refusal === undefined
      ? MachineQualificationState.HARD
      : (input.qualification?.state ?? MachineQualificationState.UNQUALIFIED);

  return {
    servaVersion: SERVA_VERSION,
    checks,
    ...(identity === undefined ? {} : { identity }),
    qualification: state,
    qualificationReason: refusal ?? 'measured on this machine and current',
    /*
     * BOTH conditions. A stale HARD record with every prerequisite present is not ready,
     * and a fresh measurement with no sandbox installed is not either.
     */
    engineeringReady: refusal === undefined && blocking.length === 0,
    summary:
      blocking.length === 0
        ? refusal === undefined
          ? 'ready: every prerequisite is present and this machine is qualified'
          : 'prerequisites are present; this machine is not qualified — ' + refusal
        : String(blocking.length) +
          ' prerequisite(s) need attention: ' +
          blocking.map((c) => c.label).join(', '),
  };
}

/**
 * The owner-facing lines, aligned.
 *
 * Alignment is not decoration here. This is read under stress — something is broken and
 * somebody is scanning for the word that is not READY — and a column that wanders because
 * one project path was long is a column nobody can scan.
 */
export function renderDoctor(report: DoctorReport): string {
  const WIDTH = 24;
  const row = (label: string, state: string): string => {
    /* Long labels are elided from the LEFT: the end of a path identifies it, not the start. */
    const shown =
      label.length <= WIDTH ? label.padEnd(WIDTH, '.') : '…' + label.slice(-(WIDTH - 1));
    return shown + ' ' + state;
  };
  return [
    'Serva Code ' + report.servaVersion,
    '',
    ...report.checks.map((c) => row(c.label, c.state)),
    row('Machine qualification', report.qualification),
    '',
    report.summary,
    ...report.checks
      .filter((c) => c.remedy !== undefined)
      .map((c) => '  → ' + c.label + ': ' + String(c.remedy)),
  ].join('\n');
}
