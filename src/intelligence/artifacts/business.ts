import { z } from 'zod';
import { SourceMarking } from '../../vocab/index.js';
import { RefSchema, artifact, enumOf } from './base.js';

/**
 * BUSINESS ANALYSIS — the rules the software must obey.
 *
 * SPEC: 08 §3.3, 06 (SC-AGENT-040).
 *
 * The invariant: no important business behaviour may remain implicit for Engineering to
 * invent. A developer who has to guess what happens when a refund arrives after
 * settlement will guess something reasonable, ship it, and the company will discover its
 * own policy months later by reading the code.
 *
 * Financial logic gets its own escalation rule for that reason — see `financialRefusal`.
 */

export const ActorSchema = artifact({
  name: z.string().min(1),
  description: z.string().min(1),
  /** In business terms, not permission strings. "May approve refunds up to £500." */
  permissionsBusinessTerms: z.array(z.string().min(1)).default([]),
});
export type Actor = z.output<typeof ActorSchema>;

export const RoleSchema = artifact({
  name: z.string().min(1),
  description: z.string().min(1),
  actorRefs: z.array(RefSchema).default([]),
  permissionsBusinessTerms: z.array(z.string().min(1)).default([]),
});
export type Role = z.output<typeof RoleSchema>;

export const RuleAuthority = {
  /** The owner said so. The strongest form for a business rule. */
  OWNER_CONFIRMED: 'OWNER_CONFIRMED',
  /** Imposed from outside — statute, regulator, payment scheme. */
  LEGAL_OR_REGULATORY: 'LEGAL_OR_REGULATORY',
  /** Serva derived it from other confirmed rules. Traceable, but not independent. */
  DERIVED: 'DERIVED',
  /** Nobody has confirmed it. Cannot govern money. */
  PROPOSED: 'PROPOSED',
} as const;
export type RuleAuthority = (typeof RuleAuthority)[keyof typeof RuleAuthority];

/**
 * One rule the product must enforce.
 *
 * `rationale` is required because a rule without one cannot be safely changed later: the
 * next person cannot tell whether it encodes a legal obligation or somebody's preference
 * from three years ago.
 */
export const BusinessRuleSchema = artifact({
  statement: z.string().min(1),
  rationale: z.string().min(1),
  authority: enumOf(RuleAuthority),
  ownerConfirmed: z.boolean(),
  /** Where this rule bites: entity, process, or state transition. */
  appliesTo: z.array(z.string().min(1)).default([]),
  supersedes: RefSchema.optional(),
});
export type BusinessRule = z.output<typeof BusinessRuleSchema>;

export const ProcessModelSchema = artifact({
  name: z.string().min(1),
  steps: z
    .array(
      z
        .object({
          order: z.number().int().min(1),
          actorRef: RefSchema.optional(),
          action: z.string().min(1),
        })
        .strict(),
    )
    .min(1),
  /** The unhappy paths. A process with no exceptions has not been thought about. */
  exceptions: z
    .array(z.object({ when: z.string().min(1), then: z.string().min(1) }).strict())
    .default([]),
});
export type ProcessModel = z.output<typeof ProcessModelSchema>;

/**
 * The lifecycle of a stateful entity, with guards.
 *
 * Guards are required on transitions rather than optional. "Order can go from PLACED to
 * SHIPPED" is not a specification; "…when payment has cleared and stock is reserved" is.
 * Engineering cannot invent the guard safely, and QA cannot test a transition whose
 * precondition nobody wrote down.
 */
export const StateMachineSchema = artifact({
  entityRef: z.string().min(1),
  states: z.array(z.string().min(1)).min(2),
  initialState: z.string().min(1),
  terminalStates: z.array(z.string().min(1)).default([]),
  transitions: z
    .array(
      z
        .object({
          from: z.string().min(1),
          to: z.string().min(1),
          trigger: z.string().min(1),
          guard: z.string().min(1),
          ruleRefs: z.array(RefSchema).default([]),
        })
        .strict(),
    )
    .min(1),
});
export type StateMachine = z.output<typeof StateMachineSchema>;

/** One meaning per term (08 §3.3). Two definitions of "order" is a defect factory. */
export const GlossarySchema = artifact({
  terms: z
    .array(
      z
        .object({
          term: z.string().min(1),
          definition: z.string().min(1),
          notTobeConfusedWith: z.string().min(1).optional(),
        })
        .strict(),
    )
    .min(1),
});
export type Glossary = z.output<typeof GlossarySchema>;

/**
 * Money. The one area where inventing a rule is never acceptable.
 *
 * SPEC: §8 — fees, commissions, tax, wallet behaviour, refunds and settlement must never
 * be fabricated. If it is not owner-stated or legally established, the correct output is
 * an OwnerDecisionRequest, not a plausible default.
 *
 * A "reasonable" 2.5% commission invented by an agent is indistinguishable from a real
 * one until it is charged to a customer.
 */
export const FinancialLogicSchema = artifact({
  area: z.enum([
    'FEES',
    'COMMISSION',
    'TAX',
    'WALLET',
    'REFUND',
    'SETTLEMENT',
    'PRICING',
    'PAYOUT',
  ]),
  statement: z.string().min(1),
  authority: enumOf(RuleAuthority),
  /** Worked example. Ambiguity in money is usually only visible in arithmetic. */
  workedExample: z.string().min(1).optional(),
  ownerDecisionRef: RefSchema.optional(),
});
export type FinancialLogic = z.output<typeof FinancialLogicSchema>;

/**
 * Financial logic that nobody with the authority to decide it has decided.
 *
 * Returns the reason it cannot stand, or undefined. Not a Zod refinement, because the
 * right response is an OwnerDecisionRequest on a gate rather than a parse failure.
 */
export function financialRefusal(f: FinancialLogic): string | undefined {
  const authoritative =
    f.authority === RuleAuthority.OWNER_CONFIRMED ||
    f.authority === RuleAuthority.LEGAL_OR_REGULATORY;
  if (authoritative) return undefined;
  if (f.ownerDecisionRef !== undefined) return undefined;
  if (f.meta.provenance.marking === SourceMarking.OWNER_STATED) return undefined;
  return (
    'OWNER_DECISION_REQUIRED: financial logic for ' +
    f.area +
    ' is neither owner-confirmed nor legally established, and Serva does not invent money rules'
  );
}

/**
 * Two rules that cannot both hold.
 *
 * Recorded rather than resolved. Serva can detect that "refunds are always permitted
 * within 14 days" and "no refund after dispatch" collide; deciding which one the business
 * actually means is the owner's call.
 */
export const RuleContradictionSchema = artifact({
  ruleRefs: z.array(RefSchema).min(2),
  explanation: z.string().min(1),
  resolvedBy: RefSchema.optional(),
});
export type RuleContradiction = z.output<typeof RuleContradictionSchema>;
