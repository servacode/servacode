import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContractRegistry } from '../src/agents/registry.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { FakeEngineAdapter } from '../src/engine/fake.js';
import { Store } from '../src/store/store.js';
import { FixedClock } from '../src/core/clock.js';
import { SequentialIdSource } from '../src/core/ids.js';
import { IntelligenceOrchestrator } from '../src/intelligence/execution/orchestrator.js';
import { jsonSchemaFor } from '../src/intelligence/execution/jsonSchema.js';
import { ARTIFACT_TYPES, repository } from '../src/intelligence/repository.js';
import { OpenQuestionSchema } from '../src/intelligence/artifacts/framing.js';
import {
  DiscoveryFindingsSchema,
  UserSegmentSchema,
} from '../src/intelligence/artifacts/discovery.js';
import { ResearchRequestSchema } from '../src/intelligence/research/capture.js';
import { configureResearchSeeds } from '../src/intelligence/research/seeds.js';
import {
  marketResearchDepartment,
  sourceVerificationDepartment,
} from '../src/intelligence/departments/research.js';
import { ResearchFindingSchema } from '../src/intelligence/artifacts/market.js';
import { ClaimVerificationSchema } from '../src/intelligence/research/verification.js';
import { cleanup, tempRoot } from './helpers.js';
import type { Retriever } from '../src/intelligence/research/gateway.js';
import type { DepartmentConfig } from '../src/intelligence/execution/types.js';

/**
 * AN OBLIGATION NOBODY CONSUMES IS A BETTER-DOCUMENTED DEADLOCK.
 *
 * The runner learned to record what it routed: a research question becomes a
 * `ResearchRequest` plus an `OpenQuestion`, and canon another department owes becomes an
 * `OpenQuestion` naming the family and the stage. Both are durable, neither is ever
 * raised twice — and until the obligation controller existed, both stayed OPEN forever
 * while the record read as though the question had been properly handled.
 *
 * These tests go through the ORCHESTRATOR. Nothing below calls the runner directly or
 * fulfils an obligation by hand, because the defect was never in the recording.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});
beforeEach(() => {
  configureResearchSeeds({ hosts: [], urls: [] });
});

const WORK_ITEM = 'SC-WI-003000';
const REQUESTER = 'SC-AGENT-052';
const DATA_ARCHITECT = 'SC-AGENT-080';
const RESEARCHER = 'SC-AGENT-060';
const VERIFIER = 'SC-AGENT-063';

/* Every upstream stage except the two each scenario actually wires. */
const KEEP = (...stages: readonly string[]): Record<string, string> => {
  const ALL = [
    'SC-STAGE-002',
    'SC-STAGE-003',
    'SC-STAGE-004',
    'SC-STAGE-010',
    'SC-STAGE-011',
    'SC-STAGE-013',
    'SC-STAGE-015',
    'SC-STAGE-016',
    'SC-STAGE-020',
    'SC-STAGE-021',
    'SC-STAGE-022',
    'SC-STAGE-023',
    'SC-STAGE-024',
    'SC-STAGE-025',
    'SC-STAGE-026',
  ];
  const skip: Record<string, string> = {};
  for (const s of ALL) {
    if (!stages.includes(s)) skip[s] = 'out of scope for this control-flow test';
  }
  return skip;
};

const NoteSchema = z.object({ note: z.string().min(1) }).strict();
const DataSchema = z.object({ entity: z.string().min(1) }).strict();

function envelope(result: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...over,
  };
}

/** A run that stopped, with the question in the field a model happened to choose. */
function asking(question: string): Record<string, unknown> {
  return envelope({ note: 'unused' }, { status: 'ESCALATED', unresolved: [question] });
}

interface Harness {
  readonly root: string;
  readonly store: Store;
  readonly clock: FixedClock;
  readonly ids: SequentialIdSource;
  readonly engine: FakeEngineAdapter;
}

