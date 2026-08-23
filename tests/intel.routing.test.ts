import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ContractRegistry } from '../src/agents/registry.js';
import { AgentRuntime } from '../src/agents/runtime.js';
import { FakeEngineAdapter } from '../src/engine/fake.js';
import { Store } from '../src/store/store.js';
import { FixedClock } from '../src/core/clock.js';
import { SequentialIdSource } from '../src/core/ids.js';
import { runDepartment } from '../src/intelligence/execution/runner.js';
import { DepartmentOutcome } from '../src/intelligence/execution/types.js';
import { resolveApplicability } from '../src/intelligence/applicability.js';
import { jsonSchemaFor } from '../src/intelligence/execution/jsonSchema.js';
import { ARTIFACT_TYPES, repository } from '../src/intelligence/repository.js';
import { OpenQuestionSchema, ProjectGoalSchema } from '../src/intelligence/artifacts/framing.js';
import { ResearchRequestSchema } from '../src/intelligence/research/capture.js';
import { OFFLINE_RETRIEVER } from '../src/intelligence/research/gateway.js';
import { cleanup, tempRoot } from './helpers.js';
import type { DepartmentConfig, DepartmentContext } from '../src/intelligence/execution/types.js';

/**
 * CLASSIFICATION IS NOT ROUTING.
 *
 * `normalizeOpenQuestions` decides where a question belongs. These tests are about what
 * the runner then DOES about it — because a classifier that says "the answer is already in
 * the Store" and then fails without supplying it has described the fix rather than applied
 * it, and one that says "Serva may retrieve this" and never schedules retrieval has made a
 * promise on somebody else's behalf.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const WORK_ITEM = 'SC-WI-001000';
const OutputSchema = z.object({ note: z.string().min(1) }).strict();

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

/** An envelope that could not finish, with its questions in whichever field is asked for. */
function asking(field: 'escalations' | 'unresolved', ...questions: string[]) {
  return envelope(
    { note: 'unused' },
    field === 'escalations'
      ? {
          status: 'ESCALATED',
          escalations: questions.map((q) => ({
            condition: 'INSUFFICIENT_CONTEXT',
            detail: q,
            blocking: true,
          })),
        }
      : { status: 'ESCALATED', unresolved: questions },
  );
}

interface Harness {
  readonly store: Store;
  readonly clock: FixedClock;
  readonly ids: SequentialIdSource;
  readonly engine: FakeEngineAdapter;
  readonly root: string;
}

function setup(): Harness {
  const root = tempRoot();
  roots.push(root);
  const clock = new FixedClock();
  const ids = new SequentialIdSource();
  const store = Store.initialize(root, { clock, ids, actor: 'ROUTING_TEST' });
  return { store, clock, ids, engine: new FakeEngineAdapter({ clock }), root };
}

/** A department with the given agent, outputs and research declaration. */
function department(over: Partial<DepartmentConfig<typeof OutputSchema>> = {}) {
  return {
    id: 'DEPT-ASKING',
    stageId: 'SC-STAGE-011',
    agentId: 'SC-AGENT-052',
    title: 'A department with a question',
    produces: [],
    outputSchema: OutputSchema,
    outputJsonSchema: jsonSchemaFor(OutputSchema),
    buildContext: () => ({ canon: [], excluded: [] }),
    task: () => 'do the thing',
    scopeBoundary: () => 'nothing',
    persist: () => ({ artifactIds: [] }),
    ...over,
  } as DepartmentConfig<typeof OutputSchema>;
}

function deps(h: Harness, o: { enabled?: readonly string[]; departments?: unknown } = {}) {
  const registry = ContractRegistry.shared();
  const enabled = new Set(o.enabled ?? ['SC-AGENT-052']);
  return {
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
      enabledAgents: enabled,
      projectRoot: '/nowhere',
    }),
    projectRoot: '/nowhere',
    enabledAgents: enabled,
    ...(o.departments === undefined ? {} : { departments: o.departments }),
  } as never;
}

function context(h: Harness, over: Partial<DepartmentContext> = {}): DepartmentContext {
  const plan = resolveApplicability('PRF-NEW-PRODUCT');
  return {
    workItemId: WORK_ITEM,
    store: h.store,
    clock: h.clock,
    ids: h.ids,
    plan,
    stage: plan.stages[0] as never,
    ...over,
  } as DepartmentContext;
}

/** A goal the department can be told about. */
function seedGoal(h: Harness): string {
  const at = h.clock.now();
  const id = h.ids.next('SC-GOAL');
  const tx = h.store.begin();
  repository(h.store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).put(tx, {
    id,
    createdAt: at,
    statement: 'Stop losing phone orders during the morning rush',
    successIndicator: 'no order lost during a two-week observation',
    priority: 'MUST',
    meta: { provenance: { marking: 'OWNER_STATED', statedAt: at }, attribution: { at } },
  } as never);
  tx.commit();
  return id;
}

