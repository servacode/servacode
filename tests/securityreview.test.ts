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
  partitionGap,
  reviewUnitsFor,
  runScopedSecurityReview,
  runSecurityReview,
} from '../src/acceptance/securityReviewRun.js';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ContractRegistry } from '../src/agents/registry.js';
import { ScopeCoverage, listScopeReviews } from '../src/acceptance/scopeReview.js';
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
/** A VERIFIER by contract, used where the test needs authority without independence. */
const REVIEWER_VERIFIER = 'SC-AGENT-200';
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

/** Write a review into an existing project root. */
function write(root: string, body: unknown): void {
  const path = join(root, ...REVIEW_PATH.split('/'));
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2), 'utf8');
}

function resolve(root: string, store?: Store, over: Record<string, unknown> = {}) {
  return resolveSecurityReview({
    root,
    repository: REPOSITORY,
    openStore: () => store,
    /* Every real caller supplies this; without it the authority is unknown and refused. */
    registry: ContractRegistry.shared(),
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
      /*
       * Independence is now decided by governed history rather than by the document, so the
       * store must actually record this agent producing. SC-AGENT-200 is a VERIFIER by
       * contract — which is the point: holding the authority does not make you independent of
       * work you did yourself.
       */
      const tx = rt.store.begin();
      tx.putCanon('agentRunRecord', 'SC-RUN-PRODUCED', {
        runId: 'SC-RUN-PRODUCED',
        agentId: REVIEWER_VERIFIER,
        roleInTask: 'PRODUCER',
        outcome: 'COMPLETED',
      });
      tx.commit();
      seedRun(rt.store, 'SC-RUN-000100', REVIEWER_VERIFIER);
      const result = resolve(
        pkg(
          review({
            reviewerAgentId: REVIEWER_VERIFIER,
            independence: {
              implementationProducers: [REVIEWER_VERIFIER],
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
      /* The contract grants EXECUTE, whatever the document wrote in its own authority field. */
      expect(result.refusals.join(' ')).toContain('EXECUTE');
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
      registry: ContractRegistry.shared(),
    });
    expect(resolved.refusals, resolved.refusals.join('; ')).toEqual([]);
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
        reviewUnitsFor(area).flatMap((unit) =>
          unit.prefixes.map((prefix) =>
            prefix.endsWith('/') ? prefix + 'seed.ts' : prefix + '.ts',
          ),
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
        const units = REQUIRED_SCOPE.flatMap((a) => reviewUnitsFor(a)).map((u) => u.unit);
        const area = units.find((a) => task.includes('Area under review: ' + a)) ?? '?';
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
      store: rt.store,
    });
  }

  it('dispatches one run per required area, each told only its own area', async () => {
    const rt = project();
    const { seen, runtime } = areaRuntime(clean);
    const outcome = await scoped(rt, runtime);

    expect(outcome.refusals).toEqual([]);
    /* One run per UNIT: most areas are one unit, and an oversized one is several. */
    const units = REQUIRED_SCOPE.flatMap((a) => reviewUnitsFor(a));
    expect(seen.length).toBe(units.length);
    expect(new Set(seen.map((x) => x.area)).size).toBe(units.length);
    /* Coverage is still reported against REQUIRED_SCOPE, never against the units. */
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
    expect(ids.length).toBe(REQUIRED_SCOPE.flatMap((a) => reviewUnitsFor(a)).length);
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

  it('tells the reviewer which claim kind is honest for analysing supplied text', async () => {
    /*
     * Two areas still ended EVIDENCE_VIOLATION after the wording fix, and the reviewer had
     * actually complied: its statements read "Analysed the supplied text of http.ts...". What
     * the runtime contradicted was the claim KIND — `FILE_READ` — because a run holding no
     * tools completed no tool call, so it cannot have read a file.
     *
     * The assessor was right both times. The prompt was wrong: it told the reviewer how to
     * phrase a claim and never told it which kind of claim it was entitled to make.
     */
    const rt = project();
    const { seen, runtime } = areaRuntime(clean);
    await scoped(rt, runtime);
    const task = String(seen[0]?.request['taskDefinition']);
    expect(task).toContain('OTHER');
    expect(task).toContain('FILE_READ');
  });

  it('gives each area long enough to actually read its source', async () => {
    /* Every FAILED area in the first real run was `terminated: TIMEOUT` at the 180s default. */
    const rt = project();
    const { seen, runtime } = areaRuntime(clean);
    await scoped(rt, runtime);
    const budget = seen[0]?.request['budget'] as { maxWallTimeMs?: number } | undefined;
    expect(budget?.maxWallTimeMs ?? 0).toBeGreaterThan(180_000);
  });

  it('persists every area attempt, including the ones that refused', async () => {
    /*
     * SPEC: finding SSA-5. The whole point: a review that dies must leave more evidence than
     * one that passes, so a later resolver never has to pay for the same model calls twice.
     */
    const rt = project();
    const { runtime } = areaRuntime((area) =>
      area === 'AI Runtime' ? { outcome: 'EVIDENCE_VIOLATION' } : clean(area),
    );
    const outcome = await scoped(rt, runtime);
    expect(outcome.review).toBeUndefined();

    const persisted = listScopeReviews(rt.store);
    expect(persisted.length).toBe(REQUIRED_SCOPE.flatMap((a) => reviewUnitsFor(a)).length);

    const refused = persisted.find((r) => r.scopeName === 'AI Runtime');
    expect(refused?.terminalOutcome).toBe('EVIDENCE_VIOLATION');
    expect(refused?.coverage).toBe(ScopeCoverage.NOT_REVIEWED);
    expect(refused?.refusal).toBeDefined();
  });

  it('persists findings from a BLOCKED area, which is the case that lost them', async () => {
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
                  severity: Severity.HIGH,
                  area,
                  statement: 'the guard is inert on the default path',
                  evidence: ['src/acceptance/proof.ts:445'],
                },
              ],
              verdict: ReviewVerdict.BLOCKED,
              summary: 'blocked',
            },
          }
        : clean(area),
    );
    await scoped(rt, runtime);

    const blocked = listScopeReviews(rt.store).find((r) => r.scopeName === 'Owner authority');
    expect(blocked?.verdict).toBe(ReviewVerdict.BLOCKED);
    expect(blocked?.findings[0]?.severity).toBe(Severity.HIGH);
    expect(blocked?.findings[0]?.evidence).toContain('src/acceptance/proof.ts:445');
    expect(blocked?.findings[0]?.resolved).toBe(false);
  });

  it('records omitted files as PARTIAL coverage, never as complete', async () => {
    const rt = project();
    const { runtime } = areaRuntime(clean);
    await runScopedSecurityReview({
      runtime,
      workItemId: 'SC-WI-1',
      repository: REPO,
      storePath: rt.root,
      implementationProducers: [PRODUCER],
      reviewedAt: '2026-08-25T00:00:00.000Z',
      allFiles: FILES,
      /* Every file is too large for the budget, so every area omits something. */
      readFile: () => 'x'.repeat(400_000),
      store: rt.store,
    });
    for (const r of listScopeReviews(rt.store)) {
      expect(r.coverage, r.scopeName).not.toBe(ScopeCoverage.COMPLETE);
    }
  });

  it('retries a transient engine failure rather than losing the area', async () => {
    /*
     * SPEC: Phase 6 final acceptance sequence §7.
     *
     * Five of twenty-two areas were lost to three causes, none of them a product defect and
     * all of them mine: a wall-clock budget the largest area exceeded, two ENGINE_ERRORs six
     * seconds apart (a transient provider failure — "engine result error: success" alongside
     * exit code 1), and one `error_max_structured_output_retries` after 42k output tokens.
     *
     * A single transient failure costing an entire scoped review is a review that reports on
     * the provider's mood. One retry per unit costs one extra call in the rare case and saves
     * a whole area; it does NOT retry a refusal, because a refusal is an answer.
     */
    const rt = project();
    let attempts = 0;
    const seenAreas = new Map<string, number>();
    const runtime = {
      run: (request: Record<string, unknown>) => {
        attempts += 1;
        const task = String(request['taskDefinition']);
        const units = REQUIRED_SCOPE.flatMap((a) => reviewUnitsFor(a)).map((u) => u.unit);
        const area = units.find((a) => task.includes('Area under review: ' + a)) ?? '?';
        /*
         * The FIRST attempt at one area dies the way the real ones did, and the second
         * succeeds — which is what "transient" means, and what a retry is for.
         */
        seenAreas.set(area, (seenAreas.get(area) ?? 0) + 1);
        const transient = area === 'AI Runtime' && seenAreas.get(area) === 1;
        return Promise.resolve({
          runId: 'SC-RUN-' + String(attempts),
          outcome: transient ? 'FAILED' : 'COMPLETED',
          bundle: {},
          envelope: { result: transient ? undefined : clean(area).result },
          claimAssessments: [],
          attempts: 1,
          diagnostics: transient ? ['terminated: ENGINE_ERROR'] : [],
        });
      },
    } as unknown as Parameters<typeof runScopedSecurityReview>[0]['runtime'];

    const outcome = await runScopedSecurityReview({
      runtime,
      workItemId: 'SC-WI-1',
      repository: REPO,
      storePath: rt.root,
      implementationProducers: [PRODUCER],
      reviewedAt: '2026-08-25T00:00:00.000Z',
      allFiles: FILES,
      readFile: () => 'export const x = 1;',
      store: rt.store,
    });

    const ai = outcome.areas.find((a) => a.area === 'AI Runtime');
    /* It was retried: more runs than units. */
    expect(attempts).toBeGreaterThan(REQUIRED_SCOPE.flatMap((a) => reviewUnitsFor(a)).length);
    expect(ai?.refusal, 'a transient failure still lost the area').toBeUndefined();
  });

  it('does not retry a refusal, because a refusal is an answer', async () => {
    /*
     * An EVIDENCE_VIOLATION is the runtime catching a false claim. Retrying it would be asking
     * the same reviewer to say something different, which is not verification.
     */
    const rt = project();
    let attempts = 0;
    const runtime = {
      run: () => {
        attempts += 1;
        return Promise.resolve({
          runId: 'SC-RUN-' + String(attempts),
          outcome: 'EVIDENCE_VIOLATION',
          bundle: {},
          envelope: {},
          claimAssessments: [],
          attempts: 1,
          diagnostics: [],
        });
      },
    } as unknown as Parameters<typeof runScopedSecurityReview>[0]['runtime'];

    await runScopedSecurityReview({
      runtime,
      workItemId: 'SC-WI-1',
      repository: REPO,
      storePath: rt.root,
      implementationProducers: [PRODUCER],
      reviewedAt: '2026-08-25T00:00:00.000Z',
      allFiles: FILES,
      readFile: () => 'export const x = 1;',
      store: rt.store,
    });
    expect(attempts).toBe(REQUIRED_SCOPE.flatMap((a) => reviewUnitsFor(a)).length);
  });

  it('bounds what the reviewer may return, so a huge answer is not a lost area', async () => {
    /*
     * One area died on `error_max_structured_output_retries` after 42k output tokens: the
     * reviewer wrote more than the structured schema could carry. Asking for fewer, better
     * findings is the fix — a review that reports everything reports nothing.
     */
    const rt = project();
    const { seen, runtime } = areaRuntime(clean);
    await scoped(rt, runtime);
    const task = String(seen[0]?.request['taskDefinition']);
    expect(task).toMatch(/most|at most|no more than/i);
  });

  it('maps every required area to real source', () => {
    /* An area matching nothing is a hole in the table, and would review nothing at all. */
    for (const area of REQUIRED_SCOPE) {
      expect(AREA_SOURCES[area], area + ' has no source mapping').toBeDefined();
      expect((AREA_SOURCES[area] ?? []).length, area).toBeGreaterThan(0);
    }
  });
});

