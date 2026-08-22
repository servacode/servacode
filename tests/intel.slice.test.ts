import { afterEach, describe, expect, it } from 'vitest';
import { GateVerdict, SourceMarking, StageLedgerDisposition } from '../src/vocab/index.js';
import { FakeEngineAdapter } from '../src/engine/fake.js';
import { Store } from '../src/store/store.js';
import {
  UPSTREAM_DEPARTMENTS,
  answerOwnerDecision,
  intelligenceOrchestrator,
  openOwnerDecisions,
  recordIdea,
} from '../src/intelligence/app.js';
import {
  OrchestratorState,
  readOrchestratorRecord,
} from '../src/intelligence/execution/orchestrator.js';
import { ARTIFACT_TYPES, repository } from '../src/intelligence/repository.js';
import { ClientInputSchema, ProjectGoalSchema } from '../src/intelligence/artifacts/framing.js';
import {
  CurrentAlternativeSchema,
  UserSegmentSchema,
} from '../src/intelligence/artifacts/discovery.js';
import { FeatureSchema } from '../src/intelligence/artifacts/product.js';
import { FinancialLogicSchema } from '../src/intelligence/artifacts/business.js';
import {
  AcceptanceCriterionSchema,
  NfrSchema,
  RequirementSchema,
} from '../src/intelligence/artifacts/requirements.js';
import { readLedger } from '../src/lifecycle/stages.js';
import { readGateResults } from '../src/gates/engine.js';
import { cleanup, freshStore } from './helpers.js';

/**
 * THE FIRST VERTICAL SLICE.
 *
 * Owner intake → Discovery → Product → Business Analysis → Requirements → NFR →
 * independent Verifier → Requirements Gate.
 *
 * Everything is deterministic: a scripted engine, no network, no paid call. What is under
 * test is Serva's governance — that each department is a separate run producing separate
 * persisted artifacts with real provenance, that an owner decision genuinely stops the
 * lifecycle, and that resuming works from the Store with no conversation to remember.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const WORK_ITEM = 'SC-WI-000500';

/** Envelope wrapper — the runtime refuses a bare payload, and rightly. */
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

const INTAKE_OUT = {
  problem: 'Independent bakeries lose orders taken by phone during the morning rush.',
  audience: 'Small bakery owners and their counter staff',
  successDefinition: 'No order taken during the rush is lost or duplicated.',
  commercialRequirements: ['must be affordable for a single-site bakery'],
  goals: [
    {
      statement: 'Capture every order reliably during peak hours',
      successIndicator: 'zero lost orders reported over a four-week period',
      priority: 'MUST' as const,
    },
  ],
  constraints: [
    { type: 'TIME' as const, statement: 'ready before the winter season', negotiable: true },
  ],
  openQuestions: [],
};

const DISCOVERY_OUT = {
  summary: 'Counter staff take phone orders on paper during a rush and transcribe them later.',
  segments: [
    {
      name: 'Counter staff',
      description: 'Serve walk-ins and answer the phone simultaneously',
      goals: ['take an order without losing the walk-in queue'],
      context: 'Peak 07:00-09:30, both hands busy',
      jobs: [{ statement: 'Record a phone order while serving', currentSolution: 'paper notepad' }],
      pains: [
        {
          statement: 'Orders are transcribed later and sometimes lost',
          severity: 'BLOCKING' as const,
        },
      ],
      alternatives: [
        {
          kind: 'MANUAL_PROCESS' as const,
          description: 'A paper notepad by the till',
          whyUsed: 'instant, needs no login, works with flour on your hands',
          weaknesses: ['illegible', 'lost', 'no record after the shift'],
        },
      ],
    },
  ],
  researchPerformed: { interviews: 0, surveys: 0, usabilityTests: 0, deskResearch: true },
  limitations: ['No bakery staff were interviewed; segment behaviour is desk research only.'],
  assumptions: [
    {
      statement: 'Staff will accept a screen during a rush',
      loadBearing: true,
      validationApproach: 'observe one morning service before build',
      ifWrong: 'the product is unusable at exactly the moment it is needed',
    },
  ],
};

