import { PGlite } from '@electric-sql/pglite';

/**
 * The role layout next-boilerplate deploys (migrations 005a, 122): an owner that is neither superuser nor BYPASSRLS,
 * app_runtime NOBYPASSRLS for the app, app_admin as the cross-tenant group role reached through a login role.
 */
export const ROLE_SETUP_SQL = `
CREATE ROLE app_owner LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE app_runtime LOGIN NOBYPASSRLS;
CREATE ROLE app_admin NOLOGIN;
CREATE ROLE app_admin_login LOGIN IN ROLE app_admin;
GRANT CREATE, USAGE ON SCHEMA public TO app_owner;
SET ROLE app_owner;
CREATE TABLE items (id int PRIMARY KEY, tenant text NOT NULL, v text);
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON items
  USING (tenant = current_setting('app.current_tenant', true))
  WITH CHECK (tenant = current_setting('app.current_tenant', true));
CREATE POLICY tenant_admin_bypass ON items TO app_admin
  USING (coalesce(current_setting('app.bypass_rls', true), 'off') = 'on');
GRANT SELECT, INSERT, UPDATE, DELETE ON items TO app_runtime, app_admin;
CREATE VIEW items_low WITH (security_barrier) AS SELECT id, tenant FROM items WHERE id < 100;
GRANT SELECT ON items_low TO app_runtime;
CREATE TABLE notes (id int, visibility text);
CREATE VIEW notes_public WITH (security_barrier) AS SELECT * FROM notes WHERE visibility = 'public';
CREATE VIEW notes_public_plain AS SELECT * FROM notes WHERE visibility = 'public';
GRANT SELECT ON notes_public, notes_public_plain TO app_runtime;
CREATE FUNCTION count_items() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = public
  AS $$ SELECT count(*) FROM items $$;
CREATE FUNCTION leak_probe(text) RETURNS boolean LANGUAGE plpgsql COST 0.0000001
  AS $$ BEGIN RAISE NOTICE 'saw %', $1; RETURN true; END $$;
RESET ROLE;
INSERT INTO notes VALUES (1, 'public'), (2, 'secret');
INSERT INTO items VALUES (1, 'a', 'a1'), (2, 'a', 'a2'), (3, 'b', 'b1'), (200, 'b', 'b2');
`;

export async function createEngine(): Promise<PGlite> {
  const engine = await PGlite.create();
  await engine.exec(ROLE_SETUP_SQL);
  return engine;
}

/** Runs one statement and returns its rows, rolling back if it left a failed transaction open. */
export async function rows<T>(engine: PGlite, sql: string, params?: unknown[]): Promise<T[]> {
  try {
    return (await engine.query<T>(sql, params)).rows;
  } catch (error: any) {
    if (engine.isInTransaction()) await engine.exec('ROLLBACK');
    throw error;
  }
}

/** Runs a script in its own explicit transaction and returns the rows of its last statement. */
export async function inTransaction<T>(engine: PGlite, sql: string): Promise<T[]> {
  try {
    const results = await engine.exec(`BEGIN;\n${sql};\nCOMMIT`);
    return (results[results.length - 2]?.rows ?? []) as T[];
  } catch (error: any) {
    if (engine.isInTransaction()) await engine.exec('ROLLBACK');
    throw error;
  }
}

export type Who = { cu: string; su: string; role: string; is_superuser: string };

export const WHO_SQL = `SELECT current_user::text AS cu, session_user::text AS su, current_setting('role') AS role, current_setting('is_superuser') AS is_superuser`;
