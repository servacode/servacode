import { StageLedgerDisposition } from '../vocab/index.js';
import { fail } from '../core/errors.js';
import { AuditAction, audit } from '../events/audit.js';
import { appendLedgerEntry } from '../lifecycle/stages.js';
import { getCatalogues } from '../catalogue/index.js';
import { ARTIFACT_TYPES, canonExists, repository } from './repository.js';
import {
  ChangeRequestSchema,
  DecisionPurpose,
  IMPACT_DIMENSIONS,
  ImpactAnalysisSchema,
  OptionDisposition,
  OwnerDecisionRequestSchema,
  approvalRefusal,
  unassessedDimensions,
} from './artifacts/governance.js';
import { readOrchestratorRecord, writeOrchestratorRecord } from './execution/orchestrator.js';
import { GateVerdict } from '../vocab/index.js';
import { resolveApplicability } from './applicability.js';
import { UPSTREAM_DEPARTMENTS } from './app.js';
import type {
  ChangeRequest,
  ImpactAnalysis,
  OwnerDecisionRequest,
} from './artifacts/governance.js';
import type { Store } from '../store/store.js';
import type { Clock } from '../core/clock.js';
import type { IdSource } from '../core/ids.js';

/**
 * CHANGE, IMPACT AND RE-ENTRY.
 *
 * SPEC: §34, SC-POL-013, SC-WF-009.
 *
 * The failure this exists to prevent is the quiet one: the owner asks for something small,
 * somebody edits a requirement, and eleven other things that depended on it are now wrong
 * and nobody re-checked them. A change does not edit canon. It produces an assessment of
 * what it touches, and re-entry re-derives the affected work THROUGH THE SAME GOVERNANCE
 * that produced it the first time — same departments, same gates, same runner.
 *
 * Three rules make that mechanical rather than aspirational:
 *
 *   1. every mandated dimension must be assessed. UNKNOWN is not in the enum, and an
 *      unassessed dimension is an unfinished analysis, not a finding.
 *   2. re-entry is by STAGE, and re-entering invalidates that stage and everything after
 *      it. You cannot re-run architecture and keep the design that was derived from the
 *      old one.
 *   3. a change that has been raised and not carried through BLOCKS readiness. Otherwise
 *      the handover describes a product the owner has already changed their mind about.
 *
 * Nothing here calls a model. What a change affects is a judgement, and it arrives from
 * the assessing department as data; what that judgement OBLIGES is arithmetic over the
 * lifecycle, and arithmetic is Serva's.
 */

/**
 * Which stage owns each impact dimension.
 *
 * This is what turns "the analysis says UX is affected" into "stage 024 runs again". It
 * is a lookup rather than a judgement on purpose: the alternative is asking a model which
 * stages to re-run, and a model asked that question will answer helpfully rather than
 * consistently.
 *
 * IMPLEMENTATION is deliberately empty here — it is downstream of Phase 5, and Phase 4
 * decides for itself what a changed specification means for code.
 */
const DIMENSION_STAGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  PRODUCT_SCOPE: ['SC-STAGE-004'],
  BUSINESS_RULES: ['SC-STAGE-010'],
  REQUIREMENTS: ['SC-STAGE-011'],
  MARKET_POSITION: ['SC-STAGE-013'],
  EXISTING_EVIDENCE: ['SC-STAGE-013'],
  COST: ['SC-STAGE-015'],
  ARCHITECTURE: ['SC-STAGE-020', 'SC-STAGE-023'],
  DATA: ['SC-STAGE-021'],
  SECURITY: ['SC-STAGE-022'],
  UX: ['SC-STAGE-024'],
  DESIGN_SYSTEM: ['SC-STAGE-025'],
  ADMIN_OPERABILITY: ['SC-STAGE-026'],
  TESTS: ['SC-STAGE-030'],
  IMPLEMENTATION: [],
});

/**
 * Stages Serva re-derives whenever anything re-runs at all.
 *
 * Risk is computed from persisted canon rather than reasoned about, so re-deriving it
 * costs nothing and NOT re-deriving it leaves a risk register describing a product that
 * has since changed — which is worse than having no register, because it looks current.
 */
const ALWAYS_REDERIVE: readonly string[] = Object.freeze(['SC-STAGE-016']);

