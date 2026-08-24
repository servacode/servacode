import { RunOutcome } from '../vocab/index.js';
import { AuditAction, audit } from '../events/audit.js';
import { getCatalogues } from '../catalogue/index.js';
import { assertNoRunReuse } from '../agents/runtime.js';
import {
  EXECUTION_PLAN_JSON_SCHEMA,
  ExecutionPlanSchema,
  REQUEST_CLASSIFICATION_JSON_SCHEMA,
  RequestClassificationSchema,
  RequestRecordSchema,
  type ExecutionPlan,
  type RequestClassification,
  type RequestRecord,
} from './schemas.js';
import { validateExecutionPlan, type PlanValidation } from './planValidation.js';
import type { AgentRunResult, AgentRuntime } from '../agents/runtime.js';
import type { Store } from '../store/store.js';
import type { IdSource } from '../core/ids.js';
import type { Clock } from '../core/clock.js';
import type { ContractRegistry } from '../agents/registry.js';

/**
 * The deterministic orchestration foundation.
 *
 * SPEC: 04 §2 (the loop), 04 §12 (the Orchestrator is not a prompt), 19 §10.
 *
 * The distinction this class exists to hold:
 *
 *   **An AI Orchestrator agent may RECOMMEND a plan. This code owns dispatch.**
 *
 * Claude is asked for a classification and for a plan. It is never asked to run the
 * company. Each step becomes a separate governed AgentRun with its own contract, its
 * own constructed context, its own capability grant and its own fresh session — which
 * is exactly what a single hidden multi-agent session inside the engine would destroy.
 * If the engine's own subagent machinery were used as Serva's company structure, none
 * of the per-run governance would exist, and Serva would be trusting a transcript
 * instead of a trace.
 *
 * Phase 3 implements the flow up to the dispatch queue. Executing a queue of producer
 * work belongs to the Engineering Factory phase.
 */

export const CLASSIFIER_AGENT = 'SC-AGENT-003';
export const ORCHESTRATOR_AGENT = 'SC-AGENT-001';
export const PLANNER_AGENT = 'SC-AGENT-002';

/** 04 §3.4 — below this, a classification is not acted on without owner input. */
export const MIN_CLASSIFICATION_CONFIDENCE = 'LOW';

export interface OrchestratorDeps {
  readonly store: Store;
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly runtime: AgentRuntime;
  readonly registry: ContractRegistry;
  readonly enabledAgents: ReadonlySet<string>;
}

export const RoutingStage = {
  RECORDED: 'RECORDED',
  CLASSIFIED: 'CLASSIFIED',
  PLANNED: 'PLANNED',
  VALIDATED: 'VALIDATED',
  QUEUED: 'QUEUED',
  HALTED: 'HALTED',
} as const;
export type RoutingStage = (typeof RoutingStage)[keyof typeof RoutingStage];

export interface DispatchEntry {
  readonly stepId: string;
  readonly agentId: string;
  readonly departmentId: string;
  readonly purpose: string;
  readonly scopeBoundary: string;
  readonly dependsOn: readonly string[];
  /** Steps with no unmet dependency are ready now; the rest wait. */
  readonly ready: boolean;
}

export interface RoutingResult {
  readonly request: RequestRecord;
  readonly stage: RoutingStage;
  readonly classification?: RequestClassification;
  readonly classificationRun?: AgentRunResult;
  readonly plan?: ExecutionPlan;
  readonly planRun?: AgentRunResult;
  readonly validation?: PlanValidation;
  readonly queue: readonly DispatchEntry[];
  readonly haltReason?: string;
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /** 04 §2 step 1 — the request becomes a record before anything reasons about it. */
  recordRequest(text: string, workItemId: string, source: RequestRecord['source']): RequestRecord {
    const record = RequestRecordSchema.parse({
      id: this.deps.ids.next('SC-REQST'),
      text,
      receivedAt: this.deps.clock.now(),
      source,
      workItemId,
    });
    const tx = this.deps.store.begin();
    // T-WORKING, not T-CANON: a request is an input, not established project truth.
    tx.putWorking('requestRecord', record.id, record);
    audit(tx, {
      action: AuditAction.REQUEST_RECEIVED,
      subject: record.id,
      outcome: 'OK',
      detail: { workItemId, source, chars: text.length },
    });
    tx.commit();
    return record;
  }

