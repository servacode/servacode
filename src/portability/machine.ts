import { z } from 'zod';
import { canonicalJson, digestOf } from '../core/hash.js';
import { IsoSchema } from '../domain/schemas.js';

/**
 * MACHINE IDENTITY — QUALIFICATION IS LOCAL, AND IT DOES NOT TRAVEL.
 *
 * SPEC: §24, §29, Phase 4 boundary model, 33 PC-5.
 *
 * The dangerous idea this file exists to prevent is a single line in a restore routine:
 * copy the qualification record across with everything else. It is the obvious thing to
 * do — the owner backed up a working machine and restored it, so surely the machine works
 * — and it would mean a Producer running write-capable inside a sandbox nobody had
 * measured, on a computer that might not even have bubblewrap installed.
 *
 * So HARD is a property of THIS machine, established by measuring THIS machine, and a
 * restored project begins UNQUALIFIED however green the backup was. That is not caution;
 * it is the difference between a security control and a note saying a control once
 * existed.
 *
 * `MachineIdentity` binds the facts that would change what containment actually means. The
 * fingerprint covers all of them, so a distro upgrade, a Node change, a different Claude
 * binary or a sandbox mechanism swap all invalidate qualification automatically rather
 * than requiring somebody to notice.
 */

export const MachineIdentitySchema = z
  .object({
    /** Host operating system as reported by the platform, e.g. `win32`. */
    platform: z.string().min(1),
    /** Host release string. A Windows feature update changes containment behaviour. */
    release: z.string().min(1),
    architecture: z.string().min(1),
    /** WSL version where execution crosses into a guest. */
    wslVersion: z.string().min(1).optional(),
    /** The guest distribution execution actually happens in. */
    guestDistro: z.string().min(1).optional(),
    guestKernel: z.string().min(1).optional(),
    /** The non-root guest user. Running as root is a different boundary entirely. */
    guestUser: z.string().min(1).optional(),
    nodeVersion: z.string().min(1),
    /** The engine binary, by absolute path in the environment it runs in. */
    claudeLocation: z.string().min(1).optional(),
    claudeVersion: z.string().min(1).optional(),
    /** What actually contains a process: `bubblewrap`, `claude-sandbox-runtime`, … */
    sandboxMechanism: z.string().min(1).optional(),
    sandboxVersion: z.string().min(1).optional(),
    /** Digest of the sandbox settings measured under. Part of the boundary, not decoration. */
    executionPolicyDigest: z.string().min(1).optional(),
    /**
     * Whether Windows interop is enabled inside the guest.
     *
     * Recorded because it is a containment property and because it is the thing somebody
     * turns back on when a test is easier with it. A change here invalidates the
     * fingerprint, which is exactly the intent.
     */
    interopEnabled: z.boolean().optional(),
  })
  .strict();
export type MachineIdentityFacts = z.output<typeof MachineIdentitySchema>;

export interface MachineIdentity extends MachineIdentityFacts {
  /** Digest over every field above, in a fixed order. The value callers compare. */
  readonly fingerprint: string;
}

/** Build a machine identity. Every recorded fact is inside the fingerprint. */
export function machineIdentity(facts: MachineIdentityFacts): MachineIdentity {
  const parsed = MachineIdentitySchema.parse(facts);
  const material = {
    platform: parsed.platform,
    release: parsed.release,
    architecture: parsed.architecture,
    wslVersion: parsed.wslVersion ?? null,
    guestDistro: parsed.guestDistro ?? null,
    guestKernel: parsed.guestKernel ?? null,
    guestUser: parsed.guestUser ?? null,
    nodeVersion: parsed.nodeVersion,
    claudeLocation: parsed.claudeLocation ?? null,
    claudeVersion: parsed.claudeVersion ?? null,
    sandboxMechanism: parsed.sandboxMechanism ?? null,
    sandboxVersion: parsed.sandboxVersion ?? null,
    executionPolicyDigest: parsed.executionPolicyDigest ?? null,
    interopEnabled: parsed.interopEnabled ?? null,
  };
  return { ...parsed, fingerprint: digestOf(canonicalJson(material)) };
}

