import { afterEach, describe, expect, it } from 'vitest';
import { EnforcementClass } from '../src/vocab/index.js';
import { ExecutionAvailability, QualificationAttempt } from '../src/substrate/types.js';
import {
  assessProducerContainment,
  assessVerificationBlock,
  resolveLiveEngineering,
  resolveLiveServa,
} from '../src/acceptance/liveProof.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { CHANGESET_CANON_TYPE } from '../src/engineering/changeset.js';
import { REVIEW_CANON_TYPE } from '../src/engineering/review.js';
import { appendRunEvent } from '../src/events/agentRun.js';
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
function seedRun(
  store: Store,
  runId: string,
  agentId: string,
  outcome = 'COMPLETED',
  claimAssessments: readonly unknown[] = [],
): void {
  const tx = store.begin();
  tx.putCanon('agentRunRecord', runId, {
    runId,
    agentId,
    outcome,
    workItemId: 'SC-WI-000900',
    claimAssessments,
    evidenceRefs: [],
  });
  tx.commit();
}

/**
 * A claim the runtime contradicted, in the flattened shape the terminal record persists.
 *
 * `AgentRuntime` builds these as `{ claim, verification }` and the record flattens them, and
 * a first version of the verifier read only the nested form — so every real contradicted
 * claim arrived as kind `OTHER` and the material-kind check never fired. Both shapes are read
 * now, and the flat one is used here because it is what a real store holds.
 */
const contradicted = (kind: string, statement = 'the agent said so') => ({
  kind,
  statement,
  verification: 'CONTRADICTED',
});

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

