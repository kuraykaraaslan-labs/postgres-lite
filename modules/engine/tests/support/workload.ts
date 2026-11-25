import type { PGlite } from '@electric-sql/pglite';

import type { CrashRecorder } from './crash-recorder.js';

/** Rows the engine acknowledged, as the test expects to find them after any crash. */
export type Acked = Map<number, string>;

export interface CheckResult {
  missing: number[];
  wrongValue: number[];
  extra: number;
  amcheckErrors: string[];
}

/** Reads table t and runs amcheck on every btree index (catalogs included) and on the heap of t. */
export async function checkImage(pg: PGlite, acked: Acked): Promise<CheckResult> {
  const rows = (await pg.query<{ id: number; v: string }>('SELECT id, v FROM t ORDER BY id')).rows;
  const found = new Map(rows.map((r) => [r.id, r.v]));
  const missing: number[] = [];
  const wrongValue: number[] = [];
  for (const [id, v] of acked) {
    const got = found.get(id);
    if (got === undefined) missing.push(id);
    else if (got !== v) wrongValue.push(id);
  }
  const extra = [...found.keys()].filter((id) => !acked.has(id)).length;
  const amcheckErrors: string[] = [];
  await pg.exec('CREATE EXTENSION IF NOT EXISTS amcheck');
  const indexes = (
    await pg.query<{ oid: number; name: string }>(
      `SELECT c.oid::int AS oid, c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_am a ON a.oid = c.relam WHERE a.amname = 'btree' AND c.relpersistence = 'p'`,
    )
  ).rows;
  for (const index of indexes) {
    try {
      await pg.query('SELECT bt_index_check($1::oid::regclass, true)', [index.oid]);
    } catch (error) {
      amcheckErrors.push(`${index.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const heap = await pg.query<{ msg: string }>("SELECT msg FROM verify_heapam('t')");
  for (const row of heap.rows) amcheckErrors.push(`heap t: ${row.msg}`);
  return { missing, wrongValue, extra, amcheckErrors };
}

export const MARKS = ['before-checkpoint', 'after-checkpoint', 'end'] as const;
export type MarkLabel = (typeof MARKS)[number];

/**
 * Commits a mixed workload and marks three crash points: after 200 autocommit inserts, right after a CHECKPOINT,
 * and at the end (updates on pages the checkpoint wrote, a 200-row transaction, a WAL segment switch, a second
 * checkpoint, 200 more autocommits and deletes). Returns the acknowledged rows at each mark.
 */
export async function runWorkload(pg: PGlite, recorder: CrashRecorder): Promise<Map<MarkLabel, Acked>> {
  const ackedAt = new Map<MarkLabel, Acked>();
  const acked: Acked = new Map();
  const mark = (label: MarkLabel): void => {
    recorder.mark(label);
    ackedAt.set(label, new Map(acked));
  };
  await pg.exec('CREATE TABLE t (id int PRIMARY KEY, v text NOT NULL)');
  for (let i = 1; i <= 200; i++) {
    const v = `a${i}`.padEnd(120, '.');
    await pg.query('INSERT INTO t VALUES ($1, $2)', [i, v]);
    acked.set(i, v);
  }
  mark('before-checkpoint');
  await pg.exec('CHECKPOINT');
  mark('after-checkpoint');
  await pg.exec("UPDATE t SET v = 'u' || id WHERE id % 10 = 0");
  for (const [id] of acked) if (id % 10 === 0) acked.set(id, `u${id}`);
  await pg.exec("BEGIN; INSERT INTO t SELECT g, 'tx' || g FROM generate_series(201, 400) g; COMMIT");
  for (let i = 201; i <= 400; i++) acked.set(i, `tx${i}`);
  await pg.exec('SELECT pg_switch_wal()');
  await pg.exec('CHECKPOINT');
  for (let i = 401; i <= 600; i++) {
    // Wide rows, so with a small shared_buffers dirty pages are evicted (unsynced data-file writes) after the checkpoint.
    const v = `b${i}`.padEnd(1000, '.');
    await pg.query('INSERT INTO t VALUES ($1, $2)', [i, v]);
    acked.set(i, v);
  }
  await pg.exec('DELETE FROM t WHERE id % 7 = 0');
  for (const [id] of [...acked]) if (id % 7 === 0) acked.delete(id);
  mark('end');
  recorder.stop();
  return ackedAt;
}
