import { EvidenceClass } from '../vocab/index.js';
import {
  ExecutionOutcome,
  EngineeringEvidenceSchema,
  recordEvidence,
  runRecipe,
  type CommandExecutionRecord,
  type EngineeringEvidence,
  type ExecutorDeps,
} from './execution.js';
import { checkScopeConformance, type ChangeSet, type ScopeOptions } from './changeset.js';
import { scanChangeSetForSecrets, redactedReport } from './secrets.js';
import type { RecipeRegistry } from './recipe.js';
import type { EngineeringWorkspace } from './workspace.js';

/**
 * The deterministic Runtime Components. SPEC: 30 §5, Phase 4 §12.
 *
 * These are **not agents**. There is no model here, no prompt and no judgement: each
 * one runs a registered recipe or a pure check and records what it observed.
 *
 * That is the whole reason they exist. A Producer saying "the tests pass" is a claim
 * about the world. `SC-RTC-012` observing exit code 0 for a named recipe against a
 * named ChangeSet is a fact about the world, and only the second can support a gate.
 *
 * Every executor produces evidence with basis MEASURED, bound to the ChangeSet it ran
 * against — which is what makes a later edit make the result stale rather than wrong.
 */

export const RuntimeComponent = {
  /** Scope Conformance Checker — compares observed diff against declared scope. */
  SCOPE: 'SC-RTC-005',
  /** Build Executor. */
  BUILD: 'SC-RTC-011',
  /** Test Executor. */
  TEST: 'SC-RTC-012',
  /** Standards & Lint Checker. */
  LINT: 'SC-RTC-013',
  /** Secrets Scanner. */
  SECRETS: 'SC-RTC-015',
} as const;
export type RuntimeComponent = (typeof RuntimeComponent)[keyof typeof RuntimeComponent];

export interface ExecutorContext {
  readonly deps: ExecutorDeps;
  readonly recipes: RecipeRegistry;
  readonly workspace: EngineeringWorkspace;
  readonly changeSet: ChangeSet;
  readonly projectRoot: string;
  readonly correlationId?: string;
}

export interface ExecutorOutcome {
  readonly component: RuntimeComponent;
  readonly evidence: EngineeringEvidence;
  readonly execution?: CommandExecutionRecord;
}

/** Common shape: run a recipe, turn what was observed into evidence, store both. */
async function runAndRecord(
  ctx: ExecutorContext,
  component: RuntimeComponent,
  recipeId: string,
  claim: string,
): Promise<ExecutorOutcome> {
  const recipe = ctx.recipes.get(recipeId);
  const execution = await runRecipe(ctx.deps, {
    recipe,
    workItemId: ctx.workspace.workItemId,
    workspaceId: ctx.workspace.workspaceId,
    workspacePath: ctx.workspace.path,
    projectRoot: ctx.projectRoot,
    baseCommit: ctx.workspace.baseCommit,
    headCommit: ctx.changeSet.headCommit,
    changeSetId: ctx.changeSet.changeSetId,
    ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
  });

  /*
   * A refusal or a timeout is INDETERMINATE, not FAIL.
   *
   * The distinction is load-bearing: FAIL says the code is wrong, INDETERMINATE says
   * we could not find out. Reporting "the substrate refused to run the tests" as a
   * test failure would blame the change for the machine, and 31 §4.1.1 routes the two
   * to different verdicts precisely so that cannot happen.
   */
  const outcome: EngineeringEvidence['outcome'] =
    execution.outcome === ExecutionOutcome.SUCCEEDED
      ? 'PASS'
      : execution.outcome === ExecutionOutcome.FAILED
        ? 'FAIL'
        : 'INDETERMINATE';

  const evidence = EngineeringEvidenceSchema.parse({
    id: ctx.deps.ids.next('SC-EEV'),
    evidenceClass: recipe.evidenceClass,
    claim,
    basis: 'MEASURED',
    workItemId: ctx.workspace.workItemId,
    changeSetId: ctx.changeSet.changeSetId,
    workspaceId: ctx.workspace.workspaceId,
    headCommit: ctx.changeSet.headCommit,
    executionId: execution.executionId,
    runtimeComponentId: component,
    outcome,
    detail:
      recipe.id +
      ' -> ' +
      execution.outcome +
      ' (exit ' +
      String(execution.exitCode) +
      '): ' +
      execution.terminationReason,
    capturedAt: ctx.deps.clock.now(),
    // SC-POL-023: only the runtime captures evidence. There is no other value here.
    capturedBy: 'RUNTIME',
  });

  const tx = ctx.deps.store.begin();
  recordEvidence(tx, evidence);
  tx.commit();

  return { component, evidence, execution };
}

/** SC-RTC-011 — Build Executor. */
export async function runBuild(
  ctx: ExecutorContext,
  recipeId = 'SC-RECIPE-BUILD',
): Promise<ExecutorOutcome> {
  return runAndRecord(ctx, RuntimeComponent.BUILD, recipeId, 'The workspace builds.');
}

/** SC-RTC-012 — Test Executor. The one whose result a Producer cannot assert. */
export async function runTests(
  ctx: ExecutorContext,
  recipeId = 'SC-RECIPE-UNIT-TEST',
): Promise<ExecutorOutcome> {
  return runAndRecord(
    ctx,
    RuntimeComponent.TEST,
    recipeId,
    'The declared test suite passes against this ChangeSet.',
  );
}

