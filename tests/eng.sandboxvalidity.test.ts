import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { FAKE_CAPABILITIES, FAKE_ENGINE_VERSION, FakeEngineAdapter } from '../src/engine/fake.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { ContractRegistry } from '../src/agents/registry.js';
import {
  SimulatedExecutionSubstrate,
  makeFixtureDir,
  removeFixtureDir,
} from '../src/substrate/fake.js';
import { GitService } from '../src/engineering/git.js';
import { EngineeringWorkspaceManager, workspacesRootFor } from '../src/engineering/workspace.js';
import { RecipeRegistry } from '../src/engineering/recipe.js';
import { EngineeringFactory } from '../src/engineering/factory.js';
import { dispatchProducer, verifySandboxProfileInForce } from '../src/engineering/dispatch.js';
import {
  OS_SANDBOX_QUALIFICATION,
  PRODUCER_DENIED_COMMANDS,
  QUALIFICATION_ONLY_MARKER,
  resolveOsSandboxQualificationPolicy,
} from '../src/engineering/capability.js';
import {
  ContainmentAttribution,
  ProbePermission,
  SANDBOX_MEASUREMENT_TYPE,
  SANDBOX_STATUS_ORDER,
  SUPPORTED_SANDBOX_KEYS,
  SandboxProfileStatus,
  buildSandboxProfile,
  containmentRefusal,
  measurementRefusal,
  sandboxProfileStatuses,
  validateSandboxProfile,
} from '../src/engineering/sandboxProfile.js';
import type { ProbeObservation, SandboxMeasurement } from '../src/engineering/sandboxProfile.js';
import { BoundaryPurpose, executionBoundary } from '../src/substrate/boundary.js';
import { WslTransport } from '../src/substrate/transport.js';
import { probeClaude } from '../src/engine/claude/probe.js';
import { EngineHealthState } from '../src/engine/types.js';
import { buildChangeSet } from '../src/engineering/changeset.js';
import { integrateVerifiedChangeSet } from '../src/engineering/integration.js';
import { cleanup, freshStore } from './helpers.js';
import type { GeneratedSandboxProfile } from '../src/engineering/sandboxProfile.js';
import type { ExecutorDeps } from '../src/engineering/execution.js';
import { Store } from '../src/store/store.js';

/**
 * A SANDBOX PROFILE THE ENGINE WOULD IGNORE IS NOT A SANDBOX.
 *
 * The defect these tests exist for: Serva emitted `sandbox.network.enabled`, which is
 * not a key the engine validates. A settings file that fails validation is not partially
 * applied and does not warn — it is discarded whole. So the Producer ran under DEFAULT
 * policy, which confines writes to the working directory (making the profile look
 * effective) and leaves reads open across the machine. A real Producer read Serva's own
 * store through Bash while Serva recorded a HARD boundary.
 *
 * `claude doctor` cannot be the check: measured on 2.1.231 it emits byte-identical
 * output for a valid profile and one carrying that bad key. There is no one to ask, so
 * validity has to be established BEFORE dispatch, and it has to be blocking.
 */

const roots: string[] = [];
const fixtures: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
  for (const f of fixtures.splice(0)) removeFixtureDir(f);
});

const PRODUCER = 'SC-AGENT-150';

/**
 * Every AgentRun the store knows about, live projection or terminal record.
 *
 * Asked of the store rather than guessed from the filesystem, and covering both shelves,
 * so "no run was created" cannot be satisfied by a run that merely finished.
 */
function runsIn(store: Store): string[] {
  return [
    ...new Set([...store.listWorkingIds('agentRun'), ...store.listCanonIds('agentRunRecord')]),
  ];
}

/** Put an arbitrary key into a generated profile, as a broken build of it would. */
function withKey(
  base: GeneratedSandboxProfile,
  path: string,
  value: unknown,
): GeneratedSandboxProfile {
  const settings = JSON.parse(JSON.stringify(base.settings)) as Record<string, unknown>;
  const parts = path.split('.');
  let node = settings;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    node[part] = typeof next === 'object' && next !== null ? next : {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1] as string] = value;
  return { ...base, settings };
}

function filesystemOf(p: GeneratedSandboxProfile): Record<string, string[]> {
  const sandbox = p.settings['sandbox'] as Record<string, unknown>;
  return sandbox['filesystem'] as Record<string, string[]>;
}

