import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    reporters: ['default'],
    sequence: { shuffle: false },
    testTimeout: 20000,
  },
});
