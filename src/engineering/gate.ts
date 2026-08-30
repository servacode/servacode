import {
  CriterionBasis,
  CriterionResult,
  EvidenceClass,
  IndeterminateReason,
  OnMissingEvidence,
  Severity,
} from '../vocab/index.js';
import { evaluateGate } from '../gates/engine.js';
import type {
  Criterion,
  CriterionEvaluation,
  EvidenceRequirement,
  GateResult,
  QualityGate,
} from '../gates/types.js';
import type { GateEngineDeps } from '../gates/engine.js';
import type { Transaction } from '../store/store.js';
import type { EngineeringEvidence } from './execution.js';
import { deriveEvidenceValidity } from './execution.js';
import { RuntimeComponent, type RequiredChecks } from './executors.js';
import { ValidityState } from '../vocab/index.js';
import type { ChangeSet } from './changeset.js';

/**
 * The Engineering Gate. SPEC: Phase 4 §20, 18, 31 §4.1.
 *
 * **No bespoke second verdict system.** This module builds a `QualityGate` and a set of
 * `CriterionEvaluation`s from real evidence, then hands them to the Phase 2 gate
 * engine, which already owns composition, severity binding, waiver validation and the
 * disposition table. Inventing a parallel verdict path here would create exactly the
 * divergence `31` exists to prevent.
 *
 * What this file actually decides is narrower and more interesting: **how a piece of
 * evidence becomes a criterion result.** Three rules do all the work:
 *
 *   - evidence PASS for this ChangeSet    -> MET
 *   - evidence FAIL for this ChangeSet    -> NOT_MET
 *   - evidence absent, stale, or          -> INDETERMINATE with a reason
 *     INDETERMINATE
 *
 * The third is the one that matters. **NO EVIDENCE = NOT VERIFIED**, never PASS and
 * never FAIL: absence of evidence is not proof of a defect any more than it is proof
 * of correctness (SC-POL-005, 31 §4.1.1).
 */

export const ENGINEERING_GATE_ID = 'SC-GATE-CODE_REVIEW';

export interface EngineeringCriterionSpec {
  readonly id: string;
  readonly statement: string;
  readonly severity: Severity;
  readonly component?: RuntimeComponent;
  /** Set for criteria satisfied by an agent's judgement rather than a measurement. */
  readonly judged?: boolean;
}

/**
 * The criteria an engineering change is judged against.
 *
 * Severities are deliberate, not decorative. Scope, tests and secrets are BLOCKING
 * because a change that escapes its boundary, breaks the suite, or commits a
 * credential is not a change anyone should be able to waive past. Lint is MAJOR: it
 * matters and it is not a safety property.
 */
export function engineeringCriteria(required: RequiredChecks): EngineeringCriterionSpec[] {
  const out: EngineeringCriterionSpec[] = [];
  if (required.scope) {
    out.push({
      id: 'EC-SCOPE',
      statement: 'The change stays inside the declared scope (SC-POL-009).',
      severity: Severity.BLOCKING,
      component: RuntimeComponent.SCOPE,
    });
  }
  if (required.build) {
    out.push({
      id: 'EC-BUILD',
      statement: 'The workspace builds.',
      severity: Severity.BLOCKING,
      component: RuntimeComponent.BUILD,
    });
  }
  if (required.tests) {
    out.push({
      id: 'EC-TESTS',
      statement: 'The declared test suite passes against this ChangeSet.',
      severity: Severity.BLOCKING,
      component: RuntimeComponent.TEST,
    });
  }
  if (required.lint) {
    out.push({
      id: 'EC-LINT',
      statement: 'The change conforms to the project standards.',
      severity: Severity.MAJOR,
      component: RuntimeComponent.LINT,
    });
  }
  if (required.secrets) {
    out.push({
      id: 'EC-SECRETS',
      statement: 'The change introduces no committed credential.',
      severity: Severity.BLOCKING,
      component: RuntimeComponent.SECRETS,
    });
  }
  if (required.codeReview) {
    out.push({
      id: 'EC-REVIEW',
      statement: 'An independent reviewer accepts the change.',
      severity: Severity.BLOCKING,
      judged: true,
    });
  }
  if (required.qaVerification) {
    out.push({
      id: 'EC-QA',
      statement: 'QA verification confirms the change satisfies its acceptance criteria.',
      severity: Severity.BLOCKING,
      judged: true,
    });
  }
  return out;
}