/* ====== SSA-3 & SSA-4: the document must not define the facts that authorise it ====== */

describe('a forged review document cannot manufacture independence or authority', () => {
  /*
   * SPEC: findings SSA-3 (MEDIUM) and SSA-4 (LOW), from the independent security review.
   *
   * `resolveSecurityReview` read `independence.implementationProducers` and
   * `reviewerAuthority` straight out of the parsed file. A hand-authored review naming a real
   * completed run could declare an empty producer set and `VERIFY`, and pass both checks — in
   * the module whose entire purpose is that a file cannot certify itself.
   *
   * EVIDENCE FILE TEXT IS NOT AUTHORITY. The document may now REFERENCE these facts; the
   * store and the contract registry DECIDE them.
   */
  function seedProducerRun(store: Store, agentId: string): void {
    const tx = store.begin();
    tx.putCanon('agentRunRecord', 'SC-RUN-PRODUCED', {
      runId: 'SC-RUN-PRODUCED',
      agentId,
      roleInTask: 'PRODUCER',
      outcome: 'COMPLETED',
    });
    tx.commit();
  }

  function resolveIt(rt: ServaRuntime) {
    return resolveSecurityReview({
      root: rt.root,
      repository: REPOSITORY,
      openStore: () => rt.store,
      registry: ContractRegistry.shared(),
    });
  }

  it('refuses a review declaring an empty producer set when the store says otherwise', () => {
    const rt = project();
    /* Governed history says SC-AGENT-200 produced. The document says nobody did. */
    seedProducerRun(rt.store, 'SC-AGENT-200');
    seedRun(rt.store, 'SC-RUN-000100', 'SC-AGENT-200');
    write(rt.root, review({ reviewerAgentId: 'SC-AGENT-200', storePath: rt.root }));

    const resolved = resolveIt(rt);
    expect(resolved.resolved).toBe(false);
    expect(resolved.refusals.join(' ')).toContain('produced');
  });

  it('refuses a forged reviewerAuthority the contract does not grant', () => {
    const rt = project();
    seedRun(rt.store, 'SC-RUN-000100', PRODUCER);
    /* SC-AGENT-150 is a PRODUCER; the document claims it holds VERIFY. */
    write(
      rt.root,
      review({ reviewerAgentId: PRODUCER, reviewerAuthority: 'VERIFY', storePath: rt.root }),
    );

    const resolved = resolveIt(rt);
    expect(resolved.resolved).toBe(false);
    expect(resolved.refusals.join(' ')).toContain('authority');
  });

  it('refuses a reviewer identity no contract issues', () => {
    const rt = project();
    seedRun(rt.store, 'SC-RUN-000100', 'SC-AGENT-999');
    write(
      rt.root,
      review({ reviewerAgentId: 'SC-AGENT-999', reviewerAuthority: 'VERIFY', storePath: rt.root }),
    );

    const resolved = resolveIt(rt);
    expect(resolved.resolved).toBe(false);
  });

  it('accepts a reviewer the contract and the store both vouch for', () => {
    const rt = project();
    seedProducerRun(rt.store, PRODUCER);
    seedRun(rt.store, 'SC-RUN-000100', REVIEWER);
    write(rt.root, review({ storePath: rt.root }));

    const resolved = resolveIt(rt);
    expect(resolved.refusals, resolved.refusals.join('; ')).toEqual([]);
    expect(resolved.resolved).toBe(true);
  });
});

