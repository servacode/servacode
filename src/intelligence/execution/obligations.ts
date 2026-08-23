import { ARTIFACT_TYPES, repository } from '../repository.js';
import { OpenQuestionSchema, OpenQuestionState } from '../artifacts/framing.js';
import { ResearchRequestSchema, SourceCaptureSchema } from '../research/capture.js';
import { AuditAction, audit } from '../../events/audit.js';
import { runDepartment } from './runner.js';
import { DepartmentOutcome } from './types.js';
import type { DepartmentConfig, DepartmentContext, DepartmentResult, RunnerDeps } from './types.js';
import type { ApplicabilityPlan } from '../applicability.js';
import type { GatewayDeps } from '../research/gateway.js';
import type { OpenQuestion } from '../artifacts/framing.js';
import type { ArtifactType } from '../repository.js';
import type { Store } from '../../store/store.js';

/**
 * RECORDING AN OBLIGATION IS NOT DISCHARGING ONE.
 *
 * SPEC: 04, §32, §41.
 *
 * The runner learned to route: a question it can prove another department owes becomes a
 * durable `OpenQuestion`, and a question Serva may lawfully retrieve becomes a
 * `ResearchRequest` as well. Both survive a restart, neither is ever raised twice, and
 * both were — until this file — permanently OPEN.
 *
 * An obligation nobody consumes is a slightly better-documented deadlock. The department
 * that asked cannot proceed; the department that owes the answer has no idea it was
 * asked; and the honest-looking record says a question was properly routed to somebody
 * who will never see it.
 *
 * So this is the consumer. It is NOT a second scheduler: it owns no queue, no state and
 * no ordering of its own. It reads the obligations already in the Store, dispatches the
 * canonical department that owes each one through the SAME `runDepartment` every stage
 * uses, resolves the question with the canon that actually satisfied it, and reports what
 * it did so the orchestrator's existing bookkeeping can absorb it.
 *
 * Three rules keep it from becoming one:
 *
 *   it never invents evidence — an obligation it cannot lawfully discharge BLOCKS with
 *   the exact reason, and "we could not find out" stays a legitimate result;
 *
 *   it never runs a department twice — before dispatching anything it asks whether the
 *   canon that would satisfy the obligation already exists, so a process that died
 *   between producing evidence and recording the answer resolves on the next pass rather
 *   than paying for the same work again;
 *
 *   it never asks the owner — an obligation Serva placed on its own departments is
 *   Serva's to discharge, and escalating it would be asking the owner to do the company's
 *   work.
 */

export interface ObligationDeps extends RunnerDeps {
  readonly departments: readonly DepartmentConfig[];
  readonly gateway?: GatewayDeps;
}

export interface ObligationResult {
  /** Questions moved from OPEN to ANSWERED, with the canon that settled them. */
  readonly resolved: readonly string[];
  /** Departments this controller ran to completion, for the orchestrator's record. */
  readonly completedDepartments: readonly string[];
  readonly ran: readonly DepartmentResult[];
  /** Obligations that could not be discharged, each with the real reason. */
  readonly blocked: readonly string[];
}

const EMPTY: ObligationResult = Object.freeze({
  resolved: [],
  completedDepartments: [],
  ran: [],
  blocked: [],
});

/** Outstanding obligations for this work item, in the order they were raised. */
export function outstandingObligations(store: Store, workItemId: string): readonly OpenQuestion[] {
  return repository(store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema)
    .list()
    .filter(
      (q) =>
        q.state === OpenQuestionState.OPEN &&
        (q.askedOf === 'RESEARCH' || q.askedOf === 'UPSTREAM_DEPARTMENT') &&
        (q.meta.workItemId === workItemId || q.meta.workItemId === undefined),
    );
}

/**
 * Mark an obligation discharged, naming the canon that discharged it.
 *
 * `state` and `answer` were already on the artifact and are simply used. `resolvedByRefs`
 * is what makes the difference between OUTSTANDING and FULFILLED checkable after a
 * restart with no session to consult: a reader follows the refs and sees the evidence,
 * rather than reading a sentence that says evidence was obtained.
 */
function resolve(
  deps: ObligationDeps,
  question: OpenQuestion,
  o: { readonly answer: string; readonly refs: readonly string[] },
): void {
  const repo = repository(deps.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema);
  const tx = deps.store.begin();
  try {
    repo.put(tx, {
      ...question,
      state: OpenQuestionState.ANSWERED,
      answer: o.answer,
      answeredAt: deps.clock.now(),
      resolvedByRefs: o.refs.map((id) => ({ id })),
    });
    audit(tx, {
      action: AuditAction.ARTIFACT_RECORDED,
      subject: question.id,
      outcome: 'OK',
      detail: { obligation: question.askedOf, resolvedBy: o.refs.slice(0, 20) },
    });
    tx.commit();
  } catch (e) {
    tx.rollback();
    throw e;
  }
}

