import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { EngineMessages } from './engine.messages.js';

/*
 * Finds the worker entry next to this file.
 * - Built (dist/modules/engine/engine.worker.js, CommonJS): started directly. Works on Node 20+.
 * - TypeScript source under Vitest (engine.worker.ts): Node cannot run it as is (relative imports end in .js, and
 *   enums need a transform that Node's type stripping no longer offers), so the worker starts with a tiny loader that
 *   maps './x.js' to './x.ts' and compiles .ts with rolldown's oxc transform (rolldown ships with Vite, which Vitest
 *   depends on). The loader uses module.registerHooks, so running tests needs Node 22.15+ (Vitest 5 itself needs 22.12+).
 */

function sourceLoader(entry: string, anchor: string): string {
  return `
const { registerHooks, createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const { fileURLToPath } = require('node:url');
const anchor = createRequire(${JSON.stringify(anchor)});
let transformSync;
try {
  transformSync = createRequire(anchor.resolve('vite'))('rolldown/utils').transformSync;
} catch (error) {
  throw new Error(${JSON.stringify(EngineMessages.WORKER_SOURCE_LOADER)} + ': ' + error.message);
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      try { return next(specifier, context); } catch { return next(specifier.slice(0, -3) + '.ts', context); }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) return next(url, context);
    const file = fileURLToPath(url);
    const out = transformSync(file, readFileSync(file, 'utf8'), { lang: 'ts' });
    if (out.errors && out.errors.length > 0) throw new Error(file + ': ' + out.errors[0].message);
    return { format: 'module', source: out.code, shortCircuit: true };
  },
});
import(${JSON.stringify(pathToFileURL(entry).href)});
`;
}

export default class EngineWorkerPath {
  /** Absolute path of the worker entry and whether it is TypeScript source. */
  static entry(dir: string = __dirname): { file: string; source: boolean } {
    const built = path.join(dir, 'engine.worker.js');
    if (fs.existsSync(built)) return { file: built, source: false };
    return { file: path.join(dir, 'engine.worker.ts'), source: true };
  }

  static spawn(dir: string = __dirname): Worker {
    const { file, source } = EngineWorkerPath.entry(dir);
    if (!source) return new Worker(file);
    return new Worker(sourceLoader(file, file), { eval: true });
  }
}
