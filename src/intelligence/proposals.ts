import { fail } from '../core/errors.js';
import { AuditAction, audit } from '../events/audit.js';
import { ARTIFACT_TYPES, canonExists, repository } from './repository.js';
import {
  DecisionPurpose,
  OptionDisposition,
  OwnerDecisionRequestSchema,
  ProposalSchema,
  ProposalState,
  approvalRefusal,
} from './artifacts/governance.js';
import { readTerminalSnapshot, runStream } from '../events/agentRun.js';
import { RunOutcome } from '../vocab/index.js';
import { ContractRegistry } from '../agents/registry.js';
import { contractOutputTypes } from './execution/authority.js';
import type { OwnerDecisionRequest, Proposal } from './artifacts/governance.js';
import type { Store } from '../store/store.js';
import type { Clock } from '../core/clock.js';
import type { IdSource } from '../core/ids.js';

/**
 * THE PROPOSAL LIFECYCLE.
 *
 * SPEC: §33, SC-WF-008.
 *
 * Any department may have a good idea. What no department may do is act on it.
 *
 * The failure mode is specific and extremely common: a designer notices the product would
 * be better with a loyalty scheme, writes it into the flows, and three stages later it is
 * in the requirements, the data model and the estimate — and the owner is looking at a
 * quote for something they never asked for. Scope creep of that kind is never a decision;
 * it is a series of small reasonable additions nobody recorded as additions.
 *
 * So a proposal is a first-class artifact with a state machine, and the states are the
 * governance:
 *
 *   PROPOSED     — raised. It is NOT scope. Nothing may reference it.
 *   ASSESSED     — value, complexity, cost, risk and scope effect are all on record.
 *   ACCEPTED     — the owning authority said yes. Still not built.
 *   REJECTED     — with a rationale kept forever, so it is not re-argued each quarter.
 *   DEFERRED     — a real answer, distinct from being ignored.
 *   INCORPORATED — the canon it changed now exists, and points back at it.
 *
 * Two transitions are the ones that matter. ACCEPTED requires an assessment, because
 * "yes" to something nobody costed is not a decision. INCORPORATED requires the canon it
 * became to actually exist, because otherwise a proposal can be marked done by claim.
 */

export interface ProposalDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdSource;
}

/** The transitions this state machine permits. Everything else is refused by name. */
const ALLOWED: Readonly<Record<ProposalState, readonly ProposalState[]>> = Object.freeze({
  [ProposalState.PROPOSED]: [ProposalState.ASSESSED, ProposalState.REJECTED],
  [ProposalState.ASSESSED]: [
    ProposalState.ACCEPTED,
    ProposalState.REJECTED,
    ProposalState.DEFERRED,
  ],
  [ProposalState.ACCEPTED]: [ProposalState.INCORPORATED, ProposalState.DEFERRED],
  /* Deferred is revisitable — that is the whole difference between it and rejected. */
  [ProposalState.DEFERRED]: [
    ProposalState.ASSESSED,
    ProposalState.ACCEPTED,
    ProposalState.REJECTED,
  ],
  [ProposalState.REJECTED]: [],
  [ProposalState.INCORPORATED]: [],
});

function load(store: Store, id: string): Proposal {
  const p = repository(store, ARTIFACT_TYPES.PROPOSAL, ProposalSchema).get(id);
  if (p === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'No proposal ' + id + ' exists',
      remedy: 'Raise it before moving it.',
      specRef: '§33',
    });
  }
  return p;
}

function save(deps: ProposalDeps, next: Proposal, detail: Record<string, unknown>): Proposal {
  const tx = deps.store.begin();
  try {
    const stored = repository(deps.store, ARTIFACT_TYPES.PROPOSAL, ProposalSchema).put(tx, next);
    audit(tx, {
      action: AuditAction.ARTIFACT_RECORDED,
      subject: next.id,
      outcome: 'OK',
      detail: { state: next.state, ...detail },
    });
    tx.commit();
    return stored;
  } catch (e) {
    tx.rollback();
    throw e;
  }
}

function assertTransition(from: ProposalState, to: ProposalState): void {
  if (ALLOWED[from].includes(to)) return;
  fail({
    code: 'E_INVALID_TRANSITION',
    message: 'A proposal cannot go from ' + from + ' to ' + to,
    remedy:
      'The order exists to stop an idea becoming scope without being costed or agreed. Permitted from ' +
      from +
      ': ' +
      (ALLOWED[from].length === 0
        ? 'nothing — this is a terminal state'
        : ALLOWED[from].join(', ')),
    details: { from, to },
    specRef: '§33',
  });
}