function setup(root = tempRoot()): Harness {
  if (!roots.includes(root)) roots.push(root);
  const clock = new FixedClock();
  const ids = new SequentialIdSource();
  const store = Store.initialize(root, { clock, ids, actor: 'OBLIGATION_TEST' });
  return { root, store, clock, ids, engine: new FakeEngineAdapter({ clock }) };
}

function reopen(h: Harness): Harness {
  const clock = new FixedClock();
  /*
   * The id source is carried across the restart because SequentialIdSource starts again
   * at 1 and would collide with transaction ids already on disk. Production uses the
   * monotonic TimeOrderedIdSource, which does not. Nothing else crosses the boundary.
   */
  const store = Store.open(h.root, { clock, ids: h.ids, actor: 'OBLIGATION_RESTART' });
  return { root: h.root, store, clock, ids: h.ids, engine: new FakeEngineAdapter({ clock }) };
}

/** The department that asks, and cannot proceed. Produces nothing of its own. */
function requester(): DepartmentConfig {
  return {
    id: 'DEPT-REQUESTER',
    stageId: 'SC-STAGE-011',
    agentId: REQUESTER,
    title: 'The department with the question',
    produces: [],
    outputSchema: NoteSchema,
    outputJsonSchema: jsonSchemaFor(NoteSchema),
    buildContext: () => ({ canon: [], excluded: [] }),
    task: () => 'establish what is required',
    scopeBoundary: () => 'requirements only',
    persist: () => ({ artifactIds: [] }),
  } as unknown as DepartmentConfig;
}

/**
 * The Data Architect, running as SC-AGENT-080 under its real canonical contract.
 *
 * A narrow configuration rather than the production data department, so that the test is
 * about the CONTROL FLOW rather than about a data model's schema. The authority is real:
 * `validateDepartmentAuthority` checks this against 32 at construction exactly as it does
 * every registered department, and DATA_MODEL is written through the same scoped writer.
 */
function dataArchitect(): DepartmentConfig {
  return {
    id: 'DEPT-DATA-ARCHITECTURE',
    stageId: 'SC-STAGE-021',
    agentId: DATA_ARCHITECT,
    title: 'Data Architecture',
    produces: [ARTIFACT_TYPES.DATA_MODEL],
    outputSchema: DataSchema,
    outputJsonSchema: jsonSchemaFor(DataSchema),
    buildContext: () => ({ canon: [], excluded: [] }),
    task: () => 'model the data',
    scopeBoundary: () => 'the data model',
    persist: (tx: never, output: { entity: string }, ctx: never) => {
      const c = ctx as unknown as { ids: SequentialIdSource; clock: FixedClock };
      const at = c.clock.now();
      const id = c.ids.next('SC-DM');
      (tx as unknown as { putCanon: (t: string, i: string, b: unknown) => void }).putCanon(
        ARTIFACT_TYPES.DATA_MODEL,
        id,
        {
          id,
          createdAt: at,
          version: 1,
          entities: [
            {
              name: output.entity,
              purpose: 'the thing the requirements are about',
              attributes: [{ name: 'id', type: 'string', constraints: ['primary key'] }],
              identity: 'id',
              lifecycle: 'created on booking, deleted on cancellation',
            },
          ],
          relationships: [],
          meta: {
            provenance: {
              marking: 'DERIVED',
              from: ['requirements'],
              rationale: 'the entities the requirements imply',
            },
            attribution: { agentId: DATA_ARCHITECT, at },
          },
        },
      );
      return { artifactIds: [id] };
    },
  } as unknown as DepartmentConfig;
}

/** A retriever that answers from a fixture. Governed, offline, and never the network. */
const FAKE_RETRIEVER: Retriever = {
  fetch: async (url: string) => ({
    url,
    title: 'A rival collection service',
    text: 'Rivals offer a two-hour collection window and confirm by text message.',
    ok: true,
  }),
};

