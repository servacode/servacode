import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GateVerdict, RunOutcome } from '../src/vocab/index.js';
import { FAKE_CAPABILITIES, FakeEngineAdapter } from '../src/engine/fake.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { ContractRegistry } from '../src/agents/registry.js';
import {
  SimulatedExecutionSubstrate,
  makeFixtureDir,
  removeFixtureDir,
} from '../src/substrate/fake.js';
import { GitService } from '../src/engineering/git.js';
import { EngineeringWorkspaceManager } from '../src/engineering/workspace.js';
import { RecipeRegistry, ExecutionRecipeSchema } from '../src/engineering/recipe.js';
import { EngineeringFactory } from '../src/engineering/factory.js';
import { DEFAULT_REQUIRED_CHECKS } from '../src/engineering/executors.js';
import { dispatchProducer, dispatchReviewer } from '../src/engineering/dispatch.js';
import { listReviews, validateReviewerResult } from '../src/engineering/review.js';
import { EvidenceClass } from '../src/vocab/index.js';
import { buildSandboxProfile } from '../src/engineering/sandboxProfile.js';
import {
  BoundaryPurpose,
  executionBoundary,
  type ExecutionBoundary,
} from '../src/substrate/boundary.js';
import { cleanup, freshStore } from './helpers.js';
import type { ExecutionRecipe } from '../src/engineering/recipe.js';
import type { ExecutorDeps } from '../src/engineering/execution.js';

/**
 * THE COMPANY ACTUALLY RUNS.
 *
 * Blocker 2: Phase 4 had policies, sandbox profiles, workspaces, executors and a gate,
 * and no path from any of it to `AgentRuntime`. The live acceptance stood a
 * `writeFileSync` in for the Producer and a string literal in for the Reviewer, so the
 * one thing the phase is FOR — a governed agent changing code under a measured
 * boundary, judged by an independent one — had never happened.
 *
 * These tests dispatch both agents for real, through the Phase 3 runtime, with a
 * scripted engine so that **no automated test spends a model call**. What is under test
 * is Serva's governance: the grant it computes, the boundary it proves before
 * dispatching, the run it records, and what it refuses to accept.
 */

const roots: string[] = [];
const fixtures: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
  for (const f of fixtures.splice(0)) removeFixtureDir(f);
});

const registry = ContractRegistry.shared();
const PRODUCER = 'SC-AGENT-150';
const REVIEWER = 'SC-AGENT-200';

function nodeRecipe(id: string, args: string[], component: string): ExecutionRecipe {
  return ExecutionRecipeSchema.parse({
    id,
    purpose: 'Fixture recipe.',
    executable: 'node',
    args,
    cwdPolicy: 'WORKSPACE',
    environmentPolicy: 'MINIMAL',
    networkPolicy: 'NONE',
    timeoutMs: 60_000,
    maxOutputBytes: 500_000,
    successExitCodes: [0],
    evidenceClass: EvidenceClass.EXECUTION,
    runtimeComponentId: component,
    applicability: 'The disposable fixture repository only.',
  });
}

/**
 * A simulated PRODUCER boundary matching the scripted engine's own location.
 *
 * Orchestration has to be testable without a qualified machine. The boundary is marked
 * simulated — the fixture does not get to describe itself as measured — so every use of
 * it must also pass the explicit `allowSimulatedBoundary` opt-in, which nothing in
 * `src/` does.
 */
function simulatedProducerBoundary(projectRoot: string): ExecutionBoundary {
  return executionBoundary({
    boundaryId: 'SC-BOUNDARY-PRODUCER',
    purpose: BoundaryPurpose.PRODUCER,
    transport: 'fake',
    engineLocation: 'fake-engine',
    engineVersion: FAKE_CAPABILITIES.version,
    sandboxMechanism: 'simulated',
    profileDigest: buildSandboxProfile({
      worktreePath: join(projectRoot, 'w'),
      projectRoot,
      networkAllowed: false,
    }).policyDigest,
    simulated: true,
  });
}

