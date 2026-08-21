import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EnforcementClass, EvidenceClass } from '../../src/vocab/index.js';
import { selectExecutionSubstrate } from '../../src/substrate/host.js';
import { describeBoundary } from '../../src/substrate/boundary.js';
import { makeFixtureDir, removeFixtureDir } from '../../src/substrate/fake.js';
import { resolveEngineeringEngine, type EngineeringEngine } from '../../src/engineering/engine.js';
import {
  ExecutionRecipeSchema,
  RecipeRegistry,
  type ExecutionRecipe,
} from '../../src/engineering/recipe.js';
import { EngineeringFactory } from '../../src/engineering/factory.js';
import { GitService } from '../../src/engineering/git.js';
import { EngineeringWorkspaceManager } from '../../src/engineering/workspace.js';
import { DEFAULT_REQUIRED_CHECKS } from '../../src/engineering/executors.js';
import { implementWorkItem, ImplementOutcome } from '../../src/app/implement.js';
import { engineeringStatus, buildEngineeringLayer } from '../../src/app/engineering.js';
import { ContractRegistry } from '../../src/agents/registry.js';
import { cleanup, freshRuntime } from '../helpers.js';
import { systemClock } from '../../src/core/clock.js';
import type { SubstrateQualification } from '../../src/substrate/types.js';

/**
 * PHASE 4 LIVE ACCEPTANCE — the real machine, the real production path.
 *
 * `npm run test:engineering-live`. Excluded from `npm run verify` and `test:claude`.
 *
 * Two boundaries are probed, because there are two and they are not the same thing:
 *
 *   RECIPE    Serva's own build/test/lint commands, contained by bubblewrap.
 *   PRODUCER  the engine session an agent runs in, contained by Claude Code's own
 *             sandbox, inside the guest where that engine is installed.
 *
 * The HARD path runs `implementWorkItem` — the same function `serva implement` calls.
 * It does NOT construct a native-host adapter for a Windows Producer, and it contains
 * no `writeFileSync` standing in for a Producer and no literal standing in for a
 * review. If prerequisites are missing the answer is BLOCKED, and **no Producer model
 * call is spent** discovering that.
 */

const roots: string[] = [];
const fixtures: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) cleanup(r);
  for (const f of fixtures.splice(0)) removeFixtureDir(f);
});

