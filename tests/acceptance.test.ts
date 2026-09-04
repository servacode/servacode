import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AcceptanceState,
  LIVE_ASSESSORS,
  acceptanceStatus,
  defaultLiveChainAssessor,
  defaultRunResolver,
} from '../src/acceptance/status.js';
import {
  PROOF_DIR,
  ProofStatus,
  VerificationType,
  fileDigest,
  resolveProof,
} from '../src/acceptance/proof.js';
import { REQUIREMENTS } from '../src/acceptance/requirements.js';
import { ScopeCoverage, recordScopeReview } from '../src/acceptance/scopeReview.js';
import { REQUIRED_SCOPE, ReviewVerdict } from '../src/acceptance/securityReview.js';
import { reviewUnitsFor } from '../src/acceptance/securityReviewRun.js';
import { reviewerAuthorityOf } from '../src/acceptance/reviewAuthority.js';
import { ContractRegistry } from '../src/agents/registry.js';
import { ServaRuntime } from '../src/app/runtime.js';
import { cleanup, tempRoot } from './helpers.js';
import type { AcceptanceProof, RepositoryIdentity } from '../src/acceptance/proof.js';

/**
 * EVIDENCE FILE TEXT IS NOT AUTHORITY.
 *
 * The previous acceptance model read prose, and an independent audit took it apart. A
 * markdown line reading `Independent reviewer: Jane Roe` produced a green Security
 * Acceptance. `RESULT: ACCEPTED` in a text file produced a green Live Acceptance. Three
 * phrases in a walkthrough produced a green Portability.
 *
 * Worse than any of them: the test suite PROVED a synthetic markdown file passed, and I
 * wrote that test believing it strengthened something. A test can assert a defect as
 * confidently as a property.
 *
 * These tests are the replacement, and the first one is the adversarial case the audit
 * asked for by name.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const REPOSITORY: RepositoryIdentity = { commit: COMMIT, tree: TREE };

/** A package directory with the files a test puts in it. */
function pkg(files: Readonly<Record<string, string>> = {}): string {
  const root = tempRoot();
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, ...rel.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return root;
}

/** Write a proof, and an evidence file it cites with a correct digest. */
function writeProof(
  root: string,
  proof: Partial<AcceptanceProof> & { requirementId: string },
  evidenceContent = 'the evidence\n',
): AcceptanceProof {
  const evidencePath = 'evidence/' + proof.requirementId + '.txt';
  const full = join(root, ...evidencePath.split('/'));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, evidenceContent, 'utf8');

  const complete: AcceptanceProof = {
    requirementId: proof.requirementId,
    verificationType: proof.verificationType ?? VerificationType.DETERMINISTIC,
    status: proof.status ?? ProofStatus.PASS,
    implementationCommit: proof.implementationCommit ?? COMMIT,
    treeDigest: proof.treeDigest ?? TREE,
    producedAt: proof.producedAt ?? '2026-08-24T00:00:00.000Z',
    producer: proof.producer ?? { kind: 'TOOL', id: 'test-harness' },
    scope: proof.scope ?? 'the thing being proved',
    evidence: proof.evidence ?? [
      { kind: 'FILE', id: evidencePath, digest: String(fileDigest(full)) },
    ],
    notes: proof.notes ?? [],
    ...(proof.machineFingerprint === undefined
      ? {}
      : { machineFingerprint: proof.machineFingerprint }),
    ...(proof.reviewerRunRef === undefined ? {} : { reviewerRunRef: proof.reviewerRunRef }),
    ...(proof.liveRunRef === undefined ? {} : { liveRunRef: proof.liveRunRef }),
  };

  const path = join(root, ...PROOF_DIR.split('/'), proof.requirementId + '.json');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(complete, null, 2), 'utf8');
  return complete;
}

function resolve(root: string, id: string, over: Record<string, unknown> = {}) {
  return resolveProof(id, { root, repository: REPOSITORY, ...over });
}

/* ============================================ the adversarial case the audit named */

describe('a markdown line naming a person does not satisfy the security requirement', () => {
  it('SECURITY_REVIEW.md with `Independent reviewer: Jane Roe` and no governed review is NOT_VERIFIED', () => {
    const root = pkg({
      'evidence/SECURITY_REVIEW.md':
        '# SECURITY REVIEW\n\nIndependent reviewer: Jane Roe\n\nEverything looks fine to me.\n',
    });
    const status = acceptanceStatus({ root, repository: REPOSITORY });
    const security = status.requirements.find((r) => r.id === 'SECURITY-INDEPENDENT');

    expect(security?.state).toBe(AcceptanceState.NOT_VERIFIED);
    expect(security?.resolution.refusals.join(' ')).toContain('no acceptance proof exists');
    expect(status.readyForOwnerUse).toBe(false);
  });

  it('a text file containing `RESULT: ACCEPTED` grants nothing', () => {
    const root = pkg({
      'evidence/LIVE_SERVA_ACCEPTANCE.txt': 'RESULT: ACCEPTED\n\nIt all worked.\n',
    });
    const status = acceptanceStatus({ root, repository: REPOSITORY });
    for (const id of ['LIVE-ENGINEERING', 'LIVE-SERVA']) {
      expect(status.requirements.find((r) => r.id === id)?.state, id).toBe(
        AcceptanceState.NOT_VERIFIED,
      );
    }
  });

  it('prose phrases in a walkthrough grant nothing', () => {
    const root = pkg({
      'evidence/PORTABILITY_WALKTHROUGH.txt': [
        'every non-excluded file came back.',
        'no machine-bound family is present.',
        'nothing in the bundle matches a credential shape.',
      ].join('\n'),
    });
    expect(
      acceptanceStatus({ root, repository: REPOSITORY }).requirements.find(
        (r) => r.id === 'PORTABILITY-FINAL',
      )?.state,
    ).toBe(AcceptanceState.NOT_VERIFIED);
  });

  it('an implementation file existing proves nothing about it', () => {
    const root = pkg({ 'src/coverage/index.ts': 'export const x = 1;\n' });
    expect(
      acceptanceStatus({ root, repository: REPOSITORY }).requirements.find(
        (r) => r.id === 'P6-LIFECYCLE',
      )?.state,
    ).toBe(AcceptanceState.NOT_VERIFIED);
  });
});

/* ================================================== a proof is checked, not believed */