describe('a setting the engine would reject blocks the run', () => {
  const good = (): GeneratedSandboxProfile =>
    buildSandboxProfile({ worktreePath: 'D:/p/wt', projectRoot: 'D:/p', networkAllowed: false });

  it('the profile Serva actually emits is accepted in full', () => {
    // The positive control. Without it, a validator that rejected everything would look
    // exactly like a working defence.
    const v = validateSandboxProfile(good(), FAKE_ENGINE_VERSION);
    expect(v.ok).toBe(true);
    expect(v.rejected).toEqual([]);
  });

  it('the exact key that caused the incident is rejected by name', () => {
    const v = validateSandboxProfile(
      withKey(good(), 'sandbox.network.enabled', false),
      FAKE_ENGINE_VERSION,
    );
    expect(v.ok).toBe(false);
    expect(v.rejected).toContain('sandbox.network.enabled');
    expect(v.reason).toContain('SANDBOX_PROFILE_REJECTED');
  });

  it('any unknown key is rejected, not just the one already seen', () => {
    // An allowlist, so the defence covers the NEXT invented field too.
    for (const path of [
      'sandbox.readOnly',
      'sandbox.filesystem.allowAll',
      'sandbox.network.mode',
    ]) {
      expect(validateSandboxProfile(withKey(good(), path, true), FAKE_ENGINE_VERSION).ok).toBe(
        false,
      );
    }
  });

  it('a supported key on too old an engine is rejected as well', () => {
    /*
     * `strictAllowlist` arrived in 2.1.219. On 2.1.200 the key is unknown, the file is
     * discarded, and every protection in it — not merely the network stance — is gone.
     * The version gate is therefore part of validity, not a nicety.
     */
    const v = validateSandboxProfile(good(), '2.1.200');
    expect(v.ok).toBe(false);
    expect(v.rejected.join(' ')).toContain('sandbox.network.strictAllowlist');
    expect(v.rejected.join(' ')).toContain('2.1.219');
  });

  it('every gated key names the version that introduced it', () => {
    for (const k of SUPPORTED_SANDBOX_KEYS) {
      if (k.since !== undefined) expect(k.since).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('validity is checked before the profile is even looked for on disk', () => {
    /*
     * Ordering matters: a rejected profile must refuse on its own terms rather than on
     * "the file is missing", so the operator is told the truth about why.
     */
    const check = verifySandboxProfileInForce({
      profile: withKey(good(), 'sandbox.network.enabled', false),
      capabilities: FAKE_CAPABILITIES,
      engineVersion: FAKE_ENGINE_VERSION,
    });
    expect(check.refusal).toContain('SANDBOX_PROFILE_REJECTED');
    expect(check.refusal).not.toContain('not on disk');
  });
});

describe('a rejected profile stops the Producer before any model call', () => {
  /*
   * `engineVersion` is threaded through the SIMULATED BOUNDARY as well as the engine,
   * because the boundary identity includes the engine version: a fixture that changed
   * only the dispatch-time version would be refused for EXECUTION_BOUNDARY_MISMATCH and
   * never reach the profile check at all. What is under test here is a qualified,
   * matching boundary whose engine cannot hold the policy Serva emits.
   */
  async function setup(engineVersion: string = FAKE_ENGINE_VERSION) {
    const capabilities = { ...FAKE_CAPABILITIES, version: engineVersion };
    const { store, root, deps } = freshStore();
    roots.push(root);
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'total.js'), 'module.exports = 1;\n', 'utf8');
    const g = (...a: string[]): string =>
      execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
      enforcement: 'HARD',
      boundary: executionBoundary({
        boundaryId: 'SC-BOUNDARY-PRODUCER',
        purpose: BoundaryPurpose.PRODUCER,
        transport: 'fake',
        engineLocation: 'fake-engine',
        engineVersion,
        sandboxMechanism: 'simulated',
        profileDigest: buildSandboxProfile({
          worktreePath: join(repo, 'w'),
          projectRoot: repo,
          networkAllowed: false,
        }).policyDigest,
        simulated: true,
      }),
    });
    const fixtureDir = makeFixtureDir();
    fixtures.push(fixtureDir);
    const qualification = await substrate.qualify(fixtureDir);
    const engine = new FakeEngineAdapter({ clock: deps.clock, capabilities });
    const runtime = new AgentRuntime({
      store,
      ids: deps.ids,
      clock: deps.clock,
      registry: ContractRegistry.shared(),
      engine,
      enabledAgents: new Set([PRODUCER]),
      projectRoot: repo,
    });
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
      recipes: new RecipeRegistry(),
      registry: ContractRegistry.shared(),
      qualification,
      executorDeps,
      gateDeps: { ids: deps.ids, clock: deps.clock, evaluator: 'ENGINEERING_GATE' },
      projectRoot: repo,
      enabledProducers: new Set([PRODUCER]),
      producerBoundary: qualification.boundary,
      allowSimulatedBoundary: true,
    });
    const item = factory.recordWorkItem({
      workItemId: 'SC-WI-VALID',
      title: 'Profile validity',
      requirements: ['Change nothing.'],
      acceptanceCriteria: ['Never dispatched.'],
      decisions: [],
      allowedScope: ['src/'],
      forbiddenScope: [],
      producerAgentId: PRODUCER,
      reviewerAgentId: 'SC-AGENT-200',
      recipes: [],
      magnitude: 'M1',
      baseCommit: base,
      expectedOutputs: [],
      maxAttempts: 1,
    });
    const workspace = await factory.openWorkspace(item, 1, qualification.boundary.fingerprint);
    return {
      store,
      root,
      deps,
      repo,
      engine,
      runtime,
      substrate,
      qualification,
      item,
      workspace,
      capabilities,
    };
  }

  const dispatchOn = async (f: Awaited<ReturnType<typeof setup>>) =>
    dispatchProducer(
      {
        store: f.store,
        clock: f.deps.clock,
        ids: f.deps.ids,
        runtime: f.runtime,
        registry: ContractRegistry.shared(),
        substrate: f.substrate,
        qualification: f.qualification,
        projectRoot: f.repo,
        enabledProducers: new Set([PRODUCER]),
        engineCapabilities: f.capabilities,
        engineVersion: f.capabilities.version,
        allowSimulatedBoundary: true,
      },
      {
        item: f.item,
        workspace: f.workspace,
        taskDefinition: 'Do nothing.',
        reviewerAvailable: true,
        executorsAvailable: true,
      },
    );

  it('refuses, records no run, and spends nothing', async () => {
    const f = await setup('2.1.200');

    /*
     * An engine too old for `strictAllowlist` is the honest way to reach this state
     * without hand-forging a profile: the settings file Serva would write is one this
     * engine discards whole. Serva must not dispatch into that.
     */
    await expect(dispatchOn(f)).rejects.toThrow(/SANDBOX_PROFILE_REJECTED/);

    // No model call.
    expect(f.engine.seen).toEqual([]);
    // No AgentRun at all, so nothing carrying write authority.
    expect(runsIn(f.store)).toEqual([]);
  });

  it('the same dispatch proceeds on an engine that accepts the profile', async () => {
    /*
     * The positive control for the refusal above: the ONLY thing that differs is the
     * engine version, so the refusal cannot be coming from something else being broken.
     */
    const f = await setup();
    f.engine.scriptDefault({
      structuredOutput: {
        status: 'COMPLETED',
        result: { summary: 'nothing to do', filesChanged: [], testsRun: [], notes: [] },
        selfReview: {
          contractConformance: 'ok',
          scopeConformance: 'ok',
          knownGaps: [],
          confidence: 'MEDIUM',
          assumptionsMade: [],
        },
        observations: [],
        escalations: [],
        evidenceClaims: [],
        unresolved: [],
      },
    });
    const d = await dispatchOn(f);
    expect(f.engine.seen.length).toBeGreaterThan(0);
    expect(d.runId).toBeTruthy();
    // And an AgentRun IS on disk here — which is what makes the empty directory in the
    // refusal case evidence rather than an artefact of looking in the wrong place.
    expect(runsIn(f.store).length).toBeGreaterThan(0);
  });
});