const PRODUCT_OUT = {
  outcome: 'PROCEED' as const,
  rationale: 'The paper notepad loses orders and nothing else in the shop records them.',
  conditions: [],
  features: [
    {
      name: 'Rapid order capture',
      description: 'One-screen capture of a phone order in under fifteen seconds',
      goalIndexes: [0],
      priority: 'MUST' as const,
    },
  ],
  outOfScope: [{ statement: 'Delivery routing', reason: 'no bakery in the segment delivers' }],
  nonGoals: [
    { statement: 'Becoming an EPOS system', reason: 'the till already works and staff trust it' },
  ],
  scopeRationale: 'Solve the rush, not the shop.',
  ownerDecisions: [],
};

/** Business analysis draws a commission rule nobody with the authority has confirmed. */
const BUSINESS_OUT_WITH_MONEY = {
  actors: [{ name: 'Counter staff', description: 'takes orders', permissions: ['create order'] }],
  rules: [
    {
      statement: 'An order must record the time it was taken',
      rationale: 'disputes are resolved by sequence',
      authority: 'DERIVED' as const,
      appliesTo: ['Order'],
    },
  ],
  processes: [],
  stateMachines: [
    {
      entity: 'Order',
      states: ['TAKEN', 'FULFILLED', 'CANCELLED'],
      initialState: 'TAKEN',
      terminalStates: ['FULFILLED', 'CANCELLED'],
      transitions: [
        { from: 'TAKEN', to: 'FULFILLED', trigger: 'collected', guard: 'payment received' },
        { from: 'TAKEN', to: 'CANCELLED', trigger: 'customer cancels', guard: 'not yet baked' },
      ],
    },
  ],
  glossary: [{ term: 'Order', definition: 'A request for goods taken from a named customer' }],
  financial: [
    {
      area: 'FEES' as const,
      statement: 'A 2% service fee applies to phone orders',
      /** PROPOSED — Serva drafted it and nobody has confirmed it. */
      authority: 'PROPOSED' as const,
    },
  ],
  contradictions: [],
};

/** The same analysis with no invented money. */
const BUSINESS_OUT_CLEAN = { ...BUSINESS_OUT_WITH_MONEY, financial: [] };

const REQUIREMENTS_OUT = {
  requirements: [
    {
      statement: 'The system shall record a phone order with customer name, items and time taken',
      kind: 'FUNCTIONAL' as const,
      priority: 'MUST' as const,
      rationale: 'orders taken on paper are lost',
      featureIndex: 0,
      acceptanceCriteria: [
        {
          criterion: 'An order saved during a rush is retrievable after the shift',
          verificationMethod: 'AUTOMATED_TEST' as const,
        },
      ],
    },
  ],
};

const NFR_OUT = {
  nfrs: [
    {
      dimension: 'PERFORMANCE' as const,
      statement: 'Order capture must complete within the rush',
      target: 'p95 under 15 seconds from first keystroke to saved',
      measurementMethod: 'timed script against the capture screen',
      applicability: 'the order capture flow only',
      rationale: 'staff cannot leave the counter for longer',
    },
  ],
};

const VERIFIER_OUT = {
  verdict: 'ACCEPTABLE' as const,
  summary: 'Requirements are atomic, traceable and each MUST is checkable.',
  findings: [],
};

/** Wire an engine that answers each department once. */
function scriptedEngine(clock: { now(): string; epochMs(): number }, business: unknown) {
  const engine = new FakeEngineAdapter({ clock });
  engine.script('SC-AGENT-020', { structuredOutput: envelope(INTAKE_OUT) });
  engine.script('SC-AGENT-030', { structuredOutput: envelope(DISCOVERY_OUT) });
  engine.script('SC-AGENT-020', { structuredOutput: envelope(PRODUCT_OUT) });
  engine.script('SC-AGENT-040', { structuredOutput: envelope(business) });
  engine.script('SC-AGENT-050', { structuredOutput: envelope(REQUIREMENTS_OUT) });
  engine.script('SC-AGENT-051', { structuredOutput: envelope(NFR_OUT) });
  engine.script('SC-AGENT-052', { structuredOutput: envelope(VERIFIER_OUT) });
  return engine;
}

