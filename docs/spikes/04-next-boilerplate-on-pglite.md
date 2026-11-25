# Spike 4: next-boilerplate's schema on PGlite 0.5.16

## Goal

Find out whether next-boilerplate's database deploy runs on PGlite 0.5.16 (PostgreSQL 18.6) with TimescaleDB absent (`DB_TIMESCALE=off`, the fallback path): every SQL migration in the order the deploy applies them, TypeORM `synchronize` from next-boilerplate's entities, and the rest of the deploy (time-series fallback, seed, post-deploy). Record every failure with file, statement, SQLSTATE and message, classify it, and list the PostgreSQL features the schema and the app rely on that a single PGlite backend may not give.

## What was built

No code in the repository. Throwaway scripts, all in `/tmp/claude-1000/-home-kuray-redis-lite/dd75f3c8-a2c6-41ac-adf5-a7b1a8a12c8f/scratchpad/spike-4-nb-deploy/`:

- `replay.mjs`: loads every `modules/<id>/server/migrations/*.sql` file from next-boilerplate (read-only) and orders them as `db.migration-files.ts` does (modules in `module.json` `dependencies.requires` order, files by name, `db:000_baseline.sql` first, `-- kind: contract` files last). It applies them to an in-process PGlite as `db.deploy.schema.ts` does (`BEGIN`, file, ledger row, `COMMIT`). If a file fails, it runs the file again one statement at a time under savepoints so that every failing statement is recorded.
- `split.mjs`: a statement splitter for that fallback. It handles quotes, `E''`, identifiers, `$tag$`, comments and `BEGIN ATOMIC … END`. It was never needed because no file failed.
- `sync/`: a scratch npm project with `@electric-sql/pglite@0.5.16`, `@electric-sql/pglite-socket@0.2.19`, `typeorm@0.3.28`, `pg@8.23.1`, `reflect-metadata@0.2.2` and `esbuild@0.28.2`.
- `nb-copy/`: a copy of next-boilerplate's `modules/**/*.{ts,json,sql}` and `tsconfig.json`, with `node_modules/@kuraykaraaslan-labs/*` linked to the copy. One entity in the copy was patched (see failure E1).
- `sync/build.mjs`: esbuild bundle of `ENTITIES` from the copy, 664 entities.
- `sync/sync.mjs`: PGlite behind pglite-socket. It runs TypeORM `synchronize` (pool `max` 10), then the SQL migrations over node-postgres, then `createSchemaBuilder().log()` to see what synchronize would still change. `--mode migrate` skips synchronize and runs the baseline. `--url` points the same run at another server.
- `sync/build-deploy.mjs` and `sync/run-deploy.mjs`: bundle next-boilerplate's own `modules/db/scripts/db-deploy.ts` from the copy (third-party packages are loaded from next-boilerplate's `node_modules`, read-only). The deploy runs twice against PGlite behind pglite-socket. Settings: `DB_TIMESCALE=off`, `NODE_ENV=development`, `FLEET_ROLE` unset (`single` role, so synchronize mode, seed on), `--allow-contract`, random throwaway `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET` and `CSRF_SECRET`, `SMTP_HOST=127.0.0.1`.
- `sync/fingerprint.mjs`: a catalog fingerprint of the user schemas with oids left out. It covers columns with types, defaults and nullability; relations with RLS, FORCE, owner and ACL; indexes; constraints; policies; function definitions (md5), `SECURITY DEFINER`, owner, ACL and `proconfig`; triggers; views; roles; memberships with `inherit` and `set`; schemas; enum and domain types; and default ACLs.
- `sync/probes.mjs`: cluster-level behaviour seen by two node-postgres connections through pglite-socket.
- Reference: a private PostgreSQL 18.6 (Ubuntu build) started with `initdb` in the scratch folder on port 55432, with `fsync=off` and `timescaledb` neither preloaded nor created (the package is installed on this machine and shows in `pg_available_extensions`, which the migrations do not check), and stopped afterwards. The same scripts ran against it, so every difference can be traced to PGlite or not.

Roles: next-boilerplate's dev setup (`docker-compose.yml`) connects as the superuser `postgres` and lets the migrations create the group roles: `tenant:122` creates `app_runtime` and `app_admin`, `db:005b` the RLS group roles, and the iot migrations create `iot_gateway`, `iot_poller` and `iot_lns`. Login roles (`<sys>_runtime`, `_admin`, …) are created afterwards by `infra/native/db-logins.sh` or `scripts/rls-staging-setup.sh`, outside the deploy. So the replay connects as PGlite's default superuser `postgres`, and no role was created beforehand. Extensions loaded: `uuid_ossp` and `btree_gist` are the only ones the migrations and the baseline create. The replay also loaded `citext`, `hstore`, `ltree`, `pgcrypto`, `pg_trgm` and `amcheck`, but nothing used them.

