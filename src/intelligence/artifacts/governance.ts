import { z } from 'zod';
import { IsoSchema } from '../../domain/schemas.js';
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
  /**
   * The canon family this proposal would change.
   *
   * Required, because it is what decides who may accept it. Without it, "the authority
   * that owns the affected canon" is a sentence in a specification rather than a check:
   * the implementation could only ask whether the accepter differed from the proposer,
   * and any unrelated agent satisfies that.
   *
   * A proposal that cannot name what it would change is a proposal nobody can rule on.
   */
  affectsCanon: z.string().min(1),
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
  /**
   * What re-entry actually obliged, recorded when it was applied.
   *
   * Durable because the process that applies re-entry is not the process that later asks
   * whether the obligations were met. Without it, IMPLEMENTED is a claim; with it, it is
   * a statement that can be checked against the ledger and the gate results.
   */
  reentry: z
    .object({
      workItemId: z.string().min(1),
      appliedAt: IsoSchema,
      reentryStageId: z.string().min(1),
      stagesToRerun: z.array(z.string().min(1)).default([]),
      gatesInvalidated: z.array(z.string().min(1)).default([]),
    })
    .strict()
    .optional(),
});
export type ChangeRequest = z.output<typeof ChangeRequestSchema>;

/**
 * What answering an option MEANS, in a vocabulary rather than in English.
 *
 * SPEC: §32. This exists because approval was previously inferred from prose. An option
 * reading "Yes" authorised a change and an option reading "No" was indistinguishable from
 * it to any code that did not read English — so a decision the owner had REFUSED could
 * authorise the very thing they refused.
 *
 * A disposition is what Serva routes on. The prose is what the owner reads.
 */
export const OptionDisposition = {
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  DEFER: 'DEFER',
  /** Neither approves nor refuses: it supplies a fact or a preference Serva lacked. */
  INFORM: 'INFORM',
} as const;
export type OptionDisposition = (typeof OptionDisposition)[keyof typeof OptionDisposition];

/**
 * What the decision is FOR.
 *
 * A decision raised to unblock a stalled department is not an approval of anything, and
 * must never be usable as one. Purpose is checked alongside the target reference, because
 * either alone is forgeable by coincidence: an old decision that happens to reference this
 * change, or an approval decision that belongs to a different change.
 */
export const DecisionPurpose = {
  /** Authorises a specific ChangeRequest. The only purpose `approveChange` accepts. */
  CHANGE_APPROVAL: 'CHANGE_APPROVAL',
  /** Authorises a specific Proposal to become scope. */
  PROPOSAL_APPROVAL: 'PROPOSAL_APPROVAL',
  /** Supplies a business rule, policy or fact Serva may not invent. */
  BUSINESS_RULE: 'BUSINESS_RULE',
  /** Answers something a department could not proceed without. */
  SPECIFICATION_GAP: 'SPECIFICATION_GAP',
  /** Accepts a residual risk, a cost overrun, or similar. */
  RISK_ACCEPTANCE: 'RISK_ACCEPTANCE',
} as const;
export type DecisionPurpose = (typeof DecisionPurpose)[keyof typeof DecisionPurpose];

/**
 * Purposes a department may NOT mint.
 *
 * `OwnerDecisionRequest` is a universal artifact family — every department must be able to
 * stop and ask, or the authority boundary has a hole in it. But the FORM of consent is not
 * the same thing as the ability to ask a question: a decision whose purpose is
 * CHANGE_APPROVAL or PROPOSAL_APPROVAL is the artifact `approveChange` and `accept` later
 * read as authorisation.
 *
 * A department that could construct one could write its own approval, wait for anybody to
 * answer it, and hand the result to the function that authorises the thing it wanted. So
 * these two purposes are reserved to Serva's own authority functions —
 * `requestChangeApproval` and `requestProposalApproval` — and the write boundary refuses
 * them to everyone else.
 *
 * The informational purposes are deliberately NOT reserved. A department raising
 * "what is the collection window?" is doing its job.
 */
export const RESERVED_PURPOSES: readonly DecisionPurpose[] = Object.freeze([
  DecisionPurpose.CHANGE_APPROVAL,
  DecisionPurpose.PROPOSAL_APPROVAL,
]);