function seedEvidence(
  store: Store,
  changeSetId = 'SC-CS-000002',
  id = 'SC-EEV-000001',
  over: Record<string, unknown> = {},
): void {
  const tx = store.begin();
  const body: Record<string, unknown> = {
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
    ...over,
  };
  for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k];
  tx.putCanon('engineeringEvidence', id, body);
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
      workItemId: 'SC-WI-000900',
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

  it('refuses when the request and the change belong to different work items', () => {
    /*
     * A real request and a real engineering run, side by side, presented as though one caused
     * the other. Without this they would assemble into a chain that never happened.
     */
    const rt = project();
    try {
      honestChain(rt);
      seedRun(rt.store, 'SC-RUN-000001', 'SC-AGENT-010');
      seedTurn(rt.store, { workItemId: 'SC-WI-SOMETHING-ELSE' });
      const result = resolveServa(rt);
      expect(result.resolved).toBe(false);
      expect(result.refusals.map((r) => r.check)).toContain('SAME_EXECUTION');
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

/* ================================ producer claim integrity vs engineering validity */

describe('an evidence violation may be accepted only when it is contained', () => {
  /*
   * SPEC: Phase 6 live Producer evidence-violation semantics.
   *
   * The first real live run ended this way: the Producer asserted it had attempted to run the
   * test suite, Serva's verifier contradicted that against the event log, and the change was
   * accepted anyway — on measured evidence and an independent review. That is the thesis of
   * the product, and it is also exactly the shape a dishonest acceptance would take, so the
   * difference between the two has to be checkable.
   */

  it('is PROVEN when the violation is quarantined and the acceptance is independently measured', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000004', PRODUCER, 'EVIDENCE_VIOLATION', [
        contradicted('COMMAND_RUN', 'claimed to have run the suite; the event log says otherwise'),
      ]);
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      seedChangeSet(rt.store);
      /* Measured by a runtime component, with no reference to the Producer's run. */
      seedEvidence(rt.store);
      seedReview(rt.store);
      seedAccepted(rt.store);

      const result = resolve(rt);
      expect(result.resolved, JSON.stringify(result.refusals)).toBe(true);
      expect(result.chain?.producerOutcome).toBe('EVIDENCE_VIOLATION');
      expect(result.chain?.containment.contained).toBe(true);
      expect(result.chain?.containment.contradictedClaims[0]?.kind).toBe('COMMAND_RUN');
      expect(result.chain?.containment.creditedFromProducer).toEqual([]);
    } finally {
      rt.close();
    }
  });

  it('is REFUSED when a contradicted claim was credited as acceptance evidence', () => {
    /* The one thing an evidence violation makes unusable: the Producer's own account. */
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000004', PRODUCER, 'EVIDENCE_VIOLATION', [
        contradicted('COMMAND_RUN'),
      ]);
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      seedChangeSet(rt.store);
      seedEvidence(rt.store);
      /* Evidence traceable to the Producer's own run. */
      seedEvidence(rt.store, 'SC-CS-000002', 'SC-EEV-000002', {
        runRef: 'SC-RUN-000004',
        basis: 'JUDGED',
        evidenceClass: 'JUDGMENT',
        runtimeComponentId: undefined,
      });
      seedReview(rt.store);
      seedAccepted(rt.store);

      const result = resolve(rt);
      expect(result.resolved).toBe(false);
      expect(result.refusals.map((r) => r.check)).toContain('PRODUCER_CONTAINMENT');
      expect(JSON.stringify(result.refusals)).toContain('credits the Producer run');
    } finally {
      rt.close();
    }
  });

  it('is REFUSED when a contradicted material claim is covered by no independent measurement', () => {
    /*
     * A Producer wrong about a file it wrote is harmless when something else checked the
     * files, and a hole when nothing did. Here the only measurement is the test recipe, and
     * the contradicted claim is about the filesystem.
     */
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000004', PRODUCER, 'EVIDENCE_VIOLATION', [
        contradicted('FILE_WRITTEN', 'claimed to have written a file nobody observed'),
      ]);
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      seedChangeSet(rt.store);
      seedEvidence(rt.store, 'SC-CS-000002', 'SC-EEV-000001', {
        runtimeComponentId: 'SC-RTC-012',
      });
      seedReview(rt.store);
      seedAccepted(rt.store);

      const result = resolve(rt);
      expect(result.resolved).toBe(false);
      expect(JSON.stringify(result.refusals)).toContain(
        'not covered by any independent measurement',
      );
    } finally {
      rt.close();
    }
  });

  it('is REFUSED when the violation itself was never durably recorded', () => {
    /* An unexamined violation is not a contained one. */
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000004', PRODUCER, 'EVIDENCE_VIOLATION', []);
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      seedChangeSet(rt.store);
      seedEvidence(rt.store);
      seedReview(rt.store);
      seedAccepted(rt.store);

      const result = resolve(rt);
      expect(result.resolved).toBe(false);
      expect(JSON.stringify(result.refusals)).toContain('not durably recorded');
    } finally {
      rt.close();
    }
  });

  it('a clean Producer is still checked for having certified itself', () => {
    /*
     * The containment analysis runs for every chain, not only a violating one. A check that
     * only fired when something already looked wrong would never catch the case where nothing
     * looked wrong.
     */
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000004', PRODUCER);
      seedRun(rt.store, 'SC-RUN-000005', REVIEWER);
      seedChangeSet(rt.store);
      seedEvidence(rt.store, 'SC-CS-000002', 'SC-EEV-000001', { runRef: 'SC-RUN-000004' });
      seedReview(rt.store);
      seedAccepted(rt.store);

      const result = resolve(rt);
      expect(result.resolved).toBe(false);
      expect(JSON.stringify(result.refusals)).toContain('credits the Producer run');
    } finally {
      rt.close();
    }
  });
});

/* ========== PARTIAL: an honest verification block is not an incomplete change ========== */

