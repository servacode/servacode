import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngineHealthState } from '../../src/engine/types.js';
import { buildAiLayer } from '../../src/app/ai.js';
import { sendOwnerRequest, TurnOutcome } from '../../src/app/conversation.js';
import { resolveEngineeringEngine, type EngineeringEngine } from '../../src/engineering/engine.js';
import { RecipeRegistry, ExecutionRecipeSchema } from '../../src/engineering/recipe.js';
import { EngineeringFactory } from '../../src/engineering/factory.js';
import { GitService } from '../../src/engineering/git.js';
import { EngineeringWorkspaceManager } from '../../src/engineering/workspace.js';
import { DEFAULT_REQUIRED_CHECKS } from '../../src/engineering/executors.js';
import { implementWorkItem, ImplementOutcome } from '../../src/app/implement.js';
import { selectExecutionSubstrate } from '../../src/substrate/host.js';
import { makeFixtureDir, removeFixtureDir } from '../../src/substrate/fake.js';
import { ContractRegistry } from '../../src/agents/registry.js';
import { systemClock } from '../../src/core/clock.js';
import { cleanup, freshRuntime } from '../helpers.js';
import type { SubstrateQualification } from '../../src/substrate/types.js';

/**
 * LIVE-SERVA — AN OWNER ASKED, AND GOVERNED WORK FOLLOWED.
 *
 * SPEC: Phase 6 final acceptance sequence §2.
 *
 * The engineering live suite proves the factory. This proves the thing that makes it a
 * COMPANY: a request in the owner's own words, routed through governed classification and
 * planning, producing a work item that a Producer then builds, deterministic checks measure,
 * an independent Reviewer accepts and Serva integrates.
 *
 * The link that makes it one chain rather than two adjacent demonstrations is the WORK ITEM
 * ID. The turn records the id its request opened, and the ChangeSet records the id it was
 * built for; `resolveLiveServa` refuses when they differ, so two unrelated runs cannot be
 * presented side by side as a chain.
 *
 * Costs real model calls. Its own file and its own command.
 */

const roots: string[] = [];
const fixtures: string[] = [];
afterAll(() => {
  if (process.env['SERVA_PRESERVE_LIVE'] === '1') {
    console.log('live fixtures preserved at:');
    for (const r of roots.splice(0)) console.log('  ' + r);
    for (const f of fixtures.splice(0)) removeFixtureDir(f);
    return;
  }
  for (const r of roots.splice(0)) cleanup(r);
  for (const f of fixtures.splice(0)) removeFixtureDir(f);
});

const PRODUCER = 'SC-AGENT-150';
const REVIEWER = 'SC-AGENT-180';

let engineering: EngineeringEngine | undefined;
let qualification: SubstrateQualification | undefined;

function liveRecipe(id: string, argv: readonly string[], checkId: string) {
  return ExecutionRecipeSchema.parse({
    recipeId: id,
    title: id,
    runtimeCheckId: checkId,
    executable: 'node',
    args: [...argv],
    timeoutMs: 120_000,
    maxOutputBytes: 200_000,
    environmentPolicy: 'MINIMAL',
    networkPolicy: 'DENY',
    successExitCodes: [0],
  });
}

beforeAll(async () => {
  engineering = await resolveEngineeringEngine({ clock: systemClock, projectRoot: process.cwd() });

  /*
   * The RECIPE boundary, measured for itself.
   *
   * Not the Producer one: they are different boundaries and neither authorises the other. The
   * deterministic commands run under this; the Producer worktree runs under `e.qualification`.
   */
  const selection = await selectExecutionSubstrate({
    clock: systemClock,
    engineVersion: 'UNKNOWN',
    projectRoot: process.cwd(),
  });
  const fixture = makeFixtureDir('serva-live-chain-');
  fixtures.push(fixture);
  qualification = await selection.substrate.qualify(fixture);
}, 300_000);

