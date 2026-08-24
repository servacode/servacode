import { EnforcementClass } from '../vocab/index.js';
import { canonicalJson, digestOf } from '../core/hash.js';
import {
  EnforcementState,
  ExecutionAvailability,
  IsolationMethod,
  NotRunReason,
  QualificationAttempt,
  type ExecuteRequest,
  type ExecuteResult,
  type ExecutionSubstrate,
  type Prerequisite,
  type SubstrateCapabilities,
  type SubstrateProbe,
  type SubstrateQualification,
} from './types.js';
import { QUALIFICATION_CASES } from './qualification.js';
import {
  RECIPE_REQUIRED_BINARIES,
  SandboxedExecutionSubstrate,
  compareVersions,
} from './sandboxed.js';
import { BoundaryPurpose, executionBoundary } from './boundary.js';
import { BubblewrapLauncher, UnimplementedLauncher } from './sandboxLauncher.js';
import {
  LocalPosixTransport,
  WslTransport,
  listWslDistributions,
  selectWslDistribution,
  type WslDistribution,
  GuestReach,
} from './transport.js';
import type { Clock } from '../core/clock.js';

/**
 * Choosing the substrate for THIS machine. SPEC: 33 §2–§3, ADR-003.
 *
 * ## The delegation model
 *
 * A Windows host has no sandbox: the engine's Bash sandbox runs on macOS, Linux and
 * WSL2, and native Windows is not supported. Serva therefore does not try to contain
 * anything on Windows. It DELEGATES execution into a WSL2 guest:
 *
 *   Windows host (Serva orchestrates)
 *     -> WslTransport, one named distribution, chosen deterministically
 *       -> bubblewrap inside the guest
 *         -> the engineering worktree
 *
 * Serva itself keeps running on the host. Only execution crosses. The worktree stays on
 * the host filesystem and is reached through `/mnt/<drive>`, so the owner can still open
 * it in their editor while a Producer works in it.
 *
 * ## What changed, and why it mattered
 *
 * The previous implementation made `WIN_NO_NATIVE_SANDBOX` permanently unsatisfiable,
 * hard-coded the seccomp prerequisite to absent, and — even with everything satisfied —
 * returned every qualification case as NOT_RUN and refused every `execute()`. The
 * documented remedy could be followed to the letter and the substrate would still never
 * become HARD. That is not a fail-closed boundary; it is an unimplemented feature
 * wearing one, and it reads as safety while guaranteeing the capability cannot exist.
 *
 * Native Windows is still NON-HARD, and that has not softened. What changed is WHERE
 * the prerequisites point: at the guest, which can actually satisfy them.
 */

/** Minimum engine version whose sandbox behaviour this qualification was written for. */
export const MIN_SANDBOX_ENGINE_VERSION = '2.1.216';

export interface SubstrateSelectionOptions {
  readonly clock: Clock;
  readonly engineVersion: string;
  readonly projectRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  /** Injected for tests, so selection can be exercised without a real machine. */
  readonly listDistributions?: () => Promise<WslDistribution[]>;
  readonly alwaysDenyRead?: readonly string[];
}

export interface SubstrateSelection {
  readonly substrate: ExecutionSubstrate;
  /** Why this substrate and not another. Shown by `serva engineering doctor`. */
  readonly basis: string;
}

/**
 * Pick the substrate this machine can actually use.
 *
 * Read-only: it lists WSL distributions and nothing more. Installing WSL, enabling
 * Windows components, rebooting or changing system security configuration are the
 * owner's decisions, and a system whose safety rests on a sandbox has no business
 * silently reconfiguring the machine that sandbox runs on.
 */
