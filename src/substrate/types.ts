import { GuestReach } from './transport.js';
import type { TransportAttempt } from './transport.js';
import { EnforcementClass } from '../vocab/index.js';
import type { ExecutionBoundary } from './boundary.js';

/**
 * ExecutionSubstrate — the boundary that has to hold before an agent may write or
 * execute anything.
 *
 * SPEC: 33 §2–§3, PC-5 (enforcement class is DETECTED and DECLARED, never assumed),
 * 19 TR-1, SC-POL-026. ADR-003.
 *
 * The failure this interface exists to prevent is a single line of code: granting
 * `Bash` because the provider offers `Bash`. The provider offers it on every platform.
 * That says nothing about whether anything can contain it.
 *
 * `EnforcementClass` is therefore a RESULT, not a configuration value:
 *
 *   HARD  every adversarial qualification test passed, on this machine, against this
 *         engine version — including subprocess escape, symlink escape, host escape,
 *         and the no-unsandboxed-retry check
 *   SOFT  a boundary exists but is harness-level only: it governs the model's own tool
 *         calls and cannot constrain an arbitrary child process
 *   NONE  no enforceable boundary
 *
 * Write and execute authority requires HARD. There is deliberately no SOFT engineering
 * mode: an agent that cannot be contained is not dispatched, and Serva says why.
 */

export { EnforcementClass };

/** How the substrate isolates, named so a reader can tell what was actually measured. */
export const IsolationMethod = {
  /** macOS Seatbelt. */
  SEATBELT: 'SEATBELT',
  /** Linux/WSL2 bubblewrap, optionally plus the seccomp filter. */
  BUBBLEWRAP: 'BUBBLEWRAP',
  /** The engine's own permission rules only — tool calls, not child processes. */
  HARNESS_ONLY: 'HARNESS_ONLY',
  /** Deterministic in-process substrate, for tests. */
  SIMULATED: 'SIMULATED',
  NONE: 'NONE',
} as const;
export type IsolationMethod = (typeof IsolationMethod)[keyof typeof IsolationMethod];

/**
 * One dimension of enforcement, measured independently.
 *
 * They are separate because they fail separately: on WSL2 the filesystem isolation can
 * be working perfectly while host escape is wide open, because the escape goes through
 * a Unix socket rather than through the filesystem (ADR-003 F-3).
 */
export const EnforcementState = {
  ENFORCED: 'ENFORCED',
  NOT_ENFORCED: 'NOT_ENFORCED',
  /** The dimension could not be measured; treated as NOT_ENFORCED for any decision. */
  UNKNOWN: 'UNKNOWN',
} as const;
export type EnforcementState = (typeof EnforcementState)[keyof typeof EnforcementState];

/** A prerequisite that is missing, with the exact step that would satisfy it. */
export interface Prerequisite {
  readonly id: string;
  readonly what: string;
  /** Why the substrate cannot be trusted without it. Never "because the docs say so". */
  readonly why: string;
  readonly remedy: string;
  readonly satisfied: boolean;
  /**
   * Whether the guest answered when this was checked.
   *
   * SPEC: finding QUALIFICATION-TRANSPORT-SEMANTICS/QTS-A. `satisfied: false` used to mean
   * both "the guest says no" and "the guest never answered", and a qualification cannot be
   * MEASURED on the second. Optional only because prerequisites established without touching
   * a guest have no reach to report.
   */
  readonly reach?: GuestReach;
}

export interface SubstrateProbe {
  readonly substrateId: string;
  readonly hostPlatform: string;
  readonly hostArch: string;
  /** Present when the engine runs inside a guest, e.g. a WSL2 distribution. */
  readonly guestPlatform?: string;
  readonly isolationMethod: IsolationMethod;
  /**
   * True when this substrate simulates rather than contains.
   *
   * A simulation's qualification outcomes are DECLARED by a fixture, not measured, so
   * no security property may be concluded from them. Callers that report a boundary to
   * an owner, or that are about to spend a model call on the strength of one, branch on
   * this rather than on the substrate's name.
   */
  readonly simulated?: boolean;
  readonly engineVersion: string;
  readonly sandboxVersion?: string;
  readonly prerequisites: readonly Prerequisite[];
  /** Raw, non-secret observations, kept so a reviewer can audit the conclusion. */
  readonly observations: Readonly<Record<string, string>>;
  readonly probedAt: string;
}

/** One adversarial test and what it proved. */
/**
 * WHY A TEST DID NOT RUN.
 *
 * SPEC: Phase 6 qualification transport invariant §2.
 *
 * `NOT_RUN` used to be one thing, and it hid the distinction that matters most. A probe
 * blocked because the sandbox launcher is genuinely absent is a fact about this machine; a
 * probe that never reached the guest is a fact about nothing at all, and the second was being
 * folded into the first and then counted as a failure.
 */
