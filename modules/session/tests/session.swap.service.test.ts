import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import Logger from '../../../libs/logger/index.js';
import SessionSwapService from '../session.swap.service.js';
import type { SessionConnection, SessionEngineContext, SessionState } from '../session.types.js';
import { createEngine, inTransaction, rows, WHO_SQL, type Who } from './session.fixtures.js';

/** A simulated client connection: every statement first takes the backend through the swap, as the lease will. */
class Client {
  private static holder: SessionConnection | null = null;

  constructor(
    private readonly engine: PGlite,
    private readonly ctx: SessionEngineContext,
    readonly conn: SessionConnection,
  ) {}

  static reset(): void {
    Client.holder = null;
  }

  async acquire(): Promise<void> {
    await SessionSwapService.swap(this.engine, this.ctx, Client.holder, this.conn);
    Client.holder = this.conn;
  }

  async rows<T>(sql: string): Promise<T[]> {
    SessionSwapService.noteStatement(this.ctx, sql);
    await this.acquire();
    return rows<T>(this.engine, sql);
  }

  async exec(sql: string): Promise<void> {
    SessionSwapService.noteStatement(this.ctx, sql);
    await this.acquire();
    await this.engine.exec(sql);
  }

  async tx<T>(sql: string): Promise<T[]> {
    SessionSwapService.noteStatement(this.ctx, sql);
    await this.acquire();
    return inTransaction<T>(this.engine, sql);
  }
}