async function setup(
  o: { enforcement?: 'HARD' | 'SOFT' | 'NONE'; boundary?: ExecutionBoundary } = {},
) {
  const { store, root, deps } = freshStore();
  roots.push(root);

  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const g = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(join(repo, 'package.json'), '{"name":"fx","private":true}\n', 'utf8');
  writeFileSync(join(repo, 'test.js'), 'process.exit(0);\n', 'utf8');
  writeFileSync(join(repo, 'src', 'total.js'), 'module.exports = 1;\n', 'utf8');
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'fx@localhost');
  g('config', 'user.name', 'Fixture');
  g('config', 'commit.gpgsign', 'false');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD').trim();

  const git = new GitService({ repoRoot: repo });
  const workspaces = new EngineeringWorkspaceManager({
    store,
    git,
    clock: deps.clock,
    projectRoot: repo,
  });
  const substrate = new SimulatedExecutionSubstrate({
    clock: deps.clock,
    enforcement: o.enforcement ?? 'HARD',
    boundary: o.boundary ?? simulatedProducerBoundary(repo),
  });
  const fixtureDir = makeFixtureDir();
  fixtures.push(fixtureDir);
  const qualification = await substrate.qualify(fixtureDir);

  const engine = new FakeEngineAdapter({ clock: deps.clock });
  const runtime = new AgentRuntime({
    store,
    ids: deps.ids,
    clock: deps.clock,
    registry,
    engine,
    enabledAgents: new Set([PRODUCER, REVIEWER]),
    projectRoot: repo,
  });

  const recipes = new RecipeRegistry([
    nodeRecipe('SC-RECIPE-UNIT-TEST', ['test.js'], 'SC-RTC-012'),
  ]);
  const executorDeps: ExecutorDeps = {
    store,
    clock: deps.clock,
    ids: deps.ids,
    substrate,
    qualification,
    env: process.env,
  };
  const factory = new EngineeringFactory({
    store,
    git,
    workspaces,
    recipes,
    registry,
    qualification,
    executorDeps,
    gateDeps: { ids: deps.ids, clock: deps.clock, evaluator: 'ENGINEERING_GATE' },
    projectRoot: repo,
    enabledProducers: new Set([PRODUCER]),
    producerBoundary: qualification.boundary,
    allowSimulatedBoundary: true,
  });

  const dispatchDeps = {
    engineCapabilities: await engine.capabilities(),
    engineVersion: FAKE_CAPABILITIES.version,
    allowSimulatedBoundary: true,
    store,
    clock: deps.clock,
    ids: deps.ids,
    runtime,
    registry,
    substrate,
    qualification,
    projectRoot: repo,
    enabledProducers: new Set([PRODUCER]),
  };

  return {
    store,
    deps,
    repo,
    base,
    git,
    workspaces,
    substrate,
    qualification,
    engine,
    runtime,
    recipes,
    factory,
    dispatchDeps,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

/**
 * The engine returns an OutputEnvelope; `result` is the role payload inside it.
 *
 * Scripting only the payload made every run terminate INVALID_OUTPUT, which is the
 * runtime refusing a malformed envelope exactly as it should.
 */
function envelope(result: unknown): Record<string, unknown> {
  return {
    status: 'COMPLETED',
    result,
    selfReview: {
      contractConformance: 'stayed within the contract',
      scopeConformance: 'within the declared scope',
      knownGaps: [],
      confidence: 'MEDIUM',
      assumptionsMade: [],
    },
    observations: [],
    escalations: [],
    evidenceClaims: [],
    unresolved: [],
  };
}

const WORK_ITEM = {
  workItemId: 'SC-WI-000300',
  title: 'total() must sum every element',
  requirements: ['total([1,2,3]) returns 6.'],
  acceptanceCriteria: ['The declared test suite passes.'],
  decisions: [],
  allowedScope: ['src/'],
  forbiddenScope: [],
  producerAgentId: PRODUCER,
  reviewerAgentId: REVIEWER,
  recipes: ['SC-RECIPE-UNIT-TEST'],
  magnitude: 'M1',
  baseCommit: 'placeholder',
  expectedOutputs: [],
  maxAttempts: 2,
};

/* ============================================================ producer dispatch */

describe('the Producer is dispatched through the one runtime, or not at all', () => {
  it('runs in its own worktree with a write grant the contract allows', async () => {
    const f = await setup();
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));

    f.engine.script(PRODUCER, {
      structuredOutput: envelope({
        summary: 'edited',
        claimedPaths: ['src/total.js'],
        observations: [],
        blockers: [],
      }),
    });

    const d = await dispatchProducer(f.dispatchDeps, {
      item,
      workspace: w,
      taskDefinition: 'Fix total().',
      reviewerAvailable: true,
      executorsAvailable: true,
    });

    expect(d.outcome).toBe(RunOutcome.COMPLETED);
    const request = f.engine.seen.at(-1);
    expect(request).toBeDefined();
    // The working directory is the WORKTREE, which is what makes every relative
    // permission rule in the grant mean "inside this worktree" and nothing wider.
    expect(request?.cwd).toBe(w.path);
    expect(request?.cwd).not.toBe(f.repo);
    expect(request?.tools.available).toContain('Edit');
    expect(request?.tools.deny).toContain('Bash(git push*)');
    expect(request?.tools.filesystem.write).toEqual([w.path]);
    expect(request?.tools.network).toBe('NONE');
  }, 60_000);

  it('the sandbox profile Serva generated is passed to the invocation', async () => {
    const f = await setup();
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    f.engine.script(PRODUCER, {
      structuredOutput: envelope({
        summary: 'x',
        claimedPaths: [],
        observations: [],
        blockers: [],
      }),
    });

    const d = await dispatchProducer(f.dispatchDeps, {
      item,
      workspace: w,
      taskDefinition: 'Fix total().',
      reviewerAvailable: true,
      executorsAvailable: true,
    });

    // Previously these functions existed and nothing called them.
    expect(d.sandboxProfile.digest).toHaveLength(64);
    expect(f.engine.seen[0]?.settingsPath).toBeDefined();
    expect(f.engine.seen[0]?.settingsPath).toContain('.serva');
    const sandbox = d.sandboxProfile.settings['sandbox'] as Record<string, unknown>;
    expect(sandbox['failIfUnavailable']).toBe(true);
    expect(sandbox['allowUnsandboxedCommands']).toBe(false);
  }, 60_000);

  it('the capability grant is recorded on the run, with its basis', async () => {
    const f = await setup();
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    f.engine.script(PRODUCER, {
      structuredOutput: envelope({
        summary: 'x',
        claimedPaths: [],
        observations: [],
        blockers: [],
      }),
    });
    const d = await dispatchProducer(f.dispatchDeps, {
      item,
      workspace: w,
      taskDefinition: 'Fix total().',
      reviewerAvailable: true,
      executorsAvailable: true,
    });

    const events = f.store.readTrace('agentrun/' + d.runId);
    const bound = events.find((e) => e.type === 'CAPABILITY_BOUND');
    expect(bound).toBeDefined();
    const payload = bound?.payload as { rationale: string[]; available: string[] };
    expect(payload.available).toContain('Edit');
    // "What could run X do?" must be answerable from the log alone (19 CX-5).
    expect(payload.rationale.join(' ')).toMatch(/grant basis: engineering producer/);
    expect(payload.rationale.join(' ')).toMatch(/sandbox profile: [0-9a-f]{64}/);
  }, 60_000);

  it('an unqualified substrate refuses before any model call is made', async () => {
    const f = await setup({ enforcement: 'SOFT' });
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });

    await expect(
      dispatchProducer(f.dispatchDeps, {
        item,
        // No workspace could be opened on a SOFT substrate, so this is the shape a
        // caller would reach for; the refusal happens before it matters.
        workspace: { path: f.repo, workspaceId: 'x' } as never,
        taskDefinition: 'Fix total().',
        reviewerAvailable: true,
        executorsAvailable: true,
      }),
    ).rejects.toThrowError(/requires HARD/);
    expect(f.engine.seen).toHaveLength(0);
  }, 60_000);

  it('no reviewer means no dispatch, and no model call', async () => {
    const f = await setup();
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));

    await expect(
      dispatchProducer(f.dispatchDeps, {
        item,
        workspace: w,
        taskDefinition: 'Fix total().',
        reviewerAvailable: false,
        executorsAvailable: true,
      }),
    ).rejects.toThrowError(/never certifies its own work/);
    expect(f.engine.seen).toHaveLength(0);
  }, 60_000);

  it('a grant wider than the contract is refused by the runtime itself', async () => {
    const f = await setup();
    // The reviewer's contract declares no filesystem write. Handing it a Producer-shaped
    // grant must fail inside AgentRuntime, not merely at the engineering gate: a grant
    // implements a contract, it does not extend one.
    await expect(
      f.runtime.run({
        agentId: REVIEWER,
        workItemId: 'SC-WI-000300',
        taskDefinition: 'x',
        scopeBoundary: 'x',
        resultSchema: { type: 'object' },
        resultValidator: { safeParse: () => ({ success: true as const }) },
        capability: {
          policy: {
            available: ['Read', 'Edit', 'Bash'],
            approve: [],
            deny: [],
            filesystem: { read: [], write: [f.repo], readDenied: [] },
            network: 'NONE',
            maxToolCalls: 10,
            rationale: [],
          },
          cwd: f.repo,
          basis: 'a caller trying it on',
        },
      }),
    ).rejects.toThrowError(/declares no filesystem write/);
    expect(f.engine.seen).toHaveLength(0);
  }, 60_000);
});

