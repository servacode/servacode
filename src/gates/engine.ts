import { GateVerdict } from '../vocab/index.js';
import { composeGateVerdict } from './compose.js';
import { assertCriterionWellFormed } from './evaluate.js';
import { AuditAction, audit } from '../events/audit.js';
import { fail } from '../core/errors.js';
import { getCatalogues } from '../catalogue/index.js';
import type { CriterionEvaluation, GateResult, QualityGate } from './types.js';
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

  const known = new Set(args.gate.criteria.map((c) => c.id));
  for (const e of args.evaluations) {
    if (!known.has(e.criterionRef)) {
      fail({
        code: 'E_GATE_DEFINITION',
        message:
          'Evaluation references criterion ' +
          e.criterionRef +
          ' which gate ' +
          args.gate.id +
          ' does not define',
        remedy: 'Evaluate only criteria belonging to the gate under evaluation.',
        details: { gateId: args.gate.id, criterionRef: e.criterionRef },
      });
    }
  }

  const composed = composeGateVerdict(args.evaluations);

  const result: GateResult = {
    id: deps.ids.next('SC-GR'),
    gateRef: args.gate.id,
    gateVersion: args.gate.version,
    scope: args.scope,
    verdict: composed.verdict,
    criterionEvaluationIds: args.evaluations.map((e) => e.id),
    evidenceRefs: [...new Set(args.evaluations.flatMap((e) => e.evidenceRefs))],
    artifactVersionsEvaluated: args.evaluations.flatMap((e) => e.artifactVersionsEvaluated),
    qualifications: composed.qualifications,
    findings: [],
    evaluatedAt: deps.clock.now(),
    evaluator: deps.evaluator,
    storeVersion: 0,
    dependsOn: [],
  };

  // T-TRACE: the criterion evaluations and the gate result are both immutable.
  for (const e of args.evaluations) {
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
      criteria: args.evaluations.length,
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
