import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeCliEngineAdapter } from '../../src/engine/claude/adapter.js';
import { EngineHealthState } from '../../src/engine/types.js';
import {
  answerOwnerDecision,
  intelligenceOrchestrator,
  openOwnerDecisions,
  recordIdea,
} from '../../src/intelligence/app.js';
import { OrchestratorState } from '../../src/intelligence/execution/orchestrator.js';
import { configureResearchSeeds } from '../../src/intelligence/departments/research.js';
import { httpRetriever } from '../../src/intelligence/research/http.js';
import { ARTIFACT_TYPES, repository } from '../../src/intelligence/repository.js';
import { ResearchFindingSchema } from '../../src/intelligence/artifacts/market.js';
import { SourceCaptureSchema } from '../../src/intelligence/research/capture.js';
import { OwnerDecisionRequestSchema } from '../../src/intelligence/artifacts/governance.js';
import { RequirementSchema } from '../../src/intelligence/artifacts/requirements.js';
import {
  DiscoveryFindingsSchema,
  UserSegmentSchema,
} from '../../src/intelligence/artifacts/discovery.js';
import { readGateResults } from '../../src/gates/engine.js';
import { runStream } from '../../src/events/agentRun.js';
import { cleanup, freshStore } from '../helpers.js';
import { ProofLedger, ProofOutcome } from './obligations.js';
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

/** How many times the test will answer before reporting where it got to. */
const MAX_OWNER_ROUNDS = 6;

let store: Store;
let root: string;
let result: AdvanceResult | undefined;
let skip: string | undefined;
const ownerRounds: string[][] = [];

/**
 * The proof ledger for this suite.
 *
 * Every obligation records PROVEN, BLOCKED or NOT_RUN. A green suite with three BLOCKED
 * obligations is an honest report; a green suite that silently skipped them is not.
 */
const proof = new ProofLedger();
/**
 * Every department result across every round.
 *
 * `advance()` returns only what THAT call ran, and the owner loop calls it several times.
 * Asserting against the last one asks whether intake ran in the final round, which it
 * did not and should not have — it ran in the first.
 */
const allRuns: {
  agentId: string;
  outcome: string;
  runId?: string;
  reason?: string;
  diagnostics: readonly string[];
}[] = [];

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

  /*
   * THE OWNER LOOP, WITH A REAL MODEL.
   *
   * A live run escalates, and it should: a one-sentence brief genuinely does not say
   * whether a reservation involves a deposit, and the whole authority boundary exists so
   * that nobody invents an answer. Asserting that a real model never asks would be
   * asserting that the boundary does not work.
   *
   * So the test plays the owner. It answers with the option a bookshop owner really would
   * give for a first release — leave it out — and lets the company continue. Capped,
   * because a loop that answers questions forever is not a test, it is a bill.
   */
  const orchestrator = intelligenceOrchestrator(intel, WORK_ITEM, 'PRF-NEW-PRODUCT');
  for (let round = 0; round < MAX_OWNER_ROUNDS; round += 1) {
    result = await orchestrator.advance();
    allRuns.push(
      ...result.ran.map((r) => ({
        agentId: r.agentId,
        outcome: r.outcome as string,
        ...(r.runId === undefined ? {} : { runId: r.runId }),
        ...(r.reason === undefined ? {} : { reason: r.reason }),
        diagnostics: r.diagnostics,
      })),
    );
    if (result.state !== OrchestratorState.WAITING_FOR_OWNER) break;

    const open = openOwnerDecisions(store);
    if (open.length === 0) break;
    ownerRounds.push(open.map((d) => d.question.slice(0, 120)));
    for (const d of open)
      ownerRounds[ownerRounds.length - 1]?.push('  -> ' + answerAsOwner(intel, store, d.id));
  }
}, 3_600_000);

afterAll(() => {
  configureResearchSeeds({ hosts: [], urls: [] });
  if (root !== undefined) cleanup(root);
});

/**
 * Answer a decision with an option it actually offers.
 *
 * The first version of this loop answered every decision with the literal string
 * "Declare it out of scope for now", which is one of the options the RUNNER offers on a
 * blocking escalation and is not offered by anything else. The live suite then failed on a
 * business-rule decision whose options are "Confirm the drafted rule as stated" and "State
 * a different rule" — closure fix 1 refusing an answer nobody offered, working exactly as
 * intended, against my own harness.
 *
 * So the test owner reads the options and chooses deliberately: DEFER where one exists
 * (declining to expand scope), otherwise Serva's own recommendation, otherwise the first
 * option. What it never does is invent an answer, which is the whole point.
 */
