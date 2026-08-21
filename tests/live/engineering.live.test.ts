import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EnforcementClass, EvidenceClass, GateVerdict, RunOutcome } from '../../src/vocab/index.js';
import { selectExecutionSubstrate } from '../../src/substrate/host.js';
import {
  engineeringAuthorityRefusal,
  type SubstrateQualification,
} from '../../src/substrate/types.js';
import { makeFixtureDir, removeFixtureDir } from '../../src/substrate/fake.js';
import { ContractRegistry } from '../../src/agents/registry.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { ClaudeCliEngineAdapter } from '../../src/engine/claude/adapter.js';
import { GitService } from '../../src/engineering/git.js';
import { EngineeringWorkspaceManager } from '../../src/engineering/workspace.js';
import {
  ExecutionRecipeSchema,
  RecipeRegistry,
  type ExecutionRecipe,
} from '../../src/engineering/recipe.js';
import { listExecutions, runRecipe } from '../../src/engineering/execution.js';
import { EngineeringFactory } from '../../src/engineering/factory.js';
import { DEFAULT_REQUIRED_CHECKS } from '../../src/engineering/executors.js';
import { dispatchProducer, dispatchReviewer } from '../../src/engineering/dispatch.js';
import { engineeringStatus, buildEngineeringLayer } from '../../src/app/engineering.js';
import { cleanup, freshRuntime, freshStore } from '../helpers.js';
import { systemClock } from '../../src/core/clock.js';

/**
 * PHASE 4 LIVE ACCEPTANCE — the real machine, not a fake.
 *
 * `npm run test:engineering-live`. Excluded from `npm run verify` and from
 * `npm run test:claude`.
 *
 * One question, answered honestly: **can this machine carry engineering authority, and
 * what did it actually prove?** The real host is probed, the enforcement class is
 * derived from qualification tests that genuinely run, and then exactly one of two
 * paths is taken:
 *
 *   HARD      the full acceptance — real worktree, a REAL Producer AgentRun, real
 *             measured evidence, a REAL independent Reviewer AgentRun, real gate, real
 *             local commit — inside a DISPOSABLE fixture repository, never the Serva
 *             source tree.
 *
 *   not HARD  report BLOCKED with the exact prerequisites, and PROVE nothing executed.
 *             **No model call is made on this path**, because a Producer that cannot be
 *             contained is not dispatched, and spending the owner's usage to discover
 *             that twice would be waste.
 *
 * It never downgrades itself to SOFT to make the demo pass, and it never substitutes a
 * `writeFileSync` for a Producer or a string literal for a Reviewer. That substitution
 * is what the previous version did, and it meant the one thing this phase exists for
 * had never actually happened.
 */

const roots: string[] = [];
const fixtures: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) cleanup(r);
  for (const f of fixtures.splice(0)) removeFixtureDir(f);
});

