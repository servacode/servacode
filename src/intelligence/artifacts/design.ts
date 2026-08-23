import { z } from 'zod';
import { RefSchema, artifact, enumOf } from './base.js';
import { OptionDisposition } from './governance.js';

/**
 * DESIGN SYSTEM AUTHORITY.
 *
 * SPEC: 08 §3.4, 13, 06 (SC-AGENT-130/131/133).
 *
 * Serva owns the visual system. The owner may supply genuine brand constraints — a logo,
 * an established palette, an identity — but "what border radius" and "which grey" are
 * Serva decisions, and asking the owner is a failure of the department, not politeness.
 *
 * Two mechanical rules make the system real rather than decorative:
 *
 *   a component may only reference SEMANTIC tokens, never raw values;
 *   every component must specify every required state.
 *
 * Both are checkable, and `deterministic.ts` checks them. A design system whose rules are
 * only in prose is a style guide, and style guides lose to deadlines.
 */

/** Token categories R4 requires a complete system to define (13 §4). */
export const REQUIRED_TOKEN_CATEGORIES: readonly string[] = Object.freeze([
  'color',
  'typography',
  'spacing',
  'radius',
  'elevation',
  'motion',
  'breakpoint',
  'zIndex',
  'border',
  'opacity',
]);

/**
 * A token set, split into primitives and the semantic roles that reference them.
 *
 * The split is the point. `color.blue.600` is a fact about a palette; `color.action.primary`
 * is a decision about meaning, and it is the only kind a component is allowed to consume.
 * Without the indirection, rebranding means finding every blue in the product and guessing
 * which ones meant "primary action".
 */
export const DesignTokenSetSchema = artifact({
  primitives: z
    .array(
      z
        .object({
          name: z.string().min(1),
          category: z.string().min(1),
          value: z.string().min(1),
        })
        .strict(),
    )
    .default([]),
  semantic: z
    .array(
      z
        .object({
          name: z.string().min(1),
          category: z.string().min(1),
          /** The primitive this role resolves to. */
          references: z.string().min(1),
          purpose: z.string().min(1),
          /** Optional per-theme overrides; absent means it is theme-independent. */
          themes: z.record(z.string().min(1)).optional(),
        })
        .strict(),
    )
    .min(1),
});
export type DesignTokenSet = z.output<typeof DesignTokenSetSchema>;

/** States a component must define before it can be used (13 §5). */
export const REQUIRED_COMPONENT_STATES: readonly string[] = Object.freeze([
  'default',
  'hover',
  'focus',
  'active',
  'disabled',
  'loading',
  'error',
]);

export const ComponentSpecSchema = artifact({
  name: z.string().min(1),
  anatomy: z.array(z.string().min(1)).min(1),
  variants: z.array(z.string().min(1)).default([]),
  states: z
    .array(
      z
        .object({
          state: z.string().min(1),
          appearance: z.string().min(1),
          /** Semantic token names only. Raw values are rejected by the checker. */
          tokens: z.array(z.string().min(1)).default([]),
        })
        .strict(),
    )
    .min(1),
  a11y: z
    .object({
      role: z.string().min(1).optional(),
      keyboard: z.array(z.string().min(1)).default([]),
      labelling: z.string().min(1).optional(),
      /** Minimum interactive target, checked mechanically where it can be. */
      minTargetPx: z.number().int().positive().optional(),
    })
    .strict(),
  /** Which properties flip under RTL. Designed here, never patched downstream. */
  rtl: z
    .object({
      mirrors: z.boolean(),
      directionalProperties: z.array(z.string().min(1)).default([]),
      exceptions: z.array(z.string().min(1)).default([]),
    })
    .strict(),
});
export type ComponentSpec = z.output<typeof ComponentSpecSchema>;

export const LayoutSystemSchema = artifact({
  grid: z.string().min(1),
  breakpoints: z
    .array(z.object({ name: z.string().min(1), min: z.string().min(1) }).strict())
    .min(1),
  spacingScale: z.array(z.string().min(1)).min(1),
  containerStrategy: z.string().min(1).optional(),
});
export type LayoutSystem = z.output<typeof LayoutSystemSchema>;

