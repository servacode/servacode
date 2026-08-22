import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_TYPES, repository } from '../src/intelligence/repository.js';
import { ProjectGoalSchema } from '../src/intelligence/artifacts/framing.js';
import { OwnerDecisionRequestSchema } from '../src/intelligence/artifacts/governance.js';
import {
  IMPACT_DIMENSIONS,
  analyseImpact,
  applyReentry,
  approveChange,
  completeChange,
  outstandingChanges,
  planReentry,
  raiseChangeRequest,
} from '../src/intelligence/change.js';
import {
  accept,
  assess,
  defer,
  incorporate,
  openProposals,
  propose,
  reject,
} from '../src/intelligence/proposals.js';
import {
  applyPattern,
  assessApplicability,
  contributeFailedApproach,
  contributeLesson,
  contributePattern,
  offerCandidate,
  patternUsageRefusal,
} from '../src/intelligence/learning.js';
import {
  ORCHESTRATOR_STATE_TYPE,
  OrchestratorRecordSchema,
  readOrchestratorRecord,
} from '../src/intelligence/execution/orchestrator.js';
import { readLedger } from '../src/lifecycle/stages.js';
import { cleanup, freshStore } from './helpers.js';
import type { Store } from '../src/store/store.js';
import type { StoreDeps } from '../src/store/store.js';

/**
 * GOVERNANCE OF WHAT HAPPENS AFTER THE FIRST PASS.
 *
 * A company that only works the first time through is not a company. These are the three
 * mechanisms that decide what happens to work already done: a change to it, an idea about
 * it, and what the next project is allowed to learn from it.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

/** The deps every runtime here takes, flattened so a test can pass `f` straight in. */
function setup(): {
  store: Store;
  clock: StoreDeps['clock'];
  ids: StoreDeps['ids'];
  deps: StoreDeps;
} {
  const { store, root, deps } = freshStore();
  roots.push(root);
  return { store, clock: deps.clock, ids: deps.ids, deps };
}

/** A goal, so an impact analysis has something real to point at. */
function seedGoal(store: Store, deps: StoreDeps): string {
  const at = deps.clock.now();
  const id = deps.ids.next('SC-GOAL');
  const tx = store.begin();
  repository(store, ARTIFACT_TYPES.PROJECT_GOAL, ProjectGoalSchema).put(tx, {
    id,
    createdAt: at,
    statement: 'Stop losing phone orders in the morning rush',
    priority: 'MUST',
    successIndicator: 'no order lost during a two-week observation',
    meta: {
      provenance: { marking: 'OWNER_STATED', statedAt: at },
      attribution: { at },
    },
  } as never);
  tx.commit();
  return id;
}

/** Every mandated dimension, assessed. The base a test then breaks deliberately. */
function fullDimensions(affected: readonly string[] = []): {
  dimension: string;
  verdict: 'AFFECTED' | 'NOT_AFFECTED';
  rationale: string;
  affectedRefs?: { id: string }[];
}[] {
  return IMPACT_DIMENSIONS.map((d) =>
    d === 'REQUIREMENTS'
      ? {
          dimension: d,
          verdict: 'AFFECTED' as const,
          rationale: 'the change alters what the product must do',
          affectedRefs: affected.map((id) => ({ id })),
        }
      : { dimension: d, verdict: 'NOT_AFFECTED' as const, rationale: 'nothing here depends on it' },
  );
}

/** A finished-looking orchestrator record, so re-entry has something to re-open. */
function seedRecord(store: Store, workItemId: string): void {
  const tx = store.begin();
  tx.putCanon(
    ORCHESTRATOR_STATE_TYPE,
    workItemId,
    OrchestratorRecordSchema.parse({
      workItemId,
      profileId: 'PRF-NEW-PRODUCT',
      state: 'COMPLETE',
      completedStages: [
        'SC-STAGE-002',
        'SC-STAGE-003',
        'SC-STAGE-004',
        'SC-STAGE-010',
        'SC-STAGE-011',
        'SC-STAGE-020',
        'SC-STAGE-024',
      ],
      ranStages: ['SC-STAGE-011', 'SC-STAGE-020', 'SC-STAGE-024'],
      gateResults: [
        { gateId: 'SC-GATE-INTAKE', verdict: 'PASS' },
        { gateId: 'SC-GATE-REQUIREMENTS', verdict: 'PASS' },
        { gateId: 'SC-GATE-ARCHITECTURE', verdict: 'PASS' },
      ],
      updatedAt: '2024-01-01T00:00:00.000Z',
    }),
  );
  tx.commit();
}

