import { z } from 'zod';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import {
  IncidentSchema,
  IncidentSeverity,
  IncidentState,
  PostIncidentReviewSchema,
} from '../artifacts/incident.js';
import { RequirementSchema } from '../artifacts/requirements.js';
import { ProposalSchema, ProposalState } from '../artifacts/governance.js';
import { jsonSchemaFor } from '../execution/jsonSchema.js';
import { contextFrom, derived } from './shared.js';
import type {
  DepartmentConfig,
  DepartmentContext,
  DepartmentContextSpec,
  PersistResult,
} from '../execution/types.js';
import type { ScopedCanonWriter } from '../execution/authority.js';

/**
 * INCIDENTS — stage 054.
 *
 * SPEC: §23, 03 §7, 06 (SC-AGENT-270/271), §34.
 *
 * "Checkout failed in production" has one wrong response and everybody reaches for it:
 * ask the model to fix checkout. That skips severity, skips impact, skips whether the
 * requirement was wrong rather than the code, skips verification, and skips the reason it
 * happened — which is the only part that stops it happening again.
 *
 * So an incident enters the same machinery as everything else. The Incident Commander
 * establishes what is true and what was done about it; it does not fix anything, because
 * containment under pressure and a governed change are different acts and merging them is
 * how an emergency patch becomes permanent undocumented behaviour.
 *
 * The Post-Incident Analyst separates the immediate cause from the contributing
 * conditions, and `contributingConditions` is required and non-empty for a reason: a
 * review that names one line of code has explained the symptom, and the same incident
 * returns with a different line number.
 *
 * Corrective actions are Proposals. An incident is not a licence to enlarge the product.
 */

const COMMANDER = 'SC-AGENT-270';
const ANALYST = 'SC-AGENT-271';

function requireRun(ctx: DepartmentContext, agentId: string): string {
  if (ctx.runId !== undefined) return ctx.runId;
  throw new Error(agentId + ' produced no governed run to attribute its record to.');
}

/* =========================================================== 054 — INCIDENT COMMAND */

export const IncidentOutputSchema = z
  .object({
    title: z.string().min(1),
    severity: z.enum([
      IncidentSeverity.SEV1,
      IncidentSeverity.SEV2,
      IncidentSeverity.SEV3,
      IncidentSeverity.SEV4,
    ]),
    /** What is actually happening, as established rather than as reported. */
    establishedEffect: z.string().min(1),
    /** Product truth this touches, by id. Empty is a real answer. */
    affects: z.array(z.string().min(1)).default([]),
    timeline: z.array(z.object({ entry: z.string().min(1) }).strict()).default([]),
    containment: z
      .object({
        action: z.string().min(1),
        reversible: z.boolean(),
      })
      .strict()
      .optional(),
    /** True only when this is a security incident. It changes the profile. */
    security: z.boolean().default(false),
  })
  .strict();

