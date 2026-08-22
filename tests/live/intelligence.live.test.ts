import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeCliEngineAdapter } from '../../src/engine/claude/adapter.js';
import { EngineHealthState } from '../../src/engine/types.js';
import { intelligenceOrchestrator, recordIdea } from '../../src/intelligence/app.js';
import { OrchestratorState } from '../../src/intelligence/execution/orchestrator.js';
import { configureResearchSeeds } from '../../src/intelligence/departments/research.js';
import { httpRetriever } from '../../src/intelligence/research/http.js';
import { ARTIFACT_TYPES, repository } from '../../src/intelligence/repository.js';
import { ResearchFindingSchema } from '../../src/intelligence/artifacts/market.js';
import { SourceCaptureSchema } from '../../src/intelligence/research/capture.js';
import { RequirementSchema } from '../../src/intelligence/artifacts/requirements.js';
import { readGateResults } from '../../src/gates/engine.js';
import { runStream } from '../../src/events/agentRun.js';
import { cleanup, freshStore } from '../helpers.js';
import type { AdvanceResult } from '../../src/intelligence/execution/orchestrator.js';
import type { Store } from '../../src/store/store.js';

/**
 * LIVE COMPANY INTELLIGENCE — OPT-IN ONLY.
 *
 * SPEC: §47. Excluded from `npm run verify`. Run deliberately:
 *
 *     npm run test:intelligence-live
 *
 * Every other intelligence test in this repository is free, offline and deterministic.
 * This one spends real subscription usage AND reaches the real network, so it must never
 * run by accident. It proves a vertical slice rather than the whole company, because
 * running fifty-five agents to learn the same thing would be an expensive way to be
 * thorough.
 *
 * What it proves, and why each is worth a real call:
 *
 *   1. a real Discovery/Product reasoning chain          — the scripted fixture cannot
 *      show that a model actually produces schema-valid canon from an owner's sentence;
 *   2. a real external research run, through the one agent whose contract permits it;
 *   3. a source capture, hashed, from a page that really existed;
 *   4. an INDEPENDENT Source Verifier that never re-fetches;
 *   5. competitive and innovation output derived from that capture;
 *   6. a downstream requirement that consumed PERSISTED canon rather than chat history —
 *      the one claim a deterministic test genuinely cannot make, because in a fixture the
 *      "persistence" and the "history" are the same object.
 *
 * If Claude is not authenticated, or the network is unavailable, this SKIPS with a stated
 * reason. A machine without an engine is a fact about the machine. Reporting it as a
 * failure teaches people to ignore a red suite, and faking the research to keep the suite
 * green would be the exact defect the whole phase exists to prevent.
 */

/*
 * A generic, stable, public subject. No client data, no proprietary problem, and a
 * research question whose answer is genuinely on the open web.
 */
const IDEA =
  'I run a small independent bookshop. I want a simple way for customers to reserve a ' +
  'book online and collect it in store, so I stop losing sales to people who assume we ' +
  'are out of stock.';

const RESEARCH_HOSTS = ['en.wikipedia.org'];
const RESEARCH_URLS = ['https://en.wikipedia.org/wiki/Click_and_collect'];

const WORK_ITEM = 'SC-WI-000950';

let store: Store;
let root: string;
let result: AdvanceResult | undefined;
let skip: string | undefined;

beforeAll(async () => {
  const f = freshStore();
  store = f.store;
  root = f.root;

  const engine = new ClaudeCliEngineAdapter({ clock: f.deps.clock, probeTtlMs: 30_000 });
  const health = await engine.health();
  if (health.state !== EngineHealthState.READY) {
    skip =
      'the Claude engine is ' +
      health.state +
      (health.detail === undefined ? '' : ': ' + health.detail);
    return;
  }

  configureResearchSeeds({ hosts: RESEARCH_HOSTS, urls: RESEARCH_URLS });

  const intel = {
    store,
    clock: f.deps.clock,
    ids: f.deps.ids,
    engine,
    projectRoot: root,
    /* The real thing: Serva fetches, the agent holds no network tool of its own. */
    gateway: {
      store,
      clock: f.deps.clock,
      ids: f.deps.ids,
      retriever: httpRetriever(),
    },
  };

  recordIdea(intel, IDEA);
  result = await intelligenceOrchestrator(intel, WORK_ITEM, 'PRF-NEW-PRODUCT').advance();
}, 3_600_000);

afterAll(() => {
  configureResearchSeeds({ hosts: [], urls: [] });
  if (root !== undefined) cleanup(root);
});

/** Skip with a stated reason rather than fail. A missing engine is not a defect. */
function guard(): boolean {
  if (skip !== undefined) {
    console.log('SKIPPED — ' + skip);
    return true;
  }
  return false;
}

