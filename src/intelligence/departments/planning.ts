import { z } from 'zod';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import { AssumptionSchema, ConstraintSchema } from '../artifacts/framing.js';
import {
  NfrSchema,
  RequirementSchema,
  AcceptanceCriterionSchema,
} from '../artifacts/requirements.js';
import { BusinessRuleSchema, StateMachineSchema } from '../artifacts/business.js';
import { ArchitectureModelSchema } from '../artifacts/architecture.js';
import { ResidualRiskSchema } from '../artifacts/security.js';
import { FlowSchema } from '../artifacts/ux.js';
import {
  BudgetStateSchema,
  CostAssessmentSchema,
  CostModelSchema,
  DeploymentStrategySchema,
  EnvironmentModelSchema,
  ObservabilitySpecSchema,
  RollbackSpecSchema,
  costRefusal,
} from '../artifacts/operations.js';
import {
  DecisionPurpose,
  OptionDisposition,
  OwnerDecisionRequestSchema,
  RiskSchema,
} from '../artifacts/governance.js';
import { TestCaseSchema, TestStrategySchema } from '../artifacts/testing.js';
import { jsonSchemaFor } from '../execution/jsonSchema.js';
import { contextFrom, derived } from './shared.js';
import type {
  DepartmentConfig,
  DepartmentContext,
  DepartmentContextSpec,
} from '../execution/types.js';

/**
 * COST, INFRASTRUCTURE, RISK, TEST DESIGN.
 *
 * SPEC: §17, §22, §23, §29, 06.
 *
 * Two placement decisions worth stating, both recorded in SPEC_IMPLEMENTATION_FINDINGS:
 *
 * Cost (SC-DEPT-024) and Infrastructure (SC-DEPT-023) own no stage in R4's 26. They
 * contribute to decisions made elsewhere, so Cost runs at FEASIBILITY (015) where
 * affordability is decided, and Infrastructure at ARCHITECTURE (020) where the shape is.
 *
 * Test design (SC-DEPT-051) owns stage 042, which is downstream of implementation. But
 * §29 requires the strategy BEFORE coding, and it is an input to the readiness package —
 * so it runs at PLANNING (030), the last upstream stage, where implementation work is
 * scoped. Running it at 042 would produce a strategy after the code it was meant to shape.
 */

/* ============================================================= SC-AGENT-110 — cost */

export const CostOutputSchema = z
  .object({
    buildCost: z
      .object({
        amount: z.number().min(0),
        currency: z.string().length(3),
        basis: z.enum(['SOURCED', 'ESTIMATED']),
        basisDetail: z.string().min(1),
        confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
      })
      .strict()
      .optional(),
    runCost: z
      .array(
        z
          .object({
            item: z.string().min(1),
            amount: z.number().min(0),
            currency: z.string().length(3),
            period: z.enum(['ONE_OFF', 'PER_MONTH', 'PER_YEAR', 'PER_UNIT']),
            basis: z.enum(['SOURCED', 'ESTIMATED']),
            basisDetail: z.string().min(1),
            confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
          })
          .strict(),
      )
      .default([]),
    assumptions: z.array(z.string().min(1)).default([]),
    narrative: z.string().min(1),
    /** Set when the total exceeds a stated budget. Becomes an owner decision. */
    exceedsBudget: z.boolean(),
  })
  .strict();

const COST = 'SC-AGENT-110';

