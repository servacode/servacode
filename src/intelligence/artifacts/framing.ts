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
  /**
   * Who owes the answer.
   *
   * `UPSTREAM_DEPARTMENT` joins the original three because classification without routing
   * is just a label: a question Serva can prove another department owes must become an
   * obligation on that department, not a sentence in a log and a generic failure.
   */
  askedOf: z.enum(['OWNER', 'RESEARCH', 'EXPERT', 'UPSTREAM_DEPARTMENT']),
  state: enumOf(OpenQuestionState),
  answer: z.string().min(1).optional(),
  answeredAt: IsoSchema.optional(),

  /**
   * Where the question came from, and what would settle it.
   *
   * All of it durable, because the process that raises a question is rarely the process
   * that answers it. An obligation that lives only in a running orchestrator disappears
   * on restart, and one that cannot say which canon it is waiting for cannot be closed by
   * anything except a person noticing.
   */
  raisedBy: z.string().min(1).optional(),
  raisedByRun: z.string().min(1).optional(),
  /** The envelope field(s) the run filed it in. Provenance; never routing. */
  sourceFields: z.array(z.string().min(1)).default([]),
  /** The canon family that would answer it, where Serva can name one. */
  missingCanon: z.string().min(1).optional(),
  /** The stage that owes that canon. */
  owedByStage: z.string().min(1).optional(),
  /** The research request raised to answer it, for an askedOf === RESEARCH question. */
  researchRequestRef: RefSchema.optional(),
  /**
   * The canon that actually settled it.
   *
   * `state` says OPEN or ANSWERED and `answer` says it in words; this says which artifacts
   * a reader can go and check. Without it a fulfilled obligation is a sentence claiming
   * evidence exists, which is the shape of every finding this phase has had to unpick.
   */
  resolvedByRefs: z.array(RefSchema).default([]),
});
export type OpenQuestion = z.output<typeof OpenQuestionSchema>;

/**
 * IS THIS SETTLED QUESTION SOMETHING SERVA MAY ACT ON, FOR THIS DEPARTMENT?
 *
 * SPEC: HIGH finding ORGANIZATIONAL-LEARNING-EXECUTION-AND-RESEARCH/OLER-CTX-1, 1.0.1 review.
 *
 * OPEN_QUESTION is UNIVERSAL in the authority model: any department may write one. The runner
 * turned an ANSWERED one into a directive in another department's TRUSTED context — "this is a
 * decision, proceed on it, do not raise it again" — and pulled in every canon its
 * `resolvedByRefs` named, on the strength of `raisedBy`, `state` and `answer` alone. All three
 * are body fields written by whoever wrote the artifact, so a department could forge a
 * settlement, address it to a TARGET department, and put words in its context.
 *
 * The sibling path had already been hardened for exactly this shape: an owner decision reaching
 * a department's context must satisfy `isAuthoritativeOwnerAnswer` AND carry attribution
 * matching that department and work item. The guard went into one path and not the other —
 * which is the class this review keeps finding, so this is the single predicate both use.
 *
 * What it requires, and why each one:
 *
 *   ANSWERED with an answer or resolving canon — a settlement that settles nothing is not one;
 *   `resolvedByRefs` non-empty — the legitimate writer always names the canon that discharged
 *     it, precisely so a reader can check rather than believe a sentence;
 *   attribution naming THIS department's agent — a forger writes under its own attribution,
 *     and `put` never re-stamps meta, so the raiser's identity survives the fulfilment;
 *   the same work item — a settlement from another item says nothing about this one.
 */
export function isSettlementFor(
  q: OpenQuestion,
  who: { readonly departmentId: string; readonly agentId: string; readonly workItemId?: string },
): boolean {
  if (q.state !== 'ANSWERED') return false;
  if (q.raisedBy !== who.departmentId) return false;
  if (q.meta.attribution.agentId !== who.agentId) return false;
  if (who.workItemId !== undefined && q.meta.workItemId !== who.workItemId) return false;
  if (q.resolvedByRefs.length === 0) return false;
  return q.answer !== undefined && q.answer.trim() !== '';
}
