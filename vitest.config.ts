import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['modules/**/tests/**/*.test.ts', 'libs/**/tests/**/*.test.ts'],
    environment: 'node',
    // PGlite boots a WASM PostgreSQL per engine: a few hundred ms each, more on cold CI runners.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Every fork compiles PGlite's WASM for each engine it starts; on Windows a fork per core runs V8 out of memory
    // ("Fatal process out of memory: Zone"), so fewer files run at once there.
    maxWorkers: process.platform === 'win32' ? 2 : undefined,
  },
});
