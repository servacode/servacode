import { afterEach, describe, expect, it } from 'vitest';
import { EnforcementClass } from '../src/vocab/index.js';
import { ExecutionAvailability, QualificationAttempt } from '../src/substrate/types.js';
import { ChainOutcome, resolveServaChain } from '../src/acceptance/servaChain.js';
import { EvidenceOrigin, byOrigin } from '../src/acceptance/evidenceClass.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { audit } from '../src/events/audit.js';
import { CHANGESET_CANON_TYPE } from '../src/engineering/changeset.js';
import { REVIEW_CANON_TYPE } from '../src/engineering/review.js';
import { cleanup, tempRoot } from './helpers.js';
import type { SubstrateQualification } from '../src/substrate/types.js';
import type { Store } from '../src/store/store.js';

/**
 * A COMPANY IS THE JOIN, NOT THE TWO HALVES.
 *
 * SPEC: Phase 6 final acceptance sequence §2, §6, §7.
 *
 * The tempting arithmetic is
 *
 *   a real intelligence chain + a real engineering chain = a live company
 *
 * and it is satisfied perfectly by two valid runs from unrelated requests. Every test here is
 * one way of trying exactly that, plus the one case that must NEVER be automated away: an
 * owner decision waiting for a person.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const FINGERPRINT = 'f'.repeat(64);
const COMMIT = 'a'.repeat(40);
const PRODUCER = 'SC-AGENT-150';
const REVIEWER = 'SC-AGENT-200';
const CLASSIFIER = 'SC-AGENT-003';
const WORK_ITEM = 'SC-WI-000900';

const HARD = {
  attempt: QualificationAttempt.MEASURED,
  availability: ExecutionAvailability.AVAILABLE,
  enforcementClass: EnforcementClass.HARD,
} as unknown as SubstrateQualification;

function project(): ServaRuntime {
  const root = tempRoot();
  roots.push(root);
  return ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root });
}

function seedRun(store: Store, runId: string, agentId: string, outcome = 'COMPLETED'): void {
  const tx = store.begin();
  tx.putCanon('agentRunRecord', runId, {
    runId,
    agentId,
    outcome,
    claimAssessments: [],
    evidenceRefs: [],
  });
  tx.commit();
}

function seedTurn(store: Store, over: Record<string, unknown> = {}): string {
  const id = String(over['id'] ?? 'SC-TURN-000001');
  const tx = store.begin();
  tx.putWorking('conversationTurn', id, {
    id,
    text: 'Fix total() so an empty list returns 0.',
    askedAt: '2026-08-24T00:00:00.000Z',
    requestId: 'SC-REQST-000001',
    workItemId: WORK_ITEM,
    outcome: 'QUEUED',
    stage: 'QUEUED',
    classification: 'DEFECT',
    queued: ['DEPT-ENGINEERING'],
    runIds: ['SC-RUN-000001'],
    ...over,
  });
  tx.commit();
  return id;
}

function seedEngineering(store: Store, over: Record<string, unknown> = {}): void {
  const workItemId = String(over['workItemId'] ?? WORK_ITEM);
  const changeSetId = String(over['changeSetId'] ?? 'SC-CS-000002');
  const tx = store.begin();
  tx.putCanon(CHANGESET_CANON_TYPE, changeSetId, {
    changeSetId,
    workItemId,
    workspaceId: 'SC-WS-000001',
    attempt: 1,
    producerAgentId: PRODUCER,
    producerRunId: 'SC-RUN-000004',
    baseCommit: 'b'.repeat(40),
    headCommit: 'c'.repeat(40),
    entries: [],
    diffDigest: 'd'.repeat(64),
    digest: 'e'.repeat(64),
    createdAt: '2026-08-24T00:00:00.000Z',
  });
  tx.putCanon('engineeringEvidence', 'SC-EEV-000001', {
    id: 'SC-EEV-000001',
    runtimeComponentId: 'SC-RTC-012',
    evidenceClass: 'EXECUTION',
    claim: 'the unit test recipe succeeded',
    basis: 'MEASURED',
    workItemId,
    changeSetId,
    workspaceId: 'SC-WS-000001',
    headCommit: 'c'.repeat(40),
    outcome: 'PASS',
    detail: 'SC-RECIPE-UNIT-TEST -> SUCCEEDED (exit 0)',
    capturedAt: '2026-08-24T00:00:00.000Z',
    capturedBy: 'RUNTIME',
  });
  tx.putCanon(REVIEW_CANON_TYPE, 'SC-REV-000001', {
    id: 'SC-REV-000001',
    workItemId,
    changeSetId,
    criterionId: 'EC-REVIEW',
    reviewerAgentId: REVIEWER,
    producerAgentId: PRODUCER,
    runRef: 'SC-RUN-000005',
    outcome: 'PASS',
    detail: 'reviewed',
    verdict: {},
    capabilityDigest: 'c'.repeat(64),
    recordedAt: '2026-08-24T00:00:00.000Z',
  });
  audit(tx, {
    action: 'CHANGE_ACCEPTED' as never,
    subject: changeSetId,
    outcome: 'OK',
    detail:
      over['acceptanceNamesWorkItem'] === false
        ? { commit: COMMIT, gateResult: 'SC-GR-000001' }
        : { commit: COMMIT, workItemId, gateResult: 'SC-GR-000001' },
  });
  tx.commit();
}

/** A legitimately pre-seeded project, a real request, and a real engineering chain. */
function wholeChain(rt: ServaRuntime): void {
  seedRun(rt.store, 'SC-RUN-000001', CLASSIFIER);
  seedRun(rt.store, 'SC-RUN-000004', PRODUCER);
  seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
  seedTurn(rt.store);
  seedEngineering(rt.store);
}

