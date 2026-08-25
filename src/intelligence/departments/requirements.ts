import { z } from 'zod';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import { ProjectGoalSchema } from '../artifacts/framing.js';
import { FeatureSchema } from '../artifacts/product.js';
import { BusinessRuleSchema, StateMachineSchema } from '../artifacts/business.js';
import {
  AcceptanceCriterionSchema,
  NfrSchema,
  RequirementSchema,
  mustHasAcceptanceRefusal,
  nfrMeasurabilityRefusal,
} from '../artifacts/requirements.js';
import { jsonSchemaFor } from '../execution/jsonSchema.js';
import { contextFrom, currentSubjects, derived } from './shared.js';
import { reviewJudgement } from './verdictSupport.js';
import type {
  DepartmentConfig,
  DepartmentContext,
  DepartmentContextSpec,
} from '../execution/types.js';

/**
 * REQUIREMENTS ENGINEERING — stage 011.
 *
 * SPEC: §9, 06. Three agents, three runs, and the third must not be either of the first
 * two.
 *
 *   SC-AGENT-050  writes functional requirements and acceptance criteria
 *   SC-AGENT-051  writes NFRs with measurable targets
 *   SC-AGENT-052  verifies the result, and did not write any of it
 *
 * The independence is the whole mechanism. An author checking their own requirements
 * finds them clear, complete and testable — not from dishonesty, but because the meaning
 * they intended is the meaning they read. `independentOf` is enforced by the runner
 * before dispatch.
 */

/* ------------------------------------------------------------------ SC-AGENT-050 */