describe('a proof resolves against the world or it does not resolve', () => {
  it('a complete, honest proof resolves to PASS', () => {
    const root = pkg();
    writeProof(root, { requirementId: 'P6-LIFECYCLE' });
    const resolved = resolve(root, 'P6-LIFECYCLE');
    expect(resolved.status, resolved.refusals.join('; ')).toBe(ProofStatus.PASS);
  });

  it('a proof for a different commit does not bind to this package', () => {
    const root = pkg();
    writeProof(root, { requirementId: 'P6-LIFECYCLE', implementationCommit: 'c'.repeat(40) });
    expect(resolve(root, 'P6-LIFECYCLE').refusals.join(' ')).toContain('describes commit');
  });

  it('a proof carried onto a modified tree fails on the tree digest', () => {
    const root = pkg();
    /*
     * The commit is a label and the tree is the content. Without this, a proof survives
     * every change that does not create a new commit — which is every change during work.
     */
    writeProof(root, { requirementId: 'P6-LIFECYCLE', treeDigest: 'd'.repeat(40) });
    expect(resolve(root, 'P6-LIFECYCLE').refusals.join(' ')).toContain('describes tree');
  });

  it('evidence that changed since the proof was written fails its digest', () => {
    const root = pkg();
    writeProof(root, { requirementId: 'P6-LIFECYCLE' });
    writeFileSync(join(root, 'evidence', 'P6-LIFECYCLE.txt'), 'something else\n', 'utf8');
    expect(resolve(root, 'P6-LIFECYCLE').refusals.join(' ')).toContain(
      'does not match its recorded digest',
    );
  });

  it('evidence named but absent fails', () => {
    const root = pkg();
    writeProof(root, {
      requirementId: 'P6-LIFECYCLE',
      evidence: [{ kind: 'FILE', id: 'evidence/nowhere.txt', digest: 'e'.repeat(64) }],
    });
    expect(resolve(root, 'P6-LIFECYCLE').refusals.join(' ')).toContain('not in this package');
  });

  it('a proof citing no evidence asserts rather than establishes', () => {
    const root = pkg();
    writeProof(root, { requirementId: 'P6-LIFECYCLE', evidence: [] });
    expect(resolve(root, 'P6-LIFECYCLE').refusals.join(' ')).toContain('cites no evidence');
  });

  it('a deterministic proof produced by a person is a claim', () => {
    const root = pkg();
    writeProof(root, {
      requirementId: 'P6-LIFECYCLE',
      producer: { kind: 'HUMAN', id: 'somebody' },
    });
    expect(resolve(root, 'P6-LIFECYCLE').refusals.join(' ')).toContain('produced by a person');
  });

  it('with no repository identity, nothing binds and nothing passes', () => {
    const root = pkg();
    writeProof(root, { requirementId: 'P6-LIFECYCLE' });
    const resolved = resolveProof('P6-LIFECYCLE', { root });
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toContain('repository identity could not be read');
  });

  it('a proof that claims FAIL stays FAIL however clean everything else is', () => {
    const root = pkg();
    writeProof(root, { requirementId: 'P6-LIFECYCLE', status: ProofStatus.FAIL });
    expect(resolve(root, 'P6-LIFECYCLE').status).toBe(ProofStatus.FAIL);
  });
});

describe('OFFLINE-VERIFICATION is re-derived by the same rule that minted it', () => {
  /*
   * SPEC: finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SSA-REV-OFFLINE-ZEROTESTS (LOW), 1.0.1.
   *
   * `resolveProof` re-implemented a SUBSET of `resolveVerificationRecord`: missing command,
   * non-zero exit, failing tests — and not the guard on zero PASSING tests. The strong copy
   * ran at minting and the weak one at re-derivation, which is the wrong way round. A proof is
   * worth exactly what the resolver checks when someone later asks whether it still holds.
   */
  const RECORD = 'evidence/acceptance-run/offline-verification.json';

  function withRecord(commands: readonly Record<string, unknown>[]): string {
    const root = pkg({
      [RECORD]: JSON.stringify({
        producedBy: 'scripts/verify.mjs',
        producedAt: '2026-08-24T00:00:00.000Z',
        implementationCommit: COMMIT,
        treeDigest: TREE,
        commands,
      }),
    });
    const full = join(root, ...RECORD.split('/'));
    writeProof(root, {
      requirementId: 'OFFLINE-VERIFICATION',
      evidence: [{ kind: 'FILE', id: RECORD, digest: String(fileDigest(full)) }],
    });
    return root;
  }

  const green = (command: string, testsPassed: number) => ({
    command,
    exitCode: 0,
    startedAt: '2026-08-24T00:00:00.000Z',
    endedAt: '2026-08-24T00:01:00.000Z',
    durationMs: 60_000,
    testsPassed,
    testsFailed: 0,
  });

  it('a run that passed no tests verified nothing, however cleanly it exited', () => {
    const root = withRecord([green('npm run verify', 0), green('npm run test:vscode', 35)]);
    const resolved = resolve(root, 'OFFLINE-VERIFICATION');
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toContain('no passing tests');
  });

  it('a record missing one of the required commands does not prove the whole suite', () => {
    const root = withRecord([green('npm run verify', 1750)]);
    const resolved = resolve(root, 'OFFLINE-VERIFICATION');
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toContain('test:vscode');
  });
});

/* ================================================= judged proofs need a real reviewer */

describe('a JUDGED proof needs a governed reviewer run that actually exists', () => {
  const REVIEWER = { runId: 'SC-RUN-000001', agentId: 'SC-AGENT-200', storePath: '.serva-self' };

  it('with no reviewer run named, it fails', () => {
    const root = pkg();
    writeProof(root, {
      requirementId: 'SECURITY-INDEPENDENT',
      verificationType: VerificationType.JUDGED,
      producer: { kind: 'AGENT_RUN', id: 'SC-AGENT-200', runId: 'SC-RUN-000001' },
    });
    expect(resolve(root, 'SECURITY-INDEPENDENT').refusals.join(' ')).toContain(
      'must name the governed reviewer run',
    );
  });

  it('with a reviewer run that does not resolve, it fails', () => {
    const root = pkg();
    writeProof(root, {
      requirementId: 'SECURITY-INDEPENDENT',
      verificationType: VerificationType.JUDGED,
      producer: { kind: 'AGENT_RUN', id: 'SC-AGENT-200', runId: 'SC-RUN-000001' },
      reviewerRunRef: REVIEWER,
    });
    expect(
      resolve(root, 'SECURITY-INDEPENDENT', { resolveRun: () => undefined }).refusals.join(' '),
    ).toContain('does not resolve');
  });

  it('a reviewer run that did not complete judged nothing', () => {
    const root = pkg();
    writeProof(root, {
      requirementId: 'SECURITY-INDEPENDENT',
      verificationType: VerificationType.JUDGED,
      producer: { kind: 'AGENT_RUN', id: 'SC-AGENT-200', runId: 'SC-RUN-000001' },
      reviewerRunRef: REVIEWER,
    });
    const refusals = resolve(root, 'SECURITY-INDEPENDENT', {
      resolveRun: () => ({ agentId: 'SC-AGENT-200', outcome: 'FAILED' }),
    }).refusals;
    expect(refusals.join(' ')).toContain('judged nothing');
  });

  it('a reviewer who produced the implementation is not independent', () => {
    const root = pkg();
    writeProof(root, {
      requirementId: 'SECURITY-INDEPENDENT',
      verificationType: VerificationType.JUDGED,
      producer: { kind: 'AGENT_RUN', id: 'SC-AGENT-150', runId: 'SC-RUN-000001' },
      reviewerRunRef: { ...REVIEWER, agentId: 'SC-AGENT-150' },
    });
    const refusals = resolve(root, 'SECURITY-INDEPENDENT', {
      resolveRun: () => ({ agentId: 'SC-AGENT-150', outcome: 'COMPLETED' }),
      implementationProducers: ['SC-AGENT-150'],
    }).refusals;
    expect(refusals.join(' ')).toContain('not an independent review');
  });

  it('a run by a different actor than the proof names is refused', () => {
    const root = pkg();
    writeProof(root, {
      requirementId: 'SECURITY-INDEPENDENT',
      verificationType: VerificationType.JUDGED,
      producer: { kind: 'AGENT_RUN', id: 'SC-AGENT-200', runId: 'SC-RUN-000001' },
      reviewerRunRef: REVIEWER,
    });
    const refusals = resolve(root, 'SECURITY-INDEPENDENT', {
      resolveRun: () => ({ agentId: 'SC-AGENT-999', outcome: 'COMPLETED' }),
    }).refusals;
    expect(refusals.join(' ')).toContain('was made by SC-AGENT-999');
  });

  it('a complete, independent, completed reviewer run resolves', () => {
    const root = pkg();
    writeProof(root, {
      requirementId: 'SECURITY-INDEPENDENT',
      verificationType: VerificationType.JUDGED,
      producer: { kind: 'AGENT_RUN', id: 'SC-AGENT-200', runId: 'SC-RUN-000001' },
      reviewerRunRef: REVIEWER,
    });
    const resolved = resolve(root, 'SECURITY-INDEPENDENT', {
      resolveRun: () => ({ agentId: 'SC-AGENT-200', outcome: 'COMPLETED' }),
      implementationProducers: ['SC-AGENT-150'],
      /* SC-AGENT-200 is a VERIFIER by contract; the resolver is asked rather than assumed. */
      reviewerAuthority: (agentId: string) =>
        reviewerAuthorityOf(agentId, ContractRegistry.shared()),
      /* A clean canonical aggregate; the store-backed path is covered end to end below. */
      assessSecurityReview: () => ({ refusals: [] }),
    });
    expect(resolved.status, resolved.refusals.join('; ')).toBe(ProofStatus.PASS);
  });
});