const PRESEED = [
  {
    origin: EvidenceOrigin.DETERMINISTIC_PRESEED,
    kind: 'REQUIREMENT',
    id: 'SC-REQ-000001',
    detail: 'total([]) returns 0',
  },
];

function resolve(rt: ServaRuntime, over: Record<string, unknown> = {}) {
  return resolveServaChain({
    store: rt.store,
    companyStore: rt.store,
    repoRoot: rt.root,
    machineFingerprint: FINGERPRINT,
    recordedFingerprint: FINGERPRINT,
    qualification: HARD,
    commitExists: () => true,
    preseeded: PRESEED,
    ...over,
  } as never);
}

/* =========================================================== F. the legitimate chain */

describe('F. a deterministic preseed plus a real cross-phase chain', () => {
  it('is PROVEN, and says which parts were pre-seeded rather than live', () => {
    const rt = project();
    try {
      wholeChain(rt);
      const result = resolve(rt);
      expect(result.outcome, JSON.stringify(result.refusals)).toBe(ChainOutcome.PROVEN);
      expect(result.workItemId).toBe(WORK_ITEM);
      expect(result.acceptedCommit).toBe(COMMIT);

      /*
       * The classes are kept apart in the evidence. Pre-seeding is legitimate; pre-seeding
       * LABELLED AS LIVE is not, and this is where that distinction is either kept or lost.
       */
      const grouped = byOrigin(result.refs);
      expect(grouped[EvidenceOrigin.DETERMINISTIC_PRESEED].map((r) => r.id)).toContain(
        'SC-REQ-000001',
      );
      expect(grouped[EvidenceOrigin.LIVE_MODEL].map((r) => r.id)).toContain('SC-RUN-000001');
      expect(grouped[EvidenceOrigin.LIVE_MODEL].map((r) => r.id)).toContain('SC-RUN-000004');
      expect(grouped[EvidenceOrigin.LIVE_MACHINE].map((r) => r.id)).toContain(FINGERPRINT);
      expect(grouped[EvidenceOrigin.OWNER_ACTION].map((r) => r.kind)).toContain('OWNER_REQUEST');
      /* No pre-seeded artifact may appear as a live one. */
      expect(grouped[EvidenceOrigin.LIVE_MODEL].map((r) => r.id)).not.toContain('SC-REQ-000001');
    } finally {
      rt.close();
    }
  });
});

/* ================================================= A, B, C. the join cannot be assembled */

describe('A. a classifier from one request and a work item from another', () => {
  it('is REFUSED', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000001', CLASSIFIER);
      seedRun(rt.store, 'SC-RUN-000004', PRODUCER);
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      /* The request opened one work item; the change was built for another. */
      seedTurn(rt.store, { workItemId: 'SC-WI-FROM-REQUEST-A' });
      seedEngineering(rt.store, { workItemId: 'SC-WI-FROM-REQUEST-B' });

      const result = resolve(rt);
      expect(result.outcome).toBe(ChainOutcome.NOT_VERIFIED);
      expect(result.refusals.map((r) => r.check)).toContain('CROSS_PHASE_JOIN');
      expect(JSON.stringify(result.refusals)).toContain('two executions, not a chain');
    } finally {
      rt.close();
    }
  });
});

