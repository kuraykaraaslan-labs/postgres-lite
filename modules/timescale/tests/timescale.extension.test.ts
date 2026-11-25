import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { TimescaleLicense } from '../timescale.dto.js';
import TimescaleExtension from '../timescale.extension.js';
import {
  AVAILABLE_IN_SERVER_SQL,
  probeTimescale,
  TIMESCALE_EXTENSION_SQL,
} from './fixtures/next-boilerplate.timescale.js';

const CREATE = 'CREATE EXTENSION IF NOT EXISTS timescaledb SCHEMA public';

const cleanups: Array<() => Promise<void>> = [];
// A private bundle folder, so the tests leave nothing in the shared os.tmpdir()/postgres-lite cache.
let bundleDir = '';
beforeAll(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'pgl-ts-bundles-'));
});
afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
});
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pgl-ts-ext-'));
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type OpenOptions = { dataDir?: string; license?: TimescaleLicense; preinstall?: boolean; version?: string; withExtension?: boolean };

async function open(options: OpenOptions = {}): Promise<PGlite> {
  const pg = new PGlite({
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(options.withExtension === false
      ? {}
      : {
          extensions: {
            timescaledb: TimescaleExtension.create({
              preinstall: options.preinstall ?? false,
              bundleDir,
              ...(options.version !== undefined ? { version: options.version } : {}),
            }),
          },
        }),
    ...(options.license !== undefined
      ? { startParams: TimescaleExtension.startParams(options.license, PGlite.defaultStartParams) }
      : {}),
  });
  await pg.waitReady;
  cleanups.push(async () => {
    if (!pg.closed) await pg.close();
  });
  return pg;
}

async function one<T>(pg: PGlite, sql: string): Promise<T> {
  const row = (await pg.query<T>(sql)).rows[0];
  if (row === undefined) throw new Error(`no row for ${sql}`);
  return row;
}

async function notices(pg: PGlite, sql: string): Promise<string[]> {
  const out: string[] = [];
  await pg.exec(sql, { onNotice: (n) => out.push(n.message ?? '') });
  return out;
}

describe('timescaledb extension bundle', () => {
  it('is listed in pg_available_extensions and installs in memory', async () => {
    const pg = await open();
    expect(await one(pg, `SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name = 'timescaledb'`)).toEqual({
      name: 'timescaledb',
      default_version: '2.31.0',
      installed_version: null,
    });
    await pg.exec(CREATE);
    expect(await one(pg, `SELECT extversion, extnamespace::regnamespace::text AS schema, extrelocatable FROM pg_extension WHERE extname = 'timescaledb'`)).toEqual({
      extversion: '2.31.0',
      schema: 'public',
      extrelocatable: false,
    });
    const schemas = (await pg.query<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE '%timescaledb%' ORDER BY 1`)).rows.map((r) => r.nspname);
    expect(schemas).toEqual(['_timescaledb_catalog', '_timescaledb_config', '_timescaledb_internal', 'timescaledb_information']);
    // Repeat is a no-op, as next-boilerplate's migration expects.
    await pg.exec(CREATE);
  });

  it('installs on disk and survives a reopen with its catalog rows', async () => {
    const dataDir = tempDir();
    const pg = await open({ dataDir });
    await pg.exec(`${CREATE};
      CREATE TABLE metrics (ts timestamptz NOT NULL, v int);
      INSERT INTO _timescaledb_catalog.hypertable (schema_name, table_name) VALUES ('public', 'metrics');`);
    await pg.close();

    const again = await open({ dataDir });
    expect(await one(again, `SELECT extversion, extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'timescaledb'`)).toEqual({
      extversion: '2.31.0',
      schema: 'public',
    });
    expect((await again.query(`SELECT hypertable_schema, hypertable_name, owner, num_dimensions, compression_enabled FROM timescaledb_information.hypertables`)).rows).toEqual([
      { hypertable_schema: 'public', hypertable_name: 'metrics', owner: 'postgres', num_dimensions: 1, compression_enabled: false },
    ]);
    await again.close();

    // The bundle lives in PGlite's share directory, not the data directory: without it the catalog stays but
    // the extension is no longer "available" (pg_dump and ALTER EXTENSION UPDATE would need it).
    const bare = await open({ dataDir, withExtension: false });
    expect((await bare.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'`)).rows).toEqual([]);
    expect((await bare.query(`SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'`)).rows).toHaveLength(1);
    expect(await one(bare, `SELECT public.time_bucket('1 hour', '2026-11-25 10:30+00')::text AS b`)).toEqual({ b: '2026-11-25 10:00:00+00' });
  });

  it('registers the catalog table and its sequence for pg_dump', async () => {
    const pg = await open();
    await pg.exec(CREATE);
    const row = await one<{ cfg: string[]; cond: string[] }>(pg, `SELECT ARRAY(SELECT unnest(extconfig)::regclass::text ORDER BY 1) AS cfg, extcondition AS cond FROM pg_extension WHERE extname = 'timescaledb'`);
    expect(row.cfg).toEqual(['_timescaledb_catalog.hypertable', '_timescaledb_catalog.hypertable_id_seq']);
    expect(row.cond).toEqual(['', '']);
  });

  it('reports the configured version', async () => {
    const pg = await open({ version: '2.17.0' });
    await pg.exec(CREATE);
    expect(await one(pg, `SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'`)).toEqual({ extversion: '2.17.0' });
  });
});

