import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EnforcementClass, EvidenceClass, GateVerdict, ValidityState } from '../src/vocab/index.js';
import { ContractRegistry } from '../src/agents/registry.js';
import {
  SimulatedExecutionSubstrate,
  makeFixtureDir,
  removeFixtureDir,
} from '../src/substrate/fake.js';
import { GitService } from '../src/engineering/git.js';
import { EngineeringWorkspaceManager } from '../src/engineering/workspace.js';
import {
  BUILTIN_RECIPES,
  ExecutionRecipeSchema,
  MINIMAL_ENV_KEYS,
  RecipeRegistry,
  scrubEnvironment,
  validateRecipe,
  type ExecutionRecipe,
} from '../src/engineering/recipe.js';
import {
  ExecutionOutcome,
  deriveEvidenceValidity,
  listExecutions,
  runRecipe,
  type ExecutorDeps,
} from '../src/engineering/execution.js';
import { buildChangeSet, type ChangeSet } from '../src/engineering/changeset.js';
import {
  DEFAULT_REQUIRED_CHECKS,
  RuntimeComponent,
  runSecretsScan,
  type ExecutorContext,
} from '../src/engineering/executors.js';
import { buildCriterionEvaluations, evaluateEngineeringGate } from '../src/engineering/gate.js';
import {
  PRODUCER_DENIED_COMMANDS,
  producerRefusal,
  resolveProducerPolicy,
  resolveReviewerPolicy,
} from '../src/engineering/capability.js';
import { EngineeringFactory, routeVerdict } from '../src/engineering/factory.js';
import { SECRET_RULES, redactSecrets, scanText } from '../src/engineering/secrets.js';
import { REVIEW_CANON_TYPE } from '../src/engineering/review.js';
import { FORBIDDEN_GIT_VERBS, gitVerb } from '../src/engineering/git.js';
import { buildSandboxProfile } from '../src/engineering/sandboxProfile.js';
import { FAKE_CAPABILITIES } from '../src/engine/fake.js';
import {
  BoundaryPurpose,
  executionBoundary,
  type ExecutionBoundary,
} from '../src/substrate/boundary.js';
import { cleanup, freshStore } from './helpers.js';
import { SequentialIdSource } from '../src/core/ids.js';
import { FixedClock } from '../src/core/clock.js';

/**
 * EVIDENCE, THE ENGINEERING GATE, AND PRODUCER CAPABILITY.
 *
 * The property under test throughout: **an agent's claim is never evidence.** Only a
 * runtime component's observation reaches the gate, only against the ChangeSet it
 * measured, and editing the code makes every earlier measurement stale rather than
 * carrying it forward.
 *
 * These tests run REAL child processes against a REAL disposable Git repository, never
 * against the Serva source tree. The fixture recipes invoke `node` directly rather than
 * `npm`, because `npm` is a shell script on Windows and the substrate spawns without a
 * shell on purpose â€” a test that needed a shell would be testing a boundary Serva
 * deliberately does not grant.
 */

const roots: string[] = [];
const fixtures: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
  for (const f of fixtures.splice(0)) removeFixtureDir(f);
});

const registry = ContractRegistry.shared();

/** Recipes for the fixture repository: same ids, same components, no npm shim. */
function fixtureRecipe(o: {
  id: string;
  args: string[];
  component: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): ExecutionRecipe {
  return ExecutionRecipeSchema.parse({
    id: o.id,
    purpose: 'Fixture recipe for the engineering test suite.',
    executable: 'node',
    args: o.args,
    cwdPolicy: 'WORKSPACE',
    environmentPolicy: 'MINIMAL',
    networkPolicy: 'NONE',
    timeoutMs: o.timeoutMs ?? 60_000,
    maxOutputBytes: o.maxOutputBytes ?? 1_000_000,
    successExitCodes: [0],
    evidenceClass: EvidenceClass.EXECUTION,
    runtimeComponentId: o.component,
    applicability: 'The disposable fixture repository only.',
  });
}

const FIXTURE_RECIPES: readonly ExecutionRecipe[] = [
  fixtureRecipe({ id: 'SC-RECIPE-UNIT-TEST', args: ['test.js'], component: 'SC-RTC-012' }),
  fixtureRecipe({ id: 'SC-RECIPE-BUILD', args: ['build.js'], component: 'SC-RTC-011' }),
  fixtureRecipe({ id: 'SC-RECIPE-LINT', args: ['lint.js'], component: 'SC-RTC-013' }),
  fixtureRecipe({
    id: 'SC-RECIPE-SLOW',
    args: ['-e', 'setTimeout(function () {}, 60000)'],
    component: 'SC-RTC-012',
    timeoutMs: 1_000,
  }),
  fixtureRecipe({
    id: 'SC-RECIPE-NOISY',
    args: ['-e', 'process.stdout.write("x".repeat(50000))'],
    component: 'SC-RTC-012',
    maxOutputBytes: 1_000,
  }),
];

const BASE_RECIPE = FIXTURE_RECIPES[0]!;

interface Fixture {
  readonly repo: string;
  readonly base: string;
  readonly store: ReturnType<typeof freshStore>['store'];
  readonly git: GitService;
  readonly substrate: SimulatedExecutionSubstrate;
  readonly qualification: Awaited<ReturnType<SimulatedExecutionSubstrate['qualify']>>;
  readonly recipes: RecipeRegistry;
  readonly executorDeps: ExecutorDeps;
  readonly gateDeps: { ids: SequentialIdSource; clock: FixedClock; evaluator: string };
  readonly factory: EngineeringFactory;
  readonly deps: ReturnType<typeof freshStore>['deps'];
}

/**
 * A disposable fixture repository, never the real source tree.
 *
 * `passing` decides whether the fixture's own test script exits 0 or 1, which is how a
 * gate failure is produced from a genuine measurement rather than from a stub.
 */

/**
 * A simulated PRODUCER boundary matching the scripted engine's own location.
 *
 * Orchestration has to be testable without a qualified machine. The boundary is marked
 * simulated â€” the fixture does not get to describe itself as measured â€” so every use of
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

async function setupFactory(
  passing = true,
  enforcement: 'HARD' | 'SOFT' | 'NONE' = 'HARD',
): Promise<Fixture> {
  const { store, root, deps } = freshStore();
  roots.push(root);

  const repo = join(root, 'fixture-repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  writeFileSync(join(repo, 'package.json'), '{"name":"fixture","private":true}\n', 'utf8');
  writeFileSync(
    join(repo, 'test.js'),
    passing
      ? 'process.exit(0);\n'
      : 'console.error("assertion failed: expected 2, got 1");\nprocess.exit(1);\n',
    'utf8',
  );
  writeFileSync(join(repo, 'build.js'), 'process.exit(0);\n', 'utf8');
  writeFileSync(join(repo, 'lint.js'), 'process.exit(0);\n', 'utf8');
  writeFileSync(join(repo, 'src', 'app.js'), 'module.exports = 1;\n', 'utf8');

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@localhost');
  git('config', 'user.name', 'Fixture');
  git('config', 'commit.gpgsign', 'false');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();

  const service = new GitService({ repoRoot: repo });
  const workspaces = new EngineeringWorkspaceManager({
    store,
    git: service,
    clock: deps.clock,
    projectRoot: repo,
  });
  const substrate = new SimulatedExecutionSubstrate({
    clock: new FixedClock(),
    enforcement,
    boundary: simulatedProducerBoundary(repo),
  });
  const fixtureDir = makeFixtureDir();
  fixtures.push(fixtureDir);
  const qualification = await substrate.qualify(fixtureDir);
  const recipes = new RecipeRegistry(FIXTURE_RECIPES);

  const executorDeps: ExecutorDeps = {
    store,
    clock: deps.clock,
    ids: deps.ids,
    substrate,
    qualification,
    env: process.env,
  };
  const gateDeps = {
    ids: deps.ids as SequentialIdSource,
    clock: deps.clock as FixedClock,
    evaluator: 'ENGINEERING_GATE',
  };

  const factory = new EngineeringFactory({
    store,
    git: service,
    workspaces,
    recipes,
    registry,
    qualification,
    executorDeps,
    gateDeps,
    projectRoot: repo,
    enabledProducers: new Set(['SC-AGENT-150']),
    producerBoundary: qualification.boundary,
    allowSimulatedBoundary: true,
  });

  return {
    repo,
    base,
    store,
    git: service,
    substrate,
    qualification,
    recipes,
    executorDeps,
    gateDeps,
    factory,
    deps,
  };
}

const WORK_ITEM = {
  workItemId: 'SC-WI-000100',
  title: 'Fix the failing assertion',
  requirements: ['The module returns 2.'],
  acceptanceCriteria: ['The declared test suite passes.'],
  decisions: [],
  allowedScope: ['src/'],
  forbiddenScope: [],
  producerAgentId: 'SC-AGENT-150',
  reviewerAgentId: 'SC-AGENT-200',
  recipes: ['SC-RECIPE-UNIT-TEST'],
  magnitude: 'M1',
  baseCommit: 'placeholder',
  expectedOutputs: [],
  maxAttempts: 2,
};

const NO_REVIEW = {
  ...DEFAULT_REQUIRED_CHECKS,
  build: false,
  lint: false,
  codeReview: false,
};

const SCOPE_AND_TESTS = {
  scope: true,
  build: false,
  tests: true,
  lint: false,
  secrets: false,
  codeReview: false,
  qaVerification: false,
};

const JUDGED_ONLY = {
  ...DEFAULT_REQUIRED_CHECKS,
  scope: false,
  build: false,
  tests: false,
  lint: false,
  secrets: false,
};

/** A ChangeSet stand-in for the pure gate-composition tests. */
function changeSetRef(id: string): ChangeSet {
  return { changeSetId: id } as unknown as ChangeSet;
}

function pureGateDeps(): { ids: SequentialIdSource; clock: FixedClock } {
  return { ids: new SequentialIdSource(), clock: new FixedClock() };
}

/* ================================================================= recipes */

describe('a recipe is data, never prose', () => {
  it('every builtin recipe is valid', () => {
    for (const r of BUILTIN_RECIPES) expect(() => validateRecipe(r)).not.toThrow();
  });

  it('a model names a recipe; it cannot compose one', () => {
    const reg = new RecipeRegistry();
    expect(reg.get('SC-RECIPE-UNIT-TEST').executable).toBe('npm');
    // The one place a model-supplied string touches execution can only ever select.
    expect(() => reg.get('rm -rf /')).toThrowError(/Unknown execution recipe/);
    expect(() => reg.get('SC-RECIPE-EVIL')).toThrowError(/Unknown execution recipe/);
  });

  it('shell evaluation is refused at registration', () => {
    const r = ExecutionRecipeSchema.parse({
      ...BASE_RECIPE,
      id: 'SC-RECIPE-SHELL',
      shellEvaluation: true,
    });
    expect(() => validateRecipe(r)).toThrowError(/does not grant/);
    expect(() => new RecipeRegistry([r])).toThrowError(/does not grant/);
  });

  it('a network grant must name its hosts', () => {
    const r = ExecutionRecipeSchema.parse({
      ...BASE_RECIPE,
      id: 'SC-RECIPE-NET',
      networkPolicy: 'DECLARED_HOSTS',
      declaredHosts: [],
    });
    expect(() => validateRecipe(r)).toThrowError(/no hosts/);
  });

  it('the executable is a bare program name, never a path or a shell line', () => {
    expect(() =>
      ExecutionRecipeSchema.parse({ ...BASE_RECIPE, executable: 'sh -c evil' }),
    ).toThrowError();
    expect(() =>
      ExecutionRecipeSchema.parse({ ...BASE_RECIPE, executable: '../../evil' }),
    ).toThrowError();
    expect(() =>
      ExecutionRecipeSchema.parse({ ...BASE_RECIPE, executable: '/bin/sh' }),
    ).toThrowError();
  });

  it('an argument carrying a NUL byte is refused', () => {
    const r = ExecutionRecipeSchema.parse({
      ...BASE_RECIPE,
      id: 'SC-RECIPE-NUL',
      args: ['ok', 'bad' + String.fromCharCode(0) + 'tail'],
    });
    expect(() => validateRecipe(r)).toThrowError(/NUL byte/);
  });
});

/* ============================================================ environment */

describe('the environment a recipe sees is constructed, not inherited', () => {
  it('MINIMAL keeps an allowlist and drops everything else', () => {
    const env = scrubEnvironment('MINIMAL', {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      GITHUB_TOKEN: 'ghp_secret',
      RANDOM_THING: 'x',
    });
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['RANDOM_THING']).toBeUndefined();
    for (const k of Object.keys(env)) expect(MINIMAL_ENV_KEYS).toContain(k);
  });

  it('INHERIT_SAFE still drops anything credential-shaped', () => {
    const env = scrubEnvironment('INHERIT_SAFE', {
      PATH: '/usr/bin',
      MY_API_KEY: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      CLAUDE_CODE_TOKEN: 'x',
      SESSION_ID: 'x',
      HARMLESS: 'y',
    });
    expect(env['HARMLESS']).toBe('y');
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['MY_API_KEY']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['CLAUDE_CODE_TOKEN']).toBeUndefined();
    expect(env['SESSION_ID']).toBeUndefined();
  });
});

