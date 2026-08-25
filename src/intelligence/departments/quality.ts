import { z } from 'zod';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import { RequirementSchema, AcceptanceCriterionSchema } from '../artifacts/requirements.js';
import { NfrSchema } from '../artifacts/requirements.js';
import { AccessibilitySpecSchema } from '../artifacts/design.js';
import { ThreatModelSchema, AbuseCaseSchema } from '../artifacts/security.js';
import {
  AcceptanceVerdictSchema,
  AccessibilityVerdictSchema,
  DefectSchema,
  PerformanceVerdictSchema,
  QAVerdictSchema,
  SecurityFindingSchema,
  SecurityVerdictSchema,
  VerificationVerdict,
} from '../artifacts/quality.js';
import { jsonSchemaFor } from '../execution/jsonSchema.js';
import { contextFrom, currentSubjects, derived } from './shared.js';
import { supportedVerdict } from './verdictSupport.js';
import type {
  DepartmentConfig,
  DepartmentContext,
  DepartmentContextSpec,
  PersistResult,
} from '../execution/types.js';
import type { ScopedCanonWriter } from '../execution/authority.js';

/**
 * THE DOWNSTREAM QUALITY COMPANY — stages 042, 043, 044, 045.
 *
 * SPEC: §12, §20, 03 §7, 06, 18.
 *
 * Phase 4 already answers the questions a machine can answer: does it build, do the
 * declared tests pass, did the change stay in scope, is there a credential in the diff.
 * Those remain the evidence authority, and nothing here can overturn one — an agent
 * opinion never makes a failing check pass.
 *
 * These four departments answer the question a machine cannot: is the thing that builds
 * the thing that was asked for. That is a judgement, so every one of them is INDEPENDENT
 * of the actors that produced the work, and every verdict names the exact artifact
 * versions it rests on. A verdict that cannot say what it looked at survives the thing it
 * looked at, and a stale approval that keeps counting is worse than no approval at all.
 *
 * All four share a shape that is not an accident:
 *
 *   NOT_VERIFIED is a first-class verdict and it BLOCKS. A verifier that could not
 *   establish something has said the most useful true thing available; forcing it into
 *   PASS or FAIL invents the one fact the run did not have.
 *
 *   `notVerified` is a separate field from findings. "I checked and it is wrong" and "I
 *   could not check" are different results, and merging them is how an unexamined area
 *   comes to look like a clean one.
 *
 *   The verdict is written by Serva from validated structured output, through a writer
 *   scoped to one family. A verifier cannot write the thing it is verifying.
 */

const QA_AGENT = 'SC-AGENT-214';
const A11Y_AGENT = 'SC-AGENT-213';
const SECURITY_AGENT = 'SC-AGENT-220';
const PERFORMANCE_AGENT = 'SC-AGENT-230';
const ACCEPTANCE_AGENT = 'SC-AGENT-240';

/** Everyone who writes the product. A verifier may never be one of them. */
export const IMPLEMENTERS: readonly string[] = Object.freeze([
  'SC-AGENT-150',
  'SC-AGENT-160',
  'SC-AGENT-170',
  'SC-AGENT-180',
  'SC-AGENT-190',
]);

/** The verdict vocabulary every downstream department returns. */
const verdictEnum = z.enum([
  VerificationVerdict.PASS,
  VerificationVerdict.PASS_WITH_QUALIFICATION,
  VerificationVerdict.FAIL,
  VerificationVerdict.NOT_VERIFIED,
]);

const notVerifiedSchema = z
  .array(z.object({ area: z.string().min(1), why: z.string().min(1) }).strict())
  .default([]);

/**
 * The subject a downstream verdict is about.
 *
 * The current ChangeSet where Phase 4 has produced one, and the work item otherwise. A
 * verdict with no subject is an opinion about the project in general, which nothing can
 * act on and nothing can invalidate.
 */
function subjectRef(ctx: DepartmentContext): { readonly id: string } {
  const changeSets = ctx.store.listCanonIds('eng.changeSet');
  const latest = changeSets[changeSets.length - 1];
  return { id: latest ?? ctx.workItemId };
}

/** The run, or a refusal. A verdict that cannot name its run is indistinguishable from a claim. */
function requireRun(ctx: DepartmentContext, agentId: string): string {
  if (ctx.runId !== undefined) return ctx.runId;
  throw new Error(
    'A verdict by ' +
      agentId +
      ' must name the governed run that produced it. Synthesising one would make the attribution unfalsifiable.',
  );
}