/* ==================================================== live proofs need a real machine */

describe('a LIVE proof needs a machine and a run', () => {
  const LIVE = { runId: 'SC-RUN-000009', agentId: 'SC-AGENT-150', storePath: '.serva-live' };

  it('without a machine fingerprint it fails', () => {
    const root = pkg();
    writeProof(root, {
      requirementId: 'LIVE-ENGINEERING',
      verificationType: VerificationType.LIVE,
      producer: { kind: 'TOOL', id: 'serva-live' },
      liveRunRef: LIVE,
    });
    expect(
      resolve(root, 'LIVE-ENGINEERING', {
        resolveRun: () => ({ agentId: 'SC-AGENT-150', outcome: 'COMPLETED' }),
      }).refusals.join(' '),
    ).toContain('must name the machine');
  });

  it('without a resolvable run it fails', () => {
    const root = pkg();
    writeProof(root, {
      requirementId: 'LIVE-ENGINEERING',
      verificationType: VerificationType.LIVE,
      producer: { kind: 'TOOL', id: 'serva-live' },
      machineFingerprint: 'f'.repeat(64),
      liveRunRef: LIVE,
    });
    expect(
      resolve(root, 'LIVE-ENGINEERING', { resolveRun: () => undefined }).refusals.join(' '),
    ).toContain('does not resolve');
  });

  it('with both, it resolves', () => {
    const root = pkg();
    writeProof(root, {
      requirementId: 'LIVE-ENGINEERING',
      verificationType: VerificationType.LIVE,
      producer: { kind: 'TOOL', id: 'serva-live' },
      machineFingerprint: 'f'.repeat(64),
      liveRunRef: LIVE,
    });
    const resolved = resolve(root, 'LIVE-ENGINEERING', {
      resolveRun: () => ({ agentId: 'SC-AGENT-150', outcome: 'COMPLETED' }),
      /* The chain has its own tests below; this one is about the machine and the run. */
      assessLiveChain: () => ({ refusals: [] }),
    });
    expect(resolved.status, resolved.refusals.join('; ')).toBe(ProofStatus.PASS);
  });
});

/* ================================================= the kind of proof has to match */

describe('a weaker kind of proof does not satisfy a stronger requirement', () => {
  it('a DETERMINISTIC proof does not satisfy a LIVE requirement', () => {
    const root = pkg();
    writeProof(root, {
      requirementId: 'LIVE-ENGINEERING',
      verificationType: VerificationType.DETERMINISTIC,
    });
    const status = acceptanceStatus({ root, repository: REPOSITORY });
    const live = status.requirements.find((r) => r.id === 'LIVE-ENGINEERING');
    expect(live?.state).toBe(AcceptanceState.NOT_VERIFIED);
    expect(live?.resolution.refusals.join(' ')).toContain('needs LIVE');
  });

  it('a DETERMINISTIC proof does not satisfy the JUDGED security requirement', () => {
    const root = pkg();
    writeProof(root, {
      requirementId: 'SECURITY-INDEPENDENT',
      verificationType: VerificationType.DETERMINISTIC,
    });
    const status = acceptanceStatus({ root, repository: REPOSITORY });
    expect(status.requirements.find((r) => r.id === 'SECURITY-INDEPENDENT')?.state).toBe(
      AcceptanceState.NOT_VERIFIED,
    );
  });
});

/* ================================================== the catalogue, and the fail-first */

describe('the requirement catalogue is complete and the current tree does not satisfy it', () => {
  it('names every Phase 6 requirement the audit called missing', () => {
    const ids = new Set(REQUIREMENTS.map((r) => r.id));
    for (const required of [
      'EXT-HOST',
      'UX-NEW-PROJECT',
      'UX-CONVERSATION',
      'UX-OWNER-VALUE',
      'UX-RECONCILIATION',
      'MACHINE-BOOTSTRAP',
      'MIGRATE-WORKFLOW',
      'INSTALL-UPDATE',
      'RESTORE-FRESH',
      'BACKUP-IDENTITY',
      'VERSION-IDENTITY',
      'STATUS-BOUNDARY-SEMANTICS',
      'SECURITY-INDEPENDENT',
      'LIVE-ENGINEERING',
      'LIVE-SERVA',
      'PORTABILITY-FINAL',
    ]) {
      expect(ids.has(required), required + ' is not in the catalogue').toBe(true);
    }
  });

  it('every requirement is mandatory, so none can be dropped by exempting it quietly', () => {
    expect(REQUIREMENTS.every((r) => r.mandatory)).toBe(true);
  });

  it('an empty package proves nothing at all, and READY is not printed', () => {
    const status = acceptanceStatus({ root: pkg(), repository: REPOSITORY });
    expect(status.readyForOwnerUse).toBe(false);
    expect(status.rendered).not.toContain('READY FOR OWNER USE');
    expect(status.notProven.length).toBe(REQUIREMENTS.length);
    /* Every line, not merely the interesting ones. */
    expect(status.lines.every((l) => l.state === AcceptanceState.NOT_VERIFIED)).toBe(true);
  });

  it('one unproven mandatory requirement withholds READY', () => {
    const root = pkg();
    for (const r of REQUIREMENTS) {
      if (r.id === 'EXT-HOST') continue;
      /* Each kind carries what its kind requires; a LIVE proof needs a machine and a run. */
      writeProof(root, {
        requirementId: r.id,
        verificationType: r.expects,
        ...(r.expects === 'JUDGED'
          ? {
              producer: { kind: 'AGENT_RUN', id: 'SC-AGENT-200', runId: 'SC-RUN-000001' },
              reviewerRunRef: {
                runId: 'SC-RUN-000001',
                agentId: 'SC-AGENT-200',
                storePath: '.serva-self',
              },
            }
          : {}),
        ...(r.expects === 'LIVE'
          ? {
              machineFingerprint: 'f'.repeat(64),
              liveRunRef: {
                runId: 'SC-RUN-000009',
                agentId: 'SC-AGENT-150',
                storePath: '.serva-live',
              },
            }
          : {}),
        ...(r.expects === 'HUMAN' ? { producer: { kind: 'HUMAN', id: 'the owner' } } : {}),
      });
    }
    const status = acceptanceStatus({
      root,
      repository: REPOSITORY,
      resolveRun: () => ({ agentId: 'SC-AGENT-200', outcome: 'COMPLETED' }),
    });
    /*
     * TWO, and the second one is the point.
     *
     * EXT-HOST is unproven because this package deliberately omits its proof. The other four
     * are unproven because a synthetic package cannot FABRICATE them: each proof file is
     * present and perfectly formed, and what stands behind it — a security review, a governed
     * live chain, a verification run that actually passed — is re-derived from evidence that
     * does not exist here.
     *
     * Writing the file used to be enough for all four. That is what the writer-vs-resolver
     * sweep closed, and this count is the cheapest place to notice if it ever reopens.
     */
    expect(status.notProven).toHaveLength(5);
    for (const id of [
      'EXT-HOST',
      'SECURITY-INDEPENDENT',
      'LIVE-ENGINEERING',
      'LIVE-SERVA',
      'OFFLINE-VERIFICATION',
    ]) {
      expect(status.notProven.join(' '), id).toContain(id);
    }
    expect(status.readyForOwnerUse).toBe(false);
    expect(status.rendered).not.toContain('READY FOR OWNER USE');
  });

  it('every unproven requirement is reported with the reason it did not resolve', () => {
    const status = acceptanceStatus({ root: pkg(), repository: REPOSITORY });
    for (const entry of status.notProven) {
      expect(entry).toMatch(/\((NOT_VERIFIED|FAIL): .+\)/);
    }
  });
});

