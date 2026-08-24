/**
 * WHAT KIND OF THING PRODUCED THIS EVIDENCE.
 *
 * SPEC: Phase 6 final acceptance sequence §4.
 *
 * A live acceptance is not uniformly live, and pretending otherwise is the easiest way to
 * overstate it. Some of the truth a legitimate chain rests on is pre-seeded deterministically —
 * a project, a git baseline, a requirement with a real acceptance oracle — because running the
 * entire New Product lifecycle live for ceremony proves nothing about the join and costs an
 * afternoon of model calls.
 *
 * Pre-seeding is legitimate. Pre-seeding LABELLED AS LIVE is not. So every part of the
 * evidence carries the class of thing that made it, and the report prints them separately.
 */
export const EvidenceOrigin = {
  /**
   * Written directly by the harness to establish valid project truth before any live work.
   *
   * Legitimate, and never a claim that upstream discovery ran. A `DETERMINISTIC_PRESEED`
   * requirement is a real requirement; it is not evidence that an agent produced one.
   */
  DETERMINISTIC_PRESEED: 'DETERMINISTIC_PRESEED',
  /** A real governed AgentRun against the real provider. */
  LIVE_MODEL: 'LIVE_MODEL',
  /** Measured on this physical machine: a boundary, a fingerprint, a sandbox probe. */
  LIVE_MACHINE: 'LIVE_MACHINE',
  /** Produced by a deterministic tool: a recipe, a digest, a git operation. */
  DETERMINISTIC_TOOL: 'DETERMINISTIC_TOOL',
  /** A person acted. Nothing automated may stand in for this. */
  OWNER_ACTION: 'OWNER_ACTION',
} as const;
export type EvidenceOrigin = (typeof EvidenceOrigin)[keyof typeof EvidenceOrigin];

export interface OriginatedRef {
  readonly origin: EvidenceOrigin;
  readonly kind: string;
  readonly id: string;
  readonly detail?: string;
}

/** Group refs by origin, so a report can never blur the classes together. */
export function byOrigin(
  refs: readonly OriginatedRef[],
): Readonly<Record<EvidenceOrigin, readonly OriginatedRef[]>> {
  const out = {
    [EvidenceOrigin.DETERMINISTIC_PRESEED]: [] as OriginatedRef[],
    [EvidenceOrigin.LIVE_MODEL]: [] as OriginatedRef[],
    [EvidenceOrigin.LIVE_MACHINE]: [] as OriginatedRef[],
    [EvidenceOrigin.DETERMINISTIC_TOOL]: [] as OriginatedRef[],
    [EvidenceOrigin.OWNER_ACTION]: [] as OriginatedRef[],
  };
  for (const ref of refs) out[ref.origin].push(ref);
  return out;
}