describe('a PARTIAL caused by the intentional Producer execution policy', () => {
  /*
   * SPEC: Phase 6 LIVE-ENGINEERING PARTIAL semantics (locked).
   *
   * The Producer holds `Bash` in its available toolset and NO approving `Bash(...)` rule in
   * its grant, so under `dontAsk` every Bash call is denied. That is deliberate — the comment
   * at `dispatch.ts:122` calls it "the right default" — and it is the whole reason a test
   * result is trustworthy: `SC-RTC-012` is documented as "the one whose result a Producer
   * cannot assert."
   *
   * So the correct behaviour for a Producer that cannot run the test is to say so. When one
   * does, it ends PARTIAL, and refusing the acceptance would punish the exact honesty the
   * trust model is built to reward — while the thing that actually verifies the change, the
   * independent measured check, passed.
   *
   * This is NOT a general tolerance for PARTIAL. Every condition below is re-derived from
   * governed evidence, and a PARTIAL that means "I did not finish the work" still refuses.
   */

  /** The grant the runtime actually bound: Bash available, Bash never approved. */
  const POLICY_GRANT = {
    available: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
    approve: ['Read(**)', 'Glob(**)', 'Grep(**)', 'Edit(**)', 'Write(**)'],
    deny: ['Bash(git push*)', 'Bash(curl*)'],
  };

  /** A Producer run that fixed the defect and was denied the test command. */
  function seedBlockedProducer(
    store: Store,
    runId: string,
    over: Record<string, unknown> = {},
  ): void {
    const tx = store.begin();
    tx.putCanon('agentRunRecord', runId, {
      runId,
      agentId: PRODUCER,
      outcome: 'PARTIAL',
      workItemId: 'SC-WI-000900',
      toolCalls: [
        { tool: 'Edit', allowed: true, subject: 'src/total.js' },
        { tool: 'Bash', allowed: false, subject: 'node test.js; echo "exit=$?"' },
      ],
      escalations: [
        {
          condition: 'VERIFICATION_BLOCKED',
          detail: 'the Bash call was denied; I will not claim a test result I did not observe',
          blocking: false,
        },
      ],
      claimAssessments: [
        { kind: 'FILE_WRITTEN', statement: 'edited src/total.js', verification: 'CORROBORATED' },
        {
          kind: 'COMMAND_RUN',
          statement: 'attempted node test.js; the call was refused',
          verification: 'UNVERIFIED',
        },
      ],
      evidenceRefs: [],
      ...over,
    });
    /*
     * The grant goes in the TRACE, because that is where the runtime writes it. Seeding it
     * onto the terminal record instead would make these tests pass against a field no real
     * run has ever carried.
     */
    appendRunEvent(tx, runId, {
      type: 'CAPABILITY_BOUND',
      payload: (over['capabilityGrant'] ?? POLICY_GRANT) as Record<string, unknown>,
    });
    tx.commit();
  }

  function chain(store: Store, producerRunId = 'SC-RUN-000004'): Record<string, unknown> {
    seedChangeSet(store, { producerRunId });
    seedReview(store);
    seedEvidence(store);
    seedEvidence(store, 'SC-CS-000002', 'SC-EEV-000002', { runtimeComponentId: 'SC-RTC-005' });
    return {};
  }

  it('resolves when the block is attributable to the policy and everything else holds', () => {
    const rt = project();
    seedBlockedProducer(rt.store, 'SC-RUN-000004');
    chain(rt.store);
    const verdict = assessVerificationBlock(rt.store, 'SC-RUN-000004', 'SC-CS-000002');
    expect(verdict.reasons, verdict.reasons.join('; ')).toEqual([]);
    expect(verdict.contained).toBe(true);
    expect(verdict.blockedTool).toBe('Bash');
  });

  it('accepts the block however the agent labelled its escalation', () => {
    /*
     * A real run labelled the same block AUTHORITY_EXCEEDED rather than VERIFICATION_BLOCKED:
     * same denied `node test.js`, same honest refusal to claim an unobserved result, same edit
     * landed. Matching one literal condition string is routing on how something classified
     * itself, which is the failure this codebase keeps meeting — the label is the agent's
     * word, and the denied tool call against the bound grant is the governed fact.
     *
     * So an escalation must exist, because a PARTIAL nobody explained is unexplained; but
     * WHICH condition it names does not decide the question.
     */
    const rt = project();
    seedBlockedProducer(rt.store, 'SC-RUN-000004', {
      escalations: [
        {
          condition: 'AUTHORITY_EXCEEDED',
          detail: 'Test execution was denied by the sandbox permission policy (Bash, dont-ask).',
          blocking: true,
        },
      ],
    });
    chain(rt.store);
    const verdict = assessVerificationBlock(rt.store, 'SC-RUN-000004', 'SC-CS-000002');
    expect(verdict.reasons, verdict.reasons.join('; ')).toEqual([]);
    expect(verdict.contained).toBe(true);
  });

  it('accepts an escalation that names the denied COMMAND rather than the tool', () => {
    /*
     * A real run escalated: "`node test.js` returned a permission denial from the sandbox in
     * don't-ask mode". Unambiguously about the denial — and my check demanded the word
     * `Bash`, which is the TOOL Serva denied rather than the command the agent ran.
     *
     * That is the same mistake as matching on the escalation's condition label, one field
     * over: an agent describes what it tried to do, not which tool wrapper carried it. Both
     * spellings identify the same denied call, and the runtime recorded both.
     */
    const rt = project();
    seedBlockedProducer(rt.store, 'SC-RUN-000004', {
      escalations: [
        {
          condition: 'AUTHORITY_EXCEEDED',
          detail: '`node test.js` returned a permission denial from the sandbox in dont-ask mode',
          blocking: true,
        },
      ],
    });
    chain(rt.store);
    const verdict = assessVerificationBlock(rt.store, 'SC-RUN-000004', 'SC-CS-000002');
    expect(verdict.reasons, verdict.reasons.join('; ')).toEqual([]);
    expect(verdict.contained).toBe(true);
  });

  it('refuses an escalation about something other than the denied tool', () => {
    /* Any escalation must not do: one about an unrelated concern explains no block at all. */
    const rt = project();
    seedBlockedProducer(rt.store, 'SC-RUN-000004', {
      escalations: [
        { condition: 'AMBIGUITY', detail: 'the requirement is unclear', blocking: false },
      ],
    });
    chain(rt.store);
    const verdict = assessVerificationBlock(rt.store, 'SC-RUN-000004', 'SC-CS-000002');
    expect(verdict.contained).toBe(false);
  });

  it('refuses a PARTIAL that recorded no verification block at all', () => {
    /* PARTIAL meaning "I stopped early" is not PARTIAL meaning "I was not allowed to check". */
    const rt = project();
    seedBlockedProducer(rt.store, 'SC-RUN-000004', { escalations: [] });
    chain(rt.store);
    const verdict = assessVerificationBlock(rt.store, 'SC-RUN-000004', 'SC-CS-000002');
    expect(verdict.contained).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('no escalation at all');
  });

  it('refuses when the block is not attributable to the Producer execution policy', () => {
    /*
     * The distinguishing fact is canonical: the denied tool is AVAILABLE and carries no
     * approving rule. A tool denied for any other reason is an unexplained environment
     * failure, and an unexplained failure is never a contained one.
     */
    const rt = project();
    seedBlockedProducer(rt.store, 'SC-RUN-000004', {
      capabilityGrant: {
        ...POLICY_GRANT,
        approve: [...POLICY_GRANT.approve, 'Bash(node test.js)'],
      },
    });
    chain(rt.store);
    const verdict = assessVerificationBlock(rt.store, 'SC-RUN-000004', 'SC-CS-000002');
    expect(verdict.contained).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('policy');
  });

  it('refuses when the implementation itself is unfinished', () => {
    /* A blocked check on work that was never done is not an honest verification gap. */
    const rt = project();
    seedBlockedProducer(rt.store, 'SC-RUN-000004', {
      toolCalls: [{ tool: 'Bash', allowed: false, subject: 'node test.js' }],
    });
    chain(rt.store);
    const verdict = assessVerificationBlock(rt.store, 'SC-RUN-000004', 'SC-CS-000002');
    expect(verdict.contained).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('no file');
  });

  it('refuses when a Producer claim was contradicted', () => {
    const rt = project();
    seedBlockedProducer(rt.store, 'SC-RUN-000004', {
      claimAssessments: [
        { kind: 'TEST_RESULT', statement: 'the tests pass', verification: 'CONTRADICTED' },
      ],
    });
    chain(rt.store);
    const verdict = assessVerificationBlock(rt.store, 'SC-RUN-000004', 'SC-CS-000002');
    expect(verdict.contained).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('contradicted');
  });

  it('refuses when nothing independently measured the blocked verification', () => {
    /*
     * The whole justification is that the check the Producer could not run was run by
     * something that could. Without it there is no verification, only a gap.
     */
    const rt = project();
    seedBlockedProducer(rt.store, 'SC-RUN-000004');
    seedChangeSet(rt.store, { producerRunId: 'SC-RUN-000004' });
    seedReview(rt.store);
    seedEvidence(rt.store, 'SC-CS-000002', 'SC-EEV-000002', { runtimeComponentId: 'SC-RTC-005' });
    const verdict = assessVerificationBlock(rt.store, 'SC-RUN-000004', 'SC-CS-000002');
    expect(verdict.contained).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('SC-RTC-012');
  });

  it('refuses when the independent measured check FAILED', () => {
    const rt = project();
    seedBlockedProducer(rt.store, 'SC-RUN-000004');
    seedChangeSet(rt.store, { producerRunId: 'SC-RUN-000004' });
    seedReview(rt.store);
    seedEvidence(rt.store, 'SC-CS-000002', 'SC-EEV-000001', { outcome: 'FAIL' });
    const verdict = assessVerificationBlock(rt.store, 'SC-RUN-000004', 'SC-CS-000002');
    expect(verdict.contained).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('FAIL');
  });
  it('refuses a terminal outcome that is not PARTIAL', () => {
    for (const outcome of ['FAILED', 'REFUSED', 'BLOCKED', 'SCOPE_VIOLATION']) {
      const rt = project();
      seedBlockedProducer(rt.store, 'SC-RUN-000004', { outcome });
      chain(rt.store);
      const verdict = assessVerificationBlock(rt.store, 'SC-RUN-000004', 'SC-CS-000002');
      expect(verdict.contained, outcome).toBe(false);
      expect(verdict.reasons.join(' '), outcome).toContain(outcome);
    }
  });

  it('refuses a run that does not resolve at all', () => {
    const rt = project();
    chain(rt.store);
    const verdict = assessVerificationBlock(rt.store, 'SC-RUN-NOPE', 'SC-CS-000002');
    expect(verdict.contained).toBe(false);
  });

  it('reads the grant from CAPABILITY_BOUND, not from the terminal record', () => {
    /*
     * The AgentRun projection has never written `capabilityGrant` onto the terminal record. A
     * first version of this assessor read exactly that, so `available` was empty for every
     * real run and no denial could ever be attributed. It failed closed — the safe direction —
     * but it proved nothing about the run it was asked about, which is its own kind of wrong.
     */
    const rt = project();
    seedBlockedProducer(rt.store, 'SC-RUN-000004');
    chain(rt.store);
    expect(assessVerificationBlock(rt.store, 'SC-RUN-000004', 'SC-CS-000002').contained).toBe(true);

    /* With no CAPABILITY_BOUND event the answer is a refusal, never a silent pass. */
    const bare = project();
    const tx = bare.store.begin();
    tx.putCanon('agentRunRecord', 'SC-RUN-000004', {
      runId: 'SC-RUN-000004',
      agentId: PRODUCER,
      outcome: 'PARTIAL',
      toolCalls: [
        { tool: 'Edit', allowed: true, subject: 'src/total.js' },
        { tool: 'Bash', allowed: false, subject: 'node test.js' },
      ],
      escalations: [{ condition: 'VERIFICATION_BLOCKED', detail: 'denied', blocking: false }],
      claimAssessments: [],
      evidenceRefs: [],
    });
    tx.commit();
    chain(bare.store);
    const verdict = assessVerificationBlock(bare.store, 'SC-RUN-000004', 'SC-CS-000002');
    expect(verdict.contained).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('CAPABILITY_BOUND');
  });
});

