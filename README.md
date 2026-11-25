# @kuraykaraaslan/postgres-lite

**Run your PostgreSQL and TimescaleDB-backed Node.js app without Docker.**

postgres-lite will be a PostgreSQL server you start with `npx`. Point `DATABASE_URL` at it and your existing code keeps working: node-postgres, TypeORM, Prisma, Drizzle, `psql`, and a TimescaleDB-compatible subset (hypertables, `time_bucket`, retention, continuous aggregates). The SQL engine is real PostgreSQL 18, from [PGlite](https://github.com/electric-sql/pglite), compiled to WASM. postgres-lite adds the network server, many connections, several databases, durable storage and the Timescale layer.

```bash
npx @kuraykaraaslan/postgres-lite --timescale
# postgres-lite listening on postgres://postgres@127.0.0.1:5432/postgres
# data: /home/you/.postgres-lite/instances/my-app-3f2a91c0
```

> [!WARNING]
> **Not usable yet.** This repository holds the design and the phase plan; no code has been written and nothing is published to npm. Everything below describes the intended behaviour. Progress is tracked in [docs/PHASES.md](docs/PHASES.md).

> [!IMPORTANT]
> **No performance guarantees.** postgres-lite aims to give the same answers PostgreSQL and TimescaleDB give. It does not aim to match their speed, and it makes **no commitment** on throughput, latency, memory use or concurrency. Don't benchmark it, load-test against it or run production traffic through it.
>
> It is meant for development, CI, tests and single-node demos.

---

## Why

- **Your stack needs PostgreSQL and TimescaleDB, your laptop doesn't have them.** Start postgres-lite with `npx` instead of installing PostgreSQL, the Timescale packages or Docker.
- **Tests that need a real database.** Mocks and SQL emulators break on the first ORM introspection query or migration. postgres-lite runs real PostgreSQL, so migrations, RLS, PL/pgSQL and `information_schema` behave as they do in production.
- **TimescaleDB in CI without Docker.** Code that calls `create_hypertable`, `time_bucket` or `add_retention_policy` runs against the Timescale-compatible layer, in both the `timescale` and the `apache` edition.
- **Same client code.** postgres-lite is a real TCP server speaking the PostgreSQL protocol, so your app, workers and migration tool can run as separate processes and share one server.

## Install

```bash
npm install --save-dev @kuraykaraaslan/postgres-lite
```

Requires Node.js 20 or newer. Pure JavaScript plus WASM: no native dependencies, works on Linux, macOS and Windows.

## Usage

### Command line

```bash
npx @kuraykaraaslan/postgres-lite --port 5432 --database my_app --timescale
```

| Option | Env variable | Default |
|---|---|---|
| `-p, --port <n>` | `POSTGRES_LITE_PORT` | `5432` |
| `-h, --host <addr>` | `POSTGRES_LITE_HOST` | `127.0.0.1` |
| `--password <pw>` | `POSTGRES_LITE_PASSWORD` | none (trust authentication) |
| `--database <name>` | `POSTGRES_LITE_DATABASE` | none; `postgres` always exists |
| `--data-dir <path>` | `POSTGRES_LITE_DATA_DIR` | see [Storage](#storage) |
| `--instance <name>` | | the current project |
| `--memory` | | off; keeps nothing on disk |
| `--timescale` | | off; installs the TimescaleDB-compatible extension in every database |
| `--timescale-license <edition>` | | `timescale` (`timescale` or `apache`) |
| `--timescale-version <v>` | | `2.31.0` |
| `--timescale-jobs <mode>` | | `auto` (`auto` or `manual`) |
| `--lock-timeout <ms>` | | `10000` |
| `--log-level <level>` | `POSTGRES_LITE_LOG_LEVEL` | `warn` (`silent`, `warn`, `info`, `debug`) |

With `--log-level warn`, any TimescaleDB function or option postgres-lite does not support is logged, so you can spot gaps quickly.

Typical `package.json` setup next to your dev server:

```json
{
  "scripts": {
    "db": "postgres-lite --database my_app --timescale",
    "dev": "concurrently \"npm:db\" \"next dev\""
  }
}
```

```bash
DATABASE_URL=postgres://postgres@127.0.0.1:5432/my_app
```

### From code

```ts
import { PostgresLite } from '@kuraykaraaslan/postgres-lite';

const server = await PostgresLite.start({ port: 0, database: 'my_app' }); // 0 = pick a free port
console.log(server.url);     // postgres://postgres@127.0.0.1:53817/my_app
console.log(server.dataDir); // where the data lives

// ... use it ...

await server.close();
```

`PostgresLite.start(options)` accepts the same options as the CLI.

### In tests (Vitest / Jest)

```ts
import pg from 'pg';
import { PostgresLite } from '@kuraykaraaslan/postgres-lite';

let server: PostgresLite;
let client: pg.Client;

beforeAll(async () => {
  server = await PostgresLite.start({ port: 0, memory: true, database: 'test' });
  client = new pg.Client(server.url);
  await client.connect();
});

afterAll(async () => {
  await client.end();
  await server.close();
});

it('counts', async () => {
  await client.query('CREATE TABLE hits (n int)');
  await client.query('INSERT INTO hits VALUES (1)');
  expect((await client.query('SELECT count(*)::int AS c FROM hits')).rows[0].c).toBe(1);
});
```

Each `start()` with `memory: true` is an isolated server, so test files never share state. Without a storage option, `start()` under a test runner uses a separate on-disk `-test` instance, never your development data.

## Storage

Data is kept on disk by default and is never lost by default.

| OS | Default location |
|---|---|
| Linux | `~/.postgres-lite` |
| macOS | `~/.postgres-lite` |
| Windows | `%LOCALAPPDATA%\postgres-lite` (inside your user folder; never copied by roaming profiles) |

- **One instance per project.** The project is found from the nearest lock file (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`) or `.git`, so two projects never share a database by accident. `--instance` picks another.
- **Durable commits.** A commit is acknowledged only after it is on disk, so it survives a crash of the process, of the OS or a power cut.
- **One server per instance.** A second server on the same instance refuses to start and tells you which process holds it.
- **Backups.** `postgres-lite backup`, `restore`, `backup prune`; a backup is taken automatically before an engine upgrade. Don't copy the folder of a running instance by hand.
- **Upgrades.** A newer engine with a different PostgreSQL major is refused until you run `postgres-lite upgrade`.
- **Memory only.** `--memory` or `{ memory: true }` keeps nothing on disk.

The full rules, and the measurements behind them, are in [docs/PHASES.md, Storage and durability](docs/PHASES.md#storage-and-durability).

## Compatibility

postgres-lite reports itself as **PostgreSQL 18.6**, from PGlite 0.5.16, and its TimescaleDB layer as **2.31.0**, matching `timescale/timescaledb:2.31.0-pg18`.

Planned end-to-end tests with real clients:

| Library | Version | What will be covered |
|---|---|---|
| **node-postgres** (`pg`) | 8.23 | simple and extended query, pools, transactions, `COPY`, `LISTEN`/`NOTIFY`, cancel |
| **TypeORM** | 0.3.28 | `synchronize`, migrations, `QueryRunner` transactions |
| **Prisma** | current | `prisma migrate`, client queries |
| **Drizzle** | current | `drizzle-kit` migrations, queries |
| **postgres.js**, **psql**, **pg_dump** | current | protocol, `--schema-only` dumps |

The first real consumer is next-boilerplate: its database deploy and its TimescaleDB integration suites are the acceptance test.

### What behaves like PostgreSQL

Everything that is PostgreSQL itself, because it *is* PostgreSQL: the planner, types, constraints, RLS with `FORCE`, roles and `GRANT`, `SECURITY DEFINER`, PL/pgSQL, `information_schema` and `pg_catalog`, `set_config`, advisory locks. postgres-lite adds what PGlite leaves out:

- **Protocol:** PostgreSQL wire protocol 3.0 and 3.2, trust, cleartext, MD5 and SCRAM-SHA-256 authentication, extended query with pipelining, `COPY`, cancel requests, every error field.
- **Many connections:** connection pools work; each connection keeps its own role, settings, prepared statements, session advisory locks and `LISTEN` channels.
- **Several databases:** `CREATE DATABASE` and `DROP DATABASE … WITH (FORCE)`; roles are shared across databases as in a real cluster.

### TimescaleDB-compatible subset

A compatibility layer, not TimescaleDB itself. It follows TimescaleDB's public API and is compared against a real TimescaleDB 2.31 server; no TimescaleDB code is used.

| Area | Functions and options | Phase |
|---|---|---|
| Extension | `CREATE EXTENSION timescaledb`, `timescaledb.license` (`timescale` / `apache`), version checks | E |
| Hypertables | `create_hypertable` (`by_range`, `by_hash`, legacy form), `add_dimension`, `set_chunk_time_interval` | E |
| Chunks | `show_chunks`, `drop_chunks`, chunk privileges, size functions, `approximate_row_count` | E |
| Catalog | `timescaledb_information.hypertables`, `dimensions`, `chunks`, `jobs`, `job_stats`, `continuous_aggregates`, `compression_settings` | E, G, H |
| Queries | `time_bucket` (every overload), `first`, `last`, `histogram` | F |
| Jobs and policies | `add_job`, `alter_job`, `delete_job`, `run_job`, retention, columnstore and continuous-aggregate policies | G |
| Columnstore | `timescaledb.enable_columnstore`, `segmentby`, `orderby`, `compress_chunk` (settings and status only) | H |
| Continuous aggregates | `WITH (timescaledb.continuous)`, `refresh_continuous_aggregate`, real-time aggregates | H |
| Gap filling | `time_bucket_gapfill`, `locf`, `interpolate` | I |

Anything else raises `feature_not_supported` (`0A000`) with the function's name.

## Status

Planning. Nothing is implemented yet. The plan has nine phases, from protocol spikes to gap filling; see [docs/PHASES.md](docs/PHASES.md).

| Phase | Scope |
|---|---|
| 0 | Spikes: protocol passthrough, role switching, extension bundle, fsync, worker threads, every OS |
| A | Wire protocol, CLI, durable on-disk storage |
| B | Many connections on one engine |
| C | Databases, roles, backups, upgrades |
| D | node-postgres, TypeORM, Prisma, Drizzle, next-boilerplate deploy |
| E – I | TimescaleDB-compatible layer |

## Differences from PostgreSQL and TimescaleDB

Known by design:

| Topic | Behaviour |
|---|---|
| Performance | No guarantees of any kind (see the note at the top). |
| Concurrency | One transaction runs at a time per database; others wait. Code that waits inside a transaction for another connection gets `55P03` after `--lock-timeout` instead of waiting forever. |
| Temporary tables | Visible to every connection of the same database. |
| Chunks | Hypertables stay ordinary tables; chunks are views over time ranges. Query results match TimescaleDB, storage layout does not. |
| Compression | Settings and status only; data is not compressed. |
| Dynamic SQL | `timescaledb.*` options inside PL/pgSQL `EXECUTE` strings are not recognised. |
| Not supported | Replication, logical decoding, TimescaleDB Toolkit, Hypercore table access method, tiered storage, PostgreSQL extensions PGlite does not ship. |

## When not to use it

- **When you need performance.** Use PostgreSQL and TimescaleDB for high-volume traffic, benchmarks and load tests.
- **Production.** postgres-lite has one engine per database and no replication.
- **Today.** It does not exist yet; see [Status](#status).

## How it works

```
client ──TCP / PostgreSQL protocol──▶ wire server ──▶ engine lease (one transaction at a time)
                                          │                 │
                                          │                 ▼
                                          │        PGlite = PostgreSQL 18 (WASM),
                                          │        one per database, each in a worker thread
                                          │                 │
                                          ├──▶ rewrite layer (CREATE/DROP DATABASE, timescaledb.* options)
                                          ├──▶ TimescaleDB-compatible extension + job scheduler
                                          └──▶ storage: lock, fsync, backups ──▶ ~/.postgres-lite
```

## Development

```bash
npm install
npm test            # Vitest: protocol, storage, client and TimescaleDB suites
npm run typecheck
npm run build       # → dist/
```

## License

MIT
