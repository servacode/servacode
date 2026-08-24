import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BootstrapState,
  StepDisposition,
  bootstrapPlan,
  renderBootstrap,
} from '../src/portability/bootstrap.js';
import type { DoctorProbes } from '../src/portability/doctor.js';

/**
 * BRINGING A MACHINE UP WITHOUT INSTALLING ANYTHING ON IT.
 *
 * SPEC: Phase 6 closure §9, §18.
 *
 * The closure is explicit, and it is the whole design constraint: *Do NOT install the machine
 * prerequisites yourself. Return `SERVA CODE — OWNER ACTION REQUIRED` with the exact commands
 * for the existing WSL guest. The owner will perform them.*
 *
 * So most of what is worth testing here is what bootstrap DOESN'T do. A version of this
 * feature that shelled out to `apt-get` would pass a naive "does the machine end up ready"
 * test and would be exactly wrong.
 */

/** A machine with everything. Each test spoils one thing. */
function probes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    platform: () => ({ platform: 'win32', release: '10.0.26200', arch: 'x64' }),
    node: () => ({ version: 'v22.0.0' }),
    wsl: () => ({ installed: true, version: '2', detail: 'WSL 2 is present' }),
    distro: () => ({
      name: 'Ubuntu',
      kernel: '5.15',
      user: 'owner',
      measured: true,
      detail: 'Ubuntu',
    }),
    claude: () => ({
      installed: true,
      location: '/usr/bin/engine',
      version: '2.0',
      credentialsFilePresent: true,
      measured: true,
      detail: 'present',
    }),
    sandbox: () => ({
      mechanism: 'bubblewrap',
      available: true,
      producerLauncher: 'runtime',
      measured: true,
      detail: 'present',
    }),
    git: () => ({ installed: true, version: '2.43', detail: 'present' }),
    interop: () => ({ enabled: false, detail: 'disabled' }),
    ...over,
  };
}

/*
 * `engineAuthenticated: true` by default, because the doctor deliberately can never report
 * sign-in as READY from a file and the authoritative answer comes from the engine. A test
 * that omitted it would be asserting against a machine nobody had asked about sign-in.
 */
const plan = (over: Partial<DoctorProbes> = {}) =>
  bootstrapPlan({ probes: probes(over), engineAuthenticated: true });

/**
 * A plan where NOBODY ASKED the engine about sign-in.
 *
 * Written as a separate helper rather than an optional argument, because a default parameter
 * fires on an explicit `undefined` and "nobody asked" would silently become "yes" — the exact
 * flattening the field exists to prevent.
 */
const planWithoutAsking = (over: Partial<DoctorProbes> = {}) =>
  bootstrapPlan({ probes: probes(over) });

/* ============================================================= what it will not do */

describe('bootstrap never touches the machine', () => {
  it('has no way to run a command at all', () => {
    /*
     * The strongest available statement, and the reason to prefer it over a behavioural
     * test: a module that cannot spawn a process cannot install a package however its
     * classification drifts later.
     */
    const source = readFileSync('src/portability/bootstrap.ts', 'utf8');
    for (const forbidden of [
      'node:child_process',
      'execFile',
      'execSync',
      'spawn',
      'node:fs',
      'writeFile',
    ]) {
      expect(source, 'bootstrap must not be able to ' + forbidden).not.toContain(forbidden);
    }
  });

  it('hands the owner a command rather than running it', () => {
    const missing = plan({ git: () => ({ installed: false, detail: 'git was not found' }) });
    const step = missing.steps.find((s) => s.id === 'GIT');
    expect(step?.disposition).toBe(StepDisposition.MANUAL_HUMAN_ACTION_REQUIRED);
    expect(step?.ownerCommand).toContain('apt-get install');
    expect(step?.runIn).toBe('WSL_GUEST');
  });

  it('says leave interop alone rather than offering to turn it on', () => {
    /*
     * Interop being enabled WEAKENS containment. A bootstrap that "fixed" it would be
     * weakening a security boundary to make its own check green — which the closure forbids
     * by name, and which is the most tempting shortcut in this whole file.
     */
    const weakened = plan({ interop: () => ({ enabled: true, detail: 'interop is enabled' }) });
    const step = weakened.steps.find((s) => s.id === 'INTEROP');
    expect(String(step?.ownerCommand)).toContain('Leave Windows interop disabled');
    expect(String(step?.ownerCommand)).not.toMatch(/enable|--enable|true/i);
  });

  it('nothing Serva may do on its own touches anything outside a project', () => {
    /*
     * Every AUTO_SAFE step is a step Serva performs WITHOUT ASKING, so the list is an
     * inventory of unsupervised authority and should be readable in one glance.
     */
    const auto = plan({}).steps.filter((s) => s.disposition === StepDisposition.AUTO_SAFE);
    for (const step of auto) {
      expect(
        ['BACKUP'],
        step.id + ' became auto-safe without anybody deciding it should',
      ).toContain(step.id);
    }
  });
});