/**
 * A decision that is genuinely the owner's to make.
 *
 * SPEC: §32. Written in business language, with a recommendation — the owner is being
 * asked to exercise authority, not to do Serva's analysis for it.
 *
 * `answeredBy` may never be an agent. `ownerDecisionRefusal` enforces that: an AI response
 * cannot impersonate owner approval, which is the difference between a governed company
 * and a system that asks itself for permission.
 *
 * `purpose` and `targetRef` together make an answer PURPOSE-BOUND. Without them an
 * approval is a free-floating "the owner said yes to something", and any code looking for
 * consent will find some. With them, consent is a statement about one named artifact and
 * cannot be borrowed by another.
 */
/**
 * How the owner is expected to answer.
 *
 * OPTION decisions are a choice between things Serva has already worked out. VALUE
 * decisions are questions where the answer is a fact only the owner has — how long a
 * reservation is held, what the cancellation fee is, whether an inventory system exists.
 *
 * Before this distinction existed, a department asking "what is the collection window?"
 * could only offer "Answer it, and Serva records the answer as company truth" — and the
 * stored answer was that sentence. On resume the department was told the owner had
 * answered "Answer it", which is not a collection window. The owner's only workable move
 * was to DEFER something they actually wanted to specify.
 */
export const ResponseMode = {
  /** Choose one of the offered options. The only mode that can carry APPROVE. */
  OPTION: 'OPTION',
  /** Supply a fact. Always INFORMATION, never authorisation. */
  VALUE: 'VALUE',
} as const;
export type ResponseMode = (typeof ResponseMode)[keyof typeof ResponseMode];

/** What kind of value a VALUE decision expects, so the answer can be checked. */
export const ValueKind = {
  TEXT: 'TEXT',
  NUMBER: 'NUMBER',
  BOOLEAN: 'BOOLEAN',
  DATE: 'DATE',
  DURATION: 'DURATION',
  ENUM: 'ENUM',
} as const;
export type ValueKind = (typeof ValueKind)[keyof typeof ValueKind];

export const OwnerDecisionRequestSchema = artifact({
  question: z.string().min(1),
  /**
   * OPTION by default, so every existing decision keeps its meaning.
   *
   * A VALUE decision may not be an approval purpose. That is enforced below rather than
   * left to convention: free text containing the word "yes" must never become consent, and
   * the surest way to guarantee that is for approval and free text to be different shapes.
   */
  responseMode: enumOf(ResponseMode).default(ResponseMode.OPTION),
  valueKind: enumOf(ValueKind).optional(),
  /** For ENUM, the permitted values. For NUMBER, an optional unit to state in the prompt. */
  valueChoices: z.array(z.string().min(1)).default([]),
  valueUnit: z.string().min(1).optional(),
  whyServaCannotDecide: z.string().min(1),
  /** What answering this decides. Routed on; never inferred from the question text. */
  purpose: enumOf(DecisionPurpose),
  /**
   * The artifact this decision is ABOUT.
   *
   * Required for the approval purposes, because an approval with no target approves
   * nothing in particular — which is exactly how an unrelated answer came to authorise an
   * M4 change. Optional for the others, where the decision supplies information rather
   * than consent.
   */
  targetRef: RefSchema.optional(),
  /** Further artifacts the answer bears on, for the audit trail. */
  supportingRefs: z.array(RefSchema).default([]),
  /**
   * The choices, for an OPTION decision. Empty for a VALUE decision, which has none.
   *
   * `optionsRefusal` enforces the two-option minimum where it applies — a schema-level
   * `.min(2)` would make VALUE decisions unrepresentable.
   */
  options: z
    .array(
      z
        .object({
          option: z.string().min(1),
          impact: z.string().min(1),
          /** What choosing this MEANS. Serva routes on this, not on the wording. */
          disposition: enumOf(OptionDisposition),
          costImplication: z.string().min(1).optional(),
          riskImplication: z.string().min(1).optional(),
        })
        .strict(),
    )
    .default([]),
  recommendation: z.string().min(1),
  recommendationRationale: z.string().min(1),
  blocksWork: z.boolean(),
  blockedRefs: z.array(RefSchema).default([]),
  state: z.enum(['OPEN', 'ANSWERED', 'WITHDRAWN']),
  chosenOption: z.string().min(1).optional(),
  /**
   * The owner's actual answer, for a VALUE decision.
   *
   * INFORMATION, always. `chosenDisposition` returns undefined for a VALUE decision and
   * `approvalRefusal` refuses one outright, so no amount of agreeable prose here can
   * authorise a change or a proposal.
   */
  answerValue: z.string().min(1).optional(),
  answeredBy: z.string().min(1).optional(),
  answeredAt: z.string().min(1).optional(),
});
export type OwnerDecisionRequest = z.output<typeof OwnerDecisionRequestSchema>;

