import { z } from 'zod';
import { GateVerdict, StageLedgerDisposition } from '../../vocab/index.js';
import { fail } from '../../core/errors.js';
import { AuditAction, audit } from '../../events/audit.js';
import { appendLedgerEntry } from '../../lifecycle/stages.js';
import { getCatalogues } from '../../catalogue/index.js';
import { resolveApplicability } from '../applicability.js';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import { OwnerDecisionRequestSchema, ownerDecisionRefusal } from '../artifacts/governance.js';
import { runDepartment } from './runner.js';
import { DepartmentOutcome } from './types.js';
import type { DepartmentConfig, DepartmentContext, DepartmentResult, RunnerDeps } from './types.js';
import type { ApplicabilityPlan, StageApplicability } from '../applicability.js';
import type { GatewayDeps } from '../research/gateway.js';
import type { Store, Transaction } from '../../store/store.js';

/**
 * THE INTELLIGENCE ORCHESTRATOR.
 *
 * SPEC: 04, 03, §4, §31, §32.
 *
 * Deterministic about governance; a model decides only CONTENT.
 *
 * Specifically, nothing below is delegated to reasoning: which profile applies, which
 * stages that profile selects, what order they run in, which department owns a stage,
 * whether its prerequisites exist, whether a gate passed, and whether an owner decision
 * blocks progress. The alternative — handing the whole project to a model and asking
 * "what should we do next" — produces a system that is agreeable rather than governed,
 * and that quietly skips whichever stage it finds least interesting.
 *
 * `WAITING_FOR_OWNER` is a real control state, not an exception. Business analysis, cost
 * and product validation can all legitimately reach a question that is not Serva's to
 * answer, and the honest response is to persist exactly where we are, stop, and resume
 * later from the Store — with no dependence on a conversation that no longer exists.
 */

export const OrchestratorState = {
  NOT_STARTED: 'NOT_STARTED',
  RUNNING: 'RUNNING',
  /** Stopped on an owner decision. Resumable, and only by a real owner answer. */
  WAITING_FOR_OWNER: 'WAITING_FOR_OWNER',
  /** A gate refused, or a department failed. Downstream stages do not run. */
  BLOCKED: 'BLOCKED',
  COMPLETE: 'COMPLETE',
} as const;
export type OrchestratorState = (typeof OrchestratorState)[keyof typeof OrchestratorState];

export const ORCHESTRATOR_STATE_TYPE = 'intel.orchestratorState';

/**
 * Everything needed to resume, and nothing that would need a session to interpret.
 *
 * SPEC: §39 — project truth comes from the Store, never from Claude session memory. This
 * record is the whole of the orchestrator's memory; if it is insufficient to resume, the
 * design is wrong, not the operator.
 */
export const OrchestratorRecordSchema = z
  .object({
    workItemId: z.string().min(1),
    profileId: z.string().min(1),
    state: z.enum([
      OrchestratorState.NOT_STARTED,
      OrchestratorState.RUNNING,
      OrchestratorState.WAITING_FOR_OWNER,
      OrchestratorState.BLOCKED,
      OrchestratorState.COMPLETE,
    ]),
    /** Stages fully finished — departments ran AND the gate accepted. */
    completedStages: z.array(z.string().min(1)).default([]),
    /**
     * Stages whose departments have run but whose gate has not yet accepted.
     *
     * The distinction exists because of the owner pause. When a department completes and
     * raises a decision, its artifacts are already written; resuming must continue from
     * the gate, not re-run the department and write them twice.
     */
    ranStages: z.array(z.string().min(1)).default([]),
    /** The stage that stopped us, when we stopped. */
    haltedAtStage: z.string().min(1).optional(),
    /** Open owner decisions blocking the halted stage. */
    pendingOwnerDecisions: z.array(z.string().min(1)).default([]),
    blockedReason: z.string().min(1).optional(),
    gateResults: z
      .array(z.object({ gateId: z.string().min(1), verdict: z.string().min(1) }).strict())
      .default([]),
    updatedAt: z.string().min(1),
  })
  .strict();