## Result

**PASS.** No failure caused by PGlite. The one failure (E1) is a defect in next-boilerplate's entities and happens before any SQL is sent.

These are scratch scripts, not vitest tests. Commands (from `.../scratchpad/spike-4-nb-deploy`):
`node replay.mjs --out run1.json`,
`cd sync && node sync.mjs --mode sync|migrate [--url …]`,
`node run-deploy.mjs [url]`,
`node probes.mjs`.

| # | Check | PGlite 0.5.16 | Real PostgreSQL 18.6 |
|---|---|---|---|
| 1 | SQL migrations, in-process replay (migrate mode: baseline + 420 files) | 421 / 421 files clean, 0 failed statements; 7.9 s total, of which 2.6 s engine start; baseline 2.0 s | not run in-process |
| 2 | Same over TCP (pglite-socket), migrate mode | 421 / 421, 0 failures; migrations 5.5 s | 421 / 421, 0 failures; 3.5 s |
| 3 | TypeORM 0.3.28 `synchronize`, 664 entities, over TCP | OK, 662 schema queries, 6.1 to 6.6 s | OK, 662 schema queries, 5.8 to 5.9 s |
| 4 | After synchronize: baseline recorded, 420 files applied | 420 applied, 0 failures, 3.5 s | 420 applied, 0 failures, 1.8 s |
| 5 | Catalog fingerprint, PGlite vs real (sync mode / migrate mode) | 21 127 / 21 108 lines | **identical** (diff 0 / 0) |
| 6 | next-boilerplate's own `db-deploy.ts`, run 1 (fresh): synchronize, 420 migrations, 22 time-series tables on the fallback path (12 with indexes only, 10 with hourly and daily rollups), seed (3 tenants, 3 users, 3 members), fleet tenant, 29 built-in widgets, 4 post-deploy steps | exit 0, 13.3 to 21.5 s | exit 0, 10.0 to 11.6 s |
| 7 | Same, run 2 (rerun): 421 skipped, seed skipped, widgets unchanged; synchronize drops 19 indexes and 19 CHECK constraints the migrations created (see below) | exit 0, 10.5 to 13.5 s | exit 0, 7.3 to 8.9 s |
| 8 | Deploy logs, PGlite vs real (both runs) | — | identical except host and timings |
| 9 | Catalog fingerprint after the full deploy | 21 595 lines | **identical** (diff 0) |

Things that look like failures and are the same on real PostgreSQL, so they have nothing to do with PGlite:
- Drift after migrations: TypeORM would still run 119 statements after a synchronize-mode deploy and 163 after a migrate-mode one. These drop indexes and CHECK constraints that migrations added and the entities do not declare, and change some `jsonb` defaults. The counts are identical on real PostgreSQL.
- Synchronize mode and migrate mode do not build the same schema: there are 1 148 policies after synchronize mode and 1 090 after migrate mode, and the fingerprints differ by 655 lines. Same on real PostgreSQL.
- Without `--allow-contract`, the first deploy of a fresh database stops at `db:007_tenant_databases_drop_plaintext.sql` with `REJECTED_CONTRACT_NOT_ALLOWED`. This is next-boilerplate's own rule; its demo reset passes `allowContract: true`.
- TypeORM logs `columns changed … updating` 20 times on run 1 and 73 times on run 2. Same on both engines.
- The rerun is not idempotent at the schema level. Run 2's synchronize drops 19 indexes (7 of them unique, for example `uq_fleet_deployments_plan_node`) and 19 CHECK constraints (for example `ck_fleet_deployments_status`) that the migrations created and the entities do not declare, and the migrations do not put them back because the ledger marks all 421 as applied. The fingerprint after run 2 no longer has them. The 26 `dropping …` lines in the run-2 log are identical on real PostgreSQL, so this is next-boilerplate behaviour, not PGlite's, but it removes uniqueness and validity checks on every redeploy.
- The deploy bundle stubbed one import that does not exist in next-boilerplate either: `@kuraykaraaslan-labs/common/server/generated/extensions/terms_consent.checkout_order` (`build-deploy.mjs` turns a missing `generated/extensions/*` file into an empty module). It is not schema code.

### Failures

| Id | File / step | Statement excerpt | SQLSTATE | Message | Class |
|---|---|---|---|---|---|
| E1 | TypeORM metadata build (after connecting, before any schema SQL); `modules/iot_device_settings/server/entities/iot_device_settings_sealed_value.entity.ts` (commit 6e2cc45402, 2026-11-22) | `@PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'PK_iot_device_settings_sealed_values' })` on the first of five primary columns only | none (`TypeORMError`) | `Entity IotDeviceSettingsSealedValue has multiple primary columns with different constraint names. Constraint names should be the equal.` | (e): a next-boilerplate defect. TypeORM 0.3.28's `EntityMetadataValidator` throws for any database, so a synchronize-mode deploy fails right after it connects, before any schema SQL. Patched in the scratch copy only, by giving all five columns the same name, which matches migration `iot_device_settings:008`. Not reported upstream. |

