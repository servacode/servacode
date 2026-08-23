import {
  CriterionBasis,
  CriterionResult,
  GateVerdict,
  IndeterminateReason,
  Severity,
} from '../../vocab/index.js';
import { evaluateGate } from '../../gates/engine.js';
import { ARTIFACT_TYPES, repository } from '../repository.js';
import { ClientInputSchema, ProjectGoalSchema, OpenQuestionSchema } from '../artifacts/framing.js';
import {
  CurrentAlternativeSchema,
  DiscoveryFindingsSchema,
  UserSegmentSchema,
} from '../artifacts/discovery.js';
import {
  FeatureSchema,
  ProductScopeSchema,
  ValidationRecommendationSchema,
  featureTraceRefusal,
} from '../artifacts/product.js';
import {
  AcceptanceCriterionSchema,
  NfrSchema,
  RequirementSchema,
  mustHasAcceptanceRefusal,
  nfrMeasurabilityRefusal,
} from '../artifacts/requirements.js';
import { CompetitivePositionSchema, ResearchFindingSchema } from '../artifacts/market.js';
import { assessFreshness, staleSubjects } from '../research/freshness.js';
import { marketFreshnessSubjects } from '../research/subjects.js';
import {
  ArchitectureModelSchema,
  AdrSchema,
  ComplexityJustificationSchema,
  TechnologyEvaluationSchema,
  evaluationRefusal,
} from '../artifacts/architecture.js';
import {
  AuthorizationModelSchema,
  PrivacyDesignSchema,
  ResidualRiskSchema,
  ThreatModelSchema,
} from '../artifacts/security.js';
import { CostAssessmentSchema, CostModelSchema, costRefusal } from '../artifacts/operations.js';
import { RiskSchema } from '../artifacts/governance.js';
import { BusinessRuleSchema } from '../artifacts/business.js';
import { FlowSchema, StateCoverageSchema } from '../artifacts/ux.js';
import {
  ComponentSpecSchema,
  DesignExceptionSchema,
  DesignTokenSetSchema,
} from '../artifacts/design.js';
import {
  AdminAuditRequirementSchema,
  AdminOperabilityReviewSchema,
  ConfigurationRegisterSchema,
  OperationalControlSchema,
  ProtectedRuleSchema,
} from '../artifacts/admin.js';
import { TestCaseSchema, TestStrategySchema } from '../artifacts/testing.js';
import { checkDesign } from '../checks/design.js';
import { checkConfiguration } from '../checks/configuration.js';
import { checkTraceability } from '../checks/traceability.js';
import { questionKindRefusal } from '../departments/intake.js';
import { gateById } from './definitions.js';
import { downstreamGateById, downstreamStoreAnswer } from './downstream.js';
import type { CriterionEvaluation } from '../../gates/types.js';
import type { GateEngineDeps } from '../../gates/engine.js';
import type { GateEvaluator } from '../execution/orchestrator.js';
import type { Store } from '../../store/store.js';
import type { Clock } from '../../core/clock.js';
import type { IdSource } from '../../core/ids.js';

/**
 * THE UPSTREAM GATE EVALUATOR.
 *
 * SPEC: §31, 18.
 *
 * Evidence first, verdict second — and the verdict is composed by the Phase 2 engine, not
 * decided here. This module's only job is to turn persisted canon into
 * `CriterionEvaluation` records honestly, including the ones that say "we do not know".
 *
 * The temptation this design removes: a gate that reads the artifacts and forms an
 * opinion. That opinion would be indistinguishable from a PASS, and there would be no
 * record of which specific check produced it. Here every criterion has a value, a basis,
 * and — where it is INDETERMINATE — a reason naming what was missing.
 *
 * `MEASURED` is used only where Serva genuinely computed the answer. A criterion whose
 * evidence is an agent's judgement is marked `JUDGED` with the actor recorded, because
 * conflating the two is how "an agent said it was fine" becomes "it was verified".
 */

