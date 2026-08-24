import { afterEach, describe, expect, it } from 'vitest';
import { EnforcementClass } from '../src/vocab/index.js';
import { ExecutionAvailability, QualificationAttempt } from '../src/substrate/types.js';
import { resolveLiveEngineering, resolveLiveServa } from '../src/acceptance/liveProof.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { CHANGESET_CANON_TYPE } from '../src/engineering/changeset.js';
import { REVIEW_CANON_TYPE } from '../src/engineering/review.js';
import { audit } from '../src/events/audit.js';
import { cleanup, tempRoot } from './helpers.js';
import type { SubstrateQualification } from '../src/substrate/types.js';
import type { Store } from '../src/store/store.js';

/**
 * A CALLER CANNOT ASSEMBLE A LIVE PASS OUT OF IDS.
 *
 * SPEC: Phase 6 final acceptance sequence §2.
 *
 * The live suites now reach real governed execution, which is exactly when the shortcut
 * becomes available: write the ids down, mint a PASS, move on. So the property under test is
 * that ids are LOOKUP HINTS AND NOTHING ELSE — every one is resolved against the Store, the
 * trace, Git and this machine, and then checked to belong to the same execution as the others.
 *
 * Six real ids from six different runs would otherwise assemble into a chain that never
 * happened, and every test below is one way of trying exactly that.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const FINGERPRINT = 'f'.repeat(64);
const COMMIT = 'a'.repeat(40);
const PRODUCER = 'SC-AGENT-150';
const REVIEWER = 'SC-AGENT-200';

const HARD: SubstrateQualification = {
  attempt: QualificationAttempt.MEASURED,
  availability: ExecutionAvailability.AVAILABLE,
  enforcementClass: EnforcementClass.HARD,
} as unknown as SubstrateQualification;

function project(): ServaRuntime {
  const root = tempRoot();
  roots.push(root);
  return ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root });
}

/** A terminal AgentRun record, exactly as the projection reads one. */
function seedRun(store: Store, runId: string, agentId: string, outcome = 'COMPLETED'): void {
  const tx = store.begin();
  tx.putCanon('agentRunRecord', runId, { runId, agentId, outcome, workItemId: 'SC-WI-000900' });
  tx.commit();
}

function seedChangeSet(store: Store, over: Record<string, unknown> = {}): { changeSetId: string } {
  const changeSetId = String(over['changeSetId'] ?? 'SC-CS-000002');
  const tx = store.begin();
  tx.putCanon(CHANGESET_CANON_TYPE, changeSetId, {
    changeSetId,
    workItemId: 'SC-WI-000900',
    workspaceId: 'SC-WS-000001',
    attempt: 1,
    producerAgentId: PRODUCER,
    producerRunId: 'SC-RUN-000004',
    baseCommit: 'b'.repeat(40),
    headCommit: COMMIT,
    entries: [],
    diffDigest: 'd'.repeat(64),
    digest: 'e'.repeat(64),
    createdAt: '2026-08-24T00:00:00.000Z',
    ...over,
  });
  tx.commit();
  return { changeSetId };
}

function seedReview(store: Store, over: Record<string, unknown> = {}): void {
  const tx = store.begin();
  const id = String(over['id'] ?? 'SC-REV-000001');
  tx.putCanon(REVIEW_CANON_TYPE, id, {
    id,
    workItemId: 'SC-WI-000900',
    changeSetId: 'SC-CS-000002',
    criterionId: 'EC-REVIEW',
    reviewerAgentId: REVIEWER,
    producerAgentId: PRODUCER,
    runRef: 'SC-RUN-000005',
    outcome: 'PASS',
    detail: 'reviewed',
    verdict: {},
    capabilityDigest: 'c'.repeat(64),
    recordedAt: '2026-08-24T00:00:00.000Z',
    ...over,
  });
  tx.commit();
}

function seedEvidence(store: Store, changeSetId = 'SC-CS-000002', id = 'SC-EEV-000001'): void {
  const tx = store.begin();
  tx.putCanon('engineeringEvidence', id, {
    id,
    runtimeComponentId: 'SC-RTC-012',
    evidenceClass: 'EXECUTION',
    claim: 'the unit test recipe succeeded',
    basis: 'MEASURED',
    workItemId: 'SC-WI-000900',
    changeSetId,
    workspaceId: 'SC-WS-000001',
    headCommit: COMMIT,
    outcome: 'PASS',
    detail: 'SC-RECIPE-UNIT-TEST -> SUCCEEDED (exit 0)',
    capturedAt: '2026-08-24T00:00:00.000Z',
    capturedBy: 'RUNTIME',
  });
  tx.commit();
}

