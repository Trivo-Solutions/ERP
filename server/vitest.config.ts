import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    exclude: ['**/node_modules/**', '**/dist/**'],
    fileParallelism: false, // integration tests share one Postgres DB; avoid cross-test races
  },
});