No other failure in any run. Classes (a) PGlite or WASM, (b) second database or real roles, (c) Timescale and (d) replay order: **0** each. The four Timescale-aware migrations (`telemetry:001`, `iot_telemetry:001`, `ai_firewall:001`, `iot_device:007`) take their `IF NOT EXISTS (… pg_extension … 'timescaledb')` branch and raise a `WARNING`. The deploy's time-series step reports `fallback (indexes …)` for all 26 tables.

### What a single PGlite backend does not give (probes.mjs, two connections through pglite-socket 0.2.19)

| Feature | next-boilerplate use | Observed on PGlite | Class / phase |
|---|---|---|---|
| Session advisory locks | the deploy lock `pg_try_advisory_lock(hashtext('next-boilerplate:db-deploy'))`, plus 143 non-test source files under `modules/` using `pg_advisory*` (mostly `_xact_`) | Both connections share backend pid 42. Connection B gets the lock A holds (`a: true, b: true`), and A's two unlocks both return true. **No mutual exclusion between connections.** | (b) Phase B must own session advisory locks per client |
| Transaction-scoped advisory locks, `FOR UPDATE SKIP LOCKED` (18 source files), `SERIALIZABLE` / `REPEATABLE READ` (5) | job queues, tenant ceiling, plan catalog | pglite-socket blocks every other connection while one has a transaction open. B's `SKIP LOCKED` query waited until A committed, then returned row 1 (on real PostgreSQL it would skip row 1). `SERIALIZABLE` begins and commits. | (b) Phase B: rows are never skipped, only serialised; correct but slower |
| Session state (GUCs, `application_name`, `SET SESSION AUTHORIZATION`, temp tables) | `set_config(…)` in 9 source files (RLS tenant GUCs); `SET LOCAL ROLE` in soak scripts | Visible to the other connection: A's `application_name` and `app.tenant` appear in B, B's `current_user` becomes `spike_login` after A's `SET SESSION AUTHORIZATION`, and A's temp table is visible from B | (b) Phase B lease and reset rules; Spike 2 covers role switching |
| Login roles and authentication | `DATABASE_URL` (runtime), `DATABASE_URL_ADMIN`, owner | Any user name is accepted with any password and the session runs as `postgres` (superuser), so RLS is bypassed for every client. `CREATE ROLE … LOGIN PASSWORD` works but is never checked. | (b) Phase A startup / auth, Phase C roles |
| `CREATE DATABASE` / `DROP DATABASE … WITH (FORCE)` | `scripts/iot-load/infra/db.ts` and 4 test files | Both succeed inside the one engine (`pg_database` gets the row), but a connection to `database=other` still lands in `postgres`. | (b) Phase C |
| `pg_stat_activity`, `pg_terminate_backend` | iot-load scripts and their tests | `pg_stat_activity` has 0 client backends | (b) Phase B/C must synthesise it |
| `statement_timeout` | `db.rls.ts` (`set_config('statement_timeout', …, true)`), `db.tenant-rekey.ts` | `SET statement_timeout='200ms'; SELECT pg_sleep(2)` completed after 2 002 ms with no `57014`. In-process PGlite (no socket) behaves the same: `pg_sleep(2)` ran 2 001 ms and a 9 s `generate_series` count ran to the end under a 200 ms timeout (review re-run). | (a) PGlite: there is no timer signal in WASM; postgres-lite must enforce it (worker termination, storage rule 3) |
| `LISTEN` / `NOTIFY` | none in source (the hits in 3 files are unrelated) | A `NOTIFY` from A was not delivered to B through pglite-socket. In-process `db.listen` not tested. | (b), not needed by next-boilerplate |
| `ALTER SYSTEM` | none | Accepted | — |
| Extensions | `uuid-ossp`, `btree_gist` (calendar exclusion constraint), `timescaledb` (optional) | PGlite 0.5.16 ships 37 extension tarballs in `dist/*.tar.gz`, `uuid-ossp`, `btree_gist`, `citext`, `hstore`, `ltree`, `pgcrypto`, `pg_trgm` and `amcheck` among them. **No `vector`** (a separate package; next-boilerplate stores embeddings as `real[]`, so it needs none) and **no `timescaledb`**. | (c) Phase E for timescaledb |

### Independent review (2026-11-25)

