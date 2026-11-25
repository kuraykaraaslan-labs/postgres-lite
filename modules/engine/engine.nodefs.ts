import { EngineMessages } from './engine.messages.js';

/*
 * The part of Emscripten's NODEFS that postgres-lite touches. PGlite ships it untyped (the Emscripten
 * typings are not a dependency), so these interfaces are written from PGlite 0.5.16's dist/pglite.cjs
 * and checked at runtime by asNodefsModule before anything is patched.
 */

export interface EmscriptenNode {
  name: string;
  mode: number;
  parent: EmscriptenNode;
}

export interface EmscriptenStream {
  node: EmscriptenNode;
  /** The Node.js file descriptor NODEFS opened for this stream. */
  nfd?: number;
}

export interface EmscriptenAttr {
  size?: number;
  mode?: number;
}

export interface NodefsStreamOps {
  write(stream: EmscriptenStream, buffer: Uint8Array, offset: number, length: number, position: number): number;
  setattr(stream: EmscriptenStream, attr: EmscriptenAttr): void;
  /** Missing in PGlite 0.5.16: Emscripten's fd_sync then succeeds without touching the disk. */
  fsync?: (stream: EmscriptenStream) => number;
}

export interface NodefsNodeOps {
  setattr(node: EmscriptenNode, attr: EmscriptenAttr): void;
  mknod(parent: EmscriptenNode, name: string, mode: number, dev: number): EmscriptenNode;
  rename(node: EmscriptenNode, newDir: EmscriptenNode, newName: string): void;
  unlink(parent: EmscriptenNode, name: string): void;
  rmdir(parent: EmscriptenNode, name: string): void;
}

export interface NodefsApi {
  stream_ops: NodefsStreamOps;
  node_ops: NodefsNodeOps;
  /** Runs a Node.js fs call and turns a thrown `{ code }` into the matching Emscripten errno. */
  tryFSOperation<T>(fn: () => T): T;
  /** Host path of a node. */
  realPath(node: EmscriptenNode): string;
}

export interface EmscriptenFsApi {
  isDir(mode: number): boolean;
}

export interface NodefsModule {
  NODEFS: NodefsApi;
  FS: EmscriptenFsApi;
}

function hasFunctions(value: unknown, names: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return names.every((name) => typeof Reflect.get(value, name) === 'function');
}

/** Narrows the Emscripten module handed to a preRun hook, so a PGlite upgrade that moves NODEFS fails loudly. */
export function asNodefsModule(mod: unknown): NodefsModule {
  const nodefs: unknown = typeof mod === 'object' && mod !== null ? Reflect.get(mod, 'NODEFS') : undefined;
  const fs: unknown = typeof mod === 'object' && mod !== null ? Reflect.get(mod, 'FS') : undefined;
  const ok =
    hasFunctions(nodefs, ['tryFSOperation', 'realPath']) &&
    hasFunctions(Reflect.get(nodefs as object, 'stream_ops'), ['write', 'setattr']) &&
    hasFunctions(Reflect.get(nodefs as object, 'node_ops'), ['setattr', 'mknod', 'rename', 'unlink', 'rmdir']) &&
    hasFunctions(fs, ['isDir']);
  if (!ok) throw new Error(EngineMessages.NODEFS_SHAPE);
  return mod as NodefsModule;
}
