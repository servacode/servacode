import { z } from 'zod';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import { RequirementSchema } from '../artifacts/requirements.js';
import { FeatureSchema } from '../artifacts/product.js';
import { UserSegmentSchema } from '../artifacts/discovery.js';
import { BusinessRuleSchema } from '../artifacts/business.js';
import {
  FlowSchema,
  InformationArchitectureSchema,
  NavigationModelSchema,
  StateCoverageSchema,
  UserJourneySchema,
  missingStates,
} from '../artifacts/ux.js';
import {
  AccessibilitySpecSchema,
  ComponentSpecSchema,
  DesignTokenSetSchema,
  LayoutSystemSchema,
  RtlRulesSchema,
  ScreenCompositionSchema,
} from '../artifacts/design.js';
import {
  AdminAuditRequirementSchema,
  AdminIaSchema,
  AdminOperabilityReviewSchema,
  ConfigurationRegisterSchema,
  OperationalControlSchema,
  ProtectedRuleSchema,
} from '../artifacts/admin.js';
import { jsonSchemaFor } from '../execution/jsonSchema.js';
import { contextFrom, currentSubjects, derived } from './shared.js';
import type {
  DepartmentConfig,
  DepartmentContext,
  DepartmentContextSpec,
} from '../execution/types.js';

/**
 * UX → DESIGN SYSTEM → ADMIN OPERABILITY.
 *
 * SPEC: §8 (of this instruction), §24, §25, §27, 12, 13.
 *
 * The chain these three build is the one §8 asks to be provable:
 *
 *   Requirement → UserFlow → ScreenComposition/Component → AdminOperability → tests
 *
 * Each department reads only its own part of it. The UI designer gets flows and tokens
 * and not the backend; the admin designer gets the configuration register and roles and
 * not the implementation. That is not tidiness — a designer shown the data model starts
 * designing the data model.
 */

/* ============================================================= SC-AGENT-120 — UX design */

const REQUIRED_STATES = [
  'DEFAULT',
  'EMPTY',
  'LOADING',
  'PARTIAL',
  'ERROR',
  'PERMISSION_DENIED',
  'SUCCESS',
] as const;