/**
 * Who may accept a proposal that would change this canon family.
 *
 * Resolved from the same canonical output authority the write boundary uses: the agent
 * whose contract declares an artifact family owns decisions about it. That is not a new
 * rule invented for proposals — it is the rule already enforced on every write, asked from
 * the other direction.
 *
 * Returns an empty set for a family nobody owns, which is deliberate: an unowned family
 * escalates to the owner rather than defaulting to anyone-may-accept.
 */
export function owningAuthorities(canonType: string): ReadonlySet<string> {
  const registry = ContractRegistry.shared();
  const owners = new Set<string>();
  for (const contract of registry.all()) {
    if (contractOutputTypes(contract).types.includes(canonType as never)) {
      owners.add(contract.id);
    }
  }
  return owners;
}

/**
 * Raise the approval question for a proposal. The ONLY way to mint proposal consent.
 *
 * `PROPOSAL_APPROVAL` is a reserved purpose: the scoped writer refuses it to every
 * department, so this function and `requestChangeApproval` are the only places the FORM of
 * consent exists. Serva writes the options and their dispositions, because a department
 * able to author an APPROVE option could author its own approval.
 */
export function requestProposalApproval(
  deps: ProposalDeps,
  o: { readonly proposalId: string; readonly workItemId?: string },
): OwnerDecisionRequest {
  const p = load(deps.store, o.proposalId);
  if (p.state !== ProposalState.ASSESSED && p.state !== ProposalState.DEFERRED) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Proposal ' + p.id + ' is ' + p.state + ', not ASSESSED',
      remedy:
        'Assess a proposal before asking anybody to accept it. Accepting an idea nobody costed is not a decision.',
      specRef: '""" + SEC + """33',
    });
  }

  const at = deps.clock.now();
  const request = OwnerDecisionRequestSchema.parse({
    id: deps.ids.next('SC-ODR'),
    createdAt: at,
    question: 'Should this become scope? "' + p.title + '" — ' + p.description,
    whyServaCannotDecide:
      'It would change ' +
      p.affectsCanon +
      ', and no agent owns that family. Adding it is a decision about what the product IS.',
    purpose: DecisionPurpose.PROPOSAL_APPROVAL,
    targetRef: { id: p.id, version: p.version },
    supportingRefs: [],
    options: [
      {
        option: 'Accept it into scope',
        impact: 'the proposal may be incorporated into ' + p.affectsCanon,
        disposition: OptionDisposition.APPROVE,
      },
      {
        option: 'Reject it',
        impact: 'the proposal is closed, and the rationale is kept so it is not re-argued',
        disposition: OptionDisposition.REJECT,
      },
      {
        option: 'Defer it',
        impact: 'the proposal stays on record and may be revisited',
        disposition: OptionDisposition.DEFER,
      },
    ],
    recommendation: 'Defer it',
    recommendationRationale:
      'Most proposals are good ideas at the wrong time. Deferring keeps it on record without enlarging what has already been agreed.',
    blocksWork: false,
    blockedRefs: [{ id: p.id }],
    state: 'OPEN',
    meta: {
      provenance: { marking: 'SYSTEM', component: 'proposal-approval' },
      attribution: { at },
      ...(o.workItemId === undefined ? {} : { workItemId: o.workItemId }),
    },
  });

  const tx = deps.store.begin();
  try {
    repository(deps.store, ARTIFACT_TYPES.OWNER_DECISION_REQUEST, OwnerDecisionRequestSchema).put(
      tx,
      request,
    );
    audit(tx, {
      action: AuditAction.ARTIFACT_RECORDED,
      subject: request.id,
      outcome: 'OK',
      detail: { purpose: DecisionPurpose.PROPOSAL_APPROVAL, proposal: p.id },
    });
    tx.commit();
  } catch (e) {
    tx.rollback();
    throw e;
  }
  return request;
}

/**
 * Why this acceptance is not authorised, or undefined if it is.
 *
 * THE EVENT, NOT THE LABEL.
 *
 * The previous rule read a caller-supplied `acceptedBy` string and asked whether it NAMED
 * an owning agent — which proves the name of an authority, not that the authority acted.
 * A caller could pass `"SC-AGENT-020"` with no Product Manager run anywhere in the Store,
 * or pass any string without `SC-AGENT-` and be treated as the owner.
 *
 * Acceptance now requires a durable event:
 *
 *   agent-owned canon — a completed, governed AgentRun by an owning authority, whose
 *   result names this exact proposal. The run is looked up in the Store; the caller
 *   supplies its id, not its conclusion.
 *
 *   owner-reserved canon — an answered OwnerDecisionRequest with purpose
 *   PROPOSAL_APPROVAL, targeting this proposal, on an option whose disposition is APPROVE.
 *   `approvalRefusal` checks all of it, exactly as it does for a change.
 */
