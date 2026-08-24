import { defineConfig } from 'vitest/config';

/**
 * SERVA 1.0 LIVE ACCEPTANCE. Invoked only by `npm run test:serva-live`.
 *
 * SPEC: Phase 6 closure §14.
 *
 * Its own command, and its own file, because it costs something different from every other
 * live suite: this one is the whole product end to end, through the functions the Control
 * Center calls, and it spends the owner's subscription to prove it.
 *
 * Excluded from `verify` the same way and for the same reason as the rest: there is no
 * combination of flags under which the ordinary test command spends money.
 */
export default defineConfig({
  test: {
    include: ['tests/live/serva.live.test.ts'],
    environment: 'node',
    reporters: ['default'],
    sequence: { shuffle: false, concurrent: false },
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 120_000,
  },
});