describe('scope coverage is decided by exact identity, not an 8-character prefix', () => {
  /*
   * SPEC: finding SSA-4 (LOW).
   *
   * Coverage matched `s.toLowerCase().includes(area.toLowerCase().slice(0, 8))`, so any scope
   * entry containing an area's first eight lowercased characters counted as covering it.
   * "backup/r" covers "backup/restore"; so does "backup/rubbish".
   */
  function resolveWithScope(scope: readonly string[]) {
    const rt = project();
    seedRun(rt.store, 'SC-RUN-000100', REVIEWER);
    write(rt.root, review({ scope: [...scope], storePath: rt.root }));
    return resolveSecurityReview({
      root: rt.root,
      repository: REPOSITORY,
      openStore: () => rt.store,
      registry: ContractRegistry.shared(),
    });
  }

  it('the exact required scope resolves', () => {
    const resolved = resolveWithScope(REQUIRED_SCOPE);
    expect(resolved.refusals.join(' ')).not.toContain('did not cover');
  });

  it('a prefix of a required area does not cover it', () => {
    const resolved = resolveWithScope(REQUIRED_SCOPE.map((a) => a.slice(0, 8)));
    expect(resolved.refusals.join(' ')).toContain('did not cover');
  });

  it('a different area sharing the first eight characters does not cover it', () => {
    const resolved = resolveWithScope(
      REQUIRED_SCOPE.map((a) => (a === 'backup/restore' ? 'backup/rubbish' : a)),
    );
    expect(resolved.refusals.join(' ')).toContain('backup/restore');
  });

  it('normalization is explicit: case and surrounding space do not change identity', () => {
    /* Deterministic and stated, rather than emergent from a substring test. */
    const resolved = resolveWithScope(REQUIRED_SCOPE.map((a) => '  ' + a.toUpperCase() + '  '));
    expect(resolved.refusals.join(' ')).not.toContain('did not cover');
  });

  it('a scope entry that merely contains a required area does not cover it', () => {
    const resolved = resolveWithScope(
      REQUIRED_SCOPE.map((a) => (a === 'migration' ? 'not really migration at all' : a)),
    );
    expect(resolved.refusals.join(' ')).toContain('migration');
  });
});