/**
 * The `CHANGE_ACCEPTED` trace entry Serva writes on integration.
 *
 * This is the binding the verifier resolves the accepted commit FROM, so a fixture without one
 * has an unaccepted change however real everything else is.
 */
function seedAccepted(store: Store, changeSetId = 'SC-CS-000002', commit = COMMIT): void {
  const tx = store.begin();
  audit(tx, {
    action: 'CHANGE_ACCEPTED' as never,
    subject: changeSetId,
    outcome: 'OK',
    detail: { commit, branch: 'serva/SC-WI-000900/01', gateResult: 'SC-GR-000001' },
  });
  tx.commit();
}

/** A store holding one complete, honest live chain. */
function honestChain(rt: ServaRuntime): void {
  seedRun(rt.store, 'SC-RUN-000004', PRODUCER);
  seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
  seedChangeSet(rt.store);
  seedEvidence(rt.store);
  seedReview(rt.store);
  seedAccepted(rt.store);
}

function resolve(rt: ServaRuntime, over: Record<string, unknown> = {}) {
  return resolveLiveEngineering({
    store: rt.store,
    repoRoot: rt.root,
    machineFingerprint: FINGERPRINT,
    recordedFingerprint: FINGERPRINT,
    qualification: HARD,
    commitExists: () => true,
    ...over,
  } as never);
}

/* ================================================================ the honest chain */

describe('a real chain resolves', () => {
  it('resolves when every reference is real and belongs to the same execution', () => {
    const rt = project();
    try {
      honestChain(rt);
      const result = resolve(rt);
      expect(result.resolved, JSON.stringify(result.refusals)).toBe(true);
      expect(result.chain?.producerRunId).toBe('SC-RUN-000004');
      expect(result.chain?.reviewerRunId).toBe('SC-RUN-000005');
      expect(result.chain?.acceptedCommit).toBe(COMMIT);
      expect(result.chain?.checkIds.length).toBeGreaterThan(0);
    } finally {
      rt.close();
    }
  });
});

/* ===================================================== the six adversarial cases */