describe('B. a pre-seeded EngineeringWorkItem with no real engineering behind it', () => {
  it('is REFUSED', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000001', CLASSIFIER);
      seedTurn(rt.store);
      /* A work item and a turn, and nothing that actually built anything. */
      const result = resolve(rt);
      expect(result.outcome).toBe(ChainOutcome.NOT_VERIFIED);
      expect(result.refusals.map((r) => r.check)).toContain('CHANGESET');
    } finally {
      rt.close();
    }
  });
});

describe('C. a real intelligence chain beside an unrelated real engineering run', () => {
  it('is REFUSED, however valid each half is on its own', () => {
    /*
     * The arithmetic this whole module exists to reject. Both halves are genuine; nothing
     * connects them, and a company is the connection.
     */
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000001', CLASSIFIER);
      seedRun(rt.store, 'SC-RUN-000004', PRODUCER);
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      seedTurn(rt.store, { workItemId: 'SC-WI-FROM-A-DIFFERENT-FIXTURE' });
      seedEngineering(rt.store);

      const result = resolve(rt);
      expect(result.outcome).toBe(ChainOutcome.NOT_VERIFIED);
      expect(result.refusals.map((r) => r.check)).toContain('CROSS_PHASE_JOIN');
    } finally {
      rt.close();
    }
  });

  it('and an acceptance that names no work item is refused too', () => {
    /*
     * Belt and braces, and they are not the same brace. The ChangeSet is written by Serva from
     * what it OBSERVED; the trace entry is written by Serva about what it DECIDED. Requiring
     * both to name the work item means one record cannot vouch for the other.
     *
     * An earlier version of this test seeded a second acceptance entry alongside the correct
     * one and then asserted PROVEN — passing while contradicting its own title, and proving
     * nothing at all.
     */
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000001', CLASSIFIER);
      seedRun(rt.store, 'SC-RUN-000004', PRODUCER);
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      seedTurn(rt.store);
      seedEngineering(rt.store, { acceptanceNamesWorkItem: false });

      const result = resolve(rt);
      expect(result.outcome).toBe(ChainOutcome.NOT_VERIFIED);
      expect(JSON.stringify(result.refusals)).toContain('no CHANGE_ACCEPTED entry names work item');
    } finally {
      rt.close();
    }
  });
});

/* ================================================= D, E. the owner decision is untouchable */

describe('D. an owner decision is pending', () => {
  function seedDecision(store: Store, id = 'SC-ODR-000001'): void {
    const tx = store.begin();
    tx.putCanon('intel.ownerDecisionRequest', id, {
      id,
      createdAt: '2026-08-24T00:00:00.000Z',
      question: 'What should total() return for an empty list?',
      whyServaCannotDecide: 'It is a product decision, not a technical fact.',
      purpose: 'BUSINESS_RULE',
      responseMode: 'VALUE',
      options: [],
      recommendation: '0',
      recommendationRationale: 'It is the identity for a sum.',
      blocksWork: true,
      blockedRefs: [],
      state: 'OPEN',
      meta: { provenance: { marking: 'SYSTEM', component: 'test' }, attribution: { at: 'T' } },
    });
    tx.commit();
  }

  it('reports OWNER_ACTION_REQUIRED and never answers it', () => {
    const rt = project();
    try {
      wholeChain(rt);
      seedDecision(rt.store);

      const result = resolve(rt);
      expect(result.outcome).toBe(ChainOutcome.OWNER_ACTION_REQUIRED);
      expect(result.pendingOwnerDecisions).toHaveLength(1);
      expect(result.pendingOwnerDecisions[0]?.question).toContain('empty list');

      /* The decision is still OPEN afterwards. Resolving it changed nothing. */
      const after = rt.store.getCanon<{ state?: string }>(
        'intel.ownerDecisionRequest',
        'SC-ODR-000001',
      )?.body;
      expect(after?.state).toBe('OPEN');
    } finally {
      rt.close();
    }
  });

  it('is never reported as PROVEN, whatever else is in order', () => {
    const rt = project();
    try {
      wholeChain(rt);
      seedDecision(rt.store);
      expect(resolve(rt).outcome).not.toBe(ChainOutcome.PROVEN);
    } finally {
      rt.close();
    }
  });

  it('the pending decision appears as OWNER_ACTION evidence, not as a refusal', () => {
    /*
     * Deliberate. Listing it among refusals would put it next to genuine problems and invite
     * somebody to make it go away.
     */
    const rt = project();
    try {
      wholeChain(rt);
      seedDecision(rt.store);
      const result = resolve(rt);
      const owner = byOrigin(result.refs)[EvidenceOrigin.OWNER_ACTION];
      expect(owner.map((r) => r.kind)).toContain('OWNER_DECISION');
      expect(JSON.stringify(result.refusals)).not.toContain('SC-ODR-000001');
    } finally {
      rt.close();
    }
  });
});

