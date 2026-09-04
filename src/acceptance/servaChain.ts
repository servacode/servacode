import { EvidenceOrigin } from './evidenceClass.js';
import { requestQueuedWork, resolveLiveEngineering } from './liveProof.js';
import { readAudit } from '../events/audit.js';
import type { LiveEngineeringInput, LiveRefusal } from './liveProof.js';
import type { OriginatedRef } from './evidenceClass.js';
import type { Store } from '../store/store.js';

/**
 * THE CROSS-PHASE JOIN: THIS REQUEST REACHED ENGINEERING THROUGH GOVERNANCE.
 *
 * SPEC: Phase 6 final acceptance sequence §2, §6, §7.
 *
 * LIVE-ENGINEERING proves the factory works. It does not prove that an owner asking for
 * something is what caused the factory to run, and the difference is the whole product: a
 * company is the JOIN, not the two halves.
 *
 * So this refuses the tempting arithmetic —
 *
 *   a real intelligence chain + a real engineering chain = a live company
 *
 * — because two valid runs from unrelated requests satisfy it perfectly and mean nothing. Every
 * reference below is resolved AND checked to belong to the same execution, and the joins are
 * named rather than implied:
 *
 *   the turn's work item IS the ChangeSet's work item;
 *   the runs the turn claims to have caused resolve, in this store, and COMPLETED;
 *   the handoff that produced the EngineeringWorkItem names that same work item.
 *
 * An owner decision left unanswered is NOT a failure of this chain. It is Serva stopping where
 * it must, and the resolution says so with its own outcome — because a harness answering an
 * owner decision to keep a test green would be the single worst thing in this codebase.
 */

export const ChainOutcome = {
  PROVEN: 'PROVEN',
  /** A person must act before this can continue. Never answered by anything automated. */
  OWNER_ACTION_REQUIRED: 'OWNER_ACTION_REQUIRED',
  NOT_VERIFIED: 'NOT_VERIFIED',
} as const;
export type ChainOutcome = (typeof ChainOutcome)[keyof typeof ChainOutcome];

export interface PendingOwnerDecision {
  readonly id: string;
  readonly question: string;
  readonly whyServaCannotDecide: string;
}

export interface ServaChainResolution {
  readonly outcome: ChainOutcome;
  readonly refusals: readonly LiveRefusal[];
  /** Every reference, carrying the class of thing that produced it. */
  readonly refs: readonly OriginatedRef[];
  readonly pendingOwnerDecisions: readonly PendingOwnerDecision[];
  readonly workItemId?: string;
  readonly turnId?: string;
  readonly acceptedCommit?: string;
}

export interface ServaChainInput extends LiveEngineeringInput {
  /** The store holding the owner request and the governed intelligence. Usually the same one. */
  readonly companyStore: Store;
  /** Which artifacts the harness wrote deterministically before any live work. */
  readonly preseeded: readonly OriginatedRef[];
  /** Named so a caller can point at one turn rather than the newest. */
  readonly turnId?: string;
}

function working<T>(store: Store, type: string): { id: string; body: T }[] {
  const out: { id: string; body: T }[] = [];
  for (const id of store.listWorkingIds(type)) {
    const envelope = store.getWorking<T>(type, id);
    if (envelope !== undefined) out.push({ id, body: envelope.body });
  }
  return out;
}

