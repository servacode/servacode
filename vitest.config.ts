import { defineConfig } from 'vitest/config';

/**
 * The default suite is offline, deterministic and free.
 *
 * `tests/live/**` is excluded here rather than guarded inside the test files, so
 * there is no combination of flags under which `npm run verify` spends the owner's
 * Claude usage. Running the live suite is an explicit act: `npm run test:claude`.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/live/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    reporters: ['default'],
    sequence: { shuffle: false },
    testTimeout: 20000,
  },
});
