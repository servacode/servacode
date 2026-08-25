import { z } from 'zod';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import { RequirementSchema } from '../artifacts/requirements.js';
import {
  HandoverPackageSchema,
  OperationalReadinessVerdictSchema,
  ReleaseRecommendationSchema,
  ReleaseSchema,
  ReleaseState,
  RunbookSchema,
} from '../artifacts/release.js';
import { AcceptanceVerdictSchema, VerificationVerdict } from '../artifacts/quality.js';
import { RollbackSpecSchema, ObservabilitySpecSchema } from '../artifacts/operations.js';
import { jsonSchemaFor } from '../execution/jsonSchema.js';
import { contextFrom, currentSubjects, derived } from './shared.js';
import { VerdictFamily, supportedVerdict, verdictIsAffirmative } from './verdictSupport.js';
import type {
  DepartmentConfig,
  DepartmentContext,
  DepartmentContextSpec,
  PersistResult,
} from '../execution/types.js';
import type { ScopedCanonWriter } from '../execution/authority.js';

/**
 * RELEASE AND OPERATIONS — stages 050 and 052.
 *
 * SPEC: §21, §22, 03 §7, 06 (SC-AGENT-250/251/260/262).
 *
 * Serva runs on one machine; the products it builds do not. The Release Manager assembles
 * a candidate and RECOMMENDS — it never authorises, because an agent that could authorise
 * a release could authorise its own work into production. Authority to deliver is the
 * owner's, raised as a governed decision by Serva's own machinery.
 *
 * The release notes are DERIVED from accepted ChangeSets rather than written from memory.
 * A summary somebody recalls describes what they remember doing, and the difference only
 * surfaces when a customer asks why a fix is missing.
 *
 * Nothing here deploys. Where no connector exists, Serva produces the governed package and
 * says external action is required — a fabricated deployment success is worse than no
 * deployment at all.
 */

const RELEASE_MANAGER = 'SC-AGENT-250';
const HANDOVER_COMPILER = 'SC-AGENT-251';
const OPERATIONS_ENGINEER = 'SC-AGENT-260';
const OPS_READINESS_VERIFIER = 'SC-AGENT-262';

function requireRun(ctx: DepartmentContext, agentId: string): string {
  if (ctx.runId !== undefined) return ctx.runId;
  throw new Error(
    agentId + ' produced no governed run to attribute its output to, and one is required.',
  );
}

/* ============================================================== 050 — RELEASE MANAGER */