describe('the denied read regions are the ones that matter', () => {
  it('denies the store, the checkout, sibling attempts and the home directory', () => {
    const worktree = join(workspacesRootFor('D:/p'), 'SC-WI-1-a01');
    const fs = filesystemOf(
      buildSandboxProfile({ worktreePath: worktree, projectRoot: 'D:/p', networkAllowed: false }),
    );
    const denyRead = fs['denyRead'] as string[];
    expect(denyRead.some((x) => x.endsWith('.serva'))).toBe(true);
    expect(denyRead).toContain('~/');
    // Sibling attempts share a parent; denying it is what keeps two concurrent
    // Producers out of each other's work.
    expect(denyRead).toContain(workspacesRootFor('D:/p'));
    /*
     * Two regions are re-opened and no more: this attempt's own worktree, and the
     * `.git` directory it is a linked worktree of — without which `git status` inside
     * the worktree fails outright, measured as a positive control.
     */
    expect(fs['allowRead']).toEqual([worktree, join('D:/p', '.git')]);
  });

  it('does not deny the runtime the Producer needs in order to run at all', () => {
    /*
     * A policy that denied `/usr` or `/etc` would not be stricter, it would be broken:
     * node, git and the shell live there. Containment is about what the OWNER cares
     * about, not about maximising the length of the deny list.
     */
    const fs = filesystemOf(buildSandboxProfile({ worktreePath: 'D:/p/wt', projectRoot: 'D:/p' }));
    for (const runtime of ['/usr', '/lib', '/etc', '/bin', '/proc']) {
      expect(fs['denyRead']).not.toContain(runtime);
    }
  });
});

