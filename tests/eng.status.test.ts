import { afterEach, describe, expect, it } from 'vitest';
import { EnforcementClass } from '../src/vocab/index.js';
import { FakeExecutionSubstrate } from '../src/substrate/fake.js';
import { HostExecutionSubstrate } from '../src/substrate/host.js';
import {
  EngineeringGovernance,
  PHASE4_CANDIDATE_PRODUCERS,
  PHASE4_VERIFIERS,
  buildEngineeringLayer,
  engineeringReconcile,
  engineeringStatus,
} from '../src/app/engineering.js';
import { ContractRegistry } from '../src/agents/registry.js';
import { producerContractRefusal } from '../src/engineering/capability.js';
import { cleanup, freshRuntime } from './helpers.js';
import type { ServaRuntime } from '../src/app/runtime.js';
import type { CommandRunner } from '../src/substrate/host.js';

/**
 * `serva engineering status | qualify | doctor | reconcile`.
 *
 * What the owner must be able to read off the screen without interpreting it: whether
 * anything is allowed to write code on this machine, and if not, exactly what is
 * missing. A status that says ACTIVE while nothing can be dispatched, or that lists a
 * tidy set of workspaces under an unqualified substrate, is worse than no status.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

function runtime(): ServaRuntime {
  const { rt, root } = freshRuntime();
  roots.push(root);
  return rt;
}

function layerWith(rt: ServaRuntime, enforcement: 'HARD' | 'SOFT' | 'NONE') {
  return buildEngineeringLayer(rt, {
    substrate: new FakeExecutionSubstrate({ clock: rt.clock, enforcement }),
  });
}

describe('the status leads with the authority state', () => {
  it('a qualified substrate reports ACTIVE with the candidate Producers enabled', async () => {
    const rt = runtime();
    const { view } = await engineeringStatus(layerWith(rt, 'HARD'));
    rt.close();

    expect(view.governance).toBe(EngineeringGovernance.ACTIVE);
    expect(view.executionSubstrate).toBe(EnforcementClass.HARD);
    expect(view.blockedBy).toBeUndefined();
    /*
     * This is the assertion that caught a real defect: the check here used to be Phase
     * 3's `capabilityLevelFor`, which answers what READ-ONLY level a contract can be
     * granted and treats a declared `fs.write` as disqualifying. Every Producer
     * declares `fs.write`, so a fully qualified substrate reported ACTIVE with an
     * empty enabled set — permanently, and with a reason that sounded plausible.
     */
    expect(view.enabledProducers).toEqual(['SC-AGENT-150', 'SC-AGENT-160', 'SC-AGENT-180']);
    // The Integration Engineer is a candidate and is still refused, because its
    // contract declares network scope and Phase 4 grants a Producer none.
    expect(view.disabledProducers).toEqual([
      { id: 'SC-AGENT-190', reason: expect.stringMatching(/grants no network to a Producer/) },
    ]);
  });

  it('a SOFT substrate is DEGRADED and enables nobody', async () => {
    const rt = runtime();
    const { view } = await engineeringStatus(layerWith(rt, 'SOFT'));
    rt.close();

    expect(view.governance).toBe(EngineeringGovernance.DEGRADED);
    expect(view.executionSubstrate).toBe(EnforcementClass.SOFT);
    expect(view.blockedBy).toMatch(/requires HARD/);
    expect(view.enabledProducers).toEqual([]);
    // Every disabled Producer names the substrate, not the agent: the machine is what
    // is wrong, and a reason that blamed the contract would send the owner nowhere.
    for (const d of view.disabledProducers) expect(d.reason).toMatch(/requires HARD/);
  });

  it('an unqualified substrate is BLOCKED, never ACTIVE-with-caveats', async () => {
    const rt = runtime();
    const { view } = await engineeringStatus(layerWith(rt, 'NONE'));
    rt.close();

    expect(view.governance).toBe(EngineeringGovernance.BLOCKED);
    expect(view.executionSubstrate).toBe(EnforcementClass.NONE);
    expect(view.enabledProducers).toEqual([]);
  });

  it('the reported recipe set is the registered one', async () => {
    const rt = runtime();
    const { view } = await engineeringStatus(layerWith(rt, 'HARD'));
    rt.close();
    expect(view.recipes).toContain('SC-RECIPE-UNIT-TEST');
    expect(view.recipes.every((r) => r.startsWith('SC-RECIPE-'))).toBe(true);
  });
});