/* ============================================================ 042 — QA VERIFICATION */

export const QAOutputSchema = z
  .object({
    verdict: verdictEnum,
    summary: z.string().min(1),
    /** Acceptance criteria or requirements this run actually exercised, by id. */
    criteriaCovered: z.array(z.string().min(1)).default([]),
    notVerified: notVerifiedSchema,
    defects: z
      .array(
        z
          .object({
            title: z.string().min(1),
            detail: z.string().min(1),
            severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
            reproduction: z.string().min(1),
            affects: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const qaVerificationDepartment: DepartmentConfig<typeof QAOutputSchema> = {
  id: 'DEPT-QA-VERIFICATION',
  stageId: 'SC-STAGE-042',
  agentId: QA_AGENT,
  title: 'QA Verification',
  produces: [ARTIFACT_TYPES.QA_VERDICT, ARTIFACT_TYPES.DEFECT],
  /** SPEC §40: the actor that wrote the product may not be the actor that verifies it. */
  independentOf: [...IMPLEMENTERS],
  outputSchema: QAOutputSchema,
  outputJsonSchema: jsonSchemaFor(QAOutputSchema),
  requires: [ARTIFACT_TYPES.ACCEPTANCE_CRITERION],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const criteria = repository(
      ctx.store,
      ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
      AcceptanceCriterionSchema,
    ).list();
    const requirements = repository(
      ctx.store,
      ARTIFACT_TYPES.REQUIREMENT,
      RequirementSchema,
    ).list();
    return {
      canon: [
        contextFrom('criteria', 'ACCEPTANCE_CRITERION', criteria, (c) => c.criterion, 1),
        contextFrom('requirements', 'REQUIREMENT', requirements, (r) => r.statement, 0.9),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'the implementers’ own reasoning and their account of the work',
          reason:
            'a verifier handed the author’s case for the defence agrees with it; QA judges the product against the criteria, not against the argument for it',
        },
      ],
    };
  },

  task(): string {
    return [
      'Decide whether this change satisfies its acceptance criteria.',
      '',
      'You are verifying, not building and not improving. A criterion you could not',
      'exercise goes in notVerified with the reason — never in the summary as though it',
      'had passed. NOT_VERIFIED is a real verdict and it blocks; it is the honest answer',
      'when the evidence is not there.',
      '',
      'A defect is something you OBSERVED, with steps somebody else can follow. A concern',
      'you cannot reproduce is a note in the summary, not a defect.',
      '',
      'The deterministic checks already ran. You cannot overturn one: if the suite failed,',
      'the suite failed, and no verdict here changes that.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Verify the change against its acceptance criteria. Do not modify anything, and do not re-specify what was asked for.';
  },

  persist(tx: ScopedCanonWriter, output, ctx): PersistResult {
    const at = ctx.clock.now();
    const runId = requireRun(ctx, QA_AGENT);
    const ids: string[] = [];

    const defectRefs: { id: string }[] = [];
    for (const d of output.defects) {
      const id = ctx.ids.next('SC-DEF');
      repository(ctx.store, ARTIFACT_TYPES.DEFECT, DefectSchema).put(tx, {
        id,
        createdAt: at,
        title: d.title,
        detail: d.detail,
        severity: d.severity,
        affects: d.affects.map((a) => ({ id: a })),
        reproduction: d.reproduction,
        state: 'OPEN',
        foundByAgentId: QA_AGENT,
        meta: derived(ctx, QA_AGENT, d.affects, 'observed while verifying acceptance', runId),
      });
      defectRefs.push({ id });
      ids.push(id);
    }

    const verdictId = ctx.ids.next('SC-QAV');
    repository(ctx.store, ARTIFACT_TYPES.QA_VERDICT, QAVerdictSchema).put(tx, {
      id: verdictId,
      createdAt: at,
      /* Serva computes this: a success that covered no criterion checked nothing. */
      verdict: supportedVerdict(output.verdict, {
        exercised: output.criteriaCovered.length,
        notVerified: output.notVerified.length,
      }),
      subjectRef: subjectRef(ctx),
      subjects: [
        ...currentSubjects(ctx.store, [
          ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
          ARTIFACT_TYPES.REQUIREMENT,
        ]),
      ],
      summary: output.summary,
      notVerified: output.notVerified,
      criteriaCovered: output.criteriaCovered,
      defectRefs,
      verifiedByRunId: runId,
      verifiedByAgentId: QA_AGENT,
      verifiedAt: at,
      meta: derived(ctx, QA_AGENT, output.criteriaCovered, 'QA verification', runId),
    });
    ids.push(verdictId);

    return {
      artifactIds: ids,
      notes: [
        'QA verdict ' + output.verdict + ' with ' + String(output.defects.length) + ' defect(s)',
        ...output.notVerified.map((n) => 'not verified: ' + n.area + ' — ' + n.why),
      ],
      judgements: [
        {
          criterionRef: 'QA-1',
          met: output.verdict === VerificationVerdict.PASS,
          by: QA_AGENT,
          note: output.summary,
          subjects: [...currentSubjects(ctx.store, [ARTIFACT_TYPES.ACCEPTANCE_CRITERION])],
        },
      ],
    };
  },
};

/* ==================================================== 042 — ACCESSIBILITY VERIFICATION */

export const AccessibilityOutputSchema = z
  .object({
    verdict: verdictEnum,
    summary: z.string().min(1),
    standard: z.string().min(1),
    automatedChecks: z
      .array(
        z
          .object({
            check: z.string().min(1),
            passed: z.boolean(),
            detail: z.string().min(1).optional(),
          })
          .strict(),
      )
      .default([]),
    findings: z
      .array(
        z
          .object({
            issue: z.string().min(1),
            severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
            where: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    notVerified: notVerifiedSchema,
  })
  .strict();

export const accessibilityVerificationDepartment: DepartmentConfig<
  typeof AccessibilityOutputSchema
> = {
  id: 'DEPT-ACCESSIBILITY-VERIFICATION',
  stageId: 'SC-STAGE-042',
  agentId: A11Y_AGENT,
  title: 'Accessibility Verification',
  produces: [ARTIFACT_TYPES.ACCESSIBILITY_VERDICT],
  /** Independent of the design authority that wrote the specification being checked. */
  independentOf: ['SC-AGENT-130', 'SC-AGENT-131', ...IMPLEMENTERS],
  outputSchema: AccessibilityOutputSchema,
  outputJsonSchema: jsonSchemaFor(AccessibilityOutputSchema),
  requires: [ARTIFACT_TYPES.ACCESSIBILITY_SPEC],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const spec = repository(
      ctx.store,
      ARTIFACT_TYPES.ACCESSIBILITY_SPEC,
      AccessibilitySpecSchema,
    ).list();
    return {
      canon: [
        contextFrom(
          'accessibility',
          'ACCESSIBILITY_SPEC',
          spec,
          (s) => s.targetStandard + ': ' + s.keyboardModel,
          1,
        ),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'the design system author’s rationale',
          reason: 'the specification is checked against the product, not against its defence',
        },
      ],
    };
  },

  task(): string {
    return [
      'Check the product against the accessibility specification that was agreed.',
      '',
      'Report automated checks separately from what you judged. Automated tooling finds a',
      'minority of real accessibility problems, and a clean sweep proves very little — a',
      'report that merges the two reads as compliance nobody established.',
      '',
      'Serva will not claim certification from this. Say plainly what you could not check.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Verify accessibility against the agreed specification. Do not redesign, and do not change the standard.';
  },

  persist(tx: ScopedCanonWriter, output, ctx): PersistResult {
    const at = ctx.clock.now();
    const runId = requireRun(ctx, A11Y_AGENT);
    const id = ctx.ids.next('SC-A11V');
    repository(ctx.store, ARTIFACT_TYPES.ACCESSIBILITY_VERDICT, AccessibilityVerdictSchema).put(
      tx,
      {
        id,
        createdAt: at,
        /* Serva computes this: a success that ran no check checked nothing. */
        verdict: supportedVerdict(output.verdict, {
          exercised: output.automatedChecks.length + output.findings.length,
          notVerified: output.notVerified.length,
        }),
        subjectRef: subjectRef(ctx),
        subjects: [...currentSubjects(ctx.store, [ARTIFACT_TYPES.ACCESSIBILITY_SPEC])],
        summary: output.summary,
        standard: output.standard,
        automatedChecks: output.automatedChecks,
        findings: output.findings,
        notVerified: output.notVerified,
        verifiedByRunId: runId,
        verifiedByAgentId: A11Y_AGENT,
        verifiedAt: at,
        meta: derived(
          ctx,
          A11Y_AGENT,
          ['accessibility specification'],
          'accessibility verification',
          runId,
        ),
      },
    );
    return {
      artifactIds: [id],
      notes: ['accessibility verdict ' + output.verdict],
      judgements: [
        {
          criterionRef: 'QA-3',
          met: output.verdict === VerificationVerdict.PASS,
          by: A11Y_AGENT,
          note: output.summary,
          subjects: [...currentSubjects(ctx.store, [ARTIFACT_TYPES.ACCESSIBILITY_SPEC])],
        },
      ],
    };
  },
};

/* ====================================================== 043 — SECURITY VERIFICATION */

export const SecurityTestOutputSchema = z
  .object({
    verdict: verdictEnum,
    summary: z.string().min(1),
    /** Threats and abuse cases actually exercised, by id. */
    threatsExercised: z.array(z.string().min(1)).default([]),
    notVerified: notVerifiedSchema,
    findings: z
      .array(
        z
          .object({
            title: z.string().min(1),
            detail: z.string().min(1),
            severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
            threatId: z.string().min(1).optional(),
            evidence: z.string().min(1),
            remediation: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const securityVerificationDepartment: DepartmentConfig<typeof SecurityTestOutputSchema> = {
  id: 'DEPT-SECURITY-VERIFICATION',
  stageId: 'SC-STAGE-043',
  agentId: SECURITY_AGENT,
  title: 'Security Verification',
  produces: [ARTIFACT_TYPES.SECURITY_VERDICT, ARTIFACT_TYPES.SECURITY_FINDING],
  /** Never the architect who designed the controls being tested. */
  independentOf: ['SC-AGENT-090', ...IMPLEMENTERS],
  outputSchema: SecurityTestOutputSchema,
  outputJsonSchema: jsonSchemaFor(SecurityTestOutputSchema),
  requires: [ARTIFACT_TYPES.THREAT_MODEL],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const threats = repository(ctx.store, ARTIFACT_TYPES.THREAT_MODEL, ThreatModelSchema).list();
    const abuse = repository(ctx.store, ARTIFACT_TYPES.ABUSE_CASE, AbuseCaseSchema).list();
    return {
      canon: [
        contextFrom('threats', 'THREAT_MODEL', threats, (t) => t.scope, 1),
        contextFrom(
          'abuse',
          'ABUSE_CASE',
          abuse,
          (a) => a.actor + ' — ' + a.method + ' — ' + a.impact,
          1,
        ),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'the security architect’s rationale for the controls',
          reason:
            'testing a control against the argument for it is not testing; the threat model states what must hold',
        },
      ],
    };
  },

  task(): string {
    return [
      'Test the built product against the threat model and the abuse cases.',
      '',
      'Say which threats you actually exercised. A threat you did not reach goes in',
      'notVerified — an unexercised threat is not a passed one, and a summary that does',
      'not distinguish them turns an untested area into a clean bill of health.',
      '',
      'Every finding needs evidence somebody else can check and a remediation somebody',
      'else can act on. A finding that only you can see is a suspicion.',
      '',
      'You do not accept risk. A finding you believe is tolerable is still a finding;',
      'accepting it is the owner’s decision and Serva raises it separately.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Test the product against the modelled threats. Do not redesign the controls and do not accept risk.';
  },

  persist(tx: ScopedCanonWriter, output, ctx): PersistResult {
    const at = ctx.clock.now();
    const runId = requireRun(ctx, SECURITY_AGENT);
    const ids: string[] = [];
    const findingRefs: { id: string }[] = [];

    for (const f of output.findings) {
      const id = ctx.ids.next('SC-SECF');
      repository(ctx.store, ARTIFACT_TYPES.SECURITY_FINDING, SecurityFindingSchema).put(tx, {
        id,
        createdAt: at,
        title: f.title,
        detail: f.detail,
        severity: f.severity,
        ...(f.threatId === undefined ? {} : { threatRef: { id: f.threatId } }),
        evidence: f.evidence,
        remediation: f.remediation,
        state: 'OPEN',
        foundByAgentId: SECURITY_AGENT,
        meta: derived(
          ctx,
          SECURITY_AGENT,
          f.threatId === undefined ? ['threat model'] : [f.threatId],
          'observed while testing the modelled threats',
          runId,
        ),
      });
      findingRefs.push({ id });
      ids.push(id);
    }

    const verdictId = ctx.ids.next('SC-SECV');
    repository(ctx.store, ARTIFACT_TYPES.SECURITY_VERDICT, SecurityVerdictSchema).put(tx, {
      id: verdictId,
      createdAt: at,
      /*
       * Serva computes this. An agent reporting PASS with `threatsExercised: []` and every
       * threat in `notVerified` was persisting a clean bill of health for a security stage
       * that exercised nothing — the exact failure this department's own task text forbids.
       */
      verdict: supportedVerdict(output.verdict, {
        exercised: output.threatsExercised.length,
        notVerified: output.notVerified.length,
      }),
      subjectRef: subjectRef(ctx),
      subjects: [
        ...currentSubjects(ctx.store, [ARTIFACT_TYPES.THREAT_MODEL, ARTIFACT_TYPES.ABUSE_CASE]),
      ],
      summary: output.summary,
      notVerified: output.notVerified,
      threatsExercised: output.threatsExercised.map((t) => ({ id: t })),
      findingRefs,
      verifiedByRunId: runId,
      verifiedByAgentId: SECURITY_AGENT,
      verifiedAt: at,
      meta: derived(ctx, SECURITY_AGENT, output.threatsExercised, 'security verification', runId),
    });
    ids.push(verdictId);

    return {
      artifactIds: ids,
      notes: [
        'security verdict ' +
          output.verdict +
          ' with ' +
          String(output.findings.length) +
          ' finding(s)',
      ],
      judgements: [
        {
          criterionRef: 'SEC-1',
          met: output.verdict === VerificationVerdict.PASS,
          by: SECURITY_AGENT,
          note: output.summary,
          subjects: [...currentSubjects(ctx.store, [ARTIFACT_TYPES.THREAT_MODEL])],
        },
      ],
    };
  },
};

/* =================================================== 044 — PERFORMANCE VERIFICATION */

export const PerformanceOutputSchema = z
  .object({
    verdict: verdictEnum,
    summary: z.string().min(1),
    notVerified: notVerifiedSchema,
    measurements: z
      .array(
        z
          .object({
            nfrId: z.string().min(1),
            target: z.string().min(1),
            /** Absent means it was not measured. That is not a zero and not a pass. */
            measured: z.string().min(1).optional(),
            met: z.boolean().optional(),
            method: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const performanceVerificationDepartment: DepartmentConfig<typeof PerformanceOutputSchema> = {
  id: 'DEPT-PERFORMANCE-VERIFICATION',
  stageId: 'SC-STAGE-044',
  agentId: PERFORMANCE_AGENT,
  title: 'Performance Verification',
  produces: [ARTIFACT_TYPES.PERFORMANCE_VERDICT],
  independentOf: [...IMPLEMENTERS],
  outputSchema: PerformanceOutputSchema,
  outputJsonSchema: jsonSchemaFor(PerformanceOutputSchema),
  requires: [ARTIFACT_TYPES.NFR],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const nfrs = repository(ctx.store, ARTIFACT_TYPES.NFR, NfrSchema).list();
    return {
      canon: [
        contextFrom('nfrs', 'NFR', nfrs, (n) => n.statement + ' — target: ' + n.target, 1),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'implementation detail and the engineers’ expectations',
          reason: 'a measurement is compared against the declared target, not against a hope',
        },
      ],
    };
  },

  task(): string {
    return [
      'Compare the measured behaviour against the declared performance targets.',
      '',
      'A target you did not measure has `measured` absent. Do not put a plausible number',
      'there: an invented measurement is the single most damaging thing this department',
      'can produce, because it looks exactly like a real one.',
      '',
      'If nothing could be measured, the verdict is NOT_VERIFIED. That is correct and it',
      'blocks, which is the point.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Measure against the declared NFR targets. Do not change the targets and do not optimise anything.';
  },

  persist(tx: ScopedCanonWriter, output, ctx): PersistResult {
    const at = ctx.clock.now();
    const runId = requireRun(ctx, PERFORMANCE_AGENT);
    const id = ctx.ids.next('SC-PERFV');

    /*
     * A target with no measurement cannot be MET, whatever the run said. Serva decides
     * this rather than trusting the flag, because "met: true" alongside an absent number
     * is exactly the shape a hopeful summary takes.
     */
    const measurements = output.measurements.map((m) => ({
      nfrRef: { id: m.nfrId },
      target: m.target,
      ...(m.measured === undefined ? {} : { measured: m.measured }),
      ...(m.measured === undefined ? {} : { met: m.met ?? false }),
      method: m.method,
    }));
    const unmeasured = measurements.filter((m) => m.measured === undefined);

    repository(ctx.store, ARTIFACT_TYPES.PERFORMANCE_VERDICT, PerformanceVerdictSchema).put(tx, {
      id,
      createdAt: at,
      /*
       * Any unmeasured target makes the whole verdict NOT_VERIFIED at best.
       *
       * The `=== PASS` form let PASS_WITH_QUALIFICATION through with nothing measured at all,
       * and the Release department reads exactly this field to choose RECOMMEND or HOLD.
       * `supportedVerdict` covers both, so the two conditions cannot drift apart again.
       */
      verdict: supportedVerdict(
        unmeasured.length > 0 && output.verdict === VerificationVerdict.PASS
          ? VerificationVerdict.NOT_VERIFIED
          : output.verdict,
        {
          exercised: measurements.filter((m) => m.measured !== undefined).length,
          notVerified: unmeasured.length,
        },
      ),
      subjectRef: subjectRef(ctx),
      subjects: [...currentSubjects(ctx.store, [ARTIFACT_TYPES.NFR])],
      summary: output.summary,
      notVerified: [
        ...output.notVerified,
        ...unmeasured.map((m) => ({
          area: m.nfrRef.id,
          why: 'the target was not measured, so nothing about it is established',
        })),
      ],
      measurements,
      verifiedByRunId: runId,
      verifiedByAgentId: PERFORMANCE_AGENT,
      verifiedAt: at,
      meta: derived(
        ctx,
        PERFORMANCE_AGENT,
        output.measurements.map((m) => m.nfrId),
        'performance verification against declared targets',
        runId,
      ),
    });

    return {
      artifactIds: [id],
      notes: [
        'performance: ' +
          String(measurements.length - unmeasured.length) +
          ' of ' +
          String(measurements.length) +
          ' target(s) measured',
      ],
      judgements: [
        {
          criterionRef: 'PF-1',
          met: unmeasured.length === 0 && output.verdict === VerificationVerdict.PASS,
          by: PERFORMANCE_AGENT,
          note: output.summary,
          subjects: [...currentSubjects(ctx.store, [ARTIFACT_TYPES.NFR])],
        },
      ],
    };
  },
};

/* ==================================================== 045 — ACCEPTANCE VERIFICATION */

export const AcceptanceOutputSchema = z
  .object({
    verdict: verdictEnum,
    summary: z.string().min(1),
    notVerified: notVerifiedSchema,
    qualifications: z.array(z.string().min(1)).default([]),
    criteria: z
      .array(
        z
          .object({
            criterionId: z.string().min(1),
            met: z.boolean(),
            evidence: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const acceptanceVerificationDepartment: DepartmentConfig<typeof AcceptanceOutputSchema> = {
  id: 'DEPT-ACCEPTANCE-VERIFICATION',
  stageId: 'SC-STAGE-045',
  agentId: ACCEPTANCE_AGENT,
  title: 'Acceptance Verification',
  produces: [ARTIFACT_TYPES.ACCEPTANCE_VERDICT],
  /** Not the requirements author, and not anybody who built it. */
  independentOf: ['SC-AGENT-050', 'SC-AGENT-051', ...IMPLEMENTERS],
  outputSchema: AcceptanceOutputSchema,
  outputJsonSchema: jsonSchemaFor(AcceptanceOutputSchema),
  requires: [ARTIFACT_TYPES.ACCEPTANCE_CRITERION],

  buildContext(ctx: DepartmentContext): DepartmentContextSpec {
    const criteria = repository(
      ctx.store,
      ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
      AcceptanceCriterionSchema,
    ).list();
    return {
      canon: [
        contextFrom('criteria', 'ACCEPTANCE_CRITERION', criteria, (c) => c.criterion, 1),
      ].filter((c): c is NonNullable<typeof c> => c !== undefined),
      excluded: [
        {
          subject: 'QA’s own verdict and the implementers’ account',
          reason:
            'acceptance asks whether what was asked for is there, which is a different question from whether the tests pass',
        },
      ],
    };
  },

  task(): string {
    return [
      'Decide, criterion by criterion, whether what was asked for is actually there.',
      '',
      'This is not a second QA pass. QA asks whether the change behaves correctly;',
      'acceptance asks whether the correct thing was built. A product can pass every test',
      'it has and still not be what the owner described.',
      '',
      'PASS_WITH_QUALIFICATION is a real answer when something is delivered but narrower',
      'than agreed. Say what the qualification is — an unqualified PASS that quietly means',
      '"mostly" is how a gap reaches a customer.',
    ].join('\n');
  },

  scopeBoundary(): string {
    return 'Judge delivery against the acceptance criteria. Do not re-specify, and do not accept on the owner’s behalf.';
  },

  persist(tx: ScopedCanonWriter, output, ctx): PersistResult {
    const at = ctx.clock.now();
    const runId = requireRun(ctx, ACCEPTANCE_AGENT);
    const id = ctx.ids.next('SC-ACCV');
    const criteria = repository(
      ctx.store,
      ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
      AcceptanceCriterionSchema,
    ).list();
    const known = new Set(criteria.map((c) => c.id));

    /* A judgement about a criterion that does not exist judges nothing. */
    const judged = output.criteria.filter((c) => known.has(c.criterionId));
    const unjudged = criteria.filter((c) => !judged.some((j) => j.criterionId === c.id));

    repository(ctx.store, ARTIFACT_TYPES.ACCEPTANCE_VERDICT, AcceptanceVerdictSchema).put(tx, {
      id,
      createdAt: at,
      /*
       * An unjudged criterion is an unanswered question, so a PASS covering only some of
       * them becomes NOT_VERIFIED. Serva computes this; a verdict that says PASS while
       * half the criteria were never looked at is the failure acceptance exists to catch.
       */
      verdict: supportedVerdict(
        unjudged.length > 0 && output.verdict === VerificationVerdict.PASS
          ? VerificationVerdict.NOT_VERIFIED
          : output.verdict,
        { exercised: judged.length, notVerified: unjudged.length },
      ),
      subjectRef: subjectRef(ctx),
      subjects: [...currentSubjects(ctx.store, [ARTIFACT_TYPES.ACCEPTANCE_CRITERION])],
      summary: output.summary,
      notVerified: [
        ...output.notVerified,
        ...unjudged.map((c) => ({ area: c.id, why: 'this criterion was not judged' })),
      ],
      criteria: judged.map((c) => ({
        criterionRef: { id: c.criterionId },
        met: c.met,
        evidence: c.evidence,
      })),
      qualifications: output.qualifications,
      verifiedByRunId: runId,
      verifiedByAgentId: ACCEPTANCE_AGENT,
      verifiedAt: at,
      meta: derived(
        ctx,
        ACCEPTANCE_AGENT,
        judged.map((c) => c.criterionId),
        'acceptance verification against the agreed criteria',
        runId,
      ),
    });

    return {
      artifactIds: [id],
      notes: [
        'acceptance: ' +
          String(judged.filter((c) => c.met).length) +
          ' of ' +
          String(criteria.length) +
          ' criteria met',
        ...output.qualifications.map((q) => 'qualification: ' + q),
      ],
      judgements: [
        {
          criterionRef: 'AC-1',
          met: unjudged.length === 0 && judged.every((c) => c.met),
          by: ACCEPTANCE_AGENT,
          note: output.summary,
          subjects: [...currentSubjects(ctx.store, [ARTIFACT_TYPES.ACCEPTANCE_CRITERION])],
        },
      ],
    };
  },
};

export const QUALITY_DEPARTMENTS: readonly DepartmentConfig[] = Object.freeze([
  qaVerificationDepartment as DepartmentConfig,
  accessibilityVerificationDepartment as DepartmentConfig,
  securityVerificationDepartment as DepartmentConfig,
  performanceVerificationDepartment as DepartmentConfig,
  acceptanceVerificationDepartment as DepartmentConfig,
]);