export function acceptanceRefusal(
  store: Store,
  p: Proposal,
  o: { readonly authorityRunId?: string; readonly ownerDecisionId?: string },
): string | undefined {
  const owners = owningAuthorities(p.affectsCanon);

  /* ------------------------------------------------ owner-reserved: no agent owns it */
  if (owners.size === 0) {
    if (o.ownerDecisionId === undefined) {
      return (
        'no agent owns ' +
        p.affectsCanon +
        ', so proposal ' +
        p.id +
        ' needs an owner decision. Raise one with requestProposalApproval.'
      );
    }
    const decision = repository(
      store,
      ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
      OwnerDecisionRequestSchema,
    ).get(o.ownerDecisionId);
    return approvalRefusal(decision, {
      purpose: DecisionPurpose.PROPOSAL_APPROVAL,
      targetId: p.id,
    });
  }

  /* ------------------------------------------- agent-owned: a governed run must exist */
  if (o.ownerDecisionId !== undefined) {
    /* The owner outranks the owning agent, so an owner approval is accepted here too. */
    const decision = repository(
      store,
      ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
      OwnerDecisionRequestSchema,
    ).get(o.ownerDecisionId);
    return approvalRefusal(decision, {
      purpose: DecisionPurpose.PROPOSAL_APPROVAL,
      targetId: p.id,
    });
  }

  if (o.authorityRunId === undefined) {
    return (
      'proposal ' +
      p.id +
      ' affects ' +
      p.affectsCanon +
      ', which belongs to ' +
      [...owners].sort().join(' or ') +
      '. Acceptance needs that authority\u2019s governed run, or an owner decision — not a name.'
    );
  }

  const snapshot = readTerminalSnapshot(store, o.authorityRunId) as
    { readonly agentId?: string; readonly outcome?: string } | undefined;
  if (snapshot === undefined) {
    return 'no governed run ' + o.authorityRunId + ' exists in this project';
  }
  if (snapshot.outcome !== RunOutcome.COMPLETED) {
    return (
      'run ' + o.authorityRunId + ' ended ' + String(snapshot.outcome) + ', so it decided nothing'
    );
  }
  if (snapshot.agentId === undefined || !owners.has(snapshot.agentId)) {
    return (
      'run ' +
      o.authorityRunId +
      ' was made by ' +
      String(snapshot.agentId) +
      ', which does not own ' +
      p.affectsCanon
    );
  }
  if (snapshot.agentId === p.origin) {
    return (
      'proposal ' +
      p.id +
      ' was raised by ' +
      p.origin +
      ' and accepted by its own run: an actor accepting its own idea is how scope grows without anybody agreeing to it'
    );
  }

  /*
   * The run must be ABOUT this proposal.
   *
   * Checked against the run's own immutable event log rather than a summary, because the
   * terminal record does not carry the payload and a summary is the thing a caller would
   * be tempted to shape. A completed Product Manager run that happened to exist is not a
   * decision to accept something it never mentioned.
   */
  const mentioned = store
    .readTrace(runStream(o.authorityRunId))
    .some((e) => JSON.stringify(e.payload).includes(p.id));
  if (!mentioned) {
    return (
      'run ' +
      o.authorityRunId +
      ' never mentions proposal ' +
      p.id +
      ': an unrelated run by the right actor is not a decision about this one'
    );
  }
  return undefined;
}

/** Raise a proposal. This creates a record, and creates nothing else. */
export function propose(
  deps: ProposalDeps,
  o: {
    readonly title: string;
    readonly origin: string;
    readonly description: string;
    /** The canon family this would change. Decides who may accept it. */
    readonly affectsCanon: string;
  },
): Proposal {
  const at = deps.clock.now();
  return save(
    deps,
    ProposalSchema.parse({
      id: deps.ids.next('SC-PROP'),
      createdAt: at,
      title: o.title,
      origin: o.origin,
      description: o.description,
      affectsCanon: o.affectsCanon,
      state: ProposalState.PROPOSED,
      meta: {
        /*
         * A proposal is a suggestion, not a finding — INFERRED, and non-load-bearing by
         * construction, because nothing is permitted to depend on it until it has been
         * incorporated as something else.
         */
        provenance: {
          marking: 'INFERRED',
          basis: o.origin + ' proposed this while doing its own work',
          confidence: 'LOW',
          loadBearing: false,
        },
        attribution: { at, agentId: o.origin },
      },
    }),
    { origin: o.origin },
  );
}

/** Record the assessment. Value, cost, risk and scope effect — all of them or none. */
export function assess(
  deps: ProposalDeps,
  o: { readonly proposalId: string; readonly assessment: NonNullable<Proposal['assessment']> },
): Proposal {
  const p = load(deps.store, o.proposalId);
  assertTransition(p.state, ProposalState.ASSESSED);
  return save(
    deps,
    { ...p, state: ProposalState.ASSESSED, assessment: o.assessment },
    { complexity: o.assessment.implementationComplexity },
  );
}

