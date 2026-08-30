import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnforcementClass } from '../vocab/index.js';
import { EngineHealthState } from '../engine/types.js';
import { ClaudeCliEngineAdapter } from '../engine/claude/adapter.js';
import { API_BILLING_ENV_VARS, THIRD_PARTY_ENV_VARS } from '../engine/claude/billing.js';
import { LocalProcessLauncher, WslProcessLauncher } from '../engine/processLauncher.js';
import { SandboxedExecutionSubstrate, PRODUCER_REQUIRED_BINARIES } from '../substrate/sandboxed.js';
import { ClaudeSandboxLauncher } from '../substrate/claudeSandbox.js';
import { MIN_SANDBOX_ENGINE_VERSION } from '../substrate/host.js';
import {
  LocalPosixTransport,
  WslTransport,
  GUEST_PATH,
  listWslDistributions,
  GuestReach,
  resolveGuestBinary,
  selectWslDistribution,
  type ExecTransport,
  type WslDistribution,
} from '../substrate/transport.js';
import { BoundaryPurpose, executionBoundary } from '../substrate/boundary.js';
import { buildSandboxProfile } from './sandboxProfile.js';
import { engineeringAuthorityRefusal, guestPrerequisite } from '../substrate/types.js';
import type { ExecutionBoundary } from '../substrate/boundary.js';
import type { AnyPrerequisite, Prerequisite, SubstrateQualification } from '../substrate/types.js';
import type { EngineCapabilities, EngineStatus } from '../engine/types.js';
import type { ProcessLauncher } from '../engine/processLauncher.js';
import type { Clock } from '../core/clock.js';

/**
 * The engine a Producer actually runs in, and the boundary that governs it.
 *
 * SPEC: Phase 4 execution-binding closure §3–§5, §7.
 *
 * The defect this module exists to close, stated plainly: Serva qualified
 * `Windows → WSL2 → bubblewrap → worktree`, and then dispatched a Producer through
 * `spawn("claude")` on native Windows. Both were true simultaneously and nothing
 * noticed, because the only question asked at dispatch was whether an enforcement class
 * said HARD. On this platform that combination is the worst possible one: the boundary
 * that was measured was not the boundary that ran, and the boundary that ran was none.
 *
 * ## Host versus guest
 *
 * Read-only Phase 3 agents keep using the host engine; their governance is the tool
 * policy, which holds wherever the process runs, and nothing they can do escapes into
 * the filesystem. A write- or exec-capable Producer is a different question entirely,
 * and on Windows it must run **inside the qualified guest**:
 *
 *   Windows Serva orchestrator
 *     → WslProcessLauncher (the exact selected distribution)
 *       → the guest's own `claude`
 *         → Claude Code's sandbox, configured by Serva's profile
 *           → the host-mounted engineering worktree
 *
 * ## What is probed, and what is never done
 *
 * The guest installation is probed for real: executable path, version, `auth status`,
 * authenticated state, and its own billing route. **Credentials are never copied from
 * Windows into the guest, never extracted, and no login is ever attempted.** An
 * unauthenticated guest is a prerequisite with a remedy the owner performs, once, by
 * hand — not something a build system quietly arranges for itself.
 */

export const ENGINEERING_BOUNDARY_ID = 'SC-BOUNDARY-PRODUCER';

export interface EngineeringEngineOptions {
  readonly clock: Clock;
  readonly projectRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly listDistributions?: () => Promise<WslDistribution[]>;
  /** Injected for tests, so the guest can be exercised without a real machine. */
  readonly transport?: ExecTransport;
  readonly launcher?: ProcessLauncher;
  readonly minEngineVersion?: string;
}

