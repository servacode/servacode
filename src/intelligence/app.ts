import { AgentRuntime } from '../agents/runtime.js';
import { ContractRegistry } from '../agents/registry.js';
import { ARTIFACT_TYPES, repository } from './repository.js';
import { IdeaSchema } from './artifacts/framing.js';
import { OwnerDecisionRequestSchema } from './artifacts/governance.js';
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
import { PHASE5_ENABLED_AGENTS } from './enabled.js';
import { AuditAction, audit } from '../events/audit.js';
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
  o: { readonly decisionId: string; readonly chosenOption: string; readonly answeredBy: string },
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

  const tx = deps.store.begin();
  try {
    repo.put(tx, {
      ...existing,
      state: 'ANSWERED',
      chosenOption: o.chosenOption,
      answeredBy: o.answeredBy,
      answeredAt: deps.clock.now(),
    });
    audit(tx, {
      action: AuditAction.OWNER_DECISION_ANSWERED,
      subject: o.decisionId,
      outcome: 'OK',
      detail: { answeredBy: o.answeredBy, chosenOption: o.chosenOption },
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
