import {
  RunOutcome,
  SourceMarking,
  StageExecutionState,
  StageLedgerDisposition,
  TrustLevel,
} from '../../vocab/index.js';
import { AuditAction, audit } from '../../events/audit.js';
import { appendLedgerEntry, startStage, transitionStage } from '../../lifecycle/stages.js';
import { assertResearchAuthority } from '../research/gateway.js';
import { resolveIntelligencePolicy } from '../research/capability.js';
import { parseToolSurface } from '../../agents/toolPolicy.js';
import { ScopedCanonWriter, allowedTypesFor } from './authority.js';
import { QuestionRouting, normalizeOpenQuestions } from './questions.js';
import type { OpenQuestion } from './questions.js';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import { ResearchRequestSchema } from '../research/capture.js';
import { OpenQuestionSchema } from '../artifacts/framing.js';
import { researchSeeds } from '../research/seeds.js';
import {
  DecisionPurpose,
  OwnerDecisionRequestSchema,
  ResponseMode,
  ValueKind,
} from '../artifacts/governance.js';
import { DepartmentOutcome } from './types.js';
import type {
  ContextElement,
  DepartmentConfig,
  DepartmentContext,
  DepartmentResult,
  PrepareResult,
  RunnerDeps,
} from './types.js';
import type { z } from 'zod';
import type { Store, Transaction } from '../../store/store.js';
import type { AgentContract } from '../../agents/schema.js';
import type { IntelligenceMeta } from '../provenance.js';
import { isAuthoritativeOwnerAnswer } from '../artifacts/governance.js';

/**
 * THE ONE INTELLIGENCE DEPARTMENT RUNNER.
 *
 * SPEC: 04, 05, 06, 19.
 *
 * Every governed intelligence run goes through here, and the order of operations is the
 * governance. Each step below refuses BEFORE the next becomes possible, so a department
 * cannot reach a model call by being configured optimistically:
 *
 *   1. the agent must be enabled            — a scope decision, not a config tweak
 *   2. independence must hold               — a reviewer may not be the author
 *   3. network authority comes from the contract, never from the department
 *   4. prerequisites must exist             — decided from the Store, no model involved
 *   5. the stage enters IN_PROGRESS         — the ledger records the attempt
 *   6. context is MINIMISED and exclusions recorded
 *   7. the run happens through AgentRuntime — one run, one session, one payload
 *   8. the payload is validated by Serva    — "the provider says it is valid" is not enough
 *   9. artifacts are persisted in ONE transaction
 *  10. the ledger records the disposition   — including the failures
 *
 * A department config contributes only steps 6, 7's task text, and 9's mapping. It cannot
 * reorder, skip, or soften any of the rest, which is exactly the point.
 */

/** Everything the ledger needs to describe one attempt. */
function ledgerActor(config: DepartmentConfig): string {
  return config.agentId;
}

/**
 * How many times a department may be handed a fact it asked for.
 *
 * Two: the original run, and one retry with the answer in hand. A run that asks again
 * after being given the answer has not been unlucky, it has failed to read — and a third
 * attempt would be a loop with a nicer name.
 */
const MAX_FACT_ATTEMPTS = 2;

/**
 * Is there an authority in this company that could lawfully answer a research question?
 *
 * Read from the registered configuration and the canonical contracts, never from the
 * asking department's wishes. Two ways it can be true, and both are a declaration
 * somebody made deliberately: this department is itself research-authorised, or another
 * registered department is — in which case the obligation controller hands the question
 * to it and the asker retrieves nothing.
 */
function companyCanResearch(
  deps: RunnerDeps,
  config: DepartmentConfig<z.ZodTypeAny>,
  contract: AgentContract,
): boolean {
  if (config.usesResearchGateway === true && parseToolSurface(contract).net) return true;
  return (deps.departments ?? []).some((d) => {
    if (d.usesResearchGateway !== true || d.agentId === undefined) return false;
    try {
      return parseToolSurface(deps.registry.get(d.agentId)).net;
    } catch {
      return false;
    }
  });
}

/** The exact artifact, rendered as one context element. Nothing else travels with it. */
function canonAsContext(store: Store, id: string): ContextElement | undefined {
  for (const type of Object.values(ARTIFACT_TYPES)) {
    const env = store.getCanon<unknown>(type, id);
    if (env === undefined) continue;
    return {
      source: id,
      kind: type,
      version: String(env.version),
      content: JSON.stringify(env.body),
      relevance: 1,
      /*
       * STORED IS NOT TRUSTED. A SourceCapture is text a third party wrote that Serva
       * kept a copy of, and handing it back as governed truth because it has an id in
       * the Store is exactly the confusion the trust model exists to prevent.
       */
      ...(type === ARTIFACT_TYPES.SOURCE_CAPTURE ? { trust: TrustLevel.UNTRUSTED } : {}),
    };
  }
  return undefined;
}

/**
 * Record research obligations, and retrieve nothing.
 *
 * A ResearchRequest is a DECLARATION: the question, the purpose, the hosts it may reach and
 * exactly what project material is allowed to leave — which here is nothing, because a
 * department raising a question has not been authorised to disclose anything to answer it.
 *
 * The originating department does not fetch. It cannot: its granted policy has no network
 * and `assertResearchAuthority` refuses it at the gateway. The request is canon, so the
 * research department finds it on a later stage and the requester resumes from persisted
 * evidence rather than from a retrieval of its own.
 */