/* ============ SSA-2: the self-certification filter that erased its own JUDGED branch ============ */

describe('evidence that credits the Producer, including agent-judged evidence', () => {
  /*
   * SPEC: finding SSA-2 (MEDIUM), from the independent security review.
   *
   * The filter read
   *
   *   .filter((e) => e.runRef === producerRunId || e.basis === 'JUDGED')
   *   .filter((e) => e.runRef === producerRunId)
   *
   * and the second line deletes the first line's JUDGED clause entirely. The comment above it
   * says "Any at all is the Producer certifying itself", so the code and its documented intent
   * had drifted apart — and the narrower behaviour is the dangerous direction: agent-opinion
   * evidence not tied to the producer run was never counted as self-certification at all.
   *
   * This is the failure mode this codebase keeps meeting. A filter that reads the wrong thing
   * does not error; it quietly agrees with you.
   */
  function chainWith(rt: ServaRuntime, evidence: Record<string, unknown>[]): void {
    seedRun(rt.store, 'SC-RUN-000004', PRODUCER, 'EVIDENCE_VIOLATION', [
      contradicted('FILE_WRITTEN'),
    ]);
    seedChangeSet(rt.store, { producerRunId: 'SC-RUN-000004' });
    seedReview(rt.store);
    for (const [i, over] of evidence.entries()) {
      seedEvidence(rt.store, 'SC-CS-000002', 'SC-EEV-00000' + String(i + 1), over);
    }
  }

  it('counts evidence produced by the Producer run itself', () => {
    const rt = project();
    chainWith(rt, [{ runRef: 'SC-RUN-000004', basis: 'MEASURED' }]);
    const c = assessProducerContainment(rt.store, 'SC-RUN-000004', 'SC-CS-000002');
    expect(c.creditedFromProducer).toContain('SC-EEV-000001');
    expect(c.contained).toBe(false);
  });

  it('counts JUDGED evidence as self-certifying even from another run', () => {
    /*
     * The clause the second filter deleted. Agent opinion is not measurement whoever produced
     * it, and crediting it would let a second agent vouch for the first.
     */
    const rt = project();
    chainWith(rt, [
      { runRef: 'SC-RUN-000009', basis: 'JUDGED' },
      { id: 'SC-EEV-000002', runtimeComponentId: 'SC-RTC-005', basis: 'MEASURED' },
    ]);
    const c = assessProducerContainment(rt.store, 'SC-RUN-000004', 'SC-CS-000002');
    expect(c.creditedFromProducer).toContain('SC-EEV-000001');
  });

  it('leaves independently measured evidence uncredited, so it still counts as measurement', () => {
    const rt = project();
    chainWith(rt, [{ runRef: 'SC-RUN-RUNTIME', basis: 'MEASURED' }]);
    const c = assessProducerContainment(rt.store, 'SC-RUN-000004', 'SC-CS-000002');
    expect(c.creditedFromProducer).toEqual([]);
    expect(c.measuredEvidence).toContain('SC-EEV-000001');
  });

  it('does not widen what counts as measured evidence', () => {
    /* The fix must not turn JUDGED evidence into something that can support an acceptance. */
    const rt = project();
    chainWith(rt, [{ runRef: 'SC-RUN-000009', basis: 'JUDGED' }]);
    const c = assessProducerContainment(rt.store, 'SC-RUN-000004', 'SC-CS-000002');
    expect(c.measuredEvidence).toEqual([]);
    expect(c.reasons.join(' ')).toContain('no independently measured evidence');
  });
});

