# Spike 3: TimescaleDB-compatible extension bundle

## Goal

Prove that a SQL-only extension named `timescaledb` can be packaged as a PGlite 0.5.16 extension, installed with `CREATE EXTENSION IF NOT EXISTS timescaledb SCHEMA public` in memory and on disk, survive a reopen, and satisfy next-boilerplate's capability probe and migration exactly as they are written. Also find a way to make `current_setting('timescaledb.license', true)` return `timescale` or `apache` by default, and find out which method survives a restart of an on-disk engine.

## What was built

- `modules/timescale/sql/timescaledb.control`: `default_version = '2.31.0'`, `relocatable = false`, `superuser = true`, no `schema` (so `SCHEMA public` picks `@extschema@`).
- `modules/timescale/sql/timescaledb--2.31.0.sql`: schemas `_timescaledb_catalog`, `_timescaledb_config`, `_timescaledb_internal`, `timescaledb_information`. The table `_timescaledb_catalog.hypertable` is keyed by schema and name, and it and its sequence are registered with `pg_extension_config_dump`. `@extschema@.time_bucket(interval, timestamptz)` is written as `date_bin(width, ts, '2000-01-03 00:00:00+00')`: SQL-standard body, `IMMUTABLE STRICT PARALLEL SAFE`. The view `timescaledb_information.hypertables` reads the catalog.
- `modules/timescale/timescale.ustar.ts`: a small ustar writer with bounds checks on names (ASCII, relative, no `..`, at most 100 bytes) and on sizes. The mtime is fixed, so the output is byte-identical for the same input.
- `modules/timescale/timescale.bundle.ts`: `TimescaleBundle` (static). `entries(version)` rewrites `default_version` and publishes the script as `timescaledb--<version>.sql`. `build()` returns a gzip. `ensureFile(version, dir)` writes `<tmpdir>/postgres-lite/timescaledb-<version>-<sha16>.tar.gz` through a temp file and a rename, and reuses the file if it already exists.
- `modules/timescale/timescale.extension.ts`: `TimescaleExtension.create({ version, preinstall, bundleDir })` returns a PGlite `Extension` (`setup` → `bundlePath`, plus `init` running `CREATE EXTENSION IF NOT EXISTS timescaledb SCHEMA public` when `preinstall`). `TimescaleExtension.startParams(license, PGlite.defaultStartParams)` appends `-c timescaledb.license=<license>`.
- `modules/timescale/timescale.dto.ts`: Zod options; reuses `SemverSchema` and `TimescaleLicense` from `server.dto.ts`.
- `modules/timescale/timescale.messages.ts`: message enum.
- `modules/timescale/tests/timescale.ustar.test.ts`, `timescale.bundle.test.ts`, `timescale.extension.test.ts`: tests against a real PGlite engine.
- `modules/timescale/tests/fixtures/next-boilerplate.timescale.ts`: byte-identical copies of next-boilerplate's probe queries and `TIMESCALE_EXTENSION_SQL` (checked with `includes()` against the source file), plus the same decision logic as `probeTimescale`.

How PGlite loads extensions (read from `dist/index.cjs` and `interface-*.d.ts`): `setup(pg, emscriptenOpts)` returns `{ bundlePath?, init?, close?, namespaceObj?, emscriptenOpts?, sharedPreloadLibraries? }`. In Node, `bundlePath` must be a file that exists (`fs.existsSync(URL)`); it is gunzipped and untarred under the WASM prefix `/pglite`, so `share/postgresql/extension/*` lands in `$sharedir/extension`. `init` runs after the backend is ready, on every open. The bundle is unpacked into the in-memory WASM file system and is never written to the data directory.

## Result

**PASS.**

Test command: `cd /home/kuray/postgres-lite && npx vitest run modules/timescale`. Result: 3 files, **17 passed, 0 failed** (34.5 s). Typecheck shows no errors in `modules/timescale`.