/** Verdicts that count as a gate accepting. A qualification is still an acceptance. */
const ACCEPTING: readonly string[] = Object.freeze([
  GateVerdict.PASS,
  GateVerdict.PASS_WITH_QUALIFICATION,
]);

export interface ChangeDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdSource;
  /** The registered departments, for resolving which belong to a re-entered stage. */
  readonly departments?: readonly { readonly id: string; readonly stageId: string }[];
}

/**
 * Which department ids belong to these stages.
 *
 * Read from the registered configuration rather than from a naming convention: a
 * department id that happens to contain a stage number is a coincidence, and re-entry
 * clearing the wrong departments would either repeat work nobody asked for or skip work
 * somebody did.
 */
function departmentsOfStages(deps: ChangeDeps, stages: ReadonlySet<string>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const d of deps.departments ?? UPSTREAM_DEPARTMENTS) {
    if (stages.has(d.stageId)) ids.add(d.id);
  }
  return ids;
}

/** Raise a change. Recording it is not approving it, and it is not scope. */
export function raiseChangeRequest(
  deps: ChangeDeps,
  o: {
    readonly origin: string;
    readonly description: string;
    readonly magnitude: ChangeRequest['magnitude'];
  },
): ChangeRequest {
  const at = deps.clock.now();
  const cr = ChangeRequestSchema.parse({
    id: deps.ids.next('SC-CR'),
    createdAt: at,
    origin: o.origin,
    description: o.description,
    magnitude: o.magnitude,
    state: 'RAISED',
    meta: {
      provenance: { marking: 'OWNER_STATED', verbatim: o.description, statedAt: at },
      attribution: { at },
    },
  });
  const tx = deps.store.begin();
  try {
    repository(deps.store, ARTIFACT_TYPES.CHANGE_REQUEST, ChangeRequestSchema).put(tx, cr);
    audit(tx, {
      action: AuditAction.ARTIFACT_RECORDED,
      subject: cr.id,
      outcome: 'OK',
      detail: { magnitude: o.magnitude, origin: o.origin },
    });
    tx.commit();
  } catch (e) {
    tx.rollback();
    throw e;
  }
  return cr;
}

export interface ImpactInput {
  readonly changeRequestId: string;
  readonly dimensions: readonly {
    readonly dimension: string;
    readonly verdict: 'AFFECTED' | 'NOT_AFFECTED';
    readonly rationale: string;
    readonly affectedRefs?: readonly { readonly id: string; readonly version?: number }[];
  }[];
  readonly reentryStageId: string;
  readonly assessedBy: string;
}

/**
 * Record an impact analysis, refusing an incomplete one.
 *
 * The refusals are all about the same thing: an analysis that LOOKS complete because the
 * dimensions it skipped are simply not mentioned. A missing dimension, a re-entry stage
 * that is not a real stage, and an affected reference to canon that does not exist are
 * each a way for a change to be waved through without anybody noticing it was.
 */
