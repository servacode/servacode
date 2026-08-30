import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileDigest } from '../dist/acceptance/proof.js';

/**
 * WHAT AN OWNER DOWNLOADED, AND WHETHER IT IS WHAT WAS BUILT.
 *
 * SPEC: Phase 6 closure §11; the 1.0.1 packaging audit, section I.
 *
 * Serva is delivered as files an owner copies to their own machine, and a file that has been
 * truncated, resumed badly, or altered in transit installs exactly as convincingly as one that
 * has not. Until there is something to check an artifact AGAINST, "I downloaded Serva" and "I
 * downloaded something called Serva" are the same sentence.
 *
 * So this writes one manifest naming every artifact in the release, its size, and its SHA-256.
 *
 * `fileDigest` comes from `src/acceptance/proof.ts` — the function the acceptance machinery
 * already uses to decide whether a file is the file it was proven against. Hashing is one line
 * and writing a second copy of it here would be easy; it would also mean a release could be
 * verified by an implementation that acceptance had never exercised. One hasher, used by both.
 *
 * Nothing here signs anything. A hash proves an artifact was not damaged or swapped between
 * the build and the machine; it is not a signature and this file does not pretend otherwise.
 */

const repoRoot = process.cwd();
const releaseDir = join(repoRoot, 'release');
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const version = manifest.version;

/* Named rather than globbed: a release is a stated set, and a missing artifact must be an
   error rather than a shorter manifest that still looks complete. */
const expected = [
  { file: 'serva-code-' + version + '.tgz', what: 'the Serva Code runtime and CLI' },
  { file: 'serva-code-' + version + '.vsix', what: 'the VS Code extension' },
];

const missing = expected.filter((a) => !existsSync(join(releaseDir, a.file)));
if (missing.length > 0) {
  console.error('release-manifest: the release is incomplete.');
  for (const m of missing) console.error('  missing ' + m.file + ' — ' + m.what);
  console.error('');
  console.error('  npm pack --pack-destination release');
  console.error('  npm run package:extension');
  process.exit(1);
}

const artifacts = expected.map((a) => {
  const path = join(releaseDir, a.file);
  const digest = fileDigest(path);
  if (digest === undefined) {
    console.error('release-manifest: could not read ' + a.file);
    process.exit(1);
  }
  return {
    file: a.file,
    what: a.what,
    bytes: statSync(path).size,
    sha256: digest,
  };
});

const out = {
  product: 'Serva Code',
  version,
  /*
   * No build timestamp. Two builds of the same tree should produce the same manifest, and a
   * clock reading is the one field guaranteed to make them differ for no reason an owner cares
   * about. The artifacts carry their own identity in their hashes.
   */
  artifacts,
  verify: {
    windows: 'Get-FileHash <file> -Algorithm SHA256',
    unix: 'shasum -a 256 <file>',
  },
};

const manifestPath = join(releaseDir, 'release-manifest.json');
writeFileSync(manifestPath, JSON.stringify(out, null, 2) + '\n', 'utf8');

/* A plain sidecar too, because `shasum -c` and `Get-FileHash` are what an owner already has. */
writeFileSync(
  join(releaseDir, 'SHA256SUMS'),
  artifacts.map((a) => a.sha256 + '  ' + a.file).join('\n') + '\n',
  'utf8',
);

console.log('release-manifest: Serva Code ' + version);
for (const a of artifacts) {
  console.log('');
  console.log('  ' + a.file);
  console.log('    ' + String(a.bytes) + ' bytes');
  console.log('    sha256 ' + a.sha256);
}
console.log('');
console.log('  wrote release/release-manifest.json and release/SHA256SUMS');
