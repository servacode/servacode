import { fail } from '../core/errors.js';
import { AuditAction, audit } from '../events/audit.js';
import { RoleAuthority, actorRefusal, assertActor } from '../core/actorAuthority.js';
import { ContractRegistry } from '../agents/registry.js';
import { ARTIFACT_TYPES, repository } from './repository.js';
import {
  ApplicabilityAssessmentSchema,
  CandidateItemSchema,
  CandidateStatus,
  FailedApproachSchema,
  LessonLearnedSchema,
  ReusablePatternSchema,
  leakageRefusal,
} from './artifacts/learning.js';
import type {
  ApplicabilityAssessment,
  CandidateItem,
  FailedApproach,
  LessonLearned,
  ReusablePattern,
} from './artifacts/learning.js';
import type { Store } from '../store/store.js';
import type { Clock } from '../core/clock.js';
import type { IdSource } from '../core/ids.js';

/**
 * ORGANIZATIONAL LEARNING, AND THE WALL.
 *
 * SPEC: §38, §39, 11, 27, 28.
 *
 * Two obligations that pull against each other, resolved by making one of them a
 * precondition of the other:
 *
 *   Serva should get better at building software as it builds more of it.
 *   Nothing about one client's project may reach another.
 *
 * The resolution is that the export path is the ONLY path, and it refuses. A lesson, a
 * pattern or a failed approach is offered to the shared library through `contribute*`,
 * which runs `leakageRefusal` over every field a reader would ever see — statement,
 * context, problem, solution, symptoms — and refuses the whole artifact if any of it still
 * carries a path, a URL, an email, a project id, a credential or a fragment of code.
 *
 * Refusing rather than redacting is deliberate. Redaction produces something that looks
 * clean and is not: the sentence still describes one specific client's situation, minus
 * the words that made that obvious. What must happen instead is that somebody writes the
 * general version.
 *
 * The second wall is on the import side. `offerCandidate` produces a CANDIDATE, and a
 * candidate is not an instruction. `assessApplicability` is the independent judgement that
 * it fits THIS project, and `applyPattern` refuses without one — because "it worked last
 * time" is the reasoning behind most inappropriate architecture, and prior success is not
 * authority.
 */

export interface LearningDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdSource;
}

/** Every field a future reader could see. All of it is checked, not just the summary. */
function refuseLeakage(kind: string, fields: readonly string[]): void {
  const reasons = [...new Set(fields.flatMap((f) => leakageRefusal(f)))];
  if (reasons.length === 0) return;
  fail({
    code: 'E_ISOLATION',
    message: 'Refusing to publish this ' + kind + ': ' + reasons.join('; '),
    remedy:
      'Cross-project knowledge is a generalisation, not a redaction. Rewrite it so it describes the KIND of situation rather than this one — if that cannot be done without the specifics, it is not a lesson, it is a project detail.',
    details: { reasons },
    specRef: '§39',
  });
}

/**
 * PROVE THE CURATOR, RATHER THAN TAKING ITS NAME.
 *
 * SPEC: §32; CRITICAL finding ORGANIZATIONAL-LEARNING-CORE/SEC-1.
 *
 * `KNOWLEDGE_CURATOR` was exported and never compared to anything. `curatedBy` arrived as a
 * plain string and went straight into `meta.attribution.agentId`, so any caller holding a
 * `LearningDeps` — store, clock, ids; no registry, no run context — could publish company
 * knowledge attributed to any agent it chose to name, including SC-AGENT-290 itself.
 *
 * The module's own docstring claimed the curator and the assessor were "declared independent
 * of one another" and that independence was "checked, not assumed". Nothing was checked: two
 * different literal strings satisfied it.
 *
 * `proposals.ts` already held the answer, with a comment saying precisely why — "a
 * caller-supplied actor string is not proof of a governed run." So a contribution now cites a
 * run, and the run is resolved: it must exist, it must have COMPLETED, and it must have been
 * made by the agent the contribution claims. Attribution still RECORDS who acted; it no longer
 * GRANTS the permission to.
 */