export function analyseImpact(deps: ChangeDeps, input: ImpactInput): ImpactAnalysis {
  const crRepo = repository(deps.store, ARTIFACT_TYPES.CHANGE_REQUEST, ChangeRequestSchema);
  const cr = crRepo.get(input.changeRequestId);
  if (cr === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'No change request ' + input.changeRequestId + ' exists',
      remedy: 'Raise the change before analysing it.',
      specRef: '§34',
    });
  }

  const at = deps.clock.now();
  const draft = ImpactAnalysisSchema.parse({
    id: deps.ids.next('SC-IA'),
    createdAt: at,
    changeRequestRef: { id: cr.id, version: cr.version },
    magnitude: cr.magnitude,
    dimensions: input.dimensions.map((d) => ({
      dimension: d.dimension,
      verdict: d.verdict,
      rationale: d.rationale,
      affectedRefs: [...(d.affectedRefs ?? [])],
    })),
    reentryStageId: input.reentryStageId,
    meta: {
      provenance: {
        marking: 'DERIVED',
        from: [cr.id],
        rationale: 'assessed against every dimension SC-POL-013 mandates',
      },
      attribution: { at, agentId: input.assessedBy },
    },
  });

  const unassessed = unassessedDimensions(draft);
  if (unassessed.length > 0) {
    return fail({
      code: 'E_VALIDATION',
      message: 'The impact analysis did not assess: ' + unassessed.join(', '),
      remedy:
        'SC-POL-013 mandates every dimension. A dimension nobody looked at is not NOT_AFFECTED — it is unknown, and unknown is not an outcome a change may proceed on.',
      details: { assessed: draft.dimensions.map((d) => d.dimension), unassessed },
      specRef: 'SC-POL-013',
    });
  }

  const catalogue = getCatalogues().stages;
  const stage = catalogue.find((s) => s.id === draft.reentryStageId);
  if (stage === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Re-entry stage ' + draft.reentryStageId + ' is not a canonical stage',
      remedy:
        'Stages are canonical in 03. Re-entry picks one of them; it does not get to name a new one.',
      specRef: '03 §4',
    });
  }

  /*
   * The re-entry stage is the EARLIEST stage that must run again. An analysis naming an
   * affected dimension that lives before it is contradicting itself, and the contradiction
   * matters: whichever half is wrong, some affected canon would never be re-derived.
   */
  const order = catalogue.map((s) => s.id);
  const reentryIndex = order.indexOf(draft.reentryStageId);
  const tooEarly = draft.dimensions
    .filter((d) => d.verdict === 'AFFECTED')
    .flatMap((d) => (DIMENSION_STAGES[d.dimension] ?? []).map((sid) => ({ d: d.dimension, sid })))
    .filter(({ sid }) => {
      const i = order.indexOf(sid);
      return i >= 0 && i < reentryIndex;
    });
  if (tooEarly.length > 0) {
    return fail({
      code: 'E_VALIDATION',
      message:
        'The analysis re-enters at ' +
        draft.reentryStageId +
        ' but says these earlier stages are affected: ' +
        tooEarly.map((t) => t.d + ' (' + t.sid + ')').join(', '),
      remedy:
        'Re-enter at the earliest affected stage, or record those dimensions as NOT_AFFECTED. As written, canon the change touches would never be re-derived.',
      details: { reentryStageId: draft.reentryStageId, tooEarly },
      specRef: '§34',
    });
  }

  const missing: string[] = [];
  for (const d of draft.dimensions) {
    for (const ref of d.affectedRefs) {
      if (!canonExists(deps.store, ref.id)) missing.push(d.dimension + ':' + ref.id);
    }
  }
  if (missing.length > 0) {
    return fail({
      code: 'E_VALIDATION',
      message:
        'The analysis says the change affects canon that does not exist: ' + missing.join(', '),
      remedy:
        'An affected reference must point at something real. A reference to nothing cannot be re-derived, so it would be dropped from the re-entry without anybody being told.',
      details: { missing },
      specRef: '§34',
    });
  }

  const tx = deps.store.begin();
  try {
    repository(deps.store, ARTIFACT_TYPES.IMPACT_ANALYSIS, ImpactAnalysisSchema).put(tx, draft);
    crRepo.put(tx, {
      ...cr,
      state: 'ANALYSED',
      impactAnalysisRef: { id: draft.id, version: draft.version },
    });
    audit(tx, {
      action: AuditAction.ARTIFACT_RECORDED,
      subject: draft.id,
      outcome: 'OK',
      detail: {
        changeRequest: cr.id,
        reentryStageId: draft.reentryStageId,
        affected: draft.dimensions.filter((d) => d.verdict === 'AFFECTED').map((d) => d.dimension),
      },
    });
    tx.commit();
  } catch (e) {
    tx.rollback();
    throw e;
  }
  return draft;
}

/**
 * Raise the approval question for a change. The ONLY way to mint change consent.
 *
 * Serva writes it, so the purpose, the target and the dispositions are Serva's rather than
 * anybody else's. A department cannot construct one of these, and an owner answering some
 * other question cannot accidentally produce one.
 */
