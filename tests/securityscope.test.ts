import { afterEach, describe, expect, it } from 'vitest';
import {
  SCOPE_REVIEW_CANON_TYPE,
  ScopeCoverage,
  listScopeReviews,
  recordScopeReview,
  readScopeReview,
} from '../src/acceptance/scopeReview.js';
import { ReviewVerdict, Severity } from '../src/acceptance/securityReview.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { cleanup, tempRoot } from './helpers.js';

/**
 * A BLOCKED REVIEW MUST LEAVE MORE EVIDENCE THAN A CLEAN ONE, NOT LESS.
 *
 * SPEC: finding SSA-5, from the independent security review.
 *
 * The scoped reviewer held its findings in memory and the script exited without writing them.
 * The first real run produced a BLOCKED verdict on `Serva self-acceptance authority` — four
 * genuine findings against the acceptance machinery — and left nothing on disk. Reading them
 * back meant paying for the review again.
 *
 * That is exactly backwards. A review that finds nothing costs little to repeat; a review that
 * finds something is the one whose evidence must survive. So every scoped attempt persists,
 * whatever its outcome, and a later resolver can aggregate what already happened without
 * spending a single model call.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);

function project(): ServaRuntime {
  const root = tempRoot();
  roots.push(root);
  return ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root });
}

function attempt(over: Record<string, unknown> = {}) {
  return {
    scopeId: 'core-store-integrity',
    scopeName: 'Core Store/integrity',
    implementationCommit: COMMIT,
    treeDigest: TREE,
    reviewerRunId: 'SC-RUN-000001',
    reviewerAgentId: 'SC-AGENT-220',
    coverage: ScopeCoverage.COMPLETE,
    filesReviewed: ['src/store/store.ts'],
    filesOmitted: [],
    findings: [],
    verdict: ReviewVerdict.ACCEPTED,
    terminalOutcome: 'COMPLETED',
    reviewedAt: '2026-08-25T00:00:00.000Z',
    ...over,
  };
}

describe('every scoped review attempt is durable, whatever its outcome', () => {
  it('persists a clean review and reads it back identically', () => {
    const rt = project();
    const id = recordScopeReview(rt.store, attempt());
    const back = readScopeReview(rt.store, id);
    expect(back?.scopeName).toBe('Core Store/integrity');
    expect(back?.verdict).toBe(ReviewVerdict.ACCEPTED);
    expect(back?.implementationCommit).toBe(COMMIT);
  });

  it('persists a BLOCKED review WITH the findings that blocked it', () => {
    /* The case that motivated this. Four real findings existed and none survived the exit. */
    const rt = project();
    const id = recordScopeReview(
      rt.store,
      attempt({
        scopeId: 'serva-self-acceptance-authority',
        scopeName: 'Serva self-acceptance authority',
        verdict: ReviewVerdict.BLOCKED,
        findings: [
          {
            id: 'SSA-1',
            severity: Severity.HIGH,
            area: 'Serva self-acceptance authority',
            statement: 'the independence guard is inert on the default path',
            evidence: ['src/acceptance/proof.ts:445'],
            resolved: false,
          },
        ],
      }),
    );
    const back = readScopeReview(rt.store, id);
    expect(back?.verdict).toBe(ReviewVerdict.BLOCKED);
    expect(back?.findings.length).toBe(1);
    expect(back?.findings[0]?.severity).toBe(Severity.HIGH);
    expect(back?.findings[0]?.evidence).toContain('src/acceptance/proof.ts:445');
  });

  it('persists an EVIDENCE_VIOLATION attempt, which produced no verdict at all', () => {
    const rt = project();
    const id = recordScopeReview(
      rt.store,
      attempt({
        coverage: ScopeCoverage.NOT_REVIEWED,
        verdict: ReviewVerdict.NOT_VERIFIED,
        terminalOutcome: 'EVIDENCE_VIOLATION',
        refusal: 'the reviewer claimed to have read files it holds no tool to read',
      }),
    );
    const back = readScopeReview(rt.store, id);
    expect(back?.terminalOutcome).toBe('EVIDENCE_VIOLATION');
    expect(back?.refusal).toContain('claimed');
    expect(back?.coverage).toBe(ScopeCoverage.NOT_REVIEWED);
  });

  it('records omitted files as omitted, never as covered', () => {
    /*
     * A partial view is the one thing a coverage record must not round up. The reviewer that
     * returned NOT_VERIFIED with 41 files missing was right to, and the record has to say so.
     */
    const rt = project();
    const id = recordScopeReview(
      rt.store,
      attempt({
        coverage: ScopeCoverage.PARTIAL,
        filesOmitted: ['src/intelligence/a.ts', 'src/intelligence/b.ts'],
        verdict: ReviewVerdict.NOT_VERIFIED,
      }),
    );
    const back = readScopeReview(rt.store, id);
    expect(back?.coverage).toBe(ScopeCoverage.PARTIAL);
    expect(back?.filesOmitted.length).toBe(2);
  });

  it('survives a process exit: a new Store over the same root reads it back', () => {
    /*
     * The actual property. `recordScopeReview` writes through a transaction, so the test opens
     * the project again rather than reusing the handle that wrote it.
     */
    const rt = project();
    const root = rt.root;
    recordScopeReview(rt.store, attempt({ verdict: ReviewVerdict.BLOCKED }));
    rt.close();

    const reopened = ServaRuntime.open({ root });
    try {
      const all = listScopeReviews(reopened.store);
      expect(all.length).toBe(1);
      expect(all[0]?.verdict).toBe(ReviewVerdict.BLOCKED);
      expect(all[0]?.implementationCommit).toBe(COMMIT);
    } finally {
      reopened.close();
    }
  });

  it('keeps every attempt at the same scope, so a retry does not erase what came before', () => {
    /* A second attempt is new evidence about the same question, not a correction of the first. */
    const rt = project();
    recordScopeReview(rt.store, attempt({ terminalOutcome: 'EVIDENCE_VIOLATION' }));
    recordScopeReview(rt.store, attempt({ reviewerRunId: 'SC-RUN-000002' }));
    expect(listScopeReviews(rt.store).length).toBe(2);
  });

  it('refuses to record an attempt that names no commit', () => {
    /* Evidence that binds to nothing describes nothing. */
    const rt = project();
    expect(() => recordScopeReview(rt.store, attempt({ implementationCommit: 'nope' }))).toThrow();
  });

  it('writes under its own canon type, so nothing else collides with it', () => {
    const rt = project();
    recordScopeReview(rt.store, attempt());
    expect(rt.store.listCanonIds(SCOPE_REVIEW_CANON_TYPE).length).toBe(1);
  });
});