/* ======================================== execution requires a real boundary */

describe('no command runs outside a boundary Serva has measured', () => {
  function request(f: Fixture, recipeId = 'SC-RECIPE-UNIT-TEST') {
    return {
      recipe: f.recipes.get(recipeId),
      workItemId: 'SC-WI-000100',
      workspaceId: 'w',
      workspacePath: f.repo,
      projectRoot: f.repo,
      baseCommit: f.base,
      headCommit: f.base,
    };
  }

  it('a SOFT substrate refuses to execute a recipe', async () => {
    const f = await setupFactory(true, 'SOFT');
    await expect(runRecipe(f.executorDeps, request(f))).rejects.toThrowError(/requires HARD/);
  });

  it('a NONE substrate refuses too', async () => {
    const f = await setupFactory(true, 'NONE');
    await expect(runRecipe(f.executorDeps, request(f))).rejects.toThrowError(/requires HARD/);
  });

  it('the refused command was never offered to a process', async () => {
    const f = await setupFactory(true, 'SOFT');
    await expect(runRecipe(f.executorDeps, request(f))).rejects.toThrow();
    expect(f.substrate.executed).toHaveLength(0);
    expect(listExecutions(f.store)).toHaveLength(0);
  });
});

/* =================================================== bounded, real execution */

describe('a command execution is recorded as bounded fact', () => {
  function request(f: Fixture, recipeId: string) {
    return {
      recipe: f.recipes.get(recipeId),
      workItemId: 'SC-WI-000100',
      workspaceId: 'w',
      workspacePath: f.repo,
      projectRoot: f.repo,
      baseCommit: f.base,
      headCommit: f.base,
    };
  }

  it('a timeout is TIMED_OUT, which is not a test failure', async () => {
    const f = await setupFactory(true);
    const rec = await runRecipe(f.executorDeps, request(f, 'SC-RECIPE-SLOW'));
    expect(rec.outcome).toBe(ExecutionOutcome.TIMED_OUT);
    expect(rec.terminationReason).toMatch(/wall-clock timeout/);
    // FAIL says the code is wrong; this says we could not find out.
    expect(rec.outcome).not.toBe(ExecutionOutcome.FAILED);
  }, 30_000);

  it('output is capped and the record says so', async () => {
    const f = await setupFactory(true);
    const rec = await runRecipe(f.executorDeps, request(f, 'SC-RECIPE-NOISY'));
    expect(rec.truncated.stdout).toBe(true);
    expect(rec.stdoutExcerpt.length).toBeLessThanOrEqual(2_000);
    expect(rec.stdoutDigest).toHaveLength(64);
  }, 30_000);

  it('the record carries the environment shape and never its values', async () => {
    const f = await setupFactory(true);
    const rec = await runRecipe(f.executorDeps, request(f, 'SC-RECIPE-BUILD'));
    expect(rec.outcome).toBe(ExecutionOutcome.SUCCEEDED);
    expect(rec.environmentDigest).toHaveLength(64);
    expect(rec.substrateQualificationDigest).toHaveLength(64);
    expect(rec.substrateClass).toBe(EnforcementClass.HARD);
    expect(JSON.stringify(rec)).not.toMatch(/sk-ant-|ghp_/);
  }, 30_000);
});

/* ================================================ the executors do the measuring */

