import { z } from 'zod';
import { canonicalJson, digestOf } from '../core/hash.js';
import { AuditAction, audit } from '../events/audit.js';
import { EvidenceClass, ValidityState } from '../vocab/index.js';
import { scrubEnvironment, type ExecutionRecipe } from './recipe.js';
import {
  engineeringAuthorityRefusal,
  type ExecutionSubstrate,
  type SubstrateQualification,
} from '../substrate/types.js';
import { join } from 'node:path';
import { fail } from '../core/errors.js';
import { SERVA_INTERNAL_DIR } from '../agents/toolPolicy.js';
import type { Store, Transaction } from '../store/store.js';
import type { Clock } from '../core/clock.js';
import type { IdSource } from '../core/ids.js';

/**
 * Command execution records and the evidence they can support.
 *
 * SPEC: Phase 4 §13–§14, 16 §3 (evidence classes), SC-POL-023.
 *
 * The distinction this file exists to hold:
 *
 *   A Producer saying "tests pass" is a CLAIM.
 *   The Test Executor observing exit code 0, for a named recipe, against a named
 *   ChangeSet, is EVIDENCE.
 *
 * Only the runtime writes these records. An agent has no path to one: it cannot name a
 * recipe that is not registered, cannot run a command outside the substrate, and cannot
 * write to T-TRACE at all (SC-POL-029).
 *
 * What the record deliberately does NOT hold: raw output. Digests and bounded excerpts
 * go into the trace, because T-TRACE is permanent and build output is unbounded and
 * routinely carries paths, tokens and environment fragments.
 */

export const EXECUTION_STREAM = 'engineering/executions';
export const EXECUTION_CANON_TYPE = 'commandExecution';

export const ExecutionOutcome = {
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  TIMED_OUT: 'TIMED_OUT',
  REFUSED_BY_SUBSTRATE: 'REFUSED_BY_SUBSTRATE',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
} as const;
export type ExecutionOutcome = (typeof ExecutionOutcome)[keyof typeof ExecutionOutcome];

export const CommandExecutionRecordSchema = z
  .object({
    executionId: z.string().min(1),
    runtimeComponentId: z.string().regex(/^SC-RTC-\d{3}$/),
    recipeId: z.string().min(1),
    workItemId: z.string().min(1),
    workspaceId: z.string().min(1),
    changeSetId: z.string().optional(),
    baseCommit: z.string(),
    headCommit: z.string(),
    executable: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
    /** A digest, not the environment: the values are exactly what must not be stored. */
    environmentDigest: z.string().length(64),
    environmentPolicy: z.string(),
    networkPolicy: z.string(),
    substrateClass: z.string(),
    substrateQualificationDigest: z.string().length(64),
    startedAt: z.string(),
    endedAt: z.string(),
    durationMs: z.number().int().nonnegative(),
    exitCode: z.number().int().nullable(),
    outcome: z.nativeEnum(ExecutionOutcome),
    terminationReason: z.string(),
    stdoutDigest: z.string().length(64),
    stderrDigest: z.string().length(64),
    stdoutExcerpt: z.string(),
    stderrExcerpt: z.string(),
    truncated: z.object({ stdout: z.boolean(), stderr: z.boolean() }).strict(),
    toolVersions: z.record(z.string()).default({}),
    correlationId: z.string().optional(),
    causationId: z.string().optional(),
  })
  .strict();

export type CommandExecutionRecord = z.output<typeof CommandExecutionRecordSchema>;

const EXCERPT_LIMIT = 2_000;

export interface ExecutorDeps {
  readonly store: Store;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly substrate: ExecutionSubstrate;
  readonly qualification: SubstrateQualification;
  readonly env: NodeJS.ProcessEnv;
}

export interface RunRecipeRequest {
  readonly recipe: ExecutionRecipe;
  readonly workItemId: string;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly projectRoot: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly changeSetId?: string;
  readonly correlationId?: string;
}

/**
 * Run one registered recipe through the qualified substrate and record what happened.
 *
 * Refuses before executing anything when the substrate is not HARD. That check is here
 * rather than only at the factory level because this is the function that actually
 * starts a process: a guard further up can be forgotten, and this one cannot be routed
 * around.
 */
