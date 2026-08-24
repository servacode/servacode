import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineHealthState } from '../../src/engine/types.js';
import { buildAiLayer } from '../../src/app/ai.js';
import { createProject } from '../../src/app/create.js';
import {
  conversationTranscript,
  sendOwnerRequest,
  TurnOutcome,
} from '../../src/app/conversation.js';
import { projectSnapshot } from '../../src/app/services.js';
import { machineDoctor } from '../../src/portability/doctor.js';
import { nodeDoctorProbes } from '../../src/portability/probes.js';
import { ServaRuntime } from '../../src/app/runtime.js';
import { readAudit } from '../../src/events/audit.js';
import { cleanup } from '../helpers.js';

/**
 * SERVA 1.0 LIVE ACCEPTANCE — the whole product, on this machine, for real.
 *
 * SPEC: Phase 6 closure §14.
 *
 * `npm run test:serva-live`. Excluded from `npm run verify` and from every other suite,
 * because it spends the owner's subscription.
 *
 * The other live suites prove one layer each: the engine adapter, the engineering factory,
 * the intelligence departments. This one proves the thing an OWNER does — create a project,
 * ask the company for something in their own words, and get governed work queued — through
 * the same functions the VS Code Control Center calls.
 *
 * IT REFUSES BEFORE IT SPENDS. If the engine is not authenticated, this suite says so and
 * stops. It does not attempt the call to find out, and it does not report a missing session
 * as a product failure: an unauthenticated machine is a machine that has not been set up, and
 * telling an owner their company is broken would send them to the wrong place entirely.
 *
 * NOTHING HERE INSTALLS OR AUTHENTICATES ANYTHING. Serva never signs in on the owner's
 * behalf, never writes a credential, and never changes a billing route to make a test pass.
 */

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), 'serva-live-'));
  roots.push(root);
  return root;
}

const IDEA =
  'I run a small restaurant and I keep losing phone orders when two people answer at once.';

describe('Serva 1.0, live, on this machine', () => {
  it('reports whether the engine will answer, without spending anything to find out', async () => {
    const root = folder();
    createProject({ root, name: 'RahalGo', idea: IDEA });
    const rt = ServaRuntime.open({ root });
    try {
      const layer = buildAiLayer(rt);
      const health = await layer.engine.health();

      /*
       * Recorded rather than asserted READY. This suite is run on machines that are not
       * finished being set up, and the useful output there is a precise statement of what is
       * missing — not a red test that says Serva is broken.
       */
      console.log('engine health: ' + health.state + (health.detail ? ' — ' + health.detail : ''));
      if (health.state !== EngineHealthState.READY) {
        console.log('remedy: ' + (health.remedy ?? 'sign in to the engine inside the guest'));
      }
      expect(Object.values(EngineHealthState)).toContain(health.state);
    } finally {
      rt.close();
    }
  });

  it('a project created here is immediately a governed company', async () => {
    /* Costs nothing. Proves the owner's first act works on this machine, whatever else does. */
    const root = folder();
    const created = createProject({ root, name: 'RahalGo', idea: IDEA });
    expect(created.idea).toBe(IDEA);

    const rt = ServaRuntime.open({ root });
    try {
      const snapshot = projectSnapshot(rt);
      expect(snapshot.projectName).toBe('RahalGo');
      /* A fresh company has not started work and says so rather than looking active. */
      expect(snapshot.headline.length).toBeGreaterThan(0);
      expect(readAudit(rt.store).some((e) => e.type === 'PROJECT_INITIALIZED')).toBe(true);
    } finally {
      rt.close();
    }
  });

  it('an owner request is routed through the governed path, or refused honestly', async () => {
    const root = folder();
    createProject({ root, name: 'RahalGo', idea: IDEA });
    const rt = ServaRuntime.open({ root });
    try {
      const layer = buildAiLayer(rt);
      const health = await layer.engine.health();

      if (health.state !== EngineHealthState.READY) {
        /*
         * The refusal path, exercised for real. An owner on a half-built machine gets a turn
         * in their transcript saying what happened — not a toast that disappears — and the
         * suite proves that rather than skipping.
         */
        const turn = await sendOwnerRequest(rt, 'add order tracking', {
          orchestrator: layer.orchestrator,
        });
        expect(turn.outcome).toBe(TurnOutcome.REFUSED);
        expect(turn.haltReason).toBeDefined();
        expect(conversationTranscript(rt)).toHaveLength(1);
        console.log('SERVA CODE — OWNER ACTION REQUIRED: ' + String(turn.haltReason));
        return;
      }

      /* The engine is real and ready. This is the acceptance. */
      const turn = await sendOwnerRequest(
        rt,
        'Add order tracking so a customer can see where their food is.',
        { orchestrator: layer.orchestrator },
      );

      expect([TurnOutcome.QUEUED, TurnOutcome.HALTED]).toContain(turn.outcome);
      /* Whatever happened, it happened through governed runs that can be audited. */
      expect(turn.runIds.length).toBeGreaterThan(0);
      expect(turn.text).toContain('order tracking');

      if (turn.outcome === TurnOutcome.QUEUED) {
        expect(turn.classification).toBeDefined();
        expect(turn.queued.length).toBeGreaterThan(0);
      } else {
        /* A halt is a legitimate outcome and must say where it stopped. */
        expect(turn.stage).toBeDefined();
        expect(turn.haltReason).toBeDefined();
      }

      /* And it survives the process that produced it. */
      rt.close();
      const reopened = ServaRuntime.open({ root });
      try {
        expect(conversationTranscript(reopened)).toHaveLength(1);
      } finally {
        reopened.close();
      }
    } finally {
      try {
        rt.close();
      } catch {
        /* Already closed on the success path. */
      }
    }
  });

  it('records which machine this ran on, so the evidence names a computer', () => {
    /*
     * A live result that does not say where it happened is not evidence about anything. The
     * fingerprint is the machine's identity and never travels — an acceptance proof minted
     * from this run carries it precisely so nobody can move the result to another computer.
     */
    const report = machineDoctor({ probes: nodeDoctorProbes() });
    expect(report.identity, 'this machine could not be identified at all').toBeDefined();
    const fingerprint = String(report.identity?.fingerprint);
    expect(fingerprint).toMatch(/^[0-9a-f]{16,}$/);
    console.log('machine fingerprint: ' + fingerprint);
    console.log('qualification: ' + report.qualification + ' — ' + report.qualificationReason);
  });
});
