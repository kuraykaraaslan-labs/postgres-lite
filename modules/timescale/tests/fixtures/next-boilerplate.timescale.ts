/**
 * Verbatim copies of next-boilerplate's TimescaleDB probe and migration
 * (modules/db/server/db.timescale.ts, copied 2026-11-25). Copied rather than imported so CI does not need that
 * repository; keep the SQL byte-identical when re-syncing.
 */

export const PROBE_INSTALLED_SQL = `SELECT extversion, extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'timescaledb'`;
export const PROBE_LICENSE_SQL = `SELECT current_setting('timescaledb.license', true) AS license`;
export const AVAILABLE_IN_SERVER_SQL = `SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'`;

export const TIMESCALE_EXTENSION_SQL = `
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    NULL; -- already installed
  ELSIF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb')
        AND current_setting('shared_preload_libraries', true) NOT LIKE '%timescaledb%' THEN
    RAISE NOTICE 'timescaledb is installed but not in shared_preload_libraries: time-series tables fall back to plain tables';
  ELSIF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS timescaledb SCHEMA public;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'timescaledb is available but could not be created (%): time-series tables fall back to plain tables', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'timescaledb is not available on this server: time-series tables fall back to plain tables';
  END IF;
END
$$;
`;

export type TimescaleCapability = {
  available: boolean;
  edition: 'tsl' | 'apache' | null;
  version: string | null;
  schema: string | null;
};

export const NO_TIMESCALE: TimescaleCapability = { available: false, edition: null, version: null, schema: null };

type Runner = { query(sql: string): Promise<{ rows: unknown[] }> };

/** Same decisions as next-boilerplate's probeTimescale in mode 'auto'. */
export async function probeTimescale(db: Runner): Promise<TimescaleCapability> {
  try {
    const installed = (await db.query(PROBE_INSTALLED_SQL)).rows[0] as { extversion: string; schema: string } | undefined;
    if (!installed) return NO_TIMESCALE;
    const license = ((await db.query(PROBE_LICENSE_SQL)).rows[0] as { license: string | null } | undefined)?.license;
    return {
      available: true,
      edition: license === 'apache' ? 'apache' : 'tsl',
      version: installed.extversion,
      schema: installed.schema.replace(/^"|"$/g, ''),
    };
  } catch {
    return NO_TIMESCALE;
  }
}