export interface EngineeringEngine {
  /** The adapter bound to the execution environment the boundary was measured in. */
  readonly adapter: ClaudeCliEngineAdapter | undefined;
  readonly capabilities: EngineCapabilities | undefined;
  readonly status: EngineStatus | undefined;
  /** The PRODUCER boundary qualification. Never a recipe qualification. */
  readonly qualification: SubstrateQualification | undefined;
  readonly boundary: ExecutionBoundary | undefined;
  /** Everything missing, each with a remedy. Empty when the engine is dispatchable. */
  readonly prerequisites: readonly Prerequisite[];
  /** Why no Producer may be dispatched, or undefined. */
  readonly refusal?: string;
  readonly basis: string;
  /**
   * A host path as the ENGINE will name it.
   *
   * Capability grants are computed on the host and enforced in the execution
   * environment, so an absolute permission rule has to carry the path the engine
   * actually sees.
   */
  readonly toExecutionPath: (hostPath: string) => string;
}

function unavailable(basis: string, prerequisites: readonly Prerequisite[]): EngineeringEngine {
  return {
    adapter: undefined,
    capabilities: undefined,
    status: undefined,
    qualification: undefined,
    boundary: undefined,
    prerequisites,
    toExecutionPath: (x) => x,
    refusal:
      'PLATFORM_PREREQUISITE_REQUIRED: ' +
      prerequisites
        .filter((p) => !p.satisfied)
        .map((p) => p.id + ' (' + p.what + ')')
        .join(', '),
    basis,
  };
}

/**
 * Resolve the engineering engine and qualify the boundary it will run in.
 *
 * Expensive by design: it probes the guest, writes a fixture profile and runs the
 * adversarial suite through the same sandbox runtime a Producer will be subject to.
 * That cost is the point — §7, the thing qualified is the thing executed.
 */