function raiseResearchObligations(
  deps: RunnerDeps,
  config: DepartmentConfig<z.ZodTypeAny>,
  ctx: DepartmentContext,
  questions: readonly OpenQuestion[],
): readonly string[] {
  const at = deps.clock.now();
  const ids: string[] = [];
  const tx = deps.store.begin();
  try {
    for (const q of questions) {
      const requestId = deps.ids.next('SC-RRQ');
      repository(deps.store, ARTIFACT_TYPES.RESEARCH_REQUEST, ResearchRequestSchema).put(tx, {
        id: requestId,
        createdAt: at,
        question: q.detail,
        purpose: 'raised by ' + config.id + ' while it could not proceed',
        scope: 'MARKET_LANDSCAPE',
        /*
         * WHERE, from the deployment's policy — not from the asking department.
         *
         * The department knows what it needs to find out and has no authority over the
         * company's network boundary. Recording an empty list here would have made every
         * obligation unfulfillable by construction: the gateway checks the URL against
         * exactly this field, so a request nobody may answer would sit OPEN forever while
         * looking like progress. Where the deployment permits no host, the obligation is
         * still recorded and consumption BLOCKS with that as the reason.
         */
        allowedHosts: [...researchSeeds().hosts],
        /* Nothing about this project may leave in the asking. */
        dataAllowedToLeave: [],
        maxSources: 5,
        meta: openQuestionMeta(config, ctx, q, at),
      });

      const questionId = deps.ids.next('SC-OQ');
      repository(deps.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema).put(tx, {
        id: questionId,
        createdAt: at,
        question: q.detail,
        blocks: [],
        askedOf: 'RESEARCH',
        state: 'OPEN',
        raisedBy: config.id,
        ...(q.runId === undefined ? {} : { raisedByRun: q.runId }),
        sourceFields: [...q.sources],
        researchRequestRef: { id: requestId },
        meta: openQuestionMeta(config, ctx, q, at),
      });
      ids.push(requestId, questionId);
    }
    tx.commit();
  } catch {
    /* Nothing partial survives: the obligation is recorded whole or not at all. */
    tx.rollback();
    return [];
  }
  return ids;
}

/**
 * Record upstream obligations, naming the stage that owes the canon.
 *
 * Returns a contradiction instead when the owning stage is not in the active profile.
 * Nobody will ever produce that canon, so waiting is not a plan — and asking the owner
 * would be asking them to do Serva's departmental work.
 */
function raiseUpstreamObligations(
  deps: RunnerDeps,
  config: DepartmentConfig<z.ZodTypeAny>,
  ctx: DepartmentContext,
  questions: readonly OpenQuestion[],
): { readonly artifactIds: readonly string[]; readonly contradiction?: string } {
  const at = deps.clock.now();
  const ids: string[] = [];
  const plannedStages = new Set(ctx.plan.upstreamToRun.map((st) => st.stageId));

  for (const q of questions) {
    const owner = deps.departments?.find(
      (d) => q.missingCanon !== undefined && d.produces.includes(q.missingCanon as never),
    );
    if (owner === undefined) {
      return {
        artifactIds: [],
        contradiction:
          config.title +
          ' is waiting on ' +
          String(q.missingCanon) +
          ', which no registered department produces: nothing will ever satisfy it',
      };
    }
    if (!plannedStages.has(owner.stageId)) {
      return {
        artifactIds: [],
        contradiction:
          config.title +
          ' is waiting on ' +
          String(q.missingCanon) +
          ', owed by ' +
          owner.stageId +
          ', which ' +
          ctx.plan.profileId +
          ' does not run: the profile and the dependency contradict each other',
      };
    }
  }

  const tx = deps.store.begin();
  try {
    for (const q of questions) {
      const owner = deps.departments?.find(
        (d) => q.missingCanon !== undefined && d.produces.includes(q.missingCanon as never),
      );
      const id = deps.ids.next('SC-OQ');
      repository(deps.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema).put(tx, {
        id,
        createdAt: at,
        question: q.detail,
        blocks: [],
        askedOf: 'UPSTREAM_DEPARTMENT',
        state: 'OPEN',
        raisedBy: config.id,
        ...(q.runId === undefined ? {} : { raisedByRun: q.runId }),
        sourceFields: [...q.sources],
        ...(q.missingCanon === undefined ? {} : { missingCanon: q.missingCanon }),
        ...(owner === undefined ? {} : { owedByStage: owner.stageId }),
        meta: openQuestionMeta(config, ctx, q, at),
      });
      ids.push(id);
    }
    tx.commit();
  } catch {
    tx.rollback();
    return { artifactIds: [] };
  }
  return { artifactIds: ids };
}

/** Provenance for a routed question: who asked, in which run, from which field. */
function openQuestionMeta(
  config: DepartmentConfig<z.ZodTypeAny>,
  ctx: DepartmentContext,
  q: OpenQuestion,
  at: string,
): IntelligenceMeta {
  return {
    provenance: {
      marking: SourceMarking.SYSTEM,
      component:
        'intelligence-runner: routed from ' + config.agentId + ' via ' + q.sources.join('+'),
    },
    attribution: {
      ...(q.runId === undefined ? {} : { runId: q.runId }),
      agentId: config.agentId,
      at,
    },
    stageId: config.stageId,
    workItemId: ctx.workItemId,
  };
}