function orchestrator(
  h: Harness,
  o: {
    readonly departments: readonly DepartmentConfig[];
    readonly enabled: readonly string[];
    readonly skip: Record<string, string>;
    readonly withGateway?: boolean;
  },
): IntelligenceOrchestrator {
  const registry = ContractRegistry.shared();
  const enabledAgents = new Set(o.enabled);
  return new IntelligenceOrchestrator(
    {
      store: h.store,
      clock: h.clock,
      ids: h.ids,
      registry,
      runtime: new AgentRuntime({
        store: h.store,
        ids: h.ids,
        clock: h.clock,
        registry,
        engine: h.engine,
        enabledAgents,
        projectRoot: '/nowhere',
      }),
      projectRoot: '/nowhere',
      enabledAgents,
      departments: o.departments,
      ...(o.withGateway === true
        ? {
            gateway: {
              store: h.store,
              clock: h.clock,
              ids: h.ids,
              retriever: FAKE_RETRIEVER,
            },
          }
        : {}),
    },
    WORK_ITEM,
    'PRF-NEW-PRODUCT',
    o.skip,
  );
}

/** Market research needs discovery findings before it will run at all. */
function seedDiscovery(h: Harness): void {
  const at = h.clock.now();
  const segmentId = h.ids.next('SC-SEG');
  const tx = h.store.begin();
  repository(h.store, ARTIFACT_TYPES.USER_SEGMENT, UserSegmentSchema).put(tx, {
    id: segmentId,
    createdAt: at,
    name: 'Regulars',
    description: 'the twenty people who order most mornings',
    goals: ['get the usual order in before work'],
    context: 'ordering by phone during the rush',
    meta: { provenance: { marking: 'OWNER_STATED', statedAt: at }, attribution: { at } },
  } as never);
  repository(h.store, ARTIFACT_TYPES.DISCOVERY_FINDINGS, DiscoveryFindingsSchema).put(tx, {
    id: h.ids.next('SC-DF'),
    createdAt: at,
    summary: 'a small shop losing phone orders in the morning rush',
    segmentRefs: [{ id: segmentId }],
    researchPerformed: { interviews: 1, surveys: 0, usabilityTests: 0, deskResearch: false },
    limitations: ['one conversation with the owner, and nothing else'],
    meta: { provenance: { marking: 'OWNER_STATED', statedAt: at }, attribution: { at } },
  } as never);
  tx.commit();
}

const COMPETITOR_QUESTION =
  'What do competitors in this market typically offer for collection windows?';
const DATA_QUESTION = 'No data model exists, so I cannot say where a reservation is stored';

/** The research findings a researcher returns once Serva has captured a source. */
function researchEnvelope(h: Harness): Record<string, unknown> {
  const captures = h.store.listCanonIds(ARTIFACT_TYPES.SOURCE_CAPTURE);
  return envelope({
    findings: [
      {
        question: COMPETITOR_QUESTION,
        finding: 'rivals quote a two-hour collection window and confirm by text',
        captureIds: captures,
        confidence: 'MEDIUM',
      },
    ],
    competitors: [],
    unanswered: [],
  });
}

/**
 * The verifier's verdict, built from whatever findings exist when it runs.
 *
 * Lazily, because a verdict names the finding it judges and the findings do not exist
 * until the researcher has run. A fixture with a hard-coded id would be a test agreeing
 * with itself rather than with the system.
 */
function verificationEnvelope(h: Harness, verdict: string): () => Record<string, unknown> {
  return () =>
    envelope({
      verifications: repository(h.store, ARTIFACT_TYPES.RESEARCH_FINDING, ResearchFindingSchema)
        .list()
        .map((f) => ({
          findingId: f.id,
          verdict,
          reasoning:
            verdict === 'SUPPORTED'
              ? 'the captured page states the two-hour window in those words'
              : 'the captured page says nothing about collection windows',
        })),
    });
}

/** The full research chain: retrieve, then verify, then nobody else. */
function researchChain(): readonly DepartmentConfig[] {
  return [
    requester(),
    marketResearchDepartment as DepartmentConfig,
    sourceVerificationDepartment as DepartmentConfig,
  ];
}

const RESEARCH_AGENTS = [REQUESTER, RESEARCHER, VERIFIER];