export interface UpstreamGateDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly evaluator: string;
  /**
   * Judgements produced by departments this cycle, keyed by criterion.
   *
   * Supplied rather than re-derived because a judgement belongs to the run that made it.
   * Absent means absent: the criterion becomes INDETERMINATE and the gate NOT_VERIFIED,
   * which is the correct outcome for "nobody has looked at this yet".
   */
  readonly judgements?: ReadonlyMap<
    string,
    {
      readonly met: boolean;
      readonly by: string;
      readonly note: string;
      /** The exact artifact versions judged, so readiness can tell whether they still are. */
      readonly subjects?: readonly { readonly id: string; readonly version: number }[];
    }
  >;
}

const met = (
  id: string,
  criterionRef: string,
  value: CriterionResult,
  basis: CriterionBasis,
  severity: Severity,
  at: string,
  extra: Partial<CriterionEvaluation> = {},
): CriterionEvaluation => ({
  id,
  criterionRef,
  value,
  basis,
  severity,
  evidenceRefs: [],
  qualifications: [],
  artifactVersionsEvaluated: [],
  evaluatedAt: at,
  ...extra,
});

/**
 * Build the evaluations for one gate from what the Store actually holds.
 *
 * Exported so tests can assert on the evidence rather than only on the verdict — a gate
 * that returns the right answer for the wrong reason is a gate that will return the wrong
 * answer next quarter.
 */
