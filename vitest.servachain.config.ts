import { defineConfig } from 'vitest/config';

/**
 * The LIVE-SERVA chain: an owner request that becomes an accepted commit.
 *
 * SPEC: Phase 6 final acceptance sequence §2.
 *
 * Its own command and its own config, like every other live suite, because it spends the
 * owner's subscription and takes as long as real work takes.
 */
export default defineConfig({
  test: {
    include: ['tests/live/servachain.live.test.ts'],
    environment: 'node',
    reporters: ['default'],
    sequence: { shuffle: false, concurrent: false },
    fileParallelism: false,
    testTimeout: 3_600_000,
    hookTimeout: 600_000,
  },
});