export function requestChangeApproval(
  deps: ChangeDeps,
  o: { readonly changeRequestId: string; readonly workItemId?: string },
): OwnerDecisionRequest {
  const cr = repository(deps.store, ARTIFACT_TYPES.CHANGE_REQUEST, ChangeRequestSchema).get(
    o.changeRequestId,
  );
  if (cr === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'No change request ' + o.changeRequestId + ' exists',
      remedy: 'Raise and analyse the change before asking the owner to approve it.',
      specRef: '§34',
    });
  }
  if (cr.state !== 'ANALYSED') {
    return fail({
      code: 'E_VALIDATION',
      message: 'Change ' + cr.id + ' is ' + cr.state + ', not ANALYSED',
      remedy:
        'Ask the owner to approve a change whose impact is known. Approving an unassessed change asks them to consent to an unknown quantity.',
      specRef: '§34',
    });
  }

  const at = deps.clock.now();
  const request = OwnerDecisionRequestSchema.parse({
    id: deps.ids.next('SC-ODR'),
    createdAt: at,
    question: 'Do you approve this ' + cr.magnitude + ' change? "' + cr.description + '"',
    whyServaCannotDecide:
      'A ' +
      cr.magnitude +
      ' change alters what the product IS. Serva can tell you what it would cost and what it would invalidate; it cannot decide that you want it.',
    purpose: DecisionPurpose.CHANGE_APPROVAL,
    targetRef: { id: cr.id, version: cr.version },
    supportingRefs: cr.impactAnalysisRef === undefined ? [] : [cr.impactAnalysisRef],
    options: [
      {
        option: 'Approve the change',
        impact: 'the affected stages run again and their gates re-evaluate current evidence',
        disposition: OptionDisposition.APPROVE,
      },
      {
        option: 'Reject the change',
        impact: 'nothing is re-run and the product stays as specified',
        disposition: OptionDisposition.REJECT,
      },
      {
        option: 'Defer the change',
        impact: 'the request stays on record and continues to block the handover',
        disposition: OptionDisposition.DEFER,
      },
    ],
    recommendation: 'Approve the change',
    recommendationRationale:
      'You asked for it. This asks you to confirm the cost now that Serva has assessed it.',
    blocksWork: true,
    blockedRefs: [{ id: cr.id }],
    state: 'OPEN',
    meta: {
      provenance: { marking: 'SYSTEM', component: 'change-approval' },
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
      detail: { purpose: DecisionPurpose.CHANGE_APPROVAL, changeRequest: cr.id },
    });
    tx.commit();
  } catch (e) {
    tx.rollback();
    throw e;
  }
  return request;
}

/**
 * Approve a change. M3 and M4 need the owner, and nothing may stand in for them.
 *
 * The owner decision is looked up rather than asserted, and must be ANSWERED by somebody
 * who is not an agent — the same rule the orchestrator applies, applied again here because
 * this is a second door into the same authority and a second door is how the first one
 * stops mattering.
 */
export function approveChange(
  deps: ChangeDeps,
  o: { readonly changeRequestId: string; readonly ownerDecisionId?: string },
): ChangeRequest {
  const crRepo = repository(deps.store, ARTIFACT_TYPES.CHANGE_REQUEST, ChangeRequestSchema);
  const cr = crRepo.get(o.changeRequestId);
  if (cr === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'No change request ' + o.changeRequestId + ' exists',
      remedy: 'Raise it first.',
      specRef: '§34',
    });
  }
  if (cr.state !== 'ANALYSED') {
    return fail({
      code: 'E_VALIDATION',
      message: 'Change ' + cr.id + ' is ' + cr.state + ', not ANALYSED',
      remedy:
        'Approving a change nobody has assessed approves an unknown quantity. Run the impact analysis first.',
      specRef: '§34',
    });
  }

  const needsOwner = cr.magnitude === 'M3' || cr.magnitude === 'M4';
  if (needsOwner) {
    if (o.ownerDecisionId === undefined) {
      return fail({
        code: 'E_GATE_AUTHORITY',
        message: 'A ' + cr.magnitude + ' change requires an owner decision',
        remedy:
          'M3 and M4 changes alter what the product IS. That is the owner’s call, and Serva has no way to make it on their behalf.',
        specRef: 'SC-POL-013',
      });
    }
    /*
     * PURPOSE-BOUND, OR IT IS NOT AN APPROVAL.
     *
     * The previous rule was "any ANSWERED decision not answered by an agent", and it was
     * wrong in three separate ways at once. An owner decision raised months earlier about
     * something else satisfied it. A decision raised merely to unblock a stalled
     * department satisfied it. And a decision on which the owner had chosen "No" satisfied
     * it, because nothing read which option they picked.
     *
     * `approvalRefusal` requires all of: the decision was raised AS a change approval, it
     * names THIS change, the recorded answer is one of the options actually offered, and
     * that option's disposition is APPROVE. Consent is a statement about one named
     * artifact, and it cannot be borrowed by another.
     */
    const decision = repository(
      deps.store,
      ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
      OwnerDecisionRequestSchema,
    ).get(o.ownerDecisionId);

    const refusal = approvalRefusal(decision, {
      purpose: DecisionPurpose.CHANGE_APPROVAL,
      targetId: cr.id,
    });
    if (refusal !== undefined) {
      return fail({
        code: 'E_GATE_AUTHORITY',
        message: 'Refusing to approve ' + cr.id + ': ' + refusal,
        remedy:
          'Raise the approval question with requestChangeApproval and have the owner answer it. An approval borrowed from another question is not consent to this one.',
        details: { changeRequestId: cr.id, ownerDecisionId: o.ownerDecisionId },
        specRef: '§32',
      });
    }
  }

  const next: ChangeRequest = { ...cr, state: 'APPROVED' };
  const tx = deps.store.begin();
  try {
    crRepo.put(tx, next);
    audit(tx, {
      action: AuditAction.ARTIFACT_RECORDED,
      subject: cr.id,
      outcome: 'OK',
      detail: { state: 'APPROVED', ownerDecision: o.ownerDecisionId ?? null },
    });
    tx.commit();
  } catch (e) {
    tx.rollback();
    throw e;
  }
  return next;
}

