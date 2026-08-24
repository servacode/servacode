import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECORD_PATH, resolveVerificationRecord } from '../src/acceptance/verificationRecord.js';
import { cleanup, tempRoot } from './helpers.js';
import type { RepositoryIdentity } from '../src/acceptance/proof.js';

/**
 * A TRANSCRIPT IS NOT A VERIFICATION.
 *
 * SPEC: Phase 6 final acceptance sequence §4.
 *
 * The quiet failure this guards is: run the suite, edit some source, mint the proof
 * afterwards. Nothing about that looks wrong in a log, so the record binds to the git TREE and
 * the resolver re-checks it against the repository as it is now.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) cleanup(r);
});

const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const REPOSITORY: RepositoryIdentity = { commit: COMMIT, tree: TREE };
const REQUIRED = ['npm run verify', 'npm run test:vscode'];

function pkg(record?: unknown, reports: Record<string, string> = {}): string {
  const root = tempRoot();
  roots.push(root);
  for (const [rel, content] of Object.entries(reports)) {
    const path = join(root, ...rel.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  if (record !== undefined) {
    const path = join(root, ...RECORD_PATH.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(record, null, 2), 'utf8');
  }
  return root;
}

function command(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: 'npm run verify',
    exitCode: 0,
    startedAt: '2026-08-24T00:00:00.000Z',
    endedAt: '2026-08-24T00:05:00.000Z',
    durationMs: 300_000,
    testsPassed: 1300,
    testsFailed: 0,
    testFiles: 61,
    ...over,
  };
}

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    producedBy: 'scripts/verify-evidence.mjs',
    implementationCommit: COMMIT,
    treeDigest: TREE,
    producedAt: '2026-08-24T00:05:00.000Z',
    commands: [command(), command({ command: 'npm run test:vscode', testsPassed: 35 })],
    ...over,
  };
}

const resolve = (root: string) =>
  resolveVerificationRecord({ root, repository: REPOSITORY, required: REQUIRED });

describe('a verification record resolves against the repository, or it does not', () => {
  it('an honest record for this tree resolves', () => {
    const result = resolve(pkg(record()));
    expect(result.resolved, result.refusals.join('; ')).toBe(true);
  });

  it('no record at all is not a pass', () => {
    const result = resolve(pkg());
    expect(result.resolved).toBe(false);
    expect(result.refusals.join(' ')).toContain('no verification record');
  });

  it('a record for a different commit does not describe this package', () => {
    const result = resolve(pkg(record({ implementationCommit: 'c'.repeat(40) })));
    expect(result.refusals.join(' ')).toContain('describes commit');
  });

  it('a record made before the source changed fails on the tree', () => {
    /*
     * The failure this whole record exists to catch. The commit is a label and the tree is
     * the content, so checking only the commit would let a record survive every change that
     * does not create a new one — which is every change made while working.
     */
    const result = resolve(pkg(record({ treeDigest: 'd'.repeat(40) })));
    expect(result.refusals.join(' ')).toContain('something changed after the commands ran');
  });

  it('a command that was never run is not a command that passed', () => {
    const result = resolve(pkg(record({ commands: [command()] })));
    expect(result.refusals.join(' ')).toContain('`npm run test:vscode` was not run');
  });

  it('a non-zero exit is a failure however green the counts look', () => {
    const result = resolve(
      pkg(
        record({
          commands: [command({ exitCode: 1 }), command({ command: 'npm run test:vscode' })],
        }),
      ),
    );
    expect(result.refusals.join(' ')).toContain('exited 1');
  });

  it('failing tests are a failure', () => {
    const result = resolve(
      pkg(
        record({
          commands: [command({ testsFailed: 2 }), command({ command: 'npm run test:vscode' })],
        }),
      ),
    );
    expect(result.refusals.join(' ')).toContain('2 failing test(s)');
  });

  it('a command reporting no passing tests verified nothing', () => {
    /* Ran nothing, or lost its report. Both mean the same thing here. */
    const result = resolve(
      pkg(
        record({
          commands: [command({ testsPassed: 0 }), command({ command: 'npm run test:vscode' })],
        }),
      ),
    );
    expect(result.refusals.join(' ')).toContain('nothing was verified');
  });

  it('with no repository identity, nothing binds and nothing passes', () => {
    const result = resolveVerificationRecord({
      root: pkg(record()),
      required: REQUIRED,
    });
    expect(result.resolved).toBe(false);
    expect(result.refusals.join(' ')).toContain('nothing binds this record to a tree');
  });

  it('a malformed record is refused rather than partially believed', () => {
    const result = resolve(pkg({ producedBy: 'somebody', commands: [] }));
    expect(result.resolved).toBe(false);
    expect(result.refusals.join(' ')).toContain('malformed');
  });

  it('a report edited after the run no longer matches its digest', () => {
    const reportPath = 'evidence/acceptance-run/offline-suite.json';
    const original = '{"testResults":[]}';
    const digest = createHash('sha256').update(original).digest('hex');
    const root = pkg(
      record({
        commands: [
          command({ reportPath, reportDigest: digest }),
          command({ command: 'npm run test:vscode' }),
        ],
      }),
      { [reportPath]: '{"testResults":[],"edited":true}' },
    );
    expect(resolve(root).refusals.join(' ')).toContain('does not match its recorded digest');
  });

  it('a report the record cites but the package does not hold is refused', () => {
    const result = resolve(
      pkg(
        record({
          commands: [
            command({ reportPath: 'evidence/nowhere.json', reportDigest: 'e'.repeat(64) }),
            command({ command: 'npm run test:vscode' }),
          ],
        }),
      ),
    );
    expect(result.refusals.join(' ')).toContain('is not in this package');
  });

  it('reports every refusal, so an author can tell a stale record from a wrong one', () => {
    const result = resolve(
      pkg(record({ implementationCommit: 'c'.repeat(40), treeDigest: 'd'.repeat(40) })),
    );
    expect(result.refusals.length).toBeGreaterThanOrEqual(2);
  });
});
