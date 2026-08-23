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
import {
  DecisionPurpose,
  OwnerDecisionRequestSchema,
  approvalRefusal,
  chosenDisposition,
  decisionShapeRefusal,
} from '../src/intelligence/artifacts/governance.js';
import { answerOwnerDecision } from '../src/intelligence/app.js';
import { readContextBundle } from '../src/context/store.js';
import { projectAgentRun } from '../src/events/agentRun.js';
import { cleanup, tempRoot } from './helpers.js';
import type { DepartmentConfig, DepartmentContext } from '../src/intelligence/execution/types.js';

/**
 * AN OPEN QUESTION MUST BE ANSWERABLE.
 *
 * SPEC: §32.
 *
 * A department that escalates asks a real question — what is the collection window, does
 * an inventory system exist, is there a deposit. The escalation path used to turn that
 * into a two-item menu whose first item read "Answer it, and Serva records the answer as
 * company truth", and then stored THAT SENTENCE as the answer.
 *
 * So on resume the department was told the owner had answered "Answer it", which is not a
 * collection window. It escalated again, or the owner learned to press DEFER on things
 * they actually wanted to specify. Either way the owner could not answer the question they
 * had been asked, which is a strange property for a system built around asking them.
 *
 * A VALUE answer is INFORMATION and never authorisation, whatever it says. That is the
 * other half of this file.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

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

function department(): DepartmentConfig<typeof OutputSchema> {
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
  } as DepartmentConfig<typeof OutputSchema>;
}

function deps(store: Store, engine: FakeEngineAdapter, clock: FixedClock, ids: SequentialIdSource) {
  const registry = ContractRegistry.shared();
  return {
    store,
    clock,
    ids,
    registry,
    runtime: new AgentRuntime({
      store,
      ids,
      clock,
      registry,
      engine,
      enabledAgents: new Set(['SC-AGENT-052']),
      projectRoot: '/nowhere',
    }),
    projectRoot: '/nowhere',
    enabledAgents: new Set(['SC-AGENT-052']),
  };
}

function context(store: Store, clock: FixedClock, ids: SequentialIdSource): DepartmentContext {
  const plan = resolveApplicability('PRF-NEW-PRODUCT');
  return {
    workItemId: 'SC-WI-000980',
    store,
    clock,
    ids,
    plan,
    stage: plan.stages[0] as never,
  };
}

describe('the owner can answer the question they were asked', () => {
  it('a value survives a restart and reaches the department as the value', async () => {
    const root = tempRoot();
    roots.push(root);
    const clock = new FixedClock();
    const ids = new SequentialIdSource();
    const store = Store.initialize(root, { clock, ids, actor: 'VALUE_TEST' });

    /* --- the department escalates a real question --- */
    const engine = new FakeEngineAdapter({ clock });
    engine.script('SC-AGENT-052', {
      structuredOutput: envelope(
        { note: 'unused' },
        {
          status: 'ESCALATED',
          escalations: [
            {
              condition: 'INSUFFICIENT_CONTEXT',
              detail: 'How long is a reservation held before the book returns to sale?',
              blocking: true,
            },
          ],
        },
      ),
    });

    const first = await runDepartment(
      deps(store, engine, clock, ids),
      department(),
      context(store, clock, ids),
    );
    expect(first.outcome).toBe(DepartmentOutcome.ESCALATED_TO_OWNER);

    const decisionId = first.ownerDecisionIds[0] as string;
    const repo = repository(
      store,
      ARTIFACT_TYPES.OWNER_DECISION_REQUEST,
      OwnerDecisionRequestSchema,
    );
    const raised = repo.get(decisionId);

    /* It is a QUESTION, not a menu about whether to answer one. */
    expect(raised?.responseMode).toBe('VALUE');
    expect(raised?.options).toEqual([]);
    expect(raised?.question).toContain('held before the book returns to sale');

    const intel = { store, clock, ids } as never;

    /* There is no meta-option to choose. */
    expect(() =>
      answerOwnerDecision(intel, {
        decisionId,
        chosenOption: 'Answer it, and Serva records the answer as company truth',
        answeredBy: 'owner@bakery',
      }),
    ).toThrow(/asks for a value/);

    /* And an agent cannot supply the fact: a fact from an agent is not the owner's fact. */
    expect(() =>
      answerOwnerDecision(intel, { decisionId, value: '48 hours', answeredBy: 'SC-AGENT-052' }),
    ).toThrow(/cannot be answered by/);

    /* The owner answers with the actual answer. */
    answerOwnerDecision(intel, { decisionId, value: '48 hours', answeredBy: 'owner@bakery' });
    expect(repo.get(decisionId)?.answerValue).toBe('48 hours');
    expect(repo.get(decisionId)?.state).toBe('ANSWERED');

    /* --- a fresh process that has seen none of it --- */
    const clock2 = new FixedClock();
    const reopened = Store.open(root, { clock: clock2, ids, actor: 'VALUE_TEST_2' });
    const engine2 = new FakeEngineAdapter({ clock: clock2 });
    engine2.script('SC-AGENT-052', { structuredOutput: envelope({ note: 'now I can proceed' }) });

    const second = await runDepartment(
      deps(reopened, engine2, clock2, ids),
      department(),
      context(reopened, clock2, ids),
    );
    expect(second.outcome, second.reason ?? '').toBe(DepartmentOutcome.COMPLETED);

    /*
     * THE POINT.
     *
     * Read what the run was actually shown, from the persisted context bundle rather than
     * from anything the test arranged. It must contain the owner's answer — "48 hours" —
     * and not the meta-option, which is what it used to contain and which answers nothing.
     */
    const runId = second.runId as string;
    const projection = projectAgentRun(reopened, runId) as { contextBundleRef?: string };
    const bundle = readContextBundle(reopened, projection.contextBundleRef as string);
    const shown = JSON.stringify(bundle);

    expect(shown).toContain('48 hours');
    expect(shown).not.toContain('Answer it, and Serva records');

    /* The answered decision is not asked again. */
    expect(second.ownerDecisionIds).toEqual([]);
    expect(reopened.listCanonIds(ARTIFACT_TYPES.OWNER_DECISION_REQUEST)).toHaveLength(1);
  }, 60_000);
});