export const NotRunReason = {
  /** The guest was never reached. Nothing was measured and nothing may be concluded. */
  TRANSPORT_FAILURE: 'TRANSPORT_FAILURE',
  /** The guest was reached and refused to run it — a measured fact about this machine. */
  SUBSTRATE_REFUSED: 'SUBSTRATE_REFUSED',
  /** A prerequisite of the test itself was not met. */
  PREREQUISITE_MISSING: 'PREREQUISITE_MISSING',
} as const;
export type NotRunReason = (typeof NotRunReason)[keyof typeof NotRunReason];

/**
 * WAS THIS MEASUREMENT ATTEMPT COMPLETED?
 *
 * Deliberately separate from the RESULT of the measurement. "The boundary is weak" and "the
 * boundary could not be examined" are different sentences, and overloading NONE to carry both
 * is what let a WSL outage read as a containment finding.
 */
export const QualificationAttempt = {
  /** Every blocking probe reached the guest and produced a result. */
  MEASURED: 'MEASURED',
  /** At least one blocking probe never reached the guest. Nothing may be concluded. */
  NOT_MEASURED: 'NOT_MEASURED',
  /** Probes ran but disagreed or could not be completed for a non-transport reason. */
  INCONCLUSIVE: 'INCONCLUSIVE',
} as const;
export type QualificationAttempt = (typeof QualificationAttempt)[keyof typeof QualificationAttempt];

/** CAN COMMANDS REACH THE EXECUTION ENVIRONMENT RIGHT NOW? */
export const ExecutionAvailability = {
  AVAILABLE: 'AVAILABLE',
  UNREACHABLE: 'UNREACHABLE',
  UNKNOWN: 'UNKNOWN',
} as const;
export type ExecutionAvailability =
  (typeof ExecutionAvailability)[keyof typeof ExecutionAvailability];

export interface QualificationResult {
  readonly id: string;
  readonly title: string;
  /** What a HARD substrate must do. Stated so a PASS is readable without the code. */
  readonly expectation: string;
  readonly outcome: 'PASSED' | 'FAILED' | 'NOT_RUN';
  readonly detail: string;
  /** Blocking tests gate HARD; a non-blocking one only informs. */
  readonly blocking: boolean;
  readonly at: string;
  /**
   * Whether the probe REACHED the execution environment.
   *
   * Recorded on every result, passing or not, because the question an owner and an auditor
   * both need answered first is "did this actually run there?" — and an outcome without it
   * is a claim rather than evidence.
   */
  readonly reachedGuest: GuestReach;
  /** Present only for NOT_RUN, and the reason a caller routes on. */
  readonly notRunReason?: NotRunReason;
  /** Every transport attempt behind this result, kept whether it worked or not. */
  readonly transportAttempts?: readonly TransportAttempt[];
}

export interface SubstrateCapabilities {
  readonly filesystemEnforcement: EnforcementState;
  readonly processEnforcement: EnforcementState;
  readonly networkEnforcement: EnforcementState;
  readonly credentialProtection: EnforcementState;
  readonly hostEscapeProtection: EnforcementState;
  readonly canWrite: boolean;
  readonly canExecute: boolean;
}

export interface SubstrateQualification {
  readonly probe: SubstrateProbe;
  readonly capabilities: SubstrateCapabilities;
  readonly tests: readonly QualificationResult[];
  readonly enforcementClass: EnforcementClass;
  /**
   * Whether this attempt measured anything at all.
   *
   * `enforcementClass` is only a statement ABOUT THIS MACHINE when this is MEASURED. When it
   * is NOT_MEASURED the class is NONE for authority purposes and means "nothing was proved",
   * which is why no owner-facing surface may print the class without this beside it.
   */
  readonly attempt: QualificationAttempt;
  /** Whether the execution environment could be reached during this attempt. */
  readonly availability: ExecutionAvailability;
  /** Present whenever the class is not HARD. Names the first blocking reason. */
  readonly blockedBy?: string;
  readonly qualifiedAt: string;
  /** A qualification is valid only for the engine version it was measured against. */
  readonly engineVersion: string;
  /**
   * What this qualification is a measurement OF: engine version, transport, guest
   * kernel and distribution, launcher and its version.
   *
   * Compared rather than trusted. A qualification is a measurement of one machine in
   * one configuration; when the configuration changes underneath it the measurement
   * describes something that no longer exists, and `qualificationIsStale` is how a
   * caller finds that out before running a Producer on the strength of it.
   */
  readonly fingerprint: string;
  /**
   * Whether every component of the fingerprint was actually measured.
   *
   * A digest built partly from `UNKNOWN` still hashes to something, and that something
   * changes the moment the missing probe starts answering — which reads as "the machine
   * changed" to anything comparing digests. When this is false the fingerprint identifies
   * nothing and comparisons involving it are UNKNOWN.
   */
  readonly fingerprintComplete?: boolean;
  /** Which components could not be measured. Named, so a reader can see what is missing. */
  readonly fingerprintUnmeasured?: readonly string[];
  /**
   * WHICH boundary this qualification measured.
   *
   * A qualification without a subject is the defect that made a WSL2 measurement
   * authorize a native-Windows Producer: everything checked `enforcementClass === HARD`
   * and nothing asked what had been qualified. Authority now travels with its subject.
   */
  readonly boundary: ExecutionBoundary;
}

