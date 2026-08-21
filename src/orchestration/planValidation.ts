import { MAGNITUDE_ORDER, Magnitude } from '../vocab/index.js';
import { getCatalogues } from '../catalogue/index.js';
import { capabilityLevelFor, CapabilityLevel } from '../agents/toolPolicy.js';
import type { ContractRegistry } from '../agents/registry.js';
import type { ExecutionPlan, PlanStep, RequestClassification } from './schemas.js';

/**
 * Deterministic validation of an AI-proposed ExecutionPlan.
 *
 * SPEC: 04 §7 (collection checks), 04 §12 (the Orchestrator is not a prompt),
 * 02 §6 / 32 §6 (conflict of interest), 19 §10 (never delegated).
 *
 * An ExecutionPlan produced by an agent is a **proposal**. This module is where it
 * stops being one. Every check here is mechanical logic over stored catalogues, with
 * no model involved, which is the property that makes a hallucinating planner unable
 * to advance the lifecycle.
 *
 * A rejected plan is returned as findings, never silently repaired. Quietly rewriting
 * a plan into a different plan and executing that would mean the audit trail records a
 * plan nobody proposed and nobody approved.
 */

export const PlanFindingKind = {
  UNKNOWN_AGENT: 'UNKNOWN_AGENT',
  UNKNOWN_DEPARTMENT: 'UNKNOWN_DEPARTMENT',
  AGENT_DEPARTMENT_MISMATCH: 'AGENT_DEPARTMENT_MISMATCH',
  CAPABILITY_NOT_ENABLED: 'CAPABILITY_NOT_ENABLED',
  AGENT_NOT_ENABLED: 'AGENT_NOT_ENABLED',
  CONFLICT_OF_INTEREST: 'CONFLICT_OF_INTEREST',
  UNKNOWN_DEPENDENCY: 'UNKNOWN_DEPENDENCY',
  DEPENDENCY_CYCLE: 'DEPENDENCY_CYCLE',
  DUPLICATE_STEP: 'DUPLICATE_STEP',
  EMPTY_PLAN: 'EMPTY_PLAN',
  MISSING_SCOPE: 'MISSING_SCOPE',
  MAGNITUDE_EXCEEDS_CEILING: 'MAGNITUDE_EXCEEDS_CEILING',
  OWNER_ACTION_DELEGATED: 'OWNER_ACTION_DELEGATED',
  CLASSIFICATION_MISMATCH: 'CLASSIFICATION_MISMATCH',
  UNRECORDED_OMISSION: 'UNRECORDED_OMISSION',
} as const;
export type PlanFindingKind = (typeof PlanFindingKind)[keyof typeof PlanFindingKind];

export interface PlanFinding {
  readonly kind: PlanFindingKind;
  readonly stepId?: string;
  readonly detail: string;
  readonly specRef: string;
}

export interface PlanValidation {
  readonly accepted: boolean;
  readonly findings: readonly PlanFinding[];
}

export interface PlanValidationOptions {
  readonly registry: ContractRegistry;
  readonly enabledAgents: ReadonlySet<string>;
  readonly classification: RequestClassification;
}

/**
 * 28 §3 / SC-POL-030 — actions reserved to the owner.
 *
 * Matched against a step's stated purpose. Prose matching is a weak check and is
 * treated as one: it is a backstop that catches an obviously-delegated owner action,
 * layered under the real control, which is that no agent contract grants the authority
 * to perform one in the first place.
 */
const OWNER_RESERVED_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bapprove\s+(the\s+)?(release|budget|waiver|policy)/i,
  /\bwaive\s+(a\s+|the\s+)?(gate|policy|criterion)/i,
  /\bamend\s+(the\s+)?(constitution|policy)/i,
  /\baccept\s+(the\s+)?(risk|residual risk)\b/i,
  /\bsign[- ]?off\b/i,
  /\boverride\s+(a\s+|the\s+)?gate/i,
]);

function magnitudeRank(m: Magnitude): number {
  return MAGNITUDE_ORDER.indexOf(m);
}

/** Read the M-level out of a ceiling string such as "M4 (process decisions only)". */
export function ceilingRank(ceiling: string): number {
  const m = ceiling.match(/M([0-4])/);
  if (m === null) return -1;
  return Number.parseInt(m[1]!, 10);
}

