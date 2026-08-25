import type { ContractRegistry } from '../agents/registry.js';
import type { Store } from '../store/store.js';

/**
 * NO AUTHORITY FROM CALLER-PROVIDED STRINGS.
 *
 * SPEC: Phase 6 security invariant sweep; 19 §5, §32, §38.
 *
 * Four rounds of independent review found the same defect wearing four different names —
 * `curatedBy`, `assessedBy`, `reviewerAgentId`, `verifiedByAgentId`. Each time it was fixed
 * where it was found and left standing in the sibling function twenty lines away. That is how
 * `assessApplicability` survived the round that fixed `contributeLesson`, and how
 * `liveProof.ts` survived the round that fixed `proof.ts`.
 *
 * The shape is always identical: a caller passes a name, the code compares it to a constant or
 * to another name, and permission follows. Nothing about that comparison is wrong except what
 * it rests on — two strings, both supplied by whoever wanted the permission.
 *
 * So this module holds the ONE place that answers "may this actor do this?", and it answers by
 * resolving two facts about the world:
 *
 *   WHO ACTED comes from the governed run record — the run must exist, must have COMPLETED,
 *   and must have been made by the agent being claimed. Citing a real run does not transfer
 *   the authority of the agent that made it.
 *
 *   WHAT THEY MAY DO comes from the contract registry — the authority an agent holds is a
 *   property of the contract that binds it, not of a role name written in a document.
 *
 * A document may RECORD both. It can no longer DEFINE either, which is what makes forging one
 * pointless rather than merely difficult.
 */

/** The authority levels agent contracts actually grant. Closed, and taken from the contracts. */
export const ActorAuthority = {
  OBSERVE: 'OBSERVE',
  ADVISE: 'ADVISE',
  RECOMMEND: 'RECOMMEND',
  DECIDE: 'DECIDE',
  EXECUTE: 'EXECUTE',
  VERIFY: 'VERIFY',
} as const;
export type ActorAuthority = (typeof ActorAuthority)[keyof typeof ActorAuthority];

/**
 * What an action requires, rather than what an agent happens to hold.
 *
 * Named for the ACT — curating, verifying, deciding — so a call site says what it is trying to
 * do and this module decides which authorities suffice. A call site that named an authority
 * directly would be back to encoding the answer at the point that wants permission.
 */
export const RoleAuthority = {
  /** Publish organizational knowledge a future project may read. */
  CURATE: 'CURATE',
  /** Judge work somebody else produced. */
  VERIFY: 'VERIFY',
  /** Settle a question on the company's behalf. */
  DECIDE: 'DECIDE',
  /** Produce or change an artifact. */
  EXECUTE: 'EXECUTE',
  /**
   * Judge whether something learned elsewhere applies here.
   *
   * Distinct from VERIFY: the Applicability Assessor holds ADVISE by contract, because saying
   * "this pattern fits" is advice about a decision somebody else makes. What makes it
   * trustworthy is not a high authority level but WHO holds it — one declared role, resolved,
   * and never the actor that curated the thing being assessed.
   */
  ASSESS: 'ASSESS',
} as const;
export type RoleAuthority = (typeof RoleAuthority)[keyof typeof RoleAuthority];

/**
 * Which contract authorities satisfy each act.
 *
 * A table rather than a rule over the authority name: the recurring lesson in this codebase is
 * that anything inferring meaning from how something is spelled eventually misses a case.
 */
const SUFFICIENT: Readonly<Record<RoleAuthority, readonly ActorAuthority[]>> = Object.freeze({
  CURATE: [ActorAuthority.DECIDE, ActorAuthority.VERIFY],
  VERIFY: [ActorAuthority.VERIFY],
  DECIDE: [ActorAuthority.DECIDE],
  EXECUTE: [ActorAuthority.EXECUTE],
  ASSESS: [ActorAuthority.ADVISE, ActorAuthority.VERIFY, ActorAuthority.DECIDE],
});

/**
 * A specific agent an act is reserved to, beyond merely holding the authority.
 *
 * Some acts belong to one declared role rather than to everyone who could technically perform
 * them: generalised knowledge outlives the project it came from, so one agent owns it. The id
 * lives here rather than at the call site, because a call site holding the id is a call site
 * that can be talked out of checking it.
 */
const RESERVED_TO: Readonly<Partial<Record<RoleAuthority, string>>> = Object.freeze({
  CURATE: 'SC-AGENT-290',
  ASSESS: 'SC-AGENT-291',
});

export interface ResolveActorInput {
  readonly store: Store;
  readonly registry: ContractRegistry;
  /** The governed run that performed the act. Resolved; never taken on trust. */
  readonly runId: string;
  /** The agent the caller says acted. Checked against the run, never believed. */
  readonly claimedAgentId: string;
  /** What the act requires. Omitted when only identity is being established. */
  readonly requiredAuthority?: RoleAuthority;
}

export interface ResolvedActor {
  readonly resolved: boolean;
  /** The agent the RUN says acted, which may differ from what the caller claimed. */
  readonly agentId?: string;
  /** The authority the CONTRACT grants, which no document can change. */
  readonly authority?: string;
  /** Why this actor may not act, in one sentence. Absent when it may. */
  readonly refusal?: string;
}

