import { z } from 'zod';
import { RefSchema, artifact, enumOf } from './base.js';
import { Confidence } from '../provenance.js';

/**
 * INFRASTRUCTURE & COST.
 *
 * SPEC: 08 §3.4, 12, 23, 06 (SC-AGENT-100/110).
 *
 * Two disciplines share this file because they constrain each other. Infrastructure
 * decides the shape; cost decides whether the shape is affordable; and the pairing is what
 * prevents "infrastructure theatre" — a nine-service topology with a Kubernetes cluster
 * for a product with forty users, chosen because it looks professional.
 *
 * Nothing here deploys anything. Phase 5 designs the operational shape and stops.
 */

export const EnvironmentModelSchema = artifact({
  environments: z
    .array(
      z
        .object({
          name: z.string().min(1),
          purpose: z.string().min(1),
          /** Whether real user data may exist here. The answer is usually "no". */
          dataPolicy: z.string().min(1),
          parity: z.string().min(1).optional(),
        })
        .strict(),
    )
    .min(1),
});
export type EnvironmentModel = z.output<typeof EnvironmentModelSchema>;

export const DeploymentStrategySchema = artifact({
  approach: z.string().min(1),
  /** How a bad release stops being live. Required — see RollbackSpec. */
  rolloutControl: z.string().min(1),
  downtimeExpectation: z.string().min(1),
  rationale: z.string().min(1),
});
export type DeploymentStrategy = z.output<typeof DeploymentStrategySchema>;

export const ConfigurationDeliverySchema = artifact({
  mechanism: z.string().min(1),
  /** Configuration is not secrets; conflating them is how credentials reach a repo. */
  secretsHandling: z.string().min(1),
  changeProcess: z.string().min(1),
  auditability: z.string().min(1).optional(),
});
export type ConfigurationDelivery = z.output<typeof ConfigurationDeliverySchema>;

/**
 * What can be seen when it breaks at 3am.
 *
 * `signalsForNfrs` ties observability back to the NFRs it exists to verify. Monitoring
 * that measures nothing anyone promised is dashboards, not observability.
 */
export const ObservabilitySpecSchema = artifact({
  logs: z.string().min(1),
  metrics: z.array(z.string().min(1)).default([]),
  traces: z.string().min(1).optional(),
  alerts: z
    .array(
      z
        .object({
          condition: z.string().min(1),
          severity: z.string().min(1),
          response: z.string().min(1),
        })
        .strict(),
    )
    .default([]),
  signalsForNfrs: z.array(RefSchema).default([]),
});
export type ObservabilitySpec = z.output<typeof ObservabilitySpecSchema>;

/** A backup nobody has restored is a hope. `testedAt` is why this field exists. */
export const BackupSpecSchema = artifact({
  mechanism: z.string().min(1),
  frequency: z.string().min(1),
  retention: z.string().min(1),
  restoreProcedure: z.string().min(1),
  testedAt: z.string().min(1).optional(),
  evidenceRef: RefSchema.optional(),
});
export type BackupSpec = z.output<typeof BackupSpecSchema>;

export const RollbackSpecSchema = artifact({
  mechanism: z.string().min(1),
  /** Rollback with a schema change is a different problem; it is asked about explicitly. */
  dataImplications: z.string().min(1),
  timeToRollback: z.string().min(1).optional(),
  testedAt: z.string().min(1).optional(),
});
export type RollbackSpec = z.output<typeof RollbackSpecSchema>;

/* --------------------------------------------------------------------------- cost */

export const CostBasis = {
  /** A published price, captured as a source. */
  SOURCED: 'SOURCED',
  /** A reasoned estimate. Must carry its reasoning and its confidence. */
  ESTIMATED: 'ESTIMATED',
} as const;
export type CostBasis = (typeof CostBasis)[keyof typeof CostBasis];

/**
 * A monetary figure that knows where it came from.
 *
 * SPEC: §23 — never fabricate vendor pricing. Every amount is either SOURCED with a
 * citation or ESTIMATED with a basis and a confidence. There is no third option, because
 * an unlabelled number in a cost model is indistinguishable from a real quote by the time
 * it reaches a budget conversation.
 */
export const MoneySchema = z
  .object({
    amount: z.number().min(0),
    currency: z.string().length(3),
    period: z.enum(['ONE_OFF', 'PER_MONTH', 'PER_YEAR', 'PER_UNIT']),
    basis: enumOf(CostBasis),
    /** Required for ESTIMATED; a citation for SOURCED. Enforced by `costRefusal`. */
    basisDetail: z.string().min(1),
    confidence: enumOf(Confidence).optional(),
    sourceRefs: z.array(RefSchema).default([]),
  })
  .strict();
export type Money = z.output<typeof MoneySchema>;

export function costRefusal(m: Money): string | undefined {
  if (m.basis === CostBasis.SOURCED && m.sourceRefs.length === 0) {
    return 'a SOURCED cost cites no source, which makes it an estimate wearing a stronger word';
  }
  if (m.basis === CostBasis.ESTIMATED && m.confidence === undefined) {
    return 'an ESTIMATED cost must state its confidence, or a reader cannot tell a guess from a quote';
  }
  return undefined;
}

export const CostModelSchema = artifact({
  buildCost: MoneySchema.optional(),
  runCost: z.array(z.object({ item: z.string().min(1), cost: MoneySchema }).strict()).default([]),
  /** Serva's own consumption is a running cost of the product, and is counted. */
  aiConsumption: MoneySchema.optional(),
  assumptions: z.array(z.string().min(1)).default([]),
});
export type CostModel = z.output<typeof CostModelSchema>;

export const CostAssessmentSchema = artifact({
  costModelRef: RefSchema,
  budgetRef: RefSchema.optional(),
  verdict: z.enum(['WITHIN_BUDGET', 'EXCEEDS_BUDGET', 'NO_BUDGET_STATED', 'UNKNOWN']),
  /** Exceeding budget is an owner decision, never a silent continuation. */
  ownerDecisionRef: RefSchema.optional(),
  narrative: z.string().min(1),
});
export type CostAssessment = z.output<typeof CostAssessmentSchema>;

export const LicensingAssessmentSchema = artifact({
  entries: z
    .array(
      z
        .object({
          component: z.string().min(1),
          licence: z.string().min(1),
          obligations: z.array(z.string().min(1)).default([]),
          commercialUseOk: z.enum(['YES', 'NO', 'CONDITIONAL', 'UNKNOWN']),
          note: z.string().min(1).optional(),
        })
        .strict(),
    )
    .min(1),
  expertReviewRequired: z.boolean().default(false),
});
export type LicensingAssessment = z.output<typeof LicensingAssessmentSchema>;

/** How expensive it would be to leave. The question vendors prefer nobody asks early. */
export const LockInAssessmentSchema = artifact({
  entries: z
    .array(
      z
        .object({
          vendor: z.string().min(1),
          dependency: z.string().min(1),
          exitCost: z.enum(['LOW', 'MEDIUM', 'HIGH', 'PROHIBITIVE']),
          exitPath: z.string().min(1),
          dataPortability: z.string().min(1).optional(),
        })
        .strict(),
    )
    .min(1),
});
export type LockInAssessment = z.output<typeof LockInAssessmentSchema>;

export const BudgetStateSchema = artifact({
  stated: MoneySchema.optional(),
  /** Absent is a legitimate state and must not be read as unlimited. */
  ownerStated: z.boolean(),
  notes: z.string().min(1).optional(),
});
export type BudgetState = z.output<typeof BudgetStateSchema>;