describe('the qualification grant is not a Producer grant', () => {
  const workspace = {
    path: 'D:/ws/SC-WI-1-a01',
    workspaceId: 'SC-WI-1-a01',
    workItemId: 'SC-WI-1',
  } as never;
  const probes = ['Bash(node:*)', 'Bash(curl:*)'];
  const qual = (): ReturnType<typeof resolveOsSandboxQualificationPolicy> =>
    resolveOsSandboxQualificationPolicy({
      workspace,
      projectRoot: 'D:/p',
      probeCommands: probes,
    });

  it('announces itself as qualification-only, in the record the run carries', () => {
    /*
     * The marker is in the rationale rather than in a comment because the rationale is
     * what ends up in the trace. An operator reading a run has to be able to see that
     * the grant it ran under was a measurement instrument.
     */
    expect(qual().rationale[0]).toBe(QUALIFICATION_ONLY_MARKER);
    expect(qual().rationale.join(' ')).toContain(OS_SANDBOX_QUALIFICATION);
  });

  it('approves the probe commands and nothing resembling a blanket', () => {
    const policy = qual();
    for (const p of probes) expect(policy.approve).toContain(p);
    expect(policy.approve).not.toContain('Bash(*)');
    expect(policy.approve).not.toContain('Bash');
  });

  it('deliberately does NOT apply the production command denials', () => {
    /*
     * This is the point of the profile and it looks like a weakening, so it is asserted
     * on purpose: `Bash(curl*)` denied at the permission layer would mean the network
     * probe never reaches the sandbox, and the run would record a denial that proves
     * nothing about containment.
     */
    const policy = qual();
    for (const denied of PRODUCER_DENIED_COMMANDS) {
      expect(policy.deny).not.toContain(denied);
    }
  });

  it('still refuses the tools that would buy no evidence', () => {
    const policy = qual();
    for (const t of ['Agent', 'Task', 'WebFetch', 'WebSearch']) {
      expect(policy.deny).toContain(t);
    }
  });

  it('the production Producer grant carries no qualification marker and no extra commands', () => {
    /*
     * The regression that matters: `resolveProducerPolicy` used to accept an
     * `allowedCommands` list, which meant the qualification grant and the production
     * grant were the same function with a parameter. They are now different functions,
     * and this asserts the production one cannot be talked into the other's behaviour.
     */
    const source = readFileSync('src/engineering/capability.ts', 'utf8');
    const producerBody = source.slice(
      source.indexOf('export function resolveProducerPolicy'),
      source.indexOf('export const OS_SANDBOX_QUALIFICATION'),
    );
    expect(producerBody).not.toContain('allowedCommands');
    expect(producerBody).not.toContain('probeCommands');
    expect(producerBody).not.toContain(QUALIFICATION_ONLY_MARKER);
  });
});

describe('the policy is written in the paths the engine will see', () => {
  const toGuest = (hostPath: string): string => new WslTransport('Ubuntu').toGuestPath(hostPath);

  it('every emitted path is a guest path when the engine runs in a guest', () => {
    /*
     * Measured defect: the profile carried a Windows path for the worktree while the engine ran
     * in WSL2. Every entry named a directory that does not exist there, so the write
     * allowance granted nothing and the read denials denied nothing — and because the
     * engine's DEFAULT policy confines writes to the working directory anyway, the
     * result looked like a working sandbox with every read protection missing.
     */
    const p = buildSandboxProfile({
      worktreePath: 'C:/ws/SC-WI-1-a01',
      projectRoot: 'C:/proj',
      networkAllowed: false,
      toExecutionPath: toGuest,
    });
    const fs = filesystemOf(p);
    const emitted = [
      ...fs['allowWrite']!,
      ...fs['denyWrite']!,
      ...fs['denyRead']!,
      ...fs['allowRead']!,
    ];
    for (const entry of emitted) {
      // Either a guest-absolute path or a home-relative one. Never a drive letter, and
      // never a backslash.
      expect(entry.startsWith('/') || entry.startsWith('~/')).toBe(true);
      expect(entry).not.toMatch(/^[A-Za-z]:/);
      expect(entry).not.toContain(String.fromCharCode(92));
    }
    // The worktree, plus the repository it is a linked worktree OF. Nothing else.
    expect(fs['allowRead']).toEqual(['/mnt/c/ws/SC-WI-1-a01', '/mnt/c/proj/.git']);
  });

  it('translation does not change the policy identity', () => {
    /*
     * The boundary fingerprint must describe the POLICY, not the machine it is written
     * for. If translating the paths changed the digest, a qualification could never
     * match the run it qualified.
     */
    const host = buildSandboxProfile({ worktreePath: 'C:/ws/a', projectRoot: 'C:/proj' });
    const guest = buildSandboxProfile({
      worktreePath: 'C:/ws/a',
      projectRoot: 'C:/proj',
      toExecutionPath: toGuest,
    });
    expect(guest.policyDigest).toBe(host.policyDigest);
    // ...while the bytes actually written are different, which is the point.
    expect(guest.digest).not.toBe(host.digest);
  });
});

describe('a worktree git pointer works in the environment that will use it', () => {
  it('is relative, and uses forward slashes', async () => {
    /*
     * Measured defect, found by a POSITIVE CONTROL rather than by a containment probe:
     * `git status` inside a Producer worktree failed with exit 128, and it failed
     * OUTSIDE any sandbox too, so the sandbox was not the cause.
     *
     * `git worktree add` writes an absolute pointer — correct for the machine that ran
     * it. Serva runs git on Windows and delegates write-capable Producers to WSL2, where
     * `gitdir: C:/...` is read as a RELATIVE path and appended to the worktree
     * directory. A relative pointer with forward slashes is resolved identically by git
     * on both platforms, so one file is right for both.
     */
    const { store, root, deps } = freshStore();
    roots.push(root);
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.js'), 'module.exports = 1;\n', 'utf8');
    const g = (...a: string[]): string =>
      execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
    const ws = await workspaces.create({
      projectId: 'SC-PROJ-1',
      workItemId: 'SC-WI-000100',
      attempt: 1,
      producerAgentId: PRODUCER,
      baseCommit: base,
      expectedScope: { allow: ['src/'], forbid: [] },
      sandboxProfileDigest: 'digest',
      substrateClass: 'HARD',
    });

    const pointer = readFileSync(join(ws.path, '.git'), 'utf8').trim();
    expect(pointer.startsWith('gitdir: ')).toBe(true);
    const target = pointer.slice('gitdir: '.length);
    // Relative, so it means the same thing from either operating system...
    expect(target.startsWith('..')).toBe(true);
    expect(target).not.toMatch(/^[A-Za-z]:/);
    // ...and forward slashes, which git accepts on Windows and requires on Linux.
    expect(target).not.toContain(String.fromCharCode(92));
    // It still resolves to the real worktree administrative directory.
    expect(existsSync(resolve(ws.path, target))).toBe(true);

    // And git in the worktree works from the host, which is the other half of the claim.
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: ws.path,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(typeof status).toBe('string');
  });
});