/** SC-RTC-013 — Standards & Lint Checker. */
export async function runLint(
  ctx: ExecutorContext,
  recipeId = 'SC-RECIPE-LINT',
): Promise<ExecutorOutcome> {
  return runAndRecord(
    ctx,
    RuntimeComponent.LINT,
    recipeId,
    'The change conforms to the project standards.',
  );
}

/**
 * SC-RTC-005 — Scope Conformance Checker.
 *
 * Pure: no command runs. It compares the diff Serva observed against the scope the
 * work item declared, so there is nothing to execute and nothing to sandbox.
 */
export function runScopeCheck(ctx: ExecutorContext, options: ScopeOptions): ExecutorOutcome {
  const result = checkScopeConformance(ctx.workspace, ctx.changeSet, options);
  const evidence = EngineeringEvidenceSchema.parse({
    id: ctx.deps.ids.next('SC-EEV'),
    evidenceClass: EvidenceClass.ANALYSIS,
    claim: 'The change stays inside the declared scope.',
    // DERIVED, not MEASURED: computed from stored state rather than from an execution.
    basis: 'DERIVED',
    workItemId: ctx.workspace.workItemId,
    changeSetId: ctx.changeSet.changeSetId,
    workspaceId: ctx.workspace.workspaceId,
    headCommit: ctx.changeSet.headCommit,
    runtimeComponentId: RuntimeComponent.SCOPE,
    outcome: result.conformant ? 'PASS' : 'FAIL',
    detail: result.conformant
      ? String(result.checked) + ' changed path(s), all within scope'
      : result.findings.map((f) => f.kind + ' ' + f.path + ': ' + f.detail).join('; '),
    capturedAt: ctx.deps.clock.now(),
    capturedBy: 'RUNTIME',
  });
  const tx = ctx.deps.store.begin();
  recordEvidence(tx, evidence);
  tx.commit();
  return { component: RuntimeComponent.SCOPE, evidence };
}

/**
 * SC-RTC-015 — Secrets Scanner.
 *
 * The detail recorded is the REDACTED report. A discovered credential never enters the
 * store, never reaches a model, and never appears in an evidence record: a check that
 * leaked what it found would be worse than no check.
 */
export function runSecretsScan(ctx: ExecutorContext): ExecutorOutcome {
  const result = scanChangeSetForSecrets(ctx.workspace, ctx.changeSet);
  /*
   * A SCAN THAT SKIPPED A FILE HAS NOT ANSWERED THE QUESTION.
   *
   * SPEC: findings SEC-SCAN-LARGEFILE-1 and SEC-SCAN-SKIP-SILENT-2 (both MEDIUM), 1.0.1 review.
   *
   * EC-SECRETS is BLOCKING and reads "The change introduces no committed credential". This
   * recorded PASS whenever no finding came back, including when the reason no finding came
   * back was that the file was never opened - so the way past a blocking gate was to be too
   * large to read.
   *
   * INDETERMINATE is the word the gate engine already has for it, and it is not a softening:
   * a BLOCKING criterion with an INDETERMINATE result never composes to PASS. FAIL would have
   * been the wrong word, because FAIL says a credential is there and nobody knows that.
   */
  const outcome = result.findings.some((f) => f.severity === 'HIGH')
    ? 'FAIL'
    : result.complete
      ? 'PASS'
      : 'INDETERMINATE';
  const evidence = EngineeringEvidenceSchema.parse({
    id: ctx.deps.ids.next('SC-EEV'),
    evidenceClass: EvidenceClass.ANALYSIS,
    claim: result.complete
      ? 'The change introduces no credential-shaped content matching the rule set.'
      : 'Whether the change introduces credential-shaped content is unanswered: ' +
        String(result.notScanned.length) +
        ' file(s) in it were never read.',
    basis: 'DERIVED',
    workItemId: ctx.workspace.workItemId,
    changeSetId: ctx.changeSet.changeSetId,
    workspaceId: ctx.workspace.workspaceId,
    headCommit: ctx.changeSet.headCommit,
    runtimeComponentId: RuntimeComponent.SECRETS,
    outcome,
    detail: redactedReport(result),
    capturedAt: ctx.deps.clock.now(),
    capturedBy: 'RUNTIME',
  });
  const tx = ctx.deps.store.begin();
  recordEvidence(tx, evidence);
  tx.commit();
  return { component: RuntimeComponent.SECRETS, evidence };
}

/** Which components a change of this shape needs. */
export interface RequiredChecks {
  readonly scope: boolean;
  readonly build: boolean;
  readonly tests: boolean;
  readonly lint: boolean;
  readonly secrets: boolean;
  readonly codeReview: boolean;
  readonly qaVerification: boolean;
}

export const DEFAULT_REQUIRED_CHECKS: RequiredChecks = Object.freeze({
  scope: true,
  build: true,
  tests: true,
  lint: true,
  secrets: true,
  codeReview: true,
  // QA verification is required for behaviour-bearing work, and the work item says so.
  qaVerification: false,
});
