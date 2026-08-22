import { z } from 'zod';
import { RefSchema, artifact, enumOf } from './base.js';

/**
 * GOVERNANCE — proposals, risk, impact, owner authority, readiness.
 *
 * SPEC: 08 §3.6, 09, 10, SC-POL-013, SC-WF-008/009.
 *
 * These are the artifacts that decide what happens next, and each one exists to stop a
 * specific quiet failure:
 *
 *   Proposal      — a good idea silently becoming scope
 *   Risk          — an UNKNOWN silently becoming a LOW
 *   ImpactAnalysis— a change silently affecting things nobody re-checked
 *   OwnerDecision — an AI silently deciding something that was never its to decide
 *   Readiness     — implementation silently starting on unfinished intelligence
 */

export const ProposalState = {
  PROPOSED: 'PROPOSED',
  ASSESSED: 'ASSESSED',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  DEFERRED: 'DEFERRED',
  INCORPORATED: 'INCORPORATED',
} as const;
export type ProposalState = (typeof ProposalState)[keyof typeof ProposalState];

/**
 * An improvement any department may raise.
 *
 * SPEC: §33. A proposal is NOT scope. It becomes scope only when the authority that owns
 * the affected canon incorporates it, and `incorporatedBy` records who that was.
 *
 * `rejectionRationale` is kept forever on purpose: without it, the same idea is proposed
 * every quarter and re-argued from scratch, and the company has no memory of its own
 * decisions.
 */
export const ProposalSchema = artifact({
  title: z.string().min(1),
  origin: z.string().min(1),
  description: z.string().min(1),
  state: enumOf(ProposalState),
  assessment: z
    .object({
      userOrBusinessValue: z.string().min(1),
      evidenceBasis: z.string().min(1),
      implementationComplexity: z.enum(['LOW', 'MEDIUM', 'HIGH']),
      costImpact: z.string().min(1),
      risk: z.string().min(1),
      operationalBurden: z.string().min(1),
      defensibility: z.string().min(1).optional(),
      scopeEffect: z.string().min(1),
    })
    .strict()
    .optional(),
  rejectionRationale: z.string().min(1).optional(),
  incorporatedBy: z.string().min(1).optional(),
  incorporatedInto: z.array(RefSchema).default([]),
});
export type Proposal = z.output<typeof ProposalSchema>;

export const RiskCategory = {
  ASSUMPTION: 'ASSUMPTION',
  SECURITY: 'SECURITY',
  PRIVACY: 'PRIVACY',
  COST: 'COST',
  VENDOR_LOCK_IN: 'VENDOR_LOCK_IN',
  TECHNICAL_FEASIBILITY: 'TECHNICAL_FEASIBILITY',
  EXTERNAL_DEPENDENCY: 'EXTERNAL_DEPENDENCY',
  OPERATIONAL: 'OPERATIONAL',
  UNRESOLVED_OWNER_DECISION: 'UNRESOLVED_OWNER_DECISION',
  MARKET: 'MARKET',
  SCHEDULE: 'SCHEDULE',
} as const;
export type RiskCategory = (typeof RiskCategory)[keyof typeof RiskCategory];

export const RiskLevel = {
  UNKNOWN: 'UNKNOWN',
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
} as const;
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

/**
 * A risk, with UNKNOWN as a first-class value.
 *
 * SPEC: §17 — "UNKNOWN must not become LOW". They are different claims: LOW means it was
 * assessed and found small; UNKNOWN means nobody knows. Collapsing the second into the
 * first is the most common way a risk register becomes reassuring and useless.
 */
export const RiskSchema = artifact({
  category: enumOf(RiskCategory),
  statement: z.string().min(1),
  severity: enumOf(RiskLevel),
  likelihood: enumOf(RiskLevel),
  basis: z.string().min(1),
  mitigation: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  trigger: z.string().min(1).optional(),
  state: z.enum(['OPEN', 'MITIGATED', 'ACCEPTED', 'CLOSED']),
  relatedRefs: z.array(RefSchema).default([]),
});
export type Risk = z.output<typeof RiskSchema>;

/** The dimensions a change must be assessed against (SC-POL-013). */
export const IMPACT_DIMENSIONS: readonly string[] = Object.freeze([
  'PRODUCT_SCOPE',
  'BUSINESS_RULES',
  'REQUIREMENTS',
  'MARKET_POSITION',
  'ARCHITECTURE',
  'DATA',
  'SECURITY',
  'COST',
  'UX',
  'DESIGN_SYSTEM',
  'ADMIN_OPERABILITY',
  'TESTS',
  'EXISTING_EVIDENCE',
  'IMPLEMENTATION',
]);

/**
 * What a change touches — every dimension, with no UNKNOWN permitted.
 *
 * SPEC: §34, SC-POL-013. UNKNOWN is deliberately absent from the enum: an unassessed
 * dimension is not a finding, it is an unfinished analysis, and the correct response is to
 * assess it rather than to record ignorance and proceed.
 */