describe('an area too large for one sitting is split, and the split must lose nothing', () => {
  /*
   * SPEC: Phase 6 final acceptance sequence §7.
   *
   * `organizational learning` mapped to seventy files; the reviewer returned NOT_VERIFIED with
   * forty-one omitted, which was the correct answer to a question nobody could answer as
   * asked. The fix is not a bigger budget — a reviewer handed seventy files skims all of them.
   *
   * The risk in splitting is that a partition quietly drops a directory and turns an honest
   * NOT_VERIFIED into a false ACCEPTED. That is the one outcome worse than the original
   * problem, so it is what these tests are mostly about.
   */
  const REAL_FILES = execSync('git ls-files src extension/src', { encoding: 'utf8' })
    .split(/\r?\n/)
    .map((f) => f.trim())
    .filter((f) => f.endsWith('.ts'));

  it('every required area yields at least one review unit', () => {
    for (const area of REQUIRED_SCOPE) {
      expect(reviewUnitsFor(area).length, area).toBeGreaterThan(0);
    }
  });

  it('an unsplit area is exactly one unit named for itself', () => {
    const units = reviewUnitsFor('Reconciliation');
    expect(units.length).toBe(1);
    expect(units[0]?.unit).toBe('Reconciliation');
  });

  it('the split area covers every file the whole area maps to', () => {
    /* The property that makes splitting safe rather than merely convenient. */
    for (const area of REQUIRED_SCOPE) {
      expect(partitionGap(area, REAL_FILES), area + ' loses files in its partition').toEqual([]);
    }
  });

  it('each sub-scope of the split area fits in a single review budget', () => {
    const area = 'organizational learning';
    for (const unit of reviewUnitsFor(area)) {
      const source = reviewAreaFiles(
        area,
        REAL_FILES,
        (f) => readFileSync(f, 'utf8'),
        260_000,
        unit.prefixes,
        unit.except,
      );
      expect(source.files.length, unit.unit).toBeGreaterThan(0);
      expect(source.omitted, unit.unit + ' still omits files').toEqual([]);
    }
  });

  it('the whole area does NOT fit, which is why it is split', () => {
    /* Pins the reason. If this ever passes, the split has become unnecessary rather than wrong. */
    const source = reviewAreaFiles('organizational learning', REAL_FILES, (f) =>
      readFileSync(f, 'utf8'),
    );
    expect(source.omitted.length).toBeGreaterThan(0);
  });
});