export const MachineQualificationState = {
  /** Never measured here, or invalidated. The state a restored machine starts in. */
  UNQUALIFIED: 'UNQUALIFIED',
  /** Measured, and the boundary does not contain a Producer. Read-only work only. */
  SOFT: 'SOFT',
  /** Measured, and containment holds. Write-capable engineering may run. */
  HARD: 'HARD',
  /** Measured and refused: something about this machine is actively unsafe. */
  BLOCKED: 'BLOCKED',
} as const;
export type MachineQualificationState =
  (typeof MachineQualificationState)[keyof typeof MachineQualificationState];

export const MachineQualificationSchema = z
  .object({
    machineId: z.string().min(1),
    identity: MachineIdentitySchema,
    fingerprint: z.string().min(1),
    state: z.enum([
      MachineQualificationState.UNQUALIFIED,
      MachineQualificationState.SOFT,
      MachineQualificationState.HARD,
      MachineQualificationState.BLOCKED,
    ]),
    qualifiedAt: IsoSchema.optional(),
    /** The qualification cases actually executed, with their results. */
    cases: z
      .array(
        z
          .object({
            id: z.string().min(1),
            passed: z.boolean(),
            detail: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    reason: z.string().min(1),
    /**
     * True when this record came out of a backup rather than out of a measurement.
     *
     * It exists so a restored record cannot be mistaken for a measured one even by code
     * that forgets to check the state — and so the UI can say plainly WHY the machine is
     * unqualified instead of implying the owner did something wrong.
     */
    restoredFromBackup: z.boolean().default(false),
  })
  .strict();
export type MachineQualification = z.output<typeof MachineQualificationSchema>;

export const MACHINE_QUALIFICATION_TYPE = 'machine.qualification';

/** The state a machine begins in, and the state a restored one returns to. */
export function unqualified(o: {
  readonly machineId: string;
  readonly identity: MachineIdentityFacts;
  readonly reason: string;
  readonly restoredFromBackup?: boolean;
}): MachineQualification {
  const identity = machineIdentity(o.identity);
  return MachineQualificationSchema.parse({
    machineId: o.machineId,
    identity: o.identity,
    fingerprint: identity.fingerprint,
    state: MachineQualificationState.UNQUALIFIED,
    cases: [],
    reason: o.reason,
    restoredFromBackup: o.restoredFromBackup ?? false,
  });
}

/**
 * Is this qualification still the truth about the machine in front of us?
 *
 * Returns the reason it is not, or undefined. Deliberately compares the FINGERPRINT rather
 * than the state: a record can say HARD and describe a computer that no longer exists,
 * and that is precisely the case a restore produces.
 */
export function qualificationRefusal(
  record: MachineQualification | undefined,
  actual: MachineIdentity,
): string | undefined {
  if (record === undefined) {
    return 'this machine has never been qualified, so write-capable engineering may not run on it';
  }
  if (record.restoredFromBackup) {
    return 'this qualification was restored from a backup rather than measured here. HARD is a property of a machine, not of a project: measure this machine before running write-capable work on it.';
  }
  if (record.fingerprint !== actual.fingerprint) {
    return (
      'the machine changed since it was qualified (' +
      describeIdentityDrift(record.identity, actual) +
      '), so the previous measurement no longer describes what would contain a Producer'
    );
  }
  if (record.state !== MachineQualificationState.HARD) {
    return 'this machine is ' + record.state + ', not HARD: ' + record.reason;
  }
  return undefined;
}

/** Which facts moved, field by field. A bare digest comparison tells nobody anything. */
export function describeIdentityDrift(
  before: MachineIdentityFacts,
  after: MachineIdentityFacts,
): string {
  const differences: string[] = [];
  const keys = Object.keys(MachineIdentitySchema.shape) as (keyof MachineIdentityFacts)[];
  for (const k of keys) {
    const a = before[k];
    const b = after[k];
    if (a === b) continue;
    differences.push(String(k) + ': ' + String(a ?? '(none)') + ' → ' + String(b ?? '(none)'));
  }
  return differences.length === 0 ? 'no recorded fact differs' : differences.join('; ');
}

/**
 * Facts a backup may never carry.
 *
 * Checked by the backup writer AND by the restore reader, because the two run on different
 * machines at different times and either one may be the older build.
 */
export const MACHINE_BOUND_KEYS: readonly string[] = Object.freeze([
  MACHINE_QUALIFICATION_TYPE,
  'machine.identity',
  'engineering.boundary',
  'engineering.osQualification',
]);