export type OrchestratorRecord = z.output<typeof OrchestratorRecordSchema>;

/** One department's judgement on a gate criterion, with the actor that made it. */
export interface CriterionJudgement {
  readonly criterionRef: string;
  readonly met: boolean;
  readonly by: string;
  readonly note: string;
}

/** A gate evaluation, injected so the orchestrator does not own gate mechanics. */
export interface GateEvaluator {
  evaluate(o: {
    readonly gateId: string;
    readonly workItemId: string;
    readonly stageId: string;
    readonly judgements?: ReadonlyMap<string, CriterionJudgement>;
  }): Promise<{ readonly verdict: GateVerdict; readonly reasons: readonly string[] }>;
}

export interface OrchestratorDeps extends RunnerDeps {
  /** Departments, keyed by stage. A stage may have several, run in declared order. */
  readonly departments: readonly DepartmentConfig[];
  readonly gates?: GateEvaluator;
  readonly gateway?: GatewayDeps;
}

export interface AdvanceResult {
  readonly state: OrchestratorState;
  readonly record: OrchestratorRecord;
  readonly ran: readonly DepartmentResult[];
  readonly reason?: string;
}

/**
 * Does this gate fire after this stage?
 *
 * `afterStage` is not always a single number. SC-GATE-REQUIREMENTS declares `010 + 011`,
 * because it governs business analysis AND requirements — and it must fire after the LAST
 * of them. Firing after 010 would evaluate requirements that stage 011 has not produced
 * yet, which is NOT_VERIFIED: correct, and useless, because the evidence was never going
 * to be there.
 */
function gateFiresAfter(gateId: string, stageId: string): boolean {
  const def = getCatalogues().gate(gateId);
  if (def === undefined) return false;
  const stages = (def.afterStage.match(/\d{3}/g) ?? []).map((n) => 'SC-STAGE-' + n);
  if (stages.length === 0) return false;
  return stages[stages.length - 1] === stageId;
}

/** Verdicts that permit the lifecycle to continue past a gate. */
const PASSING: readonly GateVerdict[] = Object.freeze([
  GateVerdict.PASS,
  GateVerdict.PASS_WITH_QUALIFICATION,
]);

export class IntelligenceOrchestrator {
  private readonly plan: ApplicabilityPlan;
  /** Judgements collected this cycle, keyed by criterion. */
  private readonly judgements = new Map<string, CriterionJudgement>();

  constructor(
    private readonly deps: OrchestratorDeps,
    private readonly workItemId: string,
    profileId: string,
    skip?: Readonly<Record<string, string>>,
  ) {
    this.plan = resolveApplicability(profileId, skip === undefined ? {} : { skip });
  }

  get applicability(): ApplicabilityPlan {
    return this.plan;
  }

  /** The persisted control record, or a fresh one. */
  read(): OrchestratorRecord {
    const env = this.deps.store.getCanon<unknown>(ORCHESTRATOR_STATE_TYPE, this.workItemId);
    if (env === undefined) {
      return {
        workItemId: this.workItemId,
        profileId: this.plan.profileId,
        state: OrchestratorState.NOT_STARTED,
        completedStages: [],
        ranStages: [],
        pendingOwnerDecisions: [],
        gateResults: [],
        updatedAt: this.deps.clock.now(),
      };
    }
    const parsed = OrchestratorRecordSchema.safeParse(env.body);
    if (!parsed.success) {
      return fail({
        code: 'E_VALIDATION',
        message: 'The persisted orchestrator state for ' + this.workItemId + ' is unreadable',
        remedy:
          'Serva resumes from the Store, so an unreadable control record is a hard stop rather than a reason to start again and duplicate work.',
        details: { workItemId: this.workItemId },
        specRef: '04 §5',
      });
    }
    return parsed.data;
  }

