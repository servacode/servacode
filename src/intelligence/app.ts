import { AgentRuntime } from '../agents/runtime.js';
import { ContractRegistry } from '../agents/registry.js';
import { ARTIFACT_TYPES, repository } from './repository.js';
import { IdeaSchema } from './artifacts/framing.js';
import { OwnerDecisionRequestSchema, answerRefusal } from './artifacts/governance.js';
import { IntelligenceOrchestrator } from './execution/orchestrator.js';
import { upstreamGateEvaluator } from './gates/evaluator.js';
import { intakeDepartment } from './departments/intake.js';
import { discoveryDepartment } from './departments/discovery.js';
import { productValidationDepartment } from './departments/product.js';
import { businessAnalysisDepartment } from './departments/business.js';
import {
  nfrDepartment,
  requirementsDepartment,
  requirementsVerifierDepartment,
} from './departments/requirements.js';
import { RESEARCH_CHAIN } from './departments/research.js';
import { ARCHITECTURE_DEPARTMENTS } from './departments/architecture.js';
import { DATA_SECURITY_DEPARTMENTS } from './departments/dataSecurity.js';
import { EXPERIENCE_DEPARTMENTS } from './departments/experience.js';
import { PLANNING_DEPARTMENTS } from './departments/planning.js';
import { LEARNING_DEPARTMENTS } from './departments/learning.js';
import { QUALITY_DEPARTMENTS } from './departments/quality.js';
import { RELEASE_DEPARTMENTS } from './departments/release.js';
import { INCIDENT_DEPARTMENTS } from './departments/incident.js';
import { PHASE5_ENABLED_AGENTS } from './enabled.js';
import { AuditAction, audit } from '../events/audit.js';
import { fail } from '../core/errors.js';
import { SourceMarking } from '../vocab/index.js';
import type { DepartmentConfig } from './execution/types.js';
import type { GatewayDeps } from './research/gateway.js';
import type { EngineAdapter } from '../engine/types.js';
import type { Store } from '../store/store.js';
import type { Clock } from '../core/clock.js';
import type { IdSource } from '../core/ids.js';

/**
 * WIRING THE COMPANY.
 *
 * SPEC: 04, 06.
 *
 * The department REGISTRY is a plain ordered list, and its order is the lifecycle order
 * within a stage. Requirements is the case that matters: 050 writes, 051 adds targets,
 * and 052 verifies — in that order, in three separate runs, because a verifier that ran
 * first would be verifying nothing.
 */

/** Every department Serva can currently run, in lifecycle order. */
export const UPSTREAM_DEPARTMENTS: readonly DepartmentConfig[] = Object.freeze([
  intakeDepartment as DepartmentConfig,
  discoveryDepartment as DepartmentConfig,
  productValidationDepartment as DepartmentConfig,
  businessAnalysisDepartment as DepartmentConfig,
  requirementsDepartment as DepartmentConfig,
  nfrDepartment as DepartmentConfig,
  requirementsVerifierDepartment as DepartmentConfig,
  /*
   * The research chain, in the order the separation requires: gather, verify, interpret,
   * then propose. Running the analyst before the verifier would let an unverified claim
   * become competitive truth, which is the one thing this ordering exists to prevent.
   */
  ...RESEARCH_CHAIN,
  /*
   * The design authority, in lifecycle order. Within a stage the order matters: the
   * author runs before its reviewer, and the UI designer runs after the system it must
   * compose from exists.
   */
  ...ARCHITECTURE_DEPARTMENTS,
  ...DATA_SECURITY_DEPARTMENTS,
  ...EXPERIENCE_DEPARTMENTS,
  ...PLANNING_DEPARTMENTS,
  /*
   * Learning sits at stage 053, which is phase G and therefore not in any upstream plan.
   * Registered anyway so the authority validation covers it: a department that is only
   * checked when it runs is a department nobody checks.
   */
  ...LEARNING_DEPARTMENTS,
]);