/** Read-only: `claude --version`. No model call, nothing billed. */
function engineVersion(): string {
  try {
    const out = execFileSync('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

function report(title: string, lines: readonly string[]): void {
  console.log('\n' + title);
  console.log('-'.repeat(title.length));
  for (const l of lines) console.log(l);
  console.log('');
}

/** A disposable fixture repository with a genuinely failing test. */
function fixtureRepo(): { repo: string; base: string } {
  const { root } = freshStore();
  roots.push(root);
  const repo = join(root, 'live-fixture-repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  writeFileSync(join(repo, 'package.json'), '{"name":"live-fixture","private":true}\n', 'utf8');
  writeFileSync(join(repo, 'build.js'), 'process.exit(0);\n', 'utf8');
  writeFileSync(
    join(repo, 'test.js'),
    [
      "const total = require('./src/total.js');",
      'if (total([1, 2, 3]) !== 6) {',
      '  console.error("expected 6, got " + total([1, 2, 3]));',
      '  process.exit(1);',
      '}',
      'process.exit(0);',
      '',
    ].join('\n'),
    'utf8',
  );
  // The defect the Producer is asked to fix: it sums all but the last element.
  writeFileSync(
    join(repo, 'src', 'total.js'),
    [
      'module.exports = function total(xs) {',
      '  let sum = 0;',
      '  for (let i = 0; i < xs.length - 1; i++) sum += xs[i];',
      '  return sum;',
      '};',
      '',
    ].join('\n'),
    'utf8',
  );

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@localhost');
  git('config', 'user.name', 'Live Fixture');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.');
  git('commit', '-q', '-m', 'base with a failing suite');
  return { repo, base: git('rev-parse', 'HEAD').trim() };
}

function liveRecipe(id: string, args: string[], component: string): ExecutionRecipe {
  return ExecutionRecipeSchema.parse({
    id,
    purpose: 'Live acceptance recipe for the disposable fixture repository.',
    executable: 'node',
    args,
    cwdPolicy: 'WORKSPACE',
    environmentPolicy: 'MINIMAL',
    networkPolicy: 'NONE',
    timeoutMs: 300_000,
    maxOutputBytes: 1_000_000,
    successExitCodes: [0],
    evidenceClass: EvidenceClass.EXECUTION,
    runtimeComponentId: component,
    applicability: 'The disposable live fixture repository only.',
  });
}

const LIVE_RECIPES: readonly ExecutionRecipe[] = [
  liveRecipe('SC-RECIPE-UNIT-TEST', ['test.js'], 'SC-RTC-012'),
  liveRecipe('SC-RECIPE-BUILD', ['build.js'], 'SC-RTC-011'),
];

const PRODUCER = 'SC-AGENT-150';
const REVIEWER = 'SC-AGENT-200';

let qualification: SubstrateQualification | undefined;
let selectionBasis = '';

describe('PHASE 4 — live substrate qualification', () => {
  it('derives the enforcement class from what this machine actually proved', async () => {
    const { rt, root } = freshRuntime();
    roots.push(root);
    const selection = await selectExecutionSubstrate({
      clock: systemClock,
      engineVersion: engineVersion(),
      projectRoot: rt.root,
    });
    rt.close();
    selectionBasis = selection.basis;

    const fixture = makeFixtureDir('serva-live-qual-');
    fixtures.push(fixture);
    const q = await selection.substrate.qualify(fixture);
    qualification = q;

    const refusal = engineeringAuthorityRefusal(q);
    const missing = q.probe.prerequisites.filter((p) => !p.satisfied);

    report('SERVA CODE — PHASE 4 LIVE SUBSTRATE REPORT', [
      '  host:          ' + q.probe.hostPlatform + '/' + q.probe.hostArch,
      '  guest:         ' + (q.probe.guestPlatform ?? '(none)'),
      '  substrate:     ' + q.probe.substrateId,
      '  chosen because ' + selection.basis,
      '  isolation:     ' + q.probe.isolationMethod,
      '  engine:        ' + q.engineVersion,
      '  fingerprint:   ' + q.fingerprint.slice(0, 16) + '…',
      '  class:         ' + q.enforcementClass,
      '  authority:     ' + (refusal === undefined ? 'GRANTED' : 'REFUSED'),
      ...(refusal === undefined ? [] : ['  refusal:       ' + refusal]),
      '',
      '  qualification cases:',
      ...q.tests.map((t) => '    [' + t.outcome.padEnd(7) + '] ' + t.id + '  ' + t.title),
      ...(missing.length === 0
        ? []
        : [
            '',
            '  PLATFORM_PREREQUISITE_REQUIRED — ' + String(missing.length) + ' item(s):',
            ...missing.flatMap((p) => [
              '    - ' + p.id + '  ' + p.what,
              '        why:    ' + p.why,
              '        remedy: ' + p.remedy,
            ]),
            '',
            '  Serva installs none of these. Changing the machine a sandbox runs on is',
            "  the owner's decision, not a side effect of running a test.",
          ]),
    ]);

    // Derived, never asserted: HARD requires every blocking case PASSED, and a NOT_RUN
    // counts against the substrate exactly as a failure does.
    if (q.enforcementClass === EnforcementClass.HARD) {
      expect(q.tests.filter((t) => t.blocking).every((t) => t.outcome === 'PASSED')).toBe(true);
      expect(q.probe.simulated).not.toBe(true);
    } else {
      expect(q.tests.some((t) => t.blocking && t.outcome !== 'PASSED')).toBe(true);
      expect(q.blockedBy).toBeDefined();
    }

    // Every unsatisfied prerequisite must name something a person can actually do.
    for (const p of missing) {
      expect(p.remedy.length, p.id).toBeGreaterThan(0);
      expect(p.why.length, p.id).toBeGreaterThan(0);
    }
  });

  it('the owner-facing status agrees with the qualification', async () => {
    const { rt, root } = freshRuntime();
    roots.push(root);
    const layer = await buildEngineeringLayer(rt, { engineVersion: engineVersion() });
    const { view } = await engineeringStatus(layer);
    rt.close();

    expect(view.executionSubstrate).toBe(qualification?.enforcementClass);
    expect(view.substrateBasis).toBe(selectionBasis);
    expect(view.simulated).toBe(false);
    if (view.governance === 'ACTIVE') {
      expect(view.blockedBy).toBeUndefined();
    } else {
      // A blocked state must SAY it is blocked, and say what is missing.
      expect(view.blockedBy).toBeDefined();
      expect(view.enabledProducers).toEqual([]);
    }
  });
});

describe('PHASE 4 — live acceptance', () => {
  it('either completes a governed change or refuses to execute at all', async () => {
    const q = qualification;
    expect(q).toBeDefined();
    if (q === undefined) return;

    const { repo, base } = fixtureRepo();
    const { store, root, deps } = freshStore();
    roots.push(root);

    const selection = await selectExecutionSubstrate({
      clock: systemClock,
      engineVersion: q.engineVersion,
      projectRoot: repo,
    });
    const substrate = selection.substrate;
    const git = new GitService({ repoRoot: repo });
    const workspaces = new EngineeringWorkspaceManager({
      store,
      git,
      clock: deps.clock,
      projectRoot: repo,
    });
    const recipes = new RecipeRegistry(LIVE_RECIPES);
    const registry = ContractRegistry.shared();
    const executorDeps = {
      store,
      clock: deps.clock,
      ids: deps.ids,
      substrate,
      qualification: q,
      env: process.env,
    };
    const factory = new EngineeringFactory({
      store,
      git,
      workspaces,
      recipes,
      registry,
      qualification: q,
      executorDeps,
      gateDeps: { ids: deps.ids, clock: deps.clock, evaluator: 'ENGINEERING_GATE_LIVE' },
      projectRoot: repo,
      enabledProducers: new Set([PRODUCER]),
    });

    const item = factory.recordWorkItem({
      workItemId: 'SC-WI-000900',
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
      baseCommit: base,
      expectedOutputs: [],
      maxAttempts: 2,
    });

    /* ------------------------------------------------ the not-HARD path */

    if (q.enforcementClass !== EnforcementClass.HARD) {
      const refusal = factory.refusal(item);
      report('SERVA CODE — PHASE 4 LIVE ACCEPTANCE: BLOCKED', [
        '  verdict:  BLOCKED — PLATFORM_PREREQUISITE_REQUIRED',
        '  class:    ' + q.enforcementClass + ' (measured, not assumed)',
        '  refusal:  ' + (refusal ?? '(none)'),
        '',
        '  No worktree was created. No Producer was dispatched. No Reviewer was',
        '  dispatched. No command was run. No model call was made.',
        '  Serva did not downgrade itself to SOFT execution to make this pass.',
      ]);

      expect(refusal).toMatch(/requires HARD/);
      await expect(factory.openWorkspace(item, 1, 'x'.repeat(64))).rejects.toThrowError(
        /requires HARD/,
      );
      // The execution path refuses independently of the factory, so a guard higher up
      // being forgotten would not open a hole here.
      await expect(
        runRecipe(executorDeps, {
          recipe: recipes.get('SC-RECIPE-UNIT-TEST'),
          workItemId: item.workItemId,
          workspaceId: 'none',
          workspacePath: repo,
          projectRoot: repo,
          baseCommit: base,
          headCommit: base,
        }),
      ).rejects.toThrowError(/requires HARD/);

      // The strongest available proof of no downgrade: nothing ran.
      expect(listExecutions(store)).toHaveLength(0);
      expect(workspaces.list()).toHaveLength(0);
      expect(await git.isClean(repo)).toBe(true);
      return;
    }

    /* ---------------------------------------------------- the HARD path */

    const engine = new ClaudeCliEngineAdapter({ clock: deps.clock, env: process.env });
    const capabilities = await engine.capabilities();
    const runtime = new AgentRuntime({
      store,
      ids: deps.ids,
      clock: deps.clock,
      registry,
      engine,
      enabledAgents: new Set([PRODUCER, REVIEWER]),
      projectRoot: repo,
    });
    const dispatchDeps = {
      store,
      clock: deps.clock,
      ids: deps.ids,
      runtime,
      registry,
      substrate,
      qualification: q,
      projectRoot: repo,
      enabledProducers: new Set([PRODUCER]),
      engineCapabilities: capabilities,
    };

    const workspace = await factory.openWorkspace(item, 1, 'x'.repeat(64));
    expect(workspace.path).not.toBe(repo);

    // A REAL Producer AgentRun. No writeFileSync stand-in.
    const producer = await dispatchProducer(dispatchDeps, {
      item,
      workspace,
      taskDefinition:
        'The function total() in src/total.js should sum every element of its argument and currently omits the last one. Fix it. Change nothing else.',
      reviewerAvailable: true,
      executorsAvailable: true,
    });
    expect(producer.runId).toMatch(/^SC-RUN-/);

    const measured = await factory.verifyAttempt(item, workspace, {
      required: { ...DEFAULT_REQUIRED_CHECKS, lint: false, codeReview: false },
      producerRunId: producer.runId,
    });

    // A REAL independent Reviewer AgentRun. No fabricated SC-RUN-LIVE-REVIEWER.
    const review = await dispatchReviewer(dispatchDeps, {
      item,
      workspace,
      changeSet: measured.changeSet,
      evidence: measured.evidence,
      diff: await git.diff(base, workspace.path),
      producerRunRef: producer.runId,
    });

    const final = await factory.verifyAttempt(item, workspace, {
      required: { ...DEFAULT_REQUIRED_CHECKS, lint: false },
      producerRunId: producer.runId,
    });

    report('SERVA CODE — PHASE 4 LIVE ACCEPTANCE: EXECUTED', [
      '  class:        ' + q.enforcementClass,
      '  worktree:     ' + workspace.path,
      '  producer run: ' + producer.runId + ' (' + producer.outcome + ')',
      '  reviewer run: ' + review.runId + ' (' + review.outcome + ')',
      '  change set:   ' + final.changeSet.changeSetId,
      '  verdict:      ' + final.gateResult.verdict,
      ...(producer.unprovedBoundary.length === 0
        ? []
        : [
            '',
            '  Not established before dispatch:',
            ...producer.unprovedBoundary.map((u) => '    - ' + u),
          ]),
      '',
      '  evidence:',
      ...final.evidence.map(
        (e) => '    [' + e.outcome + '] ' + (e.runtimeComponentId ?? 'JUDGED') + '  ' + e.detail,
      ),
    ]);

    // Two distinct runs, and the reviewer is not the producer.
    expect(review.runId).not.toBe(producer.runId);
    expect(final.usedUnvalidatedJudgement).toBe(false);
    expect(final.evidence.some((e) => e.basis === 'MEASURED')).toBe(true);

    if (producer.outcome !== RunOutcome.COMPLETED || review.review?.outcome !== 'PASS') {
      // An honest non-acceptance. The machinery worked; the change was not accepted.
      expect(final.attemptOutcome).not.toBe('ACCEPTED');
      return;
    }

    expect([GateVerdict.PASS, GateVerdict.PASS_WITH_QUALIFICATION]).toContain(
      final.gateResult.verdict,
    );
    const { commit } = await factory.acceptChange(item, workspace, final);
    expect(commit).toMatch(/^[0-9a-f]{7,}$/);

    // Phase 4 performs no remote write, and the primary checkout is untouched.
    expect(git.invocations.some((a) => a[0] === 'push')).toBe(false);
    expect(await git.isClean(repo)).toBe(true);
    expect(await git.headCommit(repo)).toBe(base);
  });

  it('never enables an escape hatch, whatever the substrate turned out to be', () => {
    /*
     * A last, cheap check on the one thing no measurement would catch: the flags that
     * would make every other guarantee in this phase decorative. They may be NAMED —
     * a refusal has to say what it refuses — but every occurrence must sit in a context
     * that refuses, denies or documents, never one that sets them.
     */
    const forbidden = [
      '--dangerously-skip-permissions',
      'bypassPermissions',
      'dangerouslyDisableSandbox',
    ];
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
          continue;
        }
        if (!e.name.endsWith('.ts')) continue;
        const lines = readFileSync(p, 'utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          if (!forbidden.some((f) => line.includes(f))) continue;
          const context = lines.slice(Math.max(0, i - 8), i + 1).join(' ');
          const refusing = /never|not |no |refus|deny|denied|forbid|must not|would defeat/i.test(
            context,
          );
          if (!refusing) offenders.push(p + ':' + String(i + 1) + '  ' + line.trim());
        }
      }
    };
    walk(resolve('src'));

    expect(offenders).toEqual([]);
  });
});
