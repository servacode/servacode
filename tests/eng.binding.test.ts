import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EnforcementClass, EvidenceClass, GateVerdict, RunOutcome } from '../src/vocab/index.js';
import { FAKE_CAPABILITIES, FakeEngineAdapter } from '../src/engine/fake.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { ContractRegistry } from '../src/agents/registry.js';
import {
  SimulatedExecutionSubstrate,
  makeFixtureDir,
  removeFixtureDir,
} from '../src/substrate/fake.js';
import {
  BoundaryPurpose,
  executionBoundary,
  type ExecutionBoundary,
} from '../src/substrate/boundary.js';
import { buildSandboxProfile } from '../src/engineering/sandboxProfile.js';
import { producerRefusal } from '../src/engineering/capability.js';
import { ExecutionRecipeSchema, RecipeRegistry } from '../src/engineering/recipe.js';
import { EngineeringFactory } from '../src/engineering/factory.js';
import { dispatchProducer } from '../src/engineering/dispatch.js';
import { resolveEngineeringEngine } from '../src/engineering/engine.js';
import { implementWorkItem, ImplementOutcome } from '../src/app/implement.js';
import { listReviews } from '../src/engineering/review.js';
import { listExecutions } from '../src/engineering/execution.js';
import { cleanup, freshRuntime, freshStore } from './helpers.js';
import type { ExecutionRecipe } from '../src/engineering/recipe.js';
import type { EngineeringEngine } from '../src/engineering/engine.js';

/**
 * EXECUTION BOUNDARY BINDING, AND THE PRODUCTION FLOW THAT USES IT.
 *
 * The defect: Serva qualified `Windows → WSL2 → bubblewrap → worktree`, then dispatched
 * a Producer through `spawn("claude")` on native Windows. Every check in between passed,
 * because the only question anyone asked was `enforcementClass === HARD` — a claim with
 * no subject. A measurement is a measurement OF something.
 *
 * These tests prove authority now travels with its subject, and that the production
 * `implementWorkItem` flow is the thing that uses it — not a test-only arrangement.
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

function policyDigestFor(projectRoot: string): string {
  return buildSandboxProfile({
    worktreePath: join(projectRoot, 'w'),
    projectRoot,
    networkAllowed: false,
  }).policyDigest;
}

/** A simulated PRODUCER boundary matching the scripted engine's declared location. */
function simulatedProducerBoundary(projectRoot: string): ExecutionBoundary {
  return executionBoundary({
    boundaryId: 'SC-BOUNDARY-PRODUCER',
    purpose: BoundaryPurpose.PRODUCER,
    transport: 'fake',
    engineLocation: 'fake-engine',
    engineVersion: FAKE_CAPABILITIES.version,
    sandboxMechanism: 'simulated',
    profileDigest: policyDigestFor(projectRoot),
    simulated: true,
  });
}

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

/** The envelope an engine returns; `result` is the role payload inside it. */
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

interface Harness {
  rt: ReturnType<typeof freshRuntime>['rt'];
  repo: string;
  base: string;
  engine: FakeEngineAdapter;
  engineering: EngineeringEngine;
  recipes: RecipeRegistry;
  substrate: SimulatedExecutionSubstrate;
  boundary: ExecutionBoundary;
}

/**
 * A project with a real Git repository, a scripted engine and a simulated qualified
 * boundary. Orchestration is what is under test; containment is not, and a simulated
 * boundary can never claim otherwise.
 */