/**
 * The downstream company: quality, release, operations and incidents.
 *
 * Kept separate from `UPSTREAM_DEPARTMENTS` because the two answer different questions.
 * Upstream decides WHAT to build and stops at the engineering handoff; downstream judges
 * what was built and decides whether it may be delivered. An orchestrator run for a
 * profile's upstream plan must not accidentally schedule an acceptance verifier over a
 * product that does not exist yet.
 */
export const DOWNSTREAM_DEPARTMENTS: readonly DepartmentConfig[] = Object.freeze([
  ...QUALITY_DEPARTMENTS,
  ...RELEASE_DEPARTMENTS,
  ...INCIDENT_DEPARTMENTS,
]);

/**
 * Every department Serva has, upstream and downstream.
 *
 * The list coverage is computed from, and the list authority validation runs over — a
 * department that is only checked when it happens to run is a department nobody checks.
 */
export const ALL_DEPARTMENTS: readonly DepartmentConfig[] = Object.freeze([
  ...UPSTREAM_DEPARTMENTS,
  ...DOWNSTREAM_DEPARTMENTS,
]);

export interface IntelligenceDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly engine: EngineAdapter;
  readonly projectRoot: string;
  readonly registry?: ContractRegistry;
  readonly enabledAgents?: ReadonlySet<string>;
  readonly departments?: readonly DepartmentConfig[];
  readonly gateway?: GatewayDeps;
  readonly evaluator?: string;
}

/**
 * Record the owner's words, exactly as they arrived.
 *
 * Separate from intake on purpose (03 §2). The Idea is immutable and unmediated; the
 * interpretation of it is a governed run that can be re-read and disagreed with. Storing
 * only the interpretation would make the original unrecoverable.
 */
export function recordIdea(deps: IntelligenceDeps, rawText: string): string {
  const id = deps.ids.next('SC-IDEA');
  const at = deps.clock.now();
  const tx = deps.store.begin();
  try {
    repository(deps.store, ARTIFACT_TYPES.IDEA, IdeaSchema).put(tx, {
      id,
      createdAt: at,
      rawText,
      capturedAt: at,
      meta: {
        provenance: { marking: SourceMarking.OWNER_STATED, statedAt: at, verbatim: rawText },
        attribution: { at },
      },
    });
    audit(tx, {
      action: AuditAction.REQUEST_RECEIVED,
      subject: id,
      outcome: 'OK',
      detail: { chars: rawText.length },
    });
    tx.commit();
  } catch (e) {
    tx.rollback();
    throw e;
  }
  return id;
}

/** Build an orchestrator wired to the real departments and the real gate engine. */
export function intelligenceOrchestrator(
  deps: IntelligenceDeps,
  workItemId: string,
  profileId: string,
  skip?: Readonly<Record<string, string>>,
): IntelligenceOrchestrator {
  const registry = deps.registry ?? ContractRegistry.shared();
  const enabledAgents = deps.enabledAgents ?? PHASE5_ENABLED_AGENTS;

  const runtime = new AgentRuntime({
    store: deps.store,
    ids: deps.ids,
    clock: deps.clock,
    registry,
    engine: deps.engine,
    enabledAgents,
    projectRoot: deps.projectRoot,
  });

  return new IntelligenceOrchestrator(
    {
      store: deps.store,
      clock: deps.clock,
      ids: deps.ids,
      registry,
      runtime,
      projectRoot: deps.projectRoot,
      enabledAgents,
      departments: deps.departments ?? UPSTREAM_DEPARTMENTS,
      gates: upstreamGateEvaluator({
        store: deps.store,
        clock: deps.clock,
        ids: deps.ids,
        evaluator: deps.evaluator ?? 'SC-AGENT-001',
      }),
      ...(deps.gateway === undefined ? {} : { gateway: deps.gateway }),
    },
    workItemId,
    profileId,
    skip,
  );
}

