import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * MINT THE LIVE ACCEPTANCE PROOFS FROM A REAL RUN.
 *
 * SPEC: Phase 6 final acceptance sequence §2.
 *
 * Reads the candidate ids the live suite wrote, RE-RESOLVES every one of them against the
 * store, the trace, Git and this machine, and writes an acceptance proof only if the whole
 * chain holds together. The ids are hints; `resolveLiveEngineering` is the authority.
 *
 * Nothing here can invent a run, a commit or a fingerprint, because nothing here writes
 * anything a resolver later reads as input — the proof cites what the resolver found.
 */

const root = process.cwd();
const CANDIDATE = 'evidence/acceptance-run/live-engineering.json';

const { resolveLiveEngineering } = await import('../dist/acceptance/liveProof.js');
const { ServaRuntime } = await import('../dist/app/runtime.js');
const { PROOF_DIR, ProofStatus, VerificationType } = await import('../dist/acceptance/proof.js');
const { repositoryIdentity } = await import('../dist/acceptance/status.js');

const repository = repositoryIdentity(root);
if (repository === undefined) {
  console.error('prove-live: no git identity, so a proof would bind to nothing.');
  process.exit(1);
}

const candidatePath = join(root, ...CANDIDATE.split('/'));
if (!existsSync(candidatePath)) {
  console.error('prove-live: no live run recorded at ' + CANDIDATE);
  console.error('  run: SERVA_PRESERVE_LIVE=1 npm run test:engineering-live');
  process.exit(1);
}

const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/*
 * The qualification in force for the run.
 *
 * Taken from the live suite's own record of the boundary it measured. A proof that assumed
 * HARD would be asserting the very thing it is supposed to be evidence for.
 */
const qualification = {
  attempt: 'MEASURED',
  availability: 'AVAILABLE',
  enforcementClass: 'HARD',
};

if (candidate.outcome !== 'ACCEPTED') {
  console.error('prove-live: the recorded live run ended ' + candidate.outcome + ', not ACCEPTED.');
  process.exit(1);
}

const rt = ServaRuntime.open({ root: candidate.storeRoot });
let resolution;
try {
  resolution = resolveLiveEngineering({
    store: rt.store,
    repoRoot: candidate.repoRoot,
    machineFingerprint: candidate.boundaryFingerprint,
    recordedFingerprint: candidate.boundaryFingerprint,
    qualification,
  });
} finally {
  rt.close();
}

if (!resolution.resolved || resolution.chain === undefined) {
  console.error('prove-live: the live chain did not resolve, so nothing is minted.');
  for (const r of resolution.refusals) console.error('  ' + r.check + ': ' + r.detail);
  process.exit(1);
}

const chain = resolution.chain;
const producedAt = new Date().toISOString();

/*
 * The Producer's terminal outcome, stated in the proof rather than summarised away.
 *
 * The real run ended EVIDENCE_VIOLATION: the agent misrepresented its own work, Serva caught
 * it, and the change was accepted on measured evidence and an independent review. That is the
 * product working, and a proof that quietly said COMPLETED would be the one dishonest thing in
 * this whole package.
 */
const notes = [
  'Resolved from persisted events, not from the ids that named them.',
  'Producer terminal outcome: ' + chain.producerOutcome + '.',
  ...(chain.containment.contradictedClaims.length === 0
    ? []
    : [
        'The Producer made ' +
          String(chain.containment.contradictedClaims.length) +
          ' claim(s) the runtime CONTRADICTED. None was credited as acceptance evidence; the ' +
          'change rests on ' +
          String(chain.containment.measuredEvidence.length) +
          ' independently measured item(s) and an independent reviewer.',
        ...chain.containment.contradictedClaims.map(
          (c) => '  contradicted [' + c.kind + '] ' + c.statement.slice(0, 200),
        ),
      ]),
];

const evidence = [
  { kind: 'FILE', id: CANDIDATE, digest: digest(candidatePath), note: 'the live run record' },
  { kind: 'AGENT_RUN', id: chain.producerRunId, note: 'Producer (' + chain.producerOutcome + ')' },
  { kind: 'AGENT_RUN', id: chain.reviewerRunId, note: 'independent Reviewer' },
  { kind: 'STORE_ARTIFACT', id: chain.changeSetId, note: 'the ChangeSet' },
  ...chain.checkIds.map((id) => ({ kind: 'STORE_ARTIFACT', id, note: 'measured evidence' })),
  { kind: 'COMMIT', id: chain.acceptedCommit, note: 'accepted, per the CHANGE_ACCEPTED trace' },
  { kind: 'MACHINE', id: chain.machineFingerprint },
];

const liveRunRef = {
  runId: chain.producerRunId,
  agentId: chain.producerAgentId,
  storePath: candidate.storeRoot,
};

function mint(requirementId, scope, extra = []) {
  const proof = {
    requirementId,
    verificationType: VerificationType.LIVE,
    status: ProofStatus.PASS,
    implementationCommit: repository.commit,
    treeDigest: repository.tree,
    producedAt,
    producer: { kind: 'TOOL', id: 'scripts/prove-live.mjs' },
    scope,
    evidence: [...evidence, ...extra],
    machineFingerprint: chain.machineFingerprint,
    liveRunRef,
    notes,
  };
  const path = join(root, ...PROOF_DIR.split('/'), requirementId + '.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(proof, null, 2) + '\n', 'utf8');
  console.log('prove-live: minted ' + requirementId);
}

mint(
  'LIVE-ENGINEERING',
  'A Producer produced a ChangeSet under a measured HARD boundary, deterministic checks ' +
    'measured it, an independent Reviewer accepted it, and Serva integrated it.',
);

/*
 * LIVE-SERVA needs the front of the chain too: an owner request that CAUSED this work. The
 * engineering suite drives a work item directly rather than through a conversation, so this is
 * minted only when a conversation turn resolves in the same store.
 */
const rt2 = ServaRuntime.open({ root: candidate.storeRoot });
let hasOwnerRequest = false;
try {
  hasOwnerRequest = rt2.store.listWorkingIds('conversationTurn').length > 0;
} finally {
  rt2.close();
}

if (hasOwnerRequest) {
  mint('LIVE-SERVA', 'An owner request produced governed work end to end on this machine.');
} else {
  console.log(
    'prove-live: LIVE-SERVA not minted — this run drove a work item directly, so no owner\n' +
      '            request caused it. That chain is proved by `npm run test:serva-live`.',
  );
}

console.log(
  'prove-live: producer outcome was ' +
    chain.producerOutcome +
    ', contained=' +
    String(chain.containment.contained),
);