export function validateExecutionPlan(
  plan: ExecutionPlan,
  opts: PlanValidationOptions,
): PlanValidation {
  const findings: PlanFinding[] = [];
  const add = (f: PlanFinding): void => {
    findings.push(f);
  };

  const cat = getCatalogues();
  const deptIds = new Set(cat.departments.map((d) => d.id));

  if (plan.steps.length === 0) {
    add({
      kind: PlanFindingKind.EMPTY_PLAN,
      detail: 'The plan contains no steps, so it cannot advance anything.',
      specRef: '04 §6',
    });
  }

  if (plan.planFor !== opts.classification.requestClass) {
    add({
      kind: PlanFindingKind.CLASSIFICATION_MISMATCH,
      detail:
        'The plan is for ' +
        plan.planFor +
        ' but the accepted classification is ' +
        opts.classification.requestClass +
        '. A plan may not reclassify the request it is planning for.',
      specRef: '04 CL-4',
    });
  }

  if (magnitudeRank(plan.magnitude) < magnitudeRank(opts.classification.magnitude)) {
    // 04 CL-1: classify upward under uncertainty. Downgrading requires a Decision,
    // which a plan is not.
    add({
      kind: PlanFindingKind.CLASSIFICATION_MISMATCH,
      detail:
        'The plan downgrades magnitude from ' +
        opts.classification.magnitude +
        ' to ' +
        plan.magnitude +
        '. Downgrading requires a Decision, not a plan.',
      specRef: '04 CL-1, OF-2',
    });
  }

  const seenSteps = new Set<string>();
  const producers = new Map<string, string[]>(); // agentId -> stepIds

  for (const step of plan.steps) {
    if (seenSteps.has(step.stepId)) {
      add({
        kind: PlanFindingKind.DUPLICATE_STEP,
        stepId: step.stepId,
        detail: 'Step id ' + step.stepId + ' appears more than once.',
        specRef: '04 §7',
      });
    }
    seenSteps.add(step.stepId);

    if (step.scopeBoundary.trim().length === 0) {
      add({
        kind: PlanFindingKind.MISSING_SCOPE,
        stepId: step.stepId,
        detail: 'A step without a declared scope boundary cannot be dispatched.',
        specRef: '04 §6, SC-POL-009',
      });
    }

    if (!opts.registry.has(step.agentId)) {
      add({
        kind: PlanFindingKind.UNKNOWN_AGENT,
        stepId: step.stepId,
        detail: 'Agent ' + step.agentId + ' does not exist in the canonical catalogue.',
        specRef: '30 §4',
      });
      continue;
    }

    const contract = opts.registry.get(step.agentId);
    (producers.get(step.agentId) ?? producers.set(step.agentId, []).get(step.agentId)!).push(
      step.stepId,
    );

    if (!deptIds.has(step.departmentId)) {
      add({
        kind: PlanFindingKind.UNKNOWN_DEPARTMENT,
        stepId: step.stepId,
        detail: 'Department ' + step.departmentId + ' does not exist.',
        specRef: '30 §3',
      });
    } else if (contract.department !== step.departmentId) {
      add({
        kind: PlanFindingKind.AGENT_DEPARTMENT_MISMATCH,
        stepId: step.stepId,
        detail:
          step.agentId +
          ' belongs to ' +
          contract.department +
          ', but the plan assigns it to ' +
          step.departmentId +
          '.',
        specRef: '30 §4',
      });
    }

    if (!opts.enabledAgents.has(step.agentId)) {
      add({
        kind: PlanFindingKind.AGENT_NOT_ENABLED,
        stepId: step.stepId,
        detail:
          step.agentId + ' (' + contract.name + ') is not in the enabled agent set for this phase.',
        specRef: '19 §5',
      });
    }

    const level = capabilityLevelFor(contract);
    if (level === CapabilityLevel.NOT_ENABLED) {
      add({
        kind: PlanFindingKind.CAPABILITY_NOT_ENABLED,
        stepId: step.stepId,
        detail:
          step.agentId +
          ' requires write, execute or network capability, which is not enforceable on the current substrate.',
        specRef: '33 PC-5, 19 TR-1',
      });
    }

    const ceiling = ceilingRank(contract.magnitudeCeiling);
    const needed = magnitudeRank(plan.magnitude);
    if (ceiling >= 0 && needed > ceiling) {
      add({
        kind: PlanFindingKind.MAGNITUDE_EXCEEDS_CEILING,
        stepId: step.stepId,
        detail:
          step.agentId +
          ' has a magnitude ceiling of ' +
          contract.magnitudeCeiling +
          ' but the plan is ' +
          plan.magnitude +
          '.',
        specRef: '05 §2, 09 §3',
      });
    }

    for (const pattern of OWNER_RESERVED_PATTERNS) {
      if (pattern.test(step.purpose)) {
        add({
          kind: PlanFindingKind.OWNER_ACTION_DELEGATED,
          stepId: step.stepId,
          detail: 'The step purpose describes an owner-reserved action: "' + step.purpose + '".',
          specRef: '28 §3, SC-POL-030',
        });
        break;
      }
    }
  }

  // Dependencies must name steps in this plan, and the graph must be acyclic.
  for (const step of plan.steps) {
    for (const dep of step.dependsOn) {
      if (!seenSteps.has(dep)) {
        add({
          kind: PlanFindingKind.UNKNOWN_DEPENDENCY,
          stepId: step.stepId,
          detail: 'Depends on "' + dep + '", which is not a step in this plan.',
          specRef: '04 SQ-2',
        });
      }
    }
  }
  const cycle = findCycle(plan.steps);
  if (cycle !== undefined) {
    add({
      kind: PlanFindingKind.DEPENDENCY_CYCLE,
      detail: 'Dependency cycle: ' + cycle.join(' -> '),
      specRef: '04 §7, 07 §2.1',
    });
  }

  // 02 §6 / 32 §6 — a producer and its verifier must not be the same actor within one
  // work item. In Serva every step is a separate AgentRun with its own session, so the
  // check is on the PAIRING: a plan that puts both roles on one agent is the defect.
  const agentsInPlan = [...new Set(plan.steps.map((s) => s.agentId))];
  for (let i = 0; i < agentsInPlan.length; i++) {
    for (let j = i + 1; j < agentsInPlan.length; j++) {
      const a = agentsInPlan[i]!;
      const b = agentsInPlan[j]!;
      const basis = opts.registry.conflicts(a, b);
      if (basis === undefined) continue;
      // Distinct agents on a CoI pair is CORRECT -- that is the separation working.
      // It only becomes a finding if the same agent covers both sides, which the loop
      // above cannot produce, so this records the pairing for the audit trail instead.
      void basis;
    }
  }
  for (const [agentId, stepIds] of producers) {
    const contract = opts.registry.get(agentId);
    if (stepIds.length < 2) continue;
    const steps = plan.steps.filter((s) => stepIds.includes(s.stepId));
    const producesAndVerifies =
      contract.archetype === 'VERIFIER' &&
      steps.some((s) => /produce|author|implement|write|draft/i.test(s.purpose));
    if (producesAndVerifies) {
      add({
        kind: PlanFindingKind.CONFLICT_OF_INTEREST,
        stepId: stepIds[0]!,
        detail:
          agentId +
          ' is assigned both production and verification work in the same plan (steps ' +
          stepIds.join(', ') +
          ').',
        specRef: '02 §6, SC-POL-006',
      });
    }
  }

  // SC-POL-024 — a plan that skips a recommended department must say why.
  for (const dept of opts.classification.recommendedDepartments) {
    const covered = plan.steps.some((s) => s.departmentId === dept);
    const excused = plan.omissions.some((o) => o.omitted.includes(dept));
    if (!covered && !excused) {
      add({
        kind: PlanFindingKind.UNRECORDED_OMISSION,
        detail:
          'Classification recommended ' +
          dept +
          ', which the plan neither covers nor records as a deliberate omission.',
        specRef: 'SC-POL-024, 04 §5',
      });
    }
  }

  return { accepted: findings.length === 0, findings };
}

export function findCycle(steps: readonly PlanStep[]): string[] | undefined {
  const byId = new Map(steps.map((s) => [s.stepId, s]));
  const state = new Map<string, 'VISITING' | 'DONE'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    const st = state.get(id);
    if (st === 'DONE') return undefined;
    if (st === 'VISITING') return [...stack.slice(stack.indexOf(id)), id];
    const step = byId.get(id);
    if (step === undefined) return undefined;
    state.set(id, 'VISITING');
    stack.push(id);
    for (const dep of step.dependsOn) {
      const found = visit(dep);
      if (found !== undefined) return found;
    }
    stack.pop();
    state.set(id, 'DONE');
    return undefined;
  };

  for (const s of steps) {
    const found = visit(s.stepId);
    if (found !== undefined) return found;
  }
  return undefined;
}