describe('a change is assessed before it is anything else', () => {
  it('an analysis that skips a dimension is refused, by name', () => {
    const f = setup();
    const cr = raiseChangeRequest(f, {
      origin: 'owner',
      description: 'also take orders by text message',
      magnitude: 'M2',
    });
    const partial = fullDimensions().filter((d) => d.dimension !== 'SECURITY');
    expect(() =>
      analyseImpact(f, {
        changeRequestId: cr.id,
        dimensions: partial,
        reentryStageId: 'SC-STAGE-011',
        assessedBy: 'SC-AGENT-040',
      }),
    ).toThrow(/SECURITY/);
  });

  it('a re-entry stage that is not a canonical stage is refused', () => {
    const f = setup();
    const cr = raiseChangeRequest(f, {
      origin: 'owner',
      description: 'text orders',
      magnitude: 'M2',
    });
    expect(() =>
      analyseImpact(f, {
        changeRequestId: cr.id,
        dimensions: fullDimensions(),
        reentryStageId: 'SC-STAGE-999',
        assessedBy: 'SC-AGENT-040',
      }),
    ).toThrow(/not a canonical stage/);
  });

  it('affected canon that does not exist is refused rather than silently dropped', () => {
    const f = setup();
    const cr = raiseChangeRequest(f, {
      origin: 'owner',
      description: 'text orders',
      magnitude: 'M2',
    });
    expect(() =>
      analyseImpact(f, {
        changeRequestId: cr.id,
        dimensions: fullDimensions(['SC-REQ-NOTHING']),
        reentryStageId: 'SC-STAGE-011',
        assessedBy: 'SC-AGENT-040',
      }),
    ).toThrow(/does not exist/);
  });

  it('a complete analysis records what re-entry will cost', () => {
    const f = setup();
    const goal = seedGoal(f.store, f.deps);
    const cr = raiseChangeRequest(f, {
      origin: 'owner',
      description: 'text orders',
      magnitude: 'M2',
    });
    const analysis = analyseImpact(f, {
      changeRequestId: cr.id,
      dimensions: fullDimensions([goal]),
      reentryStageId: 'SC-STAGE-011',
      assessedBy: 'SC-AGENT-040',
    });
    expect(analysis.dimensions).toHaveLength(IMPACT_DIMENSIONS.length);
    expect(analysis.reentryStageId).toBe('SC-STAGE-011');

    const plan = planReentry(f.store, {
      changeRequestId: cr.id,
      profileId: 'PRF-NEW-PRODUCT',
    });
    /* Everything from requirements onward re-runs; intake and discovery stand. */
    expect(plan.stagesToRerun[0]).toBe('SC-STAGE-011');
    expect(plan.stagesRetained).toContain('SC-STAGE-002');
    expect(plan.stagesToRerun).toContain('SC-STAGE-024');
    expect(plan.stagesRetained).not.toContain('SC-STAGE-024');
    expect(plan.affectedRefs).toContain(goal);
  });
});

