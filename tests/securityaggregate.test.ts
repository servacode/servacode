import { afterEach, describe, expect, it } from 'vitest';
import { aggregateSecurityReview } from '../src/acceptance/securityAggregate.js';
import {
  ScopeCoverage,
  findingIdPrefix,
  recordScopeReview,
} from '../src/acceptance/scopeReview.js';
import { REQUIRED_SCOPE, ReviewVerdict, Severity } from '../src/acceptance/securityReview.js';
import { reviewUnitsFor } from '../src/acceptance/securityReviewRun.js';
import { AcceptanceProofSchema, ProofStatus, VerificationType } from '../src/acceptance/proof.js';
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
  /*
   * Distinguishes one seeded ATTEMPT from another.
   *
   * SPEC: finding SC-SSA-RESOLVE-1, 1.0.1 review.
   *
   * Records are keyed by scope and reviewer run, so seeding twice with the same ids replaced
   * the first set instead of adding a second attempt — which silently turned a test about two
   * governed re-reviews into a test about one. Corroboration cannot be tested without two.
   */
  salt = '',
): void {
  let n = 0;
  for (const area of REQUIRED_SCOPE) {
    for (const { unit } of reviewUnitsFor(area)) {
      n += 1;
      const runId = 'SC-RUN-' + salt + String(n).padStart(6, '0');
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
        /*
         * A unit that DECLARES context has not been reviewed until that context reached it, so
         * a fixture claiming a complete review has to show it arriving. Derived from the scope
         * map rather than hard-coded, so declaring context somewhere new cannot silently leave
         * this fixture describing a review that could not have happened.
         */
        contextRead: reviewUnitsFor(area)
          .find((u) => u.unit === unit)
          ?.context.map((prefix) => (prefix.endsWith('.ts') ? prefix : prefix + 'seen.ts')),
        contextOmitted: [],
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
    /*
     * Resolution is a recorded fact, not an absence. A fixed finding stays in the evidence.
     *
     * NOW ALSO CORROBORATED. SPEC: finding SC-SSA-RESOLVE-1 (MEDIUM), 1.0.1 review.
     *
     * This used to pass with the claim alone, which is exactly the defect: three fields inside
     * the record making the claim were enough to mute a HIGH, and nothing in the product ever
     * writes them. The claim still disambiguates the silence — but a governed re-review of the
     * same area at this commit, which looked and did not report it, is what now evidences it.
     */
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
                /* A resolution names the implementation it was verified at, or it is a claim. */
                resolvedAtCommit: COMMIT,
                resolvedAtTree: TREE,
                resolvedNote: 'fixed: the producer set is derived from governed history',
              },
            ],
          }
        : {},
    );
    /* The re-review that backs the claim up: same area, same implementation, found nothing. */
    seedCompleteReview(
      rt.store,
      (unit) => (unit === 'Owner authority' ? { findings: [] } : {}),
      'B',
    );

    const result = aggregate(rt);
    expect(result.refusals, result.refusals.join('; ')).toEqual([]);
    expect(result.review?.findings.length).toBe(1);
  });

  it('refuses evidence bound to a different commit', () => {
    /*
     * The corrupted unit is DERIVED, not named.
     *
     * SPEC: the 1.0.1 security scope triage.
     *
     * This said `unit === 'bootstrap'`. When `bootstrap` was partitioned into sub-scopes that
     * name no longer belonged to any unit, so the override matched nothing, the fixture seeded
     * a perfectly good review, and the test asserted that a valid review is refused — which it
     * is not. It failed loudly here, but the shape is the dangerous one: had the assertion been
     * the other way round it would have passed forever while testing nothing.
     *
     * A test that hardcodes a name from a partitionable set is a test with an expiry date on it.
     */
    const target = reviewUnitsFor(REQUIRED_SCOPE[0] as string)[0]?.unit;
    expect(target, 'the scope must yield at least one review unit').toBeDefined();

    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === target ? { implementationCommit: 'c'.repeat(40) } : {},
    );
    const result = aggregate(rt);
    expect(result.review).toBeUndefined();
    expect(result.refusals.join(' ')).toContain(String(target));
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
      verdict: ReviewVerdict.ACCEPTED,
      terminalOutcome: 'COMPLETED',
      /* Later than the seeded attempt, and it still contributes nothing. */
      reviewedAt: '2026-08-26T00:00:00.000Z',
      findings: [
        {
          id: 'FORGED-1',
          severity: Severity.INFO,
          area: 'Reconciliation',
          statement: 'a finding nobody governed',
          evidence: ['src/engineering/reconcile.ts:1'],
          resolved: false,
        },
      ],
    });

    /*
     * A record citing a run nobody made is IGNORED rather than obeyed — in both directions.
     * It contributes no findings, and it cannot block a legitimate review either, which
     * matters because anyone who could forge one could otherwise deny acceptance by writing
     * garbage into the store.
     */
    const result = aggregate(rt);
    expect(result.refusals, result.refusals.join('; ')).toEqual([]);
    expect(JSON.stringify(result.review?.findings ?? [])).not.toContain('FORGED-1');
    expect(result.scopeRunIds).not.toContain('SC-RUN-INVENTED');
  });

  it('a fabricated record ALONE cannot satisfy a scope', () => {
    /* Ignored is not accepted: with no legitimate attempt behind it, the scope is uncovered. */
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === 'Reconciliation' ? { reviewerRunId: 'SC-RUN-INVENTED' } : {},
    );
    const result = aggregate(rt);
    expect(result.review).toBeUndefined();
    expect(result.refusals.join(' ')).toMatch(/Reconciliation/);
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
          /* Bound to the implementation being judged, or it suppresses nothing. */
          resolvedAtCommit: COMMIT,
          resolvedAtTree: TREE,
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

describe('the aggregate shapes into a proof the resolver will actually accept', () => {
  /*
   * A complete, clean review across all 22 units minted a proof that `resolveProof` refused as
   * malformed: `scope` was an array where the schema wants prose, and every evidence entry
   * said `ref` where it wants `id`. The review had done its job and the last twenty lines of
   * the script threw the result away.
   *
   * Nothing caught it because nothing checked the shape of what it wrote — producing evidence
   * and then declining to look at it, which is the failure this whole phase has been
   * correcting. So the shape is pinned here, at the seam between the two modules.
   */
  it('every field the aggregate produces fits the proof schema', () => {
    const rt = project();
    seedCompleteReview(rt.store);
    const result = aggregate(rt);
    expect(result.review, result.refusals.join('; ')).toBeDefined();
    const review = result.review as NonNullable<typeof result.review>;

    const proof = {
      requirementId: 'SECURITY-INDEPENDENT',
      verificationType: VerificationType.JUDGED,
      status: ProofStatus.PASS,
      implementationCommit: COMMIT,
      treeDigest: TREE,
      producedAt: '2026-08-25T01:00:00.000Z',
      producer: { kind: 'TOOL', id: 'scripts/security-review.mjs' },
      scope: 'Independent security review of ' + String(review.scope.length) + ' required areas',
      reviewerRunRef: {
        runId: review.reviewerRunId,
        agentId: review.reviewerAgentId,
        storePath: rt.root,
      },
      evidence: [
        { kind: 'FILE', id: 'evidence/x.json', digest: 'a'.repeat(64) },
        ...result.scopeRunIds.map((id) => ({ kind: 'AGENT_RUN', id })),
        { kind: 'COMMIT', id: COMMIT },
      ],
      notes: ['clean'],
    };

    const parsed = AcceptanceProofSchema.safeParse(proof);
    expect(
      parsed.success,
      parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 4)),
    ).toBe(true);
  });

  it('an evidence entry keyed `ref` is refused, which is what went wrong', () => {
    const parsed = AcceptanceProofSchema.safeParse({
      requirementId: 'SECURITY-INDEPENDENT',
      verificationType: VerificationType.JUDGED,
      status: ProofStatus.PASS,
      implementationCommit: COMMIT,
      treeDigest: TREE,
      producedAt: '2026-08-25T01:00:00.000Z',
      producer: { kind: 'TOOL', id: 'x' },
      scope: 'a scope',
      evidence: [{ kind: 'COMMIT', ref: COMMIT }],
    });
    expect(parsed.success).toBe(false);
  });
});

