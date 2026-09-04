import { ARTIFACT_TYPES, repository } from '../repository.js';
import { OpenQuestionSchema, OpenQuestionState } from '../artifacts/framing.js';
import {
  ResearchRequestSchema,
  SourceCaptureSchema,
  captureIsIntact,
} from '../research/capture.js';
import { ResearchFindingSchema } from '../artifacts/market.js';
import {
  ClaimVerificationSchema,
  claimIsAuthoritative,
  verificationRefusal,
} from '../research/verification.js';
import { assessFreshness } from '../research/freshness.js';
import { ValidityState } from '../../vocab/index.js';
import { AuditAction, audit } from '../../events/audit.js';
import { runDepartment } from './runner.js';
import { DepartmentOutcome } from './types.js';
import type { DepartmentConfig, DepartmentContext, DepartmentResult, RunnerDeps } from './types.js';
import type { ApplicabilityPlan } from '../applicability.js';
import type { GatewayDeps } from '../research/gateway.js';
import type { OpenQuestion } from '../artifacts/framing.js';
import type { ArtifactType } from '../repository.js';
import type { Store } from '../../store/store.js';
import type { ResearchRequest, SourceCapture } from '../research/capture.js';
import type { ResearchFinding } from '../artifacts/market.js';
import type { ClaimVerification } from '../research/verification.js';

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
    for (const id of outcome.extraCompleted ??
      (outcome.completedDepartment === undefined ? [] : [outcome.completedDepartment])) {
      if (done.has(id)) continue;
      completedDepartments.push(id);
      done.add(id);
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
  /** Every department this discharge ran to completion. A research chain runs two. */
  readonly extraCompleted?: readonly string[];
}

const NOTHING = { answer: '', refs: [] as readonly string[] };

/**
 * The evidence that exists for one research request, and whether it may be relied on.
 *
 * EXACT, VERIFIED AND CURRENT — all three, or it is not evidence for THIS obligation.
 *
 * Matching on the question text was the previous rule and it was not enough. Two requests
 * can ask identical words: a capture fetched under one of them proves nothing about the
 * other, and reusing it would let an unrelated piece of research silently discharge a
 * current obligation. So the relation is the `requestRef` the gateway stamps at retrieval.
 *
 * Currency is assessed with the canonical freshness model rather than a second rule
 * invented here, and staleness propagates: a finding resting on an expired capture is
 * expired too, however recently somebody wrote the finding down.
 */
interface ResearchEvidence {
  /** Captures fetched under this exact request, intact and current. */
  readonly captures: readonly SourceCapture[];
  /** Captures for this request that have expired or been altered. */
  readonly unusable: readonly string[];
  /** Findings resting on those captures. */
  readonly findings: readonly ResearchFinding[];
  /** Findings whose verification is authoritative, independent and intact. */
  readonly authoritative: readonly ResearchFinding[];
  /** The verifications that made them so. */
  readonly verifications: readonly ClaimVerification[];
  /** Why a finding may not be relied on, in the canonical vocabulary. */
  readonly refusals: readonly string[];
  /** True when every finding has been judged by a verifier. */
  readonly verified: boolean;
}

/**
 * Which of a finding's own sources no longer are what the finding cited.
 *
 * SPEC: finding OLER-INTEGRITY-1 (MEDIUM), 1.0.1 security review.
 *
 * Named and exported so the rule can be tested as a rule. `authoritative` is documented as
 * "authoritative, independent and intact", and intactness was wired for the usable-capture
 * list and for the captures a VERIFICATION cites — never for the sources the finding itself
 * rests on. Freshness does not cover it: `assessFreshness` reads `validUntil` alone, so a
 * capture whose excerpt no longer matches its digest stays VALID until it expires.
 *
 * A missing capture counts as broken. A source that cannot be produced is not a source, and
 * treating absence as "nothing to check" is how a citation stops meaning anything.
 */