describe('a sandbox is proved by measurement, not by a settings file', () => {
  const profile = (): ReturnType<typeof buildSandboxProfile> =>
    buildSandboxProfile({ worktreePath: 'D:/p/wt', projectRoot: 'D:/p', networkAllowed: false });

  /** A probe that did what a containment probe has to do to be evidence. */
  const contained = (id: string): ProbeObservation => ({
    id,
    permission: ProbePermission.ALLOWED,
    reached: true,
    contained: true,
    attribution: ContainmentAttribution.SANDBOX,
  });

  const good = (p = profile()): SandboxMeasurement => ({
    policyDigest: p.policyDigest,
    boundaryFingerprint: 'fp-1',
    engineVersion: FAKE_ENGINE_VERSION,
    measuredAt: '2026-01-01T00:00:00.000Z',
    positiveControls: [
      { id: 'P1', permission: ProbePermission.ALLOWED, reached: true, passed: true },
      { id: 'P2', permission: ProbePermission.ALLOWED, reached: true, passed: true },
    ],
    containment: [contained('R1'), contained('W2')],
    notes: [],
  });

  const at = {
    policyDigest: profile().policyDigest,
    boundaryFingerprint: 'fp-1',
    engineVersion: FAKE_ENGINE_VERSION,
  };

  it('accepts a measurement of this policy, on this boundary, on this engine', () => {
    expect(measurementRefusal(good(), at)).toBeUndefined();
  });

  it('no measurement at all is a refusal, not a warning', () => {
    expect(measurementRefusal(undefined, at)).toMatch(/unproved/);
  });

  it('a measurement with no positive control proves nothing', () => {
    /*
     * The first cross-check was exactly this: nine denials, no control, and a conclusion
     * drawn from them. Every one of those denials came from the permission layer before
     * the sandbox was ever reached.
     */
    const m = { ...good(), positiveControls: [] };
    expect(measurementRefusal(m, at)).toMatch(/no positive controls/);
  });

  it('a failed positive control invalidates the whole measurement', () => {
    const m = {
      ...good(),
      positiveControls: [
        { id: 'P1', permission: ProbePermission.ALLOWED, reached: true, passed: false },
      ],
    };
    const r = measurementRefusal(m, at);
    expect(r).toContain('P1');
    expect(r).toMatch(/invalid/);
  });

  it('an escape is a refusal', () => {
    const m = { ...good(), containment: [{ ...contained('W3'), contained: false }] };
    expect(measurementRefusal(m, at)).toMatch(/W3 ESCAPED/);
  });

  it('a measurement of a different policy does not carry over', () => {
    /*
     * The drift invalidation, expressed as an identity rather than as a rule someone has
     * to remember: change the policy and the digest changes, so the old measurement no
     * longer describes the thing about to run.
     */
    const m = { ...good(), policyDigest: 'some-other-policy' };
    expect(measurementRefusal(m, at)).toMatch(/DIFFERENT sandbox policy/);
  });

  it('a measurement of a different boundary or engine does not carry over either', () => {
    expect(measurementRefusal({ ...good(), boundaryFingerprint: 'fp-2' }, at)).toMatch(
      /DIFFERENT execution boundary/,
    );
    expect(measurementRefusal({ ...good(), engineVersion: '2.1.220' }, at)).toMatch(/2\.1\.220/);
  });

  it('HARD requires all five statuses, and names the ones it did not reach', () => {
    const p = profile();
    const complete = sandboxProfileStatuses({
      profile: p,
      engineVersion: FAKE_ENGINE_VERSION,
      boundaryFingerprint: 'fp-1',
      loaded: true,
      passedToInvocation: true,
      measurement: good(p),
    });
    expect(complete.reached).toEqual(SANDBOX_STATUS_ORDER);
    expect(complete.missing).toEqual([]);

    // Everything short of a measurement stops at EFFECTIVE, and says so.
    const unmeasured = sandboxProfileStatuses({
      profile: p,
      engineVersion: FAKE_ENGINE_VERSION,
      boundaryFingerprint: 'fp-1',
      loaded: true,
      passedToInvocation: true,
    });
    expect(unmeasured.missing).toEqual([SandboxProfileStatus.MEASURED]);
    expect(unmeasured.reached).not.toContain(SandboxProfileStatus.MEASURED);
    expect(unmeasured.reasons.join(' ')).toMatch(/unproved/);
  });

  it('a file that never reached the invocation is not EFFECTIVE', () => {
    const r = sandboxProfileStatuses({
      profile: profile(),
      engineVersion: FAKE_ENGINE_VERSION,
      boundaryFingerprint: 'fp-1',
      loaded: false,
      passedToInvocation: false,
    });
    expect(r.reached).toEqual([SandboxProfileStatus.GENERATED, SandboxProfileStatus.VALIDATED]);
    expect(r.missing).toContain(SandboxProfileStatus.LOADED);
    expect(r.missing).toContain(SandboxProfileStatus.EFFECTIVE);
  });
});

