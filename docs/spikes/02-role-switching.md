# Spike 2: role switching on one backend

## Goal

Find out whether one PGlite 0.5.16 engine (PostgreSQL 18.6, one backend, session user = the bootstrap superuser `postgres`) can serve several login roles the way next-boilerplate uses them: an owner role, `app_runtime NOBYPASSRLS`, `app_admin` reached through a login role, tables with `ENABLE` + `FORCE ROW LEVEL SECURITY` and a policy on `current_setting('app.current_tenant', true)`. Then design, build and measure the session swap a multiplexing server runs when the engine lease passes from one client connection to another.

## What was built

- `modules/session/session.types.ts`: `SessionEngine`, `SessionEngineContext`, `SessionState`, `SessionConnection`, `SwapResult`.
- `modules/session/session.messages.ts`: log and error texts (enum).
- `modules/session/session.guc-names.ts`: finds custom GUC names in SQL text (`SET`, `RESET`, `SHOW`, `set_config`, `current_setting`), Zod-validated, registry capped at 1024 names.
- `modules/session/session.sql.ts`: identifier and literal quoting, the capture `SELECT`, the restore statements.
- `modules/session/session.swap.service.ts`: `SessionSwapService` (static): `open`, `connect`, `noteStatement`, `capture`, `restore`, `swap`.
- `modules/session/tests/session.fixtures.ts`: next-boilerplate's role and RLS layout on a fresh in-memory PGlite.
- `modules/session/tests/session.swap.service.rls.test.ts`: 11 tests of PostgreSQL role and RLS behaviour on PGlite itself.
- `modules/session/tests/session.swap.service.test.ts`: 12 tests of the swap, including the timing run.
- `modules/session/tests/session.guc-names.test.ts`: 5 tests of name extraction.

## Result

**PASS**, with two PGlite gaps that the plan must handle (the escalation gap and the `RESET SESSION AUTHORIZATION` quirk below).

Command: `cd /home/kuray/postgres-lite && npx vitest run modules/session`: 3 files, **28 passed, 0 failed** (Node v26, Linux/WSL2, 2026-11-25; 26 as delivered by the author, plus 2 added in review). `npx tsc --noEmit` reports no error in `modules/session`. Node 20: not tested.

### Role and RLS behaviour on PGlite 0.5.16

| Check | Result |
|---|---|
| `SET SESSION AUTHORIZATION app_runtime` | `current_user` = `session_user` = `app_runtime`, `is_superuser` = `off` |
| `app_runtime`, no tenant | 0 rows |
| `app_runtime`, `set_config('app.current_tenant', 'a', true)` in a transaction | tenant `a` rows only; after `COMMIT` the setting is `''` and 0 rows are visible again |
| `app_runtime` inserts a row of another tenant | `42501` (`WITH CHECK`) |
| `app_runtime` `ALTER TABLE ... DISABLE ROW LEVEL SECURITY` / `SET ROLE app_owner` | `42501` both |
| Owner `app_owner` under `FORCE` | 0 rows without a tenant, 2 with tenant `a`; the superuser sees all 4 |
| `SET ROLE app_runtime` from the superuser | `current_user` changes, `session_user` stays `postgres`, RLS applies; `RESET ROLE` returns |
| `app_admin_login` | 0 rows normally, all 4 with `app.bypass_rls = on` through the `TO app_admin` policy; `SET ROLE app_admin` works |
| `SECURITY DEFINER` function owned by `app_owner` | runs as the owner and is still filtered by `FORCE` RLS (tenant `b` → 2) |
| `security_barrier` view | a cheap leaky function sees only the view's rows (`public`); on the same view without the barrier it also sees `secret` |
| `GRANT app_owner TO x WITH INHERIT TRUE, SET TRUE` / `INHERIT FALSE, SET TRUE` / `INHERIT FALSE, SET FALSE` | `pg_auth_members` shows the options; privileges inherited only with `INHERIT TRUE`; `SET ROLE` allowed only with `SET TRUE` |
| `SET SESSION AUTHORIZATION` inside a transaction that rolls back | the session user reverts, as in PostgreSQL (scratch probe only, not in the suite) |
| `SET LOCAL ROLE` | ends with the transaction (scratch probe only, not in the suite) |

### PGlite gaps found

