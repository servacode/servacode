import { defineConfig } from 'vitest/config';

/**
 * ARTIFACT-LEVEL TESTS: PACK, INSTALL SOMEWHERE ELSE, RUN.
 *
 * SPEC: the 1.0.1 packaging audit.
 *
 * Separate from the default suite because these do real I/O — `npm pack`, `npm install` into a
 * temp directory, and child processes running the packaged CLI — and take minutes rather than
 * milliseconds. They are not excluded for being inconvenient: `npm run test:package` is part of
 * the release sequence, because everything in the default suite runs with the repository
 * present and the defect they exist to catch lives precisely where it is not.
 */
export default defineConfig({
  test: {
    include: ['tests/package/**/*.test.ts'],
    environment: 'node',
    /* Packing, installing and launching a CLI is minutes of real work, not milliseconds. */
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
    /* One at a time: they share a build and would otherwise race on `npm pack`. */
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