describe('tool denial is not OS containment', () => {
  /*
   * THE DEFECT THIS SUITE EXISTS FOR.
   *
   * `contained` used to be computed as `truth !== false` — "no forbidden artifact turned
   * up". That is true of a probe the OS refused, and equally true of a probe that NEVER
   * RAN because the tool permission layer denied it first. The two are opposites: one is
   * the measurement, the other is its absence. Read the same way, a permission denial
   * would qualify the sandbox it never touched.
   *
   *   OS containment PASS = permission ALLOWED and reached and independently contained.
   */
  const p = buildSandboxProfile({
    worktreePath: 'D:/p/wt',
    projectRoot: 'D:/p',
    networkAllowed: false,
  });
  const at = {
    policyDigest: p.policyDigest,
    boundaryFingerprint: 'fp-1',
    engineVersion: FAKE_ENGINE_VERSION,
  };
  const control = (id: string) => ({
    id,
    permission: ProbePermission.ALLOWED,
    reached: true,
    passed: true,
  });
  const ok = (id: string): ProbeObservation => ({
    id,
    permission: ProbePermission.ALLOWED,
    reached: true,
    contained: true,
    attribution: ContainmentAttribution.SANDBOX,
  });
  const measurement = (containment: readonly ProbeObservation[]): SandboxMeasurement => ({
    policyDigest: p.policyDigest,
    boundaryFingerprint: 'fp-1',
    engineVersion: FAKE_ENGINE_VERSION,
    measuredAt: '2026-01-01T00:00:00.000Z',
    positiveControls: [control('P1'), control('P2'), control('P3')],
    containment,
    notes: [],
  });

  it('1. every positive control passes, but R2 was permission-DENIED — refused', () => {
    const m = measurement([
      ok('R1'),
      { ...ok('R2'), permission: ProbePermission.DENIED, reached: false },
      ok('W2'),
    ]);
    const r = measurementRefusal(m, at);
    expect(r).toContain('R2');
    expect(r).toContain('PERMISSION_DENIED');
    // ...and it is refused DESPITE every positive control passing.
    expect(m.positiveControls.every((c) => c.passed)).toBe(true);
  });

  it('2. every positive control passes, but W3 was NOT_CALLED — refused', () => {
    const r = measurementRefusal(
      measurement([
        ok('R1'),
        { ...ok('W3'), permission: ProbePermission.NOT_CALLED, reached: false },
      ]),
      at,
    );
    expect(r).toContain('W3');
    expect(r).toContain('PERMISSION_NOT_CALLED');
  });

  it('3. ALLOWED but never reached the OS boundary — refused', () => {
    const r = measurementRefusal(measurement([ok('R1'), { ...ok('R5'), reached: false }]), at);
    expect(r).toContain('R5');
    expect(r).toContain('DID_NOT_REACH_OS_SANDBOX');
  });

  it('4. ALLOWED, reached, and it escaped — containment failure', () => {
    const r = measurementRefusal(measurement([ok('R1'), { ...ok('W3'), contained: false }]), at);
    expect(r).toBe('W3 ESCAPED');
  });

  it('5. ALLOWED, reached, independently contained — valid', () => {
    expect(measurementRefusal(measurement([ok('R1'), ok('W3')]), at)).toBeUndefined();
  });

  it('a probe that ran but has no independent truth is not containment either', () => {
    // Neither contained nor escaped: nothing on disk decides it. That is an absent
    // measurement, and an absent measurement must not read as a pass.
    const undecided: ProbeObservation = {
      id: 'R7',
      permission: ProbePermission.ALLOWED,
      reached: true,
      attribution: ContainmentAttribution.SANDBOX,
    };
    expect(containmentRefusal(undecided)).toContain('NO_INDEPENDENT_TRUTH');
  });

  it('a malformed observation is refused rather than believed', () => {
    // Records written before this schema existed have no permission or reached fields.
    // Fail closed: the absence of the facts is not the presence of a pass.
    const legacy = { id: 'R1', contained: true } as unknown as ProbeObservation;
    expect(containmentRefusal(legacy)).toContain('MALFORMED_OBSERVATION');
    expect(measurementRefusal(measurement([legacy]), at)).toContain('MALFORMED_OBSERVATION');
  });

  it('an environment-attributed probe is exempt from truth, never from reaching', () => {
    /*
     * H1 on this machine: a Windows binary cannot be executed from the guest with or
     * without a sandbox, so the disk cannot decide containment and the sandbox must not
     * be credited. That is modelled explicitly — and the probe STILL has to have been
     * permitted and to have reached the boundary, so an undecidable truth can never
     * quietly stand in for containment.
     */
    const h1: ProbeObservation = {
      id: 'H1',
      permission: ProbePermission.ALLOWED,
      reached: true,
      attribution: ContainmentAttribution.ENVIRONMENT,
      attributionBasis: 'HOST_ESCAPE_CURRENTLY_BLOCKED_BY_ENVIRONMENT — fails unsandboxed too',
    };
    expect(containmentRefusal(h1)).toBeUndefined();
    expect(containmentRefusal({ ...h1, permission: ProbePermission.DENIED })).toContain(
      'PERMISSION_DENIED',
    );
    expect(containmentRefusal({ ...h1, reached: false })).toContain('DID_NOT_REACH_OS_SANDBOX');
    // And on its own it proves nothing about the sandbox.
    expect(measurementRefusal(measurement([h1]), at)).toMatch(
      /no containment probe was attributed/,
    );
    // Alongside real sandbox evidence it is fine.
    expect(measurementRefusal(measurement([ok('R1'), h1]), at)).toBeUndefined();
  });

  it('7. a probe that never reached the boundary keeps the profile out of MEASURED', () => {
    const statuses = sandboxProfileStatuses({
      profile: p,
      engineVersion: FAKE_ENGINE_VERSION,
      boundaryFingerprint: 'fp-1',
      loaded: true,
      passedToInvocation: true,
      measurement: measurement([ok('R1'), { ...ok('R2'), reached: false }]),
    });
    expect(statuses.reached).not.toContain(SandboxProfileStatus.MEASURED);
    expect(statuses.missing).toEqual([SandboxProfileStatus.MEASURED]);
    expect(statuses.reasons.join(' ')).toContain('R2 DID_NOT_REACH_OS_SANDBOX');
  });

  it('6. the permission and reached facts survive a store round trip', () => {
    /*
     * The authoritative record has to answer "did this probe pass the permission layer
     * and reach the OS?" on its own, months later, without a console log or a sentence in
     * a report.
     */
    const { store, root, deps } = freshStore();
    roots.push(root);
    const written = measurement([ok('R1'), ok('W3')]);
    const tx = store.begin();
    tx.putCanon(SANDBOX_MEASUREMENT_TYPE, written.policyDigest, written);
    tx.commit();

    // Reopened from disk, as a later process would see it.
    const reopened = Store.open(root, deps);
    const read = reopened.getCanon<SandboxMeasurement>(
      SANDBOX_MEASUREMENT_TYPE,
      written.policyDigest,
    )?.body;

    expect(read?.containment.map((c) => c.id)).toEqual(['R1', 'W3']);
    for (const c of read?.containment ?? []) {
      expect(c.permission).toBe(ProbePermission.ALLOWED);
      expect(c.reached).toBe(true);
      expect(c.attribution).toBe(ContainmentAttribution.SANDBOX);
    }
    for (const c of read?.positiveControls ?? []) {
      expect(c.permission).toBe(ProbePermission.ALLOWED);
      expect(c.reached).toBe(true);
    }
    expect(measurementRefusal(read, at)).toBeUndefined();
  });

  it("8. the real shape of this machine's result still qualifies", () => {
    /*
     * 7 positive controls and 16 containment probes, in the shape the live qualification
     * actually produces: every required negative ALLOWED, reached and contained, with H1
     * attributed to the environment.
     */
    const controls = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'W1'].map(control);
    const negatives: ProbeObservation[] = [
      ...['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'].map(ok),
      ...['W2', 'W3', 'W4', 'W5', 'W6'].map(ok),
      ok('N1'),
      {
        id: 'H1',
        permission: ProbePermission.ALLOWED,
        reached: true,
        attribution: ContainmentAttribution.ENVIRONMENT,
        attributionBasis: 'HOST_ESCAPE_CURRENTLY_BLOCKED_BY_ENVIRONMENT',
      },
    ];
    expect(controls).toHaveLength(7);
    expect(negatives).toHaveLength(16);

    const m: SandboxMeasurement = { ...measurement(negatives), positiveControls: controls };
    expect(measurementRefusal(m, at)).toBeUndefined();

    const statuses = sandboxProfileStatuses({
      profile: p,
      engineVersion: FAKE_ENGINE_VERSION,
      boundaryFingerprint: 'fp-1',
      loaded: true,
      passedToInvocation: true,
      measurement: m,
    });
    expect(statuses.reached).toEqual(SANDBOX_STATUS_ORDER);
    expect(statuses.missing).toEqual([]);
  });
});

