import { z } from 'zod';
import { RefSchema, artifact, enumOf } from './base.js';

/**
 * PRODUCT MANAGEMENT — what gets built, and what deliberately does not.
 *
 * SPEC: 08 §3.5, 06 (SC-AGENT-020), 10 (proposals).
 *
 * The discipline this family enforces is subtraction. Every interesting idea can be
 * argued for; a product manager's actual job is deciding which ones to refuse, and a
 * system that only ever adds features produces a bloated product that does nothing well.
 * So `outOfScope` and `nonGoals` are first-class fields rather than an afterthought, and
 * a Feature must trace to a ProjectGoal or an approved Proposal to exist at all.
 */

export const FeatureState = {
  PROPOSED: 'PROPOSED',
  ACCEPTED: 'ACCEPTED',
  DEFERRED: 'DEFERRED',
  REJECTED: 'REJECTED',
  IMPLEMENTED: 'IMPLEMENTED',
} as const;
export type FeatureState = (typeof FeatureState)[keyof typeof FeatureState];

/**
 * A unit of product capability.
 *
 * Exactly one of `goalRefs` or `proposalRef` must be non-empty — enforced by
 * `featureTraceRefusal` rather than by the schema, so an orphan can be reported as a gate
 * finding by `SC-RTC-007` instead of merely failing to parse. A feature that traces to
 * nothing is how scope grows without anyone deciding it should.
 */
export const FeatureSchema = artifact({
  name: z.string().min(1),
  description: z.string().min(1),
  goalRefs: z.array(RefSchema).default([]),
  proposalRef: RefSchema.optional(),
  requirementRefs: z.array(RefSchema).default([]),
  state: enumOf(FeatureState),
  priority: z.enum(['MUST', 'SHOULD', 'COULD', 'WONT']),
  /** Set by the Operability Classifier. Every feature gets one — §27. */
  operabilityReviewRef: RefSchema.optional(),
});
export type Feature = z.output<typeof FeatureSchema>;

/** Why a feature exists at all. Reported as a finding, never silently tolerated. */
export function featureTraceRefusal(f: Feature): string | undefined {
  if (f.goalRefs.length === 0 && f.proposalRef === undefined) {
    return (
      'Feature ' +
      f.id +
      ' traces to no ProjectGoal and no approved Proposal, so nothing explains why it is in the product'
    );
  }
  return undefined;
}

/**
 * The scope boundary, stated in three parts.
 *
 * `nonGoals` is distinct from `outOfScope`: out of scope means "not now", a non-goal
 * means "not ever, and here is why". Collapsing them loses the second, which is the one
 * that stops the same idea being re-proposed every quarter.
 */
export const ProductScopeSchema = artifact({
  inScope: z.array(RefSchema).min(1),
  outOfScope: z
    .array(z.object({ statement: z.string().min(1), reason: z.string().min(1) }).strict())
    .default([]),
  nonGoals: z
    .array(z.object({ statement: z.string().min(1), reason: z.string().min(1) }).strict())
    .default([]),
  rationale: z.string().min(1),
});
export type ProductScope = z.output<typeof ProductScopeSchema>;

export const RoadmapSchema = artifact({
  releases: z
    .array(
      z
        .object({
          name: z.string().min(1),
          featureRefs: z.array(RefSchema).min(1),
          rationale: z.string().min(1),
        })
        .strict(),
    )
    .min(1),
});
export type Roadmap = z.output<typeof RoadmapSchema>;

/**
 * Whether the product should be built at all.
 *
 * SPEC: §7. `DO_NOT_BUILD` is a legitimate company result, not an AI failure. A system
 * that can only ever say "yes" is not exercising product judgement, it is agreeing; the
 * value of the department is precisely that some ideas should be stopped before they
 * consume a quarter.
 */
export const ValidationOutcome = {
  PROCEED: 'PROCEED',
  PROCEED_WITH_CONDITIONS: 'PROCEED_WITH_CONDITIONS',
  PIVOT: 'PIVOT',
  NARROW_SCOPE: 'NARROW_SCOPE',
  DO_NOT_BUILD: 'DO_NOT_BUILD',
} as const;
export type ValidationOutcome = (typeof ValidationOutcome)[keyof typeof ValidationOutcome];

export const ValidationRecommendationSchema = artifact({
  outcome: enumOf(ValidationOutcome),
  rationale: z.string().min(1),
  /** Required when the outcome is conditional; the conditions ARE the recommendation. */
  conditions: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(RefSchema).default([]),
  /** What would change this recommendation. Makes it reviewable rather than final. */
  reevaluationTrigger: z.string().min(1).optional(),
});
export type ValidationRecommendation = z.output<typeof ValidationRecommendationSchema>;

export const ProductDecisionSchema = artifact({
  context: z.string().min(1),
  options: z
    .array(z.object({ option: z.string().min(1), consequence: z.string().min(1) }).strict())
    .min(2),
  chosen: z.string().min(1),
  rationale: z.string().min(1),
  rejectedReasons: z.array(z.string().min(1)).default([]),
  reevaluationTrigger: z.string().min(1).optional(),
});
export type ProductDecision = z.output<typeof ProductDecisionSchema>;