  /**
   * Owner request -> classification -> plan -> deterministic validation -> queue.
   *
   * Halts at the first stage that cannot honestly proceed. It never substitutes its
   * own answer for a missing one: a classifier that failed leaves the request
   * classified by nobody, which is a state the owner can see and act on.
   */
  async route(
    text: string,
    workItemId: string,
    /*
     * Where the request came from. Recorded rather than inferred, because an owner auditing
     * their own project should be able to see which surface they were sitting in front of
     * when they asked for something.
     */
    source: RequestRecord['source'] = 'OWNER_CLI',
  ): Promise<RoutingResult> {
    const request = this.recordRequest(text, workItemId, source);

    const classificationRun = await this.deps.runtime.run({
      agentId: CLASSIFIER_AGENT,
      workItemId,
      taskDefinition:
        'Classify this request. Derive every signal from project state, not from the requester adjectives (04 CL-3). Classify upward when signals are ambiguous (04 CL-1). If the request contains more than one intent, set multiIntent and do not force a single class.',
      scopeBoundary: 'classification only; propose nothing and change nothing',
      ownerRequest: request.text,
      resultSchema: REQUEST_CLASSIFICATION_JSON_SCHEMA,
      // Serva's own check of the payload, applied by AgentRuntime before the run is
      // called valid. The JSON Schema above shapes the request; this decides the answer.
      resultValidator: RequestClassificationSchema,
      canon: [
        ...this.projectStateContext(),
        // 04 §3.1 asks the classifier to recommend DEPARTMENTS. Without the catalogue
        // it invents plausible names like "Documentation/Content", which Serva then
        // rejects -- correctly, but for a gap Serva created by withholding the list.
        // Context is constructed: if an answer must use canonical identifiers, the
        // identifiers belong in the bundle (19 CX-4).
        {
          source: 'catalogue:departments',
          kind: 'DEPARTMENT_CATALOGUE',
          version: '1',
          relevance: 88,
          content: this.departmentCatalogue(),
        },
      ],
    });

    if (classificationRun.outcome !== RunOutcome.COMPLETED) {
      return this.halt(request, RoutingStage.RECORDED, classificationRun, undefined, undefined, {
        classificationRun,
        reason:
          'Classification did not complete: ' +
          classificationRun.outcome +
          (classificationRun.diagnostics.length > 0
            ? ' (' + classificationRun.diagnostics[0] + ')'
            : ''),
      });
    }

    // Serva validates independently of what the provider said was schema-valid.
    const parsedClass = RequestClassificationSchema.safeParse(classificationRun.envelope?.result);
    if (!parsedClass.success) {
      return this.halt(request, RoutingStage.RECORDED, classificationRun, undefined, undefined, {
        classificationRun,
        reason:
          'The classification payload did not satisfy Serva validation: ' +
          parsedClass.error.issues
            .slice(0, 5)
            .map((i) => i.path.join('.') + ' ' + i.message)
            .join('; '),
      });
    }
    const classification = parsedClass.data;

    const tx = this.deps.store.begin();
    tx.putWorking('requestClassification', this.deps.ids.next('SC-CLS'), {
      requestRef: request.id,
      ...classification,
      classifiedByRun: classificationRun.runId,
    });
    audit(tx, {
      action: AuditAction.REQUEST_CLASSIFIED,
      subject: request.id,
      outcome: 'OK',
      detail: {
        requestClass: classification.requestClass,
        magnitude: classification.magnitude,
        confidence: classification.confidence,
      },
    });
    tx.commit();

    // 04 §3.1 — meta-classes are not lifecycle work and do not get a plan.
    if (classification.requestClass === 'QUERY' || classification.requestClass === 'GOVERNANCE') {
      return {
        request,
        stage: RoutingStage.CLASSIFIED,
        classification,
        classificationRun,
        queue: [],
        haltReason:
          classification.requestClass +
          ' is a meta-class (04 §3.1): it is answered from the store or routed to governance, and produces no execution plan.',
      };
    }

    const planRun = await this.deps.runtime.run({
      agentId: ORCHESTRATOR_AGENT,
      workItemId,
      taskDefinition:
        'Propose an execution plan for the accepted classification. Assign each step to a canonical agent within its own department. Keep producers and their verifiers as separate steps. Record every department the classification recommended that you deliberately omit, with a reason (SC-POL-024). You are proposing, not dispatching: Serva validates and dispatches.',
      scopeBoundary: 'plan proposal only; dispatch nothing',
      ownerRequest: request.text,
      resultSchema: EXECUTION_PLAN_JSON_SCHEMA,
      resultValidator: ExecutionPlanSchema,
      canon: [
        ...this.projectStateContext(),
        {
          source: 'classification:' + request.id,
          kind: 'REQUEST_CLASSIFICATION',
          version: '1',
          relevance: 95,
          content: JSON.stringify(classification, null, 2),
        },
        {
          source: 'catalogue:agents',
          kind: 'AGENT_CATALOGUE',
          version: '1',
          relevance: 90,
          content: this.enabledAgentCatalogue(),
        },
        {
          source: 'catalogue:departments',
          kind: 'DEPARTMENT_CATALOGUE',
          version: '1',
          relevance: 88,
          content: this.departmentCatalogue(),
        },
      ],
    });

    if (planRun.outcome !== RunOutcome.COMPLETED) {
      return this.halt(request, RoutingStage.CLASSIFIED, classificationRun, planRun, undefined, {
        classification,
        classificationRun,
        planRun,
        reason: 'Planning did not complete: ' + planRun.outcome,
      });
    }

    const parsedPlan = ExecutionPlanSchema.safeParse(planRun.envelope?.result);
    if (!parsedPlan.success) {
      return this.halt(request, RoutingStage.CLASSIFIED, classificationRun, planRun, undefined, {
        classification,
        classificationRun,
        planRun,
        reason:
          'The plan payload did not satisfy Serva validation: ' +
          parsedPlan.error.issues
            .slice(0, 5)
            .map((i) => i.path.join('.') + ' ' + i.message)
            .join('; '),
      });
    }
    const plan = parsedPlan.data;

    const validation = validateExecutionPlan(plan, {
      registry: this.deps.registry,
      enabledAgents: this.deps.enabledAgents,
      classification,
    });

    const tx2 = this.deps.store.begin();
    tx2.putWorking('executionPlan', this.deps.ids.next('SC-PLAN'), {
      requestRef: request.id,
      proposedByRun: planRun.runId,
      accepted: validation.accepted,
      findings: validation.findings,
      ...plan,
    });
    audit(tx2, {
      action: validation.accepted ? AuditAction.PLAN_VALIDATED : AuditAction.PLAN_REJECTED,
      subject: request.id,
      outcome: validation.accepted ? 'OK' : 'REFUSED',
      detail: { steps: plan.steps.length, findings: validation.findings.length },
    });
    tx2.commit();

    if (!validation.accepted) {
      // 04 §7 — rejected, never silently sanitized into a different plan.
      return {
        request,
        stage: RoutingStage.HALTED,
        classification,
        classificationRun,
        plan,
        planRun,
        validation,
        queue: [],
        haltReason:
          'The proposed plan was rejected by deterministic validation (' +
          String(validation.findings.length) +
          ' finding(s)). Serva does not repair a plan on the proposer behalf; re-plan with the findings.',
      };
    }

    const done = new Set<string>();
    const queue: DispatchEntry[] = plan.steps.map((s) => ({
      stepId: s.stepId,
      agentId: s.agentId,
      departmentId: s.departmentId,
      purpose: s.purpose,
      scopeBoundary: s.scopeBoundary,
      dependsOn: s.dependsOn,
      ready: s.dependsOn.every((d) => done.has(d)),
    }));

    return {
      request,
      stage: RoutingStage.QUEUED,
      classification,
      classificationRun,
      plan,
      planRun,
      validation,
      queue,
    };
  }

