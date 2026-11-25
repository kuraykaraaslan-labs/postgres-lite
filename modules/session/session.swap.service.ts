import type { Results } from '@electric-sql/pglite';
import { z } from 'zod';

import Logger from '../../libs/logger/index.js';
import { CustomGucNameSchema, extractCustomGucNames, rememberCustomGucNames } from './session.guc-names.js';
import { SessionMessages } from './session.messages.js';
import { captureSql, restoreSql } from './session.sql.js';
import type { SessionConnection, SessionEngine, SessionEngineContext, SessionState, SwapResult } from './session.types.js';

const StringMapSchema = z.record(z.string(), z.string());

const CaptureRowSchema = z.object({
  session_user: z.string().min(1),
  role: z.string().min(1),
  gucs: z.string(),
  custom_gucs: z.string(),
  sql_prepared: z.string(),
});

const RoleRowSchema = z.object({ rolsuper: z.boolean(), rolcanlogin: z.boolean() });
const SettingRowSchema = z.object({ setting: z.string() });

/** Parses a JSON text column the engine built with jsonb_object_agg / jsonb_agg. */
function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(SessionMessages.CAPTURE_INVALID);
  return parsed.data;
}

function toState(row: unknown): SessionState {
  const parsed = CaptureRowSchema.safeParse(row);
  if (!parsed.success) throw new Error(SessionMessages.CAPTURE_INVALID);
  return {
    sessionUser: parsed.data.session_user,
    role: parsed.data.role,
    gucs: parseJson(parsed.data.gucs, StringMapSchema),
    customGucs: parseJson(parsed.data.custom_gucs, StringMapSchema),
    sqlPreparedNames: parseJson(parsed.data.sql_prepared, z.array(z.string())),
  };
}

/**
 * Makes one PGlite backend serve several client connections, each with its own login role and session settings.
 * The wire layer calls swap() whenever the engine lease passes to another connection; the backend is idle then
 * (ReadyForQuery 'I'), so only session-level state has to move.
 */