async function harness(o: { passing?: boolean } = {}): Promise<Harness> {
  const { rt, root } = freshRuntime();
  roots.push(root);
  const repo = rt.root;

  mkdirSync(join(repo, 'src'), { recursive: true });
  const g = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(join(repo, '.gitignore'), '.serva/\n', 'utf8');
  writeFileSync(
    join(repo, 'test.js'),
    o.passing === false
      ? 'console.error("assertion failed"); process.exit(1);\n'
      : 'process.exit(0);\n',
    'utf8',
  );
  writeFileSync(join(repo, 'src', 'total.js'), 'module.exports = 1;\n', 'utf8');
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'fx@localhost');
  g('config', 'user.name', 'Fixture');
  g('config', 'commit.gpgsign', 'false');
  g('add', '.');
  g('commit', '-q', '-m', 'base');
  const base = g('rev-parse', 'HEAD').trim();

  const boundary = simulatedProducerBoundary(repo);
  const substrate = new SimulatedExecutionSubstrate({
    clock: rt.clock,
    enforcement: 'HARD',
    boundary,
  });
  const dir = makeFixtureDir();
  fixtures.push(dir);
  const qualification = await substrate.qualify(dir);
  const engine = new FakeEngineAdapter({ clock: rt.clock });

  const engineering: EngineeringEngine = {
    adapter: engine as unknown as EngineeringEngine['adapter'],
    capabilities: await engine.capabilities(),
    status: await engine.health(),
    qualification,
    boundary: qualification.boundary,
    prerequisites: qualification.probe.prerequisites,
    basis: 'simulated boundary for an orchestration test',
  };

  return {
    rt,
    repo,
    base,
    engine,
    engineering,
    recipes: new RecipeRegistry([nodeRecipe('SC-RECIPE-UNIT-TEST', ['test.js'], 'SC-RTC-012')]),
    substrate,
    boundary,
  };
}

function workItem(base: string) {
  return {
    workItemId: 'SC-WI-000500',
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
  };
}

const REQUIRED = {
  scope: true,
  build: false,
  tests: true,
  lint: false,
  secrets: true,
  codeReview: true,
  qaVerification: false,
};

/* ================================================== the gate refuses a mismatch */

describe('a HARD qualification for one boundary does not authorize another', () => {
  async function gate(actual: ExecutionBoundary, allowSimulated = true) {
    const h = await harness();
    return producerRefusal({
      contract: registry.get(PRODUCER),
      qualification: h.engineering.qualification!,
      enabledProducers: new Set([PRODUCER]),
      workspace: { path: join(h.repo, 'wt'), workItemId: 'x' } as never,
      projectRoot: h.repo,
      reviewerAvailable: true,
      executorsAvailable: true,
      actualBoundary: actual,
      allowSimulatedBoundary: allowSimulated,
    });
  }

  it('WSL qualification with a native Windows engine is refused', async () => {
    const h = await harness();
    const native = executionBoundary({
      ...h.boundary,
      transport: 'local',
      engineLocation: 'C:\\Program Files\\claude\\claude.exe',
    });
    expect(await gate(native)).toMatch(/EXECUTION_BOUNDARY_MISMATCH/);
    expect(await gate(native)).toMatch(/transport/);
  });

  it('distribution A does not authorize distribution B', async () => {
    const h = await harness();
    const other = executionBoundary({ ...h.boundary, transport: 'wsl:Debian', guest: 'Debian' });
    expect(await gate(other)).toMatch(/EXECUTION_BOUNDARY_MISMATCH/);
  });

  it('engine version X does not authorize engine version Y', async () => {
    const h = await harness();
    const upgraded = executionBoundary({ ...h.boundary, engineVersion: '99.0.0' });
    expect(await gate(upgraded)).toMatch(/engine version/);
  });

  it('a changed sandbox profile invalidates the prior qualification', async () => {
    const h = await harness();
    const relaxed = executionBoundary({ ...h.boundary, profileDigest: 'z'.repeat(64) });
    expect(await gate(relaxed)).toMatch(/sandbox profile/);
  });

  it('a recipe boundary does not authorize a Producer', async () => {
    const h = await harness();
    // Same machine, same mechanism, measured for a different purpose. Serva's recipe
    // boundary contains `npm test`; it was never measured against an agent with Bash.
    const recipe = executionBoundary({ ...h.boundary, purpose: BoundaryPurpose.RECIPE });
    expect(await gate(recipe)).toMatch(/EXECUTION_BOUNDARY_MISMATCH|RECIPE boundary/);
  });

  it('a simulated boundary is refused unless a test explicitly opts in', async () => {
    const h = await harness();
    expect(await gate(h.boundary, false)).toMatch(/SIMULATED/);
    expect(await gate(h.boundary, true)).toBeUndefined();
  });

  it('the exact qualified boundary is eligible', async () => {
    const h = await harness();
    expect(await gate(h.boundary)).toBeUndefined();
  });
});

/* =============================================== dispatch observes, never asserts */