function assertCurator(deps: LearningDeps, curatedBy: string, curatorRunId: string): void {
  assertActor(
    {
      store: deps.store,
      registry: ContractRegistry.shared(),
      actorRunId: curatorRunId,
      claimedAgentId: curatedBy,
      requiredAuthority: RoleAuthority.CURATE,
    },
    (message, details) =>
      fail({
        code: 'E_GATE_AUTHORITY',
        message: 'Organizational learning may not be published: ' + message,
        remedy:
          'Generalised knowledge outlives the project it came from, so one governed role owns it and the run that performed the act is resolved rather than named.',
        details,
        specRef: '§32',
      }),
  );
}

/** Contribute a lesson. Generalised or refused; there is no third outcome. */
export function contributeLesson(
  deps: LearningDeps,
  o: {
    readonly statement: string;
    readonly context: string;
    readonly applicableWhen: string;
    readonly curatedBy: string;
    /** The governed run that performed this curation. Resolved, never taken on trust. */
    readonly curatorRunId: string;
  },
): LessonLearned {
  assertCurator(deps, o.curatedBy, o.curatorRunId);
  refuseLeakage('lesson', [o.statement, o.context, o.applicableWhen]);
  const at = deps.clock.now();
  const lesson = LessonLearnedSchema.parse({
    id: deps.ids.next('SC-LL'),
    createdAt: at,
    statement: o.statement,
    context: o.context,
    generalised: true,
    applicableWhen: o.applicableWhen,
    meta: {
      provenance: {
        /*
         * INFERRED rather than DERIVED, and deliberately so. A generalisation cannot cite
         * the artifacts it came from — those belong to another client — so there is
         * nothing for DERIVED's `from` to hold. It is non-load-bearing because nothing
         * here may be relied on until an applicability assessment says it applies.
         */
        marking: 'INFERRED',
        basis: 'generalised from a completed project by ' + o.curatedBy,
        confidence: 'MEDIUM',
        loadBearing: false,
      },
      attribution: { at, agentId: o.curatedBy, runId: o.curatorRunId },
    },
  });
  return write(deps, ARTIFACT_TYPES.LESSON_LEARNED, LessonLearnedSchema, lesson);
}

/**
 * Contribute a pattern.
 *
 * `notApplicableWhen` is required by the schema and it is the important half. A pattern
 * that only says when it works is a fashion, and the project that adopts it will discover
 * the exceptions the expensive way.
 */
export function contributePattern(
  deps: LearningDeps,
  o: {
    readonly name: string;
    readonly problem: string;
    readonly solution: string;
    readonly applicableWhen: string;
    readonly notApplicableWhen: readonly string[];
    readonly tradeoffs?: readonly string[];
    readonly curatedBy: string;
    /** The governed run that performed this curation. Resolved, never taken on trust. */
    readonly curatorRunId: string;
  },
): ReusablePattern {
  assertCurator(deps, o.curatedBy, o.curatorRunId);
  refuseLeakage('pattern', [
    o.name,
    o.problem,
    o.solution,
    o.applicableWhen,
    ...o.notApplicableWhen,
    ...(o.tradeoffs ?? []),
  ]);
  const at = deps.clock.now();
  const pattern = ReusablePatternSchema.parse({
    id: deps.ids.next('SC-RP'),
    createdAt: at,
    name: o.name,
    problem: o.problem,
    solution: o.solution,
    generalised: true,
    applicableWhen: o.applicableWhen,
    notApplicableWhen: [...o.notApplicableWhen],
    tradeoffs: [...(o.tradeoffs ?? [])],
    status: CandidateStatus.CANDIDATE,
    meta: {
      provenance: {
        /*
         * INFERRED rather than DERIVED, and deliberately so. A generalisation cannot cite
         * the artifacts it came from — those belong to another client — so there is
         * nothing for DERIVED's `from` to hold. It is non-load-bearing because nothing
         * here may be relied on until an applicability assessment says it applies.
         */
        marking: 'INFERRED',
        basis: 'generalised from a completed project by ' + o.curatedBy,
        confidence: 'MEDIUM',
        loadBearing: false,
      },
      attribution: { at, agentId: o.curatedBy, runId: o.curatorRunId },
    },
  });
  return write(deps, ARTIFACT_TYPES.REUSABLE_PATTERN, ReusablePatternSchema, pattern);
}

