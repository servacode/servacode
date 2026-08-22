import { z } from 'zod';
import { RefSchema, artifact, enumOf } from './base.js';

/**
 * TEST DESIGN — before implementation, not after.
 *
 * SPEC: 15, 06 (SC-AGENT-210/211).
 *
 * Test cases are derived from the SPECIFICATION, and the independence rule that makes
 * that meaningful is a context rule: `SC-AGENT-211` must not be shown the implementation
 * while designing specification-derived cases. Given the code, a test designer writes
 * tests that pass — they describe what was built rather than what was asked for, and the
 * gap between the two is exactly what testing exists to find.
 */

export const TestLevel = {
  UNIT: 'UNIT',
  INTEGRATION: 'INTEGRATION',
  CONTRACT: 'CONTRACT',
  END_TO_END: 'END_TO_END',
  MANUAL: 'MANUAL',
  SECURITY: 'SECURITY',
  PERFORMANCE: 'PERFORMANCE',
  ACCESSIBILITY: 'ACCESSIBILITY',
} as const;
export type TestLevel = (typeof TestLevel)[keyof typeof TestLevel];

export const TestKind = {
  HAPPY_PATH: 'HAPPY_PATH',
  NEGATIVE: 'NEGATIVE',
  BOUNDARY: 'BOUNDARY',
  PERMISSION: 'PERMISSION',
  STATE_TRANSITION: 'STATE_TRANSITION',
  ERROR_HANDLING: 'ERROR_HANDLING',
  REGRESSION: 'REGRESSION',
  BUSINESS_INVARIANT: 'BUSINESS_INVARIANT',
  SECURITY_BEHAVIOUR: 'SECURITY_BEHAVIOUR',
} as const;
export type TestKind = (typeof TestKind)[keyof typeof TestKind];

/**
 * How each thing that was promised will be verified.
 *
 * The mapping is the artifact. A strategy that lists techniques without saying which
 * requirement each one covers cannot answer the only question that matters at a gate:
 * is there anything we said we would do that nothing checks?
 */
export const TestStrategySchema = artifact({
  approach: z.string().min(1),
  levels: z.array(enumOf(TestLevel)).min(1),
  coverage: z
    .array(
      z
        .object({
          /** Requirement, AC, NFR, Risk, BusinessRule, StateMachine or UserFlow. */
          targetRef: RefSchema,
          targetKind: z.string().min(1),
          level: enumOf(TestLevel),
          approach: z.string().min(1),
        })
        .strict(),
    )
    .default([]),
  environments: z.array(z.string().min(1)).default([]),
  /** Stated rather than discovered later: what this strategy deliberately does not cover. */
  outOfScope: z.array(z.string().min(1)).default([]),
});
export type TestStrategy = z.output<typeof TestStrategySchema>;

export const TestCaseSchema = artifact({
  title: z.string().min(1),
  /** Upward trace to what it verifies. An untraced case tests somebody's imagination. */
  derivedFrom: z.array(RefSchema).min(1),
  level: enumOf(TestLevel),
  kind: enumOf(TestKind),
  preconditions: z.array(z.string().min(1)).default([]),
  steps: z.array(z.string().min(1)).min(1),
  expected: z.string().min(1),
  /**
   * True when the designer was shown implementation detail.
   *
   * Recorded so a reviewer can tell a specification-derived case from one written against
   * the code. Both are useful; only one of them can find a missing feature.
   */
  implementationInformed: z.boolean().default(false),
});
export type TestCase = z.output<typeof TestCaseSchema>;

export const TestDataStrategySchema = artifact({
  approach: z.string().min(1),
  /** Production data in a test environment is a privacy incident with extra steps. */
  productionDataUse: z.enum(['NEVER', 'ANONYMISED', 'SYNTHETIC_ONLY']),
  fixtures: z.array(z.string().min(1)).default([]),
  sensitiveDataHandling: z.string().min(1).optional(),
});
export type TestDataStrategy = z.output<typeof TestDataStrategySchema>;

/** DERIVED: what is covered, and — the useful half — what is not. */
export const TestCoverageReportSchema = artifact({
  covered: z.array(RefSchema).default([]),
  uncovered: z.array(z.object({ ref: RefSchema, why: z.string().min(1) }).strict()).default([]),
});
export type TestCoverageReport = z.output<typeof TestCoverageReportSchema>;
