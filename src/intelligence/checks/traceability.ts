import { Severity } from '../../vocab/index.js';
import { featureTraceRefusal } from '../artifacts/product.js';
import { mustHasAcceptanceRefusal, nfrMeasurabilityRefusal } from '../artifacts/requirements.js';
import type { Feature, ProductScope } from '../artifacts/product.js';
import type { ProjectGoal } from '../artifacts/framing.js';
import type { AcceptanceCriterion, Nfr, Requirement } from '../artifacts/requirements.js';
import type { BusinessRule } from '../artifacts/business.js';
import type { ComplexityJustification } from '../artifacts/architecture.js';
import type { AdminOperabilityReview } from '../artifacts/admin.js';
import type { Flow } from '../artifacts/ux.js';
import type { TestCase } from '../artifacts/testing.js';

/**
 * SC-RTC-007 — TRACEABILITY & ORPHAN CHECKER.
 *
 * SPEC: §30, 30 §5, 18 (quality gates).
 *
 * Every finding here is a broken link in the chain from "why we are building this" to
 * "how we will know it works". None of them is exotic; all of them are invisible without
 * a mechanical check, because each individual artifact looks perfectly reasonable on its
 * own. The goal with no feature reads fine. The feature with no goal reads fine. Only the
 * JOIN is wrong.
 *
 * This is deterministic and produces measured evidence. An agent's opinion that "coverage
 * looks good" is not a substitute, and was never meant to be.
 */

export interface TraceFinding {
  readonly code: string;
  readonly severity: Severity;
  readonly subject: string;
  readonly statement: string;
}