/** Contribute a failure. The rarest and most useful entry in the library. */
export function contributeFailedApproach(
  deps: LearningDeps,
  o: {
    readonly approach: string;
    readonly whyItFailed: string;
    readonly symptomsToWatchFor?: readonly string[];
    readonly curatedBy: string;
    /** The governed run that performed this curation. Resolved, never taken on trust. */
    readonly curatorRunId: string;
  },
): FailedApproach {
  assertCurator(deps, o.curatedBy, o.curatorRunId);
  refuseLeakage('failed approach', [o.approach, o.whyItFailed, ...(o.symptomsToWatchFor ?? [])]);
  const at = deps.clock.now();
  const failed = FailedApproachSchema.parse({
    id: deps.ids.next('SC-FA'),
    createdAt: at,
    approach: o.approach,
    whyItFailed: o.whyItFailed,
    generalised: true,
    symptomsToWatchFor: [...(o.symptomsToWatchFor ?? [])],
    meta: {
      provenance: {
        /*
         * INFERRED rather than DERIVED, and deliberately so. A generalisation cannot cite
         * the artifacts it came from — those belong to another client — so there is
         * nothing for DERIVED's `from` to hold. It is non-load-bearing because nothing
         * here may be relied on until an applicability assessment says it applies.
         */
        marking: 'INFERRED',
        basis: 'generalised from a completed project by ' + o.curatedBy,
        confidence: 'MEDIUM',
        loadBearing: false,
      },
      attribution: { at, agentId: o.curatedBy, runId: o.curatorRunId },
    },
  });
  return write(deps, ARTIFACT_TYPES.FAILED_APPROACH, FailedApproachSchema, failed);
}

/**
 * Offer knowledge to a project as a CANDIDATE.
 *
 * The summary is checked again on the way in. The library entry was clean when it was
 * written, but the summary is new text, and new text is where the specifics come back.
 */
export function offerCandidate(
  deps: LearningDeps,
  o: {
    readonly kind: CandidateItem['kind'];
    readonly ref: { readonly id: string; readonly version?: number };
    readonly summary: string;
  },
): CandidateItem {
  refuseLeakage('candidate', [o.summary]);
  const at = deps.clock.now();
  const item = CandidateItemSchema.parse({
    id: deps.ids.next('SC-CAND'),
    createdAt: at,
    kind: o.kind,
    ref: { ...o.ref },
    summary: o.summary,
    status: CandidateStatus.CANDIDATE,
    meta: {
      provenance: { marking: 'SYSTEM', component: 'knowledge-library' },
      attribution: { at },
    },
  });
  return write(deps, ARTIFACT_TYPES.CANDIDATE_ITEM, CandidateItemSchema, item);
}

/**
 * The independent judgement that a pattern fits here.
 *
 * `differences` is required to be considered when `applies` is true: a pattern adopted
 * with no account of how this project differs from the one it came from has not been
 * assessed, it has been recognised.
 */
