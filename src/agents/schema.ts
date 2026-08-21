import { z } from 'zod';
import { BudgetProfile } from '../vocab/index.js';

/**
 * AgentContract — the runtime form of a contract in `32`.
 *
 * SPEC: 05 §2 (the 29-field schema), 32 §8 (resolution model), 30 §4 (membership).
 *
 * Two things make this more than a data shape:
 *
 *   1. `resolution` carries, per field, HOW that field resolved -- LOCAL,
 *      INHERITED(block), DERIVED(rule) or NONE (32 §8.1). "Every contract resolves
 *      every field" is therefore checkable by reading the artifact, not by trusting
 *      the sentence in the specification that says so.
 *   2. `.strict()` throughout, so a generator that emits a field the schema does not
 *      model fails loudly rather than having it silently dropped on load.
 */

/** 32 §8.1 — the four resolution kinds, plus the composite forms 32 §8.2 uses. */
const ResolutionKindSchema = z
  .string()
  .min(1)
  .refine(
    (v) =>
      v === 'LOCAL' ||
      v === 'NONE' ||
      v.startsWith('INHERITED(') ||
      v.startsWith('DERIVED(') ||
      v.includes('+'),
    { message: 'resolution must be LOCAL, NONE, INHERITED(...), DERIVED(...) or a union' },
  );

/** The 29 schema fields of 05 §2, each with the rule that produced its value. */
export const ContractResolutionSchema = z
  .object({
    id: ResolutionKindSchema,
    name: ResolutionKindSchema,
    version: ResolutionKindSchema,
    department: ResolutionKindSchema,
    tier: ResolutionKindSchema,
    archetype: ResolutionKindSchema,
    authorityLevel: ResolutionKindSchema,
    magnitudeCeiling: ResolutionKindSchema,
    mission: ResolutionKindSchema,
    responsibilities: ResolutionKindSchema,
    nonResponsibilities: ResolutionKindSchema,
    inputs: ResolutionKindSchema,
    outputs: ResolutionKindSchema,
    outputSchemaRef: ResolutionKindSchema,
    tools: ResolutionKindSchema,
    filesystemScope: ResolutionKindSchema,
    networkScope: ResolutionKindSchema,
    allowedActions: ResolutionKindSchema,
    forbiddenActions: ResolutionKindSchema,
    refusalSurface: ResolutionKindSchema,
    requiredEvidence: ResolutionKindSchema,
    qualityCriteria: ResolutionKindSchema,
    escalationConditions: ResolutionKindSchema,
    failureConditions: ResolutionKindSchema,
    proposalBehavior: ResolutionKindSchema,
    reviewResponsibilities: ResolutionKindSchema,
    conflictOfInterest: ResolutionKindSchema,
    contextBudget: ResolutionKindSchema,
    untrustedContentRule: ResolutionKindSchema,
  })
  .strict();

/** The count is the check: 05 §2 has 29 fields and CR-R8 forbids any drift. */
export const SCHEMA_FIELD_COUNT = 29;

const nonEmpty = z.array(z.string().min(1));

export const AgentContractSchema = z
  .object({
    id: z.string().regex(/^SC-AGENT-\d{3}$/),
    name: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    department: z.string().regex(/^SC-DEPT-\d{3}$/),
    /** 30 §3 has six tiers; T-1 governance through T-6 operations and learning. */
    tier: z.number().int().min(1).max(6),
    archetype: z.enum(['GOVERNOR', 'ANALYST', 'DEFINER', 'ARCHITECT', 'PRODUCER', 'VERIFIER']),
    authorityLevel: z.enum(['OBSERVE', 'ADVISE', 'RECOMMEND', 'DECIDE', 'EXECUTE', 'VERIFY']),
    magnitudeCeiling: z.string().min(1),
    mission: z.string().min(1),
    responsibilities: nonEmpty.min(1),
    nonResponsibilities: nonEmpty,
    inputs: nonEmpty.min(1),
    outputs: z.string().min(1),
    outputSchemaRef: z.string().regex(/^SCH-[A-Z0-9-]+$/),
    outputDeterminism: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('GENERATIVE') }).strict(),
      z.object({ kind: z.literal('JUDGMENT') }).strict(),
      z
        .object({
          kind: z.literal('MIXED'),
          generative: z.array(z.string()),
          judgment: z.array(z.string()),
        })
        .strict(),
    ]),
    tools: z.string().min(1),
    filesystemScope: z.string().min(1),
    networkScope: z.string().min(1),
    allowedActions: z.string(),
    forbiddenActions: nonEmpty.min(1),
    refusalSurface: nonEmpty.min(1),
    requiredEvidence: z.array(z.string()),
    qualityCriteria: nonEmpty.min(1),
    escalationConditions: nonEmpty.min(1),
    failureConditions: nonEmpty.min(1),
    proposalBehavior: z.string().min(1),
    reviewResponsibilities: z.string().min(1),
    conflictOfInterest: z
      .object({
        inherited: z.string().min(1),
        local: z.string(),
        derived: z.array(z.object({ with: z.array(z.string()), basis: z.string() }).strict()),
      })
      .strict(),
    contextBudget: z.nativeEnum(BudgetProfile),
    untrustedContentRule: z.string().min(1),
    inherits: z.array(z.string().regex(/^[AT]-[A-Z]+$/)).min(1),
    /** 32 §9.1 — the Agent Existence Test criteria that justify a separate agent. */
    aet: z
      .object({ criteria: z.array(z.string().regex(/^AET-\d$/)).min(1), justification: z.string() })
      .strict(),
    resolution: ContractResolutionSchema,
  })
  .strict();

export type AgentContract = z.output<typeof AgentContractSchema>;

export const ContractRegistryFileSchema = z
  .object({
    $generated: z
      .object({
        by: z.string(),
        from: z.string(),
        specDigest: z.string().length(64),
        specBaseline: z.string(),
        note: z.string(),
      })
      .strict(),
    inheritance: z.object({}).passthrough(),
    conflictOfInterestPairs: z.array(
      z.object({ a: z.string(), b: z.string(), basis: z.string() }).strict(),
    ),
    contracts: z.array(AgentContractSchema),
    counts: z.object({ contracts: z.number().int(), coiPairs: z.number().int() }).strict(),
  })
  .strict();

export type ContractRegistryFile = z.output<typeof ContractRegistryFileSchema>;
