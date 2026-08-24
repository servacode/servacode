import { defineConfig } from 'vitest/config';

/**
 * The default suite is offline, deterministic and free.
 *
 * `tests/live/**` is excluded here rather than guarded inside the test files, so
 * there is no combination of flags under which `npm run verify` spends the owner's
 * Claude usage. Running the live suite is an explicit act: `npm run test:claude`.
 *
 * `tests/vscode/**` is excluded because it cannot run here at all: those tests import the
 * `vscode` module, which exists only inside an Extension Host. They run under
 * `npm run test:vscode`, which launches a real editor, and their result is merged into the
 * acceptance proofs from a separate report — so a requirement bound to one of them cannot be
 * proven by this suite alone.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/live/**', 'tests/vscode/**', 'node_modules/**', 'dist/**', 'out/**'],
    environment: 'node',
    reporters: ['default'],
    sequence: { shuffle: false },
    testTimeout: 20000,
  },
});
