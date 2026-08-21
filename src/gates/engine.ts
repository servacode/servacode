import { CriterionResult, GateVerdict } from '../vocab/index.js';
import { composeGateVerdict } from './compose.js';
import { assertCriterionWellFormed } from './evaluate.js';
import { waiverProblem } from './authority.js';
import { AuditAction, audit } from '../events/audit.js';
import { fail } from '../core/errors.js';
import { getCatalogues } from '../catalogue/index.js';
import type { ApplicabilityAuthority, WaiverAuthority } from './authority.js';
import type { Criterion, CriterionEvaluation, GateResult, QualityGate } from './types.js';
import type { Store, Transaction } from '../store/store.js';
import type { IdSource } from '../core/ids.js';
import type { Clock } from '../core/clock.js';

/**
 * Gate engine.
 *
 * SPEC: 18 §1 — a gate evaluates the STORE; it does not interview the worker.
 * Composition semantics are owned by 31 §4.1 and implemented in ./compose.ts.
 * This module persists the result and records the audit trail; it contains no
 * verdict logic of its own (18 §4.1).
 */

export const GATE_STREAM = 'gate-results';

export interface GateEngineDeps {
  readonly ids: IdSource;
  readonly clock: Clock;
  readonly evaluator: string;
  /**
   * Resolves and validates waivers. ABSENT MEANS WAIVED IS REJECTED: with no
   * authority able to say whether a waiver exists, is in scope, is active and
   * was granted by someone entitled to grant it, the only honest answer is that
   * the criterion is not waived. A reference string is not consent.
   */
  readonly waivers?: WaiverAuthority;
  /**
   * Resolves conditional applicability against stored state. Absent means
   * NOT_APPLICABLE is rejected for every conditional criterion.
   */
  readonly applicability?: ApplicabilityAuthority;
}

export function assertKnownGate(gateId: string): void {
  if (!getCatalogues().gateIds.includes(gateId)) {
    fail({
      code: 'E_GATE_DEFINITION',
      message: 'Unknown quality gate: ' + gateId,
      remedy: 'Gate identifiers come from 30 §7. Run `serva gates` to list them.',
      details: { gateId },
      specRef: '30 §7',
    });
  }
}

/** Validate a gate definition before it is ever evaluated. */
export function validateGate(gate: QualityGate): void {
  if (gate.criteria.length === 0) {
    fail({
      code: 'E_GATE_DEFINITION',
      message: 'Gate ' + gate.id + ' has no criteria',
      remedy: 'A gate with nothing to check cannot produce a meaningful verdict.',
      details: { gateId: gate.id },
      specRef: '18 §2',
    });
  }
  const seen = new Set<string>();
  for (const c of gate.criteria) {
    assertCriterionWellFormed(c); // CR-EX1
    if (seen.has(c.id)) {
      fail({
        code: 'E_GATE_DEFINITION',
        message: 'Gate ' + gate.id + ' has duplicate criterion id ' + c.id,
        remedy: 'Criterion identifiers must be unique within a gate.',
        details: { gateId: gate.id, criterionId: c.id },
      });
    }
    seen.add(c.id);
  }
}

/**
 * Gate completeness. Every criterion the gate defines must resolve to EXACTLY ONE
 * CriterionEvaluation before a verdict may be produced.
 *
 * SPEC basis: 18 1 -- a gate evaluates the store against its DECLARED criteria.
 * A criterion that was never evaluated has not been satisfied; it has not been
 * looked at. Allowing an incomplete set would let a non-empty gate reach PASS by
 * simply omitting the criteria that would have blocked it, which defeats
 * SC-POL-005 at the one place it is supposed to bite.
 *
 * Deliberately NOT done here: converting an omitted criterion into FAIL. Absence
 * of an evaluation is not proof of non-compliance (31 4.1.1). The evaluator must
 * state what it found -- INDETERMINATE when it could not check, NOT_APPLICABLE
 * when the criterion does not apply in this scope.
 */
