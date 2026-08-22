import { ValidityState } from '../../vocab/index.js';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import {
  CompetitivePositionSchema,
  DifferentiatorSchema,
  MarketGapSchema,
  ResearchFindingSchema,
  TableStakesSchema,
} from '../artifacts/market.js';
import { ProposalSchema } from '../artifacts/governance.js';
import { assessFreshness } from '../research/freshness.js';
import type { Store } from '../../store/store.js';
import type { Clock } from '../../core/clock.js';

/**
 * THE PRODUCT ADVANTAGE BOARD — DERIVED, never authored.
 *
 * SPEC: §15, 11.
 *
 * Nothing here is canon. Every row is computed from artifacts that already exist, which
 * is the whole point: a board somebody could edit directly would become a second, more
 * convenient version of the truth, and within a quarter it would be the one people read.
 *
 * The two columns that make it worth having are the ones a status report normally omits.
 * REJECTED/DEFERRED keeps the reasoning for ideas the company has already declined, so the
 * same proposal is not re-argued from scratch every quarter. RESEARCH EXPIRY says which
 * conclusions have quietly stopped being current — a differentiator nobody touched can
 * become stale because the finding underneath it aged out.
 */

export interface AdvantageRow {
  readonly id: string;
  readonly statement: string;
  readonly detail: string;
  /** STALE when this rests on research that has expired. */
  readonly validity: ValidityState;
  readonly cause?: string;
}

export interface ProductAdvantageBoard {
  readonly tableStakes: readonly AdvantageRow[];
  readonly plannedDifferentiators: readonly AdvantageRow[];
  readonly experimentalOpportunities: readonly AdvantageRow[];
  readonly rejectedOrDeferred: readonly AdvantageRow[];
  readonly competitiveRisks: readonly AdvantageRow[];
  readonly researchExpiry: readonly AdvantageRow[];
  /** Present when no competitive position exists yet. */
  readonly note?: string;
}

export function buildAdvantageBoard(store: Store, clock: Clock): ProductAdvantageBoard {
  const findings = repository(store, ARTIFACT_TYPES.RESEARCH_FINDING, ResearchFindingSchema).list();
  const stakes = repository(store, ARTIFACT_TYPES.TABLE_STAKES, TableStakesSchema).list();
  const diffs = repository(store, ARTIFACT_TYPES.DIFFERENTIATOR, DifferentiatorSchema).list();
  const gaps = repository(store, ARTIFACT_TYPES.MARKET_GAP, MarketGapSchema).list();
  const positions = repository(
    store,
    ARTIFACT_TYPES.COMPETITIVE_POSITION,
    CompetitivePositionSchema,
  ).list();
  const proposals = repository(store, ARTIFACT_TYPES.PROPOSAL, ProposalSchema).list();

  /*
   * One freshness pass over the whole graph. Findings expire directly; everything that
   * cites them inherits it, so a conclusion resting on an expired fact shows as STALE
   * without anyone having to trace the edges by hand.
   */
  const subjects = [
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
  const verdicts = new Map(assessFreshness(subjects, clock).map((v) => [v.id, v]));

  const row = (id: string, statement: string, detail: string): AdvantageRow => {
    const v = verdicts.get(id);
    return {
      id,
      statement,
      detail,
      validity: v?.state ?? ValidityState.VALID,
      ...(v?.causedBy === undefined ? {} : { cause: v.causedBy }),
    };
  };

  const position = positions[positions.length - 1];

  return {
    tableStakes: stakes.map((t) => row(t.id, t.capability, t.whyExpected)),
    plannedDifferentiators: diffs.map((d) =>
      row(d.id, d.statement, 'defensibility ' + d.defensibility + ' — ' + d.defensibilityRationale),
    ),
    experimentalOpportunities: proposals
      .filter((p) => p.state === 'PROPOSED' || p.state === 'ASSESSED')
      .map((p) => row(p.id, p.title, p.assessment?.userOrBusinessValue ?? p.description)),
    /*
     * Kept, with the reasoning. This is the column that stops the company rediscovering
     * an idea it has already considered and declined.
     */
    rejectedOrDeferred: proposals
      .filter((p) => p.state === 'REJECTED' || p.state === 'DEFERRED')
      .map((p) => row(p.id, p.title, p.rejectionRationale ?? 'no rationale recorded')),
    competitiveRisks: [
      ...gaps.map((g) => row(g.id, g.description, 'confidence ' + g.confidence)),
      ...(position === undefined
        ? []
        : [row(position.id, 'Reason to stay with the incumbent', position.reasonToStay)]),
    ],
    researchExpiry: findings.map((f) =>
      row(f.id, f.question, 'valid until ' + f.freshness.validUntil),
    ),
    ...(position === undefined
      ? {
          note: 'No competitive position exists yet, so this board shows evidence rather than a position.',
        }
      : {}),
  };
}

/** Anything on the board that has stopped being current. */
export function staleAdvantage(board: ProductAdvantageBoard): readonly AdvantageRow[] {
  return [
    ...board.tableStakes,
    ...board.plannedDifferentiators,
    ...board.competitiveRisks,
    ...board.researchExpiry,
  ].filter((r) => r.validity === ValidityState.STALE);
}
