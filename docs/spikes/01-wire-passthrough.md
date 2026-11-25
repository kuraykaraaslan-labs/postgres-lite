# Spike 1: protocol passthrough

## Goal

Prove that a small TCP server can do the PostgreSQL startup phase itself and then forward complete frontend
messages to PGlite 0.5.16 (PostgreSQL 18.6) through the `EngineHandle` contract (`execProtocolRaw`), so that the
real `pg` client works unchanged, and pin down exactly what PGlite's raw protocol entry point does for the
extended protocol, pipelines, errors, COPY and startup.

## What was built

- `modules/wire/wire.codec.ts`: bounds-checked framing (startup packets, frontend frames), readers for backend output (ReadyForQuery status, ErrorResponse fields, DataRows) and builders for the backend messages the server sends itself.
- `modules/wire/wire.startup.ts`: protocol check and 3.x negotiation, startup GUCs applied in the engine with `set_config`, ParameterStatus values read from the engine, the greeting (AuthenticationOk, 15 ParameterStatus, BackendKeyData, ReadyForQuery).
- `modules/wire/wire.connection.ts`: per-connection state machine (SSLRequest/GSSENCRequest answered `N`, startup, batching of every complete message per TCP read into one engine call, Terminate, FATAL on protocol violations, session reset on disconnect); an engine gate serialises engine calls.
- `modules/wire/wire.server.ts`: `WireServer.start({ engine, host, port })` returns `{ port, host, close() }`.
- `modules/wire/wire.guard.ts`: allowlist of frontend message types that may reach PGlite, and the stopgap refusal of `COPY ... FROM STDIN`.
- `modules/wire/wire.dto.ts`: Zod schema for startup parameters (user required, GUC names validated).
- `modules/wire/wire.types.ts`, `modules/wire/wire.messages.ts`: types and the message enum.
- `modules/wire/tests/support/pglite.engine.ts`: in-memory PGlite wrapped as an `EngineHandle` (tests only; the engine module is another spike).
- `modules/wire/tests/support/raw.client.ts`: raw TCP client for byte-level tests.
- `modules/wire/tests/wire.codec.test.ts` (7 tests) and `modules/wire/tests/wire.server.test.ts` (15 tests, real PGlite, real `pg` 8.23).
- Probe scripts (not in the repo): `/tmp/claude-1000/-home-kuray-redis-lite/dd75f3c8-a2c6-41ac-adf5-a7b1a8a12c8f/scratchpad/spike-01/` (`probe.mjs`, `rest.mjs`, `copy.mjs`, `copysplit.mjs`, `misc.mjs`, `bad.mjs`).

## Result

**PASS.** `cd /home/kuray/postgres-lite && npx vitest run modules/wire`: 2 files, **22 passed, 0 failed** (about 28 s,
almost all of it one PGlite boot per test). `npx tsc --noEmit` reports no error in `modules/wire`.