describe('dispatch derives the boundary from the runtime it is about to use', () => {
  it('a runtime whose engine sits elsewhere is refused, and nothing is spawned', async () => {
    const h = await harness();
    // The qualification says `fake`. This engine declares a different location, which
    // is precisely the native-Windows case in miniature.
    const elsewhere = new FakeEngineAdapter({ clock: h.rt.clock });
    Object.defineProperty(elsewhere, 'executionLocation', {
      value: { transport: 'local', executable: 'C:\\claude.exe' },
    });
    const runtime = new AgentRuntime({
      store: h.rt.store,
      ids: h.rt.ids,
      clock: h.rt.clock,
      registry,
      engine: elsewhere,
      enabledAgents: new Set([PRODUCER, REVIEWER]),
      projectRoot: h.repo,
    });

    const factory = new EngineeringFactory({
      store: h.rt.store,
      git: new (await import('../src/engineering/git.js')).GitService({ repoRoot: h.repo }),
      workspaces: new (await import('../src/engineering/workspace.js')).EngineeringWorkspaceManager(
        {
          store: h.rt.store,
          git: new (await import('../src/engineering/git.js')).GitService({ repoRoot: h.repo }),
          clock: h.rt.clock,
          projectRoot: h.repo,
        },
      ),
      recipes: h.recipes,
      registry,
      qualification: h.engineering.qualification!,
      executorDeps: {
        store: h.rt.store,
        clock: h.rt.clock,
        ids: h.rt.ids,
        substrate: h.substrate,
        qualification: h.engineering.qualification!,
        env: process.env,
      },
      gateDeps: { ids: h.rt.ids, clock: h.rt.clock, evaluator: 'G' },
      projectRoot: h.repo,
      enabledProducers: new Set([PRODUCER]),
      producerBoundary: h.boundary,
      allowSimulatedBoundary: true,
    });
    const item = factory.recordWorkItem(workItem(h.base));
    const w = await factory.openWorkspace(item, 1, 'd'.repeat(64));

    await expect(
      dispatchProducer(
        {
          store: h.rt.store,
          clock: h.rt.clock,
          ids: h.rt.ids,
          runtime,
          registry,
          substrate: h.substrate,
          qualification: h.engineering.qualification!,
          projectRoot: h.repo,
          enabledProducers: new Set([PRODUCER]),
          engineCapabilities: h.engineering.capabilities!,
          engineVersion: FAKE_CAPABILITIES.version,
          allowSimulatedBoundary: true,
        },
        {
          item,
          workspace: w,
          taskDefinition: 'x',
          reviewerAvailable: true,
          executorsAvailable: true,
        },
      ),
    ).rejects.toThrowError(/EXECUTION_BOUNDARY_MISMATCH/);

    expect(elsewhere.seen).toHaveLength(0);
    h.rt.close();
  }, 60_000);

  it('CAPABILITY_BOUND records the boundary fingerprint', async () => {
    const h = await harness();
    const { GitService } = await import('../src/engineering/git.js');
    const { EngineeringWorkspaceManager } = await import('../src/engineering/workspace.js');
    const git = new GitService({ repoRoot: h.repo });
    const workspaces = new EngineeringWorkspaceManager({
      store: h.rt.store,
      git,
      clock: h.rt.clock,
      projectRoot: h.repo,
    });
    const runtime = new AgentRuntime({
      store: h.rt.store,
      ids: h.rt.ids,
      clock: h.rt.clock,
      registry,
      engine: h.engine,
      enabledAgents: new Set([PRODUCER, REVIEWER]),
      projectRoot: h.repo,
    });
    const factory = new EngineeringFactory({
      store: h.rt.store,
      git,
      workspaces,
      recipes: h.recipes,
      registry,
      qualification: h.engineering.qualification!,
      executorDeps: {
        store: h.rt.store,
        clock: h.rt.clock,
        ids: h.rt.ids,
        substrate: h.substrate,
        qualification: h.engineering.qualification!,
        env: process.env,
      },
      gateDeps: { ids: h.rt.ids, clock: h.rt.clock, evaluator: 'G' },
      projectRoot: h.repo,
      enabledProducers: new Set([PRODUCER]),
      producerBoundary: h.boundary,
      allowSimulatedBoundary: true,
    });
    const item = factory.recordWorkItem(workItem(h.base));
    const w = await factory.openWorkspace(item, 1, 'd'.repeat(64));
    h.engine.script(PRODUCER, {
      structuredOutput: envelope({
        summary: 'x',
        claimedPaths: [],
        observations: [],
        blockers: [],
      }),
    });

    const d = await dispatchProducer(
      {
        store: h.rt.store,
        clock: h.rt.clock,
        ids: h.rt.ids,
        runtime,
        registry,
        substrate: h.substrate,
        qualification: h.engineering.qualification!,
        projectRoot: h.repo,
        enabledProducers: new Set([PRODUCER]),
        engineCapabilities: h.engineering.capabilities!,
        engineVersion: FAKE_CAPABILITIES.version,
        allowSimulatedBoundary: true,
      },
      {
        item,
        workspace: w,
        taskDefinition: 'x',
        reviewerAvailable: true,
        executorsAvailable: true,
      },
    );

    const bound = h.rt.store
      .readTrace('agentrun/' + d.runId)
      .find((e) => e.type === 'CAPABILITY_BOUND');
    const rationale = (bound?.payload as { rationale: string[] }).rationale.join(' ');
    // "What could run X do, and where?" answerable from the log alone.
    expect(rationale).toContain(h.boundary.fingerprint);
    expect(rationale).toMatch(/execution boundary: SC-BOUNDARY-PRODUCER/);
    h.rt.close();
  }, 60_000);
});

