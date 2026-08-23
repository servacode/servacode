import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_TYPES, repository } from '../src/intelligence/repository.js';
import {
  QuestionRouting,
  normalizeOpenQuestions,
  questionKey,
} from '../src/intelligence/execution/questions.js';
import { OwnerDecisionRequestSchema } from '../src/intelligence/artifacts/governance.js';
import { ProjectGoalSchema } from '../src/intelligence/artifacts/framing.js';
import { cleanup, freshStore } from './helpers.js';
import type { Store, StoreDeps } from '../src/store/store.js';

/**
 * MODEL FIELD CHOICE MUST NOT CONTROL GOVERNANCE.
 *
 * Three live runs found three versions of one mistake: Serva routing on how an agent
 * chose to describe its own failure — the `blocking` flag, then the terminal status, then
 * which of two envelope fields it filed a question in. Each fix widened an enumeration,
 * and the next run found the case the enumeration had missed.
 *
 * These tests are about the property that replaced the enumeration: the same question
 * routes the same way regardless of how it arrives, and where it routes is decided from
 * the Store rather than from the sentence.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const WORK_ITEM = 'SC-WI-000990';

function setup(): { store: Store; deps: StoreDeps } {
  const { store, root, deps } = freshStore();
  roots.push(root);
  return { store, deps };
}

/** The normaliser's inputs, with everything but the question held constant. */
function normalize(
  f: { store: Store },
  o: {
    escalations?: readonly { condition: string; detail: string }[];
    unresolved?: readonly string[];
    produces?: readonly string[];
    canResearch?: boolean;
    runId?: string;
  },
) {
  return normalizeOpenQuestions({
    escalations: o.escalations ?? [],
    unresolved: o.unresolved ?? [],
    store: f.store,
    workItemId: WORK_ITEM,
    produces: o.produces ?? [],
    canResearch: o.canResearch ?? false,
    ...(o.runId === undefined ? {} : { runId: o.runId }),
  });
}

/** An answered owner decision, as `answerOwnerDecision` would leave it. */
function answeredDecision(f: { store: Store; deps: StoreDeps }, question: string): string {
  const at = f.deps.clock.now();
  const id = f.deps.ids.next('SC-ODR');
  const tx = f.store.begin();
  repository(f.store, ARTIFACT_TYPES.OWNER_DECISION_REQUEST, OwnerDecisionRequestSchema).put(tx, {
    id,
    createdAt: at,
    question,
    whyServaCannotDecide: 'It is a business policy.',
    purpose: 'SPECIFICATION_GAP',
    responseMode: 'VALUE',
    valueKind: 'TEXT',
    options: [],
    recommendation: 'Answer it in your own words',
    recommendationRationale: 'the work is stopped until you do',
    blocksWork: true,
    state: 'ANSWERED',
    answerValue: '48 hours',
    answeredBy: 'owner@bakery',
    answeredAt: at,
    meta: {
      provenance: { marking: 'SYSTEM', component: 'test' },
      attribution: { at },
      workItemId: WORK_ITEM,
    },
  } as never);
  tx.commit();
  return id;
}

describe('the field a question arrives in does not decide anything', () => {
  const QUESTION = 'The reservation hold duration is not specified anywhere in the brief';

  it('1. a question only in escalations is routed', () => {
    const f = setup();
    const [q] = normalize(f, {
      escalations: [{ condition: 'INSUFFICIENT_CONTEXT', detail: QUESTION }],
    });
    expect(q?.routing).toBe(QuestionRouting.OWNER_DECISION);
    expect(q?.sources).toEqual(['escalations']);
  });

  it('2. the same question only in unresolved routes identically', () => {
    const f = setup();
    const [viaEscalation] = normalize(f, {
      escalations: [{ condition: 'INSUFFICIENT_CONTEXT', detail: QUESTION }],
    });
    const [viaUnresolved] = normalize(f, { unresolved: [QUESTION] });

    expect(viaUnresolved?.routing).toBe(viaEscalation?.routing);
    expect(viaUnresolved?.key).toBe(viaEscalation?.key);
    /* Only the provenance differs, which is what provenance is for. */
    expect(viaUnresolved?.sources).toEqual(['unresolved']);
  });

  it('3. the same question in both fields is one obligation, not two', () => {
    const f = setup();
    const questions = normalize(f, {
      escalations: [{ condition: 'INSUFFICIENT_CONTEXT', detail: QUESTION }],
      unresolved: [QUESTION],
    });

    expect(questions).toHaveLength(1);
    /* And it remembers that the run said it twice. */
    expect([...(questions[0]?.sources ?? [])].sort()).toEqual(['escalations', 'unresolved']);
  });

  it('near-identical phrasings collapse to one question', () => {
    /*
     * "How long is a reservation held?" and "Reservation hold duration is not specified"
     * are the same question asked twice. The key is deliberately crude: merging two
     * genuinely different questions is worse than asking one twice.
     */
    expect(questionKey('How long is a reservation held?')).toBe(
      questionKey('reservation held — how long?'),
    );
    expect(questionKey('What is the deposit?')).not.toBe(questionKey('What is the hold time?'));
  });
});

