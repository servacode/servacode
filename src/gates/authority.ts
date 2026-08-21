import { z } from 'zod';
import { WaiverState } from '../vocab/index.js';
import { isSafeSegment } from '../store/paths.js';
import type { Store } from '../store/store.js';

/**
 * Gate authority ports.
 *
 * The gate engine must decide two governance questions that a caller is not
 * permitted to answer for itself:
 *
 *   - is this criterion genuinely inapplicable in this scope?  (31 §2, 18 §2)
 *   - is this criterion genuinely covered by a waiver?          (09 §9, 18 §6)
 *
 * Both were previously accepted as caller assertions: a `NOT_APPLICABLE` value,
 * or a non-empty `waiverRef` string. Either one bypasses the criterion entirely,
 * so either one is an authority bypass. This module defines the NARROW resolver
 * interfaces the engine needs, plus deterministic store-backed implementations.
 *
 * Deliberately out of scope (later phases own these): waiver issuance, the owner
 * approval flow, the waiver register view, expiry notification, and any general
 * applicability rules engine. Nothing here creates, amends or expires a waiver —
 * it only RESOLVES and VALIDATES one.
 *
 * The fail-closed default matters more than the feature: when no authority is
 * wired in, `WAIVED` and conditional `NOT_APPLICABLE` are rejected rather than
 * trusted.
 */

/** 09 §2 — a policy waiver is an owner-only decision. Nothing else may grant one. */
export const WAIVER_REQUIRED_AUTHORITY = 'OWNER';

/** T-CANON type holding PolicyWaiver records (08 §3 — CANON entity). */
export const WAIVER_CANON_TYPE = 'policyWaiver';

/**
 * 09 §9 PolicyWaiver, narrowed to the fields the gate engine must verify.
 *
 * `expiresAt` is mandatory: W-1 states an indefinite waiver is not permitted, so
 * an absent expiry is a malformed record rather than "never expires".
 */
export const WaiverRecordSchema = z
  .object({
    id: z.string().min(1),
    /** GW-1 — a waiver is scoped to a specific criterion of a specific gate. */
    gateRef: z.string().min(1),
    criterionRef: z.string().min(1),
    /** The specific subject (work item, artifact, feature) the waiver covers. */
    scope: z.string().min(1),
    state: z.enum([
      WaiverState.ACTIVE,
      WaiverState.EXPIRED,
      WaiverState.REMEDIATED,
      WaiverState.REVOKED,
    ]),
    expiresAt: z.string().datetime(),
    authority: z.string().min(1),
    justification: z.string().min(1),
  })
  .strict();

export type WaiverRecord = z.output<typeof WaiverRecordSchema>;

/**
 * The only capability the gate engine requires of the waiver subsystem.
 *
 * `resolve` returns undefined for an unknown reference. It must never invent a
 * record: an unresolvable reference means the waiver does not exist, which the
 * engine treats as "not waived".
 */
export interface WaiverAuthority {
  resolve(waiverRef: string): WaiverRecord | undefined;
}

/** The outcome of resolving one criterion's applicability condition. */
export interface ApplicabilityDetermination {
  readonly condition: string;
  readonly applies: boolean;
  readonly resolvedBy: string;
}

/**
 * The only capability the gate engine requires to accept `NOT_APPLICABLE`.
 *
 * `resolve` returns undefined when the condition is not registered. An
 * unrecognised condition is not an implicit "does not apply" — it is a gap the
 * engine must refuse to paper over.
 */
export interface ApplicabilityAuthority {
  resolve(condition: string, scope: string): ApplicabilityDetermination | undefined;
}

/**
 * Deterministic waiver resolution across the T-CANON boundary.
 *
 * A waiver is a CANON record like any other, so it inherits canon integrity
 * verification: a waiver edited out of band fails its digest check on read
 * rather than quietly authorising a gate.
 */
export class StoreWaiverAuthority implements WaiverAuthority {
  constructor(private readonly store: Store) {}

  resolve(waiverRef: string): WaiverRecord | undefined {
    // An unusable reference cannot name a record. Checked without throwing so a
    // malformed reference reads as "no such waiver" rather than as a store fault.
    if (!isSafeSegment(waiverRef)) return undefined;
    const env = this.store.getCanon<unknown>(WAIVER_CANON_TYPE, waiverRef);
    if (env === undefined) return undefined;
    const parsed = WaiverRecordSchema.safeParse(env.body);
    // A malformed waiver record grants nothing. Fail closed.
    return parsed.success ? parsed.data : undefined;
  }
}

/**
 * A named applicability condition, evaluated against STORED STATE.
 *
 * Deliberately the same shape as a workflow step's exitCondition: the project
 * already treats "a predicate over the store" as the way a runtime decides
 * something a participant may not simply assert.
 */
export type ApplicabilityCondition = (store: Store, scope: string) => boolean;

/**
 * Applicability resolution from a registry of named conditions.
 *
 * This is the minimum deterministic contract that keeps `NOT_APPLICABLE` from
 * being a naked assertion. It is not an applicability subsystem: it registers no
 * conditions of its own and offers no way to define one at runtime.
 */
export class ConditionRegistry implements ApplicabilityAuthority {
  constructor(
    private readonly store: Store,
    private readonly conditions: ReadonlyMap<string, ApplicabilityCondition>,
  ) {}

  resolve(condition: string, scope: string): ApplicabilityDetermination | undefined {
    const fn = this.conditions.get(condition);
    if (fn === undefined) return undefined;
    return { condition, applies: fn(this.store, scope), resolvedBy: 'CONDITION_REGISTRY' };
  }
}

/** Is the waiver usable at this instant? W-4/GW-5 — an expired waiver re-blocks. */
export function waiverProblem(
  waiver: WaiverRecord,
  gateRef: string,
  criterionRef: string,
  scope: string,
  now: string,
): string | undefined {
  if (waiver.gateRef !== gateRef) {
    return 'waiver targets gate ' + waiver.gateRef + ', not ' + gateRef;
  }
  if (waiver.criterionRef !== criterionRef) {
    return 'waiver targets criterion ' + waiver.criterionRef + ', not ' + criterionRef;
  }
  if (waiver.scope !== scope) {
    return 'waiver is scoped to ' + waiver.scope + ', not ' + scope;
  }
  if (waiver.state !== WaiverState.ACTIVE) {
    return 'waiver state is ' + waiver.state;
  }
  if (Date.parse(waiver.expiresAt) <= Date.parse(now)) {
    return 'waiver expired at ' + waiver.expiresAt;
  }
  if (waiver.authority !== WAIVER_REQUIRED_AUTHORITY) {
    return (
      'waiver authority is ' +
      waiver.authority +
      '; a policy waiver requires ' +
      WAIVER_REQUIRED_AUTHORITY +
      ' (09 §2)'
    );
  }
  return undefined;
}