describe('every way of inventing a live PASS is refused', () => {
  it('a fake Producer run id', () => {
    const rt = project();
    try {
      /* Everything else is real; only the run the ChangeSet names does not exist. */
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      seedChangeSet(rt.store, { producerRunId: 'SC-RUN-999999' });
      seedEvidence(rt.store);
      seedReview(rt.store);
      seedAccepted(rt.store);

      const result = resolve(rt);
      expect(result.resolved).toBe(false);
      expect(result.refusals.map((r) => r.check)).toContain('PRODUCER_RUN');
      expect(JSON.stringify(result.refusals)).toContain('does not resolve');
    } finally {
      rt.close();
    }
  });

  it('a Reviewer from another execution', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000004', PRODUCER);
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      seedChangeSet(rt.store);
      seedEvidence(rt.store);
      /* A real, completed review — of a different change set. */
      seedReview(rt.store, { changeSetId: 'SC-CS-OTHER' });
      seedAccepted(rt.store);

      const result = resolve(rt);
      expect(result.resolved).toBe(false);
      expect(result.refusals.map((r) => r.check)).toContain('REVIEW');
    } finally {
      rt.close();
    }
  });

  it('a Reviewer belonging to a different work item', () => {
    const rt = project();
    try {
      honestChain(rt);
      seedReview(rt.store, { workItemId: 'SC-WI-SOMETHING-ELSE' });
      const result = resolve(rt);
      expect(result.resolved).toBe(false);
      expect(result.refusals.map((r) => r.check)).toContain('SAME_EXECUTION');
    } finally {
      rt.close();
    }
  });

  it('a Reviewer that is the Producer', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000004', PRODUCER);
      seedRun(rt.store, 'SC-RUN-000005', PRODUCER);
      seedChangeSet(rt.store);
      seedEvidence(rt.store);
      seedReview(rt.store, { reviewerAgentId: PRODUCER });
      seedAccepted(rt.store);

      const result = resolve(rt);
      expect(result.resolved).toBe(false);
      expect(result.refusals.map((r) => r.check)).toContain('INDEPENDENCE');
    } finally {
      rt.close();
    }
  });

  it('a mismatching machine fingerprint', () => {
    const rt = project();
    try {
      honestChain(rt);
      const result = resolve(rt, { recordedFingerprint: '9'.repeat(64) });
      expect(result.resolved).toBe(false);
      expect(result.refusals.map((r) => r.check)).toContain('MACHINE');
    } finally {
      rt.close();
    }
  });

  it('a SOFT qualification', () => {
    const rt = project();
    try {
      honestChain(rt);
      const soft = {
        attempt: QualificationAttempt.MEASURED,
        availability: ExecutionAvailability.AVAILABLE,
        enforcementClass: EnforcementClass.SOFT,
      } as unknown as SubstrateQualification;
      const result = resolve(rt, { qualification: soft });
      expect(result.resolved).toBe(false);
      expect(JSON.stringify(result.refusals)).toContain('requires HARD');
    } finally {
      rt.close();
    }
  });

  it('a qualification that never reached the guest', () => {
    /* The transport invariant, at the acceptance layer. */
    const rt = project();
    try {
      honestChain(rt);
      const unmeasured = {
        attempt: QualificationAttempt.NOT_MEASURED,
        availability: ExecutionAvailability.UNREACHABLE,
        enforcementClass: EnforcementClass.NONE,
      } as unknown as SubstrateQualification;
      const result = resolve(rt, { qualification: unmeasured });
      expect(result.resolved).toBe(false);
      expect(JSON.stringify(result.refusals)).toContain('nothing was measured');
    } finally {
      rt.close();
    }
  });

  it('a manually written accepted commit the governed chain did not produce', () => {
    const rt = project();
    try {
      honestChain(rt);
      const result = resolve(rt, { hints: { acceptedCommit: '7'.repeat(40) } });
      expect(result.resolved).toBe(false);
      expect(result.refusals.map((r) => r.check)).toContain('ACCEPTED_COMMIT');
      expect(JSON.stringify(result.refusals)).toContain('the trace records as accepted');
    } finally {
      rt.close();
    }
  });

  it('a commit that is not in the repository at all', () => {
    const rt = project();
    try {
      honestChain(rt);
      const result = resolve(rt, { commitExists: () => false });
      expect(result.resolved).toBe(false);
      expect(JSON.stringify(result.refusals)).toContain('not a commit in this repository');
    } finally {
      rt.close();
    }
  });

  it('an Engineering Gate result with no deterministic evidence behind it', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000004', PRODUCER);
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      seedChangeSet(rt.store);
      seedReview(rt.store);
      /* Evidence bound to a DIFFERENT change set: real, and about something else. */
      seedEvidence(rt.store, 'SC-CS-OTHER');
      seedAccepted(rt.store);

      const result = resolve(rt);
      expect(result.resolved).toBe(false);
      expect(result.refusals.map((r) => r.check)).toContain('CHECKS');
    } finally {
      rt.close();
    }
  });

  it('a Producer run made by a different actor than the ChangeSet names', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000004', 'SC-AGENT-999');
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      seedChangeSet(rt.store);
      seedEvidence(rt.store);
      seedReview(rt.store);
      seedAccepted(rt.store);

      const result = resolve(rt);
      expect(result.resolved).toBe(false);
      expect(JSON.stringify(result.refusals)).toContain('was made by SC-AGENT-999');
    } finally {
      rt.close();
    }
  });

  it('a Producer run that produced nothing', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000004', PRODUCER, 'FAILED');
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      seedChangeSet(rt.store);
      seedEvidence(rt.store);
      seedReview(rt.store);
      seedAccepted(rt.store);

      const result = resolve(rt);
      expect(result.resolved).toBe(false);
      expect(JSON.stringify(result.refusals)).toContain('produced nothing');
    } finally {
      rt.close();
    }
  });

  it('a change accepted by nothing in the trace', () => {
    /*
     * Everything real except the acceptance itself. The commit is resolved FROM the
     * `CHANGE_ACCEPTED` trace entry, so a change nobody integrated has no commit to cite.
     */
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000004', PRODUCER);
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      seedChangeSet(rt.store);
      seedEvidence(rt.store);
      seedReview(rt.store);

      const result = resolve(rt);
      expect(result.resolved).toBe(false);
      expect(JSON.stringify(result.refusals)).toContain('nothing was ever accepted');
    } finally {
      rt.close();
    }
  });

  it('a Producer that misreported its own work is REPORTED, not hidden', () => {
    /*
     * The first real live run ended exactly this way. Acceptance never rested on the
     * Producer's word — deterministic checks measured the code and an independent reviewer
     * judged it — so this resolves. What must never happen is it resolving SILENTLY.
     */
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000004', PRODUCER, 'EVIDENCE_VIOLATION');
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      seedChangeSet(rt.store);
      seedEvidence(rt.store);
      seedReview(rt.store);
      seedAccepted(rt.store);

      const result = resolve(rt);
      expect(result.resolved, JSON.stringify(result.refusals)).toBe(true);
      expect(result.chain?.producerOutcome).toBe('EVIDENCE_VIOLATION');
    } finally {
      rt.close();
    }
  });

  it('reports every refusal, not only the first', () => {
    /*
     * An auditor looking at a failed live acceptance needs the whole picture. Stopping at the
     * earliest failure would hide that three separate things were wrong.
     */
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      seedChangeSet(rt.store, { producerRunId: 'SC-RUN-999999' });
      seedReview(rt.store, { changeSetId: 'SC-CS-OTHER' });

      const result = resolve(rt, { recordedFingerprint: '9'.repeat(64) });
      const checks = new Set(result.refusals.map((r) => r.check));
      expect(checks.size).toBeGreaterThanOrEqual(3);
      expect(checks).toContain('MACHINE');
      expect(checks).toContain('PRODUCER_RUN');
    } finally {
      rt.close();
    }
  });
});