Reviewer re-run (2026-11-25, after moving the extension tests' bundle files into a private temp folder that is removed afterwards): 3 files, **17 passed, 0 failed** (40.6 s); typecheck clean for `modules/timescale`.

Measured:
- `pg_available_extensions`: `timescaledb`, `default_version 2.31.0`, `installed_version null` before `CREATE EXTENSION`.
- After `CREATE EXTENSION IF NOT EXISTS timescaledb SCHEMA public`: `extversion 2.31.0`, `extnamespace::regnamespace = public`, `extrelocatable false`. A second `CREATE` is a no-op. With `version: '2.17.0'`: `extversion 2.17.0`.
- On disk: the extension, a catalog row and the `hypertables` view (`public`, `metrics`, owner `postgres`, `num_dimensions 1`, `compression_enabled false`) survive close and reopen. When the engine is reopened **without** the extension object, `pg_extension` still has the row and `time_bucket` still works, but `pg_available_extensions` no longer lists it.
- `pg_extension.extconfig` = `{_timescaledb_catalog.hypertable, _timescaledb_catalog.hypertable_id_seq}`, `extcondition` = `{'',''}`. pg_dump itself was not run (not tested).
- `time_bucket(w, ts) = date_bin(w, ts, '2000-01-03 00:00:00+00')` for 5 widths (`1 hour`, `15 minutes`, `1 day`, `7 days`, `1 week`) × 6 timestamps (including 1970, 1999-12-31 23:59:59.999999, a leap day and a US DST day), with session `TimeZone = America/Los_Angeles`: 30 out of 30 equal. These 30 checks hold by construction (the function body is that same `date_bin` call); they only show the UTC origin does not move with the session time zone. The two fixed values below are the real assertions. `time_bucket('1 week', '2026-11-25 12:00+00')` = `2026-11-23 00:00:00+00` (a Monday). `provolatile = i`, `proisstrict = true`. Not compared with real TimescaleDB (no reference run in this spike). Month widths raise date_bin's error (not handled; Phase F).
- Bundle: 1 204 bytes gzip. PGlite start with the bundle versus without, 3 runs each: 2 343 / 2 028 / 2 098 ms vs 2 932 / 2 159 / 1 917 ms, so the difference is within noise. `CREATE EXTENSION`: 14.6 to 19.5 ms.

`timescaledb.license`, on PGlite 0.5.16, on disk, close then reopen:

| Method | Same session | After reopen | Notes |
|---|---|---|---|
| startup `-c timescaledb.license=apache` (via `startParams`) | `apache` | only if passed again (`null` without it) | Works in memory and on disk. Wins over `postgresql.auto.conf`. A session `SET` can override it; `RESET ALL` and `DISCARD ALL` return to it. |
| `ALTER SYSTEM SET` | `null` (also after `pg_reload_conf()`) | `apache` | Written to `postgresql.auto.conf`, read at start. On disk only; lost in memory mode. |
| `ALTER DATABASE postgres SET` | `''` | `null` | Stored in `pg_db_role_setting`, **never applied**: PGlite's single-user backend does not process db/role settings. |
| `ALTER ROLE postgres SET` | (not checked) | `null` | Same as above. |
| extension script | not possible | not possible | `ALTER SYSTEM` cannot run inside a transaction; `ALTER DATABASE` is ignored (see above). |
| `-c shared_preload_libraries=timescaledb` | PGlite fails to start ("PGlite failed to initialize properly") | | There is no `timescaledb.so` to load. |

next-boilerplate (`/home/kuray/next-boilerplate/modules/db/server/db.timescale.ts`), run both through the test fixture and, in a scratch script, by importing the real file read-only through Node type stripping. Both gave the same results. The author's scratch script pre-installed with an explicit `CREATE EXTENSION` after start; the reviewer repeated the pre-installed `tsl` row with the real file and the `init` hook and got the same probe result and no notice. The fixture's three probe queries and `TIMESCALE_EXTENSION_SQL` were checked byte-identical against the source by the reviewer; the fixture's `probeTimescale` is a re-implementation, not a copy.

| Engine | `timescaleAvailableInServer` | probe before | `TIMESCALE_EXTENSION_SQL` | probe after |
|---|---|---|---|---|
| not pre-installed, `-c license=timescale` | `true` | `available:false` | NOTICE `timescaledb is installed but not in shared_preload_libraries: time-series tables fall back to plain tables`; extension not created | `available:false` |
| pre-installed (`init`), `license=timescale` | `true` | `{available:true, edition:'tsl', version:'2.31.0', schema:'public'}` | no notice (already-installed branch) | same |
| pre-installed, `license=apache` | `true` | `{available:true, edition:'apache', version:'2.31.0', schema:'public'}` | no notice | same |

`versionAtLeast('2.31.0', MIN_TIMESCALE_COLUMNSTORE)` = `true`.

## Decisions for the plan

- **Bundle format confirmed.** A runtime-built ustar `.tar.gz` holding only `share/postgresql/extension/timescaledb.control` and `timescaledb--<version>.sql` works. No C, no `.so`, no build step. Phase E can use `TimescaleExtension.create()` as written.
- **The bundle must be passed on every open.** It lives in PGlite's WASM share directory, not in the data directory. Without it the installed extension keeps working, but `pg_available_extensions` loses it, and with it `ALTER EXTENSION UPDATE` and the control file that pg_dump/restore need. The engine module should always register the extension when `--timescale` is on, and it must also register it for a data directory that already has `timescaledb` in `pg_extension`, so a restart without `--timescale` does not orphan it (PHASES.md storage rule 9 / Phase E).
- **Pre-install is required for next-boilerplate.** Without it, the migration stops at the `shared_preload_libraries` check, and that setting cannot be faked (PGlite refuses to start). Pre-install through the extension's `init` hook (`CREATE EXTENSION IF NOT EXISTS timescaledb SCHEMA public` on each open) works in memory and on disk and is idempotent. Phase E "Pre-install" should say: done in the PGlite extension `init`, once per engine (that is, per database).
- **License: startup `-c` on every open is the mechanism.** `--timescale-license` → `startParams = [...PGlite.defaultStartParams, '-c', 'timescaledb.license=<v>']`. The flag is the source of truth on every start. `ALTER SYSTEM` also persists, but only on disk and it loses to `-c`, so it is not needed. PHASES.md Phase E "Edition" should name this mechanism. Because `startParams` replaces PGlite's defaults, engine code must always spread `PGlite.defaultStartParams` (this also matters for spike 6's fsync params).
- **New finding for Phases B and C:** PGlite ignores `ALTER DATABASE … SET` and `ALTER ROLE … SET` at session start: the values are stored in `pg_db_role_setting` but never applied. Real PostgreSQL applies them at connection start, and apps use them (for example `ALTER ROLE app SET search_path`). The session layer must read `pg_db_role_setting` for (database, role) and apply the values with `SET` when a connection starts. Add this to the Phase B/C session list.
- `time_bucket(interval, timestamptz)` as `date_bin(…, '2000-01-03 00:00:00+00')` is correct for fixed-width buckets and is independent of the session time zone. Phase F still owns months, `offset`, `origin`, `timezone` and the other overloads.
- **Packaging:** `sql/` is read at runtime from `__dirname/sql`. `tsc` does not copy it into `dist/`, so `tsconfig.build.json` or a build script must copy `modules/timescale/sql/` (or the SQL must be embedded as TS strings). Decide this in Phase A packaging.

