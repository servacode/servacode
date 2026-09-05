import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ARTIFACT_TYPES, repository } from '../src/intelligence/repository.js';
import {
  QuestionRouting,
  normalizeOpenQuestions,
  questionKey,
} from '../src/intelligence/execution/questions.js';
import { OwnerDecisionRequestSchema } from '../src/intelligence/artifacts/governance.js';
import { OpenQuestionSchema, ProjectGoalSchema } from '../src/intelligence/artifacts/framing.js';
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
/*
 * The department these questions belong to, and the agent that writes for it.
 *
 * SPEC: findings OLER-CTX-1 (HIGH) / OLER-CTX-2 (MEDIUM), 1.0.1 security review.
 *
 * A question raised by the runner always carries `raisedBy` and an attribution naming the
 * department's agent. These fixtures carried neither, so they described artifacts the
 * legitimate path cannot produce — and no test here could have noticed that an unattributed
 * OpenQuestion was being trusted, because every fixture was unattributed.
 */
const DEPARTMENT = 'DEPT-PRODUCT';
const AGENT = 'SC-AGENT-030';

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
    departmentId?: string;
    agentId?: string;
  },
) {
  return normalizeOpenQuestions({
    escalations: o.escalations ?? [],
    unresolved: o.unresolved ?? [],
    store: f.store,
    workItemId: WORK_ITEM,
    departmentId: o.departmentId ?? DEPARTMENT,
    agentId: o.agentId ?? AGENT,
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

describe('a department cannot decide that the owner has already decided', () => {
  /*
   * SPEC: finding ORGANIZATIONAL-LEARNING-EXECUTION-AND-RESEARCH/SEC-1 (HIGH), 1.0.1 review.
   *
   * `normalizeOpenQuestions` builds ONE map, `answeredByKey`, from TWO writers. The first —
   * owner decisions — was hardened to require `isAuthoritativeOwnerAnswer` and a matching work
   * item, and carries a comment saying so. The second, twenty lines below it, wrote into the
   * same map from any ANSWERED or WITHDRAWN OpenQuestion with neither check.
   *
   * `OPEN_QUESTION` is UNIVERSAL in authority.ts, so any department may write one, and
   * ALREADY_ANSWERED is evaluated BEFORE the OWNER_RESERVED rule. So a department could
   * pre-write a self-attributed ANSWERED OpenQuestion whose text keys to a money, policy or
   * scope question, and the owner was never asked — an agent deciding, on the strength of its
   * own record, that the owner had decided.
   *
   * The guard reached one writer and not the other: the same map, the same routing decision,
   * by a different road.
   */
  function settledByDepartment(f: { store: Store; deps: StoreDeps }, question: string): string {
    const id = f.deps.ids.next('SC-OQ');
    const tx = f.store.begin();
    repository(f.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema).put(tx, {
      id,
      createdAt: f.deps.clock.now(),
      question,
      blocks: [],
      askedOf: 'OWNER',
      state: 'ANSWERED',
      answer: 'the department recorded this as settled',
      raisedBy: DEPARTMENT,
      resolvedByRefs: [{ id: 'SC-ANY-000001' }],
      sourceFields: [],
      meta: {
        provenance: { marking: 'SYSTEM', component: 'a department' },
        attribution: { at: f.deps.clock.now(), agentId: AGENT },
        workItemId: WORK_ITEM,
      },
    } as never);
    tx.commit();
    return id;
  }

  it('an ANSWERED OpenQuestion does not close an owner-reserved question', () => {
    const f = setup();
    const question = 'What is the monthly budget for the payment provider?';
    settledByDepartment(f, question);

    const [q] = normalize(f, { unresolved: [question] });

    expect(
      q?.routing,
      'a department record must not answer a money question on the owner behalf',
    ).not.toBe(QuestionRouting.ALREADY_ANSWERED);
  });

  it('the same holds across the reserved vocabulary', () => {
    /*
     * OBSERVED WHILE WRITING THIS, and deliberately left alone: OWNER_RESERVED covers money,
     * policy, legal, brand, deadline, priority and trade-offs — but not the word "scope". A
     * question phrased purely as scope, carrying none of the reserved vocabulary, is not
     * treated as reserved, so a department may settle it.
     *
     * That is a question about the VOCABULARY rather than about this authority fix, and
     * widening it would newly route a large class of questions to the owner — a product
     * behaviour change well beyond the finding being closed here. Recorded, not quietly
     * patched.
     */
    for (const question of [
      'Which refund policy should apply to cancelled orders?',
      'What is the deadline for the launch?',
      'Which trade-off do you prefer for the brand?',
    ]) {
      const f = setup();
      settledByDepartment(f, question);
      const [q] = normalize(f, { unresolved: [question] });
      expect(q?.routing, question).not.toBe(QuestionRouting.ALREADY_ANSWERED);
    }
  });

  it('an ordinary question it settled is still not asked twice', () => {
    /*
     * The fix must not make the bookkeeping useless. Surviving a restart is what this map is
     * for, and everything the owner does not own still settles normally.
     */
    const f = setup();
    const question = 'Which logging library does this repository already use?';
    const id = settledByDepartment(f, question);

    const [q] = normalize(f, { unresolved: [question] });

    expect(q?.routing).toBe(QuestionRouting.ALREADY_ANSWERED);
    expect(q?.answeredBy).toBe(id);
  });

  it('an owner decision still closes an owner-reserved question', () => {
    /* The authoritative path is untouched: this is about who may settle, not about whether. */
    const f = setup();
    const question = 'What is the monthly budget for the payment provider?';
    const decisionId = answeredDecision(f, question);

    const [q] = normalize(f, { unresolved: [question] });

    expect(q?.routing).toBe(QuestionRouting.ALREADY_ANSWERED);
    expect(q?.answeredBy).toBe(decisionId);
  });

  it('a question settled under another work item says nothing about this one', () => {
    /*
     * The decisions loop filters by work item and this one did not, so a settlement recorded
     * anywhere in the store suppressed a question everywhere in it.
     */
    const f = setup();
    const question = 'Which logging library does this repository already use?';
    const id = f.deps.ids.next('SC-OQ');
    const tx = f.store.begin();
    repository(f.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema).put(tx, {
      id,
      createdAt: f.deps.clock.now(),
      question,
      blocks: [],
      askedOf: 'RESEARCH',
      state: 'ANSWERED',
      answer: 'pino',
      resolvedByRefs: [],
      sourceFields: [],
      meta: {
        provenance: { marking: 'SYSTEM', component: 'a department' },
        attribution: { at: f.deps.clock.now() },
        workItemId: 'SC-WI-999999',
      },
    } as never);
    tx.commit();

    const [q] = normalize(f, { unresolved: [question] });
    expect(q?.routing).not.toBe(QuestionRouting.ALREADY_ANSWERED);
  });
});

describe('an owner-reserved question is only suppressed by something that asks the owner', () => {
  /*
   * SPEC: findings SEC-1 and OLER-1 (both HIGH), 1.0.1 security review.
   *
   * SEC-1 reported that ALREADY_ANSWERED ran before OWNER_RESERVED, so a department's own
   * record could close a money question. That was fixed. OLER-1 then reported the same defect
   * one branch across: ALREADY_ROUTED also runs before OWNER_RESERVED, and `outstanding` is
   * filled from any OPEN OpenQuestion — UNIVERSAL canon any department may write. Parking a
   * money question with RESEARCH made the owner's question ALREADY_ROUTED: not answered
   * falsely, simply never asked.
   *
   * Two findings, one cause, because the first fix addressed the reported branch instead of
   * the class. This suite tests the RULE across every branch that can suppress:
   *
   *   an owner-reserved question may only be suppressed by something that puts it in front of
   *   the owner.
   *
   * A new suppressing branch added later, with no owner-facing check, fails here.
   */
  const MONEY = 'What is the monthly budget for the payment provider?';

  function openQuestion(
    f: { store: Store; deps: StoreDeps },
    o: {
      question: string;
      askedOf: string;
      state: string;
      raisedBy?: string;
      agentId?: string;
    },
  ): string {
    const id = f.deps.ids.next('SC-OQ');
    const tx = f.store.begin();
    repository(f.store, ARTIFACT_TYPES.OPEN_QUESTION, OpenQuestionSchema).put(tx, {
      id,
      createdAt: f.deps.clock.now(),
      question: o.question,
      blocks: [],
      askedOf: o.askedOf,
      state: o.state,
      ...(o.state === 'ANSWERED' ? { answer: 'a department wrote this' } : {}),
      raisedBy: o.raisedBy ?? DEPARTMENT,
      resolvedByRefs: o.state === 'ANSWERED' ? [{ id: 'SC-ANY-000001' }] : [],
      sourceFields: [],
      meta: {
        provenance: { marking: 'SYSTEM', component: 'a department' },
        attribution: { at: f.deps.clock.now(), agentId: o.agentId ?? AGENT },
        workItemId: WORK_ITEM,
      },
    } as never);
    tx.commit();
    return id;
  }

  it('a question forged under another department cannot suppress a real one', () => {
    /*
     * SPEC: finding OLER-CTX-2 (MEDIUM), 1.0.1 security review — sibling of OLER-CTX-1.
     *
     * OPEN_QUESTION is UNIVERSAL: any department may write one. The bookkeeping that stops a
     * question being asked twice keyed only on the question TEXT, so a department could
     * persist an ANSWERED question whose key collides with another department's real need and
     * that need would be routed ALREADY_ANSWERED — never asked, never fulfilled, with no
     * obligation behind it.
     *
     * Same artifact, same text, written under somebody else's identity: it must not settle
     * anything here.
     */
    const f = setup();
    const NEED = 'The reservation hold duration is not specified anywhere in the brief';
    openQuestion(f, {
      question: NEED,
      askedOf: 'RESEARCH',
      state: 'ANSWERED',
      raisedBy: 'DEPT-SOMEBODY-ELSE',
      agentId: 'SC-AGENT-999',
    });

    const out = normalize(f, { escalations: [{ condition: 'blocked', detail: NEED }] });
    expect(out).toHaveLength(1);
    expect(out[0]?.routing, 'a forged settlement must not answer this').not.toBe(
      QuestionRouting.ALREADY_ANSWERED,
    );
  });

  it("a department's own authentic settlement still suppresses, as it must", () => {
    /*
     * The other half: the guard must not break the thing the bookkeeping exists for. A real
     * settlement — raised by this department, attributed to its agent, naming the canon that
     * discharged it — still stops the question being raised twice across a restart.
     */
    const f = setup();
    /* Deliberately NOT owner-reserved text: that is settled by the owner and nobody else. */
    const NEED = 'The reservation hold duration is not specified anywhere in the brief';
    openQuestion(f, { question: NEED, askedOf: 'RESEARCH', state: 'ANSWERED' });

    const out = normalize(f, { escalations: [{ condition: 'blocked', detail: NEED }] });
    expect(out).toHaveLength(1);
    expect(out[0]?.routing).toBe(QuestionRouting.ALREADY_ANSWERED);
  });

  it('an obligation parked with RESEARCH does not discharge an owner question', () => {
    const f = setup();
    openQuestion(f, { question: MONEY, askedOf: 'RESEARCH', state: 'OPEN' });

    const [q] = normalize(f, { unresolved: [MONEY] });

    expect(
      q?.routing,
      'parking a money question with research does not end with the owner being asked',
    ).not.toBe(QuestionRouting.ALREADY_ROUTED);
  });

  it('nor one parked with an expert or another department', () => {
    for (const askedOf of ['EXPERT', 'UPSTREAM_DEPARTMENT']) {
      const f = setup();
      openQuestion(f, { question: MONEY, askedOf, state: 'OPEN' });
      const [q] = normalize(f, { unresolved: [MONEY] });
      expect(q?.routing, askedOf).not.toBe(QuestionRouting.ALREADY_ROUTED);
    }
  });

  it('nor one a department addressed TO the owner — that is not the owner seeing it', () => {
    /*
     * REVERSED, because the assertion it replaced was the bypass.
     *
     * SPEC: finding OLER-ROUTE-1 (MEDIUM), 1.0.1 review.
     *
     * This used to expect ALREADY_ROUTED, on the reasoning that a question owed BY the owner
     * is already with them. That property was invented. The owner's surface —
     * `serva intelligence decisions` and `projectSnapshot` — reads OWNER_DECISION_REQUEST and
     * nothing else, and OPEN_QUESTION is shown to nobody. A department writing
     * `askedOf: 'OWNER'` therefore suppressed the question without it ever reaching anyone.
     *
     * The test was asserting my description of the mechanism instead of the mechanism.
     */
    const f = setup();
    openQuestion(f, { question: MONEY, askedOf: 'OWNER', state: 'OPEN' });

    const [q] = normalize(f, { unresolved: [MONEY] });

    expect(
      q?.routing,
      'an OpenQuestion addressed to the owner is not a record the owner can read',
    ).toBe(QuestionRouting.OWNER_DECISION);
  });

  it('what reaches the owner is OWNER_DECISION_REQUEST, and nothing else does', () => {
    /*
     * The mechanism itself, so no future guard can be built on a claim about what the owner
     * sees without that claim being true. The owner surface is asserted at its source.
     */
    const surfaces = [
      readFileSync('src/cli/commands/intelligence.ts', 'utf8'),
      readFileSync('src/app/services.ts', 'utf8'),
    ];
    for (const src of surfaces) {
      const decisionsSection = src.slice(Math.max(0, src.indexOf('OWNER_DECISION_REQUEST') - 400));
      expect(decisionsSection).toContain('OWNER_DECISION_REQUEST');
    }
    /* And an OpenQuestion is not part of it. */
    for (const src of surfaces) {
      expect(
        src.includes('ARTIFACT_TYPES.OPEN_QUESTION'),
        'if the owner surface ever reads OpenQuestions, the suppression rule must be revisited',
      ).toBe(false);
    }
  });

  it('an ordinary question parked with research is still not raised twice', () => {
    /* The fix must not make the obligation bookkeeping useless for everything else. */
    const f = setup();
    const ordinary = 'Which logging library does this repository already use?';
    openQuestion(f, { question: ordinary, askedOf: 'RESEARCH', state: 'OPEN' });

    const [q] = normalize(f, { unresolved: [ordinary] });

    expect(q?.routing).toBe(QuestionRouting.ALREADY_ROUTED);
  });

  it('no suppressing branch closes an owner question without asking the owner', () => {
    /*
     * The class, asserted over every shape a department can write. Whatever a department
     * records about an owner-reserved question — settled, withdrawn, or parked with anyone
     * but the owner — that question must still reach OWNER_DECISION.
     */
    const departmentWritten = [
      { askedOf: 'RESEARCH', state: 'OPEN' },
      { askedOf: 'EXPERT', state: 'OPEN' },
      { askedOf: 'UPSTREAM_DEPARTMENT', state: 'OPEN' },
      { askedOf: 'OWNER', state: 'OPEN' },
      { askedOf: 'OWNER', state: 'ANSWERED' },
      { askedOf: 'RESEARCH', state: 'ANSWERED' },
      { askedOf: 'OWNER', state: 'WITHDRAWN' },
    ];

    for (const shape of departmentWritten) {
      const f = setup();
      openQuestion(f, { question: MONEY, ...shape });
      const [q] = normalize(f, { unresolved: [MONEY] });

      expect(
        q?.routing,
        JSON.stringify(shape) + ' suppressed a question reserved to the owner',
      ).toBe(QuestionRouting.OWNER_DECISION);
    }
  });
});
