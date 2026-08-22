import { z } from 'zod';
import { RefSchema, artifact, enumOf } from './base.js';

/**
 * ADMIN OPERABILITY — mandatory for EVERY feature.
 *
 * SPEC: 12, 06 (SC-AGENT-140/141), SC-RTC-008.
 *
 * The question is not "does this feature need an admin page". It is: what must an
 * operator be able to see, change, override, and never change — and what must be audited
 * when they do.
 *
 * The reason this is mandatory rather than discretionary: features shipped without
 * operability become permanent engineering tickets. Every "can you just change the
 * commission rate for this one merchant" costs a deployment forever, because the decision
 * to hard-code it was never made — it was simply never considered.
 *
 * The opposite failure is worse. Making a security rule, a financial invariant or a
 * historical record freely configurable hands an operator the ability to break the
 * company's own guarantees from a settings page.
 */

export const ConfigClassification = {
  /** Safe for an operator to change at runtime. */
  OPERATOR_CONFIGURABLE: 'OPERATOR_CONFIGURABLE',
  /** Changeable, but only with elevated authority and an audit record. */
  PRIVILEGED: 'PRIVILEGED',
  /** Deploy-time only. Not a runtime knob. */
  DEPLOY_TIME: 'DEPLOY_TIME',
  /** Never configurable. See ProtectedRule. */
  PROTECTED: 'PROTECTED',
} as const;
export type ConfigClassification = (typeof ConfigClassification)[keyof typeof ConfigClassification];

export const ProtectionReason = {
  SECURITY: 'SECURITY',
  FINANCIAL: 'FINANCIAL',
  STRUCTURAL: 'STRUCTURAL',
  LEGAL: 'LEGAL',
  HISTORICAL_INTEGRITY: 'HISTORICAL_INTEGRITY',
} as const;
export type ProtectionReason = (typeof ProtectionReason)[keyof typeof ProtectionReason];

/**
 * Something that must never become an ordinary setting.
 *
 * `SC-RTC-008` cross-checks this register against the ConfigurationRegister and fails when
 * a protected rule appears as operator-configurable — a contradiction no amount of agent
 * confidence should be able to talk past.
 */
export const ProtectedRuleSchema = artifact({
  rule: z.string().min(1),
  protectionReason: enumOf(ProtectionReason),
  explanation: z.string().min(1),
  businessRuleRef: RefSchema.optional(),
});
export type ProtectedRule = z.output<typeof ProtectedRuleSchema>;

/**
 * Every configurable element, classified and justified.
 *
 * `effectiveDated` is the field that prevents a whole class of financial bug: changing a
 * commission rate must not retroactively rewrite what past orders charged. Anything
 * historically significant has to be version- or date-aware, and the checker enforces it.
 */
export const ConfigurationRegisterSchema = artifact({
  entries: z
    .array(
      z
        .object({
          element: z.string().min(1),
          classification: enumOf(ConfigClassification),
          justification: z.string().min(1),
          featureRef: RefSchema.optional(),
          /** True when past records must keep the value that applied at the time. */
          historicallySignificant: z.boolean().default(false),
          effectiveDated: z.boolean().default(false),
          requiresAudit: z.boolean().default(false),
          requiresConfirmation: z.boolean().default(false),
          reversible: z.boolean().default(true),
          defaultValue: z.string().min(1).optional(),
        })
        .strict(),
    )
    .default([]),
});
export type ConfigurationRegister = z.output<typeof ConfigurationRegisterSchema>;

export const AdminAuditRequirementSchema = artifact({
  action: z.string().min(1),
  /** Who did it, to what, when, and what it was before. */
  captures: z.array(z.string().min(1)).min(1),
  retention: z.string().min(1).optional(),
  featureRef: RefSchema.optional(),
});
export type AdminAuditRequirement = z.output<typeof AdminAuditRequirementSchema>;

/**
 * The mandated questions, answered per feature.
 *
 * Structured rather than prose so `SC-RTC-008` can tell an unanswered question from an
 * answered one. A review that says "no admin needs" is fine; a review that quietly omits
 * the question is not.
 */
export const AdminOperabilityReviewSchema = artifact({
  featureRef: RefSchema,
  whatOperatorMustView: z.array(z.string().min(1)).default([]),
  whatIsConfigurable: z.array(z.string().min(1)).default([]),
  whatCanBeOverridden: z.array(z.string().min(1)).default([]),
  whatShouldBeAutomated: z.array(z.string().min(1)).default([]),
  whatMustNeverBeConfigurable: z.array(z.string().min(1)).default([]),
  whatRequiresAudit: z.array(z.string().min(1)).default([]),
  whatRequiresConfirmation: z.array(z.string().min(1)).default([]),
  roleSeparation: z.array(z.string().min(1)).default([]),
  /** Explicit, so "this feature needs nothing" is a decision rather than an omission. */
  concluded: z.boolean(),
  conclusion: z.string().min(1),
});
export type AdminOperabilityReview = z.output<typeof AdminOperabilityReviewSchema>;

export const AdminIaSchema = artifact({
  sections: z
    .array(
      z
        .object({
          name: z.string().min(1),
          purpose: z.string().min(1),
          audienceRole: z.string().min(1).optional(),
          contains: z.array(z.string().min(1)).default([]),
        })
        .strict(),
    )
    .min(1),
});
export type AdminIa = z.output<typeof AdminIaSchema>;

/**
 * A control an operator can actually operate.
 *
 * `guardrail` is required for anything destructive. A button that permanently deletes a
 * merchant's data with no confirmation, no reversal and no audit is not an operational
 * control, it is an incident waiting for a mis-click.
 */
export const OperationalControlSchema = artifact({
  name: z.string().min(1),
  effect: z.string().min(1),
  destructive: z.boolean(),
  guardrail: z.string().min(1).optional(),
  reversible: z.boolean(),
  requiredRole: z.string().min(1).optional(),
  auditRequirementRef: RefSchema.optional(),
});
export type OperationalControl = z.output<typeof OperationalControlSchema>;