  private write(record: OrchestratorRecord): OrchestratorRecord {
    const next = { ...record, updatedAt: this.deps.clock.now() };
    const tx = this.deps.store.begin();
    try {
      tx.putCanon(ORCHESTRATOR_STATE_TYPE, this.workItemId, next);
      tx.commit();
    } catch (e) {
      tx.rollback();
      throw e;
    }
    return next;
  }

  /**
   * Record every stage this profile will NOT run.
   *
   * Done once, up front, so the ledger describes the whole lifecycle rather than only the
   * parts that happened to execute. A reader can then see that Discovery was considered
   * and excluded by profile — which is a decision — instead of finding no mention of it.
   */
  recordApplicability(): void {
    const tx = this.deps.store.begin();
    try {
      const stageDeps = {
        ids: this.deps.ids,
        clock: this.deps.clock,
        actor: 'SC-AGENT-001',
      };
      for (const s of this.plan.stages) {
        if (s.disposition === StageLedgerDisposition.IN_PROGRESS) continue;
        appendLedgerEntry(tx, stageDeps, {
          workItemId: this.workItemId,
          stageId: s.stageId,
          profileRef: this.plan.profileId,
          disposition: s.disposition,
          reason: s.reason,
          attempt: 1,
        });
      }
      audit(tx, {
        action: AuditAction.REQUEST_CLASSIFIED,
        subject: this.workItemId,
        outcome: 'OK',
        detail: {
          profile: this.plan.profileId,
          upstreamStages: this.plan.upstreamToRun.map((s) => s.stageId),
        },
      });
      tx.commit();
    } catch (e) {
      tx.rollback();
      throw e;
    }
  }

  /** Departments owning a stage, in declaration order. */
  private departmentsFor(stageId: string): readonly DepartmentConfig[] {
    return this.deps.departments.filter((d) => d.stageId === stageId);
  }

  /**
   * Are the owner decisions that stopped us now genuinely answered?
   *
   * An agent-authored answer does not count, and `ownerDecisionRefusal` is what says so.
   * This is checked on RESUME rather than trusted from the caller, because the caller is
   * the part of the system most likely to be in a hurry.
   */
  private unresolvedOwnerDecisions(ids: readonly string[]): readonly string[] {
    const repo = repository(
      this.deps.store,
      ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
      OwnerDecisionRequestSchema,
    );
    const unresolved: string[] = [];
    for (const id of ids) {
      const d = repo.get(id);
      if (d === undefined) {
        unresolved.push(id + ' (not found)');
        continue;
      }
      if (d.state !== 'ANSWERED') {
        unresolved.push(id + ' (' + d.state + ')');
        continue;
      }
      const refusal = ownerDecisionRefusal(d);
      if (refusal !== undefined) unresolved.push(id + ': ' + refusal);
    }
    return unresolved;
  }

  /**
   * Evaluate the gate that guards a stage, or nothing when none does.
   *
   * Pulled out because it is now called from two places — after a stage completes, and
   * after a stage fails — and those two callers must not be able to drift into asking the
   * gate different questions.
   */
  private async evaluateGate(
    stage: StageApplicability,
  ): Promise<{ readonly verdict: GateVerdict; readonly reasons: readonly string[] } | undefined> {
    if (stage.gate === undefined || this.deps.gates === undefined) return undefined;
    if (!gateFiresAfter(stage.gate, stage.stageId)) return undefined;
    return await this.deps.gates.evaluate({
      gateId: stage.gate,
      workItemId: this.workItemId,
      stageId: stage.stageId,
      judgements: this.judgements,
    });
  }

