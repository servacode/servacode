import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Mocha from 'mocha';

/**
 * THE EXTENSION HOST SUITE'S ENTRY POINT.
 *
 * SPEC: Phase 6 closure §8.
 *
 * VS Code loads this inside a real Extension Host, with a real `vscode` module, a real
 * webview and a real window. Everything the ordinary suite proves about the renderer, the
 * protocol and the action registry is proved without any of that — deliberately, because
 * logic that can only be tested by launching an editor is logic that in practice is not
 * tested at all.
 *
 * What only this can prove is that the parts MEET. An independent audit was right to insist
 * on it: `extension/package.json` pointed `main` at `./dist/extension.js` while the compiler
 * emitted `./dist/extension/src/extension.js`, so the extension could never have activated on
 * any machine — and the entire unit suite was green. A test that never loads the thing cannot
 * discover that the thing does not load.
 *
 * The result is written as a machine-readable report that `scripts/prove.mjs` reads. A
 * requirement bound to a file in this directory cannot be proven from the offline suite
 * alone: if this never ran, the prover reports "did not run", which is the honest answer.
 */

const REPORT = 'evidence/acceptance-run/extension-host.json';
const here = dirname(fileURLToPath(import.meta.url));

interface Recorded {
  readonly file: string;
  readonly title: string;
  readonly passed: boolean;
  readonly error?: string;
}

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', color: false, timeout: 120_000 });

  const files = readdirSync(here)
    .filter((f) => f.endsWith('.host.test.js'))
    .sort()
    .map((f) => join(here, f));

  const recorded: Recorded[] = [];

  /*
   * `SERVA_REPO_ROOT` is set by the launcher. Deriving it from this file's position would
   * break the moment the output directory moved, and a report written to the wrong place is
   * indistinguishable from one never written.
   */
  const repoRoot = process.env['SERVA_REPO_ROOT'] ?? resolve(here, '..', '..', '..');

  const writeReport = (): void => {
    const byFile = new Map<string, Recorded[]>();
    for (const entry of recorded) {
      const list = byFile.get(entry.file) ?? [];
      list.push(entry);
      byFile.set(entry.file, list);
    }

    const path = join(repoRoot, ...REPORT.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        {
          producedBy: 'tests/vscode, in a real VS Code Extension Host',
          numTotalTests: recorded.length,
          numFailedTests: recorded.filter((r) => !r.passed).length,
          testResults: [...byFile.entries()].map(([file, entries]) => ({
            name: file,
            status: entries.every((e) => e.passed) ? 'passed' : 'failed',
            assertionResults: entries.map((e) => ({
              title: e.title,
              status: e.passed ? 'passed' : 'failed',
              ...(e.error === undefined ? {} : { failureMessages: [e.error] }),
            })),
          })),
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  };

  /*
   * The compiled tests are ES modules, because everything they import is. Mocha loads `.js`
   * with `require`, which fails on the first `import` statement — so they are imported here,
   * after `pre-require` has installed `describe` and `it` as globals. This is the documented
   * way to run ESM suites against a programmatic Mocha instance.
   */
  for (const file of files) {
    mocha.suite.emit('pre-require', globalThis, file, mocha);
    await import(pathToFileURL(file).href);
  }

  await new Promise<void>((resolveRun, rejectRun) => {
    const runner = mocha.run((failures) => {
      /*
       * The report is written whether the suite passed or failed, and the prover reads the
       * per-test outcomes rather than this count. A report that only appeared on success
       * would make "did not run" and "ran and failed" indistinguishable, which is the
       * distinction the whole acceptance model rests on.
       */
      writeReport();
      if (failures > 0) rejectRun(new Error(String(failures) + ' Extension Host test(s) failed'));
      else resolveRun();
    });

    const sourceOf = (test: Mocha.Runnable): string => {
      const name = (test.file ?? '').split(/[\\/]/).pop() ?? 'unknown.js';
      return 'tests/vscode/' + name.replace(/\.js$/, '.ts');
    };
    runner.on('pass', (test) => {
      recorded.push({ file: sourceOf(test), title: test.fullTitle(), passed: true });
    });
    runner.on('fail', (test, error) => {
      recorded.push({
        file: sourceOf(test),
        title: typeof test.fullTitle === 'function' ? test.fullTitle() : String(test.title),
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}