export interface ReentryPlan {
  readonly changeRequestId: string;
  readonly reentryStageId: string;
  /** Upstream stages that must run again, in lifecycle order. */
  readonly stagesToRerun: readonly string[];
  /** Canon the analysis says this change affects. */
  readonly affectedRefs: readonly string[];
  /** Stages that stand, so a reader can see that the delta really is a delta. */
  readonly stagesRetained: readonly string[];
}

/**
 * What re-entry obliges, computed from the lifecycle.
 *
 * Everything from the re-entry stage onward runs again. Not because every later stage is
 * necessarily wrong, but because each was derived from the one before it: keeping a design
 * that was justified by an architecture we are about to change is how a company ends up
 * with canon that agrees with nothing.
 */
export function planReentry(
  store: Store,
  o: { readonly changeRequestId: string; readonly profileId: string },
): ReentryPlan {
  const cr = repository(store, ARTIFACT_TYPES.CHANGE_REQUEST, ChangeRequestSchema).get(
    o.changeRequestId,
  );
  if (cr === undefined || cr.impactAnalysisRef === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Change ' + o.changeRequestId + ' has no impact analysis',
      remedy:
        'Analyse the change before planning re-entry. The analysis is what says where to re-enter.',
      specRef: '§34',
    });
  }
  const analysis = repository(store, ARTIFACT_TYPES.IMPACT_ANALYSIS, ImpactAnalysisSchema).get(
    cr.impactAnalysisRef.id,
  );
  if (analysis === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Impact analysis ' + cr.impactAnalysisRef.id + ' is missing from the store',
      remedy: 'Canon does not disappear. This store is inconsistent and should be verified.',
      specRef: '§34',
    });
  }

  const plan = resolveApplicability(o.profileId);
  const order = plan.upstreamToRun.map((s) => s.stageId);
  const from = order.indexOf(analysis.reentryStageId);

  /*
   * A DELTA, not a suffix.
   *
   * The tempting rule is "everything from here onward", and it is wrong in the direction
   * that costs the client money: a requirements change would re-run market research,
   * which does not depend on requirements at all. What re-runs is the re-entry stage
   * itself, plus the later stages the analysis actually marked AFFECTED, plus the stages
   * Serva computes rather than reasons about.
   *
   * The cost of being wrong the other way — a stage that should have re-run and did not —
   * is contained by the validation above: an affected dimension may not name a stage
   * earlier than the re-entry point, so nothing affected can fall through the gap.
   */
  const affectedStages = new Set(
    analysis.dimensions
      .filter((d) => d.verdict === 'AFFECTED')
      .flatMap((d) => DIMENSION_STAGES[d.dimension] ?? []),
  );
  const rerun = (stageId: string, index: number): boolean =>
    from >= 0 &&
    index >= from &&
    (stageId === analysis.reentryStageId ||
      affectedStages.has(stageId) ||
      ALWAYS_REDERIVE.includes(stageId));

  const stagesToRerun = order.filter((s, i) => rerun(s, i));
  const stagesRetained = order.filter((s, i) => !rerun(s, i));

  return {
    changeRequestId: cr.id,
    reentryStageId: analysis.reentryStageId,
    stagesToRerun,
    stagesRetained,
    affectedRefs: analysis.dimensions.flatMap((d) => d.affectedRefs.map((r) => r.id)),
  };
}

