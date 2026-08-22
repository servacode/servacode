import { z } from 'zod';
import { RefSchema, artifact } from './base.js';

/**
 * UX AUTHORITY.
 *
 * SPEC: 08 §3.4, 13, 06 (SC-AGENT-120/123).
 *
 * The invariant that earns its keep: **no happy-path-only UX**. Every flow must say what
 * happens when the list is empty, when the request is slow, when it half-succeeds, when it
 * fails, when the user is not allowed, and when the network is gone.
 *
 * Those states are where real products are won and lost, and they are exactly the states
 * that get "designed" during implementation by whoever is closest to the deadline. Making
 * coverage a structured, checkable artifact means the omission is visible before code
 * exists rather than after a user finds it.
 */

/** The states every meaningful flow must account for (13 §5). */
export const UiState = {
  DEFAULT: 'DEFAULT',
  EMPTY: 'EMPTY',
  LOADING: 'LOADING',
  PARTIAL: 'PARTIAL',
  ERROR: 'ERROR',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  SUCCESS: 'SUCCESS',
  OFFLINE: 'OFFLINE',
} as const;
export type UiState = (typeof UiState)[keyof typeof UiState];

/** Offline is conditional; the rest are required wherever a flow can reach them. */
export const REQUIRED_UI_STATES: readonly UiState[] = Object.freeze([
  UiState.DEFAULT,
  UiState.EMPTY,
  UiState.LOADING,
  UiState.PARTIAL,
  UiState.ERROR,
  UiState.PERMISSION_DENIED,
  UiState.SUCCESS,
]);

export const UserJourneySchema = artifact({
  name: z.string().min(1),
  segmentRef: RefSchema,
  /** The goal in the user's terms, not the system's. */
  goal: z.string().min(1),
  steps: z
    .array(
      z
        .object({
          order: z.number().int().min(1),
          action: z.string().min(1),
          systemResponse: z.string().min(1),
          flowRef: RefSchema.optional(),
        })
        .strict(),
    )
    .min(1),
  requirementRefs: z.array(RefSchema).default([]),
});
export type UserJourney = z.output<typeof UserJourneySchema>;

export const FlowSchema = artifact({
  name: z.string().min(1),
  entryPoints: z.array(z.string().min(1)).min(1),
  steps: z.array(z.string().min(1)).min(1),
  exitPoints: z.array(z.string().min(1)).default([]),
  requirementRefs: z.array(RefSchema).default([]),
  /** Set when a state genuinely cannot occur here, with the reason. */
  notApplicableStates: z
    .array(z.object({ state: z.string().min(1), reason: z.string().min(1) }).strict())
    .default([]),
});
export type Flow = z.output<typeof FlowSchema>;

/**
 * What each screen or flow does in each state.
 *
 * `NOT_APPLICABLE` requires a reason, which is the whole mechanism: a designer may declare
 * that a flow has no empty state, but must say why, and a reviewer can disagree with the
 * sentence. Silence is not available.
 */
export const StateCoverageSchema = artifact({
  flowRef: RefSchema,
  screen: z.string().min(1),
  states: z
    .array(
      z
        .object({
          state: z.string().min(1),
          behaviour: z.string().min(1).optional(),
          disposition: z.enum(['DEFINED', 'NOT_APPLICABLE']),
          reason: z.string().min(1).optional(),
        })
        .strict(),
    )
    .min(1),
});
export type StateCoverage = z.output<typeof StateCoverageSchema>;

/** Which required states this coverage fails to account for. Empty means complete. */
export function missingStates(c: StateCoverage): readonly string[] {
  const accounted = new Set(
    c.states
      .filter((s) => s.disposition === 'DEFINED' || (s.reason ?? '').trim() !== '')
      .map((s) => s.state),
  );
  return REQUIRED_UI_STATES.filter((s) => !accounted.has(s));
}

export const InformationArchitectureSchema = artifact({
  sections: z
    .array(
      z
        .object({
          name: z.string().min(1),
          contains: z.array(z.string().min(1)).default([]),
          audience: z.string().min(1).optional(),
        })
        .strict(),
    )
    .min(1),
  rationale: z.string().min(1),
});
export type InformationArchitecture = z.output<typeof InformationArchitectureSchema>;

export const NavigationModelSchema = artifact({
  pattern: z.string().min(1),
  primary: z.array(z.string().min(1)).min(1),
  secondary: z.array(z.string().min(1)).default([]),
  /** How a user knows where they are. Routinely forgotten, always missed. */
  wayfinding: z.string().min(1).optional(),
});
export type NavigationModel = z.output<typeof NavigationModelSchema>;

export const ContentStrategySchema = artifact({
  voice: z.string().min(1),
  /** Error messages are content, and the ones written under pressure are the worst. */
  errorMessageGuidance: z.string().min(1),
  terminologySource: RefSchema.optional(),
  localisation: z.string().min(1).optional(),
});
export type ContentStrategy = z.output<typeof ContentStrategySchema>;

export const UsabilityCriteriaSchema = artifact({
  criteria: z
    .array(
      z
        .object({
          statement: z.string().min(1),
          /** Measurable where it can be: "a new user completes checkout in under 90s". */
          measure: z.string().min(1),
          appliesTo: RefSchema.optional(),
        })
        .strict(),
    )
    .min(1),
});
export type UsabilityCriteria = z.output<typeof UsabilityCriteriaSchema>;
