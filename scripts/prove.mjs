import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

/**
 * MINT ACCEPTANCE PROOFS FROM VERIFICATION THAT ACTUALLY RAN.
 *
 * SPEC: Phase 6 closure §1, §14, §16.
 *
 * A proof is written by the TOOL that performed the verification, never by hand. This is that
 * tool for the DETERMINISTIC line: it runs the offline suite, reads the machine-readable
 * result, and mints a proof for a requirement ONLY when every test file bound to it in
 * `REQUIREMENTS[].provenBy` ran and passed in that result.
 *
 * Three properties make the output worth something:
 *
 *   the requirement-to-test binding lives in `src/acceptance/requirements.ts`, which is
 *   written before the implementation and does not shrink to fit it, so a requirement nobody
 *   has tested has no `provenBy` and cannot be proven here at all;
 *
 *   the proof cites the run report AND every test file by content digest, so editing a test
 *   after the fact invalidates the proof rather than the test;
 *
 *   proofs are BUILD OUTPUT, not source. They bind to the current git tree and are
 *   regenerated whenever it changes. There is no state in which a stale proof survives a code
 *   change, because the tree digest it names is re-derived at resolution.
 *
 * What this cannot do is manufacture a JUDGED, LIVE or HUMAN proof. Those need a reviewer
 * run, a provider run on a named machine, or a person, and none of them can be produced by
 * running a test suite. That is why they are the lines which gate READY.
 */

const root = process.cwd();
const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const REPORT = 'evidence/acceptance-run/prove-offline-suite.json';

const { REQUIREMENTS } = await import('../dist/acceptance/requirements.js');
const { repositoryIdentity } = await import('../dist/acceptance/status.js');
const { PROOF_DIR, ProofStatus, VerificationType } = await import('../dist/acceptance/proof.js');

const repository = repositoryIdentity(root);
if (repository === undefined) {
  console.error('prove: no git identity. A proof minted here would bind to nothing. Refusing.');
  process.exit(1);
}

/**
 * REFUSE TO PROVE AN UNCOMMITTED TREE.
 *
 * A proof records the tree digest of HEAD. Minting one while source files differ from HEAD
 * would produce a document that binds to a tree the tests did not run against — the exact
 * failure the tree digest exists to prevent, committed by the tool that writes it.
 *
 * Build output is exempt because it is derived: `dist/` and `evidence/` are what this command
 * and `npm run build` produce, and requiring them to be committed first is circular.
 */
function uncommittedSource() {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return out
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter((p) => p !== '')
      .map((p) => p.replace(/^"|"$/g, '').replace(/\\/g, '/'))
      .filter((p) => !p.startsWith('dist/') && !p.startsWith('evidence/'));
  } catch {
    return ['(git status could not be read)'];
  }
}

const dirty = uncommittedSource();
if (dirty.length > 0) {
  /* No escape flag. One would let anybody mint a proof for a tree that was never tested. */
  console.error('prove: the working tree differs from HEAD, so a proof would bind to a tree the');
  console.error('       tests did not run against. Commit first, then prove:');
  for (const p of dirty.slice(0, 20)) console.error('         ' + p);
  process.exit(1);
}

const digest = (abs) => createHash('sha256').update(readFileSync(abs)).digest('hex');

/* --------------------------------------------------------------- run the offline suite */

const candidates = REQUIREMENTS.filter(
  (r) =>
    r.expects === VerificationType.DETERMINISTIC &&
    r.provenBy !== undefined &&
    r.provenBy.length > 0 &&
    (only.length === 0 || only.includes(r.id)),
);

if (candidates.length === 0) {
  console.error('prove: no requirement names tests to run.');
  process.exit(1);
}

const reportPath = join(root, ...REPORT.split('/'));
mkdirSync(join(reportPath, '..'), { recursive: true });
rmSync(reportPath, { force: true });