function report(title: string, lines: readonly string[]): void {
  console.log('\n' + title);
  console.log('-'.repeat(title.length));
  for (const l of lines) console.log(l);
  console.log('');
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

const PRODUCER = 'SC-AGENT-150';
const REVIEWER = 'SC-AGENT-200';

let recipeQualification: SubstrateQualification | undefined;
let engineering: EngineeringEngine | undefined;

describe('PHASE 4 — live boundaries', () => {
  it('qualifies the RECIPE boundary from what this machine proved', async () => {
    const { rt, root } = freshRuntime();
    roots.push(root);
    const selection = await selectExecutionSubstrate({
      clock: systemClock,
      engineVersion: 'UNKNOWN',
      projectRoot: rt.root,
    });
    const fixture = makeFixtureDir('serva-live-recipe-');
    fixtures.push(fixture);
    const q = await selection.substrate.qualify(fixture);
    recipeQualification = q;
    rt.close();

    report('SERVA CODE — RECIPE BOUNDARY (deterministic build/test/lint)', [
      '  chosen because ' + selection.basis,
      '  boundary:      ' + describeBoundary(q.boundary),
      '  class:         ' + q.enforcementClass,
      '',
      '  prerequisites:',
      ...q.probe.prerequisites.map(
        (p) => '    [' + (p.satisfied ? ' ok ' : 'MISS') + '] ' + p.id + '  ' + p.what,
      ),
    ]);

    expect(q.boundary.purpose).toBe('RECIPE');
    // The prerequisites of this boundary are only what its mechanism uses. socat and
    // the syscall filter belong to the Producer boundary, where they participate.
    expect(q.probe.prerequisites.map((p) => p.id)).not.toContain('SECCOMP_FILTER');
  });

  it('qualifies the PRODUCER boundary — engine, guest, auth, sandbox', async () => {
    const { rt, root } = freshRuntime();
    roots.push(root);
    const e = await resolveEngineeringEngine({ clock: systemClock, projectRoot: rt.root });
    engineering = e;
    rt.close();

    const missing = e.prerequisites.filter((p) => !p.satisfied);
    report('SERVA CODE — PRODUCER BOUNDARY (the engine session an agent runs in)', [
      '  chosen because ' + e.basis,
      '  boundary:      ' + (e.boundary === undefined ? '(none)' : describeBoundary(e.boundary)),
      '  fingerprint:   ' + (e.boundary?.fingerprint.slice(0, 16) ?? '(none)') + '…',
      '  guest engine:  ' + (e.boundary?.engineLocation ?? '(not found)'),
      '  engine version:' + (e.status?.version ?? '(unknown)'),
      '  authenticated: ' + String(e.status?.authenticated ?? false),
      '  billing route: ' + (e.status?.billingMode ?? '(unknown)'),
      '  sandbox:       ' + (e.boundary?.sandboxMechanism ?? '(none)'),
      '  class:         ' + (e.qualification?.enforcementClass ?? 'NONE'),
      '  authority:     ' + (e.refusal === undefined ? 'GRANTED' : 'REFUSED'),
      ...(e.refusal === undefined ? [] : ['  refusal:       ' + e.refusal]),
      ...(e.qualification === undefined
        ? []
        : [
            '',
            '  qualification cases:',
            ...e.qualification.tests.map(
              (t) => '    [' + t.outcome.padEnd(7) + '] ' + t.id + '  ' + t.title,
            ),
          ]),
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
            '  Serva installs none of these, copies no credentials into the guest, and',
            "  never logs in on the owner's behalf.",
          ]),
    ]);

    // Every unsatisfied prerequisite names something a person can actually do.
    for (const p of missing) {
      expect(p.remedy.length, p.id).toBeGreaterThan(0);
      expect(p.why.length, p.id).toBeGreaterThan(0);
    }

    if (
      e.qualification !== undefined &&
      e.qualification.enforcementClass === EnforcementClass.HARD
    ) {
      expect(
        e.qualification.tests.filter((t) => t.blocking).every((t) => t.outcome === 'PASSED'),
      ).toBe(true);
      expect(e.boundary?.simulated).toBe(false);
      expect(e.boundary?.purpose).toBe('PRODUCER');
      // On Windows the Producer boundary must be the GUEST, never the host.
      if (process.platform === 'win32') {
        expect(e.boundary?.transport.startsWith('wsl:')).toBe(true);
        expect(e.boundary?.engineLocation?.startsWith('/mnt/')).toBe(false);
      }
    }
  }, 300_000);

  it('the two boundaries are distinct, and neither authorizes the other', () => {
    const recipe = recipeQualification?.boundary;
    const producer = engineering?.boundary;
    if (recipe === undefined || producer === undefined) return;
    // Different purposes, different mechanisms, different fingerprints. A HARD recipe
    // boundary has never been evidence about a Producer, and now it cannot be mistaken
    // for one either.
    expect(recipe.fingerprint).not.toBe(producer.fingerprint);
    expect(recipe.purpose).not.toBe(producer.purpose);
  });

  it('the owner-facing status agrees with the recipe qualification', async () => {
    const { rt, root } = freshRuntime();
    roots.push(root);
    const layer = await buildEngineeringLayer(rt);
    const { view } = await engineeringStatus(layer);
    rt.close();
    expect(view.simulated).toBe(false);
    expect(view.executionSubstrate).toBe(recipeQualification?.enforcementClass);
  }, 120_000);
});