/** The department context for a department the controller is dispatching. */
function contextFor(
  deps: ObligationDeps,
  config: DepartmentConfig,
  o: {
    readonly workItemId: string;
    readonly plan: ApplicabilityPlan;
    readonly obligation?: DepartmentContext['obligation'];
  },
): DepartmentContext | undefined {
  const stage = o.plan.stages.find((s) => s.stageId === config.stageId);
  if (stage === undefined) return undefined;
  return {
    workItemId: o.workItemId,
    store: deps.store,
    clock: deps.clock,
    ids: deps.ids,
    plan: o.plan,
    stage,
    ...(deps.gateway === undefined ? {} : { gateway: deps.gateway }),
    ...(o.obligation === undefined ? {} : { obligation: o.obligation }),
  };
}

/**
 * Discharge every outstanding obligation this controller can.
 *
 * Called by the orchestrator before it advances and again whenever a department stops for
 * want of something it recorded. Both callers matter: the first is what makes a restart
 * mid-obligation resume rather than deadlock, and the second is what stops a single
 * `advance()` reporting BLOCKED for work it was about to be able to do.
 */
export async function dischargeObligations(
  deps: ObligationDeps,
  o: {
    readonly workItemId: string;
    readonly plan: ApplicabilityPlan;
    /** Departments the orchestrator already considers finished. Never run twice. */
    readonly completedDepartments?: ReadonlySet<string>;
  },
): Promise<ObligationResult> {
  const outstanding = outstandingObligations(deps.store, o.workItemId);
  if (outstanding.length === 0) return EMPTY;

  const resolved: string[] = [];
  const completedDepartments: string[] = [];
  const ran: DepartmentResult[] = [];
  const blocked: string[] = [];
  const done = new Set(o.completedDepartments ?? []);

  for (const question of outstanding) {
    const outcome =
      question.askedOf === 'RESEARCH'
        ? await dischargeResearch(deps, question, o.plan, o.workItemId, done)
        : await dischargeUpstream(deps, question, o.plan, o.workItemId, done);

    if (outcome.ran !== undefined) ran.push(outcome.ran);
    if (outcome.completedDepartment !== undefined) {
      completedDepartments.push(outcome.completedDepartment);
      done.add(outcome.completedDepartment);
    }
    if (outcome.blocked !== undefined) {
      blocked.push(outcome.blocked);
      continue;
    }
    resolve(deps, question, { answer: outcome.answer, refs: outcome.refs });
    resolved.push(question.id);
  }

  return { resolved, completedDepartments, ran, blocked };
}

interface Discharge {
  readonly answer: string;
  readonly refs: readonly string[];
  readonly blocked?: string;
  readonly ran?: DepartmentResult;
  readonly completedDepartment?: string;
}

const NOTHING = { answer: '', refs: [] as readonly string[] };

/**
 * Hand a research obligation to the canonical research authority.
 *
 * The authority is resolved from the registered configuration, not named here: it is the
 * department that declares `usesResearchGateway`, which is the same declaration the runner
 * checks before it will route a question to research at all. Where none is registered, or
 * where the profile does not run its stage, the obligation is BLOCKED with that as the
 * reason — never quietly reassigned to the owner.
 */
async function dischargeResearch(
  deps: ObligationDeps,
  question: OpenQuestion,
  plan: ApplicabilityPlan,
  workItemId: string,
  done: ReadonlySet<string>,
): Promise<Discharge> {
  const requestId = question.researchRequestRef?.id;
  const request =
    requestId === undefined
      ? undefined
      : repository(deps.store, ARTIFACT_TYPES.RESEARCH_REQUEST, ResearchRequestSchema).get(
          requestId,
        );
  if (request === undefined) {
    return {
      ...NOTHING,
      blocked:
        'research obligation ' +
        question.id +
        ' names no research request that exists, so there is nothing to fulfil',
    };
  }

  /*
   * ALREADY RETRIEVED? Then discharge without spending anything.
   *
   * A process that captured sources and died before recording the answer must not pay for
   * the same retrieval again on resume. The captures carry the question they were fetched
   * for, so this is a fact about the Store rather than a guess about history.
   */
  const captured = repository(deps.store, ARTIFACT_TYPES.SOURCE_CAPTURE, SourceCaptureSchema)
    .list()
    .filter((c) => c.researchQuestion === request.question);
  const priorFindings = findingsFor(
    deps.store,
    captured.map((c) => c.id),
  );
  if (priorFindings.length > 0) {
    return {
      answer:
        'Serva retrieved ' +
        String(captured.length) +
        ' source(s) under ' +
        request.id +
        ' and the research authority reported its findings.',
      refs: [...priorFindings, ...captured.map((c) => c.id)],
    };
  }

  const config = deps.departments.find((d) => d.usesResearchGateway === true);
  if (config === undefined) {
    return {
      ...NOTHING,
      blocked:
        'research obligation ' +
        question.id +
        ' cannot be discharged: no registered department declares research authority, so nobody may retrieve for it',
    };
  }
  if (done.has(config.id)) {
    return {
      ...NOTHING,
      blocked:
        'research obligation ' +
        question.id +
        ' is still open although ' +
        config.title +
        ' has already run: the retrieval it needs produced nothing that answers it',
    };
  }

  const ctx = contextFor(deps, config, {
    workItemId,
    plan,
    obligation: {
      questionId: question.id,
      requestId: request.id,
      question: request.question,
    },
  });
  if (ctx === undefined) {
    return {
      ...NOTHING,
      blocked:
        'research obligation ' +
        question.id +
        ' is owed by ' +
        config.stageId +
        ', which ' +
        plan.profileId +
        ' does not include: the profile and the obligation contradict each other',
    };
  }

  const result = await runDepartment(deps, config, ctx);
  if (result.outcome !== DepartmentOutcome.COMPLETED) {
    return {
      ...NOTHING,
      ran: result,
      blocked:
        'research obligation ' +
        question.id +
        ' could not be discharged: ' +
        (result.reason ?? config.title + ' did not complete'),
    };
  }

  return {
    answer:
      'Serva retrieved evidence under research request ' +
      request.id +
      ' and ' +
      config.title +
      ' reported what the sources say. The findings are canon; the raw captures are untrusted data.',
    refs: result.artifactIds,
    ran: result,
    completedDepartment: config.id,
  };
}