/* ====== HIGH 2: a resolution is about one defect at one implementation ====== */

describe('a historical resolution cannot mute a current finding', () => {
  /*
   * SPEC: HIGH finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-REV-001.
   *
   * `findingsAcrossAttempts` gathered findings from every persisted attempt for a scope with
   * no filter on commit or tree, then dropped any whose `resolved` flag was true. So a
   * `resolved: true` written against any past attempt — at any older tree — permanently
   * suppressed that finding id at the current commit.
   *
   * Finding ids are area-namespaced and reviewer-numbered, so a regression re-introducing the
   * same defect collides with the old id and stays suppressed. This is the one place a
   * blocking CRITICAL can be cleared, and it cleared on an unchecked boolean.
   *
   * The question the aggregate asks is now "what is unresolved at THIS commit and tree",
   * rather than "which historical ids can I subtract". A resolution is evidence about one
   * defect at one implementation state, and it is honoured only at that state.
   */
  const OLD_COMMIT = 'e'.repeat(40);
  const OLD_TREE = 'f'.repeat(40);

  function seedAt(store: Store, unit: string, over: Record<string, unknown>, n = 900): void {
    const runId = 'SC-RUN-H' + String(n);
    const tx = store.begin();
    tx.putCanon('agentRunRecord', runId, { runId, agentId: REVIEWER, outcome: 'COMPLETED' });
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
      reviewedAt: '2026-08-30T00:00:00.000Z',
      ...over,
    });
  }

  const finding = (severity: string, over: Record<string, unknown> = {}) => ({
    id: 'F-1',
    severity,
    area: 'Owner authority',
    statement: 'a real problem',
    evidence: ['src/app/conversation.ts:1'],
    resolved: false,
    ...over,
  });

  it('a HIGH resolved at an OLD commit does not mute the same id now', () => {
    const rt = project();
    seedCompleteReview(rt.store);
    /* The historical record: same id, marked resolved, at a different implementation. */
    seedAt(rt.store, 'Owner authority', {
      implementationCommit: OLD_COMMIT,
      treeDigest: OLD_TREE,
      reviewedAt: '2026-01-01T00:00:00.000Z',
      findings: [finding('HIGH', { resolved: true, resolvedNote: 'fixed, honestly' })],
    });
    /* And the current one: the same defect is back. */
    seedAt(rt.store, 'Owner authority', { findings: [finding('HIGH')] }, 901);

    const result = aggregate(rt);
    expect(result.review).toBeUndefined();
    expect(result.refusals.join(' ')).toMatch(/HIGH/);
  });

  it('a CRITICAL regression at a new tree blocks, whatever history says', () => {
    const rt = project();
    seedCompleteReview(rt.store);
    seedAt(rt.store, 'Owner authority', {
      implementationCommit: OLD_COMMIT,
      treeDigest: OLD_TREE,
      reviewedAt: '2026-01-01T00:00:00.000Z',
      findings: [finding('CRITICAL', { resolved: true })],
    });
    seedAt(rt.store, 'Owner authority', { findings: [finding('CRITICAL')] }, 901);
    expect(aggregate(rt).review).toBeUndefined();
  });

  it('a resolution bound to THIS commit and tree does suppress', () => {
    /* Resolution is not impossible — it is bound. */
    const rt = project();
    seedCompleteReview(rt.store);
    seedAt(rt.store, 'Owner authority', {
      findings: [
        finding('HIGH', {
          resolved: true,
          resolvedAtCommit: COMMIT,
          resolvedAtTree: TREE,
          resolvedNote: 'fixed and re-reviewed at this exact tree',
        }),
      ],
    });
    const result = aggregate(rt);
    expect(result.refusals, result.refusals.join('; ')).toEqual([]);
  });

  it('resolved:true with no implementation binding is not authority', () => {
    const rt = project();
    seedCompleteReview(rt.store);
    seedAt(rt.store, 'Owner authority', {
      findings: [finding('HIGH', { resolved: true, resolvedNote: 'trust me' })],
    });
    expect(aggregate(rt).review).toBeUndefined();
  });

  it('a resolution bound to a DIFFERENT commit is not authority here', () => {
    const rt = project();
    seedCompleteReview(rt.store);
    seedAt(rt.store, 'Owner authority', {
      findings: [
        finding('HIGH', { resolved: true, resolvedAtCommit: OLD_COMMIT, resolvedAtTree: OLD_TREE }),
      ],
    });
    expect(aggregate(rt).review).toBeUndefined();
  });

  it('a legitimately fixed historical finding that does not recur blocks nothing', () => {
    /* History stays readable; it simply does not decide the present. */
    const rt = project();
    seedCompleteReview(rt.store);
    seedAt(rt.store, 'Owner authority', {
      implementationCommit: OLD_COMMIT,
      treeDigest: OLD_TREE,
      reviewedAt: '2026-01-01T00:00:00.000Z',
      findings: [finding('CRITICAL')],
    });
    const result = aggregate(rt);
    expect(result.refusals, result.refusals.join('; ')).toEqual([]);
  });

  it('severity is read from the CURRENT finding, not an older one', () => {
    const rt = project();
    seedCompleteReview(rt.store);
    seedAt(rt.store, 'Owner authority', {
      implementationCommit: OLD_COMMIT,
      treeDigest: OLD_TREE,
      reviewedAt: '2026-01-01T00:00:00.000Z',
      findings: [finding('LOW', { resolved: true })],
    });
    seedAt(rt.store, 'Owner authority', { findings: [finding('HIGH')] }, 901);
    /* A historical LOW resolution must not clear a current HIGH by id collision. */
    expect(aggregate(rt).review).toBeUndefined();
  });

  it('two attempts at THIS commit union their findings', () => {
    /*
     * The property SC-SSA-F2 established, preserved: a retry that simply does not re-report a
     * finding does not resolve it. Both attempts are at the current implementation, so both
     * count.
     */
    const rt = project();
    seedCompleteReview(rt.store);
    seedAt(rt.store, 'Owner authority', { findings: [finding('HIGH')] });
    seedAt(rt.store, 'Owner authority', { findings: [] }, 901);
    expect(aggregate(rt).review).toBeUndefined();
  });
});