export function assertEvaluationsComplete(
  gate: QualityGate,
  evaluations: readonly CriterionEvaluation[],
): void {
  // Every DEFINED criterion is expected, regardless of applicability. Applicability
  // is not a licence to omit: it is expressed by the evaluator returning an explicit
  // NOT_APPLICABLE, which keeps the record of what was considered complete.
  const expected = new Set(gate.criteria.map((c) => c.id));

  const seen = new Map<string, number>();
  for (const e of evaluations) {
    if (!expected.has(e.criterionRef)) {
      fail({
        code: 'E_GATE_DEFINITION',
        message:
          'Evaluation references criterion ' +
          e.criterionRef +
          ' which gate ' +
          gate.id +
          ' does not define',
        remedy: 'Evaluate only criteria belonging to the gate under evaluation.',
        details: { gateId: gate.id, criterionRef: e.criterionRef, defined: [...expected] },
        specRef: '18 2',
      });
    }
    seen.set(e.criterionRef, (seen.get(e.criterionRef) ?? 0) + 1);
  }

  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  if (duplicated.length > 0) {
    fail({
      code: 'E_GATE_DEFINITION',
      message:
        'Gate ' + gate.id + ' received more than one evaluation for: ' + duplicated.join(', '),
      remedy: 'Each criterion resolves to exactly one CriterionEvaluation.',
      details: { gateId: gate.id, duplicated },
      specRef: '18 2',
    });
  }

  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    fail({
      code: 'E_GATE_DEFINITION',
      message: 'Gate ' + gate.id + ' has unevaluated criteria: ' + missing.join(', '),
      remedy:
        'Every criterion must resolve to exactly one CriterionEvaluation. Produce an explicit INDETERMINATE (with a reason) where the criterion could not be checked, or NOT_APPLICABLE where it does not apply. A criterion is never silently omitted.',
      details: { gateId: gate.id, missing, supplied: [...seen.keys()] },
      specRef: '18 1, SC-POL-005',
    });
  }
}

/**
 * Bind every evaluation to the authoritative gate definition.
 *
 * THE DEFECT THIS CLOSES. Completeness proved that each criterion was addressed;
 * it did not prove that what came back respected the definition. Composition then
 * routed on fields the caller supplied. A caller could therefore answer for a
 * BLOCKING criterion while claiming ADVISORY severity, and a proven failure would
 * compose to FINDING_ONLY instead of FAIL. Three fields carry that risk, and each
 * is a complete bypass of the criterion on its own:
 *
 *   severity        -- decides which disposition row applies (31 §4.1.1)
 *   NOT_APPLICABLE  -- makes the criterion INERT
 *   WAIVED          -- converts an unmet criterion into a qualified pass
 *
 * None of the three is a finding. All three are properties of the GATE, not
 * observations of the subject, so the runtime owns all three. MV-6 already stated
 * this for severity, but only the verifier mapper honoured it; an arbitrary caller
 * of evaluateGate did not. This function moves the rule to the boundary where
 * every caller must pass through it.
 *
 * Returns the normalized evaluations that composition will actually see.
 */
export function bindEvaluationsToGate(
  gate: QualityGate,
  scope: string,
  evaluations: readonly CriterionEvaluation[],
  deps: GateEngineDeps,
): CriterionEvaluation[] {
  assertEvaluationsComplete(gate, evaluations);

  const byId = new Map(gate.criteria.map((c) => [c.id, c]));
  const now = deps.clock.now();

  return evaluations.map((e) => {
    // Non-null: assertEvaluationsComplete has already proved membership.
    const criterion = byId.get(e.criterionRef)!;
    assertSeverityIsGateOwned(gate, criterion, e);

    if (e.value === CriterionResult.NOT_APPLICABLE) {
      return withApplicabilityBasis(gate, criterion, scope, e, deps, now);
    }
    if (e.value === CriterionResult.WAIVED) {
      assertWaiverIsValid(gate, criterion, scope, e, deps, now);
    }

    // Severity is re-stamped from the definition rather than merely checked, so
    // that composition cannot see a caller-supplied value even if some future
    // path reaches it without the check above.
    return { ...e, severity: criterion.severity };
  });
}

/** 31 §2.1, MV-6 — severity comes from the gate definition, never from the caller. */
function assertSeverityIsGateOwned(
  gate: QualityGate,
  criterion: Criterion,
  e: CriterionEvaluation,
): void {
  if (e.severity !== criterion.severity) {
    fail({
      code: 'E_GATE_AUTHORITY',
      message:
        'Evaluation of ' +
        criterion.id +
        ' claims severity ' +
        e.severity +
        ' but gate ' +
        gate.id +
        ' defines it as ' +
        criterion.severity,
      remedy:
        'Severity is a property of the gate definition, not of the evaluation. Report what you found; the runtime decides how much it counts.',
      details: {
        gateId: gate.id,
        criterionRef: criterion.id,
        claimed: e.severity,
        defined: criterion.severity,
      },
      specRef: '31 §2.1, 18 MV-6',
    });
  }
}

