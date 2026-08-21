import { ViolationSeverity } from '../vocab/index.js';
import { getCatalogues } from '../catalogue/index.js';
import { fail } from '../core/errors.js';
import { recordViolation } from '../events/audit.js';
import type { Transaction } from '../store/store.js';

/**
 * Policy registry and governance foundation.
 *
 * SPEC: 01 (the constitution), 30 §9 (membership).
 *
 * Phase 2 scope: identifiers, enforcement metadata, violation representation, and
 * the checks the deterministic core itself performs. The AI governance layer is a
 * later phase; this is the foundation it will use.
 */

export const EnforcementClass = {
  MECHANICAL: 'MECHANICAL',
  GATE: 'GATE',
  PROCESS: 'PROCESS',
  ADVISORY: 'ADVISORY',
} as const;
export type EnforcementClass = (typeof EnforcementClass)[keyof typeof EnforcementClass];

export interface PolicyRecord {
  readonly id: string;
  readonly name: string;
  /** Where the core enforces it, when it does. Absent means "not enforced in Phase 2". */
  readonly enforcementPoint?: string;
  readonly enforcement?: EnforcementClass;
}

/**
 * Enforcement points the Phase 2 core actually implements.
 *
 * Deliberately a short list. 29 CF-2: anything specified but not implemented is
 * recorded as an explicit non-conformance — unimplemented governance must never
 * be mistaken for working governance.
 */
const PHASE2_ENFORCEMENT: Readonly<Record<string, { point: string; klass: EnforcementClass }>> =
  Object.freeze({
    'SC-POL-002': { point: 'DecisionSchema.options minimum 2', klass: 'MECHANICAL' },
    'SC-POL-004': { point: 'catalogue/index.ts single generated source', klass: 'MECHANICAL' },
    'SC-POL-005': {
      point: 'gates/compose.ts INDETERMINATE never composes to PASS',
      klass: 'MECHANICAL',
    },
    'SC-POL-015': { point: 'DecisionSchema.reevaluationTrigger required', klass: 'MECHANICAL' },
    'SC-POL-020': {
      point: 'store/store.ts — all truth on disk, no session state',
      klass: 'MECHANICAL',
    },
    'SC-POL-022': { point: 'store/traceLog.ts — append-only API, hash chain', klass: 'MECHANICAL' },
    'SC-POL-024': { point: 'lifecycle/stages.ts — ledger entry per attempt', klass: 'MECHANICAL' },
    'SC-POL-029': { point: 'events/audit.ts — runtime-only writer', klass: 'MECHANICAL' },
    'SC-POL-031': { point: 'validity/derive.ts — derived staleness', klass: 'MECHANICAL' },
    'SC-POL-033': { point: 'workflow/engine.ts — terminal state enforcement', klass: 'MECHANICAL' },
  });

export function listPolicies(): PolicyRecord[] {
  return getCatalogues().policies.map((p) => {
    const e = PHASE2_ENFORCEMENT[p.id];
    return {
      id: p.id,
      name: p.name,
      ...(e === undefined ? {} : { enforcementPoint: e.point, enforcement: e.klass }),
    };
  });
}

export function getPolicy(id: string): PolicyRecord {
  const found = listPolicies().find((p) => p.id === id);
  if (found === undefined) {
    return fail({
      code: 'E_NOT_FOUND',
      message: 'Unknown policy: ' + id,
      remedy: 'Policy identifiers come from 30 §9. Run `serva doctor` to list them.',
      details: { id },
      specRef: '30 §9',
    });
  }
  return found;
}

/** Coverage report: which policies the Phase 2 core enforces mechanically. */
export function enforcementCoverage(): {
  total: number;
  enforced: number;
  unenforced: readonly string[];
} {
  const all = listPolicies();
  const enforced = all.filter((p) => p.enforcementPoint !== undefined);
  return {
    total: all.length,
    enforced: enforced.length,
    unenforced: all.filter((p) => p.enforcementPoint === undefined).map((p) => p.id),
  };
}

export interface ViolationArgs {
  readonly policyId: string;
  readonly severity: ViolationSeverity;
  readonly subject: string;
  readonly statement: string;
  readonly response: string;
  readonly detail?: Record<string, unknown>;
}

/** Record a violation. Validates the policy exists before writing (no free-text refs). */
export function reportViolation(tx: Transaction, args: ViolationArgs): void {
  const policy = getPolicy(args.policyId);
  recordViolation(tx, {
    policyRef: policy.id,
    severity: args.severity,
    subject: args.subject,
    statement: args.statement,
    response: args.response,
    ...(args.detail === undefined ? {} : { detail: args.detail }),
  });
}

export { ViolationSeverity };
