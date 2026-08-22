import { z } from 'zod';
import { IdSchema, IsoSchema } from '../../domain/schemas.js';
import { IntelligenceMetaSchema } from '../provenance.js';

/**
 * The shape every canonical intelligence artifact shares.
 *
 * SPEC: 08 §3 (entity catalogue), 08 §2 (durability tiers).
 *
 * Two fields carry most of the weight.
 *
 * `meta` is the provenance envelope, and it is required rather than optional because an
 * artifact whose origin is unknown is not usable as company truth — you cannot decide
 * whether to trust it, whether it expires, or whether it should have been an Assumption.
 *
 * `version` exists because R4 treats intelligence as versioned canon: a refresh creates a
 * NEW version rather than editing the old one, so a decision made last month still points
 * at what it actually relied on. Overwriting would make the audit trail a lie of omission.
 */
export const ArtifactBaseSchema = z.object({
  id: IdSchema,
  version: z.number().int().positive().default(1),
  createdAt: IsoSchema,
  meta: IntelligenceMetaSchema,
});

/**
 * Compose an artifact schema from the base plus its own fields.
 *
 * `.strict()` throughout, deliberately. A typo in a field name should fail loudly at the
 * boundary rather than silently produce an artifact missing the thing the author meant to
 * say — half the value of these schemas is that they refuse incomplete intelligence.
 */
export function artifact<T extends z.ZodRawShape>(shape: T) {
  return ArtifactBaseSchema.extend(shape).strict();
}

/** A reference to another artifact, optionally pinned to the version relied upon. */
export const RefSchema = z
  .object({
    id: IdSchema,
    version: z.number().int().positive().optional(),
  })
  .strict();
export type Ref = z.output<typeof RefSchema>;

/**
 * When research-backed truth stops being current.
 *
 * SPEC: 11 §6, 16 §7. Competitive truth expires: a competitor ships, a price changes, a
 * gap closes. `validUntil` is what lets a gate refuse to treat last quarter's landscape
 * as this quarter's, without anyone having to remember to go and check.
 */
export const FreshnessSchema = z
  .object({
    retrievedAt: IsoSchema,
    validUntil: IsoSchema,
  })
  .strict();

export const enumOf = <T extends Record<string, string>>(e: T): z.ZodType<T[keyof T]> => {
  const values = Object.values(e) as [string, ...string[]];
  return z.enum(values) as unknown as z.ZodType<T[keyof T]>;
};

/** Priority vocabulary shared by goals, features and requirements (03, 08 §3). */
export const Priority = {
  MUST: 'MUST',
  SHOULD: 'SHOULD',
  COULD: 'COULD',
  WONT: 'WONT',
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

/** Coarse magnitude, used for impact and change sizing (03 §6, SC-POL-013). */
export const Magnitude = {
  M1: 'M1',
  M2: 'M2',
  M3: 'M3',
  M4: 'M4',
} as const;
export type Magnitude = (typeof Magnitude)[keyof typeof Magnitude];