function answerAsOwner(
  intel: Parameters<typeof answerOwnerDecision>[0],
  store: Store,
  decisionId: string,
): string {
  const decision = repository(
    store,
    ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
    OwnerDecisionRequestSchema,
  ).get(decisionId);
  const options = decision?.options ?? [];
  const chosen =
    options.find((o) => o.disposition === 'DEFER') ??
    options.find((o) => o.option === decision?.recommendation) ??
    options[0];
  if (chosen === undefined) throw new Error('decision ' + decisionId + ' offers no options');

  answerOwnerDecision(intel, {
    decisionId,
    chosenOption: chosen.option,
    answeredBy: 'live-test-owner',
  });
  return chosen.option + ' (' + chosen.disposition + ')';
}

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
    console.log('ran: ' + allRuns.map((r) => r.agentId + ':' + r.outcome).join(', '));
    for (const r of allRuns) {
      if (r.outcome === 'COMPLETED') continue;
      console.log('  ' + r.agentId + ' — ' + (r.reason ?? 'no reason'));
      for (const d of r.diagnostics) console.log('    · ' + d);
    }
    if (result?.state === OrchestratorState.BLOCKED) {
      console.log('BLOCKED — ' + (result.reason ?? 'no reason given'));
    }
    for (const [i, round] of ownerRounds.entries()) {
      console.log('owner round ' + String(i + 1) + ':');
      for (const q of round) console.log('    ? ' + q);
    }

    /*
     * Intake is the floor, and it may reach it either way: by producing canon, or by
     * asking the owner something a one-sentence brief could not answer. Both are the
     * system working. What would NOT be acceptable is a third outcome — proceeding on an
     * invented answer — and that one is impossible to reach from here, because canon is
     * only written by a run that completed.
     */
    const intake = allRuns.filter((r) => r.agentId === 'SC-AGENT-020');
    expect(intake.length, 'intake never ran').toBeGreaterThan(0);
    expect(
      intake.some((r) => r.outcome === 'COMPLETED' || r.outcome === 'ESCALATED_TO_OWNER'),
      'intake neither completed nor escalated: ' + intake.map((r) => r.reason ?? '').join(' | '),
    ).toBe(true);

    /* Every question the company asked was raised by Serva and answered by a person. */
    for (const id of store.listCanonIds(ARTIFACT_TYPES.OWNER_DECISION_REQUEST)) {
      const env = store.getCanon<{ answeredBy?: string; state?: string }>(
        ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
        id,
      );
      const answeredBy = env?.body?.answeredBy;
      if (answeredBy !== undefined) expect(answeredBy.startsWith('SC-AGENT-')).toBe(false);
    }
  });

  it('1. discovery and product produced schema-valid canon from one owner sentence', () => {
    if (guard()) return;
    proof.attempt('LC-1', 'discovery and product produce schema-valid canon', () => {
      const goals = store.listCanonIds(ARTIFACT_TYPES.PROJECT_GOAL);
      const alternatives = store.listCanonIds(ARTIFACT_TYPES.CURRENT_ALTERNATIVE);

      if (goals.length === 0) {
        return { blocked: 'no goal exists: the run is still with the owner' };
      }
      if (alternatives.length === 0) {
        /*
         * Intake produced goals and discovery did not complete. A real run reached exactly
         * this state — the owner declared two unknowns out of scope and discovery refused
         * to proceed on an unvalidated assumption about customer behaviour. Correct, and
         * not a proof of the chain.
         */
        return { blocked: 'goals exist but discovery produced no CurrentAlternative' };
      }
      return (
        String(goals.length) +
        ' goal(s) and ' +
        String(alternatives.length) +
        ' current alternative(s) from one owner sentence'
      );
    });
  });

  it('2/3. a real source was retrieved by Serva and captured with a digest', () => {
    if (guard()) return;
    proof.attempt('LC-2/3', 'a real source is retrieved by Serva and captured', () => {
      const captures = repository(store, ARTIFACT_TYPES.SOURCE_CAPTURE, SourceCaptureSchema).list();
      if (captures.length === 0) {
        /* Nothing invented in its place is the thing that must still hold. */
        expect(store.listCanonIds(ARTIFACT_TYPES.RESEARCH_FINDING)).toHaveLength(0);
        return { blocked: 'the lifecycle did not reach market research' };
      }
      for (const c of captures) {
        expect(c.url.startsWith('https://en.wikipedia.org/')).toBe(true);
        expect(c.contentDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(c.trust).toBe('UNTRUSTED');
        expect(c.excerpt.length).toBeGreaterThan(0);
        /* Retrieval is attributed to the ONE agent whose contract declares network. */
        expect(c.retrievedByAgentId).toBe('SC-AGENT-060');
      }
      return String(captures.length) + ' page(s), hashed and UNTRUSTED';
    });
  });

  it('4. the Source Verifier judged the findings without fetching anything', () => {
    if (guard()) return;
    proof.attempt('LC-4', 'the Source Verifier judges captures and fetches nothing', () => {
      const captures = store.listCanonIds(ARTIFACT_TYPES.SOURCE_CAPTURE);
      if (captures.length === 0) return { notRun: 'no capture exists, so nothing to verify' };

      const verifications = store.listCanonIds(ARTIFACT_TYPES.CLAIM_VERIFICATION);
      if (verifications.length === 0) {
        return { blocked: 'the lifecycle stopped before verification' };
      }
      for (const id of captures) {
        const env = store.getCanon<{ retrievedByAgentId?: string }>(
          ARTIFACT_TYPES.SOURCE_CAPTURE,
          id,
        );
        expect(env?.body?.retrievedByAgentId).not.toBe('SC-AGENT-063');
      }
      return String(verifications.length) + ' verification(s), none of them a re-fetch';
    });
  });

  it('5. competitive and innovation output was derived from the captured evidence', () => {
    if (guard()) return;
    proof.attempt('LC-5', 'competitive output derives from captured evidence', () => {
      const findings = repository(
        store,
        ARTIFACT_TYPES.RESEARCH_FINDING,
        ResearchFindingSchema,
      ).list();
      if (findings.length === 0) {
        const competitive = readGateResults(store).find((g) => g.gateRef === 'SC-GATE-COMPETITIVE');
        /* No evidence must produce NOT_VERIFIED, never a plausible landscape. */
        expect(competitive?.verdict ?? 'NOT_VERIFIED').toBe('NOT_VERIFIED');
        return { blocked: 'no finding exists; the competitive gate reads NOT_VERIFIED' };
      }
      const captureIds = new Set(store.listCanonIds(ARTIFACT_TYPES.SOURCE_CAPTURE));
      for (const f of findings) {
        expect(f.meta.provenance.marking).toBe('RESEARCHED');
        if (f.meta.provenance.marking !== 'RESEARCHED') continue;
        expect(f.meta.provenance.sources.length).toBeGreaterThan(0);
        for (const src of f.meta.provenance.sources) {
          expect(captureIds.has(src.captureId)).toBe(true);
        }
      }
      return String(findings.length) + ' finding(s), each citing a stored capture';
    });
  });

  it('6. a downstream requirement consumed PERSISTED canon, not chat history', () => {
    if (guard()) return;
    proof.attempt('LC-6', 'a downstream decision consumes PERSISTED canon', () => {
      const requirements = repository(store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
      if (requirements.length === 0) {
        return { notRun: 'the lifecycle did not reach requirements' };
      }

      /*
       * Each department is its own AgentRun with its own session. The requirements author
       * never saw the discovery run's conversation — so if its output traces to a Feature
       * id the product stage persisted, the only route to that id is the Store.
       */
      const featureIds = new Set(store.listCanonIds(ARTIFACT_TYPES.FEATURE));
      const tracing = requirements.filter((r) => r.tracesTo.some((t) => featureIds.has(t.id)));
      expect(tracing.length, 'no requirement traced to a persisted feature').toBeGreaterThan(0);

      const runIds = new Set(
        allRuns.map((r) => r.runId).filter((id): id is string => id !== undefined),
      );
      expect(runIds.size).toBeGreaterThan(3);
      for (const runId of runIds) expect(runStream(runId)).toBeTruthy();

      return (
        String(tracing.length) +
        ' requirement(s) trace to a feature id their run never saw, across ' +
        String(runIds.size) +
        ' sessions'
      );
    });
  });
});