export async function runRecipe(
  deps: ExecutorDeps,
  req: RunRecipeRequest,
): Promise<CommandExecutionRecord> {
  const refusal = engineeringAuthorityRefusal(deps.qualification);
  if (refusal !== undefined) {
    return fail({
      code: 'E_CAPABILITY_NOT_ENABLED',
      message: 'Refusing to execute ' + req.recipe.id + ': ' + refusal,
      remedy:
        'Serva does not run a Producer command outside a boundary it has measured. Qualify the substrate, or accept that this project cannot be built here.',
      details: {
        recipeId: req.recipe.id,
        enforcementClass: deps.qualification.enforcementClass,
        blockedBy: deps.qualification.blockedBy,
      },
      specRef: '33 PC-5, Phase 4 §1',
    });
  }

  const env = scrubEnvironment(req.recipe.environmentPolicy, deps.env);
  const cwd = req.recipe.cwdPolicy === 'WORKSPACE' ? req.workspacePath : req.projectRoot;
  const startedAt = deps.clock.now();

  const result = await deps.substrate.execute({
    executable: req.recipe.executable,
    args: req.recipe.args,
    cwd,
    env,
    timeoutMs: req.recipe.timeoutMs,
    maxOutputBytes: req.recipe.maxOutputBytes,
    // The worktree, and nothing else. A build that needs to write elsewhere is a
    // recipe that needs a stated reason, not a wider default.
    writeScope: [req.workspacePath],
    // Readable: the worktree and the project it came from, so a build can resolve a
    // shared config. NOT the store — a run must not be able to read the audit trail it
    // is being judged by, or another run's prompt while that run is still in flight.
    readScope: [req.workspacePath, req.projectRoot],
    denyRead: [join(req.projectRoot, SERVA_INTERNAL_DIR)],
    networkAllowed: req.recipe.networkPolicy !== 'NONE',
  });

  const outcome: ExecutionOutcome = result.refusedBySubstrate
    ? ExecutionOutcome.REFUSED_BY_SUBSTRATE
    : result.timedOut
      ? ExecutionOutcome.TIMED_OUT
      : result.exitCode !== null && req.recipe.successExitCodes.includes(result.exitCode)
        ? ExecutionOutcome.SUCCEEDED
        : ExecutionOutcome.FAILED;

  const record = CommandExecutionRecordSchema.parse({
    executionId: deps.ids.next('SC-EXEC'),
    runtimeComponentId: req.recipe.runtimeComponentId,
    recipeId: req.recipe.id,
    workItemId: req.workItemId,
    workspaceId: req.workspaceId,
    ...(req.changeSetId === undefined ? {} : { changeSetId: req.changeSetId }),
    baseCommit: req.baseCommit,
    headCommit: req.headCommit,
    executable: req.recipe.executable,
    args: [...req.recipe.args],
    cwd,
    environmentDigest: digestOf(canonicalJson(Object.keys(env).sort())),
    environmentPolicy: req.recipe.environmentPolicy,
    networkPolicy: req.recipe.networkPolicy,
    substrateClass: deps.qualification.enforcementClass,
    substrateQualificationDigest: qualificationDigest(deps.qualification),
    startedAt,
    endedAt: result.endedAt,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    outcome,
    terminationReason: result.refusedBySubstrate
      ? (result.refusalReason ?? 'refused by substrate')
      : result.timedOut
        ? 'wall-clock timeout after ' + String(req.recipe.timeoutMs) + 'ms'
        : 'exited ' + String(result.exitCode),
    stdoutDigest: digestOf(result.stdout),
    stderrDigest: digestOf(result.stderr),
    stdoutExcerpt: result.stdout.slice(0, EXCERPT_LIMIT),
    stderrExcerpt: result.stderr.slice(0, EXCERPT_LIMIT),
    truncated: result.truncated,
    ...(req.correlationId === undefined ? {} : { correlationId: req.correlationId }),
  });

  const tx = deps.store.begin();
  // T-CANON: an execution is established fact about something that already happened,
  // and canon gives it immutability and digest verification for free.
  tx.putCanon(EXECUTION_CANON_TYPE, record.executionId, record);
  tx.appendTrace(EXECUTION_STREAM, {
    type: 'COMMAND_EXECUTED',
    payload: {
      executionId: record.executionId,
      runtimeComponentId: record.runtimeComponentId,
      recipeId: record.recipeId,
      workspaceId: record.workspaceId,
      outcome: record.outcome,
      exitCode: record.exitCode,
      headCommit: record.headCommit,
    },
    ...(req.correlationId === undefined ? {} : { correlationId: req.correlationId }),
  });
  audit(tx, {
    action: AuditAction.COMMAND_EXECUTED,
    subject: record.executionId,
    outcome: outcome === ExecutionOutcome.SUCCEEDED ? 'OK' : 'FAILED',
    detail: { recipeId: record.recipeId, outcome, exitCode: record.exitCode },
  });
  tx.commit();

  return record;
}