function setup(business: unknown = BUSINESS_OUT_CLEAN) {
  const { store, root, deps } = freshStore();
  roots.push(root);
  const engine = scriptedEngine(deps.clock, business);
  const intel = {
    store,
    clock: deps.clock,
    ids: deps.ids,
    engine,
    projectRoot: root,
  };
  return { store, root, deps, engine, intel };
}

describe('the intelligence execution core runs the upstream company', () => {
  it('runs each department as a separate governed run, and reaches the Requirements Gate', async () => {
    const f = setup();
    recordIdea(f.intel, 'I want an app so my bakery stops losing phone orders in the morning.');

    const orchestrator = intelligenceOrchestrator(f.intel, WORK_ITEM, 'PRF-NEW-PRODUCT');
    const result = await orchestrator.advance();

    /* --- every department was a SEPARATE run, in its own session --- */
    const agentsRun = result.ran.map((r) => r.agentId);
    expect(agentsRun).toEqual([
      'SC-AGENT-020', // intake
      'SC-AGENT-030', // discovery
      'SC-AGENT-020', // product validation
      'SC-AGENT-040', // business analysis
      'SC-AGENT-050', // requirements
      'SC-AGENT-051', // NFRs
      'SC-AGENT-052', // independent verifier
    ]);
    const runIds = result.ran.map((r) => r.runId);
    expect(new Set(runIds).size).toBe(runIds.length);

    /* --- separate structured artifacts, actually persisted --- */
    const input = repository(f.store, ARTIFACT_TYPES.CLIENT_INPUT, ClientInputSchema).list();
    const goals = repository(f.store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).list();
    const segments = repository(f.store, ARTIFACT_TYPES.USER_SEGMENT, UserSegmentSchema).list();
    const alts = repository(
      f.store,
      ARTIFACT_TYPES.CURRENT_ALTERNATIVE,
      CurrentAlternativeSchema,
    ).list();
    const features = repository(f.store, ARTIFACT_TYPES.FEATURE, FeatureSchema).list();
    const reqs = repository(f.store, ARTIFACT_TYPES.REQUIREMENT, RequirementSchema).list();
    const acs = repository(
      f.store,
      ARTIFACT_TYPES.ACCEPTANCE_CRITERION,
      AcceptanceCriterionSchema,
    ).list();
    const nfrs = repository(f.store, ARTIFACT_TYPES.NFR, NfrSchema).list();

    expect(input).toHaveLength(1);
    expect(goals).toHaveLength(1);
    expect(segments).toHaveLength(1);
    expect(features).toHaveLength(1);
    expect(reqs).toHaveLength(1);
    expect(acs).toHaveLength(1);
    expect(nfrs).toHaveLength(1);

    /* --- the mandatory discovery rule: every segment has an alternative --- */
    for (const s of segments) {
      expect(alts.some((a) => a.segmentRef.id === s.id)).toBe(true);
    }
    expect(alts[0]?.kind).toBe('MANUAL_PROCESS');

    /* --- provenance survived, and says where each fact came from --- */
    expect(input[0]?.meta.provenance.marking).toBe(SourceMarking.OWNER_STATED);
    expect(segments[0]?.meta.provenance.marking).toBe(SourceMarking.DERIVED);
    expect(reqs[0]?.meta.attribution.agentId).toBe('SC-AGENT-050');
    expect(nfrs[0]?.meta.attribution.agentId).toBe('SC-AGENT-051');

    /* --- traceability actually chains: requirement -> feature -> goal --- */
    expect(reqs[0]?.tracesTo[0]?.id).toBe(features[0]?.id);
    expect(features[0]?.goalRefs[0]?.id).toBe(goals[0]?.id);

    /* --- the assumption was preserved rather than dissolved into prose --- */
    const assumptions = f.store.listCanonIds(ARTIFACT_TYPES.ASSUMPTION);
    expect(assumptions).toHaveLength(1);

    /* --- the ledger describes the WHOLE lifecycle, not only what ran --- */
    const ledger = readLedger(f.store, WORK_ITEM);
    const dispositions = new Set(ledger.map((e) => e.disposition));
    expect(dispositions.has(StageLedgerDisposition.EXECUTED)).toBe(true);
    /*
     * Under PRF-NEW-PRODUCT every stage is applicable, so nothing is NOT_APPLICABLE here
     * — the executed ones are recorded, and the profile that decided it travels with each
     * entry so a later reader can argue with the selection rather than guess at it.
     */
    for (const stageId of ['SC-STAGE-002', 'SC-STAGE-003', 'SC-STAGE-011']) {
      expect(
        ledger.some(
          (e) => e.stageId === stageId && e.disposition === StageLedgerDisposition.EXECUTED,
        ),
      ).toBe(true);
    }
    for (const e of ledger) expect(e.profileRef).toBe('PRF-NEW-PRODUCT');

    /* --- the gate engine produced real GateResults over persisted evidence --- */
    const gateResults = readGateResults(f.store);
    const requirementsGate = gateResults.find((g) => g.gateRef === 'SC-GATE-REQUIREMENTS');
    expect(requirementsGate).toBeDefined();
    expect(requirementsGate?.criterionEvaluationIds.length).toBeGreaterThan(0);
    expect([GateVerdict.PASS, GateVerdict.PASS_WITH_QUALIFICATION]).toContain(
      requirementsGate?.verdict,
    );

    /*
     * ...and then it stops, honestly.
     *
     * PRF-NEW-PRODUCT selects market and competitive intelligence, and no department is
     * wired to that stage in this build. The alternative — skipping it and reporting
     * COMPLETE — would describe a lifecycle that never ran a third of its stages as
     * finished, which is exactly the "looks done, was not" failure the ledger exists to
     * prevent.
     */
    expect(result.state).toBe(OrchestratorState.BLOCKED);
    expect(result.record.haltedAtStage).toBe('SC-STAGE-013');
    expect(result.reason).toContain('no department is wired');
    expect(result.record.completedStages).toEqual([
      'SC-STAGE-002',
      'SC-STAGE-003',
      'SC-STAGE-004',
      'SC-STAGE-010',
      'SC-STAGE-011',
    ]);
  }, 60_000);

  it('a profile that excludes a stage records the exclusion, it does not omit it', async () => {
    /*
     * The property §4 exists for. Under PRF-FEATURE, discovery is skipped BY PROFILE —
     * and the ledger says so, with a reason. A lifecycle that simply never mentioned
     * discovery would leave a reader unable to tell a decision from an oversight.
     */
    const f = setup();
    recordIdea(f.intel, 'add a loyalty stamp to the order screen');
    const o = intelligenceOrchestrator(f.intel, 'SC-WI-000501', 'PRF-FEATURE');
    await o.advance();

    const ledger = readLedger(f.store, 'SC-WI-000501');
    const discovery = ledger.find((e) => e.stageId === 'SC-STAGE-003');
    expect(discovery?.disposition).toBe(StageLedgerDisposition.NOT_APPLICABLE);
    expect(discovery?.reason).toContain('PRF-FEATURE');
    // EVERY stage the profile excludes is recorded, not merely some of them.
    const excluded = o.applicability.stages.filter((x) => x.disposition === 'NOT_APPLICABLE');
    expect(excluded.length).toBe(15);
    for (const x of excluded) {
      expect(ledger.some((e) => e.stageId === x.stageId)).toBe(true);
    }
  }, 60_000);

  it('a research-free discovery is honest about it rather than claiming interviews', async () => {
    const f = setup();
    recordIdea(f.intel, 'bakery order capture');
    const o = intelligenceOrchestrator(f.intel, WORK_ITEM, 'PRF-NEW-PRODUCT');
    const result = await o.advance();

    const discovery = result.ran.find((r) => r.agentId === 'SC-AGENT-030');
    expect(discovery?.diagnostics.join(' ')).toContain('no primary user research was performed');

    // ...and the discovery gate still passes, because saying so is the requirement.
    const gates = readGateResults(f.store);
    const dg = gates.find((g) => g.gateRef === 'SC-GATE-DISCOVERY');
    expect([GateVerdict.PASS, GateVerdict.PASS_WITH_QUALIFICATION]).toContain(dg?.verdict);
  }, 60_000);
});

