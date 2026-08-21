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

const ASSETS = [
  ['src/catalogue/generated/catalogues.json', 'dist/catalogue/generated/catalogues.json'],
  ['src/agents/generated/contracts.json', 'dist/agents/generated/contracts.json'],
];

let copied = 0;
for (const [from, to] of ASSETS) {
  const src = join(repoRoot, from);
  const dest = join(repoRoot, to);
  if (!existsSync(src)) {
    console.error('Missing build asset: ' + from + '\nRun `npm run generate` first.');
    process.exit(1);
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log('copied ' + from + ' -> ' + to);
  copied += 1;
}
console.log('assets copied: ' + copied);