/* ============================ the resolver reads the store the store actually writes */

describe('defaultRunResolver resolves a run the Store really wrote', () => {
  /*
   * SPEC: Phase 6 closure §1.
   *
   * Two defects, both found by the canonical matrix refusing LIVE proofs whose chains the
   * live verifier had already resolved:
   *
   *   it read a `HEAD` file naming the current version — the Store has never written one, and
   *   `grep -rn "'HEAD'" src/store/store.ts` returns nothing;
   *
   *   it joined `root` with `ref.storePath` unconditionally, so an ABSOLUTE store path became
   *   `D:\SEVACODE\D:SEVACODEout…`. A live fixture lives outside the repository by design, so
   *   every live proof was unresolvable.
   *
   * Neither had a test. Both made a real governed run look like it had never happened, which is
   * the one direction this whole model must never fail in.
   */
  it('resolves a versioned record through an absolute store path', () => {
    const root = tempRoot();
    roots.push(root);
    const rt = ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root });
    try {
      const tx = rt.store.begin();
      tx.putCanon('agentRunRecord', 'SC-RUN-000042', {
        runId: 'SC-RUN-000042',
        agentId: 'SC-AGENT-220',
        outcome: 'COMPLETED',
      });
      tx.commit();
    } finally {
      rt.close();
    }

    /* An absolute path, as every live fixture records. */
    const resolved = defaultRunResolver(process.cwd())({
      runId: 'SC-RUN-000042',
      storePath: root,
    });

    expect(resolved, 'the run the Store just wrote did not resolve').toBeDefined();
    expect(resolved?.outcome).toBe('COMPLETED');
    expect(resolved?.agentId).toBe('SC-AGENT-220');
  });

  it('still resolves a store path relative to the package root', () => {
    /* The original supported shape must keep working. */
    const root = tempRoot();
    roots.push(root);
    const rt = ServaRuntime.init('RahalGo', 'idea', { root });
    try {
      const tx = rt.store.begin();
      tx.putCanon('agentRunRecord', 'SC-RUN-000043', {
        runId: 'SC-RUN-000043',
        agentId: 'SC-AGENT-200',
        outcome: 'COMPLETED',
      });
      tx.commit();
    } finally {
      rt.close();
    }
    const resolved = defaultRunResolver(root)({
      runId: 'SC-RUN-000043',
      storePath: '.',
    });
    expect(resolved?.outcome).toBe('COMPLETED');
  });

  it('a run that does not exist still resolves to nothing', () => {
    /* The fix must not make absence resolvable. */
    const root = tempRoot();
    roots.push(root);
    const rt = ServaRuntime.init('RahalGo', 'idea', { root });
    rt.close();
    expect(
      defaultRunResolver(process.cwd())({
        runId: 'SC-RUN-NEVER',
        storePath: root,
      }),
    ).toBeUndefined();
  });
});

/* ============ LIVE-ENGINEERING: a CONTAINED evidence violation is not disqualifying */

describe('LIVE-ENGINEERING accepts a contained EVIDENCE_VIOLATION, and nothing else does', () => {
  /*
   * SPEC: Phase 6 Producer evidence-violation semantics (locked).
   *
   * `liveProof.ts` already implements the locked rule — `PRODUCED_NOTHING` deliberately
   * excludes EVIDENCE_VIOLATION, and `assessProducerContainment` decides containment on
   * evidence. The generic `resolveProof` predated that and demanded COMPLETED, so the same
   * real run was accepted by the chain verifier and refused by the proof resolver.
   *
   * This is a CONSISTENCY REPAIR, not a relaxation. The exception is confined to
   * LIVE-ENGINEERING, containment is re-derived canonically rather than read from the
   * document, and every other terminal outcome stays refused.
   */
  const LIVE_RUN = { runId: 'SC-RUN-000002', agentId: 'SC-AGENT-150', storePath: '.serva-live' };

  function liveProof(root: string, over: Partial<AcceptanceProof> = {}): void {
    writeProof(root, {
      requirementId: 'LIVE-ENGINEERING',
      verificationType: VerificationType.LIVE,
      producer: { kind: 'TOOL', id: 'scripts/prove-live.mjs' },
      machineFingerprint: 'f'.repeat(64),
      liveRunRef: LIVE_RUN,
      ...over,
    });
  }

  /** Containment as the canonical assessor would report it. */
  const contained = () => ({ contained: true, producerOutcome: 'EVIDENCE_VIOLATION', reasons: [] });
  const uncontained = () => ({
    contained: false,
    producerOutcome: 'EVIDENCE_VIOLATION',
    reasons: ['acceptance evidence credits the Producer run'],
  });

  it('COMPLETED resolves exactly as before', () => {
    const root = pkg();
    liveProof(root);
    const resolved = resolveProof('LIVE-ENGINEERING', {
      root,
      repository: REPOSITORY,
      resolveRun: () => ({ agentId: 'SC-AGENT-150', outcome: 'COMPLETED' }),
      assessLiveChain: () => ({ refusals: [] }),
    });
    expect(resolved.status, resolved.refusals.join('; ')).toBe(ProofStatus.PASS);
  });

  it('a CONTAINED evidence violation resolves', () => {
    const root = pkg();
    liveProof(root);
    const resolved = resolveProof('LIVE-ENGINEERING', {
      root,
      repository: REPOSITORY,
      resolveRun: () => ({ agentId: 'SC-AGENT-150', outcome: 'EVIDENCE_VIOLATION' }),
      assessLiveChain: () => ({ refusals: [] }),
      assessContainment: contained,
    });
    expect(resolved.status, resolved.refusals.join('; ')).toBe(ProofStatus.PASS);
  });

  it('an UNCONTAINED evidence violation is refused', () => {
    const root = pkg();
    liveProof(root);
    const resolved = resolveProof('LIVE-ENGINEERING', {
      root,
      repository: REPOSITORY,
      resolveRun: () => ({ agentId: 'SC-AGENT-150', outcome: 'EVIDENCE_VIOLATION' }),
      assessLiveChain: () => ({ refusals: [] }),
      assessContainment: uncontained,
    });
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toContain('credits the Producer run');
  });

  it('an evidence violation with NO containment assessment available is refused', () => {
    /*
     * Rule 3: a naked claim in the document proves nothing. With no canonical assessor the
     * answer is NOT_VERIFIED, never a pass on the strength of the proof's own prose.
     */
    const root = pkg();
    liveProof(root);
    const resolved = resolveProof('LIVE-ENGINEERING', {
      root,
      repository: REPOSITORY,
      resolveRun: () => ({ agentId: 'SC-AGENT-150', outcome: 'EVIDENCE_VIOLATION' }),
    });
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toContain('containment');
  });

  it('a genuinely failed run is still refused, containment or not', () => {
    for (const outcome of ['FAILED', 'REFUSED', 'BLOCKED', 'SCOPE_VIOLATION', 'INVALID_OUTPUT']) {
      const root = pkg();
      liveProof(root);
      const resolved = resolveProof('LIVE-ENGINEERING', {
        root,
        repository: REPOSITORY,
        resolveRun: () => ({ agentId: 'SC-AGENT-150', outcome }),
        /* Even offered a contained verdict, a run that produced nothing stays refused. */
        assessContainment: contained,
      });
      expect(resolved.status, outcome + ' resolved').toBe(ProofStatus.NOT_VERIFIED);
      expect(resolved.refusals.join(' '), outcome).toContain(outcome);
    }
  });

  it('another LIVE requirement does NOT inherit the exception', () => {
    /* The exception is confined by requirement id, so LIVE-SERVA still demands COMPLETED. */
    const root = pkg();
    writeProof(root, {
      requirementId: 'LIVE-SERVA',
      verificationType: VerificationType.LIVE,
      producer: { kind: 'TOOL', id: 'scripts/prove-live.mjs' },
      machineFingerprint: 'f'.repeat(64),
      liveRunRef: LIVE_RUN,
    });
    const resolved = resolveProof('LIVE-SERVA', {
      root,
      repository: REPOSITORY,
      resolveRun: () => ({ agentId: 'SC-AGENT-150', outcome: 'EVIDENCE_VIOLATION' }),
      assessContainment: contained,
    });
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toContain('EVIDENCE_VIOLATION');
  });
});