describe('the Test Executor measures; the Producer does not', () => {
  async function verifyOnce(passing: boolean, edit: (w: string) => void) {
    const f = await setupFactory(passing);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    edit(w.path);
    const verification = await f.factory.verifyAttempt(item, w, { required: NO_REVIEW });
    return { f, item, w, verification };
  }

  it('a failing suite produces FAIL evidence with a real exit code', async () => {
    const { f, verification } = await verifyOnce(false, (w) => {
      writeFileSync(join(w, 'src', 'app.js'), 'module.exports = 1;\n// edited\n', 'utf8');
    });
    const test = verification.evidence.find((e) => e.runtimeComponentId === RuntimeComponent.TEST);
    expect(test?.outcome).toBe('FAIL');
    expect(test?.basis).toBe('MEASURED');
    // SC-POL-023: only the runtime captures evidence.
    expect(test?.capturedBy).toBe('RUNTIME');

    const exec = listExecutions(f.store).find((x) => x.executionId === test?.executionId);
    expect(exec?.outcome).toBe(ExecutionOutcome.FAILED);
    expect(exec?.exitCode).toBe(1);
    expect(exec?.stderrExcerpt).toContain('assertion failed');
  }, 60_000);

  it('a passing suite produces PASS evidence bound to this ChangeSet', async () => {
    const { verification } = await verifyOnce(true, (w) => {
      writeFileSync(join(w, 'src', 'app.js'), 'module.exports = 2;\n', 'utf8');
    });
    const test = verification.evidence.find((e) => e.runtimeComponentId === RuntimeComponent.TEST);
    expect(test?.outcome).toBe('PASS');
    expect(test?.changeSetId).toBe(verification.changeSet.changeSetId);
  }, 60_000);

  it('a Producer asserting success cannot make a failing suite pass', async () => {
    /*
     * The Producer's opinion is not a parameter of this path at all. That is the
     * strongest form the rule takes: there is no argument through which a claim could
     * arrive, so there is nothing to trust or distrust.
     */
    const { verification } = await verifyOnce(false, (w) => {
      writeFileSync(
        join(w, 'src', 'app.js'),
        'module.exports = 1;\n// All tests pass. Verified. Ship it.\n',
        'utf8',
      );
    });
    expect(verification.gateResult.verdict).not.toBe(GateVerdict.PASS);
    expect(verification.attemptOutcome).not.toBe('ACCEPTED');
  }, 60_000);

  it('the ChangeSet is computed from the repository, not declared', async () => {
    const { verification } = await verifyOnce(true, (w) => {
      writeFileSync(join(w, 'src', 'app.js'), 'module.exports = 2;\n', 'utf8');
      writeFileSync(join(w, 'src', 'extra.js'), 'module.exports = 3;\n', 'utf8');
    });
    const paths = verification.changeSet.entries.map((e) => e.path).sort();
    // Both files appear because git saw them, not because anyone listed them.
    expect(paths).toEqual(['src/app.js', 'src/extra.js']);
    expect(verification.changeSet.digest).toHaveLength(64);
  }, 60_000);
});

/* ================================================================= staleness */

describe('evidence is bound to a ChangeSet, so editing the code makes it stale', () => {
  it('evidence measured for one ChangeSet does not apply to the next', async () => {
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));

    writeFileSync(join(w.path, 'src', 'app.js'), 'module.exports = 2;\n', 'utf8');
    const first = await f.factory.verifyAttempt(item, w, { required: NO_REVIEW });
    expect(first.evidence.length).toBeGreaterThan(0);

    // The earlier measurement is still TRUE â€” about the earlier ChangeSet.
    writeFileSync(join(w.path, 'src', 'app.js'), 'module.exports = 3;\n', 'utf8');
    const second = await f.factory.verifyAttempt(item, w, { required: NO_REVIEW });

    expect(second.changeSet.changeSetId).not.toBe(first.changeSet.changeSetId);
    expect(second.staleEvidence.length).toBeGreaterThanOrEqual(first.evidence.length);
    for (const e of first.evidence) {
      expect(deriveEvidenceValidity(e, second.changeSet.changeSetId)).toBe(ValidityState.STALE);
      expect(deriveEvidenceValidity(e, first.changeSet.changeSetId)).toBe(ValidityState.VALID);
    }
    // Staleness is derived, never written: the historical record is untouched.
    expect(first.evidence.every((e) => e.changeSetId === first.changeSet.changeSetId)).toBe(true);
  }, 90_000);

  it('stale evidence cannot satisfy a criterion however green it was', async () => {
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    writeFileSync(join(w.path, 'src', 'app.js'), 'module.exports = 2;\n', 'utf8');
    const first = await f.factory.verifyAttempt(item, w, { required: NO_REVIEW });
    expect(first.evidence.some((e) => e.outcome === 'PASS')).toBe(true);

    const evaluations = buildCriterionEvaluations(pureGateDeps(), {
      changeSet: changeSetRef('SC-CS-SOMETHING-ELSE'),
      evidence: first.evidence,
      judged: [],
      required: NO_REVIEW,
    });
    expect(evaluations.every((e) => e.value === 'INDETERMINATE')).toBe(true);
  }, 60_000);
});

/* ===================================================== the Engineering Gate */

describe('the Engineering Gate uses the Phase 2 engine and nothing bespoke', () => {
  it('missing test evidence is NOT_VERIFIED, never FAIL', async () => {
    // NO EVIDENCE = NOT VERIFIED. Absence of a measurement is not proof of a defect.
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    writeFileSync(join(w.path, 'src', 'app.js'), 'module.exports = 2;\n', 'utf8');

    const changeSet = await buildChangeSet(
      { store: f.store, git: f.git, clock: f.deps.clock, ids: f.deps.ids },
      w,
    );
    const tx = f.store.begin();
    const result = evaluateEngineeringGate(tx, f.gateDeps, {
      changeSet,
      evidence: [],
      judged: [],
      required: SCOPE_AND_TESTS,
    });
    tx.commit();
    expect(result.verdict).toBe(GateVerdict.NOT_VERIFIED);
    expect(routeVerdict(result.verdict)).toBe('REWORK');
  }, 60_000);

  it('a failing test drives the gate away from PASS', async () => {
    const f = await setupFactory(false);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    writeFileSync(join(w.path, 'src', 'app.js'), 'module.exports = 1;\n// edit\n', 'utf8');
    const v = await f.factory.verifyAttempt(item, w, { required: SCOPE_AND_TESTS });
    expect(v.gateResult.verdict).toBe(GateVerdict.FAIL);
    expect(v.attemptOutcome).toBe('REWORK');
  }, 60_000);

  it('a scope violation stops the deterministic checks from running at all', async () => {
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    // Outside `src/`, which the work item declared as the only allowed scope.
    writeFileSync(join(w.path, 'package.json'), '{"name":"hijacked"}\n', 'utf8');

    const v = await f.factory.verifyAttempt(item, w, { required: SCOPE_AND_TESTS });
    const scope = v.evidence.find((e) => e.runtimeComponentId === RuntimeComponent.SCOPE);
    expect(scope?.outcome).toBe('FAIL');
    expect(scope?.detail).toContain('OUTSIDE_ALLOWED_SCOPE');
    // Measuring an unauthorized change would produce true statements about work nobody
    // asked for, and the green would read as the headline.
    expect(v.evidence.some((e) => e.runtimeComponentId === RuntimeComponent.TEST)).toBe(false);
    expect(v.unresolved.join(' ')).toMatch(/outside its declared scope/);
    expect(v.attemptOutcome).not.toBe('ACCEPTED');
  }, 60_000);

  it('every criterion resolves to exactly one evaluation', () => {
    const evaluations = buildCriterionEvaluations(pureGateDeps(), {
      changeSet: changeSetRef('SC-CS-1'),
      evidence: [],
      judged: [],
      required: DEFAULT_REQUIRED_CHECKS,
    });
    const refs = evaluations.map((e) => e.criterionRef);
    expect(new Set(refs).size).toBe(refs.length);
    expect(refs).toEqual([
      'EC-SCOPE',
      'EC-BUILD',
      'EC-TESTS',
      'EC-LINT',
      'EC-SECRETS',
      'EC-REVIEW',
    ]);
  });

  it('a reviewer rejection is NOT_MET at BLOCKING severity', () => {
    const evaluations = buildCriterionEvaluations(pureGateDeps(), {
      changeSet: changeSetRef('SC-CS-1'),
      evidence: [],
      judged: [
        {
          criterionId: 'EC-REVIEW',
          outcome: 'FAIL',
          detail: 'rejected: the change does not do what the work item asked',
          runRef: 'SC-RUN-000001',
          reviewerRole: 'CODE_REVIEW',
        },
      ],
      required: JUDGED_ONLY,
    });
    const review = evaluations.find((e) => e.criterionRef === 'EC-REVIEW');
    expect(review?.value).toBe('NOT_MET');
    expect(review?.severity).toBe('BLOCKING');
    expect(review?.basis).toBe('JUDGED');
  });

  it('a missing reviewer verdict is INDETERMINATE, not an implicit approval', () => {
    const evaluations = buildCriterionEvaluations(pureGateDeps(), {
      changeSet: changeSetRef('SC-CS-1'),
      evidence: [],
      judged: [],
      required: JUDGED_ONLY,
    });
    expect(evaluations.find((e) => e.criterionRef === 'EC-REVIEW')?.value).toBe('INDETERMINATE');
  });
});

/* ================================================================== secrets */

