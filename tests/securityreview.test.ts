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
import { ALWAYS_DENY_TOOLS, NEVER_AVAILABLE } from '../src/agents/toolPolicy.js';
import {
  AREA_SOURCES,
  reviewAreaFiles,
  runScopedSecurityReview,
  runSecurityReview,
} from '../src/acceptance/securityReviewRun.js';
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

/* ================= producing the review, rather than hand-writing it ================= */

describe('the review is performed by a governed run, not authored', () => {
  /*
   * SPEC: Phase 6 final acceptance sequence §7.
   *
   * Every test above proves the verifier refuses a bad review. None of them proved anything
   * could produce a good one — the verifier was reachable only from its own tests, so the
   * only supported way to a green Security Acceptance was to write the JSON by hand. A
   * verifier whose sole input is a hand-authored file verifies the author's typing.
   */
  const REPO = { commit: COMMIT, tree: TREE };

  /** A runtime that returns one prepared result, recording what it was asked. */
  function fakeRuntime(outcome: string, result: unknown) {
    const seen: { request?: Record<string, unknown> } = {};
    return {
      seen,
      runtime: {
        run: (request: Record<string, unknown>) => {
          seen.request = request;
          return Promise.resolve({
            runId: 'SC-RUN-REVIEW',
            outcome,
            bundle: {},
            envelope: { result },
            claimAssessments: [],
            attempts: 1,
            diagnostics: [],
          });
        },
      } as unknown as Parameters<typeof runSecurityReview>[0]['runtime'],
    };
  }

  const GOOD = {
    scope: [...REQUIRED_SCOPE],
    findings: [
      {
        id: 'F-1',
        severity: Severity.LOW,
        area: 'Owner authority',
        statement: 'the refusal message names the gate but not the remedy',
        evidence: ['src/app/conversation.ts:212'],
      },
    ],
    verdict: ReviewVerdict.ACCEPTED,
    summary: 'no blocking finding',
  };

  it('produces a review that the verifier then resolves', async () => {
    const rt = project();
    const { runtime } = fakeRuntime('COMPLETED', GOOD);
    const outcome = await runSecurityReview({
      runtime,
      workItemId: 'SC-WI-1',
      repository: REPO,
      storePath: rt.root,
      implementationProducers: [PRODUCER],
      reviewedAt: '2026-08-25T00:00:00.000Z',
    });

    expect(outcome.refusals).toEqual([]);
    expect(outcome.review).toBeDefined();

    /* The produced review must survive the same verifier a hand-written one faces. */
    seedRun(rt.store, 'SC-RUN-REVIEW', REVIEWER);
    const path = join(rt.root, ...REVIEW_PATH.split('/'));
    mkdirSync(join(rt.root, 'evidence', 'acceptance-run'), { recursive: true });
    writeFileSync(path, JSON.stringify(outcome.review, null, 2), 'utf8');

    const resolved = resolveSecurityReview({
      root: rt.root,
      repository: REPOSITORY,
      openStore: () => rt.store,
    });
    expect(resolved.refusals).toEqual([]);
    expect(resolved.resolved).toBe(true);
  });

  it('stamps the commit from measured fact, so a reviewer cannot name its own', async () => {
    /*
     * A reviewer that could declare which commit it reviewed could review one thing and
     * certify another, and the staleness check would agree with it.
     */
    const rt = project();
    const { runtime } = fakeRuntime('COMPLETED', {
      ...GOOD,
      /* Even offered, an extra commit field is not part of the result contract. */
    });
    const outcome = await runSecurityReview({
      runtime,
      workItemId: 'SC-WI-1',
      repository: REPO,
      storePath: rt.root,
      implementationProducers: [PRODUCER],
      reviewedAt: '2026-08-25T00:00:00.000Z',
    });
    expect(outcome.review?.implementationCommit).toBe(COMMIT);
    expect(outcome.review?.treeDigest).toBe(TREE);
    expect(outcome.review?.reviewerRunId).toBe('SC-RUN-REVIEW');
    expect(outcome.review?.reviewerAgentId).toBe(REVIEWER);
  });

  it('asks for every required area by name', async () => {
    const rt = project();
    const { runtime, seen } = fakeRuntime('COMPLETED', GOOD);
    await runSecurityReview({
      runtime,
      workItemId: 'SC-WI-1',
      repository: REPO,
      storePath: rt.root,
      implementationProducers: [PRODUCER],
      reviewedAt: '2026-08-25T00:00:00.000Z',
    });
    const task = String(seen.request?.['taskDefinition']);
    for (const area of REQUIRED_SCOPE) expect(task).toContain(area);
    /* The reviewer is told it holds no write authority, in the boundary it is bound by. */
    expect(String(seen.request?.['scopeBoundary']).toLowerCase()).toContain('read-only');
  });

  it('a run that did not complete produces no review at all', async () => {
    const rt = project();
    const { runtime } = fakeRuntime('FAILED', GOOD);
    const outcome = await runSecurityReview({
      runtime,
      workItemId: 'SC-WI-1',
      repository: REPO,
      storePath: rt.root,
      implementationProducers: [PRODUCER],
      reviewedAt: '2026-08-25T00:00:00.000Z',
    });
    expect(outcome.review).toBeUndefined();
    expect(outcome.refusals.join(' ')).toContain('judged nothing');
  });

  it('carries the reviewer verdict through unchanged, including BLOCKED', async () => {
    /* A producer that softened a verdict would be the exact failure §7 exists to prevent. */
    const rt = project();
    const { runtime } = fakeRuntime('COMPLETED', {
      ...GOOD,
      findings: [
        {
          id: 'F-1',
          severity: Severity.CRITICAL,
          area: 'Owner authority',
          statement: 'a gate can be bypassed',
          evidence: ['src/app/conversation.ts:212'],
        },
      ],
      verdict: ReviewVerdict.BLOCKED,
    });
    const outcome = await runSecurityReview({
      runtime,
      workItemId: 'SC-WI-1',
      repository: REPO,
      storePath: rt.root,
      implementationProducers: [PRODUCER],
      reviewedAt: '2026-08-25T00:00:00.000Z',
    });
    expect(outcome.review?.verdict).toBe(ReviewVerdict.BLOCKED);
    expect(outcome.review?.findings[0]?.severity).toBe(Severity.CRITICAL);
  });
});

