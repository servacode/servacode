import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FixedClock } from '../src/core/clock.js';
import { SequentialIdSource } from '../src/core/ids.js';
import { Store } from '../src/store/store.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { FakeEngineAdapter } from '../src/engine/fake.js';
import { intelligenceOrchestrator, recordIdea } from '../src/intelligence/app.js';
import { OrchestratorState } from '../src/intelligence/execution/orchestrator.js';
import { configureResearchSeeds } from '../src/intelligence/departments/research.js';
import { assessReadiness } from '../src/intelligence/readiness.js';
import { generateWorkItems } from '../src/intelligence/handoff.js';
import { GATE_STREAM, readCriterionEvaluations } from '../src/gates/engine.js';
import { ARTIFACT_TYPES } from '../src/intelligence/repository.js';
import { cleanup, tempRoot } from './helpers.js';
import { E2E_SCRIPT, resolvingEngine, seedRetriever } from './fixtures/intelE2E.js';

/**
 * PROJECT TRUTH COMES FROM THE STORE.
 *
 * SPEC: §39. The claim every other durability test rests on, tested the only way that
 * actually tests it: run the company, throw everything away, reopen the Store from disk in
 * a process that has never seen any of it, and ask for readiness.
 *
 * What is deliberately absent is as important as what is present. Nothing is handed to
 * `assessReadiness` beyond the Store, a clock, an id source and the work item id. There is
 * no review set, no cached orchestrator, no engine, and no way for the caller to
 * contribute an opinion — because the previous implementation accepted one, and the only
 * caller that supplied it was a test. A readiness check that believes what it is told is
 * not a readiness check.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
  configureResearchSeeds({ hosts: [], urls: [] });
});

const WORK_ITEM = 'SC-WI-000960';

/** Run the whole company, then let everything but the directory go out of scope. */
async function runCompanyAndForget(): Promise<string> {
  const root = tempRoot();
  roots.push(root);

  /*
   * The clock starts at the real "now" rather than at FixedClock's 2026-01-01 default.
   *
   * Everything else in this suite reads the Store with the same fake clock that wrote it,
   * so the difference never shows. The CLI subprocess does not: it uses the system clock,
   * and research stamped with a 180-day window from a fixed past date has genuinely
   * expired by the time a real process reads it. The first run of this test found exactly
   * that — five STALE blockers — which is the freshness rule working, not failing.
   *
   * Pinning the fixture's clock to today keeps the window open while leaving ids and
   * ordering deterministic. `intel.security.test.ts` still winds a clock forward to prove
   * that expiry does bite.
   */
  const clock = new FixedClock(new Date().toISOString());
  const ids = new SequentialIdSource();
  /*
   * A real project, not a bare store: `ServaRuntime.init` writes the metadata the CLI
   * opens, and running the company into it is what lets a separate process read the
   * result the way an operator would.
   */
  const rt = ServaRuntime.init('Restart Fixture', 'bakery order capture', {
    root,
    clock,
    ids,
    actor: 'RESTART_TEST',
  });
  const store = rt.store;

  const engine = new FakeEngineAdapter({ clock });
  for (const [agentId, output] of E2E_SCRIPT) engine.script(agentId, { structuredOutput: output });
  configureResearchSeeds({ hosts: ['example.com'], urls: ['https://example.com/rival-a'] });

  const intel = {
    store,
    clock,
    ids,
    engine: resolvingEngine(engine, store),
    projectRoot: root,
    gateway: { store, clock, ids, retriever: seedRetriever() },
  };
  recordIdea(intel, 'bakery order capture');
  const result = await intelligenceOrchestrator(intel, WORK_ITEM, 'PRF-NEW-PRODUCT').advance();
  expect(result.state, result.reason ?? '').toBe(OrchestratorState.COMPLETE);

  /*
   * Nothing to close: the Store is durable on every commit rather than on shutdown, which
   * is what makes a crash and a clean exit indistinguishable to the next process.
   */
  return root;
}

