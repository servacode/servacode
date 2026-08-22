import { afterEach, describe, expect, it } from 'vitest';
import { GateVerdict } from '../src/vocab/index.js';
import { FakeEngineAdapter } from '../src/engine/fake.js';
import {
  intelligenceOrchestrator,
  recordIdea,
  openOwnerDecisions,
  answerOwnerDecision,
} from '../src/intelligence/app.js';
import {
  OrchestratorState,
  readOrchestratorRecord,
} from '../src/intelligence/execution/orchestrator.js';
import type { AdvanceResult } from '../src/intelligence/execution/orchestrator.js';
import { configureResearchSeeds } from '../src/intelligence/departments/research.js';
import { ARTIFACT_TYPES, repository } from '../src/intelligence/repository.js';
import { FeatureSchema } from '../src/intelligence/artifacts/product.js';
import { RequirementSchema } from '../src/intelligence/artifacts/requirements.js';
import {
  IMPACT_DIMENSIONS,
  analyseImpact,
  applyReentry,
  approveChange,
  planReentry,
  raiseChangeRequest,
} from '../src/intelligence/change.js';
import { readGateResults } from '../src/gates/engine.js';
import { readLedger } from '../src/lifecycle/stages.js';
import { cleanup, freshStore } from './helpers.js';
import { E2E_SCRIPT, resolvingEngine, seedRetriever } from './fixtures/intelE2E.js';

/**
 * OFFLINE END-TO-END ACCEPTANCE — SCENARIOS B, C AND D.
 *
 * SPEC: §46. Scenario A (new product, end to end, handed to the Phase 4 factory) lives in
 * `intel.e2e.test.ts`. These are the three ways the first pass is not the whole story:
 * the product changes, the research fails, and the question is not Serva's to answer.
 *
 * All three are deterministic — a scripted engine and a fake retriever. What they assert
 * is not that the company produces good content, which a fixture cannot show, but that it
 * does the right thing when something goes wrong.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
  configureResearchSeeds({ hosts: [], urls: [] });
});

const WORK_ITEM = 'SC-WI-000701';

/** Everything a failing scenario needs to explain itself in one assertion message. */
function describeRun(r: AdvanceResult): string {
  return (
    'state=' +
    r.state +
    ' halted=' +
    (r.record.haltedAtStage ?? '-') +
    ' reason=' +
    (r.reason ?? '-') +
    ' ran=' +
    r.ran
      .map(
        (x) => x.agentId + ':' + x.outcome + (x.reason === undefined ? '' : '(' + x.reason + ')'),
      )
      .join(', ')
  );
}

function setup(opts: { readonly research?: boolean } = {}) {
  const { store, root, deps } = freshStore();
  roots.push(root);
  const engine = new FakeEngineAdapter({ clock: deps.clock });
  for (const [agentId, output] of E2E_SCRIPT) engine.script(agentId, { structuredOutput: output });

  const withResearch = opts.research !== false;
  const intel = {
    store,
    clock: deps.clock,
    ids: deps.ids,
    engine: resolvingEngine(engine, store),
    projectRoot: root,
    ...(withResearch
      ? {
          gateway: {
            store,
            clock: deps.clock,
            ids: deps.ids,
            retriever: seedRetriever(),
          },
        }
      : {}),
  };
  configureResearchSeeds(
    withResearch
      ? { hosts: ['example.com'], urls: ['https://example.com/rival-a'] }
      : { hosts: [], urls: [] },
  );
  return { store, root, deps, engine, intel };
}

/* ============================================================ SCENARIO B — MAJOR FEATURE */