export function evaluationsFor(
  deps: UpstreamGateDeps,
  gateId: string,
): readonly CriterionEvaluation[] {
  const at = deps.clock.now();
  const out: CriterionEvaluation[] = [];
  const next = (): string => deps.ids.next('SC-CE');
  const gate = gateById(gateId);
  if (gate === undefined) return out;

  const sev = (cid: string): Severity =>
    gate.criteria.find((c) => c.id === cid)?.severity ?? Severity.BLOCKING;

  /** A criterion nobody could evaluate. NOT_VERIFIED, never PASS. */
  const indeterminate = (cid: string, reason: IndeterminateReason): CriterionEvaluation =>
    met(next(), cid, CriterionResult.INDETERMINATE, CriterionBasis.MEASURED, sev(cid), at, {
      reason,
    });

  const measured = (cid: string, ok: boolean): CriterionEvaluation =>
    met(
      next(),
      cid,
      ok ? CriterionResult.MET : CriterionResult.NOT_MET,
      CriterionBasis.MEASURED,
      sev(cid),
      at,
    );

  const judged = (cid: string): CriterionEvaluation => {
    const j = deps.judgements?.get(cid);
    if (j === undefined) return indeterminate(cid, IndeterminateReason.EVIDENCE_ABSENT);
    return met(
      next(),
      cid,
      j.met ? CriterionResult.MET : CriterionResult.NOT_MET,
      CriterionBasis.JUDGED,
      sev(cid),
      at,
      {
        /*
         * The ACTOR is recorded, not merely that a judgement happened. A criterion whose
         * evidence is "somebody decided" cannot later be checked for independence.
         */
        judgedBy: { role: j.by, criteriaApplied: [j.note], confidence: 'MEDIUM' },
        /*
         * And WHAT was judged, at which version.
         *
         * This is what readiness reads. Without it a review is a permanent fact about a
         * project rather than a statement about a version of it, and rewriting the
         * architecture would leave last month's acceptance still standing.
         *
         * The digest is empty because these are Store-resident artifacts identified by
         * (type, id, version) rather than content-addressed blobs; the version is the
         * currency check, and the Store is authoritative for the content at it.
         */
        artifactVersionsEvaluated: (j.subjects ?? []).map((sub) => ({
          artifactId: sub.id,
          version: sub.version,
          digest: '',
        })),
      },
    );
  };

  const store = deps.store;

  /*
   * DOWNSTREAM GATES ARE EVALUATED GENERICALLY.
   *
   * The eleven upstream gates each ask something specific enough to need its own query, and
   * the switch below is that. The downstream seven are uniform by construction: a criterion
   * is either a verdict somebody INDEPENDENT reached, which `judged` already resolves from
   * the run that reached it, or a fact about the Store, which `downstreamStoreAnswer`
   * computes.
   *
   * Writing seven more hand-rolled cases would have produced seven more places to forget
   * that absent evidence is INDETERMINATE rather than NOT_MET — and `undefined` is carried
   * through the answer type precisely so that cannot be collapsed into a false.
   */
  if (downstreamGateById(gateId) !== undefined) {
    for (const c of gate.criteria) {
      if (c.evaluation.kind === 'VERIFIER_RESULT') {
        out.push(judged(c.id));
        continue;
      }
      const answer = downstreamStoreAnswer(store, c.id);
      out.push(
        answer === undefined
          ? indeterminate(c.id, IndeterminateReason.EVIDENCE_ABSENT)
          : measured(c.id, answer),
      );
    }
    return out;
  }

  switch (gateId) {
    case 'SC-GATE-INTAKE': {
      const input = repository(store, ARTIFACT_TYPES.CLIENT_INPUT, ClientInputSchema).list();
      const goals = repository(store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).list();
      const questions = repository(store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema).list();

      out.push(
        input.length === 0
          ? indeterminate('IN-1', IndeterminateReason.EVIDENCE_ABSENT)
          : measured(
              'IN-1',
              input.every(
                (i) => i.problem !== '' && i.audience !== '' && i.successDefinition !== '',
              ),
            ),
      );
      out.push(
        goals.length === 0
          ? indeterminate('IN-2', IndeterminateReason.EVIDENCE_ABSENT)
          : measured(
              'IN-2',
              goals.every((g) => g.successIndicator.trim() !== ''),
            ),
      );
      out.push(
        measured(
          'IN-3',
          questions.every((q) => questionKindRefusal(q.question) === undefined),
        ),
      );
      break;
    }

    case 'SC-GATE-DISCOVERY': {
      const segments = repository(store, ARTIFACT_TYPES.USER_SEGMENT, UserSegmentSchema).list();
      const alts = repository(
        store,
        ARTIFACT_TYPES.CURRENT_ALTERNATIVE,
        CurrentAlternativeSchema,
      ).list();
      const findings = repository(
        store,
        ARTIFACT_TYPES.DISCOVERY_FINDINGS,
        DiscoveryFindingsSchema,
      ).list();

      out.push(measured('DI-1', segments.length > 0));

      /*
       * The mandatory rule, measured per segment rather than in aggregate. "There are
       * alternatives" is true of a discovery where one segment has four and three have
       * none — which is exactly the discovery that has not been done.
       */
      if (segments.length === 0) {
        out.push(indeterminate('DI-2', IndeterminateReason.PRECONDITION_ABSENT));
      } else {
        const covered = segments.every((s) => alts.some((a) => a.segmentRef.id === s.id));
        out.push(measured('DI-2', covered));
      }

      if (findings.length === 0) {
        out.push(indeterminate('DI-3', IndeterminateReason.EVIDENCE_ABSENT));
      } else {
        /*
         * The claim under test is not "research happened" — it is "nothing claims research
         * that did not happen". A discovery with zero interviews is acceptable provided it
         * says so, which is why this reads the counts rather than requiring them.
         */
        const honest = findings.every((f) => {
          const r = f.researchPerformed;
          const none = r.interviews === 0 && r.surveys === 0 && r.usabilityTests === 0;
          return !none || f.limitations.length > 0 || r.deskResearch;
        });
        out.push(measured('DI-3', honest));
      }

      out.push(judged('DI-4'));
      break;
    }

    case 'SC-GATE-PRODUCT_VALIDATION': {
      const recs = repository(
        store,
        ARTIFACT_TYPES.VALIDATION_RECOMMENDATION,
        ValidationRecommendationSchema,
      ).list();
      const features = repository(store, ARTIFACT_TYPES.FEATURE, FeatureSchema).list();
      const scope = repository(store, ARTIFACT_TYPES.PRODUCT_SCOPE, ProductScopeSchema).list();

      out.push(
        recs.length === 0
          ? indeterminate('PV-1', IndeterminateReason.EVIDENCE_ABSENT)
          : measured(
              'PV-1',
              recs.every((r) => r.rationale.trim() !== ''),
            ),
      );
      out.push(
        measured(
          'PV-2',
          features.every((f) => featureTraceRefusal(f) === undefined),
        ),
      );
      out.push(
        scope.length === 0
          ? indeterminate('PV-3', IndeterminateReason.EVIDENCE_ABSENT)
          : measured(
              'PV-3',
              scope.every((s) => s.outOfScope.length > 0 || s.nonGoals.length > 0),
            ),
      );
      break;
    }

    case 'SC-GATE-REQUIREMENTS': {
      const reqs = repository(store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
      const acs = repository(
        store,
        ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
        AcceptanceCriterionSchema,
      ).list();
      const nfrs = repository(store, ARTIFACT_TYPES.NFR, NfrSchema).list();
      const goals = repository(store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).list();

      if (reqs.length === 0) {
        out.push(indeterminate('RQ-1', IndeterminateReason.EVIDENCE_ABSENT));
        out.push(indeterminate('RQ-3', IndeterminateReason.EVIDENCE_ABSENT));
        out.push(indeterminate('RQ-5', IndeterminateReason.EVIDENCE_ABSENT));
      } else {
        out.push(
          measured(
            'RQ-1',
            reqs.every((r) => mustHasAcceptanceRefusal(r, acs) === undefined),
          ),
        );
        out.push(
          measured(
            'RQ-3',
            reqs.every((r) => r.tracesTo.length > 0 || r.featureRef !== undefined),
          ),
        );

        /*
         * Coverage is TRANSITIVE. A requirement traces to the feature it serves, and the
         * feature traces to the goal; demanding a direct requirement→goal edge would
         * report every properly-structured project as uncovered.
         */
        const feats = repository(store, ARTIFACT_TYPES.FEATURE, FeatureSchema).list();
        const covered = new Set<string>();
        for (const r of reqs) {
          const viaTraces = r.tracesTo.map((t) => t.id);
          const viaFeature = r.featureRef === undefined ? [] : [r.featureRef.id];
          for (const id of [...viaTraces, ...viaFeature]) {
            covered.add(id);
            const feature = feats.find((f) => f.id === id);
            for (const g of feature?.goalRefs ?? []) covered.add(g.id);
          }
        }
        out.push(
          measured(
            'RQ-5',
            goals.every((g) => covered.has(g.id)),
          ),
        );
      }

      out.push(
        nfrs.length === 0
          ? indeterminate('RQ-2', IndeterminateReason.EVIDENCE_ABSENT)
          : measured(
              'RQ-2',
              nfrs.every((n) => nfrMeasurabilityRefusal(n) === undefined),
            ),
      );

      /* The independent verifier's judgement. Absent means NOT_VERIFIED. */
      out.push(judged('RQ-4'));
      break;
    }

    case 'SC-GATE-COMPETITIVE': {
      const findings = repository(
        store,
        ARTIFACT_TYPES.RESEARCH_FINDING,
        ResearchFindingSchema,
      ).list();
      const positions = repository(
        store,
        ARTIFACT_TYPES.COMPETITIVE_POSITION,
        CompetitivePositionSchema,
      ).list();

      /*
       * No research at all is INDETERMINATE, not NOT_MET.
       *
       * The distinction decides what an operator does next. NOT_MET says the company
       * looked and the market failed the test; INDETERMINATE says nobody looked. §31 is
       * explicit that research unavailable is NOT_VERIFIED — and inventing a plausible
       * landscape to avoid an awkward gate result is the exact failure this gate exists
       * to make impossible.
       */
      if (findings.length === 0) {
        out.push(indeterminate('CO-1', IndeterminateReason.EVIDENCE_ABSENT));
        out.push(indeterminate('CO-3', IndeterminateReason.EVIDENCE_ABSENT));
      } else {
        out.push(
          measured(
            'CO-1',
            findings.every((f) => f.sources.length > 0),
          ),
        );

        /* Freshness over the WHOLE market graph, so nothing reads as merely absent. */
        const verdicts = assessFreshness(marketFreshnessSubjects(store), deps.clock);
        out.push(measured('CO-3', staleSubjects(verdicts).length === 0));
      }

      /* The independent verifier's judgement. Absent means nobody checked. */
      out.push(judged('CO-2'));

      out.push(
        positions.length === 0
          ? indeterminate('CO-4', IndeterminateReason.EVIDENCE_ABSENT)
          : measured(
              'CO-4',
              positions.every(
                (p) => p.reasonToSwitch.trim() !== '' && p.reasonToStay.trim() !== '',
              ),
            ),
      );
      break;
    }

    case 'SC-GATE-FEASIBILITY': {
      const costs = repository(store, ARTIFACT_TYPES.COST_MODEL, CostModelSchema).list();
      const assessments = repository(
        store,
        ARTIFACT_TYPES.COST_ASSESSMENT,
        CostAssessmentSchema,
      ).list();
      const risks = repository(store, ARTIFACT_TYPES.RISK, RiskSchema).list();

      if (costs.length === 0) {
        out.push(indeterminate('FE-1', IndeterminateReason.EVIDENCE_ABSENT));
      } else {
        const figures = costs.flatMap((c) => [
          ...(c.buildCost === undefined ? [] : [c.buildCost]),
          ...c.runCost.map((r) => r.cost),
        ]);
        out.push(
          measured(
            'FE-1',
            figures.every((m) => costRefusal(m) === undefined),
          ),
        );
      }

      /* Over budget with no owner decision is a silent continuation, which is the failure. */
      const overspend = assessments.filter(
        (a) => a.verdict === 'EXCEEDS_BUDGET' && a.ownerDecisionRef === undefined,
      );
      out.push(measured('FE-2', overspend.length === 0));

      /*
       * UNKNOWN is expected and acceptable — what is not is an UNKNOWN quietly recorded as
       * LOW. This checks the register exists at all; the distinction itself is enforced by
       * the aggregator, which never downgrades.
       */
      out.push(
        risks.length === 0
          ? indeterminate('FE-3', IndeterminateReason.EVIDENCE_ABSENT)
          : measured('FE-3', true),
      );
      break;
    }

    case 'SC-GATE-ARCHITECTURE': {
      const arch = repository(
        store,
        ARTIFACT_TYPES.ARCHITECTURE_MODEL,
        ArchitectureModelSchema,
      ).list();
      const complexity = repository(
        store,
        ARTIFACT_TYPES.COMPLEXITY_JUSTIFICATION,
        ComplexityJustificationSchema,
      ).list();
      const reqs = repository(store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
      const nfrs = repository(store, ARTIFACT_TYPES.NFR, NfrSchema).list();

      out.push(judged('AR-1'));
      out.push(judged('AR-2'));
      out.push(judged('DA-1'));

      if (arch.length === 0) {
        out.push(indeterminate('AR-3', IndeterminateReason.PRECONDITION_ABSENT));
      } else {
        const known = new Set([...reqs.map((r) => r.id), ...nfrs.map((n) => n.id)]);
        out.push(
          measured(
            'AR-3',
            complexity.every((c) => known.has(c.forcingRequirementRef.id)),
          ),
        );
      }
      break;
    }

    case 'SC-GATE-SECURITY_DESIGN': {
      const threats = repository(store, ARTIFACT_TYPES.THREAT_MODEL, ThreatModelSchema).list();
      const authz = repository(
        store,
        ARTIFACT_TYPES.AUTHORIZATION_MODEL,
        AuthorizationModelSchema,
      ).list();
      const privacy = repository(store, ARTIFACT_TYPES.PRIVACY_DESIGN, PrivacyDesignSchema).list();
      const residual = repository(store, ARTIFACT_TYPES.RESIDUAL_RISK, ResidualRiskSchema).list();

      out.push(
        threats.length === 0
          ? indeterminate('SE-1', IndeterminateReason.EVIDENCE_ABSENT)
          : measured(
              'SE-1',
              threats.every((t) => t.boundaryRefs.length > 0 && t.threats.length > 0),
            ),
      );
      out.push(
        authz.length === 0
          ? indeterminate('SE-2', IndeterminateReason.EVIDENCE_ABSENT)
          : measured(
              'SE-2',
              authz.every((a) => a.defaultEffect === 'DENY' && a.entries.length > 0),
            ),
      );
      out.push(
        privacy.length === 0
          ? indeterminate('SE-3', IndeterminateReason.EVIDENCE_ABSENT)
          : measured(
              'SE-3',
              privacy.every((p) => p.dataInventory.length > 0),
            ),
      );
      /*
       * A residual risk PENDING_OWNER is not a failure — it is an honest open question, and
       * readiness blocks on it separately. What would fail is one marked ACCEPTED with no
       * owner decision behind it.
       */
      out.push(
        measured(
          'SE-4',
          residual.every(
            (r) => r.ownerDisposition !== 'ACCEPTED' || r.ownerDecisionRef !== undefined,
          ),
        ),
      );
      break;
    }

    case 'SC-GATE-TECHNOLOGY': {
      const evaluations = repository(
        store,
        ARTIFACT_TYPES.TECHNOLOGY_EVALUATION,
        TechnologyEvaluationSchema,
      ).list();
      const adrs = repository(store, ARTIFACT_TYPES.ADR, AdrSchema).list();

      if (evaluations.length === 0) {
        out.push(indeterminate('TE-1', IndeterminateReason.EVIDENCE_ABSENT));
        out.push(indeterminate('TE-2', IndeterminateReason.EVIDENCE_ABSENT));
      } else {
        out.push(
          measured(
            'TE-1',
            evaluations.every((e) => e.candidates.length >= 2),
          ),
        );
        out.push(
          measured(
            'TE-2',
            evaluations.every((e) => evaluationRefusal(e) === undefined),
          ),
        );
      }
      out.push(
        adrs.length === 0
          ? indeterminate('TE-3', IndeterminateReason.EVIDENCE_ABSENT)
          : measured(
              'TE-3',
              adrs.every(
                (a) => a.reevaluationTrigger.trim() !== '' && a.rejectedReasons.length > 0,
              ),
            ),
      );
      break;
    }

    case 'SC-GATE-DESIGN': {
      const features = repository(store, ARTIFACT_TYPES.FEATURE, FeatureSchema).list();
      const reviews = repository(
        store,
        ARTIFACT_TYPES.ADMIN_OPERABILITY_REVIEW,
        AdminOperabilityReviewSchema,
      ).list();
      const registers = repository(
        store,
        ARTIFACT_TYPES.CONFIGURATION_REGISTER,
        ConfigurationRegisterSchema,
      ).list();
      const protectedRules = repository(
        store,
        ARTIFACT_TYPES.PROTECTED_RULE,
        ProtectedRuleSchema,
      ).list();
      const audits = repository(
        store,
        ARTIFACT_TYPES.ADMIN_AUDIT_REQUIREMENT,
        AdminAuditRequirementSchema,
      ).list();
      const controls = repository(
        store,
        ARTIFACT_TYPES.OPERATIONAL_CONTROL,
        OperationalControlSchema,
      ).list();
      const tokens = repository(
        store,
        ARTIFACT_TYPES.DESIGN_TOKEN_SET,
        DesignTokenSetSchema,
      ).list();
      const components = repository(
        store,
        ARTIFACT_TYPES.COMPONENT_SPEC,
        ComponentSpecSchema,
      ).list();
      const coverage = repository(store, ARTIFACT_TYPES.STATE_COVERAGE, StateCoverageSchema).list();
      const exceptions = repository(
        store,
        ARTIFACT_TYPES.DESIGN_EXCEPTION,
        DesignExceptionSchema,
      ).list();

      out.push(judged('UX-1'));
      out.push(judged('UX-2'));
      out.push(judged('DS-1'));

      /* SC-RTC-017 and the token/state checks, mechanically. */
      const designFindings = checkDesign({
        ...(tokens[0] === undefined ? {} : { tokens: tokens[0] }),
        components,
        coverage,
        exceptions,
        clock: deps.clock,
      });
      out.push(
        measured(
          'DS-2',
          designFindings.every((f) => f.severity !== Severity.BLOCKING),
        ),
      );

      /* SC-RTC-008, over the ACTUAL persisted operability artifacts. */
      const configFindings = checkConfiguration({
        features,
        reviews,
        ...(registers[0] === undefined ? {} : { register: registers[0] }),
        protectedRules,
        auditRequirements: audits,
        controls,
      });
      out.push(
        features.length === 0
          ? indeterminate('AO-1', IndeterminateReason.PRECONDITION_ABSENT)
          : measured(
              'AO-1',
              features.every((f) => reviews.some((r) => r.featureRef.id === f.id)),
            ),
      );
      out.push(measured('AO-2', !configFindings.some((f) => f.code === 'PROTECTED_RULE_EXPOSED')));
      break;
    }

    case 'SC-GATE-PLAN': {
      const strategies = repository(store, ARTIFACT_TYPES.TEST_STRATEGY, TestStrategySchema).list();
      out.push(
        strategies.length === 0
          ? indeterminate('PL-1', IndeterminateReason.EVIDENCE_ABSENT)
          : measured(
              'PL-1',
              strategies.every((s) => s.coverage.length > 0),
            ),
      );

      const trace = checkTraceability({
        goals: repository(store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).list(),
        features: repository(store, ARTIFACT_TYPES.FEATURE, FeatureSchema).list(),
        requirements: repository(store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list(),
        acceptanceCriteria: repository(
          store,
          ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
          AcceptanceCriterionSchema,
        ).list(),
        nfrs: repository(store, ARTIFACT_TYPES.NFR, NfrSchema).list(),
        businessRules: repository(store, ARTIFACT_TYPES.BUSINESS_RULE, BusinessRuleSchema).list(),
        complexity: repository(
          store,
          ARTIFACT_TYPES.COMPLEXITY_JUSTIFICATION,
          ComplexityJustificationSchema,
        ).list(),
        operabilityReviews: repository(
          store,
          ARTIFACT_TYPES.ADMIN_OPERABILITY_REVIEW,
          AdminOperabilityReviewSchema,
        ).list(),
        flows: repository(store, ARTIFACT_TYPES.FLOW, FlowSchema).list(),
        testCases: repository(store, ARTIFACT_TYPES.TEST_CASE, TestCaseSchema).list(),
      });
      out.push(
        measured(
          'PL-2',
          trace.every((f) => f.severity !== Severity.BLOCKING),
        ),
      );
      break;
    }

    default:
      break;
  }

  return out;
}

/**
 * A `GateEvaluator` the orchestrator can call.
 *
 * Persists the GateResult through the Phase 2 engine, so upstream gates appear in the
 * same immutable stream as every other gate in Serva rather than in a Phase 5 side table.
 */
export function upstreamGateEvaluator(deps: UpstreamGateDeps): GateEvaluator {
  return {
    evaluate: async (o) => {
      /*
       * Judgements arrive per call rather than being fixed at construction: they belong
       * to the runs that just happened, and a gate evaluated tomorrow must not silently
       * reuse a verdict formed today.
       */
      const perCall: UpstreamGateDeps = {
        ...deps,
        ...(o.judgements === undefined ? {} : { judgements: o.judgements }),
      };
      const gate = gateById(o.gateId);
      if (gate === undefined) {
        /*
         * A stage whose gate Serva has not defined yet. Reported as NOT_VERIFIED rather
         * than waved through: an unimplemented gate is missing evidence, not a pass.
         */
        return {
          verdict: GateVerdict.NOT_VERIFIED,
          reasons: [o.gateId + ' is not defined in this build, so nothing was verified'],
        };
      }

      const evaluations = evaluationsFor(perCall, o.gateId);
      const engineDeps: GateEngineDeps = {
        ids: deps.ids,
        clock: deps.clock,
        evaluator: deps.evaluator,
      };

      const tx = deps.store.begin();
      let verdict: GateVerdict;
      try {
        const result = evaluateGate(tx, engineDeps, {
          gate,
          scope: o.workItemId,
          evaluations,
        });
        verdict = result.verdict;
        tx.commit();
      } catch (e) {
        tx.rollback();
        return {
          verdict: GateVerdict.NOT_VERIFIED,
          reasons: ['gate evaluation failed: ' + String(e instanceof Error ? e.message : e)],
        };
      }

      const reasons = evaluations
        .filter((e) => e.value !== CriterionResult.MET)
        .map(
          (e) =>
            e.criterionRef +
            ' ' +
            e.value +
            (e.reason === undefined ? '' : ' (' + e.reason + ')') +
            ': ' +
            (gate.criteria.find((c) => c.id === e.criterionRef)?.statement ?? ''),
        );
      return { verdict, reasons };
    },
  };
}
