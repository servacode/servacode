import { z } from 'zod';
import { EnforcementClass } from '../vocab/index.js';
import { ExecutionAvailability, QualificationAttempt } from './types.js';
import type { SubstrateQualification } from './types.js';
import type { Store } from '../store/store.js';

/**
 * THE LAST TIME THIS MACHINE WAS ACTUALLY MEASURED.
 *
 * SPEC: Phase 6 qualification transport invariant §4, §5, §6.
 *
 * A qualification is a measurement, and a measurement that could not be taken must not erase
 * the last one that was. Before this existed, a WSL outage overwrote a HARD result with NONE
 * and an owner watched their machine appear to lose its boundary because a transport was busy
 * for four seconds.
 *
 * So two facts are kept apart and both are persisted:
 *
 *   LAST VALID QUALIFICATION   the most recent attempt that actually measured something,
 *                              with the fingerprint of the machine it measured.
 *
 *   CURRENT ATTEMPT            what happened this time, which may be NOT_MEASURED.
 *
 * Keeping the first does NOT keep its authority. `producerAuthority` below requires the
 * preserved measurement AND a currently reachable execution path AND a fingerprint that still
 * matches — because a boundary that was real yesterday authorises nothing about a guest
 * nobody can talk to today.
 *
 * WORKING state rather than canon. A machine measurement is a fact about a computer, not
 * about the product being built, and it is expected to change when the computer does.
 */

export const WORKING_TYPE = 'substrateQualification';
const RECORD_ID = 'last-valid';

export const QualificationRecordSchema = z
  .object({
    enforcementClass: z.enum([EnforcementClass.HARD, EnforcementClass.SOFT, EnforcementClass.NONE]),
    /** What was measured: engine version, transport, kernel, distribution, launcher. */
    fingerprint: z.string().min(1),
    boundaryId: z.string().min(1),
    measuredAt: z.string().min(1),
    engineVersion: z.string().min(1),
    /** Kept so a reader can see what the measurement rested on without re-running it. */
    blockedBy: z.string().min(1).optional(),
    /** False when part of the fingerprint could not be measured, so it identifies nothing. */
    fingerprintComplete: z.boolean().optional(),
  })
  .strict();
export type QualificationRecord = z.output<typeof QualificationRecordSchema>;