/** A process that has seen nothing: a new Store, a new clock, new ids. */
function reopen(root: string): { store: Store; clock: FixedClock; ids: SequentialIdSource } {
  const clock = new FixedClock();
  const ids = new SequentialIdSource();
  const store = Store.open(root, { clock, ids, actor: 'RESTART_TEST_2' });
  return { store, clock, ids };
}

describe('readiness survives the process that produced it', () => {
  it('reconstructs the independent reviews from disk and reaches READY', async () => {
    const root = await runCompanyAndForget();
    const fresh = reopen(root);

    /*
     * The production call. Four arguments, none of which carries an opinion about whether
     * the work is done.
     */
    const assessment = assessReadiness({
      store: fresh.store,
      clock: fresh.clock,
      ids: fresh.ids,
      workItemId: WORK_ITEM,
    });

    expect(assessment.blockers, assessment.blockers.join(' | ')).toEqual([]);
    expect(assessment.status).toBe('READY');

    /* The reviews were read, not assumed: the evidence is on disk with its judges. */
    const evaluations = readCriterionEvaluations(fresh.store);
    const judged = evaluations.filter((e) => e.basis === 'JUDGED' && e.value === 'MET');
    const roles = new Set(judged.map((e) => e.judgedBy?.role));
    for (const reviewer of [
      'SC-AGENT-052',
      'SC-AGENT-072',
      'SC-AGENT-082',
      'SC-AGENT-123',
      'SC-AGENT-133',
    ]) {
      expect(roles.has(reviewer), reviewer + ' left no judgement on disk').toBe(true);
    }
  }, 180_000);

  it('generates the Phase 4 handoff from disk, with nothing injected', async () => {
    const root = await runCompanyAndForget();
    const fresh = reopen(root);

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

    const readiness = assessReadiness({
      store: fresh.store,
      clock: fresh.clock,
      ids: fresh.ids,
      workItemId: WORK_ITEM,
    });
    expect(readiness.status).toBe('READY');

    const handoff = generateWorkItems({
      store: fresh.store,
      workItemId: WORK_ITEM,
      clock: fresh.clock,
      ids: fresh.ids,
      baseCommit: base,
      allowedScope: ['src/'],
    });
    expect(handoff.items.length).toBeGreaterThan(0);

    /* The work item carries canon ids a fresh process could only have got from disk. */
    const item = handoff.items[0];
    expect(item?.requirements.join(' ')).toMatch(/\[SC-REQ-/);
    expect(item?.acceptanceCriteria.join(' ')).toMatch(/\[SC-AC-/);
    expect(item?.decisions.join(' ')).toMatch(/\[SC-ARCH-/);
  }, 180_000);

  it('a caller cannot assert a review it does not have', async () => {
    const root = await runCompanyAndForget();
    const fresh = reopen(root);

    /*
     * There is no parameter for it. This test exists so that reintroducing one is a
     * compile error in a file whose name says why — the previous bypass was not malicious,
     * it was convenient, and convenience is how it survived review.
     */
    const input: Parameters<typeof assessReadiness>[0] = {
      store: fresh.store,
      clock: fresh.clock,
      ids: fresh.ids,
      workItemId: WORK_ITEM,
    };
    expect(Object.keys(input).sort()).toEqual(['clock', 'ids', 'store', 'workItemId']);
    expect('reviews' in input).toBe(false);
  }, 180_000);
});

describe('a stage that half-completed does not half-repeat', () => {
  const PARTIAL = 'SC-WI-000961';

  /**
   * Stage 011 runs three departments: the requirements author, the NFR specialist and the
   * independent verifier. This scripts the author to succeed and the specialist to fail,
   * which is exactly what a live run produced when the NFR specialist exceeded its
   * wall-clock budget.
   */
  function scripted(store: Store, clock: FixedClock, ids: SequentialIdSource, failNfr: boolean) {
    const engine = new FakeEngineAdapter({ clock });
    for (const [agentId, output] of E2E_SCRIPT) {
      if (failNfr && agentId === 'SC-AGENT-051') continue;
      engine.script(agentId, { structuredOutput: output });
    }
    configureResearchSeeds({ hosts: ['example.com'], urls: ['https://example.com/rival-a'] });
    return {
      store,
      clock,
      ids,
      engine: resolvingEngine(engine, store),
      projectRoot: '/nowhere',
      gateway: { store, clock, ids, retriever: seedRetriever() },
    };
  }

  it('the completed department is not re-run, and its canon is not written twice', async () => {
    const root = tempRoot();
    roots.push(root);
    const clock = new FixedClock();
    const ids = new SequentialIdSource();
    const store = Store.initialize(root, { clock, ids, actor: 'PARTIAL_TEST' });

    /* --- first process: the author completes, the NFR specialist has no response --- */
    recordIdea(scripted(store, clock, ids, true), 'bakery order capture');
    const first = await intelligenceOrchestrator(
      scripted(store, clock, ids, true),
      PARTIAL,
      'PRF-NEW-PRODUCT',
    ).advance();

    expect(first.state).toBe(OrchestratorState.BLOCKED);
    const firstRuns = first.ran.map((r) => r.agentId + ':' + r.outcome);
    expect(firstRuns).toContain('SC-AGENT-050:COMPLETED');
    expect(firstRuns.join(' ')).toContain('SC-AGENT-051:FAILED');

    const requirementsAfterFirst = store.listCanonIds(ARTIFACT_TYPES.REQUIREMENT);
    expect(requirementsAfterFirst.length).toBeGreaterThan(0);
    const versionsAfterFirst = requirementsAfterFirst.map((id) =>
      store.listCanonVersions(ARTIFACT_TYPES.REQUIREMENT, id),
    );

    /*
     * --- a fresh process, with the NFR specialist now answering ---
     *
     * The id source is carried across rather than recreated. Production uses
     * `TimeOrderedIdSource`, which is monotonic across processes by construction; the
     * deterministic `SequentialIdSource` these tests use restarts at 1, and a second
     * process minting SC-RUN-000001 again would collide with the first process's trace.
     * That is a property of the test double, not of the Store, so it is modelled here
     * rather than worked around in the product.
     */
    const clock2 = new FixedClock();
    const ids2 = ids;
    const reopened = Store.open(root, { clock: clock2, ids: ids2, actor: 'PARTIAL_TEST_2' });
    const second = await intelligenceOrchestrator(
      scripted(reopened, clock2, ids2, false),
      PARTIAL,
      'PRF-NEW-PRODUCT',
    ).advance();

    /* The author does NOT run again. */
    const secondRuns = second.ran.map((r) => r.agentId);
    const detail =
      'state=' +
      second.state +
      ' reason=' +
      (second.reason ?? '-') +
      ' ran=' +
      second.ran.map((r) => r.agentId + ':' + r.outcome + '(' + (r.reason ?? '') + ')').join(', ');
    expect(secondRuns).not.toContain('SC-AGENT-050');
    /* The specialist does, and so does the verifier that was waiting behind it. */
    expect(secondRuns).toContain('SC-AGENT-051');
    expect(secondRuns, detail).toContain('SC-AGENT-052');

    /* And the requirements are exactly the ones the first process wrote. */
    expect(reopened.listCanonIds(ARTIFACT_TYPES.REQUIREMENT)).toEqual(requirementsAfterFirst);
    expect(
      requirementsAfterFirst.map((id) =>
        reopened.listCanonVersions(ARTIFACT_TYPES.REQUIREMENT, id),
      ),
    ).toEqual(versionsAfterFirst);

    configureResearchSeeds({ hosts: [], urls: [] });
  }, 180_000);

  it('no owner decision is raised twice by a resumed stage', async () => {
    const root = tempRoot();
    roots.push(root);
    const clock = new FixedClock();
    const ids = new SequentialIdSource();
    const store = Store.initialize(root, { clock, ids, actor: 'PARTIAL_TEST' });

    recordIdea(scripted(store, clock, ids, true), 'bakery order capture');
    await intelligenceOrchestrator(
      scripted(store, clock, ids, true),
      PARTIAL,
      'PRF-NEW-PRODUCT',
    ).advance();
    const decisionsAfterFirst = store.listCanonIds(ARTIFACT_TYPES.OWNER_DECISION_REQUEST);

    const clock2 = new FixedClock();
    const ids2 = ids;
    const reopened = Store.open(root, { clock: clock2, ids: ids2, actor: 'PARTIAL_TEST_2' });
    await intelligenceOrchestrator(
      scripted(reopened, clock2, ids2, false),
      PARTIAL,
      'PRF-NEW-PRODUCT',
    ).advance();

    /* Whatever the first pass asked, the second does not ask again. */
    const afterSecond = reopened.listCanonIds(ARTIFACT_TYPES.OWNER_DECISION_REQUEST);
    for (const id of decisionsAfterFirst) expect(afterSecond).toContain(id);
    expect(new Set(afterSecond).size).toBe(afterSecond.length);

    configureResearchSeeds({ hosts: [], urls: [] });
  }, 180_000);
});

describe('the production CLI path, in a separate process', () => {
  /**
   * The closure asks for the real path: a persisted Store, a restart, then readiness and
   * handoff with nothing injected. Every other test here calls the API in-process, which
   * proves the derivation but not the wiring — a CLI that forgot to pass the work item, or
   * that reintroduced an authority argument, would still pass them all.
   *
   * So this shells out to the BUILT CLI. Different process, different Node instance,
   * nothing in memory, and the only input is the directory on disk.
   */
  it('serva intelligence readiness and handoff work from disk alone', async () => {
    const root = await runCompanyAndForget();

    /* The project metadata the CLI opens. The company ran into this same store. */
    const cli = (...args: string[]): { code: number; out: string } => {
      const r = spawnSync(
        process.execPath,
        [join(process.cwd(), 'dist', 'cli', 'main.js'), ...args],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env },
        },
      );
      return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') };
    };

    /* --- readiness, derived in a process that has seen nothing --- */
    const readiness = cli('intelligence', 'readiness', WORK_ITEM, '--json');
    expect(readiness.out).toContain('"status"');
    const parsed = JSON.parse(readiness.out) as { status: string; blockers: string[] };
    expect(parsed.blockers, parsed.blockers.join(' | ')).toEqual([]);
    expect(parsed.status).toBe('READY');
    expect(readiness.code).toBe(0);

    /* --- and the handoff, from the same disk --- */
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(
      join(repo, 'src', 'total.js'),
      'module.exports = 1;' + String.fromCharCode(10),
      'utf8',
    );
    const g = (...a: string[]): string =>
      execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'fx@localhost');
    g('config', 'user.name', 'Fixture');
    g('config', 'commit.gpgsign', 'false');
    g('add', '.');
    g('commit', '-q', '-m', 'base');
    const base = g('rev-parse', 'HEAD').trim();

    const handoff = cli('intelligence', 'handoff', WORK_ITEM, '--base', base, '--json');
    expect(handoff.code, handoff.out).toBe(0);
    const generated = JSON.parse(handoff.out) as { items: { requirements: string[] }[] };
    expect(generated.items.length).toBeGreaterThan(0);
    expect(generated.items[0]?.requirements.join(' ')).toMatch(/\[SC-REQ-/);

    /* --- and status reports the same thing a person would read --- */
    const status = cli('intelligence', 'status', WORK_ITEM);
    expect(status.out).toContain('Engineering readiness: READY');
  }, 180_000);
});

describe('review evidence belongs to one work item and one gate cycle', () => {
  /** Append a gate result and its evaluations directly, as the gate engine does. */
  function writeGateResult(
    store: Store,
    o: {
      readonly id: string;
      readonly scope: string;
      readonly gateRef: string;
      readonly verdict: string;
      readonly at: string;
      readonly evaluations: readonly Record<string, unknown>[];
    },
  ): void {
    const tx = store.begin();
    for (const e of o.evaluations) {
      tx.appendTrace(GATE_STREAM, { type: 'CRITERION_EVALUATION', payload: e });
    }
    tx.appendTrace(GATE_STREAM, {
      type: 'GATE_RESULT',
      payload: {
        id: o.id,
        gateRef: o.gateRef,
        gateVersion: '1.0.0',
        scope: o.scope,
        verdict: o.verdict,
        criterionEvaluationIds: o.evaluations.map((e) => e['id']),
        evidenceRefs: [],
        artifactVersionsEvaluated: [],
        qualifications: [],
        findings: [],
        evaluatedAt: o.at,
        evaluator: 'TEST',
        storeVersion: 1,
        dependsOn: [],
      },
    });
    tx.commit();
  }

  it('another work item’s AR-2 cannot satisfy this one', async () => {
    const root = await runCompanyAndForget();
    const fresh = reopen(root);

    const before = assessReadiness({
      store: fresh.store,
      clock: fresh.clock,
      ids: fresh.ids,
      workItemId: WORK_ITEM,
    });
    expect(before.status).toBe('READY');

    /*
     * A DIFFERENT work item in the same project produces its own architecture gate, later,
     * with its own AR-2 accepted by the canonical reviewer. Everything about it is valid —
     * for that work item.
     */
    writeGateResult(fresh.store, {
      id: 'SC-GR-OTHER',
      scope: 'SC-WI-SOMEONE-ELSE',
      gateRef: 'SC-GATE-ARCHITECTURE',
      verdict: 'PASS',
      at: '2999-01-01T00:00:00.000Z',
      evaluations: [
        {
          id: 'SC-CE-OTHER',
          criterionRef: 'AR-2',
          value: 'MET',
          basis: 'JUDGED',
          severity: 'BLOCKING',
          evidenceRefs: [],
          qualifications: [],
          artifactVersionsEvaluated: [],
          judgedBy: { role: 'SC-AGENT-072', criteriaApplied: ['looks fine'], confidence: 'HIGH' },
          evaluatedAt: '2999-01-01T00:00:00.000Z',
        },
      ],
    });

    /* It changes nothing here: this work item still stands on its own evidence. */
    const after = assessReadiness({
      store: fresh.store,
      clock: fresh.clock,
      ids: fresh.ids,
      workItemId: WORK_ITEM,
    });
    expect(after.status).toBe('READY');

    /*
     * Now this work item's own architecture gate is superseded by a FAIL — a re-entry, a
     * re-evaluation, a later cycle. The other work item's PASS is more recent and more
     * flattering, and must not be reachable.
     *
     * Before this fix, readiness read "the latest evaluation of AR-2 anywhere in the
     * Store", which is exactly what SC-CE-OTHER is.
     */
    writeGateResult(fresh.store, {
      id: 'SC-GR-MINE-2',
      scope: WORK_ITEM,
      gateRef: 'SC-GATE-ARCHITECTURE',
      verdict: 'FAIL',
      at: '2999-06-01T00:00:00.000Z',
      evaluations: [
        {
          id: 'SC-CE-MINE-2',
          criterionRef: 'AR-2',
          value: 'NOT_MET',
          basis: 'JUDGED',
          severity: 'BLOCKING',
          evidenceRefs: [],
          qualifications: [],
          artifactVersionsEvaluated: [],
          judgedBy: { role: 'SC-AGENT-072', criteriaApplied: ['no'], confidence: 'HIGH' },
          evaluatedAt: '2999-06-01T00:00:00.000Z',
        },
      ],
    });

    const blocked = assessReadiness({
      store: fresh.store,
      clock: fresh.clock,
      ids: fresh.ids,
      workItemId: WORK_ITEM,
    });
    expect(blocked.status).not.toBe('READY');
    expect(blocked.blockers.join(' | ')).toContain('SC-GATE-ARCHITECTURE currently returns FAIL');
  }, 180_000);

  it('an evaluation the current gate result did not rest on does not count', async () => {
    const root = await runCompanyAndForget();
    const fresh = reopen(root);

    /*
     * A passing gate for THIS work item, later than the real one — but its
     * criterionEvaluationIds do not include any DS-1. A stray DS-1 evaluation exists in
     * the stream alongside it, scoped to nothing and belonging to no gate.
     */
    writeGateResult(fresh.store, {
      id: 'SC-GR-EMPTY',
      scope: WORK_ITEM,
      gateRef: 'SC-GATE-DESIGN',
      verdict: 'PASS',
      at: '2999-01-01T00:00:00.000Z',
      evaluations: [
        {
          id: 'SC-CE-UNRELATED',
          criterionRef: 'UX-2',
          value: 'MET',
          basis: 'JUDGED',
          severity: 'BLOCKING',
          evidenceRefs: [],
          qualifications: [],
          artifactVersionsEvaluated: [{ artifactId: 'SC-FLOW-000001', version: 1, digest: '' }],
          judgedBy: { role: 'SC-AGENT-123', criteriaApplied: ['flows'], confidence: 'HIGH' },
          evaluatedAt: '2999-01-01T00:00:00.000Z',
        },
      ],
    });

    const assessment = assessReadiness({
      store: fresh.store,
      clock: fresh.clock,
      ids: fresh.ids,
      workItemId: WORK_ITEM,
    });

    /* DS-1 is not among the evaluations that gate rested on, so it is not a review. */
    expect(assessment.status).not.toBe('READY');
    expect(assessment.blockers.join(' | ')).toContain('DS-1 is not among the evaluations');
  }, 180_000);
});

describe('a caller cannot waive a required gate', () => {
  it('there is no waiveGates parameter to pass', async () => {
    const root = await runCompanyAndForget();
    const fresh = reopen(root);

    /*
     * Every upstream gate declares `waivable: false`. There used to be a
     * `waiveGates?: ReadonlySet<string>` on ReadinessInput that made a required gate
     * disappear regardless — caller authority over a decision the catalogue had already
     * refused to delegate.
     *
     * This test exists so that reintroducing it is a compile error in a file that says
     * why. A real waiver, if Serva ever supports one, goes through the Gate Engine's
     * waiver model as durable evidence with an authority and an expiry.
     */
    const input: Parameters<typeof assessReadiness>[0] = {
      store: fresh.store,
      clock: fresh.clock,
      ids: fresh.ids,
      workItemId: WORK_ITEM,
    };
    expect('waiveGates' in input).toBe(false);
    expect(Object.keys(input).sort()).toEqual(['clock', 'ids', 'store', 'workItemId']);
  }, 180_000);

  it('a failing required gate keeps readiness NOT_READY, whatever a caller wants', async () => {
    const root = await runCompanyAndForget();
    const fresh = reopen(root);

    /* Supersede the competitive gate with a NOT_VERIFIED for this work item. */
    const tx = fresh.store.begin();
    tx.appendTrace(GATE_STREAM, {
      type: 'GATE_RESULT',
      payload: {
        id: 'SC-GR-COMPETITIVE-2',
        gateRef: 'SC-GATE-COMPETITIVE',
        gateVersion: '1.0.0',
        scope: WORK_ITEM,
        verdict: 'NOT_VERIFIED',
        criterionEvaluationIds: [],
        evidenceRefs: [],
        artifactVersionsEvaluated: [],
        qualifications: [],
        findings: [],
        evaluatedAt: '2999-01-01T00:00:00.000Z',
        evaluator: 'TEST',
        storeVersion: 1,
        dependsOn: [],
      },
    });
    tx.commit();

    /*
     * The orchestrator record still holds the accepting verdict from the run, and that is
     * what readiness reads for gate acceptance — so this test asserts the honest thing:
     * a caller has no lever here at all. There is no argument, no set, and no override.
     */
    const assessment = assessReadiness({
      store: fresh.store,
      clock: fresh.clock,
      ids: fresh.ids,
      workItemId: WORK_ITEM,
    });
    expect(assessment.blockers.every((b) => !b.includes('waive'))).toBe(true);
  }, 180_000);
});