/* ======================================================= the whole-product chain */

describe('the Serva chain needs an owner request that actually caused the work', () => {
  function seedTurn(store: Store, over: Record<string, unknown> = {}): void {
    const tx = store.begin();
    const id = String(over['id'] ?? 'SC-TURN-000001');
    tx.putWorking('conversationTurn', id, {
      id,
      text: 'Add order tracking',
      askedAt: '2026-08-24T00:00:00.000Z',
      requestId: 'SC-REQST-000001',
      outcome: 'QUEUED',
      stage: 'QUEUED',
      classification: 'FEATURE',
      queued: ['DEPT-PRODUCT'],
      runIds: ['SC-RUN-000001'],
      ...over,
    });
    tx.commit();
  }

  function resolveServa(rt: ServaRuntime, over: Record<string, unknown> = {}) {
    return resolveLiveServa({
      store: rt.store,
      companyStore: rt.store,
      repoRoot: rt.root,
      machineFingerprint: FINGERPRINT,
      recordedFingerprint: FINGERPRINT,
      qualification: HARD,
      commitExists: () => true,
      ...over,
    } as never);
  }

  it('resolves the full chain from request to accepted commit', () => {
    const rt = project();
    try {
      honestChain(rt);
      seedRun(rt.store, 'SC-RUN-000001', 'SC-AGENT-010');
      seedTurn(rt.store);
      const result = resolveServa(rt);
      expect(result.resolved, JSON.stringify(result.refusals)).toBe(true);
      expect(result.chain?.requestId).toBe('SC-REQST-000001');
      expect(result.chain?.queuedDepartments).toContain('DEPT-PRODUCT');
    } finally {
      rt.close();
    }
  });

  it('refuses when the request names a governed run that does not exist', () => {
    const rt = project();
    try {
      honestChain(rt);
      seedTurn(rt.store, { runIds: ['SC-RUN-INVENTED'] });
      const result = resolveServa(rt);
      expect(result.resolved).toBe(false);
      expect(result.refusals.map((r) => r.check)).toContain('GOVERNED_INTELLIGENCE');
    } finally {
      rt.close();
    }
  });

  it('refuses when no owner request is recorded at all', () => {
    const rt = project();
    try {
      honestChain(rt);
      const result = resolveServa(rt);
      expect(result.resolved).toBe(false);
      expect(result.refusals.map((r) => r.check)).toContain('OWNER_REQUEST');
    } finally {
      rt.close();
    }
  });

  it('refuses when the request was itself refused', () => {
    const rt = project();
    try {
      honestChain(rt);
      seedRun(rt.store, 'SC-RUN-000001', 'SC-AGENT-010');
      seedTurn(rt.store, { outcome: 'REFUSED', queued: [] });
      const result = resolveServa(rt);
      expect(result.resolved).toBe(false);
      expect(JSON.stringify(result.refusals)).toContain('no work followed it');
    } finally {
      rt.close();
    }
  });
});