export default class SessionSwapService {
  /**
   * Reads the engine's superuser and seeds the custom GUC registry from what a reopened database already holds:
   * function bodies, RLS policies, views and ALTER ROLE / DATABASE ... SET defaults.
   */
  static async open(engine: SessionEngine): Promise<SessionEngineContext> {
    const who = await engine.query<{ session_user: string }>('SELECT session_user::text AS session_user');
    const superuser = who.rows[0]?.session_user;
    if (superuser === undefined) throw new Error(SessionMessages.SUPERUSER_UNKNOWN);
    const ctx: SessionEngineContext = { superuser, customGucNames: new Set() };
    // A reopened database has functions written in an earlier run; their set_config / current_setting calls name
    // settings this run has not seen in any statement yet.
    const sources = await engine.query<{ setting: string }>(
      `SELECT prosrc AS setting FROM pg_proc WHERE prolang <> 12 AND prolang <> 13 AND prosrc ~* '(set_config|current_setting|\\mset\\M)'
       UNION ALL SELECT unnest(setconfig) FROM pg_db_role_setting
       UNION ALL SELECT concat_ws(' ', qual, with_check) FROM pg_policies
       UNION ALL SELECT definition FROM pg_views WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
    );
    for (const row of sources.rows) {
      const parsed = SettingRowSchema.safeParse(row);
      if (!parsed.success) continue;
      rememberCustomGucNames(ctx.customGucNames, extractCustomGucNames(parsed.data.setting));
      const assigned = parsed.data.setting.split('=')[0] ?? '';
      if (CustomGucNameSchema.safeParse(assigned).success) rememberCustomGucNames(ctx.customGucNames, [assigned]);
    }
    Logger.debug(SessionMessages.OPENED, { superuser, customGucNames: ctx.customGucNames.size });
    return ctx;
  }

  /**
   * A new connection's state as PostgreSQL builds it at login: the login role as session user, no SET ROLE, and the
   * ALTER ROLE / ALTER DATABASE ... SET defaults (role-and-database beats role beats database; rows are read in
   * rising precedence so a later one overwrites).
   */
  static async connect(engine: SessionEngine, ctx: SessionEngineContext, id: number, loginRole: string): Promise<SessionConnection> {
    const role = await engine.query('SELECT rolsuper, rolcanlogin FROM pg_roles WHERE rolname = $1', [loginRole]);
    const parsed = RoleRowSchema.safeParse(role.rows[0]);
    if (!parsed.success) throw new Error(SessionMessages.ROLE_NOT_FOUND);
    if (!parsed.data.rolcanlogin) throw new Error(SessionMessages.ROLE_CANNOT_LOGIN);
    const defaults = await engine.query(
      `SELECT unnest(s.setconfig) AS setting FROM pg_db_role_setting s
         LEFT JOIN pg_roles r ON r.oid = s.setrole
        WHERE (s.setrole = 0 OR r.rolname = $1)
          AND s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
        ORDER BY CASE WHEN s.setrole = 0 THEN 1 WHEN s.setdatabase = 0 THEN 2 ELSE 3 END`,
      [loginRole],
    );
    const state: SessionState = { sessionUser: loginRole, role: 'none', gucs: {}, customGucs: {}, sqlPreparedNames: [] };
    for (const row of defaults.rows) {
      const parsedRow = SettingRowSchema.safeParse(row);
      if (!parsedRow.success) continue;
      const eq = parsedRow.data.setting.indexOf('=');
      if (eq <= 0) continue;
      const name = parsedRow.data.setting.slice(0, eq);
      const value = parsedRow.data.setting.slice(eq + 1);
      if (CustomGucNameSchema.safeParse(name).success) {
        rememberCustomGucNames(ctx.customGucNames, [name]);
        state.customGucs[name] = value;
      } else {
        state.gucs[name] = value;
      }
    }
    return { id, loginRole, loginIsSuperuser: parsed.data.rolsuper, state };
  }

  /** Feeds a client statement to the custom GUC registry; returns how many new names it added. */
  static noteStatement(ctx: SessionEngineContext, sql: string): number {
    return rememberCustomGucNames(ctx.customGucNames, extractCustomGucNames(sql));
  }

  /** Reads the session state of whoever holds the backend now. */
  static async capture(engine: SessionEngine, ctx: SessionEngineContext): Promise<SessionState> {
    const result = await engine.query(captureSql([...ctx.customGucNames]));
    if (result.rows.length === 0) throw new Error(SessionMessages.CAPTURE_EMPTY);
    return toState(result.rows[0]);
  }

  /** Puts a captured state on the backend, whatever state it had before. */
  static async restore(engine: SessionEngine, ctx: SessionEngineContext, state: SessionState): Promise<void> {
    await engine.exec(restoreSql(ctx.superuser, state).join(';\n'));
  }

  /**
   * Captures the outgoing connection's session into its state object and restores the incoming one, in one round
   * trip: a simple-query batch runs as one implicit transaction, so a failed restore leaves the backend as it was.
   */
  static async swap(
    engine: SessionEngine,
    ctx: SessionEngineContext,
    outgoing: SessionConnection | null,
    incoming: SessionConnection,
  ): Promise<SwapResult> {
    if (outgoing === incoming) return { skipped: true, outgoingEscalated: false };
    const statements = restoreSql(ctx.superuser, incoming.state);
    if (outgoing !== null) statements.unshift(captureSql([...ctx.customGucNames]));
    let results: Results[];
    try {
      results = await engine.exec(statements.join(';\n'));
    } catch (error: any) {
      Logger.warn(SessionMessages.SWAP_FAILED, { connectionId: incoming.id, errorCode: typeof error?.code === 'string' ? error.code : undefined });
      throw error;
    }
    let outgoingEscalated = false;
    if (outgoing !== null) {
      const row = results[0]?.rows[0];
      if (row === undefined) throw new Error(SessionMessages.CAPTURE_EMPTY);
      outgoing.state = toState(row);
      // PostgreSQL lets only a superuser login change session_user; PGlite's backend is a superuser, so a non-superuser
      // client can reach SET SESSION AUTHORIZATION through dynamic SQL. Detected here, not prevented.
      outgoingEscalated = !outgoing.loginIsSuperuser && outgoing.state.sessionUser !== outgoing.loginRole;
      if (outgoingEscalated) Logger.warn(SessionMessages.ESCALATED, { connectionId: outgoing.id, sessionUser: outgoing.state.sessionUser });
    }
    return { skipped: false, outgoingEscalated };
  }
}
