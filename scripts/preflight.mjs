import { execSync } from 'node:child_process';

/**
 * THE CHEAP CHECK BEFORE THE EXPENSIVE ONE.
 *
 * SPEC: Phase 6 architectural stabilisation, part D.
 *
 * Several final-acceptance cycles ended the same way: 22 model calls, forty minutes, and a
 * finding that was a sibling of one already fixed. The independent review is worth what it
 * costs — it found every defect in this phase — but it should not be the thing that discovers
 * a class we already know how to test for.
 *
 * So this runs the deterministic suites that encode the classes the review has already taught
 * us, and it runs them first:
 *
 *   guest reach semantics          a transport failure is not a measurement
 *   vacuous safety                 an empty collection is not proof of anything
 *   owner authority                `state === 'ANSWERED'` is not an owner
 *   reviewer authority             a different agent is not an independent one
 *   curator and assessor authority a caller-supplied name is not a role
 *   verdict authority              a verdict with nothing behind it is not a pass
 *   finding resolution             a resolution is bound to an implementation
 *   writer vs resolver             what the writer enforces, the resolver re-derives
 *   requirement-specific resolvers LIVE-SERVA is not LIVE-ENGINEERING
 *   stale evidence                 a proof binds to a commit and a tree
 *   cross-project leakage          paths, secrets and client names do not travel
 *
 * It is NOT a substitute for SECURITY-INDEPENDENT, and nothing here mints anything. It is a
 * way to be wrong cheaply.
 */

const SUITES = [
  {
    file: 'tests/security.invariant.test.ts',
    covers:
      'authority from governed evidence, guest reach, owner authority, verdict families, ' +
      'declared safeguards',
  },
  {
    file: 'tests/acceptance.test.ts',
    covers:
      'writer-vs-resolver equivalence, requirement-specific LIVE resolvers, stale commit/tree',
  },
  {
    file: 'tests/securityaggregate.test.ts',
    covers: 'review attempt and finding-resolution authority',
  },
  { file: 'tests/securityreview.test.ts', covers: 'reviewer identity, scope coverage, durability' },
  { file: 'tests/reviewauthority.test.ts', covers: 'reviewer independence derived canonically' },
  { file: 'tests/securityscope.test.ts', covers: 'scoped review evidence survives process exit' },
  { file: 'tests/liveproof.test.ts', covers: 'live chain resolution and producer containment' },
  { file: 'tests/substrate.transport.test.ts', covers: 'transport failure is never a measurement' },
  {
    file: 'tests/eng.substrate.test.ts',
    covers: 'qualification derives HARD from what it observed',
  },
  { file: 'tests/install.test.ts', covers: 'rollback refuses when it cannot show nothing is lost' },
  { file: 'tests/intel.invariants.test.ts', covers: 'cross-project leakage' },
  { file: 'tests/library.test.ts', covers: 'the last wall before knowledge leaves a project' },
  { file: 'tests/intel.governance.test.ts', covers: 'curator and assessor authority' },
];

console.log('preflight: ' + String(SUITES.length) + ' deterministic suites over known classes');
console.log('');

const started = Date.now();
let failed = 0;

for (const suite of SUITES) {
  process.stdout.write('  ' + suite.file.padEnd(42));
  try {
    execSync('npx vitest run ' + suite.file + ' --reporter=dot', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10 * 60_000,
    });
    console.log('ok    ' + suite.covers);
  } catch {
    failed += 1;
    console.log('FAIL  ' + suite.covers);
  }
}

console.log('');
console.log(
  'preflight: ' +
    (failed === 0 ? 'clean' : String(failed) + ' suite(s) failed') +
    ' in ' +
    String(Math.round((Date.now() - started) / 1000)) +
    's',
);

if (failed > 0) {
  console.error('');
  console.error('  Fix these before spending a live or security sequence. They encode classes');
  console.error('  the independent review has already found once.');
  process.exitCode = 1;
}