/**
 * Turn blocking escalations into owner decisions, in one transaction.
 *
 * The two options are the same every time, deliberately. Serva does not know enough about
 * an arbitrary escalation to invent meaningful alternatives, and inventing them would be
 * the same failure as inventing the answer — so the choice offered is the honest one:
 * answer it, or say it is out of scope and accept that the behaviour stays unspecified.
 */
function raiseEscalationDecisions(
  deps: RunnerDeps,
  config: DepartmentConfig<z.ZodTypeAny>,
  ctx: DepartmentContext,
  escalations: readonly OpenQuestion[],
): readonly string[] {
  const at = deps.clock.now();
  const ids: string[] = [];
  const tx = deps.store.begin();
  try {
    const repo = repository(
      deps.store,
      ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
      OwnerDecisionRequestSchema,
    );
    for (const e of escalations) {
      const id = deps.ids.next('SC-ODR');
      repo.put(tx, {
        id,
        createdAt: at,
        /*
         * The QUESTION, not a labelled question. The run's own condition word is
         * provenance and goes below; putting it in front of the text makes the owner read
         * "INSUFFICIENT_CONTEXT:" before every sentence, and makes the stored question
         * text depend on which label the run picked.
         */
        question: e.detail,
        whyServaCannotDecide:
          '(' +
          e.condition +
          ') ' +
          config.title +
          ' reached the edge of what it is allowed to decide. Answering this means choosing what the product does, which is yours to choose — and a plausible default here becomes a real behaviour nobody agreed to.',
        purpose: DecisionPurpose.SPECIFICATION_GAP,
        /*
         * A VALUE QUESTION, NOT A MENU.
         *
         * This used to offer "Answer it, and Serva records the answer as company truth" —
         * and then store that sentence as the answer. On resume the department was told
         * the owner had answered "Answer it", which is not a collection window, a hold
         * duration or a cancellation policy. The owner's only workable move was to DEFER
         * something they actually wanted to specify, and the department escalated again.
         *
         * The question the agent asked is a question. It is now asked as one.
         */
        responseMode: ResponseMode.VALUE,
        valueKind: ValueKind.TEXT,
        options: [],
        recommendation: 'Answer it in your own words',
        recommendationRationale:
          'The work is stopped until somebody says what the product should do here. Your answer is recorded as company truth and the stage runs again with it.',
        blocksWork: true,
        blockedRefs: [],
        state: 'OPEN',
        meta: {
          provenance: {
            marking: 'SYSTEM',
            /*
             * The originating field is recorded, so a reader can see that a question filed
             * as `unresolved` was routed identically to one filed as an escalation — which
             * is the invariant, and is invisible without saying so.
             */
            component:
              'intelligence-runner: open question from ' +
              config.agentId +
              ' via ' +
              e.sources.join('+'),
          },
          attribution: {
            ...(e.runId === undefined ? {} : { runId: e.runId }),
            agentId: config.agentId,
            at,
          },
          stageId: config.stageId,
          workItemId: ctx.workItemId,
        },
      });
      ids.push(id);
    }
    tx.commit();
  } catch {
    tx.rollback();
    return [];
  }
  return ids;
}

