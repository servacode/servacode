import { z } from 'zod';
import { IsoSchema } from '../../domain/schemas.js';
import { RefSchema, artifact, enumOf } from './base.js';

/**
 * INCIDENTS — A PRODUCTION FAILURE IS A COMPANY PROCESS, NOT A PATCH REQUEST.
 *
 * SPEC: §23, 06 (SC-AGENT-270/271), 03 §7 (stage 054), §34 (re-entry).
 *
 * "Checkout failed in production" has exactly one wrong response, and it is the one
 * everybody reaches for: ask the model to fix checkout. That skips severity, skips impact,
 * skips whether the requirement was wrong rather than the code, skips verification, and
 * skips the reason it happened — which is the only part that stops it happening again.
 *
 * So an incident enters the same governed machinery as everything else. It is recorded with
 * a severity that decides the profile, it produces an impact analysis and a change request
 * rather than a direct edit, and it closes through a gate. The corrective actions a
 * post-incident review proposes are `Proposal`s, which means they are costed and agreed
 * before they become scope — an incident is not a licence to enlarge the product.
 *
 * `PostIncidentReview` deliberately separates the immediate cause from the contributing
 * conditions. A review that names one line of code has explained the symptom; the
 * conditions are what let the line reach production, and they are usually the same three
 * things every time.
 */

export const IncidentSeverity = {
  /** Product unusable, data at risk, or a security breach. */
  SEV1: 'SEV1',
  /** A major capability is broken with no workaround. */
  SEV2: 'SEV2',
  /** Degraded, or broken with a workaround. */
  SEV3: 'SEV3',
  /** Minor, cosmetic, or an isolated report. */
  SEV4: 'SEV4',
} as const;
export type IncidentSeverity = (typeof IncidentSeverity)[keyof typeof IncidentSeverity];

export const IncidentState = {
  REPORTED: 'REPORTED',
  /** Being investigated; the effect is understood, the cause is not. */
  INVESTIGATING: 'INVESTIGATING',
  /** The bleeding has stopped. Not the same as fixed. */
  CONTAINED: 'CONTAINED',
  /** A governed change has been accepted and released. */
  RESOLVED: 'RESOLVED',
  /** Reviewed, with corrective actions on record. The only terminal state. */
  CLOSED: 'CLOSED',
} as const;
export type IncidentState = (typeof IncidentState)[keyof typeof IncidentState];

/**
 * What happened, as reported and as established.
 *
 * `reportedEffect` and `establishedEffect` are separate fields because the first report is
 * almost never accurate and overwriting it loses the fact that Serva was working from a
 * different picture for the first hour.
 */
export const IncidentSchema = artifact({
  title: z.string().min(1),
  severity: enumOf(IncidentSeverity),
  state: enumOf(IncidentState),
  reportedAt: IsoSchema,
  reportedBy: z.string().min(1),
  reportedEffect: z.string().min(1),
  establishedEffect: z.string().min(1).optional(),
  /** Timeline entries, appended. What was known, and when. */
  timeline: z
    .array(
      z
        .object({
          at: IsoSchema,
          entry: z.string().min(1),
          by: z.string().min(1),
        })
        .strict(),
    )
    .default([]),
  /** What was done to stop the bleeding, and whether it is reversible. */
  containment: z
    .object({
      action: z.string().min(1),
      at: IsoSchema,
      reversible: z.boolean(),
    })
    .strict()
    .optional(),
  /** Product truth this touches: requirements, flows, components. */
  affectsRefs: z.array(RefSchema).default([]),
  /** The governed change raised to fix it. An incident never edits anything itself. */
  changeRequestRef: RefSchema.optional(),
  /** The release that carried the fix. */
  resolvedByReleaseRef: RefSchema.optional(),
});
export type Incident = z.output<typeof IncidentSchema>;

/** SC-AGENT-271 — why it happened, and what would have to change for it not to. */
export const PostIncidentReviewSchema = artifact({
  incidentRef: RefSchema,
  /** The proximate cause: the thing that broke. */
  immediateCause: z.string().min(1),
  /**
   * The conditions that let it reach production.
   *
   * Required and non-empty. A review with an immediate cause and no contributing
   * conditions has explained the symptom and stopped, which is how the same incident
   * happens a second time with a different line number.
   */
  contributingConditions: z.array(z.string().min(1)).min(1),
  /** What detected it, and how long that took. Often the most actionable finding. */
  detection: z.string().min(1),
  /** What Serva could not establish. Absent is not the same as none. */
  notEstablished: z.array(z.string().min(1)).default([]),
  /** Corrective actions, as Proposals: costed and agreed before they become scope. */
  correctiveProposalRefs: z.array(RefSchema).default([]),
  lessonRefs: z.array(RefSchema).default([]),
  reviewedByRunId: z.string().min(1),
  reviewedByAgentId: z.string().min(1),
});
export type PostIncidentReview = z.output<typeof PostIncidentReviewSchema>;

/**
 * The lifecycle profile an incident of a given severity re-enters through.
 *
 * Deterministic, and deliberately not a judgement: an incident commander under pressure
 * asked "which profile?" will answer "the fast one". SEV1 gets the security profile only
 * when it IS a security incident, which the caller states rather than infers.
 */
export function profileForIncident(o: {
  readonly severity: IncidentSeverity;
  readonly security: boolean;
}): string {
  if (o.security) return 'PRF-SECURITY-FIX';
  return o.severity === IncidentSeverity.SEV1 || o.severity === IncidentSeverity.SEV2
    ? 'PRF-BUG-FIX'
    : 'PRF-SMALL-CHANGE';
}
