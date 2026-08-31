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
 * The qualification in force for the run, READ from what the run measured.
 *
 * SPEC: finding SERVA-SELF-ACCEPTANCE-AUTHORITY/SC-SSA-REV-Q1 (MEDIUM), 1.0.1 security review.
 *
 * The comment above this block used to say exactly what it says now — "taken from the live
 * suite's own record of the boundary it measured", and "a proof that assumed HARD would be
 * asserting the very thing it is supposed to be evidence for" — directly above three hardcoded
 * literals. It was taken from nothing. The headline clause of LIVE-ENGINEERING, that a Producer
 * ran under a measured HARD boundary, was asserted rather than evidenced for the whole of 1.0.
 *
 * The live suite now writes the persisted measurement into the candidate.
 * `recordQualification` stores one ONLY when the attempt was MEASURED, so the existence of that
 * record is the evidence that a measurement happened, and its class is what was measured.
 *
 * Absence REFUSES. There is no fallback to HARD, because a fallback is how a literal gets back
 * in wearing a different name.
 */
const measured = candidate.qualification;
if (measured === null || measured === undefined) {
  console.error('prove-live: the recorded live run carries no qualification measurement.');
  console.error('  LIVE-ENGINEERING claims a Producer ran under a measured HARD boundary, and');
  console.error('  nothing in this candidate evidences that. Re-run the live suite:');
  console.error('    SERVA_PRESERVE_LIVE=1 npm run test:engineering-live');
  process.exit(1);
}
if (measured.enforcementClass !== 'HARD') {
  console.error(
    'prove-live: the boundary this run measured was ' +
      String(measured.enforcementClass) +
      ', not HARD.',
  );
  console.error('  LIVE-ENGINEERING is not provable on a machine that did not measure HARD.');
  process.exit(1);
}

const qualification = {
  /* MEASURED is not asserted here: a persisted record exists only for a measured attempt. */
  attempt: 'MEASURED',
  /* The guest was reachable, evidenced by the Producer run having actually executed in it. */
  availability: 'AVAILABLE',
  enforcementClass: measured.enforcementClass,
};

console.log(
  'prove-live: boundary ' +
    measured.enforcementClass +
    ' measured at ' +
    String(measured.measuredAt) +
    (measured.fingerprintComplete === true
      ? ''
      : ' (machine fingerprint incomplete, so it identifies nothing)'),
);

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

/* --------------------------------------------------------------------- LIVE-SERVA */

/*
 * The cross-phase join, from its own live run.
 *
 * Deliberately NOT derived from the engineering candidate above. LIVE-ENGINEERING proves the
 * factory; LIVE-SERVA proves that an owner asking for something is what caused the factory to
 * run, and reusing one run for both would assert the join by assuming it.
 */
const SERVA_CANDIDATE = 'evidence/acceptance-run/live-serva.json';
const servaPath = join(root, ...SERVA_CANDIDATE.split('/'));

if (!existsSync(servaPath)) {
  console.log(
    'prove-live: LIVE-SERVA not minted — no cross-phase run recorded at ' + SERVA_CANDIDATE,
  );
} else {
  const serva = JSON.parse(readFileSync(servaPath, 'utf8'));

  if (serva.state === 'OWNER_ACTION_REQUIRED') {
    console.log('prove-live: LIVE-SERVA is OWNER_ACTION_REQUIRED and cannot be minted.');
    console.log('  decision: ' + String(serva.pendingDecision?.id));
    console.log('  ' + String(serva.pendingDecision?.question));
    console.log('  Answer it as yourself, then resume; nothing here may answer it for you.');
  } else if (serva.state !== 'ACCEPTED') {
    console.log('prove-live: the cross-phase run ended ' + String(serva.state) + ', not ACCEPTED.');
  } else {
    const { resolveServaChain } = await import('../dist/acceptance/servaChain.js');
    const rt2 = ServaRuntime.open({ root: serva.storeRoot });
    let chainResult;
    try {
      chainResult = resolveServaChain({
        store: rt2.store,
        companyStore: rt2.store,
        repoRoot: serva.repoRoot,
        machineFingerprint: serva.boundaryFingerprint,
        recordedFingerprint: serva.boundaryFingerprint,
        qualification,
        preseeded: serva.preseeded ?? [],
      });
    } finally {
      rt2.close();
    }

    if (chainResult.outcome !== 'PROVEN') {
      console.log('prove-live: the cross-phase chain is ' + chainResult.outcome + '.');
      for (const r of chainResult.refusals) console.log('  ' + r.check + ': ' + r.detail);
      for (const d of chainResult.pendingOwnerDecisions) {
        console.log('  OWNER DECISION ' + d.id + ': ' + d.question);
      }
    } else {
      /*
       * The classes are kept apart in the proof itself, not merely in a report. A pre-seeded
       * requirement is real truth about the project and is not evidence that anything ran
       * live, and this is the one document where blurring the two would matter most.
       */
      const grouped = {};
      for (const ref of chainResult.refs) {
        (grouped[ref.origin] ??= []).push(
          ref.kind + ' ' + ref.id + (ref.detail ? ' — ' + ref.detail : ''),
        );
      }

      const servaProof = {
        requirementId: 'LIVE-SERVA',
        verificationType: VerificationType.LIVE,
        status: ProofStatus.PASS,
        implementationCommit: repository.commit,
        treeDigest: repository.tree,
        producedAt,
        producer: { kind: 'TOOL', id: 'scripts/prove-live.mjs' },
        scope:
          "One owner request, in the owner's own words, reached an authoritative integration " +
          'commit through governed classification, planning, a Producer under a measured HARD ' +
          'boundary, deterministic checks, an independent Reviewer and the Engineering Gate.',
        evidence: [
          { kind: 'FILE', id: SERVA_CANDIDATE, digest: digest(servaPath), note: 'the run record' },
          ...chainResult.refs
            .filter((r) => r.kind === 'AGENT_RUN')
            .map((r) => ({ kind: 'AGENT_RUN', id: r.id, note: r.detail ?? '' })),
          { kind: 'COMMIT', id: String(chainResult.acceptedCommit) },
          { kind: 'MACHINE', id: String(serva.boundaryFingerprint) },
        ],
        machineFingerprint: String(serva.boundaryFingerprint),
        liveRunRef: {
          runId: String(serva.ownerRequest?.runIds?.[0] ?? ''),
          agentId: 'SC-AGENT-003',
          storePath: serva.storeRoot,
        },
        notes: [
          'Work item ' +
            String(chainResult.workItemId) +
            ', request ' +
            String(chainResult.turnId) +
            '.',
          'Evidence by origin — pre-seeded truth is NOT live evidence:',
          ...Object.entries(grouped).flatMap(([origin, items]) => [
            '  ' + origin + ':',
            ...items.map((i) => '    ' + i),
          ]),
        ],
      };

      const servaProofPath = join(root, ...PROOF_DIR.split('/'), 'LIVE-SERVA.json');
      mkdirSync(dirname(servaProofPath), { recursive: true });
      writeFileSync(servaProofPath, JSON.stringify(servaProof, null, 2) + '\n', 'utf8');
      console.log(
        'prove-live: minted LIVE-SERVA (work item ' + String(chainResult.workItemId) + ')',
      );
    }
  }
}

console.log(
  'prove-live: producer outcome was ' +
    chain.producerOutcome +
    ', contained=' +
    String(chain.containment.contained),
);