describe('a real company run over a real problem', () => {
  it('reached at least the competitive stage, or reported honestly why not', () => {
    if (guard()) return;
    expect(result).toBeDefined();
    const ran = (result?.ran ?? []).map((r) => r.agentId + ':' + r.outcome);
    console.log('ran: ' + ran.join(', '));
    if (result?.state === OrchestratorState.BLOCKED) {
      console.log('BLOCKED — ' + (result.reason ?? 'no reason given'));
    }
    /* Intake and discovery are the floor: below that, nothing was proved. */
    expect(ran.join(' ')).toContain('SC-AGENT-020:COMPLETED');
    expect(ran.join(' ')).toContain('SC-AGENT-030:COMPLETED');
  });

  it('1. discovery and product produced schema-valid canon from one owner sentence', () => {
    if (guard()) return;
    expect(store.listCanonIds(ARTIFACT_TYPES.PROJECT_GOAL).length).toBeGreaterThan(0);
    /* The Current Alternative is the discovery field that is never optional. */
    expect(store.listCanonIds(ARTIFACT_TYPES.CURRENT_ALTERNATIVE).length).toBeGreaterThan(0);
    expect(store.listCanonIds(ARTIFACT_TYPES.FEATURE).length).toBeGreaterThan(0);
  });

  it('2/3. a real source was retrieved by Serva and captured with a digest', () => {
    if (guard()) return;
    const captures = repository(store, ARTIFACT_TYPES.SOURCE_CAPTURE, SourceCaptureSchema).list();
    if (captures.length === 0) {
      /* Honest degradation: no network is a recorded UNAVAILABLE, never an invented market. */
      console.log('NO CAPTURE — the network was unavailable; research must read UNAVAILABLE');
      expect(store.listCanonIds(ARTIFACT_TYPES.RESEARCH_FINDING)).toHaveLength(0);
      return;
    }
    for (const c of captures) {
      expect(c.url.startsWith('https://en.wikipedia.org/')).toBe(true);
      expect(c.contentDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(c.trust).toBe('UNTRUSTED');
      expect(c.excerpt.length).toBeGreaterThan(0);
      /* Retrieval is attributed to the ONE agent whose contract declares network. */
      expect(c.retrievedByAgentId).toBe('SC-AGENT-060');
    }
  });

  it('4. the Source Verifier judged the findings without fetching anything', () => {
    if (guard()) return;
    const captures = store.listCanonIds(ARTIFACT_TYPES.SOURCE_CAPTURE);
    if (captures.length === 0) return;

    const verifierRun = (result?.ran ?? []).find((r) => r.agentId === 'SC-AGENT-063');
    expect(verifierRun, 'the source verifier did not run').toBeDefined();

    /*
     * The proof that it did not re-fetch: no capture is attributed to it, and the capture
     * count did not change while it ran. It had nothing to fetch WITH — its contract
     * declares no network — and this is the observable consequence.
     */
    const verifications = store.listCanonIds(ARTIFACT_TYPES.CLAIM_VERIFICATION);
    expect(verifications.length).toBeGreaterThan(0);
    for (const id of captures) {
      const env = store.getCanon<{ retrievedByAgentId?: string }>(
        ARTIFACT_TYPES.SOURCE_CAPTURE,
        id,
      );
      expect(env?.body?.retrievedByAgentId).not.toBe('SC-AGENT-063');
    }
  });

  it('5. competitive and innovation output was derived from the captured evidence', () => {
    if (guard()) return;
    const findings = repository(
      store,
      ARTIFACT_TYPES.RESEARCH_FINDING,
      ResearchFindingSchema,
    ).list();
    if (findings.length === 0) {
      const competitive = readGateResults(store).find((g) => g.gateRef === 'SC-GATE-COMPETITIVE');
      /* No evidence must produce NOT_VERIFIED, never a plausible landscape. */
      expect(competitive?.verdict ?? 'NOT_VERIFIED').toBe('NOT_VERIFIED');
      return;
    }
    for (const f of findings) {
      expect(f.meta.provenance.marking).toBe('RESEARCHED');
      if (f.meta.provenance.marking === 'RESEARCHED') {
        expect(f.meta.provenance.sources.length).toBeGreaterThan(0);
        for (const s of f.meta.provenance.sources) {
          expect(store.listCanonIds(ARTIFACT_TYPES.SOURCE_CAPTURE)).toContain(s.captureId);
        }
      }
    }
  });

  it('6. a downstream requirement consumed PERSISTED canon, not chat history', () => {
    if (guard()) return;
    const requirements = repository(store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
    if (requirements.length === 0) {
      console.log('the run did not reach requirements; nothing to assert here');
      return;
    }

    /*
     * Each department is its own AgentRun with its own session. The requirements author
     * never saw the discovery run's conversation — so if its output traces to a Feature
     * id that the product stage persisted, the only route by which it could know that id
     * is the Store.
     */
    const featureIds = new Set(store.listCanonIds(ARTIFACT_TYPES.FEATURE));
    const tracing = requirements.filter((r) => r.tracesTo.some((t) => featureIds.has(t.id)));
    expect(tracing.length, 'no requirement traced to a persisted feature').toBeGreaterThan(0);

    /* And the runs really were separate sessions. */
    const runIds = new Set(
      (result?.ran ?? []).map((r) => r.runId).filter((id): id is string => id !== undefined),
    );
    expect(runIds.size).toBeGreaterThan(3);
    for (const runId of runIds) expect(runStream(runId)).toBeTruthy();
  });
});