/**
 * Re-open the orchestrator at the re-entry stage.
 *
 * Idempotent, because the operation is "these stages are no longer complete" rather than
 * "undo one step". Applying the same approved change twice leaves the record in the same
 * shape: the second application has nothing left to remove.
 *
 * The gate results for re-run stages are dropped too. A gate verdict is a statement about
 * evidence that existed when it was evaluated; keeping it would let a change sail past a
 * gate on the strength of the very artifacts it just invalidated.
 */
export function applyReentry(
  deps: ChangeDeps,
  o: { readonly workItemId: string; readonly changeRequestId: string },
): ReentryPlan {
  const record = readOrchestratorRecord(deps.store, o.workItemId);
  if (record === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'No intelligence run exists for ' + o.workItemId,
      remedy: 'There is nothing to re-enter. Run the company first.',
      specRef: '§34',
    });
  }
  const plan = planReentry(deps.store, {
    changeRequestId: o.changeRequestId,
    profileId: record.profileId,
  });
  const rerun = new Set(plan.stagesToRerun);

  const gatesOfRerun = new Set(
    resolveApplicability(record.profileId)
      .upstreamToRun.filter((s) => rerun.has(s.stageId))
      .flatMap((s) => (s.gate === undefined ? [] : [s.gate])),
  );

  const alreadyDone = record.completedStages.filter((s) => rerun.has(s));

  const tx = deps.store.begin();
  try {
    /*
     * The re-entry is RECORDED on the change, not merely performed.
     *
     * Without this, `completeChange` had nothing to check and accepted the word
     * IMPLEMENTED on trust — so approve-then-complete removed the readiness block while
     * every stale artifact the change invalidated was still standing. The obligation has
     * to be durable, because the process that applied it will not be the process that
     * later asks whether it happened.
     */
    repository(deps.store, ARTIFACT_TYPES.CHANGE_REQUEST, ChangeRequestSchema).put(tx, {
      ...(repository(deps.store, ARTIFACT_TYPES.CHANGE_REQUEST, ChangeRequestSchema).get(
        o.changeRequestId,
      ) as ChangeRequest),
      reentry: {
        workItemId: o.workItemId,
        appliedAt: deps.clock.now(),
        reentryStageId: plan.reentryStageId,
        stagesToRerun: [...plan.stagesToRerun],
        gatesInvalidated: [...gatesOfRerun],
      },
    });

    writeOrchestratorRecord(tx, {
      ...record,
      state: 'RUNNING',
      completedStages: record.completedStages.filter((s) => !rerun.has(s)),
      ranStages: record.ranStages.filter((s) => !rerun.has(s)),
      /*
       * The per-department progress for the re-run stages goes too. Leaving it would make
       * the resume skip exactly the departments the re-entry exists to repeat.
       */
      completedDepartments: record.completedDepartments.filter(
        (id) => !departmentsOfStages(deps, rerun).has(id),
      ),
      gateResults: record.gateResults.filter((g) => !gatesOfRerun.has(g.gateId)),
      pendingOwnerDecisions: [],
      updatedAt: deps.clock.now(),
    });
    /*
     * Only stages that had actually completed are abandoned. A second application would
     * otherwise write a ledger entry claiming to abandon work that was already abandoned,
     * and the ledger would grow a step every time somebody re-ran the same command.
     */
    for (const stageId of alreadyDone) {
      appendLedgerEntry(
        tx,
        { ids: deps.ids, clock: deps.clock, actor: 'SC-INTELLIGENCE' },
        {
          workItemId: o.workItemId,
          stageId,
          profileRef: record.profileId,
          disposition: StageLedgerDisposition.ABANDONED,
          attempt: 1,
          reason:
            'superseded by change ' +
            plan.changeRequestId +
            ', which re-enters the lifecycle at ' +
            plan.reentryStageId,
        },
      );
    }
    audit(tx, {
      action: AuditAction.ARTIFACT_RECORDED,
      subject: plan.changeRequestId,
      outcome: 'OK',
      detail: { reentryStageId: plan.reentryStageId, stagesToRerun: plan.stagesToRerun },
    });
    tx.commit();
  } catch (e) {
    tx.rollback();
    throw e;
  }
  return plan;
}