describe('doctor reports what is missing without changing the machine', () => {
  /** Records every command the probe issued, so the test can prove none of them wrote. */
  function recordingRunner(seen: string[][]): CommandRunner {
    return async (bin, args) => {
      seen.push([bin, ...args]);
      return { code: 1, stdout: '', stderr: 'not found', spawnFailed: true };
    };
  }

  it('a native Windows host is BLOCKED with named prerequisites', async () => {
    const rt = runtime();
    const seen: string[][] = [];
    const layer = buildEngineeringLayer(rt, {
      substrate: new HostExecutionSubstrate({
        clock: rt.clock,
        engineVersion: '2.1.216',
        platform: 'win32',
        run: recordingRunner(seen),
      }),
    });
    const { view, qualification } = await engineeringStatus(layer);
    rt.close();

    expect(view.governance).toBe(EngineeringGovernance.BLOCKED);
    expect(view.hostPlatform).toBe('win32');
    expect(view.missingPrerequisites.length).toBeGreaterThan(0);
    // Each one names a remedy the owner can act on, rather than a bare "unsupported".
    for (const p of view.missingPrerequisites) {
      expect(p.remedy.length).toBeGreaterThan(0);
      expect(p.what.length).toBeGreaterThan(0);
    }
    // Nothing was proved, so nothing is recorded as passing.
    expect(qualification.tests.every((t) => t.outcome !== 'PASSED')).toBe(true);
  });

  it('the probe never installs, enables or reboots anything', async () => {
    const rt = runtime();
    const seen: string[][] = [];
    const layer = buildEngineeringLayer(rt, {
      substrate: new HostExecutionSubstrate({
        clock: rt.clock,
        engineVersion: '2.1.216',
        platform: 'win32',
        run: recordingRunner(seen),
      }),
    });
    await engineeringStatus(layer);
    rt.close();

    /*
     * Changing the machine a sandbox runs on is the owner's decision, not a side
     * effect of asking for status (Phase 4 §5). The probe may only look.
     */
    const forbidden =
      /\b(install|enable|dism|shutdown|reboot|apt|apt-get|dnf|yum|choco|winget|sudo|setup)\b/i;
    for (const cmd of seen) {
      expect(cmd.join(' ')).not.toMatch(forbidden);
    }
  });

  it('a doctor run on an unqualified host still exits with a non-zero-shaped state', async () => {
    const rt = runtime();
    const { view } = await engineeringStatus(layerWith(rt, 'NONE'));
    rt.close();
    // The CLI maps ACTIVE to 0 and everything else to 1; the view is what it reads.
    expect(view.governance).not.toBe(EngineeringGovernance.ACTIVE);
  });
});

describe('the contract half of the Producer gate', () => {
  const registry = ContractRegistry.shared();

  it('a candidate Producer with no network scope passes it', () => {
    for (const id of ['SC-AGENT-150', 'SC-AGENT-160', 'SC-AGENT-180']) {
      expect(producerContractRefusal(registry.get(id), PHASE4_CANDIDATE_PRODUCERS)).toBeUndefined();
    }
  });

  it('a candidate that declares network scope is refused, candidate or not', () => {
    // Membership in the candidate set is necessary and nowhere near sufficient.
    expect(
      producerContractRefusal(registry.get('SC-AGENT-190'), PHASE4_CANDIDATE_PRODUCERS),
    ).toMatch(/grants no network to a Producer/);
  });

  it('no verifier passes it', () => {
    for (const id of PHASE4_VERIFIERS) {
      const all = new Set([...PHASE4_CANDIDATE_PRODUCERS, ...PHASE4_VERIFIERS]);
      expect(producerContractRefusal(registry.get(id), all)).toMatch(
        /write authority belongs to a PRODUCER/,
      );
    }
  });

  it('a Producer outside the enabled set is refused by name', () => {
    expect(producerContractRefusal(registry.get('SC-AGENT-150'), new Set())).toMatch(
      /not in the enabled Producer set/,
    );
  });
});

describe('reconcile reports divergence and repairs nothing', () => {
  it('a project with no workspaces reports nothing to reconcile', async () => {
    const rt = runtime();
    const layer = layerWith(rt, 'HARD');
    const report = await engineeringReconcile(rt, layer);
    rt.close();

    expect(report.workspacesChecked).toBe(0);
    expect(report.divergences).toEqual([]);
  });
});
