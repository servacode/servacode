import { afterEach, describe, expect, it } from 'vitest';
import {
  implementationProducersFrom,
  reviewerAuthorityOf,
  isIndependentReviewer,
} from '../src/acceptance/reviewAuthority.js';
import { ContractRegistry } from '../src/agents/registry.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { CHANGESET_CANON_TYPE } from '../src/engineering/changeset.js';
import { cleanup, tempRoot } from './helpers.js';
import type { Store } from '../src/store/store.js';

/**
 * WHO PRODUCED THIS, AND WHO IS ALLOWED TO JUDGE IT — ASKED OF THE WORLD.
 *
 * SPEC: Phase 6 final acceptance sequence §7; SSA-1, SSA-3.
 *
 * The independent security review found both of these being *declared* rather than derived.
 * `resolveProof` refused a non-independent reviewer only when a caller passed
 * `implementationProducers`, and nothing in production ever did — so the guard that gates
 * READY FOR OWNER USE was inert on the only path that matters. `resolveSecurityReview` read
 * `reviewerAuthority` and the producer set straight out of the review document, which is the
 * file that principle exists to distrust.
 *
 * Both answers are facts about the world and are now asked of it: the producer set from
 * governed execution history in the store, the authority from the agent's own contract.
 * Neither can be supplied by a document, which is what makes forging one pointless.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const PRODUCER = 'SC-AGENT-150';
const REVIEWER = 'SC-AGENT-220';

function project(): ServaRuntime {
  const root = tempRoot();
  roots.push(root);
  return ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root });
}

function seedChangeSet(store: Store, id: string, producerAgentId: string): void {
  const tx = store.begin();
  tx.putCanon(CHANGESET_CANON_TYPE, id, {
    changeSetId: id,
    workItemId: 'SC-WI-000900',
    workspaceId: 'SC-WS-000001',
    attempt: 1,
    producerAgentId,
    producerRunId: 'SC-RUN-' + id,
    baseCommit: 'b'.repeat(40),
    headCommit: 'a'.repeat(40),
    entries: [],
    diffDigest: 'd'.repeat(64),
    digest: 'e'.repeat(64),
    createdAt: '2026-08-25T00:00:00.000Z',
  });
  tx.commit();
}

function seedRun(store: Store, runId: string, agentId: string, roleInTask: string): void {
  const tx = store.begin();
  tx.putCanon('agentRunRecord', runId, {
    runId,
    agentId,
    roleInTask,
    outcome: 'COMPLETED',
    workItemId: 'SC-WI-000900',
    claimAssessments: [],
    evidenceRefs: [],
  });
  tx.commit();
}

describe('the implementation producer set comes from governed history', () => {
  it('finds every agent that actually produced a ChangeSet', () => {
    const rt = project();
    seedChangeSet(rt.store, 'SC-CS-000001', PRODUCER);
    seedChangeSet(rt.store, 'SC-CS-000002', 'SC-AGENT-160');
    const producers = implementationProducersFrom(rt.store);
    expect([...producers].sort()).toEqual(['SC-AGENT-150', 'SC-AGENT-160']);
  });

  it('finds an agent that ran as a PRODUCER even with no ChangeSet of its own', () => {
    /*
     * A run that produced nothing still participated in implementation. Requiring a ChangeSet
     * would let a failed producer review its own successor's work.
     */
    const rt = project();
    seedRun(rt.store, 'SC-RUN-000009', 'SC-AGENT-180', 'PRODUCER');
    expect(implementationProducersFrom(rt.store).has('SC-AGENT-180')).toBe(true);
  });

  it('does not count a VERIFIER run as implementation', () => {
    const rt = project();
    seedRun(rt.store, 'SC-RUN-000010', REVIEWER, 'VERIFIER');
    expect(implementationProducersFrom(rt.store).has(REVIEWER)).toBe(false);
  });

  it('an empty store yields an empty set rather than an error', () => {
    /* A package with no history has no producers, and that is a fact rather than a failure. */
    const rt = project();
    expect(implementationProducersFrom(rt.store).size).toBe(0);
  });
});

describe('reviewer authority comes from the contract, never from a document', () => {
  const registry = ContractRegistry.shared();

  it('reads VERIFY from the agent contract', () => {
    expect(reviewerAuthorityOf(REVIEWER, registry)).toBe('VERIFY');
  });

  it('reads a producer authority as what it is', () => {
    const authority = reviewerAuthorityOf(PRODUCER, registry);
    expect(authority).toBeDefined();
    expect(authority).not.toBe('VERIFY');
  });

  it('an unknown agent has no authority at all', () => {
    /* Not "a default authority" — an id nobody issued is an id that certifies nothing. */
    expect(reviewerAuthorityOf('SC-AGENT-999', registry)).toBeUndefined();
  });
});

describe('independence is decided by both facts together', () => {
  const registry = ContractRegistry.shared();

  it('an independent verifier is independent', () => {
    const rt = project();
    seedChangeSet(rt.store, 'SC-CS-000001', PRODUCER);
    const verdict = isIndependentReviewer(REVIEWER, rt.store, registry);
    expect(verdict.independent, verdict.reasons.join('; ')).toBe(true);
  });

  it('an agent that produced the work cannot review it, whatever it holds', () => {
    const rt = project();
    seedChangeSet(rt.store, 'SC-CS-000001', 'SC-AGENT-200');
    /* SC-AGENT-200 is a VERIFIER by contract, but it produced here, so it is not independent. */
    const verdict = isIndependentReviewer('SC-AGENT-200', rt.store, registry);
    expect(verdict.independent).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('produced');
  });

  it('an agent without verifier authority cannot certify, however independent', () => {
    const rt = project();
    const verdict = isIndependentReviewer(PRODUCER, rt.store, registry);
    expect(verdict.independent).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('authority');
  });

  it('an unknown agent is refused rather than defaulted', () => {
    const rt = project();
    const verdict = isIndependentReviewer('SC-AGENT-999', rt.store, registry);
    expect(verdict.independent).toBe(false);
  });
});