/* ============================================================ reviewer dispatch */

describe('the reviewer is a separate, independent, read-only run', () => {
  async function verified(f: Fixture) {
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));

    /*
     * A REAL PRODUCER RUN, because the reviewer is judged against one.
     *
     * SPEC: finding ENGINEERING-ACCEPTANCE-AUTHORITY/EAA-1 (MEDIUM), 1.0.1 security review.
     *
     * This fixture wrote the file itself and then dispatched a reviewer with no Producer run
     * to name — a shape production never takes, since app/implement.ts always passes
     * producerRunRef. Independence used to be SKIPPED when the reference was absent, so the
     * gap in the validator and the gap in the fixture agreed with each other, and neither
     * matched the product. Requiring the reference exposed both at once.
     */
    f.engine.script(PRODUCER, {
      structuredOutput: envelope({
        summary: 'fix total',
        claimedPaths: ['src/total.js'],
        observations: [],
        blockers: [],
      }),
    });
    const produced = await dispatchProducer(f.dispatchDeps, {
      item,
      workspace: w,
      taskDefinition: 'Fix total().',
      reviewerAvailable: true,
      executorsAvailable: true,
    });

    writeFileSync(join(w.path, 'src', 'total.js'), 'module.exports = 2;\n', 'utf8');
    const v = await f.factory.verifyAttempt(item, w, {
      required: { ...DEFAULT_REQUIRED_CHECKS, build: false, lint: false, codeReview: false },
    });
    return { item, w, v, producerRunRef: produced.runId };
  }

  it('is dispatched with no write tool, into its own run', async () => {
    const f = await setup();
    const { item, w, v, producerRunRef } = await verified(f);
    f.engine.script(REVIEWER, {
      structuredOutput: envelope({
        criterionId: 'EC-REVIEW',
        outcome: 'PASS',
        changeSetId: v.changeSet.changeSetId,
        summary: 'Correct and in scope.',
        findings: [],
        confidence: 'HIGH',
      }),
    });

    const d = await dispatchReviewer(f.dispatchDeps, {
      item,
      workspace: w,
      changeSet: v.changeSet,
      evidence: v.evidence,
      diff: await f.git.diff(f.base, w.path),
      producerRunRef,
    });

    expect(d.review?.outcome).toBe('PASS');
    const request = f.engine.seen.at(-1);
    expect(request?.tools.available).not.toContain('Edit');
    expect(request?.tools.available).not.toContain('Bash');
    expect(request?.tools.filesystem.write).toEqual([]);
    // A fresh session, never continued: two runs sharing one session share context.
    expect(request?.sessionPolicy).toBe('NEW');
  }, 60_000);

  it('sees the evidence and the diff, and not the Producer reasoning', async () => {
    const f = await setup();
    const { item, w, v, producerRunRef } = await verified(f);
    f.engine.script(REVIEWER, {
      structuredOutput: envelope({
        criterionId: 'EC-REVIEW',
        outcome: 'PASS',
        changeSetId: v.changeSet.changeSetId,
        summary: 'ok',
        findings: [],
        confidence: 'MEDIUM',
      }),
    });
    await dispatchReviewer(f.dispatchDeps, {
      item,
      workspace: w,
      changeSet: v.changeSet,
      evidence: v.evidence,
      diff: 'DIFF-MARKER-TEXT',
      producerRunRef,
    });

    const reviewerCall = f.engine.seen.at(-1);
    const prompt = (reviewerCall?.systemPrompt ?? '') + (reviewerCall?.prompt ?? '');
    expect(prompt).toContain(v.changeSet.changeSetId);
    expect(prompt).toContain('DIFF-MARKER-TEXT');
    expect(prompt).toContain('SC-RTC-012');
    // A reviewer that can read the argument reviews the argument, not the artifact.
    expect(prompt).not.toContain('Fixed the loop bound');
  }, 60_000);

  it('a verdict about a different ChangeSet is refused, not recorded', async () => {
    const f = await setup();
    const { item, w, v, producerRunRef } = await verified(f);
    f.engine.script(REVIEWER, {
      structuredOutput: envelope({
        criterionId: 'EC-REVIEW',
        outcome: 'PASS',
        changeSetId: 'SC-CS-SOMETHING-ELSE',
        summary: 'ok',
        findings: [],
        confidence: 'HIGH',
      }),
    });

    await expect(
      dispatchReviewer(f.dispatchDeps, {
        item,
        workspace: w,
        changeSet: v.changeSet,
        evidence: v.evidence,
        diff: '',
        producerRunRef,
      }),
    ).rejects.toThrowError(/reports on ChangeSet SC-CS-SOMETHING-ELSE/);
    expect(listReviews(f.store)).toHaveLength(0);
  }, 60_000);

  it('a rejection with no findings is not a usable verdict', async () => {
    const f = await setup();
    const { item, w, v, producerRunRef } = await verified(f);
    f.engine.script(REVIEWER, {
      structuredOutput: envelope({
        criterionId: 'EC-REVIEW',
        outcome: 'FAIL',
        changeSetId: v.changeSet.changeSetId,
        summary: 'no',
        findings: [],
        confidence: 'HIGH',
      }),
    });
    // A Producer told only "no" will guess. The schema refuses the verdict, the run
    // ends INVALID_OUTPUT, and NO EVIDENCE = NOT VERIFIED.
    const d = await dispatchReviewer(f.dispatchDeps, {
      item,
      workspace: w,
      changeSet: v.changeSet,
      evidence: v.evidence,
      diff: '',
      producerRunRef,
    });
    expect(d.review).toBeUndefined();
    expect(d.problems.join(' ')).toMatch(/NO EVIDENCE = NOT VERIFIED/);
  }, 60_000);

  it('an agent reviewing its own work is refused', async () => {
    const f = await setup();
    const item = f.factory.recordWorkItem({
      ...WORK_ITEM,
      baseCommit: f.base,
      // The work item schema forbids this, so reach past it to prove the dispatch
      // check is independent rather than a restatement of the schema.
    });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    await expect(
      dispatchReviewer(f.dispatchDeps, {
        item: { ...item, reviewerAgentId: PRODUCER },
        workspace: w,
        changeSet: { changeSetId: 'SC-CS-1' } as never,
        evidence: [],
        diff: '',
      }),
    ).rejects.toThrowError(/never certifies its own work/);
  }, 60_000);
});