1. **Escalation.** PGlite's authenticated user is the superuser, and PostgreSQL only checks the authenticated user. A session switched to `app_runtime` can run `SET SESSION AUTHORIZATION postgres`, `SELECT set_config('session_authorization', 'postgres', false)` or the same inside `DO $$ ... EXECUTE ... $$`, and becomes superuser. PostgreSQL refuses this with `42501` for a non-superuser login. Statement interception catches the first form only. The swap detects any form at the next lease change: the capture reads `session_user`, and `SwapResult.outgoingEscalated` is true (and logged at `warn`) when a non-superuser login has a different session user. Detection happens after the statement has run, and it can be evaded: a connection that escalates, acts and runs `SET SESSION AUTHORIZATION <its login>` before releasing the lease is not flagged (review probe: `app_runtime` escalated, ran `CREATE ROLE sneaky SUPERUSER`, switched back; the role persisted and `outgoingEscalated` was `false`; the switch-back case is in the suite).
2. **`RESET SESSION AUTHORIZATION`, `SET SESSION AUTHORIZATION DEFAULT` and `DISCARD ALL` do not change the session user.** PGlite never sets `session_authorization` at backend start (its value is `''`), so these reset it to `''` and leave the session user as it was. In PostgreSQL they return to the login user.
3. **PGlite sends no `ParameterStatus`** (checked with `execProtocol` after `SET SESSION AUTHORIZATION`, `SET application_name`, `SET search_path`). Session changes cannot be tracked from the engine's protocol stream, and the wire layer must create the `ParameterStatus` messages itself.
4. **PGlite's default `search_path` is `public`**, not `"$user", public`. Not investigated further.

### What the swap captures and restores

| State | How it is captured | How it is restored |
|---|---|---|
| Session user | `session_user` | `SET SESSION AUTHORIZATION <user>` |
| `SET ROLE` | `current_setting('role')` (`none` or the role) | `SET ROLE <role>` after the session user |
| Built-in session GUCs (`SET`, `set_config(..., false)`, `SET SESSION CHARACTERISTICS`, `SET TIME ZONE`) | `pg_settings WHERE source = 'session'`, values read with `current_setting(name)` so units round-trip (`5s`, `16MB`) | `RESET ALL`, then `set_config(name, value, false)` |
| Custom GUCs (`app.current_tenant`) | **not listed in `pg_settings` or `SHOW ALL`** (tested), so they are read by name from a registry: names found in client statements (`noteStatement`) and, at `open`, in function bodies, RLS policies, views and `ALTER ROLE/DATABASE ... SET` | same `set_config` |
| `ALTER ROLE ... SET` defaults | applied by `connect()` from `pg_db_role_setting` (role + database > role > database), because `SET SESSION AUTHORIZATION` does not apply them | part of the state |
| SQL-level `PREPARE` | names only (`pg_prepared_statements WHERE from_sql`) | **not restored** (see Decisions) |
| Protocol-level prepared statements and portals | not touched | namespaced by the wire layer (Phase B) |

All catalog functions, types and views in the capture and in `set_config` are schema-qualified with `pg_catalog` (review fix): the batch runs under the outgoing connection's `search_path`, and `SET search_path = other, pg_catalog` with an `other.current_setting(text)` function made the unqualified capture return `'spoofed'` for every setting, which the restore would then apply as the superuser or fail on (`SET ROLE spoofed`). Tested.

Order of the restore: `SET SESSION AUTHORIZATION <superuser>` first (so `RESET ALL` and `set_config` can restore settings only a superuser may set, tested with `log_statement`), `RESET ALL`, `set_config`, then the session user, then `SET ROLE`. The capture of the outgoing connection and the restore of the incoming one go to PGlite as one simple-query batch, so one round trip; the batch is one implicit transaction, and a failing restore (tested with a role that does not exist, `22023`) leaves the backend exactly as it was. `RESET ALL` leaves custom settings at `''`, not `NULL` (`current_setting(name, true)`); next-boilerplate's helpers treat both the same.

### Cost (1000 alternating swaps between two connections with a role, 4 built-in and 4 custom GUCs; in-memory engine; three runs)

Review re-run (same machine, one run): swap 1.92 to 2.04 ms (p95 2.64 to 3.24), capture 1.93 to 2.07, restore 0.12, name-only capture 0.23, `SELECT 1` 0.11 to 0.15 ms; slightly below the author's ranges, same shape. 399 settings confirmed (`SELECT count(*) FROM pg_settings`).

| Measure | Median |
|---|---|
| Full swap (capture + restore, one round trip) | **2.2 to 2.5 ms** (p95 3.4 to 4.4 ms) |
| Capture alone | 2.1 to 2.6 ms |
| Restore alone | 0.13 to 0.18 ms |
| Capture by known names only, no `pg_settings` | 0.26 to 0.35 ms |
| `SELECT 1` | 0.10 to 0.16 ms |

Almost all of the swap is the `pg_settings` scan: PostgreSQL formats all 399 settings to filter on `source`.

## Decisions for the plan