export const RequirementsOutputSchema = z
  .object({
    requirements: z
      .array(
        z
          .object({
            statement: z.string().min(1),
            kind: z.enum(['FUNCTIONAL', 'CONSTRAINT', 'DATA', 'INTERFACE']),
            priority: z.enum(['MUST', 'SHOULD', 'COULD', 'WONT']),
            rationale: z.string().min(1),
            /** Index into the features given in context. */
            featureIndex: z.number().int().min(0),
            acceptanceCriteria: z
              .array(
                z
                  .object({
                    criterion: z.string().min(1),
                    verificationMethod: z.enum([
                      'AUTOMATED_TEST',
                      'MANUAL_TEST',
                      'INSPECTION',
                      'ANALYSIS',
                      'DEMONSTRATION',
                      'MEASUREMENT',
                    ]),
                  })
                  .strict(),
              )
              .default([]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type RequirementsOutput = z.output<typeof RequirementsOutputSchema>;

const REQ_AGENT = 'SC-AGENT-050';

export const requirementsDepartment: DepartmentConfig<typeof RequirementsOutputSchema> = {
  id: 'DEPT-REQUIREMENTS',
  stageId: 'SC-STAGE-011',
  agentId: REQ_AGENT,
  title: 'Requirements Engineering',
  produces: [ARTIFACT_TYPES.REQUIREMENT, ARTIFACT_TYPES.ACCEPTANCE_CRITERION],
  outputSchema: RequirementsOutputSchema,
  outputJsonSchema: jsonSchemaFor(RequirementsOutputSchema),
  requires: [ARTIFACT_TYPES.FEATURE],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const features = repository(ctx.store, ARTIFACT_TYPES.FEATURE, FeatureSchema).list();
    const rules = repository(ctx.store, ARTIFACT_TYPES.BUSINESS_RULE, BusinessRuleSchema).list();
    const machines = repository(ctx.store, ARTIFACT_TYPES.STATE_MACHINE, StateMachineSchema).list();
    const canon = [
      contextFrom(
        'features',
        'FEATURE',
        features.map((f, i) => ({ ...f, id: '#' + String(i) })),
        (f) => f.name + ': ' + f.description,
        1,
      ),
      contextFrom('rules', 'BUSINESS_RULE', rules, (r) => r.statement, 0.95),
      contextFrom(
        'state-machines',
        'STATE_MACHINE',
        machines,
        (m) =>
          m.entityRef +
          ': ' +
          m.transitions.map((t) => t.from + '->' + t.to + ' when ' + t.guard).join('; '),
        0.9,
      ),
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);
    return {
      canon,
      excluded: [
        {
          subject: 'architecture, technology, UI design',
          reason: 'requirements state WHAT is required; solution detail belongs to later stages',
        },
      ],
    };
  },

  task(): string {
    return [
      'Write atomic, testable requirements for the features in context.',
      '',
      'Every requirement is ONE statement. If it contains "and" joining two behaviours,',
      'it is two requirements, and a test can pass for one while failing the other.',
      '',
      'Every MUST requirement needs at least one acceptance criterion with a verification',
      'method. A MUST nobody can check is not a requirement, it is an intention.',
      '',
      'Reference the feature it serves by index. A requirement that traces to nothing is',
      'either scope creep or a lost rationale.',
      '',
      'Do not write non-functional requirements here — targets for performance, security,',
      'availability and the rest are a separate specialism and a separate run.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Functional requirements and acceptance criteria only. No NFRs, no design, no technology.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const at = ctx.clock.now();
    const features = repository(ctx.store, ARTIFACT_TYPES.FEATURE, FeatureSchema).list();
    const reqs = repository(ctx.store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema);
    const acs = repository(
      ctx.store,
      ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
      AcceptanceCriterionSchema,
    );
    const notes: string[] = [];

    for (const r of output.requirements) {
      const feature = features[r.featureIndex];
      const id = ctx.ids.next('SC-REQ');
      reqs.put(tx, {
        id,
        createdAt: at,
        statement: r.statement,
        kind: r.kind,
        priority: r.priority,
        rationale: r.rationale,
        tracesTo: feature === undefined ? [] : [{ id: feature.id }],
        ...(feature === undefined ? {} : { featureRef: { id: feature.id } }),
        meta: derived(
          ctx,
          REQ_AGENT,
          feature === undefined ? ['features'] : [feature.id],
          'requirement derived from the feature it serves',
        ),
      });
      ids.push(id);
      if (feature === undefined) {
        notes.push(
          'requirement ' +
            id +
            ' references feature index ' +
            String(r.featureIndex) +
            ', which does not exist',
        );
      }

      for (const ac of r.acceptanceCriteria) {
        const acId = ctx.ids.next('SC-AC');
        acs.put(tx, {
          id: acId,
          createdAt: at,
          requirementRef: { id },
          criterion: ac.criterion,
          verificationMethod: ac.verificationMethod,
          meta: derived(ctx, REQ_AGENT, [id], 'acceptance criterion for this requirement'),
        });
        ids.push(acId);
      }
    }

    return { artifactIds: ids, notes };
  },
};

/* ------------------------------------------------------------------ SC-AGENT-051 */

export const NfrOutputSchema = z
  .object({
    nfrs: z
      .array(
        z
          .object({
            dimension: z.enum([
              'PERFORMANCE',
              'AVAILABILITY',
              'SCALABILITY',
              'SECURITY',
              'PRIVACY',
              'ACCESSIBILITY',
              'USABILITY',
              'MAINTAINABILITY',
              'OPERABILITY',
              'COST',
              'COMPATIBILITY',
              'RELIABILITY',
            ]),
            statement: z.string().min(1),
            /** Must contain a number or name a standard. "fast" is refused. */
            target: z.string().min(1),
            measurementMethod: z.string().min(1),
            applicability: z.string().min(1),
            rationale: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type NfrOutput = z.output<typeof NfrOutputSchema>;

const NFR_AGENT = 'SC-AGENT-051';

export const nfrDepartment: DepartmentConfig<typeof NfrOutputSchema> = {
  id: 'DEPT-NFR',
  stageId: 'SC-STAGE-011',
  agentId: NFR_AGENT,
  title: 'NFR Specification',
  produces: [ARTIFACT_TYPES.NFR],
  outputSchema: NfrOutputSchema,
  outputJsonSchema: jsonSchemaFor(NfrOutputSchema),
  requires: [ARTIFACT_TYPES.REQUIREMENT],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const reqs = repository(ctx.store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
    const goals = repository(ctx.store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).list();
    const canon = [
      contextFrom('requirements', 'REQUIREMENT', reqs, (r) => r.statement, 1),
      contextFrom('goals', 'GOAL', goals, (g) => g.statement, 0.8),
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);
    return {
      canon,
      excluded: [
        {
          subject: 'architecture and technology',
          reason:
            'an NFR states the target; choosing a mechanism to meet it is the architect’s decision, and stating both here would prejudge it',
        },
      ],
    };
  },

  task(): string {
    return [
      'Specify non-functional requirements with MEASURABLE targets.',
      '',
      'Every target must contain a number or name a published standard. "Fast", "secure",',
      '"scalable" and "user friendly" are not targets — they cannot be tested, cannot be',
      'designed against, and cannot be failed, which means they will be declared satisfied',
      'by whoever is under the most schedule pressure.',
      '',
      'Good: "p95 response under 200ms for the order list at 500 concurrent users",',
      '"WCAG 2.2 AA", "99.9% monthly availability", "restore from backup within 4 hours".',
      '',
      'Each NFR needs a measurement method and an applicability statement. An NFR that',
      'applies everywhere usually applies nowhere.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Non-functional requirements only. Do not restate functional behaviour or choose mechanisms.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const at = ctx.clock.now();
    const nfrs = repository(ctx.store, ARTIFACT_TYPES.NFR, NfrSchema);
    const notes: string[] = [];

    for (const n of output.nfrs) {
      const id = ctx.ids.next('SC-NFR');
      const stored = nfrs.put(tx, {
        id,
        createdAt: at,
        dimension: n.dimension,
        statement: n.statement,
        target: n.target,
        measurementMethod: n.measurementMethod,
        applicability: n.applicability,
        rationale: n.rationale,
        meta: derived(ctx, NFR_AGENT, ['requirements'], 'quality target for this product'),
      });
      ids.push(id);
      /*
       * Stored either way, then flagged. An unmeasurable NFR that vanished would leave
       * the gap invisible; recorded with a finding, the verifier and the gate can both
       * see exactly which target is not a target.
       */
      const refusal = nfrMeasurabilityRefusal(stored);
      if (refusal !== undefined) notes.push(refusal);
    }

    return { artifactIds: ids, notes };
  },
};

/* ------------------------------------------------------------------ SC-AGENT-052 */

export const VerifierOutputSchema = z
  .object({
    verdict: z.enum(['ACCEPTABLE', 'NOT_ACCEPTABLE']),
    summary: z.string().min(1),
    findings: z
      .array(
        z
          .object({
            severity: z.enum(['BLOCKING', 'MAJOR', 'ADVISORY']),
            subject: z.string().min(1),
            statement: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type VerifierOutput = z.output<typeof VerifierOutputSchema>;

const VERIFIER_AGENT = 'SC-AGENT-052';

export const requirementsVerifierDepartment: DepartmentConfig<typeof VerifierOutputSchema> = {
  id: 'DEPT-REQUIREMENTS-VERIFIER',
  stageId: 'SC-STAGE-011',
  agentId: VERIFIER_AGENT,
  title: 'Requirements Quality Verification',
  produces: [],
  outputSchema: VerifierOutputSchema,
  outputJsonSchema: jsonSchemaFor(VerifierOutputSchema),
  requires: [ARTIFACT_TYPES.REQUIREMENT],
  /** SPEC §40: the verifier is not the author. Enforced by the runner before dispatch. */
  independentOf: [REQ_AGENT, NFR_AGENT],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const reqs = repository(ctx.store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
    const acs = repository(
      ctx.store,
      ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
      AcceptanceCriterionSchema,
    ).list();
    const nfrs = repository(ctx.store, ARTIFACT_TYPES.NFR, NfrSchema).list();
    const goals = repository(ctx.store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).list();

    const canon = [
      contextFrom(
        'requirements',
        'REQUIREMENT',
        reqs,
        (r) => '[' + r.priority + '] ' + r.statement,
        1,
      ),
      contextFrom(
        'acceptance',
        'ACCEPTANCE',
        acs,
        (a) => a.requirementRef.id + ': ' + a.criterion,
        1,
      ),
      contextFrom('nfrs', 'NFR', nfrs, (n) => n.dimension + ' target: ' + n.target, 1),
      contextFrom('goals', 'GOAL', goals, (g) => g.statement, 0.9),
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    return {
      canon,
      excluded: [
        {
          subject: 'the authors’ reasoning and drafts',
          reason:
            'the verifier judges the requirements as written; the author’s explanation of what they meant is exactly what an independent reader will not have',
        },
      ],
    };
  },

  task(): string {
    return [
      'Verify the requirements you have been given. You did not write them.',
      '',
      'Check each one for: atomicity (one behaviour per statement), testability, a stated',
      'source or rationale, and contradiction with any other requirement.',
      '',
      'Check that every MUST has an acceptance criterion, that every NFR target is',
      'measurable rather than an adjective, and that every project goal is either covered',
      'or explicitly deferred.',
      '',
      'Report findings with severity. Return NOT_ACCEPTABLE if anything BLOCKING remains —',
      'a verifier that always accepts is a formality, and the gate is relying on you.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Verify only. Do not rewrite requirements or add new ones.';
  },

  persist(_tx, output, ctx) {
    /*
     * The verifier writes no canon. Its verdict is EVIDENCE for the gate, and letting it
     * edit the requirements it judges would make it an author with an opinion — which is
     * the independence this department exists to preserve.
     */
    const notes: string[] = [output.summary];

    /* Serva's own deterministic checks run alongside the judgement, never instead of it. */
    const reqs = repository(ctx.store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
    const acs = repository(
      ctx.store,
      ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
      AcceptanceCriterionSchema,
    ).list();
    const nfrs = repository(ctx.store, ARTIFACT_TYPES.NFR, NfrSchema).list();

    for (const r of reqs) {
      const refusal = mustHasAcceptanceRefusal(r, acs);
      if (refusal !== undefined) notes.push('MEASURED: ' + refusal);
    }
    for (const n of nfrs) {
      const refusal = nfrMeasurabilityRefusal(n);
      if (refusal !== undefined) notes.push('MEASURED: ' + refusal);
    }
    for (const f of output.findings) {
      notes.push('JUDGED[' + f.severity + '] ' + f.subject + ': ' + f.statement);
    }
    if (output.verdict === 'NOT_ACCEPTABLE') {
      notes.push('VERDICT: NOT_ACCEPTABLE');
    }

    /*
     * The verdict travels to the gate as an attributable judgement, not as prose in a
     * diagnostic. RQ-4 is a VERIFIER_RESULT criterion; without this it is INDETERMINATE
     * and the gate is NOT_VERIFIED — which is the correct outcome when nobody independent
     * has actually looked.
     */
    return {
      artifactIds: [],
      notes,
      judgements: [
        {
          criterionRef: 'RQ-4',
          met: reviewJudgement(
            output.verdict,
            currentSubjects(ctx.store, [
              ARTIFACT_TYPES.REQUIREMENT,
              ARTIFACT_TYPES.NFR,
              ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
            ]),
          ),
          by: VERIFIER_AGENT,
          note: output.summary,
          subjects: currentSubjects(ctx.store, [
            ARTIFACT_TYPES.REQUIREMENT,
            ARTIFACT_TYPES.NFR,
            ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
          ]),
        },
      ],
    };
  },
};