  /**
   * Every dispatched step is a separate governed run.
   *
   * Exposed as an assertion rather than a comment because it is the property that
   * distinguishes Serva's company structure from the engine's own subagent machinery.
   */
  assertSeparateRuns(results: readonly AgentRunResult[]): void {
    const ids = new Set<string>();
    const sessions = new Set<string>();
    for (const r of results) {
      if (ids.has(r.runId)) {
        throw new Error('run ' + r.runId + ' appears twice');
      }
      ids.add(r.runId);
      if (r.sessionRef !== undefined) {
        if (sessions.has(r.sessionRef)) {
          throw new Error(
            'session ' + r.sessionRef + ' was reused across runs, violating 19 SM-1/SM-3',
          );
        }
        sessions.add(r.sessionRef);
      }
    }
  }

  private projectStateContext(): {
    source: string;
    kind: string;
    version: string;
    content: string;
    relevance: number;
  }[] {
    const workItems = this.deps.store.listWorkingIds('workItem');
    const requirements = this.deps.store.listCanonIds('requirement');
    return [
      {
        source: 'store:project-state',
        kind: 'PROJECT_STATE',
        version: String(this.deps.store.storeVersion()),
        relevance: 80,
        content: [
          'Store version: ' + String(this.deps.store.storeVersion()),
          'Work items on record: ' + String(workItems.length),
          'Requirements baselined: ' + String(requirements.length),
          workItems.length === 0 && requirements.length === 0
            ? 'No project state exists yet. A request against an empty store is a strong NEW_PROJECT signal (04 §3.2).'
            : 'Project state exists; this is not a NEW_PROJECT unless the request is for a different product.',
        ].join('\n'),
      },
    ];
  }