describe('approving a change is the owner’s act, not the analysis’', () => {
  function analysed(f: ReturnType<typeof setup>, magnitude: 'M2' | 'M4') {
    const goal = seedGoal(f.store, f.deps);
    const cr = raiseChangeRequest(f, {
      origin: 'owner',
      description: 'change the commission model',
      magnitude,
    });
    analyseImpact(f, {
      changeRequestId: cr.id,
      dimensions: fullDimensions([goal]),
      reentryStageId: 'SC-STAGE-010',
      assessedBy: 'SC-AGENT-040',
    });
    return cr;
  }

  it('an unanalysed change cannot be approved', () => {
    const f = setup();
    const cr = raiseChangeRequest(f, { origin: 'owner', description: 'x', magnitude: 'M1' });
    expect(() => approveChange(f, { changeRequestId: cr.id })).toThrow(/not ANALYSED/);
  });

  it('an M4 change with no owner decision is refused', () => {
    const f = setup();
    const cr = analysed(f, 'M4');
    expect(() => approveChange(f, { changeRequestId: cr.id })).toThrow(
      /requires an owner decision/,
    );
  });

  it('an agent cannot stand in for the owner', () => {
    const f = setup();
    const cr = analysed(f, 'M4');
    const at = f.deps.clock.now();
    const decisionId = f.deps.ids.next('SC-ODR');
    const tx = f.store.begin();
    repository(f.store, ARTIFACT_TYPES.OWNER_DECISION_REQUEST, OwnerDecisionRequestSchema).put(tx, {
      id: decisionId,
      createdAt: at,
      question: 'Change the commission model?',
      whyServaCannotDecide: 'It is a commercial policy.',
      options: [
        { option: 'Yes', impact: 'margins change' },
        { option: 'No', impact: 'nothing changes' },
      ],
      recommendation: 'No',
      recommendationRationale: 'no evidence it helps',
      blocksWork: true,
      blockedRefs: [],
      state: 'ANSWERED',
      chosenOption: 'Yes',
      answeredBy: 'SC-AGENT-040',
      answeredAt: at,
      meta: { provenance: { marking: 'SYSTEM', component: 'test' }, attribution: { at } },
    } as never);
    tx.commit();

    expect(() => approveChange(f, { changeRequestId: cr.id, ownerDecisionId: decisionId })).toThrow(
      /answered by SC-AGENT-040/,
    );
  });

  it('a real owner answer approves it', () => {
    const f = setup();
    const cr = analysed(f, 'M4');
    const at = f.deps.clock.now();
    const decisionId = f.deps.ids.next('SC-ODR');
    const tx = f.store.begin();
    repository(f.store, ARTIFACT_TYPES.OWNER_DECISION_REQUEST, OwnerDecisionRequestSchema).put(tx, {
      id: decisionId,
      createdAt: at,
      question: 'Change the commission model?',
      whyServaCannotDecide: 'It is a commercial policy.',
      options: [
        { option: 'Yes', impact: 'margins change' },
        { option: 'No', impact: 'nothing changes' },
      ],
      recommendation: 'No',
      recommendationRationale: 'no evidence it helps',
      blocksWork: true,
      blockedRefs: [],
      state: 'ANSWERED',
      chosenOption: 'Yes',
      answeredBy: 'owner@bakery',
      answeredAt: at,
      meta: { provenance: { marking: 'SYSTEM', component: 'test' }, attribution: { at } },
    } as never);
    tx.commit();

    expect(approveChange(f, { changeRequestId: cr.id, ownerDecisionId: decisionId }).state).toBe(
      'APPROVED',
    );
  });
});

describe('re-entry re-opens the lifecycle, idempotently', () => {
  const WORK_ITEM = 'SC-WI-000900';

  function approved(f: ReturnType<typeof setup>): string {
    const goal = seedGoal(f.store, f.deps);
    const cr = raiseChangeRequest(f, {
      origin: 'owner',
      description: 'accept orders by text as well',
      magnitude: 'M2',
    });
    analyseImpact(f, {
      changeRequestId: cr.id,
      dimensions: fullDimensions([goal]),
      reentryStageId: 'SC-STAGE-011',
      assessedBy: 'SC-AGENT-040',
    });
    approveChange(f, { changeRequestId: cr.id });
    return cr.id;
  }

  it('the stages from the re-entry point are no longer complete, and their gates are dropped', () => {
    const f = setup();
    seedRecord(f.store, WORK_ITEM);
    const crId = approved(f);

    applyReentry(f, { workItemId: WORK_ITEM, changeRequestId: crId });
    const after = readOrchestratorRecord(f.store, WORK_ITEM);

    /* Intake stands. Requirements and everything after it does not. */
    expect(after?.completedStages).toContain('SC-STAGE-002');
    expect(after?.completedStages).not.toContain('SC-STAGE-011');
    expect(after?.completedStages).not.toContain('SC-STAGE-024');
    expect(after?.ranStages).not.toContain('SC-STAGE-011');
    expect(after?.state).toBe('RUNNING');

    /* A gate verdict is about the evidence that existed when it was given. */
    const gates = (after?.gateResults ?? []).map((g) => g.gateId);
    expect(gates).toContain('SC-GATE-INTAKE');
    expect(gates).not.toContain('SC-GATE-REQUIREMENTS');
    expect(gates).not.toContain('SC-GATE-ARCHITECTURE');
  });

  it('applying the same change twice changes nothing the second time', () => {
    const f = setup();
    seedRecord(f.store, WORK_ITEM);
    const crId = approved(f);

    applyReentry(f, { workItemId: WORK_ITEM, changeRequestId: crId });
    const first = readOrchestratorRecord(f.store, WORK_ITEM);
    const ledgerAfterFirst = readLedger(f.store, WORK_ITEM).length;

    applyReentry(f, { workItemId: WORK_ITEM, changeRequestId: crId });
    const second = readOrchestratorRecord(f.store, WORK_ITEM);

    expect(second?.completedStages).toEqual(first?.completedStages);
    expect(second?.ranStages).toEqual(first?.ranStages);
    expect(second?.gateResults).toEqual(first?.gateResults);
    /* And it does not narrate the same abandonment again. */
    expect(readLedger(f.store, WORK_ITEM).length).toBe(ledgerAfterFirst);
  });

  it('an outstanding change is visible until it is carried through', () => {
    const f = setup();
    seedRecord(f.store, WORK_ITEM);
    const crId = approved(f);
    expect(outstandingChanges(f.store).map((c) => c.id)).toContain(crId);
    completeChange(f, crId);
    expect(outstandingChanges(f.store).map((c) => c.id)).not.toContain(crId);
  });
});