export function assessApplicability(
  deps: LearningDeps,
  o: {
    readonly patternId: string;
    readonly applies: boolean;
    readonly rationale: string;
    readonly confidence: ApplicabilityAssessment['confidence'];
    readonly differences: readonly string[];
    readonly assessedBy: string;
    /** The governed run that performed this assessment. Resolved, never taken on trust. */
    readonly assessorRunId: string;
  },
): ApplicabilityAssessment {
  const pattern = repository(
    deps.store,
    ARTIFACT_TYPES.REUSABLE_PATTERN,
    ReusablePatternSchema,
  ).get(o.patternId);
  if (pattern === undefined) {
    return fail({
      code: 'E_VALIDATION',
      message: 'No pattern ' + o.patternId + ' exists',
      remedy: 'A judgement about a pattern that is not in the library judges nothing.',
      specRef: '§38',
    });
  }
  /*
   * THE ASSESSOR IS RESOLVED, EXACTLY AS THE CURATOR IS.
   *
   * SPEC: §38; CRITICAL finding ORGANIZATIONAL-LEARNING-CORE/ORG-LEARNING-1.
   *
   * This compared `o.assessedBy` to a constant — while its own remedy line read "a
   * caller-supplied actor string is not proof of a governed run". The round that fixed exactly
   * that in `assertCurator` left this function, twenty lines away, untouched.
   *
   * It is the more dangerous of the two: `patternUsageRefusal` treats this assessment as the
   * independent judgement gating `applyPattern`, so a caller could authorise applying any
   * learned pattern to a new project by typing a name. `§38` exists to stop prior success
   * becoming authority, and this was the door it left open.
   *
   * Independence is established here too, against the run that curated the pattern — between
   * two RESOLVED actors rather than two strings.
   */
  assertActor(
    {
      store: deps.store,
      registry: ContractRegistry.shared(),
      actorRunId: o.assessorRunId,
      claimedAgentId: o.assessedBy,
      requiredAuthority: RoleAuthority.ASSESS,
      ...(pattern.meta.attribution.runId === undefined
        ? {}
        : { mustDifferFromRunId: pattern.meta.attribution.runId }),
    },
    (message, details) =>
      fail({
        code: 'E_GATE_AUTHORITY',
        message: 'Applicability may not be assessed: ' + message,
        remedy:
          'Applying a pattern to a new project is a judgement, and a judgement needs a governed run behind it that is not the one that curated the pattern.',
        details,
        specRef: '§38',
      }),
  );
  if (o.applies && o.differences.length === 0) {
    return fail({
      code: 'E_VALIDATION',
      message: 'Pattern ' + o.patternId + ' was accepted with no differences considered',
      remedy:
        'Every project differs from the one a pattern came from. Recording how is what separates an assessment from a recognition — and the differences are where the pattern will break.',
      specRef: '§38',
    });
  }
  const at = deps.clock.now();
  const assessment = ApplicabilityAssessmentSchema.parse({
    id: deps.ids.next('SC-APPL'),
    createdAt: at,
    patternRef: { id: pattern.id, version: pattern.version },
    applies: o.applies,
    rationale: o.rationale,
    confidence: o.confidence,
    differences: [...o.differences],
    assessedBy: o.assessedBy,
    assessorRunId: o.assessorRunId,
    meta: {
      provenance: {
        marking: 'DERIVED',
        from: [pattern.id],
        rationale: 'independent assessment of whether this pattern applies to this project',
      },
      attribution: { at, agentId: o.assessedBy },
    },
  });
  return write(
    deps,
    ARTIFACT_TYPES.APPLICABILITY_ASSESSMENT,
    ApplicabilityAssessmentSchema,
    assessment,
  );
}

/**
 * Whether a decision may lean on a learned pattern.
 *
 * SPEC: §38 — prior success is not authority. A pattern is usable here only when somebody
 * independent assessed it as applying HERE, and said why. Returns the refusal rather than
 * a boolean so the caller can put the reason in front of whoever is about to be told no.
 *
 * "Somebody independent" is checked, not assumed. The assessment must come from
 * SC-AGENT-291 and the pattern must not have been curated by the same actor — an assessor
 * that curated the pattern is answering a question it has already argued the answer to.
 */