/* ========= LIVE-ENGINEERING: an honest PARTIAL is not an unfinished change ========= */

describe('LIVE-ENGINEERING accepts a contained PARTIAL, and nothing else does', () => {
  /*
   * SPEC: Phase 6 LIVE-ENGINEERING PARTIAL semantics (locked).
   *
   * The Producer is denied `Bash` by design so that `SC-RTC-012` — "the one whose result a
   * Producer cannot assert" — is what verifies a change. A Producer that hits that boundary
   * and refuses to claim an unobserved test result ends PARTIAL. Refusing its acceptance would
   * punish exactly the behaviour the trust model exists to reward.
   *
   * The exception is confined the same way the EVIDENCE_VIOLATION one is, and for the same
   * reason: containment is re-derived canonically, never read from the proof.
   */
  const LIVE_RUN = { runId: 'SC-RUN-000002', agentId: 'SC-AGENT-150', storePath: '.serva-live' };

  function liveProof(root: string, requirementId = 'LIVE-ENGINEERING'): void {
    writeProof(root, {
      requirementId,
      verificationType: VerificationType.LIVE,
      producer: { kind: 'TOOL', id: 'scripts/prove-live.mjs' },
      machineFingerprint: 'f'.repeat(64),
      liveRunRef: LIVE_RUN,
    });
  }

  const blocked = () => ({ contained: true, producerOutcome: 'PARTIAL', reasons: [] });
  const unfinished = (why: string) => () => ({
    contained: false,
    producerOutcome: 'PARTIAL',
    reasons: [why],
  });

  function resolveWith(
    root: string,
    outcome: string,
    assessContainment?: () => { contained: boolean; producerOutcome: string; reasons: string[] },
    requirementId = 'LIVE-ENGINEERING',
  ) {
    return resolveProof(requirementId, {
      root,
      repository: REPOSITORY,
      resolveRun: () => ({ agentId: 'SC-AGENT-150', outcome }),
      /* The chain is re-derived separately; these tests are about the terminal outcome. */
      assessLiveChain: () => ({ refusals: [] }),
      ...(assessContainment === undefined ? {} : { assessContainment }),
    });
  }

  it('a contained VERIFICATION_BLOCKED PARTIAL resolves', () => {
    const root = pkg();
    liveProof(root);
    const resolved = resolveWith(root, 'PARTIAL', blocked);
    expect(resolved.status, resolved.refusals.join('; ')).toBe(ProofStatus.PASS);
  });

  it('a PARTIAL from unfinished implementation refuses', () => {
    const root = pkg();
    liveProof(root);
    const resolved = resolveWith(
      root,
      'PARTIAL',
      unfinished('the run records no file the Producer was allowed to change'),
    );
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toContain('no file');
  });

  it('a PARTIAL with no independent verification refuses', () => {
    const root = pkg();
    liveProof(root);
    const resolved = resolveWith(
      root,
      'PARTIAL',
      unfinished('no SC-RTC-012 measurement is bound to SC-CS-000001'),
    );
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toContain('SC-RTC-012');
  });

  it('a PARTIAL with a contradicted claim refuses', () => {
    const root = pkg();
    liveProof(root);
    const resolved = resolveWith(
      root,
      'PARTIAL',
      unfinished('1 Producer claim(s) were contradicted by the runtime'),
    );
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toContain('contradicted');
  });

  it('a PARTIAL with failing measured checks refuses', () => {
    const root = pkg();
    liveProof(root);
    const resolved = resolveWith(
      root,
      'PARTIAL',
      unfinished('independent measurement did not pass: SC-RTC-012 FAIL'),
    );
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toContain('FAIL');
  });

  it('a PARTIAL with no containment assessment available refuses', () => {
    const root = pkg();
    liveProof(root);
    const resolved = resolveWith(root, 'PARTIAL');
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toContain('containment is unproven');
  });

  it('a containment verdict for a DIFFERENT outcome cannot license this one', () => {
    /*
     * An assessor answering about EVIDENCE_VIOLATION is answering a different question. Left
     * unchecked, one outcome's containment would silently license another's.
     */
    const root = pkg();
    liveProof(root);
    const resolved = resolveWith(root, 'PARTIAL', () => ({
      contained: true,
      producerOutcome: 'EVIDENCE_VIOLATION',
      reasons: [],
    }));
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toContain('assessed for EVIDENCE_VIOLATION');
  });

  it('LIVE-SERVA does not inherit the PARTIAL exception', () => {
    const root = pkg();
    liveProof(root, 'LIVE-SERVA');
    const resolved = resolveWith(root, 'PARTIAL', blocked, 'LIVE-SERVA');
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toContain('PARTIAL');
  });

  it('other terminal outcomes stay refused even offered a contained verdict', () => {
    for (const outcome of ['FAILED', 'REFUSED', 'BLOCKED', 'ESCALATED', 'INVALID_OUTPUT']) {
      const root = pkg();
      liveProof(root);
      const resolved = resolveWith(root, outcome, blocked);
      expect(resolved.status, outcome).toBe(ProofStatus.NOT_VERIFIED);
      expect(resolved.refusals.join(' '), outcome).toContain(outcome);
    }
  });
});

/* ============ SSA-1: independence must hold on the path nobody passes options to ============ */

