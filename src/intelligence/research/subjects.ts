import { ARTIFACT_TYPES, repository } from '../repository.js';
import {
  CompetitivePositionSchema,
  DifferentiatorSchema,
  MarketGapSchema,
  ResearchFindingSchema,
  TableStakesSchema,
} from '../artifacts/market.js';
import type { FreshnessSubject } from './freshness.js';
import type { Store } from '../../store/store.js';

/**
 * The market freshness graph, built once.
 *
 * Every consumer must pass the WHOLE graph: findings expire directly, and table stakes,
 * gaps, differentiators and the position inherit it. A caller that passes only findings
 * and positions gets a position that appears to rest on differentiators "which are not
 * present" — and `assessFreshness` correctly, uselessly, reports it as stale.
 *
 * That is not a flaw in the propagation. It is why the subject list is built in one place
 * rather than assembled by each caller from whichever artifacts it happened to load.
 */
export function marketFreshnessSubjects(store: Store): readonly FreshnessSubject[] {
  const findings = repository(store, ARTIFACT_TYPES.RESEARCH_FINDING, ResearchFindingSchema).list();
  const stakes = repository(store, ARTIFACT_TYPES.TABLE_STAKES, TableStakesSchema).list();
  const gaps = repository(store, ARTIFACT_TYPES.MARKET_GAP, MarketGapSchema).list();
  const diffs = repository(store, ARTIFACT_TYPES.DIFFERENTIATOR, DifferentiatorSchema).list();
  const positions = repository(
    store,
    ARTIFACT_TYPES.COMPETITIVE_POSITION,
    CompetitivePositionSchema,
  ).list();

  return [
    ...findings.map((f) => ({ id: f.id, validUntil: f.freshness.validUntil })),
    ...stakes.map((t) => ({ id: t.id, dependsOn: t.evidenceRefs.map((r) => r.id) })),
    ...gaps.map((g) => ({ id: g.id, dependsOn: g.evidenceRefs.map((r) => r.id) })),
    ...diffs.map((d) => ({ id: d.id, dependsOn: d.evidenceRefs.map((r) => r.id) })),
    ...positions.map((p) => ({
      id: p.id,
      validUntil: p.freshness.validUntil,
      dependsOn: p.differentiatorRefs.map((r) => r.id),
    })),
  ];
}