  /** 30 §3 — the canonical department identifiers an answer is allowed to use. */
  private departmentCatalogue(): string {
    const lines = [
      'Canonical departments (30 §3). Use these identifiers exactly; any other value',
      'will be rejected by Serva validation.',
    ];
    for (const d of getCatalogues().departments) {
      lines.push('- ' + d.id + '  ' + d.name + '  (tier ' + String(d.tier) + ')');
    }
    return lines.join('\n');
  }

  private enabledAgentCatalogue(): string {
    const lines = ['Agents you may assign work to. Any other agent will be rejected.'];
    for (const id of [...this.deps.enabledAgents].sort()) {
      const c = this.deps.registry.get(id);
      lines.push(
        '- ' +
          c.id +
          ' ' +
          c.name +
          ' | dept ' +
          c.department +
          ' | ' +
          c.archetype +
          '/' +
          c.authorityLevel +
          ' | ceiling ' +
          c.magnitudeCeiling +
          ' | ' +
          c.mission,
      );
    }
    return lines.join('\n');
  }

  private halt(
    request: RequestRecord,
    stage: RoutingStage,
    _classificationRun: AgentRunResult | undefined,
    _planRun: AgentRunResult | undefined,
    _validation: PlanValidation | undefined,
    o: {
      reason: string;
      classification?: RequestClassification;
      classificationRun?: AgentRunResult;
      planRun?: AgentRunResult;
    },
  ): RoutingResult {
    const tx = this.deps.store.begin();
    audit(tx, {
      action: AuditAction.PLAN_REJECTED,
      subject: request.id,
      outcome: 'REFUSED',
      detail: { stage, reason: o.reason },
    });
    tx.commit();
    return {
      request,
      stage: RoutingStage.HALTED,
      ...(o.classification === undefined ? {} : { classification: o.classification }),
      ...(o.classificationRun === undefined ? {} : { classificationRun: o.classificationRun }),
      ...(o.planRun === undefined ? {} : { planRun: o.planRun }),
      queue: [],
      haltReason: o.reason,
    };
  }
}

export { assertNoRunReuse };
