import { afterEach, describe, expect, it } from 'vitest';
import { aggregateSecurityReview } from '../src/acceptance/securityAggregate.js';
import { ScopeCoverage, recordScopeReview } from '../src/acceptance/scopeReview.js';
import { REQUIRED_SCOPE, ReviewVerdict, Severity } from '../src/acceptance/securityReview.js';
import { reviewUnitsFor } from '../src/acceptance/securityReviewRun.js';
import { ContractRegistry } from '../src/agents/registry.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { cleanup, tempRoot } from './helpers.js';
import type { Store } from '../src/store/store.js';

/**
 * THE FINAL REVIEW IS AN AGGREGATE OF REAL SCOPED REVIEWS, NOT A SUMMARY OF THEM.
 *
 * SPEC: Phase 6 final acceptance sequence §7.
 *
 * Seventeen areas reviewed in twenty-two governed runs have to add up to one answer, and the
 * adding-up is where a review quietly becomes prose: sixteen clean areas and one that never
 * ran is not "mostly reviewed", and a HIGH finding nobody resolved is not a detail of an
 * otherwise green report.
 *
 * So the aggregate resolves from persisted scope records and refuses on anything less than
 * complete coverage of every required area at one commit, with no unresolved CRITICAL or HIGH
 * finding anywhere in it.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const REVIEWER = 'SC-AGENT-220';
const REPOSITORY = { commit: COMMIT, tree: TREE };

function project(): ServaRuntime {
  const root = tempRoot();
  roots.push(root);
  return ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root });
}

/** Every unit of every required area, reviewed cleanly. */
function seedCompleteReview(
  store: Store,
  over: (unit: string) => Record<string, unknown> = () => ({}),
): void {
  let n = 0;
  for (const area of REQUIRED_SCOPE) {
    for (const { unit } of reviewUnitsFor(area)) {
      n += 1;
      const runId = 'SC-RUN-' + String(n).padStart(6, '0');
      /*
       * The run is seeded too, because the aggregate now RESOLVES it rather than believing the
       * record. A fixture that recorded reviews for runs that never happened was describing a
       * world the verifier is right to refuse.
       */
      const tx = store.begin();
      tx.putCanon('agentRunRecord', runId, {
        runId,
        agentId: REVIEWER,
        outcome: 'COMPLETED',
        roleInTask: 'VERIFIER',
      });
      tx.commit();

      recordScopeReview(store, {
        scopeId: '',
        scopeName: unit,
        implementationCommit: COMMIT,
        treeDigest: TREE,
        reviewerRunId: runId,
        reviewerAgentId: REVIEWER,
        coverage: ScopeCoverage.COMPLETE,
        filesReviewed: ['src/x.ts'],
        filesOmitted: [],
        findings: [],
        verdict: ReviewVerdict.ACCEPTED,
        terminalOutcome: 'COMPLETED',
        reviewedAt: '2026-08-25T00:00:00.000Z',
        ...over(unit),
      });
    }
  }
}

function aggregate(rt: ServaRuntime) {
  return aggregateSecurityReview({
    store: rt.store,
    repository: REPOSITORY,
    registry: ContractRegistry.shared(),
    reviewedAt: '2026-08-25T01:00:00.000Z',
  });
}

describe('a complete, clean aggregate resolves', () => {
  it('resolves when every required area is covered at this commit', () => {
    const rt = project();
    seedCompleteReview(rt.store);
    const result = aggregate(rt);
    expect(result.refusals, result.refusals.join('; ')).toEqual([]);
    expect(result.review?.verdict).toBe(ReviewVerdict.ACCEPTED);
    expect(result.review?.scope).toEqual([...REQUIRED_SCOPE]);
  });

  it('carries every finding through, and names the runs it aggregated', () => {
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === 'Reconciliation'
        ? {
            findings: [
              {
                id: 'R-1',
                severity: Severity.LOW,
                area: unit,
                statement: 'a note',
                evidence: ['src/engineering/reconcile.ts:1'],
                resolved: false,
              },
            ],
          }
        : {},
    );
    const result = aggregate(rt);
    expect(result.review?.findings.length).toBe(1);
    expect(result.scopeRunIds.length).toBeGreaterThanOrEqual(REQUIRED_SCOPE.length);
  });
});

