import { defineConfig } from 'vitest/config';

/**
 * The Phase 4 live acceptance. Invoked only by `npm run test:engineering-live`.
 *
 * Kept apart from `vitest.live.config.ts` on purpose. That suite spends the owner's
 * Claude usage; this one probes the machine and, if the machine can carry engineering
 * authority, runs real builds and tests inside a disposable fixture repository. Two
 * different costs, two different decisions, two different commands.
 */
export default defineConfig({
  test: {
    include: ['tests/live/engineering.live.test.ts'],
    environment: 'node',
    reporters: ['default'],
    sequence: { shuffle: false, concurrent: false },
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