/* ==================================================================== RESEARCH */

describe('a research obligation is consumed, not merely recorded', () => {
  it('the exact request is fulfilled, the question is resolved, and the requester resumes', async () => {
    const h = setup();
    seedDiscovery(h);
    configureResearchSeeds({ hosts: ['example.com'], urls: ['https://example.com/rival'] });

    h.engine.script(REQUESTER, { structuredOutput: asking(COMPETITOR_QUESTION) });

    const orch = orchestrator(h, {
      departments: researchChain(),
      enabled: RESEARCH_AGENTS,
      skip: KEEP('SC-STAGE-011', 'SC-STAGE-013'),
      withGateway: true,
    });

    /*
     * The researcher's answer is scripted lazily, because it must cite the capture ids
     * Serva creates while discharging the obligation — which do not exist until the
     * gateway has run. The verifier's is lazy for the same reason.
     */
    h.engine.script(RESEARCHER, { structuredOutputFrom: () => researchEnvelope(h) });
    h.engine.script(VERIFIER, { structuredOutputFrom: verificationEnvelope(h, 'SUPPORTED') });
    h.engine.script(REQUESTER, {
      structuredOutput: envelope({ note: 'the evidence answers it; proceeding' }),
    });

    const advanced = await orch.advance();

    /* ONE request, and it is the one the requester raised. Not a generic substitute. */
    const requests = repository(
      h.store,
      ARTIFACT_TYPES.RESEARCH_REQUEST,
      ResearchRequestSchema,
    ).list();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.question).toBe(COMPETITOR_QUESTION);
    expect(requests[0]?.dataAllowedToLeave).toEqual([]);

    /* Serva retrieved under that request; the asking department did not. */
    const captures = h.store.listCanonIds(ARTIFACT_TYPES.SOURCE_CAPTURE);
    expect(captures.length).toBeGreaterThan(0);
    expect(h.store.listCanonIds(ARTIFACT_TYPES.RESEARCH_FINDING).length).toBeGreaterThan(0);

    /* Independently verified, by a different agent, in a different governed run. */
    const verifications = repository(
      h.store,
      ARTIFACT_TYPES.CLAIM_VERIFICATION,
      ClaimVerificationSchema,
    ).list();
    expect(verifications.length).toBeGreaterThan(0);
    expect(verifications[0]?.verifiedByAgentId).toBe(VERIFIER);

    /* The obligation is FULFILLED, and says which canon fulfilled it. */
    const questions = repository(h.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema).list();
    expect(questions).toHaveLength(1);
    expect(questions[0]?.state).toBe('ANSWERED');

    /*
     * BOUNDED REFS. The verified conclusion and the judgement that made it one — never
     * the ResearchRequest, and never a raw SourceCapture. Handing back everything the
     * researcher's run touched is how retrieved text used to arrive downstream dressed as
     * governed canon.
     */
    const refs = questions[0]?.resolvedByRefs.map((r) => r.id) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const id of refs) {
      expect(captures).not.toContain(id);
      expect(id).not.toBe(requests[0]?.id);
    }

    /* The requester resumed and completed. Nobody asked the owner anything. */
    expect(h.store.listCanonIds(ARTIFACT_TYPES.OWNER_DECISION_REQUEST)).toHaveLength(0);
    const requesterRuns = advanced.ran.filter((r) => r.departmentId === 'DEPT-REQUESTER');
    expect(requesterRuns[requesterRuns.length - 1]?.outcome).toBe('COMPLETED');
  }, 120_000);

  it('an unfulfillable request BLOCKS with the real reason, and invents nothing', async () => {
    const h = setup();
    seedDiscovery(h);
    /* No permitted host. The obligation is real; answering it lawfully is not possible. */
    configureResearchSeeds({ hosts: [], urls: [] });

    h.engine.script(REQUESTER, { structuredOutput: asking(COMPETITOR_QUESTION) });

    const orch = orchestrator(h, {
      departments: researchChain(),
      enabled: RESEARCH_AGENTS,
      skip: KEEP('SC-STAGE-011', 'SC-STAGE-013'),
      withGateway: true,
    });
    const advanced = await orch.advance();

    expect(advanced.state).toBe('BLOCKED');
    expect(advanced.reason).toContain('permits no host');
    /* Nothing was captured and nothing was concluded. */
    expect(h.store.listCanonIds(ARTIFACT_TYPES.SOURCE_CAPTURE)).toHaveLength(0);
    expect(h.store.listCanonIds(ARTIFACT_TYPES.RESEARCH_FINDING)).toHaveLength(0);
    const questions = repository(h.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema).list();
    expect(questions[0]?.state).toBe('OPEN');
  }, 120_000);

  it('restarting mid-obligation resumes, and raises no second request', async () => {
    const first = setup();
    seedDiscovery(first);
    configureResearchSeeds({ hosts: ['example.com'], urls: ['https://example.com/rival'] });

    /*
     * The first process records the obligation and then dies: the researcher is dispatched
     * and never answers. That is the state a crash actually leaves behind — an obligation
     * on disk, and nothing that knows about it in memory.
     */
    first.engine.script(REQUESTER, { structuredOutput: asking(COMPETITOR_QUESTION) });
    const before = await orchestrator(first, {
      departments: researchChain(),
      enabled: RESEARCH_AGENTS,
      skip: KEEP('SC-STAGE-011', 'SC-STAGE-013'),
      withGateway: true,
    }).advance();
    expect(before.state).toBe('BLOCKED');

    const openBefore = repository(
      first.store,
      ARTIFACT_TYPES.OPEN_QUESTION,
      OpenQuestionSchema,
    ).list();
    expect(openBefore).toHaveLength(1);
    expect(openBefore[0]?.state).toBe('OPEN');
    expect(first.store.listCanonIds(ARTIFACT_TYPES.RESEARCH_FINDING)).toHaveLength(0);

    /* A new process, a new engine, nothing carried but the Store. */
    const h = reopen(first);
    h.engine.script(RESEARCHER, { structuredOutputFrom: () => researchEnvelope(h) });
    h.engine.script(VERIFIER, { structuredOutputFrom: verificationEnvelope(h, 'SUPPORTED') });
    h.engine.script(REQUESTER, {
      structuredOutput: envelope({ note: 'resuming from the persisted evidence' }),
    });

    await orchestrator(h, {
      departments: researchChain(),
      enabled: RESEARCH_AGENTS,
      skip: KEEP('SC-STAGE-011', 'SC-STAGE-013'),
      withGateway: true,
    }).advance();

    /* Still ONE request and ONE question — the ones the dead process left behind. */
    expect(h.store.listCanonIds(ARTIFACT_TYPES.RESEARCH_REQUEST)).toHaveLength(1);
    const questions = repository(h.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema).list();
    expect(questions).toHaveLength(1);
    expect(questions[0]?.id).toBe(openBefore[0]?.id);
    expect(questions[0]?.state).toBe('ANSWERED');
    expect(questions[0]?.resolvedByRefs.length).toBeGreaterThan(0);
    expect(h.store.listCanonIds(ARTIFACT_TYPES.RESEARCH_FINDING).length).toBeGreaterThan(0);
  }, 120_000);
});

