import { defineConfig } from 'vitest/config';

/**
 * The opt-in live suite. Invoked only by `npm run test:claude`.
 *
 * Long timeouts because a real model call is not fast, and single-threaded because
 * the point is to make the minimum number of calls in a predictable order.
 */
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    // The engineering acceptance lives here too but costs something different, so it
    // gets its own command rather than riding along with the model-call suite.
    exclude: ['tests/live/engineering.live.test.ts'],
    environment: 'node',
    reporters: ['default'],
    sequence: { shuffle: false, concurrent: false },
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
