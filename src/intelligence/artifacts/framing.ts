import { z } from 'zod';
import { IdSchema, IsoSchema } from '../../domain/schemas.js';
import { RefSchema, artifact, enumOf } from './base.js';

/**
 * PROJECT & FRAMING — what the owner actually asked for.
 *
 * SPEC: 08 §3.1, 03 §2.
 *
 * These are the traceability roots. Everything downstream — every feature, requirement,
 * architecture decision and test — must eventually point back to a ProjectGoal or an
 * approved Proposal, and `SC-RTC-007` exists to find the things that do not.
 */

/**
 * The owner's words, kept exactly as they arrived.
 *
 * Immutable on purpose (03 §2). Serva's first act is to interpret the idea, and the
 * interpretation is frequently where meaning is lost; keeping the original text means a
 * later reader can check the interpretation against what was actually said rather than
 * against a summary of it.
 */
export const IdeaSchema = artifact({
  rawText: z.string().min(1),
  capturedAt: IsoSchema,
});
export type Idea = z.output<typeof IdeaSchema>;

/**
 * The structured intake, derived from the Idea.
 *
 * `successDefinition` is separate from `problem` because "what is wrong" and "what would
 * count as fixed" are different questions, and a project that never answers the second
 * cannot tell whether it succeeded.
 */
export const ClientInputSchema = artifact({
  ideaRef: RefSchema,
  problem: z.string().min(1),
  audience: z.string().min(1),
  successDefinition: z.string().min(1),
  commercialRequirements: z.array(z.string().min(1)).default([]),
});
export type ClientInput = z.output<typeof ClientInputSchema>;

/** A traceability root. Every feature must reach one of these, or an approved Proposal. */
export const ProjectGoalSchema = artifact({
  statement: z.string().min(1),
  /** How anyone would know this was achieved. A goal with no indicator is a wish. */
  successIndicator: z.string().min(1),
  priority: z.enum(['MUST', 'SHOULD', 'COULD', 'WONT']),
});
export type ProjectGoal = z.output<typeof ProjectGoalSchema>;

export const ConstraintType = {
  TECHNICAL: 'TECHNICAL',
  BUSINESS: 'BUSINESS',
  LEGAL: 'LEGAL',
  RESOURCE: 'RESOURCE',
  TIME: 'TIME',
  EXISTING_SYSTEM: 'EXISTING_SYSTEM',
} as const;
export type ConstraintType = (typeof ConstraintType)[keyof typeof ConstraintType];

/**
 * A limit on the solution space.
 *
 * `negotiable` matters more than it looks: an owner's "we must launch by March" and "we
 * use PostgreSQL because that is what the team knows" constrain Serva very differently,
 * and treating a preference as a hard constraint quietly removes options that should have
 * been considered.
 */
export const ConstraintSchema = artifact({
  type: enumOf(ConstraintType),
  statement: z.string().min(1),
  negotiable: z.boolean(),
});
export type Constraint = z.output<typeof ConstraintSchema>;

export const AssumptionStatus = {
  UNVALIDATED: 'UNVALIDATED',
  VALIDATED: 'VALIDATED',
  INVALIDATED: 'INVALIDATED',
  ACCEPTED_AS_RISK: 'ACCEPTED_AS_RISK',
} as const;
export type AssumptionStatus = (typeof AssumptionStatus)[keyof typeof AssumptionStatus];

/**
 * Something Serva is proceeding as if it were true.
 *
 * SPEC: 08 §3.1 — "blocks unqualified PASS if load-bearing and unvalidated".
 *
 * This is where inference goes to become honest. An INFERRED fact that would change the
 * product must be promoted to one of these, and a load-bearing one that nobody has
 * validated is visible to the gate rather than buried in a paragraph. `validationApproach`
 * is required because "we assume X" without "and here is how we could find out" is not a
 * plan, it is a hope.
 */
export const AssumptionSchema = artifact({
  statement: z.string().min(1),
  status: enumOf(AssumptionStatus),
  validationApproach: z.string().min(1),
  loadBearing: z.boolean(),
  /** What breaks if this is wrong. Drives Risk aggregation (§17). */
  ifWrong: z.string().min(1).optional(),
  riskRef: RefSchema.optional(),
});
export type Assumption = z.output<typeof AssumptionSchema>;

export const OpenQuestionState = {
  OPEN: 'OPEN',
  ANSWERED: 'ANSWERED',
  WITHDRAWN: 'WITHDRAWN',
} as const;
export type OpenQuestionState = (typeof OpenQuestionState)[keyof typeof OpenQuestionState];

/** Something Serva does not know and cannot responsibly decide for itself. */
export const OpenQuestionSchema = artifact({
  question: z.string().min(1),
  /** What cannot proceed until this is answered. An empty list means it is not blocking. */
  blocks: z.array(IdSchema).default([]),
  askedOf: z.enum(['OWNER', 'RESEARCH', 'EXPERT']),
  state: enumOf(OpenQuestionState),
  answer: z.string().min(1).optional(),
  answeredAt: IsoSchema.optional(),
});
export type OpenQuestion = z.output<typeof OpenQuestionSchema>;
