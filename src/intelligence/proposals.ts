import { fail } from '../core/errors.js';
import { AuditAction, audit } from '../events/audit.js';
import { ARTIFACT_TYPES, canonExists, repository } from './repository.js';
import { ProposalSchema, ProposalState } from './artifacts/governance.js';
import { ContractRegistry } from '../agents/registry.js';
import { contractOutputTypes } from './execution/authority.js';
import type { Proposal } from './artifacts/governance.js';
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
 * Why this actor may not accept this proposal, or undefined if they may.
 *
 * Three rules, in the order they matter:
 *
 *   the proposer may not accept their own idea — that is scope creep with a signature;
 *   an actor with no authority over the affected canon may not accept it — the previous
 *   rule was merely "different from the proposer", which any passing agent satisfies;
 *   a family nobody owns is the owner's to rule on, not an agent's.
 */
export function acceptanceRefusal(p: Proposal, acceptedBy: string): string | undefined {
  if (p.origin === acceptedBy) {
    return (
      'proposal ' +
      p.id +
      ' was raised and accepted by ' +
      acceptedBy +
      ': an actor accepting its own idea is how scope grows without anybody agreeing to it'
    );
  }

  const owners = owningAuthorities(p.affectsCanon);
  if (owners.size === 0) {
    /*
     * Nothing in `32` claims this family. That makes it owner-reserved rather than
     * unowned: somebody still has to decide, and the somebody is the person paying.
     */
    if (acceptedBy.startsWith('SC-AGENT-')) {
      return (
        'no agent owns ' +
        p.affectsCanon +
        ', so proposal ' +
        p.id +
        ' is the owner' +
        String.fromCharCode(0x2019) +
        's to accept, not ' +
        acceptedBy +
        String.fromCharCode(0x2019) +
        's'
      );
    }
    return undefined;
  }

  if (!owners.has(acceptedBy)) {
    /* A person may always accept: the owner outranks the canon's owning agent. */
    if (!acceptedBy.startsWith('SC-AGENT-')) return undefined;
    return (
      acceptedBy +
      ' does not own ' +
      p.affectsCanon +
      ', so it cannot accept proposal ' +
      p.id +
      '. That belongs to ' +
      [...owners].sort().join(' or ') +
      ', or to the owner.'
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
 * Accept a proposal. Requires the assessment, and accepting is still not building.
 *
 * `acceptedBy` is recorded because §33 makes acceptance the act of a named authority. A
 * proposal that accepted itself would be the scope creep this file exists to prevent,
 * wearing a state machine as a disguise.
 */
export function accept(
  deps: ProposalDeps,
  o: { readonly proposalId: string; readonly acceptedBy: string },
): Proposal {
  const p = load(deps.store, o.proposalId);
  assertTransition(p.state, ProposalState.ACCEPTED);
  if (p.assessment === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Proposal ' + p.id + ' has no assessment',
      remedy:
        'Accepting an idea nobody costed is not a decision. Record the value, complexity, cost, risk and scope effect first.',
      specRef: '§33',
    });
  }
  const refusal = acceptanceRefusal(p, o.acceptedBy);
  if (refusal !== undefined) {
    return fail({
      code: 'E_GATE_AUTHORITY',
      message: 'Refusing to accept ' + p.id + ': ' + refusal,
      remedy:
        'A proposal is accepted by the authority that owns the canon it would change, or by the owner. Anyone else accepting it is a decision made by whoever happened to be passing.',
      details: {
        proposalId: p.id,
        affectsCanon: p.affectsCanon,
        owners: [...owningAuthorities(p.affectsCanon)].sort(),
      },
      specRef: '§33',
    });
  }
  return save(deps, { ...p, state: ProposalState.ACCEPTED }, { acceptedBy: o.acceptedBy });
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