/**
 * Has the machine changed since this qualification was measured?
 *
 * A timestamp would not answer this: a qualification an hour old on an unchanged
 * machine is fine, and one a minute old is worthless if the kernel was upgraded in
 * between.
 */
export function qualificationIsStale(
  qualification: SubstrateQualification,
  currentFingerprint: string,
): boolean {
  return qualification.fingerprint !== currentFingerprint;
}

export interface ExecuteRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** Paths the command may write. Anything else is refused by the substrate. */
  readonly writeScope: readonly string[];
  /** Paths that must remain readable even where a default would mask them. */
  readonly readScope?: readonly string[];
  /**
   * Paths masked entirely: the Serva store, credential directories, other runs.
   *
   * Masking rather than denying, because a denied directory that still exists is a
   * directory whose contents can sometimes be reached another way.
   */
  readonly denyRead?: readonly string[];
  readonly networkAllowed: boolean;
}

export interface ExecuteResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: { stdout: boolean; stderr: boolean };
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  /** True when the substrate itself refused, as opposed to the command failing. */
  readonly refusedBySubstrate: boolean;
  readonly refusalReason?: string;
  /**
   * Whether the command reached the execution environment.
   *
   * Travels with every result so a caller never has to infer it from an exit code. An exit
   * code from a command that never started is not a fact about containment, and treating it
   * as one is what made engineering authority nondeterministic on a Windows host.
   */
  readonly reach: GuestReach;
  /** Every transport attempt behind this result, kept whether it worked or not. */
  readonly transportAttempts?: readonly TransportAttempt[];
}

export interface ExecutionSubstrate {
  readonly id: string;
  probe(): Promise<SubstrateProbe>;
  /** Run the adversarial tests. Expensive and side-effecting on a fixture workspace. */
  qualify(fixtureDir: string): Promise<SubstrateQualification>;
  capabilities(): Promise<SubstrateCapabilities>;
  execute(request: ExecuteRequest): Promise<ExecuteResult>;
  /** Human-readable account of what was measured, and what was not. */
  explain(): Promise<string>;
}

/**
 * The single question the whole factory turns on.
 *
 * Returns the reason a substrate may not carry engineering authority, or undefined.
 * Every caller that is about to grant write or execute capability asks this first.
 */
export function engineeringAuthorityRefusal(q: SubstrateQualification): string | undefined {
  /*
   * NOT MEASURED IS NOT A CLASS, AND IT GRANTS NOTHING.
   *
   * SPEC: Phase 6 qualification transport invariant §1, §5.
   *
   * Checked before the class, and phrased as what it is. An attempt that never reached the
   * execution environment says nothing about this machine — so authority is refused, but the
   * refusal must not read as a containment finding. An owner told "your substrate is NONE"
   * goes looking for a broken sandbox; an owner told "the guest could not be reached" goes
   * and looks at WSL, which is where the problem actually is.
   */
  if (q.attempt !== QualificationAttempt.MEASURED) {
    return (
      'This machine was not measured (' +
      q.attempt +
      '), so no engineering authority can rest on it. ' +
      (q.blockedBy ?? 'No qualifying evidence was produced.')
    );
  }

  /*
   * MEASURED HARD IS STILL NOT ENOUGH IF THE PATH IS GONE.
   *
   * A qualification is a statement about a boundary that existed when it was measured.
   * Producer dispatch also needs that boundary to be reachable NOW, and preserving a HARD
   * measurement across an outage — which §4 requires — would otherwise quietly authorise a
   * Producer against a guest nobody can currently talk to.
   */
  if (q.availability === ExecutionAvailability.UNREACHABLE) {
    return (
      'The execution environment is currently unreachable, so a Producer cannot be dispatched ' +
      'even though this machine measured ' +
      q.enforcementClass +
      '. ' +
      (q.blockedBy ?? '')
    ).trim();
  }

  if (q.enforcementClass !== EnforcementClass.HARD) {
    return (
      'Execution substrate is ' +
      q.enforcementClass +
      ', and engineering write/execute authority requires HARD. ' +
      (q.blockedBy ?? 'No qualifying evidence was produced.')
    );
  }
  const failed = q.tests.filter((t) => t.blocking && t.outcome !== 'PASSED');
  if (failed.length > 0) {
    return (
      'Substrate reports HARD but blocking qualification tests did not pass: ' +
      failed.map((t) => t.id + ' (' + t.outcome + ')').join(', ')
    );
  }
  if (!q.capabilities.canWrite || !q.capabilities.canExecute) {
    return 'Substrate does not enforce both write and execute boundaries.';
  }
  return undefined;
}

