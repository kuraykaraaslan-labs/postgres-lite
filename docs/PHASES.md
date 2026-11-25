# @kuraykaraaslan/postgres-lite: Phases

> **What:** an npm package that runs a PostgreSQL-compatible server in Node.js, with a TimescaleDB-compatible extension. Apps change nothing except `DATABASE_URL`.
> **How:** real PostgreSQL from [PGlite](https://github.com/electric-sql/pglite) (WASM) as the engine; postgres-lite owns the wire protocol, connections, sessions, databases and the Timescale shim. The same split as redis-lite's WASM Lua engine.
> **Reference:** TimescaleDB **2.31.0** on PostgreSQL 18 (`timescale/timescaledb:2.31.0-pg18`, the image next-boilerplate pins). Engine: PGlite **0.5.16** = PostgreSQL **18.6**. Result rows, SQLSTATE codes and error messages of the supported API must match it.
> **First consumer:** next-boilerplate. Its database and Timescale integration suites are the acceptance test, as BullMQ was for redis-lite.
> **Storage:** on disk by default, in a folder inside the user's home folder on every OS, one instance per project. Data is never lost by default; memory-only runs exist but must be asked for (see [Storage and durability](#storage-and-durability)).
> **Not a goal:** performance, real chunk storage, real compression. Development, CI and tests only.

---

## Method

- **Clean room.** TimescaleDB is used only as a black box to compare against, plus its public documentation. No Timescale source is copied, Apache or TSL. This keeps the package MIT and out of the Timescale License.
- **Differential tests.** Each Timescale test script runs against the reference container and against postgres-lite; rows, column types, SQLSTATE and message must be equal. The reference results are recorded once as fixtures, so normal CI runs without Docker.
- **Real PostgreSQL for everything that is not Timescale.** Planner, types, RLS, roles, PL/pgSQL, `information_schema` come from PGlite unchanged. postgres-lite never reimplements core SQL.
- **Unsupported is loud.** Any Timescale function or option that is not implemented raises `feature_not_supported` (`0A000`) with the name of the call, and is logged at `warn`, like redis-lite's unknown commands.
- **Naming.** No "timescale" in the package name (trademark). The README says "TimescaleDB-compatible subset".

## Conventions (internal-ai-rules: Code_Structure_Rules_Common → Code_Structure_Rules_TS)

- `strict: true`, no `@ts-ignore`, no `any` outside `catch`.
- Module-first layout, no `src/` wrapper: `modules/<module>/`, `libs/` for thin infrastructure (`libs/env.ts`, `libs/logger/`).
- Options and env go through one Zod schema (`libs/env.ts`; `PostgresLiteOptionsDTO` in `modules/server/server.dto.ts`). External input is checked with `safeParse`. Enums are `z.enum`; string constants go in `<module>.messages.ts`.
- Services are static classes, one default-exported class per service file, named exports for everything else.
- No logic file over 500 lines; split by responsibility, and split its tests the same way.
- Tests co-located in `modules/<module>/tests/`, Vitest, run against a real PGlite engine (never a mocked engine). File names mirror the source (`wire.codec.ts` → `wire.codec.test.ts`).
- No AI attribution in commits or PR descriptions.

```
postgres-lite/
├── index.ts                  public API: PostgresLite.start(options) → { url, close() }
├── cli.ts                    npx postgres-lite
├── libs/
│   ├── env.ts                Zod env schema (POSTGRES_LITE_*)
│   └── logger/index.ts
├── modules/
│   ├── wire/                 framing, startup, auth, simple + extended query, COPY, cancel
│   ├── session/              per-connection state, engine lease, advisory locks, LISTEN/NOTIFY
│   ├── engine/               one PGlite instance per database, role registry, snapshots
│   ├── rewrite/              statement interception (CREATE/DROP DATABASE, timescaledb.* options)
│   ├── timescale/            the extension: sql/ (control + install script), jobs scheduler, catalog
│   └── server/               TCP server, options DTO, lifecycle
└── docs/
```

---

## Storage and durability

**Rule: no data loss by default.** An acknowledged commit survives a restart, a crash of the process, and a crash of the OS or a power cut, on Linux, macOS and Windows. The rules below come from measurements on PGlite 0.5.16 and from an adversarial review on 2026-11-25 (three reviewers, each finding re-checked by a skeptic; failures reproduced by fault injection unless marked "reasoned").

### Where

| OS | Data root, inside the user's home folder |
|---|---|
| Linux | `/home/<user>/.postgres-lite` |
| macOS | `/Users/<user>/.postgres-lite` |
| Windows | `C:\Users\<user>\AppData\Local\postgres-lite` (`%LOCALAPPDATA%`) |

On Windows the root is `AppData\Local` rather than the top of the profile: a roaming profile copies the profile root file by file at sign-out and sign-in, which merges a live database from two points in time, and `AppData\Local` is excluded from roaming and from OneDrive's folder backup.

- Precedence: `--data-dir` > `POSTGRES_LITE_DATA_DIR` > default. Memory-only storage only with `--memory` / `{ memory: true }`.
- **Root validation.** The home folder must be non-empty and absolute (an empty `HOME` makes the root relative to the current directory, where `git clean` deletes it). The default root is refused, and `--data-dir` required, when Windows has loaded a temporary, `systemprofile` or service profile; when a container is detected (`/.dockerenv`, `/run/.containerenv`) and the root is not on its own mount (rebuilding the container deletes it); or when the root or a file in it belongs to another user (a `sudo` run leaves files the next normal run cannot write). Reasoned.
- Every start prints the absolute data directory, the instance and its databases; the API returns `dataDir`.

### Instances: one per project

A single machine-wide instance would put every project's `next_boilerplate` database in one place, and one project's reset or test clean-up would wipe another's. With Docker each project had its own volume; postgres-lite keeps that.

- **Default instance = the project.** The project root is the nearest directory with a lock file (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`) or `.git`, so starting from `apps/web` and from the monorepo root opens the same instance. Name: `<package name>-<first 8 hex of sha256(realpath(root))>`. Outside any project: `default`. `--instance <name>` overrides.
- **Moved or renamed project.** If an instance with the same package name records a project path that no longer exists, no new empty instance is created silently: the start stops, lists it, and asks for `--instance <name>` to adopt it.
- **Tests.** The test helper runs in memory. `PostgresLite.start()` under a test runner (`VITEST`, `JEST_WORKER_ID`, `NODE_ENV=test`) without a storage option uses a separate on-disk instance `<project>-test-<worker>`, so test clean-up never reaches development data.
- `postgres-lite instance list | remove` (remove takes a backup first), so nobody deletes folders by hand.

```
~/.postgres-lite/                      Windows: %LOCALAPPDATA%\postgres-lite\
├── instances/
│   └── <project>-<hash>/
│       ├── instance.json              layout, postgres-lite, PGlite, PostgreSQL and shim versions; project path; pending operation
│       ├── lock/                      instance lock generations (rule 2)
│       ├── roles.json                 cluster-wide role registry (Phase C)
│       ├── databases.json             database name → directory id
│       └── databases/<id>/            one PostgreSQL data directory per database, plus name.json
└── backups/<instance>/                outside the instance, survives `instance remove`
```

**Directory names never come from database names.** PostgreSQL names are case-sensitive and may contain `/` or `..`; APFS (macOS) and NTFS (Windows) are case-insensitive and APFS ignores Unicode normalisation, so `App` and `app` would share a folder, be opened by two engines, and `DROP DATABASE "App"` would delete `app` (platform behaviour reasoned; the double-open damage reproduced). So: an opaque id per database, the map in `databases.json`, the name also in each directory so the map can be rebuilt, open engines keyed by the directory's `(dev, ino)`, and deletes only of a direct child of `databases/` that the map lists.

### What PGlite does on its own (measured, PGlite 0.5.16)

| Check | Result |
|---|---|
| `kill -9` during continuous autocommit inserts, 3 rounds | No acknowledged commit lost (1 809 / 14 297 / 25 011 rows) |
| Second process on the same directory | Opens it and writes while the first writes: **no lock** |
| fsync | **Off.** PGlite starts PostgreSQL with `-F` (`fsync = off`); its Node file layer (Emscripten NODEFS) has no `fsync`, and `fdatasync` returns success without doing anything. Crash images with unsynced writes dropped: after a restart, a power cut lost all 1 010 later commits; after a checkpoint, 25 of 1 011 rows were left and an index was corrupt |
| initdb | A new database is 970 files (38 MB) written without one fsync |
| PostgreSQL `PANIC` (WAL disk full, fsync `EIO`, Windows directory fsync `EPERM`) | The engine keeps running in an undefined state: it acknowledged one more commit that was then lost, and the next statement hung at 100 % CPU, blocking the whole Node process |
| Data-file disk full | Statement fails with `53100`; nothing lost; engine keeps working |
| Directory without `PG_VERSION` (an interrupted restore) | PGlite silently runs initdb over it and opens an empty database |
| File copy of a live directory with a checkpoint during the copy | The copy opens without error but misses committed rows; heap and index disagree |

### Rules

1. **Real fsync.** Start PGlite without `-F` and with `wal_sync_method = fsync`. Add `fsync` to NODEFS's stream operations as `fs.fsyncSync(fd)` (Node maps it to `F_FULLFSYNC` on macOS and `FlushFileBuffers` on Windows); on Windows a directory fsync reports `EINVAL`, which PostgreSQL ignores for directories. Never `open_sync` (aborts PGlite) or `open_datasync` (no such flag on Windows, no drive-cache flush on macOS). Every PostgreSQL sync is then real: WAL at commit, data files and `pg_control` at checkpoint. Files written outside PostgreSQL (initdb, template copy, restore, upgrade) are fsynced one by one, with their directories, before the database is used.
2. **A live server never loses its lock.** A server is alive if its PID is alive and its recorded process start time and boot ID match. A live PID on the same host is never declared stale, whatever it is doing (a long statement, `Ctrl+Z`, laptop sleep, a debugger). The owner also holds an OS-released handle that a second server probes (abstract Unix socket on Linux, socket file on macOS, named pipe on Windows). A lock written from another PID namespace or machine (WSL vs Windows, a container, an NFS home) cannot be checked: refuse and require `--force-unlock`. Acquiring never unlinks: each attempt writes its body to a temp file and `link`s it as the next generation `lock/<n>`; the highest generation owns. Before every checkpoint and before shutdown the owner checks it still holds the highest generation, and exits without writing if not. (Reviewed: a heartbeat rule handed a paused server's instance to a second server and left the directory unopenable; unlink-and-recreate gave two owners in 15 of 80 races.)
3. **Every engine in a worker thread.** The main thread (TCP, other databases, the lock handle) never blocks on a long statement, and a stuck engine can be terminated.
4. **`PANIC` means dead.** Any `PANIC` or `FATAL` from an engine, or an `Aborted()`, ends that engine: nothing more is forwarded from it, its in-flight and queued statements fail (`53100` for a full disk, `58030` otherwise), its clients are disconnected, and the database is reopened with crash recovery once the cause is gone.
5. **Clean shutdown** on `SIGINT`, `SIGTERM`, `SIGHUP`, and on Windows `SIGBREAK` and console close: stop accepting, give open transactions a grace period, then roll them back and end those clients with `FATAL 57P01` (Phase B lease rules), `CHECKPOINT`, close every engine, release the lock.
6. **Database operations are atomic.** `CREATE DATABASE`, restore, upgrade and template copies build in `databases/.tmp-<id>/`, are opened and checked, fsynced, and swapped in by rename (the old directory to `.trash-<id>`, removed afterwards). The operation is recorded as pending in `instance.json` until it is done; a start that finds a pending operation finishes or rolls it back and names the backup. PGlite is never handed a non-empty directory without `PG_VERSION`, or one whose `PG_VERSION` differs from `instance.json`.
7. **Backups only from the lock owner.** With a server running, `postgres-lite backup` asks it over an admin channel and the server dumps each database under the engine lease; with none running, the CLI takes the lock and copies the stopped directories. Archives are written to a temp name, fsynced and renamed, then verified: loaded into a memory engine, per-table row counts compared, `amcheck` run. Each archive carries a manifest (postgres-lite, PGlite, PostgreSQL, shim and layout versions). `restore` refuses while a server runs, checks the manifest and goes through rule 6. Backups are never deleted automatically (`backup prune --keep <n>`). Copying a live instance by hand is documented as unsafe. (Reviewed: a read-only dump from a second process destroyed both the live database and the backup.)
8. **Version guard.** At start, `instance.json` and each `PG_VERSION` are checked against the running versions. Same PostgreSQL major, newer PGlite → a cold backup of the stopped directories first (no engine may open them before the backup), then open. Different PostgreSQL major, or a layout or shim version newer than this release understands → refuse, touch nothing, name the release that last wrote the instance, print the upgrade path.
9. **Upgrade across a PostgreSQL major.** `postgres-lite upgrade`: backup; dump with the old engine (the previous major's PGlite and its `pg_dump` ship as aliased dependencies, or the refusal prints the exact `npx @kuraykaraaslan/postgres-lite@<version>` command); restore with the new engine and the same shim version into a new directory; `ALTER EXTENSION timescaledb UPDATE`; compare row counts; swap by rule 6. The shim catalog must survive `pg_dump` (Phase E; reproduced: without `pg_extension_config_dump` the dump silently dropped every hypertable and job).
10. **Metadata files** (`instance.json`, `roles.json`, `databases.json`, lock bodies): temp file, fsync, rename, directory fsync (not on Windows).
11. **Permissions.** Root `0700` on Linux and macOS (it holds password hashes).
12. **Unsafe locations warned.** A data directory inside a cloud-synced folder (OneDrive, iCloud Drive, Dropbox, Google Drive) or on a network share is reported at start.
13. **Explicit deletes stay explicit.** `DROP DATABASE` deletes the data, as in PostgreSQL. A full disk on a data file fails the statement with `53100`; a full disk on the WAL is a `PANIC` (rule 4); committed data is kept in both cases.

---

## Compatibility target: what next-boilerplate uses

Taken from `modules/db/server/db.timescale.ts`, `db.time-series.ts`, `db.time-series.rollup.ts`, `db.tenant-rekey.plan.ts`, `modules/iot_telemetry/server/iot_telemetry.timescale.ts` and their tests (2026-11-25).

| Area | Calls | Phase |
|---|---|---|
| Probe | `pg_extension` (`extversion`, `extnamespace`), `pg_available_extensions`, `current_setting('timescaledb.license', true)`, `current_setting('shared_preload_libraries', true)` | E |
| Extension | `CREATE EXTENSION IF NOT EXISTS timescaledb SCHEMA public` inside a `DO` block (skipped when already installed) | E |
| Hypertables | `create_hypertable(regclass, by_range(col, interval), if_not_exists, create_default_indexes, migrate_data)`, `set_chunk_time_interval` | E |
| Catalog views | `timescaledb_information.hypertables` (incl. `compression_enabled`), `.dimensions` (`time_interval`, `dimension_number`), `.chunks` (`chunk_schema`, `chunk_name`, `is_compressed`), `.jobs` (`proc_name`, `config->>'drop_after'`), `.continuous_aggregates` | E, G, H |
| Chunks | `drop_chunks(regclass, older_than => interval)`, chunks cast to `regclass` and `REVOKE`d one by one, chunk-ACL isolation probes | E |
| Policies | `add_retention_policy` / `remove_retention_policy`, `CALL add_columnstore_policy(after =>)`, `add_continuous_aggregate_policy(start_offset, end_offset, schedule_interval)`, `alter_job(job_id, scheduled => false)` | G |
| Columnstore | `ALTER TABLE … SET (timescaledb.enable_columnstore, timescaledb.segmentby, timescaledb.orderby)`; refusal on RLS tables | H |
| Continuous aggregates | `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous) AS … WITH NO DATA`; refusal on RLS sources | H |
| Queries | `time_bucket(interval, ts)`; rollups use `date_bin`, `array_agg … ORDER BY`, `LATERAL unnest`, `ON CONFLICT` (core PG) | F |
| Planned in next-boilerplate | `time_bucket_gapfill`, `locf` (`iot-telemetry/phases/03-query-api.md`) | I |
| Core PG it leans on | several login roles (`DATABASE_URL`, `_ADMIN`, owner), RLS with `FORCE`, `security_barrier` views, `SECURITY DEFINER`, `set_config(…, true)`, `GRANT role … WITH INHERIT TRUE, SET TRUE` (PG16+), `pg_advisory_xact_lock`, `CREATE DATABASE` / `DROP DATABASE … WITH (FORCE)` in tests | B, C |

Other widely used Timescale features added for general users: `time_bucket` with offset/origin/timezone and integer buckets, `first`/`last`, `histogram`, `show_chunks`, size functions, `add_job` custom jobs, `refresh_continuous_aggregate`, the legacy `timescaledb.compress` / `add_compression_policy` names.

---

## Status (2026-11-25)

| | |
|---|---|
| Repo | `kuraykaraaslan-labs/postgres-lite` cloned to `/home/kuray/postgres-lite`, empty |
| Done | this plan; storage measurements on PGlite 0.5.16 (process crash safe, no lock, `fsync = off`); adversarial durability review folded into [Storage and durability](#storage-and-durability) |
| Next | Phase 0 spikes |

---

## Phase 0: spikes (go / no-go)

Each spike gets a short result in `docs/SPIKES.md`. A failed spike changes the plan before code is written.

1. **Protocol passthrough.** A minimal TCP server that does startup itself and forwards query messages to PGlite's raw-protocol entry point (`execProtocolRaw`). Pass: node-postgres runs `SELECT 1` and a parameterised query (extended protocol).
2. **Role switching.** `SET SESSION AUTHORIZATION <non-superuser>` on the single PGlite backend makes RLS with `FORCE` apply, and switching back works. Pass: a two-role RLS probe returns the right rows.
3. **Extension bundle.** A SQL-only `timescaledb.control` + install script in a PGlite extension bundle installs with `CREATE EXTENSION timescaledb`; a custom GUC `timescaledb.license` is readable with `current_setting`.
4. **Postgres version.** Pin `@electric-sql/pglite` **0.5.16** = PostgreSQL **18.6**, the same major as next-boilerplate's reference image (checked 2026-11-25 with `SELECT version()`). 0.6.0 (2026-11-23) moves to PostgreSQL 19.0: too new to pin and a different major from the reference; revisit when Timescale ships a pg19 image. Run next-boilerplate's full deploy (synchronize + SQL migrations) against PGlite 0.5.16 and list any failure that is not about Timescale.
5. **SQL parser.** A WASM build of the real PostgreSQL parser (libpg-query) parses and deparses the statements the rewrite layer needs (Phase C, H). Measure the load time.
6. **fsync.** Implement storage rule 1 and prove it with a lost-unsynced-writes test: record which writes were fsynced, rebuild the directory as the fsynced state plus an arbitrary subset of the other writes, reopen, and require every acknowledged commit present and `amcheck` clean. Also require fsyncs of `pg_control` and data files at `CHECKPOINT`, and of every file after initdb. Measure the cost per commit. A WAL-only flush does not pass (reviewed: it lost every commit after a restart, or left 25 of 1 011 rows after a checkpoint).
7. **Engine in a worker thread.** PGlite runs in a `worker_thread` with the raw protocol passed by message; measure the overhead; `Worker.terminate()` recovers a hung engine and the directory reopens with crash recovery (storage rules 3 and 4).
8. **Every OS.** The storage suite (see Acceptance) passes on Linux, macOS and Windows, including a Windows user name with non-ASCII letters, a path near the 260-character limit, and on macOS and Windows two databases whose names differ only in case or Unicode normalisation.

## Phase A: wire protocol

- Startup: `SSLRequest` (answer `N`), `GSSENCRequest` (answer `N`), protocol 3.0 and 3.2 negotiation, `ParameterStatus` set as a real server sends it (`server_version` reports the PGlite version, `server_encoding`, `client_encoding`, `DateStyle`, `integer_datetimes`, `standard_conforming_strings`, `TimeZone`, `application_name`).
- Auth: trust (default), cleartext, MD5 and SCRAM-SHA-256 against passwords set with `CREATE/ALTER ROLE … PASSWORD`. `--password` sets the superuser password.
- Simple query and extended query (`Parse`/`Bind`/`Describe`/`Execute`/`Sync`/`Flush`/`Close`), pipelining, error recovery until `Sync`.
- `COPY FROM STDIN` / `COPY TO STDOUT` (text, csv, binary).
- `CancelRequest` with a real `BackendKeyData` per connection.
- Errors and notices with every field PostgreSQL sends (`S`, `V`, `C`, `M`, `D`, `H`, `P`, `W`, `s`, `t`, `c`, `n`, `F`, `L`, `R`).
- CLI and API: `npx postgres-lite --port 5432 --host 127.0.0.1 --password <pw> --data-dir <path> --instance <name> --memory --log-level warn`, `PostgresLite.start({ port: 0 })` → `{ url, dataDir, close() }`, env `POSTGRES_LITE_*` validated by Zod. `--database <name>` creates that database at start, like the Docker image's `POSTGRES_DB`. Storage is on disk from the first release: [Storage and durability](#storage-and-durability) rules 1–5, 10 and 11 (fsync, lock, worker threads, `PANIC` handling, clean shutdown, metadata, permissions) and the project instance ship with Phase A, not later.

**Exit:** node-postgres, postgres.js and `psql` connect and run a mixed script; protocol tests in `modules/wire/tests/`.

## Phase B: many connections on one engine

PGlite is one backend. postgres-lite makes it look like many.

- **Engine lease.** A connection holds the engine from the first statement of a transaction until `ReadyForQuery` reports idle (`I`). Others wait in FIFO order. Outside a transaction each statement takes and releases the lease. The transaction status is tracked per engine, from the engine's own `ReadyForQuery`, and the lease is handed over only when that status is `I`.
- **Every release path rolls back first.** Socket close or error, `pg_terminate_backend`, `DROP DATABASE … WITH (FORCE)`, an exception in the connection handler, and shutdown all run, in a `finally` block: stop reading the client and discard its unprocessed messages, send `ROLLBACK`, confirm status `I`, and only then hand the engine over. Shutdown ends the client with `FATAL 57P01`. (Reviewed: without this, another client's autocommit writes ran inside a dead client's open transaction and were lost after being acknowledged, and a shutdown rollback committed half of a pipelined transaction.)
- **Lease timeout.** A connection waiting longer than `--lock-timeout` (default 10 s) gets `lock_not_available` (`55P03`) naming the connection that holds the engine. This catches the one real difference from Postgres: code that waits inside a transaction for another connection deadlocks here.
- **Session swap.** On each lease change: restore the connection's role (`SET SESSION AUTHORIZATION` from the startup user, then any `SET ROLE`), its session GUCs (tracked from `ParameterStatus` and `SET`/`RESET`), and `search_path`. Transaction-local settings (`set_config(…, true)`) need no swap.
- **Prepared statements and portals.** Names are namespaced per connection in `Parse`/`Bind`/`Describe`/`Close`, so two clients can both prepare `s1`.
- **Advisory locks.** `pg_advisory_xact_lock` works natively (only one transaction runs at a time). Session-level `pg_advisory_lock` / `pg_try_advisory_lock` / `unlock` are tracked by the server per connection and released on disconnect.
- **LISTEN / NOTIFY.** The server keeps each connection's channels and delivers notifications to the right sockets after commit.
- **Introspection.** `pg_backend_pid()` returns the connection's own id; `pg_stat_activity` shows the server's connections; `pg_cancel_backend` / `pg_terminate_backend` act on them.
- **Known limit, documented.** Temporary tables are visible to every connection of the same database.

**Exit:** a test with 20 pooled connections, interleaved transactions, RLS under two roles and prepared statements with clashing names; and a test that kills a client in the middle of a transaction, runs an autocommit insert from another client, restarts the server and finds the insert.

## Phase C: databases, roles and lifecycle

- **One PGlite engine per database**, created by `CREATE DATABASE` (or `--database` at start). As in PostgreSQL, connecting to a database that does not exist fails with `3D000`; nothing is created on connect. `postgres` always exists. The rewrite layer intercepts `CREATE DATABASE` (`TEMPLATE`, `OWNER`, `IF NOT EXISTS`), `DROP DATABASE` (`IF EXISTS`, `WITH (FORCE)` closes the other connections first, through the Phase B release path) and `ALTER DATABASE … RENAME` (a change in `databases.json` only). `pg_database` is kept consistent across engines.
- **Cluster-wide roles.** Roles are per engine in PGlite but cluster-wide in PostgreSQL. `CREATE/ALTER/DROP ROLE` and `GRANT/REVOKE role` are buffered per transaction and acted on only after `COMMIT` returns idle (discarded on `ROLLBACK`). Order: origin commit → registry entry written as pending, with the origin database (atomic) → client acknowledged → replayed idempotently on every other engine → entry marked done. Every start and every database open reconciles pending entries from the origin database's `pg_authid` (never by re-running the SQL), then aligns the other engines; a role that owns objects is reported, not dropped by force.
- **Snapshots for tests.** `PostgresLite.start({ template })` and a test helper copy a prepared data directory, so a suite gets a migrated database in milliseconds instead of running migrations again. Test servers run with `memory: true`.
- **Per-database storage.** Each database lives in `databases/<id>/` of its instance, never in a folder named after the database; `CREATE DATABASE` and `DROP DATABASE` follow storage rule 6.
- **Backups, restore, version guard, upgrade, instances.** `postgres-lite backup`, `restore`, `backup prune`, `upgrade`, `instance list | remove` (storage rules 6–9).

**Exit:** next-boilerplate's `CREATE DATABASE` / `DROP DATABASE … WITH (FORCE)` test setup works.

## Phase D: client and ORM compatibility

- node-postgres 8.23 (next-boilerplate's version), TypeORM 0.3.28 (`synchronize`, migrations, `QueryRunner` transactions), Prisma Migrate, Drizzle Kit, postgres.js, `psql`, `pg_dump --schema-only`.
- next-boilerplate's full deploy against postgres-lite **without** Timescale (`DB_TIMESCALE=off`): synchronize, SQL migrations, seed.

**Exit:** a compatibility suite (`modules/server/tests/compat.*.test.ts`) per client; next-boilerplate's deploy is green.

## Phase E: Timescale extension, catalog and hypertables

- **Bundle.** `timescaledb.control` + `timescaledb--2.31.0.sql` as a PGlite extension. The reported version is configurable (`--timescale-version`, default `2.31.0`) so version checks such as next-boilerplate's columnstore check (2.18+) can be tested.
- **Pre-install.** With `--timescale` the extension is created in every new database, so next-boilerplate's migration takes the "already installed" branch and never reaches the `shared_preload_libraries` check (a postmaster setting PGlite cannot fake). `pg_available_extensions` lists it either way.
- **Edition.** `--timescale-license timescale|apache` sets `timescaledb.license`. Under `apache`, TSL functions raise the same error as real Timescale, so both of next-boilerplate's code paths can be tested.
- **Catalog.** Tables in `_timescaledb_catalog` (hypertables, dimensions, chunks), `_timescaledb_config` (jobs) and the `timescaledb_information` views built on them: `hypertables`, `dimensions`, `chunks`.
- **Dump-safe catalog.** Every catalog and config table, and its sequence, is registered with `pg_extension_config_dump` (rows the install script seeds itself are excluded by a `WHERE` filter), and relations are stored by schema and name, never by OID. Otherwise `pg_dump` (backups, `postgres-lite upgrade`) silently drops every hypertable and job (reproduced). Each shim version ships its install script and an update script from the previous one.
- **Hypertables.** `create_hypertable` in the generalised form (`by_range`, `by_hash`) and the legacy positional form, with `if_not_exists`, `create_default_indexes`, `migrate_data`; `add_dimension`; `set_chunk_time_interval`. The table stays a normal table, so OIDs, views, FKs and RLS are untouched.
- **Chunks without partitioning.** A statement-level trigger (with transition tables) records which chunk ranges hold data, aligned as Timescale aligns them. Each chunk is a view `_timescaledb_internal._hyper_<h>_<n>_chunk` over its range, owned by the hypertable owner, so `::regclass`, `SELECT` and `GRANT`/`REVOKE` on a chunk behave as next-boilerplate's chunk-ACL probes expect. `GRANT`/`REVOKE` on the hypertable is propagated to its chunks.
- **Chunk functions.** `show_chunks` and `drop_chunks` (`older_than`, `newer_than`, interval or timestamp) delete whole chunk ranges, never partial ones, so the rows left match Timescale's.
- **Sizes and counts.** `hypertable_size`, `hypertable_detailed_size`, `chunks_detailed_size`, `approximate_row_count`.
- **Refusals.** Errors Timescale gives (not a hypertable, table not empty without `migrate_data`, missing time column, wrong column type) with the same SQLSTATE and message, recorded from the reference.

**Exit:** next-boilerplate's `db.timescale.integration.test.ts` and `db.timescale.isolation.integration.test.ts` pass against postgres-lite.

## Phase F: query functions

- `time_bucket` for every overload: `interval` with `timestamptz` / `timestamp` / `date`, with `offset`, `origin` and `timezone`; integer buckets (`smallint`, `int`, `bigint`) with offset. Timescale's default origin (2000-01-03, a Monday) and its rule for month buckets.
- `first(value, time)`, `last(value, time)`, `histogram(value, min, max, nbuckets)`.
- Differential fixtures for every overload, including DST boundaries and negative timestamps.

**Exit:** every fixture matches the reference row for row.

## Phase G: jobs and policies

- Job catalog: `add_job`, `alter_job` (`scheduled`, `schedule_interval`, `config`, `next_start`), `delete_job`, `CALL run_job(id)`; `timescaledb_information.jobs`, `job_stats`, `job_errors`.
- Policies as jobs with Timescale's `proc_name` and `config` shape: `add_retention_policy` / `remove_retention_policy` (`policy_retention`, `drop_after`), `add_columnstore_policy` / `remove_columnstore_policy` and the legacy `add_compression_policy` / `remove_compression_policy` (`policy_compression`), `add_continuous_aggregate_policy` / `remove_continuous_aggregate_policy` (`policy_refresh_continuous_aggregate`).
- **Scheduler.** A Node timer loop runs due jobs as the job owner, as Timescale's background worker does, including its refusal for an owner without `LOGIN`. `--timescale-jobs auto|manual` (default `auto`); `manual` runs jobs only through `run_job`, for deterministic tests.

**Exit:** next-boilerplate's `db.time-series.rollup.integration.test.ts` passes (it uses `alter_job(… scheduled => false)` and the retention policy catalog).

## Phase H: columnstore and continuous aggregates

PostgreSQL rejects `timescaledb.*` options before any extension code runs (Timescale intercepts them in C). The rewrite layer parses these statements with the real Postgres parser and rewrites them into catalog calls:

- `ALTER TABLE … SET (timescaledb.enable_columnstore | compress, segmentby | compress_segmentby, orderby | compress_orderby, compress_chunk_time_interval)` and `RESET (…)`.
- `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous [, timescaledb.materialized_only]) AS … WITH [NO] DATA`, `ALTER MATERIALIZED VIEW … SET (timescaledb.*)`, `DROP MATERIALIZED VIEW` of a continuous aggregate.
- **Columnstore.** Settings and status only: `compression_enabled`, per-chunk `is_compressed`, `compress_chunk` / `decompress_chunk` / `convert_to_columnstore` / `convert_to_rowstore` flip flags; data stays in rows. `timescaledb_information.compression_settings`, `hypertable_columnstore_settings`.
- **Continuous aggregates.** Stored as a hypertable-backed table plus a view. `CALL refresh_continuous_aggregate(view, start, end)` re-materialises only the buckets in the window; the refresh policy does the same on schedule; `materialized_only = false` adds the real-time tail. `timescaledb_information.continuous_aggregates`. Retention policies work on them.
- **Refusals.** RLS hypertable + columnstore and RLS source + continuous aggregate raise Timescale's exact error (next-boilerplate depends on these).
- **Limit, documented.** Statements built inside PL/pgSQL with `EXECUTE` bypass the rewrite layer.

**Exit:** columnstore and continuous-aggregate fixtures match the reference; next-boilerplate's "compression/cagg refusal" tests pass.

## Phase I: gap filling

- `time_bucket_gapfill(interval, ts [, timezone] [, start, finish])` with `locf(…)` and `interpolate(…)`, by rewriting the query to `generate_series` plus a join. Start and finish come from the arguments or from simple `WHERE time >= … AND time < …` bounds; anything else raises Timescale's "missing time_bucket_gapfill argument" error.

**Exit:** next-boilerplate's planned `fill=null|previous` query and the gapfill fixtures match the reference.

---

## Acceptance (whole project)

Against `DATABASE_URL=postgres://…@127.0.0.1:<port>/…` with postgres-lite started with `--timescale`, and with no Docker:

