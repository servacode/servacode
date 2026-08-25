import { listChangeSets } from '../engineering/changeset.js';
import type { ContractRegistry } from '../agents/registry.js';
import type { Store } from '../store/store.js';

/**
 * WHO PRODUCED THIS, AND WHO MAY JUDGE IT — ASKED OF THE WORLD.
 *
 * SPEC: Phase 6 final acceptance sequence §7; findings SSA-1 and SSA-3.
 *
 * The independent security review found both of these being declared rather than derived, in
 * the two places it mattered most.
 *
 *   `resolveProof` refused a non-independent reviewer only when a caller passed
 *   `implementationProducers` — and nothing in production ever passed it. The guard that gates
 *   READY FOR OWNER USE was inert on the only path anyone actually runs, and the tests all
 *   passed because every one of them supplied the list by hand.
 *
 *   `resolveSecurityReview` read `independence.implementationProducers` and `reviewerAuthority`
 *   straight out of the review document. A hand-authored file declaring an empty producer set
 *   and `VERIFY` satisfied both checks — in the module written to enforce that a file cannot
 *   certify itself.
 *
 * Both are facts about the world, so both are asked of it: the producer set from governed
 * execution history in the store, the authority from the agent's own contract. A document may
 * REFERENCE these; it can no longer DEFINE them, which is what makes forging one pointless
 * rather than merely difficult.
 */

/** Authorities that are a verifier's rather than a producer's. From the contract, always. */
const VERIFIER_AUTHORITIES: ReadonlySet<string> = new Set(['VERIFY', 'REVIEW', 'ASSESS']);

/** Archetypes whose runs count as having participated in implementation. */
const IMPLEMENTING_ROLES: ReadonlySet<string> = new Set(['PRODUCER', 'ARCHITECT']);

/**
 * Every agent that actually produced implementation in this store.
 *
 * Derived from two governed sources rather than one, because either alone has a hole:
 *
 *   ChangeSets name the agent that produced them, which is the strongest evidence there is —
 *   but only for work that reached a ChangeSet.
 *
 *   AgentRun records name the role each run was dispatched in, which catches a producer whose
 *   attempt produced nothing. Requiring a ChangeSet would let a failed producer turn around and
 *   review its successor's work on the same item.
 *
 * An empty result is a fact, not a failure: a package with no execution history has no
 * producers. It is the caller's job to decide whether reviewing such a thing means anything.
 */
export function implementationProducersFrom(store: Store): ReadonlySet<string> {
  const producers = new Set<string>();

  try {
    for (const changeSet of listChangeSets(store)) {
      if (changeSet.producerAgentId !== undefined) producers.add(changeSet.producerAgentId);
    }
  } catch {
    /* An unreadable ChangeSet stream contributes nothing; the run records may still speak. */
  }

  try {
    for (const runId of store.listCanonIds('agentRunRecord')) {
      const body = store.getCanon<{ agentId?: string; roleInTask?: string }>(
        'agentRunRecord',
        runId,
      )?.body;
      if (body?.agentId === undefined) continue;
      if (body.roleInTask !== undefined && IMPLEMENTING_ROLES.has(body.roleInTask)) {
        producers.add(body.agentId);
      }
    }
  } catch {
    /* Same: a partial answer from one source beats an exception that answers nothing. */
  }

  return producers;
}

/**
 * The authority an agent actually holds, from the contract that binds it.
 *
 * `undefined` for an id no contract issues. That is deliberately not "a default authority":
 * an agent nobody defined certifies nothing, and returning a permissive default here would
 * make an invented reviewer id the easiest forgery in the system.
 */
export function reviewerAuthorityOf(
  agentId: string,
  registry: ContractRegistry,
): string | undefined {
  if (!registry.has(agentId)) return undefined;
  try {
    return registry.get(agentId).authorityLevel;
  } catch {
    return undefined;
  }
}

export interface IndependenceVerdict {
  readonly independent: boolean;
  /** The authority actually held, for the record even when it disqualifies. */
  readonly authority?: string;
  readonly producers: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * May this agent certify this store's implementation?
 *
 * Two conditions, and both are about the world rather than about a claim: it must hold a
 * verifier's authority by contract, and it must not appear among the agents that produced what
 * it is being asked to judge. Neither is sufficient alone — a VERIFIER that produced here is
 * reviewing itself, and a genuinely uninvolved PRODUCER still holds no authority to certify.
 */
export function isIndependentReviewer(
  agentId: string,
  store: Store,
  registry: ContractRegistry,
): IndependenceVerdict {
  const reasons: string[] = [];
  const authority = reviewerAuthorityOf(agentId, registry);
  const producers = implementationProducersFrom(store);

  if (authority === undefined) {
    reasons.push(agentId + ' holds no contract, so it holds no authority to certify anything');
  } else if (!VERIFIER_AUTHORITIES.has(authority.toUpperCase())) {
    reasons.push(
      agentId +
        ' holds ' +
        authority +
        ', which is not a verifier authority; an agent that can produce cannot certify',
    );
  }

  if (producers.has(agentId)) {
    reasons.push(
      agentId + ' produced implementation in this store, so it cannot independently review it',
    );
  }

  return {
    independent: reasons.length === 0,
    ...(authority === undefined ? {} : { authority }),
    producers: [...producers].sort(),
    reasons,
  };
}
