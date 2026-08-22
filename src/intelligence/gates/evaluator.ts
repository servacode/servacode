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
import { questionKindRefusal } from '../departments/intake.js';
import { gateById } from './definitions.js';
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
    { readonly met: boolean; readonly by: string; readonly note: string }
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
      },
    );
  };

  const store = deps.store;

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

        /* Freshness, computed rather than trusted: an expired finding is not current. */
        const verdicts = assessFreshness(
          [
            ...findings.map((f) => ({ id: f.id, validUntil: f.freshness.validUntil })),
            ...positions.map((p) => ({
              id: p.id,
              validUntil: p.freshness.validUntil,
              dependsOn: p.differentiatorRefs.map((r) => r.id),
            })),
          ],
          deps.clock,
        );
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
