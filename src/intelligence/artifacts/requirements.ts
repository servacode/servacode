import { z } from 'zod';
import { RefSchema, artifact, enumOf } from './base.js';

/**
 * REQUIREMENTS & NFRs.
 *
 * SPEC: 08 §3.3, 06 (SC-AGENT-050/051/052).
 *
 * Two rules do most of the work here, and both are checkable rather than aspirational:
 *
 *   every MUST requirement has at least one AcceptanceCriterion;
 *   every NFR has a MEASURABLE target and a method for measuring it.
 *
 * "The system shall be fast" is not a requirement, it is a mood. It cannot be tested,
 * cannot be designed against, and cannot be failed — which means it will be declared
 * satisfied by whoever is under the most schedule pressure.
 */

export const RequirementKind = {
  FUNCTIONAL: 'FUNCTIONAL',
  CONSTRAINT: 'CONSTRAINT',
  DATA: 'DATA',
  INTERFACE: 'INTERFACE',
} as const;
export type RequirementKind = (typeof RequirementKind)[keyof typeof RequirementKind];

/**
 * One atomic, testable statement of what the product must do.
 *
 * `tracesTo` points UPWARD — to the goal, business rule or proposal that justifies it.
 * `SC-RTC-007` treats an empty `tracesTo` as an orphan, because a requirement nobody
 * asked for is either scope creep or a lost rationale, and both are worth surfacing.
 */
export const RequirementSchema = artifact({
  statement: z.string().min(1),
  kind: enumOf(RequirementKind),
  priority: z.enum(['MUST', 'SHOULD', 'COULD', 'WONT']),
  rationale: z.string().min(1),
  /** Upward traceability: ProjectGoal, BusinessRule, Proposal, or Feature. */
  tracesTo: z.array(RefSchema).default([]),
  featureRef: RefSchema.optional(),
});
export type Requirement = z.output<typeof RequirementSchema>;

export const VerificationMethod = {
  AUTOMATED_TEST: 'AUTOMATED_TEST',
  MANUAL_TEST: 'MANUAL_TEST',
  INSPECTION: 'INSPECTION',
  ANALYSIS: 'ANALYSIS',
  DEMONSTRATION: 'DEMONSTRATION',
  MEASUREMENT: 'MEASUREMENT',
} as const;
export type VerificationMethod = (typeof VerificationMethod)[keyof typeof VerificationMethod];

export const AcceptanceCriterionSchema = artifact({
  requirementRef: RefSchema,
  criterion: z.string().min(1),
  verificationMethod: enumOf(VerificationMethod),
});
export type AcceptanceCriterion = z.output<typeof AcceptanceCriterionSchema>;

export const NfrDimension = {
  PERFORMANCE: 'PERFORMANCE',
  AVAILABILITY: 'AVAILABILITY',
  SCALABILITY: 'SCALABILITY',
  SECURITY: 'SECURITY',
  PRIVACY: 'PRIVACY',
  ACCESSIBILITY: 'ACCESSIBILITY',
  USABILITY: 'USABILITY',
  MAINTAINABILITY: 'MAINTAINABILITY',
  OPERABILITY: 'OPERABILITY',
  COST: 'COST',
  COMPATIBILITY: 'COMPATIBILITY',
  RELIABILITY: 'RELIABILITY',
} as const;
export type NfrDimension = (typeof NfrDimension)[keyof typeof NfrDimension];

/**
 * A quality requirement with a number attached.
 *
 * `target` is a free string because units differ wildly (`p95 < 200ms`, `99.9% monthly`,
 * `WCAG 2.2 AA`), but `nfrMeasurabilityRefusal` refuses the adjectives that masquerade as
 * targets. `applicability` is here so an NFR can be explicitly scoped rather than
 * silently ignored where it does not apply.
 */
export const NfrSchema = artifact({
  dimension: enumOf(NfrDimension),
  statement: z.string().min(1),
  target: z.string().min(1),
  measurementMethod: z.string().min(1),
  applicability: z.string().min(1),
  rationale: z.string().min(1),
});
export type Nfr = z.output<typeof NfrSchema>;

/** Words that sound like targets and are not. */
const UNMEASURABLE = [
  'fast',
  'quick',
  'responsive',
  'secure',
  'safe',
  'scalable',
  'reliable',
  'robust',
  'user friendly',
  'user-friendly',
  'easy',
  'intuitive',
  'modern',
  'good',
  'high performance',
  'best practice',
];

/**
 * Is this NFR actually measurable?
 *
 * A target with no digit and no recognised standard is almost always an adjective. The
 * check is deliberately blunt — it is a prompt to write a number, not a proof of quality —
 * and it is reported as a finding so the Requirements Quality Verifier can act on it.
 */
export function nfrMeasurabilityRefusal(n: Nfr): string | undefined {
  const target = n.target.trim().toLowerCase();
  const hasNumber = /\d/.test(target);
  const namesStandard = /wcag|iso|nist|owasp|pci|gdpr|rfc|sla/i.test(target);
  if (!hasNumber && !namesStandard) {
    return (
      'NFR ' +
      n.id +
      ' has no measurable target ("' +
      n.target +
      '"): a quality with no number and no named standard cannot be verified or failed'
    );
  }
  if (UNMEASURABLE.some((w) => target === w || target.startsWith(w + ' '))) {
    return 'NFR ' + n.id + ' states an adjective ("' + n.target + '") rather than a target';
  }
  if (n.measurementMethod.trim() === '') {
    return 'NFR ' + n.id + ' has a target but no way to measure it';
  }
  return undefined;
}

/** A MUST with nothing to check against is not a requirement anyone can satisfy. */
export function mustHasAcceptanceRefusal(
  r: Requirement,
  criteria: readonly AcceptanceCriterion[],
): string | undefined {
  if (r.priority !== 'MUST') return undefined;
  const mine = criteria.filter((c) => c.requirementRef.id === r.id);
  if (mine.length === 0) {
    return 'MUST requirement ' + r.id + ' has no acceptance criterion, so nothing can verify it';
  }
  return undefined;
}

/**
 * A frozen set of requirement versions.
 *
 * Versions rather than ids: the point of a baseline is that "what we agreed to build" does
 * not drift underneath the people building it. A baseline of bare ids would follow every
 * later edit and record nothing.
 */
export const RequirementBaselineSchema = artifact({
  requirementVersions: z
    .array(z.object({ id: z.string().min(1), version: z.number().int().positive() }).strict())
    .min(1),
  baselinedAt: z.string().min(1),
  by: z.string().min(1),
});
export type RequirementBaseline = z.output<typeof RequirementBaselineSchema>;

export const TraceabilityLinkSchema = artifact({
  from: RefSchema,
  to: RefSchema,
  kind: z.enum(['SATISFIES', 'DERIVES_FROM', 'VERIFIES', 'IMPLEMENTS', 'REFINES', 'CONFLICTS']),
  rationale: z.string().min(1).optional(),
});
export type TraceabilityLink = z.output<typeof TraceabilityLinkSchema>;