export async function selectExecutionSubstrate(
  opts: SubstrateSelectionOptions,
): Promise<SubstrateSelection> {
  const platform = opts.platform ?? process.platform;
  /*
   * The RECIPE boundary: Serva's own deterministic build, test and lint commands.
   *
   * Its prerequisites are only what bubblewrap actually uses. The Producer boundary is
   * a different mechanism with a different list, built by `resolveEngineeringEngine`.
   */
  const common = {
    clock: opts.clock,
    engineVersion: opts.engineVersion,
    projectRoot: opts.projectRoot,
    minEngineVersion: MIN_SANDBOX_ENGINE_VERSION,
    purpose: BoundaryPurpose.RECIPE,
    boundaryId: 'SC-BOUNDARY-RECIPE',
    requiredBinaries: RECIPE_REQUIRED_BINARIES,
    ...(opts.alwaysDenyRead === undefined ? {} : { alwaysDenyRead: opts.alwaysDenyRead }),
  };

  if (platform === 'linux') {
    return {
      substrate: new SandboxedExecutionSubstrate({
        ...common,
        transport: new LocalPosixTransport(),
        launcher: new BubblewrapLauncher(),
      }),
      basis: 'Linux host: the engine and the sandbox run on the same machine.',
    };
  }

  if (platform === 'darwin') {
    /*
     * macOS uses Seatbelt, a different launcher with a different profile language. It
     * is not implemented, and saying so is the honest state: a substrate built on
     * `UnimplementedLauncher` reports the prerequisite unsatisfied and refuses to
     * execute, rather than quietly running a Producer unconstrained.
     */
    return {
      substrate: new SandboxedExecutionSubstrate({
        ...common,
        transport: new LocalPosixTransport(),
        launcher: new UnimplementedLauncher(
          'macOS containment uses Seatbelt, which Serva does not implement yet. No Producer will be dispatched on this host.',
          'seatbelt-unimplemented',
        ),
      }),
      basis: 'macOS host: no launcher implemented, so nothing may execute.',
    };
  }

  if (platform !== 'win32') {
    return {
      substrate: new UnqualifiableSubstrate({
        clock: opts.clock,
        engineVersion: opts.engineVersion,
        hostPlatform: platform,
        prerequisites: [
          {
            id: 'SUPPORTED_PLATFORM',
            what: 'A platform Serva can contain a process on (Linux, WSL2, or macOS)',
            why: 'Containment is platform-specific. Serva has no mechanism for this one, so it cannot measure a boundary here.',
            remedy: 'Run the engineering engine on Linux, or on Windows with WSL2.',
            satisfied: false,
          },
        ],
      }),
      basis: 'Unsupported platform ' + platform + '.',
    };
  }

  /* -------------------------------------------------------- Windows delegation */

  const distributions = await (opts.listDistributions ?? listWslDistributions)();
  const selected = selectWslDistribution(distributions, opts.env ?? process.env);

  if (selected === undefined) {
    const requested = (opts.env ?? process.env)['SERVA_WSL_DISTRO'];
    return {
      substrate: new UnqualifiableSubstrate({
        clock: opts.clock,
        engineVersion: opts.engineVersion,
        hostPlatform: 'win32',
        observations: {
          'wsl:distributions': distributions
            .map((d) => d.name + ':v' + String(d.version))
            .join(', '),
        },
        prerequisites: [
          {
            id: 'WSL_DISTRIBUTION',
            what:
              requested === undefined
                ? 'A WSL2 distribution'
                : 'A WSL2 distribution named ' + requested,
            why: 'The engine sandbox is not supported on native Windows, so a Linux guest is the only place on this host where a Producer can be contained.',
            remedy:
              requested === undefined
                ? 'Install WSL2 and a Linux distribution, then re-run `serva engineering doctor`. Serva will not install it for you.'
                : 'Install that distribution, or unset SERVA_WSL_DISTRO to use the default.',
            satisfied: false,
          },
        ],
      }),
      basis:
        distributions.length === 0
          ? 'Windows host with no WSL2 distribution available.'
          : 'Windows host: no WSL2 distribution matched the selection rule.',
    };
  }

  if (selected.version !== 2) {
    return {
      substrate: new UnqualifiableSubstrate({
        clock: opts.clock,
        engineVersion: opts.engineVersion,
        hostPlatform: 'win32',
        guestPlatform: selected.name,
        prerequisites: [
          {
            id: 'WSL_VERSION_2',
            what: 'WSL version 2 for ' + selected.name,
            why: 'WSL1 does not provide the kernel features bubblewrap needs, so nothing can be contained there.',
            remedy: 'wsl --set-version ' + selected.name + ' 2',
            satisfied: false,
          },
        ],
      }),
      basis: 'Windows host: ' + selected.name + ' is WSL' + String(selected.version) + '.',
    };
  }

  return {
    substrate: new SandboxedExecutionSubstrate({
      ...common,
      transport: new WslTransport(selected.name),
      launcher: new BubblewrapLauncher(),
    }),
    basis:
      'Windows host delegating execution to WSL2 distribution "' +
      selected.name +
      '". Native Windows remains NON-HARD; the guest is the candidate.',
  };
}

