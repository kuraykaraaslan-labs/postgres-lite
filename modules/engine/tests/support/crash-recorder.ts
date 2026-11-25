import fs from 'node:fs';
import path from 'node:path';

import type { NodefsHook } from '../../engine.fsync.js';
import type { EmscriptenAttr, EmscriptenNode, EmscriptenStream, NodefsModule } from '../../engine.nodefs.js';

/*
 * Records every state-changing file operation PostgreSQL makes through NODEFS, so a test can later rebuild
 * "what a disk could hold after a power cut": the fsynced state plus any subset of the rest (crash-image.ts).
 * Files and directories are tracked by an id rather than a path, so renames and reused names stay correct.
 */

export type RecordedOp =
  | { kind: 'write'; id: number; pos: number; data: Buffer }
  | { kind: 'truncate'; id: number; size: number }
  | { kind: 'fsync'; id: number }
  | { kind: 'create'; parent: number; name: string; id: number; dir: boolean }
  | { kind: 'rename'; id: number; fromParent: number; fromName: string; toParent: number; toName: string }
  | { kind: 'unlink'; parent: number; name: string };

/** The directory as it was when recording started: every file and directory with its id. */
export interface BaseTree {
  /** Copy of the data directory taken when recording started. */
  snapshotDir: string;
  /** id → path relative to the data directory ('' is the root, id 0). */
  paths: Map<number, string>;
  dirs: Set<number>;
}

export interface Mark {
  label: string;
  opIndex: number;
}

export class CrashRecorder {
  readonly ops: RecordedOp[] = [];
  readonly marks: Mark[] = [];
  /** Operations the model could not attribute to a known file; a correct run has none. */
  unknownNodes = 0;
  base: BaseTree | undefined;

  #active = false;
  #nextId = 0;
  #nodeIds = new WeakMap<EmscriptenNode, number>();
  #liveByPath = new Map<string, number>();
  #mod: NodefsModule | undefined;

  constructor(private readonly dataDir: string) {}

  /** The NODEFS hook to pass to EngineOpen; it wraps the ops after fsync has been installed (or not). */
  readonly hook: NodefsHook = (mod) => {
    this.#mod = mod;
    this.wrap(mod);
  };

  /** Copies the (fully fsynced) data directory as the base image and starts recording. The engine must be idle. */
  start(snapshotDir: string): void {
    fs.cpSync(this.dataDir, snapshotDir, { recursive: true });
    const paths = new Map<number, string>();
    const dirs = new Set<number>();
    const walk = (rel: string): void => {
      const id = this.#nextId++;
      paths.set(id, rel);
      dirs.add(id);
      this.#liveByPath.set(rel, id);
      for (const entry of fs.readdirSync(path.join(snapshotDir, rel), { withFileTypes: true })) {
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(childRel);
        else {
          const fid = this.#nextId++;
          paths.set(fid, childRel);
          this.#liveByPath.set(childRel, fid);
        }
      }
    };
    walk('');
    this.base = { snapshotDir, paths, dirs };
    this.#active = true;
  }

  mark(label: string): void {
    this.marks.push({ label, opIndex: this.ops.length });
  }

  stop(): void {
    this.#active = false;
  }

  /** Paths (relative, at recording time) of the fsyncs in ops[from, to). */
  fsyncPaths(from: number, to: number): string[] {
    const names = this.namesById();
    const out: string[] = [];
    for (const op of this.ops.slice(from, to)) if (op.kind === 'fsync') out.push(names.get(op.id) ?? `#${op.id}`);
    return out;
  }

