import { z } from 'zod';
import { RefSchema, artifact, enumOf } from './base.js';

/**
 * DATA ARCHITECTURE.
 *
 * SPEC: 08 §3.4, 06 (SC-AGENT-080/082), 17 (classification and retention).
 *
 * Retention and deletion are modelled here rather than left to implementation because
 * they are policy, not plumbing. "How long do we keep this, and what does deleting it
 * actually mean" is a question with legal consequences and exactly one defensible answer
 * per data class — and it is far cheaper to answer before the schema exists than after
 * the data does.
 */

export const DataModelSchema = artifact({
  entities: z
    .array(
      z
        .object({
          name: z.string().min(1),
          description: z.string().min(1),
          /** The module that owns writes. Shared ownership is how invariants die. */
          ownerModule: z.string().min(1),
          identifierStrategy: z.string().min(1),
          attributes: z
            .array(
              z
                .object({
                  name: z.string().min(1),
                  type: z.string().min(1),
                  required: z.boolean().default(false),
                  note: z.string().min(1).optional(),
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
          note: z.string().min(1).optional(),
        })
        .strict(),
    )
    .default([]),
  /** Where a transaction must be atomic, and where eventual consistency is acceptable. */
  transactionBoundaries: z.array(z.string().min(1)).default([]),
});
export type DataModel = z.output<typeof DataModelSchema>;

export const DataClass = {
  PUBLIC: 'PUBLIC',
  INTERNAL: 'INTERNAL',
  CONFIDENTIAL: 'CONFIDENTIAL',
  PERSONAL: 'PERSONAL',
  SENSITIVE_PERSONAL: 'SENSITIVE_PERSONAL',
  FINANCIAL: 'FINANCIAL',
  CREDENTIAL: 'CREDENTIAL',
} as const;
export type DataClass = (typeof DataClass)[keyof typeof DataClass];

export const DataClassificationSchema = artifact({
  entries: z
    .array(
      z
        .object({
          dataElement: z.string().min(1),
          class: enumOf(DataClass),
          handlingRules: z.array(z.string().min(1)).min(1),
          /** Why it is held at all. Data with no purpose is a liability with a schema. */
          purpose: z.string().min(1),
        })
        .strict(),
    )
    .min(1),
});
export type DataClassification = z.output<typeof DataClassificationSchema>;

export const DeletionMethod = {
  HARD_DELETE: 'HARD_DELETE',
  SOFT_DELETE: 'SOFT_DELETE',
  ANONYMISE: 'ANONYMISE',
  /** Kept deliberately — historical or legal integrity forbids removal. */
  RETAIN_IMMUTABLE: 'RETAIN_IMMUTABLE',
} as const;
export type DeletionMethod = (typeof DeletionMethod)[keyof typeof DeletionMethod];

export const RetentionPolicySchema = artifact({
  dataClass: enumOf(DataClass),
  retention: z.string().min(1),
  deletionMethod: enumOf(DeletionMethod),
  /** The obligation that fixes this period, where one exists. */
  basis: z.string().min(1),
  exceptions: z.array(z.string().min(1)).default([]),
});
export type RetentionPolicy = z.output<typeof RetentionPolicySchema>;

export const ConsistencyModelSchema = artifact({
  entries: z
    .array(
      z
        .object({
          scope: z.string().min(1),
          model: z.enum(['STRONG', 'EVENTUAL', 'CAUSAL', 'READ_YOUR_WRITES']),
          rationale: z.string().min(1),
          /** What a user sees while it converges. The part that becomes a support ticket. */
          userVisibleEffect: z.string().min(1).optional(),
        })
        .strict(),
    )
    .min(1),
});
export type ConsistencyModel = z.output<typeof ConsistencyModelSchema>;

/**
 * How data gets from the old shape to the new one.
 *
 * `reversibility` is required. A migration nobody can undo is an irreversible commitment,
 * which under 09 makes it an owner-authority question rather than an engineering one.
 */
export const MigrationStrategySchema = artifact({
  approach: z.string().min(1),
  reversibility: z.enum(['REVERSIBLE', 'PARTIALLY_REVERSIBLE', 'IRREVERSIBLE']),
  testingRequirement: z.string().min(1),
  dataLossRisk: z.string().min(1).optional(),
});
export type MigrationStrategy = z.output<typeof MigrationStrategySchema>;

export const EntityOwnershipSchema = artifact({
  entries: z
    .array(
      z
        .object({
          entity: z.string().min(1),
          ownerModule: z.string().min(1),
          writers: z.array(z.string().min(1)).default([]),
          readers: z.array(z.string().min(1)).default([]),
        })
        .strict(),
    )
    .min(1),
  ssotRef: RefSchema.optional(),
});
export type EntityOwnership = z.output<typeof EntityOwnershipSchema>;
