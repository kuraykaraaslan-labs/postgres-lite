import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import EngineFsync, { type NodefsHook } from '../engine.fsync.js';
import type { EmscriptenStream } from '../engine.nodefs.js';
import EngineOpen from '../engine.open.js';

interface FsyncEvent {
  path: string;
  dir: boolean;
  errno: number | undefined;
}

/** Records every fsync PostgreSQL asks NODEFS for, with the errno it got back. */
function fsyncLog(dataDir: string, log: FsyncEvent[]): NodefsHook {
  return (mod) => {
    const original = mod.NODEFS.stream_ops.fsync;
    if (original === undefined) return;
    mod.NODEFS.stream_ops.fsync = (stream: EmscriptenStream): number => {
      const event: FsyncEvent = {
        path: path.relative(dataDir, mod.NODEFS.realPath(stream.node)).split(path.sep).join('/'),
        dir: mod.FS.isDir(stream.node.mode),
        errno: undefined,
      };
      log.push(event);
      try {
        return original(stream);
      } catch (error) {
        const errno: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'errno') : undefined;
        event.errno = typeof errno === 'number' ? errno : -1;
        throw error;
      }
    };
  };
}

function countTree(root: string): { files: number; dirs: number } {
  let files = 0;
  let dirs = 1;
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isDirectory()) dirs++;
    else if (entry.isFile()) files++;
  }
  return { files, dirs };
}

function stats(times: number[]): { median: number; p95: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? Number.NaN;
  return { median: at(50), p95: at(95) };
}

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-spike6-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('EngineFsync.startParams', () => {
  it('drops -F, keeps the other PGlite defaults and asks for wal_sync_method=fsync', () => {
    const params = EngineFsync.startParams();
    expect(params).not.toContain('-F');
    const kept = PGlite.defaultStartParams.filter((p) => p !== '-F');
    expect(params.slice(0, kept.length)).toEqual(kept);
    expect(params.slice(kept.length)).toEqual(['-c', 'fsync=on', '-c', 'wal_sync_method=fsync']);
  });

  it('replaces any fsync or wal_sync_method setting already in the defaults', () => {
    expect(EngineFsync.startParams(['--single', '-F', '-c', 'fsync=off', '-c', 'wal_sync_method=fdatasync', '-c', 'a=b'])).toEqual([
      '--single',
      '-c',
      'a=b',
      '-c',
      'fsync=on',
      '-c',
      'wal_sync_method=fsync',
    ]);
  });
});