describe('A. EXISTING_STORE_FACT is supplied, not merely named', () => {
  it('the exact fact is handed back and the retry succeeds', async () => {
    const h = setup();
    const goalId = seedGoal(h);

    /* First attempt asks about canon it was not shown; second one proceeds. */
    h.engine.script('SC-AGENT-052', {
      structuredOutput: asking('unresolved', 'I was never shown ' + goalId + ', so I stopped'),
    });
    h.engine.script('SC-AGENT-052', { structuredOutput: envelope({ note: 'now I can proceed' }) });

    const result = await runDepartment(deps(h), department(), context(h));

    expect(result.outcome, result.reason ?? '').toBe(DepartmentOutcome.COMPLETED);
    /* No owner was troubled with a question Serva could answer itself. */
    expect(h.store.listCanonIds(ARTIFACT_TYPES.OWNER_DECISION_REQUEST)).toHaveLength(0);
    expect(result.diagnostics.join(' ')).toContain('supplying ' + goalId);
  }, 60_000);

  it('B. asking again after being given the fact fails explicitly, and does not loop', async () => {
    const h = setup();
    const goalId = seedGoal(h);

    /* Both attempts ask the same thing. The second must not produce a third. */
    for (let i = 0; i < 4; i += 1) {
      h.engine.script('SC-AGENT-052', {
        structuredOutput: asking('unresolved', 'I was never shown ' + goalId + ', so I stopped'),
      });
    }

    const result = await runDepartment(deps(h), department(), context(h));

    expect(result.outcome).toBe(DepartmentOutcome.FAILED);
    expect(result.reason).toContain('asked for it again');
    expect(result.reason).toContain(goalId);
    expect(h.store.listCanonIds(ARTIFACT_TYPES.OWNER_DECISION_REQUEST)).toHaveLength(0);
  }, 60_000);
});

describe('C. research capability is not the presence of a gateway', () => {
  it('an ordinary department gains nothing from a globally available gateway', async () => {
    const h = setup();
    h.engine.script('SC-AGENT-052', {
      structuredOutput: asking(
        'unresolved',
        'What do competitors in this market typically offer for collection?',
      ),
    });

    /*
     * The orchestrator puts one gateway in the context for the whole run. SC-AGENT-052 is
     * a verifier: its contract declares no network and its department does not use the
     * gateway — and no research authority is registered in this company at all. A gateway
     * OBJECT is not a research capability, so there is no route to offer and the question
     * is the owner's.
     */
    const result = await runDepartment(
      deps(h),
      department(),
      context(h, {
        gateway: { store: h.store, clock: h.clock, ids: h.ids, retriever: OFFLINE_RETRIEVER },
      }),
    );

    /* It became an owner question, not a research obligation. */
    expect(h.store.listCanonIds(ARTIFACT_TYPES.RESEARCH_REQUEST)).toHaveLength(0);
    expect(result.outcome).toBe(DepartmentOutcome.ESCALATED_TO_OWNER);
    expect(result.diagnostics.join(' ')).toContain('OWNER_DECISION');
  }, 60_000);

  it('a registered research authority makes the route real, and the asker still retrieves nothing', async () => {
    const h = setup();
    h.engine.script('SC-AGENT-052', {
      structuredOutput: asking(
        'unresolved',
        'What do competitors in this market typically offer for collection?',
      ),
    });

    /*
     * The same department, the same question, the same gateway — and now a company that
     * employs a researcher. The route exists because a REGISTERED department declares
     * research and its canonical contract grants network scope, which is a decision
     * somebody made rather than an object that happened to be in scope.
     *
     * What does not change is who may fetch. SC-AGENT-052 records an obligation and
     * retrieves nothing: `assertResearchAuthority` would refuse it at the gateway, and the
     * evidence arrives later, from the authority that is allowed to go and get it.
     */
    const result = await runDepartment(
      deps(h, {
        departments: [
          {
            id: 'DEPT-MARKET-RESEARCH',
            stageId: 'SC-STAGE-013',
            agentId: 'SC-AGENT-060',
            produces: [ARTIFACT_TYPES.RESEARCH_FINDING],
            usesResearchGateway: true,
          },
        ],
      }),
      department(),
      context(h, {
        gateway: { store: h.store, clock: h.clock, ids: h.ids, retriever: OFFLINE_RETRIEVER },
      }),
    );

    expect(result.outcome).toBe(DepartmentOutcome.PREREQUISITE_MISSING);
    expect(h.store.listCanonIds(ARTIFACT_TYPES.RESEARCH_REQUEST)).toHaveLength(1);
    expect(h.store.listCanonIds(ARTIFACT_TYPES.SOURCE_CAPTURE)).toHaveLength(0);
    expect(h.store.listCanonIds(ARTIFACT_TYPES.OWNER_DECISION_REQUEST)).toHaveLength(0);
  }, 60_000);
});