function terminalRun(
  store: Store,
  runId: string,
): { readonly agentId?: string; readonly outcome?: string } | undefined {
  try {
    return store.getCanon<{ agentId?: string; outcome?: string }>('agentRunRecord', runId)?.body;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the whole chain, from what an owner asked to what Serva integrated.
 *
 * Returns an outcome rather than a boolean, because `OWNER_ACTION_REQUIRED` is a third thing
 * that is neither success nor failure — and collapsing it into either would mean a harness
 * either fails a correct refusal or, far worse, learns to route around one.
 */
export function resolveServaChain(input: ServaChainInput): ServaChainResolution {
  const refusals: LiveRefusal[] = [];
  const refs: OriginatedRef[] = [...input.preseeded];
  const refuse = (check: string, detail: string): void => {
    refusals.push({ check, detail });
  };

  /* ----------------------------------------------- an owner decision outranks everything */

  /*
   * Checked FIRST and reported on its own. A pending decision is not a defect in the chain;
   * it is the chain waiting for the one participant no harness may impersonate. Reporting it
   * as a refusal alongside genuine problems would invite somebody to make it go away.
   */
  const pending = working<{
    state?: string;
    question?: string;
    whyServaCannotDecide?: string;
  }>(input.companyStore, 'intel.ownerDecisionRequest')
    .concat(
      input.companyStore.listCanonIds('intel.ownerDecisionRequest').map((id) => ({
        id,
        body:
          input.companyStore.getCanon<{
            state?: string;
            question?: string;
            whyServaCannotDecide?: string;
          }>('intel.ownerDecisionRequest', id)?.body ?? {},
      })),
    )
    .filter((d) => d.body.state === 'OPEN')
    .map((d) => ({
      id: d.id,
      question: String(d.body.question ?? ''),
      whyServaCannotDecide: String(d.body.whyServaCannotDecide ?? ''),
    }));

  for (const decision of pending) {
    refs.push({
      origin: EvidenceOrigin.OWNER_ACTION,
      kind: 'OWNER_DECISION',
      id: decision.id,
      detail: decision.question,
    });
  }

  /* ------------------------------------------------------------------ the owner request */

  const turns = working<Record<string, unknown>>(input.companyStore, 'conversationTurn');
  const turn =
    input.turnId !== undefined ? turns.find((t) => t.id === input.turnId) : turns[turns.length - 1];

  if (turn === undefined) {
    refuse('OWNER_REQUEST', 'no owner request is recorded in this store');
    return {
      outcome: ChainOutcome.NOT_VERIFIED,
      refusals,
      refs,
      pendingOwnerDecisions: pending,
    };
  }

  refs.push({
    origin: EvidenceOrigin.OWNER_ACTION,
    kind: 'OWNER_REQUEST',
    id: turn.id,
    detail: String(turn.body['text'] ?? ''),
  });

  const turnWorkItem = String(turn.body['workItemId'] ?? '');
  const runIds = Array.isArray(turn.body['runIds']) ? (turn.body['runIds'] as string[]) : [];

  /*
   * At least one governed reasoning stage must have run live AFTER the request. A request that
   * caused no run reached engineering by some other route, which is precisely the join this
   * function exists to prove did not happen by accident.
   */
  if (runIds.length === 0) {
    refuse(
      'GOVERNED_INTELLIGENCE',
      'the request caused no governed run, so nothing reasoned about it',
    );
  }
  for (const runId of runIds) {
    const run = terminalRun(input.companyStore, runId);
    if (run === undefined) {
      refuse('GOVERNED_INTELLIGENCE', runId + ' is named by the request and does not resolve');
      continue;
    }
    if (run.outcome !== 'COMPLETED') {
      refuse('GOVERNED_INTELLIGENCE', runId + ' ended ' + String(run.outcome));
      continue;
    }
    refs.push({
      origin: EvidenceOrigin.LIVE_MODEL,
      kind: 'AGENT_RUN',
      id: runId,
      detail: String(run.agentId) + ' — governed reasoning after the request',
    });
  }

  /*
   * THE REQUEST MUST HAVE PRODUCED WORK.
   *
   * The rule lives in `requestQueuedWork` and is shared with `resolveLiveServa`, because this
   * module once held its own hardened copy while the acceptance path kept the weak one. Two
   * statements of one rule is how the weak one survives.
   */
  const notQueued = requestQueuedWork(turn.body);
  if (notQueued !== undefined) refuse(notQueued.check, notQueued.detail);

  /* ------------------------------------------------------------------ the engineering half */

  const engineering = resolveLiveEngineering(input);
  refusals.push(...engineering.refusals);

  if (engineering.chain !== undefined) {
    const chain = engineering.chain;
    refs.push(
      {
        origin: EvidenceOrigin.LIVE_MACHINE,
        kind: 'MACHINE',
        id: chain.machineFingerprint,
        detail: 'the boundary this ran under',
      },
      {
        origin: EvidenceOrigin.LIVE_MODEL,
        kind: 'AGENT_RUN',
        id: chain.producerRunId,
        detail: 'Producer ' + chain.producerAgentId + ' (' + chain.producerOutcome + ')',
      },
      {
        origin: EvidenceOrigin.LIVE_MODEL,
        kind: 'AGENT_RUN',
        id: chain.reviewerRunId,
        detail: 'independent Reviewer ' + chain.reviewerAgentId,
      },
      { origin: EvidenceOrigin.DETERMINISTIC_TOOL, kind: 'CHANGESET', id: chain.changeSetId },
      ...chain.checkIds.map((id) => ({
        origin: EvidenceOrigin.DETERMINISTIC_TOOL,
        kind: 'CHECK_EVIDENCE',
        id,
      })),
      {
        origin: EvidenceOrigin.DETERMINISTIC_TOOL,
        kind: 'COMMIT',
        id: chain.acceptedCommit,
        detail: 'integration commit, per the CHANGE_ACCEPTED trace',
      },
    );

    /*
     * THE JOIN ITSELF.
     *
     * Without this, a real request and a real engineering run are two things that happened.
     * The turn records the work item its request opened and the ChangeSet records the one it
     * was built for; if they differ, nothing connects them.
     */
    if (turnWorkItem === '' || turnWorkItem !== chain.workItemId) {
      refuse(
        'CROSS_PHASE_JOIN',
        'the request opened work item ' +
          (turnWorkItem === '' ? '(none)' : turnWorkItem) +
          ' and the change was built for ' +
          chain.workItemId +
          '; these are two executions, not a chain',
      );
    }

    /*
     * And the acceptance names the same work item in the trace. Belt and braces on purpose:
     * the ChangeSet is written by Serva from what it observed, and the trace is written by
     * Serva about what it decided. Two independent records agreeing is the evidence.
     */
    const accepted = readAudit(input.store).filter((e) => e.type === 'CHANGE_ACCEPTED');
    const forThisItem = accepted.some(
      (e) =>
        ((e.payload as { detail?: { workItemId?: string } })?.detail?.workItemId ?? '') ===
        chain.workItemId,
    );
    if (!forThisItem) {
      refuse('CROSS_PHASE_JOIN', 'no CHANGE_ACCEPTED entry names work item ' + chain.workItemId);
    }
  }

  /* --------------------------------------------------------------------- the outcome */

  if (pending.length > 0) {
    /*
     * Reported ahead of everything else. Serva stopped where it must, and the only correct
     * response is a person — so this outcome exists to make "answer it yourself" the obvious
     * next step rather than "make the test pass".
     */
    return {
      outcome: ChainOutcome.OWNER_ACTION_REQUIRED,
      refusals,
      refs,
      pendingOwnerDecisions: pending,
      workItemId: turnWorkItem,
      turnId: turn.id,
      ...(engineering.chain === undefined
        ? {}
        : { acceptedCommit: engineering.chain.acceptedCommit }),
    };
  }

  return {
    outcome: refusals.length === 0 ? ChainOutcome.PROVEN : ChainOutcome.NOT_VERIFIED,
    refusals,
    refs,
    pendingOwnerDecisions: [],
    workItemId: turnWorkItem,
    turnId: turn.id,
    ...(engineering.chain === undefined
      ? {}
      : { acceptedCommit: engineering.chain.acceptedCommit }),
  };
}