describe('the default readiness path enforces reviewer independence by itself', () => {
  /*
   * SPEC: Phase 6 final acceptance sequence §7; finding SSA-1 (HIGH).
   *
   * The independent security review found this, and it found it because every test that
   * existed passed `implementationProducers` explicitly. `resolveProof` refused a
   * non-independent reviewer only when that list arrived, `acceptanceStatus` never supplied
   * one, and so the guard gating READY FOR OWNER USE was inert on the only path anyone runs.
   *
   * A guard that works in tests and not in production is worse than no guard: it produces the
   * documentation and the confidence of a check without the check.
   *
   * So these tests call `acceptanceStatus` the way the CLI does — a root and nothing else.
   */
  function seedRun(
    store: ServaRuntime['store'],
    runId: string,
    agentId: string,
    roleInTask?: string,
  ): void {
    const tx = store.begin();
    tx.putCanon('agentRunRecord', runId, {
      runId,
      agentId,
      outcome: 'COMPLETED',
      ...(roleInTask === undefined ? {} : { roleInTask }),
      claimAssessments: [],
      evidenceRefs: [],
    });
    tx.commit();
  }

  function project(): ServaRuntime {
    const root = tempRoot();
    roots.push(root);
    return ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root });
  }

  function judgedProof(root: string, reviewerAgentId: string, storePath: string): void {
    writeProof(root, {
      requirementId: 'SECURITY-INDEPENDENT',
      verificationType: VerificationType.JUDGED,
      producer: { kind: 'TOOL', id: 'scripts/security-review.mjs' },
      reviewerRunRef: { runId: 'SC-RUN-REVIEW', agentId: reviewerAgentId, storePath },
    });
  }

  it('refuses a reviewer that produced the implementation, with no options passed', () => {
    const rt = project();
    /* Governed history says SC-AGENT-200 produced here, whatever its contract archetype is. */
    seedRun(rt.store, 'SC-RUN-PROD', 'SC-AGENT-200', 'PRODUCER');
    seedRun(rt.store, 'SC-RUN-REVIEW', 'SC-AGENT-200');
    judgedProof(rt.root, 'SC-AGENT-200', rt.root);

    const status = acceptanceStatus({ root: rt.root, repository: REPOSITORY });
    const req = status.requirements.find((r) => r.id === 'SECURITY-INDEPENDENT');
    expect(req?.state).not.toBe(AcceptanceState.PASS);
    expect(req?.resolution.refusals.join(' ')).toContain('produced');
  });

  it('accepts a genuinely independent verifier, with no options passed', () => {
    const rt = project();
    seedRun(rt.store, 'SC-RUN-PROD', 'SC-AGENT-150', 'PRODUCER');
    seedRun(rt.store, 'SC-RUN-REVIEW', 'SC-AGENT-220');
    judgedProof(rt.root, 'SC-AGENT-220', rt.root);

    const status = acceptanceStatus({ root: rt.root, repository: REPOSITORY });
    const req = status.requirements.find((r) => r.id === 'SECURITY-INDEPENDENT');
    /*
     * The proof still fails other checks in this synthetic package — what matters here is that
     * it is NOT refused for independence, which is the guard under test.
     */
    expect(req?.resolution.refusals.join(' ')).not.toContain('produced');
  });

  it('refuses a reviewer holding no verifier authority, with no options passed', () => {
    const rt = project();
    seedRun(rt.store, 'SC-RUN-REVIEW', 'SC-AGENT-150');
    judgedProof(rt.root, 'SC-AGENT-150', rt.root);

    const status = acceptanceStatus({ root: rt.root, repository: REPOSITORY });
    const req = status.requirements.find((r) => r.id === 'SECURITY-INDEPENDENT');
    expect(req?.state).not.toBe(AcceptanceState.PASS);
    expect(req?.resolution.refusals.join(' ')).toContain('authority');
  });
});

/* ====== SC-SSA-REV-F1: the findings clause is enforced by evidence, not by a field ====== */

describe('SECURITY-INDEPENDENT is decided by the review, not by the proof that cites it', () => {
  /*
   * SPEC: Phase 6 final acceptance sequence §7; HIGH finding
   * SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-REV-F1.
   *
   * The requirement text demands the reviewer "left no unresolved Critical or High finding".
   * `resolveProof` re-derived the reviewer run properly — COMPLETED, matching agent, not a
   * producer, holding verifier authority — and then took the verdict from the document:
   *
   *     status = proof.status !== PASS ? proof.status : (refusals.length === 0 ? PASS : ...)
   *
   * The findings-vs-verdict agreement and the no-unresolved-blocker check live in
   * `resolveSecurityReview` and `aggregateSecurityReview`, and `status.ts` called neither. So a
   * proof saying PASS, with a real completed SC-AGENT-220 run behind it, resolved green even
   * when that run had reported a CRITICAL.
   *
   * The only thing preventing that was a minting script choosing not to write the file — a
   * trustworthy writer guarding an untrustworthy resolver, which is the inversion this whole
   * model exists to prevent. It is also the defect that would have let me force 51/51 by hand
   * at any point in this phase.
   *
   * These tests hand-author the proof deliberately, because that is the attack.
   */
  const REVIEWER = 'SC-AGENT-220';
  const IMPLEMENTER = 'SC-AGENT-150';

  function project(): ServaRuntime {
    const root = tempRoot();
    roots.push(root);
    return ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root });
  }

  function seedRun(rt: ServaRuntime, runId: string, agentId: string, roleInTask?: string): void {
    const tx = rt.store.begin();
    tx.putCanon('agentRunRecord', runId, {
      runId,
      agentId,
      outcome: 'COMPLETED',
      ...(roleInTask === undefined ? {} : { roleInTask }),
    });
    tx.commit();
  }

  /** Every required unit, reviewed cleanly, unless `over` says otherwise for that unit. */
  function seedReview(
    rt: ServaRuntime,
    over: (unit: string) => Record<string, unknown> = () => ({}),
  ): void {
    let n = 0;
    for (const area of REQUIRED_SCOPE) {
      for (const { unit } of reviewUnitsFor(area)) {
        n += 1;
        const runId = 'SC-RUN-SR' + String(n).padStart(3, '0');
        seedRun(rt, runId, REVIEWER);
        recordScopeReview(rt.store, {
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
           * A unit that DECLARES context has not reviewed anything until that context reached
           * it, so a fixture describing a complete review has to show it arriving. Taken from
           * the scope map rather than written out, so declaring context somewhere new cannot
           * leave this fixture quietly describing a review that could not have happened.
           */
          contextRead: reviewUnitsFor(area)
            .find((u) => u.unit === unit)
            ?.context.map((prefix) => (prefix.endsWith('.ts') ? prefix : prefix + 'seen.ts')),
          contextOmitted: [],
          findings: [],
          verdict: ReviewVerdict.ACCEPTED,
          terminalOutcome: 'COMPLETED',
          reviewedAt: '2026-08-29T00:00:00.000Z',
          ...over(unit),
        });
      }
    }
  }

  /** A syntactically perfect SECURITY-INDEPENDENT proof claiming PASS. */
  function forgeProof(rt: ServaRuntime, reviewerAgentId = REVIEWER): void {
    writeProof(rt.root, {
      requirementId: 'SECURITY-INDEPENDENT',
      verificationType: VerificationType.JUDGED,
      status: ProofStatus.PASS,
      producer: { kind: 'TOOL', id: 'scripts/security-review.mjs' },
      reviewerRunRef: {
        runId: 'SC-RUN-SR001',
        agentId: reviewerAgentId,
        storePath: rt.root,
      },
    });
  }

  function stateOfSecurity(rt: ServaRuntime) {
    const status = acceptanceStatus({ root: rt.root, repository: REPOSITORY });
    return status.requirements.find((r) => r.id === 'SECURITY-INDEPENDENT');
  }

  const blocking = (severity: string) => (unit: string) =>
    unit === 'Owner authority'
      ? {
          verdict: ReviewVerdict.BLOCKED,
          findings: [
            {
              id: 'X-1',
              severity,
              area: unit,
              statement: 'a real problem the reviewer found',
              evidence: ['src/app/conversation.ts:1'],
              resolved: false,
            },
          ],
        }
      : {};

  it('1. a forged PASS over an unresolved HIGH is NOT_VERIFIED', () => {
    const rt = project();
    seedReview(rt, blocking('HIGH'));
    forgeProof(rt);
    const req = stateOfSecurity(rt);
    expect(req?.state).not.toBe(AcceptanceState.PASS);
    expect(req?.resolution.refusals.join(' ')).toMatch(/HIGH/);
  });

  it('2. a forged PASS over an unresolved CRITICAL is NOT_VERIFIED', () => {
    const rt = project();
    seedReview(rt, blocking('CRITICAL'));
    forgeProof(rt);
    const req = stateOfSecurity(rt);
    expect(req?.state).not.toBe(AcceptanceState.PASS);
    expect(req?.resolution.refusals.join(' ')).toMatch(/CRITICAL/);
  });

  it('3. a forged PASS over incomplete required scope is NOT_VERIFIED', () => {
    const rt = project();
    seedReview(rt, (unit) =>
      unit === 'migration'
        ? { coverage: ScopeCoverage.PARTIAL, filesOmitted: ['src/portability/migration.ts'] }
        : {},
    );
    forgeProof(rt);
    const req = stateOfSecurity(rt);
    expect(req?.state).not.toBe(AcceptanceState.PASS);
    expect(req?.resolution.refusals.join(' ')).toMatch(/migration|coverage/i);
  });

  it('4. a forged PASS over a NOT_VERIFIED scoped review is NOT_VERIFIED', () => {
    const rt = project();
    seedReview(rt, (unit) =>
      unit === 'Research trust' ? { verdict: ReviewVerdict.NOT_VERIFIED } : {},
    );
    forgeProof(rt);
    const req = stateOfSecurity(rt);
    expect(req?.state).not.toBe(AcceptanceState.PASS);
    expect(req?.resolution.refusals.join(' ')).toMatch(/Research trust|NOT_VERIFIED/);
  });

  it('5. a forged PASS over an EVIDENCE_VIOLATION scoped review is NOT_VERIFIED', () => {
    const rt = project();
    seedReview(rt, (unit) =>
      unit === 'AI Runtime'
        ? {
            terminalOutcome: 'EVIDENCE_VIOLATION',
            coverage: ScopeCoverage.NOT_REVIEWED,
            verdict: ReviewVerdict.NOT_VERIFIED,
          }
        : {},
    );
    forgeProof(rt);
    const req = stateOfSecurity(rt);
    expect(req?.state).not.toBe(AcceptanceState.PASS);
    expect(req?.resolution.refusals.join(' ')).toMatch(/AI Runtime|EVIDENCE_VIOLATION/);
  });

  it('6. a forged PASS naming a non-independent reviewer is NOT_VERIFIED', () => {
    const rt = project();
    seedReview(rt);
    /* Governed history says this agent produced here, so it cannot certify its own work. */
    seedRun(rt, 'SC-RUN-PROD', REVIEWER, 'PRODUCER');
    forgeProof(rt);
    const req = stateOfSecurity(rt);
    expect(req?.state).not.toBe(AcceptanceState.PASS);
    expect(req?.resolution.refusals.join(' ')).toMatch(/produced/i);
  });

  it('7. a genuine clean aggregate resolves', () => {
    const rt = project();
    seedReview(rt);
    seedRun(rt, 'SC-RUN-PROD', IMPLEMENTER, 'PRODUCER');
    forgeProof(rt);
    const req = stateOfSecurity(rt);
    expect(req?.state, req?.resolution.refusals.join('; ')).toBe(AcceptanceState.PASS);
  });

  it('8. editing the proof document cannot change the answer', () => {
    /*
     * The same store, judged twice: once with the document claiming PASS and once with it
     * claiming NOT_VERIFIED. Neither claim moves the result, because neither is consulted.
     */
    const rt = project();
    seedReview(rt, blocking('HIGH'));
    seedRun(rt, 'SC-RUN-PROD', IMPLEMENTER, 'PRODUCER');

    forgeProof(rt);
    expect(stateOfSecurity(rt)?.state).not.toBe(AcceptanceState.PASS);

    writeProof(rt.root, {
      requirementId: 'SECURITY-INDEPENDENT',
      verificationType: VerificationType.JUDGED,
      status: ProofStatus.NOT_VERIFIED,
      producer: { kind: 'TOOL', id: 'scripts/security-review.mjs' },
      reviewerRunRef: { runId: 'SC-RUN-SR001', agentId: REVIEWER, storePath: rt.root },
    });
    expect(stateOfSecurity(rt)?.state).not.toBe(AcceptanceState.PASS);

    /* And the clean store passes regardless of what the document had said. */
    const clean = project();
    seedReview(clean);
    seedRun(clean, 'SC-RUN-PROD', IMPLEMENTER, 'PRODUCER');
    forgeProof(clean);
    expect(stateOfSecurity(clean)?.state).toBe(AcceptanceState.PASS);
  });
});

