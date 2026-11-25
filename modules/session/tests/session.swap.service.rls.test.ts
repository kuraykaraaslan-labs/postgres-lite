import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createEngine, inTransaction, rows, WHO_SQL, type Who } from './session.fixtures.js';

/**
 * The PostgreSQL behaviour the session swap builds on, checked on PGlite 0.5.16 itself: one backend whose
 * authenticated user is the bootstrap superuser, switched between login roles.
 */
describe('role switching on one PGlite backend', () => {
  let engine: PGlite;

  beforeAll(async () => {
    engine = await createEngine();
  });

  afterAll(async () => {
    await engine.close();
  });

  const becomeSuperuser = async (): Promise<void> => {
    await engine.exec('SET SESSION AUTHORIZATION postgres');
  };

  it('SET SESSION AUTHORIZATION changes current_user and session_user and drops superuser', async () => {
    await engine.exec('SET SESSION AUTHORIZATION app_runtime');
    expect(await rows<Who>(engine, WHO_SQL)).toEqual([{ cu: 'app_runtime', su: 'app_runtime', role: 'none', is_superuser: 'off' }]);
    await becomeSuperuser();
    expect(await rows<Who>(engine, WHO_SQL)).toEqual([{ cu: 'postgres', su: 'postgres', role: 'none', is_superuser: 'on' }]);
  });

  it('filters rows per tenant for app_runtime with a transaction-local tenant', async () => {
    await engine.exec('SET SESSION AUTHORIZATION app_runtime');
    expect(await rows(engine, 'SELECT id FROM items')).toEqual([]);
    expect(await inTransaction(engine, `SELECT set_config('app.current_tenant', 'a', true); SELECT id FROM items ORDER BY id`)).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await inTransaction(engine, `SELECT set_config('app.current_tenant', 'b', true); SELECT id FROM items ORDER BY id`)).toEqual([{ id: 3 }, { id: 200 }]);
    // set_config(..., true) ends with its transaction: nothing is visible again afterwards.
    expect(await rows(engine, `SELECT count(*)::int AS n, current_setting('app.current_tenant', true) AS t FROM items`)).toEqual([{ n: 0, t: '' }]);
    await expect(inTransaction(engine, `SELECT set_config('app.current_tenant', 'a', true); INSERT INTO items VALUES (9, 'b', 'x')`)).rejects.toMatchObject({ code: '42501' });
    await expect(rows(engine, 'ALTER TABLE items DISABLE ROW LEVEL SECURITY')).rejects.toMatchObject({ code: '42501' });
    await expect(rows(engine, 'SET ROLE app_owner')).rejects.toMatchObject({ code: '42501' });
    await becomeSuperuser();
  });

  it('applies FORCE ROW LEVEL SECURITY to the table owner', async () => {
    await engine.exec('SET SESSION AUTHORIZATION app_owner');
    expect(await rows(engine, 'SELECT count(*)::int AS n FROM items')).toEqual([{ n: 0 }]);
    expect(await inTransaction(engine, `SELECT set_config('app.current_tenant', 'a', true); SELECT count(*)::int AS n FROM items`)).toEqual([{ n: 2 }]);
    await becomeSuperuser();
    expect(await rows(engine, 'SELECT count(*)::int AS n FROM items')).toEqual([{ n: 4 }]);
  });

  it('SET ROLE switches current_user only, and RLS follows current_user', async () => {
    await engine.exec('SET ROLE app_runtime');
    expect(await rows<Who>(engine, WHO_SQL)).toEqual([{ cu: 'app_runtime', su: 'postgres', role: 'app_runtime', is_superuser: 'off' }]);
    expect(await rows(engine, 'SELECT count(*)::int AS n FROM items')).toEqual([{ n: 0 }]);
    await engine.exec('RESET ROLE');
    expect(await rows<Who>(engine, WHO_SQL)).toEqual([{ cu: 'postgres', su: 'postgres', role: 'none', is_superuser: 'on' }]);
  });

  it('lets the admin login reach the bypass policy through its group role', async () => {
    await engine.exec('SET SESSION AUTHORIZATION app_admin_login');
    expect(await rows(engine, 'SELECT count(*)::int AS n FROM items')).toEqual([{ n: 0 }]);
    expect(await inTransaction(engine, `SELECT set_config('app.bypass_rls', 'on', true); SELECT count(*)::int AS n FROM items`)).toEqual([{ n: 4 }]);
    await engine.exec('SET ROLE app_admin');
    expect(await rows<Who>(engine, WHO_SQL)).toEqual([{ cu: 'app_admin', su: 'app_admin_login', role: 'app_admin', is_superuser: 'off' }]);
    await becomeSuperuser();
  });

  it('runs SECURITY DEFINER functions as the owner, still under FORCE RLS', async () => {
    await engine.exec('SET SESSION AUTHORIZATION app_runtime');
    expect(await inTransaction(engine, `SELECT set_config('app.current_tenant', 'b', true); SELECT count_items()::int AS n`)).toEqual([{ n: 2 }]);
    expect(await inTransaction(engine, `SELECT set_config('app.current_tenant', 'b', true); SELECT current_user::text AS cu`)).toEqual([{ cu: 'app_runtime' }]);
    await becomeSuperuser();
  });

  it('keeps a leaky function behind a security_barrier view predicate', async () => {
    const seen = async (query: string): Promise<string[]> => {
      const notices: string[] = [];
      await engine.exec('SET SESSION AUTHORIZATION app_runtime');
      await engine.query(query, [], { onNotice: (n) => notices.push(n.message ?? '') });
      await becomeSuperuser();
      return notices.sort();
    };
    expect(await seen('SELECT id FROM notes_public WHERE leak_probe(visibility)')).toEqual(['saw public']);
    // Without the barrier the cheaper function is evaluated before the view's own predicate.
    expect(await seen('SELECT id FROM notes_public_plain WHERE leak_probe(visibility)')).toEqual(['saw public', 'saw secret']);
    // Over the RLS table the view adds its predicate to the tenant policy.
    await engine.exec('SET SESSION AUTHORIZATION app_runtime');
    expect(await inTransaction(engine, `SELECT set_config('app.current_tenant', 'b', true); SELECT id FROM items_low`)).toEqual([{ id: 3 }]);
    await becomeSuperuser();
  });

  it('supports GRANT role TO user WITH INHERIT and SET options (PostgreSQL 16+)', async () => {
    await engine.exec(`
      CREATE ROLE deployer LOGIN; GRANT app_owner TO deployer WITH INHERIT TRUE, SET TRUE;
      CREATE ROLE auditor LOGIN;  GRANT app_owner TO auditor WITH INHERIT FALSE, SET TRUE;
      CREATE ROLE outsider LOGIN; GRANT app_owner TO outsider WITH INHERIT FALSE, SET FALSE`);
    expect(
      await rows(engine, `SELECT member::regrole::text AS m, inherit_option, set_option FROM pg_auth_members WHERE roleid = 'app_owner'::regrole ORDER BY 1`),
    ).toEqual([
      { m: 'auditor', inherit_option: false, set_option: true },
      { m: 'deployer', inherit_option: true, set_option: true },
      { m: 'outsider', inherit_option: false, set_option: false },
    ]);
    const probe = async (login: string): Promise<{ inherits: boolean; canSet: boolean }> => {
      await engine.exec(`SET SESSION AUTHORIZATION ${login}`);
      const [priv] = await rows<{ p: boolean }>(engine, `SELECT has_table_privilege('items', 'SELECT, UPDATE') AND has_table_privilege('items', 'DELETE') AS p`);
      const owner = await rows<{ ok: boolean }>(engine, `SELECT pg_has_role('app_owner', 'USAGE') AS ok`);
      let canSet = true;
      try {
        await engine.exec('SET ROLE app_owner');
      } catch {
        canSet = false;
      }
      await becomeSuperuser();
      return { inherits: (owner[0]?.ok ?? false) && (priv?.p ?? false), canSet };
    };
    expect(await probe('deployer')).toEqual({ inherits: true, canSet: true });
    expect(await probe('auditor')).toEqual({ inherits: false, canSet: true });
    expect(await probe('outsider')).toEqual({ inherits: false, canSet: false });
  });

  it('PGlite quirk: RESET SESSION AUTHORIZATION, SET ... DEFAULT and DISCARD ALL leave the session user unchanged', async () => {
    // PGlite never sets session_authorization at backend start (its reset value is ''), so every "back to the
    // authenticated user" form is a no-op. PostgreSQL would return to the login user.
    for (const statement of ['RESET SESSION AUTHORIZATION', 'SET SESSION AUTHORIZATION DEFAULT', 'DISCARD ALL']) {
      await engine.exec('SET SESSION AUTHORIZATION app_runtime');
      await engine.exec(statement);
      expect((await rows<Who>(engine, WHO_SQL))[0]?.su).toBe('app_runtime');
    }
    await becomeSuperuser();
    expect((await rows<Who>(engine, WHO_SQL))[0]?.su).toBe('postgres');
  });

  it('PGlite gap: a non-superuser session can switch to the superuser (PostgreSQL refuses with 42501)', async () => {
    for (const escalation of [
      'SET SESSION AUTHORIZATION postgres',
      `SELECT set_config('session_authorization', 'postgres', false)`,
      `DO $$ BEGIN EXECUTE 'SET SESSION AUTHORIZATION postgres'; END $$`,
    ]) {
      await engine.exec('SET SESSION AUTHORIZATION app_runtime');
      await engine.exec(escalation);
      expect(await rows<Who>(engine, WHO_SQL)).toEqual([{ cu: 'postgres', su: 'postgres', role: 'none', is_superuser: 'on' }]);
    }
  });

  it('PGlite sends no ParameterStatus, so session changes cannot be tracked from the protocol stream', async () => {
    const text = Buffer.from(`SET SESSION AUTHORIZATION app_runtime; SET application_name = 'x'; SET search_path = public\0`);
    const message = Buffer.alloc(5 + text.length);
    message.write('Q');
    message.writeInt32BE(4 + text.length, 1);
    text.copy(message, 5);
    const result = await engine.execProtocol(new Uint8Array(message));
    expect(result.messages.map((m) => m.name)).not.toContain('parameterStatus');
    await becomeSuperuser();
    await engine.exec('RESET ALL');
  });
});
