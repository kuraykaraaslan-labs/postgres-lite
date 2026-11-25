# Spike 7: engine in a worker thread

## Goal

Run each PGlite engine in a `worker_thread` behind the existing `EngineHandle` contract (`execProtocolRaw(Uint8Array) → Promise<Uint8Array>`, `close()`), passing raw protocol bytes by message with transferred `ArrayBuffer`s. Prove storage rules 3 and 4 hold: a statement that hangs or spins does not block the main thread (a timer keeps firing), `Worker.terminate()` ends it, and the on-disk directory reopens with crash recovery and no acknowledged commit lost. Measure the per-query round-trip overhead against an in-process engine, and make the worker entry run both from TypeScript source under Vitest and from compiled `dist/`.

## What was built

- `modules/engine/engine.host.ts`: `EngineHost.start(storage, options)` (default export, static) and `WorkerEngine` (implements `EngineHandle`, plus `terminate()`, `alive`, `threadId`); optional `startTimeoutMs`.
- `modules/engine/engine.worker.ts`: worker entry, `EngineWorker` static class; one engine per worker, requests handled one at a time in arrival order.
- `modules/engine/engine.worker-path.ts`: `EngineWorkerPath.entry()` / `spawn()`: chooses the built `.js` entry or the TypeScript source loader.
- `modules/engine/engine.dto.ts`: Zod schemas of the host↔worker messages (`start`, `exec`, `close` / `started`, `start-failed`, `result`, `error`, `closed`); both sides `safeParse` what they receive.
- `modules/engine/engine.open.ts`, `engine.fsync.ts`: shared with spike 6; the worker opens its engine with `EngineOpen.open`, so worker engines are durable by default.
- `modules/engine/tests/engine.host.test.ts`: clean run and close, two hang scenarios with terminate and reopen, overhead benchmark.
- `modules/engine/tests/support/protocol.ts`: builds a simple `Query` message and reads `DataRow`, `CommandComplete`, `ErrorResponse`, `ReadyForQuery`.

### Bytes across the thread

Host → worker: the caller's bytes are copied (`slice()`) and the copy's `ArrayBuffer` is transferred, so the caller's buffer stays usable (tested by sending the same `Uint8Array` twice). Worker → host: PGlite 0.5.16's `execProtocolRaw` returns a fresh `Uint8Array` of exact size (`new Uint8Array(buf.subarray(0, n))` in `dist/index.cjs`), which is transferred without a copy; any other view is copied first, so PGlite's internal buffers are never detached.

### Worker entry resolution

- **Built (`dist/modules/engine/engine.worker.js`, CommonJS):** `EngineWorkerPath.entry()` finds `engine.worker.js` next to `engine.worker-path.js` (`__dirname`) and starts it with `new Worker(file)`. Verified by compiling the engine module with the repo's `tsconfig.json` settings into the scratchpad and running `EngineHost.start` + `SELECT 41` + `close()` on Node 26.13.1 and Node 24.21.0. Node 20: not tested (not installed).
- **TypeScript source under Vitest (`engine.worker.ts`):** Node cannot run the source directly: relative imports end in `.js`, and the message enum needs a transform; Node 26's `stripTypeScriptTypes` accepts only `mode: 'strip'`, and `--experimental-transform-types` is rejected in a worker's `execArgv` (both tried). So the worker starts from a small `eval` loader that calls `module.registerHooks` to map `./x.js` → `./x.ts` and compile `.ts` with `transformSync` from `rolldown/utils` (oxc), resolved through `vite`, which Vitest depends on. Loaded modules run as ESM. Needs Node 22.15+ for `registerHooks` (Vitest 5 itself needs 22.12+). No new dependency.

## Result

**PASS.**

Test command: `cd /home/kuray/postgres-lite && npx vitest run modules/engine` → 3 files, **25 passed, 0 failed** (run twice); spike 7 is the 4 tests in `engine.host.test.ts`, and the spike 6 control test also opens its damaged images through `EngineHost` with a 30 s start timeout. Typecheck: `npx tsc --noEmit` reports nothing under `modules/engine`.

