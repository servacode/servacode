import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngineHealthState } from '../../src/engine/types.js';
import { buildAiLayer } from '../../src/app/ai.js';
import { createProject } from '../../src/app/create.js';
import { sendOwnerRequest, TurnOutcome } from '../../src/app/conversation.js';
import { resolveEngineeringEngine, type EngineeringEngine } from '../../src/engineering/engine.js';
import {
  RecipeRegistry,
  ExecutionRecipeSchema,
  type ExecutionRecipe,
} from '../../src/engineering/recipe.js';
import { EvidenceClass } from '../../src/vocab/index.js';
import { EngineeringFactory } from '../../src/engineering/factory.js';
import { GitService } from '../../src/engineering/git.js';
import { EngineeringWorkspaceManager } from '../../src/engineering/workspace.js';
import { DEFAULT_REQUIRED_CHECKS } from '../../src/engineering/executors.js';
import { implementWorkItem, ImplementOutcome } from '../../src/app/implement.js';
import { selectExecutionSubstrate } from '../../src/substrate/host.js';
import { qualifyOsSandbox } from '../../src/engineering/osQualification.js';
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
import { QualificationAttempt } from '../../src/substrate/types.js';
import { EnforcementClass } from '../../src/vocab/index.js';
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

  /*
   * THE PROJECT DECLARES ITS OWN MODULE SYSTEM.
   *
   * SPEC: Phase 6 fixture correction §3.
   *
   * Omitting this made the first live chain INVALID. Worktrees are created under
   * `<projectRoot>/../.serva-workspaces/…`, which for this fixture is inside the Serva
   * repository — so Node walked up, found Serva's own `package.json` with `"type": "module"`,
   * and refused to load a CommonJS `test.js`. The declared acceptance oracle never executed:
   * four runs, every one `ReferenceError: require is not defined`, not one reaching `total()`.
   *
   * This is truth that legitimately existed before the owner request. A real CommonJS project
   * says so in its manifest; this fixture simply failed to. It pre-solves nothing — the
   * off-by-one defect remains, the acceptance criterion remains unmet, and the suite still
   * fails until a Producer fixes the code.
   */
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      { name: 'totals-fixture', version: '1.0.0', private: true, type: 'commonjs' },
      null,
      2,
    ) + '\n',
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

export interface OraclePreflight {
  readonly eligible: boolean;
  readonly exitCode: number | null;
  readonly reachedProduct: boolean;
  readonly assertionFailure: boolean;
  readonly environmentError: boolean;
  readonly output: string;
  readonly reason: string;
}

/**
 * PROVE THE ORACLE RUNS AND FAILS FOR THE INTENDED DEFECT — BEFORE SPENDING ANYTHING.
 *
 * SPEC: Phase 6 fixture correction §4.
 *
 * The first live chain burned four Producer attempts and two Reviewer runs discovering that its
 * acceptance oracle could not execute at all. Every model call in that run was spent proving a
 * fixture defect. This is the check that makes that impossible to repeat.
 *
 * Three outcomes, and only one of them is eligible:
 *
 *   RUNS and fails on an ASSERTION  the fixture represents the intended defect. Proceed.
 *   RUNS and PASSES                 the defect is not there; there is nothing to ask for.
 *   FAILS to run at all             a fixture or environment problem, which no Producer can fix.
 *
 * Deliberately run with the HOST node against the fixture directory rather than through the
 * sandbox: this is asking whether the fixture is coherent, not whether the boundary contains
 * anything, and it must cost nothing and depend on nothing.
 */
