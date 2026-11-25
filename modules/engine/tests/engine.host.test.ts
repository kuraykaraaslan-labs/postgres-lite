import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import EngineHost, { type WorkerEngine } from '../engine.host.js';
import { EngineMessages } from '../engine.messages.js';
import EngineOpen from '../engine.open.js';
import { readReply, simpleQuery, type QueryReply } from './support/protocol.js';

/** DBState in pg_control (int32 at offset 16): 1 = shut down cleanly, 6 = in production (next open runs crash recovery). */
const DB_SHUTDOWNED = 1;
const DB_IN_PRODUCTION = 6;

function controlState(dataDir: string): number {
  return fs.readFileSync(path.join(dataDir, 'global', 'pg_control')).readInt32LE(16);
}

async function q(engine: { execProtocolRaw(m: Uint8Array): Promise<Uint8Array> }, sql: string): Promise<QueryReply> {
  return readReply(await engine.execProtocolRaw(simpleQuery(sql)));
}

function openFds(): number | undefined {
  try {
    return fs.readdirSync('/proc/self/fd').length;
  } catch {
    return undefined;
  }
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? Number.NaN;
}

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-spike7-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('WorkerEngine', () => {
  it('runs the raw protocol in a worker and closes cleanly', async () => {
    const dataDir = path.join(root, 'clean');
    const engine = await EngineHost.start({ kind: 'disk', dataDir });
    const reply = await q(engine, 'SELECT 1 AS one');
    expect(reply.rows).toEqual([['1']]);
    expect(reply.status).toBe('I');
    const err = await q(engine, 'SELECT * FROM missing_table');
    expect(err.errors[0]).toContain('missing_table');
    expect((await q(engine, 'SELECT 2')).rows).toEqual([['2']]);
    // The caller's buffer is copied before transfer, so it can be sent again.
    const message = simpleQuery('SELECT 3');
    await engine.execProtocolRaw(message);
    expect(readReply(await engine.execProtocolRaw(message)).rows).toEqual([['3']]);
    await engine.close();
    expect(engine.alive).toBe(false);
    expect(controlState(dataDir)).toBe(DB_SHUTDOWNED);
    await expect(engine.execProtocolRaw(simpleQuery('SELECT 1'))).rejects.toThrow(EngineMessages.WORKER_EXITED);
  });

  for (const [name, statement] of [
    ['pg_sleep', 'SELECT pg_sleep(3600)'],
    ['a CPU-bound generate_series', 'SELECT count(*) FROM generate_series(1, 1000000000000) g'],
  ] as const) {
    it(`a hung statement (${name}) does not block the main thread, terminate() ends it, and the directory recovers`, async () => {
      const dataDir = path.join(root, `hang-${name.replace(/\W+/g, '-')}`);
      const engine = await EngineHost.start({ kind: 'disk', dataDir });
      await q(engine, 'CREATE TABLE t (id int PRIMARY KEY, v text)');
      for (let i = 1; i <= 100; i++) await q(engine, `INSERT INTO t VALUES (${i}, 'v${i}')`);
      const fdsBefore = openFds();

      const other = await EngineHost.start({ kind: 'memory' });
      const hung = engine.execProtocolRaw(simpleQuery(statement));
      const hungOutcome = hung.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

      // A 10 ms timer keeps firing on the main thread, and a second engine keeps answering, while the first is stuck.
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      const otherReplies: string[] = [];
      const started = performance.now();
      while (performance.now() - started < 1000) {
        otherReplies.push(String((await q(other, 'SELECT 42')).rows[0]?.[0]));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      clearInterval(timer);
      expect(ticks).toBeGreaterThan(50);
      expect(otherReplies.length).toBeGreaterThan(10);
      expect(new Set(otherReplies)).toEqual(new Set(['42']));

      const terminateStart = performance.now();
      await engine.terminate();
      const terminateMs = performance.now() - terminateStart;
      expect(await hungOutcome).toBe(EngineMessages.WORKER_TERMINATED);
      expect(engine.alive).toBe(false);
      expect(terminateMs).toBeLessThan(5000);
      expect(controlState(dataDir)).toBe(DB_IN_PRODUCTION);
      const fdsAfter = openFds();

      const reopened = await EngineHost.start({ kind: 'disk', dataDir });
      const rows = await q(reopened, 'SELECT count(*), min(id), max(id) FROM t');
      expect(rows.rows).toEqual([['100', '1', '100']]);
      await reopened.close();
      await other.close();
      expect(controlState(dataDir)).toBe(DB_SHUTDOWNED);
      console.info(`[spike7] ${name}: ticks=${ticks} in ~1 s, other engine replies=${otherReplies.length}, terminate=${terminateMs.toFixed(1)} ms, fds before=${fdsBefore} after terminate=${fdsAfter}`);
    });
  }

  it('measures the round-trip overhead of a worker against in-process (1000 x SELECT 1)', async () => {
    const message = simpleQuery('SELECT 1');
    const measure = async (engine: { execProtocolRaw(m: Uint8Array): Promise<Uint8Array> }): Promise<number[]> => {
      for (let i = 0; i < 200; i++) await engine.execProtocolRaw(message);
      const times: number[] = [];
      for (let i = 0; i < 1000; i++) {
        const t0 = performance.now();
        await engine.execProtocolRaw(message);
        times.push(performance.now() - t0);
      }
      return times.sort((a, b) => a - b);
    };
    const local = await EngineOpen.open({ kind: 'memory' });
    const inProcess = await measure({ execProtocolRaw: (m) => local.pg.execProtocolRaw(m) });
    await local.pg.close();
    const worker: WorkerEngine = await EngineHost.start({ kind: 'memory' });
    const inWorker = await measure(worker);
    await worker.close();
    const median = (t: number[]): number => percentile(t, 50);
    console.info(
      `[spike7] SELECT 1 x1000: in-process median=${(median(inProcess) * 1000).toFixed(0)} us p95=${(percentile(inProcess, 95) * 1000).toFixed(0)} us; ` +
        `worker median=${(median(inWorker) * 1000).toFixed(0)} us p95=${(percentile(inWorker, 95) * 1000).toFixed(0)} us; ` +
        `overhead median=${((median(inWorker) - median(inProcess)) * 1000).toFixed(0)} us`,
    );
    // Generous bound: the point is that a worker hop costs well under a millisecond, not an exact number.
    expect(median(inWorker) - median(inProcess)).toBeLessThan(1);
  });
});