describe('the reviewer runs read-only, and the grant says so', () => {
  /*
   * SPEC: 19 §5, SC-POL-026.
   *
   * SC-AGENT-220's contract declares exec, so `resolveToolPolicy` refuses it — execute is
   * enforceable only on the isolation substrate. That refusal is correct and must stay: the
   * temptation here was to relax the resolver so a review could run at all, which would have
   * granted every agent declaring exec a capability nothing can hold.
   *
   * The narrow answer is an explicit grant smaller than the contract. These tests pin it
   * closed, because a grant that quietly widened later is exactly how this would go wrong.
   */
  const REPO = { commit: COMMIT, tree: TREE };

  function capture() {
    const seen: { request?: Record<string, unknown> } = {};
    const runtime = {
      run: (request: Record<string, unknown>) => {
        seen.request = request;
        return Promise.resolve({
          runId: 'SC-RUN-REVIEW',
          outcome: 'COMPLETED',
          bundle: {},
          envelope: {
            result: {
              scope: [...REQUIRED_SCOPE],
              findings: [],
              verdict: ReviewVerdict.ACCEPTED,
              summary: 'clean',
            },
          },
          claimAssessments: [],
          attempts: 1,
          diagnostics: [],
        });
      },
    } as unknown as Parameters<typeof runSecurityReview>[0]['runtime'];
    return { seen, runtime };
  }

  it('grants no tool, no write, no network and no tool calls', async () => {
    const rt = project();
    const { seen, runtime } = capture();
    await runSecurityReview({
      runtime,
      workItemId: 'SC-WI-1',
      repository: REPO,
      storePath: rt.root,
      implementationProducers: [PRODUCER],
      reviewedAt: '2026-08-25T00:00:00.000Z',
    });

    const capability = seen.request?.['capability'] as { policy: Record<string, unknown> };
    expect(capability).toBeDefined();
    const policy = capability.policy as {
      available: string[];
      approve: string[];
      deny: string[];
      filesystem: { write: string[] };
      network: unknown;
      maxToolCalls: number;
    };
    expect(policy.available).toEqual([]);
    expect(policy.approve).toEqual([]);
    expect(policy.filesystem.write).toEqual([]);
    expect(policy.network).toBe('NONE');
    expect(policy.maxToolCalls).toBe(0);
  });

  it('denies execution and write tools explicitly, not merely by omission', async () => {
    /* Deny outranks approve, so a later widening of `available` still cannot reach these. */
    const rt = project();
    const { seen, runtime } = capture();
    await runSecurityReview({
      runtime,
      workItemId: 'SC-WI-1',
      repository: REPO,
      storePath: rt.root,
      implementationProducers: [PRODUCER],
      reviewedAt: '2026-08-25T00:00:00.000Z',
    });
    const policy = (seen.request?.['capability'] as { policy: { deny: string[] } }).policy;
    for (const tool of ['Bash', 'PowerShell', 'Edit', 'Write', 'WebFetch']) {
      expect(policy.deny, tool + ' must be denied outright').toContain(tool);
    }
  });

  it('denies every tool the canonical lists forbid, without restating them', async () => {
    /*
     * A hand-written deny list drifts from the canonical one, and the drift is silent until
     * something refuses. `assertGrantWithinContract` rejected an earlier version of this grant
     * for omitting `Monitor` — a tool the literal list had simply never heard of.
     */
    const rt = project();
    const { seen, runtime } = capture();
    await runSecurityReview({
      runtime,
      workItemId: 'SC-WI-1',
      repository: REPO,
      storePath: rt.root,
      implementationProducers: [PRODUCER],
      reviewedAt: '2026-08-25T00:00:00.000Z',
    });
    const policy = (seen.request?.['capability'] as { policy: { deny: string[] } }).policy;
    for (const tool of [...ALWAYS_DENY_TOOLS, ...NEVER_AVAILABLE]) {
      expect(policy.deny, tool).toContain(tool);
    }
  });
});