describe('the aggregate refuses anything less than a real review of everything', () => {
  it('refuses a missing area', () => {
    const rt = project();
    seedCompleteReview(rt.store);
    /* Drop one area's records by reviewing everything except it. */
    const dropped = project();
    for (const area of REQUIRED_SCOPE.filter((a) => a !== 'migration')) {
      for (const { unit } of reviewUnitsFor(area)) {
        recordScopeReview(dropped.store, {
          scopeId: '',
          scopeName: unit,
          implementationCommit: COMMIT,
          treeDigest: TREE,
          reviewerRunId: 'SC-RUN-' + unit.replace(/[^a-z]/gi, ''),
          reviewerAgentId: REVIEWER,
          coverage: ScopeCoverage.COMPLETE,
          filesReviewed: ['src/x.ts'],
          filesOmitted: [],
          findings: [],
          verdict: ReviewVerdict.ACCEPTED,
          terminalOutcome: 'COMPLETED',
          reviewedAt: '2026-08-25T00:00:00.000Z',
        });
      }
    }
    const result = aggregate(dropped);
    expect(result.review).toBeUndefined();
    expect(result.refusals.join(' ')).toContain('migration');
  });

  it('refuses a sub-scope that was not reviewed, even when its siblings were', () => {
    /* An area is covered only when every unit of it is. Five sixths is not coverage. */
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === 'organizational learning — core'
        ? { coverage: ScopeCoverage.NOT_REVIEWED, verdict: ReviewVerdict.NOT_VERIFIED }
        : {},
    );
    const result = aggregate(rt);
    expect(result.review).toBeUndefined();
    expect(result.refusals.join(' ')).toContain('organizational learning');
  });

  it('refuses PARTIAL coverage, however clean its verdict', () => {
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === 'AI Runtime'
        ? { coverage: ScopeCoverage.PARTIAL, filesOmitted: ['src/agents/runtime.ts'] }
        : {},
    );
    const result = aggregate(rt);
    expect(result.review).toBeUndefined();
    expect(result.refusals.join(' ')).toContain('AI Runtime');
  });

  it('refuses an EVIDENCE_VIOLATION attempt', () => {
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === 'Research trust'
        ? {
            terminalOutcome: 'EVIDENCE_VIOLATION',
            coverage: ScopeCoverage.NOT_REVIEWED,
            verdict: ReviewVerdict.NOT_VERIFIED,
          }
        : {},
    );
    const result = aggregate(rt);
    expect(result.review).toBeUndefined();
    expect(result.refusals.join(' ')).toContain('Research trust');
  });

  it('refuses an unresolved HIGH finding', () => {
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === 'Owner authority'
        ? {
            verdict: ReviewVerdict.BLOCKED,
            findings: [
              {
                id: 'OA-1',
                severity: Severity.HIGH,
                area: unit,
                statement: 'the guard is inert',
                evidence: ['src/acceptance/proof.ts:445'],
                resolved: false,
              },
            ],
          }
        : {},
    );
    const result = aggregate(rt);
    expect(result.review).toBeUndefined();
    expect(result.refusals.join(' ')).toContain('HIGH');
  });

  it('accepts a HIGH finding that is recorded as resolved', () => {
    /* Resolution is a recorded fact, not an absence. A fixed finding stays in the evidence. */
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === 'Owner authority'
        ? {
            findings: [
              {
                id: 'OA-1',
                severity: Severity.HIGH,
                area: unit,
                statement: 'the guard was inert',
                evidence: ['src/acceptance/proof.ts:445'],
                resolved: true,
                resolvedNote: 'fixed: the producer set is derived from governed history',
              },
            ],
          }
        : {},
    );
    const result = aggregate(rt);
    expect(result.refusals, result.refusals.join('; ')).toEqual([]);
    expect(result.review?.findings.length).toBe(1);
  });

  it('refuses evidence bound to a different commit', () => {
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === 'bootstrap' ? { implementationCommit: 'c'.repeat(40) } : {},
    );
    const result = aggregate(rt);
    expect(result.review).toBeUndefined();
    expect(result.refusals.join(' ')).toContain('bootstrap');
  });

  it('refuses a reviewer that holds no verifier authority', () => {
    const rt = project();
    seedCompleteReview(rt.store, () => ({ reviewerAgentId: 'SC-AGENT-150' }));
    const result = aggregate(rt);
    expect(result.review).toBeUndefined();
    expect(result.refusals.join(' ')).toContain('authority');
  });

  it('refuses a reviewer that produced the implementation', () => {
    const rt = project();
    const tx = rt.store.begin();
    tx.putCanon('agentRunRecord', 'SC-RUN-PRODUCED', {
      runId: 'SC-RUN-PRODUCED',
      agentId: 'SC-AGENT-200',
      roleInTask: 'PRODUCER',
      outcome: 'COMPLETED',
    });
    tx.commit();
    seedCompleteReview(rt.store, () => ({ reviewerAgentId: 'SC-AGENT-200' }));
    const result = aggregate(rt);
    expect(result.review).toBeUndefined();
    expect(result.refusals.join(' ')).toContain('produced');
  });

  it('an empty store proves nothing at all', () => {
    const rt = project();
    const result = aggregate(rt);
    expect(result.review).toBeUndefined();
    expect(result.refusals.length).toBeGreaterThan(0);
  });
});