describe('the secrets scanner reports without disclosing', () => {
  it('detects a private key and never echoes it', () => {
    const findings = scanText('a.pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIabcdefgh\n');
    expect(findings[0]?.category).toBe('PRIVATE_KEY');
    expect(findings[0]?.severity).toBe('HIGH');
    expect(findings[0]?.matchDigest).toHaveLength(64);
    expect(JSON.stringify(findings)).not.toContain('PRIVATE KEY-----');
  });

  it('detects vendor key shapes', () => {
    expect(scanText('x', 'const k = "sk-ant-abcdefghijklmnop123"')[0]?.category).toBe(
      'ANTHROPIC_KEY',
    );
    expect(scanText('x', 'AKIAIOSFODNN7XAMPLEQ')[0]?.category).toBe('AWS_ACCESS_KEY');
    expect(scanText('x', 'ghp_abcdefghijklmnopqrstuvwxyz0123')[0]?.category).toBe('GITHUB_TOKEN');
  });

  it('a placeholder is downgraded but never suppressed', () => {
    /*
     * REWRITTEN, because it asserted the defect.
     *
     * SPEC: finding ENGINEERING-SECRETS-AND-EXECUTION-EVIDENCE/SEC-2 (MEDIUM), 1.0.1 review.
     *
     * This used `"sk-ant-abcdefghijklmnop123"; // placeholder` and expected MEDIUM â€” which
     * passed only because the comment downgraded it. Its own note said "the scanner does not
     * get to decide that a comment is telling the truth", and the code was doing precisely
     * that: `looksLikePlaceholder` read the whole LINE.
     *
     * Since `blocking` is `some(f => f.severity === 'HIGH')`, that let anyone disarm the scan
     * by typing a word next to a live credential. The downgrade now rests on the value.
     */
    const f = scanText('x', 'const k = "sk-ant-aaaaaaaaaaaaaaaaaaaa";');
    expect(f).toHaveLength(1);
    /* Downgraded because the VALUE is a masked run, and never dropped â€” a "placeholder" that
       turns out to be real must still be reported. */
    expect(f[0]?.severity).toBe('MEDIUM');

    /* And the comment on its own changes nothing. */
    const captioned = scanText('x', 'const k = "sk-ant-R7kQ2mZ9pL4xW1nT8vB6"; // placeholder');
    expect(captioned).toHaveLength(1);
    expect(captioned[0]?.severity, 'a caption must not disarm the scan').toBe('HIGH');
  });

  it('a high-confidence finding blocks, and the report withholds the value', async () => {
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    writeFileSync(
      join(w.path, 'src', 'config.js'),
      'module.exports = { key: "ghp_abcdefghijklmnopqrstuvwxyz0123" };\n',
      'utf8',
    );
    const changeSet = await buildChangeSet(
      { store: f.store, git: f.git, clock: f.deps.clock, ids: f.deps.ids },
      w,
    );
    const ctx: ExecutorContext = {
      deps: f.executorDeps,
      recipes: f.recipes,
      workspace: w,
      changeSet,
      projectRoot: f.repo,
    };
    const out = runSecretsScan(ctx);
    expect(out.evidence.outcome).toBe('FAIL');
    expect(out.evidence.detail).toContain('src/config.js');
    expect(out.evidence.detail).toMatch(/withheld by design/);
    // The value itself never enters the store.
    expect(out.evidence.detail).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(JSON.stringify(f.store.getCanon('engineeringEvidence', out.evidence.id))).not.toContain(
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
    );
  }, 60_000);

  it('a clean scan says what it actually checked', async () => {
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    writeFileSync(join(w.path, 'src', 'app.js'), 'module.exports = 2;\n', 'utf8');
    const changeSet = await buildChangeSet(
      { store: f.store, git: f.git, clock: f.deps.clock, ids: f.deps.ids },
      w,
    );
    const out = runSecretsScan({
      deps: f.executorDeps,
      recipes: f.recipes,
      workspace: w,
      changeSet,
      projectRoot: f.repo,
    });
    expect(out.evidence.outcome).toBe('PASS');
    // Not "the change is secure" â€” "nothing matched these rules".
    expect(out.evidence.detail).toMatch(/it is not a security review/);
  }, 60_000);
});

/* ==================================================== Producer capability */

describe('a Producer is dispatched only when every condition is true', () => {
  const producer = (): ReturnType<ContractRegistry['get']> => registry.get('SC-AGENT-150');

  function gate(
    f: Fixture,
    o: Partial<Parameters<typeof producerRefusal>[0]> = {},
  ): string | undefined {
    return producerRefusal({
      contract: producer(),
      qualification: f.qualification,
      enabledProducers: new Set(['SC-AGENT-150']),
      projectRoot: f.repo,
      reviewerAvailable: true,
      executorsAvailable: true,
      actualBoundary: f.qualification.boundary,
      allowSimulatedBoundary: true,
      ...o,
    });
  }

  it('a SOFT substrate refuses write authority', async () => {
    const f = await setupFactory(true, 'SOFT');
    expect(gate(f)).toMatch(/requires HARD/);
  });

  it('an agent outside the enabled set is refused', async () => {
    const f = await setupFactory(true);
    expect(gate(f, { enabledProducers: new Set() })).toMatch(/not in the enabled Producer set/);
  });

  it('a VERIFIER is refused write authority whatever the substrate can do', async () => {
    const f = await setupFactory(true);
    expect(
      gate(f, {
        contract: registry.get('SC-AGENT-200'),
        enabledProducers: new Set(['SC-AGENT-200']),
      }),
    ).toMatch(/write authority belongs to a PRODUCER/);
  });

  it('no worktree means no dispatch', async () => {
    const f = await setupFactory(true);
    expect(gate(f)).toMatch(/never edits the primary checkout/);
  });

  it('a workspace that resolves to the primary checkout is refused', async () => {
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    expect(gate(f, { workspace: { ...w, path: f.repo } })).toMatch(
      /resolves to the primary checkout/,
    );
  }, 30_000);

  it('no reviewer means no dispatch', async () => {
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    expect(gate(f, { workspace: w, reviewerAvailable: false })).toMatch(
      /never certifies its own work/,
    );
  }, 30_000);

  it('no evidence executors means no dispatch', async () => {
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    expect(gate(f, { workspace: w, executorsAvailable: false })).toMatch(
      /a change nobody can measure cannot be accepted/,
    );
  }, 30_000);

  it('a refused dispatch is an error, never a quiet downgrade to read-only', async () => {
    const f = await setupFactory(true, 'SOFT');
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    expect(() =>
      resolveProducerPolicy({
        contract: producer(),
        workspace: { workItemId: item.workItemId, path: join(f.repo, 'nope') } as never,
        qualification: f.qualification,
        enabledProducers: new Set(['SC-AGENT-150']),
        projectRoot: f.repo,
        reviewerAvailable: true,
        executorsAvailable: true,
        actualBoundary: f.qualification.boundary,
        allowSimulatedBoundary: true,
      }),
    ).toThrowError(/cannot be dispatched/);
  });

  it('the granted policy denies every publishing verb and writes only the worktree', async () => {
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    const policy = resolveProducerPolicy({
      contract: producer(),
      workspace: w,
      qualification: f.qualification,
      enabledProducers: new Set(['SC-AGENT-150']),
      projectRoot: f.repo,
      reviewerAvailable: true,
      executorsAvailable: true,
      actualBoundary: f.qualification.boundary,
      allowSimulatedBoundary: true,
    });
    expect(policy.available).toContain('Edit');
    expect(policy.available).toContain('Bash');
    for (const d of PRODUCER_DENIED_COMMANDS) expect(policy.deny).toContain(d);
    expect(policy.deny).toContain('Bash(git push*)');
    expect(policy.deny).toContain('Bash(git merge*)');
    expect(policy.deny).toContain('Bash(git rebase*)');
    expect(policy.deny).toContain('Bash(git remote*)');
    expect(policy.deny).toContain('Bash(git config*)');
    // No subagent: a Producer that could spawn one would run an ungoverned run inside
    // a governed one.
    expect(policy.deny).toContain('Agent');
    expect(policy.deny).toContain('Task');
    expect(policy.network).toBe('NONE');
    expect(policy.filesystem.write).toEqual([w.path]);
    expect(policy.filesystem.write).not.toContain(f.repo);
  }, 30_000);

  it('the reviewer policy has no write tool at all', async () => {
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    const policy = resolveReviewerPolicy(w, f.repo);
    expect(policy.available).not.toContain('Edit');
    expect(policy.available).not.toContain('Write');
    expect(policy.available).not.toContain('Bash');
    expect(policy.filesystem.write).toEqual([]);
    // Read-only by construction, not by configuration: there is nothing to widen.
    expect(policy.deny).toContain('Edit');
    expect(policy.deny).toContain('Write');
    expect(policy.deny).toContain('Bash');
  }, 30_000);

  it('a work item naming one agent for both roles is rejected at definition', async () => {
    const f = await setupFactory(true);
    expect(() =>
      f.factory.recordWorkItem({
        ...WORK_ITEM,
        baseCommit: f.base,
        reviewerAgentId: 'SC-AGENT-150',
      }),
    ).toThrowError();
  });

  it('a work item naming an unregistered recipe is refused before any worktree exists', async () => {
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({
      ...WORK_ITEM,
      baseCommit: f.base,
      recipes: ['SC-RECIPE-MADE-UP'],
    });
    expect(f.factory.refusal(item)).toMatch(/unregistered recipe/);
  });
});