/**
 * How the interface behaves in a right-to-left language.
 *
 * A separate artifact because retrofitting RTL is one of the most expensive corrections in
 * front-end work: it touches every margin, icon, animation direction and text alignment in
 * the product. Deciding it up front costs a paragraph.
 */
export const RtlRulesSchema = artifact({
  supported: z.boolean(),
  /** Properties that must be logical rather than physical: margin-inline-start, not -left. */
  logicalProperties: z.array(z.string().min(1)).default([]),
  mirroredIcons: z.array(z.string().min(1)).default([]),
  /** Things that must NOT mirror — phone numbers, code, logos, media controls. */
  neverMirror: z.array(z.string().min(1)).default([]),
  numeralHandling: z.string().min(1).optional(),
});
export type RtlRules = z.output<typeof RtlRulesSchema>;

export const AccessibilitySpecSchema = artifact({
  targetStandard: z.string().min(1),
  contrastMinimums: z
    .array(z.object({ context: z.string().min(1), ratio: z.number().positive() }).strict())
    .min(1),
  minTargetPx: z.number().int().positive(),
  keyboardModel: z.string().min(1),
  focusVisible: z.string().min(1),
  motionPreference: z.string().min(1).optional(),
  /**
   * Automated checks find a fraction of accessibility defects. Claiming conformance from
   * a checker is a false statement about a legal standard, so it is recorded separately.
   */
  formalConformanceClaimed: z.literal(false).default(false),
  expertReviewRequired: z.boolean().default(true),
});
export type AccessibilitySpec = z.output<typeof AccessibilitySpecSchema>;

export const MotionSpecSchema = artifact({
  durations: z
    .array(z.object({ name: z.string().min(1), ms: z.number().int().positive() }).strict())
    .min(1),
  easings: z.array(z.object({ name: z.string().min(1), curve: z.string().min(1) }).strict()).min(1),
  /** Respecting reduced-motion is an accessibility requirement, not a nicety. */
  reducedMotionBehaviour: z.string().min(1),
});
export type MotionSpec = z.output<typeof MotionSpecSchema>;

export const DesignDecisionSchema = artifact({
  /**
   * A Proposal this decision rules on, if it rules on one.
   *
   * SPEC: §33. The pair below is how an authority's ANSWER becomes durable project
   * truth rather than something a caller asserts. `accept()` resolves this artifact; it
   * does not take a disposition as an argument, and there is no argument to take.
   *
   * Un-forgeable by construction rather than by checking: the ScopedCanonWriter already
   * restricts this artifact family to the agent whose contract declares it, so a decision
   * carrying a disposition was necessarily written by the authority that owns the canon.
   */
  proposalRef: RefSchema.optional(),
  /**
   * What was decided, in the vocabulary Serva already routes on.
   *
   * `OptionDisposition` is reused deliberately: a second verdict taxonomy would be a
   * second thing to keep in step, and APPROVE / REJECT / DEFER already mean exactly this.
   */
  proposalDisposition: enumOf(OptionDisposition).optional(),
  context: z.string().min(1),
  chosen: z.string().min(1),
  alternatives: z.array(z.string().min(1)).default([]),
  rationale: z.string().min(1),
  affects: z.array(RefSchema).default([]),
});
export type DesignDecision = z.output<typeof DesignDecisionSchema>;

/**
 * A sanctioned deviation from the system, with an expiry.
 *
 * `expiresAt` is mandatory because a permanent exception is not an exception, it is an
 * undocumented second design system. The deterministic checker fails expired ones.
 */
export const DesignExceptionSchema = artifact({
  scope: z.string().min(1),
  reason: z.string().min(1),
  approver: z.string().min(1),
  expiresAt: z.string().min(1),
});
export type DesignException = z.output<typeof DesignExceptionSchema>;

export const ScreenCompositionSchema = artifact({
  screen: z.string().min(1),
  flowRef: RefSchema.optional(),
  /** Composed from existing components. SC-AGENT-131 may not invent new ones. */
  componentRefs: z.array(RefSchema).min(1),
  layoutRef: RefSchema.optional(),
  notes: z.string().min(1).optional(),
});
export type ScreenComposition = z.output<typeof ScreenCompositionSchema>;
