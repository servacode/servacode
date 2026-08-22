import { z } from 'zod';
import { FreshnessSchema, RefSchema, artifact, enumOf } from './base.js';
import { Confidence, SourceRefSchema } from '../provenance.js';

/**
 * MARKET & COMPETITIVE INTELLIGENCE.
 *
 * SPEC: 08 §3.2, 11 (competitive innovation), 06 (SC-AGENT-060/061/062/063).
 *
 * Three separations are load-bearing here and none of them are bureaucracy:
 *
 *   the Researcher GATHERS evidence and does not conclude;
 *   the Verifier checks claims against CAPTURED sources and cannot re-fetch;
 *   the Analyst and the Strategist conclude, and may not edit the findings underneath.
 *
 * The failure being prevented is specific: a strategist who wants a differentiator to be
 * true adjusting the research that says it is not. Keeping findings and conclusions in
 * different artifacts, written by different runs, means that adjustment has to be an
 * explicit, attributable act rather than a quiet edit.
 *
 * Everything research-backed carries `freshness`, because competitive truth expires and a
 * gate must not be able to treat last quarter's landscape as current.
 */

/**
 * One answered research question.
 *
 * `sources` is required and non-empty. A finding without a captured source is not a
 * finding, it is a recollection — and `SC-AGENT-063` verifies against what was captured
 * at retrieval time, never against the live web.
 */
export const ResearchFindingSchema = artifact({
  question: z.string().min(1),
  finding: z.string().min(1),
  sources: z.array(SourceRefSchema).min(1),
  confidence: enumOf(Confidence),
  freshness: FreshnessSchema,
});
export type ResearchFinding = z.output<typeof ResearchFindingSchema>;

/**
 * Why a research question could not be answered.
 *
 * SPEC: §31 — research unavailable is NOT_VERIFIED, never invented market truth.
 *
 * This artifact exists so that "we could not find out" is a recordable, gate-readable
 * result. Without somewhere to put it, an agent under pressure to produce output writes a
 * plausible competitor landscape instead, and plausible is indistinguishable from true
 * until it costs someone a quarter.
 */
export const ResearchUnavailableReason = {
  NETWORK_DENIED: 'NETWORK_DENIED',
  NO_SOURCES_FOUND: 'NO_SOURCES_FOUND',
  RETRIEVAL_FAILED: 'RETRIEVAL_FAILED',
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
} as const;
export type ResearchUnavailableReason =
  (typeof ResearchUnavailableReason)[keyof typeof ResearchUnavailableReason];

export const ResearchUnavailableSchema = artifact({
  question: z.string().min(1),
  reason: enumOf(ResearchUnavailableReason),
  detail: z.string().min(1),
  /** What a person could do to unblock it. */
  remedy: z.string().min(1),
});
export type ResearchUnavailable = z.output<typeof ResearchUnavailableSchema>;

export const CompetitorProfileSchema = artifact({
  name: z.string().min(1),
  positioning: z.string().min(1),
  features: z.array(z.string().min(1)).default([]),
  pricingNotes: z.string().min(1).optional(),
  sources: z.array(SourceRefSchema).min(1),
  freshness: FreshnessSchema,
});
export type CompetitorProfile = z.output<typeof CompetitorProfileSchema>;

/** DERIVED: competitors × dimensions. Never authored directly; recomputed from profiles. */
export const FeatureComparisonSchema = artifact({
  dimensions: z.array(z.string().min(1)).min(1),
  competitorRefs: z.array(RefSchema).min(1),
  cells: z
    .array(
      z
        .object({
          competitorRef: RefSchema,
          dimension: z.string().min(1),
          value: z.string().min(1),
          sourceRefs: z.array(SourceRefSchema).default([]),
        })
        .strict(),
    )
    .default([]),
});
export type FeatureComparison = z.output<typeof FeatureComparisonSchema>;

/**
 * A capability the market expects as a baseline.
 *
 * Table stakes are not differentiators and confusing the two is the most common strategy
 * error there is. "We have search" is not a reason to switch; lacking search is a reason
 * not to buy. `evidenceRefs` is required so that a claimed table stake traces to findings
 * rather than to intuition about what products "obviously" need.
 */
export const TableStakesSchema = artifact({
  capability: z.string().min(1),
  whyExpected: z.string().min(1),
  evidenceRefs: z.array(RefSchema).min(1),
});
export type TableStakes = z.output<typeof TableStakesSchema>;

export const MarketGapSchema = artifact({
  description: z.string().min(1),
  evidenceRefs: z.array(RefSchema).min(1),
  confidence: enumOf(Confidence),
  /** Why the gap exists. A gap nobody has filled is often a gap nobody wants filled. */
  whyUnfilled: z.string().min(1).optional(),
});
export type MarketGap = z.output<typeof MarketGapSchema>;

export const Defensibility = {
  NONE: 'NONE',
  WEAK: 'WEAK',
  MODERATE: 'MODERATE',
  STRONG: 'STRONG',
} as const;
export type Defensibility = (typeof Defensibility)[keyof typeof Defensibility];

/**
 * A concrete, argued reason to choose this product.
 *
 * SPEC: §14 — "modern UI", "AI powered", "fast", "easy", "secure" are not differentiators
 * without a concrete argued advantage. `basis` and `competitorCoverage` are required
 * precisely so the claim has to survive contact with what competitors already do; a
 * differentiator every competitor also has is a table stake wearing a nicer word.
 *
 * `defensibility` asks the harder question: if this works, how long before it is copied?
 * NONE is a legitimate answer and a useful one.
 */
export const DifferentiatorSchema = artifact({
  statement: z.string().min(1),
  basis: z.string().min(1),
  defensibility: enumOf(Defensibility),
  defensibilityRationale: z.string().min(1),
  /** What each competitor does about this today. Empty means it was never checked. */
  competitorCoverage: z
    .array(
      z
        .object({
          competitorRef: RefSchema,
          coverage: z.enum(['ABSENT', 'PARTIAL', 'PRESENT', 'UNKNOWN']),
          note: z.string().min(1).optional(),
        })
        .strict(),
    )
    .min(1),
  evidenceRefs: z.array(RefSchema).default([]),
});
export type Differentiator = z.output<typeof DifferentiatorSchema>;

/**
 * The answer to "why would anyone choose this?".
 *
 * `reasonToStay` is the field people skip and the one that decides outcomes: it is the
 * argument for the incumbent, written honestly, by the company proposing to displace it.
 * A position that cannot state it has not understood the market it is entering.
 */
export const CompetitivePositionSchema = artifact({
  whyChosen: z.string().min(1),
  alternativeRefs: z.array(RefSchema).min(1),
  tableStakesPlan: z
    .array(
      z
        .object({
          tableStakesRef: RefSchema,
          disposition: z.enum(['AT_LAUNCH', 'DEFERRED', 'NOT_DOING']),
          rationale: z.string().min(1),
        })
        .strict(),
    )
    .default([]),
  differentiatorRefs: z.array(RefSchema).default([]),
  reasonToSwitch: z.string().min(1),
  reasonToStay: z.string().min(1),
  nonGoals: z.array(z.string().min(1)).default([]),
  freshness: FreshnessSchema,
});
export type CompetitivePosition = z.output<typeof CompetitivePositionSchema>;