describe("a reviewer's own verdict is read, not only its findings", () => {
  /*
   * SPEC: finding SSA-RLC-AGG-1 (MEDIUM), 1.0.1 security review.
   *
   * The aggregate refused NOT_VERIFIED and said nothing about BLOCKED. Blocked units had
   * always been refused in practice — on their unresolved CRITICAL/HIGH findings, caught
   * elsewhere — never on the verdict itself. So a reviewer that read its area and said "I am
   * blocking this" while raising nothing above MEDIUM was overruled by silence.
   *
   * The fixture below is exactly that shape: BLOCKED, with one MEDIUM and nothing higher.
   */
  it('a BLOCKED unit stops the proof even when nothing it found is CRITICAL or HIGH', () => {
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === REQUIRED_SCOPE[0]
        ? {
            verdict: ReviewVerdict.BLOCKED,
            findings: [
              {
                id: 'BLOCKED-BY-JUDGEMENT-1',
                severity: Severity.MEDIUM,
                area: String(REQUIRED_SCOPE[0]),
                statement: 'the reviewer will not accept this, and says so in its verdict',
                evidence: ['src/somewhere.ts:1'],
              },
            ],
          }
        : {},
    );

    const result = aggregate(rt);
    expect(result.review, 'a proof must not be minted over a reviewer objection').toBeUndefined();
    expect(result.refusals.join(' ')).toContain('did not accept what it reviewed');
  });

  it('and the refusal names the verdict rather than assuming which one it was', () => {
    /*
     * Written as "anything that is not ACCEPTED" rather than a list of today's two verdicts,
     * so a third one refuses here the day it is added. Asserted on the message, which is the
     * part a reader acts on.
     */
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === REQUIRED_SCOPE[0] ? { verdict: ReviewVerdict.NOT_VERIFIED, findings: [] } : {},
    );
    const said = aggregate(rt).refusals.join(' ');
    expect(said).toContain('NOT_VERIFIED');
    expect(said).toContain('it decided nothing');
  });
});