/** Findings that cite any of these captures. */
function findingsFor(store: Store, captureIds: readonly string[]): readonly string[] {
  if (captureIds.length === 0) return [];
  const wanted = new Set(captureIds);
  const out: string[] = [];
  for (const id of store.listCanonIds(ARTIFACT_TYPES.RESEARCH_FINDING)) {
    const env = store.getCanon<{ readonly sources?: readonly { readonly captureId: string }[] }>(
      ARTIFACT_TYPES.RESEARCH_FINDING,
      id,
    );
    const refs = env?.body.sources ?? [];
    if (refs.some((r) => wanted.has(r.captureId))) out.push(id);
  }
  return out;
}

/**
 * Run the department that owes the canon, and resolve the obligation with what it wrote.
 *
 * This is re-entry rather than a retry of the department that asked. Running the requester
 * again while the canon it needs is still absent would produce the same block, the same
 * cost and the same obligation — which is the difference between control flow and a loop.
 */
async function dischargeUpstream(
  deps: ObligationDeps,
  question: OpenQuestion,
  plan: ApplicabilityPlan,
  workItemId: string,
  done: ReadonlySet<string>,
): Promise<Discharge> {
  const family = question.missingCanon as ArtifactType | undefined;
  if (family === undefined) {
    return {
      ...NOTHING,
      blocked:
        'upstream obligation ' +
        question.id +
        ' names no canon family, so no department can be resolved to satisfy it',
    };
  }

  /* Already produced — by an ordinary stage run, or by a pass that died before recording. */
  const existing = deps.store.listCanonIds(family);
  if (existing.length > 0) {
    return {
      answer:
        String(existing.length) +
        ' ' +
        family +
        ' artifact(s) now exist, produced by the department that owes them.',
      refs: existing,
    };
  }

  const config = deps.departments.find((d) => d.produces.includes(family));
  if (config === undefined) {
    return {
      ...NOTHING,
      blocked:
        'upstream obligation ' +
        question.id +
        ' is waiting on ' +
        family +
        ', which no registered department produces: nothing will ever satisfy it',
    };
  }
  if (done.has(config.id)) {
    return {
      ...NOTHING,
      blocked:
        config.title +
        ' has already run and produced no ' +
        family +
        ', so obligation ' +
        question.id +
        ' cannot be satisfied by running it again',
    };
  }

  const ctx = contextFor(deps, config, { workItemId, plan });
  if (ctx === undefined) {
    return {
      ...NOTHING,
      blocked:
        'upstream obligation ' +
        question.id +
        ' is owed by ' +
        config.stageId +
        ', which ' +
        plan.profileId +
        ' does not include: the profile and the dependency contradict each other',
    };
  }

  const result = await runDepartment(deps, config, ctx);
  const produced = deps.store.listCanonIds(family);
  if (result.outcome !== DepartmentOutcome.COMPLETED || produced.length === 0) {
    return {
      ...NOTHING,
      ran: result,
      blocked:
        'upstream obligation ' +
        question.id +
        ' could not be discharged: ' +
        (result.reason ?? config.title + ' produced no ' + family),
    };
  }

  return {
    answer:
      config.title +
      ' produced the ' +
      family +
      ' this question was waiting for, in run ' +
      String(result.runId),
    refs: produced,
    ran: result,
    completedDepartment: config.id,
  };
}