describe('the review is scoped by area, because one reviewer cannot read the whole codebase', () => {
  /*
   * SPEC: Phase 6 final acceptance sequence §7.
   *
   * The first version handed one reviewer all 189 source files. 2.36MB does not fit an 80K
   * context, the bundle truncated at 40 files, and the run escalated INSUFFICIENT_CONTEXT
   * rather than certify what it had not seen. That refusal was correct — so the question
   * changed rather than the answer.
   */
  const REPO = { commit: COMMIT, tree: TREE };
  /*
   * One file under every prefix any area maps to. A fixture that covered only some areas would
   * exercise the "no source mapped" refusal instead of the path under test — which is itself
   * worth knowing, and is covered separately below.
   */
  const FILES = Object.freeze([
    ...new Set(
      REQUIRED_SCOPE.flatMap((area) =>
        (AREA_SOURCES[area] ?? []).map((prefix) =>
          prefix.endsWith('/') ? prefix + 'seed.ts' : prefix,
        ),
      ),
    ),
  ]);

  /** A runtime answering every area, recording what each was asked. */
  function areaRuntime(reply: (area: string) => { outcome: string; result?: unknown }) {
    const seen: { area: string; request: Record<string, unknown> }[] = [];
    let n = 0;
    const runtime = {
      run: (request: Record<string, unknown>) => {
        n += 1;
        const task = String(request['taskDefinition']);
        const area = REQUIRED_SCOPE.find((a) => task.includes('Area under review: ' + a)) ?? '?';
        seen.push({ area, request });
        const r = reply(area);
        return Promise.resolve({
          runId: 'SC-RUN-' + String(n),
          outcome: r.outcome,
          bundle: {},
          envelope: { result: r.result },
          claimAssessments: [],
          attempts: 1,
          diagnostics: [],
        });
      },
    } as unknown as Parameters<typeof runScopedSecurityReview>[0]['runtime'];
    return { seen, runtime };
  }

  const clean = (area: string) => ({
    outcome: 'COMPLETED',
    result: { scope: [area], findings: [], verdict: ReviewVerdict.ACCEPTED, summary: 'clean' },
  });

  function scoped(
    rt: ServaRuntime,
    runtime: Parameters<typeof runScopedSecurityReview>[0]['runtime'],
  ) {
    return runScopedSecurityReview({
      runtime,
      workItemId: 'SC-WI-1',
      repository: REPO,
      storePath: rt.root,
      implementationProducers: [PRODUCER],
      reviewedAt: '2026-08-25T00:00:00.000Z',
      allFiles: FILES,
      readFile: () => 'export const x = 1;',
    });
  }

  it('dispatches one run per required area, each told only its own area', async () => {
    const rt = project();
    const { seen, runtime } = areaRuntime(clean);
    const outcome = await scoped(rt, runtime);

    expect(outcome.refusals).toEqual([]);
    expect(seen.length).toBe(REQUIRED_SCOPE.length);
    expect(new Set(seen.map((x) => x.area)).size).toBe(REQUIRED_SCOPE.length);
    expect(outcome.review?.scope).toEqual([...REQUIRED_SCOPE]);

    /* Each run is bounded to its own area, so findings cannot drift across scopes. */
    for (const { area, request } of seen) {
      expect(String(request['scopeBoundary'])).toContain(area);
    }
  });

  it('one CRITICAL anywhere blocks the whole review', async () => {
    /* A review is not an average of its areas. The strictest part decides. */
    const rt = project();
    const { runtime } = areaRuntime((area) =>
      area === 'Owner authority'
        ? {
            outcome: 'COMPLETED',
            result: {
              scope: [area],
              findings: [
                {
                  id: 'F-1',
                  severity: Severity.CRITICAL,
                  area,
                  statement: 'a gate can be bypassed',
                  evidence: ['src/app/conversation.ts:1'],
                },
              ],
              verdict: ReviewVerdict.BLOCKED,
              summary: 'blocked',
            },
          }
        : clean(area),
    );
    const outcome = await scoped(rt, runtime);
    expect(outcome.review?.verdict).toBe(ReviewVerdict.BLOCKED);
    expect(outcome.review?.findings.length).toBe(1);
  });

  it('an area that could not be reviewed refuses the whole review', async () => {
    /* Sixteen of seventeen areas is not a review of seventeen. */
    const rt = project();
    const { runtime } = areaRuntime((area) =>
      area === 'AI Runtime' ? { outcome: 'ESCALATED' } : clean(area),
    );
    const outcome = await scoped(rt, runtime);
    expect(outcome.review).toBeUndefined();
    expect(outcome.refusals.join(' ')).toContain('AI Runtime');
  });

  it('namespaces finding ids by area so two reviewers cannot collide', async () => {
    const rt = project();
    const { runtime } = areaRuntime((area) => ({
      outcome: 'COMPLETED',
      result: {
        scope: [area],
        findings: [
          {
            id: 'F-1',
            severity: Severity.LOW,
            area,
            statement: 'a note',
            evidence: ['src/store/store.ts:1'],
          },
        ],
        verdict: ReviewVerdict.ACCEPTED,
        summary: 'ok',
      },
    }));
    const outcome = await scoped(rt, runtime);
    const ids = outcome.review?.findings.map((f) => f.id) ?? [];
    expect(ids.length).toBe(REQUIRED_SCOPE.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tells the reviewer which files it did NOT get', async () => {
    /*
     * A reviewer that silently receives a truncated bundle reports on a codebase that does not
     * exist. Naming the omissions is what makes the scope honest.
     */
    const source = reviewAreaFiles(
      'Core Store/integrity',
      ['src/store/a.ts', 'src/store/b.ts'],
      () => 'x'.repeat(1000),
      1500,
    );
    expect(source.files).toEqual(['src/store/a.ts']);
    expect(source.omitted).toEqual(['src/store/b.ts']);
  });

  it('tells the reviewer it holds no tools, so it cannot claim to have read files', async () => {
    /*
     * The first real run lost seven areas to EVIDENCE_VIOLATION. The reviewer wrote "Read
     * src/gates/authority.ts and analysed..." and the runtime contradicted it correctly: no
     * tool call happened in that run, because this grant deliberately provides none.
     *
     * The reviewer was not lying so much as describing analysis in the idiom of reading, and
     * the prompt invited it. A claim to have performed an action nothing observed is exactly
     * what claim assessment exists to catch, so the prompt now says plainly where the source
     * came from and how to describe working on it.
     */
    const rt = project();
    const { seen, runtime } = areaRuntime(clean);
    await scoped(rt, runtime);
    const task = String(seen[0]?.request['taskDefinition']);
    expect(task).toContain('SUPPLIED TO YOU AS CONTEXT');
    expect(task).toContain('you hold no tools');
    expect(task.toLowerCase()).toContain('never');
  });

  it('gives each area long enough to actually read its source', async () => {
    /* Every FAILED area in the first real run was `terminated: TIMEOUT` at the 180s default. */
    const rt = project();
    const { seen, runtime } = areaRuntime(clean);
    await scoped(rt, runtime);
    const budget = seen[0]?.request['budget'] as { maxWallTimeMs?: number } | undefined;
    expect(budget?.maxWallTimeMs ?? 0).toBeGreaterThan(180_000);
  });

  it('maps every required area to real source', () => {
    /* An area matching nothing is a hole in the table, and would review nothing at all. */
    for (const area of REQUIRED_SCOPE) {
      expect(AREA_SOURCES[area], area + ' has no source mapping').toBeDefined();
      expect((AREA_SOURCES[area] ?? []).length, area).toBeGreaterThan(0);
    }
  });
});