/* ================================================= rework and acceptance */

describe('rework is bounded and acceptance is deterministic', () => {
  it('a second attempt is permitted and a third is not', async () => {
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base, maxAttempts: 2 });
    expect(f.factory.canRework(item, 1).allowed).toBe(true);
    const stop = f.factory.canRework(item, 2);
    expect(stop.allowed).toBe(false);
    expect(stop.reason).toMatch(/owner decision, not another retry/);
  });

  it('the rework context is built from evidence, not from the previous reasoning', async () => {
    const f = await setupFactory(false);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    writeFileSync(join(w.path, 'src', 'app.js'), 'module.exports = 1;\n// x\n', 'utf8');
    const v = await f.factory.verifyAttempt(item, w, { required: NO_REVIEW });
    const ctx = f.factory.reworkContext(v);
    expect(ctx).toContain('What was measured against ChangeSet ' + v.changeSet.changeSetId);
    expect(ctx).toMatch(/nothing carries forward/);
    expect(ctx).toContain('SC-RTC-012');
  }, 60_000);

  it('an unaccepted change cannot be integrated', async () => {
    const f = await setupFactory(false);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    writeFileSync(join(w.path, 'src', 'app.js'), 'module.exports = 1;\n// x\n', 'utf8');
    const v = await f.factory.verifyAttempt(item, w, { required: NO_REVIEW });
    // Refused twice over: no review is recorded, and the gate said REWORK. The review
    // check fires first because it does not depend on the verdict at all.
    await expect(f.factory.acceptChange(item, w, v)).rejects.toThrowError(
      /No independent review is recorded/,
    );
    expect(v.attemptOutcome).toBe('REWORK');
  }, 60_000);

  it('a verdict supplied by the caller cannot be integrated', async () => {
    /*
     * The hole this closes: `verifyAttempt` used to take a `judged` array straight from
     * its caller and hand it to the gate, so a required, BLOCKING review criterion was
     * satisfied by a literal. No run had to exist; the `runRef` string was never
     * resolved against anything. The accepted record would then claim an independent
     * review that never happened.
     *
     * The seam still exists, because gate composition has to be testable without
     * spending a model call. What changed is that it can no longer reach acceptance.
     */
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    writeFileSync(join(w.path, 'src', 'app.js'), 'module.exports = 2;\n', 'utf8');

    const v = await f.factory.verifyAttempt(item, w, {
      required: {
        scope: true,
        build: false,
        tests: true,
        lint: false,
        secrets: true,
        codeReview: true,
        qaVerification: false,
      },
      testOnlyJudged: [
        {
          criterionId: 'EC-REVIEW',
          outcome: 'PASS',
          detail: 'looks fine to me',
          runRef: 'SC-RUN-TOTALLY-MADE-UP',
          reviewerRole: 'CODE_REVIEW',
        },
      ],
    });

    // The gate composes as before â€” that is what the seam is for.
    expect(v.gateResult.verdict).toBe(GateVerdict.PASS_WITH_QUALIFICATION);
    // ...and the result is flagged, and refuses to become a commit.
    expect(v.usedUnvalidatedJudgement).toBe(true);
    expect(v.unresolved.join(' ')).toMatch(/test seam/);
    await expect(f.factory.acceptChange(item, w, v)).rejects.toThrowError(
      /no AgentRun backs|not accepted/,
    );

    // Nothing was committed, and no review was invented.
    expect(await f.git.headCommit(w.path)).toBe(f.base);
  }, 90_000);

  it('acceptance refuses when no independent review is recorded at all', async () => {
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    writeFileSync(join(w.path, 'src', 'app.js'), 'module.exports = 2;\n', 'utf8');

    // Review not required by the gate, so the attempt is ACCEPTED...
    const v = await f.factory.verifyAttempt(item, w, { required: NO_REVIEW });
    expect(v.attemptOutcome).toBe('ACCEPTED');

    // ...and integration still refuses, because the store holds no review. Two checks
    // against the same fact from different directions.
    await expect(f.factory.acceptChange(item, w, v)).rejects.toThrowError(
      /No independent review is recorded/,
    );
  }, 90_000);

  it('acceptance refuses a persisted FAIL review, not merely a missing one', async () => {
    /*
     * SPEC: finding ENGINEERING-ACCEPTANCE-AUTHORITY/EAA-R1 (MEDIUM), 1.0.1 security review.
     *
     * The block being tested claims it 'cannot be satisfied by anything except a persisted,
     * validated review'. It read existence and authorship and never the OUTCOME, so a
     * dissenting reviewer's FAIL sat in the store and satisfied the check that exists to
     * consult it. The gate honours dissent; this boundary did not, and this boundary is the
     * one that writes a commit.
     *
     * The gate here is bypassed on purpose (`NO_REVIEW` leaves the attempt ACCEPTED) so that
     * the integration check is the only thing standing between a FAIL review and a commit.
     */
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    writeFileSync(join(w.path, 'src', 'app.js'), 'module.exports = 2;\n', 'utf8');

    const v = await f.factory.verifyAttempt(item, w, { required: NO_REVIEW });
    expect(v.attemptOutcome).toBe('ACCEPTED');

    /* An independent reviewer — not the producer — that rejected the change. */
    const tx = f.store.begin();
    tx.putCanon(REVIEW_CANON_TYPE, 'SC-REVIEW-DISSENT', {
      id: 'SC-REVIEW-DISSENT',
      workItemId: item.workItemId,
      changeSetId: v.changeSet.changeSetId,
      criterionId: 'EC-REVIEW',
      reviewerAgentId: 'SC-AGENT-200',
      producerAgentId: 'SC-AGENT-150',
      runRef: 'SC-RUN-000900',
      outcome: 'FAIL',
      detail: 'this drops the guard the work item was for',
      verdict: {},
      capabilityDigest: 'e'.repeat(64),
      recordedAt: '2026-08-25T00:00:00.000Z',
    });
    tx.commit();

    await expect(f.factory.acceptChange(item, w, v)).rejects.toThrowError(/is FAIL/);
    expect(await f.git.headCommit(w.path), 'nothing was committed').toBe(f.base);
  }, 90_000);

  it('a dissent is not overruled by being recorded second', async () => {
    /*
     * The precedence half. Two reviewers, PASS first and FAIL second: array order must not
     * decide. `decisiveReview` is the gate's own rule, shared so the two boundaries cannot
     * come to different conclusions about the same set of records.
     */
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    writeFileSync(join(w.path, 'src', 'app.js'), 'module.exports = 2;\n', 'utf8');

    const v = await f.factory.verifyAttempt(item, w, { required: NO_REVIEW });
    const base = {
      workItemId: item.workItemId,
      changeSetId: v.changeSet.changeSetId,
      criterionId: 'EC-REVIEW',
      producerAgentId: 'SC-AGENT-150',
      runRef: 'SC-RUN-000901',
      verdict: {},
      capabilityDigest: 'e'.repeat(64),
      recordedAt: '2026-08-25T00:00:00.000Z',
    };
    const tx = f.store.begin();
    tx.putCanon(REVIEW_CANON_TYPE, 'SC-REVIEW-A-PASS', {
      ...base,
      id: 'SC-REVIEW-A-PASS',
      reviewerAgentId: 'SC-AGENT-200',
      outcome: 'PASS',
      detail: 'looks fine',
    });
    tx.putCanon(REVIEW_CANON_TYPE, 'SC-REVIEW-B-FAIL', {
      ...base,
      id: 'SC-REVIEW-B-FAIL',
      reviewerAgentId: 'SC-AGENT-201',
      outcome: 'FAIL',
      detail: 'it is not fine',
    });
    tx.commit();

    await expect(f.factory.acceptChange(item, w, v)).rejects.toThrowError(/is FAIL/);
  }, 90_000);

  it('a passing review by somebody other than the named reviewer does not authorise', async () => {
    /*
     * SPEC: finding EAA-REV-1 (MEDIUM), 1.0.1 security review.
     *
     * The boundary accepted any persisted PASS for the ChangeSet that the producer had not
     * written. Whether it came from the reviewer the work item NAMED was checked in a
     * different function, against the work item rather than the review actually consumed — so
     * the guarantee rested on caller code the boundary cannot see.
     */
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    writeFileSync(
      join(w.path, 'src', 'app.js'),
      'module.exports = 2;' + String.fromCharCode(92) + 'n',
      'utf8',
    );

    const v = await f.factory.verifyAttempt(item, w, { required: NO_REVIEW });
    expect(v.attemptOutcome).toBe('ACCEPTED');

    /* A real, non-producer reviewer — simply not the one this work item was assigned. */
    const tx = f.store.begin();
    tx.putCanon(REVIEW_CANON_TYPE, 'SC-REVIEW-STRANGER', {
      id: 'SC-REVIEW-STRANGER',
      workItemId: item.workItemId,
      changeSetId: v.changeSet.changeSetId,
      criterionId: 'EC-REVIEW',
      reviewerAgentId: 'SC-AGENT-201',
      producerAgentId: 'SC-AGENT-150',
      runRef: 'SC-RUN-000910',
      outcome: 'PASS',
      detail: 'looks fine to me',
      verdict: {},
      capabilityDigest: 'e'.repeat(64),
      recordedAt: '2026-08-25T00:00:00.000Z',
    });
    tx.commit();

    await expect(f.factory.acceptChange(item, w, v)).rejects.toThrowError(
      /No passing EC-REVIEW by the reviewer SC-AGENT-200/,
    );
    expect(await f.git.headCommit(w.path), 'nothing was committed').toBe(f.base);
  }, 90_000);

  it('a QA pass by the named reviewer does not authorise a code change', async () => {
    /*
     * SPEC: finding EAA-F1 (MEDIUM), 1.0.1 security review — the second pass on EAA-REV-1.
     *
     * That fix constrained WHO reviewed and not WHICH review. A persisted review carries a
     * criterion: EC-REVIEW is the independent code review, EC-QA is a different question asked
     * of the same agent. A passing EC-QA record therefore authorised integration of a change
     * whose code review was never the thing that passed.
     */
    const f = await setupFactory(true);
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    const w = await f.factory.openWorkspace(item, 1, 'd'.repeat(64));
    writeFileSync(
      join(w.path, 'src', 'app.js'),
      'module.exports = 2;' + String.fromCharCode(92) + 'n',
      'utf8',
    );

    const v = await f.factory.verifyAttempt(item, w, { required: NO_REVIEW });
    const tx = f.store.begin();
    tx.putCanon(REVIEW_CANON_TYPE, 'SC-REVIEW-QA-ONLY', {
      id: 'SC-REVIEW-QA-ONLY',
      workItemId: item.workItemId,
      changeSetId: v.changeSet.changeSetId,
      criterionId: 'EC-QA',
      reviewerAgentId: 'SC-AGENT-200',
      producerAgentId: 'SC-AGENT-150',
      runRef: 'SC-RUN-000920',
      outcome: 'PASS',
      detail: 'QA looks fine',
      verdict: {},
      capabilityDigest: 'e'.repeat(64),
      recordedAt: '2026-08-25T00:00:00.000Z',
    });
    tx.commit();

    await expect(f.factory.acceptChange(item, w, v)).rejects.toThrowError(/No passing EC-REVIEW/);
    expect(await f.git.headCommit(w.path), 'nothing was committed').toBe(f.base);
  }, 90_000);

  it('routing follows the canonical verdict taxonomy', () => {
    expect(routeVerdict(GateVerdict.PASS)).toBe('ACCEPTED');
    expect(routeVerdict(GateVerdict.PASS_WITH_QUALIFICATION)).toBe('ACCEPTED');
    expect(routeVerdict(GateVerdict.FAIL)).toBe('REWORK');
    expect(routeVerdict(GateVerdict.NOT_VERIFIED)).toBe('REWORK');
    expect(routeVerdict(GateVerdict.BLOCKED)).toBe('BLOCKED');
    expect(routeVerdict(GateVerdict.ESCALATED)).toBe('ESCALATED');
  });
});