export const UxOutputSchema = z
  .object({
    journeys: z
      .array(
        z
          .object({
            name: z.string().min(1),
            goal: z.string().min(1),
            steps: z
              .array(
                z.object({ action: z.string().min(1), systemResponse: z.string().min(1) }).strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .min(1),
    flows: z
      .array(
        z
          .object({
            name: z.string().min(1),
            entryPoints: z.array(z.string().min(1)).min(1),
            steps: z.array(z.string().min(1)).min(1),
            requirementIds: z.array(z.string().min(1)).min(1),
            screens: z
              .array(
                z
                  .object({
                    screen: z.string().min(1),
                    /** Every required state: defined, or not-applicable WITH a reason. */
                    states: z
                      .array(
                        z
                          .object({
                            state: z.string().min(1),
                            disposition: z.enum(['DEFINED', 'NOT_APPLICABLE']),
                            behaviour: z.string().min(1).optional(),
                            reason: z.string().min(1).optional(),
                          })
                          .strict(),
                      )
                      .min(1),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .min(1),
    informationArchitecture: z
      .array(
        z
          .object({ name: z.string().min(1), contains: z.array(z.string().min(1)).default([]) })
          .strict(),
      )
      .min(1),
    navigationPattern: z.string().min(1),
    rationale: z.string().min(1),
  })
  .strict();

const UX = 'SC-AGENT-120';

export const uxDepartment: DepartmentConfig<typeof UxOutputSchema> = {
  id: 'DEPT-UX',
  stageId: 'SC-STAGE-024',
  agentId: UX,
  title: 'UX Design',
  outputSchema: UxOutputSchema,
  outputJsonSchema: jsonSchemaFor(UxOutputSchema),
  requires: [ARTIFACT_TYPES.REQUIREMENT],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const reqs = repository(ctx.store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
    const segments = repository(ctx.store, ARTIFACT_TYPES.USER_SEGMENT, UserSegmentSchema).list();
    const rules = repository(ctx.store, ARTIFACT_TYPES.BUSINESS_RULE, BusinessRuleSchema).list();
    return {
      canon: [
        contextFrom('requirements', 'REQUIREMENT', reqs, (r) => r.id + ': ' + r.statement, 1),
        contextFrom('segments', 'SEGMENT', segments, (s) => s.name + ' — ' + s.context, 1),
        contextFrom('rules', 'BUSINESS_RULE', rules, (r) => r.statement, 0.8),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'architecture, data model, technology',
          reason:
            'the experience follows the requirements and the people using them; implementation detail would shape the flow around what is convenient to build',
        },
      ],
    };
  },

  task(): string {
    return [
      'Design the experience. Serva decides this — the owner is not asked how many screens',
      'they want.',
      '',
      'For EVERY screen in every flow, say what happens in each of these states:',
      '  DEFAULT, EMPTY, LOADING, PARTIAL, ERROR, PERMISSION_DENIED, SUCCESS.',
      '',
      'A state that genuinely cannot occur may be NOT_APPLICABLE — but you must say why,',
      'and a reviewer can disagree with the sentence. Silence is not available. These are',
      'the states real products are lost in, and they are exactly the ones that get',
      '"designed" during implementation by whoever is closest to the deadline.',
      '',
      'Every flow must cite the requirement ids it implements.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Flows, journeys, IA and state coverage. Do not choose visual styling or invent requirements.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const notes: string[] = [];
    const at = ctx.clock.now();
    const reqs = repository(ctx.store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
    const known = new Set(reqs.map((r) => r.id));
    const segments = repository(ctx.store, ARTIFACT_TYPES.USER_SEGMENT, UserSegmentSchema).list();

    for (const j of output.journeys) {
      const id = ctx.ids.next('SC-UJ');
      repository(ctx.store, ARTIFACT_TYPES.USER_JOURNEY, UserJourneySchema).put(tx, {
        id,
        createdAt: at,
        name: j.name,
        segmentRef: { id: segments[0]?.id ?? 'SC-SEG-UNKNOWN' },
        goal: j.goal,
        steps: j.steps.map((s, i) => ({
          order: i + 1,
          action: s.action,
          systemResponse: s.systemResponse,
        })),
        requirementRefs: [],
        meta: derived(ctx, UX, ['requirements'], 'journey for this segment'),
      });
      ids.push(id);
    }

    let uncovered = 0;
    for (const f of output.flows) {
      const real = f.requirementIds.filter((r) => known.has(r));
      if (real.length === 0) {
        notes.push(
          'flow "' + f.name + '" cites no requirement that exists — recorded as an orphan',
        );
      }
      const flowId = ctx.ids.next('SC-FLOW');
      repository(ctx.store, ARTIFACT_TYPES.FLOW, FlowSchema).put(tx, {
        id: flowId,
        createdAt: at,
        name: f.name,
        entryPoints: f.entryPoints,
        steps: f.steps,
        exitPoints: [],
        requirementRefs: real.map((r) => ({ id: r })),
        notApplicableStates: [],
        meta: derived(
          ctx,
          UX,
          real.length > 0 ? real : ['requirements'],
          'flow implementing these requirements',
        ),
      });
      ids.push(flowId);

      for (const s of f.screens) {
        const covId = ctx.ids.next('SC-STC');
        const coverage = repository(
          ctx.store,
          ARTIFACT_TYPES.STATE_COVERAGE,
          StateCoverageSchema,
        ).put(tx, {
          id: covId,
          createdAt: at,
          flowRef: { id: flowId },
          screen: s.screen,
          states: s.states,
          meta: derived(ctx, UX, [flowId], 'state coverage for ' + s.screen),
        });
        ids.push(covId);

        const missing = missingStates(coverage);
        if (missing.length > 0) {
          uncovered += missing.length;
          notes.push('"' + s.screen + '" does not account for: ' + missing.join(', '));
        }
      }
    }

    const iaId = ctx.ids.next('SC-IA');
    repository(
      ctx.store,
      ARTIFACT_TYPES.INFORMATION_ARCHITECTURE,
      InformationArchitectureSchema,
    ).put(tx, {
      id: iaId,
      createdAt: at,
      sections: output.informationArchitecture,
      rationale: output.rationale,
      meta: derived(ctx, UX, ['requirements'], 'information architecture'),
    });
    ids.push(iaId);

    const navId = ctx.ids.next('SC-NAV');
    repository(ctx.store, ARTIFACT_TYPES.NAVIGATION_MODEL, NavigationModelSchema).put(tx, {
      id: navId,
      createdAt: at,
      pattern: output.navigationPattern,
      primary: output.informationArchitecture.map((s) => s.name),
      secondary: [],
      meta: derived(ctx, UX, [iaId], 'navigation over the information architecture'),
    });
    ids.push(navId);

    return {
      artifactIds: ids,
      notes,
      judgements: [
        {
          criterionRef: 'UX-1',
          met: uncovered === 0,
          by: UX,
          note:
            uncovered === 0
              ? 'every screen accounts for every required state'
              : String(uncovered) + ' state(s) unaccounted for',
        },
      ],
    };
  },
};

/* ============================================================ SC-AGENT-123 — UX review */

const ReviewOutput = z
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

const UX_REVIEWER = 'SC-AGENT-123';

export const uxReviewDepartment: DepartmentConfig<typeof ReviewOutput> = {
  id: 'DEPT-UX-REVIEW',
  stageId: 'SC-STAGE-024',
  agentId: UX_REVIEWER,
  title: 'UX Review',
  outputSchema: ReviewOutput,
  outputJsonSchema: jsonSchemaFor(ReviewOutput),
  requires: [ARTIFACT_TYPES.FLOW],
  independentOf: [UX],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const flows = repository(ctx.store, ARTIFACT_TYPES.FLOW, FlowSchema).list();
    const coverage = repository(
      ctx.store,
      ARTIFACT_TYPES.STATE_COVERAGE,
      StateCoverageSchema,
    ).list();
    return {
      canon: [
        contextFrom('flows', 'FLOW', flows, (f) => f.name + ': ' + f.steps.join(' → '), 1),
        contextFrom(
          'coverage',
          'STATE_COVERAGE',
          coverage,
          (c) => c.screen + ': ' + c.states.map((s) => s.state + '=' + s.disposition).join(', '),
          1,
        ),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        { subject: 'the designer’s reasoning', reason: 'the flows are judged as recorded' },
      ],
    };
  },

  task(): string {
    return [
      'Review these flows. You did not design them.',
      '',
      'Check state coverage first — a NOT_APPLICABLE with no reason, or a missing state,',
      'is where the product will fail in front of a user.',
      '',
      'Then check that every flow implements a stated requirement and that a person can',
      'tell where they are and how to get back. Return NOT_ACCEPTABLE if anything BLOCKING',
      'remains.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Review only. Do not redesign flows.';
  },

  persist(_tx, output, ctx) {
    return {
      artifactIds: [],
      notes: [
        output.summary,
        ...output.findings.map((f) => 'JUDGED[' + f.severity + '] ' + f.statement),
      ],
      judgements: [
        {
          criterionRef: 'UX-2',
          met: output.verdict === 'ACCEPTABLE',
          by: UX_REVIEWER,
          note: output.summary,
          subjects: currentSubjects(ctx.store, [
            ARTIFACT_TYPES.FLOW,
            ARTIFACT_TYPES.STATE_COVERAGE,
          ]),
        },
      ],
    };
  },
};

/* ====================================================== SC-AGENT-130 — design system */

export const DesignSystemOutputSchema = z
  .object({
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
      .min(1),
    semantic: z
      .array(
        z
          .object({
            name: z.string().min(1),
            category: z.string().min(1),
            references: z.string().min(1),
            purpose: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    components: z
      .array(
        z
          .object({
            name: z.string().min(1),
            anatomy: z.array(z.string().min(1)).min(1),
            states: z
              .array(
                z
                  .object({
                    state: z.string().min(1),
                    appearance: z.string().min(1),
                    tokens: z.array(z.string().min(1)).default([]),
                  })
                  .strict(),
              )
              .min(1),
            keyboard: z.array(z.string().min(1)).default([]),
            minTargetPx: z.number().int().positive(),
            mirrorsUnderRtl: z.boolean(),
            directionalProperties: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .min(1),
    layout: z
      .object({
        grid: z.string().min(1),
        breakpoints: z
          .array(z.object({ name: z.string().min(1), min: z.string().min(1) }).strict())
          .min(1),
        spacingScale: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    rtl: z
      .object({
        supported: z.boolean(),
        logicalProperties: z.array(z.string().min(1)).default([]),
        neverMirror: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    accessibility: z
      .object({
        targetStandard: z.string().min(1),
        minTargetPx: z.number().int().positive(),
        keyboardModel: z.string().min(1),
        focusVisible: z.string().min(1),
        contrastMinimums: z
          .array(z.object({ context: z.string().min(1), ratio: z.number().positive() }).strict())
          .min(1),
      })
      .strict(),
  })
  .strict();

const DESIGN_OWNER = 'SC-AGENT-130';

export const designSystemDepartment: DepartmentConfig<typeof DesignSystemOutputSchema> = {
  id: 'DEPT-DESIGN-SYSTEM',
  stageId: 'SC-STAGE-025',
  agentId: DESIGN_OWNER,
  title: 'Design System',
  outputSchema: DesignSystemOutputSchema,
  outputJsonSchema: jsonSchemaFor(DesignSystemOutputSchema),
  requires: [ARTIFACT_TYPES.FLOW],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const flows = repository(ctx.store, ARTIFACT_TYPES.FLOW, FlowSchema).list();
    const segments = repository(ctx.store, ARTIFACT_TYPES.USER_SEGMENT, UserSegmentSchema).list();
    return {
      canon: [
        contextFrom('flows', 'FLOW', flows, (f) => f.name, 1),
        contextFrom('segments', 'SEGMENT', segments, (s) => s.context, 0.8),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'architecture, data, implementation',
          reason: 'the visual system follows the experience, not the backend',
        },
      ],
    };
  },

  task(): string {
    return [
      'Define the design system. Serva chooses this — the owner is not asked for a border',
      'radius or a shade of grey. Genuine brand constraints, if any, are already in the',
      'project constraints.',
      '',
      'Split tokens into PRIMITIVES (a palette) and SEMANTIC roles that reference them.',
      'A component may only ever consume a semantic token: without the indirection,',
      'rebranding means finding every blue and guessing which ones meant "primary action".',
      '',
      'Every component must define default, hover, focus, active, disabled, loading and',
      'error. A component missing a state is a component someone will improvise later.',
      '',
      'Decide RTL now. Retrofitting it touches every margin, icon and alignment in the',
      'product; deciding it here costs a paragraph.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'The design system itself. Do not compose screens or change flows.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const at = ctx.clock.now();

    const tokensId = ctx.ids.next('SC-DTS');
    repository(ctx.store, ARTIFACT_TYPES.DESIGN_TOKEN_SET, DesignTokenSetSchema).put(tx, {
      id: tokensId,
      createdAt: at,
      primitives: output.primitives,
      semantic: output.semantic,
      meta: derived(ctx, DESIGN_OWNER, ['flows'], 'token system for this product'),
    });
    ids.push(tokensId);

    for (const c of output.components) {
      const id = ctx.ids.next('SC-CMP');
      repository(ctx.store, ARTIFACT_TYPES.COMPONENT_SPEC, ComponentSpecSchema).put(tx, {
        id,
        createdAt: at,
        name: c.name,
        anatomy: c.anatomy,
        variants: [],
        states: c.states,
        a11y: { keyboard: c.keyboard, minTargetPx: c.minTargetPx },
        rtl: {
          mirrors: c.mirrorsUnderRtl,
          directionalProperties: c.directionalProperties,
          exceptions: [],
        },
        meta: derived(ctx, DESIGN_OWNER, [tokensId], 'component built from semantic tokens'),
      });
      ids.push(id);
    }

    const layoutId = ctx.ids.next('SC-LAY');
    repository(ctx.store, ARTIFACT_TYPES.LAYOUT_SYSTEM, LayoutSystemSchema).put(tx, {
      id: layoutId,
      createdAt: at,
      grid: output.layout.grid,
      breakpoints: output.layout.breakpoints,
      spacingScale: output.layout.spacingScale,
      meta: derived(ctx, DESIGN_OWNER, [tokensId], 'layout system'),
    });
    ids.push(layoutId);

    const rtlId = ctx.ids.next('SC-RTL');
    repository(ctx.store, ARTIFACT_TYPES.RTL_RULES, RtlRulesSchema).put(tx, {
      id: rtlId,
      createdAt: at,
      supported: output.rtl.supported,
      logicalProperties: output.rtl.logicalProperties,
      mirroredIcons: [],
      neverMirror: output.rtl.neverMirror,
      meta: derived(ctx, DESIGN_OWNER, [tokensId], 'right-to-left behaviour, designed up front'),
    });
    ids.push(rtlId);

    const a11yId = ctx.ids.next('SC-ACCESS');
    repository(ctx.store, ARTIFACT_TYPES.ACCESSIBILITY_SPEC, AccessibilitySpecSchema).put(tx, {
      id: a11yId,
      createdAt: at,
      targetStandard: output.accessibility.targetStandard,
      contrastMinimums: output.accessibility.contrastMinimums,
      minTargetPx: output.accessibility.minTargetPx,
      keyboardModel: output.accessibility.keyboardModel,
      focusVisible: output.accessibility.focusVisible,
      /*
       * An automated checker finds a minority of real accessibility defects. Claiming
       * conformance from its silence would be a false statement about a legal standard.
       */
      formalConformanceClaimed: false,
      expertReviewRequired: true,
      meta: derived(
        ctx,
        DESIGN_OWNER,
        [tokensId],
        'accessibility targets, not a conformance claim',
      ),
    });
    ids.push(a11yId);

    return {
      artifactIds: ids,
      notes: [
        'accessibility: targets recorded; formal conformance is EXPERT_REVIEW_REQUIRED and is not claimed',
      ],
    };
  },
};

/* ============================================================= SC-AGENT-131 — UI design */

export const UiOutputSchema = z
  .object({
    screens: z
      .array(
        z
          .object({
            screen: z.string().min(1),
            /** Names of components from the system. New components are refused. */
            componentNames: z.array(z.string().min(1)).min(1),
            notes: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const UI_DESIGNER = 'SC-AGENT-131';

export const uiDepartment: DepartmentConfig<typeof UiOutputSchema> = {
  id: 'DEPT-UI',
  stageId: 'SC-STAGE-025',
  agentId: UI_DESIGNER,
  title: 'UI Composition',
  outputSchema: UiOutputSchema,
  outputJsonSchema: jsonSchemaFor(UiOutputSchema),
  requires: [ARTIFACT_TYPES.COMPONENT_SPEC],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const components = repository(
      ctx.store,
      ARTIFACT_TYPES.COMPONENT_SPEC,
      ComponentSpecSchema,
    ).list();
    const coverage = repository(
      ctx.store,
      ARTIFACT_TYPES.STATE_COVERAGE,
      StateCoverageSchema,
    ).list();
    return {
      canon: [
        contextFrom(
          'components',
          'COMPONENT',
          components,
          (c) => c.name + ': ' + c.anatomy.join('/'),
          1,
        ),
        contextFrom('screens', 'SCREEN', coverage, (c) => c.screen, 1),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'the token primitives and backend',
          reason:
            'the UI designer composes with the system and may not invent a token or a component',
        },
      ],
    };
  },

  task(): string {
    return [
      'Compose each screen from the EXISTING components.',
      '',
      'You may not invent a new component or a new token. If a screen genuinely needs',
      'something the system does not have, say so in notes — changing the system is the',
      'Design System Owner’s decision and requires impact analysis across every consumer.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Compose screens from existing components. Do not add components or tokens.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const notes: string[] = [];
    const at = ctx.clock.now();
    const components = repository(
      ctx.store,
      ARTIFACT_TYPES.COMPONENT_SPEC,
      ComponentSpecSchema,
    ).list();
    const byName = new Map(components.map((c) => [c.name, c.id]));

    for (const s of output.screens) {
      const refs = s.componentNames
        .map((n) => byName.get(n))
        .filter((id): id is string => id !== undefined);
      const invented = s.componentNames.filter((n) => !byName.has(n));
      if (invented.length > 0) {
        /* §25: SC-AGENT-131 may compose but may not invent. Reported, not stored. */
        notes.push(
          'screen "' +
            s.screen +
            '" referenced component(s) that are not in the design system: ' +
            invented.join(', ') +
            ' — a new component is the Design System Owner’s decision',
        );
      }
      if (refs.length === 0) continue;
      const id = ctx.ids.next('SC-SCR');
      repository(ctx.store, ARTIFACT_TYPES.SCREEN_COMPOSITION, ScreenCompositionSchema).put(tx, {
        id,
        createdAt: at,
        screen: s.screen,
        componentRefs: refs.map((r) => ({ id: r })),
        ...(s.notes === undefined ? {} : { notes: s.notes }),
        meta: derived(ctx, UI_DESIGNER, refs, 'screen composed from existing components'),
      });
      ids.push(id);
    }

    return { artifactIds: ids, notes };
  },
};

/* ================================================== SC-AGENT-133 — design system review */

const DESIGN_REVIEWER = 'SC-AGENT-133';

export const designReviewDepartment: DepartmentConfig<typeof ReviewOutput> = {
  id: 'DEPT-DESIGN-REVIEW',
  stageId: 'SC-STAGE-025',
  agentId: DESIGN_REVIEWER,
  title: 'Design System Review',
  outputSchema: ReviewOutput,
  outputJsonSchema: jsonSchemaFor(ReviewOutput),
  requires: [ARTIFACT_TYPES.DESIGN_TOKEN_SET],
  independentOf: [DESIGN_OWNER, UI_DESIGNER],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const tokens = repository(
      ctx.store,
      ARTIFACT_TYPES.DESIGN_TOKEN_SET,
      DesignTokenSetSchema,
    ).list();
    const components = repository(
      ctx.store,
      ARTIFACT_TYPES.COMPONENT_SPEC,
      ComponentSpecSchema,
    ).list();
    return {
      canon: [
        contextFrom(
          'tokens',
          'TOKENS',
          tokens,
          (t) => t.semantic.map((s) => s.name + '→' + s.references).join(', '),
          1,
        ),
        contextFrom(
          'components',
          'COMPONENT',
          components,
          (c) => c.name + ' states: ' + c.states.map((s) => s.state).join('/'),
          1,
        ),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [{ subject: 'the design owner’s reasoning', reason: 'judged as recorded' }],
    };
  },

  task(): string {
    return [
      'Review the design system. You did not build it.',
      '',
      'Check that every semantic token resolves to a real primitive, that no component',
      'uses a raw value, that every component defines every required state, and that RTL',
      'uses logical rather than physical properties.',
      '',
      'Serva also runs these checks mechanically. Your job is what a checker cannot do:',
      'whether the system is coherent and whether a designer could actually build with it.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Review only. Do not change tokens or components.';
  },

  persist(_tx, output, ctx) {
    return {
      artifactIds: [],
      notes: [
        output.summary,
        ...output.findings.map((f) => 'JUDGED[' + f.severity + '] ' + f.statement),
      ],
      judgements: [
        {
          criterionRef: 'DS-1',
          met: output.verdict === 'ACCEPTABLE',
          by: DESIGN_REVIEWER,
          note: output.summary,
          subjects: currentSubjects(ctx.store, [
            ARTIFACT_TYPES.DESIGN_TOKEN_SET,
            ARTIFACT_TYPES.COMPONENT_SPEC,
          ]),
        },
      ],
    };
  },
};

/* ============================================ SC-AGENT-140/141 — admin operability */

export const OperabilityOutputSchema = z
  .object({
    reviews: z
      .array(
        z
          .object({
            featureName: z.string().min(1),
            whatOperatorMustView: z.array(z.string().min(1)).default([]),
            whatIsConfigurable: z.array(z.string().min(1)).default([]),
            whatCanBeOverridden: z.array(z.string().min(1)).default([]),
            whatShouldBeAutomated: z.array(z.string().min(1)).default([]),
            whatMustNeverBeConfigurable: z.array(z.string().min(1)).default([]),
            whatRequiresAudit: z.array(z.string().min(1)).default([]),
            whatRequiresConfirmation: z.array(z.string().min(1)).default([]),
            roleSeparation: z.array(z.string().min(1)).default([]),
            conclusion: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    configuration: z
      .array(
        z
          .object({
            element: z.string().min(1),
            classification: z.enum([
              'OPERATOR_CONFIGURABLE',
              'PRIVILEGED',
              'DEPLOY_TIME',
              'PROTECTED',
            ]),
            justification: z.string().min(1),
            historicallySignificant: z.boolean(),
            effectiveDated: z.boolean(),
            requiresAudit: z.boolean(),
            requiresConfirmation: z.boolean(),
            reversible: z.boolean(),
          })
          .strict(),
      )
      .default([]),
    protectedRules: z
      .array(
        z
          .object({
            rule: z.string().min(1),
            protectionReason: z.enum([
              'SECURITY',
              'FINANCIAL',
              'STRUCTURAL',
              'LEGAL',
              'HISTORICAL_INTEGRITY',
            ]),
            explanation: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    auditRequirements: z
      .array(
        z
          .object({ action: z.string().min(1), captures: z.array(z.string().min(1)).min(1) })
          .strict(),
      )
      .default([]),
    controls: z
      .array(
        z
          .object({
            name: z.string().min(1),
            effect: z.string().min(1),
            destructive: z.boolean(),
            reversible: z.boolean(),
            guardrail: z.string().min(1).optional(),
          })
          .strict(),
      )
      .default([]),
    adminSections: z
      .array(z.object({ name: z.string().min(1), purpose: z.string().min(1) }).strict())
      .min(1),
  })
  .strict();

const OPERABILITY = 'SC-AGENT-140';

export const operabilityDepartment: DepartmentConfig<typeof OperabilityOutputSchema> = {
  id: 'DEPT-OPERABILITY',
  stageId: 'SC-STAGE-026',
  agentId: OPERABILITY,
  title: 'Admin Operability',
  outputSchema: OperabilityOutputSchema,
  outputJsonSchema: jsonSchemaFor(OperabilityOutputSchema),
  requires: [ARTIFACT_TYPES.FEATURE],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const features = repository(ctx.store, ARTIFACT_TYPES.FEATURE, FeatureSchema).list();
    const rules = repository(ctx.store, ARTIFACT_TYPES.BUSINESS_RULE, BusinessRuleSchema).list();
    return {
      canon: [
        contextFrom('features', 'FEATURE', features, (f) => f.name + ': ' + f.description, 1),
        contextFrom('rules', 'BUSINESS_RULE', rules, (r) => r.statement, 1),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'implementation and architecture',
          reason: 'operability is about what an operator must be able to do, not how it is built',
        },
      ],
    };
  },

  task(): string {
    return [
      'EVERY feature gets an operability review. This is mandatory.',
      '',
      'The question is not "does this need an admin page". It is: what must an operator be',
      'able to SEE, what may they CHANGE, what may they OVERRIDE, what should be automated,',
      'and — most importantly — what must NEVER be configurable.',
      '',
      'Features shipped without this become permanent engineering tickets: every "can you',
      'just change the rate for this one customer" costs a deployment forever, because the',
      'decision to hard-code it was never made, only never considered.',
      '',
      'The opposite error is worse. A security rule, a financial invariant or a historical',
      'record exposed as an ordinary setting hands an operator the ability to break the',
      'company’s own guarantees from a settings page. Mark those PROTECTED.',
      '',
      'Anything historically significant — a rate that past records were computed with —',
      'must be effective-dated, or changing it silently rewrites the past.',
      '',
      'A destructive control needs a guardrail. Say what it is.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Operability and configuration classification. Do not design the admin UI in detail or change features.';
  },

  persist(tx, output, ctx) {
    const ids: string[] = [];
    const notes: string[] = [];
    const at = ctx.clock.now();
    const features = repository(ctx.store, ARTIFACT_TYPES.FEATURE, FeatureSchema).list();
    const byName = new Map(features.map((f) => [f.name, f.id]));

    for (const r of output.reviews) {
      const featureId = byName.get(r.featureName);
      if (featureId === undefined) {
        notes.push('operability review references unknown feature "' + r.featureName + '"');
        continue;
      }
      const id = ctx.ids.next('SC-AOR');
      repository(
        ctx.store,
        ARTIFACT_TYPES.ADMIN_OPERABILITY_REVIEW,
        AdminOperabilityReviewSchema,
      ).put(tx, {
        id,
        createdAt: at,
        featureRef: { id: featureId },
        whatOperatorMustView: r.whatOperatorMustView,
        whatIsConfigurable: r.whatIsConfigurable,
        whatCanBeOverridden: r.whatCanBeOverridden,
        whatShouldBeAutomated: r.whatShouldBeAutomated,
        whatMustNeverBeConfigurable: r.whatMustNeverBeConfigurable,
        whatRequiresAudit: r.whatRequiresAudit,
        whatRequiresConfirmation: r.whatRequiresConfirmation,
        roleSeparation: r.roleSeparation,
        concluded: true,
        conclusion: r.conclusion,
        meta: derived(ctx, OPERABILITY, [featureId], 'operability review for this feature'),
      });
      ids.push(id);
    }

    /* Features with no review at all — the mandatory rule, checked here as well. */
    const reviewed = new Set(output.reviews.map((r) => byName.get(r.featureName)));
    for (const f of features) {
      if (!reviewed.has(f.id)) {
        notes.push('feature "' + f.name + '" received no operability review');
      }
    }

    if (output.configuration.length > 0) {
      const id = ctx.ids.next('SC-CFG');
      repository(ctx.store, ARTIFACT_TYPES.CONFIGURATION_REGISTER, ConfigurationRegisterSchema).put(
        tx,
        {
          id,
          createdAt: at,
          entries: output.configuration,
          meta: derived(ctx, OPERABILITY, ['features'], 'every configurable element, classified'),
        },
      );
      ids.push(id);
    }

    for (const p of output.protectedRules) {
      const id = ctx.ids.next('SC-PR');
      repository(ctx.store, ARTIFACT_TYPES.PROTECTED_RULE, ProtectedRuleSchema).put(tx, {
        id,
        createdAt: at,
        rule: p.rule,
        protectionReason: p.protectionReason,
        explanation: p.explanation,
        meta: derived(ctx, OPERABILITY, ['features'], 'never configurable'),
      });
      ids.push(id);
    }

    for (const a of output.auditRequirements) {
      const id = ctx.ids.next('SC-AAR');
      repository(
        ctx.store,
        ARTIFACT_TYPES.ADMIN_AUDIT_REQUIREMENT,
        AdminAuditRequirementSchema,
      ).put(tx, {
        id,
        createdAt: at,
        action: a.action,
        captures: a.captures,
        meta: derived(ctx, OPERABILITY, ['features'], 'what must be captured for ' + a.action),
      });
      ids.push(id);
    }

    for (const c of output.controls) {
      const id = ctx.ids.next('SC-OC');
      repository(ctx.store, ARTIFACT_TYPES.OPERATIONAL_CONTROL, OperationalControlSchema).put(tx, {
        id,
        createdAt: at,
        name: c.name,
        effect: c.effect,
        destructive: c.destructive,
        reversible: c.reversible,
        ...(c.guardrail === undefined ? {} : { guardrail: c.guardrail }),
        meta: derived(ctx, OPERABILITY, ['features'], 'operational control'),
      });
      ids.push(id);
    }

    const iaId = ctx.ids.next('SC-AIA');
    repository(ctx.store, ARTIFACT_TYPES.ADMIN_IA, AdminIaSchema).put(tx, {
      id: iaId,
      createdAt: at,
      sections: output.adminSections,
      meta: derived(ctx, OPERABILITY, ['features'], 'admin information architecture'),
    });
    ids.push(iaId);

    return { artifactIds: ids, notes };
  },
};

export const EXPERIENCE_DEPARTMENTS: readonly DepartmentConfig[] = Object.freeze([
  uxDepartment as DepartmentConfig,
  uxReviewDepartment as DepartmentConfig,
  designSystemDepartment as DepartmentConfig,
  uiDepartment as DepartmentConfig,
  designReviewDepartment as DepartmentConfig,
  operabilityDepartment as DepartmentConfig,
]);

/** Re-exported for the deterministic checks, which use the same list. */
export { REQUIRED_STATES };
