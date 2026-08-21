import { z } from 'zod';
import { Magnitude, RequestClass } from '../vocab/index.js';

/**
 * Orchestration record shapes. SPEC: 04 §3 (classification), 04 §6 (assembly).
 *
 * Two schemas per concept, and the duplication is deliberate:
 *
 *   - a Zod schema, which is what Serva validates the engine's answer against;
 *   - a JSON Schema, which is what the engine is asked to produce.
 *
 * "The provider says it is valid" and "Serva accepts it" are different claims
 * (19 SO-2). The engine validates against the JSON Schema it was given; Serva then
 * validates independently against its own. A test round-trips a valid document
 * through both so the pair cannot drift apart silently.
 */

/* ------------------------------------------------------------ classification */

export const ClassificationSignalSchema = z
  .object({
    signal: z.string().min(1),
    /** 04 §3.2 — every signal cites the state it was read from, never an adjective. */
    readFrom: z.string().min(1),
    effect: z.string().min(1),
  })
  .strict();

export const RequestClassificationSchema = z
  .object({
    requestClass: z.nativeEnum(RequestClass),
    magnitude: z.nativeEnum(Magnitude),
    affectedAreas: z.array(z.string()),
    signals: z.array(ClassificationSignalSchema),
    researchRequired: z.boolean(),
    impactAnalysisRequired: z.boolean(),
    ownerDecisionRequired: z.boolean(),
    recommendedDepartments: z.array(z.string().regex(/^SC-DEPT-\d{3}$/)),
    riskFlags: z.array(z.string()),
    confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    multiIntent: z.boolean(),
    unresolved: z.array(z.string()),
  })
  .strict();

export type RequestClassification = z.output<typeof RequestClassificationSchema>;

export const REQUEST_CLASSIFICATION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'requestClass',
    'magnitude',
    'affectedAreas',
    'signals',
    'researchRequired',
    'impactAnalysisRequired',
    'ownerDecisionRequired',
    'recommendedDepartments',
    'riskFlags',
    'confidence',
    'multiIntent',
    'unresolved',
  ],
  properties: {
    requestClass: { type: 'string', enum: Object.values(RequestClass) },
    magnitude: { type: 'string', enum: Object.values(Magnitude) },
    affectedAreas: { type: 'array', items: { type: 'string' } },
    signals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['signal', 'readFrom', 'effect'],
        properties: {
          signal: { type: 'string', minLength: 1 },
          readFrom: { type: 'string', minLength: 1 },
          effect: { type: 'string', minLength: 1 },
        },
      },
    },
    researchRequired: { type: 'boolean' },
    impactAnalysisRequired: { type: 'boolean' },
    ownerDecisionRequired: { type: 'boolean' },
    recommendedDepartments: { type: 'array', items: { type: 'string' } },
    riskFlags: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
    multiIntent: { type: 'boolean' },
    unresolved: { type: 'array', items: { type: 'string' } },
  },
};

/* -------------------------------------------------------------- execution plan */

export const PlanStepSchema = z
  .object({
    stepId: z.string().min(1),
    agentId: z.string().regex(/^SC-AGENT-\d{3}$/),
    departmentId: z.string().regex(/^SC-DEPT-\d{3}$/),
    purpose: z.string().min(1),
    scopeBoundary: z.string().min(1),
    dependsOn: z.array(z.string()),
    /** The artifact this step is expected to produce, for CoI reasoning. */
    produces: z.string().min(1),
  })
  .strict();

export const ExecutionPlanSchema = z
  .object({
    planFor: z.nativeEnum(RequestClass),
    magnitude: z.nativeEnum(Magnitude),
    rationale: z.string().min(1),
    steps: z.array(PlanStepSchema),
    /** 04 §5, SC-POL-024 — a stage skipped without a recorded reason is a defect. */
    omissions: z.array(
      z.object({ omitted: z.string().min(1), reason: z.string().min(1) }).strict(),
    ),
    ownerDecisionsRequired: z.array(z.string()),
    unresolved: z.array(z.string()),
  })
  .strict();

export type ExecutionPlan = z.output<typeof ExecutionPlanSchema>;
export type PlanStep = z.output<typeof PlanStepSchema>;

export const EXECUTION_PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'planFor',
    'magnitude',
    'rationale',
    'steps',
    'omissions',
    'ownerDecisionsRequired',
    'unresolved',
  ],
  properties: {
    planFor: { type: 'string', enum: Object.values(RequestClass) },
    magnitude: { type: 'string', enum: Object.values(Magnitude) },
    rationale: { type: 'string', minLength: 1 },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'stepId',
          'agentId',
          'departmentId',
          'purpose',
          'scopeBoundary',
          'dependsOn',
          'produces',
        ],
        properties: {
          stepId: { type: 'string', minLength: 1 },
          agentId: { type: 'string' },
          departmentId: { type: 'string' },
          purpose: { type: 'string', minLength: 1 },
          scopeBoundary: { type: 'string', minLength: 1 },
          dependsOn: { type: 'array', items: { type: 'string' } },
          produces: { type: 'string', minLength: 1 },
        },
      },
    },
    omissions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['omitted', 'reason'],
        properties: {
          omitted: { type: 'string', minLength: 1 },
          reason: { type: 'string', minLength: 1 },
        },
      },
    },
    ownerDecisionsRequired: { type: 'array', items: { type: 'string' } },
    unresolved: { type: 'array', items: { type: 'string' } },
  },
};

/* ------------------------------------------------------------- request record */

export const RequestRecordSchema = z
  .object({
    id: z.string().min(1),
    /** Verbatim. Never normalised, never paraphrased, never trusted as instruction. */
    text: z.string().min(1),
    receivedAt: z.string(),
    source: z.enum(['OWNER_CLI', 'OWNER_UI', 'SYSTEM']),
    workItemId: z.string().min(1),
  })
  .strict();

export type RequestRecord = z.output<typeof RequestRecordSchema>;
