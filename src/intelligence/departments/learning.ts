import { z } from 'zod';
import { knownProjectNames } from '../learning.js';
import type { Store } from '../../store/store.js';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import {
  ApplicabilityAssessmentSchema,
  CandidateStatus,
  FailedApproachSchema,
  LessonLearnedSchema,
  ReusablePatternSchema,
  leakageRefusal,
} from '../artifacts/learning.js';
import { ProposalSchema, RiskSchema } from '../artifacts/governance.js';
import { AdrSchema } from '../artifacts/architecture.js';
import { jsonSchemaFor } from '../execution/jsonSchema.js';
import { contextFrom, derived } from './shared.js';
import type {
  DepartmentConfig,
  DepartmentContext,
  DepartmentContextSpec,
} from '../execution/types.js';

/**
 * ORGANIZATIONAL LEARNING, AS GOVERNED RUNS.
 *
 * SPEC: §38, §39, §40, 06 (SC-AGENT-280/290/291).
 *
 * These roles were previously a deterministic API where the caller supplied `curatedBy`
 * and `assessedBy` as strings. That kept the leakage wall real — it refuses regardless of
 * who is asking — but it made the ROLES nominal: nothing tied a curation to a governed
 * AgentRun, and nothing stopped one actor curating a pattern and then assessing that the
 * pattern applies.
 *
 * They now run on the same substrate as every other department, so the runner enforces
 * independence, provenance, context minimisation and the write scope for them too. What
 * does NOT move is the wall: `leakageRefusal` still runs on every field at persist time,
 * because a governed run is still a model, and a model asked to generalise will sometimes
 * generalise a client's name into a shorter version of the client's name.
 *
 * The division of labour is `32`'s, and it is worth reading before assuming otherwise:
 *
 *   SC-AGENT-280  Improvement Analyst    → Proposal[]
 *   SC-AGENT-290  Knowledge Curator      → LessonLearned[], ReusablePattern[], FailedApproach[]
 *   SC-AGENT-291  Applicability Assessor → ApplicabilityAssessment[]
 *
 * The analyst proposes improvements to THIS project; the curator writes the things a
 * different project may read. Keeping those apart is what stops "we should have done X"
 * becoming everyone's pattern before anyone has decided it was even right here.
 *
 * 290 and 291 are declared independent of one another. A curator assessing its own pattern
 * would be answering "does this apply?" about something it has just spent a run arguing is
 * worth reusing.
 */

const ANALYST = 'SC-AGENT-280';
const CURATOR = 'SC-AGENT-290';
const ASSESSOR = 'SC-AGENT-291';

/**
 * Every field a future reader could see, checked together.
 *
 * SPEC: HIGH finding ORGANIZATIONAL-LEARNING-CORE/ORG-LEARN-CORE-1.
 *
 * `leakageRefusal` gained a `knownNames` argument so it could catch client names — which it
 * cannot recognise in the abstract — and this caller kept invoking the one-argument form. The
 * check therefore existed at one door of the wall and not at this one.
 *
 * The names come from the governed store rather than from the caller, for the same reason
 * they do in `learning.ts`: a name Serva actually holds is a fact, and a name a caller passes
 * is a claim.
 */
function leakage(store: Store, fields: readonly string[]): readonly string[] {
  const names = knownProjectNames(store);
  return [...new Set(fields.flatMap((f) => leakageRefusal(f, names)))];
}

/* ============================================================ SC-AGENT-280 — analyst */

