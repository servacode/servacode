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
 * A substrate cannot talk its way to HARD: every blocking test must have PASSED, and a
 * test that could not be run counts against it exactly as a failure does. "We could not
 * check whether it escapes" and "it escapes" are the same fact for this decision.
 */
export function deriveEnforcementClass(
  tests: readonly QualificationResult[],
  capabilities: SubstrateCapabilities,
): { enforcementClass: EnforcementClass; blockedBy?: string } {
  const blocking = tests.filter((t) => t.blocking);
  if (blocking.length === 0) {
    return {
      enforcementClass: EnforcementClass.NONE,
      blockedBy: 'No blocking qualification test was run, so nothing was proved.',
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
      blockedBy: weak[0] + ' enforcement is ' + weak[1],
    };
  }
  return { enforcementClass: EnforcementClass.HARD };
}