export const ReleaseOutputSchema = z
  .object({
    releaseVersion: z.string().min(1),
    name: z.string().min(1),
    /** One line per user-visible change, written for somebody outside the project. */
    notes: z.array(z.string().min(1)).default([]),
    knownLimitations: z.array(z.string().min(1)).default([]),
    recommendation: z.enum(['RELEASE', 'HOLD', 'RELEASE_WITH_QUALIFICATION']),
    rationale: z.string().min(1),
    blockers: z.array(z.string().min(1)).default([]),
    qualifications: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const releaseDepartment: DepartmentConfig<typeof ReleaseOutputSchema> = {
  id: 'DEPT-RELEASE',
  stageId: 'SC-STAGE-050',
  agentId: RELEASE_MANAGER,
  title: 'Release Management',
  produces: [ARTIFACT_TYPES.RELEASE, ARTIFACT_TYPES.RELEASE_RECOMMENDATION],
  outputSchema: ReleaseOutputSchema,
  outputJsonSchema: jsonSchemaFor(ReleaseOutputSchema),
  /** A release candidate with nothing accepted in it is not a candidate. */
  requires: [ARTIFACT_TYPES.ACCEPTANCE_VERDICT],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const requirements = repository(
      ctx.store,
      ARTIFACT_TYPES.REQUIREMENT,
      RequirementSchema,
    ).list();
    const acceptance = repository(
      ctx.store,
      ARTIFACT_TYPES.ACCEPTANCE_VERDICT,
      AcceptanceVerdictSchema,
    ).list();
    return {
      canon: [
        contextFrom('requirements', 'REQUIREMENT', requirements, (r) => r.statement, 1),
        contextFrom(
          'acceptance',
          'ACCEPTANCE_VERDICT',
          acceptance,
          (a) => a.verdict + ': ' + a.summary,
          1,
        ),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'implementation detail and internal reasoning',
          reason:
            'release notes are written for somebody outside the project; internal detail is how a note becomes unreadable',
        },
      ],
    };
  },

  task(): string {
    return [
      'Assemble the release candidate and say whether you would ship it.',
      '',
      'You RECOMMEND. You do not authorise: shipping is the owner’s decision, and Serva',
      'raises it separately. A recommendation that reads like a decision is the one thing',
      'this department must not produce.',
      '',
      'Notes are for somebody who has never seen the code. "Fixed SC-REQ-000012" tells a',
      'customer nothing; say what changed for them.',
      '',
      'Blockers are the things that would make shipping wrong. If there are none, say so',
      'plainly rather than leaving the list empty and hoping it reads as none.',
      '',
      'Known limitations are not failures. A limitation nobody wrote down becomes a support',
      'ticket and then a surprise.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Assemble and recommend. Do not authorise a release, do not deploy, and do not change what was built.';
  },

  persist(tx: ScopedCanonWriter, output, ctx): PersistResult {
    const at = ctx.clock.now();
    const runId = requireRun(ctx, RELEASE_MANAGER);

    /*
     * The contents are DERIVED from the Store rather than taken from the run. A release
     * that lists what a model remembered including is a release note, not a manifest.
     */
    const changeSetRefs = ctx.store.listCanonIds('eng.changeSet').map((id) => ({ id }));
    const requirementRefs = ctx.store
      .listCanonIds(ARTIFACT_TYPES.REQUIREMENT)
      .map((id) => ({ id }));

    const releaseId = ctx.ids.next('SC-REL');
    repository(ctx.store, ARTIFACT_TYPES.RELEASE, ReleaseSchema).put(tx, {
      id: releaseId,
      createdAt: at,
      releaseVersion: output.releaseVersion,
      name: output.name,
      /* CANDIDATE, always. Approval is an owner decision and happens elsewhere. */
      state: ReleaseState.CANDIDATE,
      changeSetRefs,
      requirementRefs,
      notes: output.notes,
      knownLimitations: output.knownLimitations,
      artifactManifest: [],
      meta: derived(
        ctx,
        RELEASE_MANAGER,
        changeSetRefs.map((c) => c.id),
        'release candidate assembled from accepted change sets',
        runId,
      ),
    });

    const recId = ctx.ids.next('SC-RELREC');
    repository(ctx.store, ARTIFACT_TYPES.RELEASE_RECOMMENDATION, ReleaseRecommendationSchema).put(
      tx,
      {
        id: recId,
        createdAt: at,
        releaseRef: { id: releaseId },
        recommendation: output.recommendation,
        rationale: output.rationale,
        blockers: output.blockers,
        qualifications: output.qualifications,
        recommendedByRunId: runId,
        recommendedByAgentId: RELEASE_MANAGER,
        meta: derived(ctx, RELEASE_MANAGER, [releaseId], 'release recommendation', runId),
      },
    );

    return {
      artifactIds: [releaseId, recId],
      notes: [
        'release candidate ' + output.releaseVersion + ': ' + output.recommendation,
        ...output.blockers.map((b) => 'blocker: ' + b),
      ],
      judgements: [
        {
          criterionRef: 'RL-2',
          met: output.recommendation !== 'HOLD',
          by: RELEASE_MANAGER,
          note: output.rationale,
          subjects: [...currentSubjects(ctx.store, [ARTIFACT_TYPES.ACCEPTANCE_VERDICT])],
        },
      ],
    };
  },
};

/* ============================================================ 050 — HANDOVER COMPILER */

export const HandoverOutputSchema = z
  .object({
    overview: z.string().min(1),
    deploymentSteps: z.array(z.string().min(1)).default([]),
    configurationRequirements: z
      .array(
        z
          .object({
            key: z.string().min(1),
            purpose: z.string().min(1),
            secret: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
    migrationRequirements: z.array(z.string().min(1)).default([]),
    rollbackPlan: z.string().min(1),
    operatorDocumentation: z.array(z.string().min(1)).default([]),
    knownLimitations: z.array(z.string().min(1)).default([]),
    /** What could not be established. Present and empty is a claim; absent is not. */
    notEstablished: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const handoverDepartment: DepartmentConfig<typeof HandoverOutputSchema> = {
  id: 'DEPT-HANDOVER',
  stageId: 'SC-STAGE-050',
  agentId: HANDOVER_COMPILER,
  title: 'Handover',
  produces: [ARTIFACT_TYPES.HANDOVER_PACKAGE],
  outputSchema: HandoverOutputSchema,
  outputJsonSchema: jsonSchemaFor(HandoverOutputSchema),
  requires: [ARTIFACT_TYPES.RELEASE],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const releases = repository(ctx.store, ARTIFACT_TYPES.RELEASE, ReleaseSchema).list();
    const rollback = repository(ctx.store, ARTIFACT_TYPES.ROLLBACK_SPEC, RollbackSpecSchema).list();
    return {
      canon: [
        contextFrom('release', 'RELEASE', releases, (r) => r.releaseVersion + ' — ' + r.name, 1),
        contextFrom('rollback', 'ROLLBACK_SPEC', rollback, (r) => r.mechanism, 1),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'credential values of any kind',
          reason:
            'a handover package travels; a secret inside one is a secret in somebody else’s inbox forever',
        },
      ],
    };
  },

  task(): string {
    return [
      'Compile what somebody who was never in the room needs to run and change this.',
      '',
      'Write for a competent stranger. Everything obvious to this project is invisible to',
      'them: the migration that has to run first, the configuration the environment does',
      'not have, the way back when it goes wrong.',
      '',
      'Name configuration KEYS and what they are for. Never a value. A package like this',
      'gets emailed, and a secret in one is a secret forever.',
      '',
      'Anything you could not establish goes in notEstablished. A handover that quietly',
      'omits the unknown reads as complete, which is the most expensive kind of wrong.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Compile the handover package. Do not deploy, do not include secrets, and do not invent an operational procedure nobody agreed.';
  },

  persist(tx: ScopedCanonWriter, output, ctx): PersistResult {
    const at = ctx.clock.now();
    const runId = requireRun(ctx, HANDOVER_COMPILER);
    const releases = repository(ctx.store, ARTIFACT_TYPES.RELEASE, ReleaseSchema).list();
    const release = releases[releases.length - 1];
    if (release === undefined) {
      return { artifactIds: [], notes: ['no release candidate exists to hand over'] };
    }

    const acceptance = repository(
      ctx.store,
      ARTIFACT_TYPES.ACCEPTANCE_VERDICT,
      AcceptanceVerdictSchema,
    )
      .list()
      .map((a) => ({ id: a.id }));

    const id = ctx.ids.next('SC-HAND');
    repository(ctx.store, ARTIFACT_TYPES.HANDOVER_PACKAGE, HandoverPackageSchema).put(tx, {
      id,
      createdAt: at,
      releaseRef: { id: release.id },
      overview: output.overview,
      deploymentSteps: output.deploymentSteps,
      configurationRequirements: output.configurationRequirements,
      migrationRequirements: output.migrationRequirements,
      rollbackPlan: output.rollbackPlan,
      operatorDocumentation: output.operatorDocumentation,
      acceptanceEvidenceRefs: acceptance,
      knownLimitations: output.knownLimitations,
      notEstablished: output.notEstablished,
      compiledByRunId: runId,
      compiledByAgentId: HANDOVER_COMPILER,
      meta: derived(ctx, HANDOVER_COMPILER, [release.id], 'handover package', runId),
    });

    return {
      artifactIds: [id],
      notes: [
        'handover package compiled for ' + release.releaseVersion,
        ...output.notEstablished.map((n) => 'not established: ' + n),
      ],
      judgements: [
        {
          criterionRef: 'RL-3',
          met: output.rollbackPlan.trim().length > 0 && output.deploymentSteps.length > 0,
          by: HANDOVER_COMPILER,
          note: 'handover package with a rollback plan and deployment steps',
          subjects: [...currentSubjects(ctx.store, [ARTIFACT_TYPES.RELEASE])],
        },
      ],
    };
  },
};

/* ========================================================== 052 — OPERATIONS ENGINEER */

export const OperationsOutputSchema = z
  .object({
    runbooks: z
      .array(
        z
          .object({
            title: z.string().min(1),
            scenario: z.string().min(1),
            detection: z.string().min(1),
            steps: z.array(z.string().min(1)).min(1),
            escalation: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const operationsDepartment: DepartmentConfig<typeof OperationsOutputSchema> = {
  id: 'DEPT-OPERATIONS',
  stageId: 'SC-STAGE-052',
  agentId: OPERATIONS_ENGINEER,
  title: 'Operations',
  produces: [ARTIFACT_TYPES.RUNBOOK],
  outputSchema: OperationsOutputSchema,
  outputJsonSchema: jsonSchemaFor(OperationsOutputSchema),
  requires: [ARTIFACT_TYPES.RELEASE],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const observability = repository(
      ctx.store,
      ARTIFACT_TYPES.OBSERVABILITY_SPEC,
      ObservabilitySpecSchema,
    ).list();
    const releases = repository(ctx.store, ARTIFACT_TYPES.RELEASE, ReleaseSchema).list();
    return {
      canon: [
        contextFrom('release', 'RELEASE', releases, (r) => r.releaseVersion, 0.8),
        contextFrom(
          'observability',
          'OBSERVABILITY_SPEC',
          observability,
          (o) => o.metrics.join('; '),
          1,
        ),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'source code',
          reason: 'a runbook is written for whoever is awake at 3am, not for whoever wrote it',
        },
      ],
    };
  },

  task(): string {
    return [
      'Write the runbooks for the failures this product can actually have.',
      '',
      'Each one needs: how somebody notices, what they do, and who they wake if it does',
      'not work. A runbook without a detection step is a document nobody opens, because',
      'nobody knew to open it.',
      '',
      'Write for somebody tired and under pressure who did not build this. Steps, in order,',
      'that can be followed without understanding the architecture.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Write operational runbooks. Do not change the product and do not deploy anything.';
  },

  persist(tx: ScopedCanonWriter, output, ctx): PersistResult {
    const at = ctx.clock.now();
    const runId = requireRun(ctx, OPERATIONS_ENGINEER);
    const ids: string[] = [];
    for (const r of output.runbooks) {
      const id = ctx.ids.next('SC-RUNB');
      repository(ctx.store, ARTIFACT_TYPES.RUNBOOK, RunbookSchema).put(tx, {
        id,
        createdAt: at,
        title: r.title,
        scenario: r.scenario,
        detection: r.detection,
        steps: r.steps,
        escalation: r.escalation,
        relatedRefs: [],
        meta: derived(ctx, OPERATIONS_ENGINEER, ['release'], 'operational runbook', runId),
      });
      ids.push(id);
    }
    return {
      artifactIds: ids,
      notes: [String(ids.length) + ' runbook(s) recorded'],
    };
  },
};

/* ================================================= 052 — OPERATIONAL READINESS VERIFIER */

export const OpsReadinessOutputSchema = z
  .object({
    verdict: z.enum([
      VerificationVerdict.PASS,
      VerificationVerdict.PASS_WITH_QUALIFICATION,
      VerificationVerdict.FAIL,
      VerificationVerdict.NOT_VERIFIED,
    ]),
    summary: z.string().min(1),
    checks: z
      .array(
        z
          .object({
            area: z.string().min(1),
            met: z.boolean(),
            detail: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    notVerified: z
      .array(z.object({ area: z.string().min(1), why: z.string().min(1) }).strict())
      .default([]),
  })
  .strict();

export const operationalReadinessDepartment: DepartmentConfig<typeof OpsReadinessOutputSchema> = {
  id: 'DEPT-OPERATIONAL-READINESS',
  stageId: 'SC-STAGE-052',
  agentId: OPS_READINESS_VERIFIER,
  title: 'Operational Readiness',
  produces: [ARTIFACT_TYPES.OPERATIONAL_READINESS_VERDICT],
  /** Never the engineer who wrote the runbooks being judged. */
  independentOf: [OPERATIONS_ENGINEER],
  outputSchema: OpsReadinessOutputSchema,
  outputJsonSchema: jsonSchemaFor(OpsReadinessOutputSchema),
  requires: [ARTIFACT_TYPES.RUNBOOK],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const runbooks = repository(ctx.store, ARTIFACT_TYPES.RUNBOOK, RunbookSchema).list();
    const rollback = repository(ctx.store, ARTIFACT_TYPES.ROLLBACK_SPEC, RollbackSpecSchema).list();
    return {
      canon: [
        contextFrom('runbooks', 'RUNBOOK', runbooks, (r) => r.title + ': ' + r.scenario, 1),
        contextFrom('rollback', 'ROLLBACK_SPEC', rollback, (r) => r.mechanism, 1),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'the operations engineer’s rationale',
          reason: 'readiness is judged against the runbooks themselves, not against their defence',
        },
      ],
    };
  },

  task(): string {
    return [
      'Decide whether somebody who did not build this could operate it.',
      '',
      'The test is not whether documents exist. It is whether a person on call at 3am,',
      'holding only these runbooks, could detect the failure, act on it, and know who to',
      'escalate to.',
      '',
      'An area with no runbook and no rollback is NOT_VERIFIED, not a pass with a note.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Judge operational readiness. Do not write runbooks and do not change the product.';
  },

  persist(tx: ScopedCanonWriter, output, ctx): PersistResult {
    const at = ctx.clock.now();
    const runId = requireRun(ctx, OPS_READINESS_VERIFIER);
    const releases = repository(ctx.store, ARTIFACT_TYPES.RELEASE, ReleaseSchema).list();
    const release = releases[releases.length - 1];
    const id = ctx.ids.next('SC-OPSV');
    repository(
      ctx.store,
      ARTIFACT_TYPES.OPERATIONAL_READINESS_VERDICT,
      OperationalReadinessVerdictSchema,
    ).put(tx, {
      id,
      createdAt: at,
      /* Serva computes this: a readiness verdict that ran no check verified nothing. */
      verdict: supportedVerdict(output.verdict, {
        exercised: output.checks.length,
        notVerified: output.notVerified.length,
      }),
      releaseRef: { id: release?.id ?? ctx.workItemId },
      summary: output.summary,
      checks: output.checks,
      notVerified: output.notVerified,
      verifiedByRunId: runId,
      verifiedByAgentId: OPS_READINESS_VERIFIER,
      verifiedAt: at,
      meta: derived(ctx, OPS_READINESS_VERIFIER, ['runbooks'], 'operational readiness', runId),
    });
    return {
      artifactIds: [id],
      notes: ['operational readiness ' + output.verdict],
      judgements: [
        {
          criterionRef: 'RL-4',
          /* A readiness PASS that ran no check is not readiness. */
          met: verdictIsAffirmative(output.verdict, {
            examined: output.checks.length,
            family: VerdictFamily.VERIFICATION,
          }),
          by: OPS_READINESS_VERIFIER,
          note: output.summary,
          subjects: [...currentSubjects(ctx.store, [ARTIFACT_TYPES.RUNBOOK])],
        },
      ],
    };
  },
};

export const RELEASE_DEPARTMENTS: readonly DepartmentConfig[] = Object.freeze([
  releaseDepartment as DepartmentConfig,
  handoverDepartment as DepartmentConfig,
  operationsDepartment as DepartmentConfig,
  operationalReadinessDepartment as DepartmentConfig,
]);