Covered with the `pg` client: `SELECT 1`; `SELECT $1::int + 1` (extended protocol); errors (simple and extended)
followed by a successful query on the same connection; a three-statement simple query returning three results;
a `pg.Pool` running 5 queries in sequence; a second connection after the first closed, which sees a fresh
session (application_name and TimeZone reset, temp table gone, the first client's open transaction rolled back);
ParameterStatus from `SET application_name` reaching the client. With a raw socket: startup and a query written
one byte per write; a pipeline of 12 messages in one write (error, skip to Sync, two more batches) giving
`1 E Z 1 2 D C Z T D C Z`; SSLRequest answered `N`; protocol 3.2 plus a `_pq_.` option answered with
NegotiateProtocolVersion (minor 0, 1 option); protocol 4.0 refused (FATAL 0A000); an unknown startup GUC refused
(FATAL 42704); Terminate closes the socket; a PasswordMessage after startup ends the session with FATAL 08P01
and the engine keeps serving; `COPY FROM STDIN` refused with 0A000 (simple, extended, behind a leading comment,
after a `'--'` literal, and inside a transaction,
which then reports 25P02 like any failed transaction); `COPY TO STDOUT` passes through (`H d c C Z`).

Measured (Linux, WSL2, Node 26, in-memory PGlite, one client):

| Measure | Value |
|---|---|
| `pg` connect (startup through the server) | 37.6 ms (first connect; review re-run: 2.1 to 3.2 ms warm) |
| `SELECT 1`, simple protocol, through the server | 0.107 ms avg over 2 000 |
| `SELECT $1::int`, extended protocol, through the server | 0.141 ms avg over 2 000 |
| Same `SELECT 1` straight into the engine (`execProtocolRawStream`) | 0.019 ms avg |
| 5 000 rows of 1 KB through the server | 16.6 ms |
| 5 MB text parameter through the server | 84.2 ms |
| `execProtocolRaw` `SELECT 1`, default `syncToFs: true` vs `false` (memory fs) | 0.071 vs 0.038 ms |
| Heap growth over 50 000 calls: `execProtocolRaw` vs `execProtocolRawStream` | 24.3 MB vs 0.0 MB |

### PGlite 0.5.16 `execProtocolRaw` semantics (measured, plus its source in `dist/chunk-XZUEO4BZ.js`)

- **One call runs the backend main loop until the input is consumed**, then calls
  `PostgresSendReadyForQueryIfNecessary` and flushes. It returns every byte the backend wrote, in order, as one
  copied `Uint8Array` (safe to keep across calls). Flush (`H`) changes nothing: output is always flushed at the end.
- **Without Sync no ReadyForQuery is produced.** `P` alone returns `1`; `B D E` alone returns `2 T D C`; a later
  `S` alone returns `Z`. Portal and statement state persist between calls, so a batch can be split at any message
  boundary (except COPY FROM, below). `Execute` with a row limit returns `s` (PortalSuspended) and a later `E` in a
  separate call continues the portal.
- **Pipelines:** `P B E S P B E S` in one call returns both results, each ending with its own `Z`.
- **Errors skip to Sync exactly like a real backend.** An error in `P`/`B`/`E` drops the following messages until
  `S`, then `Z` (`I`, or `E` inside a transaction block). This holds across calls: an error without Sync, then
  `B E` in a second call (returns nothing), then `S` in a third (returns `Z`). A multi-statement simple query stops
  at the failing statement and ends with `Z`. In a transaction, later statements get 25P02 until ROLLBACK.
- **Malformed bodies** in a well-framed message (Query without NUL, truncated Bind) give ErrorResponse 08P01 and
  the engine keeps working.
- **Messages that kill the engine:** an unknown message type (`z`) and a PasswordMessage (`p`) after startup make
  the call never return: a synchronous spin that blocks the Node event loop (timers do not fire). PostgreSQL
  would end the session with FATAL; PGlite cannot end its single session. The server must never forward them.
- **Special first bytes:** if the input's first byte is `X` the whole input is dropped and an empty array returned;
  if it is `0` the input is treated as a startup packet. Neither is checked per message, only at offset 0.
- **COPY TO STDOUT** works in simple and extended protocol: `H d ... c C Z`, all in one return.
- **COPY FROM STDIN works only when the COPY, its CopyData and CopyDone/CopyFail are in the same call**
  (simple: `G C Z`; extended with Sync: `1 2 G C Z`; CopyFail: `G E(57014) Z`; COPY in the middle of a batch of
  several Queries also works). A `COPY ... FROM STDIN` sent alone ends the WASM PostgreSQL: the call rejects with
  `ExitStatus { status: 1 }`, and the next call on that instance spins forever (event loop blocked). CopyData,
  CopyDone and CopyFail outside COPY are ignored (empty output), as in PostgreSQL.
- **FunctionCall (`F`)** is processed (an argument-count mismatch gave ErrorResponse 08P01, engine intact).
- **NOTIFY** to a channel the session listens on comes back inline as `A` in the same output.
- **`pg_terminate_backend(pg_backend_pid())`** only raises a warning (`could not send signal to process 42`).
- **Startup through the engine is not needed to run queries.** Queries work on a fresh `PGlite.create()` with no
  startup packet. But **without one PGlite startup the backend never reports GUC changes**: `SET application_name`
  returns `C Z` with no ParameterStatus. After one raw startup packet (first byte 0) the engine replies like a real
  server (`R`, 15 `S`, `K` with pid 42, `Z`), `SET` then returns `C S Z`, and the next Sync-ended reply carries six
  extra pending ParameterStatus messages, which is why the test engine sends one Sync after the startup and
  discards the output. Its startup reply leaves `session_authorization` empty.
- **Memory:** `execProtocolRaw` also parses every backend message into PGlite's own result collector, which is
  only reset by `execProtocol`; in raw use it grows without bound (24.3 MB per 50 000 `SELECT 1`).
  `execProtocolRawStream` with `onRawData` skips that parser (0.0 MB growth). The `onRawData` chunk is a view that
  must be copied before the next chunk.
- **`syncToFs` defaults to `true`** and roughly doubles the cost of a trivial call even on the memory fs.

## Decisions for the plan

- **Engine module (Phase 0 spike 7 / Phase A):** wrap PGlite with `execProtocolRawStream` + `onRawData` (copy each
  chunk), never `execProtocolRaw`, to avoid the unbounded result collector. Send one PGlite startup packet when
  the engine opens and discard its output plus one Sync, so GUC changes are reported. Pass `syncToFs: false`
  unless the fsync design (spike 6) needs PGlite's own sync.
- **Wire server owns startup completely**; the engine never sees a client's startup packet. Startup GUCs are
  applied with `SELECT set_config($1, $2, false)` in the engine and the reported values read back with
  `current_setting`; `session_authorization` comes from `session_user`. The greeting sends the 15 parameters
  PostgreSQL 18 sends, in its order (list in `wire.startup.ts`), not only the 11 named in Phase A.
- **Frontend message allowlist is a safety rule, not a nicety:** only `Q P B D E S H C F d c f` reach PGlite;
  anything else gets FATAL 08P01 from the server. `X` is handled by the server and never forwarded.
- **COPY FROM STDIN needs server-side buffering (Phase A).** The server must recognise the COPY before
  forwarding it, answer CopyInResponse itself, buffer CopyData until CopyDone/CopyFail (and Sync in the extended
  protocol), then send everything to the engine in one call and drop the engine's own `G` from the reply. The
  column count and format for the synthetic CopyInResponse can be learned by a probe call (`COPY ...` plus
  CopyFail, inside a savepoint when a transaction is open). Recognising the statement needs the SQL parser
  (spike 5); the spike's regex refusal is a stopgap. A memory cap for buffered COPY data needs deciding.
- **An engine that dies blocks the event loop** (after `ExitStatus`, or on a forbidden message). This confirms
  that the engine must run in a worker thread with `terminate()` as the recovery path (spike 7, storage rules 3–4).
- **Disconnect cleanup** sends `Sync`, `ROLLBACK`, `DISCARD ALL` in one call before the engine serves the next
  connection. This is enough for strictly sequential connections only. With two open connections it loses
  acknowledged data (review probe, see below), so the wire server must not be used with more than one client
  until Phase B's lease and session swap replace it.
- **Protocol 3.2:** the spike negotiates 3.2 down to 3.0 as requested. Real PostgreSQL 18 accepts 3.2 (longer
  cancel key in BackendKeyData). Since the server builds BackendKeyData itself, Phase A can accept 3.2 natively;
  this is a choice to make there.
- Batching rule that worked: all complete messages from one TCP read go to the engine in one call; output is
  written back unchanged. Pipelines and skip-to-Sync behave correctly with no protocol state in the server.

## Open questions

- Concurrent connections: the spike serialises engine calls but does not keep transactions or unsynced batches of
  two clients apart (Phase B). The review tested one case and it loses data (see Review); other interleavings
  were not tested.
- `user` and `database` startup parameters are accepted without checks (roles: spike 2; databases: Phase C). The
  `options` startup parameter (`-c name=value`) is ignored; not tested.
- CancelRequest closes the connection without acting on it; cancelling a running query was not tested (the engine
  call is synchronous, so cancel also depends on spike 7).
- Not tested: binary-format COPY, COPY through the server once buffered, notices with every field, psql and
  postgres.js clients, Node 20 (written for it; tests ran on Node 26 only), disk-backed engine, TLS.
- Whether PGlite's GUC reporting after its startup matches PostgreSQL for every GUC_REPORT parameter (only
  application_name and TimeZone were checked).

