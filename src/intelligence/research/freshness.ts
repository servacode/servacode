import { ValidityState } from '../../vocab/index.js';
import type { Clock } from '../../core/clock.js';

/**
 * RESEARCH FRESHNESS — competitive truth expires.
 *
 * SPEC: §16, 11 §6, 31 §3 (validity), SC-RTC-004.
 *
 * A competitor ships a feature; a price changes; a gap closes. None of these events notify
 * Serva, so the only honest model is that research-backed conclusions have a shelf life and
 * a gate must be able to tell whether it is looking at current truth.
 *
 * Two properties matter and are easy to get wrong:
 *
 *   staleness PROPAGATES. If the finding underneath a differentiator expired, the
 *   differentiator is stale too, even though nobody touched it. Marking only the leaf
 *   leaves a confident conclusion resting on an expired fact.
 *
 *   old research is NOT deleted. A decision made in March relied on what was known in
 *   March, and erasing that makes the rationale unreadable. A refresh creates a new
 *   version; the old one stays exactly where it was.
 */

export interface FreshnessSubject {
  readonly id: string;
  readonly validUntil?: string;
  /** What this rests on. Staleness flows along these edges. */
  readonly dependsOn?: readonly string[];
}

export interface FreshnessVerdict {
  readonly id: string;
  readonly state: ValidityState;
  readonly reason: string;
  /** The expired thing that caused this, when the subject itself has not expired. */
  readonly causedBy?: string;
}

/**
 * Compute validity across a dependency graph.
 *
 * Directly expired subjects go STALE; anything transitively depending on a stale subject
 * goes STALE with the cause named, so a reader can see WHY a conclusion stopped counting
 * without tracing the graph by hand.
 *
 * A missing dependency is treated as stale rather than ignored: a conclusion resting on
 * something Serva can no longer find is not current truth either.
 */
export function assessFreshness(
  subjects: readonly FreshnessSubject[],
  clock: Clock,
): readonly FreshnessVerdict[] {
  const now = Date.parse(clock.now());
  const byId = new Map(subjects.map((s) => [s.id, s]));
  const verdicts = new Map<string, FreshnessVerdict>();

  // Direct expiry first: everything else is derived from it.
  for (const s of subjects) {
    if (s.validUntil === undefined) {
      verdicts.set(s.id, {
        id: s.id,
        state: ValidityState.VALID,
        reason: 'does not expire',
      });
      continue;
    }
    const expired = Date.parse(s.validUntil) <= now;
    verdicts.set(s.id, {
      id: s.id,
      state: expired ? ValidityState.STALE : ValidityState.VALID,
      reason: expired
        ? 'valid_until ' + s.validUntil + ' has passed'
        : 'valid until ' + s.validUntil,
    });
  }

  /*
   * Propagate. Iterating to a fixed point rather than recursing keeps a dependency cycle
   * from becoming a stack overflow — cycles are a modelling error, not a crash.
   */
  let changed = true;
  let guard = 0;
  while (changed && guard < subjects.length + 1) {
    changed = false;
    guard += 1;
    for (const s of subjects) {
      const current = verdicts.get(s.id);
      if (current === undefined || current.state === ValidityState.STALE) continue;
      for (const depId of s.dependsOn ?? []) {
        const dep = byId.get(depId);
        if (dep === undefined) {
          verdicts.set(s.id, {
            id: s.id,
            state: ValidityState.STALE,
            reason: 'rests on ' + depId + ', which is not present',
            causedBy: depId,
          });
          changed = true;
          break;
        }
        if (verdicts.get(depId)?.state === ValidityState.STALE) {
          verdicts.set(s.id, {
            id: s.id,
            state: ValidityState.STALE,
            reason: 'rests on ' + depId + ', which is stale',
            causedBy: depId,
          });
          changed = true;
          break;
        }
      }
    }
  }

  return subjects.map(
    (s) => verdicts.get(s.id) ?? { id: s.id, state: ValidityState.VALID, reason: 'not assessed' },
  );
}

/** The stale ones, which is what a gate actually needs. */
export function staleSubjects(verdicts: readonly FreshnessVerdict[]): readonly FreshnessVerdict[] {
  return verdicts.filter((v) => v.state === ValidityState.STALE);
}

/** Default shelf lives. Prices age fastest; an architecture pattern barely ages at all. */
export const DEFAULT_VALIDITY_DAYS: Readonly<Record<string, number>> = Object.freeze({
  PRICING: 30,
  COMPETITOR_FEATURES: 90,
  MARKET_LANDSCAPE: 180,
  REGULATORY: 180,
  TECHNOLOGY_CAPABILITY: 365,
});

export function validUntilFrom(retrievedAt: string, days: number): string {
  return new Date(Date.parse(retrievedAt) + days * 86_400_000)
    .toISOString()
    .replace(/\.\d+Z$/, '.000Z');
}
