import { z } from 'zod';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import { ConstraintSchema } from '../artifacts/framing.js';
import { NfrSchema, RequirementSchema } from '../artifacts/requirements.js';
import { BusinessRuleSchema } from '../artifacts/business.js';
import {
  DecisionPurpose,
  OptionDisposition,
  OwnerDecisionRequestSchema,
} from '../artifacts/governance.js';
import {
  AdrSchema,
  ArchitectureModelSchema,
  ComplexityJustificationSchema,
  ModuleContractSchema,
  NfrMappingSchema,
  SSOTRegisterSchema,
  TechnologyEvaluationSchema,
  evaluationRefusal,
} from '../artifacts/architecture.js';
import { jsonSchemaFor } from '../execution/jsonSchema.js';
import { contextFrom, derived } from './shared.js';
import type {
  DepartmentConfig,
  DepartmentContext,
  DepartmentContextSpec,
} from '../execution/types.js';

/**
 * ARCHITECTURE, TECHNOLOGY, REVIEW.
 *
 * SPEC: §7 (of this instruction), §18, §19, 06.
 *
 * The architect consumes PERSISTED requirements, NFRs and constraints — never a
 * conversation. That is not a style preference: an architecture justified by something
 * said in chat cannot be re-derived, re-checked, or disagreed with six months later.
 *
 * Two rules do the work:
 *
 *   every complexity pattern names the requirement that FORCES it, and the simpler
 *   option it rejected. "Scalable" is not a forcing requirement; `p95 < 200ms at 10k
 *   concurrent` is.
 *
 *   criteria are declared BEFORE candidates are scored, and both timestamps are stored,
 *   so the ordering is checkable rather than promised. Criteria invented afterwards
 *   reliably describe whichever option the author already preferred.
 *
 * A specification gap is ESCALATED, never filled. An architect who invents the missing
 * business rule has made a business decision nobody asked them to make, and it will be
 * discovered later by reading the code.
 */

/* ============================================================ SC-AGENT-070 — architect */