describe('E. after a real owner answer, the same chain resumes from Store truth', () => {
  it('resolves from disk alone, with no duplicate decision or run', () => {
    const rt = project();
    const root = rt.root;
    try {
      wholeChain(rt);
      const tx = rt.store.begin();
      tx.putCanon('intel.ownerDecisionRequest', 'SC-ODR-000001', {
        id: 'SC-ODR-000001',
        createdAt: '2026-08-24T00:00:00.000Z',
        question: 'What should total() return for an empty list?',
        whyServaCannotDecide: 'It is a product decision.',
        purpose: 'BUSINESS_RULE',
        responseMode: 'VALUE',
        options: [],
        recommendation: '0',
        recommendationRationale: 'identity for a sum',
        blocksWork: true,
        blockedRefs: [],
        /* The owner answered, through Serva. */
        state: 'ANSWERED',
        answerValue: '0',
        answeredBy: 'owner',
        answeredAt: '2026-08-24T01:00:00.000Z',
        meta: { provenance: { marking: 'SYSTEM', component: 'test' }, attribution: { at: 'T' } },
      });
      tx.commit();
    } finally {
      rt.close();
    }

    /* A NEW process, reading only what is on disk. */
    const resumed = ServaRuntime.open({ root });
    try {
      const result = resolveServaChain({
        store: resumed.store,
        companyStore: resumed.store,
        repoRoot: root,
        machineFingerprint: FINGERPRINT,
        recordedFingerprint: FINGERPRINT,
        qualification: HARD,
        commitExists: () => true,
        preseeded: PRESEED,
      } as never);

      expect(result.outcome, JSON.stringify(result.refusals)).toBe(ChainOutcome.PROVEN);
      expect(result.pendingOwnerDecisions).toHaveLength(0);

      /* One turn, one classifier run, one ChangeSet. Resuming duplicated nothing. */
      expect(resumed.store.listWorkingIds('conversationTurn')).toHaveLength(1);
      expect(
        resumed.store.listCanonIds('agentRunRecord').filter((id) => id === 'SC-RUN-000001'),
      ).toHaveLength(1);
    } finally {
      resumed.close();
    }
  });
});

/* ============================================ the fail-closed case, preserved as a rule */

describe('unonboarded code is refused, and that refusal is not a defect', () => {
  it('a request to modify code the Store has no baseline for cannot reach engineering', () => {
    /*
     * SPEC: Phase 6 final acceptance sequence §5.
     *
     * Observed live. Given a git repository full of code and a Serva Store that had never
     * baselined any of it, the Orchestrator escalated rather than planning:
     *
     *   Governed store (empty project) contradicts the filesystem (existing untracked code).
     *   Serva/owner must resolve whether to onboard/baseline the pre-existing code…
     *   No baselined requirement/acceptance oracle exists for total(); expected value 6 comes
     *   only from an untracked test.
     *
     * That is correct. There was no oracle, so there was nothing to build against, and Serva
     * declined to invent one. The temptation afterwards is to make Serva accept unknown code so
     * that a live acceptance goes green — which would trade the product's central property for
     * a passing row on a matrix.
     *
     * So the refusal is a RULE now. A chain whose request halted has no accepted commit and no
     * work item to join, and this asserts it stays that way.
     */
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000001', CLASSIFIER);
      /* The orchestrator escalated; the turn records a halt rather than queued work. */
      seedTurn(rt.store, {
        outcome: 'HALTED',
        stage: 'CLASSIFIED',
        queued: [],
        haltReason:
          'Planning did not complete: ESCALATED — no baselined requirement or acceptance ' +
          'oracle exists for the code on disk.',
      });

      const result = resolve(rt);
      expect(result.outcome).toBe(ChainOutcome.NOT_VERIFIED);
      expect(result.acceptedCommit).toBeUndefined();
      /* Nothing was built, so the join cannot be satisfied by anything. */
      expect(result.refusals.map((r) => r.check)).toContain('CHANGESET');
    } finally {
      rt.close();
    }
  });

  it('a halted request never yields a PROVEN chain, however healthy the machine is', () => {
    const rt = project();
    try {
      wholeChain(rt);
      /* Everything real — except the request itself went nowhere. */
      seedTurn(rt.store, { outcome: 'HALTED', stage: 'CLASSIFIED', queued: [] });
      const result = resolve(rt);
      expect(result.outcome).not.toBe(ChainOutcome.PROVEN);
    } finally {
      rt.close();
    }
  });
});