export const incidentCommandDepartment: DepartmentConfig<typeof IncidentOutputSchema> = {
  id: 'DEPT-INCIDENT-COMMAND',
  stageId: 'SC-STAGE-054',
  agentId: COMMANDER,
  title: 'Incident Command',
  produces: [ARTIFACT_TYPES.INCIDENT],
  outputSchema: IncidentOutputSchema,
  outputJsonSchema: jsonSchemaFor(IncidentOutputSchema),

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const requirements = repository(
      ctx.store,
      ARTIFACT_TYPES.REQUIREMENT,
      RequirementSchema,
    ).list();
    const existing = repository(ctx.store, ARTIFACT_TYPES.INCIDENT, IncidentSchema).list();
    return {
      canon: [
        contextFrom('requirements', 'REQUIREMENT', requirements, (r) => r.statement, 0.9),
        contextFrom(
          'incidents',
          'INCIDENT',
          existing,
          (i) => i.severity + ' ' + i.state + ': ' + i.title,
          1,
        ),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'source code and implementation detail',
          reason:
            'establishing what is broken and fixing it are different acts; merging them turns an emergency into permanent undocumented behaviour',
        },
      ],
    };
  },

  task(): string {
    return [
      'Establish what is actually happening, and record what was done to stop it.',
      '',
      'You do not fix anything. A fix is a governed change with impact analysis and',
      'verification behind it, and Serva raises one — an emergency patch that skipped',
      'that is how a workaround becomes permanent behaviour nobody documented.',
      '',
      'Severity decides how the company responds, so choose it on effect rather than on',
      'how alarming the report sounded. SEV1 means unusable, data at risk, or a breach.',
      '',
      'The reported effect and the established effect are different things. Say what you',
      'established; Serva keeps the original report either way.',
      '',
      'Mark `security` only when this IS a security incident. It changes which lifecycle',
      'profile the fix re-enters through.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Establish and record the incident. Do not modify the product, and do not decide the fix.';
  },

  persist(tx: ScopedCanonWriter, output, ctx): PersistResult {
    const at = ctx.clock.now();
    const runId = requireRun(ctx, COMMANDER);
    const id = ctx.ids.next('SC-INC');

    repository(ctx.store, ARTIFACT_TYPES.INCIDENT, IncidentSchema).put(tx, {
      id,
      createdAt: at,
      title: output.title,
      severity: output.severity,
      /*
       * CONTAINED only where containment was actually recorded. An incident state is a
       * control signal, not a mood: reporting CONTAINED because the run sounded confident
       * would let the lifecycle move on from a live outage.
       */
      state:
        output.containment === undefined ? IncidentState.INVESTIGATING : IncidentState.CONTAINED,
      reportedAt: at,
      reportedBy: ctx.ownerRequest === undefined ? 'OWNER' : 'OWNER',
      reportedEffect: ctx.ownerRequest ?? output.establishedEffect,
      establishedEffect: output.establishedEffect,
      timeline: output.timeline.map((t) => ({ at, entry: t.entry, by: COMMANDER })),
      ...(output.containment === undefined
        ? {}
        : {
            containment: {
              action: output.containment.action,
              at,
              reversible: output.containment.reversible,
            },
          }),
      affectsRefs: output.affects.map((a) => ({ id: a })),
      meta: derived(ctx, COMMANDER, output.affects, 'incident established', runId),
    });

    return {
      artifactIds: [id],
      notes: [
        'incident ' + output.severity + ' recorded: ' + output.title,
        ...(output.security ? ['this is a security incident; the fix profile changes'] : []),
        ...(output.containment === undefined
          ? ['not contained: the effect is still live']
          : ['contained: ' + output.containment.action]),
      ],
    };
  },
};

/* ========================================================= 054 — POST-INCIDENT REVIEW */

