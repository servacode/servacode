import { RunOutcome, StageExecutionState, StageLedgerDisposition } from '../../vocab/index.js';
import { AuditAction, audit } from '../../events/audit.js';
import { appendLedgerEntry, startStage, transitionStage } from '../../lifecycle/stages.js';
import { assertResearchAuthority } from '../research/gateway.js';
import { resolveIntelligencePolicy } from '../research/capability.js';
import { parseToolSurface } from '../../agents/toolPolicy.js';
import { DepartmentOutcome } from './types.js';
import type {
  DepartmentConfig,
  DepartmentContext,
  DepartmentResult,
  PrepareResult,
  RunnerDeps,
} from './types.js';
import type { z } from 'zod';

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
       * transaction and the same ledger path as every other department.
       */
      computed = config.persist(dtx, undefined as never, ctx);
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
      canon: [...spec.canon, ...prepared.canon].map((c) => ({
        source: c.source,
        kind: c.kind,
        version: c.version,
        content: c.content,
        relevance: c.relevance,
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
    return {
      ...refuse(
        DepartmentOutcome.FAILED,
        config.title + ' run ended ' + run.outcome + '. NO OUTPUT = NOTHING RECORDED.',
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
    persisted = config.persist(tx, parsed.data as z.output<S>, ctx);
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
