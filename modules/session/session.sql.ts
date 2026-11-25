/** Quotes an identifier the way quote_ident does for any input. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quotes a string literal. Only used in statements that run right after RESET ALL, where standard_conforming_strings
 * is back at its default (on), so doubling single quotes is the complete escape.
 */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * GUCs the swap never copies: identity is restored by its own statements, and the transaction_* settings are
 * per transaction even when pg_settings reports them.
 */
export const UNSWAPPED_GUCS: readonly string[] = [
  'role',
  'session_authorization',
  'is_superuser',
  'transaction_isolation',
  'transaction_read_only',
  'transaction_deferrable',
];

/** One SELECT that reads the whole session state of whoever holds the backend now. */
export function captureSql(customGucNames: readonly string[]): string {
  const excluded = UNSWAPPED_GUCS.map(quoteLiteral).join(', ');
  // Names come from the validated registry (identifier characters and dots only), so they are safe to inline.
  const names = customGucNames.length ? `ARRAY[${customGucNames.map(quoteLiteral).join(', ')}]::text[]` : `ARRAY[]::text[]`;
  // Every catalog object is schema-qualified: the batch runs under the outgoing connection's search_path, and a
  // client that puts its own schema before pg_catalog could otherwise shadow current_setting() and feed the restore
  // (which runs as the superuser) whatever values it likes.
  return [
    `SELECT session_user::pg_catalog.text AS session_user, pg_catalog.current_setting('role') AS role,`,
    ` (SELECT coalesce(pg_catalog.jsonb_object_agg(name, pg_catalog.current_setting(name)), '{}'::pg_catalog.jsonb)::pg_catalog.text FROM pg_catalog.pg_settings`,
    `   WHERE source = 'session' AND name NOT IN (${excluded})) AS gucs,`,
    ` (SELECT coalesce(pg_catalog.jsonb_object_agg(n, v), '{}'::pg_catalog.jsonb)::pg_catalog.text FROM`,
    `   (SELECT n, pg_catalog.current_setting(n, true) AS v FROM pg_catalog.unnest(${names}) AS n) AS c WHERE v <> '') AS custom_gucs,`,
    ` (SELECT coalesce(pg_catalog.jsonb_agg(name ORDER BY name), '[]'::pg_catalog.jsonb)::pg_catalog.text FROM pg_catalog.pg_prepared_statements WHERE from_sql) AS sql_prepared`,
  ].join('\n');
}

/**
 * Statements that make the backend look like the given session: superuser first so RESET ALL and set_config can
 * restore SUSET settings a superuser login made, then the session user, then SET ROLE (which needs that session user).
 */
export function restoreSql(superuser: string, loginState: { sessionUser: string; role: string; gucs: Record<string, string>; customGucs: Record<string, string> }): string[] {
  const statements = [`SET SESSION AUTHORIZATION ${quoteIdent(superuser)}`, 'RESET ALL'];
  const settings = { ...loginState.gucs, ...loginState.customGucs };
  const calls = Object.entries(settings).map(([name, value]) => `pg_catalog.set_config(${quoteLiteral(name)}, ${quoteLiteral(value)}, false)`);
  if (calls.length) statements.push(`SELECT ${calls.join(', ')}`);
  if (loginState.sessionUser !== superuser) statements.push(`SET SESSION AUTHORIZATION ${quoteIdent(loginState.sessionUser)}`);
  if (loginState.role !== 'none') statements.push(`SET ROLE ${quoteIdent(loginState.role)}`);
  return statements;
}