/** The disposition the owner actually chose, or undefined if unanswered or a VALUE. */
export function chosenDisposition(d: OwnerDecisionRequest): OptionDisposition | undefined {
  if (d.state !== 'ANSWERED') return undefined;
  /* A VALUE answer has no disposition. Information is not consent. */
  if (d.responseMode === ResponseMode.VALUE) return undefined;
  if (d.chosenOption === undefined) return undefined;
  return d.options.find((o) => o.option === d.chosenOption)?.disposition;
}

/**
 * Is this decision well formed for how it expects to be answered?
 *
 * Returns the reason it is not. Two rules carry the weight:
 *
 *   an OPTION decision needs at least two options, or it is not a choice;
 *   a VALUE decision may not carry an approval purpose, because its answer is free text
 *   and free text must never be routed on. Approval comes from a typed disposition or it
 *   does not come at all.
 */
export function decisionShapeRefusal(d: OwnerDecisionRequest): string | undefined {
  if (d.responseMode === ResponseMode.VALUE) {
    if ((RESERVED_PURPOSES as readonly string[]).includes(d.purpose)) {
      return (
        'decision ' +
        d.id +
        ' asks for a VALUE but its purpose is ' +
        d.purpose +
        ': an approval is a typed disposition, never free text'
      );
    }
    if (d.options.length > 0) {
      return 'decision ' + d.id + ' asks for a VALUE and also offers options';
    }
    if (d.valueKind === undefined) {
      return 'decision ' + d.id + ' asks for a VALUE without saying what kind';
    }
    if (d.valueKind === ValueKind.ENUM && d.valueChoices.length < 2) {
      return 'decision ' + d.id + ' is an ENUM with fewer than two choices';
    }
    return undefined;
  }
  if (d.options.length < 2) {
    return 'decision ' + d.id + ' offers ' + String(d.options.length) + ' option(s): not a choice';
  }
  return undefined;
}

/**
 * Is this a well-formed answer to what was asked?
 *
 * For OPTION, the answer must be one of the options offered. For VALUE, it must satisfy
 * the declared kind — a question that asked for a number is not answered by "soon".
 */
export function answerRefusal(
  d: OwnerDecisionRequest,
  answer: { readonly option?: string; readonly value?: string },
): string | undefined {
  if (d.responseMode === ResponseMode.VALUE) {
    if (answer.value === undefined || answer.value.trim() === '') {
      return 'decision ' + d.id + ' asks for a value, and none was given';
    }
    if (answer.option !== undefined) {
      return 'decision ' + d.id + ' asks for a value, not a choice between options';
    }
    const v = answer.value.trim();
    switch (d.valueKind) {
      case ValueKind.NUMBER:
        if (!/^-?\d+(\.\d+)?$/.test(v)) return '"' + v + '" is not a number';
        break;
      case ValueKind.BOOLEAN:
        if (!/^(yes|no|true|false)$/i.test(v)) return '"' + v + '" is not yes or no';
        break;
      case ValueKind.DATE:
        if (Number.isNaN(Date.parse(v))) return '"' + v + '" is not a date';
        break;
      case ValueKind.ENUM:
        if (!d.valueChoices.includes(v)) {
          return '"' + v + '" is not one of: ' + d.valueChoices.join(', ');
        }
        break;
      default:
        break;
    }
    return undefined;
  }

  if (answer.value !== undefined) {
    return 'decision ' + d.id + ' is a choice between options, not a free-text question';
  }
  if (answer.option === undefined || !d.options.some((o) => o.option === answer.option)) {
    return (
      '"' +
      String(answer.option) +
      '" is not one of the options offered on ' +
      d.id +
      '. They are: ' +
      d.options.map((o) => '"' + o.option + '"').join(', ')
    );
  }
  return undefined;
}

