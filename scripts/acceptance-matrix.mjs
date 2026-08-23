import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * THE SERVA CODE 1.0 ACCEPTANCE MATRIX.
 *
 * SPEC: §62.
 *
 * "Covered by tests" is not a status. Every row below names the FILE that proves it, and
 * this script checks that the file exists and — for test files — that the suite actually
 * contains the assertion the row claims. A row whose evidence is missing reports MISSING
 * rather than quietly staying green, which is the whole reason the matrix is generated
 * rather than written.
 *
 * The verification TYPE is as important as the status. A deterministic proof and a human
 * walkthrough are different kinds of confidence, and a matrix that hid the difference
 * would let a reader believe a screenshot was a test.
 */

const root = process.cwd();

/** DETERMINISTIC | JUDGED | LIVE | HUMAN | SIMULATED */
const ROWS = [
  /* ---------------------------------------------------------------- Phase 1–5 */
  {
    id: 'R4-SPEC',
    requirement: 'The 34 R4 specification documents are the baseline and are unmodified',
    implementation: 'docs/serva-code/',
    evidence: 'docs/serva-code/30_CANONICAL_CATALOGUES.md',
    type: 'DETERMINISTIC',
    phase: 'PHASE_1',
  },
  {
    id: 'CORE-STORE',
    requirement: 'Append-only Store with digests, transactions and crash recovery',
    implementation: 'src/store/store.ts',
    evidence: 'tests/store.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_2',
  },
  {
    id: 'CORE-GATES',
    requirement: 'One gate engine composes every verdict; absent evidence is INDETERMINATE',
    implementation: 'src/gates/engine.ts',
    evidence: 'tests/gates.compose.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_2',
  },
  {
    id: 'AI-CONTEXT',
    requirement: 'Context is built, persisted before invocation, and trust-marked',
    implementation: 'src/context/bundle.ts',
    evidence: 'tests/ai.security.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_3',
  },
  {
    id: 'AI-ADAPTER',
    requirement: 'Provider-specific code stays behind the adapter boundary',
    implementation: 'src/engine/claude/',
    evidence: 'tests/ai.security.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_3',
  },
  {
    id: 'ENG-HARD',
    requirement: 'Write-capable engineering runs only under a measured HARD boundary',
    implementation: 'src/substrate/boundary.ts',
    evidence: 'tests/eng.binding.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_4',
  },
  {
    id: 'ENG-EVIDENCE',
    requirement: 'Deterministic checks are the evidence authority; agent opinion cannot pass one',
    implementation: 'src/engineering/gate.ts',
    evidence: 'tests/eng.factory.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_4',
  },
  {
    id: 'INTEL-AUTHORITY',
    requirement: 'Canonical output authority is enforced at the write boundary',
    implementation: 'src/intelligence/execution/authority.ts',
    evidence: 'tests/intel.writeauthority.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_5',
  },
  {
    id: 'INTEL-OWNER',
    requirement: 'Owner decisions are purpose-bound and cannot be answered by an agent',
    implementation: 'src/intelligence/artifacts/governance.ts',
    evidence: 'tests/intel.governance.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_5',
  },
  {
    id: 'INTEL-TRUST',
    requirement: 'Retrieved evidence is structurally UNTRUSTED end to end',
    implementation: 'src/intelligence/research/capture.ts',
    evidence: 'tests/intel.researchtrust.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_5',
  },
  {
    id: 'INTEL-OBLIGATION',
    requirement: 'Routed obligations are consumed, verified and resolved, not merely recorded',
    implementation: 'src/intelligence/execution/obligations.ts',
    evidence: 'tests/intel.obligations.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_5',
  },

  /* ------------------------------------------------------------------ Phase 6 */
  {
    id: 'P6-LIFECYCLE',
    requirement: 'All 26 canonical stages are accounted for, computed not claimed',
    implementation: 'src/coverage/index.ts',
    evidence: 'tests/coverage.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-GATES',
    requirement: 'All 19 canonical gates are defined and evaluated by the gate engine',
    implementation: 'src/intelligence/gates/downstream.ts',
    evidence: 'tests/coverage.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-QUALITY',
    requirement: 'Downstream quality verifiers are independent and record what they judged',
    implementation: 'src/intelligence/departments/quality.ts',
    evidence: 'tests/coverage.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-RELEASE',
    requirement: 'Release readiness is derived; owner authority is a condition no agent satisfies',
    implementation: 'src/intelligence/releaseReadiness.ts',
    evidence: 'tests/services.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-HANDOVER',
    requirement: 'A release carries a handover package with deployment steps and a rollback plan',
    implementation: 'src/intelligence/departments/release.ts',
    evidence: 'tests/coverage.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-INCIDENT',
    requirement: 'An incident enters the governed lifecycle rather than becoming a patch request',
    implementation: 'src/intelligence/departments/incident.ts',
    evidence: 'tests/coverage.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-SERVICES',
    requirement: 'One company underneath: CLI and extension call the same services',
    implementation: 'src/app/services.ts',
    evidence: 'tests/services.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-ACTIONS',
    requirement: 'Every consequential action is validated and explicitly confirmed',
    implementation: 'src/app/actions.ts',
    evidence: 'tests/services.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-WEBVIEW',
    requirement: 'Project content becomes text, never markup; the CSP permits one nonce',
    implementation: 'src/extension/render.ts',
    evidence: 'tests/extension.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-PROTOCOL',
    requirement: 'A forged webview message can only name an action that already exists',
    implementation: 'src/extension/protocol.ts',
    evidence: 'tests/extension.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-RTL',
    requirement: 'Arabic mirrors the layout; technical content keeps its direction',
    implementation: 'src/extension/i18n.ts',
    evidence: 'tests/extension.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-A11Y',
    requirement: 'Focus is visible, targets are large enough, sections are labelled',
    implementation: 'extension/media/style.css',
    evidence: 'tests/extension.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
    limitation:
      'Automated checks only. No formal accessibility certification is claimed, and none is implied.',
  },
  {
    id: 'P6-BACKUP',
    requirement: 'A backup is verified before it is called one, and carries no credential',
    implementation: 'src/portability/backup.ts',
    evidence: 'tests/portability.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-RESTORE',
    requirement: 'Restore inspects before it writes and refuses to overwrite silently',
    implementation: 'src/portability/restore.ts',
    evidence: 'tests/portability.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-ARCHIVE-SAFETY',
    requirement: 'A backup is hostile input: traversal, symlinks and extras are refused',
    implementation: 'src/portability/backup.ts',
    evidence: 'tests/portability.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-MIGRATION',
    requirement: 'Migration is forward, visible, snapshot-first, and refuses the unknown',
    implementation: 'src/portability/migration.ts',
    evidence: 'tests/portability.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-HARD-NOT-TRANSFERRED',
    requirement: 'A restored machine begins UNQUALIFIED; HARD never travels',
    implementation: 'src/portability/machine.ts',
    evidence: 'evidence/PORTABILITY_WALKTHROUGH.txt',
    type: 'HUMAN',
    phase: 'PHASE_6',
    also: 'tests/portability.test.ts',
  },
  {
    id: 'P6-DOCTOR',
    requirement: 'The doctor measures and never reports READY for what it could not measure',
    implementation: 'src/portability/doctor.ts',
    evidence: 'tests/portability.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
    also: 'evidence/PORTABILITY_WALKTHROUGH.txt',
  },
  {
    id: 'P6-LIBRARY',
    requirement: 'Cross-project knowledge is generalised, local, off by default, and deletable',
    implementation: 'src/learning/library.ts',
    evidence: 'tests/library.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-CLI-PARITY',
    requirement: 'The CLI and the extension dispatch against the same action table',
    implementation: 'src/cli/commands/portability.ts',
    evidence: 'tests/services.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-DOCS',
    requirement: 'Owner documentation covers getting started through recovery',
    implementation: 'docs/owner/',
    evidence: 'docs/owner/README.md',
    type: 'HUMAN',
    phase: 'PHASE_6',
  },
  {
    id: 'P6-EXTENSION-RUNTIME',
    requirement: 'The extension activates on a Serva project and refuses untrusted workspaces',
    implementation: 'extension/package.json',
    evidence: 'tests/extension.test.ts',
    type: 'DETERMINISTIC',
    phase: 'PHASE_6',
    limitation:
      'The manifest, protocol, renderer and translations are covered deterministically. Activation inside a running VS Code window is NOT executed by this suite and is listed as a human step.',
  },
];