/**
 * Accept a proposal.
 *
 * Takes a reference to an authority EVENT — a governed run, or an answered owner decision
 * — and resolves it against the Store. It does not take a name.
 */
export function accept(
  deps: ProposalDeps,
  o: {
    readonly proposalId: string;
    /** A completed governed run by the authority that owns the affected canon. */
    readonly authorityRunId?: string;
    /** An answered PROPOSAL_APPROVAL decision targeting this proposal. */
    readonly ownerDecisionId?: string;
  },
): Proposal {
  const p = load(deps.store, o.proposalId);
  assertTransition(p.state, ProposalState.ACCEPTED);
  if (p.assessment === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Proposal ' + p.id + ' has no assessment',
      remedy:
        'Accepting an idea nobody costed is not a decision. Record the value, complexity, cost, risk and scope effect first.',
      specRef: '""" + SEC + """33',
    });
  }

  const refusal = acceptanceRefusal(deps.store, p, o);
  if (refusal !== undefined) {
    return fail({
      code: 'E_GATE_AUTHORITY',
      message: 'Refusing to accept ' + p.id + ': ' + refusal,
      remedy:
        'A proposal is accepted by the authority that owns the canon it would change, acting — or by the owner answering a PROPOSAL_APPROVAL decision. A name is not an act.',
      details: {
        proposalId: p.id,
        affectsCanon: p.affectsCanon,
        owners: [...owningAuthorities(p.affectsCanon)].sort(),
      },
      specRef: '""" + SEC + """33',
    });
  }

  return save(
    deps,
    { ...p, state: ProposalState.ACCEPTED },
    {
      authorityRunId: o.authorityRunId ?? null,
      ownerDecisionId: o.ownerDecisionId ?? null,
    },
  );
}

/** Reject, with the rationale kept forever so the same idea is not re-argued blind. */
export function reject(
  deps: ProposalDeps,
  o: { readonly proposalId: string; readonly rationale: string },
): Proposal {
  const p = load(deps.store, o.proposalId);
  assertTransition(p.state, ProposalState.REJECTED);
  return save(deps, { ...p, state: ProposalState.REJECTED, rejectionRationale: o.rationale }, {});
}

/** Defer. A real answer, and distinguishable from having been ignored. */
export function defer(
  deps: ProposalDeps,
  o: { readonly proposalId: string; readonly rationale: string },
): Proposal {
  const p = load(deps.store, o.proposalId);
  assertTransition(p.state, ProposalState.DEFERRED);
  return save(deps, { ...p, state: ProposalState.DEFERRED, rejectionRationale: o.rationale }, {});
}

/**
 * Mark a proposal incorporated, once the canon it became exists.
 *
 * The references are checked against the Store rather than taken on trust. "Incorporated"
 * asserted with nothing to point at is the one claim in this lifecycle that would be worth
 * making falsely, because it is the one that closes the loop.
 */
export function incorporate(
  deps: ProposalDeps,
  o: {
    readonly proposalId: string;
    readonly incorporatedBy: string;
    readonly into: readonly { readonly id: string; readonly version?: number }[];
  },
): Proposal {
  const p = load(deps.store, o.proposalId);
  assertTransition(p.state, ProposalState.INCORPORATED);
  if (o.into.length === 0) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Proposal ' + p.id + ' claims incorporation into nothing',
      remedy: 'Incorporated means canon changed. Name what changed.',
      specRef: '§33',
    });
  }
  const missing = o.into.filter((r) => !canonExists(deps.store, r.id)).map((r) => r.id);
  if (missing.length > 0) {
    return fail({
      code: 'E_VALIDATION',
      message:
        'Proposal ' +
        p.id +
        ' claims incorporation into canon that does not exist: ' +
        missing.join(', '),
      remedy:
        'A proposal is incorporated when the artifact carrying it exists. Write the artifact, then close the proposal against it.',
      details: { missing },
      specRef: '§33',
    });
  }
  return save(
    deps,
    {
      ...p,
      state: ProposalState.INCORPORATED,
      incorporatedBy: o.incorporatedBy,
      incorporatedInto: o.into.map((r) => ({ ...r })),
    },
    { into: o.into.map((r) => r.id) },
  );
}

/**
 * Proposals that are not scope, and are not closed either.
 *
 * Surfaced rather than blocking. An open proposal does not make a product unready — it is
 * a suggestion nobody has ruled on, which is a normal state for a company to be in. What
 * would be wrong is for it to be invisible.
 */
export function openProposals(store: Store): readonly Proposal[] {
  return repository(store, ARTIFACT_TYPES.PROPOSAL, ProposalSchema)
    .list()
    .filter(
      (p) =>
        p.state === ProposalState.PROPOSED ||
        p.state === ProposalState.ASSESSED ||
        p.state === ProposalState.ACCEPTED,
    );
}

export { ProposalState };