- **Phase 0 item 2 passes.** One engine serves several login roles with correct RLS, `FORCE`, `SECURITY DEFINER`, `security_barrier` and PostgreSQL 16 grant options.
- **Phase B, Session swap**, should say: per lease change, one batch: capture the outgoing connection (`session_user`, `role`, `pg_settings` with `source = 'session'`, custom GUCs by name) and restore the incoming one (`SET SESSION AUTHORIZATION <superuser>`, `RESET ALL`, `set_config` each, `SET SESSION AUTHORIZATION <login or switched user>`, `SET ROLE`). **Replace "tracked from `ParameterStatus`"**: PGlite sends none. Skip the swap when the same connection takes the lease again.
- **Custom GUC registry**: keep one per engine, fed from every client statement and seeded at engine open from `pg_proc`, `pg_policies`, `pg_views` and `pg_db_role_setting`. Names built at run time (`format('app.%s', x)`) are missed; document it as a known limit.
- **Login defaults**: the connection's start state applies `ALTER ROLE / ALTER DATABASE ... SET`, because `SET SESSION AUTHORIZATION` does not.
- **SQL-level `PREPARE` / `EXECUTE` / `DEALLOCATE` names are namespaced by the rewrite layer** (needs spike 5's parser), like protocol-level names. They cannot be moved by the swap: `pg_prepared_statements.statement` holds the whole query string the `PREPARE` arrived in (tested: `insert ...; PREPARE p1 ...; PREPARE p2 ...` shows the `INSERT` for both), so re-running it could repeat other statements.
- **Rewrite rules for session authorization**: `RESET SESSION AUTHORIZATION`, `SET SESSION AUTHORIZATION DEFAULT` and `DISCARD ALL` become "back to the connection's login role" (plus the rest of `DISCARD ALL` for that connection only). `SET SESSION AUTHORIZATION` from a non-superuser login gets `42501 permission denied to set session authorization` as in PostgreSQL.
- **Add to Known limits (README Differences and Phase B)**: roles and RLS behave as in PostgreSQL for application code, but they are not a security boundary against a client that runs dynamic SQL: `set_config('session_authorization', ...)` or `EXECUTE 'SET SESSION AUTHORIZATION ...'` reaches the superuser. The server checks at each lease change and ends a connection whose session user changed (Phase B release path), but this is best effort only: the statement has already run, and a client that switches back before releasing is not detected. Anything done as superuser (new SUPERUSER roles, ALTER ROLE, catalog changes) persists.
- **Role-level defaults and `RESET`**: defaults from `ALTER ROLE / DATABASE ... SET` are applied with `set_config` (source `session`), so `RESET <name>` / `RESET ALL` in the client returns to the server default, not to the role default as in PostgreSQL (review probe: `ALTER ROLE app_runtime SET work_mem = '16MB'`, then `SET work_mem = '32MB'; RESET work_mem` gives `4MB`; PostgreSQL gives `16MB`). The rewrite layer must map `RESET` to the connection's login defaults, or this goes into Known limits.
- **Capture SQL must stay schema-qualified** (`pg_catalog.*`), because it runs under the client's `search_path`.
- **Swap cost**: about 2.4 ms per lease change between different connections, dominated by the `pg_settings` scan. Acceptable for a dev and test tool (performance is not a goal). If it matters later, capture built-in GUCs by name as well (measured 0.3 ms), with a full scan only when a statement could have changed session state.

## Open questions

- Other per-backend state that the swap does not move, all not tested: `WITH HOLD` cursors, sequence `currval` / `lastval`, temporary tables (already a documented limit), session advisory locks and `LISTEN` (Phase B keeps them in the server), `pg_stat_*` counters.
- Can the escalation gap be closed at the engine (a PGlite build or option whose authenticated user is not a superuser while a controller can still switch users)? Not investigated.
- `SET ROLE` restore fails if the membership was revoked after the connection set it (PostgreSQL keeps the role in that case). Current behaviour: the swap throws and the backend is left unchanged; the caller should end that connection. Not tested beyond the missing-role case.
- `pg_settings` hides `GUC_SUPERUSER_ONLY` settings from a non-superuser `current_user`, so a superuser login that `SET ROLE`s to a normal role could lose such a setting at capture. Not tested.
- `statement_timeout` did not fire in a review probe (`SET statement_timeout = '1ms'; SELECT pg_sleep(0.05)` succeeded), so an outgoing connection's timeout cannot break the swap batch today; whether PGlite enforces any timeout was not investigated.
- The cost of the `pg_settings` scan under a worker thread (spike 7) and on Windows and macOS: not tested.
- A dirty-flag design (skip the full capture when a connection only ran plain DML and `SELECT`) is not safe without knowing which functions and triggers call `set_config(..., false)`; not built.