/**
 * Record a real owner answer.
 *
 * `answeredBy` is required and must not be an agent — `ownerDecisionRefusal` enforces it,
 * and the orchestrator re-checks on resume. An AI response cannot satisfy an owner
 * decision, which is the difference between a governed company and one that asks itself
 * for permission.
 */
export function answerOwnerDecision(
  deps: IntelligenceDeps,
  o: {
    readonly decisionId: string;
    /** For an OPTION decision: one of the options offered. */
    readonly chosenOption?: string;
    /** For a VALUE decision: the owner's actual answer. */
    readonly value?: string;
    readonly answeredBy: string;
  },
): void {
  const repo = repository(
    deps.store,
    ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
    OwnerDecisionRequestSchema,
  );
  const existing = repo.get(o.decisionId);
  if (existing === undefined) {
    throw new Error('No owner decision ' + o.decisionId + ' exists');
  }

  /*
   * THE ANSWER MUST FIT THE QUESTION.
   *
   * An OPTION decision is answered with one of the options offered; free text there is a
   * string that looks like consent and can be routed on by nothing. A VALUE decision is
   * answered with an actual value of the declared kind; choosing a meta-option there is
   * how "what is the collection window?" came to be answered "Answer it".
   *
   * Checked where a person types it, so a malformed answer is refused while they are still
   * in front of it rather than at some later point that blames the wrong thing.
   */
  const refusal = answerRefusal(existing, {
    ...(o.chosenOption === undefined ? {} : { option: o.chosenOption }),
    ...(o.value === undefined ? {} : { value: o.value }),
  });
  if (refusal !== undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: refusal,
      remedy:
        existing.responseMode === 'VALUE'
          ? 'Answer with the value itself — for example `--value "48 hours"`.'
          : 'Answer with one of the options as written.',
      details: {
        decisionId: o.decisionId,
        responseMode: existing.responseMode,
        offered: existing.options.map((opt) => opt.option),
      },
      specRef: '§32',
    });
  }

  /*
   * The impersonation rule, applied at the point of writing as well as at every point of
   * reading. `ownerDecisionRefusal` catches a stored agent answer; this stops one being
   * stored at all — and it applies to a VALUE just as much as to a choice, because a fact
   * supplied by an agent is not a fact supplied by the owner.
   */
  if (o.answeredBy.startsWith('SC-AGENT-') || o.answeredBy.startsWith('SC-RUN-')) {
    return fail({
      code: 'E_GATE_AUTHORITY',
      message: 'Owner decision ' + o.decisionId + ' cannot be answered by ' + o.answeredBy,
      remedy:
        'An owner decision is answered by a person. An agent answering it is the system asking itself for permission.',
      specRef: '§32',
    });
  }

  const tx = deps.store.begin();
  try {
    repo.put(tx, {
      ...existing,
      state: 'ANSWERED',
      ...(o.chosenOption === undefined ? {} : { chosenOption: o.chosenOption }),
      ...(o.value === undefined ? {} : { answerValue: o.value }),
      answeredBy: o.answeredBy,
      answeredAt: deps.clock.now(),
    });
    audit(tx, {
      action: AuditAction.OWNER_DECISION_ANSWERED,
      subject: o.decisionId,
      outcome: 'OK',
      detail: {
        answeredBy: o.answeredBy,
        responseMode: existing.responseMode,
        ...(o.chosenOption === undefined ? {} : { chosenOption: o.chosenOption }),
        ...(o.value === undefined ? {} : { value: o.value }),
      },
    });
    tx.commit();
  } catch (e) {
    tx.rollback();
    throw e;
  }
}

/** Owner decisions still waiting. What `serva intelligence status` shows first. */
export function openOwnerDecisions(store: Store): readonly { id: string; question: string }[] {
  return repository(store, ARTIFACT_TYPES.OWNER_DECISION_REQUEST, OwnerDecisionRequestSchema)
    .list()
    .filter((d) => d.state === 'OPEN')
    .map((d) => ({ id: d.id, question: d.question }));
}