/**
 * Why this change has not been carried through, or undefined if it has.
 *
 * DERIVED, and the whole reason `completeChange` cannot be told. Previously it required
 * only `state === APPROVED` and wrote IMPLEMENTED — so approving a change and immediately
 * completing it removed the readiness block while every artifact the change invalidated
 * was still standing, unrewritten and now unguarded.
 *
 * Each clause is a fact about persisted state:
 *
 *   re-entry was applied, to the work item it names
 *   every stage the plan said to re-run has completed again since
 *   every gate the re-entry invalidated has been re-evaluated and accepts
 *
 * The third is the one that matters most. Re-running a stage produces new artifacts; the
 * gate is what says the new ones are acceptable. A change that re-ran its stages and
 * failed their gates has not been carried through — it has been attempted.
 */
export function completionRefusal(store: Store, changeRequestId: string): string | undefined {
  const cr = repository(store, ARTIFACT_TYPES.CHANGE_REQUEST, ChangeRequestSchema).get(
    changeRequestId,
  );
  if (cr === undefined) return 'no change request ' + changeRequestId + ' exists';
  if (cr.state !== 'APPROVED') return 'change ' + cr.id + ' is ' + cr.state + ', not APPROVED';

  const reentry = cr.reentry;
  if (reentry === undefined) {
    return (
      'change ' +
      cr.id +
      ' was approved but re-entry was never applied: nothing has been re-derived, so the canon it invalidates is still standing'
    );
  }

  const record = readOrchestratorRecord(store, reentry.workItemId);
  if (record === undefined) {
    return 'the intelligence run for ' + reentry.workItemId + ' no longer exists';
  }

  const completed = new Set(record.completedStages);
  const outstanding = reentry.stagesToRerun.filter((stage) => !completed.has(stage));
  if (outstanding.length > 0) {
    return (
      'change ' +
      cr.id +
      ' re-entered at ' +
      reentry.reentryStageId +
      ', and these stages have not completed again: ' +
      outstanding.join(', ')
    );
  }

  const accepting = new Set(
    record.gateResults.filter((g) => ACCEPTING.includes(g.verdict)).map((g) => g.gateId),
  );
  const unaccepted = reentry.gatesInvalidated.filter((gate) => !accepting.has(gate));
  if (unaccepted.length > 0) {
    return (
      'change ' +
      cr.id +
      ' re-ran its stages, but these gates have not accepted the new evidence: ' +
      unaccepted.join(', ')
    );
  }
  return undefined;
}

/**
 * Mark a change carried through. Only then does it stop blocking readiness.
 *
 * There is no argument for "it is done". The obligations are read from the Store.
 */
export function completeChange(deps: ChangeDeps, changeRequestId: string): ChangeRequest {
  const repo = repository(deps.store, ARTIFACT_TYPES.CHANGE_REQUEST, ChangeRequestSchema);
  const refusal = completionRefusal(deps.store, changeRequestId);
  if (refusal !== undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Refusing to record ' + changeRequestId + ' as carried through: ' + refusal,
      remedy:
        'Apply the re-entry, let the affected stages run again, and let their gates accept the new evidence. Marking it done without that removes the readiness block while the stale canon stands.',
      details: { changeRequestId },
      specRef: '§34',
    });
  }
  const cr = repo.get(changeRequestId) as ChangeRequest;
  const next: ChangeRequest = { ...cr, state: 'IMPLEMENTED' };
  const tx = deps.store.begin();
  try {
    repo.put(tx, next);
    tx.commit();
  } catch (e) {
    tx.rollback();
    throw e;
  }
  return next;
}

/** Changes raised and not yet carried through or rejected. Readiness blocks on these. */
export function outstandingChanges(store: Store): readonly ChangeRequest[] {
  return repository(store, ARTIFACT_TYPES.CHANGE_REQUEST, ChangeRequestSchema)
    .list()
    .filter((c) => c.state === 'RAISED' || c.state === 'ANALYSED' || c.state === 'APPROVED');
}

export { IMPACT_DIMENSIONS };