/* ============================== an unqualified substrate blocks the factory */

describe('an unqualified substrate blocks the factory entirely', () => {
  it('no workspace can be opened', async () => {
    const f = await setupFactory(true, 'NONE');
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    await expect(f.factory.openWorkspace(item, 1, 'd'.repeat(64))).rejects.toThrowError(
      /requires HARD/,
    );
  });

  it('the refusal names the substrate rather than blaming the work item', async () => {
    const f = await setupFactory(true, 'SOFT');
    const item = f.factory.recordWorkItem({ ...WORK_ITEM, baseCommit: f.base });
    expect(f.factory.refusal(item)).toMatch(/requires HARD/);
  });

  it('the enforcement class is reported, not assumed', async () => {
    const hard = await setupFactory(true, 'HARD');
    expect(hard.qualification.enforcementClass).toBe(EnforcementClass.HARD);
    const soft = await setupFactory(true, 'SOFT');
    expect(soft.qualification.enforcementClass).toBe(EnforcementClass.SOFT);
    expect(soft.qualification.blockedBy).toBeDefined();
  });
});

describe('the words around a secret do not decide how serious it is', () => {
  /*
   * SPEC: finding ENGINEERING-SECRETS-AND-EXECUTION-EVIDENCE/SEC-2 (MEDIUM), 1.0.1 review.
   *
   * `looksLikePlaceholder` tested `line + ' ' + matched` â€” the WHOLE line. Since
   * `blocking` is `findings.some(f => f.severity === 'HIGH')`, writing `// example` beside a
   * live credential downgraded it to MEDIUM and acceptance stopped being blocked.
   *
   * The text on the line is written by whoever wrote the line. Letting it decide enforcement
   * hands the control to the one party it is meant to constrain.
   *
   * The judgement now rests on the matched value itself: a real key stays HIGH however it is
   * captioned, and an actually-placeholder-shaped value is still downgraded.
   */
  const REAL_AWS = 'AKIA' + 'Q7X4ZL2MN8VBCD3R';
  const REAL_ANTHROPIC = 'sk-ant-' + 'api03R7kQ2mZ9pL4xW1nT8vB6cD5hJ3';

  it('a real key stays HIGH however the line is captioned', () => {
    for (const caption of [
      '// example',
      '# sample only',
      '/* test_only */',
      '-- placeholder',
      '// changeme',
      '// this is a fake, honestly',
      '// your_key here',
    ]) {
      const findings = scanText('src/config.ts', 'const k = "' + REAL_AWS + '"; ' + caption);
      expect(findings.length, caption).toBeGreaterThan(0);
      expect(findings[0]?.severity, 'caption ' + caption + ' must not downgrade a real key').toBe(
        'HIGH',
      );
    }
  });

  it('the same holds for an API key, and the scan still blocks', () => {
    const findings = scanText('src/config.ts', 'const k = "' + REAL_ANTHROPIC + '"; // example');
    expect(findings[0]?.severity).toBe('HIGH');
  });

  it('a value that is itself a placeholder is still downgraded', () => {
    /*
     * The negative case, so the fix does not simply make everything HIGH. A scanner that
     * cannot distinguish documentation from a credential is one people learn to ignore.
     */
    const masked = scanText('README.md', 'AKIA' + 'XXXXXXXXXXXXXXXX');
    expect(masked.length).toBeGreaterThan(0);
    expect(masked[0]?.severity, 'an all-X value is documentation').toBe('MEDIUM');
  });

  it('never suppresses the finding, whichever way it is graded', () => {
    /* Downgrade, never disappear â€” a placeholder that turns out to be real must still show. */
    const masked = scanText('README.md', 'AKIA' + 'XXXXXXXXXXXXXXXX');
    expect(masked.length).toBe(1);
  });
});