/** The last attempt that measured something, or `undefined` if this machine never has. */
export function lastValidQualification(store: Store): QualificationRecord | undefined {
  const envelope = store.getWorking<unknown>(WORKING_TYPE, RECORD_ID);
  if (envelope === undefined) return undefined;
  const parsed = QualificationRecordSchema.safeParse(envelope.body);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Record a qualification, but ONLY if it measured something.
 *
 * The guard is the whole point of this function and it is deliberately not optional. An
 * attempt that never reached the guest describes nothing, and writing it here would destroy
 * the last real measurement with a non-measurement — which is the defect this module exists
 * to prevent, and which would be trivially reintroduced by an `if` in a caller.
 */
export function recordQualification(
  store: Store,
  qualification: SubstrateQualification,
): QualificationRecord | undefined {
  if (qualification.attempt !== QualificationAttempt.MEASURED) return undefined;

  const record: QualificationRecord = QualificationRecordSchema.parse({
    enforcementClass: qualification.enforcementClass,
    fingerprint: qualification.fingerprint,
    boundaryId: qualification.boundary.boundaryId,
    measuredAt: qualification.qualifiedAt,
    engineVersion: qualification.engineVersion,
    ...(qualification.fingerprintComplete === undefined
      ? {}
      : { fingerprintComplete: qualification.fingerprintComplete }),
    ...(qualification.blockedBy === undefined ? {} : { blockedBy: qualification.blockedBy }),
  });

  const tx = store.begin();
  tx.putWorking(WORKING_TYPE, RECORD_ID, record);
  tx.commit();
  return record;
}

export const FingerprintComparison = {
  MATCHES: 'MATCHES',
  DIFFERS: 'DIFFERS',
  /** The current machine could not be inspected, so there is nothing to compare against. */
  UNKNOWN: 'UNKNOWN',
} as const;
export type FingerprintComparison =
  (typeof FingerprintComparison)[keyof typeof FingerprintComparison];

/**
 * Does the preserved measurement still describe this machine?
 *
 * SPEC: §6.
 *
 * A transport failure is NOT evidence that the machine changed, and it must never be reported
 * as though it were. When the current attempt measured nothing there is no current
 * fingerprint to compare, and the honest answer is UNKNOWN — not DIFFERS, which would tell an
 * owner their machine had changed underneath them, and not MATCHES, which would claim the old
 * fingerprint describes a guest Serva cannot currently see.
 */
export function compareFingerprint(
  record: QualificationRecord | undefined,
  current: SubstrateQualification,
): FingerprintComparison {
  if (record === undefined) return FingerprintComparison.UNKNOWN;
  if (current.attempt !== QualificationAttempt.MEASURED) return FingerprintComparison.UNKNOWN;

  /*
   * A digest built partly from `UNKNOWN` identifies nothing.
   *
   * The live evidence caught this: `engineVersion` reads UNKNOWN when its probe does not
   * answer and a real version when it does, so the digest changed on an untouched machine and
   * Serva reported `fingerprint DIFFERS`. Comparing two strings is easy; the question is
   * whether either string is a measurement, and when one is not the only honest answer is
   * that the comparison could not be made.
   */
  if (record.fingerprintComplete === false || current.fingerprintComplete === false) {
    return FingerprintComparison.UNKNOWN;
  }

  return record.fingerprint === current.fingerprint
    ? FingerprintComparison.MATCHES
    : FingerprintComparison.DIFFERS;
}

export const ProducerAuthority = {
  /** A Producer may be dispatched. */
  AVAILABLE: 'AVAILABLE',
  /** Everything else. The reason says which, in the owner's terms. */
  BLOCKED: 'BLOCKED',
} as const;
export type ProducerAuthority = (typeof ProducerAuthority)[keyof typeof ProducerAuthority];

export interface ProducerAuthorityView {
  readonly authority: ProducerAuthority;
  /** The preserved measurement, whatever the current attempt did. */
  readonly lastValid?: QualificationRecord;
  readonly attempt: QualificationAttempt;
  readonly availability: ExecutionAvailability;
  readonly fingerprint: FingerprintComparison;
  readonly reason: string;
}

/**
 * May a Producer run right now?
 *
 * SPEC: §5.
 *
 * Preserving a HARD measurement across an outage is NOT permission to use it. This is the
 * conjunction that decides, and each clause is here because dropping it would authorise a
 * Producer against something nobody has checked:
 *
 *   a current attempt that MEASURED this machine
 *   a measured class of HARD
 *   an execution path reachable NOW
 *
 * Note what is NOT in that list. A fingerprint matching a STORED record is not required when
 * the current attempt measured this machine — nothing stored is being relied on. The stored
 * record matters when the current attempt measured nothing, and in that case authority is
 * refused regardless.
 *
 * The reason is written for an owner rather than a log, because the difference between
 * "your machine has no boundary" and "WSL is not answering" is the difference between a day
 * of debugging and restarting a distribution.
 */
export function producerAuthority(
  record: QualificationRecord | undefined,
  current: SubstrateQualification,
): ProducerAuthorityView {
  const fingerprint = compareFingerprint(record, current);
  const base = {
    ...(record === undefined ? {} : { lastValid: record }),
    attempt: current.attempt,
    availability: current.availability,
    fingerprint,
  };

  if (current.attempt !== QualificationAttempt.MEASURED) {
    return {
      ...base,
      authority: ProducerAuthority.BLOCKED,
      reason:
        record === undefined
          ? 'This machine has never been measured, and this attempt did not reach the execution environment.'
          : 'The execution environment could not be reached, so nothing was measured this time. ' +
            'The last valid measurement (' +
            record.enforcementClass +
            ', ' +
            record.measuredAt +
            ') is preserved and is not being used, because it says nothing about a guest Serva ' +
            'cannot currently talk to.',
    };
  }

  if (current.availability !== ExecutionAvailability.AVAILABLE) {
    return {
      ...base,
      authority: ProducerAuthority.BLOCKED,
      reason: 'The execution environment is not currently available.',
    };
  }

  if (current.enforcementClass !== EnforcementClass.HARD) {
    return {
      ...base,
      authority: ProducerAuthority.BLOCKED,
      reason:
        'This machine measured ' +
        current.enforcementClass +
        ', and a Producer requires HARD. ' +
        (current.blockedBy ?? ''),
    };
  }

  /*
   * A DIFFERING FINGERPRINT DOES NOT BLOCK A CURRENT MEASUREMENT.
   *
   * Staleness is about REUSING a stored qualification, and nothing is being reused here: this
   * attempt measured this machine, just now, and found HARD. The stored record has simply
   * been superseded, which is what `recordQualification` has already done with it.
   *
   * Getting this wrong produced exactly the flapping the invariant exists to remove. An
   * earlier draft blocked on DIFFERS even when the current attempt measured HARD, so a
   * machine whose fingerprint moved for any reason reported BLOCKED on one run and AVAILABLE
   * on the next — a different mechanism producing the same symptom, which is worth saying out
   * loud because it is the second time this shape of mistake appeared in this file.
   *
   * The comparison is still reported, because an owner seeing DIFFERS on an untouched machine
   * has learned something real about their environment.
   */
  return {
    ...base,
    authority: ProducerAuthority.AVAILABLE,
    reason:
      'Measured HARD on this machine, and the execution environment is reachable.' +
      (fingerprint === FingerprintComparison.DIFFERS
        ? ' The machine differs from the previous measurement, which has been superseded.'
        : ''),
  };
}
