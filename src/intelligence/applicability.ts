import { getCatalogues } from '../catalogue/index.js';
import { fail } from '../core/errors.js';
import { StageLedgerDisposition } from '../vocab/index.js';
import type { ProfileDef, StageDef } from '../catalogue/index.js';

/**
 * WHICH STAGES RUN, AND WHY THE OTHERS DID NOT.
 *
 * SPEC: 03 §7 (profiles), 04 §5 (selection), SC-POL-024 (omissions are recorded).
 *
 * The failure this exists to prevent is not "too few stages ran". It is a project that
 * looks complete because the stages that would have found the problem were never
 * mentioned. A profile that simply *omits* Discovery leaves no trace that discovery was a
 * question anyone considered; a profile that records `NOT_APPLICABLE(PRF-FEATURE)` leaves
 * a reader able to disagree with it.
 *
 * So resolution is TOTAL: every stage in the catalogue gets a disposition, including the
 * ones that will not run. There is no third category of "not mentioned".
 */

/** The upstream half of the lifecycle — the part Phase 5 is responsible for. */
export const INTELLIGENCE_PHASES: readonly string[] = Object.freeze(['A', 'B', 'C', 'D']);

export interface StageApplicability {
  readonly stageId: string;
  readonly name: string;
  readonly phase: string;
  /** EXECUTED is never asserted here — this decides only APPLICABILITY. */
  readonly disposition: StageLedgerDisposition;
  /** The spec's own qualifier, where it has one: delta, light, assess, re-check… */
  readonly mode?: string;
  /** Why, in a sentence a person can disagree with. */
  readonly reason: string;
  /** The gate that follows this stage, when it has one. */
  readonly gate?: string;
  /** True when this stage belongs to Phase 5 rather than to implementation. */
  readonly upstream: boolean;
}

export interface ApplicabilityPlan {
  readonly profileId: string;
  readonly profile: ProfileDef;
  /** Every stage in the catalogue, in lifecycle order. Nothing is omitted silently. */
  readonly stages: readonly StageApplicability[];
  /** The upstream stages that will actually run, in order. */
  readonly upstreamToRun: readonly StageApplicability[];
  /** Obligations the spec states in prose that a stage list cannot express. */
  readonly proseObligations: readonly string[];
}

function isUpstream(stage: StageDef): boolean {
  return INTELLIGENCE_PHASES.includes(stage.phase);
}

/**
 * Resolve a profile into a total plan.
 *
 * `skip` lets a caller record a deliberate omission that the PROFILE would otherwise
 * include — an owner decision, or a precondition that is genuinely absent. It is separate
 * from profile applicability on purpose: "this profile never runs Discovery" and "we chose
 * not to run Discovery this time" are different facts and a reader must be able to tell
 * them apart.
 */
export function resolveApplicability(
  profileId: string,
  opts: { readonly skip?: Readonly<Record<string, string>> } = {},
): ApplicabilityPlan {
  const cat = getCatalogues();
  const profile = cat.profile(profileId);
  if (profile === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Unknown lifecycle profile: ' + profileId,
      remedy:
        'Profiles are canonical in 03 §7 and generated into the catalogue. Serva does not invent one.',
      details: { profileId, known: cat.profileIds },
      specRef: '03 §7',
    });
  }

  const selected = new Map<string, string | undefined>();
  for (const entry of profile.stages) {
    selected.set('SC-STAGE-' + entry.stage, entry.mode);
  }

  const stages = cat.stages.map((stage): StageApplicability => {
    const upstream = isUpstream(stage);
    const gate = stage.gate ?? undefined;
    const base = {
      stageId: stage.id,
      name: stage.name,
      phase: stage.phase,
      upstream,
      ...(gate === undefined || gate === null ? {} : { gate }),
    };

    const skipReason = opts.skip?.[stage.id];
    if (skipReason !== undefined) {
      return {
        ...base,
        disposition: StageLedgerDisposition.SKIPPED,
        reason: skipReason,
      };
    }

    if (!selected.has(stage.id)) {
      return {
        ...base,
        disposition: StageLedgerDisposition.NOT_APPLICABLE,
        reason: 'not selected by ' + profile.id + ' (' + profile.appliesTo + ')',
      };
    }

    const mode = selected.get(stage.id);
    return {
      ...base,
      disposition: StageLedgerDisposition.IN_PROGRESS,
      ...(mode === undefined ? {} : { mode }),
      reason:
        mode === undefined
          ? 'selected by ' + profile.id
          : 'selected by ' + profile.id + ', scoped: ' + mode,
    };
  });

  return {
    profileId: profile.id,
    profile,
    stages,
    upstreamToRun: stages.filter(
      (s) => s.upstream && s.disposition === StageLedgerDisposition.IN_PROGRESS,
    ),
    /*
     * `045 + root-cause record` and `013 or targeted research` are obligations and
     * alternatives the spec writes in prose. They are surfaced rather than dropped,
     * because a plan that keeps only the stage numbers means less than the spec says.
     */
    proseObligations: profile.unparsedStageTerms,
  };
}

/** The gates that guard the upstream stages this profile will run, in order. */
export function upstreamGatesFor(plan: ApplicabilityPlan): readonly string[] {
  const seen: string[] = [];
  for (const s of plan.upstreamToRun) {
    if (s.gate !== undefined && !seen.includes(s.gate)) seen.push(s.gate);
  }
  return seen;
}