  /**
   * Run the lifecycle forward until it completes, blocks, or needs the owner.
   *
   * Idempotent by construction: completed stages are skipped on re-entry, so calling this
   * after a resume continues rather than repeating. That is what makes "stop and come
   * back tomorrow" a supported operation instead of a way to spend the budget twice.
   */
  async advance(): Promise<AdvanceResult> {
    let record = this.read();
    const ran: DepartmentResult[] = [];

    if (record.state === OrchestratorState.NOT_STARTED) {
      this.recordApplicability();
    }

    /* --- resuming from an owner pause requires a real answer --- */
    if (record.state === OrchestratorState.WAITING_FOR_OWNER) {
      const unresolved = this.unresolvedOwnerDecisions(record.pendingOwnerDecisions);
      if (unresolved.length > 0) {
        return {
          state: OrchestratorState.WAITING_FOR_OWNER,
          record,
          ran,
          reason: 'still waiting on the owner: ' + unresolved.join('; '),
        };
      }
      record = { ...record, pendingOwnerDecisions: [] };
    }

    if (record.state === OrchestratorState.COMPLETE) {
      return { state: record.state, record, ran };
    }

    const completed = new Set(record.completedStages);
    const alreadyRan = new Set(record.ranStages);

    for (const stage of this.plan.upstreamToRun) {
      if (completed.has(stage.stageId)) continue;

      const configs = this.departmentsFor(stage.stageId);
      if (configs.length === 0) {
        /*
         * A selected stage with nobody to run it BLOCKS.
         *
         * The tempting alternative is to skip it and carry on, which would let a
         * lifecycle report COMPLETE while several stages the profile selected never ran.
         * That is precisely the "looks finished, was not" failure the ledger exists to
         * prevent — so an unwired stage is a visible stop with a reason naming it.
         */
        const reason =
          stage.name +
          ' is selected by ' +
          this.plan.profileId +
          ', and no department is wired to it in this build, so the lifecycle cannot honestly continue past it';
        const tx = this.deps.store.begin();
        try {
          appendLedgerEntry(
            tx,
            { ids: this.deps.ids, clock: this.deps.clock, actor: 'SC-AGENT-001' },
            {
              workItemId: this.workItemId,
              stageId: stage.stageId,
              profileRef: this.plan.profileId,
              disposition: StageLedgerDisposition.BLOCKED,
              reason,
              attempt: 1,
            },
          );
          tx.commit();
        } catch {
          tx.rollback();
        }
        record = this.write({
          ...record,
          state: OrchestratorState.BLOCKED,
          haltedAtStage: stage.stageId,
          blockedReason: reason,
          completedStages: [...completed],
          ranStages: [...alreadyRan],
        });
        return { state: OrchestratorState.BLOCKED, record, ran, reason };
      }

      /* ---------------------------------------------- the departments, once each */

      if (!alreadyRan.has(stage.stageId)) {
        const ctx: DepartmentContext = {
          workItemId: this.workItemId,
          store: this.deps.store,
          clock: this.deps.clock,
          ids: this.deps.ids,
          plan: this.plan,
          stage,
          ...(this.deps.gateway === undefined ? {} : { gateway: this.deps.gateway }),
        };

        const pending: string[] = [];
        for (const config of configs) {
          const result = await runDepartment(this.deps, config, ctx);
          ran.push(result);
          for (const j of result.judgements ?? []) this.judgements.set(j.criterionRef, j);

          if (result.outcome === DepartmentOutcome.OWNER_DECISION_REQUIRED) {
            pending.push(...result.ownerDecisionIds);
            continue;
          }
          if (result.outcome !== DepartmentOutcome.COMPLETED) {
            /*
             * The gate still runs.
             *
             * A department that could not produce its evidence has not made the gate
             * irrelevant — it has given the gate its answer. Recording NOT_VERIFIED is
             * strictly more useful than recording nothing: readiness blocks on a verdict
             * it can name, and the difference between "the evidence says no" and "there
             * was no evidence" survives into the report.
             *
             * The department's own reason is kept alongside it, because the gate verdict
             * says WHAT is missing and the department reason says WHY.
             */
            const departmentReason = result.reason ?? config.title + ' did not complete';
            const verdict = await this.evaluateGate(stage);
            const gateResults =
              verdict === undefined
                ? record.gateResults
                : [
                    ...record.gateResults.filter((g) => g.gateId !== stage.gate),
                    { gateId: stage.gate as string, verdict: verdict.verdict },
                  ];

            record = this.write({
              ...record,
              state: OrchestratorState.BLOCKED,
              haltedAtStage: stage.stageId,
              blockedReason:
                verdict === undefined
                  ? departmentReason
                  : stage.gate +
                    ' returned ' +
                    verdict.verdict +
                    ': ' +
                    departmentReason +
                    (verdict.reasons.length === 0 ? '' : ' — ' + verdict.reasons.join('; ')),
              gateResults,
              completedStages: [...completed],
              ranStages: [...alreadyRan],
            });
            return {
              state: OrchestratorState.BLOCKED,
              record,
              ran,
              ...(record.blockedReason === undefined ? {} : { reason: record.blockedReason }),
            };
          }
        }

        /*
         * Every department for this stage has now produced its artifacts, so the stage is
         * marked as RUN even when a decision is outstanding. Resuming continues at the
         * gate rather than re-running the departments and writing their canon twice.
         */
        alreadyRan.add(stage.stageId);

        if (pending.length > 0) {
          record = this.write({
            ...record,
            state: OrchestratorState.WAITING_FOR_OWNER,
            haltedAtStage: stage.stageId,
            pendingOwnerDecisions: pending,
            completedStages: [...completed],
            ranStages: [...alreadyRan],
          });
          return {
            state: OrchestratorState.WAITING_FOR_OWNER,
            record,
            ran,
            reason:
              'the lifecycle stopped at ' +
              stage.name +
              ' because ' +
              String(pending.length) +
              ' decision(s) are the owner\u2019s to make',
          };
        }
      }

      /* ------------------------------------- the gate that guards this stage */

      const gate = await this.evaluateGate(stage);
      if (stage.gate !== undefined && gate !== undefined) {
        const gateResults = [
          ...record.gateResults.filter((g) => g.gateId !== stage.gate),
          { gateId: stage.gate, verdict: gate.verdict },
        ];
        if (!PASSING.includes(gate.verdict)) {
          record = this.write({
            ...record,
            state: OrchestratorState.BLOCKED,
            haltedAtStage: stage.stageId,
            blockedReason:
              stage.gate + ' returned ' + gate.verdict + ': ' + gate.reasons.join('; '),
            gateResults,
            completedStages: [...completed],
            ranStages: [...alreadyRan],
          });
          return {
            state: OrchestratorState.BLOCKED,
            record,
            ran,
            ...(record.blockedReason === undefined ? {} : { reason: record.blockedReason }),
          };
        }
        record = { ...record, gateResults };
      }

      completed.add(stage.stageId);
      record = this.write({
        ...record,
        state: OrchestratorState.RUNNING,
        completedStages: [...completed],
        ranStages: [...alreadyRan],
      });
    }

    record = this.write({ ...record, state: OrchestratorState.COMPLETE });
    return { state: OrchestratorState.COMPLETE, record, ran };
  }
}

/**
 * Write the control record from outside the orchestrator.
 *
 * Exists for re-entry, which must be able to say "these stages are no longer complete"
 * without instantiating a whole orchestrator and its department list. It takes the
 * caller's transaction so the record change commits with the ledger entries that explain
 * it — a store that recorded one without the other would be a store nobody could read.
 */
export function writeOrchestratorRecord(tx: Transaction, record: OrchestratorRecord): void {
  tx.putCanon(ORCHESTRATOR_STATE_TYPE, record.workItemId, OrchestratorRecordSchema.parse(record));
}

/** Read the control record without constructing an orchestrator. Used by the CLI. */
export function readOrchestratorRecord(
  store: Store,
  workItemId: string,
): OrchestratorRecord | undefined {
  const env = store.getCanon<unknown>(ORCHESTRATOR_STATE_TYPE, workItemId);
  if (env === undefined) return undefined;
  const parsed = OrchestratorRecordSchema.safeParse(env.body);
  return parsed.success ? parsed.data : undefined;
}
