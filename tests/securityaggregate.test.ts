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
      recordScopeReview(store, {
        scopeId: '',
        scopeName: unit,
        implementationCommit: COMMIT,
        treeDigest: TREE,
        reviewerRunId: 'SC-RUN-' + String(n).padStart(6, '0'),
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
