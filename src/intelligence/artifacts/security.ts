import { z } from 'zod';
import { RefSchema, artifact } from './base.js';

/**
 * SECURITY & PRIVACY ARCHITECTURE.
 *
 * SPEC: 08 §3.4, 17, 06 (SC-AGENT-090).
 *
 * The standard this family holds to is that security is modelled, not asserted. "JWT +
 * HTTPS" names two mechanisms and answers none of the questions that matter: who are the
 * actors, what are they allowed to do, what happens when one of them is hostile, and what
 * is left over after the mitigations.
 *
 * `EXPERT_REVIEW_REQUIRED` exists throughout because there is a real line between design
 * work an AI can do and professional certification it cannot. Serva must never imply it
 * performed a legal or compliance assessment.
 */

export const TrustBoundarySchema = artifact({
  between: z.tuple([z.string().min(1), z.string().min(1)]),
  controls: z.array(z.string().min(1)).min(1),
  /** What crosses it, and in which direction. A boundary with no traffic is decoration. */
  dataCrossing: z.array(z.string().min(1)).default([]),
});
export type TrustBoundary = z.output<typeof TrustBoundarySchema>;

/**
 * How someone MISUSES the product, as opposed to how they use it.
 *
 * Abuse cases are separate from threats because they are written from the attacker's
 * point of view and routinely surface requirements the functional analysis misses — rate
 * limits, ownership checks, replay protection, the fact that a "helpful" export endpoint
 * is also a bulk data exfiltration endpoint.
 */
export const AbuseCaseSchema = artifact({
  actor: z.string().min(1),
  goal: z.string().min(1),
  method: z.string().min(1),
  impact: z.string().min(1),
  mitigations: z.array(z.string().min(1)).default([]),
  requirementRefs: z.array(RefSchema).default([]),
});
export type AbuseCase = z.output<typeof AbuseCaseSchema>;

export const ThreatModelSchema = artifact({
  scope: z.string().min(1),
  boundaryRefs: z.array(RefSchema).min(1),
  threats: z
    .array(
      z
        .object({
          id: z.string().min(1),
          statement: z.string().min(1),
          /** STRIDE or equivalent, where a taxonomy helps. Optional, never invented. */
          category: z.string().min(1).optional(),
          affects: z.string().min(1),
          mitigations: z.array(z.string().min(1)).default([]),
          residualRiskRef: RefSchema.optional(),
        })
        .strict(),
    )
    .min(1),
  abuseCaseRefs: z.array(RefSchema).default([]),
  /** Depth scales with risk (17 §4); the level chosen is recorded, not assumed. */
  depth: z.enum(['LIGHT', 'STANDARD', 'DEEP']),
});
export type ThreatModel = z.output<typeof ThreatModelSchema>;

export const AuthDesignSchema = artifact({
  identitySources: z.array(z.string().min(1)).min(1),
  mechanisms: z.array(z.string().min(1)).min(1),
  sessionModel: z.string().min(1),
  credentialRecovery: z.string().min(1).optional(),
  mfa: z.string().min(1).optional(),
  rationale: z.string().min(1),
});
export type AuthDesign = z.output<typeof AuthDesignSchema>;

/**
 * Who may do what to which resource.
 *
 * A matrix rather than prose, because prose authorisation is where the gaps hide. Writing
 * the cells forces the question "and can a merchant read another merchant's orders?" to be
 * answered rather than assumed.
 */
export const AuthorizationModelSchema = artifact({
  model: z.enum(['RBAC', 'ABAC', 'RELATIONSHIP', 'HYBRID']),
  entries: z
    .array(
      z
        .object({
          role: z.string().min(1),
          resource: z.string().min(1),
          action: z.string().min(1),
          effect: z.enum(['ALLOW', 'DENY']),
          condition: z.string().min(1).optional(),
        })
        .strict(),
    )
    .min(1),
  defaultEffect: z.enum(['ALLOW', 'DENY']).default('DENY'),
});
export type AuthorizationModel = z.output<typeof AuthorizationModelSchema>;

export const SecretsDesignSchema = artifact({
  storage: z.string().min(1),
  rotation: z.string().min(1),
  distribution: z.string().min(1),
  /** Never the values themselves — only where they live and how they move. */
  inventory: z.array(z.string().min(1)).default([]),
});
export type SecretsDesign = z.output<typeof SecretsDesignSchema>;

export const PrivacyDesignSchema = artifact({
  dataInventory: z
    .array(
      z
        .object({
          data: z.string().min(1),
          why: z.string().min(1),
          flowsTo: z.array(z.string().min(1)).default([]),
          accessibleBy: z.array(z.string().min(1)).default([]),
          retentionRef: RefSchema.optional(),
        })
        .strict(),
    )
    .min(1),
  externalProcessors: z
    .array(
      z
        .object({ name: z.string().min(1), purpose: z.string().min(1), data: z.string().min(1) })
        .strict(),
    )
    .default([]),
  subjectRights: z.array(z.string().min(1)).default([]),
  /** Set when a conclusion needs a professional, which an AI is not. */
  expertReviewRequired: z.boolean().default(false),
  expertReviewReason: z.string().min(1).optional(),
});
export type PrivacyDesign = z.output<typeof PrivacyDesignSchema>;

export const ResidualRiskSchema = artifact({
  risk: z.string().min(1),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  whyNotMitigated: z.string().min(1),
  /** Accepting a residual risk is an owner act, not an architectural one. */
  ownerDisposition: z.enum(['ACCEPTED', 'PENDING_OWNER', 'REJECTED']),
  ownerDecisionRef: RefSchema.optional(),
});
export type ResidualRisk = z.output<typeof ResidualRiskSchema>;

export const SecurityNfrSchema = artifact({
  statement: z.string().min(1),
  target: z.string().min(1),
  verification: z.string().min(1),
  nfrRef: RefSchema.optional(),
});
export type SecurityNfr = z.output<typeof SecurityNfrSchema>;