export function brokenSources(
  finding: ResearchFinding,
  captures: readonly SourceCapture[],
): readonly string[] {
  const byId = new Map(captures.map((c) => [c.id, c]));
  return finding.sources
    .map((ref) => ref.captureId)
    .filter((id) => {
      const capture = byId.get(id);
      return capture === undefined || !captureIsIntact(capture);
    });
}

function researchEvidence(deps: ObligationDeps, request: ResearchRequest): ResearchEvidence {
  const allCaptures = repository(
    deps.store,
    ARTIFACT_TYPES.SOURCE_CAPTURE,
    SourceCaptureSchema,
  ).list();
  /* Bound to THIS authorisation. A capture with no request ref is never reused. */
  const mine = allCaptures.filter((c) => c.requestRef?.id === request.id);

  const allFindings = repository(
    deps.store,
    ARTIFACT_TYPES.RESEARCH_FINDING,
    ResearchFindingSchema,
  ).list();
  const mineIds = new Set(mine.map((c) => c.id));
  const findings = allFindings.filter((f) => f.sources.some((r) => mineIds.has(r.captureId)));

  /* Freshness across the real dependency graph: findings rest on captures. */
  const verdicts = new Map(
    assessFreshness(
      [
        ...mine.map((c) => ({ id: c.id, validUntil: c.validUntil })),
        ...findings.map((f) => ({
          id: f.id,
          validUntil: f.freshness.validUntil,
          dependsOn: f.sources.map((r) => r.captureId),
        })),
      ],
      deps.clock,
    ).map((v) => [v.id, v]),
  );

  const unusable: string[] = [];
  const usable: SourceCapture[] = [];
  for (const c of mine) {
    if (!captureIsIntact(c)) {
      unusable.push('capture ' + c.id + ' no longer matches its content digest');
      continue;
    }
    if (verdicts.get(c.id)?.state === ValidityState.STALE) {
      unusable.push('capture ' + c.id + ' expired on ' + c.validUntil);
      continue;
    }
    usable.push(c);
  }

  const allVerifications = repository(
    deps.store,
    ARTIFACT_TYPES.CLAIM_VERIFICATION,
    ClaimVerificationSchema,
  ).list();

  const authoritative: ResearchFinding[] = [];
  const verifications: ClaimVerification[] = [];
  const refusals: string[] = [];
  let judged = 0;

  for (const f of findings) {
    const forThis = allVerifications.filter((v) => v.claimRef.id === f.id);
    if (forThis.length === 0) continue;
    judged += 1;

    if (verdicts.get(f.id)?.state === ValidityState.STALE) {
      refusals.push(
        'finding ' + f.id + ' is stale: ' + (verdicts.get(f.id)?.reason ?? 'it has expired'),
      );
      continue;
    }

    /*
     * AND THE CAPTURES THE FINDING ITSELF RESTS ON MUST STILL BE WHAT THEY WERE.
     *
     * SPEC: finding OLER-INTEGRITY-1 (MEDIUM), 1.0.1 security review.
     *
     * `authoritative` is documented as "authoritative, independent and intact", and intactness
     * was wired for two of the three: the usable-capture list above, and — inside
     * `verificationRefusal` — the captures the VERIFICATION cites. The finding's own sources
     * were never checked. Freshness does not cover it: `assessFreshness` reads `validUntil`
     * alone, so a capture whose excerpt no longer matches its content digest is VALID until it
     * expires, and a verification citing some other intact capture could discharge a claim
     * resting on it.
     *
     * A digest that no longer matches means the passage relied on is not the passage that was
     * fetched. Whatever else is true of the finding, it no longer rests on what it cites.
     */
    const broken = brokenSources(f, mine);
    if (broken.length > 0) {
      refusals.push(
        'finding ' +
          f.id +
          ' rests on ' +
          broken.join(', ') +
          ', which no longer matches what was fetched',
      );
      continue;
    }

    let accepted: ClaimVerification | undefined;
    for (const v of forThis) {
      /*
       * Passed unconditionally. Spreading these away when the attribution lacked them meant a
       * finding with no recorded author silently skipped the independence check — the caller
       * deciding, by omission, not to ask a question the verifier exists to answer.
       */
      const refusal = verificationRefusal(v, {
        claimRunId: f.meta.attribution.runId ?? '',
        claimAgentId: f.meta.attribution.agentId ?? '',
        captures: mine,
      });
      if (refusal !== undefined) {
        refusals.push(refusal);
        continue;
      }
      if (!claimIsAuthoritative(v)) {
        refusals.push('finding ' + f.id + ' was judged ' + v.verdict + ': ' + v.reasoning);
        continue;
      }
      accepted = v;
      break;
    }
    if (accepted === undefined) continue;
    authoritative.push(f);
    verifications.push(accepted);
  }

  return {
    captures: usable,
    unusable,
    findings,
    authoritative,
    verifications,
    refusals,
    verified: findings.length > 0 && judged === findings.length,
  };
}

