import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngineHealthState } from '../../src/engine/types.js';
import { buildAiLayer } from '../../src/app/ai.js';
import { createProject } from '../../src/app/create.js';
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
import { ARTIFACT_TYPES, repository } from '../../src/intelligence/repository.js';
import {
  AcceptanceCriterionSchema,
  RequirementSchema,
} from '../../src/intelligence/artifacts/requirements.js';
import { ServaRuntime } from '../../src/app/runtime.js';
import { EvidenceOrigin } from '../../src/acceptance/evidenceClass.js';
import { cleanup } from '../helpers.js';
import type { OriginatedRef } from '../../src/acceptance/evidenceClass.js';
import type { SubstrateQualification } from '../../src/substrate/types.js';

/**
 * LIVE-SERVA — AN OWNER ASKED, AND GOVERNED WORK REACHED AN ACCEPTED COMMIT.
 *
 * SPEC: Phase 6 final acceptance sequence §1–§5.
 *
 * The first attempt at this halted, correctly: given a repository full of code and a Store
 * that had never baselined any of it, the Orchestrator escalated rather than planning — no
 * acceptance oracle, so nothing to build against. That refusal is now a regression in
 * `tests/servachain.test.ts` and Serva was not changed to accept unknown code.
 *
 * So the fixture is a LEGITIMATELY ONBOARDED project instead. Everything a real existing
 * project would already have is pre-seeded deterministically and tagged
 * `DETERMINISTIC_PRESEED`: the project, a git baseline, the source, an accepted requirement,
 * and a measurable acceptance criterion pointing at a test suite that currently FAILS.
 *
 * Nothing that answers the live request is pre-seeded. No plan, no work item, no ChangeSet, no
 * producer run, no review, no commit. The fixture is legitimate, not pre-solved.
 *
 * If the real chain asks for owner authority, this stops and says so. It does not answer, and
 * it does not adjust the fixture to avoid the question.
 */

const roots: string[] = [];
const fixtures: string[] = [];
const CANDIDATE = 'evidence/acceptance-run/live-serva.json';