export const costDepartment: DepartmentConfig<typeof CostOutputSchema> = {
  id: 'DEPT-COST',
  stageId: 'SC-STAGE-015',
  agentId: COST,
  title: 'Cost Engineering',
  outputSchema: CostOutputSchema,
  outputJsonSchema: jsonSchemaFor(CostOutputSchema),
  requires: [ARTIFACT_TYPES.REQUIREMENT],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const reqs = repository(ctx.store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
    const nfrs = repository(ctx.store, ARTIFACT_TYPES.NFR, NfrSchema).list();
    const constraints = repository(ctx.store, ARTIFACT_TYPES.CONSTRAINT, ConstraintSchema).list();
    return {
      canon: [
        contextFrom('requirements', 'REQUIREMENT', reqs, (r) => r.statement, 0.9),
        contextFrom('nfrs', 'NFR', nfrs, (n) => n.dimension + ': ' + n.target, 1),
        contextFrom(
          'constraints',
          'CONSTRAINT',
          constraints,
          (c) => c.type + ': ' + c.statement,
          1,
        ),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        { subject: 'design and market research', reason: 'cost follows the requirements and NFRs' },
      ],
    };
  },

  task(): string {
    return [
      'Estimate what this will cost to build and to run.',
      '',
      'EVERY number is either SOURCED — with a citation — or ESTIMATED with a stated basis',
      'and a confidence. There is no third option. Never fabricate vendor pricing: an',
      'unlabelled number in a cost model is indistinguishable from a real quote by the',
      'time it reaches a budget conversation.',
      '',
      'Include the AI consumption this product will cause. Serva running is a cost of the',
      'product, not a free externality.',
      '',
      'If the total exceeds a stated budget, say so. Serva escalates rather than quietly',
      'continuing.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Cost only. Do not change the architecture or select technology to make a number smaller.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const notes: string[] = [];
    const ownerDecisionIds: string[] = [];
    const at = ctx.clock.now();

    const money = (m: {
      amount: number;
      currency: string;
      basis: 'SOURCED' | 'ESTIMATED';
      basisDetail: string;
      confidence?: 'LOW' | 'MEDIUM' | 'HIGH' | undefined;
      period?: 'ONE_OFF' | 'PER_MONTH' | 'PER_YEAR' | 'PER_UNIT' | undefined;
    }) => ({
      amount: m.amount,
      currency: m.currency,
      period: m.period ?? ('ONE_OFF' as const),
      basis: m.basis,
      basisDetail: m.basisDetail,
      ...(m.confidence === undefined ? {} : { confidence: m.confidence }),
      sourceRefs: [],
    });

    const modelId = ctx.ids.next('SC-COST');
    const model = repository(ctx.store, ARTIFACT_TYPES.COST_MODEL, CostModelSchema).put(tx, {
      id: modelId,
      createdAt: at,
      ...(output.buildCost === undefined ? {} : { buildCost: money(output.buildCost) }),
      runCost: output.runCost.map((r) => ({ item: r.item, cost: money(r) })),
      assumptions: output.assumptions,
      meta: derived(ctx, COST, ['requirements', 'nfrs'], 'cost model for this product'),
    });
    ids.push(modelId);

    /* Every figure is checked for its basis, including the ones nobody looked at twice. */
    for (const entry of model.runCost) {
      const refusal = costRefusal(entry.cost);
      if (refusal !== undefined) notes.push(entry.item + ': ' + refusal);
    }
    if (model.buildCost !== undefined) {
      const refusal = costRefusal(model.buildCost);
      if (refusal !== undefined) notes.push('build cost: ' + refusal);
    }

    const budgets = repository(ctx.store, ARTIFACT_TYPES.BUDGET_STATE, BudgetStateSchema).list();
    const budget = budgets[budgets.length - 1];
    const assessmentId = ctx.ids.next('SC-CASS');
    repository(ctx.store, ARTIFACT_TYPES.COST_ASSESSMENT, CostAssessmentSchema).put(tx, {
      id: assessmentId,
      createdAt: at,
      costModelRef: { id: modelId },
      ...(budget === undefined ? {} : { budgetRef: { id: budget.id } }),
      verdict: output.exceedsBudget
        ? 'EXCEEDS_BUDGET'
        : budget === undefined
          ? 'NO_BUDGET_STATED'
          : 'WITHIN_BUDGET',
      narrative: output.narrative,
      meta: derived(ctx, COST, [modelId], 'cost against the stated budget'),
    });
    ids.push(assessmentId);

    if (output.exceedsBudget) {
      /* Exceeding budget is the owner's decision, never a silent continuation. */
      const odrId = ctx.ids.next('SC-ODR');
      repository(ctx.store, ARTIFACT_TYPES.OWNER_DECISION_REQUEST, OwnerDecisionRequestSchema).put(
        tx,
        {
          id: odrId,
          createdAt: at,
          question: 'The estimated cost exceeds the stated budget. How would you like to proceed?',
          whyServaCannotDecide:
            'Spending more than the budget is a commercial commitment. Serva can narrow the scope or change the approach, but it cannot decide to spend your money.',
          purpose: DecisionPurpose.RISK_ACCEPTANCE,
          targetRef: { id: assessmentId },
          options: [
            {
              option: 'Increase the budget',
              impact: 'the product is built as scoped',
              disposition: OptionDisposition.APPROVE,
            },
            {
              option: 'Narrow the scope',
              impact: 'Serva returns a smaller product within budget',
              disposition: OptionDisposition.INFORM,
            },
          ],
          recommendation: 'Narrow the scope',
          recommendationRationale:
            'A smaller product that ships is worth more than a larger one that runs out of money.',
          blocksWork: true,
          blockedRefs: [{ id: assessmentId }],
          state: 'OPEN',
          meta: derived(ctx, COST, [assessmentId], 'cost exceeds the stated budget'),
        },
      );
      ids.push(odrId);
      ownerDecisionIds.push(odrId);
    }

    return { artifactIds: ids, notes, ownerDecisionIds };
  },
};

/* ================================================== SC-AGENT-100 — infrastructure */

export const InfrastructureOutputSchema = z
  .object({
    environments: z
      .array(
        z
          .object({
            name: z.string().min(1),
            purpose: z.string().min(1),
            dataPolicy: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    deployment: z
      .object({
        approach: z.string().min(1),
        rolloutControl: z.string().min(1),
        downtimeExpectation: z.string().min(1),
        rationale: z.string().min(1),
      })
      .strict(),
    observability: z
      .object({
        logs: z.string().min(1),
        metrics: z.array(z.string().min(1)).default([]),
        alerts: z
          .array(
            z
              .object({
                condition: z.string().min(1),
                severity: z.string().min(1),
                response: z.string().min(1),
              })
              .strict(),
          )
          .default([]),
      })
      .strict(),
    rollback: z
      .object({ mechanism: z.string().min(1), dataImplications: z.string().min(1) })
      .strict(),
  })
  .strict();

const INFRA = 'SC-AGENT-100';

export const infrastructureDepartment: DepartmentConfig<typeof InfrastructureOutputSchema> = {
  id: 'DEPT-INFRASTRUCTURE',
  stageId: 'SC-STAGE-020',
  agentId: INFRA,
  title: 'Infrastructure Architecture',
  outputSchema: InfrastructureOutputSchema,
  outputJsonSchema: jsonSchemaFor(InfrastructureOutputSchema),
  requires: [ARTIFACT_TYPES.ARCHITECTURE_MODEL],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const arch = repository(
      ctx.store,
      ARTIFACT_TYPES.ARCHITECTURE_MODEL,
      ArchitectureModelSchema,
    ).list();
    const nfrs = repository(ctx.store, ARTIFACT_TYPES.NFR, NfrSchema).list();
    return {
      canon: [
        contextFrom('architecture', 'ARCHITECTURE', arch, (a) => a.style, 1),
        contextFrom('nfrs', 'NFR', nfrs, (n) => n.dimension + ': ' + n.target, 1),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [{ subject: 'UX and design', reason: 'not relevant to operational shape' }],
    };
  },

  task(): string {
    return [
      'Define the operational shape. Nothing is deployed here — this is design only.',
      '',
      'A simple product gets a simple topology. A nine-service cluster for forty users is',
      'infrastructure theatre: it looks professional and costs real money forever. Let the',
      'NFRs force the complexity, or do not add it.',
      '',
      'Say how a bad release stops being live, and what rollback means when the schema has',
      'already changed. That is the question nobody asks until 3am.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Operational architecture only. Deploy nothing, provision nothing.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const at = ctx.clock.now();

    const envId = ctx.ids.next('SC-ENV');
    repository(ctx.store, ARTIFACT_TYPES.ENVIRONMENT_MODEL, EnvironmentModelSchema).put(tx, {
      id: envId,
      createdAt: at,
      environments: output.environments,
      meta: derived(ctx, INFRA, ['architecture'], 'environments and their data policy'),
    });
    ids.push(envId);

    const depId = ctx.ids.next('SC-DEPL');
    repository(ctx.store, ARTIFACT_TYPES.DEPLOYMENT_STRATEGY, DeploymentStrategySchema).put(tx, {
      id: depId,
      createdAt: at,
      approach: output.deployment.approach,
      rolloutControl: output.deployment.rolloutControl,
      downtimeExpectation: output.deployment.downtimeExpectation,
      rationale: output.deployment.rationale,
      meta: derived(ctx, INFRA, [envId], 'how releases reach production'),
    });
    ids.push(depId);

    const obsId = ctx.ids.next('SC-OBS');
    repository(ctx.store, ARTIFACT_TYPES.OBSERVABILITY_SPEC, ObservabilitySpecSchema).put(tx, {
      id: obsId,
      createdAt: at,
      logs: output.observability.logs,
      metrics: output.observability.metrics,
      alerts: output.observability.alerts,
      signalsForNfrs: [],
      meta: derived(ctx, INFRA, [depId], 'what can be seen when it breaks'),
    });
    ids.push(obsId);

    const rbId = ctx.ids.next('SC-ROLL');
    repository(ctx.store, ARTIFACT_TYPES.ROLLBACK_SPEC, RollbackSpecSchema).put(tx, {
      id: rbId,
      createdAt: at,
      mechanism: output.rollback.mechanism,
      dataImplications: output.rollback.dataImplications,
      meta: derived(ctx, INFRA, [depId], 'how a bad release stops being live'),
    });
    ids.push(rbId);

    return { artifactIds: ids };
  },
};

/* ==================================================== SC-AGENT-210/211 — test design */

export const TestOutputSchema = z
  .object({
    approach: z.string().min(1),
    levels: z
      .array(
        z.enum([
          'UNIT',
          'INTEGRATION',
          'CONTRACT',
          'END_TO_END',
          'MANUAL',
          'SECURITY',
          'PERFORMANCE',
          'ACCESSIBILITY',
        ]),
      )
      .min(1),
    coverage: z
      .array(
        z
          .object({
            targetId: z.string().min(1),
            targetKind: z.string().min(1),
            level: z.enum([
              'UNIT',
              'INTEGRATION',
              'CONTRACT',
              'END_TO_END',
              'MANUAL',
              'SECURITY',
              'PERFORMANCE',
              'ACCESSIBILITY',
            ]),
            approach: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    outOfScope: z.array(z.string().min(1)).default([]),
    cases: z
      .array(
        z
          .object({
            title: z.string().min(1),
            derivedFromIds: z.array(z.string().min(1)).min(1),
            level: z.enum([
              'UNIT',
              'INTEGRATION',
              'CONTRACT',
              'END_TO_END',
              'MANUAL',
              'SECURITY',
              'PERFORMANCE',
              'ACCESSIBILITY',
            ]),
            kind: z.enum([
              'HAPPY_PATH',
              'NEGATIVE',
              'BOUNDARY',
              'PERMISSION',
              'STATE_TRANSITION',
              'ERROR_HANDLING',
              'REGRESSION',
              'BUSINESS_INVARIANT',
              'SECURITY_BEHAVIOUR',
            ]),
            steps: z.array(z.string().min(1)).min(1),
            expected: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const TEST_STRATEGIST = 'SC-AGENT-210';

export const testDepartment: DepartmentConfig<typeof TestOutputSchema> = {
  id: 'DEPT-TEST-DESIGN',
  stageId: 'SC-STAGE-030',
  agentId: TEST_STRATEGIST,
  title: 'Test Strategy and Cases',
  outputSchema: TestOutputSchema,
  outputJsonSchema: jsonSchemaFor(TestOutputSchema),
  requires: [ARTIFACT_TYPES.REQUIREMENT],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const reqs = repository(ctx.store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
    const acs = repository(
      ctx.store,
      ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
      AcceptanceCriterionSchema,
    ).list();
    const nfrs = repository(ctx.store, ARTIFACT_TYPES.NFR, NfrSchema).list();
    const rules = repository(ctx.store, ARTIFACT_TYPES.BUSINESS_RULE, BusinessRuleSchema).list();
    const machines = repository(ctx.store, ARTIFACT_TYPES.STATE_MACHINE, StateMachineSchema).list();
    const flows = repository(ctx.store, ARTIFACT_TYPES.FLOW, FlowSchema).list();

    return {
      canon: [
        contextFrom('requirements', 'REQUIREMENT', reqs, (r) => r.id + ': ' + r.statement, 1),
        contextFrom('acceptance', 'ACCEPTANCE', acs, (a) => a.id + ': ' + a.criterion, 1),
        contextFrom('nfrs', 'NFR', nfrs, (n) => n.id + ': ' + n.target, 1),
        contextFrom('rules', 'BUSINESS_RULE', rules, (r) => r.id + ': ' + r.statement, 1),
        contextFrom(
          'state-machines',
          'STATE_MACHINE',
          machines,
          (m) => m.transitions.map((t) => t.from + '->' + t.to + ' when ' + t.guard).join('; '),
          1,
        ),
        contextFrom('flows', 'FLOW', flows, (f) => f.id + ': ' + f.name, 1),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          /* SPEC §29: the independence rule that makes specification-derived cases mean something. */
          subject: 'any implementation, code or technical design',
          reason:
            'a test designer shown the implementation writes tests that pass — they describe what was built rather than what was asked for, and the gap between those two is what testing exists to find',
        },
      ],
    };
  },

  task(): string {
    return [
      'Design how everything that was promised will be verified. Testing starts here, not',
      'after the code exists.',
      '',
      'Map each requirement, acceptance criterion, NFR, business rule, state transition and',
      'flow to a verification approach. The mapping IS the artifact: a strategy that lists',
      'techniques without saying what each one covers cannot answer the only question a',
      'gate asks — is there anything we promised that nothing checks?',
      '',
      'Write cases for the happy path AND for negatives, boundaries, permissions, state',
      'transitions, error handling and business invariants.',
      '',
      'You have NOT been shown the implementation. That is deliberate: your cases must',
      'describe what was asked for, not what happens to have been built.',
      '',
      'State what you are deliberately NOT covering.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Test strategy and specification-derived cases. Do not execute tests or read implementation.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const notes: string[] = [];
    const at = ctx.clock.now();

    const traceable = new Set<string>([
      ...repository(ctx.store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).ids(),
      ...repository(
        ctx.store,
        ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
        AcceptanceCriterionSchema,
      ).ids(),
      ...repository(ctx.store, ARTIFACT_TYPES.NFR, NfrSchema).ids(),
      ...repository(ctx.store, ARTIFACT_TYPES.BUSINESS_RULE, BusinessRuleSchema).ids(),
      ...repository(ctx.store, ARTIFACT_TYPES.FLOW, FlowSchema).ids(),
    ]);

    const strategyId = ctx.ids.next('SC-TSTR');
    repository(ctx.store, ARTIFACT_TYPES.TEST_STRATEGY, TestStrategySchema).put(tx, {
      id: strategyId,
      createdAt: at,
      approach: output.approach,
      levels: output.levels,
      coverage: output.coverage
        .filter((c) => traceable.has(c.targetId))
        .map((c) => ({
          targetRef: { id: c.targetId },
          targetKind: c.targetKind,
          level: c.level,
          approach: c.approach,
        })),
      environments: [],
      outOfScope: output.outOfScope,
      meta: derived(ctx, TEST_STRATEGIST, ['requirements'], 'how each promise will be verified'),
    });
    ids.push(strategyId);

    for (const c of output.cases) {
      const real = c.derivedFromIds.filter((d) => traceable.has(d));
      if (real.length === 0) {
        notes.push('test case "' + c.title + '" derives from nothing that exists — not recorded');
        continue;
      }
      const id = ctx.ids.next('SC-TC');
      repository(ctx.store, ARTIFACT_TYPES.TEST_CASE, TestCaseSchema).put(tx, {
        id,
        createdAt: at,
        title: c.title,
        derivedFrom: real.map((d) => ({ id: d })),
        level: c.level,
        kind: c.kind,
        preconditions: [],
        steps: c.steps,
        expected: c.expected,
        /* Derived from the specification, with no implementation in context. */
        implementationInformed: false,
        meta: derived(ctx, TEST_STRATEGIST, real, 'case derived from the specification'),
      });
      ids.push(id);
    }

    return { artifactIds: ids, notes };
  },
};

/* =========================================== RISK — composed, not a new sovereign agent */

/**
 * SPEC §17: implement the risk stage WITHOUT inventing a new sovereign agent.
 *
 * Risk is an AGGREGATION of things other departments already recorded — unvalidated
 * load-bearing assumptions, residual security risks, cost overruns, unresolved owner
 * decisions. Composing it deterministically is both what the spec asks and the more
 * honest design: an agent asked to "identify the risks" produces a plausible list, while
 * this produces the actual ones, each pointing at the artifact it came from.
 *
 * `UNKNOWN` is preserved rather than rounded to LOW.
 */
export function aggregateRisks(
  ctx: DepartmentContext,
): readonly { readonly id: string; readonly statement: string }[] {
  const at = ctx.clock.now();
  const created: { id: string; statement: string }[] = [];
  const tx = ctx.store.begin();
  const risks = repository(ctx.store, ARTIFACT_TYPES.RISK, RiskSchema);

  try {
    const assumptions = repository(ctx.store, ARTIFACT_TYPES.ASSUMPTION, AssumptionSchema)
      .list()
      .filter((a) => a.loadBearing && a.status === 'UNVALIDATED');
    for (const a of assumptions) {
      const id = ctx.ids.next('SC-RISK');
      risks.put(tx, {
        id,
        createdAt: at,
        category: 'ASSUMPTION',
        statement: 'Load-bearing assumption is unvalidated: ' + a.statement,
        /* Nobody has assessed it, so the severity is UNKNOWN — not LOW. */
        severity: 'UNKNOWN',
        likelihood: 'UNKNOWN',
        basis: 'promoted from an unvalidated load-bearing assumption',
        ...(a.ifWrong === undefined
          ? {}
          : { mitigation: 'Validate before build: ' + a.validationApproach }),
        state: 'OPEN',
        relatedRefs: [{ id: a.id }],
        meta: derived(ctx, 'SC-AGENT-001', [a.id], 'risk aggregated from an assumption'),
      });
      created.push({ id, statement: a.statement });
    }

    const residual = repository(ctx.store, ARTIFACT_TYPES.RESIDUAL_RISK, ResidualRiskSchema)
      .list()
      .filter((r) => r.ownerDisposition === 'PENDING_OWNER');
    for (const r of residual) {
      const id = ctx.ids.next('SC-RISK');
      risks.put(tx, {
        id,
        createdAt: at,
        category: 'SECURITY',
        statement: r.risk,
        severity: r.severity,
        likelihood: 'UNKNOWN',
        basis: r.whyNotMitigated,
        state: 'OPEN',
        relatedRefs: [{ id: r.id }],
        meta: derived(ctx, 'SC-AGENT-001', [r.id], 'risk aggregated from a residual security risk'),
      });
      created.push({ id, statement: r.risk });
    }

    const open = repository(
      ctx.store,
      ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
      OwnerDecisionRequestSchema,
    )
      .list()
      .filter((d) => d.state === 'OPEN');
    for (const d of open) {
      const id = ctx.ids.next('SC-RISK');
      risks.put(tx, {
        id,
        createdAt: at,
        category: 'UNRESOLVED_OWNER_DECISION',
        statement: 'Unanswered owner decision: ' + d.question,
        severity: 'UNKNOWN',
        likelihood: 'UNKNOWN',
        basis: d.whyServaCannotDecide,
        state: 'OPEN',
        relatedRefs: [{ id: d.id }],
        meta: derived(ctx, 'SC-AGENT-001', [d.id], 'risk aggregated from an open owner decision'),
      });
      created.push({ id, statement: d.question });
    }

    tx.commit();
  } catch (e) {
    tx.rollback();
    throw e;
  }
  return created;
}

/**
 * The risk stage, composed rather than reasoned.
 *
 * It borrows the Orchestrator's identity because the aggregation is Serva's own act, not
 * a specialist's opinion — and `deterministic` means no model is consulted at all.
 */
export const riskDepartment: DepartmentConfig<z.ZodTypeAny> = {
  id: 'DEPT-RISK',
  stageId: 'SC-STAGE-016',
  agentId: 'SC-AGENT-001',
  title: 'Risk Aggregation',
  outputSchema: z.unknown(),
  outputJsonSchema: {},
  deterministic: true,

  buildContext(): DepartmentContextSpec {
    return { canon: [], excluded: [] };
  },
  task(): string {
    return 'Risk is aggregated from persisted canon. No model is consulted.';
  },
  scopeBoundary(): string {
    return 'Aggregate risks recorded by other departments. Invent nothing.';
  },
  persist(_tx, _output, ctx) {
    const created = aggregateRisks(ctx);
    return {
      artifactIds: created.map((r) => r.id),
      notes: [
        created.length === 0
          ? 'no open risks were aggregated'
          : String(created.length) +
            ' risk(s) aggregated from assumptions, residual security risks and open owner decisions',
      ],
    };
  },
};

export const PLANNING_DEPARTMENTS: readonly DepartmentConfig[] = Object.freeze([
  riskDepartment as DepartmentConfig,
  costDepartment as DepartmentConfig,
  infrastructureDepartment as DepartmentConfig,
  testDepartment as DepartmentConfig,
]);