export async function resolveEngineeringEngine(
  opts: EngineeringEngineOptions,
): Promise<EngineeringEngine> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;

  /* ------------------------------------------- 1. where will the Producer run? */

  let transport: ExecTransport;
  let launcher: ProcessLauncher;
  let basis: string;

  if (opts.transport !== undefined && opts.launcher !== undefined) {
    transport = opts.transport;
    launcher = opts.launcher;
    basis = 'execution environment supplied by the caller';
  } else if (platform === 'win32') {
    const distributions = await (opts.listDistributions ?? listWslDistributions)();
    const selected = selectWslDistribution(distributions, env);
    if (selected === undefined || selected.version !== 2) {
      return unavailable('Windows host with no usable WSL2 distribution.', [
        {
          id: 'WSL_DISTRIBUTION',
          what: 'A WSL2 distribution',
          why: 'A write-capable Producer cannot be contained on native Windows, so the guest is the only place it may run.',
          remedy:
            'Install WSL2 and a Linux distribution, then re-run `serva engineering doctor`. Serva will not install it for you.',
          satisfied: false,
        },
      ]);
    }
    transport = new WslTransport(selected.name);
    launcher = new WslProcessLauncher({ distro: selected.name });
    basis =
      'Windows host: the Producer runs inside WSL2 distribution "' +
      selected.name +
      '", because native Windows has no sandbox to contain it.';
  } else if (platform === 'linux') {
    transport = new LocalPosixTransport();
    launcher = new LocalProcessLauncher();
    basis = 'Linux host: the Producer runs here, under the engine sandbox.';
  } else {
    return unavailable('No engineering engine for platform ' + platform + '.', [
      {
        id: 'SUPPORTED_PLATFORM',
        what: 'Linux, or Windows with WSL2',
        why: 'Serva has no measured Producer boundary on this platform, so it will not dispatch one.',
        remedy: 'Run the engineering engine on Linux, or on Windows with WSL2.',
        satisfied: false,
      },
    ]);
  }

  /* ------------------------------------------- 2. is the engine there, and whose? */

  const guestBin = await whichIn(transport, 'claude');
  if (guestBin === undefined || guestBin.startsWith('/mnt/')) {
    return unavailable(basis, [
      {
        id: 'GUEST_ENGINE',
        what: 'Claude Code installed in the execution environment',
        why:
          guestBin === undefined
            ? 'The engine must run where the sandbox runs; an install on the other side of the transport cannot be contained by it.'
            : 'The `claude` on PATH resolves under /mnt/, which is the Windows executable reached through interop. That is the host engine wearing a Linux path, and it is exactly what must not be dispatched.',
        remedy: 'Install Claude Code inside the execution environment.',
        satisfied: false,
      },
    ]);
  }

  const adapter = new ClaudeCliEngineAdapter({
    clock: opts.clock,
    bin: guestBin,
    // The guest supplies its own environment. Nothing is forwarded from Windows,
    // including the API-key variables that would silently change the billing route.
    env: {},
    launcher:
      opts.launcher ??
      (platform === 'win32'
        ? new WslProcessLauncher({ distro: transportDistro(transport), guestBin })
        : launcher),
    run: (bin, args, timeoutMs) =>
      transport
        .run({
          executable: bin,
          args,
          cwd: '/',
          env: { PATH: GUEST_PATH },
          timeoutMs,
          maxOutputBytes: 200_000,
        })
        .then((r) => ({
          code: r.exitCode,
          stdout: r.stdout.replace(/\0/g, ''),
          stderr: r.stderr.replace(/\0/g, ''),
          ...(r.spawnFailed ? { spawnFailed: true } : {}),
          // Carried through, not dropped. The transport already knows the difference
          // between "it failed" and "it ran out of time"; discarding that here is what
          // made a cold guest look like a missing install.
          ...(r.timedOut ? { timedOut: true } : {}),
        })),
  });

  const status = await adapter.health();
  const capabilities = await adapter.capabilities();

  /*
   * Did the engine answer at all?
   *
   * SPEC: finding QTS-PREREQ-NOREACH. `UNAVAILABLE` is the health probe saying it could not
   * reach the engine — which establishes nothing about authentication or billing, and must
   * not be recorded as a measured absence of either.
   */
  const engineReach =
    status.state === EngineHealthState.UNAVAILABLE ? GuestReach.NOT_REACHED : GuestReach.REACHED;

  const authPrereqs: AnyPrerequisite[] = [];
  /*
   * Guest-derived: the engine health probe ran in the execution environment, so an unreached
   * guest cannot establish that authentication is missing. `status.reach` carries that.
   */
  authPrereqs.push(
    guestPrerequisite({
      id: 'GUEST_ENGINE_AUTH',
      what: 'An authenticated Claude Code in the execution environment',
      why: 'The engine cannot run a session without it, and a Producer dispatched into an unauthenticated engine burns a worktree to discover that.',
      remedy:
        'Run `claude` once inside the execution environment and sign in there. Serva never copies credentials across, never extracts a token, and never logs in for you.',
      satisfied: status.authenticated,
      reach: engineReach,
    }),
  );
  authPrereqs.push(
    guestPrerequisite({
      id: 'GUEST_ENGINE_BILLING',
      what: 'An acceptable billing route in the execution environment',
      why: "A guest configured for an API-key or third-party-cloud route bills differently from the owner's subscription, and a Producer is not the place to discover that (SC-POL-035).",
      remedy:
        'Unset ' +
        [...API_BILLING_ENV_VARS, ...THIRD_PARTY_ENV_VARS].join(', ') +
        ' inside the execution environment, or accept that route explicitly.',
      satisfied: status.state !== EngineHealthState.BILLING_ROUTE_REFUSED,
      reach: engineReach,
    }),
  );
  authPrereqs.push(
    guestPrerequisite({
      id: 'GUEST_ENGINE_CAPABILITIES',
      what: 'An engine that supports structured output, tool restriction and settings isolation',
      why: 'Serva governs a run through exactly those three mechanisms. An engine missing any of them cannot be governed, only hoped at.',
      remedy: 'Update Claude Code inside the execution environment.',
      satisfied:
        capabilities.supportsStructuredOutput &&
        capabilities.supportsToolRestriction &&
        capabilities.supportsAmbientConfigIsolation &&
        capabilities.supportsNonInteractivePermissions,
      reach: engineReach,
    }),
  );

  /* ------------------------- 3. qualify the boundary the Producer will really use */

  const fixture = join(opts.projectRoot, '.serva', 'tmp', 'producer-boundary');
  const worktreeFixture = join(fixture, 'worktree');
  mkdirSync(worktreeFixture, { recursive: true });

  /*
   * The fixture profile is the SAME POLICY a real attempt receives, pointed at a
   * disposable worktree. `policyDigest` is deliberately path-independent: every
   * attempt has a different worktree, and a boundary identity that changed per attempt
   * would make the comparison useless while looking rigorous. What must not change is
   * the POLICY — the write scope shape, the denied reads, the network stance, and the
   * two settings that decide whether the sandbox can be got out of the way.
   */
  const profile = buildSandboxProfile({
    worktreePath: worktreeFixture,
    projectRoot: opts.projectRoot,
    networkAllowed: false,
    // The policy is enforced where the engine runs, so it is written in that
    // environment's paths — the same translation the Producer's grant uses.
    toExecutionPath: (hostPath: string) => transport.toGuestPath(hostPath),
  });
  const profilePath = join(fixture, 'settings.json');
  writeFileSync(profilePath, JSON.stringify(profile.settings, null, 2), 'utf8');
  // The sandbox runtime speaks its own schema; the launcher writes that file itself
  // from the same spec, so the two cannot drift.
  const srtConfigPath = join(fixture, 'srt-settings.json');

  const substrate = new SandboxedExecutionSubstrate({
    transport,
    launcher: new ClaudeSandboxLauncher({
      configHostPath: srtConfigPath,
      configGuestPath: transport.toGuestPath(srtConfigPath),
    }),
    clock: opts.clock,
    engineVersion: status.version,
    projectRoot: opts.projectRoot,
    minEngineVersion: opts.minEngineVersion ?? MIN_SANDBOX_ENGINE_VERSION,
    purpose: BoundaryPurpose.PRODUCER,
    boundaryId: ENGINEERING_BOUNDARY_ID,
    requiredBinaries: PRODUCER_REQUIRED_BINARIES,
    requiresEngine: true,
    extraPrerequisites: authPrereqs,
    profileDigest: profile.policyDigest,
  });

  let qualification: SubstrateQualification;
  try {
    qualification = await substrate.qualify(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }

  const refusal = engineeringAuthorityRefusal(qualification);
  return {
    adapter,
    capabilities,
    status,
    qualification,
    boundary: qualification.boundary,
    prerequisites: qualification.probe.prerequisites,
    ...(refusal === undefined ? {} : { refusal }),
    basis,
    toExecutionPath: (hostPath) => transport.toGuestPath(hostPath),
  };
}