- next-boilerplate deploy (synchronize + migrations + seed) green.
- `db.timescale.integration`, `db.timescale.isolation.integration`, `db.time-series.rollup.integration`, `telemetry.timescale.integration` (53 tests on the reference), `telemetry.tenant-purge.range.db` green.
- The same suites green with `--timescale-license apache` for the Apache code path.
- Storage suite green on Linux, macOS and Windows (CI matrix):
  - `kill -9` during writes, and the lost-unsynced-writes test (Phase 0 spike 6): no acknowledged commit lost, `amcheck` clean.
  - Fault injection: WAL disk full, fsync `EIO`, Windows directory fsync `EPERM`, WAL rename `EPERM`. No acknowledged commit lost, no acknowledgement after a `PANIC`, other databases keep working.
  - Lock: a second server is refused while the owner is busy in a long statement, paused (`SIGSTOP`) or asleep; a dead owner's lock is taken over; two servers started at the same instant end with one owner; a lock from another PID namespace needs `--force-unlock`.
  - Lease: a client killed mid-transaction never swallows another client's acknowledged write.
  - Interrupted `CREATE DATABASE`, restore and upgrade: the next start finishes or rolls back; never an empty database in place of a real one.
  - Backup taken while writing restores with every row acknowledged before it started; a backup from a second process cannot run beside a live server.
  - Two databases whose names differ only in case or normalisation stay separate; dropping one leaves the other.
  - Version guard: newer PGlite with the same major backs up first; a new major is refused untouched; `upgrade` keeps hypertables and jobs.