export const ImpactAnalysisSchema = artifact({
  changeRequestRef: RefSchema,
  magnitude: z.enum(['M1', 'M2', 'M3', 'M4']),
  dimensions: z
    .array(
      z
        .object({
          dimension: z.string().min(1),
          verdict: z.enum(['AFFECTED', 'NOT_AFFECTED']),
          rationale: z.string().min(1),
          /** Canon that must be re-derived or re-verified because of this change. */
          affectedRefs: z.array(RefSchema).default([]),
        })
        .strict(),
    )
    .min(1),
  /** The earliest stage that must run again. Not the whole lifecycle. */
  reentryStageId: z.string().min(1),
  resultingWork: z.array(z.string().min(1)).default([]),
});
export type ImpactAnalysis = z.output<typeof ImpactAnalysisSchema>;

/** Which mandated dimensions this analysis failed to assess. */
export function unassessedDimensions(a: ImpactAnalysis): readonly string[] {
  const seen = new Set(a.dimensions.map((d) => d.dimension));
  return IMPACT_DIMENSIONS.filter((d) => !seen.has(d));
}

export const ChangeRequestSchema = artifact({
  origin: z.string().min(1),
  description: z.string().min(1),
  magnitude: z.enum(['M1', 'M2', 'M3', 'M4']),
  impactAnalysisRef: RefSchema.optional(),
  state: z.enum(['RAISED', 'ANALYSED', 'APPROVED', 'REJECTED', 'IMPLEMENTED']),
});
export type ChangeRequest = z.output<typeof ChangeRequestSchema>;

/**
 * A decision that is genuinely the owner's to make.
 *
 * SPEC: §32. Written in business language, with a recommendation — the owner is being
 * asked to exercise authority, not to do Serva's analysis for it.
 *
 * `answeredBy` may never be an agent. `ownerDecisionRefusal` enforces that: an AI response
 * cannot impersonate owner approval, which is the difference between a governed company
 * and a system that asks itself for permission.
 */
export const OwnerDecisionRequestSchema = artifact({
  question: z.string().min(1),
  whyServaCannotDecide: z.string().min(1),
  options: z
    .array(
      z
        .object({
          option: z.string().min(1),
          impact: z.string().min(1),
          costImplication: z.string().min(1).optional(),
          riskImplication: z.string().min(1).optional(),
        })
        .strict(),
    )
    .min(2),
  recommendation: z.string().min(1),
  recommendationRationale: z.string().min(1),
  blocksWork: z.boolean(),
  blockedRefs: z.array(RefSchema).default([]),
  state: z.enum(['OPEN', 'ANSWERED', 'WITHDRAWN']),
  chosenOption: z.string().min(1).optional(),
  answeredBy: z.string().min(1).optional(),
  answeredAt: z.string().min(1).optional(),
});
export type OwnerDecisionRequest = z.output<typeof OwnerDecisionRequestSchema>;

/** An owner decision answered by anything other than the owner is not a decision. */
export function ownerDecisionRefusal(d: OwnerDecisionRequest): string | undefined {
  if (d.state !== 'ANSWERED') return undefined;
  if (d.answeredBy === undefined || d.answeredBy.trim() === '') {
    return 'OwnerDecisionRequest ' + d.id + ' is ANSWERED but records nobody who answered it';
  }
  if (/^SC-AGENT-/.test(d.answeredBy) || /^SC-RUN-/.test(d.answeredBy)) {
    return (
      'OwnerDecisionRequest ' +
      d.id +
      ' was answered by ' +
      d.answeredBy +
      ', which is an agent: owner authority cannot be synthesised by the company that needs it'
    );
  }
  if (d.chosenOption === undefined) {
    return 'OwnerDecisionRequest ' + d.id + ' is ANSWERED but records no chosen option';
  }
  return undefined;
}

export const ReadinessStatus = {
  READY: 'READY',
  NOT_READY: 'NOT_READY',
  BLOCKED: 'BLOCKED',
} as const;
export type ReadinessStatus = (typeof ReadinessStatus)[keyof typeof ReadinessStatus];

/**
 * DERIVED. References the accepted versions of what implementation needs.
 *
 * Deliberately a set of references rather than copies. A readiness package that embedded
 * the requirements would be a second source of truth that starts drifting the moment
 * anything upstream changes — and the version pins are what make "what did we hand over"
 * answerable later.
 */
export const EngineeringReadinessPackageSchema = artifact({
  status: enumOf(ReadinessStatus),
  refs: z
    .object({
      productScope: RefSchema.optional(),
      requirementBaseline: RefSchema.optional(),
      acceptanceCriteria: z.array(RefSchema).default([]),
      nfrs: z.array(RefSchema).default([]),
      businessRules: z.array(RefSchema).default([]),
      architecture: z.array(RefSchema).default([]),
      dataModel: z.array(RefSchema).default([]),
      security: z.array(RefSchema).default([]),
      ux: z.array(RefSchema).default([]),
      designSystem: z.array(RefSchema).default([]),
      adminOperability: z.array(RefSchema).default([]),
      testStrategy: z.array(RefSchema).default([]),
      risks: z.array(RefSchema).default([]),
      competitivePosition: RefSchema.optional(),
      acceptedProposals: z.array(RefSchema).default([]),
    })
    .strict(),
  gateResults: z
    .array(z.object({ gateId: z.string().min(1), verdict: z.string().min(1) }).strict())
    .default([]),
  openOwnerDecisions: z.array(RefSchema).default([]),
  /** Why it is not READY, in terms someone can act on. */
  blockers: z.array(z.string().min(1)).default([]),
});
export type EngineeringReadinessPackage = z.output<typeof EngineeringReadinessPackageSchema>;