/* ====== the bounded sweep: what stops a hand-authored PASS for the other types? ====== */

describe('a LIVE proof must resolve its whole chain, not just name a run', () => {
  /*
   * SPEC: Phase 6 bounded writer-vs-resolver sweep.
   *
   * Same class as SC-SSA-REV-F1, found by asking the same question of the other
   * acceptance-critical types. `prove-live.mjs` runs `resolveLiveEngineering` and refuses to
   * mint unless the entire chain holds — ChangeSet, measured evidence, independent authorised
   * reviewer, engineering gate, accepted commit that exists in git.
   *
   * `resolveProof`'s LIVE branch re-derived none of it. It checked that the named run resolved
   * and how it ended, and took everything else from the document. A hand-authored LIVE proof
   * naming any real COMPLETED run therefore resolved green, with no ChangeSet, no review and
   * no accepted commit anywhere.
   *
   * The writer was trustworthy and the resolver was not, which is the inversion this model
   * exists to prevent.
   */
  const LIVE_RUN = { runId: 'SC-RUN-000002', agentId: 'SC-AGENT-150', storePath: '.serva-live' };

  function liveProofFor(root: string, requirementId: string): void {
    writeProof(root, {
      requirementId,
      verificationType: VerificationType.LIVE,
      status: ProofStatus.PASS,
      producer: { kind: 'TOOL', id: 'scripts/prove-live.mjs' },
      machineFingerprint: 'f'.repeat(64),
      liveRunRef: LIVE_RUN,
    });
  }

  for (const requirementId of ['LIVE-ENGINEERING', 'LIVE-SERVA']) {
    it(requirementId + ': a real run with no chain behind it is refused', () => {
      const root = pkg();
      liveProofFor(root, requirementId);
      const resolved = resolveProof(requirementId, {
        root,
        repository: REPOSITORY,
        resolveRun: () => ({ agentId: 'SC-AGENT-150', outcome: 'COMPLETED' }),
        assessLiveChain: () => ({ refusals: ['no ChangeSet is bound to this producer run'] }),
      });
      expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
      expect(resolved.refusals.join(' ')).toContain('ChangeSet');
    });

    it(requirementId + ': with no chain assessment available it is refused', () => {
      const root = pkg();
      liveProofFor(root, requirementId);
      const resolved = resolveProof(requirementId, {
        root,
        repository: REPOSITORY,
        resolveRun: () => ({ agentId: 'SC-AGENT-150', outcome: 'COMPLETED' }),
      });
      expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
      expect(resolved.refusals.join(' ')).toMatch(/chain|could not be re-derived/i);
    });

    it(requirementId + ': a genuine chain resolves', () => {
      const root = pkg();
      liveProofFor(root, requirementId);
      const resolved = resolveProof(requirementId, {
        root,
        repository: REPOSITORY,
        resolveRun: () => ({ agentId: 'SC-AGENT-150', outcome: 'COMPLETED' }),
        assessLiveChain: () => ({ refusals: [] }),
      });
      expect(resolved.status, resolved.refusals.join('; ')).toBe(ProofStatus.PASS);
    });
  }
});