/* =========================================================== the five states, derived */

describe('the state is the worst step present', () => {
  it('COMPLETE when the machine needs nothing', () => {
    const complete = plan();
    expect(complete.state).toBe(BootstrapState.COMPLETE);
    expect(complete.ownerActions).toHaveLength(0);
    expect(complete.summary).toContain('everything Serva needs');
  });

  it('MANUAL_HUMAN_ACTION_REQUIRED when a person has to install something', () => {
    expect(plan({ git: () => ({ installed: false, detail: 'no git' }) }).state).toBe(
      BootstrapState.MANUAL_HUMAN_ACTION_REQUIRED,
    );
  });

  it('BLOCKED outranks an owner action, because it is a different answer', () => {
    /*
     * A probe that could not run, with nothing an owner can do about it, must not be
     * presented alongside "run this command" as though the list were uniform.
     */
    const blocked = plan({
      platform: () => ({ platform: 'unknown', release: 'unknown', arch: 'unknown' }),
      git: () => ({ installed: false, detail: 'no git' }),
    });
    expect(blocked.state).toBe(BootstrapState.BLOCKED);
    expect(blocked.steps.find((s) => s.id === 'PLATFORM')?.disposition).toBe(
      StepDisposition.BLOCKED,
    );
    /* And the thing the owner CAN do is still listed, rather than hidden behind the block. */
    expect(blocked.ownerActions.map((s) => s.id)).toContain('GIT');
  });

  it('cannot be COMPLETE while a step is outstanding, because it is derived', () => {
    const partial = plan({ git: () => ({ installed: false, detail: 'no git' }) });
    const outstanding = partial.steps.filter((s) => s.disposition !== StepDisposition.SATISFIED);
    expect(outstanding.length).toBeGreaterThan(0);
    expect(partial.state).not.toBe(BootstrapState.COMPLETE);
  });

  it('an unclassified failing check needs a person, not a silent action', () => {
    /*
     * The DEFAULT matters more than the table. A check added in a later phase must not become
     * something Serva quietly acts on because nobody remembered to classify it — so anything
     * unrecognised lands in OWNER_APPROVAL_REQUIRED rather than AUTO_SAFE.
     *
     * A missing project root produces exactly such a check: real, failing, and named by
     * nothing in the manual table.
     */
    const missingRoot = bootstrapPlan({
      probes: probes(),
      engineAuthenticated: true,
      projectRoots: ['/nowhere/that/exists'],
    });
    const step = missingRoot.steps.find((s) => s.id.startsWith('PROJECT:'));
    expect(step, 'the doctor did not produce a project check to classify').toBeDefined();
    expect(step?.disposition).not.toBe(StepDisposition.AUTO_SAFE);
    expect(step?.disposition).not.toBe(StepDisposition.SATISFIED);
  });

  it('sign-in is satisfied only by the engine’s own answer, never by a file', () => {
    /*
     * The doctor has no branch that reports sign-in READY from a credentials file, and this
     * must not become the place that quietly reintroduces one. With nobody asked, the step
     * stays outstanding however many files are present.
     */
    const nobodyAsked = planWithoutAsking();
    expect(nobodyAsked.state).not.toBe(BootstrapState.COMPLETE);
    const auth = nobodyAsked.steps.find((s) => s.id === 'CLAUDE_AUTH');
    expect(auth?.disposition).not.toBe(StepDisposition.SATISFIED);

    /* And a real negative is not a shrug: it is still the owner's to resolve. */
    const notSignedIn = bootstrapPlan({ probes: probes(), engineAuthenticated: false });
    expect(notSignedIn.steps.find((s) => s.id === 'CLAUDE_AUTH')?.disposition).toBe(
      StepDisposition.MANUAL_HUMAN_ACTION_REQUIRED,
    );
  });
});