/**
 * Derive the class from the tests, rather than letting an implementation assert one.
 *
 * A substrate cannot talk its way to HARD: every blocking test must have PASSED, and a test
 * that could not be run never counts towards it.
 *
 * For AUTHORITY, "we could not check whether it escapes" and "it escapes" are the same fact:
 * neither grants anything. For REPORTING they are not remotely the same, and conflating them
 * is what let an intermittent WSL transport print `Q-A FAILED: the permitted write was
 * REFUSED` about a command that never ran. That is why the return carries `attempt` beside
 * the class: the class answers what may be granted, and the attempt answers whether anything
 * was learned.
 */
export function deriveEnforcementClass(
  tests: readonly QualificationResult[],
  capabilities: SubstrateCapabilities,
): {
  enforcementClass: EnforcementClass;
  attempt: QualificationAttempt;
  availability: ExecutionAvailability;
  blockedBy?: string;
} {
  const blocking = tests.filter((t) => t.blocking);
  if (blocking.length === 0) {
    return {
      enforcementClass: EnforcementClass.NONE,
      attempt: QualificationAttempt.NOT_MEASURED,
      availability: ExecutionAvailability.UNKNOWN,
      blockedBy: 'No blocking qualification test was run, so nothing was proved.',
    };
  }

  /*
   * TRANSPORT FIRST, AND NOTHING ELSE MATTERS UNTIL IT PASSES.
   *
   * A blocking probe that never reached the guest means this attempt measured nothing. The
   * enforcement class returned alongside it is NONE — which is the only safe authority
   * answer, since nothing may be granted on the strength of an absent measurement — but the
   * ATTEMPT says NOT_MEASURED, and every caller that reports to a person must read that
   * rather than the class. A machine whose WSL was busy is not a machine without a boundary.
   */
  const unreached = blocking.filter(
    (t) => t.outcome === 'NOT_RUN' && t.notRunReason === NotRunReason.TRANSPORT_FAILURE,
  );
  if (unreached.length > 0) {
    const first = unreached[0]!;
    return {
      enforcementClass: EnforcementClass.NONE,
      attempt: QualificationAttempt.NOT_MEASURED,
      availability: ExecutionAvailability.UNREACHABLE,
      blockedBy:
        first.id +
        ' never reached the execution environment, so this machine was not measured: ' +
        first.detail,
    };
  }

  const notPassed = blocking.filter((t) => t.outcome !== 'PASSED');
  if (notPassed.length > 0) {
    const first = notPassed[0]!;
    return {
      enforcementClass:
        capabilities.filesystemEnforcement === EnforcementState.ENFORCED
          ? EnforcementClass.SOFT
          : EnforcementClass.NONE,
      /*
       * Reached, and did not pass. That IS a measurement, and it is not retried: a genuine
       * containment failure that gets re-run until it agrees with you is not a check.
       */
      attempt: QualificationAttempt.MEASURED,
      availability: ExecutionAvailability.AVAILABLE,
      blockedBy: first.id + ' ' + first.outcome + ': ' + first.detail,
    };
  }
  const dims: readonly [string, EnforcementState][] = [
    ['filesystem', capabilities.filesystemEnforcement],
    ['process', capabilities.processEnforcement],
    ['network', capabilities.networkEnforcement],
    ['host escape', capabilities.hostEscapeProtection],
  ];
  const weak = dims.find(([, state]) => state !== EnforcementState.ENFORCED);
  if (weak !== undefined) {
    return {
      enforcementClass: EnforcementClass.SOFT,
      attempt: QualificationAttempt.MEASURED,
      availability: ExecutionAvailability.AVAILABLE,
      blockedBy: weak[0] + ' enforcement is ' + weak[1],
    };
  }
  return {
    enforcementClass: EnforcementClass.HARD,
    attempt: QualificationAttempt.MEASURED,
    availability: ExecutionAvailability.AVAILABLE,
  };
}
