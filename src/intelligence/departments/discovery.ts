import { z } from 'zod';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import { ClientInputSchema, ProjectGoalSchema, AssumptionSchema } from '../artifacts/framing.js';
import {
  CurrentAlternativeSchema,
  DiscoveryFindingsSchema,
  JobToBeDoneSchema,
  PainSchema,
  UserSegmentSchema,
} from '../artifacts/discovery.js';
import { jsonSchemaFor } from '../execution/jsonSchema.js';
import { contextFrom, derived, inferred } from './shared.js';
import type {
  DepartmentConfig,
  DepartmentContext,
  DepartmentContextSpec,
} from '../execution/types.js';

/**
 * DISCOVERY — SC-AGENT-030, stage 003.
 *
 * SPEC: §6, 06.
 *
 * The output schema carries this department's hardest rule in its shape: every segment
 * must have at least one current alternative, and `alternatives` is `.min(1)` per segment
 * rather than a free list. A product compared only against software competitors is
 * compared against the wrong thing — most things lose to a spreadsheet, a WhatsApp group,
 * or nobody bothering.
 *
 * `researchPerformed` is structured because the failure mode is prose. "User research
 * indicates…" is one sentence away from "we asked nobody", and only a counted field makes
 * the difference legible to a gate.
 */

const AlternativeOut = z
  .object({
    kind: z.enum([
      'DO_NOTHING',
      'MANUAL_PROCESS',
      'SPREADSHEET',
      'GENERAL_PURPOSE_TOOL',
      'INTERNAL_SYSTEM',
      'EMPLOYEE_OR_SERVICE',
      'COMPETITOR_PRODUCT',
    ]),
    description: z.string().min(1),
    whyUsed: z.string().min(1),
    weaknesses: z.array(z.string().min(1)).min(1),
  })
  .strict();

const SegmentOut = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    goals: z.array(z.string().min(1)).min(1),
    context: z.string().min(1),
    jobs: z
      .array(
        z.object({ statement: z.string().min(1), currentSolution: z.string().min(1) }).strict(),
      )
      .min(1),
    pains: z
      .array(
        z
          .object({
            statement: z.string().min(1),
            severity: z.enum(['BLOCKING', 'MAJOR', 'MINOR']),
          })
          .strict(),
      )
      .default([]),
    /** MANDATORY. A segment with no current alternative has not been researched. */
    alternatives: z.array(AlternativeOut).min(1),
  })
  .strict();