export function patternUsageRefusal(store: Store, patternId: string): string | undefined {
  const pattern = repository(store, ARTIFACT_TYPES.REUSABLE_PATTERN, ReusablePatternSchema).get(
    patternId,
  );
  if (pattern === undefined) return 'pattern ' + patternId + ' is not in the library';
  const assessments = repository(
    store,
    ARTIFACT_TYPES.APPLICABILITY_ASSESSMENT,
    ApplicabilityAssessmentSchema,
  )
    .list()
    .filter((a) => a.patternRef.id === patternId);
  if (assessments.length === 0) {
    return (
      'pattern ' +
      patternId +
      ' has no applicability assessment for this project: it worked somewhere else, which is not a reason'
    );
  }
  const accepting = assessments.filter((a) => a.applies);
  if (accepting.length === 0) {
    return 'pattern ' + patternId + ' was assessed as NOT applying to this project';
  }

  /*
   * §40: THE ASSESSMENT WAS MADE BY A RESOLVED, INDEPENDENT ACTOR.
   *
   * This filtered on `assessedBy === APPLICABILITY_ASSESSOR && assessedBy !== curator`, which
   * two different string literals satisfy. The assessments are now re-checked against the
   * store: each must cite a governed run that resolves, completed, was made by the agent it
   * names, holds a verifier's authority, and is not the run that curated the pattern.
   */
  const curator = pattern.meta.attribution.agentId;
  const independent = accepting.filter((a) => {
    if (a.assessorRunId === undefined) return false;
    return (
      actorRefusal({
        store,
        registry: ContractRegistry.shared(),
        actorRunId: a.assessorRunId,
        claimedAgentId: a.assessedBy,
        requiredAuthority: RoleAuthority.ASSESS,
        ...(pattern.meta.attribution.runId === undefined
          ? {}
          : { mustDifferFromRunId: pattern.meta.attribution.runId }),
      }) === undefined
    );
  });
  if (independent.length === 0) {
    return (
      'pattern ' +
      patternId +
      ' has no INDEPENDENT applicability assessment: it was curated by ' +
      String(curator) +
      ' and assessed by ' +
      accepting.map((a) => a.assessedBy).join(', ') +
      '. A curator judging its own pattern is not a second opinion.'
    );
  }
  return undefined;
}

/** The one role `32` authorises to judge whether a pattern applies. */
export const APPLICABILITY_ASSESSOR = 'SC-AGENT-291';
/** The one role `32` authorises to publish cross-project knowledge. */
export const KNOWLEDGE_CURATOR = 'SC-AGENT-290';

/** Mark a candidate applied, once something independent said it applies. */
export function applyPattern(
  deps: LearningDeps,
  o: { readonly patternId: string },
): ReusablePattern {
  const refusal = patternUsageRefusal(deps.store, o.patternId);
  if (refusal !== undefined) {
    return fail({
      code: 'E_GATE_AUTHORITY',
      message: 'Refusing to apply a pattern: ' + refusal,
      remedy:
        'Have SC-AGENT-291 assess whether it applies here. A pattern that arrives as an instruction has skipped the only check that stops the last project dictating this one.',
      specRef: '§38',
    });
  }
  const repo = repository(deps.store, ARTIFACT_TYPES.REUSABLE_PATTERN, ReusablePatternSchema);
  const pattern = repo.get(o.patternId) as ReusablePattern;
  return write(deps, ARTIFACT_TYPES.REUSABLE_PATTERN, ReusablePatternSchema, {
    ...pattern,
    status: CandidateStatus.APPLIED,
  });
}

/** One write path, so the audit entry cannot be forgotten on one of six functions. */
function write<T extends { readonly id: string }>(
  deps: LearningDeps,
  type: (typeof ARTIFACT_TYPES)[keyof typeof ARTIFACT_TYPES],
  schema: Parameters<typeof repository>[2],
  value: T,
): T {
  const tx = deps.store.begin();
  try {
    const stored = repository(deps.store, type, schema).put(tx, value) as T;
    audit(tx, {
      action: AuditAction.ARTIFACT_RECORDED,
      subject: value.id,
      outcome: 'OK',
      detail: { type },
    });
    tx.commit();
    return stored;
  } catch (e) {
    tx.rollback();
    throw e;
  }
}

export { CandidateStatus, leakageRefusal };