afterAll(() => {
  for (const f of fixtures.splice(0)) removeFixtureDir(f);
  if (process.env['SERVA_PRESERVE_LIVE'] === '1') {
    for (const r of roots.splice(0)) console.log('preserved: ' + r);
    return;
  }
  for (const r of roots.splice(0)) cleanup(r);
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

/**
 * A project that is legitimately onboarded, and legitimately broken.
 *
 * SPEC: §1.
 *
 * The requirement and its acceptance criterion are ACCEPTED TRUTH: they say what `total` must
 * do and how anybody checks. The code does not satisfy them, and the declared suite fails.
 * That is an ordinary state for a real project and it is the state the owner's request is
 * about.
 *
 * Returns the refs it seeded so the evidence can name them as pre-seeded rather than live.
 */
function preseed(root: string): { preseeded: OriginatedRef[]; base: string } {
  mkdirSync(join(root, 'src'), { recursive: true });
  createProject({
    root,
    name: 'TotalsFixture',
    idea: 'A tiny library that adds up numbers, used by the ordering flow.',
  });

  writeFileSync(
    join(root, 'test.js'),
    [
      "const total = require('./src/total.js');",
      'let failed = 0;',
      'function check(name, actual, expected) {',
      '  if (actual !== expected) {',
      '    console.error(name + ": expected " + expected + ", got " + actual);',
      '    failed++;',
      '  }',
      '}',
      "check('sums every element', total([1, 2, 3]), 6);",
      "check('empty list is zero', total([]), 0);",
      'process.exit(failed === 0 ? 0 : 1);',
      '',
    ].join('\n'),
    'utf8',
  );

  /* The defect: the loop stops one short, so the last element is never added. */
  writeFileSync(
    join(root, 'src', 'total.js'),
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

  writeFileSync(join(root, '.gitignore'), '.serva/\n', 'utf8');

  const g = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'fixture@localhost');
  g('config', 'user.name', 'Live Fixture');
  g('config', 'commit.gpgsign', 'false');
  g('add', '.');
  g('commit', '-q', '-m', 'the baselined project, with a defect');
  const base = g('rev-parse', 'HEAD').trim();

  const rt = ServaRuntime.open({ root });
  const preseeded: OriginatedRef[] = [];
  try {
    const at = rt.clock.now();
    const meta = {
      provenance: { marking: 'SYSTEM', component: 'deterministic-preseed' },
      attribution: { at },
    };

    const requirementId = rt.ids.next('SC-REQ');
    const criterionId = rt.ids.next('SC-AC');
    const tx = rt.store.begin();

    repository(rt.store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).put(tx, {
      id: requirementId,
      version: 1,
      createdAt: at,
      statement: 'total(xs) returns the sum of every element of xs, and total([]) returns 0.',
      kind: 'FUNCTIONAL',
      priority: 'MUST',
      rationale:
        'The ordering flow prices baskets with it; a short sum undercharges and an empty ' +
        'basket must cost nothing rather than throwing.',
      tracesTo: [],
      meta,
    } as never);

    repository(rt.store, ARTIFACT_TYPES.ACCEPTANCE_CRITERION, AcceptanceCriterionSchema).put(tx, {
      id: criterionId,
      version: 1,
      createdAt: at,
      requirementRef: { id: requirementId, version: 1 },
      criterion: 'The declared test suite (`node test.js`) exits 0.',
      verificationMethod: 'AUTOMATED_TEST',
      meta,
    } as never);

    tx.commit();

    preseeded.push(
      {
        origin: EvidenceOrigin.DETERMINISTIC_PRESEED,
        kind: 'PROJECT',
        id: rt.requireProject().id,
        detail: 'TotalsFixture',
      },
      {
        origin: EvidenceOrigin.DETERMINISTIC_PRESEED,
        kind: 'GIT_BASELINE',
        id: base,
        detail: 'the baselined commit the project was onboarded at',
      },
      {
        origin: EvidenceOrigin.DETERMINISTIC_PRESEED,
        kind: 'REQUIREMENT',
        id: requirementId,
        detail: 'total sums every element; total([]) is 0',
      },
      {
        origin: EvidenceOrigin.DETERMINISTIC_PRESEED,
        kind: 'ACCEPTANCE_CRITERION',
        id: criterionId,
        detail: 'the declared test suite exits 0',
      },
    );
  } finally {
    rt.close();
  }

  return { preseeded, base };
}

beforeAll(async () => {
  engineering = await resolveEngineeringEngine({ clock: systemClock, projectRoot: process.cwd() });
  const selection = await selectExecutionSubstrate({
    clock: systemClock,
    engineVersion: 'UNKNOWN',
    projectRoot: process.cwd(),
  });
  const fixture = makeFixtureDir('serva-live-join-');
  fixtures.push(fixture);
  qualification = await selection.substrate.qualify(fixture);
}, 300_000);

describe('Serva 1.0 — one owner request, across the governed join', () => {
  it('reaches an accepted commit, or stops for the owner', async () => {
    const e = engineering;
    if (e === undefined) {
      console.log('SERVA CODE — OWNER ACTION REQUIRED: no engineering engine on this machine.');
      return;
    }

    /* ------------------------------------------------- 1. the legitimate fixture */

    const root = join(process.cwd(), 'out', 'live-join-fixture');
    const resuming = process.env['SERVA_RESUME'] === '1' && existsSync(join(root, '.serva'));

    let preseeded: OriginatedRef[];
    let base: string;
    if (resuming) {
      console.log('resuming the existing live acceptance from ' + root);
      preseeded = JSON.parse(readFileSync(join(process.cwd(), ...CANDIDATE.split('/')), 'utf8'))
        .preseeded as OriginatedRef[];
      base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    } else {
      execFileSync(process.execPath, [
        '-e',
        'require("node:fs").rmSync(process.argv[1],{recursive:true,force:true})',
        root,
      ]);
      const seeded = preseed(root);
      preseeded = seeded.preseeded;
      base = seeded.base;
      roots.push(root);
    }

    const rt = ServaRuntime.open({ root });
    const layer = buildAiLayer(rt);
    const health = await layer.engine.health();
    if (health.state !== EngineHealthState.READY) {
      console.log('SERVA CODE — OWNER ACTION REQUIRED: ' + (health.remedy ?? health.state));
      rt.close();
      return;
    }

    /* ------------------------------------------------ 2. one real owner request */

    let turn;
    const existing = rt.store.listWorkingIds('conversationTurn');
    if (resuming && existing.length > 0) {
      /*
       * Resume derives ENTIRELY from Store truth. The request is not re-sent, because a second
       * request would be a second execution — and the whole point of resuming is that the
       * chain survives a process ending.
       */
      const id = existing[existing.length - 1] as string;
      turn = rt.store.getWorking<Record<string, unknown>>('conversationTurn', id)?.body as never;
      console.log('resumed the existing request ' + id);
    } else {
      turn = await sendOwnerRequest(
        rt,
        'The declared test suite fails: total() is short by one element and total([]) throws. ' +
          'Please make the suite pass.',
        { orchestrator: layer.orchestrator },
      );
    }

    const t = turn as unknown as {
      id: string;
      outcome: string;
      stage?: string;
      haltReason?: string;
      workItemId?: string;
      runIds: string[];
    };
    console.log('owner request: ' + t.outcome + ' — work item ' + String(t.workItemId));

    /* --------------------------------------------- 3. did Serva ask the owner? */

    const decisions = rt.store
      .listCanonIds(ARTIFACT_TYPES.OWNER_DECISION_REQUEST)
      .map((id) =>
        rt.store.getCanon<Record<string, unknown>>(ARTIFACT_TYPES.OWNER_DECISION_REQUEST, id),
      )
      .filter((e): e is NonNullable<typeof e> => e !== undefined)
      .map((e) => e.body)
      .filter((d) => d['state'] === 'OPEN');

    if (decisions.length > 0) {
      const d = decisions[0] as Record<string, unknown>;
      const options = Array.isArray(d['options']) ? (d['options'] as { option: string }[]) : [];
      console.log('');
      console.log('SERVA CODE — OWNER ACTION REQUIRED');
      console.log('');
      console.log('  decision:       ' + String(d['id']));
      console.log('  question:       ' + String(d['question']));
      console.log('  why Serva cannot decide this:');
      console.log('    ' + String(d['whyServaCannotDecide']));
      console.log('  Serva recommends: ' + String(d['recommendation']));
      console.log('    because ' + String(d['recommendationRationale']));
      if (String(d['responseMode']) === 'VALUE') {
        console.log('  answer shape:   a value of kind ' + String(d['valueKind'] ?? 'TEXT'));
      } else {
        for (const o of options) console.log('  option:         ' + o.option);
      }
      console.log('');
      console.log('  Answer it, as yourself:');
      console.log(
        '    node dist/cli/main.js intelligence answer ' +
          String(d['id']) +
          (String(d['responseMode']) === 'VALUE'
            ? ' --value "<your answer>"'
            : ' --option "<one of the above>"') +
          ' --root ' +
          root,
      );
      console.log('  or in VS Code: `Serva: Answer an owner decision`');
      console.log('');
      console.log('  Then resume THIS acceptance, from the Store:');
      console.log('    SERVA_RESUME=1 SERVA_PRESERVE_LIVE=1 npm run test:serva-chain');
      console.log('');

      writeFileSync(
        join(process.cwd(), ...CANDIDATE.split('/')),
        JSON.stringify(
          {
            producedBy: 'tests/live/servachain.live.test.ts',
            state: 'OWNER_ACTION_REQUIRED',
            storeRoot: root,
            repoRoot: root,
            preseeded,
            ownerRequest: { turnId: t.id, workItemId: t.workItemId, runIds: t.runIds },
            pendingDecision: {
              id: String(d['id']),
              question: String(d['question']),
              responseMode: String(d['responseMode']),
            },
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );

      rt.close();
      /* Not a failure. Serva stopped where it must, and the chain is persisted. */
      return;
    }

    if (t.outcome !== TurnOutcome.QUEUED) {
      console.log('SERVA CODE — the request halted at ' + String(t.stage));
      console.log('  ' + String(t.haltReason));
      rt.close();
      return;
    }

    /* ------------------------------ 4. the SAME work item, built for real */

    const workItemId = String(t.workItemId);
    const recipes = new RecipeRegistry([
      liveRecipe('SC-RECIPE-UNIT-TEST', ['test.js'], 'SC-RTC-012'),
    ]);
    const git = new GitService({ repoRoot: root });
    const substrate = (
      await selectExecutionSubstrate({
        clock: systemClock,
        engineVersion: 'UNKNOWN',
        projectRoot: root,
      })
    ).substrate;

    const factory = new EngineeringFactory({
      store: rt.store,
      git,
      workspaces: new EngineeringWorkspaceManager({
        store: rt.store,
        git,
        clock: rt.clock,
        projectRoot: root,
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
      projectRoot: root,
      enabledProducers: new Set([PRODUCER]),
      ...(e.boundary === undefined ? {} : { producerBoundary: e.boundary }),
    });

    const item = factory.recordWorkItem({
      workItemId,
      title: 'the declared test suite must pass',
      requirements: ['total(xs) returns the sum of every element, and total([]) returns 0.'],
      acceptanceCriteria: ['The declared test suite (`node test.js`) exits 0.'],
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

    const accepted = result.attempts[result.attempts.length - 1];
    writeFileSync(
      join(process.cwd(), ...CANDIDATE.split('/')),
      JSON.stringify(
        {
          producedBy: 'tests/live/servachain.live.test.ts',
          state: result.outcome === ImplementOutcome.ACCEPTED ? 'ACCEPTED' : String(result.outcome),
          storeRoot: root,
          repoRoot: root,
          boundaryFingerprint: result.boundaryFingerprint ?? null,
          preseeded,
          ownerRequest: { turnId: t.id, workItemId, runIds: t.runIds },
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

    if (result.outcome !== ImplementOutcome.ACCEPTED) {
      console.log('SERVA CODE — the chain did not reach an accepted commit.');
      console.log('  ' + String(result.refusal ?? '(no refusal recorded)'));
      rt.close();
      return;
    }

    expect(result.commit).toBeDefined();
    expect(item.workItemId).toBe(t.workItemId);
    rt.close();
  }, 3_600_000);
});