/**
 * 31 §2 — NOT_APPLICABLE means "does not apply, WITH A RECORDED REASON".
 *
 * An ALWAYS criterion has no condition that could fail, so it can never be
 * inapplicable; accepting NOT_APPLICABLE there would let any criterion be skipped
 * by naming the value. A conditional criterion is resolved by an authority against
 * stored state, and the engine stamps the determination it obtained -- never the
 * one the caller offered.
 */
function withApplicabilityBasis(
  gate: QualityGate,
  criterion: Criterion,
  scope: string,
  e: CriterionEvaluation,
  deps: GateEngineDeps,
  now: string,
): CriterionEvaluation {
  if (criterion.applicability === 'ALWAYS') {
    return fail({
      code: 'E_GATE_AUTHORITY',
      message: 'Criterion ' + criterion.id + ' applies ALWAYS and cannot be NOT_APPLICABLE',
      remedy:
        'An unconditional criterion has no applicability condition to fail. Evaluate it: MET, NOT_MET, or INDETERMINATE with a reason.',
      details: { gateId: gate.id, criterionRef: criterion.id, scope },
      specRef: '31 §2, 18 §2',
    });
  }

  const condition = criterion.applicability.condition;
  if (deps.applicability === undefined) {
    return fail({
      code: 'E_GATE_AUTHORITY',
      message:
        'NOT_APPLICABLE for ' +
        criterion.id +
        ' cannot be accepted: no applicability authority is configured',
      remedy:
        'Supply an ApplicabilityAuthority that can resolve condition "' +
        condition +
        '" against stored state. Without one the runtime cannot distinguish a genuine exemption from an assertion.',
      details: { gateId: gate.id, criterionRef: criterion.id, condition, scope },
      specRef: '31 §2',
    });
  }

  const determination = deps.applicability.resolve(condition, scope);
  if (determination === undefined) {
    return fail({
      code: 'E_GATE_AUTHORITY',
      message: 'Applicability condition "' + condition + '" is not registered',
      remedy:
        'An unrecognised condition is a gap in the definition, not an exemption. Register the condition or correct the criterion.',
      details: { gateId: gate.id, criterionRef: criterion.id, condition, scope },
      specRef: '18 §2',
    });
  }
  if (determination.applies) {
    return fail({
      code: 'E_GATE_AUTHORITY',
      message:
        'Criterion ' +
        criterion.id +
        ' was reported NOT_APPLICABLE but condition "' +
        condition +
        '" holds for ' +
        scope,
      remedy: 'The criterion applies here. Evaluate it rather than exempting it.',
      details: { gateId: gate.id, criterionRef: criterion.id, condition, scope },
      specRef: '31 §2',
    });
  }

  // Runtime-written: the caller's value, if any, is replaced by what was resolved.
  return {
    ...e,
    severity: criterion.severity,
    applicabilityBasis: {
      condition,
      resolvedBy: determination.resolvedBy,
      resolvedAt: now,
    },
  };
}

/**
 * 09 §9, 18 GW-1..GW-5 — a waiverRef is a reference, not authority.
 *
 * Composition turns WAIVED into a qualified pass. Accepting an arbitrary string
 * therefore hands any caller a universal bypass with an audit trail that looks
 * legitimate. Each check below corresponds to a stated rule: GW-1 scope and
 * target, GW-3 waivability, W-4/GW-5 expiry, 09 §2 authority.
 */
