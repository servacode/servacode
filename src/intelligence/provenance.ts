import { z } from 'zod';
import { SourceMarking, TrustLevel } from '../vocab/index.js';
import { IdSchema, IsoSchema } from '../domain/schemas.js';

/**
 * WHERE EVERY INTELLIGENCE FACT CAME FROM.
 *
 * SPEC: 08 §4 (knowledge model), 16 (evidence model), SC-POL-005.
 *
 * The single most dangerous thing an intelligence system can do is launder a guess into a
 * fact. "I think users probably want offline mode" and "three of the four current
 * alternatives work offline" are different claims that render identically once the
 * hedging is stripped, and everything downstream — scope, requirements, architecture,
 * cost — treats them the same way.
 *
 * So provenance is not metadata attached to a fact; it is part of the fact. A statement
 * with no marking cannot be constructed, because the schema requires one.
 *
 * INFERRED is not a weaker kind of true. It is a different thing entirely, and 08 §4 is
 * explicit: an inference that would materially affect the product must be promoted to an
 * Assumption, and a load-bearing Assumption that nobody has validated must show up in
 * Risk and in the gate rather than sitting quietly inside a paragraph.
 */

const enumOf = <T extends Record<string, string>>(e: T): z.ZodType<T[keyof T]> => {
  const values = Object.values(e) as [string, ...string[]];
  return z.enum(values) as unknown as z.ZodType<T[keyof T]>;
};

/** How confident an inference is. Deliberately coarse: false precision is worse than none. */
export const Confidence = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
} as const;
export type Confidence = (typeof Confidence)[keyof typeof Confidence];

/**
 * A reference to captured source evidence, never to a bare URL.
 *
 * A URL is a promise that someone else will keep a page unchanged for you, and they will
 * not. Verification has to work against what was actually retrieved, which is why this
 * points at a SourceCapture record rather than at the web. See `research/capture.ts`.
 */
export const SourceRefSchema = z
  .object({
    captureId: IdSchema,
    /** The exact passage relied on, so a verifier can check the claim against it. */
    locator: z.string().min(1).optional(),
  })
  .strict();
export type SourceRef = z.output<typeof SourceRefSchema>;

const OwnerStatedSchema = z
  .object({
    marking: z.literal(SourceMarking.OWNER_STATED),
    /** Recorded verbatim where it matters; paraphrasing an owner is how intent drifts. */
    verbatim: z.string().min(1).optional(),
    statedAt: IsoSchema,
  })
  .strict();

const DerivedSchema = z
  .object({
    marking: z.literal(SourceMarking.DERIVED),
    /** The artifacts this was derived FROM. Empty is not derivation, it is invention. */
    from: z.array(z.string().min(1)).min(1),
    rationale: z.string().min(1),
  })
  .strict();

const ResearchedSchema = z
  .object({
    marking: z.literal(SourceMarking.RESEARCHED),
    /** At least one captured source. RESEARCHED without a citation is INFERRED. */
    sources: z.array(SourceRefSchema).min(1),
    /** Retrieved content is never trusted, whatever it says about itself. */
    trust: z.literal(TrustLevel.UNTRUSTED).default(TrustLevel.UNTRUSTED),
  })
  .strict();

const InferredSchema = z
  .object({
    marking: z.literal(SourceMarking.INFERRED),
    basis: z.string().min(1),
    confidence: enumOf(Confidence),
    /**
     * Whether the product would change if this inference were wrong.
     *
     * The whole point of the distinction. A load-bearing inference must carry an
     * Assumption id; `assertProvenance` refuses it otherwise, so the promotion cannot be
     * forgotten under time pressure.
     */
    loadBearing: z.boolean(),
    assumptionId: IdSchema.optional(),
  })
  .strict();

const SystemSchema = z
  .object({
    marking: z.literal(SourceMarking.SYSTEM),
    component: z.string().min(1),
  })
  .strict();

export const ProvenanceSchema = z.discriminatedUnion('marking', [
  OwnerStatedSchema,
  DerivedSchema,
  ResearchedSchema,
  InferredSchema,
  SystemSchema,
]);
export type Provenance = z.output<typeof ProvenanceSchema>;

/** Who produced the fact. A run, not a conversation. */
export const AttributionSchema = z
  .object({
    /** The governed AgentRun. Project truth comes from the Store, never from a session. */
    runId: z.string().min(1).optional(),
    agentId: IdSchema.optional(),
    at: IsoSchema,
  })
  .strict();

/**
 * The envelope every intelligence artifact carries.
 *
 * `stageId` and `workItemId` are here so a fact can always be traced back to the stage
 * that produced it — which is what makes staleness computable when that stage re-runs.
 */
export const IntelligenceMetaSchema = z
  .object({
    provenance: ProvenanceSchema,
    attribution: AttributionSchema,
    stageId: z.string().min(1).optional(),
    workItemId: z.string().min(1).optional(),
  })
  .strict();
export type IntelligenceMeta = z.output<typeof IntelligenceMetaSchema>;

/**
 * The invariant a schema alone cannot express.
 *
 * Returns the reason this provenance is not acceptable, or undefined. Kept as a function
 * rather than a Zod refinement so callers can report it as a finding on a gate instead of
 * only as a parse error — an unpromoted inference is a governance problem, not a syntax
 * one.
 */
export function provenanceRefusal(p: Provenance): string | undefined {
  if (p.marking === SourceMarking.INFERRED && p.loadBearing && p.assumptionId === undefined) {
    return 'a load-bearing INFERRED fact must be promoted to an Assumption and cite its id: an inference the product depends on is a risk, not a finding';
  }
  if (p.marking === SourceMarking.RESEARCHED && p.sources.length === 0) {
    return 'RESEARCHED requires at least one captured source; without one the fact is INFERRED';
  }
  return undefined;
}

export function assertProvenance(p: Provenance): void {
  const refusal = provenanceRefusal(p);
  if (refusal !== undefined) throw new Error('PROVENANCE_REFUSED: ' + refusal);
}

/** True when this fact rests on research, and therefore expires. See `freshness.ts`. */
export function isResearched(p: Provenance): boolean {
  return p.marking === SourceMarking.RESEARCHED;
}