describe('a slow engine is not a missing engine', () => {
  const now = (): string => '2026-01-01T00:00:00.000Z';

  /** A runner that times out the first N calls to `--version`, then answers normally. */
  const runner = (timeoutsBeforeAnswering: number) => {
    let seen = 0;
    const calls: number[] = [];
    const run = async (
      _bin: string,
      args: readonly string[],
      timeoutMs: number,
    ): Promise<{ code: number | null; stdout: string; stderr: string; timedOut?: boolean }> => {
      if (args[0] === '--version') {
        calls.push(timeoutMs);
        seen += 1;
        if (seen <= timeoutsBeforeAnswering) {
          // A killed process closes with a null code. Without `timedOut` this is
          // indistinguishable from a binary that does not exist.
          return { code: null, stdout: '', stderr: '', timedOut: true };
        }
        return { code: 0, stdout: '2.1.231 (Claude Code)', stderr: '' };
      }
      return { code: 0, stdout: '{"loggedIn":true}', stderr: '' };
    };
    return { run, calls };
  };

  it('retries once with a longer budget, and reports READY', async () => {
    /*
     * Measured: the FIRST `--version` into the WSL2 guest took 16.3s against a 15s
     * budget — starting the distro and faulting in a 300MB binary across a filesystem
     * bridge — while every later call answered in under a second. Serva reported the
     * engine UNAVAILABLE and refused the whole qualification with
     * PLATFORM_PREREQUISITE_REQUIRED, telling the owner to install software that was
     * already installed, authenticated and working.
     */
    const r = runner(1);
    const res = await probeClaude({ run: r.run, now, env: {}, timeoutMs: 1000 });
    expect(res.status.state).toBe(EngineHealthState.READY);
    expect(res.status.version).toBe('2.1.231');
    // The retry got a strictly larger budget; retrying with the same one would just
    // repeat the measurement that already failed.
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]).toBeGreaterThan(r.calls[0] as number);
  });

  it('a persistent timeout is reported as a timeout, not as a missing install', async () => {
    const r = runner(99);
    const res = await probeClaude({ run: r.run, now, env: {}, timeoutMs: 1000 });
    expect(res.status.state).toBe(EngineHealthState.UNAVAILABLE);
    expect(res.status.detail).toMatch(/did not answer/);
    expect(res.status.detail).not.toMatch(/could not be run/);
    // And the remedy does not send the owner to reinstall a working engine.
    expect(res.status.remedy).not.toMatch(/Install Claude Code/);
    expect(res.status.remedy).toMatch(/not responding in time/);
    expect(r.calls).toHaveLength(2);
  });

  it('a genuinely absent binary still says so', async () => {
    // The protection this whole path exists for is untouched.
    const run = async (): Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      spawnFailed?: boolean;
    }> => ({
      code: null,
      stdout: '',
      stderr: '',
      spawnFailed: true,
    });
    const res = await probeClaude({ run, now, env: {}, timeoutMs: 1000 });
    expect(res.status.state).toBe(EngineHealthState.UNAVAILABLE);
    expect(res.status.detail).toMatch(/could not be run/);
    expect(res.status.remedy).toMatch(/Install Claude Code/);
  });
});