Every check above was re-run from scratch on Node 26.13.1 under a load average of about 12: the replay (421 / 421 clean, 0 failures, 10.1 s total, 2.5 s engine start, 2.7 s baseline), sync and migrate mode over pglite-socket (0 failures, 662 schema queries, drift 119 and 163, policies 1 148 and 1 090), the deploy twice on PGlite (both runs end with `[db-deploy] done.`, 420 applied then 421 skipped, ledger 421, 3 tenants, 3 users, 3 members, 29 widgets) and `probes.mjs` (every value in the table reproduced). A second private PostgreSQL 18.6 cluster was initialised for the review and the same scripts ran against it: fingerprint diffs 0 for sync mode (21 127 lines), migrate mode (21 108) and the full deploy (21 595), and the deploy logs match apart from host, timings and the process id in a deprecation warning.

Limits of the evidence: the scripts always exit 0, even when a step fails (a failed `synchronize` only sets `ok: false` in the JSON), so the 9 checks are read from their output, not asserted. The test command above covers only the PGlite side; the real-PostgreSQL runs (`--url`, `run-deploy.mjs <url>`) and the fingerprint diffs are separate manual steps.

## Decisions for the plan

- **Spike 4 passes.** PHASES.md Phase 0 item 4 can say: "next-boilerplate's full deploy (synchronize, 421 SQL migrations, time-series fallback, seed and post-deploy, run twice) completes on PGlite 0.5.16 with `DB_TIMESCALE=off`, and the resulting catalog is identical to real PostgreSQL 18.6. No PGlite-specific failure." Pinning 0.5.16 stands.
- Phase D's exit ("next-boilerplate's deploy is green without Timescale") is already met at the engine level. What is left is the wire layer, and the fingerprint diff against real PostgreSQL 18.6 (`sync/fingerprint.mjs`) can serve as its acceptance check.
- **Phase B must emulate per-client session state on the one backend.** Session advisory locks (next-boilerplate's deploy lock relies on them), GUCs, `application_name`, session authorization and temp tables all leak across connections behind pglite-socket. Add an acceptance test: two clients racing for `pg_try_advisory_lock(k)` get `true` and `false`.
- Transactions serialise the whole engine. pglite-socket 0.2.19 already queues other connections while one is inside a transaction. That is correct for `SKIP LOCKED` and advisory `_xact_` locks (no rows skipped, no deadlock) but serialises job workers. Phase B should state this, together with a long-transaction timeout.
- **`statement_timeout` is not enforced by PGlite.** postgres-lite must implement it outside the engine. A timer in the main thread can cancel the statement only by terminating the worker (storage rules 3 and 4), so the plan needs a decision: honour `statement_timeout` by killing the engine and recovering, or document it as ignored. next-boilerplate sets it in `db.rls.ts`.
- **Authentication and roles:** pglite-socket accepts any user name and password and runs everything as the superuser, so RLS is never applied to an app connection. Phase A must do startup and auth itself, and must not reuse pglite-socket's handler.
- Phase C exit stays as written: `CREATE DATABASE` makes a catalog row only, and a connection to another database name lands in `postgres`.
- The extension list for next-boilerplate is `uuid-ossp` + `btree_gist` (+ `timescaledb` in Phase E). Both ship with PGlite 0.5.16 and must be loaded in every engine postgres-lite starts, because the baseline and `calendar:001` run `CREATE EXTENSION`.
- Speed: 421 migrations take 3.5 to 5.5 s over TCP on PGlite against 1.8 to 3.5 s on real PostgreSQL, and the full first deploy 13 to 21 s against 10 to 12 s. That is acceptable for development, and the Phase C template snapshot is still worth having for test suites.

## Open questions

- E1 is a next-boilerplate bug. Should it be reported or fixed there? This spike did not touch next-boilerplate.
- A rerun of next-boilerplate's deploy in synchronize mode drops 19 migration-created indexes (7 unique) and 19 CHECK constraints and never restores them (same on real PostgreSQL). next-boilerplate's owner should know. For postgres-lite it means a fingerprint check must compare after the same number of deploy runs on both engines.
- The drift after migrations (119 or 163 statements) and the policy-count difference between synchronize and migrate mode (1 148 vs 1 090) are next-boilerplate properties, identical on real PostgreSQL. They do not affect postgres-lite, but next-boilerplate's owner may want to know.
- Not tested: next-boilerplate's runtime (requests through the app, RLS with the runtime and admin login roles), `FLEET_ROLE=node|fleet` (migrate mode with `--tenant-databases` fan-out to dedicated databases), Timescale mode, on-disk PGlite (every run here was in memory), Node 20 (all runs on Node 26.13.1), and `NOTIFY` delivery through PGlite's in-process `listen`.
- pglite-socket 0.2.19 is the version that matches PGlite 0.5.16 (peer `0.5.16`, published 2026-11-09). It was used only as a test harness. The plan is still to write postgres-lite's own wire server (Spike 1).