/* ==================================================== the anti-fabrication checks */

describe('a reviewer verdict must be traceable to a real run', () => {
  const verdict = (changeSetId: string) => ({
    criterionId: 'EC-REVIEW' as const,
    outcome: 'PASS' as const,
    changeSetId,
    summary: 'ok',
    findings: [],
    confidence: 'HIGH' as const,
  });

  it('a runRef naming no run is refused outright', async () => {
    const f = await setup();
    const v = validateReviewerResult({
      store: f.store,
      runRef: 'SC-RUN-INVENTED',
      expectedReviewerAgentId: REVIEWER,
      producerAgentId: PRODUCER,
      changeSetId: 'SC-CS-1',
      workItemId: 'SC-WI-000300',
      verdict: verdict('SC-CS-1'),
    });
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toMatch(/No AgentRun SC-RUN-INVENTED exists/);
  });

  it('a run by the wrong agent is refused', async () => {
    const f = await setup();
    const { item, w, v } = await (async () => {
      const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
      const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
      writeFileSync(join(w.path, 'src', 'total.js'), 'module.exports = 2;\n', 'utf8');
      const v = await f.factory.verifyAttempt(item, w, {
        required: { ...DEFAULT_REQUIRED_CHECKS, build: false, lint: false, codeReview: false },
      });
      return { item, w, v };
    })();

    f.engine.script(REVIEWER, {
      structuredOutput: verdict(v.changeSet.changeSetId),
    });
    const d = await dispatchReviewer(f.dispatchDeps, {
      item,
      workspace: w,
      changeSet: v.changeSet,
      evidence: v.evidence,
      diff: '',
    });

    // The run is real, but it is not the agent this criterion requires.
    const wrong = validateReviewerResult({
      store: f.store,
      runRef: d.runId,
      expectedReviewerAgentId: 'SC-AGENT-214',
      producerAgentId: PRODUCER,
      changeSetId: v.changeSet.changeSetId,
      workItemId: item.workItemId,
      verdict: verdict(v.changeSet.changeSetId),
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.problems.join(' ')).toMatch(/not by the expected reviewer/);
  }, 60_000);

  it('a run that had write tools is not a review', async () => {
    const f = await setup();
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    f.engine.script(PRODUCER, {
      structuredOutput: envelope({
        summary: 'x',
        claimedPaths: [],
        observations: [],
        blockers: [],
      }),
    });
    const d = await dispatchProducer(f.dispatchDeps, {
      item,
      workspace: w,
      taskDefinition: 'x',
      reviewerAvailable: true,
      executorsAvailable: true,
    });

    const v = validateReviewerResult({
      store: f.store,
      runRef: d.runId,
      expectedReviewerAgentId: PRODUCER,
      producerAgentId: PRODUCER,
      changeSetId: 'SC-CS-1',
      workItemId: item.workItemId,
      verdict: verdict('SC-CS-1'),
    });
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toMatch(/write or execute tools available/);
    expect(v.problems.join(' ')).toMatch(/never certifies its own work/);
  }, 60_000);
});

/* ============================================================== end to end */

describe('a governed change goes all the way to an accepted commit', () => {
  it('Producer edits, runtime measures, reviewer judges, Serva integrates', async () => {
    const f = await setup();
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));

    // The Producer's edit is the scripted engine's side effect, exactly as a real
    // session's Edit tool call would be. No model call is spent.
    f.engine.script(PRODUCER, {
      structuredOutput: envelope({
        summary: 'Fixed the loop bound.',
        claimedPaths: ['src/total.js'],
        observations: [],
        blockers: [],
      }),
    });
    const producer = await dispatchProducer(f.dispatchDeps, {
      item,
      workspace: w,
      taskDefinition: 'Fix total().',
      reviewerAvailable: true,
      executorsAvailable: true,
    });
    expect(producer.outcome).toBe(RunOutcome.COMPLETED);
    writeFileSync(join(w.path, 'src', 'total.js'), 'module.exports = 2;\n', 'utf8');

    // Serva computes the ChangeSet and measures it. The Producer's claimedPaths are
    // recorded and not consulted.
    const measured = await f.factory.verifyAttempt(item, w, {
      required: { ...DEFAULT_REQUIRED_CHECKS, build: false, lint: false, codeReview: false },
      producerRunId: producer.runId,
    });
    expect(measured.evidence.some((e) => e.outcome === 'PASS')).toBe(true);

    f.engine.script(REVIEWER, {
      structuredOutput: envelope({
        criterionId: 'EC-REVIEW',
        outcome: 'PASS',
        changeSetId: measured.changeSet.changeSetId,
        summary: 'The loop bound was the defect; minimal and in scope.',
        findings: [],
        confidence: 'HIGH',
      }),
    });
    const review = await dispatchReviewer(f.dispatchDeps, {
      item,
      workspace: w,
      changeSet: measured.changeSet,
      evidence: measured.evidence,
      diff: await f.git.diff(f.base, w.path),
      producerRunRef: producer.runId,
    });
    expect(review.review?.runRef).toBe(review.runId);

    // Re-verify with the review required. The judged input now comes from the store.
    const final = await f.factory.verifyAttempt(item, w, {
      required: { ...DEFAULT_REQUIRED_CHECKS, build: false, lint: false },
      producerRunId: producer.runId,
    });
    expect(final.usedUnvalidatedJudgement).toBe(false);
    expect(final.gateResult.verdict).toBe(GateVerdict.PASS_WITH_QUALIFICATION);
    expect(final.attemptOutcome).toBe('ACCEPTED');

    const { commit } = await f.factory.acceptChange(item, w, final);
    const message = execFileSync('git', ['log', '-1', '--format=%B', commit], {
      cwd: w.path,
      encoding: 'utf8',
    });
    expect(message).toContain(item.workItemId);
    expect(message).toContain(final.changeSet.changeSetId);
    expect(message).toContain(PRODUCER);
    expect(message).toContain(REVIEWER);

    // Two runs, two sessions, and the owner's checkout untouched.
    expect(producer.runId).not.toBe(review.runId);
    expect(f.engine.seen).toHaveLength(2);
    expect(f.engine.seen[0]?.runId).not.toBe(f.engine.seen[1]?.runId);
    expect(await f.git.isClean(f.repo)).toBe(true);
    expect(await f.git.headCommit(f.repo)).toBe(f.base);
  }, 120_000);

  it('a Producer that says the tests pass does not make them pass', async () => {
    /*
     * THE NEGATIVE CASE THAT MATTERS.
     *
     * The Producer reports, in its structured result, that it ran the suite and that it
     * passed — and leaves the code broken. Nothing in Serva reads that claim when
     * deciding: the recipe is executed, its exit code is the evidence, and the gate is
     * computed from evidence. A change set can be accepted only by something that
     * actually ran.
     *
     * This is the difference between a company that measures and one that believes its
     * staff, and it has to be a test rather than a design intention, because the failure
     * mode is silent: a fabricated pass looks exactly like a real one in the summary.
     */
    const f = await setup();

    /*
     * A suite that actually checks the code. The shared fixture's `test.js` exits 0
     * unconditionally, which is fine for tests about plumbing and useless here: a suite
     * that cannot fail cannot contradict anybody.
     */
    const g = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: f.repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    writeFileSync(
      join(f.repo, 'test.js'),
      [
        "const total = require('./src/total.js');",
        'if (total !== 1) {',
        '  console.error("expected 1, got " + total);',
        '  process.exit(1);',
        '}',
        'process.exit(0);',
        '',
      ].join('\n'),
      'utf8',
    );
    g('add', 'test.js');
    g('commit', '-q', '-m', 'a suite that can fail');
    const base = g('rev-parse', 'HEAD').trim();

    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));

    f.engine.script(PRODUCER, {
      structuredOutput: envelope({
        /*
         * The false claim has to go in prose, because `ProducerResultSchema` is strict
         * and gives a Producer no field in which to report a test outcome at all. That
         * is the first line of the defence: there is nowhere to put the lie that Serva
         * would read.
         */
        summary: 'Fixed the loop bound and ran the unit suite: SC-RECIPE-UNIT-TEST passes.',
        claimedPaths: ['src/total.js'],
        observations: [],
        blockers: [],
      }),
    });
    const producer = await dispatchProducer(f.dispatchDeps, {
      item,
      workspace: w,
      taskDefinition: 'Fix total().',
      reviewerAvailable: true,
      executorsAvailable: true,
    });
    expect(producer.outcome).toBe(RunOutcome.COMPLETED);

    // ...and the code is left in a state the suite rejects. The claim above is false.
    writeFileSync(join(w.path, 'src', 'total.js'), 'module.exports = 0;\n', 'utf8');

    const measured = await f.factory.verifyAttempt(item, w, {
      required: { ...DEFAULT_REQUIRED_CHECKS, build: false, lint: false, codeReview: false },
      producerRunId: producer.runId,
    });

    // The recipe ran, and it failed. Serva's evidence contradicts the Producer's prose.
    const suite = measured.evidence.find((e) => e.runtimeComponentId === 'SC-RTC-012');
    expect(suite?.outcome).toBe('FAIL');
    expect(measured.gateResult.verdict).not.toBe(GateVerdict.PASS);
    expect(measured.gateResult.verdict).not.toBe(GateVerdict.PASS_WITH_QUALIFICATION);
    expect(measured.attemptOutcome).not.toBe('ACCEPTED');

    // And nothing reached the owner's checkout.
    expect(await f.git.isClean(f.repo)).toBe(true);
    expect(await f.git.headCommit(f.repo)).toBe(base);
  }, 120_000);

  it('a reviewer rejection stops the change at the gate', async () => {
    const f = await setup();
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    writeFileSync(join(w.path, 'src', 'total.js'), 'module.exports = 2;\n', 'utf8');

    const measured = await f.factory.verifyAttempt(item, w, {
      required: { ...DEFAULT_REQUIRED_CHECKS, build: false, lint: false, codeReview: false },
    });

    /* A Producer to be independent OF — see the note on `verified` above. */
    f.engine.script(PRODUCER, {
      structuredOutput: envelope({
        summary: 'fix total',
        claimedPaths: ['src/total.js'],
        observations: [],
        blockers: [],
      }),
    });
    const produced = await dispatchProducer(f.dispatchDeps, {
      item,
      workspace: w,
      taskDefinition: 'Fix total().',
      reviewerAvailable: true,
      executorsAvailable: true,
    });

    f.engine.script(REVIEWER, {
      structuredOutput: envelope({
        criterionId: 'EC-REVIEW',
        outcome: 'FAIL',
        changeSetId: measured.changeSet.changeSetId,
        summary: 'Changes behaviour the work item did not ask for.',
        findings: [{ severity: 'BLOCKING', path: 'src/total.js', detail: 'out of scope rewrite' }],
        confidence: 'HIGH',
      }),
    });
    await dispatchReviewer(f.dispatchDeps, {
      item,
      workspace: w,
      changeSet: measured.changeSet,
      evidence: measured.evidence,
      diff: '',
      producerRunRef: produced.runId,
    });

    const final = await f.factory.verifyAttempt(item, w, {
      required: { ...DEFAULT_REQUIRED_CHECKS, build: false, lint: false },
    });
    // Every deterministic check passed. The reviewer is why this does not ship.
    expect(final.gateResult.verdict).toBe(GateVerdict.FAIL);
    expect(final.attemptOutcome).toBe('REWORK');

    /*
     * Refused twice over, and the message now names the REVIEW rather than the verdict.
     *
     * SPEC: finding ENGINEERING-ACCEPTANCE-AUTHORITY/EAA-R1 (MEDIUM), 1.0.1 security review.
     *
     * `acceptChange` reads the persisted review's outcome before it reads the caller-supplied
     * `attemptOutcome`, for the same reason the review-existence check comes first: it does not
     * depend on the verdict at all, so it still holds when the verdict is the thing that is
     * wrong. Both refusals are correct here; asserting the earlier one keeps this test bound to
     * the check that does not rely on its caller.
     */
    await expect(f.factory.acceptChange(item, w, final)).rejects.toThrowError(
      /independent review of ChangeSet .* is FAIL/,
    );
  }, 120_000);
});