describe('a proposal is not scope', () => {
  it('it cannot be accepted before it is assessed', () => {
    const f = setup();
    const p = propose(f, {
      title: 'Loyalty points',
      origin: 'SC-AGENT-120',
      description: 'Reward repeat phone orders',
    });
    expect(() => accept(f, { proposalId: p.id, acceptedBy: 'SC-AGENT-030' })).toThrow(
      /cannot go from PROPOSED to ACCEPTED/,
    );
  });

  it('it cannot accept itself', () => {
    const f = setup();
    const p = propose(f, {
      title: 'Loyalty points',
      origin: 'SC-AGENT-120',
      description: 'Reward repeat phone orders',
    });
    assess(f, {
      proposalId: p.id,
      assessment: {
        userOrBusinessValue: 'repeat custom',
        evidenceBasis: 'none yet — an idea',
        implementationComplexity: 'MEDIUM',
        costImpact: 'a fortnight of work',
        risk: 'dilutes the first release',
        operationalBurden: 'staff must explain it',
        scopeEffect: 'adds a feature nobody asked for',
      },
    });
    expect(() => accept(f, { proposalId: p.id, acceptedBy: 'SC-AGENT-120' })).toThrow(
      /raised and accepted by/,
    );
  });

  it('incorporation must point at canon that exists', () => {
    const f = setup();
    const goal = seedGoal(f.store, f.deps);
    const p = propose(f, {
      title: 'Loyalty points',
      origin: 'SC-AGENT-120',
      description: 'Reward repeat phone orders',
    });
    assess(f, {
      proposalId: p.id,
      assessment: {
        userOrBusinessValue: 'repeat custom',
        evidenceBasis: 'none yet',
        implementationComplexity: 'MEDIUM',
        costImpact: 'a fortnight',
        risk: 'dilution',
        operationalBurden: 'training',
        scopeEffect: 'adds a feature',
      },
    });
    accept(f, { proposalId: p.id, acceptedBy: 'SC-AGENT-030' });

    expect(() =>
      incorporate(f, {
        proposalId: p.id,
        incorporatedBy: 'SC-AGENT-030',
        into: [{ id: 'SC-FEAT-NOTHING' }],
      }),
    ).toThrow(/does not exist/);

    const done = incorporate(f, {
      proposalId: p.id,
      incorporatedBy: 'SC-AGENT-030',
      into: [{ id: goal }],
    });
    expect(done.state).toBe('INCORPORATED');
    expect(done.incorporatedInto.map((r) => r.id)).toEqual([goal]);
    expect(openProposals(f.store)).toHaveLength(0);
  });

  it('a rejection keeps its rationale, and is terminal', () => {
    const f = setup();
    const p = propose(f, {
      title: 'Blockchain the receipts',
      origin: 'SC-AGENT-062',
      description: 'Immutable order history',
    });
    const rejected = reject(f, {
      proposalId: p.id,
      rationale: 'a bakery does not have a trust problem between itself and its till',
    });
    expect(rejected.rejectionRationale).toMatch(/trust problem/);
    expect(() => assess(f, { proposalId: p.id, assessment: {} as never })).toThrow(
      /cannot go from REJECTED/,
    );
  });

  it('deferred is a real answer, and revisitable', () => {
    const f = setup();
    const p = propose(f, {
      title: 'Loyalty points',
      origin: 'SC-AGENT-120',
      description: 'later, maybe',
    });
    assess(f, {
      proposalId: p.id,
      assessment: {
        userOrBusinessValue: 'repeat custom',
        evidenceBasis: 'none',
        implementationComplexity: 'LOW',
        costImpact: 'small',
        risk: 'low',
        operationalBurden: 'low',
        scopeEffect: 'adds a feature',
      },
    });
    const deferred = defer(f, { proposalId: p.id, rationale: 'not for the first release' });
    expect(deferred.state).toBe('DEFERRED');
    expect(accept(f, { proposalId: p.id, acceptedBy: 'SC-AGENT-030' }).state).toBe('ACCEPTED');
  });
});