/* ====== SWEEP: the live chain resolves its reviewer like everything else does ====== */

describe('the live chain proves reviewer authority, not merely a different name', () => {
  /*
   * SPEC: Phase 6 security invariant sweep; HIGH finding
   * SERVA-SELF-ACCEPTANCE-AUTHORITY/SSA-REV-1.
   *
   * `resolveLiveEngineering` checked `review.reviewerAgentId === producerAgentId` and stopped
   * there. Any agent with a different id and a persisted review record showing PASS satisfied
   * the "independent Reviewer" requirement of LIVE-ENGINEERING and LIVE-SERVA — a second
   * Producer, or an agent holding no verifier contract at all.
   *
   * The round that added this check to `proof.ts`'s JUDGED branch and to
   * `reviewAuthority.ts` never carried it here, which is the pattern this sweep exists to end.
   */
  it('refuses a reviewer whose contract grants no verifier authority', () => {
    const rt = project();
    /* SC-AGENT-180 is a real agent, genuinely not the producer, and holds EXECUTE. */
    seedRun(rt.store, 'SC-RUN-000004', PRODUCER);
    seedRun(rt.store, 'SC-RUN-000005', 'SC-AGENT-180');
    seedChangeSet(rt.store);
    seedEvidence(rt.store);
    seedReview(rt.store, { reviewerAgentId: 'SC-AGENT-180', runRef: 'SC-RUN-000005' });
    seedAccepted(rt.store);

    const result = resolve(rt);
    expect(result.resolved).toBe(false);
    expect(JSON.stringify(result.refusals)).toMatch(/authoris|authority/i);
  });

  it('refuses a reviewer whose cited run does not resolve', () => {
    const rt = project();
    seedRun(rt.store, 'SC-RUN-000004', PRODUCER);
    seedChangeSet(rt.store);
    seedEvidence(rt.store);
    seedReview(rt.store, { runRef: 'SC-RUN-INVENTED' });
    seedAccepted(rt.store);

    const result = resolve(rt);
    expect(result.resolved).toBe(false);
  });

  it('refuses a reviewer that borrowed a real run made by someone else', () => {
    const rt = project();
    seedRun(rt.store, 'SC-RUN-000004', PRODUCER);
    seedRun(rt.store, 'SC-RUN-000005', 'SC-AGENT-180');
    seedChangeSet(rt.store);
    seedEvidence(rt.store);
    /* The record names the real REVIEWER while citing a run that agent never made. */
    seedReview(rt.store, { reviewerAgentId: REVIEWER, runRef: 'SC-RUN-000005' });
    seedAccepted(rt.store);

    const result = resolve(rt);
    expect(result.resolved).toBe(false);
  });

  it('accepts a genuine verifier, resolved from its own run', () => {
    const rt = project();
    honestChain(rt);
    const result = resolve(rt);
    expect(result.resolved, JSON.stringify(result.refusals)).toBe(true);
  });
});