describe('durable engine (storage rule 1)', () => {
  it('fsyncs every file and directory of a new data directory after initdb', async () => {
    const dataDir = path.join(root, 'initdb');
    const synced: string[] = [];
    const original = fs.fsyncSync;
    const openPaths = new Map<number, string>();
    const originalOpen = fs.openSync;
    fs.openSync = ((target: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode | null): number => {
      const fd = originalOpen(target, flags ?? 'r', mode);
      openPaths.set(fd, String(target));
      return fd;
    }) as typeof fs.openSync;
    fs.fsyncSync = (fd: number): void => {
      synced.push(openPaths.get(fd) ?? `fd:${fd}`);
      original(fd);
    };
    try {
      const { pg, created } = await EngineOpen.open({ kind: 'disk', dataDir });
      expect(created).toBe(true);
      const tree = countTree(dataDir);
      const syncedSet = new Set(synced);
      const missed: string[] = [];
      // Windows cannot flush a directory handle, so syncTree skips directories there (see EngineFsync.syncTree).
      const windows = process.platform === 'win32';
      for (const entry of fs.readdirSync(dataDir, { recursive: true, encoding: 'utf8' })) {
        const full = path.join(dataDir, entry);
        if (windows && fs.statSync(full).isDirectory()) continue;
        if (!syncedSet.has(full)) missed.push(entry);
      }
      expect(missed).toEqual([]);
      expect(syncedSet.has(dataDir)).toBe(!windows);
      expect(syncedSet.has(path.dirname(dataDir))).toBe(!windows);
      console.info(`[spike6] new data directory: ${tree.files} files, ${tree.dirs} directories, ${synced.length} fsyncs during open`);
      expect((await pg.query<{ f: string; m: string }>("SELECT current_setting('fsync') f, current_setting('wal_sync_method') m")).rows[0]).toEqual({
        f: 'on',
        m: 'fsync',
      });
      await pg.close();
    } finally {
      fs.fsyncSync = original;
      fs.openSync = originalOpen;
    }
  });

  it('fsyncs the WAL at every commit, and pg_control plus data files at CHECKPOINT', async () => {
    const dataDir = path.join(root, 'counts');
    const log: FsyncEvent[] = [];
    const { pg } = await EngineOpen.open({ kind: 'disk', dataDir }, { hooks: [fsyncLog(dataDir, log)] });
    await pg.exec('CREATE TABLE t (id serial PRIMARY KEY, v text)');
    const beforeCommits = log.length;
    for (let i = 0; i < 100; i++) await pg.query('INSERT INTO t (v) VALUES ($1)', ['x']);
    const commits = log.slice(beforeCommits);
    expect(commits.length).toBeGreaterThanOrEqual(100);
    expect(commits.every((e) => e.path.startsWith('pg_wal/'))).toBe(true);
    const beforeCheckpoint = log.length;
    await pg.exec('CHECKPOINT');
    const checkpoint = log.slice(beforeCheckpoint);
    const paths = checkpoint.map((e) => e.path);
    expect(paths).toContain('global/pg_control');
    expect(paths.filter((p) => p.startsWith('base/')).length).toBeGreaterThan(0);
    // Files always flush; a directory reports EINVAL on Windows (28 in Emscripten), which PostgreSQL ignores.
    expect(checkpoint.filter((e) => !e.dir && e.errno !== undefined)).toEqual([]);
    const dirErrno = process.platform === 'win32' ? 28 : undefined;
    expect(checkpoint.filter((e) => e.dir && e.errno !== dirErrno)).toEqual([]);
    console.info(
      `[spike6] 100 autocommit inserts: ${commits.length} fsyncs (${(commits.length / 100).toFixed(2)} per commit, all pg_wal); ` +
        `CHECKPOINT: ${checkpoint.length} fsyncs (${paths.filter((p) => p.startsWith('base/')).length} data files, ` +
        `${checkpoint.filter((e) => e.dir).length} directories, pg_control ${paths.filter((p) => p === 'global/pg_control').length})`,
    );
    await pg.close();
  });

  it('on Windows reports EINVAL for a directory fsync, and PostgreSQL carries on', async () => {
    const dataDir = path.join(root, 'win32');
    const log: FsyncEvent[] = [];
    const { pg } = await EngineOpen.open({ kind: 'disk', dataDir }, { platform: 'win32', hooks: [fsyncLog(dataDir, log)] });
    await pg.exec("CREATE TABLE t (v text); INSERT INTO t VALUES ('a')");
    await pg.exec('SELECT pg_switch_wal()');
    await pg.exec('CHECKPOINT');
    await pg.exec("INSERT INTO t VALUES ('b')");
    expect((await pg.query<{ n: number }>('SELECT count(*)::int n FROM t')).rows[0]?.n).toBe(2);
    const dirEvents = log.filter((e) => e.dir);
    expect(dirEvents.length).toBeGreaterThan(0);
    expect(dirEvents.every((e) => e.errno === 28)).toBe(true); // Emscripten EINVAL
    expect(log.filter((e) => !e.dir).every((e) => e.errno === undefined)).toBe(true);
    await pg.close();
  });

  it('measures the commit latency cost (500 autocommit inserts, with and without the fix)', async () => {
    const measure = async (durable: boolean): Promise<{ median: number; p95: number }> => {
      const { pg } = await EngineOpen.open({ kind: 'disk', dataDir: path.join(root, `latency-${durable}`) }, { durable });
      await pg.exec('CREATE TABLE t (id serial PRIMARY KEY, v text)');
      for (let i = 0; i < 50; i++) await pg.query('INSERT INTO t (v) VALUES ($1)', ['warmup']);
      const times: number[] = [];
      for (let i = 0; i < 500; i++) {
        const t0 = performance.now();
        await pg.query('INSERT INTO t (v) VALUES ($1)', ['x'.repeat(100)]);
        times.push(performance.now() - t0);
      }
      await pg.close();
      return stats(times);
    };
    const without = await measure(false);
    const withFix = await measure(true);
    console.info(
      `[spike6] autocommit insert latency (500): without fix median=${without.median.toFixed(3)} ms p95=${without.p95.toFixed(3)} ms; ` +
        `with fix median=${withFix.median.toFixed(3)} ms p95=${withFix.p95.toFixed(3)} ms; ` +
        `cost median=+${(withFix.median - without.median).toFixed(3)} ms`,
    );
    expect(withFix.median).toBeGreaterThan(without.median);
  });
});