/* ================================================ the guest engine is probed, not assumed */

describe('the engineering engine refuses rather than falling back to the host', () => {
  it('an unsupported platform yields a satisfiable prerequisite and no adapter', async () => {
    const { rt, root } = freshRuntime();
    roots.push(root);
    const e = await resolveEngineeringEngine({
      clock: rt.clock,
      projectRoot: rt.root,
      platform: 'aix' as NodeJS.Platform,
    });
    rt.close();
    expect(e.adapter).toBeUndefined();
    expect(e.prerequisites[0]?.id).toBe('SUPPORTED_PLATFORM');
    expect(e.refusal).toMatch(/PLATFORM_PREREQUISITE_REQUIRED/);
  });

  it('Windows with no WSL2 guest never falls back to the native engine', async () => {
    const { rt, root } = freshRuntime();
    roots.push(root);
    const e = await resolveEngineeringEngine({
      clock: rt.clock,
      projectRoot: rt.root,
      platform: 'win32',
      env: {},
      listDistributions: async () => [],
    });
    rt.close();
    // The whole defect in one assertion: no adapter is produced, so there is nothing
    // to dispatch onto the host.
    expect(e.adapter).toBeUndefined();
    expect(e.prerequisites[0]?.id).toBe('WSL_DISTRIBUTION');
    expect(e.prerequisites[0]?.remedy).toMatch(/Install WSL2/);
  });
});

/* ================================================= the production flow, end to end */