  private namesById(): Map<number, string> {
    const out = new Map<number, string>();
    for (const [p, id] of this.#liveByPath) out.set(id, p);
    for (const [id, p] of this.base?.paths ?? []) if (!out.has(id)) out.set(id, p);
    return out;
  }

  private rel(node: EmscriptenNode): string {
    const mod = this.#mod;
    if (mod === undefined) return '';
    const real = mod.NODEFS.realPath(node);
    const relative = path.relative(this.dataDir, real).split(path.sep).join('/');
    return relative;
  }

  private idOf(node: EmscriptenNode): number {
    const known = this.#nodeIds.get(node);
    if (known !== undefined) return known;
    const byPath = this.#liveByPath.get(this.rel(node));
    if (byPath !== undefined) {
      this.#nodeIds.set(node, byPath);
      return byPath;
    }
    this.unknownNodes++;
    const id = this.#nextId++;
    this.#nodeIds.set(node, id);
    return id;
  }

  private wrap(mod: NodefsModule): void {
    const { NODEFS, FS } = mod;
    const streamOps = NODEFS.stream_ops;
    const nodeOps = NODEFS.node_ops;

    const write = streamOps.write;
    streamOps.write = (stream, buffer, offset, length, position): number => {
      const written = write(stream, buffer, offset, length, position);
      if (this.#active && written > 0) {
        const data = Buffer.from(buffer.subarray(offset, offset + written));
        this.ops.push({ kind: 'write', id: this.idOf(stream.node), pos: position, data });
      }
      return written;
    };

    const fsync = streamOps.fsync;
    // Without the fix there is no fsync to wrap: recording one would claim durability PGlite never provided.
    if (fsync !== undefined) {
      streamOps.fsync = (stream: EmscriptenStream): number => {
        const result = fsync(stream);
        if (this.#active) this.ops.push({ kind: 'fsync', id: this.idOf(stream.node) });
        return result;
      };
    }

    const streamSetattr = streamOps.setattr;
    streamOps.setattr = (stream, attr: EmscriptenAttr): void => {
      streamSetattr(stream, attr);
      if (this.#active && attr.size !== undefined) this.ops.push({ kind: 'truncate', id: this.idOf(stream.node), size: attr.size });
    };

    const nodeSetattr = nodeOps.setattr;
    nodeOps.setattr = (node, attr): void => {
      nodeSetattr(node, attr);
      if (this.#active && attr.size !== undefined) this.ops.push({ kind: 'truncate', id: this.idOf(node), size: attr.size });
    };

    const mknod = nodeOps.mknod;
    nodeOps.mknod = (parent, name, mode, dev): EmscriptenNode => {
      const node = mknod(parent, name, mode, dev);
      if (this.#active) {
        const id = this.#nextId++;
        this.#nodeIds.set(node, id);
        this.#liveByPath.set(this.rel(node), id);
        this.ops.push({ kind: 'create', parent: this.idOf(parent), name, id, dir: FS.isDir(mode) });
      }
      return node;
    };

    const rename = nodeOps.rename;
    nodeOps.rename = (node, newDir, newName): void => {
      if (!this.#active) return rename(node, newDir, newName);
      const id = this.idOf(node);
      const fromParent = this.idOf(node.parent);
      const fromName = node.name;
      const fromRel = this.rel(node);
      rename(node, newDir, newName);
      const toRel = this.rel(newDir) === '' ? newName : `${this.rel(newDir)}/${newName}`;
      for (const [p, pid] of [...this.#liveByPath]) {
        if (p === fromRel || p.startsWith(`${fromRel}/`)) {
          this.#liveByPath.delete(p);
          this.#liveByPath.set(toRel + p.slice(fromRel.length), pid);
        }
      }
      this.ops.push({ kind: 'rename', id, fromParent, fromName, toParent: this.idOf(newDir), toName: newName });
    };

    for (const key of ['unlink', 'rmdir'] as const) {
      const remove = nodeOps[key];
      nodeOps[key] = (parent, name): void => {
        remove(parent, name);
        if (!this.#active) return;
        const parentRel = this.rel(parent);
        this.#liveByPath.delete(parentRel === '' ? name : `${parentRel}/${name}`);
        this.ops.push({ kind: 'unlink', parent: this.idOf(parent), name });
      };
    }
  }
}