export function qualificationDigest(q: SubstrateQualification): string {
  return digestOf(
    canonicalJson({
      substrateId: q.probe.substrateId,
      enforcementClass: q.enforcementClass,
      engineVersion: q.engineVersion,
      tests: q.tests.map((t) => ({ id: t.id, outcome: t.outcome })),
    }),
  );
}

export function readExecution(
  store: Store,
  executionId: string,
): CommandExecutionRecord | undefined {
  const env = store.getCanon<unknown>(EXECUTION_CANON_TYPE, executionId);
  if (env === undefined) return undefined;
  const parsed = CommandExecutionRecordSchema.safeParse(env.body);
  return parsed.success ? parsed.data : undefined;
}

export function listExecutions(store: Store): CommandExecutionRecord[] {
  return store
    .listCanonIds(EXECUTION_CANON_TYPE)
    .map((id) => readExecution(store, id))
    .filter((r): r is CommandExecutionRecord => r !== undefined);
}

/* ------------------------------------------------------------------- evidence */

export const EVIDENCE_CANON_TYPE = 'engineeringEvidence';

/**
 * Evidence produced by a runtime component. SPEC: 16 §3, SC-POL-023.
 *
 * Bound to a ChangeSet, not merely to a work item. That binding is what makes
 * staleness computable: change the code and the evidence still describes the old
 * ChangeSet, truthfully, and simply no longer applies. Historical evidence is never
 * mutated — `deriveValidity` computes STALE, it does not write it (31 VD-1).
 */
export const EngineeringEvidenceSchema = z
  .object({
    id: z.string().min(1),
    evidenceClass: z.nativeEnum(EvidenceClass),
    claim: z.string().min(1),
    /** MEASURED for an executor, JUDGED for a reviewer, DERIVED for a gate. */
    basis: z.enum(['MEASURED', 'JUDGED', 'DERIVED']),
    workItemId: z.string().min(1),
    changeSetId: z.string().min(1),
    workspaceId: z.string().min(1),
    headCommit: z.string(),
    executionId: z.string().optional(),
    runRef: z.string().optional(),
    runtimeComponentId: z.string().optional(),
    outcome: z.enum(['PASS', 'FAIL', 'INDETERMINATE']),
    detail: z.string(),
    capturedAt: z.string(),
    capturedBy: z.enum(['RUNTIME', 'OWNER']),
  })
  .strict();

export type EngineeringEvidence = z.output<typeof EngineeringEvidenceSchema>;

export function recordEvidence(tx: Transaction, evidence: EngineeringEvidence): void {
  tx.putCanon(EVIDENCE_CANON_TYPE, evidence.id, evidence);
}

export function listEvidence(store: Store): EngineeringEvidence[] {
  return store
    .listCanonIds(EVIDENCE_CANON_TYPE)
    .map((id) => {
      const env = store.getCanon<unknown>(EVIDENCE_CANON_TYPE, id);
      if (env === undefined) return undefined;
      const parsed = EngineeringEvidenceSchema.safeParse(env.body);
      return parsed.success ? parsed.data : undefined;
    })
    .filter((e): e is EngineeringEvidence => e !== undefined);
}

/**
 * Is this evidence still about the change in front of us?
 *
 * DERIVED, never stored (31 VD-1). Evidence measured against one ChangeSet is STALE for
 * a different one — which is the mechanical answer to "the tests passed earlier".
 * They did. They passed against something else.
 */
export function deriveEvidenceValidity(
  evidence: EngineeringEvidence,
  currentChangeSetId: string,
): ValidityState {
  return evidence.changeSetId === currentChangeSetId ? ValidityState.VALID : ValidityState.STALE;
}

export function evidenceForChangeSet(
  store: Store,
  changeSetId: string,
): { valid: EngineeringEvidence[]; stale: EngineeringEvidence[] } {
  const valid: EngineeringEvidence[] = [];
  const stale: EngineeringEvidence[] = [];
  for (const e of listEvidence(store)) {
    if (deriveEvidenceValidity(e, changeSetId) === ValidityState.VALID) valid.push(e);
    else stale.push(e);
  }
  return { valid, stale };
}