export async function runDepartment<S extends z.ZodTypeAny>(
  deps: RunnerDeps,
  config: DepartmentConfig<S>,
  ctx: DepartmentContext,
  attempt = 1,
): Promise<DepartmentResult> {
  const base = {
    departmentId: config.id,
    stageId: config.stageId,
    agentId: config.agentId,
    artifactIds: [] as readonly string[],
    ownerDecisionIds: [] as readonly string[],
  };
  const diagnostics: string[] = [];
  const stageDeps = { ids: deps.ids, clock: deps.clock, actor: ledgerActor(config) };

  /*
   * The authorised write set, computed once, before anything runs.
   *
   * `allowedTypesFor` intersects what the department declares with what its contract
   * permits, so neither side can widen the other. The department never sees the
   * transaction itself and therefore cannot commit, cannot roll back, and cannot write
   * outside the intersection.
   */
  const allowedTypes = allowedTypesFor(config, deps.registry);
  const scopedWriter = (tx: Transaction): ScopedCanonWriter =>
    new ScopedCanonWriter(tx, config.agentId, config.id, allowedTypes);

  const refuse = (outcome: DepartmentOutcome, reason: string): DepartmentResult => {
    const tx = deps.store.begin();
    try {
      appendLedgerEntry(tx, stageDeps, {
        workItemId: ctx.workItemId,
        stageId: config.stageId,
        profileRef: ctx.plan.profileId,
        disposition:
          outcome === DepartmentOutcome.PREREQUISITE_MISSING
            ? StageLedgerDisposition.BLOCKED
            : StageLedgerDisposition.FAILED,
        reason,
        attempt,
      });
      tx.commit();
    } catch {
      tx.rollback();
    }
    return { ...base, outcome, diagnostics, reason };
  };

  /* ---------------------------------------------------------- 1. enablement */

  const contract = deps.registry.get(config.agentId);
  if (!deps.enabledAgents.has(config.agentId)) {
    return refuse(
      DepartmentOutcome.REFUSED,
      'Agent ' +
        config.agentId +
        ' is not enabled for execution, so ' +
        config.title +
        ' cannot run. Enabling an agent is a scope decision, not a configuration tweak.',
    );
  }

  /* ------------------------------------------------------- 2. independence */

  /*
   * SPEC: §40. Checked here rather than in each department, because the departments that
   * most need it are exactly the ones whose authors would find it most inconvenient.
   */
  for (const forbidden of config.independentOf ?? []) {
    if (forbidden === config.agentId) {
      return refuse(
        DepartmentOutcome.REFUSED,
        config.title +
          ' is configured to be independent of ' +
          forbidden +
          ', and is running AS that actor: marking your own work is not review',
      );
    }
  }

  /* ------------------------------------------------- 3. network authority */

  /*
   * Network is not a department capability. It belongs to the research gateway, and only
   * an agent whose CANONICAL CONTRACT declares network scope may cause retrieval. A
   * department that merely asks for it is refused here, before anything is fetched.
   */
  if (config.usesResearchGateway === true) {
    try {
      assertResearchAuthority(contract);
    } catch (e) {
      return refuse(DepartmentOutcome.REFUSED, String(e instanceof Error ? e.message : e));
    }
    if (ctx.gateway === undefined) {
      diagnostics.push(
        'no research gateway was provided, so this department will produce findings only from what is already captured',
      );
    }
  } else if (parseToolSurface(contract).net) {
    /*
     * The reverse direction, and worth catching: a contract that declares network being
     * run by a department that never declared it would mean the capability existed and
     * nobody had decided it should.
     */
    diagnostics.push(
      'contract ' +
        contract.id +
        ' declares network scope, but this department does not use the research gateway; no retrieval will occur',
    );
  }

  /* ------------------------------------------------------ 4. prerequisites */

  const missing: string[] = [];
  for (const type of config.requires ?? []) {
    if (deps.store.listCanonIds(type).length === 0) missing.push(type);
  }
  if (missing.length > 0) {
    return refuse(
      DepartmentOutcome.PREREQUISITE_MISSING,
      config.title +
        ' cannot run: no ' +
        missing.join(', ') +
        ' exists yet. The stage that produces it has not completed.',
    );
  }

  /* ------------------------------------------------------------- 5. ledger */

  {
    const tx = deps.store.begin();
    try {
      const state = startStage(tx, deps.store, stageDeps, ctx.workItemId, config.stageId);
      if (state.state !== StageExecutionState.IN_PROGRESS) {
        transitionStage(
          tx,
          deps.store,
          stageDeps,
          ctx.workItemId,
          config.stageId,
          StageExecutionState.IN_PROGRESS,
        );
      }
      tx.commit();
    } catch (e) {
      tx.rollback();
      diagnostics.push('stage transition: ' + String(e instanceof Error ? e.message : e));
    }
  }

  /* ------------------------------- 6a. Serva's own pre-run work, where declared */

  let prepared: PrepareResult = { canon: [], notes: [] };
  if (config.prepare !== undefined) {
    try {
      prepared = await config.prepare(ctx);
    } catch (e) {
      return refuse(
        DepartmentOutcome.FAILED,
        config.title + ' preparation failed: ' + String(e instanceof Error ? e.message : e),
      );
    }
    diagnostics.push(...prepared.notes);
    if (prepared.blocked !== undefined) {
      /*
       * Stopped BEFORE the model call. "We could not find out" is a result, and the one
       * thing that must not happen next is a plausible answer produced without evidence.
       */
      return refuse(DepartmentOutcome.PREREQUISITE_MISSING, prepared.blocked);
    }
  }

  /* ------------------------------------------- 6b. context, deliberately narrow */

  const spec = config.buildContext(ctx);

  /*
   * INDEPENDENCE, SECOND HALF — enforced on the CONTEXT, not on the prompt.
   *
   * Being a different agent id is necessary and not sufficient. A reviewer handed the
   * author's own run — its reasoning, its justification, its summary of why the work is
   * good — is reading the case for the defence and will agree with it. Independence means
   * reviewing the ARTIFACT: canon is sourced by artifact id and type, so a context element
   * sourced from a forbidden ACTOR is the author's voice arriving by the back door.
   *
   * Refused rather than filtered. Silently dropping it would leave the department
   * believing it had context it does not have, and the next reviewer to be written would
   * make the same mistake with nothing to notice it.
   */
  /*
   * ANSWERS THE OWNER HAS ALREADY GIVEN.
   *
   * Added by the runner rather than by each department, because it is what makes an owner
   * pause resumable at all: a department that escalated and is now running again must SEE
   * the answer, and every department would otherwise have to remember to ask for it.
   *
   * Only decisions this department itself raised are included. An answer about pricing is
   * not context for the design system, and a context bundle that grows every time anybody
   * anywhere answers anything is the opposite of the minimisation §41 asks for.
   */
  const answeredForThisDepartment = repository(
    deps.store,
    ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
    OwnerDecisionRequestSchema,
  )
    .list()
    .filter(
      (d) =>
        /*
         * SPEC: finding F1-OWNER-ANSWER-TRUST.
         *
         * This filtered on `state === 'ANSWERED'` plus self-attribution, which is the two
         * conditions a fabricating department satisfies most easily. What reaches a
         * department's TRUSTED context as "the owner answered X. Proceed on it." must be an
         * answer the owner actually gave.
         */
        isAuthoritativeOwnerAnswer(d) &&
        (d.chosenOption !== undefined || d.answerValue !== undefined) &&
        d.meta.attribution.agentId === config.agentId &&
        d.meta.workItemId === ctx.workItemId,
    )
    .map((d) => ({
      source: 'OWNER',
      kind: ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
      version: String(d.version),
      content:
        'The owner was asked: ' +
        d.question +
        String.fromCharCode(10) +
        'The owner answered: ' +
        /* The VALUE where there is one; the chosen option otherwise. Never the meta-option. */
        String(d.answerValue ?? d.chosenOption) +
        String.fromCharCode(10) +
        'This is a decision, not a suggestion. Proceed on it, and do not re-open it.',
      relevance: 1,
    }));

  /*
   * OBLIGATIONS THIS DEPARTMENT RAISED, AND SOMEBODY HAS SINCE DISCHARGED.
   *
   * The mirror of the owner answers above, and it exists for the same reason: the process
   * that asked a question is not the process that resumes with the answer. A department
   * that raised a research obligation, blocked, and is now running again must SEE the
   * evidence that was retrieved for it — otherwise it asks the identical question, the
   * normaliser correctly reports the obligation as already outstanding, and the lifecycle
   * deadlocks on work that was in fact completed.
   *
   * The answer AND the canon it points at, because "this was answered" without the
   * artifacts is a claim rather than evidence.
   */
  const settledObligations = repository(
    deps.store,
    ARTIFACT_TYPES.OPEN_QUESTION,
    OpenQuestionSchema,
  )
    .list()
    .filter(
      (q) =>
        q.raisedBy === config.id &&
        q.state === 'ANSWERED' &&
        (q.meta.workItemId === ctx.workItemId || q.meta.workItemId === undefined),
    )
    .flatMap((q) => [
      {
        source: 'OBLIGATION',
        kind: ARTIFACT_TYPES.OPEN_QUESTION,
        version: String(q.version),
        content:
          'You previously could not proceed without: ' +
          q.question +
          String.fromCharCode(10) +
          'That has now been discharged by ' +
          q.askedOf +
          ': ' +
          (q.answer ?? 'see the referenced canon') +
          String.fromCharCode(10) +
          'Proceed on it. Do not raise the same question again.',
        relevance: 1,
      },
      ...q.resolvedByRefs
        .map((r) => canonAsContext(deps.store, r.id))
        .filter((c): c is ContextElement => c !== undefined),
    ]);

  const forbiddenActors = new Set(config.independentOf ?? []);
  if (forbiddenActors.size > 0) {
    const leaked = spec.canon.filter((c) => forbiddenActors.has(c.source));
    if (leaked.length > 0) {
      return refuse(
        DepartmentOutcome.REFUSED,
        config.title +
          ' must be independent of ' +
          [...forbiddenActors].join(', ') +
          ', but its context carries that actor’s own run: ' +
          leaked.map((c) => c.source + '/' + c.kind).join(', ') +
          '. A reviewer reads the artifact, not the author’s account of it.',
      );
    }
  }
  if (spec.excluded.length > 0) {
    const tx = deps.store.begin();
    try {
      audit(tx, {
        action: AuditAction.ARTIFACT_RECORDED,
        subject: config.id,
        outcome: 'OK',
        detail: {
          contextExclusions: spec.excluded.map((e) => e.subject + ': ' + e.reason).slice(0, 20),
        },
      });
      tx.commit();
    } catch {
      tx.rollback();
    }
  }

  /* --------------------------- 7a. a computed stage asks nobody and spends nothing */

  if (config.deterministic === true) {
    let computed;
    const dtx = deps.store.begin();
    try {
      /*
       * The empty payload is deliberate: a deterministic department derives everything
       * from the Store, so there is no model output to validate. It goes through the same
       * transaction, the same SCOPED WRITER and the same ledger path as every other
       * department — computing an artifact is not a reason to be trusted with a wider
       * write surface than reasoning about one.
       */
      computed = config.persist(scopedWriter(dtx), undefined as never, ctx);
      dtx.commit();
    } catch (e) {
      dtx.rollback();
      return refuse(
        DepartmentOutcome.FAILED,
        config.title + ' could not be computed: ' + String(e instanceof Error ? e.message : e),
      );
    }

    const ltx = deps.store.begin();
    try {
      appendLedgerEntry(ltx, stageDeps, {
        workItemId: ctx.workItemId,
        stageId: config.stageId,
        profileRef: ctx.plan.profileId,
        disposition: StageLedgerDisposition.EXECUTED,
        reason: config.title + ' computed from persisted canon (no model call)',
        attempt,
      });
      ltx.commit();
    } catch {
      ltx.rollback();
    }

    return {
      ...base,
      outcome: DepartmentOutcome.COMPLETED,
      artifactIds: [...(prepared.artifactIds ?? []), ...computed.artifactIds],
      ownerDecisionIds: computed.ownerDecisionIds ?? [],
      diagnostics: [...diagnostics, ...(computed.notes ?? [])],
      ...(computed.judgements === undefined ? {} : { judgements: computed.judgements }),
    };
  }

  /* ------------------------------------------------------------- 7b. the run */

  const assembled: readonly ContextElement[] = [
    ...spec.canon,
    ...prepared.canon,
    ...answeredForThisDepartment,
    ...settledObligations,
    /* Exactly what an earlier attempt asked for, and nothing more. */
    ...(ctx.supplied ?? []),
  ];

  /*
   * RETRIEVED EVIDENCE MAY NOT ENTER TRUSTED CONTEXT.
   *
   * Checked against the STORE, not against a name or a kind string: an element whose
   * source names a SourceCapture is retrieved text, whatever the department called it.
   * The bundle's structural marking is the authoritative one, so a department that
   * assembled a capture as trusted is refused here rather than corrected quietly — a
   * silent downgrade would leave the next department author making the same mistake with
   * nothing to notice it.
   */
  {
    const captureIds = new Set(deps.store.listCanonIds(ARTIFACT_TYPES.SOURCE_CAPTURE));
    const promoted = assembled.filter(
      (c) =>
        c.trust !== TrustLevel.UNTRUSTED && [...captureIds].some((id) => c.source.includes(id)),
    );
    if (promoted.length > 0) {
      return refuse(
        DepartmentOutcome.REFUSED,
        config.title +
          ' assembled retrieved evidence as trusted context: ' +
          promoted.map((c) => c.source).join(', ') +
          '. A captured source is data about the world and never governed project truth, however long Serva has stored it.',
      );
    }
  }

  let run;
  try {
    run = await deps.runtime.run({
      agentId: config.agentId,
      workItemId: ctx.workItemId,
      taskDefinition: config.task(ctx),
      scopeBoundary: config.scopeBoundary(ctx),
      ...(ctx.ownerRequest === undefined ? {} : { ownerRequest: ctx.ownerRequest }),
      resultSchema: config.outputJsonSchema,
      resultValidator: config.outputSchema,
      /*
       * The grant is computed HERE, not derived by the runtime.
       *
       * Phase 3 refuses to resolve a policy for a contract that declares network, because
       * it cannot enforce network at call time. Serva's answer is not to enforce it but
       * to withhold it: retrieval happens in the gateway, and the run itself gets no
       * tools at all. The grant is proved to be within the contract before binding.
       */
      capability: {
        policy: resolveIntelligencePolicy(contract, {
          projectRoot: deps.projectRoot,
          enabled: deps.enabledAgents,
        }),
        cwd: deps.projectRoot,
        basis:
          'company intelligence run: no filesystem, no execution, no network; any external evidence was retrieved by Serva and is present as untrusted data',
      },
      canon: assembled.map((c) => ({
        source: c.source,
        kind: c.kind,
        version: c.version,
        content: c.content,
        relevance: c.relevance,
        /* Carried, so the persisted bundle and the prompt agree with the artifact. */
        ...(c.trust === undefined ? {} : { trust: c.trust }),
      })),
    });
  } catch (e) {
    return refuse(
      DepartmentOutcome.FAILED,
      config.title + ' could not be dispatched: ' + String(e instanceof Error ? e.message : e),
    );
  }

  diagnostics.push(...run.diagnostics);

  /* ------------------------------------------------------- 8. Serva validates */

  if (run.outcome !== RunOutcome.COMPLETED || run.envelope === undefined) {
    /*
     * NO OUTPUT = NOTHING RECORDED still holds — no canon is written from a run that did
     * not complete. But an ESCALATED run is not a silent failure: the agent said what it
     * could not proceed without, and discarding that leaves an operator staring at a
     * refusal with no way to act on it.
     *
     * Found by the live suite, where a real intake run escalated on a genuinely
     * under-specified request and the only thing Serva reported was that it had escalated.
     */
    const escalations = run.envelope?.escalations ?? [];
    for (const e of escalations) {
      diagnostics.push(
        (e.blocking ? 'BLOCKING escalation: ' : 'escalation: ') + e.condition + ' — ' + e.detail,
      );
    }
    const said =
      escalations.length === 0
        ? ''
        : ' The run escalated: ' +
          escalations.map((e) => e.condition + ' (' + e.detail + ')').join('; ');
    const unresolved = run.envelope?.unresolved ?? [];
    const open = unresolved.length === 0 ? '' : ' Unresolved: ' + unresolved.join('; ');

    /*
     * AN ESCALATION IS A QUESTION, AND THE HONEST RESPONSE TO A QUESTION IS TO ASK IT —
     * not to report an error and stop.
     *
     * Serva writes the OwnerDecisionRequest, not the agent. The agent supplied the
     * condition and the detail; the structure around them — why this is not Serva's to
     * decide, what the options are, what happens either way — is Serva's, and an agent
     * able to author the whole request would be an agent able to author its own approval.
     *
     * WE ARE ALREADY IN THE NOT-COMPLETED BRANCH, so every escalation here is blocking by
     * situation rather than by declaration. The stage produced nothing; the escalations
     * are the agent's account of what it needed and did not have.
     *
     * Two live runs were needed to get this rule right, and both times the narrower
     * version swallowed a real question:
     *
     *   business analysis raised four escalations — undefined reservation statuses,
     *   uncollected holds, whether any money is involved at all — and marked none of them
     *   `blocking`, so a flag-based rule dropped all four;
     *
     *   discovery then ended EVIDENCE_VIOLATION rather than ESCALATED, because what it
     *   objected to was an unvalidated load-bearing assumption, so a status-based rule
     *   dropped that one too.
     *
     * Both attempts were the same mistake: asking the agent to classify its own failure
     * and then routing on the answer. What Serva actually knows is simpler and is not the
     * agent's to characterise — the run did not complete, and it said why.
     *
     * The flag is still honoured where it can be: a run that COMPLETED does not come
     * through here at all, so a concern noted alongside real output raises nothing.
     */
    /*
     * NORMALISE FIRST, ROUTE SECOND.
     *
     * Both envelope fields become one deduplicated list, and each question is routed from
     * what the STORE says rather than from how the run happened to file it. Not everything
     * a run could not resolve is the owner's: some of it is already recorded, some of it
     * is a fact about the world Serva may retrieve, and some of it is canon another
     * department owes.
     *
     * Asking the owner all of it would be asking them to do Serva's job, and would train
     * them to skim.
     */
    const questions = normalizeOpenQuestions({
      escalations,
      unresolved,
      store: deps.store,
      workItemId: ctx.workItemId,
      produces: config.produces,
      /*
       * RESEARCH AUTHORITY IS NOT THE PRESENCE OF A GATEWAY.
       *
       * The orchestrator puts one gateway in the context for the whole run, so testing
       * `ctx.gateway !== undefined` would have let any department claim a research route
       * merely because a gateway OBJECT existed — a UX designer included, in a project
       * with no researcher at all.
       *
       * The question this asks is not "may this run fetch?" — it may not, and nothing
       * here changes that. It is "can the COMPANY lawfully answer this by retrieval?",
       * which is a fact about the registered configuration: some department declares
       * research, ITS canonical contract grants network scope, and a gateway exists to do
       * it with. Where that authority exists, a department with no network of its own may
       * route a question to it and wait; where it does not, the route is never offered and
       * the question falls to the owner, which is the honest result.
       *
       * `assertResearchAuthority` is untouched and still refuses at the point of
       * retrieval, so the asking department cannot fetch whatever this decides.
       */
      canResearch: ctx.gateway !== undefined && companyCanResearch(deps, config, contract),
      ...(run.runId === undefined ? {} : { runId: run.runId }),
    });

    for (const q of questions) {
      diagnostics.push(
        q.routing +
          ' [' +
          q.sources.join('+') +
          '] ' +
          q.condition +
          ' — ' +
          q.detail +
          ' (' +
          q.why +
          ')',
      );
    }

    /* --------------------------------------------------- EXISTING_STORE_FACT: supply it */

    const facts = questions.filter((q) => q.routing === QuestionRouting.EXISTING_STORE_FACT);
    if (facts.length > 0 && attempt < MAX_FACT_ATTEMPTS) {
      /*
       * The answer is already canon and this run was not shown it. Saying so in a log and
       * failing would be describing the fix rather than applying it.
       *
       * So the exact artifact is bound into the context and the department runs once more.
       * ONCE: `MAX_FACT_ATTEMPTS` is 2, so a run that asks the same question again after
       * being handed the answer fails explicitly rather than looping. The whole Store is
       * not opened up — only the artifacts the questions actually named.
       */
      const supplied = facts
        .map((q) => q.factRef)
        .filter((id): id is string => id !== undefined)
        .map((id) => canonAsContext(deps.store, id))
        .filter((c): c is ContextElement => c !== undefined);

      if (supplied.length > 0) {
        diagnostics.push(
          'supplying ' +
            supplied.map((c) => c.source).join(', ') +
            ' and retrying ' +
            config.title +
            ' once',
        );
        /*
         * The retry's diagnostics are prepended with this attempt's, so the trace shows
         * that a question was asked, what was supplied and that a second attempt happened.
         * A recursive call with a fresh diagnostics array would leave the record saying
         * the department simply worked, which is not what happened.
         */
        const retried = await runDepartment(deps, config, { ...ctx, supplied }, attempt + 1);
        return { ...retried, diagnostics: [...diagnostics, ...retried.diagnostics] };
      }
    }
    if (facts.length > 0) {
      /*
       * Second time round with the fact in hand, still asking. That is a run that did not
       * use what it was given, and retrying again would be a loop with a nicer name.
       */
      return {
        ...refuse(
          DepartmentOutcome.FAILED,
          config.title +
            ' was given ' +
            facts.map((q) => q.factRef ?? '(unnamed)').join(', ') +
            ' and asked for it again: ' +
            facts.map((q) => q.detail).join('; '),
        ),
        runId: run.runId,
      };
    }

    /* ------------------------------------------------------- RESEARCH: a real obligation */

    const forResearch = questions.filter((q) => q.routing === QuestionRouting.RESEARCH);
    if (forResearch.length > 0) {
      const raised = raiseResearchObligations(deps, config, ctx, forResearch);
      return {
        ...base,
        outcome: DepartmentOutcome.PREREQUISITE_MISSING,
        runId: run.runId,
        artifactIds: raised,
        diagnostics,
        reason:
          config.title +
          ' needs evidence Serva must retrieve: ' +
          forResearch.map((q) => q.detail).join('; ') +
          '. Recorded as ' +
          String(raised.length) +
          ' research obligation(s); this department does not retrieve for itself.',
      };
    }

    /* --------------------------------------------- UPSTREAM_DEPARTMENT: a real obligation */

    const forUpstream = questions.filter((q) => q.routing === QuestionRouting.UPSTREAM_DEPARTMENT);
    if (forUpstream.length > 0) {
      const { artifactIds, contradiction } = raiseUpstreamObligations(
        deps,
        config,
        ctx,
        forUpstream,
      );
      if (contradiction !== undefined) {
        /*
         * The canon is owed by a stage this profile does not run. Nobody will ever produce
         * it, so waiting is not a plan and asking the owner would be asking them to do
         * Serva's departmental work.
         */
        return { ...refuse(DepartmentOutcome.FAILED, contradiction), runId: run.runId };
      }
      return {
        ...base,
        outcome: DepartmentOutcome.PREREQUISITE_MISSING,
        runId: run.runId,
        artifactIds,
        diagnostics,
        reason:
          config.title +
          ' is waiting on canon another department owes: ' +
          forUpstream.map((q) => String(q.missingCanon)).join(', '),
      };
    }

    /* ------------------------------------------------------ ALREADY_ROUTED / _ANSWERED */

    const settled = questions.filter(
      (q) =>
        q.routing === QuestionRouting.ALREADY_ANSWERED ||
        q.routing === QuestionRouting.ALREADY_ROUTED,
    );
    if (settled.length > 0 && settled.length === questions.length) {
      /*
       * Everything it asked has already been asked or answered, and it asked anyway. No
       * duplicate is created — that property is the whole point — but the run has failed
       * to use authoritative context it was given, and that is worth saying out loud
       * rather than quietly retrying.
       */
      return {
        ...refuse(
          DepartmentOutcome.FAILED,
          config.title +
            ' raised only questions that are already settled or outstanding, and did not use the answers it was given: ' +
            settled.map((q) => q.detail).join('; '),
        ),
        runId: run.runId,
      };
    }

    /* --------------------------------------------------------------- OWNER_DECISION */

    const forOwner = questions.filter((q) => q.routing === QuestionRouting.OWNER_DECISION);

    if (forOwner.length > 0) {
      const raised = raiseEscalationDecisions(deps, config, ctx, forOwner);
      if (raised.length > 0) {
        const ltx = deps.store.begin();
        try {
          appendLedgerEntry(ltx, stageDeps, {
            workItemId: ctx.workItemId,
            stageId: config.stageId,
            profileRef: ctx.plan.profileId,
            /*
             * BLOCKED, not FAILED. Nothing went wrong: the department reached the edge of
             * what it is allowed to decide and said so, which is the behaviour the whole
             * authority boundary exists to produce.
             */
            disposition: StageLedgerDisposition.BLOCKED,
            reason:
              config.title +
              ' raised ' +
              String(forOwner.length) +
              ' question(s) that are the owner\u2019s to answer',
            attempt,
          });
          ltx.commit();
        } catch {
          ltx.rollback();
        }
        return {
          ...base,
          outcome: DepartmentOutcome.ESCALATED_TO_OWNER,
          runId: run.runId,
          ownerDecisionIds: raised,
          diagnostics,
          reason:
            config.title +
            ' cannot proceed without the owner: ' +
            forOwner.map((q) => q.detail).join('; '),
        };
      }
    }

    return {
      ...refuse(
        DepartmentOutcome.FAILED,
        config.title +
          ' run ended ' +
          run.outcome +
          '. NO OUTPUT = NOTHING RECORDED.' +
          said +
          open,
      ),
      runId: run.runId,
    };
  }

  const parsed = config.outputSchema.safeParse(run.envelope.result);
  if (!parsed.success) {
    return {
      ...refuse(
        DepartmentOutcome.FAILED,
        config.title + ' produced a payload Serva does not accept for this role',
      ),
      runId: run.runId,
    };
  }

  /* ------------------------------------------------- 9. persist, atomically */

  let persisted;
  const tx = deps.store.begin();
  try {
    /*
     * The department writes through a scope it cannot widen. An artifact type outside its
     * canonical authority is refused at the call, before anything is staged — so a
     * violation leaves no partial state, and the transaction either commits everything
     * this department was entitled to write or nothing at all.
     */
    /*
     * The run id reaches `persist` here, and only here. A department cannot know it
     * beforehand — the run does not exist when the context is built — and a caller that
     * could supply one could attribute canon to a run that never happened.
     */
    persisted = config.persist(scopedWriter(tx), parsed.data as z.output<S>, {
      ...ctx,
      ...(run.runId === undefined ? {} : { runId: run.runId }),
    });
    tx.commit();
  } catch (e) {
    tx.rollback();
    return {
      ...refuse(
        DepartmentOutcome.FAILED,
        config.title +
          ' produced output that could not be recorded as canon: ' +
          String(e instanceof Error ? e.message : e),
      ),
      runId: run.runId,
    };
  }

  /* ---------------------------------------------------------- 10. disposition */

  const ownerDecisionIds = persisted.ownerDecisionIds ?? [];
  const outcome =
    ownerDecisionIds.length > 0
      ? DepartmentOutcome.OWNER_DECISION_REQUIRED
      : DepartmentOutcome.COMPLETED;

  {
    const ltx = deps.store.begin();
    try {
      appendLedgerEntry(ltx, stageDeps, {
        workItemId: ctx.workItemId,
        stageId: config.stageId,
        profileRef: ctx.plan.profileId,
        /*
         * EXECUTED even when an owner decision is outstanding: the department DID its
         * work and produced a question. Recording it as blocked would lose the fact that
         * the analysis happened, and would make a resume look like a first attempt.
         */
        disposition: StageLedgerDisposition.EXECUTED,
        reason:
          outcome === DepartmentOutcome.OWNER_DECISION_REQUIRED
            ? config.title +
              ' completed and raised ' +
              String(ownerDecisionIds.length) +
              ' owner decision(s)'
            : config.title + ' completed',
        attempt,
      });
      ltx.commit();
    } catch (e) {
      ltx.rollback();
      diagnostics.push('ledger: ' + String(e instanceof Error ? e.message : e));
    }
  }

  if (persisted.notes !== undefined) diagnostics.push(...persisted.notes);

  return {
    ...base,
    outcome,
    runId: run.runId,
    artifactIds: [...(prepared.artifactIds ?? []), ...persisted.artifactIds],
    ownerDecisionIds,
    diagnostics,
    ...(persisted.judgements === undefined ? {} : { judgements: persisted.judgements }),
  };
}