describe('a targeted re-check informs a decision and can never satisfy one', () => {
  /*
   * `onlyUnits` exists so a defect that survived a fix costs one model call to find rather
   * than twenty-two. The risk in adding it is obvious — a partial run that could mint would
   * be a way to buy acceptance cheaply — so the aggregate is what refuses, and it refuses on
   * the same ground it always did: a missing area is a missing area.
   */
  const REPO = { commit: COMMIT, tree: TREE };

  it('reviews only the named unit', async () => {
    const rt = project();
    const seen: string[] = [];
    const runtime = {
      run: (request: Record<string, unknown>) => {
        seen.push(
          String(request['taskDefinition']).split('Area under review: ')[1]?.split('\n')[0] ?? '?',
        );
        return Promise.resolve({
          runId: 'SC-RUN-1',
          outcome: 'COMPLETED',
          bundle: {},
          envelope: {
            result: {
              scope: ['x'],
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
    } as unknown as Parameters<typeof runScopedSecurityReview>[0]['runtime'];

    const outcome = await runScopedSecurityReview({
      runtime,
      workItemId: 'SC-WI-1',
      repository: REPO,
      storePath: rt.root,
      implementationProducers: [PRODUCER],
      reviewedAt: '2026-08-30T00:00:00.000Z',
      allFiles: ['src/engineering/reconcile.ts'],
      readFile: () => 'export const x = 1;',
      store: rt.store,
      onlyUnits: ['Reconciliation'],
    });

    expect(seen).toEqual(['Reconciliation']);
    /* And it cannot pretend to be a whole review: the other areas are simply absent. */
    expect(outcome.review).toBeUndefined();
    expect(outcome.areas.length).toBe(1);
  });
});
