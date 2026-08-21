/**
 * Serva Code — Core Engine (Phase 2).
 *
 * Public surface of the deterministic core. The future VS Code extension imports
 * this module directly; there is no protocol layer (ADR-001).
 *
 * This module deliberately exports NO AI-provider dependency (27 NFR-17).
 */

export * from './vocab/index.js';

export { ServaError, isServaError, fail, type ServaErrorCode } from './core/errors.js';
export { systemClock, FixedClock, type Clock } from './core/clock.js';
export {
  TimeOrderedIdSource,
  SequentialIdSource,
  parseIdPrefix,
  assertIdPrefix,
  type IdSource,
  type IdPrefix,
} from './core/ids.js';
export { canonicalJson, sha256Hex, digestOf, chainDigest, GENESIS_DIGEST } from './core/hash.js';

export { Store, Transaction, SCHEMA_VERSION } from './store/store.js';
export { TraceLog, type TraceRecord } from './store/traceLog.js';
export { storePaths, SERVA_DIR, type StorePaths } from './store/paths.js';

export { getCatalogues, resetCatalogueCache } from './catalogue/index.js';

export * from './domain/schemas.js';

export {
  composeGateVerdict,
  SEVERITY_DISPOSITION,
  type ComposedVerdict,
  type Disposition,
} from './gates/compose.js';
export { mapVerifierResult, deriveBasis } from './gates/mapVerifier.js';
export {
  evaluateEvidenceCriterion,
  evaluateToolUnavailable,
  evaluateNotApplicable,
  assertCriterionWellFormed,
  type EvidenceView,
} from './gates/evaluate.js';
export {
  ConditionRegistry,
  StoreWaiverAuthority,
  WAIVER_CANON_TYPE,
  WAIVER_REQUIRED_AUTHORITY,
  WaiverRecordSchema,
  waiverProblem,
} from './gates/authority.js';
export type {
  ApplicabilityAuthority,
  ApplicabilityCondition,
  ApplicabilityDetermination,
  WaiverAuthority,
  WaiverRecord,
} from './gates/authority.js';
export {
  evaluateGate,
  validateGate,
  assertKnownGate,
  assertEvaluationsComplete,
  bindEvaluationsToGate,
  readGateResults,
  readCriterionEvaluations,
  GATE_STREAM,
} from './gates/engine.js';
export type {
  Criterion,
  CriterionEvaluation,
  ArtifactVerifierResult,
  GateResult,
  QualityGate,
  Qualification,
  EvidenceRequirement,
} from './gates/types.js';

export {
  deriveValidity,
  isUsable,
  MapValidityContext,
  type ValidityBearing,
  type ValidityContext,
} from './validity/derive.js';

export {
  AgentRunEventType,
  appendRunEvent,
  projectAgentRun,
  refreshProjection,
  emitTerminalSnapshot,
  findIncompleteRuns,
  runStream,
  type AgentRunProjection,
} from './events/agentRun.js';
export {
  AuditAction,
  audit,
  recordViolation,
  readAudit,
  readViolations,
  AUDIT_STREAM,
  VIOLATION_STREAM,
} from './events/audit.js';

export {
  WorkflowEngine,
  WorkflowEventType,
  assertTransition,
  assertRunCoherent,
  validateWorkflowDefinition,
  isTerminal,
  WORKFLOW_STREAM,
  type WorkflowDefinition,
  type StepDefinition,
} from './workflow/engine.js';

export {
  startStage,
  transitionStage,
  appendLedgerEntry,
  applyGateOutcome,
  readLedger,
  getStageState,
  assertKnownStage,
  STAGE_LEDGER_STREAM,
} from './lifecycle/stages.js';
export {
  mapGateOutcome,
  GATE_OUTCOME_MAPPING,
  type GateOutcomeMapping,
} from './lifecycle/mapping.js';

export {
  listPolicies,
  getPolicy,
  enforcementCoverage,
  reportViolation,
  type PolicyRecord,
} from './policy/registry.js';

export {
  ServaRuntime,
  discoverProjectRoot,
  SERVA_VERSION,
  SPEC_BASELINE,
  type RuntimeOptions,
  type StartupReport,
} from './app/runtime.js';
export { runDoctor, type DoctorReport, type Check } from './app/doctor.js';