describe('a credential printed by a build does not become permanent record', () => {
  /*
   * SPEC: finding ENGINEERING-SECRETS-AND-EXECUTION-EVIDENCE/SEC-1 (MEDIUM), 1.0.1 review.
   *
   * `runRecipe` wrote 2000 bytes of raw stdout and stderr into T-CANON, which is immutable and
   * travels in every backup and export. The module's own header says that output "routinely
   * carries paths, tokens and environment fragments", and the secrets scanner only ever ran
   * over ChangeSet FILES â€” so a credential printed by a build was persisted verbatim, forever,
   * having gone around the boundary that exists to catch it.
   *
   * Canon cannot be repaired afterwards, which is the whole reason this has to happen before
   * the write rather than after it.
   */
  const LIVE_KEY = 'AKIA' + 'Q7X4ZL2MN8VBCD3R';

  it('redacts the credential and says how many it removed', () => {
    const r = redactSecrets('building...\nAWS_ACCESS_KEY_ID=' + LIVE_KEY + '\ndone');
    expect(r.text, 'the value itself must not survive').not.toContain(LIVE_KEY);
    expect(r.text).toContain('[REDACTED:');
    expect(r.count).toBe(1);
    /* The shape is safe to name; it describes what matched, never the value. */
    expect(r.categories.length).toBeGreaterThan(0);
  });

  it('redacts an unquoted assignment, which is the shape process output has', () => {
    /*
     * SPEC: finding ENGINEERING-SECRETS-AND-EXECUTION-EVIDENCE/SEC-REV-1 (MEDIUM), 1.0.1.
     *
     * GENERIC_ASSIGNMENT required QUOTES, which is what a source file looks like. A build log
     * says `api_key=…` with none, and that log is what `excerpts()` writes into immutable
     * canon — the one channel where an unredacted value cannot afterwards be withdrawn.
     */
    const value = 'zK7RmQ2wX9tLpV4nB6cY';
    const r = redactSecrets('deploying\napi_key=' + value + '\nok');
    expect(r.text, 'the value itself must not survive').not.toContain(value);
    expect(r.text).toContain('[REDACTED:');
    expect(r.count).toBe(1);
  });

  it('redacts the bare forms build output actually uses', () => {
    /*
     * SPEC: finding SEC-REV-EXEC-A2 (MEDIUM), 1.0.1 security review — the second pass.
     *
     * The first pass widened the SHAPE to unquoted values and left the keyword set alone, so
     * `TOKEN=` and `APIKEY=` — the two forms a build log is most likely to contain — still
     * went verbatim into immutable canon. Fixing the reported example and not the class is
     * exactly the habit this review keeps catching.
     */
    for (const line of [
      'TOKEN=zK7RmQ2wX9tLpV4nB6cY',
      'export APIKEY=zK7RmQ2wX9tLpV4nB6cY',
      'CLIENT_SECRET: zK7RmQ2wX9tLpV4nB6cY',
      'passphrase=zK7RmQ2wX9tLpV4nB6cY',
    ]) {
      const r = redactSecrets(line);
      expect(r.text, line).not.toContain('zK7RmQ2wX9tLpV4nB6cY');
      expect(r.count, line).toBeGreaterThan(0);
    }
  });

  it('a keyword as ordinary as `token` still does not eat ordinary output', () => {
    /*
     * The cost of widening the keyword set, bounded by the length threshold. `token` appears
     * in every parser that ever printed a diagnostic; a redactor that ate those would make the
     * evidence useless, which is its own way of hiding a finding.
     */
    const plain = 'token=42\nnext token: identifier\nbearer of record: none';
    const r = redactSecrets(plain);
    expect(r.text).toBe(plain);
    expect(r.count).toBe(0);
  });

  it('does not redact a short unquoted value that is plainly not a credential', () => {
    /*
     * The other half, and the reason the unquoted branch asks for twenty characters. A
     * redactor that eats `secret: true` makes the evidence an owner reads useless, and useless
     * evidence is how a real finding goes unnoticed.
     */
    const plain = 'config: secret: true\napi_key=none\npassword: 1234';
    const r = redactSecrets(plain);
    expect(r.text).toBe(plain);
    expect(r.count).toBe(0);
  });

  it('every free-text channel into canon is redacted, including the termination reason', () => {
    /*
     * SPEC: finding SEC-REV-EXEC-1 (MEDIUM), 1.0.1 security review.
     *
     * stdout, stderr and argv all passed through `redactSecrets` before being written;
     * `terminationReason` did not, and a substrate refusal reason carries paths and command
     * fragments. Canon is immutable, so an unredacted value there cannot be withdrawn — which
     * is why the rule is "before persistence", not "before display".
     *
     * Asserted on the composition rather than on a live substrate refusal, because provoking a
     * refusal that carries a credential means asking the substrate to leak one. What the rule
     * does to such a string is checked directly; that this channel applies it is checked here.
     */
    const reason = 'refused: recipe used --token=' + 'sk-ant-api03-' + 'K7mQ2wX9tLpV4nB6cYzR8dHs';
    expect(redactSecrets(reason).text, 'the rule itself removes it').not.toContain(
      'K7mQ2wX9tLpV4nB6cYzR8dHs',
    );

    const source = readFileSync('src/engineering/execution.ts', 'utf8');
    expect(source).toContain("redactSecrets(result.refusalReason ?? 'refused by substrate').text");
  });

  it('leaves ordinary output exactly as it was', () => {
    /* A redactor that rewrites innocent text makes every excerpt untrustworthy. */
    const plain = 'tsc --noEmit\n0 errors\nBuild succeeded in 4.1s';
    const r = redactSecrets(plain);
    expect(r.text).toBe(plain);
    expect(r.count).toBe(0);
  });

  it('removes a credential that straddles the excerpt boundary', () => {
    /*
     * The ordering that matters. Truncating first would cut the key in half at 2000 bytes, and
     * the surviving half is both a disclosure and a shape the rules no longer match â€” so it
     * would pass through in silence.
     */
    /* A separator, because the rules require a word boundary: a key embedded inside a longer
       alphanumeric run is not a standalone key, and correctly does not match. */
    const padding = 'x'.repeat(1_994) + '\n';
    const r = redactSecrets(padding + LIVE_KEY + ' trailing');
    expect(r.text.slice(0, 2_000)).not.toContain('AKIA');
    expect(r.count).toBe(1);
  });

  it('every rule the scanner enforces is one the redactor also removes', () => {
    /*
     * One detector, not two. If these ever diverge, the day they disagree is the day one of
     * them is wrong about a secret â€” so this asserts they are driven by the same rule set
     * rather than by two lists somebody has to remember to update together.
     */
    for (const rule of SECRET_RULES) {
      const sample = SAMPLE_FOR.get(rule.category);
      if (sample === undefined) continue;
      const r = redactSecrets('value=' + sample);
      expect(r.text, rule.category + ' is scanned but not redacted').not.toContain(sample);
    }
  });
});

/** Realistic-shaped values, one per rule, used only to prove the redactor covers each rule. */
const SAMPLE_FOR = new Map<string, string>([
  ['ANTHROPIC_KEY', 'sk-ant-' + 'api03R7kQ2mZ9pL4xW1nT8vB6cD5hJ3'],
  ['AWS_ACCESS_KEY', 'AKIA' + 'Q7X4ZL2MN8VBCD3R'],
  ['GITHUB_TOKEN', 'ghp_' + 'R7kQ2mZ9pL4xW1nT8vB6cD5hJ3aF1g'],
  ['PRIVATE_KEY', '-----BEGIN RSA PRIVATE KEY-----'],
]);

describe('a private key is removed whole, not labelled', () => {
  /*
   * SPEC: finding ENGINEERING-SECRETS-AND-EXECUTION-EVIDENCE/SEC-EXEC-1 (HIGH), 1.0.1 review.
   *
   * The SEC-1 fix reused SECRET_RULES to redact. Those rules exist to DETECT, and a detector
   * only needs an anchor: the PRIVATE_KEY pattern matches the BEGIN line and stops. Redacting
   * with it replaced the header, wrote the base64 body and END marker into canon verbatim, and
   * left '[REDACTED:PRIVATE_KEY]' sitting directly above the key â€” worse than not redacting,
   * because it tells a reader where to look.
   *
   * Detection and redaction are different questions about the same rules, and one pattern
   * cannot answer both.
   */
  const BODY = 'MIIEowIBAAKCAQEA3Zx8Kq2mNvB7pL4wQ9sT1uYbC6dE8fG0hJ2kL4mN6oP8qR0sT';

  it('removes the body and the END marker, not just the header', () => {
    const key =
      '-----BEGIN RSA PRIVATE KEY-----' +
      String.fromCharCode(10) +
      BODY +
      String.fromCharCode(10) +
      '-----END RSA PRIVATE KEY-----';
    const r = redactSecrets(
      'building' + String.fromCharCode(10) + key + String.fromCharCode(10) + 'done',
    );

    expect(r.text, 'the key body must not survive').not.toContain(BODY);
    expect(r.text, 'nor the END marker, which proves the block was cut short').not.toContain(
      'END RSA PRIVATE KEY',
    );
    expect(r.text).toContain('[REDACTED:PRIVATE_KEY]');
    /* The surrounding output is still readable, which is the point of an excerpt. */
    expect(r.text).toContain('building');
    expect(r.text).toContain('done');
  });

  it('removes a key whose END marker never arrived', () => {
    /*
     * Build output is truncated all the time. A key that lost its terminator is still a key,
     * and a redactor that needs the closing marker fails exactly when output was cut off.
     */
    const r = redactSecrets(
      'log' +
        String.fromCharCode(10) +
        '-----BEGIN OPENSSH PRIVATE KEY-----' +
        String.fromCharCode(10) +
        BODY,
    );
    expect(r.text).not.toContain(BODY);
    expect(r.count).toBe(1);
  });

  it('every rule that can appear in output leaves nothing of the value behind', () => {
    /*
     * The general form. A sample per rule, asserted absent rather than merely "changed" â€”
     * the SEC-1 fix passed a weaker version of this test while leaving the key body in place.
     */
    const samples: readonly [string, string][] = [
      ['ANTHROPIC_KEY', 'sk-ant-' + 'api03R7kQ2mZ9pL4xW1nT8vB6cD5hJ3'],
      ['AWS_ACCESS_KEY', 'AKIA' + 'Q7X4ZL2MN8VBCD3R'],
      ['GITHUB_TOKEN', 'ghp_' + 'R7kQ2mZ9pL4xW1nT8vB6cD5hJ3aF1g'],
      ['SLACK_TOKEN', 'xoxb-' + '2847362912-R7kQ2mZ9pL4x'],
      ['GOOGLE_API_KEY', 'AIza' + 'SyR7kQ2mZ9pL4xW1nT8vB6cD5hJ3aF1gQ2m'],
    ];
    for (const [label, value] of samples) {
      const r = redactSecrets('env: ' + value);
      expect(r.text, label + ' survived redaction').not.toContain(value);
      expect(r.count, label + ' was not counted').toBeGreaterThan(0);
    }
  });
});