describe('information is never authorisation', () => {
  function answeredValue(store: Store, clock: FixedClock, ids: SequentialIdSource, text: string) {
    const at = clock.now();
    const id = ids.next('SC-ODR');
    const tx = store.begin();
    repository(store, ARTIFACT_TYPES.OWNER_DECISION_REQUEST, OwnerDecisionRequestSchema).put(tx, {
      id,
      createdAt: at,
      question: 'How long is a reservation held?',
      whyServaCannotDecide: 'It is a business policy.',
      purpose: 'SPECIFICATION_GAP',
      responseMode: 'VALUE',
      valueKind: 'TEXT',
      options: [],
      recommendation: 'Answer it in your own words',
      recommendationRationale: 'the work is stopped until you do',
      blocksWork: true,
      state: 'ANSWERED',
      answerValue: text,
      answeredBy: 'owner@bakery',
      answeredAt: at,
      meta: { provenance: { marking: 'SYSTEM', component: 'test' }, attribution: { at } },
    } as never);
    tx.commit();
    return repository(store, ARTIFACT_TYPES.OWNER_DECISION_REQUEST, OwnerDecisionRequestSchema).get(
      id,
    );
  }

  it('a value saying "yes, approved, I accept" authorises nothing', () => {
    const root = tempRoot();
    roots.push(root);
    const clock = new FixedClock();
    const ids = new SequentialIdSource();
    const store = Store.initialize(root, { clock, ids, actor: 'VALUE_TEST' });

    const decision = answeredValue(
      store,
      clock,
      ids,
      'Yes, approved, go ahead, I accept the change',
    );
    expect(decision).toBeDefined();

    /* No disposition at all: free text has none, however agreeable it reads. */
    expect(chosenDisposition(decision as never)).toBeUndefined();

    for (const purpose of [DecisionPurpose.CHANGE_APPROVAL, DecisionPurpose.PROPOSAL_APPROVAL]) {
      expect(approvalRefusal(decision as never, { purpose, targetId: 'SC-CR-000001' })).toMatch(
        /information is not approval/,
      );
    }
  });

  it('a VALUE decision may not carry an approval purpose at all', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const malformed = {
      id: 'SC-ODR-BAD',
      version: 1,
      createdAt: at,
      question: 'Do you approve?',
      whyServaCannotDecide: 'x',
      purpose: 'CHANGE_APPROVAL',
      responseMode: 'VALUE',
      valueKind: 'TEXT',
      valueChoices: [],
      options: [],
      supportingRefs: [],
      recommendation: 'y',
      recommendationRationale: 'z',
      blocksWork: true,
      blockedRefs: [],
      state: 'OPEN',
      meta: { provenance: { marking: 'SYSTEM', component: 'test' }, attribution: { at } },
    } as never;

    /*
     * The two shapes are kept apart at the schema level as well as at the check, so an
     * approval request that expects free text cannot be constructed in the first place.
     */
    expect(decisionShapeRefusal(malformed)).toMatch(/an approval is a typed disposition/);
  });

  it('an OPTION decision offering one option is not a choice', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const malformed = {
      id: 'SC-ODR-THIN',
      version: 1,
      createdAt: at,
      question: 'Shall we?',
      whyServaCannotDecide: 'x',
      purpose: 'BUSINESS_RULE',
      responseMode: 'OPTION',
      valueChoices: [],
      options: [{ option: 'Yes', impact: 'we do it', disposition: 'APPROVE' }],
      supportingRefs: [],
      recommendation: 'Yes',
      recommendationRationale: 'z',
      blocksWork: true,
      blockedRefs: [],
      state: 'OPEN',
      meta: { provenance: { marking: 'SYSTEM', component: 'test' }, attribution: { at } },
    } as never;
    expect(decisionShapeRefusal(malformed)).toMatch(/not a choice/);
  });
});