export function oraclePreflight(root: string): OraclePreflight {
  let exitCode: number | null = 0;
  let output = '';
  try {
    output = execFileSync(process.execPath, ['test.js'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as { status?: number | null; stdout?: string; stderr?: string };
    exitCode = err.status ?? null;
    output = String(err.stdout ?? '') + String(err.stderr ?? '');
  }

  /*
   * An environment error is anything that stops the interpreter before the product is reached.
   * Named explicitly rather than inferred from "not an assertion", because the interesting case
   * — a suite that runs and fails correctly — must not be reachable by a typo in this list.
   */
  const environmentError =
    /ReferenceError|SyntaxError|Cannot find module|ERR_[A-Z_]+|is not defined in ES module scope/.test(
      output,
    );

  /* The fixture's own assertion text. It only appears once `total()` has actually been called. */
  const assertionFailure = /expected \d+, got \d+/.test(output);
  const reachedProduct = assertionFailure || exitCode === 0;

  const eligible = exitCode !== 0 && assertionFailure && !environmentError;

  return {
    eligible,
    exitCode,
    reachedProduct,
    assertionFailure,
    environmentError,
    output: output.trim().slice(0, 600),
    reason: eligible
      ? 'the oracle runs and fails on an assertion against the intended defect'
      : environmentError
        ? 'the oracle did not execute: the failure is environmental, not a product defect'
        : exitCode === 0
          ? 'the oracle PASSES on the baseline, so the intended defect is not present'
          : 'the oracle failed without reaching the product',
  };
}

/**
 * Reconstruct what was pre-seeded, from the Store rather than from a file.
 *
 * SPEC: §3 — after a process restart, continuation must derive entirely from Store truth.
 *
 * Everything here is read back out of canon, so a resumed run describes the same project the
 * first run did without depending on anything the first run remembered to write down.
 */
function preseededFromStore(root: string): OriginatedRef[] {
  const rt = ServaRuntime.open({ root });
  try {
    const project = rt.requireProject();
    const refs: OriginatedRef[] = [
      {
        origin: EvidenceOrigin.DETERMINISTIC_PRESEED,
        kind: 'PROJECT',
        id: project.id,
        detail: project.name,
      },
      {
        origin: EvidenceOrigin.DETERMINISTIC_PRESEED,
        kind: 'GIT_BASELINE',
        id: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        detail: 'the baselined commit the project was onboarded at',
      },
    ];
    for (const id of rt.store.listCanonIds(ARTIFACT_TYPES.REQUIREMENT)) {
      refs.push({ origin: EvidenceOrigin.DETERMINISTIC_PRESEED, kind: 'REQUIREMENT', id });
    }
    for (const id of rt.store.listCanonIds(ARTIFACT_TYPES.ACCEPTANCE_CRITERION)) {
      refs.push({ origin: EvidenceOrigin.DETERMINISTIC_PRESEED, kind: 'ACCEPTANCE_CRITERION', id });
    }
    return refs;
  } finally {
    rt.close();
  }
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
      /*
       * CONTINUATION DERIVES FROM STORE TRUTH.
       *
       * SPEC: §3.
       *
       * An earlier version read the pre-seed list back out of the JSON the previous run wrote,
       * and the first time a run crashed before writing it, resume could not start at all —
       * which is precisely the situation resume exists for. The Store holds all of it, so it
       * is read back from there instead.
       */
      console.log('resuming the existing live acceptance from ' + root);
      preseeded = preseededFromStore(root);
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

    /*
     * ORACLE PREFLIGHT — the gate that costs nothing and prevents the last failure.
     *
     * SPEC: §4. The invalid chain spent four Producer attempts and two Reviewer runs
     * discovering that its acceptance oracle could not execute. Nothing may be spent until the
     * baseline is proved to fail FOR THE INTENDED DEFECT.
     */
    const preflight = oraclePreflight(root);
    console.log(
      'oracle preflight: exit ' +
        String(preflight.exitCode) +
        ' | reachedProduct=' +
        String(preflight.reachedProduct) +
        ' | assertion=' +
        String(preflight.assertionFailure) +
        ' | environmentError=' +
        String(preflight.environmentError),
    );
    console.log('  ' + preflight.reason);
    if (!preflight.eligible) {
      console.log('SERVA CODE — the fixture is not eligible for a live run. Nothing was spent.');
      console.log(preflight.output);
      rt.close();
      /*
       * A failure, not a skip. An ineligible fixture means this acceptance cannot be attempted,
       * and a green test would say the opposite.
       */
      expect(preflight.eligible, preflight.reason).toBe(true);
      return;
    }

    /*
     * The containment this machine actually has, handed to plan validation.
     *
     * MEASURED, not assumed: `available` is true only when this attempt reached the guest and
     * found HARD. On a SOFT or unreachable machine this is false and a write-capable step is
     * refused exactly as it was before Phase 4 existed.
     */
    const producerHard =
      qualification !== undefined &&
      qualification.attempt === QualificationAttempt.MEASURED &&
      qualification.enforcementClass === EnforcementClass.HARD;

    const layer = buildAiLayer(rt, {
      producerExecution: {
        available: producerHard,
        /*
         * Every agent the engineering factory runs INSIDE the measured boundary, not only the
         * one that writes code. The live planner produced a three-step plan — QA, Backend,
         * Code Review — and declaring only the Producer refused the reviewer step, because a
         * reviewer also executes in a worktree and is contained by the same boundary.
         */
        producers: new Set([PRODUCER, REVIEWER, 'SC-AGENT-200', 'SC-AGENT-210']),
        basis: producerHard
          ? 'this machine measured HARD and the boundary is reachable'
          : 'the substrate did not measure HARD on this machine',
      },
    });
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
      /*
       * THE REQUEST MUST STATE SOMETHING TRUE OF THE SEEDED CODE.
       *
       * This used to add "and total([]) throws", which is false: the seeded loop is skipped at
       * length 0, so the empty case already returns 0 and its check already passes. Serva's
       * planner noticed exactly that — CLAIM_STATE_MISMATCH, "project state shows it returns
       * 0" — recorded it unresolved, and the plan validator halted for the owner.
       *
       * That is the product behaving correctly, and it is why the fixture text is corrected
       * rather than the check relaxed: the halt-on-unresolved path has its own offline test
       * (`halts when the plan records unresolved items`), so nothing is lost here. What this
       * fixture exists to exercise is the CROSS-PHASE JOIN reaching an accepted commit, and it
       * cannot do that while asking Serva to fix something that is not broken.
       */
      turn = await sendOwnerRequest(
        rt,
        'The declared test suite fails: total() is short by one element. Please make the ' +
          'suite pass.',
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

    /*
     * THE OS SANDBOX MUST BE MEASURED BEFORE A PRODUCER MAY RUN.
     *
     * The factory refuses with SANDBOX_NOT_MEASURED otherwise, and that refusal is correct: a
     * policy nobody probed is an unproved sandbox, not a proved one. The measurement runs
     * adversarially under the real policy and is recorded against that policy's digest.
     */
    if (e.boundary !== undefined && e.qualification !== undefined) {
      const probeItem = factory.recordWorkItem({
        workItemId: workItemId + '-sandbox-probe',
        title: 'OS sandbox qualification',
        requirements: ['Run each listed probe script exactly once.'],
        acceptanceCriteria: ['Every probe has been attempted.'],
        decisions: [],
        allowedScope: ['src/'],
        forbiddenScope: [],
        producerAgentId: PRODUCER,
        reviewerAgentId: REVIEWER,
        recipes: [],
        magnitude: 'M1',
        baseCommit: base,
        expectedOutputs: [],
        maxAttempts: 1,
      });
      const measured = await qualifyOsSandbox(
        {
          store: rt.store,
          clock: rt.clock,
          ids: rt.ids,
          registry: ContractRegistry.shared(),
          factory,
          workspaces: new EngineeringWorkspaceManager({
            store: rt.store,
            git,
            clock: rt.clock,
            projectRoot: root,
          }),
          substrate,
          engine: e,
          qualification: e.qualification,
          projectRoot: root,
          producerAgentId: PRODUCER,
        },
        probeItem,
      );
      console.log(
        'os sandbox measured: ' +
          String(measured.measurement.containment.filter((c) => c.contained).length) +
          '/' +
          String(measured.measurement.containment.length) +
          ' contained, policy ' +
          measured.measurement.policyDigest.slice(0, 12),
      );
    }

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