describe('the aggregate re-resolves the runs it aggregates', () => {
  /*
   * SPEC: HIGH findings SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-F1 and F2, from the independent
   * review — both against this module, written earlier in this same effort.
   *
   * F1: the aggregate derived authority and independence canonically and then took each scope
   * record's `terminalOutcome` on its word, never resolving `reviewerRunId` against
   * `agentRunRecord`. `resolveSecurityReview` does exactly that check a few files away, with a
   * comment explaining why — so this module had the fix in view and did not apply it.
   * `resolveProof` re-verifies only the ONE run the aggregate names, so the other twenty-one
   * were confirmed by nobody.
   *
   * F2: `latestByScope` kept only the newest attempt per unit, so a CRITICAL recorded by an
   * earlier attempt vanished if a later one simply did not re-report it. `scopeReview.ts`'s
   * own docstring rejects that inference in as many words: "a finding that stops appearing may
   * have been fixed, or may simply not have been looked for." Retrying a scope must not
   * un-block a review.
   */
  function seedReviewerRun(store: Store, runId: string, agentId = REVIEWER, outcome = 'COMPLETED') {
    const tx = store.begin();
    tx.putCanon('agentRunRecord', runId, { runId, agentId, outcome, roleInTask: 'VERIFIER' });
    tx.commit();
  }

  it('refuses a scope record whose reviewer run does not exist', () => {
    const rt = project();
    seedCompleteReview(rt.store);
    /*
     * One record cites a run nobody recorded — the shape a fabricated review takes: a real
     * scope, a plausible run id, and nothing behind it.
     */
    recordScopeReview(rt.store, {
      scopeId: '',
      scopeName: 'Reconciliation',
      implementationCommit: COMMIT,
      treeDigest: TREE,
      reviewerRunId: 'SC-RUN-INVENTED',
      reviewerAgentId: REVIEWER,
      coverage: ScopeCoverage.COMPLETE,
      filesReviewed: ['src/engineering/reconcile.ts'],
      filesOmitted: [],
      findings: [],
      verdict: ReviewVerdict.ACCEPTED,
      terminalOutcome: 'COMPLETED',
      /* Later than the seeded attempt, so this is the one coverage resolves from. */
      reviewedAt: '2026-08-26T00:00:00.000Z',
    });

    const result = aggregate(rt);
    expect(result.review).toBeUndefined();
    expect(result.refusals.join(' ')).toMatch(/does not resolve|does not exist/i);
  });

  it('refuses a reviewer run that did not COMPLETE, whatever the record claims', () => {
    const rt = project();
    seedCompleteReview(rt.store);
    let n = 0;
    for (const area of REQUIRED_SCOPE) {
      for (let i = 0; i < reviewUnitsFor(area).length; i += 1) {
        n += 1;
        seedReviewerRun(
          rt.store,
          'SC-RUN-' + String(n).padStart(6, '0'),
          REVIEWER,
          n === 3 ? 'FAILED' : 'COMPLETED',
        );
      }
    }
    const result = aggregate(rt);
    expect(result.review).toBeUndefined();
    expect(result.refusals.join(' ')).toContain('FAILED');
  });

  it('refuses a run made by a different agent than the record names', () => {
    const rt = project();
    seedCompleteReview(rt.store);
    let n = 0;
    for (const area of REQUIRED_SCOPE) {
      for (let i = 0; i < reviewUnitsFor(area).length; i += 1) {
        n += 1;
        seedReviewerRun(
          rt.store,
          'SC-RUN-' + String(n).padStart(6, '0'),
          n === 5 ? 'SC-AGENT-200' : REVIEWER,
        );
      }
    }
    const result = aggregate(rt);
    expect(result.review).toBeUndefined();
    expect(result.refusals.join(' ')).toMatch(/SC-AGENT-200|made by/);
  });

  it('resolves when every cited run is real, completed and by the named agent', () => {
    const rt = project();
    seedCompleteReview(rt.store);
    let n = 0;
    for (const area of REQUIRED_SCOPE) {
      for (let i = 0; i < reviewUnitsFor(area).length; i += 1) {
        n += 1;
        seedReviewerRun(rt.store, 'SC-RUN-' + String(n).padStart(6, '0'));
      }
    }
    const result = aggregate(rt);
    expect(result.refusals, result.refusals.join('; ')).toEqual([]);
    expect(result.review?.verdict).toBe(ReviewVerdict.ACCEPTED);
  });

  it('a retry does not erase an earlier unresolved CRITICAL', () => {
    /* F2: history stays, and an unresolved finding keeps blocking until it is RESOLVED. */
    const rt = project();
    seedCompleteReview(rt.store);
    let n = 0;
    for (const area of REQUIRED_SCOPE) {
      for (let i = 0; i < reviewUnitsFor(area).length; i += 1) {
        n += 1;
        seedReviewerRun(rt.store, 'SC-RUN-' + String(n).padStart(6, '0'));
      }
    }

    /* An EARLIER attempt at one scope found something CRITICAL and nobody resolved it. */
    seedReviewerRun(rt.store, 'SC-RUN-EARLIER');
    recordScopeReview(rt.store, {
      scopeId: '',
      scopeName: 'Reconciliation',
      implementationCommit: COMMIT,
      treeDigest: TREE,
      reviewerRunId: 'SC-RUN-EARLIER',
      reviewerAgentId: REVIEWER,
      coverage: ScopeCoverage.COMPLETE,
      filesReviewed: ['src/engineering/reconcile.ts'],
      filesOmitted: [],
      findings: [
        {
          id: 'R-CRIT',
          severity: Severity.CRITICAL,
          area: 'Reconciliation',
          statement: 'evidence can be trusted after an external change',
          evidence: ['src/engineering/reconcile.ts:234'],
          resolved: false,
        },
      ],
      verdict: ReviewVerdict.BLOCKED,
      terminalOutcome: 'COMPLETED',
      /* Earlier in time than the clean attempt seeded above. */
      reviewedAt: '2026-08-24T00:00:00.000Z',
    });

    const result = aggregate(rt);
    expect(result.review, 'a retry silently un-blocked the review').toBeUndefined();
    expect(result.refusals.join(' ')).toContain('R-CRIT');
  });

  it('an earlier finding recorded as RESOLVED stops blocking', () => {
    /* Resolution is recorded, so fixing something genuinely clears it — and stays visible. */
    const rt = project();
    seedCompleteReview(rt.store);
    let n = 0;
    for (const area of REQUIRED_SCOPE) {
      for (let i = 0; i < reviewUnitsFor(area).length; i += 1) {
        n += 1;
        seedReviewerRun(rt.store, 'SC-RUN-' + String(n).padStart(6, '0'));
      }
    }
    seedReviewerRun(rt.store, 'SC-RUN-EARLIER');
    recordScopeReview(rt.store, {
      scopeId: '',
      scopeName: 'Reconciliation',
      implementationCommit: COMMIT,
      treeDigest: TREE,
      reviewerRunId: 'SC-RUN-EARLIER',
      reviewerAgentId: REVIEWER,
      coverage: ScopeCoverage.COMPLETE,
      filesReviewed: ['src/engineering/reconcile.ts'],
      filesOmitted: [],
      findings: [
        {
          id: 'R-CRIT',
          severity: Severity.CRITICAL,
          area: 'Reconciliation',
          statement: 'evidence can be trusted after an external change',
          evidence: ['src/engineering/reconcile.ts:234'],
          resolved: true,
          resolvedNote: 'fixed: four divergence kinds are now detected',
        },
      ],
      verdict: ReviewVerdict.BLOCKED,
      terminalOutcome: 'COMPLETED',
      reviewedAt: '2026-08-24T00:00:00.000Z',
    });

    const result = aggregate(rt);
    expect(result.refusals, result.refusals.join('; ')).toEqual([]);
    /* The resolved finding is still carried, because history does not disappear. */
    expect(result.review?.findings.some((f) => f.id === 'R-CRIT')).toBe(true);
  });
});