function assertWaiverIsValid(
  gate: QualityGate,
  criterion: Criterion,
  scope: string,
  e: CriterionEvaluation,
  deps: GateEngineDeps,
  now: string,
): void {
  const waiverRef = e.waiverRef;
  if (waiverRef === undefined) {
    fail({
      code: 'E_VALIDATION',
      message: 'CriterionEvaluation ' + e.id + ' is WAIVED without a waiverRef',
      remedy: 'A waived criterion must reference an active, unexpired waiver (09 §9).',
      details: { gateId: gate.id, criterionRef: criterion.id },
      specRef: '08 KI-2b',
    });
    return;
  }

  const waivable = gate.waivable && (criterion.waivable ?? true);
  if (!waivable) {
    fail({
      code: 'E_GATE_AUTHORITY',
      message: 'Criterion ' + criterion.id + ' of gate ' + gate.id + ' is not waivable',
      remedy:
        'Some criteria can never be waived (18 GW-3). Fix the underlying condition; there is no override mechanism (18 §6).',
      details: {
        gateId: gate.id,
        criterionRef: criterion.id,
        gateWaivable: gate.waivable,
        criterionWaivable: criterion.waivable,
      },
      specRef: '18 GW-3, 09 W-2',
    });
  }

  if (deps.waivers === undefined) {
    fail({
      code: 'E_GATE_AUTHORITY',
      message:
        'WAIVED for ' + criterion.id + ' cannot be accepted: no waiver authority is configured',
      remedy:
        'Supply a WaiverAuthority so the reference can be resolved and validated. An unvalidated waiverRef is not consent (18 GW-4).',
      details: { gateId: gate.id, criterionRef: criterion.id, waiverRef },
      specRef: '09 §9',
    });
    return;
  }

  const waiver = deps.waivers.resolve(waiverRef);
  if (waiver === undefined) {
    fail({
      code: 'E_GATE_AUTHORITY',
      message: 'Waiver ' + waiverRef + ' does not exist',
      remedy:
        'A waived criterion must reference a recorded PolicyWaiver. An unresolvable reference is not a waiver.',
      details: { gateId: gate.id, criterionRef: criterion.id, waiverRef },
      specRef: '09 §9',
    });
    return;
  }

  const problem = waiverProblem(waiver, gate.id, criterion.id, scope, now);
  if (problem !== undefined) {
    fail({
      code: 'E_GATE_AUTHORITY',
      message: 'Waiver ' + waiverRef + ' does not authorise this criterion: ' + problem,
      remedy:
        'Waivers are scoped, targeted, expiring and authority-bound (09 W-1, 18 GW-1, GW-5). Obtain a waiver that covers this criterion in this scope, or fix the criterion.',
      details: { gateId: gate.id, criterionRef: criterion.id, waiverRef, scope, problem },
      specRef: '09 §9, 18 §6',
    });
  }
}

export interface EvaluateGateArgs {
  readonly gate: QualityGate;
  readonly scope: string;
  readonly evaluations: readonly CriterionEvaluation[];
}

/**
 * Evaluate a gate and persist the immutable result.
 *
 * The GateResult carries NO validity field: ValidityState is derived (31 VD-1).
 */
export function evaluateGate(
  tx: Transaction,
  deps: GateEngineDeps,
  args: EvaluateGateArgs,
): GateResult {
  validateGate(args.gate);

  // Everything downstream reads `bound`, never args.evaluations: there must be no
  // path by which a caller-supplied governance field reaches composition or the
  // persisted record.
  const bound = bindEvaluationsToGate(args.gate, args.scope, args.evaluations, deps);

  const composed = composeGateVerdict(bound);

  const result: GateResult = {
    id: deps.ids.next('SC-GR'),
    gateRef: args.gate.id,
    gateVersion: args.gate.version,
    scope: args.scope,
    verdict: composed.verdict,
    criterionEvaluationIds: bound.map((e) => e.id),
    evidenceRefs: [...new Set(bound.flatMap((e) => e.evidenceRefs))],
    artifactVersionsEvaluated: bound.flatMap((e) => e.artifactVersionsEvaluated),
    qualifications: composed.qualifications,
    findings: [],
    evaluatedAt: deps.clock.now(),
    evaluator: deps.evaluator,
    storeVersion: 0,
    dependsOn: [],
  };

  // T-TRACE: the criterion evaluations and the gate result are both immutable.
  for (const e of bound) {
    tx.appendTrace(GATE_STREAM, { type: 'CRITERION_EVALUATION', payload: e });
  }
  tx.appendTrace(GATE_STREAM, { type: 'GATE_RESULT', payload: result });

  audit(tx, {
    action: AuditAction.GATE_EVALUATED,
    subject: args.gate.id,
    outcome: composed.verdict === GateVerdict.PASS ? 'OK' : 'OK',
    detail: {
      scope: args.scope,
      verdict: composed.verdict,
      qualifications: composed.qualifications.length,
      criteria: bound.length,
    },
  });

  return result;
}

export function readGateResults(store: Store): GateResult[] {
  return store
    .readTrace(GATE_STREAM)
    .filter((r) => r.type === 'GATE_RESULT')
    .map((r) => r.payload as GateResult);
}

export function readCriterionEvaluations(store: Store): CriterionEvaluation[] {
  return store
    .readTrace(GATE_STREAM)
    .filter((r) => r.type === 'CRITERION_EVALUATION')
    .map((r) => r.payload as CriterionEvaluation);
}
