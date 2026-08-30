import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SERVA_VERSION, versionIdentity } from '../src/portability/version.js';
import { FixedClock } from '../src/core/clock.js';
import { MANIFEST_NAME, createBackup } from '../src/portability/backup.js';
import { ServaRuntime } from '../src/app/runtime.js';

/**
 * ONE PRODUCT, ONE VERSION.
 *
 * SPEC: Phase 6 closure §12; §34.
 *
 * The independent audit found the package claiming Serva Code 1.0 while the root manifest
 * read `0.2.0` and described itself as "Phase 2 Core Engine". Three artifacts carried the
 * product's identity and two of them disagreed with the third, so an owner reading
 * `package.json` after installing would have learned the wrong thing about what they had.
 *
 * A constant in source is easy to keep right; a manifest nobody imports drifts silently.
 * These tests are the thing that makes drift loud, and they read the manifests off disk
 * rather than importing a value that would agree with itself by construction.
 */

const root = join(import.meta.dirname, '..');
const manifest = (...p: string[]): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, ...p), 'utf8')) as Record<string, unknown>;

describe('version identity is coherent across everything that carries it', () => {
  it('the root manifest states the product version', () => {
    expect(manifest('package.json').version).toBe(SERVA_VERSION);
  });

  it('the extension manifest states the same product version', () => {
    /* The extension IS the primary experience, so a different number there is a different product. */
    expect(manifest('extension', 'package.json').version).toBe(SERVA_VERSION);
  });

  /*
   * THE LOCKFILES CARRY THE VERSION TOO, AND NOBODY WAS CHECKING THEM.
   *
   * SPEC: Phase 6 closure §12; the 1.0.1 packaging audit.
   *
   * These tests asserted the two `package.json` files and stopped there, while the acceptance
   * requirement claimed version identity across everything that carries it. A lockfile states
   * the version twice — at the top and again for the root package — and `npm install` writes
   * both, so a hand-edited manifest and a stale lock disagree silently until an owner installs
   * from the lock and gets a different number than the one they were promised.
   */
  it('the root lockfile states the product version, in both places it says it', () => {
    const lock = manifest('package-lock.json');
    expect(lock.version, 'package-lock.json top-level version').toBe(SERVA_VERSION);
    const packages = lock.packages as Record<string, { version?: string } | undefined>;
    expect(packages['']?.version, 'package-lock.json root package version').toBe(SERVA_VERSION);
  });

  it('the extension lockfile states the product version, in both places it says it', () => {
    const lock = manifest('extension', 'package-lock.json');
    expect(lock.version, 'extension/package-lock.json top-level version').toBe(SERVA_VERSION);
    const packages = lock.packages as Record<string, { version?: string } | undefined>;
    expect(packages['']?.version, 'extension/package-lock.json root package version').toBe(
      SERVA_VERSION,
    );
  });

  it('no manifest describes itself as an earlier phase', () => {
    for (const where of [['package.json'], ['extension', 'package.json']]) {
      const description = String(manifest(...where).description ?? '');
      expect(description, where.join('/')).not.toMatch(/Phase\s*[0-9]/i);
    }
  });

  it('the product version is a release version, not a pre-1.0 one', () => {
    expect(SERVA_VERSION).toMatch(/^[1-9][0-9]*\.[0-9]+\.[0-9]+$/);
  });

  it('the three version numbers stay separate, because they answer different questions', () => {
    const identity = versionIdentity();
    expect(identity.serva).toBe(SERVA_VERSION);
    /*
     * Deliberately NOT asserting they are equal. The store schema and the backup format move
     * independently of the product; collapsing them means a cosmetic release invalidates
     * every backup, or a real format change slides through under a version that did not move.
     */
    expect(Number.isInteger(identity.storeSchema)).toBe(true);
    expect(Number.isInteger(identity.backupFormat)).toBe(true);
  });
});

describe('a backup a real owner takes carries the real product version', () => {
  /*
   * SPEC: Phase 6 closure §12; §34.
   *
   * `createBackup` stamps `servaVersion: SERVA_VERSION` into every manifest, and reading that
   * line in the source proves only that somebody wrote it. A backup is the artifact that
   * outlives the machine it came from — the one place a wrong version number is discovered
   * years later by someone trying to restore — so this makes a real one and reads it back off
   * disk.
   */
  it('the manifest of a genuinely created backup states SERVA_VERSION', () => {
    const work = mkdtempSync(join(tmpdir(), 'serva-version-identity-'));
    try {
      const project = join(work, 'project');
      mkdirSync(project, { recursive: true });
      /* `init` creates the store; pre-creating it would read as a project that already exists. */
      ServaRuntime.init('RahalGo', 'Stop losing phone orders', { root: project });

      const destination = join(work, 'bundle');
      const result = createBackup(
        { clock: new FixedClock() },
        {
          projects: [{ projectId: 'PRJ-1', name: 'RahalGo', root: project }],
          destination,
        },
      );

      expect(result.manifest.servaVersion).toBe(SERVA_VERSION);

      /* And on disk, because the returned object and the written file could differ. */
      const written = JSON.parse(readFileSync(join(destination, MANIFEST_NAME), 'utf8')) as Record<
        string,
        unknown
      >;
      expect(written.servaVersion).toBe(SERVA_VERSION);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
