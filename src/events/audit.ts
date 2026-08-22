import type { ViolationSeverity } from '../vocab/index.js';
import type { Store, Transaction } from '../store/store.js';
import type { TraceRecord } from '../store/traceLog.js';

/**
 * Audit trail. SPEC: SC-POL-029 — Audit Events are written by the runtime only.
 *
 * This module is not reachable from any agent tool surface. Agents produce
 * *content*; the runtime produces *records about what happened*.
 */

export const AUDIT_STREAM = 'audit';
export const VIOLATION_STREAM = 'violations';

export const AuditAction = {
  PROJECT_INITIALIZED: 'PROJECT_INITIALIZED',
  PROJECT_OPENED: 'PROJECT_OPENED',
  STORE_RECOVERED: 'STORE_RECOVERED',
  GATE_EVALUATED: 'GATE_EVALUATED',
  STAGE_LEDGER_APPENDED: 'STAGE_LEDGER_APPENDED',
  WORKFLOW_TRANSITION: 'WORKFLOW_TRANSITION',
  WORK_ITEM_TRANSITION: 'WORK_ITEM_TRANSITION',
  CANON_WRITTEN: 'CANON_WRITTEN',
  VALIDITY_RECOMPUTED: 'VALIDITY_RECOMPUTED',
  EVIDENCE_REVOKED: 'EVIDENCE_REVOKED',
  EVIDENCE_DISPUTED: 'EVIDENCE_DISPUTED',
  INTEGRITY_CHECK: 'INTEGRITY_CHECK',
  POLICY_VIOLATION: 'POLICY_VIOLATION',
  AGENT_RUN_TERMINATED: 'AGENT_RUN_TERMINATED',
  REQUEST_RECEIVED: 'REQUEST_RECEIVED',
  REQUEST_CLASSIFIED: 'REQUEST_CLASSIFIED',
  PLAN_VALIDATED: 'PLAN_VALIDATED',
  PLAN_REJECTED: 'PLAN_REJECTED',
  ENGINE_PROBED: 'ENGINE_PROBED',
  SUBSTRATE_QUALIFIED: 'SUBSTRATE_QUALIFIED',
  WORKSPACE_CREATED: 'WORKSPACE_CREATED',
  WORKSPACE_REMOVED: 'WORKSPACE_REMOVED',
  COMMAND_EXECUTED: 'COMMAND_EXECUTED',
  CHANGESET_RECORDED: 'CHANGESET_RECORDED',
  SCOPE_VIOLATION_DETECTED: 'SCOPE_VIOLATION_DETECTED',
  CHANGE_ACCEPTED: 'CHANGE_ACCEPTED',
  INTEGRATION_CONFLICT: 'INTEGRATION_CONFLICT',
  EXTERNAL_WORKSPACE_CHANGE: 'EXTERNAL_WORKSPACE_CHANGE',
  /** A Producer AgentRun was dispatched into a worktree under a measured boundary. */
  PRODUCER_DISPATCHED: 'PRODUCER_DISPATCHED',
  /** An independent reviewer's verdict was validated and persisted. */
  REVIEW_RECORDED: 'REVIEW_RECORDED',
  /** A reviewer result was refused: it could not be tied to a real, independent run. */
  REVIEW_REFUSED: 'REVIEW_REFUSED',
  /** A canonical intelligence artifact was written, at a specific version (08 §3). */
  ARTIFACT_RECORDED: 'ARTIFACT_RECORDED',
  /** An intelligence artifact was refused: malformed, or laundering a guess as a fact. */
  ARTIFACT_REFUSED: 'ARTIFACT_REFUSED',
  /** An owner decision was requested, because the answer was never Serva's to give. */
  OWNER_DECISION_REQUESTED: 'OWNER_DECISION_REQUESTED',
  /** An owner answered. Durable, attributable, and never synthesised by an agent. */
  OWNER_DECISION_ANSWERED: 'OWNER_DECISION_ANSWERED',
  /** External content was retrieved and captured as evidence. Always UNTRUSTED. */
  SOURCE_CAPTURED: 'SOURCE_CAPTURED',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditInput {
  readonly action: AuditAction;
  readonly subject: string;
  readonly outcome: 'OK' | 'REFUSED' | 'FAILED';
  readonly policyRef?: string;
  readonly detail?: Record<string, unknown>;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export function audit(tx: Transaction, input: AuditInput): void {
  tx.appendTrace(AUDIT_STREAM, {
    type: input.action,
    payload: {
      subject: input.subject,
      outcome: input.outcome,
      ...(input.policyRef === undefined ? {} : { policyRef: input.policyRef }),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    },
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
  });
}

export interface ViolationInput {
  readonly policyRef: string;
  readonly severity: ViolationSeverity;
  readonly subject: string;
  readonly statement: string;
  readonly response: string;
  readonly detail?: Record<string, unknown>;
}

/** 01 §1.3 — every violation produces an append-only record. */
export function recordViolation(tx: Transaction, input: ViolationInput): void {
  tx.appendTrace(VIOLATION_STREAM, {
    type: 'VIOLATION',
    payload: {
      policyRef: input.policyRef,
      severity: input.severity,
      subject: input.subject,
      statement: input.statement,
      response: input.response,
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    },
  });
  audit(tx, {
    action: AuditAction.POLICY_VIOLATION,
    subject: input.subject,
    outcome: 'REFUSED',
    policyRef: input.policyRef,
    detail: { severity: input.severity },
  });
}

export function readAudit(store: Store): TraceRecord[] {
  return store.readTrace(AUDIT_STREAM);
}

export function readViolations(store: Store): TraceRecord[] {
  return store.readTrace(VIOLATION_STREAM);
}
