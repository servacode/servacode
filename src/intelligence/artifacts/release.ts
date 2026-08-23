import { z } from 'zod';
import { IsoSchema } from '../../domain/schemas.js';
import { RefSchema, artifact, enumOf } from './base.js';
import { VerificationVerdict } from './quality.js';

/**
 * RELEASE AND HANDOVER — DELIVERY IS A DECISION, NOT A CONSEQUENCE OF GREEN.
 *
 * SPEC: §21, §22, 06 (SC-AGENT-250/251/260/262), 03 §7 (stages 050, 052).
 *
 * Serva runs on one machine and the products it builds do not. That gap is where the most
 * expensive mistake in software delivery lives: a suite goes green, somebody ships, and the
 * things nobody wrote down — the migration that has to run first, the configuration the
 * environment does not have, the way back if it goes wrong — are discovered in production
 * by a customer.
 *
 * So a release is an ARTIFACT with named contents, and the checklist is canon rather than
 * a habit. `ReleaseRecommendation` is deliberately a recommendation: the Release Manager
 * assembles and advises, and the authority to actually deliver is the owner's. An agent
 * that could authorise a release could authorise its own work into production.
 *
 * `HandoverPackage` exists because the product may leave Serva entirely — a client takes
 * it, or another team operates it. What they need is not the Store; it is the subset of
 * project truth that lets somebody else run and change the thing safely.
 *
 * Nothing here deploys. Where no connector exists, Serva produces the governed package and
 * says plainly that external action is required, because a fabricated deployment success is
 * worse than no deployment at all.
 */

export const ReleaseState = {
  /** Assembled and not yet judged. */
  CANDIDATE: 'CANDIDATE',
  /** Gate passed and the owner authorised it. Still not delivered. */
  APPROVED: 'APPROVED',
  /** Delivered, or handed to whoever delivers. */
  RELEASED: 'RELEASED',
  /** Refused: a gate, a blocker, or the owner. */
  REJECTED: 'REJECTED',
  /** Withdrawn after approval, before or after delivery. */
  ROLLED_BACK: 'ROLLED_BACK',
} as const;
export type ReleaseState = (typeof ReleaseState)[keyof typeof ReleaseState];

/**
 * A release candidate, identified and enumerated.
 *
 * `contents` is derived from accepted ChangeSets rather than written by hand: release notes
 * assembled from memory describe what somebody remembers doing, and the difference only
 * shows up when a customer asks why a fix is missing.
 */
export const ReleaseSchema = artifact({
  /** Human identity: the thing a person says out loud. */
  version: z.number().int().positive().default(1),
  releaseVersion: z.string().min(1),
  name: z.string().min(1),
  state: enumOf(ReleaseState),
  /** Accepted ChangeSets in this candidate. The source of the notes, not a summary of them. */
  changeSetRefs: z.array(RefSchema).default([]),
  /** Requirements this release claims to deliver. */
  requirementRefs: z.array(RefSchema).default([]),
  notes: z.array(z.string().min(1)).default([]),
  knownLimitations: z.array(z.string().min(1)).default([]),
  /** The commit or artifact identity delivered, where one exists. */
  artifactManifest: z
    .array(
      z
        .object({
          name: z.string().min(1),
          kind: z.string().min(1),
          identity: z.string().min(1),
          digest: z.string().min(1).optional(),
        })
        .strict(),
    )
    .default([]),
  /** The owner decision that authorised it. Absent means nobody authorised it. */
  approvedByOwnerDecisionRef: RefSchema.optional(),
  approvedAt: IsoSchema.optional(),
});
export type Release = z.output<typeof ReleaseSchema>;

/** SC-AGENT-250 — what the Release Manager advises, and why. Never an authorisation. */
export const ReleaseRecommendationSchema = artifact({
  releaseRef: RefSchema,
  recommendation: z.enum(['RELEASE', 'HOLD', 'RELEASE_WITH_QUALIFICATION']),
  rationale: z.string().min(1),
  /** Everything the recommendation rests on, so a reader can disagree with it. */
  blockers: z.array(z.string().min(1)).default([]),
  qualifications: z.array(z.string().min(1)).default([]),
  recommendedByRunId: z.string().min(1),
  recommendedByAgentId: z.string().min(1),
});
export type ReleaseRecommendation = z.output<typeof ReleaseRecommendationSchema>;

/**
 * SC-AGENT-251 — everything somebody else needs to run and change this safely.
 *
 * The checklist items are required rather than optional because each of them is a thing
 * that is obvious to the team that built it and invisible to the team that inherits it.
 */
export const HandoverPackageSchema = artifact({
  releaseRef: RefSchema,
  /** What the product is, for a reader who has never seen the project. */
  overview: z.string().min(1),
  deploymentSteps: z.array(z.string().min(1)).default([]),
  configurationRequirements: z
    .array(
      z
        .object({
          key: z.string().min(1),
          purpose: z.string().min(1),
          /** Never a value. A handover package is not a place to put a secret. */
          secret: z.boolean().default(false),
        })
        .strict(),
    )
    .default([]),
  migrationRequirements: z.array(z.string().min(1)).default([]),
  rollbackPlan: z.string().min(1),
  operatorDocumentation: z.array(z.string().min(1)).default([]),
  /** The evidence that this was accepted, by reference rather than by assertion. */
  acceptanceEvidenceRefs: z.array(RefSchema).default([]),
  knownLimitations: z.array(z.string().min(1)).default([]),
  /** What Serva could not establish. Present and empty is a claim; absent is not. */
  notEstablished: z.array(z.string().min(1)).default([]),
  compiledByRunId: z.string().min(1),
  compiledByAgentId: z.string().min(1),
});
export type HandoverPackage = z.output<typeof HandoverPackageSchema>;

/** SC-AGENT-260 — how somebody knows this is working, and what to do when it is not. */
export const RunbookSchema = artifact({
  title: z.string().min(1),
  scenario: z.string().min(1),
  detection: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  escalation: z.string().min(1),
  relatedRefs: z.array(RefSchema).default([]),
});
export type Runbook = z.output<typeof RunbookSchema>;

/** SC-AGENT-262 — is this operable by somebody who was not in the room? */
export const OperationalReadinessVerdictSchema = artifact({
  verdict: enumOf(VerificationVerdict),
  releaseRef: RefSchema,
  summary: z.string().min(1),
  checks: z
    .array(
      z
        .object({
          area: z.string().min(1),
          met: z.boolean(),
          detail: z.string().min(1),
        })
        .strict(),
    )
    .default([]),
  notVerified: z
    .array(z.object({ area: z.string().min(1), why: z.string().min(1) }).strict())
    .default([]),
  verifiedByRunId: z.string().min(1),
  verifiedByAgentId: z.string().min(1),
  verifiedAt: IsoSchema,
});
export type OperationalReadinessVerdict = z.output<typeof OperationalReadinessVerdictSchema>;