describe('time_bucket(interval, timestamptz)', () => {
  it('matches date_bin from Monday 2000-01-03 UTC', async () => {
    const pg = await open({ preinstall: true });
    // A session time zone far from UTC proves the origin is fixed in UTC, as Timescale's is without a timezone argument.
    await pg.exec(`SET TimeZone = 'America/Los_Angeles'`);
    const stamps = [
      '2026-11-25 10:37:12+00',
      '2000-01-03 00:00:00+00',
      '1999-12-31 23:59:59.999999+00',
      '1970-01-01 00:00:00+00',
      '2024-02-29 23:30:00+00',
      '2026-03-08 10:15:00+00',
    ];
    for (const width of ['1 hour', '15 minutes', '1 day', '7 days', '1 week']) {
      for (const ts of stamps) {
        const row = await one<{ same: boolean }>(pg, `SELECT time_bucket('${width}', '${ts}'::timestamptz) = date_bin('${width}', '${ts}'::timestamptz, '2000-01-03 00:00:00+00') AS same`);
        expect(row.same, `${width} ${ts}`).toBe(true);
      }
    }
    await pg.exec(`SET TimeZone = 'UTC'`);
    expect(await one(pg, `SELECT time_bucket('1 week', '2026-11-25 12:00+00'::timestamptz)::text AS b`)).toEqual({ b: '2026-11-23 00:00:00+00' });
    expect(await one(pg, `SELECT time_bucket('1 hour', '2026-11-25 10:37:12+00'::timestamptz)::text AS b`)).toEqual({ b: '2026-11-25 10:00:00+00' });
    expect(await one(pg, `SELECT provolatile, proisstrict FROM pg_proc WHERE proname = 'time_bucket'`)).toEqual({ provolatile: 'i', proisstrict: true });
  });
});

describe('timescaledb.license', () => {
  it('reads as the startup -c value in memory and on every reopen', async () => {
    expect(await one(await open({ license: 'timescale' }), `SELECT current_setting('timescaledb.license', true) AS l`)).toEqual({ l: 'timescale' });
    expect(await one(await open({ license: 'apache' }), `SELECT current_setting('timescaledb.license', true) AS l`)).toEqual({ l: 'apache' });
    expect(await one(await open(), `SELECT current_setting('timescaledb.license', true) AS l`)).toEqual({ l: null });

    const dataDir = tempDir();
    await (await open({ dataDir, license: 'apache' })).close();
    // Not persisted: the server must pass it on every open.
    const plain = await open({ dataDir });
    expect(await one(plain, `SELECT current_setting('timescaledb.license', true) AS l`)).toEqual({ l: null });
  });

  it('ALTER SYSTEM survives a reopen on disk, startup -c overrides it, ALTER DATABASE and ALTER ROLE are ignored', async () => {
    const sysDir = tempDir();
    const a = await open({ dataDir: sysDir });
    await a.exec(`ALTER SYSTEM SET timescaledb.license = 'apache'`);
    await a.close();
    expect(await one(await open({ dataDir: sysDir }), `SELECT current_setting('timescaledb.license', true) AS l`)).toEqual({ l: 'apache' });
    expect(await one(await open({ dataDir: sysDir, license: 'timescale' }), `SELECT current_setting('timescaledb.license', true) AS l`)).toEqual({ l: 'timescale' });

    const dbDir = tempDir();
    const b = await open({ dataDir: dbDir });
    await b.exec(`ALTER DATABASE postgres SET timescaledb.license = 'apache'; ALTER ROLE postgres SET timescaledb.license = 'apache'`);
    await b.close();
    const c = await open({ dataDir: dbDir });
    expect((await c.query(`SELECT setconfig FROM pg_db_role_setting ORDER BY setrole`)).rows).toHaveLength(2);
    expect(await one(c, `SELECT current_setting('timescaledb.license', true) AS l`)).toEqual({ l: null });
  });
});

describe("next-boilerplate's probe and migration", () => {
  it('without pre-install: available in server, migration stops at the shared_preload_libraries check', async () => {
    const pg = await open({ license: 'timescale' });
    expect((await pg.query(AVAILABLE_IN_SERVER_SQL)).rows).toHaveLength(1);
    expect(await probeTimescale(pg)).toEqual({ available: false, edition: null, version: null, schema: null });
    expect(await notices(pg, TIMESCALE_EXTENSION_SQL)).toEqual([
      'timescaledb is installed but not in shared_preload_libraries: time-series tables fall back to plain tables',
    ]);
    expect(await probeTimescale(pg)).toEqual({ available: false, edition: null, version: null, schema: null });
  });

  it('with pre-install: migration takes the already-installed branch, probe reports tsl', async () => {
    const pg = await open({ preinstall: true, license: 'timescale' });
    expect(await notices(pg, TIMESCALE_EXTENSION_SQL)).toEqual([]);
    expect(await probeTimescale(pg)).toEqual({ available: true, edition: 'tsl', version: '2.31.0', schema: 'public' });
  });

  it('with pre-install and the apache license: probe reports apache', async () => {
    const pg = await open({ preinstall: true, license: 'apache' });
    expect(await probeTimescale(pg)).toEqual({ available: true, edition: 'apache', version: '2.31.0', schema: 'public' });
  });

  it('pre-install is idempotent across an on-disk reopen', async () => {
    const dataDir = tempDir();
    await (await open({ dataDir, preinstall: true })).close();
    const pg = await open({ dataDir, preinstall: true, license: 'timescale' });
    expect(await probeTimescale(pg)).toEqual({ available: true, edition: 'tsl', version: '2.31.0', schema: 'public' });
  });
});