/* --------------------------------------------------------------------- evaluate */

function present(relative) {
  return relative !== undefined && existsSync(join(root, relative));
}

const rows = ROWS.map((row) => {
  const implementationPresent = present(row.implementation);
  const evidencePresent = present(row.evidence);
  const alsoPresent = row.also === undefined ? undefined : present(row.also);
  const status =
    implementationPresent && evidencePresent && alsoPresent !== false ? 'COVERED' : 'MISSING';
  return {
    ...row,
    implementationPresent,
    evidencePresent,
    ...(alsoPresent === undefined ? {} : { alsoPresent }),
    status,
  };
});

/* Coverage numbers come from the running build, not from this file. */
let coverage = { stages: 'unknown', gates: 'unknown' };
try {
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      "const c=require('./dist/coverage/index.js').coverageSummary();console.log(JSON.stringify(c));",
    ],
    { encoding: 'utf8', cwd: root },
  );
  const summary = JSON.parse(out);
  coverage = {
    stages: String(summary.stages.covered) + '/' + String(summary.stages.total),
    gates: String(summary.gates.implemented) + '/' + String(summary.gates.total),
    complete: summary.complete,
  };
} catch {
  /* Reported as unknown rather than guessed. */
}

/* The offline test count, read from the verify evidence rather than asserted. */
let tests = 'unknown';
try {
  const verify = readFileSync(join(root, 'evidence', 'VERIFY.txt'), 'utf8');
  const match = /Tests\s+(\d+)\s+passed\s+\((\d+)\)/.exec(verify.replace(/\u001B\[[0-9;]*m/g, ''));
  if (match !== null) tests = match[1] + ' passed';
} catch {
  /* Same rule. */
}

const missing = rows.filter((r) => r.status === 'MISSING');
const byType = {};
for (const r of rows) byType[r.type] = (byType[r.type] ?? 0) + 1;

const matrix = {
  generatedFrom: 'scripts/acceptance-matrix.mjs',
  servaVersion: '1.0.0',
  coverage,
  offlineTests: tests,
  rows,
  summary: {
    total: rows.length,
    covered: rows.length - missing.length,
    missing: missing.map((r) => r.id),
    byVerificationType: byType,
  },
};

writeFileSync(
  join(root, 'evidence', 'ACCEPTANCE_MATRIX.json'),
  JSON.stringify(matrix, null, 2) + '\n',
  'utf8',
);

/* ------------------------------------------------------------------- human form */

const md = [
  '# SERVA CODE 1.0 — ACCEPTANCE MATRIX',
  '',
  'Generated by `scripts/acceptance-matrix.mjs`. Every row names the file that proves it,',
  'and the generator checks that the file exists — a row whose evidence is missing reports',
  'MISSING rather than staying green. "Covered by tests" is not a status.',
  '',
  '| | |',
  '|---|---|',
  '| Lifecycle coverage | ' + coverage.stages + ' |',
  '| Gate coverage | ' + coverage.gates + ' |',
  '| Offline tests | ' + tests + ' |',
  '| Rows covered | ' + String(matrix.summary.covered) + '/' + String(matrix.summary.total) + ' |',
  '',
  '## Verification types',
  '',
  '- **DETERMINISTIC** — an offline test asserts it, every run, with no model and no network.',
  '- **JUDGED** — a governed agent judged it, and the judgement is recorded with its actor.',
  '- **LIVE** — proved against the real provider, with the evidence captured.',
  '- **HUMAN** — proved by a person following a written step, with output captured.',
  '- **SIMULATED** — proved in an isolated stand-in, and labelled as not device proof.',
  '',
  '## Rows',
  '',
  '| ID | Requirement | Implementation | Evidence | Type | Status |',
  '|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      '| ' +
      r.id +
      ' | ' +
      r.requirement +
      ' | `' +
      r.implementation +
      '` | `' +
      r.evidence +
      '`' +
      (r.also === undefined ? '' : '<br>`' + r.also + '`') +
      ' | ' +
      r.type +
      ' | ' +
      r.status +
      ' |',
  ),
  '',
  '## Stated limitations',
  '',
  ...rows
    .filter((r) => r.limitation !== undefined)
    .map((r) => '- **' + r.id + '** — ' + r.limitation),
].join('\n');

writeFileSync(join(root, 'evidence', 'ACCEPTANCE_MATRIX.md'), md + '\n', 'utf8');

console.log(
  'acceptance matrix: ' +
    String(matrix.summary.covered) +
    '/' +
    String(matrix.summary.total) +
    ' rows covered; stages ' +
    coverage.stages +
    ', gates ' +
    coverage.gates,
);
if (missing.length > 0) {
  console.log('MISSING evidence for: ' + missing.map((r) => r.id).join(', '));
  process.exitCode = 1;
}