describe('the choke point examines the verb, whatever precedes it', () => {
  /*
   * SPEC: findings ENGINEERING-GIT-AND-COMMIT-INTEGRITY/F1 then F2 (MEDIUM), 1.0.1 review.
   *
   * The guard originally read `args.find((a) => !a.startsWith('-'))`, which returns
   * `user.name=Serva Code` for this module's own commit argv. I fixed that by skipping `-c`
   * and `-C` â€” the two globals this file uses â€” and the next review found the same desync one
   * option across: `['--git-dir','/x','push']` returns `/x`, so `push` is never examined.
   *
   * Fixing what the report named rather than what it meant, twice on one function. The set is
   * now enumerated from git's documented globals, and this asserts the property over all of
   * them instead of the two that happened to be reported.
   *
   * Tested through `gitVerb` because `GitService.git()` â€” the choke point that calls it â€” is
   * private, so the exported helper is the reachable surface. What the guard does WITH the
   * verb is covered by the forbidden-verb tests elsewhere in this file.
   */
  const FORBIDDEN = 'push';

  it('finds the verb behind every value-taking global option', () => {
    const globals = [
      ['-c', 'user.name=x'],
      ['-C', '/some/path'],
      ['--git-dir', '/some/.git'],
      ['--work-tree', '/some/tree'],
      ['--namespace', 'ns'],
      ['--exec-path', '/usr/lib/git-core'],
      ['--super-prefix', 'sub/'],
      ['--config-env', 'name=ENVVAR'],
      ['--attr-source', 'HEAD'],
    ];
    for (const pair of globals) {
      expect(gitVerb([...pair, FORBIDDEN, '--force']), pair[0] + ' hid the verb').toBe(FORBIDDEN);
    }
  });

  it('finds it behind several of them at once', () => {
    expect(
      gitVerb(['-c', 'a=b', '--git-dir', '/x', '-C', '/y', '--namespace', 'n', FORBIDDEN]),
    ).toBe(FORBIDDEN);
  });

  it('the =value forms need no special case, and still do not hide it', () => {
    /* A single token beginning with '-', so the ordinary flag rule already covers it. */
    expect(gitVerb(['--git-dir=/x', '--work-tree=/y', FORBIDDEN])).toBe(FORBIDDEN);
  });

  it('an option this parser does not know stops it, rather than being assumed harmless', () => {
    /*
     * SPEC: finding GIT-INT-M1 (MEDIUM), 1.0.1 security review.
     *
     * The parser skipped every unrecognised `-…`, which assumes it takes no value. A
     * value-taking global absent from the set therefore made the option's VALUE read as the
     * verb — and when that value looks like an allowed verb, the choke point approves one
     * subcommand while git runs another. The same desync the two earlier fixes closed, one
     * option further out; guessing is what made all three possible.
     *
     * `undefined` means "no verb could be determined", and the choke point refuses that.
     */
    expect(gitVerb(['--some-future-global', 'status', 'push'])).toBeUndefined();
    expect(gitVerb(['-Z', 'status'])).toBeUndefined();

    /* And the forms it DOES know still resolve, so this is not a blanket refusal. */
    expect(gitVerb(['--no-pager', 'status'])).toBe('status');
    expect(gitVerb(['--git-dir=/x', 'status'])).toBe('status');
    expect(gitVerb(['-c', 'user.name=x', 'commit'])).toBe('commit');
  });

  it('every forbidden verb is still found behind a global that takes a value', () => {
    for (const verb of FORBIDDEN_GIT_VERBS) {
      expect(gitVerb(['--git-dir', '/x', verb]), verb).toBe(verb);
    }
  });

  it('still reads the plain verb, and the argv this module actually builds', () => {
    expect(gitVerb(['status', '--porcelain'])).toBe('status');
    expect(
      gitVerb(['-c', 'user.name=Serva Code', '-c', 'user.email=serva@localhost', 'commit', '-m']),
    ).toBe('commit');
  });
});

describe('a coincidence in a real credential does not disarm the scan', () => {
  /*
   * SPEC: finding ENGINEERING-SECRETS-AND-EXECUTION-EVIDENCE/SEC-PLACEHOLDER-1 (MEDIUM),
   * 1.0.1 security review.
   *
   * `looksLikePlaceholder` downgrades HIGH to MEDIUM and `blocking` requires a HIGH, so the
   * downgrade is what decides enforcement. The rule was `/(.)\1{3,}/` â€” four identical
   * characters ANYWHERE â€” and a genuine forty-character token contains such a run often
   * enough to matter. Every one of those was silently dropped out of the blocking set.
   *
   * The distinguishing property was never "contains a repeat" but "is degenerate": a masked
   * value's longest run covers most of it and its alphabet is tiny; a real credential's does
   * neither, whatever unlucky substring it happens to carry.
   */
  it('a real token containing a four-character run stays HIGH', () => {
    const withRun = 'ghp_' + 'R7kQaaaa2mZ9pL4xW1nT8vB6cD5hJ3';
    const f = scanText('src/config.ts', 'const t = "' + withRun + '";');
    expect(f.length).toBeGreaterThan(0);
    expect(f[0]?.severity, 'a coincidental repeat must not disarm the gate').toBe('HIGH');
  });

  it('and so does one containing a longer run, while the value stays varied', () => {
    const withRun = 'ghp_' + 'R7kQaaaaa2mZ9pL4xW1nT8vB6cD5hJ';
    const f = scanText('src/config.ts', 'const t = "' + withRun + '";');
    expect(f[0]?.severity).toBe('HIGH');
  });

  it('a masked value, whose repeat dominates it, is still downgraded', () => {
    const masked = 'AKIA' + 'XXXXXXXXXXXXXXXX';
    const f = scanText('README.md', masked);
    expect(f.length).toBe(1);
    expect(f[0]?.severity, 'a mask is documentation, not a credential').toBe('MEDIUM');
  });

  it('a low-entropy value that is not dominated by one character stays HIGH', () => {
    /*
     * ASSERTED IN THE DIRECTION IT ACTUALLY ERRS, which is the safe one.
     *
     * sk-ant-abababab… alternates, but counting the vendor prefix it carries six distinct
     * characters and no dominant run, so the degeneracy rules do not fire and it stays
     * blocking. An earlier version of this test expected MEDIUM and was simply wrong about
     * what the rule does.
     *
     * Leaving it HIGH costs somebody an explanation for an obvious fake; downgrading it would
     * risk waving through a real credential that happened to look repetitive. The finding
     * being fixed here is the second kind, and the rules are deliberately biased that way.
     */
    const f = scanText('README.md', 'sk-ant-' + 'ababababababababab');
    expect(f[0]?.severity).toBe('HIGH');
  });

  it('and a documented example key, which names itself', () => {
    /* AWS publishes AKIAIOSFODNN7EXAMPLE; nobody is issued a key containing EXAMPLE. */
    const f = scanText('docs/setup.md', 'AKIAIOSFODNN7EXAMPLE');
    expect(f[0]?.severity).toBe('MEDIUM');
  });
});

describe('a credential on the command line is not written to canon', () => {
  /*
   * SPEC: finding ENGINEERING-SECRETS-AND-EXECUTION-EVIDENCE/SEC-ARGS-1 (MEDIUM), 1.0.1.
   *
   * stdout and stderr are redacted before they reach T-CANON and the environment is stored as
   * a digest of its keys with values excluded â€” while argv went in verbatim. One side of a
   * boundary left open is how the boundary is defeated later.
   */
  it('redacts a credential in an argument, keeping the flag readable', () => {
    const r = redactSecrets('--token=sk-ant-' + 'api03R7kQ2mZ9pL4xW1nT8vB6cD5hJ3');
    expect(r.text).not.toContain('api03R7kQ2mZ9pL4xW1nT8vB6cD5hJ3');
    expect(r.text, 'the shape of the invocation is what an auditor reads').toContain('--token=');
    expect(r.count).toBe(1);
  });

  it('leaves ordinary arguments untouched', () => {
    for (const arg of ['--noEmit', 'test.js', '-p', 'tsconfig.build.json']) {
      expect(redactSecrets(arg).text).toBe(arg);
    }
  });

  it('the record construction routes args through redaction', () => {
    /*
     * Structural, because reaching runRecipe needs a live substrate. What matters is that the
     * persisted field is not the raw recipe array â€” the exact thing the finding named.
     */
    const src = readFileSync('src/engineering/execution.ts', 'utf8');
    expect(src, 'argv must be sanitised before it is persisted').toContain(
      'args: redactArgs(req.recipe.args)',
    );
    expect(src).not.toContain('args: [...req.recipe.args]');
  });
});