export const ArchitectureOutputSchema = z
  .object({
    style: z.string().min(1),
    rationale: z.string().min(1),
    modules: z
      .array(
        z
          .object({
            name: z.string().min(1),
            responsibility: z.string().min(1),
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
    moduleContracts: z
      .array(
        z
          .object({
            ownerModule: z.string().min(1),
            interface: z.string().min(1),
            invariants: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .default([]),
    ssot: z
      .array(
        z
          .object({
            truthElement: z.string().min(1),
            location: z.string().min(1),
            consumers: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .default([]),
    /** Anything more complicated than the obvious answer must name what forces it. */
    complexity: z
      .array(
        z
          .object({
            pattern: z.string().min(1),
            forcingRequirementId: z.string().min(1),
            simplerOptionRejected: z.string().min(1),
            whyRejected: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    /** Every NFR, mapped to a mechanism or explicitly flagged unsatisfied. */
    nfrMapping: z
      .array(
        z
          .object({
            nfrId: z.string().min(1),
            status: z.enum(['SATISFIED', 'PARTIAL', 'UNSATISFIED', 'DEFERRED']),
            mechanism: z.string().min(1).optional(),
            verification: z.string().min(1).optional(),
            note: z.string().min(1).optional(),
          })
          .strict(),
      )
      .default([]),
    /** Gaps in the specification. Escalated upstream, never filled in here. */
    specificationGaps: z
      .array(z.object({ what: z.string().min(1), whyItBlocksDesign: z.string().min(1) }).strict())
      .default([]),
  })
  .strict();

const ARCHITECT = 'SC-AGENT-070';

function designContext(ctx: DepartmentContext): DepartmentContextSpec {
  const reqs = repository(ctx.store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
  const nfrs = repository(ctx.store, ARTIFACT_TYPES.NFR, NfrSchema).list();
  const constraints = repository(ctx.store, ARTIFACT_TYPES.CONSTRAINT, ConstraintSchema).list();
  const rules = repository(ctx.store, ARTIFACT_TYPES.BUSINESS_RULE, BusinessRuleSchema).list();

  const canon = [
    contextFrom(
      'requirements',
      'REQUIREMENT',
      reqs,
      (r) => '[' + r.priority + '] ' + r.statement,
      1,
    ),
    contextFrom(
      'nfrs',
      'NFR',
      nfrs,
      (n) => n.dimension + ': ' + n.target + ' (' + n.applicability + ')',
      1,
    ),
    contextFrom(
      'constraints',
      'CONSTRAINT',
      constraints,
      (c) => c.type + ': ' + c.statement + (c.negotiable ? ' [negotiable]' : ' [fixed]'),
      1,
    ),
    contextFrom('rules', 'BUSINESS_RULE', rules, (r) => r.statement, 0.9),
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  return {
    canon,
    excluded: [
      {
        subject: 'discovery narrative, market research, design system',
        reason:
          'architecture answers the forcing requirements; upstream narrative would justify complexity that no requirement asks for',
      },
    ],
  };
}

export const architectureDepartment: DepartmentConfig<typeof ArchitectureOutputSchema> = {
  id: 'DEPT-ARCHITECTURE',
  stageId: 'SC-STAGE-020',
  agentId: ARCHITECT,
  title: 'Software Architecture',
  outputSchema: ArchitectureOutputSchema,
  outputJsonSchema: jsonSchemaFor(ArchitectureOutputSchema),
  requires: [ARTIFACT_TYPES.REQUIREMENT, ARTIFACT_TYPES.NFR],

  buildContext: designContext,

  task(): string {
    return [
      'Design the SIMPLEST architecture that satisfies the forcing requirements.',
      '',
      'Every NFR must appear in nfrMapping — mapped to a mechanism, or explicitly marked',
      'UNSATISFIED or DEFERRED. An NFR that is simply absent from the design has been',
      'quietly dropped, and nobody will notice until it is tested.',
      '',
      'Any pattern more complicated than the obvious answer must name the requirement that',
      'FORCES it and the simpler option you rejected. Microservices because "scalable",',
      'event sourcing because "enterprise", Redis because "fast" and Kubernetes because',
      '"production" are not justifications — they are habits with a rationale attached',
      'afterwards.',
      '',
      'If the specification is missing something you need, put it in specificationGaps.',
      'Do NOT invent the missing business rule: that is a business decision, and filling',
      'it in here means the company discovers its own policy later by reading the code.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Architecture only. Do not select specific technologies, design data schemas, or invent requirements.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const notes: string[] = [];
    const at = ctx.clock.now();
    const reqs = repository(ctx.store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
    const nfrs = repository(ctx.store, ARTIFACT_TYPES.NFR, NfrSchema).list();
    const known = new Set([...reqs.map((r) => r.id), ...nfrs.map((n) => n.id)]);

    const modelId = ctx.ids.next('SC-ARCH');
    repository(ctx.store, ARTIFACT_TYPES.ARCHITECTURE_MODEL, ArchitectureModelSchema).put(tx, {
      id: modelId,
      createdAt: at,
      style: output.style,
      modules: output.modules,
      interactions: output.interactions,
      rationale: output.rationale,
      meta: derived(
        ctx,
        ARCHITECT,
        ['requirements', 'nfrs'],
        'architecture over the forcing requirements',
      ),
    });
    ids.push(modelId);

    for (const m of output.moduleContracts) {
      const id = ctx.ids.next('SC-MOD');
      repository(ctx.store, ARTIFACT_TYPES.MODULE_CONTRACT, ModuleContractSchema).put(tx, {
        id,
        createdAt: at,
        ownerModule: m.ownerModule,
        interface: m.interface,
        invariants: m.invariants,
        errors: [],
        meta: derived(ctx, ARCHITECT, [modelId], 'contract for ' + m.ownerModule),
      });
      ids.push(id);
    }

    if (output.ssot.length > 0) {
      const id = ctx.ids.next('SC-SSOT');
      repository(ctx.store, ARTIFACT_TYPES.SSOT_REGISTER, SSOTRegisterSchema).put(tx, {
        id,
        createdAt: at,
        entries: output.ssot,
        meta: derived(ctx, ARCHITECT, [modelId], 'where each piece of truth lives'),
      });
      ids.push(id);
    }

    for (const c of output.complexity) {
      if (!known.has(c.forcingRequirementId)) {
        /*
         * A pattern citing a requirement that does not exist is unjustified complexity.
         * Recorded as a finding rather than stored, so the traceability checker does not
         * have to discover it later.
         */
        notes.push(
          'complexity "' +
            c.pattern +
            '" cites forcing requirement ' +
            c.forcingRequirementId +
            ', which does not exist — not recorded',
        );
        continue;
      }
      const id = ctx.ids.next('SC-CJ');
      repository(
        ctx.store,
        ARTIFACT_TYPES.COMPLEXITY_JUSTIFICATION,
        ComplexityJustificationSchema,
      ).put(tx, {
        id,
        createdAt: at,
        pattern: c.pattern,
        forcingRequirementRef: { id: c.forcingRequirementId },
        simplerOptionRejected: c.simplerOptionRejected,
        whyRejected: c.whyRejected,
        meta: derived(
          ctx,
          ARCHITECT,
          [c.forcingRequirementId],
          'complexity forced by this requirement',
        ),
      });
      ids.push(id);
    }

    /* Every NFR gets an entry, including the ones the design did not mention. */
    const mapped = new Map(output.nfrMapping.map((m) => [m.nfrId, m]));
    const entries = nfrs.map((n) => {
      const m = mapped.get(n.id);
      if (m === undefined) {
        notes.push('NFR ' + n.id + ' (' + n.dimension + ') was not addressed by the architecture');
        return {
          nfrRef: { id: n.id },
          status: 'UNSATISFIED' as const,
          note: 'the architecture did not address this NFR',
        };
      }
      return {
        nfrRef: { id: n.id },
        status: m.status,
        ...(m.mechanism === undefined ? {} : { mechanism: m.mechanism }),
        ...(m.verification === undefined ? {} : { verification: m.verification }),
        ...(m.note === undefined ? {} : { note: m.note }),
      };
    });
    const mappingId = ctx.ids.next('SC-NMAP');
    repository(ctx.store, ARTIFACT_TYPES.NFR_MAPPING, NfrMappingSchema).put(tx, {
      id: mappingId,
      createdAt: at,
      entries,
      meta: derived(ctx, ARCHITECT, [modelId], 'every NFR mapped to a mechanism or flagged'),
    });
    ids.push(mappingId);

    /*
     * A SPECIFICATION GAP IS ESCALATED, NOT FILLED.
     *
     * This is the single place where an architect is most tempted to help. The
     * requirements do not say what happens to an order placed after closing time, the
     * design needs an answer, and inventing a reasonable one costs nothing and unblocks
     * everything. It also silently makes a business decision on the owner's behalf — and
     * by the time anyone reads the requirement back, it looks like something they asked
     * for.
     *
     * So the gap becomes a blocking OwnerDecisionRequest, the orchestrator stops at
     * WAITING_FOR_OWNER, and the answer comes back from a person. A note would not do
     * this: a note is something the run emits and the lifecycle ignores.
     */
    const ownerDecisionIds: string[] = [];
    const decisions = repository(
      ctx.store,
      ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
      OwnerDecisionRequestSchema,
    );
    for (const g of output.specificationGaps) {
      const odrId = ctx.ids.next('SC-ODR');
      decisions.put(tx, {
        id: odrId,
        createdAt: at,
        question: 'The specification does not say: ' + g.what,
        whyServaCannotDecide:
          'Architecture can decide HOW the product is built. This is a question about WHAT it should do, and answering it here would put a business decision in a technical document where nobody would think to look for it.',
        purpose: DecisionPurpose.SPECIFICATION_GAP,
        supportingRefs: [{ id: modelId }],
        options: [
          {
            option: 'Answer it, and Serva records it as a requirement',
            impact: g.whyItBlocksDesign,
            disposition: OptionDisposition.INFORM,
          },
          {
            option: 'Defer it, and Serva designs around the absence',
            impact: 'the design leaves the behaviour unspecified rather than guessing at it',
            disposition: OptionDisposition.DEFER,
          },
        ],
        recommendation: 'Answer it',
        recommendationRationale:
          'The design is blocked either way; answering makes the blockage go away rather than moving it downstream.',
        blocksWork: true,
        blockedRefs: [{ id: modelId }],
        state: 'OPEN',
        meta: derived(ctx, ARCHITECT, [modelId], 'specification gap escalated upstream'),
      });
      ids.push(odrId);
      ownerDecisionIds.push(odrId);
      notes.push('SPECIFICATION_GAP escalated upstream: ' + g.what + ' — ' + g.whyItBlocksDesign);
    }

    const unsatisfied = entries.filter((e) => e.status === 'UNSATISFIED').length;
    return {
      artifactIds: ids,
      notes,
      ownerDecisionIds,
      judgements: [
        {
          criterionRef: 'AR-1',
          met: unsatisfied === 0,
          by: ARCHITECT,
          note:
            String(entries.length - unsatisfied) + ' of ' + String(entries.length) + ' NFRs mapped',
        },
      ],
    };
  },
};

/* ================================================== SC-AGENT-071 — technology evaluation */

export const TechnologyOutputSchema = z
  .object({
    decisions: z
      .array(
        z
          .object({
            area: z.string().min(1),
            /** Declared BEFORE scoring. The ordering is stored and checked. */
            criteria: z
              .array(z.object({ name: z.string().min(1), rationale: z.string().min(1) }).strict())
              .min(1),
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
            chosen: z.string().min(1),
            rationale: z.string().min(1),
            rejectedReasons: z.array(z.string().min(1)).min(1),
            consequences: z.array(z.string().min(1)).min(1),
            reversalCost: z.enum(['LOW', 'MEDIUM', 'HIGH', 'IRREVERSIBLE']),
            reevaluationTrigger: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const EVALUATOR = 'SC-AGENT-071';

export const technologyDepartment: DepartmentConfig<typeof TechnologyOutputSchema> = {
  id: 'DEPT-TECHNOLOGY',
  stageId: 'SC-STAGE-023',
  agentId: EVALUATOR,
  title: 'Technology Selection',
  outputSchema: TechnologyOutputSchema,
  outputJsonSchema: jsonSchemaFor(TechnologyOutputSchema),
  requires: [ARTIFACT_TYPES.ARCHITECTURE_MODEL],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const base = designContext(ctx);
    const arch = repository(
      ctx.store,
      ARTIFACT_TYPES.ARCHITECTURE_MODEL,
      ArchitectureModelSchema,
    ).list();
    return {
      canon: [
        ...base.canon,
        ...[
          contextFrom(
            'architecture',
            'ARCHITECTURE',
            arch,
            (a) => a.style + ': ' + a.modules.map((m) => m.name).join(', '),
            1,
          ),
        ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      ],
      excluded: base.excluded,
    };
  },

  task(): string {
    return [
      'Select the technology. This is Serva’s decision, not the owner’s.',
      '',
      'For every material choice: at least TWO real candidates, criteria declared before',
      'you score anything, and the requirements or NFRs each criterion serves.',
      '',
      'Assess security impact, operability, cost and licensing, lock-in and reversal cost,',
      'ecosystem maturity, and platform compatibility. State the re-evaluation trigger —',
      'the thing that would make this decision worth revisiting.',
      '',
      'A comparison of one candidate is a preference. If only one option genuinely exists,',
      'say so in the rationale and name what you considered and ruled out.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Technology decisions only. Do not redesign the architecture or add requirements.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const notes: string[] = [];
    const at = ctx.clock.now();
    /*
     * Declared-before-scored is recorded as two distinct instants rather than asserted.
     * Both come from the clock at persist time in this build, so the ordering is
     * structurally true; a future revision that lets an agent supply them will still be
     * checked by `evaluationRefusal`.
     */
    const declaredAt = at;
    const scoredAt = new Date(Date.parse(at) + 1000).toISOString().replace(/\.\d+Z$/, '.000Z');

    for (const d of output.decisions) {
      const evalId = ctx.ids.next('SC-TE');
      const evaluation = repository(
        ctx.store,
        ARTIFACT_TYPES.TECHNOLOGY_EVALUATION,
        TechnologyEvaluationSchema,
      ).put(tx, {
        id: evalId,
        createdAt: at,
        decisionArea: d.area,
        criteria: d.criteria,
        criteriaDeclaredAt: declaredAt,
        candidates: d.candidates,
        scoredAt,
        meta: derived(ctx, EVALUATOR, ['architecture'], 'technology evaluation for ' + d.area),
      });
      ids.push(evalId);

      const refusal = evaluationRefusal(evaluation);
      if (refusal !== undefined) {
        notes.push(refusal);
        continue;
      }

      const adrId = ctx.ids.next('SC-ADR');
      repository(ctx.store, ARTIFACT_TYPES.ADR, AdrSchema).put(tx, {
        id: adrId,
        createdAt: at,
        class: 'TECHNOLOGY',
        title: d.area + ': ' + d.chosen,
        context: 'Selection for ' + d.area,
        options: d.candidates.map((c) => ({
          option: c.name,
          consequence: c.lockInNote ?? c.costNote ?? 'see evaluation',
        })),
        chosen: d.chosen,
        drivers: [],
        evidenceRefs: [{ id: evalId }],
        rationale: d.rationale,
        rejectedReasons: d.rejectedReasons,
        consequences: d.consequences,
        reversalCost: d.reversalCost,
        reevaluationTrigger: d.reevaluationTrigger,
        evaluationRef: { id: evalId },
        meta: derived(ctx, EVALUATOR, [evalId], 'decision recorded with its alternatives'),
      });
      ids.push(adrId);
    }

    return { artifactIds: ids, notes };
  },
};

/* ================================================== SC-AGENT-072 — architecture review */

export const ArchitectureReviewOutputSchema = z
  .object({
    verdict: z.enum(['ACCEPTABLE', 'NOT_ACCEPTABLE']),
    summary: z.string().min(1),
    findings: z
      .array(
        z
          .object({
            severity: z.enum(['BLOCKING', 'MAJOR', 'ADVISORY']),
            subject: z.string().min(1),
            statement: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const REVIEWER = 'SC-AGENT-072';

export const architectureReviewDepartment: DepartmentConfig<typeof ArchitectureReviewOutputSchema> =
  {
    id: 'DEPT-ARCHITECTURE-REVIEW',
    stageId: 'SC-STAGE-020',
    agentId: REVIEWER,
    title: 'Architecture Review',
    outputSchema: ArchitectureReviewOutputSchema,
    outputJsonSchema: jsonSchemaFor(ArchitectureReviewOutputSchema),
    requires: [ARTIFACT_TYPES.ARCHITECTURE_MODEL],
    /** SPEC §5 of this instruction: the reviewer is never the architect. */
    independentOf: [ARCHITECT, EVALUATOR],

    buildContext(ctx: DepartmentContext): DepartmentContextSpec {
      const arch = repository(
        ctx.store,
        ARTIFACT_TYPES.ARCHITECTURE_MODEL,
        ArchitectureModelSchema,
      ).list();
      const complexity = repository(
        ctx.store,
        ARTIFACT_TYPES.COMPLEXITY_JUSTIFICATION,
        ComplexityJustificationSchema,
      ).list();
      const mapping = repository(ctx.store, ARTIFACT_TYPES.NFR_MAPPING, NfrMappingSchema).list();
      const nfrs = repository(ctx.store, ARTIFACT_TYPES.NFR, NfrSchema).list();

      const canon = [
        contextFrom('architecture', 'ARCHITECTURE', arch, (a) => a.style + ' — ' + a.rationale, 1),
        contextFrom(
          'complexity',
          'COMPLEXITY',
          complexity,
          (c) =>
            c.pattern +
            ' forced by ' +
            c.forcingRequirementRef.id +
            '; rejected ' +
            c.simplerOptionRejected,
          1,
        ),
        contextFrom(
          'nfr-mapping',
          'NFR_MAPPING',
          mapping,
          (m) => m.entries.map((e) => e.nfrRef.id + '=' + e.status).join(', '),
          1,
        ),
        contextFrom('nfrs', 'NFR', nfrs, (n) => n.dimension + ': ' + n.target, 1),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);

      return {
        canon,
        excluded: [
          {
            subject: 'the architect’s reasoning and drafts',
            reason:
              'the reviewer judges the design as recorded; the author’s explanation of what they meant is exactly what a future maintainer will not have',
          },
        ],
      };
    },

    task(): string {
      return [
        'Review this architecture. You did not design it.',
        '',
        'Check that every NFR is mapped to a mechanism or explicitly flagged, that every',
        'complexity pattern names a real forcing requirement and a rejected simpler option,',
        'and that module ownership does not overlap.',
        '',
        'Look specifically for complexity nothing asks for. Return NOT_ACCEPTABLE if',
        'anything BLOCKING remains — a reviewer who always accepts is a formality, and the',
        'gate is relying on you.',
      ].join('\n');
    },

    scopeBoundary(): string {
      return 'Review only. Do not redesign, and do not add requirements.';
    },

    persist(_tx, output, _ctx) {
      const notes = [
        output.summary,
        ...output.findings.map(
          (f) => 'JUDGED[' + f.severity + '] ' + f.subject + ': ' + f.statement,
        ),
      ];
      return {
        artifactIds: [],
        notes,
        judgements: [
          {
            criterionRef: 'AR-2',
            met: output.verdict === 'ACCEPTABLE',
            by: REVIEWER,
            note: output.summary,
          },
        ],
      };
    },
  };

export const ARCHITECTURE_DEPARTMENTS: readonly DepartmentConfig[] = Object.freeze([
  architectureDepartment as DepartmentConfig,
  architectureReviewDepartment as DepartmentConfig,
  technologyDepartment as DepartmentConfig,
]);