export interface TraceInput {
  readonly goals: readonly ProjectGoal[];
  readonly features: readonly Feature[];
  readonly requirements: readonly Requirement[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly nfrs: readonly Nfr[];
  readonly businessRules: readonly BusinessRule[];
  readonly complexity: readonly ComplexityJustification[];
  readonly operabilityReviews: readonly AdminOperabilityReview[];
  readonly flows: readonly Flow[];
  readonly testCases: readonly TestCase[];
  readonly productScope?: ProductScope;
  /** Ids the project has explicitly deferred, so a deferral is not reported as a gap. */
  readonly deferred?: readonly string[];
}

const finding = (
  code: string,
  severity: Severity,
  subject: string,
  statement: string,
): TraceFinding => ({ code, severity, subject, statement });

/**
 * Run every orphan check.
 *
 * Severity is deliberate. A MUST requirement with no acceptance criterion is BLOCKING
 * because nothing can verify it; an unreferenced business rule is ADVISORY because it may
 * legitimately constrain something outside this release. Marking everything BLOCKING
 * teaches people to ignore the report.
 */
export function checkTraceability(input: TraceInput): readonly TraceFinding[] {
  const out: TraceFinding[] = [];
  const deferred = new Set(input.deferred ?? []);

  /* --- goals must reach something that implements them --- */
  const goalIdsCovered = new Set<string>();
  for (const f of input.features) for (const g of f.goalRefs) goalIdsCovered.add(g.id);
  for (const r of input.requirements) for (const t of r.tracesTo) goalIdsCovered.add(t.id);
  for (const g of input.goals) {
    if (goalIdsCovered.has(g.id) || deferred.has(g.id)) continue;
    out.push(
      finding(
        'GOAL_UNCOVERED',
        Severity.BLOCKING,
        g.id,
        'ProjectGoal "' +
          g.statement +
          '" is covered by no Feature and no Requirement, and has not been explicitly deferred',
      ),
    );
  }

  /* --- features must be justified by a goal or an approved proposal --- */
  for (const f of input.features) {
    const refusal = featureTraceRefusal(f);
    if (refusal !== undefined)
      out.push(finding('FEATURE_ORPHAN', Severity.BLOCKING, f.id, refusal));
  }

  /* --- requirements must trace upward, and MUSTs must be verifiable --- */
  for (const r of input.requirements) {
    if (r.tracesTo.length === 0 && r.featureRef === undefined) {
      out.push(
        finding(
          'REQUIREMENT_ORPHAN',
          Severity.MAJOR,
          r.id,
          'Requirement "' +
            r.statement +
            '" traces upward to nothing, so nothing explains why it exists',
        ),
      );
    }
    const missingAc = mustHasAcceptanceRefusal(r, input.acceptanceCriteria);
    if (missingAc !== undefined) {
      out.push(finding('MUST_WITHOUT_AC', Severity.BLOCKING, r.id, missingAc));
    }
  }

  /* --- acceptance criteria need a method, and a real requirement --- */
  const reqIds = new Set(input.requirements.map((r) => r.id));
  for (const ac of input.acceptanceCriteria) {
    if (!reqIds.has(ac.requirementRef.id)) {
      out.push(
        finding(
          'AC_ORPHAN',
          Severity.MAJOR,
          ac.id,
          'AcceptanceCriterion references requirement ' +
            ac.requirementRef.id +
            ', which does not exist',
        ),
      );
    }
  }

  /* --- NFRs must be measurable, or explicitly dispositioned --- */
  for (const n of input.nfrs) {
    const refusal = nfrMeasurabilityRefusal(n);
    if (refusal !== undefined && !deferred.has(n.id)) {
      out.push(finding('NFR_UNMEASURABLE', Severity.BLOCKING, n.id, refusal));
    }
  }

  /* --- business rules that nothing downstream implements --- */
  const ruleRefsUsed = new Set<string>();
  for (const r of input.requirements) for (const t of r.tracesTo) ruleRefsUsed.add(t.id);
  for (const br of input.businessRules) {
    if (ruleRefsUsed.has(br.id) || deferred.has(br.id)) continue;
    out.push(
      finding(
        'RULE_UNIMPLEMENTED',
        Severity.ADVISORY,
        br.id,
        'BusinessRule "' +
          br.statement +
          '" is referenced by no requirement; it may be out of this release, or forgotten',
      ),
    );
  }

  /* --- UI flows must exist for a reason --- */
  for (const f of input.flows) {
    if (f.requirementRefs.length === 0) {
      out.push(
        finding(
          'FLOW_ORPHAN',
          Severity.MAJOR,
          f.id,
          'Flow "' + f.name + '" implements no stated requirement',
        ),
      );
    }
  }

  /* --- every feature needs an operability review (§27, mandatory) --- */
  const reviewed = new Set(input.operabilityReviews.map((r) => r.featureRef.id));
  for (const f of input.features) {
    if (reviewed.has(f.id)) continue;
    out.push(
      finding(
        'FEATURE_WITHOUT_OPERABILITY_REVIEW',
        Severity.BLOCKING,
        f.id,
        'Feature "' +
          f.name +
          '" has no AdminOperabilityReview, which is mandatory for every feature',
      ),
    );
  }

  /* --- architecture complexity must name what forces it --- */
  for (const c of input.complexity) {
    const forcing = c.forcingRequirementRef.id;
    const known = reqIds.has(forcing) || input.nfrs.some((n) => n.id === forcing);
    if (!known) {
      out.push(
        finding(
          'COMPLEXITY_UNFORCED',
          Severity.BLOCKING,
          c.id,
          'Pattern "' +
            c.pattern +
            '" cites forcing requirement ' +
            forcing +
            ', which does not exist',
        ),
      );
    }
  }

  /* --- test cases must verify something real --- */
  const traceableIds = new Set<string>([
    ...reqIds,
    ...input.acceptanceCriteria.map((a) => a.id),
    ...input.nfrs.map((n) => n.id),
    ...input.businessRules.map((b) => b.id),
    ...input.flows.map((f) => f.id),
  ]);
  for (const tc of input.testCases) {
    const anyReal = tc.derivedFrom.some((d) => traceableIds.has(d.id));
    if (!anyReal) {
      out.push(
        finding(
          'TESTCASE_ORPHAN',
          Severity.MAJOR,
          tc.id,
          'TestCase "' +
            tc.title +
            '" derives from nothing that exists, so it verifies nothing anyone asked for',
        ),
      );
    }
  }

  return out;
}

/** Anything BLOCKING stops readiness. Used by the gate wiring and by `serva readiness`. */
export function blockingFindings(findings: readonly TraceFinding[]): readonly TraceFinding[] {
  return findings.filter((f) => f.severity === Severity.BLOCKING);
}