describe('a unit that never received its required context has not decided anything', () => {
  /*
   * SPEC: the omission at 7595c20a, and the acceptance bar set after it.
   *
   * Context is declared for exactly one reason: the unit cannot decide its own files without
   * it. `Serva self-acceptance authority` judges whether a persisted record counts as
   * evidence, and that turns on the store's tamper-evidence guarantee, so store.ts is declared
   * context for it. At 7595c20a the guarantee did not fit the budget and the unit accepted
   * anyway — an ACCEPTED that means "did not notice the absence", not "nothing was wrong".
   *
   * So this is checked at the CONSUMER too, and the requirement is derived from the scope map
   * rather than read off the record being judged. Two records, one per direction, and the two
   * conditions are never folded into each other.
   */
  /*
   * DERIVED, NOT NAMED. A hard-coded unit name silently stopped matching when the area was
   * split, and both tests below went on passing while testing nothing — which is the failure
   * they exist to catch, arriving in the test itself.
   */
  const UNIT = String(
    REQUIRED_SCOPE.flatMap((area) => reviewUnitsFor(area)).find((u) => u.context.length > 0)?.unit,
  );

  it('the fixture names a unit that actually requires context', () => {
    expect(UNIT, 'no unit declares context, so the tests below would prove nothing').not.toBe(
      'undefined',
    );
  });

  it('an ACCEPTED record whose declared context never arrived carries no authority', () => {
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === UNIT ? { contextRead: [], contextOmitted: ['src/store/store.ts'] } : {},
    );

    const result = aggregate(rt);
    expect(result.review, 'a judgement made without what decides it must not mint').toBeUndefined();
    expect(result.refusals.join(' ')).toContain('src/store/store.ts');
  });

  it('the refusal is about the missing context, not about coverage', () => {
    /*
     * The distinction that must not blur. Every SUBJECT was reviewed — coverage is COMPLETE
     * and truthfully so. What is missing is a guard the unit was promised, and calling that
     * PARTIAL would assert the unit failed to review a file it does not even own.
     */
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === UNIT
        ? {
            coverage: ScopeCoverage.COMPLETE,
            contextRead: [],
            contextOmitted: ['src/store/store.ts'],
          }
        : {},
    );

    const result = aggregate(rt);
    const said = result.refusals.join(' ');
    expect(said).toContain('without declared context');
    /* The real PARTIAL wording, so this assertion can actually fail if the two ever blur. */
    expect(said, 'coverage was complete and must not be reported otherwise').not.toContain(
      'a partial view of an area is not coverage of it',
    );
  });

  it('a unit that declares no context is unaffected by any of this', () => {
    /* The rule applies where context is REQUIRED, and nowhere else. */
    const rt = project();
    seedCompleteReview(rt.store);
    const result = aggregate(rt);
    expect(result.refusals, result.refusals.join('; ')).toEqual([]);
    expect(result.review).toBeDefined();
  });
});