export const DiscoveryOutputSchema = z
  .object({
    summary: z.string().min(1),
    segments: z.array(SegmentOut).min(1),
    researchPerformed: z
      .object({
        interviews: z.number().int().min(0),
        surveys: z.number().int().min(0),
        usabilityTests: z.number().int().min(0),
        deskResearch: z.boolean(),
      })
      .strict(),
    limitations: z.array(z.string().min(1)).default([]),
    assumptions: z
      .array(
        z
          .object({
            statement: z.string().min(1),
            loadBearing: z.boolean(),
            validationApproach: z.string().min(1),
            ifWrong: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type DiscoveryOutput = z.output<typeof DiscoveryOutputSchema>;

/**
 * DERIVED from the validator above, never hand-written.
 *
 * Two hand-maintained schemas drift silently: the provider then shapes output to a
 * contract Serva no longer enforces. One source of truth, two distinct checks.
 */
export const DISCOVERY_JSON_SCHEMA: Record<string, unknown> = jsonSchemaFor(DiscoveryOutputSchema);

const AGENT = 'SC-AGENT-030';

export const discoveryDepartment: DepartmentConfig<typeof DiscoveryOutputSchema> = {
  id: 'DEPT-DISCOVERY',
  stageId: 'SC-STAGE-003',
  agentId: AGENT,
  title: 'Discovery',
  outputSchema: DiscoveryOutputSchema,
  outputJsonSchema: DISCOVERY_JSON_SCHEMA,
  requires: [ARTIFACT_TYPES.CLIENT_INPUT],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const input = repository(ctx.store, ARTIFACT_TYPES.CLIENT_INPUT, ClientInputSchema).list();
    const goals = repository(ctx.store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).list();

    const canon = [
      contextFrom(
        'client-input',
        'INTAKE',
        input,
        (i) =>
          'problem: ' +
          i.problem +
          ' | audience: ' +
          i.audience +
          ' | success: ' +
          i.successDefinition,
        1,
      ),
      contextFrom(
        'goals',
        'GOAL',
        goals,
        (g) => g.statement + ' (success: ' + g.successIndicator + ')',
        0.9,
      ),
    ].filter((c): c is NonNullable<typeof c> => c !== undefined);

    return {
      canon,
      excluded: [
        {
          subject: 'architecture, data model, design system, implementation',
          reason:
            'discovery is about who has the problem and what they do today; solution detail would bias the answer toward what is easy to build',
        },
      ],
    };
  },

  task(): string {
    return [
      'Identify who has this problem and what they do about it TODAY.',
      '',
      'For every user segment you identify you MUST record at least one current',
      'alternative. "Do nothing", a spreadsheet, a WhatsApp group, paper, a phone call, or',
      'an employee doing it by hand are all valid and common alternatives — most products',
      'lose to one of those rather than to a competing product. Do not list only software',
      'competitors.',
      '',
      'For each alternative, say why people currently USE it, not only what is wrong with',
      'it. A replacement that ignores why the old way is tolerable tends to lose to it.',
      '',
      'CRITICAL — do not fabricate research. If no interviews, surveys or usability tests',
      'were performed, record zero for them and say so in `limitations`. Never write or',
      'imply that users were asked something when they were not.',
      '',
      'Anything you believe but cannot support, and that would change the product if it',
      'were wrong, belongs in `assumptions` with loadBearing set to true.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Produce discovery findings only. Do not propose features, architecture, technology or design.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const segments = repository(ctx.store, ARTIFACT_TYPES.USER_SEGMENT, UserSegmentSchema);
    const jobs = repository(ctx.store, ARTIFACT_TYPES.JOB_TO_BE_DONE, JobToBeDoneSchema);
    const pains = repository(ctx.store, ARTIFACT_TYPES.PAIN, PainSchema);
    const alts = repository(
      ctx.store,
      ARTIFACT_TYPES.CURRENT_ALTERNATIVE,
      CurrentAlternativeSchema,
    );
    const assumptions = repository(ctx.store, ARTIFACT_TYPES.ASSUMPTION, AssumptionSchema);
    const findings = repository(
      ctx.store,
      ARTIFACT_TYPES.DISCOVERY_FINDINGS,
      DiscoveryFindingsSchema,
    );

    const at = ctx.clock.now();
    const segmentIds: string[] = [];

    for (const s of output.segments) {
      const segId = ctx.ids.next('SC-SEG');
      segments.put(tx, {
        id: segId,
        createdAt: at,
        name: s.name,
        description: s.description,
        goals: s.goals,
        context: s.context,
        meta: derived(ctx, AGENT, ['client-input'], 'segment identified during discovery'),
      });
      segmentIds.push(segId);
      ids.push(segId);

      for (const j of s.jobs) {
        const id = ctx.ids.next('SC-JTBD');
        jobs.put(tx, {
          id,
          createdAt: at,
          statement: j.statement,
          segmentRef: { id: segId },
          currentSolution: j.currentSolution,
          meta: derived(ctx, AGENT, [segId], 'job identified for this segment'),
        });
        ids.push(id);
      }

      for (const p of s.pains) {
        const id = ctx.ids.next('SC-PAIN');
        pains.put(tx, {
          id,
          createdAt: at,
          statement: p.statement,
          severity: p.severity,
          segmentRef: { id: segId },
          meta: derived(ctx, AGENT, [segId], 'pain identified for this segment'),
        });
        ids.push(id);
      }

      for (const a of s.alternatives) {
        const id = ctx.ids.next('SC-ALT');
        alts.put(tx, {
          id,
          createdAt: at,
          segmentRef: { id: segId },
          kind: a.kind,
          description: a.description,
          whyUsed: a.whyUsed,
          weaknesses: a.weaknesses,
          meta: derived(ctx, AGENT, [segId], 'what this segment uses today'),
        });
        ids.push(id);
      }
    }

    /*
     * Assumptions are written BEFORE the findings that may cite them, so a load-bearing
     * inference always has an Assumption id to point at. The repository refuses the other
     * order, which is the intended pressure.
     */
    for (const a of output.assumptions) {
      const id = ctx.ids.next('SC-ASSUM');
      assumptions.put(tx, {
        id,
        createdAt: at,
        statement: a.statement,
        status: 'UNVALIDATED',
        validationApproach: a.validationApproach,
        loadBearing: a.loadBearing,
        ifWrong: a.ifWrong,
        meta: inferred(
          ctx,
          AGENT,
          'stated by discovery as an assumption rather than a finding',
          'MEDIUM',
          false,
        ),
      });
      ids.push(id);
    }

    const findingsId = ctx.ids.next('SC-DF');
    findings.put(tx, {
      id: findingsId,
      createdAt: at,
      summary: output.summary,
      segmentRefs: segmentIds.map((id) => ({ id })),
      researchPerformed: output.researchPerformed,
      limitations: output.limitations,
      openQuestionRefs: [],
      assumptionRefs: [],
      meta: derived(ctx, AGENT, segmentIds, 'discovery summary over the identified segments'),
    });
    ids.push(findingsId);

    const notes: string[] = [];
    const r = output.researchPerformed;
    if (r.interviews === 0 && r.surveys === 0 && r.usabilityTests === 0) {
      notes.push(
        'no primary user research was performed; every segment claim rests on desk research or inference and the gate should read it that way',
      );
    }

    return {
      artifactIds: ids,
      notes,
      judgements: [
        {
          criterionRef: 'DI-4',
          /*
           * The repository already REFUSES a load-bearing inference with no Assumption,
           * so reaching this point means the promotion happened. The judgement records
           * who is accountable for it rather than leaving the criterion unevaluated.
           */
          met: true,
          by: AGENT,
          note:
            'every load-bearing inference was promoted to an Assumption; ' +
            String(output.assumptions.length) +
            ' recorded',
        },
      ],
    };
  },
};
