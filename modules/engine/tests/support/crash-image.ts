import fs from 'node:fs';
import path from 'node:path';

import type { BaseTree, RecordedOp } from './crash-recorder.js';

/*
 * Builds a power-cut image from a recording: everything made durable by an fsync before the crash point, plus a random
 * subset of everything else (in order). The durability model is POSIX's, with the one relaxation every journaling file
 * system used by Linux, macOS and Windows gives: fsyncing a new file also makes its directory entry durable.
 * - A write or truncate is durable if the same file is fsynced later.
 * - A create is durable if its directory or the new file is fsynced later.
 * - A rename or unlink is durable if the directories involved are fsynced later.
 * Unsynced writes are split into 4 KiB sectors that survive independently, so torn pages are part of the test.
 */

const SECTOR = 4096;

export interface CrashImageStats {
  ops: number;
  durableOps: number;
  volatileOps: number;
  volatileKept: number;
}

/** Deterministic PRNG (mulberry32) so a failing seed can be replayed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lastFsyncIndex(ops: readonly RecordedOp[]): Map<number, number> {
  const last = new Map<number, number>();
  ops.forEach((op, i) => {
    if (op.kind === 'fsync') last.set(op.id, i);
  });
  return last;
}

function isDurable(op: RecordedOp, index: number, last: Map<number, number>): boolean {
  const after = (id: number): boolean => (last.get(id) ?? -1) > index;
  switch (op.kind) {
    case 'fsync':
      return true;
    case 'write':
    case 'truncate':
      return after(op.id);
    case 'create':
      return after(op.parent) || after(op.id);
    case 'rename':
      return after(op.toParent) && after(op.fromParent);
    case 'unlink':
      return after(op.parent);
  }
}

class ImageModel {
  readonly children = new Map<number, Map<string, number>>();
  readonly contents = new Map<number, Buffer>();

  constructor(private readonly base: BaseTree) {
    const dirByPath = new Map<string, number>();
    for (const id of base.dirs) {
      this.children.set(id, new Map());
      dirByPath.set(base.paths.get(id) ?? '', id);
    }
    for (const [id, rel] of base.paths) {
      if (rel === '') continue;
      const parentRel = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
      const parent = dirByPath.get(parentRel);
      if (parent !== undefined) this.children.get(parent)?.set(path.posix.basename(rel), id);
    }
  }

  private content(id: number): Buffer {
    let buf = this.contents.get(id);
    if (buf === undefined) {
      const rel = this.base.paths.get(id);
      buf = rel !== undefined && !this.base.dirs.has(id) ? fs.readFileSync(path.join(this.base.snapshotDir, rel)) : Buffer.alloc(0);
      this.contents.set(id, buf);
    }
    return buf;
  }

  write(id: number, pos: number, data: Buffer): void {
    let buf = this.content(id);
    const end = pos + data.length;
    if (end > buf.length) {
      const grown = Buffer.alloc(end);
      buf.copy(grown);
      buf = grown;
    }
    data.copy(buf, pos);
    this.contents.set(id, buf);
  }

  truncate(id: number, size: number): void {
    const buf = this.content(id);
    const out = Buffer.alloc(size);
    buf.copy(out, 0, 0, Math.min(size, buf.length));
    this.contents.set(id, out);
  }

  apply(op: RecordedOp): void {
    switch (op.kind) {
      case 'fsync':
        return;
      case 'write':
        return this.write(op.id, op.pos, op.data);
      case 'truncate':
        return this.truncate(op.id, op.size);
      case 'create': {
        const dir = this.children.get(op.parent);
        if (dir === undefined || dir.has(op.name)) return;
        dir.set(op.name, op.id);
        if (op.dir) this.children.set(op.id, new Map());
        else if (!this.contents.has(op.id)) this.contents.set(op.id, Buffer.alloc(0));
        return;
      }
      case 'rename': {
        const from = this.children.get(op.fromParent);
        const to = this.children.get(op.toParent);
        if (from === undefined || to === undefined || from.get(op.fromName) !== op.id) return;
        from.delete(op.fromName);
        to.set(op.toName, op.id);
        return;
      }
      case 'unlink':
        this.children.get(op.parent)?.delete(op.name);
        return;
    }
  }

  /** Writes the model to `outDir`, copying untouched files from the base snapshot. */
  materialize(outDir: string): void {
    const emit = (dirId: number, target: string): void => {
      fs.mkdirSync(target, { recursive: true });
      for (const [name, id] of this.children.get(dirId) ?? []) {
        const full = path.join(target, name);
        if (this.children.has(id)) emit(id, full);
        else {
          const buf = this.contents.get(id);
          const rel = this.base.paths.get(id);
          if (buf !== undefined) fs.writeFileSync(full, buf);
          else if (rel !== undefined) fs.copyFileSync(path.join(this.base.snapshotDir, rel), full);
          else fs.writeFileSync(full, Buffer.alloc(0));
        }
      }
    };
    emit(0, outDir);
    fs.chmodSync(outDir, 0o700);
  }
}

/** Builds the image for a crash right before ops[crashAt]. */
export function buildCrashImage(base: BaseTree, allOps: readonly RecordedOp[], crashAt: number, seed: number, outDir: string): CrashImageStats {
  const ops = allOps.slice(0, crashAt);
  const last = lastFsyncIndex(ops);
  const random = seededRandom(seed);
  const model = new ImageModel(base);
  const stats: CrashImageStats = { ops: ops.length, durableOps: 0, volatileOps: 0, volatileKept: 0 };
  ops.forEach((op, i) => {
    if (op.kind === 'fsync') return;
    if (isDurable(op, i, last)) {
      stats.durableOps++;
      model.apply(op);
      return;
    }
    stats.volatileOps++;
    if (op.kind !== 'write') {
      if (random() < 0.5) {
        stats.volatileKept++;
        model.apply(op);
      }
      return;
    }
    let kept = false;
    for (let start = op.pos; start < op.pos + op.data.length; ) {
      const end = Math.min(op.pos + op.data.length, (Math.floor(start / SECTOR) + 1) * SECTOR);
      if (random() < 0.5) {
        kept = true;
        model.write(op.id, start, op.data.subarray(start - op.pos, end - op.pos));
      }
      start = end;
    }
    if (kept) stats.volatileKept++;
  });
  model.materialize(outDir);
  return stats;
}
