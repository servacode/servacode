import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REQUIRED_SCOPE,
  REVIEW_PATH,
  ReviewVerdict,
  Severity,
  resolveSecurityReview,
} from '../src/acceptance/securityReview.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { cleanup, tempRoot } from './helpers.js';
import type { RepositoryIdentity } from '../src/acceptance/proof.js';
import type { Store } from '../src/store/store.js';

/**
 * `Independent reviewer: Jane Roe` MUST NOT SATISFY THIS.
 *
 * SPEC: Phase 6 final acceptance sequence §7.
 *
 * That sentence, in a markdown file, produced a green Security Acceptance in an earlier
 * iteration of this product — and my own test suite proved the synthetic file passed. This is
 * the requirement the whole typed-proof model was built to fix, so it gets the most adversarial
 * treatment of any of them.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const REPOSITORY: RepositoryIdentity = { commit: COMMIT, tree: TREE };
const REVIEWER = 'SC-AGENT-220';
const PRODUCER = 'SC-AGENT-150';

function project(): ServaRuntime {
  const root = tempRoot();
  roots.push(root);
  return ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root });
}

function seedRun(store: Store, runId: string, agentId: string, outcome = 'COMPLETED'): void {
  const tx = store.begin();
  tx.putCanon('agentRunRecord', runId, { runId, agentId, outcome });
  tx.commit();
}

function review(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    implementationCommit: COMMIT,
    treeDigest: TREE,
    reviewerRunId: 'SC-RUN-000100',
    reviewerAgentId: REVIEWER,
    reviewerAuthority: 'VERIFY',
    independence: {
      implementationProducers: [PRODUCER],
      statement: 'The reviewer produced none of the reviewed work.',
    },
    scope: [...REQUIRED_SCOPE],
    findings: [],
    verdict: ReviewVerdict.ACCEPTED,
    reviewedAt: '2026-08-24T00:00:00.000Z',
    storePath: '.serva-review',
    ...over,
  };
}

function pkg(body?: unknown): string {
  const root = tempRoot();
  roots.push(root);
  if (body !== undefined) {
    const path = join(root, ...REVIEW_PATH.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(body, null, 2), 'utf8');
  }
  return root;
}

function resolve(root: string, store?: Store, over: Record<string, unknown> = {}) {
  return resolveSecurityReview({
    root,
    repository: REPOSITORY,
    openStore: () => store,
    ...over,
  });
}

function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'SF-1',
    severity: Severity.MEDIUM,
    area: 'Owner authority',
    statement: 'something worth noting',
    evidence: ['src/app/actions.ts'],
    ...over,
  };
}

/* ============================================================ the prose that used to pass */

describe('prose does not satisfy the security requirement', () => {
  it('no review at all is not an accepted review', () => {
    const result = resolve(pkg());
    expect(result.resolved).toBe(false);
    expect(result.refusals.join(' ')).toContain('no security review');
  });

  it('a review naming a person but resolving no run is refused', () => {
    /* The shape of the original defect, expressed in the typed model. */
    const rt = project();
    try {
      const result = resolve(pkg(review()), rt.store);
      expect(result.resolved).toBe(false);
      expect(result.refusals.join(' ')).toContain('does not resolve to a run');
    } finally {
      rt.close();
    }
  });
});

/* ==================================================================== the run behind it */

describe('the review needs a governed run that actually happened', () => {
  it('resolves when the run is real, completed and by the named actor', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000100', REVIEWER);
      const result = resolve(pkg(review()), rt.store);
      expect(result.resolved, result.refusals.join('; ')).toBe(true);
    } finally {
      rt.close();
    }
  });

  it('a run that did not complete reviewed nothing', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000100', REVIEWER, 'FAILED');
      expect(resolve(pkg(review()), rt.store).refusals.join(' ')).toContain('reviewed nothing');
    } finally {
      rt.close();
    }
  });

  it('a run by a different actor than the review names is refused', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000100', 'SC-AGENT-999');
      expect(resolve(pkg(review()), rt.store).refusals.join(' ')).toContain('was made by');
    } finally {
      rt.close();
    }
  });
});

/* ====================================================================== independence */

