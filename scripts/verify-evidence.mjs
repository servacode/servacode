import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * RUN THE VERIFICATION, AND RECORD WHAT IT ACTUALLY DID.
 *
 * SPEC: Phase 6 final acceptance sequence §4.
 *
 * "I ran the tests and they passed" is a sentence, and a pasted transcript is a longer one.
 * This produces the machine-readable alternative: for each command, the exact text run, the
 * exit code, the test counts taken from the runner's own report, the digest of that report,
 * and the commit and tree it all happened against.
 *
 * The failure it exists to prevent is easy and quiet: run the suite, edit some source, mint
 * the proof afterwards. The tree digest makes that impossible, which is why this refuses to
 * run at all on a working tree that differs from HEAD.
 */

const root = process.cwd();
const RECORD = 'evidence/acceptance-run/offline-verification.json';

function git(args) {
  try {
    return execSync('git ' + args, { cwd: root, encoding: 'utf8', timeout: 30_000 }).trim();
  } catch {
    return undefined;
  }
}

const commit = git('rev-parse HEAD');
const tree = git('rev-parse HEAD^{tree}');
if (commit === undefined || tree === undefined) {
  console.error('verify-evidence: no git identity, so nothing would bind this record to a tree.');
  process.exit(1);
}

/*
 * A record describing a tree that is not the one on disk is worse than no record: it looks
 * like evidence and describes something else. `dist/` and `evidence/` are derived and exempt.
 */
const dirty = (git('status --porcelain') ?? '')
  .split('\n')
  .map((l) => l.slice(3).trim())
  .filter((p) => p !== '')
  .map((p) => p.replace(/^"|"$/g, '').replace(/\\/g, '/'))
  .filter((p) => !p.startsWith('dist/') && !p.startsWith('evidence/') && !p.startsWith('out/'));

if (dirty.length > 0) {
  console.error('verify-evidence: the working tree differs from HEAD. Commit first:');
  for (const p of dirty.slice(0, 20)) console.error('  ' + p);
  process.exit(1);
}

/**
 * The commands whose success IS the offline verification.
 *
 * `npm run verify` is the whole deterministic gate — format, lint, typecheck, the offline
 * suite, the build. `npm run test:vscode` is the Extension Host suite, which cannot run
 * inside the first one because it launches a real editor.
 */
const COMMANDS = [
  { command: 'npm run verify', report: 'evidence/acceptance-run/offline-suite.json' },
  { command: 'npm run test:vscode', report: 'evidence/acceptance-run/extension-host.json' },
];

const digestOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Test counts, read from the runner's own report rather than scraped from its output. */
function countsFrom(reportPath) {
  const full = join(root, ...reportPath.split('/'));
  if (!existsSync(full)) return {};
  try {
    const report = JSON.parse(readFileSync(full, 'utf8'));
    const suites = Array.isArray(report.testResults) ? report.testResults : [];
    const assertions = suites.flatMap((s) =>
      Array.isArray(s.assertionResults) ? s.assertionResults : [],
    );
    return {
      testsPassed: assertions.filter((a) => a.status === 'passed').length,
      testsFailed: assertions.filter((a) => a.status !== 'passed' && a.status !== 'skipped').length,
      testFiles: suites.length,
      reportPath,
      reportDigest: digestOf(full),
    };
  } catch {
    return {};
  }
}

const commands = [];
for (const { command, report } of COMMANDS) {
  console.log('verify-evidence: ' + command);
  const startedAt = new Date().toISOString();
  const began = Date.now();
  let exitCode = 0;
  try {
    execSync(command, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], timeout: 60 * 60_000 });
  } catch (e) {
    exitCode = typeof e?.status === 'number' ? e.status : 1;
  }
  const endedAt = new Date().toISOString();

  commands.push({
    command,
    exitCode,
    startedAt,
    endedAt,
    durationMs: Date.now() - began,
    ...countsFrom(report),
  });
}

const record = {
  producedBy: 'scripts/verify-evidence.mjs',
  implementationCommit: commit,
  treeDigest: tree,
  producedAt: new Date().toISOString(),
  commands,
};

const path = join(root, ...RECORD.split('/'));
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, JSON.stringify(record, null, 2) + '\n', 'utf8');

console.log('');
console.log('verify-evidence: recorded at ' + commit.slice(0, 12) + ' / tree ' + tree.slice(0, 12));
for (const c of commands) {
  console.log(
    '  ' +
      (c.exitCode === 0 ? ' ok ' : 'FAIL') +
      '  ' +
      c.command.padEnd(24) +
      (c.testsPassed === undefined
        ? ''
        : String(c.testsPassed) + ' passed, ' + String(c.testsFailed) + ' failed'),
  );
}

if (commands.some((c) => c.exitCode !== 0)) process.exitCode = 1;