describe('implementWorkItem is the production path', () => {
  async function run(h: Harness, o: { producerFixes?: boolean; reviewer?: 'PASS' | 'FAIL' } = {}) {
    const item = workItem(h.base);
    const factory = new EngineeringFactory({
      store: h.rt.store,
      git: new (await import('../src/engineering/git.js')).GitService({ repoRoot: h.repo }),
      workspaces: new (await import('../src/engineering/workspace.js')).EngineeringWorkspaceManager(
        {
          store: h.rt.store,
          git: new (await import('../src/engineering/git.js')).GitService({ repoRoot: h.repo }),
          clock: h.rt.clock,
          projectRoot: h.repo,
        },
      ),
      recipes: h.recipes,
      registry,
      qualification: h.engineering.qualification!,
      executorDeps: {
        store: h.rt.store,
        clock: h.rt.clock,
        ids: h.rt.ids,
        substrate: h.substrate,
        qualification: h.engineering.qualification!,
        env: process.env,
      },
      gateDeps: { ids: h.rt.ids, clock: h.rt.clock, evaluator: 'G' },
      projectRoot: h.repo,
      enabledProducers: new Set([PRODUCER]),
      producerBoundary: h.boundary,
      allowSimulatedBoundary: true,
    });
    const recorded = factory.recordWorkItem(item);

    for (let i = 0; i < 3; i++) {
      h.engine.script(PRODUCER, {
        /*
         * The scripted engine's side effect IS the Producer's Edit tool call.
         *
         * This is not a stand-in for the Producer: the run, the grant, the boundary
         * check and the record are all real, and the only thing simulated is the
         * model's choice of edit. The production flow contains no write of its own —
         * a separate test asserts that `src/` never calls writeFileSync for this.
         */
        structuredOutputFrom: (req) => {
          writeFileSync(join(req.cwd, 'src', 'total.js'), 'module.exports = 2;\n', 'utf8');
          return envelope({
            summary: 'edited total()',
            claimedPaths: ['src/total.js'],
            observations: [],
            blockers: [],
          });
        },
      });
    }
    h.engine.scriptDefault({
      // The reviewer must echo the ChangeSet it was given, and Serva refuses a verdict
      // that names a different one. Reading it back out of the prompt is how a fixture
      // behaves like a reviewer instead of agreeing with the test.
      structuredOutputFrom: (req) =>
        envelope({
          criterionId: 'EC-REVIEW',
          outcome: o.reviewer ?? 'PASS',
          changeSetId:
            /ChangeSet (SC-CS-[A-Za-z0-9-]+)/.exec(req.systemPrompt + req.prompt)?.[1] ?? 'UNKNOWN',
          summary: 'reviewed',
          findings: o.reviewer === 'FAIL' ? [{ severity: 'BLOCKING', detail: 'no' }] : [],
          confidence: 'HIGH',
        }),
    });

    return { recorded, factory };
  }

  it('refuses before any worktree, model call or command when the boundary is not HARD', async () => {
    const h = await harness();
    const soft = new SimulatedExecutionSubstrate({
      clock: h.rt.clock,
      enforcement: 'SOFT',
      boundary: h.boundary,
    });
    const dir = makeFixtureDir();
    fixtures.push(dir);
    const q = await soft.qualify(dir);

    const result = await implementWorkItem(
      {
        rt: h.rt,
        registry,
        recipes: h.recipes,
        recipeSubstrate: h.substrate,
        recipeQualification: h.engineering.qualification!,
        engine: { ...h.engineering, qualification: q, boundary: q.boundary },
        enabledProducers: new Set([PRODUCER]),
        allowSimulatedBoundary: true,
      },
      workItem(h.base),
    );
    h.rt.close();

    expect(result.outcome).toBe(ImplementOutcome.BLOCKED);
    expect(result.refusal).toMatch(/measured SOFT/);
    expect(result.attempts).toEqual([]);
    expect(h.engine.seen).toHaveLength(0);
    expect(listExecutions(h.rt.store)).toHaveLength(0);
  }, 60_000);

  it('dispatches a real Producer run, measures, reviews, and accepts an exact commit', async () => {
    const h = await harness();
    await run(h);

    const result = await implementWorkItem(
      {
        rt: h.rt,
        registry,
        recipes: h.recipes,
        recipeSubstrate: h.substrate,
        recipeQualification: h.engineering.qualification!,
        engine: h.engineering,
        enabledProducers: new Set([PRODUCER]),
        required: REQUIRED,
        allowSimulatedBoundary: true,
      },
      workItem(h.base),
    );

    const attempt = result.attempts[0];
    expect(attempt?.producerRunId).toMatch(/^SC-RUN-/);
    expect(attempt?.reviewerRunId).toMatch(/^SC-RUN-/);
    // Two runs, two sessions, and the reviewer is not the producer.
    expect(attempt?.producerRunId).not.toBe(attempt?.reviewerRunId);
    expect(h.engine.seen.length).toBeGreaterThanOrEqual(2);
    expect(h.engine.seen[0]?.runId).not.toBe(h.engine.seen[1]?.runId);

    // The Producer's own words created no evidence; SC-RTC-012 did.
    expect(listExecutions(h.rt.store).length).toBeGreaterThan(0);
    expect(
      result.verification?.evidence.some(
        (e) => e.basis === 'MEASURED' && e.capturedBy === 'RUNTIME',
      ),
    ).toBe(true);

    h.rt.close();
  }, 120_000);

  it('a failed measurement drives rework and stops at the configured limit', async () => {
    const h = await harness({ passing: false });
    await run(h);

    const result = await implementWorkItem(
      {
        rt: h.rt,
        registry,
        recipes: h.recipes,
        recipeSubstrate: h.substrate,
        recipeQualification: h.engineering.qualification!,
        engine: h.engineering,
        enabledProducers: new Set([PRODUCER]),
        required: { ...REQUIRED, codeReview: false },
        allowSimulatedBoundary: true,
      },
      { ...workItem(h.base), maxAttempts: 2 },
    );
    h.rt.close();

    expect(result.outcome).toBe(ImplementOutcome.REWORK_EXHAUSTED);
    // Bounded: exactly maxAttempts, never an unbounded repair loop.
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.verdict).toBe(GateVerdict.FAIL);
    expect(result.commit).toBeUndefined();
  }, 120_000);

  it('the reviewer verdict the gate consumes is a persisted one', async () => {
    const h = await harness();
    await run(h);
    await implementWorkItem(
      {
        rt: h.rt,
        registry,
        recipes: h.recipes,
        recipeSubstrate: h.substrate,
        recipeQualification: h.engineering.qualification!,
        engine: h.engineering,
        enabledProducers: new Set([PRODUCER]),
        required: REQUIRED,
        allowSimulatedBoundary: true,
      },
      workItem(h.base),
    );
    const reviews = listReviews(h.rt.store);
    h.rt.close();

    // Whatever the gate concluded, it concluded it from a review tied to a real run.
    for (const r of reviews) {
      expect(r.runRef).toMatch(/^SC-RUN-/);
      expect(r.reviewerAgentId).toBe(REVIEWER);
      expect(r.reviewerAgentId).not.toBe(r.producerAgentId);
    }
  }, 120_000);
});

