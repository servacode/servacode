import { z } from 'zod';
import { RefSchema, artifact, enumOf } from './base.js';

/**
 * ARCHITECTURE & TECHNOLOGY.
 *
 * SPEC: 08 §3.4, §3.6, 06 (SC-AGENT-070/071/072).
 *
 * The governing rule is simplicity with receipts. Every complexity pattern must name the
 * requirement that forces it, and `ComplexityJustification` requires
 * `simplerOptionRejected` — because the interesting question is never "is Kubernetes
 * good", it is "what did we consider instead, and what specifically ruled it out".
 *
 * Without that field the honest answer ("it is what I have used before") is invisible, and
 * an architecture accumulates machinery nobody can later argue against because nobody
 * recorded the argument for it.
 */

export const ArchitectureModelSchema = artifact({
  style: z.string().min(1),
  modules: z
    .array(
      z
        .object({
          name: z.string().min(1),
          responsibility: z.string().min(1),
          /** What this module owns exclusively. Overlap here is a defect. */
          owns: z.array(z.string().min(1)).default([]),
        })
        .strict(),
    )
    .min(1),
  interactions: z
    .array(
      z
        .object({
          from: z.string().min(1),
          to: z.string().min(1),
          via: z.string().min(1),
          synchronous: z.boolean(),
        })
        .strict(),
    )
    .default([]),
  rationale: z.string().min(1),
});
export type ArchitectureModel = z.output<typeof ArchitectureModelSchema>;

export const ModuleContractSchema = artifact({
  ownerModule: z.string().min(1),
  interface: z.string().min(1),
  /** What callers may rely on. An interface without invariants is a shape, not a contract. */
  invariants: z.array(z.string().min(1)).min(1),
  errors: z.array(z.string().min(1)).default([]),
});
export type ModuleContract = z.output<typeof ModuleContractSchema>;

/**
 * Where each piece of truth lives, and who may derive from it.
 *
 * Two modules that both consider themselves authoritative for "the current price" is the
 * single most reliable source of production data corruption. This register makes the
 * question answerable before it becomes an incident.
 */
export const SSOTRegisterSchema = artifact({
  entries: z
    .array(
      z
        .object({
          truthElement: z.string().min(1),
          location: z.string().min(1),
          consumers: z.array(z.string().min(1)).default([]),
          derivation: z.string().min(1).optional(),
        })
        .strict(),
    )
    .min(1),
});
export type SSOTRegister = z.output<typeof SSOTRegisterSchema>;

/**
 * Why this architecture is more complicated than the obvious one.
 *
 * `forcingRequirementRef` points at a real Requirement or NFR. "Scalable", "enterprise"
 * and "production-grade" are not forcing requirements; `p95 < 200ms at 10k concurrent
 * users` is.
 */
export const ComplexityJustificationSchema = artifact({
  pattern: z.string().min(1),
  forcingRequirementRef: RefSchema,
  simplerOptionRejected: z.string().min(1),
  whyRejected: z.string().min(1),
});
export type ComplexityJustification = z.output<typeof ComplexityJustificationSchema>;

/** DERIVED: NFR → mechanism → verification. An unmapped NFR is an unmet one. */
export const NfrMappingSchema = artifact({
  entries: z
    .array(
      z
        .object({
          nfrRef: RefSchema,
          mechanism: z.string().min(1).optional(),
          verification: z.string().min(1).optional(),
          /** Explicit and visible, rather than an NFR quietly missing from the list. */
          status: z.enum(['SATISFIED', 'PARTIAL', 'UNSATISFIED', 'DEFERRED']),
          note: z.string().min(1).optional(),
        })
        .strict(),
    )
    .default([]),
});
export type NfrMapping = z.output<typeof NfrMappingSchema>;

/**
 * A technology comparison where the criteria were fixed BEFORE the scores.
 *
 * SPEC: §19. `criteriaDeclaredAt` and `scoredAt` exist so that ordering is checkable
 * rather than promised. Criteria invented after the fact reliably describe whichever
 * option the author already preferred, and the resulting evaluation is advocacy with a
 * table.
 */
export const TechnologyEvaluationSchema = artifact({
  decisionArea: z.string().min(1),
  criteria: z
    .array(
      z
        .object({
          name: z.string().min(1),
          weight: z.number().min(0).max(1).optional(),
          rationale: z.string().min(1),
        })
        .strict(),
    )
    .min(1),
  criteriaDeclaredAt: z.string().min(1),
  candidates: z
    .array(
      z
        .object({
          name: z.string().min(1),
          scores: z
            .array(
              z
                .object({
                  criterion: z.string().min(1),
                  score: z.number(),
                  basis: z.string().min(1),
                })
                .strict(),
            )
            .default([]),
          costNote: z.string().min(1).optional(),
          lockInNote: z.string().min(1).optional(),
          securityNote: z.string().min(1).optional(),
        })
        .strict(),
    )
    .min(2),
  scoredAt: z.string().min(1),
});
export type TechnologyEvaluation = z.output<typeof TechnologyEvaluationSchema>;

/** At least two real candidates, and criteria fixed first. Reported, not thrown. */
export function evaluationRefusal(e: TechnologyEvaluation): string | undefined {
  if (e.candidates.length < 2) {
    return (
      'TechnologyEvaluation ' +
      e.id +
      ' considered ' +
      String(e.candidates.length) +
      ' candidate(s): a comparison of one is a preference, not an evaluation'
    );
  }
  if (Date.parse(e.criteriaDeclaredAt) > Date.parse(e.scoredAt)) {
    return (
      'TechnologyEvaluation ' +
      e.id +
      ' declared its criteria AFTER scoring, so the criteria may describe the winner rather than the need'
    );
  }
  return undefined;
}

export const DecisionClass = {
  ARCHITECTURE: 'ARCHITECTURE',
  TECHNOLOGY: 'TECHNOLOGY',
  DATA: 'DATA',
  SECURITY: 'SECURITY',
  DESIGN: 'DESIGN',
  PRODUCT: 'PRODUCT',
  OPERATIONAL: 'OPERATIONAL',
} as const;
export type DecisionClass = (typeof DecisionClass)[keyof typeof DecisionClass];

/**
 * An Architecture Decision Record.
 *
 * `reversalCost` and `reevaluationTrigger` are what make a decision revisitable instead of
 * permanent by default. A choice recorded without them becomes load-bearing simply because
 * nobody remembers whether it can be undone.
 */
export const AdrSchema = artifact({
  class: enumOf(DecisionClass),
  title: z.string().min(1),
  context: z.string().min(1),
  options: z
    .array(z.object({ option: z.string().min(1), consequence: z.string().min(1) }).strict())
    .min(2),
  chosen: z.string().min(1),
  drivers: z.array(RefSchema).default([]),
  evidenceRefs: z.array(RefSchema).default([]),
  rationale: z.string().min(1),
  rejectedReasons: z.array(z.string().min(1)).min(1),
  consequences: z.array(z.string().min(1)).min(1),
  reversalCost: z.enum(['LOW', 'MEDIUM', 'HIGH', 'IRREVERSIBLE']),
  reevaluationTrigger: z.string().min(1),
  evaluationRef: RefSchema.optional(),
});
export type Adr = z.output<typeof AdrSchema>;