export function buildEngineeringGate(required: RequiredChecks): QualityGate {
  const criteria: Criterion[] = engineeringCriteria(required).map((spec) => ({
    id: spec.id,
    statement: spec.statement,
    evaluation:
      spec.judged === true
        ? { kind: 'VERIFIER_RESULT' as const, role: 'CODE_REVIEW', criteria: [spec.id] }
        : { kind: 'EVIDENCE_CHECK' as const, requirement: evidenceRequirement() },
    independence: spec.judged === true,
    severity: spec.severity,
    /*
     * testsExistence is FALSE throughout, and that is the point.
     *
     * CR-EX1 permits treating absent evidence as a proven negative only for a
     * criterion that IS an existence test. "The tests pass" is not one: a missing test
     * result means nobody looked, which is INDETERMINATE, not failure.
     */
    testsExistence: false,
    onMissingEvidence: OnMissingEvidence.INDETERMINATE,
    policyRefs: ['SC-POL-005', 'SC-POL-023'],
    applicability: 'ALWAYS' as const,
  }));

  return {
    id: ENGINEERING_GATE_ID,
    name: 'Engineering Gate',
    version: '1.0.0',
    blocking: true,
    criteria,
    invalidationSet: ['ChangeSet'],
    waivable: true,
  };
}

/**
 * What a measured criterion requires of its evidence.
 *
 * `validity: VALID` is the binding that makes staleness bite: evidence measured
 * against a different ChangeSet derives to STALE, which is not VALID, so it cannot
 * satisfy the requirement however green it was (31 TX-4).
 */
function evidenceRequirement(): EvidenceRequirement {
  return {
    requiredClass: EvidenceClass.EXECUTION,
    requiredCount: 1,
    independence: false,
    validity: ValidityState.VALID,
    onMissingEvidence: OnMissingEvidence.INDETERMINATE,
  };
}

export interface JudgedInput {
  readonly criterionId: string;
  readonly outcome: 'PASS' | 'FAIL' | 'NOT_VERIFIED';
  readonly detail: string;
  readonly runRef: string;
  readonly reviewerRole: string;
}

export interface EngineeringEvaluationInput {
  readonly changeSet: ChangeSet;
  readonly evidence: readonly EngineeringEvidence[];
  readonly judged: readonly JudgedInput[];
  readonly required: RequiredChecks;
}

/**
 * Turn evidence into criterion evaluations.
 *
 * Every criterion resolves to exactly one evaluation, because the Phase 2 gate engine
 * refuses an incomplete set — the check that stops a non-empty gate reaching PASS by
 * omitting the criteria that would have blocked it.
 */