describe('learning crosses the boundary only as a generalisation', () => {
  const CURATOR = 'SC-AGENT-280';

  it('a lesson still carrying project specifics is refused, with every reason', () => {
    const f = setup();
    expect(() =>
      contributeLesson(f, {
        statement: 'Ask the client at /home/acme/orders before designing the till screen',
        context: 'contact dave@acme.example about SC-WI-000700',
        applicableWhen: 'always',
        curatedBy: CURATOR,
      }),
    ).toThrow(/file path|email|project identifier/);
  });

  it('a genuine generalisation is published', () => {
    const f = setup();
    const lesson = contributeLesson(f, {
      statement: 'Counter staff will not use a screen that needs more than one tap during a rush',
      context: 'high-pressure point-of-sale work with both hands occupied',
      applicableWhen: 'the operator is standing, busy, and interrupted',
      curatedBy: CURATOR,
    });
    expect(lesson.generalised).toBe(true);
  });

  it('a pattern must say when NOT to use it', () => {
    const f = setup();
    expect(() =>
      contributePattern(f, {
        name: 'Offline-first order capture',
        problem: 'connectivity drops during service',
        solution: 'queue locally and reconcile',
        applicableWhen: 'the operator cannot wait for the network',
        notApplicableWhen: [],
        curatedBy: CURATOR,
      }),
    ).toThrow();
  });

  it('a pattern cannot be applied on the strength of having worked elsewhere', () => {
    const f = setup();
    const pattern = contributePattern(f, {
      name: 'Offline-first order capture',
      problem: 'connectivity drops during service',
      solution: 'queue locally and reconcile',
      applicableWhen: 'the operator cannot wait for the network',
      notApplicableWhen: ['when two operators may edit the same order'],
      tradeoffs: ['reconciliation is not free'],
      curatedBy: CURATOR,
    });
    offerCandidate(f, {
      kind: 'PATTERN',
      ref: { id: pattern.id },
      summary: 'queue orders locally when the network is unreliable',
    });

    expect(patternUsageRefusal(f.store, pattern.id)).toMatch(/no applicability assessment/);
    expect(() => applyPattern(f, { patternId: pattern.id })).toThrow(/not a reason/);

    /* Accepting it without saying how this project differs is recognition, not assessment. */
    expect(() =>
      assessApplicability(f, {
        patternId: pattern.id,
        applies: true,
        rationale: 'it worked before',
        confidence: 'HIGH',
        differences: [],
        assessedBy: 'SC-AGENT-291',
      }),
    ).toThrow(/no differences considered/);

    assessApplicability(f, {
      patternId: pattern.id,
      applies: true,
      rationale: 'the same interruption pattern applies, and the till is offline half the morning',
      confidence: 'MEDIUM',
      differences: ['a single operator here, where the earlier project had three'],
      assessedBy: 'SC-AGENT-291',
    });
    expect(patternUsageRefusal(f.store, pattern.id)).toBeUndefined();
    expect(applyPattern(f, { patternId: pattern.id }).status).toBe('APPLIED');
  });

  it('a pattern assessed as NOT applying stays unusable', () => {
    const f = setup();
    const pattern = contributePattern(f, {
      name: 'Event sourcing everything',
      problem: 'auditability',
      solution: 'append-only events for all state',
      applicableWhen: 'regulated finance',
      notApplicableWhen: ['a small business with one operator'],
      curatedBy: CURATOR,
    });
    assessApplicability(f, {
      patternId: pattern.id,
      applies: false,
      rationale: 'the operational cost is not justified at this scale',
      confidence: 'HIGH',
      differences: ['no regulator, no audit obligation'],
      assessedBy: 'SC-AGENT-291',
    });
    expect(patternUsageRefusal(f.store, pattern.id)).toMatch(/NOT applying/);
    expect(() => applyPattern(f, { patternId: pattern.id })).toThrow();
  });

  it('a failed approach carries no code and no client', () => {
    const f = setup();
    expect(() =>
      contributeFailedApproach(f, {
        approach: 'we wrote `function reconcile() {` on the client',
        whyItFailed: 'it drifted',
        curatedBy: CURATOR,
      }),
    ).toThrow(/source-code fragment/);

    const ok = contributeFailedApproach(f, {
      approach: 'reconciling offline orders on the device rather than at the server',
      whyItFailed: 'two devices reconciled differently and neither was wrong',
      symptomsToWatchFor: ['totals that disagree only after a network outage'],
      curatedBy: CURATOR,
    });
    expect(ok.generalised).toBe(true);
  });
});
