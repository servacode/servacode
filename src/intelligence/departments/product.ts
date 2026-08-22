import { z } from 'zod';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import { ClientInputSchema, ProjectGoalSchema } from '../artifacts/framing.js';
import { DiscoveryFindingsSchema, UserSegmentSchema } from '../artifacts/discovery.js';
import { CurrentAlternativeSchema } from '../artifacts/discovery.js';
import {
  FeatureSchema,
  ProductScopeSchema,
  ValidationRecommendationSchema,
} from '../artifacts/product.js';
import { OwnerDecisionRequestSchema } from '../artifacts/governance.js';
import { jsonSchemaFor } from '../execution/jsonSchema.js';
import { contextFrom, derived } from './shared.js';
import type {
  DepartmentConfig,
  DepartmentContext,
  DepartmentContextSpec,
} from '../execution/types.js';

/**
 * PRODUCT VALIDATION — SC-AGENT-020, stage 004.
 *
 * SPEC: §7, 06, 10.
 *
 * The department that is allowed to say no. `DO_NOT_BUILD` is in the schema as a
 * first-class outcome because a product function that can only ever agree is not
 * exercising judgement — and the value of running discovery at all is that some ideas
 * should be stopped before they consume a quarter.
 *
 * Every feature must trace to a goal. `outOfScope` and `nonGoals` are separate fields for
 * a reason worth keeping: "not now" and "not ever, and here is why" are different
 * decisions, and only the second stops the same idea being re-proposed indefinitely.
 */