/**
 * Resolve who acted, and whether they were entitled to.
 *
 * Returns rather than throws, because most callers want to report a refusal alongside others
 * rather than abort on the first one. `assertActor` is the throwing form.
 */
export function resolveActor(input: ResolveActorInput): ResolvedActor {
  const record = readRun(input.store, input.runId);

  if (record === undefined) {
    return {
      resolved: false,
      refusal:
        'run ' +
        input.runId +
        ' does not resolve in this store, and a caller-supplied actor string is not proof of a governed run',
    };
  }

  /*
   * A run that never terminated recorded no act of deciding. This is checked before the agent
   * comparison so an abandoned run cannot be borrowed by the agent that started it either.
   */
  if (record.outcome !== 'COMPLETED') {
    return {
      resolved: false,
      ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
      refusal:
        'run ' +
        input.runId +
        ' ended ' +
        String(record.outcome ?? 'without a terminal outcome') +
        ', so it performed nothing',
    };
  }

  if (record.agentId !== input.claimedAgentId) {
    return {
      resolved: false,
      ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
      refusal:
        'run ' +
        input.runId +
        ' was made by ' +
        String(record.agentId) +
        ', not the ' +
        input.claimedAgentId +
        ' this claims: borrowing a real run does not transfer the authority of the agent that made it',
    };
  }

  const agentId = record.agentId;
  const authority = authorityOf(agentId, input.registry);
  if (authority === undefined) {
    return {
      resolved: false,
      agentId,
      refusal: agentId + ' holds no contract, so it holds no authority to act',
    };
  }

  if (input.requiredAuthority !== undefined) {
    const reserved = RESERVED_TO[input.requiredAuthority];
    if (reserved !== undefined && agentId !== reserved) {
      return {
        resolved: false,
        agentId,
        authority,
        refusal:
          input.requiredAuthority +
          ' is reserved to ' +
          reserved +
          ', and this act was performed by ' +
          agentId,
      };
    }

    const sufficient = SUFFICIENT[input.requiredAuthority];
    if (!sufficient.includes(authority.toUpperCase() as ActorAuthority)) {
      return {
        resolved: false,
        agentId,
        authority,
        refusal:
          agentId +
          ' holds ' +
          authority +
          ', which does not authorise ' +
          input.requiredAuthority +
          ' (that needs one of ' +
          sufficient.join(', ') +
          ')',
      };
    }
  }

  return { resolved: true, agentId, authority };
}

export interface ActorRefusalInput extends Omit<ResolveActorInput, 'runId' | 'claimedAgentId'> {
  readonly actorRunId: string;
  readonly claimedAgentId: string;
  /**
   * A run this actor must not be the same agent as.
   *
   * Independence, decided between two RESOLVED actors rather than between two strings a caller
   * supplied. If the other run does not resolve, independence from it is an unanswered
   * question rather than an established fact, so that refuses too.
   */
  readonly mustDifferFromRunId?: string;
}

/** The complete refusal for one act, or `undefined` when it may proceed. */
export function actorRefusal(input: ActorRefusalInput): string | undefined {
  const actor = resolveActor({
    store: input.store,
    registry: input.registry,
    runId: input.actorRunId,
    claimedAgentId: input.claimedAgentId,
    ...(input.requiredAuthority === undefined
      ? {}
      : { requiredAuthority: input.requiredAuthority }),
  });
  if (!actor.resolved) return actor.refusal;

  if (input.mustDifferFromRunId !== undefined) {
    const other = readRun(input.store, input.mustDifferFromRunId);
    if (other === undefined) {
      return (
        'run ' +
        input.mustDifferFromRunId +
        ' does not resolve, so independence from it cannot be established'
      );
    }
    if (other.agentId === actor.agentId) {
      return (
        'the same agent ' +
        String(actor.agentId) +
        ' performed both acts, so nothing independent happened'
      );
    }
  }

  return undefined;
}

/** The throwing form, for a call site with nothing useful to do with a refusal but stop. */
export function assertActor(
  input: ActorRefusalInput,
  fail: (message: string, details: Record<string, unknown>) => never,
): void {
  const refusal = actorRefusal(input);
  if (refusal !== undefined) {
    fail(refusal, {
      runId: input.actorRunId,
      claimedAgentId: input.claimedAgentId,
      ...(input.requiredAuthority === undefined
        ? {}
        : { requiredAuthority: input.requiredAuthority }),
    });
  }
}

/** The authority a contract grants, or `undefined` for an id nobody issued. */
export function authorityOf(agentId: string, registry: ContractRegistry): string | undefined {
  if (!registry.has(agentId)) return undefined;
  try {
    return registry.get(agentId).authorityLevel;
  } catch {
    return undefined;
  }
}

function readRun(
  store: Store,
  runId: string,
): { readonly agentId?: string; readonly outcome?: string } | undefined {
  try {
    return store.getCanon<{ agentId?: string; outcome?: string }>('agentRunRecord', runId)?.body;
  } catch {
    /* An unreadable record establishes nothing, which is a refusal rather than a pass. */
    return undefined;
  }
}