/**
 * The boundary a dispatch is ABOUT to use, derived from the engine in hand.
 *
 * Built independently of the qualification so the comparison has two sources. Deriving
 * both from the same object would compare a value with itself.
 */
export function boundaryOfEngine(o: {
  readonly adapter: ClaudeCliEngineAdapter;
  readonly engineVersion: string;
  readonly sandboxMechanism: string;
  readonly sandboxVersion?: string;
  readonly policyDigest: string;
}): ExecutionBoundary {
  const location = o.adapter.location;
  return executionBoundary({
    boundaryId: ENGINEERING_BOUNDARY_ID,
    purpose: BoundaryPurpose.PRODUCER,
    simulated: false,
    transport: location.transport,
    ...(location.guest === undefined ? {} : { guest: location.guest }),
    engineLocation: o.adapter.executable,
    engineVersion: o.engineVersion,
    sandboxMechanism: o.sandboxMechanism,
    ...(o.sandboxVersion === undefined ? {} : { sandboxVersion: o.sandboxVersion }),
    profileDigest: o.policyDigest,
  });
}

/**
 * Where a binary is in the guest, or `undefined` when the guest did not say it is there.
 *
 * SPEC: finding QUALIFICATION-TRANSPORT-SEMANTICS/QTS-A. Callers here want a path or nothing,
 * and the REACH is consumed rather than discarded: an unreached guest yields `undefined`
 * exactly as an absent binary does, but only after the distinction has been read.
 */
async function whichIn(transport: ExecTransport, bin: string): Promise<string | undefined> {
  const found = await resolveGuestBinary(transport, bin);
  return found.reach === GuestReach.REACHED ? found.path : undefined;
}

function transportDistro(transport: ExecTransport): string {
  return transport.id.startsWith('wsl:') ? transport.id.slice(4) : transport.id;
}

export { EnforcementClass };