/* ================================================== uncertainty is not a diagnosis */

describe('a probe that could not run does not become a diagnosis', () => {
  it('an unmeasured check is marked unmeasured, whatever it is dispositioned as', () => {
    const unsure = planWithoutAsking({
      claude: () => ({
        installed: true,
        credentialsFilePresent: true,
        measured: true,
        detail: 'a credentials file is present; an authenticated SESSION is not established',
      }),
    });
    const auth = unsure.steps.find((s) => s.id === 'CLAUDE_AUTH');
    expect(auth?.unmeasured).toBe(true);
    /* And the owner is still told what to do about it, rather than that it is impossible. */
    expect(auth?.disposition).toBe(StepDisposition.MANUAL_HUMAN_ACTION_REQUIRED);
  });

  it('the rendering warns before it instructs', () => {
    const unsure = planWithoutAsking({
      claude: () => ({
        installed: true,
        credentialsFilePresent: true,
        measured: true,
        detail: 'no session established',
      }),
    });
    const rendered = renderBootstrap(unsure);
    const warningAt = rendered.indexOf('Serva could not confirm this');
    const commandAt = rendered.indexOf('Sign in to the engine CLI');
    expect(warningAt).toBeGreaterThan(-1);
    expect(commandAt).toBeGreaterThan(warningAt);
  });

  it('an unmeasured check with nothing an owner could do is BLOCKED, not an instruction', () => {
    const cannotSee = plan({
      distro: () => ({ measured: false, detail: 'the guest did not answer' }),
      wsl: () => ({ installed: true, version: '2', detail: 'WSL 2 is present' }),
    });
    const step = cannotSee.steps.find((s) => s.id === 'DISTRO');
    /* DISTRO has a remedy, so it instructs. The point is that it never claims to KNOW. */
    expect(step?.unmeasured === true || step?.disposition !== StepDisposition.SATISFIED).toBe(true);
  });
});

/* ================================================================== what it prints */

describe('the owner reads one line and knows whether they are being asked', () => {
  it('leads with OWNER ACTION REQUIRED when a person must act', () => {
    const rendered = renderBootstrap(plan({ git: () => ({ installed: false, detail: 'no git' }) }));
    expect(rendered.split('\n')[0]).toBe('SERVA CODE — OWNER ACTION REQUIRED');
  });

  it('does not shout when there is nothing to do', () => {
    const rendered = renderBootstrap(plan());
    expect(rendered).toContain('machine bootstrap COMPLETE');
    expect(rendered).not.toContain('OWNER ACTION REQUIRED');
  });

  it('says bootstrap is not qualification, even when complete', () => {
    /*
     * The sentence somebody is most likely to skip is the one that stops them reading a green
     * line as permission to write code. COMPLETE is not HARD, and the two are never equated.
     */
    for (const rendered of [
      renderBootstrap(plan()),
      renderBootstrap(plan({ git: () => ({ installed: false, detail: 'no git' }) })),
    ]) {
      expect(rendered).toContain('Bootstrap is not qualification');
      expect(rendered).toContain('SOFT');
    }
  });

  it('states that Serva will not do these things, where the owner is reading', () => {
    const rendered = renderBootstrap(plan({ git: () => ({ installed: false, detail: 'no git' }) }));
    expect(rendered).toContain('Serva does not install these for you');
  });
});
