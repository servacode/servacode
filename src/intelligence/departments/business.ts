import { z } from 'zod';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import { ProjectGoalSchema } from '../artifacts/framing.js';
import { FeatureSchema } from '../artifacts/product.js';
import {
  ActorSchema,
  BusinessRuleSchema,
  FinancialLogicSchema,
  GlossarySchema,
  ProcessModelSchema,
  RoleSchema,
  RuleAuthority,
  StateMachineSchema,
  financialRefusal,
} from '../artifacts/business.js';
import { OwnerDecisionRequestSchema } from '../artifacts/governance.js';
import { jsonSchemaFor } from '../execution/jsonSchema.js';
import { contextFrom, derived } from './shared.js';
import type {
  DepartmentConfig,
  DepartmentContext,
  DepartmentContextSpec,
} from '../execution/types.js';

/**
 * BUSINESS ANALYSIS — SC-AGENT-040, stage 010.
 *
 * SPEC: §8, 06.
 *
 * The rule this department exists to enforce: no important business behaviour may remain
 * implicit for Engineering to invent. A developer who has to guess what happens when a
 * refund arrives after settlement will guess something reasonable, ship it, and the
 * company will discover its own policy months later by reading the code.
 *
 * Money is the one area where a plausible default is never acceptable. Anything financial
 * that is not owner-confirmed or legally established becomes an OwnerDecisionRequest — and
 * because owner decisions are control flow, that genuinely stops the lifecycle rather than
 * leaving a note somebody might read.
 */

