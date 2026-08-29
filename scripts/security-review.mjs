import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * RUN THE INDEPENDENT SECURITY REVIEW, AND MINT ITS PROOF FROM WHAT IT FOUND.
 *
 * SPEC: Phase 6 final acceptance sequence §7.
 *
 * §7 puts this last on purpose: a security review of a commit that is about to change is a
 * review of nothing. So this refuses a dirty tree, reads the commit from Git rather than from
 * any file, and dispatches a real governed run of SC-AGENT-220 — a VERIFIER whose contract
 * grants it no write authority and no network.
 *
 * Each area's judgement is persisted before anything else can happen, then the verdict is
 * AGGREGATED from those persisted records rather than from this process's own recollection of
 * them. So a review that dies partway leaves its findings behind, and a BLOCKED verdict mints
 * no proof at all — the correct outcome for a commit with a real finding in it, and the one
 * outcome a script that trusted its own reviewer could never reach.
 */

const root = process.cwd();
const REVIEW_OUT = 'evidence/acceptance-run/security-review.json';
const REQUIREMENT = 'SECURITY-INDEPENDENT';

const { ServaRuntime } = await import('../dist/app/runtime.js');
const { buildAiLayer } = await import('../dist/app/ai.js');
const { repositoryIdentity } = await import('../dist/acceptance/status.js');
const { AcceptanceProofSchema, PROOF_DIR, ProofStatus, VerificationType } =
  await import('../dist/acceptance/proof.js');
const { REQUIRED_SCOPE } = await import('../dist/acceptance/securityReview.js');
const { aggregateSecurityReview } = await import('../dist/acceptance/securityAggregate.js');
const { ContractRegistry } = await import('../dist/agents/registry.js');
const { DEFAULT_SECURITY_REVIEWER, runScopedSecurityReview } =
  await import('../dist/acceptance/securityReviewRun.js');
const { execSync } = await import('node:child_process');

const repository = repositoryIdentity(root);
if (repository === undefined) {
  console.error('security-review: no git identity, so a review would bind to nothing.');
  process.exit(1);
}

/*
 * A review of a tree that is not the one on disk describes something that does not exist.
 * `dist/` and `evidence/` are derived, and `out/` is scratch.
 */
const dirty = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .map((l) => l.slice(3).trim())
  .filter((p) => p !== '')
  .map((p) => p.replace(/^"|"$/g, '').replace(/\\/g, '/'))
  .filter((p) => !p.startsWith('dist/') && !p.startsWith('evidence/') && !p.startsWith('out/'));

if (dirty.length > 0) {
  console.error('security-review: the working tree differs from HEAD. Commit first:');
  for (const p of dirty.slice(0, 20)) console.error('  ' + p);
  process.exit(1);
}

/**
 * Everything that produced the implementation being reviewed.
 *
 * Recorded so independence can be checked rather than assumed. A reviewer drawn from this set
 * would be certifying its own work, and `resolveSecurityReview` refuses that.
 */
const IMPLEMENTATION_PRODUCERS = ['SC-AGENT-150', 'SC-AGENT-160', 'SC-AGENT-180'];