describe('Scenario B — a feature request re-enters the lifecycle, it does not restart it', () => {
  it('only the affected stages re-run, and unrelated canon is left exactly as it was', async () => {
    const f = setup();
    recordIdea(f.intel, 'I want an app so my bakery stops losing phone orders in the morning.');
    const first = await intelligenceOrchestrator(f.intel, WORK_ITEM, 'PRF-NEW-PRODUCT').advance();
    expect(first.state).toBe(OrchestratorState.COMPLETE);

    /* What the finished company holds, before anything changes. */
    const features = repository(f.store, ARTIFACT_TYPES.FEATURE, FeatureSchema).list();
    const requirement = repository(
      f.store,
      ARTIFACT_TYPES.REQUIREMENT,
      RequirementSchema,
    ).list()[0];
    expect(requirement).toBeDefined();
    const findingsBefore = f.store.listCanonIds(ARTIFACT_TYPES.RESEARCH_FINDING);
    const discoveryBefore = f.store.listCanonIds(ARTIFACT_TYPES.PROJECT_GOAL);
    const findingVersionsBefore = findingsBefore.map((id) =>
      f.store.listCanonVersions(ARTIFACT_TYPES.RESEARCH_FINDING, id),
    );

    /* --- the owner asks for a feature --- */
    const change = raiseChangeRequest(f.intel, {
      origin: 'owner',
      description: 'customers should be able to place the same order again with one tap',
      magnitude: 'M2',
    });

    const analysis = analyseImpact(f.intel, {
      changeRequestId: change.id,
      dimensions: IMPACT_DIMENSIONS.map((d) =>
        d === 'REQUIREMENTS' || d === 'UX' || d === 'TESTS'
          ? {
              dimension: d,
              verdict: 'AFFECTED' as const,
              rationale:
                'repeat ordering is a new behaviour, a new screen state, and a new test case',
              affectedRefs: [{ id: requirement?.id as string }],
            }
          : {
              dimension: d,
              verdict: 'NOT_AFFECTED' as const,
              rationale: 'repeat ordering reuses what is already decided here',
            },
      ),
      reentryStageId: 'SC-STAGE-011',
      assessedBy: 'SC-AGENT-040',
    });
    expect(analysis.dimensions).toHaveLength(IMPACT_DIMENSIONS.length);

    approveChange(f.intel, { changeRequestId: change.id });
    const plan = planReentry(f.store, {
      changeRequestId: change.id,
      profileId: 'PRF-NEW-PRODUCT',
    });

    /*
     * The point of the scenario: intake, discovery, product validation, business analysis
     * and market research are NOT re-run. A change that restarts the company is not a
     * delta, it is a second project charged to the same client.
     */
    expect(plan.stagesRetained).toContain('SC-STAGE-002');
    expect(plan.stagesRetained).toContain('SC-STAGE-003');
    expect(plan.stagesRetained).toContain('SC-STAGE-004');
    expect(plan.stagesRetained).toContain('SC-STAGE-013');
    expect(plan.stagesToRerun).toContain('SC-STAGE-011');
    expect(plan.stagesToRerun).toContain('SC-STAGE-024');
    expect(plan.stagesToRerun).toContain('SC-STAGE-030');

    applyReentry(f.intel, { workItemId: WORK_ITEM, changeRequestId: change.id });
    const record = readOrchestratorRecord(f.store, WORK_ITEM);

    /* Re-opened at the right place. */
    expect(record?.state).toBe('RUNNING');
    expect(record?.completedStages).toContain('SC-STAGE-002');
    expect(record?.completedStages).not.toContain('SC-STAGE-011');

    /* Gates guarding retained stages stand; gates guarding re-run stages do not. */
    const gateIds = (record?.gateResults ?? []).map((g) => g.gateId);
    expect(gateIds).toContain('SC-GATE-INTAKE');
    expect(gateIds).toContain('SC-GATE-DISCOVERY');
    expect(gateIds).not.toContain('SC-GATE-DESIGN');
    expect(gateIds).not.toContain('SC-GATE-PLAN');

    /*
     * And nothing upstream was touched. Re-entry INVALIDATES work; it does not rewrite
     * evidence. Yesterday's research still says what it said.
     */
    expect(f.store.listCanonIds(ARTIFACT_TYPES.RESEARCH_FINDING)).toEqual(findingsBefore);
    expect(f.store.listCanonIds(ARTIFACT_TYPES.PROJECT_GOAL)).toEqual(discoveryBefore);
    expect(
      findingsBefore.map((id) => f.store.listCanonVersions(ARTIFACT_TYPES.RESEARCH_FINDING, id)),
    ).toEqual(findingVersionsBefore);
    expect(features.length).toBeGreaterThan(0);

    /* The ledger says why the later stages stopped counting. */
    const abandoned = readLedger(f.store, WORK_ITEM).filter((e) => e.disposition === 'ABANDONED');
    expect(abandoned.length).toBeGreaterThan(0);
    expect(abandoned.map((e) => e.reason ?? '').join(' ')).toContain(change.id);
  }, 180_000);
});

/* =========================================================== SCENARIO C — RESEARCH FAILURE */