console.log(
  'prove: running the offline suite for ' + String(candidates.length) + ' requirement(s)',
);
try {
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules', 'vitest', 'vitest.mjs'),
      'run',
      '--reporter=json',
      '--outputFile=' + REPORT,
    ],
    { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], timeout: 30 * 60_000 },
  );
} catch {
  /* A failing suite still writes a report; the per-requirement check below reads it. */
}

if (!existsSync(reportPath)) {
  console.error('prove: the suite produced no machine-readable result. Nothing can be proven.');
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const suites = Array.isArray(report.testResults) ? report.testResults : [];

/*
 * The Extension Host suite runs in a real VS Code, so it cannot be part of the offline run.
 * Its result is merged here when it exists, in the same shape, which means a requirement can
 * name BOTH an offline test file and a host test file and be proven only when both passed.
 *
 * When it does not exist, nothing is merged and every requirement naming a host test reports
 * "did not run". That is the honest answer, and it is what makes `npm run test:vscode` a
 * prerequisite for those rows rather than a suggestion.
 */
const HOST_REPORT = 'evidence/acceptance-run/extension-host.json';
const hostPath = join(root, ...HOST_REPORT.split('/'));
let hostReportCited = false;
if (existsSync(hostPath)) {
  try {
    const host = JSON.parse(readFileSync(hostPath, 'utf8'));
    if (Array.isArray(host.testResults)) {
      suites.push(...host.testResults);
      hostReportCited = true;
    }
  } catch {
    console.error('prove: the Extension Host result could not be read; treating it as absent.');
  }
}

/**
 * Did every test in this file pass, in THIS run?
 *
 * `ran: false` means the file is not in the report at all, which is not a pass. A binding
 * naming a test file nobody ran must never mint a proof, so the absent case is answered
 * separately from the failing case rather than folded into one falsy.
 */
function fileOutcome(rel) {
  const abs = resolvePath(root, rel);
  const suite = suites.find((s) => resolvePath(root, s.name ?? '') === abs);
  if (suite === undefined) return { ran: false, passed: false, total: 0, failed: 0 };
  const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
  const failed = assertions.filter((a) => a.status !== 'passed' && a.status !== 'skipped').length;
  const executed = assertions.filter((a) => a.status === 'passed').length;
  return {
    ran: true,
    passed: suite.status === 'passed' && failed === 0 && executed > 0,
    total: assertions.length,
    failed,
  };
}

/* ------------------------------------------------------------------------ mint or refuse */

const producedAt = new Date().toISOString();
const proofDir = join(root, ...PROOF_DIR.split('/'));
mkdirSync(proofDir, { recursive: true });

let minted = 0;
const refused = [];

for (const r of candidates) {
  const path = join(proofDir, r.id + '.json');
  const outcomes = r.provenBy.map((f) => ({ file: f, ...fileOutcome(f) }));
  const bad = outcomes.filter((o) => !o.passed);

  if (bad.length > 0) {
    /*
     * No proof, and no FAIL proof either: a requirement whose tests did not pass is simply
     * unproven, and the matrix reports NOT_VERIFIED with the reason. Removing a stale proof
     * matters more than writing a new one, because otherwise yesterday's green survives
     * today's red.
     */
    rmSync(path, { force: true });
    refused.push(
      r.id +
        ' - ' +
        bad
          .map((o) =>
            o.ran ? o.file + ' had ' + String(o.failed) + ' failing' : o.file + ' did not run',
          )
          .join('; '),
    );
    continue;
  }

  const usesHost = r.provenBy.some((f) => f.replace(/\\/g, '/').startsWith('tests/vscode/'));
  const evidence = [
    { kind: 'FILE', id: REPORT, digest: digest(reportPath), note: 'the offline suite result' },
    ...(usesHost && hostReportCited
      ? [
          {
            kind: 'FILE',
            id: HOST_REPORT,
            digest: digest(hostPath),
            note: 'the Extension Host suite result',
          },
        ]
      : []),
    ...r.provenBy.map((f) => ({
      kind: 'FILE',
      id: f,
      digest: digest(resolvePath(root, f)),
      note: String(outcomes.find((o) => o.file === f).total) + ' assertions, all passing',
    })),
    { kind: 'COMMIT', id: repository.commit },
  ];

  writeFileSync(
    path,
    JSON.stringify(
      {
        requirementId: r.id,
        verificationType: VerificationType.DETERMINISTIC,
        status: ProofStatus.PASS,
        implementationCommit: repository.commit,
        treeDigest: repository.tree,
        producedAt,
        producer: { kind: 'TOOL', id: 'scripts/prove.mjs' },
        scope: r.requirement,
        evidence,
        notes: [
          'Minted from a suite run on this tree. The proof cites the run report and every ' +
            'test file by content digest; editing either invalidates the proof.',
        ],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  minted += 1;
}

console.log(
  'prove: minted ' +
    String(minted) +
    ' deterministic proof(s) at ' +
    repository.commit.slice(0, 12),
);
for (const line of refused) console.log('  refused: ' + line);

/* ------------------------------------------------- the verification record, if there is one */

/*
 * OFFLINE-VERIFICATION is not proved by a test passing; it is proved by the VERIFICATION
 * COMMANDS having run and passed at this exact tree. That is a different kind of fact, so it
 * has its own resolver and its own minting path rather than a `provenBy` binding that would
 * quietly mean something else.
 */
const { resolveVerificationRecord, RECORD_PATH } =
  await import('../dist/acceptance/verificationRecord.js');
const verification = resolveVerificationRecord({
  root,
  repository,
  required: ['npm run verify', 'npm run test:vscode'],
});

const offlinePath = join(proofDir, 'OFFLINE-VERIFICATION.json');
if (verification.resolved) {
  const recordFile = join(root, ...RECORD_PATH.split('/'));
  writeFileSync(
    offlinePath,
    JSON.stringify(
      {
        requirementId: 'OFFLINE-VERIFICATION',
        verificationType: VerificationType.DETERMINISTIC,
        status: ProofStatus.PASS,
        implementationCommit: repository.commit,
        treeDigest: repository.tree,
        producedAt,
        producer: { kind: 'TOOL', id: 'scripts/prove.mjs' },
        scope: 'Every verification command ran and passed at this exact commit and tree.',
        evidence: [
          { kind: 'FILE', id: RECORD_PATH, digest: digest(recordFile), note: 'the run record' },
          ...(verification.record?.commands ?? [])
            .filter((c) => c.reportPath !== undefined && c.reportDigest !== undefined)
            .map((c) => ({
              kind: 'FILE',
              id: c.reportPath,
              digest: c.reportDigest,
              note: c.command + ': ' + String(c.testsPassed) + ' passed',
            })),
          { kind: 'COMMIT', id: repository.commit },
        ],
        notes: (verification.record?.commands ?? []).map(
          (c) =>
            c.command +
            ' exited ' +
            String(c.exitCode) +
            (c.testsPassed === undefined
              ? ''
              : ' with ' +
                String(c.testsPassed) +
                ' passing, ' +
                String(c.testsFailed) +
                ' failing'),
        ),
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  minted += 1;
  console.log('prove: minted OFFLINE-VERIFICATION from the recorded verification run');
} else {
  rmSync(offlinePath, { force: true });
  console.log('prove: OFFLINE-VERIFICATION stays NOT_VERIFIED — ' + verification.refusals[0]);
}

const unbound = REQUIREMENTS.filter(
  (r) =>
    r.expects === VerificationType.DETERMINISTIC &&
    (r.provenBy === undefined || r.provenBy.length === 0),
);
if (unbound.length > 0) {
  console.log(
    'prove: ' +
      String(unbound.length) +
      ' deterministic requirement(s) name no test and stay NOT_VERIFIED: ' +
      unbound.map((r) => r.id).join(', '),
  );
}
if (refused.length > 0) process.exitCode = 1;