describe('independence is established, never assumed from a missing field', () => {
  /*
   * SPEC: finding ENGINEERING-ACCEPTANCE-AUTHORITY/EAA-1 (MEDIUM), 1.0.1 security review.
   *
   * The session-distinctness check lived inside `if (input.producerRunRef !== undefined)`, and
   * the field is optional on both the input and the persisted schema. Omitting it therefore did
   * not fail the check — it REMOVED the check. A reviewer that had shared the Producer's engine
   * session, reviewing the argument rather than the artifact (19 SM-3), validated and persisted
   * cleanly whenever the caller left the reference out.
   *
   * Independence then rested on an optional input rather than on the validator, which is the
   * one place it cannot rest: the caller supplying the reference is the same caller whose
   * independence is in question.
   */
  it('a reviewer that names no Producer run cannot be shown to be independent', async () => {
    const f = await setup();
    const { item, w, v } = await verifiedFor(f);

    f.engine.script(REVIEWER, {
      structuredOutput: envelope({
        criterionId: 'EC-REVIEW',
        outcome: 'PASS',
        changeSetId: v.changeSet.changeSetId,
        summary: 'Looks fine.',
        findings: [],
        confidence: 'HIGH',
      }),
    });

    await expect(
      dispatchReviewer(f.dispatchDeps, {
        item,
        workspace: w,
        changeSet: v.changeSet,
        evidence: v.evidence,
        diff: '',
        /* producerRunRef deliberately absent — the shape the defect allowed through. */
      }),
    ).rejects.toThrowError(/Producer run was not identified/);
  }, 60_000);

  it('a run that recorded no engine session cannot be shown to be independent', async () => {
    /*
     * SPEC: finding EAA-SESSION-RESIDUAL (MEDIUM), 1.0.1 security review.
     *
     * The distinctness check ran only when BOTH runs recorded an `engineSessionRef`, so when
     * either was missing the comparison had nothing to compare and did not refuse - the same
     * shape as EAA-1 above, one field along. A reviewer sharing the Producer's session passed
     * whenever the engine did not report one.
     *
     * The residual's stated reason was that demanding the field would refuse every review under
     * an engine that does not report one. That is measurable, and it was measured: across the
     * 29 governed runs of the 0fe5215d security round, 29 recorded an engineSessionRef. The
     * fake adapter reports one per run too. So the field is present in practice, and requiring
     * it fails CLOSED for an engine that stops reporting it rather than passing silently.
     */
    const f = await setup();
    const { item, w, v } = await verifiedFor(f);

    f.engine.script(REVIEWER, {
      structuredOutput: envelope({
        criterionId: 'EC-REVIEW',
        outcome: 'PASS',
        changeSetId: v.changeSet.changeSetId,
        summary: 'Looks fine.',
        findings: [],
        confidence: 'HIGH',
      }),
    });

    /* A real, resolvable Producer run whose record carries no engine session. */
    const producerRunId = producerRunWithoutSession(f, item);

    await expect(
      dispatchReviewer(f.dispatchDeps, {
        item,
        workspace: w,
        changeSet: v.changeSet,
        evidence: v.evidence,
        diff: '',
        producerRunRef: producerRunId,
      }),
    ).rejects.toThrowError(/engine session/i);
  }, 60_000);

  it('a Producer reference that resolves to nothing is refused', async () => {
    /*
     * Otherwise the requirement is satisfiable by inventing a run id, which is a weaker
     * check than no check at all — it looks like evidence.
     */
    const f = await setup();
    const { item, w, v } = await verifiedFor(f);

    f.engine.script(REVIEWER, {
      structuredOutput: envelope({
        criterionId: 'EC-REVIEW',
        outcome: 'PASS',
        changeSetId: v.changeSet.changeSetId,
        summary: 'Looks fine.',
        findings: [],
        confidence: 'HIGH',
      }),
    });

    await expect(
      dispatchReviewer(f.dispatchDeps, {
        item,
        workspace: w,
        changeSet: v.changeSet,
        evidence: v.evidence,
        diff: '',
        producerRunRef: 'SC-RUN-000000000000000000000',
      }),
    ).rejects.toThrowError(/does not resolve to a recorded run/);
  }, 60_000);
});

/**
 * A resolvable Producer run whose record carries no engine session.
 *
 * Written directly rather than dispatched, because the fake adapter reports a session for
 * every run - which is the measurement the requirement rests on, and so is no way to
 * produce the shape being refused.
 */
function producerRunWithoutSession(f: Fixture, item: { workItemId: string }): string {
  const runId = 'SC-RUN-00000000000000NOSESS';
  const tx = f.store.begin();
  tx.putCanon('agentRunRecord', runId, {
    runId,
    agentId: PRODUCER,
    workItemId: item.workItemId,
    outcome: 'COMPLETED',
  });
  tx.commit();
  return runId;
}

/** A verified attempt with no Producer dispatched, for the two refusals above. */
async function verifiedFor(f: Fixture) {
  const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
  const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
  writeFileSync(join(w.path, 'src', 'total.js'), 'module.exports = 2;\n', 'utf8');
  const v = await f.factory.verifyAttempt(item, w, {
    required: { ...DEFAULT_REQUIRED_CHECKS, build: false, lint: false, codeReview: false },
  });
  return { item, w, v };
}
