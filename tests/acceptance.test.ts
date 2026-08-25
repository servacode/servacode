import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AcceptanceState, acceptanceStatus, defaultRunResolver } from '../src/acceptance/status.js';
import {
  PROOF_DIR,
  ProofStatus,
  VerificationType,
  fileDigest,
  resolveProof,
} from '../src/acceptance/proof.js';
import { REQUIREMENTS } from '../src/acceptance/requirements.js';
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
    expect(status.notProven).toHaveLength(1);
    expect(status.notProven[0]).toContain('EXT-HOST');
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