## Review (independent reviewer)

Re-ran `cd /home/kuray/postgres-lite && npx vitest run modules/wire`: 2 files, 22 passed, 0 failed (30.5 s), before
and after the fix below. `npx tsc --noEmit` reports no error in `modules/wire`. The tests use a real in-memory
PGlite (no mock); no `any`, `@ts-ignore`, `process.env` or file over 500 lines in `modules/wire`.

Numbers re-measured through the server (review probe, same machine): `SELECT 1` simple 0.118 ms, extended
0.140 ms, 5 000 rows of 1 KB 16.7 ms, 5 MB parameter 83.0 ms; these match. `pg` connect was 2.1 to 3.2 ms on a
warm server, so the 37.6 ms above is a first connect. `syncToFs` and heap numbers match the author's `rest.out`.

- **Fixed: the COPY FROM STDIN guard could be bypassed and kill the engine.** The regex only matched `COPY` at the
  start of the text or after `;`, so `/* c */ COPY t FROM STDIN` was forwarded: the client got XX000, the next
  query got "Connection terminated", and the Node process then hung (event loop blocked) until killed. The guard
  now refuses any text with the words COPY, FROM and STDIN in that order (keywords cannot be escaped, so a real
  one cannot slip through; the price is false refusals). Comment stripping was rejected because `SELECT '--';
  COPY t FROM STDIN` hides the COPY from it. Three cases were added to the existing COPY test.
- **Not fixed (Phase B): a second client silently loses the first client's committed data.** Probe: client A runs
  `BEGIN; INSERT`; client B connects, sees A's uncommitted row (count 1), and disconnects; B's cleanup `ROLLBACK`
  ends A's transaction. A's `COMMIT` then returns command tag `COMMIT` with only a notice "there is no transaction
  in progress", and the row is gone (count 0). A `pg.Pool` with more than one connection reaches this easily.
- Not fixed (noted): a client can make the server buffer up to 1 GiB per connection (the protocol's message
  limit) before anything is checked; no per-connection memory cap exists yet.
- Probe scripts: `/tmp/claude-1000/-home-kuray-redis-lite/dd75f3c8-a2c6-41ac-adf5-a7b1a8a12c8f/scratchpad/review-spike-1-wire/`
  (`concurrency.probe.test.ts`, `copycomment.probe.test.ts`, `bench.probe.test.ts`).