describe('D. a RESEARCH route becomes a governed obligation', () => {
  it('a research-authorised department records a request and retrieves nothing itself', async () => {
    const h = setup();
    h.engine.script('SC-AGENT-060', {
      structuredOutput: asking(
        'escalations',
        'What do competitors in this market typically offer for collection?',
      ),
    });

    const result = await runDepartment(
      deps(h, { enabled: ['SC-AGENT-060'] }),
      department({
        id: 'DEPT-RESEARCH-ASKING',
        stageId: 'SC-STAGE-013',
        agentId: 'SC-AGENT-060',
        usesResearchGateway: true,
      }),
      context(h, {
        gateway: { store: h.store, clock: h.clock, ids: h.ids, retriever: OFFLINE_RETRIEVER },
      }),
    );

    expect(result.outcome).toBe(DepartmentOutcome.PREREQUISITE_MISSING);
    expect(result.reason).toContain('does not retrieve for itself');

    /* The obligation is canon: a declaration to retrieve, and a question owed to research. */
    const requests = repository(
      h.store,
      ARTIFACT_TYPES.RESEARCH_REQUEST,
      ResearchRequestSchema,
    ).list();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.question).toContain('competitors');
    /* Nothing about this project leaves in the asking. */
    expect(requests[0]?.dataAllowedToLeave).toEqual([]);

    const questions = repository(h.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema).list();
    expect(questions).toHaveLength(1);
    expect(questions[0]?.askedOf).toBe('RESEARCH');
    expect(questions[0]?.researchRequestRef?.id).toBe(requests[0]?.id);
    /* And the department did not fetch: no capture exists. */
    expect(h.store.listCanonIds(ARTIFACT_TYPES.SOURCE_CAPTURE)).toHaveLength(0);
  }, 60_000);
});

describe('E. an UPSTREAM route names the stage that owes the canon', () => {
  const OWNER_DEPARTMENT = {
    id: 'DEPT-DATA',
    stageId: 'SC-STAGE-021',
    produces: [ARTIFACT_TYPES.DATA_MODEL],
  };

  it('the obligation records the family, the owing stage and who asked', async () => {
    const h = setup();
    h.engine.script('SC-AGENT-052', {
      structuredOutput: asking(
        'unresolved',
        'No data model exists, so I cannot say where a reservation is stored',
      ),
    });

    const result = await runDepartment(
      deps(h, { departments: [OWNER_DEPARTMENT] }),
      department(),
      context(h),
    );

    expect(result.outcome).toBe(DepartmentOutcome.PREREQUISITE_MISSING);
    expect(result.reason).toContain(ARTIFACT_TYPES.DATA_MODEL);
    /* The owner was not asked to do Serva's departmental work. */
    expect(h.store.listCanonIds(ARTIFACT_TYPES.OWNER_DECISION_REQUEST)).toHaveLength(0);

    const [q] = repository(h.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema).list();
    expect(q?.askedOf).toBe('UPSTREAM_DEPARTMENT');
    expect(q?.missingCanon).toBe(ARTIFACT_TYPES.DATA_MODEL);
    expect(q?.owedByStage).toBe('SC-STAGE-021');
    expect(q?.raisedBy).toBe('DEPT-ASKING');
    expect(q?.sourceFields).toEqual(['unresolved']);
  }, 60_000);

  it('canon owed by a stage this profile does not run is reported as a contradiction', async () => {
    const h = setup();
    h.engine.script('SC-AGENT-052', {
      structuredOutput: asking('unresolved', 'No data model exists, so I cannot proceed'),
    });

    const result = await runDepartment(
      deps(h, { departments: [{ ...OWNER_DEPARTMENT, stageId: 'SC-STAGE-052' }] }),
      department(),
      /* PRF-SMALL-CHANGE runs almost nothing, so nobody will ever produce it. */
      context(h, { plan: resolveApplicability('PRF-SMALL-CHANGE') }),
    );

    expect(result.outcome).toBe(DepartmentOutcome.FAILED);
    expect(result.reason).toContain('contradict each other');
    expect(h.store.listCanonIds(ARTIFACT_TYPES.OPEN_QUESTION)).toHaveLength(0);
  }, 60_000);

  it('canon no registered department produces is reported, not waited on', async () => {
    const h = setup();
    h.engine.script('SC-AGENT-052', {
      structuredOutput: asking('unresolved', 'No data model exists, so I cannot proceed'),
    });
    const result = await runDepartment(deps(h, { departments: [] }), department(), context(h));
    expect(result.outcome).toBe(DepartmentOutcome.FAILED);
    expect(result.reason).toContain('no registered department produces');
  }, 60_000);
});