describe('an owner decision is control flow, not advice', () => {
  it('stops the lifecycle, persists the state, and refuses to resume without a real answer', async () => {
    const f = setup(BUSINESS_OUT_WITH_MONEY);
    recordIdea(f.intel, 'bakery order capture with a service fee');

    const o = intelligenceOrchestrator(f.intel, WORK_ITEM, 'PRF-NEW-PRODUCT');
    const first = await o.advance();

    /* --- Serva refused to invent the fee and stopped --- */
    expect(first.state).toBe(OrchestratorState.WAITING_FOR_OWNER);
    expect(first.reason).toContain('owner');
    expect(first.record.haltedAtStage).toBe('SC-STAGE-010');
    expect(first.record.pendingOwnerDecisions).toHaveLength(1);

    // The financial rule was stored, marked PROPOSED — recorded, not acted on.
    const fin = repository(f.store, ARTIFACT_TYPES.FINANCIAL_LOGIC, FinancialLogicSchema).list();
    expect(fin[0]?.authority).toBe('PROPOSED');

    // Requirements did NOT run. A blocked lifecycle does not quietly continue.
    expect(first.ran.some((r) => r.agentId === 'SC-AGENT-050')).toBe(false);

    /* --- an AGENT cannot answer it --- */
    const decisionId = first.record.pendingOwnerDecisions[0] as string;
    answerOwnerDecision(f.intel, {
      decisionId,
      chosenOption: 'Confirm the drafted rule as stated',
      answeredBy: 'SC-AGENT-040',
    });
    const forged = await o.advance();
    expect(forged.state).toBe(OrchestratorState.WAITING_FOR_OWNER);
    expect(forged.reason).toContain('cannot be synthesised');

    /* --- a real owner answer releases it --- */
    answerOwnerDecision(f.intel, {
      decisionId,
      chosenOption: 'Confirm the drafted rule as stated',
      answeredBy: 'owner:bakery@example.com',
    });
    const resumed = await o.advance();
    /* Past the owner decision, through the requirements gate, on to the first gap. */
    expect(resumed.record.haltedAtStage).toBe('SC-STAGE-013');
    expect(resumed.record.completedStages).toContain('SC-STAGE-011');

    // ...and it continued rather than starting again: intake and discovery did not rerun.
    expect(resumed.ran.some((r) => r.agentId === 'SC-AGENT-030')).toBe(false);
    expect(resumed.ran.map((r) => r.agentId)).toEqual([
      'SC-AGENT-050',
      'SC-AGENT-051',
      'SC-AGENT-052',
    ]);
  }, 60_000);

  it('resumes from the STORE, with no orchestrator and no conversation carried over', async () => {
    /*
     * SPEC §39. The proof that project truth lives in the Store: the first orchestrator
     * is discarded entirely, the Store is reopened from disk, and a brand new
     * orchestrator — with a fresh engine that has never seen the earlier departments —
     * continues from exactly where the first one stopped.
     */
    const f = setup(BUSINESS_OUT_WITH_MONEY);
    recordIdea(f.intel, 'bakery order capture with a service fee');

    const first = await intelligenceOrchestrator(f.intel, WORK_ITEM, 'PRF-NEW-PRODUCT').advance();
    expect(first.state).toBe(OrchestratorState.WAITING_FOR_OWNER);

    const decisionId = first.record.pendingOwnerDecisions[0] as string;
    answerOwnerDecision(f.intel, {
      decisionId,
      chosenOption: 'Confirm the drafted rule',
      answeredBy: 'owner:bakery@example.com',
    });

    /* --- a completely fresh process --- */
    const reopened = Store.open(f.root, f.deps);
    const record = readOrchestratorRecord(reopened, WORK_ITEM);
    expect(record?.state).toBe(OrchestratorState.WAITING_FOR_OWNER);
    expect(record?.completedStages).toContain('SC-STAGE-003');

    const freshEngine = new FakeEngineAdapter({ clock: f.deps.clock });
    freshEngine.script('SC-AGENT-050', { structuredOutput: envelope(REQUIREMENTS_OUT) });
    freshEngine.script('SC-AGENT-051', { structuredOutput: envelope(NFR_OUT) });
    freshEngine.script('SC-AGENT-052', { structuredOutput: envelope(VERIFIER_OUT) });

    const resumed = await intelligenceOrchestrator(
      {
        store: reopened,
        clock: f.deps.clock,
        ids: f.deps.ids,
        engine: freshEngine,
        projectRoot: f.root,
      },
      WORK_ITEM,
      'PRF-NEW-PRODUCT',
    ).advance();

    expect(resumed.record.completedStages).toContain('SC-STAGE-011');
    // The fresh engine was asked ONLY for the departments that had not run. Everything
    // before the pause came back from the Store, not from a conversation.
    expect(freshEngine.seen.map((r) => r.agentId)).toEqual([
      'SC-AGENT-050',
      'SC-AGENT-051',
      'SC-AGENT-052',
    ]);
  }, 60_000);
});