/* ==================================================== THE RESEARCH SLICE, ON ITS OWN */

/**
 * §47 items 2–5, proved directly.
 *
 * The full-lifecycle run above is honest about how far it gets, and where it gets to is
 * decided by a real model reading a real brief — on the recorded run it stopped at the
 * requirements gate, which is the gate doing its job and also means market research never
 * executed. Waiting for a lifecycle to reach stage 013 is an expensive and unreliable way
 * to test stage 013.
 *
 * So this runs `PRF-RESEARCH`, which selects exactly that one stage, over a seeded
 * discovery finding. Four model calls, one real fetch, and the whole research chain:
 * retrieval by Serva, capture, INDEPENDENT verification that never re-fetches, competitive
 * analysis and innovation.
 */
describe('the research chain, against the real web', () => {
  let researchStore: Store;
  let researchRoot: string;
  let researchResult: AdvanceResult | undefined;

  beforeAll(async () => {
    if (skip !== undefined) return;

    const f = freshStore();
    researchStore = f.store;
    researchRoot = f.root;

    const engine = new ClaudeCliEngineAdapter({ clock: f.deps.clock, probeTtlMs: 30_000 });
    configureResearchSeeds({ hosts: RESEARCH_HOSTS, urls: RESEARCH_URLS });

    /* The one prerequisite stage 013 declares, seeded rather than earned. */
    const at = f.deps.clock.now();
    const segmentId = f.deps.ids.next('SC-SEG');
    const tx = researchStore.begin();
    repository(researchStore, ARTIFACT_TYPES.USER_SEGMENT, UserSegmentSchema).put(tx, {
      id: segmentId,
      createdAt: at,
      name: 'Regular customers of an independent bookshop',
      description: 'People who would visit if they knew a copy was actually held',
      goals: ['get the book without a wasted trip'],
      context: 'deciding whether the shop is worth walking to',
      meta: { provenance: { marking: 'OWNER_STATED', statedAt: at }, attribution: { at } },
    } as never);
    repository(researchStore, ARTIFACT_TYPES.DISCOVERY_FINDINGS, DiscoveryFindingsSchema).put(tx, {
      id: f.deps.ids.next('SC-DF'),
      createdAt: at,
      summary: 'Independent bookshops lose sales to customers who assume they are out of stock.',
      segmentRefs: [{ id: segmentId }],
      researchPerformed: { interviews: 0, surveys: 0, usabilityTests: 0, deskResearch: false },
      limitations: ['No primary user research was performed.'],
      meta: { provenance: { marking: 'OWNER_STATED', statedAt: at }, attribution: { at } },
    } as never);
    tx.commit();

    const intel = {
      store: researchStore,
      clock: f.deps.clock,
      ids: f.deps.ids,
      engine,
      projectRoot: researchRoot,
      gateway: {
        store: researchStore,
        clock: f.deps.clock,
        ids: f.deps.ids,
        retriever: httpRetriever(),
      },
    };
    /*
     * The same owner loop. Market research can legitimately stop and ask — a research
     * question that reaches the edge of what the brief says is exactly the case the
     * escalation path exists for — and a slice that gave up at the first question would
     * test one department instead of the chain.
     */
    const orchestrator = intelligenceOrchestrator(intel, 'SC-WI-000951', 'PRF-RESEARCH');
    for (let round = 0; round < MAX_OWNER_ROUNDS; round += 1) {
      researchResult = await orchestrator.advance();
      if (researchResult.state !== OrchestratorState.WAITING_FOR_OWNER) break;
      const open = openOwnerDecisions(researchStore);
      if (open.length === 0) break;
      for (const d of open) answerAsOwner(intel, researchStore, d.id);
    }
  }, 3_600_000);

  afterAll(() => {
    if (researchRoot !== undefined) cleanup(researchRoot);
  });

  it('2/3. Serva fetched a real page and captured it, hashed and untrusted', () => {
    if (guard()) return;
    console.log(
      'research ran: ' +
        (researchResult?.ran ?? []).map((r) => r.agentId + ':' + r.outcome).join(', '),
    );
    console.log('research state: ' + String(researchResult?.state));

    proof.attempt('RS-2/3', 'the research gateway fetches and captures a real page', () => {
      const captures = repository(
        researchStore,
        ARTIFACT_TYPES.SOURCE_CAPTURE,
        SourceCaptureSchema,
      ).list();
      if (captures.length === 0) {
        /* Honest degradation: an absence recorded, never an invented landscape. */
        expect(researchStore.listCanonIds(ARTIFACT_TYPES.RESEARCH_FINDING)).toHaveLength(0);
        expect(researchStore.listCanonIds(ARTIFACT_TYPES.COMPETITOR_PROFILE)).toHaveLength(0);
        return { blocked: 'no source was retrieved; research is UNAVAILABLE' };
      }
      for (const c of captures) {
        expect(c.url.startsWith('https://en.wikipedia.org/')).toBe(true);
        expect(c.contentDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(c.trust).toBe('UNTRUSTED');
        expect(c.excerpt.length).toBeGreaterThan(200);
        expect(c.retrievedByAgentId).toBe('SC-AGENT-060');
      }
      return String(captures.length) + ' page(s), hashed and attributed to SC-AGENT-060';
    });
  });

  it('4. the verifier judged the captures and fetched nothing of its own', () => {
    if (guard()) return;
    proof.attempt('RS-4', 'an INDEPENDENT verifier judges the captures and fetches nothing', () => {
      const captures = repository(
        researchStore,
        ARTIFACT_TYPES.SOURCE_CAPTURE,
        SourceCaptureSchema,
      ).list();
      if (captures.length === 0) return { notRun: 'no capture exists, so nothing to verify' };

      const verifications = researchStore.listCanonIds(ARTIFACT_TYPES.CLAIM_VERIFICATION);
      if (verifications.length === 0) {
        /* What must NOT happen is competitive truth built on unverified claims. */
        expect(researchStore.listCanonIds(ARTIFACT_TYPES.COMPETITIVE_POSITION)).toHaveLength(0);
        return {
          blocked: 'the chain stopped before verification: state=' + String(researchResult?.state),
        };
      }

      for (const c of captures) expect(c.retrievedByAgentId).not.toBe('SC-AGENT-063');
      /* And every capture is still exactly the capture that was verified. */
      for (const c of captures) {
        expect(researchStore.listCanonVersions(ARTIFACT_TYPES.SOURCE_CAPTURE, c.id)).toEqual([1]);
      }
      return (
        String(verifications.length) + ' verification(s); no capture attributed to SC-AGENT-063'
      );
    });
  });

  it('5. every finding cites a capture that is actually in the store', () => {
    if (guard()) return;

    proof.attempt('RS-5', 'every finding cites a capture that exists', () => {
      const findings = repository(
        researchStore,
        ARTIFACT_TYPES.RESEARCH_FINDING,
        ResearchFindingSchema,
      ).list();
      if (findings.length === 0) return { notRun: 'no finding was produced' };

      const captureIds = new Set(researchStore.listCanonIds(ARTIFACT_TYPES.SOURCE_CAPTURE));
      for (const f of findings) {
        expect(f.meta.provenance.marking).toBe('RESEARCHED');
        if (f.meta.provenance.marking !== 'RESEARCHED') continue;
        expect(f.meta.provenance.sources.length).toBeGreaterThan(0);
        for (const src of f.meta.provenance.sources) {
          expect(captureIds.has(src.captureId), 'cites a capture that does not exist').toBe(true);
        }
      }
      return String(findings.length) + ' finding(s), each RESEARCHED with a stored capture';
    });

    /*
     * The competitive chain is a SEPARATE obligation, and the one that has never completed
     * live: the chosen public pages carry no competitor data, so the analyst produces
     * nothing to build on and innovation is refused for want of a prerequisite. Correct
     * behaviour, and not a proof of the chain.
     */
    proof.attempt('RS-6', 'the competitive chain completes end to end on real sources', () => {
      const differentiators = researchStore.listCanonIds(ARTIFACT_TYPES.DIFFERENTIATOR);
      if (differentiators.length === 0) {
        /* Nothing invented to fill the gap. */
        expect(researchStore.listCanonIds(ARTIFACT_TYPES.COMPETITIVE_POSITION)).toHaveLength(0);
        return { blocked: 'the retrieved pages carry no competitor data' };
      }
      return String(differentiators.length) + ' differentiator(s) from real sources';
    });
  });

  /**
   * THE LEDGER ITSELF IS AN OBLIGATION.
   *
   * A test, not an afterAll hook. The first version of this check lived in afterAll and a
   * mis-recorded obligation slipped past it silently — the research slice was writing
   * LC-2/3 instead of RS-2/3, so RS-2/3 was never classified and nothing said so. That is
   * precisely the failure this whole mechanism replaced, reintroduced by the mechanism.
   */
  it('every obligation was classified, and at least one was proved', () => {
    console.log(proof.report('LIVE PROOF OBLIGATIONS'));
    if (guard()) return;

    const ids = new Set(proof.all().map((r) => r.id));
    const required = ['LC-1', 'LC-2/3', 'LC-4', 'LC-5', 'LC-6', 'RS-2/3', 'RS-4', 'RS-5', 'RS-6'];
    const unclassified = required.filter((r) => !ids.has(r));
    expect(unclassified, 'obligations nobody classified: ' + unclassified.join(', ')).toEqual([]);

    /* Each id is recorded exactly once: a duplicate means two obligations share a name. */
    for (const id of ids) {
      expect(
        proof.all().filter((r) => r.id === id).length,
        id + ' was classified more than once',
      ).toBe(1);
    }

    /* And something was genuinely proved, or the whole run was a no-op. */
    expect(
      proof.all().some((r) => r.outcome === ProofOutcome.PROVEN),
      'no live obligation was proved',
    ).toBe(true);
  });
});