describe('OFFLINE-VERIFICATION must say the suite PASSED, not merely that it ran', () => {
  /*
   * SPEC: Phase 6 bounded writer-vs-resolver sweep.
   *
   * The proof cites `offline-verification.json` by content digest, so the file cannot be
   * altered after minting — and nothing ever read what it SAYS. A record of a run that exited
   * 1 with five hundred failures digests just as cleanly as a green one, and the claim that
   * the suite passed lived only in the proof's `notes`, which is prose.
   *
   * The digest proves the file is unmodified. It was never evidence that the file says the
   * tests passed.
   */
  function offlineProof(root: string, record: unknown): void {
    const rel = 'evidence/acceptance-run/offline-verification.json';
    const full = join(root, ...rel.split('/'));
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, JSON.stringify(record, null, 2), 'utf8');
    writeProof(root, {
      requirementId: 'OFFLINE-VERIFICATION',
      verificationType: VerificationType.DETERMINISTIC,
      status: ProofStatus.PASS,
      producer: { kind: 'TOOL', id: 'scripts/verify-evidence.mjs' },
      evidence: [
        { kind: 'FILE', id: rel, digest: fileDigest(full) as string, note: 'the run record' },
      ],
    });
  }

  /*
   * Every field the record SCHEMA requires, because `resolveProof` now resolves this record
   * through `resolveVerificationRecord` rather than reading a few fields off raw JSON. The
   * inline reader it replaced never parsed the schema, so these fixtures were half-records
   * that the resolver was never strict enough to notice.
   */
  const ran = (command: string, over: Record<string, unknown> = {}) => ({
    command,
    exitCode: 0,
    startedAt: '2026-08-24T00:00:00.000Z',
    endedAt: '2026-08-24T00:01:00.000Z',
    durationMs: 60_000,
    testsPassed: 1600,
    testsFailed: 0,
    ...over,
  });

  const green = {
    producedBy: 'scripts/verify.mjs',
    producedAt: '2026-08-24T00:00:00.000Z',
    implementationCommit: COMMIT,
    treeDigest: TREE,
    commands: [ran('npm run verify'), ran('npm run test:vscode', { testsPassed: 35 })],
  };

  it('refuses a record whose command exited non-zero', () => {
    const root = pkg();
    offlineProof(root, {
      ...green,
      commands: [ran('npm run verify', { exitCode: 1, testsPassed: 1200 })],
    });
    const resolved = resolveProof('OFFLINE-VERIFICATION', { root, repository: REPOSITORY });
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toMatch(/exited 1|exit/i);
  });

  it('refuses a record with failing tests', () => {
    const root = pkg();
    offlineProof(root, {
      ...green,
      commands: [ran('npm run verify', { testsPassed: 1200, testsFailed: 17 })],
    });
    const resolved = resolveProof('OFFLINE-VERIFICATION', { root, repository: REPOSITORY });
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toMatch(/17|fail/i);
  });

  it('refuses a record bound to a different commit', () => {
    const root = pkg();
    offlineProof(root, { ...green, implementationCommit: 'c'.repeat(40) });
    const resolved = resolveProof('OFFLINE-VERIFICATION', { root, repository: REPOSITORY });
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
  });

  it('refuses a record with no commands at all', () => {
    /* A verification that ran nothing verified nothing, however clean it looks. */
    const root = pkg();
    offlineProof(root, { ...green, commands: [] });
    const resolved = resolveProof('OFFLINE-VERIFICATION', { root, repository: REPOSITORY });
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
  });

  it('a genuinely green record resolves', () => {
    const root = pkg();
    offlineProof(root, green);
    const resolved = resolveProof('OFFLINE-VERIFICATION', { root, repository: REPOSITORY });
    expect(resolved.status, resolved.refusals.join('; ')).toBe(ProofStatus.PASS);
  });
});

/* ====== HIGH 3: requirement identity selects the resolver, exhaustively ====== */

describe('a LIVE requirement is resolved by ITS OWN canonical resolver', () => {
  /*
   * SPEC: HIGH finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-REV-LIVE-SERVA.
   *
   * I introduced this in the commit that fixed the same class elsewhere. The assessor takes
   * `requirementId`, and I wrote `return (ref) =>` — ignoring it — and called only
   * `resolveLiveEngineering`. `resolveLiveServa` was defined and wired nowhere.
   *
   * So LIVE-SERVA was gated identically to LIVE-ENGINEERING and its distinguishing content —
   * that an OWNER REQUEST entered the governed chain and caused the accepted work — went
   * unverified while gating READY FOR OWNER USE.
   *
   * The mapping is exhaustive rather than defaulted, because a permissive default is exactly
   * how this happened: a new LIVE requirement must fail loudly rather than inherit the
   * semantics of whichever resolver was written first.
   */
  it('LIVE_ASSESSORS covers every LIVE requirement in the catalogue', () => {
    /* The structural half: adding a LIVE requirement without a mapping fails here. */
    const liveRequirements = REQUIREMENTS.filter((r) => r.expects === VerificationType.LIVE).map(
      (r) => r.id,
    );
    expect(liveRequirements.length).toBeGreaterThan(0);
    for (const id of liveRequirements) {
      expect(Object.keys(LIVE_ASSESSORS), id + ' has no canonical resolver').toContain(id);
    }
  });

  it('each mapping names a distinct resolver, so one cannot stand in for the other', () => {
    expect(LIVE_ASSESSORS['LIVE-ENGINEERING']).not.toBe(LIVE_ASSESSORS['LIVE-SERVA']);
  });

  it('an unknown LIVE requirement refuses rather than defaulting', () => {
    const assess = defaultLiveChainAssessor();
    const verdict = assess({ runId: 'SC-RUN-000002', storePath: '.nope' }, 'LIVE-SOMETHING-NEW');
    expect(verdict).toBeDefined();
    expect(verdict?.refusals.join(' ')).toMatch(/no canonical live resolver/i);
  });

  it('LIVE-SERVA is refused when the store holds no owner request', () => {
    /*
     * The distinguishing condition, end to end. An engineering chain with no owner request in
     * front of it satisfies LIVE-ENGINEERING and must not satisfy LIVE-SERVA.
     */
    const root = pkg();
    writeProof(root, {
      requirementId: 'LIVE-SERVA',
      verificationType: VerificationType.LIVE,
      producer: { kind: 'TOOL', id: 'scripts/prove-live.mjs' },
      machineFingerprint: 'f'.repeat(64),
      liveRunRef: { runId: 'SC-RUN-000002', agentId: 'SC-AGENT-150', storePath: '.serva-live' },
    });
    const resolved = resolveProof('LIVE-SERVA', {
      root,
      repository: REPOSITORY,
      resolveRun: () => ({ agentId: 'SC-AGENT-150', outcome: 'COMPLETED' }),
      /* The engineering half is clean; the cross-phase half is what is missing. */
      assessLiveChain: (_ref, requirementId) =>
        requirementId === 'LIVE-SERVA'
          ? { refusals: ['no owner request caused this work'] }
          : { refusals: [] },
    });
    expect(resolved.status).toBe(ProofStatus.NOT_VERIFIED);
    expect(resolved.refusals.join(' ')).toContain('owner request');
  });

  it('the requirement id actually reaches the assessor', () => {
    /* The bug in one line: the parameter was declared and never read. */
    const seen: string[] = [];
    const root = pkg();
    writeProof(root, {
      requirementId: 'LIVE-SERVA',
      verificationType: VerificationType.LIVE,
      producer: { kind: 'TOOL', id: 'scripts/prove-live.mjs' },
      machineFingerprint: 'f'.repeat(64),
      liveRunRef: { runId: 'SC-RUN-000002', agentId: 'SC-AGENT-150', storePath: '.serva-live' },
    });
    resolveProof('LIVE-SERVA', {
      root,
      repository: REPOSITORY,
      resolveRun: () => ({ agentId: 'SC-AGENT-150', outcome: 'COMPLETED' }),
      assessLiveChain: (_ref, requirementId) => {
        seen.push(requirementId);
        return { refusals: [] };
      },
    });
    expect(seen).toEqual(['LIVE-SERVA']);
  });
});