| Check | Measured |
|---|---|
| Clean run | `SELECT 1` → `1`, status `I`; an error reply then a normal query; `close()` → worker exits, `pg_control` state = 1 (shut down), later calls reject with "Engine worker exited" |
| `SELECT pg_sleep(3600)` hanging | 10 ms main-thread timer fired 94-100 times in ~1 s; a second worker engine answered `SELECT 42` 19-20 times (every 50 ms) meanwhile; `terminate()` took 19-50 ms; the pending call rejected with "Engine worker was terminated" |
| `SELECT count(*) FROM generate_series(1, 10^12)` spinning | timer 99-101 ticks in ~1 s; second engine 20 replies; `terminate()` 29-39 ms (V8 interrupts the WASM loop) |
| Directory after terminate | `pg_control` state = 6 (in production), so the next open ran crash recovery; reopened in a new worker with all 100 acknowledged rows (`count = 100, min = 1, max = 100`); after a clean close the state was 1 again |
| Open file descriptors (Linux, `/proc/self/fd`) | 97 with the engine running, 28 after `terminate()`: no fd leak observed; the cause of the release was not investigated |
| Round trip, 1000 × `SELECT 1` after 200 warm-up, memory engine | test file alone: in-process median 39 µs (p95 104 µs), worker median 351 µs (p95 546 µs), overhead **+312 µs**; whole module in parallel: in-process 39-40 µs, worker 370-464 µs, overhead +330 to +425 µs |

## Decisions for the plan

- Rule 3 stands: every engine runs in a worker. The hop costs about 0.3-0.4 ms per round trip, small next to a durable commit (5-10 ms fsync, spike 6), and a hung engine no longer stops the TCP server, the other databases or the lock handle.
- Rule 4 has its mechanism: `WorkerEngine.terminate()` fails every pending call at once, ends the thread in tens of milliseconds even in a WASM loop, and leaves a directory that crash recovery opens without losing acknowledged commits. Phase A wires `PANIC`/`FATAL`/`Aborted()` detection to it (not done in this spike).
- `EngineHost.start` should always be called with `startTimeoutMs` for on-disk engines: a damaged directory can hang or abort PGlite during start, and the timeout terminates the worker (used by the spike 6 control).
- Keep the protocol messages Zod-validated on both sides; the cost is inside the measured overhead.
- PHASES.md, Conventions: tests need Node 22.15+ (Vitest 5 + `registerHooks` for the source worker); the published package still targets Node 20+, but that is only verified once a Node 20 run of `dist/` exists.
- One `exec` is in flight per worker by construction (a queue in the worker); Phase B's engine lease sits above this and must not assume `execProtocolRaw` calls from different clients interleave inside the engine.

## Open questions

- Node 20 with the built `dist/` entry: not tested.
- Windows and macOS: terminate, reopen and file handles after terminate not tested (on Windows, handles left open by a terminated worker could block rename or delete of the directory).
- Memory: a worker per database plus PGlite's WASM heap; RSS per engine not measured.
- Overhead for large results (`COPY`, big `SELECT`) not measured; only `SELECT 1`.
- The source-mode loader depends on `rolldown/utils` being resolvable from `vite`; a Vite release that drops rolldown or renames `transformSync` would break running tests from source (dist unaffected). Alternative if that happens: `tsx` as a dev dependency.
- `PANIC` detection (rule 4) and the `53100` / `58030` replies to in-flight statements: not part of this spike.
- Review notes, not fixed in this spike: `WorkerEngine.close()` has no timeout, so closing a hung engine waits forever (callers must use `terminate()`); a worker reply that fails Zod validation is dropped with a warning and leaves its request pending; the `start` request's `settings` may include `fsync` or `wal_sync_method`, which are appended after the durable start params and so would override them. Phase A should bound `close()`, fail the pending request on a bad reply, and reject those two settings names.