## Out of scope

- Throughput, latency, memory and concurrency guarantees.
- Real chunk storage, real compression ratios, `hypertable_detailed_size` numbers equal to Timescale's.
- Timescale Toolkit hyperfunctions (`time_weight`, `stats_agg`, `lttb`, …), Hypercore table access method, tiered storage, multi-node.
- Replication, logical decoding, `pg_stat_*` statistics beyond `pg_stat_activity`, Postgres extensions that PGlite does not ship.

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| PGlite moves its Postgres major (0.6.0 is PostgreSQL 19) | Results drift from the pg18 reference; a pg18 data directory cannot be opened by pg19 | Pin PGlite 0.5.x (PostgreSQL 18.6); bump only together with the reference image; the version guard refuses a major change and `postgres-lite upgrade` moves the data |
| PGlite runs with `fsync = off`, has no directory lock, and keeps running after a `PANIC` | Commits lost on an OS crash or power cut; two engines on one directory corrupt it; a commit acknowledged after a `PANIC` is lost | Storage rules 1–4, tested on every OS with fault injection; the fsync fix and the `PANIC` behaviour are also reported upstream to PGlite |
| One instance shared by projects or tests | One project's reset or test clean-up wipes another's data | One instance per project; tests in memory or in a separate `-test` instance |
| Serialised engine | Code that waits inside a transaction for another connection deadlocks | Lease timeout with a clear `55P03` naming the holder (Phase B) |
| Rewrite layer misses dynamic SQL | `EXECUTE` of a `timescaledb.*` option inside PL/pgSQL fails | Documented; optional later step: a small WASM C module with a `ProcessUtility` hook |
| Timescale changes behaviour between versions | Fixtures go stale | Fixtures are tied to `--timescale-version`; re-record on a version bump |
| Licence | Copying Timescale code would bring TSL terms | Clean-room rule in Method; only public docs and black-box results |
