import { canonicalJson, digestOf } from '../core/hash.js';

/**
 * WHICH boundary earned HARD, and whether it is the one about to be used.
 *
 * SPEC: Phase 4 execution-binding closure §2, 33 PC-5.
 *
 * The defect this exists to make impossible:
 *
 *   Serva qualified   Windows host -> WSL2 guest -> bubblewrap -> worktree
 *   The Producer ran  Windows host -> `claude.exe` -> native Windows, no sandbox
 *
 * Both were true at once, and every check in between passed, because the only question
 * anyone asked was `enforcementClass === HARD`. That question has no subject. A HARD
 * qualification is a measurement OF SOMETHING, and authority derived from it is
 * authority to run **that** thing — not to run something else that happens to be
 * running at the same time.
 *
 * So an enforcement class is never sufficient on its own. Every write- or exec-capable
 * dispatch compares two boundary identities and refuses on any difference. A boundary
 * is deliberately made of the facts that would change what is actually enforced:
 * change the guest, the engine binary, its version, the sandbox mechanism or the
 * profile it was measured under, and the earlier measurement describes a machine that
 * is not this one.
 */

export const BoundaryPurpose = {
  /** The engine session a Producer runs in: its tool calls and its Bash children. */
  PRODUCER: 'PRODUCER',
  /** Serva's own deterministic recipes: build, test, lint. No model involved. */
  RECIPE: 'RECIPE',
} as const;
export type BoundaryPurpose = (typeof BoundaryPurpose)[keyof typeof BoundaryPurpose];

export interface ExecutionBoundary {
  /** Stable name for the KIND of boundary, e.g. `SC-BOUNDARY-PRODUCER`. */
  readonly boundaryId: string;
  readonly purpose: BoundaryPurpose;
  /** Where processes run: `local`, or `wsl:<distro>`. */
  readonly transport: string;
  /** The guest's own identity, when execution crosses into one. */
  readonly guest?: string;
  /**
   * The absolute path of the engine executable IN THE EXECUTION ENVIRONMENT.
   *
   * `/usr/local/bin/claude` inside a distribution and `C:\...\claude.exe` on the host
   * are different programs under different kernels with different containment. Recording
   * the path is what makes "the engine we measured" a checkable claim rather than a name.
   */
  readonly engineLocation?: string;
  readonly engineVersion: string;
  /** What actually contains a process here: `claude-sandbox-runtime`, `bubblewrap`, … */
  readonly sandboxMechanism: string;
  readonly sandboxVersion?: string;
  /**
   * Digest of the sandbox settings the boundary was measured under.
   *
   * A profile is part of the boundary, not a decoration on it: the same mechanism with
   * `allowUnsandboxedCommands: true` is a different boundary in the only sense that
   * matters.
   */
  readonly profileDigest?: string;
  /** Whether this boundary is simulated. A simulation may never authorize a Producer. */
  readonly simulated: boolean;
  /** Digest over every field above. The single value callers compare. */
  readonly fingerprint: string;
}

export interface BoundaryFacts {
  readonly boundaryId: string;
  readonly purpose: BoundaryPurpose;
  readonly transport: string;
  readonly guest?: string;
  readonly engineLocation?: string;
  readonly engineVersion: string;
  readonly sandboxMechanism: string;
  readonly sandboxVersion?: string;
  readonly profileDigest?: string;
  readonly simulated?: boolean;
}

/** Build a boundary identity. The fingerprint covers every field, in a fixed order. */
export function executionBoundary(facts: BoundaryFacts): ExecutionBoundary {
  const simulated = facts.simulated === true;
  const material = {
    boundaryId: facts.boundaryId,
    purpose: facts.purpose,
    transport: facts.transport,
    guest: facts.guest ?? null,
    engineLocation: facts.engineLocation ?? null,
    engineVersion: facts.engineVersion,
    sandboxMechanism: facts.sandboxMechanism,
    sandboxVersion: facts.sandboxVersion ?? null,
    profileDigest: facts.profileDigest ?? null,
    simulated,
  };
  return {
    ...facts,
    simulated,
    fingerprint: digestOf(canonicalJson(material)),
  };
}

/** Human-readable, one line. Used in refusals and in the owner-facing status. */
export function describeBoundary(b: ExecutionBoundary): string {
  return (
    b.boundaryId +
    ' [' +
    b.transport +
    (b.guest === undefined ? '' : ' → ' + b.guest) +
    '] ' +
    b.sandboxMechanism +
    (b.sandboxVersion === undefined ? '' : ' ' + b.sandboxVersion) +
    (b.engineLocation === undefined ? '' : ', engine ' + b.engineLocation) +
    ' ' +
    b.engineVersion +
    (b.simulated ? ' (SIMULATED)' : '')
  );
}

/**
 * Why these two boundaries are not the same one, field by field.
 *
 * Returns undefined only when they are identical. Reported field by field rather than
 * as "fingerprints differ", because an operator who has just been refused needs to know
 * WHICH thing moved — and because a bare digest comparison tells nobody anything.
 */
export function boundaryMismatch(
  qualified: ExecutionBoundary,
  actual: ExecutionBoundary,
): string | undefined {
  if (qualified.fingerprint === actual.fingerprint) return undefined;

  const differences: string[] = [];
  const cmp = (label: string, a: unknown, b: unknown): void => {
    if (a !== b) {
      differences.push(
        label + ': qualified ' + String(a ?? '(none)') + ', actual ' + String(b ?? '(none)'),
      );
    }
  };
  cmp('purpose', qualified.purpose, actual.purpose);
  cmp('transport', qualified.transport, actual.transport);
  cmp('guest', qualified.guest, actual.guest);
  cmp('engine location', qualified.engineLocation, actual.engineLocation);
  cmp('engine version', qualified.engineVersion, actual.engineVersion);
  cmp('sandbox mechanism', qualified.sandboxMechanism, actual.sandboxMechanism);
  cmp('sandbox version', qualified.sandboxVersion, actual.sandboxVersion);
  cmp('sandbox profile', qualified.profileDigest, actual.profileDigest);
  cmp('simulated', qualified.simulated, actual.simulated);

  if (differences.length === 0) {
    // Same visible fields, different digest. Treat it as a mismatch anyway: an
    // unexplained difference is the one case where guessing would be worst.
    differences.push(
      'the boundary fingerprints differ although every recorded field matches, which means something material was not recorded',
    );
  }

  return (
    'EXECUTION_BOUNDARY_MISMATCH — a HARD qualification for one boundary does not authorize a run on another. ' +
    differences.join('; ')
  );
}