export const ProductOutputSchema = z
  .object({
    outcome: z.enum([
      'PROCEED',
      'PROCEED_WITH_CONDITIONS',
      'PIVOT',
      'NARROW_SCOPE',
      'DO_NOT_BUILD',
    ]),
    rationale: z.string().min(1),
    conditions: z.array(z.string().min(1)).default([]),
    features: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().min(1),
            /** Index into the goals given in context. A feature with none is refused. */
            goalIndexes: z.array(z.number().int().min(0)).min(1),
            priority: z.enum(['MUST', 'SHOULD', 'COULD', 'WONT']),
          })
          .strict(),
      )
      .default([]),
    outOfScope: z
      .array(z.object({ statement: z.string().min(1), reason: z.string().min(1) }).strict())
      .default([]),
    nonGoals: z
      .array(z.object({ statement: z.string().min(1), reason: z.string().min(1) }).strict())
      .default([]),
    scopeRationale: z.string().min(1),
    /** Commercial or policy questions this department cannot answer for the owner. */
    ownerDecisions: z
      .array(
        z
          .object({
            question: z.string().min(1),
            whyServaCannotDecide: z.string().min(1),
            options: z
              .array(z.object({ option: z.string().min(1), impact: z.string().min(1) }).strict())
              .min(2),
            recommendation: z.string().min(1),
            recommendationRationale: z.string().min(1),
            blocksWork: z.boolean(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type ProductOutput = z.output<typeof ProductOutputSchema>;

export const PRODUCT_JSON_SCHEMA: Record<string, unknown> = jsonSchemaFor(ProductOutputSchema);

const AGENT = 'SC-AGENT-020';

export const productValidationDepartment: DepartmentConfig<typeof ProductOutputSchema> = {
  id: 'DEPT-PRODUCT-VALIDATION',
  stageId: 'SC-STAGE-004',
  agentId: AGENT,
  title: 'Product Validation',
  outputSchema: ProductOutputSchema,
  outputJsonSchema: PRODUCT_JSON_SCHEMA,
  requires: [ARTIFACT_TYPES.PROJECT_GOAL, ARTIFACT_TYPES.DISCOVERY_FINDINGS],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const goals = repository(ctx.store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).list();
    const findings = repository(
      ctx.store,
      ARTIFACT_TYPES.DISCOVERY_FINDINGS,
      DiscoveryFindingsSchema,
    ).list();
    const segments = repository(ctx.store, ARTIFACT_TYPES.USER_SEGMENT, UserSegmentSchema).list();
    const alts = repository(
      ctx.store,
      ARTIFACT_TYPES.CURRENT_ALTERNATIVE,
      CurrentAlternativeSchema,
    ).list();
    const input = repository(ctx.store, ARTIFACT_TYPES.CLIENT_INPUT, ClientInputSchema).list();

    const canon = [
      contextFrom('client-input', 'INTAKE', input, (i) => 'success: ' + i.successDefinition, 0.8),
      /*
       * Goals are indexed so the model can reference them positionally. Asking it to echo
       * generated ids invites hallucinated ones; an index it can only get wrong by
       * pointing at a real different goal is safer and checkable.
       */
      contextFrom(
        'goals',
        'GOAL',
        goals.map((g, i) => ({ ...g, id: '#' + String(i) })),
        (g) => g.statement + ' (success: ' + g.successIndicator + ')',
        1,
      ),
      contextFrom('discovery', 'FINDINGS', findings, (f) => f.summary, 0.9),
      contextFrom('segments', 'SEGMENT', segments, (s) => s.name + ': ' + s.description, 0.8),
      contextFrom(
        'alternatives',
        'ALTERNATIVE',
        alts,
        (a) => a.kind + ' — ' + a.description + ' (used because: ' + a.whyUsed + ')',
        0.9,
      ),
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    return {
      canon,
      excluded: [
        {
          subject: 'architecture, technology, data model, design system',
          reason:
            'product validation decides WHETHER and WHAT, never HOW; solution detail biases scope toward what is convenient to build',
        },
      ],
    };
  },

  task(): string {
    return [
      'Decide whether this product should be built, and what it should contain.',
      '',
      'You may legitimately conclude DO_NOT_BUILD, PIVOT or NARROW_SCOPE. Those are',
      'correct company results, not failures. An idea that loses to the current',
      'alternatives should be stopped now rather than after a quarter of engineering.',
      '',
      'Every feature you propose must trace to at least one project goal, by index. If a',
      'feature is interesting but serves no stated goal, it is scope creep — put it in',
      'outOfScope with the reason, or raise it as a proposal later.',
      '',
      'Say what is explicitly OUT of scope and what is a NON-GOAL. "Not now" and "not',
      'ever, and here is why" are different, and the second is what stops the same idea',
      'returning every quarter.',
      '',
      'Raise ownerDecisions only for commercial intent, budget, business policy, legal',
      'commitments or contradictory goals — never for technical choices.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Decide scope and viability. Do not design the solution or select technology.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const at = ctx.clock.now();
    const goals = repository(ctx.store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).list();

    const recId = ctx.ids.next('SC-VREC');
    repository(
      ctx.store,
      ARTIFACT_TYPES.VALIDATION_RECOMMENDATION,
      ValidationRecommendationSchema,
    ).put(tx, {
      id: recId,
      createdAt: at,
      outcome: output.outcome,
      rationale: output.rationale,
      conditions: output.conditions,
      evidenceRefs: [],
      meta: derived(ctx, AGENT, ['discovery'], 'product validation over discovery findings'),
    });
    ids.push(recId);

    const featureRepo = repository(ctx.store, ARTIFACT_TYPES.FEATURE, FeatureSchema);
    const featureIds: string[] = [];
    const notes: string[] = [];

    for (const f of output.features) {
      /*
       * A goal index pointing at nothing is dropped rather than stored. A feature whose
       * justification does not resolve is an orphan, and storing it would only defer the
       * finding to the traceability checker.
       */
      const refs = f.goalIndexes
        .map((i) => goals[i])
        .filter((g): g is NonNullable<typeof g> => g !== undefined)
        .map((g) => ({ id: g.id }));
      if (refs.length === 0) {
        notes.push(
          'feature "' + f.name + '" was not recorded: its goal references resolve to nothing',
        );
        continue;
      }
      const id = ctx.ids.next('SC-FEAT');
      featureRepo.put(tx, {
        id,
        createdAt: at,
        name: f.name,
        description: f.description,
        goalRefs: refs,
        requirementRefs: [],
        state: 'PROPOSED',
        priority: f.priority,
        meta: derived(
          ctx,
          AGENT,
          refs.map((r) => r.id),
          'feature proposed to serve these goals',
        ),
      });
      featureIds.push(id);
      ids.push(id);
    }

    if (featureIds.length > 0) {
      const scopeId = ctx.ids.next('SC-SCOPE');
      repository(ctx.store, ARTIFACT_TYPES.PRODUCT_SCOPE, ProductScopeSchema).put(tx, {
        id: scopeId,
        createdAt: at,
        inScope: featureIds.map((id) => ({ id })),
        outOfScope: output.outOfScope,
        nonGoals: output.nonGoals,
        rationale: output.scopeRationale,
        meta: derived(ctx, AGENT, featureIds, 'scope boundary for this release'),
      });
      ids.push(scopeId);
    }

    /* --- owner decisions become control flow, not advice --- */
    const decisions = repository(
      ctx.store,
      ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
      OwnerDecisionRequestSchema,
    );
    const ownerDecisionIds: string[] = [];
    for (const d of output.ownerDecisions) {
      const id = ctx.ids.next('SC-ODR');
      decisions.put(tx, {
        id,
        createdAt: at,
        question: d.question,
        whyServaCannotDecide: d.whyServaCannotDecide,
        options: d.options,
        recommendation: d.recommendation,
        recommendationRationale: d.recommendationRationale,
        blocksWork: d.blocksWork,
        blockedRefs: [],
        state: 'OPEN',
        meta: derived(ctx, AGENT, [recId], 'a decision that is the owner’s authority'),
      });
      ids.push(id);
      if (d.blocksWork) ownerDecisionIds.push(id);
    }

    if (output.outcome === 'DO_NOT_BUILD') {
      notes.push(
        'product validation concluded DO_NOT_BUILD: ' +
          output.rationale +
          ' — this is a company result, not an error',
      );
    }

    return { artifactIds: ids, ownerDecisionIds, notes };
  },
};
