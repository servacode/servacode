import { defineConfig } from 'vitest/config';

/**
 * The opt-in live INTELLIGENCE suite. Invoked only by `npm run test:intelligence-live`.
 *
 * Separate from `vitest.live.config.ts` because it costs something different: that suite
 * spends model usage, this one spends model usage AND reaches the public network. An
 * operator should be able to consent to one without consenting to the other.
 */
export default defineConfig({
  test: {
    include: ['tests/live/intelligence.live.test.ts'],
    environment: 'node',
    reporters: ['default'],
    sequence: { shuffle: false, concurrent: false },
    fileParallelism: false,
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
  },
});
