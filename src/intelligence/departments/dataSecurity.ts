import { z } from 'zod';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import { NfrSchema, RequirementSchema } from '../artifacts/requirements.js';
import { BusinessRuleSchema, ActorSchema } from '../artifacts/business.js';
import { ArchitectureModelSchema } from '../artifacts/architecture.js';
import {
  DataClassificationSchema,
  DataModelSchema,
  EntityOwnershipSchema,
  MigrationStrategySchema,
  RetentionPolicySchema,
} from '../artifacts/data.js';
import {
  AbuseCaseSchema,
  AuthDesignSchema,
  AuthorizationModelSchema,
  PrivacyDesignSchema,
  ResidualRiskSchema,
  SecretsDesignSchema,
  ThreatModelSchema,
  TrustBoundarySchema,
} from '../artifacts/security.js';
import { jsonSchemaFor } from '../execution/jsonSchema.js';
import { contextFrom, derived } from './shared.js';
import type {
  DepartmentConfig,
  DepartmentContext,
  DepartmentContextSpec,
} from '../execution/types.js';

/**
 * DATA ARCHITECTURE AND SECURITY.
 *
 * SPEC: §20, §21, 06, 17.
 *
 * Both departments exist to answer questions that are cheap now and ruinous later:
 * how long do we keep this and what does deleting it mean; who may do what to which
 * resource; what happens when one of the actors is hostile.
 *
 * Neither may claim a legal or compliance conclusion. `expertReviewRequired` exists so
 * that "this needs a professional" is a recordable output rather than an omission — Serva
 * must never imply it performed a certification it cannot perform.
 */

/* ========================================================= SC-AGENT-080 — data architect */

