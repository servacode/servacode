import { z } from 'zod';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import {
  ClientInputSchema,
  ConstraintSchema,
  IdeaSchema,
  OpenQuestionSchema,
  ProjectGoalSchema,
} from '../artifacts/framing.js';
import { jsonSchemaFor } from '../execution/jsonSchema.js';
import { contextFrom, derived, ownerStated } from './shared.js';
import type {
  DepartmentConfig,
  DepartmentContext,
  DepartmentContextSpec,
} from '../execution/types.js';

/**
 * INTAKE — SC-AGENT-020, stage 002.
 *
 * SPEC: §5, 03 §2.
 *
 * Turns "I want an app that solves X for Y" into the framing artifacts everything else
 * traces back to. The Idea itself is written by the caller and kept verbatim; this
 * department produces the INTERPRETATION, and the two are stored separately so a later
 * reader can check one against the other rather than against a summary.
 *
 * The questions it may raise are constrained deliberately. §5 draws the line clearly:
 * "how does the business earn money" is an owner question; "PostgreSQL or MySQL" is not.
 * `questionKindRefusal` enforces it, because the temptation to ask the owner a technical
 * question is strongest exactly when the answer is genuinely uncertain — and that is
 * precisely when Serva is supposed to decide.
 */

export const IntakeOutputSchema = z
  .object({
    problem: z.string().min(1),
    audience: z.string().min(1),
    successDefinition: z.string().min(1),
    commercialRequirements: z.array(z.string().min(1)).default([]),
    goals: z
      .array(
        z
          .object({
            statement: z.string().min(1),
            successIndicator: z.string().min(1),
            priority: z.enum(['MUST', 'SHOULD', 'COULD', 'WONT']),
          })
          .strict(),
      )
      .min(1),
    constraints: z
      .array(
        z
          .object({
            type: z.enum(['TECHNICAL', 'BUSINESS', 'LEGAL', 'RESOURCE', 'TIME', 'EXISTING_SYSTEM']),
            statement: z.string().min(1),
            negotiable: z.boolean(),
          })
          .strict(),
      )
      .default([]),
    /** Only things that are genuinely the owner's to answer. */
    openQuestions: z
      .array(
        z
          .object({
            question: z.string().min(1),
            whyOwnerMustAnswer: z.string().min(1),
            blocking: z.boolean(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type IntakeOutput = z.output<typeof IntakeOutputSchema>;

export const INTAKE_JSON_SCHEMA: Record<string, unknown> = jsonSchemaFor(IntakeOutputSchema);

/**
 * Technical choices dressed up as owner questions.
 *
 * Blunt, and intentionally so. Asking the owner which database to use is not neutral — it
 * transfers a decision Serva is accountable for onto someone who hired Serva precisely so
 * they would not have to make it.
 */
const SERVA_DECISIONS =
  /\b(postgres|mysql|sqlite|mongo|redis|kafka|framework|react|vue|angular|tailwind|css|rest|graphql|microservice|monolith|kubernetes|docker|typescript|python|rust|golang|border[- ]?radius|colou?r palette|font|api design|orm)\b/i;

export function questionKindRefusal(question: string): string | undefined {
  if (SERVA_DECISIONS.test(question)) {
    return (
      'this is a Serva decision, not an owner decision: "' +
      question +
      '". The owner defines the problem and the business goals; Serva determines how the product is engineered.'
    );
  }
  return undefined;
}

const AGENT = 'SC-AGENT-020';

export const intakeDepartment: DepartmentConfig<typeof IntakeOutputSchema> = {
  id: 'DEPT-INTAKE',
  stageId: 'SC-STAGE-002',
  agentId: AGENT,
  title: 'Intake',
  produces: [
    ARTIFACT_TYPES.CLIENT_INPUT,
    ARTIFACT_TYPES.PROJECT_GOAL,
    ARTIFACT_TYPES.CONSTRAINT,
    ARTIFACT_TYPES.OPEN_QUESTION,
  ],
  producesBeyondContract: [
    {
      type: ARTIFACT_TYPES.CLIENT_INPUT,
      why: 'R4 assigns the intake framing artifacts to no agent contract, and every downstream stage depends on them. Recorded as SF-12 rather than silently widening SC-AGENT-020.',
    },
    {
      type: ARTIFACT_TYPES.PROJECT_GOAL,
      why: 'As CLIENT_INPUT: no contract in 32 claims the framing artifacts. SF-12.',
    },
    {
      type: ARTIFACT_TYPES.CONSTRAINT,
      why: 'As CLIENT_INPUT: no contract in 32 claims the framing artifacts. SF-12.',
    },
  ],
  outputSchema: IntakeOutputSchema,
  outputJsonSchema: INTAKE_JSON_SCHEMA,
  requires: [ARTIFACT_TYPES.IDEA],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const ideas = repository(ctx.store, ARTIFACT_TYPES.IDEA, IdeaSchema).list();
    const canon = [contextFrom('idea', 'IDEA', ideas, (i) => i.rawText, 1)].filter(
      (c): c is NonNullable<typeof c> => c !== undefined,
    );
    return {
      canon,
      excluded: [
        {
          subject: 'everything else',
          reason: 'intake interprets the owner’s words and nothing else exists yet',
        },
      ],
    };
  },

  task(): string {
    return [
      'Turn the owner’s raw idea into a structured framing.',
      '',
      'Produce the problem, the audience, and — most importantly — what would count as',
      'SUCCESS. A project that never defines success cannot tell whether it succeeded.',
      '',
      'Derive project goals. Each needs a success indicator: how would anyone KNOW this',
      'was achieved? A goal with no indicator is a wish.',
      '',
      'Record constraints, and mark honestly whether each is negotiable. "We must launch',
      'by March" and "the team knows Postgres" constrain the solution very differently.',
      '',
      'Raise open questions ONLY where the answer is genuinely the owner’s authority:',
      'commercial intent, budget, business policy, legal commitments, brand identity,',
      'or contradictory goals. Ask them in business language.',
      '',
      'Do NOT ask which framework, database, architecture pattern, API style, colour or',
      'border radius to use. Those are Serva’s decisions and asking transfers them to',
      'someone who hired Serva so they would not have to make them.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Interpret the idea. Do not design a solution, propose features, or select technology.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const at = ctx.clock.now();
    const ideaRef = repository(ctx.store, ARTIFACT_TYPES.IDEA, IdeaSchema).ids()[0];

    const inputId = ctx.ids.next('SC-CIN');
    repository(ctx.store, ARTIFACT_TYPES.CLIENT_INPUT, ClientInputSchema).put(tx, {
      id: inputId,
      createdAt: at,
      ideaRef: { id: ideaRef ?? 'SC-IDEA-UNKNOWN' },
      problem: output.problem,
      audience: output.audience,
      successDefinition: output.successDefinition,
      commercialRequirements: output.commercialRequirements,
      /*
       * OWNER_STATED rather than DERIVED: this is Serva's structuring of what the owner
       * said, and the owner's authority over the problem statement carries through it.
       */
      meta: ownerStated(ctx),
    });
    ids.push(inputId);

    const goals = repository(ctx.store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema);
    for (const g of output.goals) {
      const id = ctx.ids.next('SC-GOAL');
      goals.put(tx, {
        id,
        createdAt: at,
        statement: g.statement,
        successIndicator: g.successIndicator,
        priority: g.priority,
        meta: ownerStated(ctx),
      });
      ids.push(id);
    }

    const constraints = repository(ctx.store, ARTIFACT_TYPES.CONSTRAINT, ConstraintSchema);
    for (const c of output.constraints) {
      const id = ctx.ids.next('SC-CON');
      constraints.put(tx, {
        id,
        createdAt: at,
        type: c.type,
        statement: c.statement,
        negotiable: c.negotiable,
        meta: ownerStated(ctx),
      });
      ids.push(id);
    }

    /*
     * A question Serva should have answered itself is dropped and reported, not asked.
     * Storing it would put it in front of the owner, which is the harm.
     */
    const notes: string[] = [];
    const questions = repository(ctx.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema);
    for (const q of output.openQuestions) {
      const refusal = questionKindRefusal(q.question);
      if (refusal !== undefined) {
        notes.push('question withheld from the owner — ' + refusal);
        continue;
      }
      const id = ctx.ids.next('SC-OQ');
      questions.put(tx, {
        id,
        createdAt: at,
        question: q.question,
        blocks: [],
        askedOf: 'OWNER',
        state: 'OPEN',
        meta: derived(ctx, AGENT, [inputId], q.whyOwnerMustAnswer),
      });
      ids.push(id);
    }

    return { artifactIds: ids, notes };
  },
};