describe('where a question routes is decided from the Store', () => {
  it('4. one the Store already answers does not reach the owner', () => {
    const f = setup();
    const at = f.deps.clock.now();
    const goalId = f.deps.ids.next('SC-GOAL');
    const tx = f.store.begin();
    repository(f.store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).put(tx, {
      id: goalId,
      createdAt: at,
      statement: 'Stop losing phone orders',
      successIndicator: 'no order lost in a fortnight',
      priority: 'MUST',
      meta: { provenance: { marking: 'OWNER_STATED', statedAt: at }, attribution: { at } },
    } as never);
    tx.commit();

    const [q] = normalize(f, {
      unresolved: ['I was not shown ' + goalId + ', so I could not check the success indicator'],
    });

    expect(q?.routing).toBe(QuestionRouting.EXISTING_STORE_FACT);
    expect(q?.why).toContain(goalId);
  });

  it('5. one about the outside world goes to research, not the owner', () => {
    const f = setup();
    const [q] = normalize(f, {
      unresolved: ['What do competitors in this market typically offer for collection?'],
      canResearch: true,
    });
    expect(q?.routing).toBe(QuestionRouting.RESEARCH);
  });

  it('a market question with no research capability is NOT routed to research', () => {
    const f = setup();
    const [q] = normalize(f, {
      unresolved: ['What do competitors in this market typically offer for collection?'],
      canResearch: false,
    });
    /* Serva cannot retrieve here, so it does not pretend it will. */
    expect(q?.routing).toBe(QuestionRouting.OWNER_DECISION);
  });

  it('a money question stays with the owner even when it mentions the market', () => {
    const f = setup();
    const [q] = normalize(f, {
      unresolved: ['What deposit should we charge? Competitors in this market charge 10%.'],
      canResearch: true,
    });
    /*
     * Serva may find out what others charge. It may not decide what this shop charges, and
     * the owner-reserved rule is checked first for exactly that reason.
     */
    expect(q?.routing).toBe(QuestionRouting.OWNER_DECISION);
  });

  it('one about canon another department owes goes upstream', () => {
    const f = setup();
    const [q] = normalize(f, {
      unresolved: ['No data model exists, so I cannot say where a reservation is stored'],
      produces: [ARTIFACT_TYPES.FLOW],
    });
    expect(q?.routing).toBe(QuestionRouting.UPSTREAM_DEPARTMENT);
    expect(q?.why).toContain('has not run');
  });

  it('a department is not sent upstream for canon it writes itself', () => {
    const f = setup();
    const [q] = normalize(f, {
      unresolved: ['No data model exists, so I cannot say where a reservation is stored'],
      /* This department owes the data model; the question is its own work. */
      produces: [ARTIFACT_TYPES.DATA_MODEL],
    });
    expect(q?.routing).toBe(QuestionRouting.OWNER_DECISION);
  });

  it('6. a genuine owner question reaches the owner', () => {
    const f = setup();
    for (const text of [
      'Is a deposit required at reservation, or is payment on collection?',
      'What is the budget ceiling for the first release?',
      'Which of these should we prioritise?',
    ]) {
      const [q] = normalize(f, { unresolved: [text] });
      expect(q?.routing, text).toBe(QuestionRouting.OWNER_DECISION);
    }
  });

  it('anything not demonstrably somebody else’s defaults to the owner', () => {
    const f = setup();
    const [q] = normalize(f, {
      unresolved: ['Should a customer be able to reserve more than one copy at a time?'],
    });
    /*
     * No canon answers it, no research would, and no department owes it. The default is
     * to ask, because the alternative to asking is guessing.
     */
    expect(q?.routing).toBe(QuestionRouting.OWNER_DECISION);
    expect(q?.why).toContain('may not invent it');
  });
});

describe('provenance and restart', () => {
  it('7. a question keeps its originating run and its source fields', () => {
    const f = setup();
    const [q] = normalize(f, {
      escalations: [{ condition: 'AMBIGUITY', detail: 'Is a deposit required at reservation?' }],
      unresolved: ['Is a deposit required at reservation?'],
      runId: 'SC-RUN-000042',
    });

    expect(q?.runId).toBe('SC-RUN-000042');
    expect([...(q?.sources ?? [])].sort()).toEqual(['escalations', 'unresolved']);
    expect(q?.condition).toBe('AMBIGUITY');
    /* The routing decision is stated, not just made. */
    expect(q?.why.length).toBeGreaterThan(10);
  });

  it('8. a restart does not re-ask a question the owner has answered', () => {
    const f = setup();
    const decisionId = answeredDecision(
      f,
      'How long is a reservation held before it returns to sale?',
    );

    /* The department runs again and raises the same question, phrased its own way. */
    const [q] = normalize(f, {
      unresolved: ['How long is a reservation held before it returns to sale?'],
    });

    expect(q?.routing).toBe(QuestionRouting.ALREADY_ANSWERED);
    expect(q?.answeredBy).toBe(decisionId);
  });

  it('a question already OPEN with the owner is not asked twice', () => {
    const f = setup();
    const at = f.deps.clock.now();
    const id = f.deps.ids.next('SC-ODR');
    const tx = f.store.begin();
    repository(f.store, ARTIFACT_TYPES.OWNER_DECISION_REQUEST, OwnerDecisionRequestSchema).put(tx, {
      id,
      createdAt: at,
      question: 'Is a deposit required at reservation?',
      whyServaCannotDecide: 'It is a commercial policy.',
      purpose: 'SPECIFICATION_GAP',
      responseMode: 'VALUE',
      valueKind: 'TEXT',
      options: [],
      recommendation: 'Answer it in your own words',
      recommendationRationale: 'the work is stopped until you do',
      blocksWork: true,
      state: 'OPEN',
      meta: {
        provenance: { marking: 'SYSTEM', component: 'test' },
        attribution: { at },
        workItemId: WORK_ITEM,
      },
    } as never);
    tx.commit();

    const [q] = normalize(f, { unresolved: ['Is a deposit required at reservation?'] });
    expect(q?.routing).toBe(QuestionRouting.ALREADY_ANSWERED);
    expect(q?.why).toContain('already open');
  });
});