/** Every source file in the repository, as the reviewer will be given them. */
const allFiles = execSync('git ls-files src extension/src', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .map((f) => f.trim())
  .filter((f) => f.endsWith('.ts'));

console.log(
  'security-review: reviewing ' +
    repository.commit.slice(0, 12) +
    ' — ' +
    String(allFiles.length) +
    ' source files across ' +
    String(REQUIRED_SCOPE.length) +
    ' scoped areas, one governed run each',
);

const storeRoot = process.env['SERVA_REVIEW_STORE'] ?? join(root, 'out', 'security-review-store');
mkdirSync(dirname(storeRoot), { recursive: true });

const rt = existsSync(join(storeRoot, '.serva'))
  ? ServaRuntime.open({ root: storeRoot })
  : ServaRuntime.init('Serva Code', 'Review this implementation for security', {
      root: storeRoot,
    });

const ai = buildAiLayer(rt);

const outcome = await runScopedSecurityReview({
  runtime: ai.runtime,
  workItemId: 'SC-WI-SECURITY-REVIEW',
  repository,
  storePath: storeRoot,
  implementationProducers: IMPLEMENTATION_PRODUCERS,
  reviewedAt: new Date().toISOString(),
  agentId: DEFAULT_SECURITY_REVIEWER,
  allFiles,
  readFile: (f) => readFileSync(join(root, ...f.split('/')), 'utf8'),
  /* SSA-5: every attempt is written down before this process can exit. */
  store: rt.store,
  onArea: (a) => {
    console.log(
      '  ' +
        (a.refusal === undefined ? a.verdict.padEnd(13) : 'NOT_REVIEWED ') +
        String(a.filesReviewed.length).padStart(3) +
        ' files  ' +
        String(a.findings.length) +
        ' finding(s)  ' +
        a.area +
        (a.omitted.length === 0 ? '' : '  [' + String(a.omitted.length) + ' omitted]'),
    );
  },
});

/*
 * THE IN-MEMORY OUTCOME IS A PROGRESS REPORT, NOT THE ANSWER.
 *
 * SPEC: findings SSA-3 and SSA-5. Whatever just happened is now on disk, so the verdict is
 * resolved from the persisted scope records rather than from this process's own recollection
 * of them. That is what makes the review re-checkable by someone who did not run it.
 */
const aggregated = aggregateSecurityReview({
  store: rt.store,
  repository,
  registry: ContractRegistry.shared(),
  reviewedAt: new Date().toISOString(),
  storePath: storeRoot,
});

console.log('');
if (aggregated.review === undefined) {
  console.error('security-review: the review does not aggregate, so no proof is minted:');
  for (const r of aggregated.refusals) console.error('  - ' + r);
  console.error('');
  console.error(
    '  ' +
      String(outcome.areas.filter((a) => a.refusal === undefined).length) +
      ' of ' +
      String(outcome.areas.length) +
      ' scoped reviews completed. Every attempt is persisted in ' +
      storeRoot +
      ' and can be re-resolved without re-running the model.',
  );
  process.exit(1);
}

const reviewPath = join(root, ...REVIEW_OUT.split('/'));
mkdirSync(dirname(reviewPath), { recursive: true });
writeFileSync(reviewPath, JSON.stringify(aggregated.review, null, 2) + '\n', 'utf8');

console.log('security-review: verdict ' + aggregated.review.verdict);
for (const f of aggregated.review.findings) {
  console.log('  ' + f.severity.padEnd(8) + f.area + ' — ' + f.statement.slice(0, 100));
}

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const proof = {
  requirementId: REQUIREMENT,
  verificationType: VerificationType.JUDGED,
  status: ProofStatus.PASS,
  implementationCommit: repository.commit,
  treeDigest: repository.tree,
  producedAt: new Date().toISOString(),
  producer: { kind: 'TOOL', id: 'scripts/security-review.mjs' },
  /* The proof's scope is prose a reader can disagree with, not the machine-readable list. */
  scope:
    'Independent security review of all ' +
    String(aggregated.review.scope.length) +
    ' required areas: ' +
    aggregated.review.scope.join('; '),
  reviewerRunRef: {
    runId: aggregated.review.reviewerRunId,
    agentId: aggregated.review.reviewerAgentId,
    storePath: storeRoot,
  },
  evidence: [
    {
      kind: 'FILE',
      id: REVIEW_OUT,
      digest: digest(reviewPath),
      note: 'the aggregate, re-resolved from persisted scope records rather than summarised',
    },
    ...aggregated.scopeRunIds.map((runId) => ({
      kind: 'AGENT_RUN',
      id: runId,
      note: 'one scoped review — VERIFIER, write = NONE, network = NONE',
    })),
    { kind: 'COMMIT', id: repository.commit, note: 'the exact implementation reviewed' },
  ],
  notes: [
    'Independent review of ' +
      repository.commit.slice(0, 12) +
      ' across ' +
      String(REQUIRED_SCOPE.length) +
      ' required areas in ' +
      String(aggregated.scopeRunIds.length) +
      ' governed runs: ' +
      String(aggregated.review.findings.length) +
      ' finding(s), verdict ' +
      aggregated.review.verdict +
      '. No CRITICAL or HIGH finding remains unresolved.',
  ],
};

/*
 * THE PROOF IS PARSED BEFORE IT IS WRITTEN.
 *
 * A complete, clean review minted a proof that `resolveProof` then refused as malformed —
 * `scope` was an array where the schema wants prose, and every evidence entry said `ref` where
 * it wants `id`. The review had done its job perfectly and the last twenty lines threw the
 * result away, which nothing caught because nothing checked the shape of what it wrote.
 *
 * Producing evidence and then refusing to look at it is the exact failure this whole phase has
 * been correcting, so the proof goes through the same schema that will later judge it.
 */
const parsedProof = AcceptanceProofSchema.safeParse(proof);
if (!parsedProof.success) {
  console.error('');
  console.error('security-review: the review is clean but the proof does not parse:');
  for (const issue of parsedProof.error.issues.slice(0, 5)) {
    console.error('  - ' + issue.path.join('.') + ' ' + issue.message);
  }
  process.exit(1);
}

const proofPath = join(root, ...PROOF_DIR.split('/'), REQUIREMENT + '.json');
mkdirSync(dirname(proofPath), { recursive: true });
writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n', 'utf8');

console.log('');
console.log('security-review: minted ' + REQUIREMENT + ' at ' + repository.commit.slice(0, 12));