describe('the substrate refuses before it dispatches', () => {
  it('an agent that is not enabled cannot run, and costs no model call', async () => {
    const f = setup();
    recordIdea(f.intel, 'bakery order capture');
    const o = intelligenceOrchestrator(
      { ...f.intel, enabledAgents: new Set(['SC-AGENT-030']) },
      WORK_ITEM,
      'PRF-NEW-PRODUCT',
    );
    const result = await o.advance();
    expect(result.state).toBe(OrchestratorState.BLOCKED);
    expect(result.reason).toContain('not enabled');
    expect(f.engine.seen).toHaveLength(0);
  }, 60_000);

  it('a missing prerequisite blocks the stage deterministically, before any model call', async () => {
    /* No Idea was recorded, so intake has nothing to interpret. */
    const f = setup();
    const o = intelligenceOrchestrator(f.intel, WORK_ITEM, 'PRF-NEW-PRODUCT');
    const result = await o.advance();

    expect(result.state).toBe(OrchestratorState.BLOCKED);
    expect(result.reason).toContain('intel.idea');
    expect(f.engine.seen).toHaveLength(0);

    const ledger = readLedger(f.store, WORK_ITEM);
    const blocked = ledger.find((e) => e.stageId === 'SC-STAGE-002' && e.disposition === 'BLOCKED');
    expect(blocked).toBeDefined();
  }, 60_000);

  it('the verifier is declared independent of both requirement authors', () => {
    const verifier = UPSTREAM_DEPARTMENTS.find((d) => d.agentId === 'SC-AGENT-052');
    expect(verifier?.independentOf).toContain('SC-AGENT-050');
    expect(verifier?.independentOf).toContain('SC-AGENT-051');
    // ...and it writes no canon, so it cannot become an author with an opinion.
    expect(verifier?.id).toBe('DEPT-REQUIREMENTS-VERIFIER');
  });

  it('no upstream department carries network capability', async () => {
    /* SPEC §10: network is not a department capability. */
    for (const d of UPSTREAM_DEPARTMENTS) {
      expect(d.usesResearchGateway ?? false).toBe(false);
    }
  });

  it('an open owner decision is visible without running anything', async () => {
    const f = setup(BUSINESS_OUT_WITH_MONEY);
    recordIdea(f.intel, 'bakery with a fee');
    await intelligenceOrchestrator(f.intel, WORK_ITEM, 'PRF-NEW-PRODUCT').advance();
    const open = openOwnerDecisions(f.store);
    expect(open).toHaveLength(1);
    expect(open[0]?.question).toContain('fees');
  }, 60_000);
});