## Open questions

- Control file attributes (`relocatable`, `superuser`, `trusted`) and the exact column types of `timescaledb_information.hypertables` were not compared with `timescale/timescaledb:2.31.0-pg18` (not tested). Real Timescale may be `trusted`, which would matter for a non-superuser `DATABASE_URL_ADMIN` once roles exist (Phase B).
- In real Timescale, `timescaledb.license` is defined by the C library. Whether a session `SET timescaledb.license` is refused there, and with which error, was not tested. Here a session can override it.
- The bundle cache location (`os.tmpdir()/postgres-lite`) versus the instance root: a shared temp folder is fine for a 1.2 KB deterministic file, but the plan may prefer `<data root>/cache`. Windows was not tested.
- pg_dump of the catalog rows (`extconfig`) was not run; this needs a pg_dump tool for PGlite (Phase E / storage rule 9).
- `ALTER EXTENSION timescaledb UPDATE` between shim versions: an on-disk database created with version `2.17.0` and reopened with the default bundle keeps `extversion 2.17.0` (`pg_available_extensions` shows default `2.31.0`, installed `2.17.0`, and the probe reports `2.17.0`); `ALTER EXTENSION timescaledb UPDATE` fails with `extension "timescaledb" has no update path from version "2.17.0" to version "2.31.0"`. Changing `--timescale-version` on an existing data directory therefore needs update scripts or a rule; Phase E must decide.
- Pre-install failure is fatal to the open: on an on-disk database that already has a schema `_timescaledb_catalog` (not created by the extension), opening with `preinstall: true` makes `waitReady` reject with `schema "_timescaledb_catalog" already exists`, and the PGlite instance is left with `closed = false`. User data was intact on a later open without the extension. Phase E must decide whether pre-install errors stop the server or are logged and skipped, and the engine must close the instance when `waitReady` rejects. Tested by the reviewer in a scratch test only.