export const ImprovementOutputSchema = z
  .object({
    improvements: z
      .array(
        z
          .object({
            title: z.string().min(1),
            description: z.string().min(1),
            /** The canon family this would change. Decides who may accept it. */
            affectsCanon: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const IMPROVEMENT_JSON_SCHEMA: Record<string, unknown> =
  jsonSchemaFor(ImprovementOutputSchema);

/**
 * IMPROVEMENT ANALYSIS — SC-AGENT-280, stage 053.
 *
 * Looks at what this project produced and proposes improvements to it.
 *
 * Its output is a PROPOSAL, per `32`, and that turns out to be the right shape rather than
 * a technicality: an improvement is a suggestion about this project, so it belongs in the
 * proposal lifecycle where the authority that owns the affected canon must accept it. The
 * analyst noticing something is not the analyst changing it.
 */
export const improvementDepartment: DepartmentConfig<typeof ImprovementOutputSchema> = {
  id: 'DEPT-IMPROVEMENT',
  stageId: 'SC-STAGE-053',
  agentId: ANALYST,
  title: 'Improvement Analysis',
  produces: [ARTIFACT_TYPES.PROPOSAL],
  outputSchema: ImprovementOutputSchema,
  outputJsonSchema: IMPROVEMENT_JSON_SCHEMA,

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const risks = repository(ctx.store, ARTIFACT_TYPES.RISK, RiskSchema).list();
    const decisions = repository(ctx.store, ARTIFACT_TYPES.ADR, AdrSchema).list();
    return {
      canon: [
        contextFrom('risks', 'RISK', risks, (r) => r.statement, 1),
        contextFrom('decisions', 'ADR', decisions, (a) => a.title + ': ' + a.rationale, 1),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'the implementation and the captured evidence',
          reason: 'an improvement is proposed from what was decided, not from how it was built',
        },
      ],
    };
  },

  task(): string {
    return [
      'Propose improvements to THIS project, from what it actually produced.',
      '',
      'A proposal is not a change. It says what would be better and why, and somebody with',
      'authority over the affected canon decides whether it becomes scope. Name that canon',
      'family, because it is what determines who rules on it.',
      '',
      'Ground each one in something recorded — a risk that materialised, a decision whose',
      're-evaluation trigger has fired, a control with no guardrail. An improvement with no',
      'evidence behind it is an opinion, and it will be assessed as one.',
      '',
      'Do not write lessons or patterns for other projects. That is a different role with a',
      'different wall around it, and it happens after somebody has decided this was even',
      'the right thing to do here.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Improvement proposals about this project. Do not write lessons, patterns or cross-project knowledge of any kind.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const notes: string[] = [];
    const at = ctx.clock.now();
    const known = new Set<string>(Object.values(ARTIFACT_TYPES));

    for (const i of output.improvements) {
      if (!known.has(i.affectsCanon)) {
        notes.push(
          'improvement "' + i.title + '" names an unknown canon family: ' + i.affectsCanon,
        );
        continue;
      }
      const id = ctx.ids.next('SC-PROP');
      repository(ctx.store, ARTIFACT_TYPES.PROPOSAL, ProposalSchema).put(tx, {
        id,
        createdAt: at,
        title: i.title,
        origin: ANALYST,
        description: i.description,
        affectsCanon: i.affectsCanon,
        state: 'PROPOSED',
        incorporatedInto: [],
        meta: {
          /*
           * INFERRED and non-load-bearing: a proposal is a suggestion, and nothing may
           * depend on it until the owning authority accepts it into canon.
           */
          provenance: {
            marking: 'INFERRED',
            basis: 'observed while reviewing what this project produced',
            confidence: 'MEDIUM',
            loadBearing: false,
          },
          attribution: { agentId: ANALYST, at },
          stageId: ctx.stage.stageId,
          workItemId: ctx.workItemId,
        },
      });
      ids.push(id);
    }

    return { artifactIds: ids, notes };
  },
};

/* ============================================================ SC-AGENT-290 — curator */

export const CurationOutputSchema = z
  .object({
    lessons: z
      .array(
        z
          .object({
            statement: z.string().min(1),
            context: z.string().min(1),
            applicableWhen: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    failedApproaches: z
      .array(
        z
          .object({
            approach: z.string().min(1),
            whyItFailed: z.string().min(1),
            symptomsToWatchFor: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .default([]),
    patterns: z
      .array(
        z
          .object({
            name: z.string().min(1),
            problem: z.string().min(1),
            solution: z.string().min(1),
            applicableWhen: z.string().min(1),
            notApplicableWhen: z.array(z.string().min(1)).min(1),
            tradeoffs: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const CURATION_JSON_SCHEMA: Record<string, unknown> = jsonSchemaFor(CurationOutputSchema);

/**
 * KNOWLEDGE CURATION — SC-AGENT-290, stage 053.
 *
 * The last actor before anything could cross a project boundary, and the only one whose
 * output is meant to outlive the project it came from.
 *
 * `notApplicableWhen` is required by the schema and is the important half of a pattern. One
 * that says only when it works is a fashion, and the project that adopts it discovers the
 * exceptions the expensive way.
 */
export const curationDepartment: DepartmentConfig<typeof CurationOutputSchema> = {
  id: 'DEPT-CURATION',
  stageId: 'SC-STAGE-053',
  agentId: CURATOR,
  title: 'Knowledge Curation',
  produces: [
    ARTIFACT_TYPES.LESSON_LEARNED,
    ARTIFACT_TYPES.REUSABLE_PATTERN,
    ARTIFACT_TYPES.FAILED_APPROACH,
  ],
  outputSchema: CurationOutputSchema,
  outputJsonSchema: CURATION_JSON_SCHEMA,
  /* SPEC §40: the actor that curates a pattern may not be the one that judges it applies. */
  independentOf: [ASSESSOR],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const risks = repository(ctx.store, ARTIFACT_TYPES.RISK, RiskSchema).list();
    const decisions = repository(ctx.store, ARTIFACT_TYPES.ADR, AdrSchema).list();
    return {
      canon: [
        contextFrom('risks', 'RISK', risks, (r) => r.statement, 1),
        contextFrom('decisions', 'ADR', decisions, (a) => a.title + ': ' + a.rationale, 1),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'requirements, code, client identity and captured evidence',
          reason:
            'anything needing those to make sense is a project detail rather than a generalisation, and the surest way not to publish one is not to be shown it',
        },
      ],
    };
  },

  task(): string {
    return [
      'Write what a DIFFERENT project should know from this one.',
      '',
      'Three kinds of thing: a lesson (something that turned out to be true about this KIND',
      'of problem), a failed approach (something tried that did not work), and a pattern (a',
      'solution that transfers). The failures are the rarest and most valuable, because',
      'nobody writes them down and everybody repeats them.',
      '',
      'A pattern must also say when it is WRONG. One with no notApplicableWhen is a fashion:',
      'the project that adopts it will find the exceptions the expensive way.',
      '',
      'Nothing you write may identify where it came from. No client, no domain, no path, no',
      'URL, no identifier, no code. This is checked, and anything carrying them is refused',
      'rather than trimmed — a redacted sentence still describes one specific situation,',
      'minus the words that made that obvious.',
      '',
      'What you record is a CANDIDATE. It is not advice, and adopting it is a separate',
      'judgement somebody else makes about a project you have not seen.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Generalised cross-project knowledge only. Do not assess whether anything applies to a project, and do not name any project.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const notes: string[] = [];
    const at = ctx.clock.now();

    for (const l of output.lessons) {
      const reasons = leakage(ctx.store, [l.statement, l.context, l.applicableWhen]);
      if (reasons.length > 0) {
        notes.push('lesson refused: ' + reasons.join('; '));
        continue;
      }
      const id = ctx.ids.next('SC-LL');
      repository(ctx.store, ARTIFACT_TYPES.LESSON_LEARNED, LessonLearnedSchema).put(tx, {
        id,
        createdAt: at,
        statement: l.statement,
        context: l.context,
        generalised: true,
        applicableWhen: l.applicableWhen,
        meta: derived(ctx, CURATOR, ['this project'], 'generalised for another project'),
      });
      ids.push(id);
    }

    for (const f of output.failedApproaches) {
      const reasons = leakage(ctx.store, [f.approach, f.whyItFailed, ...f.symptomsToWatchFor]);
      if (reasons.length > 0) {
        notes.push('failed approach refused: ' + reasons.join('; '));
        continue;
      }
      const id = ctx.ids.next('SC-FA');
      repository(ctx.store, ARTIFACT_TYPES.FAILED_APPROACH, FailedApproachSchema).put(tx, {
        id,
        createdAt: at,
        approach: f.approach,
        whyItFailed: f.whyItFailed,
        generalised: true,
        symptomsToWatchFor: [...f.symptomsToWatchFor],
        meta: derived(ctx, CURATOR, ['this project'], 'approach that did not work'),
      });
      ids.push(id);
    }

    for (const p of output.patterns) {
      const reasons = leakage(ctx.store, [
        p.name,
        p.problem,
        p.solution,
        p.applicableWhen,
        ...p.notApplicableWhen,
        ...p.tradeoffs,
      ]);
      if (reasons.length > 0) {
        /*
         * REFUSED, not trimmed, and the run is not failed for it. Refusing one pattern and
         * recording why is more useful than discarding the whole curation, and the note
         * reaches the trace where somebody can read what was attempted.
         */
        notes.push('pattern "' + p.name + '" refused: ' + reasons.join('; '));
        continue;
      }
      const id = ctx.ids.next('SC-RP');
      repository(ctx.store, ARTIFACT_TYPES.REUSABLE_PATTERN, ReusablePatternSchema).put(tx, {
        id,
        createdAt: at,
        name: p.name,
        problem: p.problem,
        solution: p.solution,
        generalised: true,
        applicableWhen: p.applicableWhen,
        notApplicableWhen: [...p.notApplicableWhen],
        tradeoffs: [...p.tradeoffs],
        status: CandidateStatus.CANDIDATE,
        meta: derived(ctx, CURATOR, ['this project'], 'generalised for reuse by another project'),
      });
      ids.push(id);
    }

    return { artifactIds: ids, notes };
  },
};

/* =========================================================== SC-AGENT-291 — assessor */

export const ApplicabilityOutputSchema = z
  .object({
    assessments: z
      .array(
        z
          .object({
            patternId: z.string().min(1),
            applies: z.boolean(),
            rationale: z.string().min(1),
            confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
            differences: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const APPLICABILITY_JSON_SCHEMA: Record<string, unknown> =
  jsonSchemaFor(ApplicabilityOutputSchema);

/**
 * APPLICABILITY ASSESSMENT — SC-AGENT-291, stage 053.
 *
 * SPEC §38: prior success is not authority. A pattern arrives as a candidate and stays
 * unusable until this run says it applies HERE, and says how this project differs from the
 * situations the pattern describes.
 *
 * Independent of the curator by declaration, which the runner enforces on both the actor
 * and the context: an assessor handed the curator's own run would be reading the case for
 * adoption rather than the pattern.
 */
export const applicabilityDepartment: DepartmentConfig<typeof ApplicabilityOutputSchema> = {
  id: 'DEPT-APPLICABILITY',
  stageId: 'SC-STAGE-053',
  agentId: ASSESSOR,
  title: 'Applicability Assessment',
  produces: [ARTIFACT_TYPES.APPLICABILITY_ASSESSMENT],
  outputSchema: ApplicabilityOutputSchema,
  outputJsonSchema: APPLICABILITY_JSON_SCHEMA,
  requires: [ARTIFACT_TYPES.REUSABLE_PATTERN],
  /* SPEC §40, the other direction. */
  independentOf: [CURATOR],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const patterns = repository(
      ctx.store,
      ARTIFACT_TYPES.REUSABLE_PATTERN,
      ReusablePatternSchema,
    ).list();
    return {
      canon: [
        contextFrom(
          'patterns',
          'REUSABLE_PATTERN',
          patterns,
          (p) =>
            p.id +
            ' — ' +
            p.name +
            ': ' +
            p.solution +
            ' | applies when ' +
            p.applicableWhen +
            ' | NOT when ' +
            p.notApplicableWhen.join('; '),
          1,
        ),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'the curator’s own run and reasoning',
          reason:
            'a judgement about whether a pattern applies must read the pattern, not the argument for adopting it',
        },
      ],
    };
  },

  task(): string {
    return [
      'Decide whether each pattern applies to THIS project.',
      '',
      'That it worked somewhere else is not a reason. It is the observation that prompted',
      'the question, and adopting a pattern because it succeeded before is the reasoning',
      'behind most inappropriate architecture.',
      '',
      'If you accept one, say how this project DIFFERS from the situations the pattern',
      'describes. Every project differs from the one a pattern came from, and the',
      'differences are where it will break. An acceptance with no differences recorded is a',
      'recognition rather than an assessment, and will be refused.',
      '',
      'Rejecting a pattern is a normal and useful outcome. Most patterns do not apply.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Applicability assessments only. Do not edit any pattern, and do not create new ones.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const notes: string[] = [];
    const at = ctx.clock.now();
    const patterns = new Map(
      repository(ctx.store, ARTIFACT_TYPES.REUSABLE_PATTERN, ReusablePatternSchema)
        .list()
        .map((p) => [p.id, p]),
    );

    for (const a of output.assessments) {
      const pattern = patterns.get(a.patternId);
      if (pattern === undefined) {
        notes.push('assessment cites pattern ' + a.patternId + ', which is not in the library');
        continue;
      }
      if (a.applies && a.differences.length === 0) {
        notes.push(
          'pattern ' +
            a.patternId +
            ' was accepted with no differences considered: that is a recognition, not an assessment',
        );
        continue;
      }
      const id = ctx.ids.next('SC-APPL');
      repository(
        ctx.store,
        ARTIFACT_TYPES.APPLICABILITY_ASSESSMENT,
        ApplicabilityAssessmentSchema,
      ).put(tx, {
        id,
        createdAt: at,
        patternRef: { id: pattern.id, version: pattern.version },
        applies: a.applies,
        rationale: a.rationale,
        confidence: a.confidence,
        differences: [...a.differences],
        /* The actor is the RUN's, not a caller-supplied string. */
        assessedBy: ASSESSOR,
        meta: derived(ctx, ASSESSOR, [pattern.id], 'independent applicability assessment'),
      });
      ids.push(id);
    }

    return { artifactIds: ids, notes };
  },
};

export const LEARNING_DEPARTMENTS: readonly DepartmentConfig[] = Object.freeze([
  improvementDepartment as DepartmentConfig,
  curationDepartment as DepartmentConfig,
  applicabilityDepartment as DepartmentConfig,
]);