describe('a producer cannot certify its own work', () => {
  it('refuses a reviewer that produced the implementation', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000100', PRODUCER);
      const result = resolve(
        pkg(
          review({
            reviewerAgentId: PRODUCER,
            independence: {
              implementationProducers: [PRODUCER],
              statement: 'I reviewed my own work.',
            },
          }),
        ),
        rt.store,
      );
      expect(result.resolved).toBe(false);
      expect(result.refusals.join(' ')).toContain('not an independent review');
    } finally {
      rt.close();
    }
  });

  it('refuses an authority that can produce rather than verify', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000100', REVIEWER);
      const result = resolve(pkg(review({ reviewerAuthority: 'EXECUTE' })), rt.store);
      expect(result.refusals.join(' ')).toContain('not a verifier authority');
    } finally {
      rt.close();
    }
  });
});

/* ======================================================== the commit it actually reviewed */

describe('a review of a different commit is stale by construction', () => {
  it('refuses a review of an earlier commit', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000100', REVIEWER);
      const result = resolve(pkg(review({ implementationCommit: 'c'.repeat(40) })), rt.store);
      expect(result.refusals.join(' ')).toContain('stale by construction');
    } finally {
      rt.close();
    }
  });

  it('refuses when the implementation changed after the review', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000100', REVIEWER);
      const result = resolve(pkg(review({ treeDigest: 'd'.repeat(40) })), rt.store);
      expect(result.refusals.join(' ')).toContain('changed after it was reviewed');
    } finally {
      rt.close();
    }
  });
});

/* ============================================================== scope and the verdict */

describe('the scope must cover what was asked, and the verdict must agree with the findings', () => {
  it('refuses a review that looked at three things', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000100', REVIEWER);
      const result = resolve(pkg(review({ scope: ['Core Store/integrity'] })), rt.store);
      expect(result.refusals.join(' ')).toContain('did not cover');
    } finally {
      rt.close();
    }
  });

  it('refuses ACCEPTED alongside a CRITICAL finding', () => {
    /*
     * Not a review with a bug in it. This is the failure the product exists to refuse,
     * arriving in the one document that is supposed to catch such things.
     */
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000100', REVIEWER);
      const result = resolve(
        pkg(
          review({
            findings: [finding({ id: 'SF-9', severity: Severity.CRITICAL })],
            verdict: ReviewVerdict.ACCEPTED,
          }),
        ),
        rt.store,
      );
      expect(result.resolved).toBe(false);
      expect(result.refusals.join(' ')).toContain('declares ACCEPTED while naming');
      expect(result.blocking.map((f) => f.id)).toContain('SF-9');
    } finally {
      rt.close();
    }
  });

  it('refuses ACCEPTED alongside a HIGH finding', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000100', REVIEWER);
      const result = resolve(
        pkg(review({ findings: [finding({ severity: Severity.HIGH })] })),
        rt.store,
      );
      expect(result.resolved).toBe(false);
    } finally {
      rt.close();
    }
  });

  it('allows ACCEPTED alongside MEDIUM and lower', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000100', REVIEWER);
      const result = resolve(
        pkg(
          review({
            findings: [
              finding({ severity: Severity.MEDIUM }),
              finding({ id: 'SF-2', severity: Severity.LOW }),
            ],
          }),
        ),
        rt.store,
      );
      expect(result.resolved, result.refusals.join('; ')).toBe(true);
      expect(result.blocking).toEqual([]);
    } finally {
      rt.close();
    }
  });

  it('a BLOCKED verdict is never a pass', () => {
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000100', REVIEWER);
      const result = resolve(
        pkg(
          review({
            findings: [finding({ severity: Severity.CRITICAL })],
            verdict: ReviewVerdict.BLOCKED,
          }),
        ),
        rt.store,
      );
      expect(result.resolved).toBe(false);
      expect(result.refusals.join(' ')).toContain('the verdict is BLOCKED');
    } finally {
      rt.close();
    }
  });

  it('a finding with nothing behind it cannot be filed', () => {
    /* A finding nobody can act on is an opinion; the schema requires evidence. */
    const rt = project();
    try {
      seedRun(rt.store, 'SC-RUN-000100', REVIEWER);
      const result = resolve(pkg(review({ findings: [{ ...finding(), evidence: [] }] })), rt.store);
      expect(result.resolved).toBe(false);
      expect(result.refusals.join(' ')).toContain('malformed');
    } finally {
      rt.close();
    }
  });
});
