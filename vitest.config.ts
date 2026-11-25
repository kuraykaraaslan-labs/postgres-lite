import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['modules/**/tests/**/*.test.ts', 'libs/**/tests/**/*.test.ts'],
    environment: 'node',
    // PGlite boots a WASM PostgreSQL per engine: a few hundred ms each, more on cold CI runners.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