describe('PHASE 4 — live acceptance', () => {
  it('either implements the work item or refuses, through the production path', async () => {
    const e = engineering;
    const recipeQ = recipeQualification;
    expect(e).toBeDefined();
    expect(recipeQ).toBeDefined();
    if (e === undefined || recipeQ === undefined) return;

    /* ---------------- a disposable fixture project, never the Serva source tree */

    const { rt, root } = freshRuntime();
    roots.push(root);
    const repo = rt.root;
    mkdirSync(join(repo, 'src'), { recursive: true });
    const g = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(join(repo, '.gitignore'), '.serva/\n', 'utf8');
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
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'fixture@localhost');
    g('config', 'user.name', 'Live Fixture');
    g('config', 'commit.gpgsign', 'false');
    g('add', '.');
    g('commit', '-q', '-m', 'base with a failing suite');
    const base = g('rev-parse', 'HEAD').trim();

    const recipes = new RecipeRegistry([
      liveRecipe('SC-RECIPE-UNIT-TEST', ['test.js'], 'SC-RTC-012'),
    ]);
    const git = new GitService({ repoRoot: repo });
    const factory = new EngineeringFactory({
      store: rt.store,
      git,
      workspaces: new EngineeringWorkspaceManager({
        store: rt.store,
        git,
        clock: rt.clock,
        projectRoot: repo,
      }),
      recipes,
      registry: ContractRegistry.shared(),
      qualification: recipeQ,
      executorDeps: {
        store: rt.store,
        clock: rt.clock,
        ids: rt.ids,
        substrate: (
          await selectExecutionSubstrate({
            clock: systemClock,
            engineVersion: 'UNKNOWN',
            projectRoot: repo,
          })
        ).substrate,
        qualification: recipeQ,
        env: process.env,
      },
      gateDeps: { ids: rt.ids, clock: rt.clock, evaluator: 'ENGINEERING_GATE_LIVE' },
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

    const substrate = (
      await selectExecutionSubstrate({
        clock: systemClock,
        engineVersion: 'UNKNOWN',
        projectRoot: repo,
      })
    ).substrate;

    /*
     * The SAME function `serva implement` calls. It refuses internally before creating
     * a worktree, dispatching a model or running a command when the Producer boundary
     * is not HARD — so the not-HARD path costs nothing and proves it.
     */
    const result = await implementWorkItem(
      {
        rt,
        registry: ContractRegistry.shared(),
        recipes,
        recipeSubstrate: substrate,
        recipeQualification: recipeQ,
        engine: e,
        enabledProducers: new Set([PRODUCER]),
        required: { ...DEFAULT_REQUIRED_CHECKS, build: false, lint: false },
      },
      item,
    );

    if (result.outcome === ImplementOutcome.BLOCKED && result.attempts.length === 0) {
      report('SERVA CODE — PHASE 4 LIVE ACCEPTANCE: BLOCKED', [
        '  verdict:  BLOCKED — PLATFORM_PREREQUISITE_REQUIRED',
        '  boundary: ' + (e.boundary === undefined ? '(none)' : describeBoundary(e.boundary)),
        '  refusal:  ' + (result.refusal ?? '(none)'),
        '',
        '  No worktree was created. No Producer was dispatched. No Reviewer was',
        '  dispatched. No command was run. No model call was made.',
        '  Serva did not downgrade to SOFT, and did not fall back to the host engine.',
      ]);
      expect(result.refusal).toBeDefined();
      expect(await git.isClean(repo)).toBe(true);
      expect(await git.headCommit(repo)).toBe(base);
      rt.close();
      return;
    }

    /* ------------------------------------------------------- the HARD path ran */

    report('SERVA CODE — PHASE 4 LIVE ACCEPTANCE: EXECUTED', [
      '  boundary:    ' + (e.boundary === undefined ? '(none)' : describeBoundary(e.boundary)),
      '  fingerprint: ' + (result.boundaryFingerprint ?? '(none)'),
      '  outcome:     ' + result.outcome,
      ...result.attempts.flatMap((a) => [
        '',
        '  attempt ' + String(a.attempt) + ' — workspace ' + a.workspaceId,
        '    producer run: ' + (a.producerRunId ?? '(none)'),
        '    reviewer run: ' + (a.reviewerRunId ?? '(none)'),
        '    change set:   ' + (a.changeSetId ?? '(none)'),
        '    gate:         ' + (a.verdict ?? '(none)'),
        ...a.notes.map((n) => '      - ' + n),
      ]),
      ...(result.verification === undefined
        ? []
        : [
            '',
            '  measured evidence:',
            ...result.verification.evidence.map(
              (ev) =>
                '    [' +
                ev.outcome +
                '] ' +
                (ev.runtimeComponentId ?? 'JUDGED') +
                '  ' +
                ev.detail,
            ),
          ]),
      ...(result.commit === undefined
        ? []
        : ['', '  commit ' + result.commit + ' on ' + String(result.branch)]),
    ]);

    // Whatever the outcome, the runs were real and distinct, and the checkout is clean.
    for (const a of result.attempts) {
      expect(a.producerRunId).toMatch(/^SC-RUN-/);
      if (a.reviewerRunId !== undefined) expect(a.reviewerRunId).not.toBe(a.producerRunId);
    }
    expect(result.verification?.usedUnvalidatedJudgement).not.toBe(true);
    expect(git.invocations.some((x) => x[0] === 'push')).toBe(false);
    expect(await git.isClean(repo)).toBe(true);
    expect(await git.headCommit(repo)).toBe(base);
    rt.close();
  }, 900_000);

  it('never enables an escape hatch, and never stands in for a Producer', () => {
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
          if (!/never|not |no |refus|deny|denied|forbid|must not|would defeat/i.test(context)) {
            offenders.push(p + ':' + String(i + 1) + '  ' + line.trim());
          }
        }
      }
    };
    walk(resolve('src'));
    expect(offenders).toEqual([]);

    /*
     * A self-reading check lived here and was wrong by construction: the file contains
     * the pattern it searches for, so it could only ever fail. What it was trying to
     * assert is covered honestly elsewhere — `usedUnvalidatedJudgement` is asserted
     * false above, and `eng.binding.test.ts` proves no file under `src/` sets either
     * escape hatch.
     */
  });
});