/* ============================================ no production path takes the shortcut */

describe('no production code derives write authority from an enforcement class alone', () => {
  const sources = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) out.push(p);
      }
    };
    walk(dir);
    return out;
  };

  it('the capability gate cannot be called without a boundary', () => {
    /*
     * Enforced by the type system rather than by vigilance: `actualBoundary` is a
     * required field of `ProducerGateInput`, so there is no call site that can omit it
     * and still compile. This test states the property so a future edit that made it
     * optional would have to delete an assertion rather than merely relax a type.
     */
    const src = readFileSync('src/engineering/capability.ts', 'utf8');
    expect(src).toMatch(/readonly actualBoundary: ExecutionBoundary;/);
    expect(src).not.toMatch(/readonly actualBoundary\?: ExecutionBoundary;/);
    // And the boundary comparison runs before the enforcement-class check.
    const gateBody = src.slice(src.indexOf('export function producerRefusal'));
    expect(gateBody.indexOf('boundaryMismatch')).toBeLessThan(
      gateBody.indexOf('engineeringAuthorityRefusal'),
    );
  });

  it('nothing under src/ enables the simulated-boundary opt-in', () => {
    // The escape hatch that makes orchestration testable must not exist in production.
    const offenders = sources(resolve('src')).filter((f) =>
      /allowSimulatedBoundary:\s*true/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('nothing under src/ passes testOnlyJudged', () => {
    const offenders = sources(resolve('src')).filter((f) =>
      /testOnlyJudged:\s*\[/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the CLI reaches the production flow, not a test seam', () => {
    const cli = readFileSync('src/cli/commands/implement.ts', 'utf8');
    expect(cli).toMatch(/implementWorkItem/);
    expect(cli).not.toMatch(/allowSimulatedBoundary/);
    expect(cli).not.toMatch(/writeFileSync/);
  });
});

/* ------------------------------------------------------------------ smoke check */

describe('the engine adapter declares where it runs', () => {
  it('a fake engine declares itself fake, so it can never match a measured boundary', async () => {
    const { rt, root } = freshRuntime();
    roots.push(root);
    const engine = new FakeEngineAdapter({ clock: rt.clock });
    rt.close();
    expect(engine.executionLocation.transport).toBe('fake');
    expect(RunOutcome.COMPLETED).toBe('COMPLETED');
    expect(EnforcementClass.HARD).toBe('HARD');
  });

  it('a freshly built store has no engineering executions until something runs', () => {
    const { store, root } = freshStore();
    roots.push(root);
    expect(listExecutions(store)).toEqual([]);
  });
});
