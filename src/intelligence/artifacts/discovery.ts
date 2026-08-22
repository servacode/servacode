import { z } from 'zod';
import { RefSchema, artifact, enumOf } from './base.js';

/**
 * DISCOVERY — who has the problem, and what they do about it today.
 *
 * SPEC: 08 §3.2, 06 (SC-AGENT-030 Discovery Analyst).
 *
 * The rule that shapes this whole family: **every segment must have a
 * CurrentAlternative**, and "do nothing", a spreadsheet, a WhatsApp group, paper, or an
 * employee doing it by hand are all valid alternatives.
 *
 * That is not pedantry. A product compared only against software competitors is compared
 * against the wrong thing — most products lose to inertia and to Excel, not to a rival
 * SaaS. A discovery that skips this produces a differentiator that beats a competitor
 * nobody was using anyway.
 */

export const AlternativeKind = {
  /** The strongest competitor most products actually face. */
  DO_NOTHING: 'DO_NOTHING',
  MANUAL_PROCESS: 'MANUAL_PROCESS',
  SPREADSHEET: 'SPREADSHEET',
  GENERAL_PURPOSE_TOOL: 'GENERAL_PURPOSE_TOOL',
  INTERNAL_SYSTEM: 'INTERNAL_SYSTEM',
  EMPLOYEE_OR_SERVICE: 'EMPLOYEE_OR_SERVICE',
  COMPETITOR_PRODUCT: 'COMPETITOR_PRODUCT',
} as const;
export type AlternativeKind = (typeof AlternativeKind)[keyof typeof AlternativeKind];

export const UserSegmentSchema = artifact({
  name: z.string().min(1),
  description: z.string().min(1),
  goals: z.array(z.string().min(1)).min(1),
  context: z.string().min(1),
});
export type UserSegment = z.output<typeof UserSegmentSchema>;

/**
 * What a segment is trying to get done.
 *
 * `currentSolution` is required: a job with no current solution has either not been
 * researched or does not exist. People do not wait for software to start having problems.
 */
export const JobToBeDoneSchema = artifact({
  statement: z.string().min(1),
  segmentRef: RefSchema,
  currentSolution: z.string().min(1),
});
export type JobToBeDone = z.output<typeof JobToBeDoneSchema>;

/**
 * What the segment uses today, and why they keep using it.
 *
 * `whyUsed` is as important as `weaknesses`. A replacement that ignores why the old thing
 * is tolerable tends to lose to it — the spreadsheet is awful and also instant, free, and
 * already understood by everyone in the office.
 */
export const CurrentAlternativeSchema = artifact({
  segmentRef: RefSchema,
  kind: enumOf(AlternativeKind),
  description: z.string().min(1),
  whyUsed: z.string().min(1),
  weaknesses: z.array(z.string().min(1)).min(1),
  switchingCost: z.string().min(1).optional(),
});
export type CurrentAlternative = z.output<typeof CurrentAlternativeSchema>;

export const PainSeverity = {
  BLOCKING: 'BLOCKING',
  MAJOR: 'MAJOR',
  MINOR: 'MINOR',
} as const;
export type PainSeverity = (typeof PainSeverity)[keyof typeof PainSeverity];

export const PainSchema = artifact({
  statement: z.string().min(1),
  severity: enumOf(PainSeverity),
  segmentRef: RefSchema,
  /** How the pain shows up today. Prevents a pain that is really a feature request. */
  evidence: z.string().min(1).optional(),
});
export type Pain = z.output<typeof PainSchema>;

/**
 * The Discovery department's summary.
 *
 * `researchPerformed` is an explicit, structured claim rather than prose because the
 * temptation to write "user research shows…" when no user was ever contacted is real and
 * the consequence is severe. If no interviews happened, this says so, and a gate can read
 * it. Serva never fabricates interviews, surveys or usability tests.
 */
export const DiscoveryFindingsSchema = artifact({
  summary: z.string().min(1),
  segmentRefs: z.array(RefSchema).min(1),
  researchPerformed: z
    .object({
      interviews: z.number().int().min(0).default(0),
      surveys: z.number().int().min(0).default(0),
      usabilityTests: z.number().int().min(0).default(0),
      deskResearch: z.boolean().default(false),
    })
    .strict(),
  /** Stated plainly so nothing downstream can imply evidence that does not exist. */
  limitations: z.array(z.string().min(1)).default([]),
  openQuestionRefs: z.array(RefSchema).default([]),
  assumptionRefs: z.array(RefSchema).default([]),
});
export type DiscoveryFindings = z.output<typeof DiscoveryFindingsSchema>;