/* ==================================================================== UPSTREAM */

describe('an upstream obligation drives real lifecycle control', () => {
  it('the owing department runs, the question resolves, and the downstream one resumes', async () => {
    const h = setup();
    h.engine.script(REQUESTER, { structuredOutput: asking(DATA_QUESTION) });
    h.engine.script(DATA_ARCHITECT, { structuredOutput: envelope({ entity: 'Reservation' }) });
    h.engine.script(REQUESTER, {
      structuredOutput: envelope({ note: 'the data model answers it; proceeding' }),
    });

    const orch = orchestrator(h, {
      departments: [requester(), dataArchitect()],
      enabled: [REQUESTER, DATA_ARCHITECT],
      skip: KEEP('SC-STAGE-011', 'SC-STAGE-021'),
    });
    const advanced = await orch.advance();

    /* The canon the question named now exists, produced by the department that owes it. */
    expect(h.store.listCanonIds(ARTIFACT_TYPES.DATA_MODEL)).toHaveLength(1);

    const questions = repository(h.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema).list();
    expect(questions).toHaveLength(1);
    expect(questions[0]?.askedOf).toBe('UPSTREAM_DEPARTMENT');
    expect(questions[0]?.missingCanon).toBe(ARTIFACT_TYPES.DATA_MODEL);
    expect(questions[0]?.state).toBe('ANSWERED');
    expect(questions[0]?.resolvedByRefs.map((r) => r.id)).toEqual(
      h.store.listCanonIds(ARTIFACT_TYPES.DATA_MODEL),
    );

    /* The owner was never asked to do Serva's departmental work. */
    expect(h.store.listCanonIds(ARTIFACT_TYPES.OWNER_DECISION_REQUEST)).toHaveLength(0);

    /* The downstream department resumed and completed. */
    const requesterRuns = advanced.ran.filter((r) => r.departmentId === 'DEPT-REQUESTER');
    expect(requesterRuns[requesterRuns.length - 1]?.outcome).toBe('COMPLETED');

    /* And the upstream department ran ONCE, not once for the obligation and once in turn. */
    const dataRuns = advanced.ran.filter((r) => r.departmentId === 'DEPT-DATA-ARCHITECTURE');
    expect(dataRuns).toHaveLength(1);
    expect(advanced.record.completedDepartments).toContain('DEPT-DATA-ARCHITECTURE');
  }, 120_000);

  it('restarting mid-obligation resumes, and does not duplicate the upstream run', async () => {
    const first = setup();
    /* The obligation is recorded; the Data Architect is dispatched and never answers. */
    first.engine.script(REQUESTER, { structuredOutput: asking(DATA_QUESTION) });
    const before = await orchestrator(first, {
      departments: [requester(), dataArchitect()],
      enabled: [REQUESTER, DATA_ARCHITECT],
      skip: KEEP('SC-STAGE-011', 'SC-STAGE-021'),
    }).advance();
    expect(before.state).toBe('BLOCKED');
    expect(first.store.listCanonIds(ARTIFACT_TYPES.DATA_MODEL)).toHaveLength(0);

    const h = reopen(first);
    h.engine.script(DATA_ARCHITECT, { structuredOutput: envelope({ entity: 'Reservation' }) });
    h.engine.script(REQUESTER, {
      structuredOutput: envelope({ note: 'resuming with the data model' }),
    });
    const advanced = await orchestrator(h, {
      departments: [requester(), dataArchitect()],
      enabled: [REQUESTER, DATA_ARCHITECT],
      skip: KEEP('SC-STAGE-011', 'SC-STAGE-021'),
    }).advance();

    expect(h.store.listCanonIds(ARTIFACT_TYPES.DATA_MODEL)).toHaveLength(1);
    const questions = repository(h.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema).list();
    expect(questions).toHaveLength(1);
    expect(questions[0]?.state).toBe('ANSWERED');
    expect(advanced.ran.filter((r) => r.departmentId === 'DEPT-DATA-ARCHITECTURE')).toHaveLength(1);
  }, 120_000);

  it('an obligation nobody can satisfy BLOCKS rather than waiting forever', async () => {
    const h = setup();
    h.engine.script(REQUESTER, { structuredOutput: asking(DATA_QUESTION) });

    /* Nobody is registered to produce a data model, so nothing will ever satisfy it. */
    const advanced = await orchestrator(h, {
      departments: [requester()],
      enabled: [REQUESTER],
      skip: KEEP('SC-STAGE-011'),
    }).advance();

    expect(advanced.state).toBe('BLOCKED');
    expect(h.store.listCanonIds(ARTIFACT_TYPES.OWNER_DECISION_REQUEST)).toHaveLength(0);
  }, 120_000);
});
