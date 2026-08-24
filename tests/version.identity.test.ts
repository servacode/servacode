import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVA_VERSION, versionIdentity } from '../src/portability/version.js';

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