/**
 * A substrate that cannot be qualified on this machine, and says exactly why.
 *
 * Used when Serva has no route to a boundary at all — no WSL distribution, an
 * unsupported platform. Every prerequisite it reports is SATISFIABLE by the owner: a
 * remedy nobody can act on is a dead end dressed as guidance, and that was the defect
 * in the version this replaces.
 */
export class UnqualifiableSubstrate implements ExecutionSubstrate {
  readonly id = 'unqualifiable';

  constructor(
    private readonly opts: {
      readonly clock: Clock;
      readonly engineVersion: string;
      readonly prerequisites: readonly Prerequisite[];
      readonly hostPlatform: string;
      readonly guestPlatform?: string;
      readonly observations?: Readonly<Record<string, string>>;
    },
  ) {}

  async probe(): Promise<SubstrateProbe> {
    return {
      substrateId: this.id,
      hostPlatform: this.opts.hostPlatform,
      hostArch: process.arch,
      ...(this.opts.guestPlatform === undefined ? {} : { guestPlatform: this.opts.guestPlatform }),
      isolationMethod: IsolationMethod.NONE,
      engineVersion: this.opts.engineVersion,
      prerequisites: [...this.opts.prerequisites],
      observations: { ...(this.opts.observations ?? {}), hostPlatform: this.opts.hostPlatform },
      probedAt: this.opts.clock.now(),
    };
  }

  async capabilities(): Promise<SubstrateCapabilities> {
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

  async qualify(): Promise<SubstrateQualification> {
    const probe = await this.probe();
    const at = this.opts.clock.now();
    const missing = probe.prerequisites.filter((p) => !p.satisfied);
    const reason =
      'PLATFORM_PREREQUISITE_REQUIRED: ' +
      missing.map((p) => p.id + ' (' + p.what + ')').join(', ');
    return {
      probe,
      capabilities: await this.capabilities(),
      tests: QUALIFICATION_CASES.map((c) => ({
        id: c.id,
        title: c.title,
        expectation: c.expectation,
        outcome: 'NOT_RUN' as const,
        detail: 'Not attempted: ' + reason,
        blocking: c.blocking,
        /*
         * A native Windows host has no boundary to reach, and this is not a transport
         * failure: it is a measured fact about the platform, and no retry could change it.
         */
        reachedGuest: GuestReach.NOT_REACHED,
        notRunReason: NotRunReason.PREREQUISITE_MISSING,
        at,
      })),
      enforcementClass: EnforcementClass.NONE,
      /*
       * MEASURED, and the measurement is that a native Windows host has no boundary. This is
       * a settled fact about the platform rather than a failed attempt to look — so it must
       * never be reported as "could not measure", and no retry could change it.
       */
      attempt: QualificationAttempt.MEASURED,
      availability: ExecutionAvailability.UNKNOWN,
      blockedBy: reason,
      qualifiedAt: at,
      engineVersion: this.opts.engineVersion,
      fingerprint: digestOf(
        canonicalJson({
          substrateId: this.id,
          host: this.opts.hostPlatform,
          missing: missing.map((p) => p.id),
        }),
      ),
      boundary: executionBoundary({
        boundaryId: 'SC-BOUNDARY-NONE',
        purpose: BoundaryPurpose.RECIPE,
        transport: 'none',
        engineVersion: this.opts.engineVersion,
        sandboxMechanism: 'none',
      }),
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
      /* Nothing is ever sent anywhere: this substrate refuses by construction. */
      reach: GuestReach.NOT_REACHED,
      startedAt,
      endedAt: this.opts.clock.now(),
      durationMs: 0,
      refusedBySubstrate: true,
      refusalReason:
        'This machine has no boundary Serva can measure, so nothing may execute. Command: ' +
        request.executable,
    };
  }

  async explain(): Promise<string> {
    const probe = await this.probe();
    const lines = [
      'Execution substrate: none available on this machine.',
      '  host: ' + probe.hostPlatform + '/' + probe.hostArch,
      '',
      'Prerequisites:',
    ];
    for (const p of probe.prerequisites) {
      lines.push('  [' + (p.satisfied ? ' ok ' : 'MISS') + '] ' + p.id + '  ' + p.what);
      lines.push('         why:    ' + p.why);
      lines.push('         remedy: ' + p.remedy);
    }
    lines.push(
      '',
      'Every prerequisite above is satisfiable by the owner. Serva installs none of',
      "them: changing the machine a sandbox runs on is the owner's decision.",
    );
    return lines.join('\n');
  }
}

export { compareVersions };