describe('the verified change set names the blob git will actually store', () => {
  it('matches git under core.autocrlf, and integrates', async () => {
    /*
     * Measured on this machine: `core.autocrlf` is true GLOBALLY, so every worktree
     * Serva creates inherits it. Serva computed each entry's blob id by hashing the
     * bytes on disk, while `git add` stores the FILTERED content — a different id for
     * any file whose working-tree form differs from its stored form. The verified change
     * set and the staged index therefore disagreed, and integration refused a correct
     * commit with CHANGESET_INTEGRATION_MISMATCH.
     *
     * The comparison is not relaxed here. Both sides are simply asked of git, so the
     * check compares two of the same kind of thing, and it still refuses a commit whose
     * content is not the content that was verified.
     */
    const { store, root, deps } = freshStore();
    roots.push(root);
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    const g = (...a: string[]): string =>
      execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'fx@localhost');
    g('config', 'user.name', 'Fixture');
    g('config', 'commit.gpgsign', 'false');
    // The condition under test, set explicitly so the test does not depend on whatever
    // the machine running it happens to have configured.
    g('config', 'core.autocrlf', 'true');
    writeFileSync(join(repo, 'src', 'a.txt'), 'seed\n', 'utf8');
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
    const ws = await workspaces.create({
      projectId: 'SC-PROJ-1',
      workItemId: 'SC-WI-000200',
      attempt: 1,
      producerAgentId: PRODUCER,
      baseCommit: base,
      expectedScope: { allow: ['src/'], forbid: [] },
      sandboxProfileDigest: 'digest',
      substrateClass: 'HARD',
    });

    // CRLF on disk: exactly the shape autocrlf normalises on the way in.
    writeFileSync(join(ws.path, 'src', 'a.txt'), 'a\r\nb\r\n', 'utf8');

    const changeSet = await buildChangeSet({ store, git, clock: deps.clock, ids: deps.ids }, ws);
    const entry = changeSet.entries.find((e) => e.path === 'src/a.txt');
    expect(entry).toBeDefined();

    const fromGit = execFileSync('git', ['hash-object', '--', 'src/a.txt'], {
      cwd: ws.path,
      encoding: 'utf8',
    }).trim();
    expect(entry?.blobId).toBe(fromGit);

    // ...and it is genuinely NOT the hash of the bytes on disk, or this would prove
    // nothing about the filter.
    const raw = createHash('sha1');
    const bytes = readFileSync(join(ws.path, 'src', 'a.txt'));
    raw.update('blob ' + String(bytes.length) + String.fromCharCode(0));
    raw.update(bytes);
    expect(entry?.blobId).not.toBe(raw.digest('hex'));

    // The whole point: the verified change set now integrates.
    const integrated = await integrateVerifiedChangeSet(git, {
      changeSet,
      worktreePath: ws.path,
      branch: ws.branch,
      message: 'apply the verified change set',
    });
    expect(integrated.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
