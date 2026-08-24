#!/usr/bin/env node
/**
 * Copy non-TypeScript runtime assets into dist/.
 *
 * `tsc` emits only compiled TypeScript. The generated canonical catalogues are
 * JSON data the runtime loads at startup, so a build without them produces a
 * package that fails on first use.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * EVERY OUTPUT DIRECTORY THAT CONTAINS COMPILED `src/` NEEDS THESE.
 *
 * The extension compiles its own copy of `src/` into `extension/dist/`, and that build was
 * missing the catalogues entirely. It failed the only way this class of defect ever fails:
 * silently at build time, and at ACTIVATION on a real machine, with every unit test green.
 * The Extension Host suite found it in its first run.
 *
 * Listing both destinations here, rather than teaching each build to remember, means a third
 * output directory added later fails loudly in one place instead of at somebody's first use.
 */
const SOURCES = ['src/catalogue/generated/catalogues.json', 'src/agents/generated/contracts.json'];

const OUTPUTS = [
  /* The CLI and library build: `tsc -p tsconfig.build.json` with rootDir `src`. */
  { dir: 'dist', strip: 'src/' },
  /* The extension build: rootDir is the repository, so `src/` is preserved in the output. */
  { dir: 'extension/dist', strip: '' },
  /* The Extension Host suite, which compiles its own copy of `src/` the same way. */
  { dir: 'out/vscode-test', strip: '' },
];

const ASSETS = OUTPUTS.flatMap(({ dir, strip }) =>
  SOURCES.map((from) => [from, dir + '/' + (strip === '' ? from : from.slice(strip.length))]),
);

let copied = 0;
for (const [from, to] of ASSETS) {
  const src = join(repoRoot, from);
  const dest = join(repoRoot, to);
  if (!existsSync(src)) {
    console.error('Missing build asset: ' + from + '\nRun `npm run generate` first.');
    process.exit(1);
  }
  /*
   * A destination whose compiled output is not there yet is skipped rather than created. A
   * lone JSON file in an empty directory would make a broken build look like a complete one.
   */
  const buildDir = to.startsWith('extension/dist')
    ? 'extension/dist'
    : to.startsWith('out/vscode-test')
      ? 'out/vscode-test'
      : 'dist';
  if (!existsSync(join(repoRoot, buildDir))) {
    console.log('skipped ' + to + ' (that build has not run)');
    continue;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log('copied ' + from + ' -> ' + to);
  copied += 1;
}
console.log('assets copied: ' + copied);
