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
 * The judgement it returns is not accepted here. It is written out, then re-resolved by
 * `resolveSecurityReview` against the repository and the store, and the JUDGED proof is minted
 * only if that resolution is clean. This script can therefore produce a BLOCKED verdict and
 * no proof, which is the correct outcome for a commit with a real finding in it — and the one
 * outcome a script that trusted its own reviewer could never reach.
 */

const root = process.cwd();
const REVIEW_OUT = 'evidence/acceptance-run/security-review.json';
const REQUIREMENT = 'SECURITY-INDEPENDENT';

const { ServaRuntime } = await import('../dist/app/runtime.js');
const { buildAiLayer } = await import('../dist/app/ai.js');
const { repositoryIdentity } = await import('../dist/acceptance/status.js');
const { PROOF_DIR, ProofStatus, VerificationType } = await import('../dist/acceptance/proof.js');
const { ReviewVerdict, resolveSecurityReview } =
  await import('../dist/acceptance/securityReview.js');
const { DEFAULT_SECURITY_REVIEWER, runSecurityReview } =
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

/** The source the reviewer actually judges. Read here so the run needs no filesystem tool. */
function sourceContext() {
  const files = execSync('git ls-files src extension/src', { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f.endsWith('.ts'));

  const parts = [];
  let budget = 480_000;
  for (const f of files) {
    const text = readFileSync(join(root, ...f.split('/')), 'utf8');
    if (text.length > budget) break;
    budget -= text.length;
    parts.push('=== ' + f + ' ===\n' + text);
  }
  return { content: parts.join('\n\n'), files: files.length, included: parts.length };
}

const source = sourceContext();
console.log(
  'security-review: reviewing ' +
    repository.commit.slice(0, 12) +
    ' — ' +
    String(source.included) +
    ' of ' +
    String(source.files) +
    ' source files in context',
);

const storeRoot = process.env['SERVA_REVIEW_STORE'] ?? join(root, 'out', 'security-review-store');
mkdirSync(dirname(storeRoot), { recursive: true });

const rt = existsSync(join(storeRoot, '.serva'))
  ? ServaRuntime.open({ root: storeRoot })
  : ServaRuntime.init('Serva Code', 'Review this implementation for security', {
      root: storeRoot,
    });

const ai = buildAiLayer(rt);

const outcome = await runSecurityReview({
  runtime: ai.runtime,
  workItemId: 'SC-WI-SECURITY-REVIEW',
  repository,
  storePath: storeRoot,
  implementationProducers: IMPLEMENTATION_PRODUCERS,
  reviewedAt: new Date().toISOString(),
  agentId: DEFAULT_SECURITY_REVIEWER,
  canon: [
    {
      source: 'implementation',
      kind: 'SOURCE',
      version: repository.tree,
      content: source.content,
      relevance: 1,
    },
  ],
});

if (outcome.review === undefined) {
  console.error('security-review: the review did not complete.');
  for (const r of outcome.refusals) console.error('  - ' + r);
  for (const d of outcome.run.diagnostics.slice(0, 5)) console.error('  ' + d);
  process.exit(1);
}

const reviewPath = join(root, ...REVIEW_OUT.split('/'));
mkdirSync(dirname(reviewPath), { recursive: true });
writeFileSync(reviewPath, JSON.stringify(outcome.review, null, 2) + '\n', 'utf8');
console.log('security-review: verdict ' + outcome.review.verdict);
for (const f of outcome.review.findings) {
  console.log('  ' + f.severity.padEnd(8) + f.area + ' — ' + f.statement);
}

/*
 * THE REVIEW IS NOT TRUSTED BECAUSE THIS SCRIPT PRODUCED IT.
 *
 * Re-resolved against Git and the store, exactly as it would be by anyone auditing the
 * package later. If the reviewer named a commit it did not review, ended in a run that did not
 * complete, or declared ACCEPTED over a HIGH finding, this is where it stops.
 */
const resolution = resolveSecurityReview({
  root,
  repository,
  openStore: (path) => (path === storeRoot ? rt.store : undefined),
});

if (!resolution.resolved) {
  console.error('');
  console.error('security-review: the review does not resolve, so no proof is minted:');
  for (const r of resolution.refusals) console.error('  - ' + r);
  if (outcome.review.verdict === ReviewVerdict.BLOCKED) {
    console.error('');
    console.error('  This is a real finding, not a tooling failure. Fix it and review again.');
  }
  process.exit(1);
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
  scope: outcome.review.scope,
  reviewerRunRef: {
    runId: outcome.review.reviewerRunId,
    agentId: outcome.review.reviewerAgentId,
    storePath: storeRoot,
  },
  evidence: [
    {
      kind: 'FILE',
      ref: REVIEW_OUT,
      digest: digest(reviewPath),
      note: 'the review as the reviewer left it, re-resolved rather than read',
    },
    {
      kind: 'AGENT_RUN',
      ref: outcome.review.reviewerRunId,
      note: outcome.review.reviewerAgentId + ' — VERIFIER, write = NONE, network = NONE',
    },
    { kind: 'COMMIT', ref: repository.commit, note: 'the exact implementation reviewed' },
  ],
  notes:
    'Independent review by ' +
    outcome.review.reviewerAgentId +
    ' at ' +
    repository.commit.slice(0, 12) +
    ': ' +
    String(outcome.review.findings.length) +
    ' finding(s), verdict ' +
    outcome.review.verdict +
    '. No CRITICAL or HIGH finding remains unresolved.',
};

const proofPath = join(root, ...PROOF_DIR.split('/'), REQUIREMENT + '.json');
mkdirSync(dirname(proofPath), { recursive: true });
writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n', 'utf8');

console.log('');
console.log('security-review: minted ' + REQUIREMENT + ' at ' + repository.commit.slice(0, 12));