describe('F. a route survives the process that made it', () => {
  it('a reopened Store finds the obligation and does not raise a second', async () => {
    const h = setup();
    h.engine.script('SC-AGENT-060', {
      structuredOutput: asking('escalations', 'What do competitors in this market offer?'),
    });

    const gateway = { store: h.store, clock: h.clock, ids: h.ids, retriever: OFFLINE_RETRIEVER };
    const researchDept = department({
      id: 'DEPT-RESEARCH-ASKING',
      stageId: 'SC-STAGE-013',
      agentId: 'SC-AGENT-060',
      usesResearchGateway: true,
    });

    await runDepartment(
      deps(h, { enabled: ['SC-AGENT-060'] }),
      researchDept,
      context(h, { gateway }),
    );
    expect(h.store.listCanonIds(ARTIFACT_TYPES.RESEARCH_REQUEST)).toHaveLength(1);

    /* --- a fresh process, which has seen none of it --- */
    const clock2 = new FixedClock();
    const reopened = Store.open(h.root, { clock: clock2, ids: h.ids, actor: 'ROUTING_TEST_2' });
    const engine2 = new FakeEngineAdapter({ clock: clock2 });
    engine2.script('SC-AGENT-060', {
      structuredOutput: asking('escalations', 'What do competitors in this market offer?'),
    });
    const h2: Harness = { ...h, store: reopened, clock: clock2, engine: engine2 };

    const second = await runDepartment(
      deps(h2, { enabled: ['SC-AGENT-060'] }),
      researchDept,
      context(h2, {
        store: reopened,
        gateway: { store: reopened, clock: clock2, ids: h.ids, retriever: OFFLINE_RETRIEVER },
      }),
    );

    /* The obligation is found, not recreated. */
    expect(reopened.listCanonIds(ARTIFACT_TYPES.RESEARCH_REQUEST)).toHaveLength(1);
    expect(reopened.listCanonIds(ARTIFACT_TYPES.OPEN_QUESTION)).toHaveLength(1);
    expect(second.reason).toContain('already settled or outstanding');
  }, 60_000);
});

describe('G. the field-choice invariant holds through the runner', () => {
  it('the same question in either field produces the same operational route', async () => {
    const QUESTION = 'No data model exists, so I cannot say where a reservation is stored';
    const OWNER_DEPARTMENT = {
      id: 'DEPT-DATA',
      stageId: 'SC-STAGE-021',
      produces: [ARTIFACT_TYPES.DATA_MODEL],
    };

    const outcomes: string[] = [];
    for (const field of ['escalations', 'unresolved'] as const) {
      const h = setup();
      h.engine.script('SC-AGENT-052', { structuredOutput: asking(field, QUESTION) });
      const result = await runDepartment(
        deps(h, { departments: [OWNER_DEPARTMENT] }),
        department(),
        context(h),
      );
      outcomes.push(result.outcome);

      const [q] = repository(h.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema).list();
      expect(q?.askedOf).toBe('UPSTREAM_DEPARTMENT');
      expect(q?.missingCanon).toBe(ARTIFACT_TYPES.DATA_MODEL);
      /* Only the provenance differs — which is what provenance is for. */
      expect(q?.sourceFields).toEqual([field]);
    }
    expect(outcomes[0]).toBe(outcomes[1]);
  }, 60_000);

  it('the same question in BOTH fields produces one obligation', async () => {
    const h = setup();
    const QUESTION = 'No data model exists, so I cannot say where a reservation is stored';
    h.engine.script('SC-AGENT-052', {
      structuredOutput: envelope(
        { note: 'unused' },
        {
          status: 'ESCALATED',
          escalations: [{ condition: 'AMBIGUITY', detail: QUESTION, blocking: true }],
          unresolved: [QUESTION],
        },
      ),
    });

    await runDepartment(
      deps(h, {
        departments: [
          { id: 'DEPT-DATA', stageId: 'SC-STAGE-021', produces: [ARTIFACT_TYPES.DATA_MODEL] },
        ],
      }),
      department(),
      context(h),
    );

    const questions = repository(h.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema).list();
    expect(questions).toHaveLength(1);
    expect([...(questions[0]?.sourceFields ?? [])].sort()).toEqual(['escalations', 'unresolved']);
  }, 60_000);
});
