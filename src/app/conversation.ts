import { z } from 'zod';
import { AuditAction, audit } from '../events/audit.js';
import type { ServaRuntime } from './runtime.js';
import type { Orchestrator, RoutingResult } from '../orchestration/orchestrator.js';

/**
 * THE OWNER TALKS TO A COMPANY, NOT TO A MODEL.
 *
 * SPEC: Phase 6 closure §5; §9, §10, 04 §2.
 *
 * An independent audit found no conversation surface at all: the only way to ask Serva for
 * anything was `serva route` in a terminal. The obvious way to close that gap is also the
 * wrong one — drop a chat box in the panel and pipe what the owner types to the engine.
 *
 * That would quietly replace the product. A chat box gives answers; a company does work. The
 * moment free text reaches an unrestricted session, the thing answering has no departments,
 * no gates, no canon it is allowed to write and no record of why it said what it said. It
 * would be fluent and it would be ungoverned, and an owner has no way to tell those apart
 * from the outside.
 *
 * So every turn here goes through `Orchestrator.route`: the request is recorded verbatim as
 * an input rather than an instruction, a governed classifier run classifies it, a planner run
 * proposes a plan, Serva validates that plan DETERMINISTICALLY, and what comes back to the
 * owner is what was queued — or the stage at which Serva stopped and why.
 *
 * WHAT THE OWNER READS IS NEVER MODEL PROSE. A turn shows the classification, the departments
 * queued and the halt reason. There is no field on it that carries a sentence an agent wrote
 * for the owner to read, because such a field is a chat surface with extra steps.
 *
 * The transcript is persisted, so it survives a restart, a crash and a machine change. It is
 * WORKING state rather than canon: what the owner asked for is an input to the company, and
 * inputs are never established truth (04 §2 step 1).
 */

export const TurnOutcome = {
  /** Serva queued governed work. */
  QUEUED: 'QUEUED',
  /** Serva stopped honestly at some stage. `haltReason` says which and why. */
  HALTED: 'HALTED',
  /** Serva could not begin: no engine, or the machine is unqualified. */
  REFUSED: 'REFUSED',
} as const;
export type TurnOutcome = (typeof TurnOutcome)[keyof typeof TurnOutcome];

export const WORKING_TYPE = 'conversationTurn';

export const ConversationTurnSchema = z
  .object({
    id: z.string().min(1),
    /** The owner's words, verbatim. Never normalised, never paraphrased. */
    text: z.string().min(1),
    askedAt: z.string().min(1),
    requestId: z.string().min(1).optional(),
    workItemId: z.string().min(1).optional(),
    outcome: z.enum([TurnOutcome.QUEUED, TurnOutcome.HALTED, TurnOutcome.REFUSED]),
    /** How far routing got: RECORDED, CLASSIFIED, PLANNED, VALIDATED, QUEUED. */
    stage: z.string().min(1).optional(),
    classification: z.string().min(1).optional(),
    /** Whether Serva judged the request to carry more than one intent. */
    multiIntent: z.boolean().optional(),
    /** Departments actually queued. Empty for anything that did not reach QUEUED. */
    queued: z.array(z.string().min(1)),
    /** Why Serva stopped. Serva's words about its own process, not an agent's answer. */
    haltReason: z.string().min(1).optional(),
    /** Governed runs this turn caused, so an owner can audit what was spent. */
    runIds: z.array(z.string().min(1)),
  })
  .strict();
export type ConversationTurn = z.output<typeof ConversationTurnSchema>;

/**
 * Every turn, oldest first.
 *
 * Read from the Store on each call rather than held in memory: the panel, the CLI and a
 * second window must all see the same conversation, and a cached transcript is how two
 * surfaces come to disagree about what was asked.
 */
export function conversationTranscript(rt: ServaRuntime): readonly ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const id of rt.store.listWorkingIds(WORKING_TYPE)) {
    const envelope = rt.store.getWorking<unknown>(WORKING_TYPE, id);
    if (envelope === undefined) continue;
    const parsed = ConversationTurnSchema.safeParse(envelope.body);
    if (parsed.success) turns.push(parsed.data);
  }
  return turns.sort((a, b) => (a.askedAt < b.askedAt ? -1 : a.askedAt > b.askedAt ? 1 : 0));
}

function persist(rt: ServaRuntime, turn: ConversationTurn): ConversationTurn {
  const tx = rt.store.begin();
  tx.putWorking(WORKING_TYPE, turn.id, turn);
  audit(tx, {
    action: AuditAction.REQUEST_RECEIVED,
    subject: turn.id,
    outcome: turn.outcome === TurnOutcome.QUEUED ? 'OK' : 'REFUSED',
    detail: {
      source: 'OWNER_UI',
      chars: turn.text.length,
      outcome: turn.outcome,
      ...(turn.stage === undefined ? {} : { stage: turn.stage }),
    },
  });
  tx.commit();
  return turn;
}

export interface SendOptions {
  readonly orchestrator: Pick<Orchestrator, 'route'>;
  /** Supplied by the caller so a request can join existing work rather than opening new work. */
  readonly workItemId?: string;
}

/**
 * Ask Serva for something.
 *
 * Returns the turn, always — including when routing halted. A surface that only gets a
 * result on success has to invent its own words for failure, and the words it invents will
 * not match what the Store recorded.
 */
export async function sendOwnerRequest(
  rt: ServaRuntime,
  text: string,
  o: SendOptions,
): Promise<ConversationTurn> {
  const trimmed = text.trim();
  if (trimmed === '') {
    throw Object.assign(new Error('There is nothing to send.'), {
      code: 'E_VALIDATION',
      remedy: 'Type what you want, in your own words.',
    });
  }

  const id = rt.ids.next('SC-TURN');
  const askedAt = rt.clock.now();
  const workItemId = o.workItemId ?? rt.ids.next('SC-WI');

  let result: RoutingResult;
  try {
    result = await o.orchestrator.route(trimmed, workItemId);
  } catch (e) {
    /*
     * A refusal is a turn. The engine being unavailable, or the machine unqualified, is
     * something the owner asked about and deserves an answer to in the same place they
     * asked — not a toast that disappears and a transcript with a hole in it.
     */
    return persist(rt, {
      id,
      text: trimmed,
      askedAt,
      workItemId,
      outcome: TurnOutcome.REFUSED,
      queued: [],
      haltReason: e instanceof Error ? e.message : String(e),
      runIds: [],
    });
  }

  const runIds = [result.classificationRun?.runId, result.planRun?.runId].filter(
    (r): r is string => typeof r === 'string',
  );
  const queued = result.queue.map((entry) => entry.departmentId);

  return persist(rt, {
    id,
    text: trimmed,
    askedAt,
    requestId: result.request.id,
    workItemId,
    outcome: result.stage === 'QUEUED' ? TurnOutcome.QUEUED : TurnOutcome.HALTED,
    stage: result.stage,
    ...(result.classification === undefined
      ? {}
      : {
          classification: result.classification.requestClass,
          multiIntent: result.classification.multiIntent,
        }),
    queued,
    ...(result.haltReason === undefined ? {} : { haltReason: result.haltReason }),
    runIds,
  });
}