describe('Scenario C — when research is unavailable, nothing is invented', () => {
  it('the run records the unavailability and the competitive gate refuses to verify', async () => {
    /* No gateway: Serva cannot retrieve, and the researcher has no network of its own. */
    const f = setup({ research: false });
    recordIdea(f.intel, 'bakery order capture');

    const result = await intelligenceOrchestrator(f.intel, WORK_ITEM, 'PRF-NEW-PRODUCT').advance();

    /*
     * NOT a crash and NOT a shrug. The company stops at the competitive gate, because the
     * gate cannot verify a landscape nobody retrieved.
     */
    expect(result.state, describeRun(result)).toBe(OrchestratorState.BLOCKED);

    const competitive = readGateResults(f.store).find((g) => g.gateRef === 'SC-GATE-COMPETITIVE');
    expect(competitive?.verdict).toBe(GateVerdict.NOT_VERIFIED);

    /* The important assertion: no plausible competitor landscape appeared from nowhere. */
    expect(f.store.listCanonIds(ARTIFACT_TYPES.RESEARCH_FINDING)).toHaveLength(0);
    expect(f.store.listCanonIds(ARTIFACT_TYPES.SOURCE_CAPTURE)).toHaveLength(0);
    expect(f.store.listCanonIds(ARTIFACT_TYPES.COMPETITOR_PROFILE)).toHaveLength(0);
    expect(f.store.listCanonIds(ARTIFACT_TYPES.COMPETITIVE_POSITION)).toHaveLength(0);

    /* And it says so, in words, rather than leaving an empty section. */
    const said = [
      result.reason ?? '',
      ...result.ran.flatMap((r) => [...r.diagnostics, r.reason ?? '']),
    ].join(' ');
    expect(said).toMatch(/RESEARCH_UNAVAILABLE|research|retriev/i);
  }, 180_000);
});

/* ============================================================ SCENARIO D — OWNER AUTHORITY */

describe('Scenario D — a business policy question stops the company', () => {
  /**
   * The scripted business analysis proposes a cancellation-fee rule with no authority
   * behind it. Serva has no way to know what a bakery charges to cancel an order, and a
   * plausible default here becomes a real charge to a real customer.
   */
  function withFinancialAmbiguity(f: ReturnType<typeof setup>): void {
    const business = E2E_SCRIPT.find(([id]) => id === 'SC-AGENT-040');
    const envelope = business?.[1] as Record<string, unknown>;
    const result = { ...(envelope['result'] as Record<string, unknown>) };
    result['financial'] = [
      {
        area: 'FEES',
        statement: 'A customer cancelling within an hour of collection is charged 50% of the order',
        /* DERIVED: nobody with the authority to set a charge has set this one. */
        authority: 'DERIVED',
      },
    ];
    f.engine.script('SC-AGENT-040', { structuredOutput: { ...envelope, result } });
  }

  it('stops at WAITING_FOR_OWNER instead of inventing the rule', async () => {
    const f = setup();
    /* Re-script 040 ahead of the queued default, then re-queue the rest of the script. */
    const fresh = new FakeEngineAdapter({ clock: f.deps.clock });
    for (const [agentId, output] of E2E_SCRIPT) {
      if (agentId === 'SC-AGENT-040') continue;
      fresh.script(agentId, { structuredOutput: output });
    }
    const intel = { ...f.intel, engine: resolvingEngine(fresh, f.store) };
    withFinancialAmbiguity({ ...f, engine: fresh });

    recordIdea(intel, 'bakery order capture');
    const result = await intelligenceOrchestrator(intel, WORK_ITEM, 'PRF-NEW-PRODUCT').advance();

    expect(result.state, describeRun(result)).toBe(OrchestratorState.WAITING_FOR_OWNER);

    const open = openOwnerDecisions(f.store);
    expect(open.length).toBeGreaterThan(0);
    const question = open.map((d) => d.question).join(' ');
    expect(question).toMatch(/fees/i);

    /* The rule was NOT quietly recorded as company truth in the meantime. */
    const record = readOrchestratorRecord(f.store, WORK_ITEM);
    expect(record?.state).toBe('WAITING_FOR_OWNER');
    expect(record?.pendingOwnerDecisions.length).toBeGreaterThan(0);

    /* --- the owner answers, and only then does the company continue --- */
    const decision = open[0];
    expect(decision).toBeDefined();
    answerOwnerDecision(intel, {
      decisionId: decision?.id as string,
      chosenOption: 'State a different rule',
      answeredBy: 'owner@bakery',
    });

    const resumed = await intelligenceOrchestrator(intel, WORK_ITEM, 'PRF-NEW-PRODUCT').advance();
    expect(resumed.state).not.toBe(OrchestratorState.WAITING_FOR_OWNER);

    /*
     * Resuming twice with the same answer is the same company, not a second one. The
     * departments that already ran do not run again, and no work is duplicated.
     */
    const featuresAfterFirstResume = f.store.listCanonIds(ARTIFACT_TYPES.FEATURE);
    const again = await intelligenceOrchestrator(intel, WORK_ITEM, 'PRF-NEW-PRODUCT').advance();
    expect(again.ran.map((r) => r.agentId)).not.toContain('SC-AGENT-040');
    expect(f.store.listCanonIds(ARTIFACT_TYPES.FEATURE)).toEqual(featuresAfterFirstResume);
  }, 180_000);
});
