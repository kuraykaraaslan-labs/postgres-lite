import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EngineHandle } from '../../engine/engine.types.js';
import WireCodec from '../wire.codec.js';
import { WireMessages } from '../wire.messages.js';
import WireServer from '../wire.server.js';
import type { WireServerHandle } from '../wire.types.js';
import PgliteTestEngine from './support/pglite.engine.js';
import RawClient from './support/raw.client.js';

let engine: EngineHandle;
let server: WireServerHandle;

beforeEach(async () => {
  engine = await PgliteTestEngine.create();
  server = await WireServer.start({ engine, host: '127.0.0.1', port: 0 });
});

afterEach(async () => {
  await server.close();
  await engine.close();
});

function client(extra: Partial<pg.ClientConfig> = {}): pg.Client {
  return new pg.Client({ host: '127.0.0.1', port: server.port, user: 'postgres', database: 'postgres', ...extra });
}

async function rawSession(parameters: Record<string, string> = { user: 'postgres' }): Promise<Awaited<ReturnType<typeof RawClient.connect>>> {
  const raw = await RawClient.connect(server.port);
  raw.socket.write(RawClient.startup(parameters));
  await RawClient.until(raw.received, (b) => RawClient.countType(b, 'Z') === 1);
  return raw;
}

describe('WireServer with the pg client', () => {
  it('runs SELECT 1', async () => {
    const c = client();
    await c.connect();
    const result = await c.query('SELECT 1 AS one');
    expect(result.rows).toEqual([{ one: 1 }]);
    await c.end();
  });

  it('runs a parameterised query over the extended protocol', async () => {
    const c = client();
    await c.connect();
    const result = await c.query('SELECT $1::int + 1 AS n', [41]);
    expect(result.rows).toEqual([{ n: 42 }]);
    await c.end();
  });

  it('recovers from an error on the same connection', async () => {
    const c = client();
    await c.connect();
    await expect(c.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' });
    await expect(c.query('SELECT $1::int / 0', [1])).rejects.toMatchObject({ code: '22012' });
    expect((await c.query('SELECT $1::text AS ok', ['yes'])).rows).toEqual([{ ok: 'yes' }]);
    await c.end();
  });

  it('returns one result per statement of a multi-statement simple query', async () => {
    const c = client();
    await c.connect();
    const results = (await c.query('CREATE TABLE t (a int); INSERT INTO t VALUES (1), (2); SELECT sum(a)::int AS s FROM t')) as unknown as pg.QueryResult[];
    expect(results.map((r) => r.command)).toEqual(['CREATE', 'INSERT', 'SELECT']);
    expect(results[2]?.rows).toEqual([{ s: 3 }]);
    await c.end();
  });

  it('serves a pg.Pool running five queries one after another', async () => {
    const pool = new pg.Pool({ host: '127.0.0.1', port: server.port, user: 'postgres', database: 'postgres' });
    for (let i = 0; i < 5; i++) expect((await pool.query('SELECT $1::int * 2 AS v', [i])).rows).toEqual([{ v: i * 2 }]);
    await pool.end();
  });

  it('accepts a second connection after the first closed, with a fresh session', async () => {
    const first = client({ application_name: 'first' });
    await first.connect();
    await first.query('CREATE TEMP TABLE scratch (a int)');
    await first.query("SET TimeZone = 'Asia/Tokyo'");
    await first.query('CREATE TABLE kept (a int)');
    await first.query('BEGIN');
    await first.query('INSERT INTO kept VALUES (1)');
    await first.end(); // leaves with the transaction open

    const second = client();
    await second.connect();
    const row = (await second.query("SELECT current_setting('application_name') AS app, current_setting('TimeZone') AS tz, (SELECT count(*)::int FROM kept) AS n, to_regclass('pg_temp.scratch') IS NULL AS temp_gone")).rows[0];
    expect(row).toEqual({ app: '', tz: 'UTC', n: 0, temp_gone: true });
    await second.end();
  });

  it('passes the engine ParameterStatus after SET through to the client', async () => {
    const c = client();
    await c.connect();
    const seen: Array<{ parameterName: string; parameterValue: string }> = [];
    // pg exposes ParameterStatus only on its connection object.
    (c as unknown as { connection: { on(event: string, f: (m: { parameterName: string; parameterValue: string }) => void): void } }).connection.on(
      'parameterStatus',
      (m) => seen.push(m),
    );
    await c.query("SET application_name = 'renamed'");
    expect(seen).toContainEqual(expect.objectContaining({ parameterName: 'application_name', parameterValue: 'renamed' }));
    await c.end();
  });
});

describe('WireServer startup phase', () => {
  it('answers SSLRequest with N and sends the ParameterStatus set of PostgreSQL 18', async () => {
    const raw = await RawClient.connect(server.port);
    raw.socket.write(RawClient.sslRequest());
    await RawClient.until(raw.received, (b) => b.length >= 1);
    expect(raw.received()[0]).toBe(0x4e);
    raw.socket.write(RawClient.startup({ user: 'postgres', database: 'postgres', application_name: 'probe', client_encoding: 'UTF8' }));
    const bytes = await RawClient.until(raw.received, (b) => RawClient.countType(b.subarray(1), 'Z') === 1);
    const messages = RawClient.messages(bytes.subarray(1));
    expect(messages[0]?.type).toBe('R');
    const params = Object.fromEntries(
      messages.filter((m) => m.type === 'S').map((m) => {
        const name = WireCodec.readCString(m.body, 0);
        return [name?.value, name ? WireCodec.readCString(m.body, name.next)?.value : undefined];
      }),
    );
    expect(params).toMatchObject({
      server_version: '18.6',
      server_encoding: 'UTF8',
      client_encoding: 'UTF8',
      DateStyle: 'ISO, MDY',
      integer_datetimes: 'on',
      standard_conforming_strings: 'on',
      TimeZone: 'UTC',
      IntervalStyle: 'postgres',
      application_name: 'probe',
      is_superuser: 'on',
      session_authorization: 'postgres',
    });
    const key = messages.find((m) => m.type === 'K');
    expect(key?.body.length).toBe(8);
    expect(messages.at(-1)).toEqual({ type: 'Z', body: new Uint8Array([0x49]) });
    raw.socket.end(RawClient.terminate());
    await raw.closed;
  });

  it('negotiates protocol 3.2 and unknown _pq_ options down with NegotiateProtocolVersion', async () => {
    const raw = await RawClient.connect(server.port);
    raw.socket.write(RawClient.startup({ user: 'postgres', '_pq_.future_option': 'x' }, 3, 2));
    const bytes = await RawClient.until(raw.received, (b) => RawClient.countType(b, 'Z') === 1);
    const first = RawClient.messages(bytes)[0];
    expect(first?.type).toBe('v');
    expect(WireCodec.readInt32(first!.body, 0)).toBe(0);
    expect(WireCodec.readInt32(first!.body, 4)).toBe(1);
    expect(WireCodec.readCString(first!.body, 8)?.value).toBe('_pq_.future_option');
    raw.socket.end(RawClient.terminate());
    await raw.closed;
  });

  it('refuses protocol 4.0 and a startup GUC the engine does not know, with FATAL', async () => {
    const v4 = await RawClient.connect(server.port);
    v4.socket.write(RawClient.startup({ user: 'postgres' }, 4, 0));
    await v4.closed;
    expect(WireCodec.firstError(v4.received())).toMatchObject({ S: 'FATAL', C: '0A000' });

    const badGuc = await RawClient.connect(server.port);
    badGuc.socket.write(RawClient.startup({ user: 'postgres', no_such_setting: '1' }));
    await badGuc.closed;
    expect(WireCodec.firstError(badGuc.received())).toMatchObject({ S: 'FATAL', C: '42704' });

    const c = client();
    await c.connect();
    expect((await c.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
    await c.end();
  });
});

describe('WireServer message handling', () => {
  it('handles a startup and query written one byte at a time', async () => {
    const raw = await RawClient.connect(server.port);
    const bytes = WireCodec.concat([RawClient.startup({ user: 'postgres' }), WireCodec.query('SELECT 40 + 2')]);
    for (const byte of bytes) {
      raw.socket.write(new Uint8Array([byte]));
      await new Promise((resolve) => setImmediate(resolve));
    }
    const received = await RawClient.until(raw.received, (b) => RawClient.countType(b, 'Z') === 2);
    expect(WireCodec.dataRows(received)).toEqual([['42']]);
    raw.socket.end(RawClient.terminate());
    await raw.closed;
  });

  it('runs a pipeline in one chunk and skips to Sync after an error, like a real backend', async () => {
    const raw = await rawSession();
    const start = raw.received().length;
    const pipeline = WireCodec.concat([
      WireCodec.parse('', 'SELECT 1/0'),
      WireCodec.bind('', []),
      WireCodec.execute(),
      WireCodec.parse('', 'SELECT 99'), // skipped: an error is pending until Sync
      WireCodec.bind('', []),
      WireCodec.execute(),
      WireCodec.sync(),
      WireCodec.parse('', 'SELECT $1::int'),
      WireCodec.bind('', ['7']),
      WireCodec.execute(),
      WireCodec.sync(),
      WireCodec.query('SELECT 8'),
    ]);
    raw.socket.write(pipeline);
    const received = (await RawClient.until(raw.received, (b) => RawClient.countType(b.subarray(start), 'Z') === 3)).subarray(start);
    expect(RawClient.messages(received).map((m) => m.type).join('')).toBe('1EZ12DCZTDCZ');
    expect(WireCodec.dataRows(received)).toEqual([['7'], ['8']]);
    raw.socket.end(RawClient.terminate());
    await raw.closed;
  });

  it('closes the socket on Terminate', async () => {
    const raw = await rawSession();
    raw.socket.write(RawClient.terminate());
    await raw.closed;
    expect(raw.socket.destroyed).toBe(true);
  });

  it('ends the session with FATAL 08P01 on an invalid message type, and the engine keeps serving', async () => {
    const raw = await rawSession();
    // 'p' (PasswordMessage) after startup would hang PGlite 0.5.16 forever; the server must not forward it.
    raw.socket.write(WireCodec.message('p', WireCodec.cstring('secret')));
    await raw.closed;
    const error = WireCodec.firstError(raw.received());
    expect(error).toMatchObject({ S: 'FATAL', C: '08P01', M: `${WireMessages.MESSAGE_TYPE_INVALID} 112` });

    const c = client();
    await c.connect();
    expect((await c.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
    await c.end();
  });

  it('refuses COPY FROM STDIN with 0A000 instead of losing the engine, and still runs COPY TO STDOUT', async () => {
    const c = client();
    await c.connect();
    await c.query('CREATE TABLE t (a int)');
    await expect(c.query('COPY t FROM STDIN')).rejects.toMatchObject({ code: '0A000' });
    await expect(c.query('COPY t FROM STDIN', [])).rejects.toMatchObject({ code: '0A000' });
    // A leading comment or a quote trick must not get a COPY past the guard: one that slips through kills the engine.
    await expect(c.query('/* c */ COPY t FROM STDIN')).rejects.toMatchObject({ code: '0A000' });
    await expect(c.query('-- c\nCOPY t FROM /* c */ STDIN')).rejects.toMatchObject({ code: '0A000' });
    await expect(c.query("SELECT '--'; COPY t FROM STDIN")).rejects.toMatchObject({ code: '0A000' });
    await c.query('BEGIN');
    await expect(c.query('copy t from stdin with (format csv)')).rejects.toMatchObject({ code: '0A000' });
    // The refusal fails the open transaction, exactly as a real error would.
    await expect(c.query('SELECT 1')).rejects.toMatchObject({ code: '25P02' });
    await c.query('ROLLBACK');
    await c.query('INSERT INTO t VALUES (5)');
    await c.end();

    const raw = await rawSession();
    const start = raw.received().length;
    raw.socket.write(WireCodec.query('COPY t TO STDOUT'));
    const received = (await RawClient.until(raw.received, (b) => RawClient.countType(b.subarray(start), 'Z') === 1)).subarray(start);
    expect(RawClient.messages(received).map((m) => m.type).join('')).toBe('HdcCZ');
    raw.socket.end(RawClient.terminate());
    await raw.closed;
  });
});
