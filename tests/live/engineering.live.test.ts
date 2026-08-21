import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EnforcementClass, EvidenceClass, GateVerdict } from '../../src/vocab/index.js';
import { HostExecutionSubstrate } from '../../src/substrate/host.js';
import {
  engineeringAuthorityRefusal,
  type SubstrateQualification,
} from '../../src/substrate/types.js';
import { makeFixtureDir, removeFixtureDir } from '../../src/substrate/fake.js';
import { ContractRegistry } from '../../src/agents/registry.js';
import { GitService } from '../../src/engineering/git.js';
import { EngineeringWorkspaceManager } from '../../src/engineering/workspace.js';
import {
  ExecutionRecipeSchema,
  RecipeRegistry,
  type ExecutionRecipe,
} from '../../src/engineering/recipe.js';
import { listExecutions, runRecipe } from '../../src/engineering/execution.js';
import { EngineeringFactory } from '../../src/engineering/factory.js';
import { engineeringStatus, buildEngineeringLayer } from '../../src/app/engineering.js';
import { cleanup, freshRuntime, freshStore } from '../helpers.js';
import { systemClock } from '../../src/core/clock.js';

/**
 * PHASE 4 LIVE ACCEPTANCE — the real machine, not a fake.
 *
 * `npm run test:engineering-live`. Excluded from `npm run verify` and from
 * `npm run test:claude`.
 *
 * This suite answers one question honestly: **can this machine carry engineering
 * authority, and what did it actually prove?** It probes the real host, derives the
 * enforcement class from qualification tests, and then takes exactly one of two paths:
 *
 *   HARD      run the full acceptance — real worktree, real edit, real build and test
 *             commands, real evidence, real gate, real local commit — inside a
 *             DISPOSABLE fixture repository, never the Serva source tree.
 *
 *   not HARD  report BLOCKED with the exact prerequisites, and PROVE that nothing
 *             executed anyway.
 *
 * It never downgrades itself to SOFT to make the demo pass. A green run that had
 * quietly executed a Producer's commands outside a boundary would be the single worst
 * outcome this whole phase exists to prevent, so the not-HARD path asserts the refusal
 * rather than skipping.
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

function realSubstrate(): HostExecutionSubstrate {
  return new HostExecutionSubstrate({ clock: systemClock, engineVersion: engineVersion() });
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

let qualification: SubstrateQualification | undefined;

describe('PHASE 4 — live substrate qualification', () => {
  it('derives the enforcement class from what this machine actually proved', async () => {
    const substrate = realSubstrate();
    const fixture = makeFixtureDir('serva-live-qual-');
    fixtures.push(fixture);
    qualification = await substrate.qualify(fixture);
    const q = qualification;

    const refusal = engineeringAuthorityRefusal(q);
    const missing = q.probe.prerequisites.filter((p) => !p.satisfied);

    report('SERVA CODE — PHASE 4 LIVE SUBSTRATE REPORT', [
      '  host:          ' + q.probe.hostPlatform + '/' + q.probe.hostArch,
      '  guest:         ' + (q.probe.guestPlatform ?? '(none)'),
      '  isolation:     ' + q.probe.isolationMethod,
      '  engine:        ' + q.engineVersion,
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

    // The class is derived, never asserted: a substrate cannot reach HARD without
    // every blocking case PASSED, and NOT_RUN counts against it exactly as FAILED does.
    if (q.enforcementClass === EnforcementClass.HARD) {
      expect(q.tests.filter((t) => t.blocking).every((t) => t.outcome === 'PASSED')).toBe(true);
    } else {
      expect(q.tests.some((t) => t.blocking && t.outcome !== 'PASSED')).toBe(true);
      expect(q.blockedBy).toBeDefined();
    }
  });

  it('the owner-facing status agrees with the qualification', async () => {
    const { rt, root } = freshRuntime();
    roots.push(root);
    const layer = buildEngineeringLayer(rt, { substrate: realSubstrate() });
    const { view } = await engineeringStatus(layer);
    rt.close();

    expect(view.executionSubstrate).toBe(qualification?.enforcementClass);
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
  it('either completes a verified change or refuses to execute at all', async () => {
    const q = qualification;
    expect(q).toBeDefined();
    if (q === undefined) return;

    const { repo, base } = fixtureRepo();
    const { store, root, deps } = freshStore();
    roots.push(root);

    const substrate = realSubstrate();
    const git = new GitService({ repoRoot: repo });
    const workspaces = new EngineeringWorkspaceManager({
      store,
      git,
      clock: deps.clock,
      projectRoot: repo,
    });
    const recipes = new RecipeRegistry(LIVE_RECIPES);
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
      registry: ContractRegistry.shared(),
      qualification: q,
      executorDeps,
      gateDeps: { ids: deps.ids, clock: deps.clock, evaluator: 'ENGINEERING_GATE_LIVE' },
      projectRoot: repo,
      enabledProducers: new Set(['SC-AGENT-150']),
    });

    const item = factory.recordWorkItem({
      workItemId: 'SC-WI-000900',
      title: 'total() must sum every element',
      requirements: ['total([1,2,3]) returns 6.'],
      acceptanceCriteria: ['The declared test suite passes.'],
      decisions: [],
      allowedScope: ['src/'],
      forbiddenScope: [],
      producerAgentId: 'SC-AGENT-150',
      reviewerAgentId: 'SC-AGENT-200',
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
        '  No worktree was created. No Producer was dispatched. No command was run.',
        '  Serva did not downgrade itself to SOFT execution to make this pass.',
      ]);

      expect(refusal).toMatch(/requires HARD/);
      await expect(factory.openWorkspace(item, 1, 'x'.repeat(64))).rejects.toThrowError(
        /requires HARD/,
      );
      // And the execution path refuses independently of the factory, so a guard higher
      // up being forgotten would not open a hole here.
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

    const workspace = await factory.openWorkspace(item, 1, 'x'.repeat(64));
    expect(workspace.path).not.toBe(repo);

    // Stands in for the Producer's edit. What matters for acceptance is not who typed
    // it but that the change is measured, and a real model call would spend the
    // owner's usage for a result the evidence path does not depend on.
    writeFileSync(
      join(workspace.path, 'src', 'total.js'),
      [
        'module.exports = function total(xs) {',
        '  let sum = 0;',
        '  for (let i = 0; i < xs.length; i++) sum += xs[i];',
        '  return sum;',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );

    const verification = await factory.verifyAttempt(item, workspace, {
      required: {
        scope: true,
        build: true,
        tests: true,
        lint: false,
        secrets: true,
        codeReview: true,
        qaVerification: false,
      },
      judged: [
        {
          criterionId: 'EC-REVIEW',
          outcome: 'PASS',
          detail: 'The loop bound was the defect; the change is minimal and in scope.',
          runRef: 'SC-RUN-LIVE-REVIEWER',
          reviewerRole: 'CODE_REVIEW',
        },
      ],
    });

    report('SERVA CODE — PHASE 4 LIVE ACCEPTANCE: EXECUTED', [
      '  class:      ' + q.enforcementClass,
      '  worktree:   ' + workspace.path,
      '  change set: ' + verification.changeSet.changeSetId,
      '  verdict:    ' + verification.gateResult.verdict,
      '',
      '  evidence:',
      ...verification.evidence.map(
        (e) => '    [' + e.outcome + '] ' + (e.runtimeComponentId ?? 'JUDGED') + '  ' + e.detail,
      ),
    ]);

    expect(verification.evidence.some((e) => e.basis === 'MEASURED')).toBe(true);
    expect([GateVerdict.PASS, GateVerdict.PASS_WITH_QUALIFICATION]).toContain(
      verification.gateResult.verdict,
    );
    expect(verification.attemptOutcome).toBe('ACCEPTED');

    const { commit } = await factory.acceptChange(item, workspace, verification);
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
     * a refusal has to say what it refuses — but every occurrence must sit on a line
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
          /*
           * Judge the occurrence in context, not on its own line. The real refusal
           * lists hold these flags as bare string literals, and the sentence saying
           * they are never emitted sits in the comment above them.
           */
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