/**
 * May this decision authorise `targetId` for `purpose`?
 *
 * Returns the reason it may not, so a caller can report it rather than only refuse. Every
 * clause here is a way an approval was previously borrowable:
 *
 *   not answered            — an open question is not consent
 *   answered by an agent    — the system asking itself for permission
 *   wrong purpose           — a decision raised to unblock a stage is not an approval
 *   wrong target            — the owner approved something, but not this
 *   option not on the form  — an answer that was never offered
 *   disposition not APPROVE — the owner said no, and "no" is not "yes"
 */
export function approvalRefusal(
  d: OwnerDecisionRequest | undefined,
  o: { readonly purpose: DecisionPurpose; readonly targetId: string },
): string | undefined {
  if (d === undefined) return 'no such owner decision exists';
  if (d.state !== 'ANSWERED') return 'owner decision ' + d.id + ' is ' + d.state + ', not ANSWERED';

  const impersonation = ownerDecisionRefusal(d);
  if (impersonation !== undefined) return impersonation;

  if (d.responseMode === ResponseMode.VALUE) {
    /*
     * A VALUE answer is information. Its text may well contain "yes", "approved" or
     * "go ahead" — and none of those is consent, because consent is a typed disposition on
     * an option Serva offered. This is the clause that keeps free text out of authority.
     */
    return (
      'owner decision ' +
      d.id +
      ' is a VALUE question: its answer is information, and information is not approval'
    );
  }

  if (d.purpose !== o.purpose) {
    return (
      'owner decision ' +
      d.id +
      ' was raised for ' +
      d.purpose +
      ', not ' +
      o.purpose +
      ': answering a question is not approving a change'
    );
  }

  const bound =
    d.targetRef?.id === o.targetId ||
    d.blockedRefs.some((r) => r.id === o.targetId) ||
    d.supportingRefs.some((r) => r.id === o.targetId);
  if (!bound) {
    return (
      'owner decision ' +
      d.id +
      ' does not name ' +
      o.targetId +
      ': the owner approved something, but not this'
    );
  }

  const chosen = d.options.find((opt) => opt.option === d.chosenOption);
  if (chosen === undefined) {
    return (
      'owner decision ' +
      d.id +
      ' records the answer "' +
      String(d.chosenOption) +
      '", which is not one of the options it offered'
    );
  }
  if (chosen.disposition !== OptionDisposition.APPROVE) {
    return (
      'the owner chose "' +
      chosen.option +
      '" on ' +
      d.id +
      ', which is a ' +
      chosen.disposition +
      ' — not an approval'
    );
  }
  return undefined;
}

/** An owner decision answered by anything other than the owner is not a decision. */
/**
 * IS THIS AN OWNER ANSWER SERVA MAY ACT ON?
 *
 * SPEC: HIGH finding ORGANIZATIONAL-LEARNING-EXECUTION-AND-RESEARCH/F1-OWNER-ANSWER-TRUST.
 *
 * `ownerDecisionRefusal` has always known what a real owner answer looks like, and only one
 * of its three consumers asked it. The other two filtered on `state === 'ANSWERED'` alone —
 * and `OWNER_DECISION_REQUEST` is universal, so any department could persist an ANSWERED
 * decision attributed to itself, suppress the question the owner should have been asked, and
 * feed "the owner answered X" into its own trusted context.
 *
 * The boundary was enforced in one place and reinvented in two. This is the single predicate
 * every consumer now uses, so `state === 'ANSWERED'` can never again be sufficient by itself.
 */
export function isAuthoritativeOwnerAnswer(d: OwnerDecisionRequest): boolean {
  if (d.state !== 'ANSWERED') return false;
  return ownerDecisionRefusal(d) === undefined;
}

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
  /*
   * An answer, of whichever kind the question asked for.
   *
   * A VALUE decision has no chosen option and never will — requiring one here would make
   * every answered question look unanswered, and the orchestrator would refuse to resume
   * from an owner answer it had just been given.
   */
  if (d.responseMode === ResponseMode.VALUE) {
    if (d.answerValue === undefined || d.answerValue.trim() === '') {
      return 'OwnerDecisionRequest ' + d.id + ' is ANSWERED but records no value';
    }
    return undefined;
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