export function buildCriterionEvaluations(
  deps: Pick<GateEngineDeps, 'ids' | 'clock'>,
  input: EngineeringEvaluationInput,
): CriterionEvaluation[] {
  const specs = engineeringCriteria(input.required);
  const out: CriterionEvaluation[] = [];

  for (const spec of specs) {
    const at = deps.clock.now();
    const id = deps.ids.next('SC-CE');

    if (spec.judged === true) {
      /*
       * A DISSENT IS NOT OVERRULED BY BEING SECOND.
       *
       * SPEC: finding ENGINEERING-ACCEPTANCE-AUTHORITY/EAA-2 (MEDIUM), 1.0.1 security review.
       *
       * This was `.find(...)` — the first match wins. `judgedForChangeSet` returns EVERY
       * persisted review for a ChangeSet, so for reviews ordered [PASS, FAIL] on the same
       * criterion the FAIL was simply dropped: the criterion evaluated MET, and `acceptChange`
       * checks only that a review exists and was not written by the Producer, never its
       * outcome. An independent reviewer's rejection was therefore not authoritative over an
       * earlier acceptance, which inverts what independent review is for.
       *
       * The failing judgement wins when there is one. Two reviewers disagreeing is not a tie
       * to be broken by array order — it is a reason not to accept the change.
       */
      const judgements = input.judged.filter((x) => x.criterionId === spec.id);
      const j =
        judgements.find((x) => x.outcome === 'FAIL') ??
        judgements.find((x) => x.outcome === 'NOT_VERIFIED') ??
        judgements[0];
      if (j === undefined) {
        out.push({
          id,
          criterionRef: spec.id,
          value: CriterionResult.INDETERMINATE,
          basis: CriterionBasis.JUDGED,
          reason: IndeterminateReason.EVIDENCE_ABSENT,
          severity: spec.severity,
          evidenceRefs: [],
          qualifications: [],
          artifactVersionsEvaluated: [],
          evaluatedAt: at,
          judgedBy: {
            role: 'CODE_REVIEW',
            criteriaApplied: [spec.id],
            confidence: 'LOW',
          },
        });
        continue;
      }
      out.push({
        id,
        criterionRef: spec.id,
        value:
          j.outcome === 'PASS'
            ? CriterionResult.MET
            : j.outcome === 'FAIL'
              ? CriterionResult.NOT_MET
              : CriterionResult.INDETERMINATE,
        basis: CriterionBasis.JUDGED,
        ...(j.outcome === 'NOT_VERIFIED' ? { reason: IndeterminateReason.EVIDENCE_ABSENT } : {}),
        severity: spec.severity,
        evidenceRefs: [j.runRef],
        qualifications: [],
        artifactVersionsEvaluated: [],
        evaluatedAt: at,
        judgedBy: {
          role: j.reviewerRole,
          criteriaApplied: [spec.id],
          confidence: 'MEDIUM',
        },
      });
      continue;
    }

    // Only evidence bound to THIS ChangeSet counts. Everything else is stale, however
    // recently it was measured and however green it was.
    const relevant = input.evidence.filter(
      (e) =>
        e.runtimeComponentId === spec.component &&
        deriveEvidenceValidity(e, input.changeSet.changeSetId) === ValidityState.VALID,
    );
    const latest = relevant[relevant.length - 1];

    if (latest === undefined) {
      const staleExists = input.evidence.some((e) => e.runtimeComponentId === spec.component);
      out.push({
        id,
        criterionRef: spec.id,
        value: CriterionResult.INDETERMINATE,
        basis: CriterionBasis.MEASURED,
        // NO EVIDENCE = NOT VERIFIED. Not FAIL: nobody looked at this ChangeSet.
        reason: IndeterminateReason.EVIDENCE_ABSENT,
        severity: spec.severity,
        evidenceRefs: [],
        qualifications: [],
        artifactVersionsEvaluated: [],
        evaluatedAt: at,
      });
      void staleExists;
      continue;
    }

    out.push({
      id,
      criterionRef: spec.id,
      value:
        latest.outcome === 'PASS'
          ? CriterionResult.MET
          : latest.outcome === 'FAIL'
            ? CriterionResult.NOT_MET
            : CriterionResult.INDETERMINATE,
      basis: latest.basis === 'MEASURED' ? CriterionBasis.MEASURED : CriterionBasis.DERIVED,
      ...(latest.outcome === 'INDETERMINATE'
        ? {
            // The command could not run, so the criterion could not be checked.
            reason: IndeterminateReason.TOOL_UNAVAILABLE,
          }
        : {}),
      severity: spec.severity,
      evidenceRefs: [latest.id],
      qualifications: [],
      artifactVersionsEvaluated: [],
      evaluatedAt: at,
    });
  }

  return out;
}

/**
 * Evaluate the Engineering Gate through the Phase 2 engine.
 *
 * The engine owns the verdict; this function only supplies its inputs. Severity is
 * re-stamped from the gate definition there, waivers are validated there, and the
 * disposition table lives there — so an engineering change is judged by exactly the
 * same rules as everything else in the system.
 */
export function evaluateEngineeringGate(
  tx: Transaction,
  deps: GateEngineDeps,
  input: EngineeringEvaluationInput,
): GateResult {
  const gate = buildEngineeringGate(input.required);
  const evaluations = buildCriterionEvaluations(deps, input);
  return evaluateGate(tx, deps, {
    gate,
    scope: input.changeSet.changeSetId,
    evaluations,
  });
}