export const DataOutputSchema = z
  .object({
    entities: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().min(1),
            ownerModule: z.string().min(1),
            identifierStrategy: z.string().min(1),
            attributes: z
              .array(
                z
                  .object({
                    name: z.string().min(1),
                    type: z.string().min(1),
                    required: z.boolean(),
                  })
                  .strict(),
              )
              .default([]),
          })
          .strict(),
      )
      .min(1),
    relations: z
      .array(
        z
          .object({
            from: z.string().min(1),
            to: z.string().min(1),
            cardinality: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    transactionBoundaries: z.array(z.string().min(1)).default([]),
    classification: z
      .array(
        z
          .object({
            dataElement: z.string().min(1),
            class: z.enum([
              'PUBLIC',
              'INTERNAL',
              'CONFIDENTIAL',
              'PERSONAL',
              'SENSITIVE_PERSONAL',
              'FINANCIAL',
              'CREDENTIAL',
            ]),
            purpose: z.string().min(1),
            handlingRules: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
    retention: z
      .array(
        z
          .object({
            dataClass: z.enum([
              'PUBLIC',
              'INTERNAL',
              'CONFIDENTIAL',
              'PERSONAL',
              'SENSITIVE_PERSONAL',
              'FINANCIAL',
              'CREDENTIAL',
            ]),
            retention: z.string().min(1),
            deletionMethod: z.enum(['HARD_DELETE', 'SOFT_DELETE', 'ANONYMISE', 'RETAIN_IMMUTABLE']),
            basis: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    migration: z
      .object({
        approach: z.string().min(1),
        reversibility: z.enum(['REVERSIBLE', 'PARTIALLY_REVERSIBLE', 'IRREVERSIBLE']),
        testingRequirement: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const DATA_ARCHITECT = 'SC-AGENT-080';

export const dataDepartment: DepartmentConfig<typeof DataOutputSchema> = {
  id: 'DEPT-DATA',
  stageId: 'SC-STAGE-021',
  agentId: DATA_ARCHITECT,
  title: 'Data Architecture',
  outputSchema: DataOutputSchema,
  outputJsonSchema: jsonSchemaFor(DataOutputSchema),
  requires: [ARTIFACT_TYPES.ARCHITECTURE_MODEL],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const arch = repository(
      ctx.store,
      ARTIFACT_TYPES.ARCHITECTURE_MODEL,
      ArchitectureModelSchema,
    ).list();
    const reqs = repository(ctx.store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
    const rules = repository(ctx.store, ARTIFACT_TYPES.BUSINESS_RULE, BusinessRuleSchema).list();
    return {
      canon: [
        contextFrom(
          'architecture',
          'ARCHITECTURE',
          arch,
          (a) => a.modules.map((m) => m.name + ' owns ' + m.owns.join('/')).join('; '),
          1,
        ),
        contextFrom('requirements', 'REQUIREMENT', reqs, (r) => r.statement, 1),
        contextFrom('rules', 'BUSINESS_RULE', rules, (r) => r.statement, 1),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'UX, design system, market research',
          reason:
            'the data model follows the business rules and the architecture, not the interface',
        },
      ],
    };
  },

  task(): string {
    return [
      'Define the data model, and — as importantly — what happens to the data over time.',
      '',
      'Every entity needs ONE owning module. Two modules that both believe they own the',
      'current price is the most reliable source of production data corruption there is.',
      '',
      'Classify every data element and say WHY it is held. Data with no stated purpose is',
      'a liability with a schema.',
      '',
      'Retention is policy, not plumbing: for each class, how long, by what basis, and what',
      'deleting actually means. RETAIN_IMMUTABLE is correct where historical or legal',
      'integrity forbids removal — say so rather than promising a delete you cannot honour.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Data architecture only. Do not choose a database product or write migrations.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const at = ctx.clock.now();
    const modelId = ctx.ids.next('SC-DM');
    repository(ctx.store, ARTIFACT_TYPES.DATA_MODEL, DataModelSchema).put(tx, {
      id: modelId,
      createdAt: at,
      entities: output.entities,
      relations: output.relations,
      transactionBoundaries: output.transactionBoundaries,
      meta: derived(ctx, DATA_ARCHITECT, ['architecture'], 'data model for the architecture'),
    });
    ids.push(modelId);

    const clsId = ctx.ids.next('SC-DCLS');
    repository(ctx.store, ARTIFACT_TYPES.DATA_CLASSIFICATION, DataClassificationSchema).put(tx, {
      id: clsId,
      createdAt: at,
      entries: output.classification,
      meta: derived(ctx, DATA_ARCHITECT, [modelId], 'what each element is and why it is held'),
    });
    ids.push(clsId);

    for (const r of output.retention) {
      const id = ctx.ids.next('SC-RET');
      repository(ctx.store, ARTIFACT_TYPES.RETENTION_POLICY, RetentionPolicySchema).put(tx, {
        id,
        createdAt: at,
        dataClass: r.dataClass,
        retention: r.retention,
        deletionMethod: r.deletionMethod,
        basis: r.basis,
        exceptions: [],
        meta: derived(ctx, DATA_ARCHITECT, [clsId], 'retention for ' + r.dataClass),
      });
      ids.push(id);
    }

    const ownershipId = ctx.ids.next('SC-EOWN');
    repository(ctx.store, ARTIFACT_TYPES.ENTITY_OWNERSHIP, EntityOwnershipSchema).put(tx, {
      id: ownershipId,
      createdAt: at,
      entries: output.entities.map((e) => ({
        entity: e.name,
        ownerModule: e.ownerModule,
        writers: [e.ownerModule],
        readers: [],
      })),
      meta: derived(ctx, DATA_ARCHITECT, [modelId], 'exactly one owner per entity'),
    });
    ids.push(ownershipId);

    if (output.migration !== undefined) {
      const id = ctx.ids.next('SC-MIG');
      repository(ctx.store, ARTIFACT_TYPES.MIGRATION_STRATEGY, MigrationStrategySchema).put(tx, {
        id,
        createdAt: at,
        approach: output.migration.approach,
        reversibility: output.migration.reversibility,
        testingRequirement: output.migration.testingRequirement,
        meta: derived(ctx, DATA_ARCHITECT, [modelId], 'how data reaches the new shape'),
      });
      ids.push(id);
    }

    /* Two entities claiming the same owner is fine; one entity with two owners is not. */
    const notes: string[] = [];
    const seen = new Map<string, string>();
    for (const e of output.entities) {
      const prior = seen.get(e.name);
      if (prior !== undefined && prior !== e.ownerModule) {
        notes.push('entity ' + e.name + ' is claimed by both ' + prior + ' and ' + e.ownerModule);
      }
      seen.set(e.name, e.ownerModule);
    }

    return { artifactIds: ids, notes };
  },
};

/* ==================================================== SC-AGENT-082 — data model review */

export const DataReviewOutputSchema = z
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

const DATA_REVIEWER = 'SC-AGENT-082';

export const dataReviewDepartment: DepartmentConfig<typeof DataReviewOutputSchema> = {
  id: 'DEPT-DATA-REVIEW',
  stageId: 'SC-STAGE-021',
  agentId: DATA_REVIEWER,
  title: 'Data Model Review',
  outputSchema: DataReviewOutputSchema,
  outputJsonSchema: jsonSchemaFor(DataReviewOutputSchema),
  requires: [ARTIFACT_TYPES.DATA_MODEL],
  /** SPEC §5: never the author of the model it reviews. */
  independentOf: [DATA_ARCHITECT],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const model = repository(ctx.store, ARTIFACT_TYPES.DATA_MODEL, DataModelSchema).list();
    const retention = repository(
      ctx.store,
      ARTIFACT_TYPES.RETENTION_POLICY,
      RetentionPolicySchema,
    ).list();
    const rules = repository(ctx.store, ARTIFACT_TYPES.BUSINESS_RULE, BusinessRuleSchema).list();
    return {
      canon: [
        contextFrom(
          'data-model',
          'DATA_MODEL',
          model,
          (m) => m.entities.map((e) => e.name + ' (' + e.ownerModule + ')').join(', '),
          1,
        ),
        contextFrom(
          'retention',
          'RETENTION',
          retention,
          (r) => r.dataClass + ': ' + r.retention,
          1,
        ),
        contextFrom('rules', 'BUSINESS_RULE', rules, (r) => r.statement, 1),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        { subject: 'the data architect’s reasoning', reason: 'the model is judged as recorded' },
      ],
    };
  },

  task(): string {
    return [
      'Review this data model. You did not design it.',
      '',
      'Check that every entity has exactly one owner, that transaction boundaries match',
      'the invariants the business rules require, that every data class has a retention',
      'policy, and that nothing promises a deletion the business cannot honour.',
      '',
      'Return NOT_ACCEPTABLE if anything BLOCKING remains.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Review only. Do not redesign the model.';
  },

  persist(_tx, output) {
    return {
      artifactIds: [],
      notes: [
        output.summary,
        ...output.findings.map((f) => 'JUDGED[' + f.severity + '] ' + f.statement),
      ],
      judgements: [
        {
          criterionRef: 'DA-1',
          met: output.verdict === 'ACCEPTABLE',
          by: DATA_REVIEWER,
          note: output.summary,
        },
      ],
    };
  },
};

/* ===================================================== SC-AGENT-090 — security architect */

export const SecurityOutputSchema = z
  .object({
    depth: z.enum(['LIGHT', 'STANDARD', 'DEEP']),
    scope: z.string().min(1),
    trustBoundaries: z
      .array(
        z
          .object({
            from: z.string().min(1),
            to: z.string().min(1),
            controls: z.array(z.string().min(1)).min(1),
            dataCrossing: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .min(1),
    threats: z
      .array(
        z
          .object({
            id: z.string().min(1),
            statement: z.string().min(1),
            affects: z.string().min(1),
            mitigations: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .min(1),
    abuseCases: z
      .array(
        z
          .object({
            actor: z.string().min(1),
            goal: z.string().min(1),
            method: z.string().min(1),
            impact: z.string().min(1),
            mitigations: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .min(1),
    auth: z
      .object({
        identitySources: z.array(z.string().min(1)).min(1),
        mechanisms: z.array(z.string().min(1)).min(1),
        sessionModel: z.string().min(1),
        rationale: z.string().min(1),
      })
      .strict(),
    authorization: z
      .object({
        model: z.enum(['RBAC', 'ABAC', 'RELATIONSHIP', 'HYBRID']),
        entries: z
          .array(
            z
              .object({
                role: z.string().min(1),
                resource: z.string().min(1),
                action: z.string().min(1),
                effect: z.enum(['ALLOW', 'DENY']),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    secrets: z
      .object({
        storage: z.string().min(1),
        rotation: z.string().min(1),
        distribution: z.string().min(1),
      })
      .strict(),
    privacy: z
      .object({
        dataInventory: z
          .array(
            z
              .object({
                data: z.string().min(1),
                why: z.string().min(1),
                accessibleBy: z.array(z.string().min(1)).default([]),
              })
              .strict(),
          )
          .min(1),
        subjectRights: z.array(z.string().min(1)).default([]),
        /** Set where a conclusion genuinely needs a professional. */
        expertReviewRequired: z.boolean(),
        expertReviewReason: z.string().min(1).optional(),
      })
      .strict(),
    residualRisks: z
      .array(
        z
          .object({
            risk: z.string().min(1),
            severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
            whyNotMitigated: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const SECURITY = 'SC-AGENT-090';

export const securityDepartment: DepartmentConfig<typeof SecurityOutputSchema> = {
  id: 'DEPT-SECURITY',
  stageId: 'SC-STAGE-022',
  agentId: SECURITY,
  title: 'Security & Privacy Architecture',
  outputSchema: SecurityOutputSchema,
  outputJsonSchema: jsonSchemaFor(SecurityOutputSchema),
  requires: [ARTIFACT_TYPES.ARCHITECTURE_MODEL, ARTIFACT_TYPES.DATA_MODEL],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const arch = repository(
      ctx.store,
      ARTIFACT_TYPES.ARCHITECTURE_MODEL,
      ArchitectureModelSchema,
    ).list();
    const model = repository(ctx.store, ARTIFACT_TYPES.DATA_MODEL, DataModelSchema).list();
    const cls = repository(
      ctx.store,
      ARTIFACT_TYPES.DATA_CLASSIFICATION,
      DataClassificationSchema,
    ).list();
    const actors = repository(ctx.store, ARTIFACT_TYPES.ACTOR, ActorSchema).list();
    const nfrs = repository(ctx.store, ARTIFACT_TYPES.NFR, NfrSchema).list();
    return {
      canon: [
        contextFrom('architecture', 'ARCHITECTURE', arch, (a) => a.style, 1),
        contextFrom(
          'data-model',
          'DATA_MODEL',
          model,
          (m) => m.entities.map((e) => e.name).join(', '),
          1,
        ),
        contextFrom(
          'classification',
          'DATA_CLASS',
          cls,
          (c) => c.entries.map((e) => e.dataElement + '=' + e.class).join(', '),
          1,
        ),
        contextFrom('actors', 'ACTOR', actors, (a) => a.name + ': ' + a.description, 1),
        contextFrom(
          'nfrs',
          'NFR',
          nfrs.filter((n) => n.dimension === 'SECURITY' || n.dimension === 'PRIVACY'),
          (n) => n.target,
          1,
        ),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'design system and market research',
          reason: 'not relevant to the threat model',
        },
      ],
    };
  },

  task(): string {
    return [
      'Model the security of this system. Depth scales with risk — say which depth you',
      'chose and why.',
      '',
      '"JWT + HTTPS" names two mechanisms and answers none of the real questions. Model',
      'the actual actors, resources and actions: who may do what, and what happens when',
      'one of those actors is hostile.',
      '',
      'Write abuse cases from the attacker’s point of view. They routinely surface',
      'requirements the functional analysis misses — a helpful bulk export endpoint is',
      'also a bulk exfiltration endpoint.',
      '',
      'Privacy: what data exists, why, who can reach it, and what rights apply. If a',
      'conclusion needs a lawyer or a certified assessor, set expertReviewRequired. Serva',
      'must never imply it performed a legal assessment it cannot perform.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Security and privacy DESIGN. No penetration testing, no legal certification, no implementation.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const at = ctx.clock.now();
    const boundaryIds: string[] = [];

    for (const b of output.trustBoundaries) {
      const id = ctx.ids.next('SC-TB');
      repository(ctx.store, ARTIFACT_TYPES.TRUST_BOUNDARY, TrustBoundarySchema).put(tx, {
        id,
        createdAt: at,
        between: [b.from, b.to],
        controls: b.controls,
        dataCrossing: b.dataCrossing,
        meta: derived(
          ctx,
          SECURITY,
          ['architecture'],
          'boundary between ' + b.from + ' and ' + b.to,
        ),
      });
      boundaryIds.push(id);
      ids.push(id);
    }

    const abuseIds: string[] = [];
    for (const a of output.abuseCases) {
      const id = ctx.ids.next('SC-ABUSE');
      repository(ctx.store, ARTIFACT_TYPES.ABUSE_CASE, AbuseCaseSchema).put(tx, {
        id,
        createdAt: at,
        actor: a.actor,
        goal: a.goal,
        method: a.method,
        impact: a.impact,
        mitigations: a.mitigations,
        requirementRefs: [],
        meta: derived(ctx, SECURITY, boundaryIds, 'how this system is misused'),
      });
      abuseIds.push(id);
      ids.push(id);
    }

    const tmId = ctx.ids.next('SC-TM');
    repository(ctx.store, ARTIFACT_TYPES.THREAT_MODEL, ThreatModelSchema).put(tx, {
      id: tmId,
      createdAt: at,
      scope: output.scope,
      boundaryRefs: boundaryIds.map((id) => ({ id })),
      threats: output.threats.map((t) => ({ ...t, mitigations: t.mitigations })),
      abuseCaseRefs: abuseIds.map((id) => ({ id })),
      depth: output.depth,
      meta: derived(ctx, SECURITY, boundaryIds, 'threat model at ' + output.depth + ' depth'),
    });
    ids.push(tmId);

    const authId = ctx.ids.next('SC-AUTH');
    repository(ctx.store, ARTIFACT_TYPES.AUTH_DESIGN, AuthDesignSchema).put(tx, {
      id: authId,
      createdAt: at,
      identitySources: output.auth.identitySources,
      mechanisms: output.auth.mechanisms,
      sessionModel: output.auth.sessionModel,
      rationale: output.auth.rationale,
      meta: derived(ctx, SECURITY, [tmId], 'authentication design'),
    });
    ids.push(authId);

    const azId = ctx.ids.next('SC-AZ');
    repository(ctx.store, ARTIFACT_TYPES.AUTHORIZATION_MODEL, AuthorizationModelSchema).put(tx, {
      id: azId,
      createdAt: at,
      model: output.authorization.model,
      entries: output.authorization.entries,
      defaultEffect: 'DENY',
      meta: derived(ctx, SECURITY, [tmId], 'who may do what to which resource'),
    });
    ids.push(azId);

    const secId = ctx.ids.next('SC-SEC');
    repository(ctx.store, ARTIFACT_TYPES.SECRETS_DESIGN, SecretsDesignSchema).put(tx, {
      id: secId,
      createdAt: at,
      storage: output.secrets.storage,
      rotation: output.secrets.rotation,
      distribution: output.secrets.distribution,
      inventory: [],
      meta: derived(ctx, SECURITY, [tmId], 'where secrets live and how they move'),
    });
    ids.push(secId);

    const privId = ctx.ids.next('SC-PRIV');
    repository(ctx.store, ARTIFACT_TYPES.PRIVACY_DESIGN, PrivacyDesignSchema).put(tx, {
      id: privId,
      createdAt: at,
      dataInventory: output.privacy.dataInventory.map((d) => ({
        data: d.data,
        why: d.why,
        flowsTo: [],
        accessibleBy: d.accessibleBy,
      })),
      externalProcessors: [],
      subjectRights: output.privacy.subjectRights,
      expertReviewRequired: output.privacy.expertReviewRequired,
      ...(output.privacy.expertReviewReason === undefined
        ? {}
        : { expertReviewReason: output.privacy.expertReviewReason }),
      meta: derived(ctx, SECURITY, [tmId], 'privacy design'),
    });
    ids.push(privId);

    const notes: string[] = [];
    for (const r of output.residualRisks) {
      const id = ctx.ids.next('SC-RRISK');
      repository(ctx.store, ARTIFACT_TYPES.RESIDUAL_RISK, ResidualRiskSchema).put(tx, {
        id,
        createdAt: at,
        risk: r.risk,
        severity: r.severity,
        whyNotMitigated: r.whyNotMitigated,
        /* Accepting a residual risk is an owner act, never an architectural one. */
        ownerDisposition: 'PENDING_OWNER',
        meta: derived(ctx, SECURITY, [tmId], 'risk that remains after mitigation'),
      });
      ids.push(id);
      notes.push('residual risk pending owner disposition: ' + r.risk + ' (' + r.severity + ')');
    }

    if (output.privacy.expertReviewRequired) {
      notes.push(
        'EXPERT_REVIEW_REQUIRED: ' +
          (output.privacy.expertReviewReason ?? 'a privacy conclusion here needs a professional'),
      );
    }

    return { artifactIds: ids, notes };
  },
};

export const DATA_SECURITY_DEPARTMENTS: readonly DepartmentConfig[] = Object.freeze([
  dataDepartment as DepartmentConfig,
  dataReviewDepartment as DepartmentConfig,
  securityDepartment as DepartmentConfig,
]);