export const BusinessOutputSchema = z
  .object({
    actors: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().min(1),
            permissions: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .min(1),
    rules: z
      .array(
        z
          .object({
            statement: z.string().min(1),
            rationale: z.string().min(1),
            /** OWNER_CONFIRMED only where the owner genuinely said it. */
            authority: z.enum(['OWNER_CONFIRMED', 'LEGAL_OR_REGULATORY', 'DERIVED', 'PROPOSED']),
            appliesTo: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .default([]),
    processes: z
      .array(
        z
          .object({
            name: z.string().min(1),
            steps: z
              .array(z.object({ action: z.string().min(1), actor: z.string().min(1) }).strict())
              .min(1),
            exceptions: z
              .array(z.object({ when: z.string().min(1), then: z.string().min(1) }).strict())
              .default([]),
          })
          .strict(),
      )
      .default([]),
    stateMachines: z
      .array(
        z
          .object({
            entity: z.string().min(1),
            states: z.array(z.string().min(1)).min(2),
            initialState: z.string().min(1),
            terminalStates: z.array(z.string().min(1)).default([]),
            transitions: z
              .array(
                z
                  .object({
                    from: z.string().min(1),
                    to: z.string().min(1),
                    trigger: z.string().min(1),
                    /** Required. "Order can go to SHIPPED" is not a specification. */
                    guard: z.string().min(1),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .default([]),
    glossary: z
      .array(z.object({ term: z.string().min(1), definition: z.string().min(1) }).strict())
      .default([]),
    financial: z
      .array(
        z
          .object({
            area: z.enum([
              'FEES',
              'COMMISSION',
              'TAX',
              'WALLET',
              'REFUND',
              'SETTLEMENT',
              'PRICING',
              'PAYOUT',
            ]),
            statement: z.string().min(1),
            authority: z.enum(['OWNER_CONFIRMED', 'LEGAL_OR_REGULATORY', 'DERIVED', 'PROPOSED']),
            workedExample: z.string().min(1).optional(),
          })
          .strict(),
      )
      .default([]),
    contradictions: z.array(z.object({ explanation: z.string().min(1) }).strict()).default([]),
  })
  .strict();
export type BusinessOutput = z.output<typeof BusinessOutputSchema>;

export const BUSINESS_JSON_SCHEMA: Record<string, unknown> = jsonSchemaFor(BusinessOutputSchema);

const AGENT = 'SC-AGENT-040';

export const businessAnalysisDepartment: DepartmentConfig<typeof BusinessOutputSchema> = {
  id: 'DEPT-BUSINESS-ANALYSIS',
  stageId: 'SC-STAGE-010',
  agentId: AGENT,
  title: 'Business Analysis',
  outputSchema: BusinessOutputSchema,
  outputJsonSchema: BUSINESS_JSON_SCHEMA,
  requires: [ARTIFACT_TYPES.FEATURE],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const features = repository(ctx.store, ARTIFACT_TYPES.FEATURE, FeatureSchema).list();
    const goals = repository(ctx.store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).list();
    const canon = [
      contextFrom('features', 'FEATURE', features, (f) => f.name + ': ' + f.description, 1),
      contextFrom('goals', 'GOAL', goals, (g) => g.statement, 0.7),
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);
    return {
      canon,
      excluded: [
        {
          subject: 'architecture, data model, UI, implementation',
          reason:
            'business rules are about what the business requires, not how software will satisfy it',
        },
      ],
    };
  },

  task(): string {
    return [
      'Make the business behaviour explicit so Engineering never has to invent it.',
      '',
      'Every stateful entity needs its states, its initial state, and its transitions —',
      'each transition with a GUARD. "An order can move to SHIPPED" is not a',
      'specification; "…when payment has cleared and stock is reserved" is. Engineering',
      'cannot invent the guard safely and QA cannot test a precondition nobody wrote.',
      '',
      'Give every rule a rationale. A rule without one cannot be safely changed later,',
      'because the next person cannot tell a legal obligation from a preference.',
      '',
      'CRITICAL — money. Fees, commissions, tax, wallet behaviour, refunds and settlement',
      'must never be invented. Mark financial logic OWNER_CONFIRMED only if the owner',
      'actually stated it, or LEGAL_OR_REGULATORY if statute fixes it. If neither is true,',
      'mark it PROPOSED and Serva will escalate it to the owner rather than guess. A',
      'reasonable-looking 2.5% commission invented here is indistinguishable from a real',
      'one by the time it is charged to a customer.',
      '',
      'Report contradictions between rules. Do not resolve them: which one the business',
      'means is the owner’s call.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Model business behaviour. Do not design software, data structures or interfaces.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const at = ctx.clock.now();
    const notes: string[] = [];
    const ownerDecisionIds: string[] = [];

    const actors = repository(ctx.store, ARTIFACT_TYPES.ACTOR, ActorSchema);
    const actorIds = new Map<string, string>();
    for (const a of output.actors) {
      const id = ctx.ids.next('SC-ACTOR');
      actors.put(tx, {
        id,
        createdAt: at,
        name: a.name,
        description: a.description,
        permissionsBusinessTerms: a.permissions,
        meta: derived(ctx, AGENT, ['features'], 'actor identified from the product scope'),
      });
      actorIds.set(a.name, id);
      ids.push(id);
    }

    const roles = repository(ctx.store, ARTIFACT_TYPES.ROLE, RoleSchema);
    for (const [name, actorId] of actorIds) {
      const id = ctx.ids.next('SC-ROLE');
      roles.put(tx, {
        id,
        createdAt: at,
        name: name,
        description: 'role held by ' + name,
        actorRefs: [{ id: actorId }],
        permissionsBusinessTerms: [],
        meta: derived(ctx, AGENT, [actorId], 'role derived from the actor'),
      });
      ids.push(id);
    }

    const rules = repository(ctx.store, ARTIFACT_TYPES.BUSINESS_RULE, BusinessRuleSchema);
    for (const r of output.rules) {
      const id = ctx.ids.next('SC-BR');
      rules.put(tx, {
        id,
        createdAt: at,
        statement: r.statement,
        rationale: r.rationale,
        authority: r.authority,
        ownerConfirmed: r.authority === RuleAuthority.OWNER_CONFIRMED,
        appliesTo: r.appliesTo,
        meta: derived(ctx, AGENT, ['features'], 'business rule required by the product scope'),
      });
      ids.push(id);
    }

    const processes = repository(ctx.store, ARTIFACT_TYPES.PROCESS_MODEL, ProcessModelSchema);
    for (const p of output.processes) {
      const id = ctx.ids.next('SC-PROC');
      processes.put(tx, {
        id,
        createdAt: at,
        name: p.name,
        steps: p.steps.map((s, i) => ({
          order: i + 1,
          action: s.action,
          ...(actorIds.has(s.actor) ? { actorRef: { id: actorIds.get(s.actor) as string } } : {}),
        })),
        exceptions: p.exceptions,
        meta: derived(ctx, AGENT, ['features'], 'process required by the product scope'),
      });
      ids.push(id);
    }

    const machines = repository(ctx.store, ARTIFACT_TYPES.STATE_MACHINE, StateMachineSchema);
    for (const m of output.stateMachines) {
      const id = ctx.ids.next('SC-SM');
      machines.put(tx, {
        id,
        createdAt: at,
        entityRef: m.entity,
        states: m.states,
        initialState: m.initialState,
        terminalStates: m.terminalStates,
        transitions: m.transitions.map((t) => ({ ...t, ruleRefs: [] })),
        meta: derived(ctx, AGENT, ['features'], 'lifecycle of ' + m.entity),
      });
      ids.push(id);
    }

    if (output.glossary.length > 0) {
      const id = ctx.ids.next('SC-GLOS');
      repository(ctx.store, ARTIFACT_TYPES.GLOSSARY, GlossarySchema).put(tx, {
        id,
        createdAt: at,
        terms: output.glossary,
        meta: derived(ctx, AGENT, ['features'], 'one meaning per term'),
      });
      ids.push(id);
    }

    /* --- money: escalate rather than invent --- */
    const financial = repository(ctx.store, ARTIFACT_TYPES.FINANCIAL_LOGIC, FinancialLogicSchema);
    const decisions = repository(
      ctx.store,
      ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
      OwnerDecisionRequestSchema,
    );

    for (const f of output.financial) {
      const id = ctx.ids.next('SC-FIN');
      const stored = financial.put(tx, {
        id,
        createdAt: at,
        area: f.area,
        statement: f.statement,
        authority: f.authority,
        ...(f.workedExample === undefined ? {} : { workedExample: f.workedExample }),
        meta: derived(ctx, AGENT, ['features'], 'financial logic required by the product'),
      });
      ids.push(id);

      const refusal = financialRefusal(stored);
      if (refusal === undefined) continue;

      /*
       * Not a warning. A financial rule nobody with the authority to set it has set
       * becomes a blocking owner decision, and the orchestrator stops here.
       */
      const odrId = ctx.ids.next('SC-ODR');
      decisions.put(tx, {
        id: odrId,
        createdAt: at,
        question:
          'How should ' +
          f.area.toLowerCase() +
          ' work? Serva has drafted: "' +
          f.statement +
          '" but nobody with the authority to set it has confirmed it.',
        whyServaCannotDecide:
          'This determines what customers are charged and what the business earns. Serva does not invent money rules, and a plausible default here becomes a real charge.',
        options: [
          {
            option: 'Confirm the drafted rule as stated',
            impact: 'the product implements it as written',
          },
          {
            option: 'State a different rule',
            impact: 'Serva records yours and Engineering implements that',
          },
        ],
        recommendation: 'Confirm or correct the drafted rule',
        recommendationRationale:
          'The draft is Serva’s reading of the product, offered so the decision is quick — not because Serva has the authority to make it.',
        blocksWork: true,
        blockedRefs: [{ id }],
        state: 'OPEN',
        meta: derived(ctx, AGENT, [id], refusal),
      });
      ids.push(odrId);
      ownerDecisionIds.push(odrId);
      notes.push(refusal);
    }

    for (const c of output.contradictions) {
      notes.push('rule contradiction reported for owner resolution: ' + c.explanation);
    }

    return { artifactIds: ids, ownerDecisionIds, notes };
  },
};