/**
 * Hand a research obligation to the canonical research authority, and then to its verifier.
 *
 * RETRIEVED IS NOT ESTABLISHED. The previous version resolved the obligation the moment
 * SC-AGENT-060 completed, which meant a downstream department resumed on findings nobody
 * had checked against the sources they cite — and the whole point of a separate Source
 * Verifier is that the researcher's own confidence is not evidence. `SOURCE_MISSING` is
 * the most common real failure in research, and it was being routed straight into the
 * requirements of another department.
 *
 * The chain, in three governed steps, each resumable on its own:
 *
 *   exact ResearchRequest -> SC-AGENT-060 -> SourceCapture (UNTRUSTED) + ResearchFinding
 *   -> SC-AGENT-063, which cannot fetch and may not be the claimant -> ClaimVerification
 *   -> only findings whose verdict is authoritative discharge the obligation.
 *
 * Each step is skipped when its result already exists for this exact request, so a process
 * that died between retrieval and verification resumes at verification rather than paying
 * for the retrieval again.
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

  const ran: DepartmentResult[] = [];
  const completed: string[] = [];

  /* ---------------------------------------- 1. retrieve, unless it has already happened */

  let evidence = researchEvidence(deps, request);
  if (evidence.findings.length === 0 || evidence.captures.length === 0) {
    const stale =
      evidence.unusable.length === 0
        ? ''
        : ' (previous evidence is unusable: ' + evidence.unusable.join('; ') + ')';

    const researcher = deps.departments.find((d) => d.usesResearchGateway === true);
    if (researcher === undefined) {
      return {
        ...NOTHING,
        blocked:
          'research obligation ' +
          question.id +
          ' cannot be discharged: no registered department declares research authority, so nobody may retrieve for it',
      };
    }
    if (done.has(researcher.id)) {
      return {
        ...NOTHING,
        blocked:
          'research obligation ' +
          question.id +
          ' is still open although ' +
          researcher.title +
          ' has already run: the retrieval it needs produced nothing that answers it' +
          stale,
      };
    }
    const ctx = contextFor(deps, researcher, {
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
          researcher.stageId +
          ', which ' +
          plan.profileId +
          ' does not include: the profile and the obligation contradict each other',
      };
    }
    const result = await runDepartment(deps, researcher, ctx);
    ran.push(result);
    if (result.outcome !== DepartmentOutcome.COMPLETED) {
      return {
        ...NOTHING,
        ran: result,
        blocked:
          'research obligation ' +
          question.id +
          ' could not be discharged: ' +
          (result.reason ?? researcher.title + ' did not complete') +
          stale,
      };
    }
    completed.push(researcher.id);
    evidence = researchEvidence(deps, request);
  }

  if (evidence.findings.length === 0) {
    return {
      ...NOTHING,
      ...(ran[0] === undefined ? {} : { ran: ran[0] }),
      ...(completed[0] === undefined ? {} : { completedDepartment: completed[0] }),
      blocked:
        'research obligation ' +
        question.id +
        ' produced no finding tied to request ' +
        request.id +
        ', so nothing was established',
    };
  }

  /* ------------------------------------------- 2. verify, unless that has happened too */

  if (!evidence.verified) {
    const verifier = deps.departments.find((d) =>
      d.produces.includes(ARTIFACT_TYPES.CLAIM_VERIFICATION),
    );
    if (verifier === undefined) {
      return {
        ...NOTHING,
        ...(ran[0] === undefined ? {} : { ran: ran[0] }),
        ...(completed[0] === undefined ? {} : { completedDepartment: completed[0] }),
        blocked:
          'research obligation ' +
          question.id +
          ' has findings that nobody can verify: no registered department produces ' +
          ARTIFACT_TYPES.CLAIM_VERIFICATION +
          '. Unverified research does not become another department\u2019s prerequisite.',
      };
    }
    const ctx = contextFor(deps, verifier, { workItemId, plan });
    if (ctx === undefined) {
      return {
        ...NOTHING,
        ...(ran[0] === undefined ? {} : { ran: ran[0] }),
        blocked:
          'research obligation ' +
          question.id +
          ' needs verification from ' +
          verifier.stageId +
          ', which ' +
          plan.profileId +
          ' does not include',
      };
    }
    const result = await runDepartment(deps, verifier, ctx);
    ran.push(result);
    if (result.outcome !== DepartmentOutcome.COMPLETED) {
      return {
        ...NOTHING,
        ran: result,
        ...(completed[0] === undefined ? {} : { completedDepartment: completed[0] }),
        blocked:
          'research obligation ' +
          question.id +
          ' could not be verified: ' +
          (result.reason ?? verifier.title + ' did not complete'),
      };
    }
    completed.push(verifier.id);
    evidence = researchEvidence(deps, request);
  }

  /* ------------------------------------ 3. only authoritative evidence discharges it */

  if (evidence.authoritative.length === 0) {
    /*
     * The research happened and did not establish anything. That is a legitimate result
     * and the one thing it must not do is let a downstream department proceed as though
     * the question were settled — which is exactly what resolving here would mean.
     */
    return {
      ...NOTHING,
      ...(ran[ran.length - 1] === undefined
        ? {}
        : { ran: ran[ran.length - 1] as DepartmentResult }),
      ...(completed[0] === undefined ? {} : { completedDepartment: completed[0] }),
      blocked:
        'research obligation ' +
        question.id +
        ' is NOT fulfilled: no finding survived independent verification. ' +
        (evidence.refusals.length === 0
          ? 'Nothing was judged authoritative.'
          : evidence.refusals.join('; ')) +
        ' No market truth was recorded from unsupported claims.',
    };
  }

  /*
   * THE REFS ARE CHOSEN, NOT COPIED.
   *
   * Handing back `result.artifactIds` would include the ResearchRequest and every raw
   * SourceCapture, which is how retrieved text used to arrive in a downstream department's
   * context as though it were governed canon. What a requester needs is the verified
   * conclusion and the judgement that made it one; the captures stay linked to the
   * findings for audit, where they remain untrusted.
   */
  return {
    answer:
      String(evidence.authoritative.length) +
      ' finding(s) were established under research request ' +
      request.id +
      ' and independently verified: ' +
      evidence.authoritative.map((f) => f.finding).join(' | '),
    refs: [...evidence.authoritative.map((f) => f.id), ...evidence.verifications.map((v) => v.id)],
    ...(ran[ran.length - 1] === undefined ? {} : { ran: ran[ran.length - 1] as DepartmentResult }),
    ...(completed[0] === undefined ? {} : { completedDepartment: completed[0] }),
    extraCompleted: completed,
  };
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