describe('Serva 1.0 — an owner request becomes an accepted commit', () => {
  it('routes a real request and builds what it asked for, or refuses honestly', async () => {
    const e = engineering;
    if (e === undefined) {
      console.log('SERVA CODE — OWNER ACTION REQUIRED: no engineering engine on this machine.');
      return;
    }

    /* ------------------------------- a disposable project with a failing suite */

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

    /* ------------------------------------------ 1. the owner asks, in their own words */

    const layer = buildAiLayer(rt);
    const health = await layer.engine.health();
    if (health.state !== EngineHealthState.READY) {
      console.log('SERVA CODE — OWNER ACTION REQUIRED: ' + (health.remedy ?? health.state));
      rt.close();
      return;
    }

    const turn = await sendOwnerRequest(
      rt,
      'The totals are wrong — total([1,2,3]) gives 3 instead of 6. Please fix it.',
      { orchestrator: layer.orchestrator },
    );

    console.log('owner request: ' + turn.outcome + ' — work item ' + String(turn.workItemId));
    expect(turn.runIds.length, 'the request caused no governed run').toBeGreaterThan(0);

    if (turn.outcome !== TurnOutcome.QUEUED) {
      /*
       * A halt is a legitimate outcome and this suite records it rather than failing: the
       * chain it exists to prove did not happen, so nothing may be minted from it.
       */
      console.log('SERVA CODE — the request halted at ' + String(turn.stage));
      console.log('  ' + String(turn.haltReason));
      rt.close();
      return;
    }

    /* --------------------- 2. the SAME work item is built, checked, reviewed, accepted */

    const workItemId = String(turn.workItemId);
    const recipes = new RecipeRegistry([
      liveRecipe('SC-RECIPE-UNIT-TEST', ['test.js'], 'SC-RTC-012'),
    ]);
    const git = new GitService({ repoRoot: repo });
    const substrate = (
      await selectExecutionSubstrate({
        clock: systemClock,
        engineVersion: 'UNKNOWN',
        projectRoot: repo,
      })
    ).substrate;

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
      qualification: e.qualification ?? (qualification as SubstrateQualification),
      executorDeps: {
        store: rt.store,
        clock: rt.clock,
        ids: rt.ids,
        substrate,
        qualification: qualification as SubstrateQualification,
        env: process.env,
      },
      gateDeps: { ids: rt.ids, clock: rt.clock, evaluator: 'ENGINEERING_GATE_LIVE' },
      projectRoot: repo,
      enabledProducers: new Set([PRODUCER]),
      ...(e.boundary === undefined ? {} : { producerBoundary: e.boundary }),
    });

    const item = factory.recordWorkItem({
      workItemId,
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

    const result = await implementWorkItem(
      {
        rt,
        registry: ContractRegistry.shared(),
        recipes,
        recipeSubstrate: substrate,
        recipeQualification: qualification as SubstrateQualification,
        engine: e,
        enabledProducers: new Set([PRODUCER]),
        required: { ...DEFAULT_REQUIRED_CHECKS, build: false, lint: false },
      },
      item,
    );

    console.log('engineering outcome: ' + result.outcome);
    for (const a of result.attempts) {
      console.log(
        '  attempt ' +
          String(a.attempt) +
          ': producer ' +
          String(a.producerRunId) +
          ', reviewer ' +
          String(a.reviewerRunId) +
          ', gate ' +
          String(a.verdict),
      );
    }

    if (result.outcome !== ImplementOutcome.ACCEPTED) {
      console.log('SERVA CODE — the chain did not reach an accepted commit.');
      console.log('  ' + String(result.refusal ?? '(no refusal recorded)'));
      rt.close();
      return;
    }

    /* --------------------------------------------- 3. the record a proof can resolve */

    if (process.env['SERVA_PRESERVE_LIVE'] === '1') {
      const accepted = result.attempts[result.attempts.length - 1];
      mkdirSync(join(process.cwd(), 'evidence', 'acceptance-run'), { recursive: true });
      writeFileSync(
        join(process.cwd(), 'evidence', 'acceptance-run', 'live-serva.json'),
        JSON.stringify(
          {
            producedBy: 'tests/live/servachain.live.test.ts',
            storeRoot: root,
            repoRoot: repo,
            outcome: result.outcome,
            boundaryFingerprint: result.boundaryFingerprint ?? null,
            ownerRequest: { turnId: turn.id, workItemId, runIds: turn.runIds },
            hints: {
              producerRunId: accepted?.producerRunId ?? null,
              reviewerRunId: accepted?.reviewerRunId ?? null,
              changeSetId: accepted?.changeSetId ?? null,
              acceptedCommit: result.commit ?? null,
            },
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
    }

    /* The link that makes this ONE chain: the request and the change share a work item. */
    expect(result.commit).toBeDefined();
    expect(item.workItemId).toBe(turn.workItemId);
    rt.close();
  }, 3_600_000);
});