describe('SessionSwapService', () => {
  let engine: PGlite;
  let ctx: SessionEngineContext;
  let nextId = 1;

  const superuserState = (): SessionState => ({ sessionUser: 'postgres', role: 'none', gucs: {}, customGucs: {}, sqlPreparedNames: [] });

  const client = async (login: string): Promise<Client> => new Client(engine, ctx, await SessionSwapService.connect(engine, ctx, nextId++, login));

  beforeAll(async () => {
    engine = await createEngine();
    await engine.exec(`CREATE ROLE deployer LOGIN; GRANT app_owner TO deployer WITH INHERIT TRUE, SET TRUE;
      CREATE SCHEMA other AUTHORIZATION app_owner; GRANT USAGE ON SCHEMA other TO app_runtime;
      CREATE FUNCTION tenant_of_session() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('app.fn_only', true) $$;`);
    ctx = await SessionSwapService.open(engine);
    Client.reset();
  });

  afterAll(async () => {
    await engine.close();
  });

  it('open() finds the superuser and seeds custom GUC names from function bodies', () => {
    expect(ctx.superuser).toBe('postgres');
    expect([...ctx.customGucNames].sort()).toEqual(expect.arrayContaining(['app.bypass_rls', 'app.current_tenant', 'app.fn_only']));
  });

  it('connect() refuses unknown and NOLOGIN roles', async () => {
    await expect(SessionSwapService.connect(engine, ctx, 0, 'nobody')).rejects.toThrow();
    await expect(SessionSwapService.connect(engine, ctx, 0, 'app_admin')).rejects.toThrow();
  });

  it('two connections as different roles, alternating statements, never see each other\'s rows, roles or settings', async () => {
    const a = await client('app_runtime');
    const b = await client('app_admin_login');
    // Session-level (not transaction-local) tenants: the case that leaks if the swap misses custom GUCs.
    await a.exec(`SELECT set_config('app.current_tenant', 'a', false)`);
    await b.exec(`SET app.current_tenant = 'b'; SET search_path = other, public; SET statement_timeout = '7s'`);
    for (let round = 0; round < 25; round++) {
      expect(await a.rows(`SELECT id FROM items WHERE id < 1000 ORDER BY id`)).toEqual([{ id: 1 }, { id: 2 }]);
      expect(await b.rows(`SELECT id FROM items ORDER BY id`)).toEqual([{ id: 3 }, { id: 200 }]);
      expect(await a.rows<Who>(WHO_SQL)).toEqual([{ cu: 'app_runtime', su: 'app_runtime', role: 'none', is_superuser: 'off' }]);
      expect(await b.rows<Who>(WHO_SQL)).toEqual([{ cu: 'app_admin_login', su: 'app_admin_login', role: 'none', is_superuser: 'off' }]);
      expect(await a.rows(`SELECT current_setting('search_path') AS sp, current_setting('statement_timeout') AS st`)).toEqual([{ sp: 'public', st: '0' }]);
      expect(await b.rows(`SELECT current_setting('search_path') AS sp, current_setting('statement_timeout') AS st`)).toEqual([{ sp: 'other, public', st: '7s' }]);
      // A transaction-local bypass in b must not survive into a's next statement.
      expect(await b.tx(`SELECT set_config('app.bypass_rls', 'on', true); SELECT count(*)::int AS n FROM items WHERE id < 1000`)).toEqual([{ n: 4 }]);
      expect(await a.rows(`SELECT count(*)::int AS n, current_setting('app.bypass_rls', true) AS by FROM items WHERE id < 1000`)).toEqual([{ n: 2, by: '' }]);
      // Writes stay inside each tenant.
      await a.exec(`INSERT INTO items VALUES (${1000 + round}, 'a', 'w')`);
      expect(await b.rows(`SELECT count(*)::int AS n FROM items WHERE id >= 1000`)).toEqual([{ n: 0 }]);
    }
    expect(await a.rows(`SELECT count(*)::int AS n FROM items WHERE id >= 1000`)).toEqual([{ n: 25 }]);
    await a.exec(`DELETE FROM items WHERE id >= 1000`);
  });

  it('restores SET ROLE and a session GUC after another connection used the backend', async () => {
    const d = await client('deployer');
    const r = await client('app_runtime');
    await d.exec(`SET ROLE app_owner; SET work_mem = '16MB'; SET app.current_tenant = 'b'`);
    expect(await r.rows<Who>(WHO_SQL)).toEqual([{ cu: 'app_runtime', su: 'app_runtime', role: 'none', is_superuser: 'off' }]);
    expect(await r.rows(`SELECT current_setting('work_mem') AS wm, current_setting('app.current_tenant', true) AS t`)).toEqual([{ wm: '4MB', t: '' }]);
    expect(await d.rows<Who>(WHO_SQL)).toEqual([{ cu: 'app_owner', su: 'deployer', role: 'app_owner', is_superuser: 'off' }]);
    expect(await d.rows(`SELECT current_setting('work_mem') AS wm, count(*)::int AS n FROM items`)).toEqual([{ wm: '16MB', n: 2 }]);
    // RESET ROLE and RESET are captured too: the connection's own resets survive the next swap.
    await d.exec(`RESET ROLE; RESET work_mem`);
    await r.rows('SELECT 1');
    expect(await d.rows(`SELECT current_user::text AS cu, current_setting('work_mem') AS wm`)).toEqual([{ cu: 'deployer', wm: '4MB' }]);
  });

  it('restores a superuser login\'s SET SESSION AUTHORIZATION and its superuser-only settings', async () => {
    const s = await client('postgres');
    const r = await client('app_runtime');
    await s.exec(`SET log_statement = 'all'; SET SESSION AUTHORIZATION app_owner`);
    expect(await r.rows(`SELECT current_setting('log_statement') AS ls`)).toEqual([{ ls: 'none' }]);
    expect(await s.rows<Who>(WHO_SQL)).toEqual([{ cu: 'app_owner', su: 'app_owner', role: 'none', is_superuser: 'off' }]);
    expect(s.conn.state.gucs).toMatchObject({ log_statement: 'all' });
    expect(s.conn.state.sessionUser).toBe('app_owner');
  });

  it('applies ALTER ROLE ... SET defaults at connect, as a login would', async () => {
    await SessionSwapService.restore(engine, ctx, superuserState());
    Client.reset();
    await engine.exec(`ALTER ROLE app_runtime SET statement_timeout = '3s'; ALTER ROLE app_runtime SET app.region = 'eu'`);
    const r = await client('app_runtime');
    const o = await client('app_owner');
    expect(await r.rows(`SELECT current_setting('statement_timeout') AS st, current_setting('app.region', true) AS region`)).toEqual([{ st: '3s', region: 'eu' }]);
    expect(await o.rows(`SELECT current_setting('statement_timeout') AS st, current_setting('app.region', true) AS region`)).toEqual([{ st: '0', region: '' }]);
    await SessionSwapService.restore(engine, ctx, superuserState());
    Client.reset();
    await engine.exec(`ALTER ROLE app_runtime RESET ALL`);
  });

  it('flags a non-superuser connection that switched to the superuser through dynamic SQL', async () => {
    const warnings: string[] = [];
    Logger.setLevel('warn');
    Logger.setSink((line) => warnings.push(line));
    try {
      const evil = await client('app_runtime');
      const other = await client('app_owner');
      await evil.exec(`DO $$ BEGIN EXECUTE 'SET SESSION AUTHORIZATION postgres'; END $$`);
      Client.reset();
      await SessionSwapService.swap(engine, ctx, null, evil.conn);
      await engine.exec(`DO $$ BEGIN EXECUTE 'SET SESSION AUTHORIZATION postgres'; END $$`);
      const result = await SessionSwapService.swap(engine, ctx, evil.conn, other.conn);
      expect(result.outgoingEscalated).toBe(true);
      expect(warnings.some((line) => line.includes('SessionSwapService.swap'))).toBe(true);
      expect(await rows<Who>(engine, WHO_SQL)).toEqual([{ cu: 'app_owner', su: 'app_owner', role: 'none', is_superuser: 'off' }]);
    } finally {
      Logger.setSink((line) => process.stderr.write(`${line}\n`));
      Client.reset();
    }
  });

  it('does not see an escalation the connection undid before releasing the lease', async () => {
    // Detection compares session_user at release only, so escalate, act, switch back inside one lease goes unnoticed.
    const evil = await client('app_runtime');
    const other = await client('app_owner');
    await evil.exec(`SELECT set_config('session_authorization', 'postgres', false); SET SESSION AUTHORIZATION app_runtime`);
    const result = await SessionSwapService.swap(engine, ctx, evil.conn, other.conn);
    expect(result.outgoingEscalated).toBe(false);
    Client.reset();
  });

  it('captures the real settings even when the client shadows current_setting() through search_path', async () => {
    await SessionSwapService.restore(engine, ctx, superuserState());
    Client.reset();
    await engine.exec(`CREATE FUNCTION other.current_setting(text) RETURNS text LANGUAGE sql AS $$ SELECT 'spoofed' $$`);
    try {
      const a = await client('app_runtime');
      const b = await client('app_owner');
      await a.exec(`SET search_path = other, pg_catalog; SET app.current_tenant = 'a'`);
      await b.rows('SELECT 1');
      expect(a.conn.state.role).toBe('none');
      expect(a.conn.state.customGucs).toMatchObject({ 'app.current_tenant': 'a' });
      expect(a.conn.state.gucs).toMatchObject({ search_path: 'other, pg_catalog' });
      expect(await a.rows(`SELECT pg_catalog.current_setting('app.current_tenant') AS t`)).toEqual([{ t: 'a' }]);
    } finally {
      await SessionSwapService.restore(engine, ctx, superuserState());
      Client.reset();
      await engine.exec(`DROP FUNCTION other.current_setting(text)`);
    }
  });

  it('leaves the backend unchanged when the incoming restore fails', async () => {
    const a = await client('app_runtime');
    await a.exec(`SET app.current_tenant = 'a'`);
    const ghost = await client('deployer');
    ghost.conn.state.role = 'role_that_does_not_exist';
    await expect(SessionSwapService.swap(engine, ctx, a.conn, ghost.conn)).rejects.toMatchObject({ code: '22023' });
    expect(await rows(engine, `SELECT session_user::text AS su, current_setting('app.current_tenant', true) AS t`)).toEqual([{ su: 'app_runtime', t: 'a' }]);
    Client.reset();
  });

  it('records SQL-level PREPARE names but cannot move them: they stay visible to the next connection', async () => {
    const a = await client('app_runtime');
    const b = await client('app_owner');
    await a.exec(`PREPARE tenant_rows AS SELECT id FROM items ORDER BY id`);
    await b.rows('SELECT 1');
    expect(a.conn.state.sqlPreparedNames).toEqual(['tenant_rows']);
    // pg_prepared_statements keeps the whole query string a PREPARE arrived in, so re-running it on swap-in could
    // repeat other statements; the names have to be namespaced by the rewrite layer instead (see the spike report).
    expect(await b.rows(`SELECT name FROM pg_prepared_statements WHERE from_sql`)).toEqual([{ name: 'tenant_rows' }]);
    await b.exec('DEALLOCATE tenant_rows');
  });

  it('measures the swap: median of 1000 alternating swaps', async () => {
    const a = await client('app_runtime');
    const b = await client('deployer');
    await a.exec(`SET app.current_tenant = 'a'; SET search_path = public; SET statement_timeout = '9s'`);
    await b.exec(`SET ROLE app_owner; SET app.current_tenant = 'b'; SET work_mem = '16MB'; SET TimeZone = 'UTC'`);
    const median = (values: number[]): number => {
      const sorted = [...values].sort((x, y) => x - y);
      return sorted[Math.floor(sorted.length / 2)] ?? 0;
    };
    const percentile = (values: number[], p: number): number => [...values].sort((x, y) => x - y)[Math.floor(values.length * p)] ?? 0;
    for (let i = 0; i < 100; i++) await SessionSwapService.swap(engine, ctx, i % 2 ? b.conn : a.conn, i % 2 ? a.conn : b.conn);
    const swaps: number[] = [];
    let holder = a.conn;
    for (let i = 0; i < 1000; i++) {
      const next = holder === a.conn ? b.conn : a.conn;
      const started = performance.now();
      await SessionSwapService.swap(engine, ctx, holder, next);
      swaps.push(performance.now() - started);
      holder = next;
    }
    const baseline: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const started = performance.now();
      await engine.query('SELECT 1');
      baseline.push(performance.now() - started);
    }
    const restoreOnly: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const started = performance.now();
      await SessionSwapService.restore(engine, ctx, i % 2 ? a.conn.state : b.conn.state);
      restoreOnly.push(performance.now() - started);
    }
    const captureOnly: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const started = performance.now();
      await SessionSwapService.capture(engine, ctx);
      captureOnly.push(performance.now() - started);
    }
    // What a capture costs without the pg_settings scan, reading only names known in advance (the alternative design).
    const known = ['search_path', 'statement_timeout', 'work_mem', 'TimeZone', ...ctx.customGucNames];
    const lightSql = `SELECT session_user::text, current_setting('role'), ${known.map((n) => `current_setting('${n}', true)`).join(', ')}`;
    const lightCapture: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const started = performance.now();
      await engine.query(lightSql);
      lightCapture.push(performance.now() - started);
    }
    const report = {
      swapMedianMs: Number(median(swaps).toFixed(3)),
      swapP95Ms: Number(percentile(swaps, 0.95).toFixed(3)),
      restoreOnlyMedianMs: Number(median(restoreOnly).toFixed(3)),
      captureOnlyMedianMs: Number(median(captureOnly).toFixed(3)),
      lightCaptureMedianMs: Number(median(lightCapture).toFixed(3)),
      selectOneMedianMs: Number(median(baseline).toFixed(3)),
      customGucNames: ctx.customGucNames.size,
    };
    process.stdout.write(`SWAP_TIMING ${JSON.stringify(report)}\n`);
    // Generous bound: the number that matters is the one printed above and recorded in the spike report.
    expect(report.swapMedianMs).toBeLessThan(20);
    expect(await rows<Who>(engine, WHO_SQL)).toHaveLength(1);
  });
});