describe('a resolution is evidence, not a field that asserts itself', () => {
  /*
   * SPEC: finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-RESOLVE-1 (MEDIUM), 1.0.1 review.
   *
   * A blocking CRITICAL or HIGH was muted by three fields that all live inside the record making
   * the claim: `resolved`, `resolvedAtCommit`, `resolvedAtTree`. The record's provenance was
   * checked — commit, tree, and that its `reviewerRunId` resolves to a COMPLETED verifier run
   * with authority — but the run's OUTPUT was never compared against what the record claimed, so
   * one legitimate run could be cited by a record it never produced.
   *
   * And the mechanism has no legitimate writer: `persist()` writes `resolved: false` for every
   * finding of every reviewer run, and nothing in the product ever writes `true`. Every
   * resolution that has ever existed was authored outside the review path.
   *
   * A resolution must now also be CORROBORATED — a governed re-review of the same area, at this
   * commit and tree, that looked and did not report the finding. Neither half is forgeable
   * alone: a claim cannot conjure a run's silence, and silence with no claim means only that
   * nobody looked.
   */
  it('refuses a forged resolution: right fields, no re-review behind it', () => {
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === REQUIRED_SCOPE[0]
        ? {
            findings: [
              {
                id: 'FORGED-1',
                severity: Severity.HIGH,
                area: String(REQUIRED_SCOPE[0]),
                statement: 'a real defect somebody wanted to disappear',
                evidence: ['src/somewhere.ts:1'],
                /* Everything the old check asked for, and nothing behind it. */
                resolved: true,
                resolvedAtCommit: COMMIT,
                resolvedAtTree: TREE,
                resolvedNote: 'fixed, honestly',
              },
            ],
          }
        : {},
    );

    const result = aggregate(rt);
    expect(result.review, 'a self-asserted resolution must not mint a review').toBeUndefined();
    expect(result.refusals.join(' ')).toContain('FORGED-1');
  });

  it('honours a resolution that a re-review corroborates by not finding it', () => {
    /*
     * The legitimate shape, so the fix does not make resolution impossible: two governed
     * attempts at this implementation for the same area — one carrying the closed finding, one
     * that looked and reported nothing.
     */
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === REQUIRED_SCOPE[0]
        ? {
            findings: [
              {
                id: 'CLOSED-1',
                severity: Severity.HIGH,
                area: String(REQUIRED_SCOPE[0]),
                statement: 'was real, and was fixed',
                evidence: ['src/somewhere.ts:1'],
                resolved: true,
                resolvedAtCommit: COMMIT,
                resolvedAtTree: TREE,
                resolvedNote: 'fixed: the guard now reads the fact rather than the label',
              },
            ],
          }
        : {},
    );
    /* The corroborating re-review of the same area, which looked and found nothing. */
    seedCompleteReview(
      rt.store,
      (unit) => (unit === REQUIRED_SCOPE[0] ? { findings: [] } : {}),
      'B',
    );

    const result = aggregate(rt);
    expect(result.refusals, result.refusals.join('; ')).toEqual([]);
    expect(result.review).toBeDefined();
  });

  it('corroborates a resolution in a PARTITIONED area, where the unit is not the area', () => {
    /*
     * SSA-REV-A3. Corroboration used to be matched by comparing the finding's `area` against
     * the record's `scopeName`. For an area split into units those hold different things — the
     * finding says 'bootstrap', the record says 'bootstrap — the command surface' — so no
     * re-review of a split area could ever corroborate anything. The mechanism did not fail;
     * it silently never fired, which is the harder failure to notice.
     *
     * Fail-safe, so nothing was wrongly suppressed. But a check that cannot succeed is not a
     * check, and this asserts the legitimate shape actually works.
     */
    const AREA = 'bootstrap';
    const UNIT = 'bootstrap — the command surface';
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === UNIT
        ? {
            findings: [
              {
                id: findingIdPrefix(UNIT) + '/CLOSED-1',
                severity: Severity.HIGH,
                area: AREA,
                statement: 'was real, and was fixed',
                evidence: ['src/cli/bootstrap.ts:1'],
                resolved: true,
                resolvedAtCommit: COMMIT,
                resolvedAtTree: TREE,
                resolvedNote: 'fixed at this tree',
              },
            ],
          }
        : {},
    );
    seedCompleteReview(rt.store, (unit) => (unit === UNIT ? { findings: [] } : {}), 'B');

    const result = aggregate(rt);
    expect(result.refusals, result.refusals.join('; ')).toEqual([]);
    expect(result.review).toBeDefined();
  });

  it('will not accept a sibling unit of the same area as the corroborating re-review', () => {
    /*
     * The precision half, and the reason the fix is not "match on the area instead".
     *
     * The units of a split area read different files. Silence from a unit that never looked at
     * the finding's code says nothing about it, so only the unit that RAISED a finding can
     * corroborate its resolution — recovered from the id the reviewer namespaced with it.
     *
     * Here the raising unit was re-reviewed and STILL REPORTS the finding, while its sibling
     * looked at the other slice and saw nothing. Matching by area would find the sibling's
     * silence and close a finding the responsible reviewer just repeated.
     */
    const RAISED_BY = 'bootstrap — the command surface';
    /* Its sibling, 'bootstrap — substrate prerequisites', is seeded silent by the default. */
    const claimed = {
      id: findingIdPrefix(RAISED_BY) + '/CLOSED-2',
      severity: Severity.HIGH,
      area: 'bootstrap',
      statement: 'claimed fixed, contradicted by the unit that raised it',
      evidence: ['src/cli/bootstrap.ts:1'],
      resolved: true,
      resolvedAtCommit: COMMIT,
      resolvedAtTree: TREE,
      resolvedNote: 'fixed at this tree',
    };

    const rt = project();
    seedCompleteReview(rt.store, (unit) => (unit === RAISED_BY ? { findings: [claimed] } : {}));
    seedCompleteReview(
      rt.store,
      (unit) => (unit === RAISED_BY ? { findings: [claimed] } : {}),
      'B',
    );

    const result = aggregate(rt);
    expect(result.review, "a sibling unit must not close another unit's finding").toBeUndefined();
    expect(result.refusals.join(' ')).toContain('CLOSED-2');
  });

  it('silence alone still does not close anything', () => {
    /*
     * The other half. A re-review that does not mention a finding may mean it was fixed or that
     * nobody looked for it — which is why the explicit claim is still required.
     */
    const rt = project();
    seedCompleteReview(rt.store, (unit) =>
      unit === REQUIRED_SCOPE[0]
        ? {
            findings: [
              {
                id: 'STILL-OPEN-1',
                severity: Severity.HIGH,
                area: String(REQUIRED_SCOPE[0]),
                statement: 'never claimed resolved',
                evidence: ['src/somewhere.ts:1'],
              },
            ],
          }
        : {},
    );
    seedCompleteReview(
      rt.store,
      (unit) => (unit === REQUIRED_SCOPE[0] ? { findings: [] } : {}),
      'B',
    );

    const result = aggregate(rt);
    expect(result.review).toBeUndefined();
    expect(result.refusals.join(' ')).toContain('STILL-OPEN-1');
  });
});