export const PostIncidentOutputSchema = z
  .object({
    incidentId: z.string().min(1),
    immediateCause: z.string().min(1),
    /** Required and non-empty: a cause with no conditions explains the symptom only. */
    contributingConditions: z.array(z.string().min(1)).min(1),
    detection: z.string().min(1),
    notEstablished: z.array(z.string().min(1)).default([]),
    /** Corrective actions, raised as Proposals so they are costed before they are scope. */
    correctiveActions: z
      .array(
        z
          .object({
            title: z.string().min(1),
            description: z.string().min(1),
            affectsCanon: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const postIncidentDepartment: DepartmentConfig<typeof PostIncidentOutputSchema> = {
  id: 'DEPT-POST-INCIDENT',
  stageId: 'SC-STAGE-054',
  agentId: ANALYST,
  title: 'Post-Incident Review',
  produces: [ARTIFACT_TYPES.POST_INCIDENT_REVIEW, ARTIFACT_TYPES.PROPOSAL],
  /** The commander who handled it does not also judge how it was handled. */
  independentOf: [COMMANDER],
  outputSchema: PostIncidentOutputSchema,
  outputJsonSchema: jsonSchemaFor(PostIncidentOutputSchema),
  requires: [ARTIFACT_TYPES.INCIDENT],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const incidents = repository(ctx.store, ARTIFACT_TYPES.INCIDENT, IncidentSchema).list();
    return {
      canon: [
        contextFrom(
          'incidents',
          'INCIDENT',
          incidents,
          (i) =>
            i.severity +
            ': ' +
            i.title +
            ' — established: ' +
            (i.establishedEffect ?? i.reportedEffect),
          1,
        ),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'the commander’s own account of their decisions',
          reason:
            'a review of how an incident was handled that reads the handler’s defence is not a review',
        },
      ],
    };
  },

  task(): string {
    return [
      'Explain why this happened, and what would have to change for it not to.',
      '',
      'The immediate cause is the thing that broke. The contributing conditions are what',
      'let it reach production, and they are the part worth writing down: a review that',
      'names one line of code has explained the symptom, and the same incident comes back',
      'with a different line number.',
      '',
      'Detection matters as much as cause. How long before anybody knew is usually the',
      'most actionable finding in the whole review.',
      '',
      'Corrective actions are PROPOSALS. They get costed and agreed like anything else —',
      'an incident is not a licence to enlarge the product.',
      '',
      'Blame nobody. A review that finds a person has found the wrong thing.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Review the incident and propose corrective actions. Do not implement them, and do not assign blame.';
  },

  persist(tx: ScopedCanonWriter, output, ctx): PersistResult {
    const at = ctx.clock.now();
    const runId = requireRun(ctx, ANALYST);
    const incidents = repository(ctx.store, ARTIFACT_TYPES.INCIDENT, IncidentSchema);
    const incident = incidents.get(output.incidentId);
    if (incident === undefined) {
      return {
        artifactIds: [],
        notes: ['review dropped — no incident ' + output.incidentId + ' exists'],
      };
    }

    const ids: string[] = [];
    const proposalRefs: { id: string }[] = [];
    for (const a of output.correctiveActions) {
      const id = ctx.ids.next('SC-PROP');
      repository(ctx.store, ARTIFACT_TYPES.PROPOSAL, ProposalSchema).put(tx, {
        id,
        createdAt: at,
        title: a.title,
        origin: ANALYST,
        description: a.description,
        affectsCanon: a.affectsCanon,
        /* PROPOSED. It is not scope until somebody assesses and accepts it. */
        state: ProposalState.PROPOSED,
        meta: derived(ctx, ANALYST, [incident.id], 'corrective action from a review', runId),
      });
      proposalRefs.push({ id });
      ids.push(id);
    }

    const reviewId = ctx.ids.next('SC-PIR');
    repository(ctx.store, ARTIFACT_TYPES.POST_INCIDENT_REVIEW, PostIncidentReviewSchema).put(tx, {
      id: reviewId,
      createdAt: at,
      incidentRef: { id: incident.id },
      immediateCause: output.immediateCause,
      contributingConditions: output.contributingConditions,
      detection: output.detection,
      notEstablished: output.notEstablished,
      correctiveProposalRefs: proposalRefs,
      lessonRefs: [],
      reviewedByRunId: runId,
      reviewedByAgentId: ANALYST,
      meta: derived(ctx, ANALYST, [incident.id], 'post-incident review', runId),
    });
    ids.push(reviewId);

    return {
      artifactIds: ids,
      notes: [
        'post-incident review with ' +
          String(output.contributingConditions.length) +
          ' contributing condition(s) and ' +
          String(proposalRefs.length) +
          ' corrective proposal(s)',
        ...output.notEstablished.map((n) => 'not established: ' + n),
      ],
      judgements: [
        {
          criterionRef: 'IC-2',
          met: output.contributingConditions.length > 0,
          by: ANALYST,
          note: output.immediateCause,
          subjects: [{ id: incident.id, version: incident.version }],
        },
      ],
    };
  },
};

export const INCIDENT_DEPARTMENTS: readonly DepartmentConfig[] = Object.freeze([
  incidentCommandDepartment as DepartmentConfig,
  postIncidentDepartment as DepartmentConfig,
]);
