# Spike 6: real fsync

## Goal

Implement storage rule 1 of `docs/PHASES.md` on PGlite 0.5.16 and prove it: PostgreSQL runs with `fsync = on` and `wal_sync_method = fsync`, every fsync it asks for reaches the disk through Emscripten's NODEFS, a Windows directory fsync reports `EINVAL`, and a new data directory is fsynced file by file after initdb. The proof is a lost-unsynced-writes test: record every write and fsync at the NODEFS layer, build power-cut images from the fsynced state plus random subsets of the unsynced writes, reopen each image, and require every acknowledged commit and a clean `amcheck`. Also measure fsyncs per commit and at `CHECKPOINT`, and the commit latency cost.

## What was built

- `modules/engine/engine.fsync.ts`: `EngineFsync` (start params, `install` of `stream_ops.fsync`, `syncTree`, `createFilesystem`) and a private `NodeFS` subclass whose preRun hook patches NODEFS before initdb and PostgreSQL start.
- `modules/engine/engine.nodefs.ts`: typed shape of the NODEFS parts that are patched, with a runtime check (`asNodefsModule`) that fails loudly if a PGlite upgrade moves them.
- `modules/engine/engine.open.ts`: `EngineOpen.open(storage, options)`: opens an engine durable by default, fsyncs the tree when initdb ran, accepts extensions, extra `-c` settings and NODEFS hooks.
- `modules/engine/engine.messages.ts`: message enum for the module.
- `modules/engine/tests/engine.fsync.test.ts`: start params, initdb tree sync, fsync counts per commit and at `CHECKPOINT`, Windows directory rule, latency.
- `modules/engine/tests/engine.fsync.crash.test.ts`: the lost-unsynced-writes test with the fix (12 images) and a control without it (6 images).
- `modules/engine/tests/support/crash-recorder.ts`: wraps NODEFS `stream_ops.write/fsync/setattr` and `node_ops.setattr/mknod/rename/unlink/rmdir`, tracks files by id.
- `modules/engine/tests/support/crash-image.ts`: builds a crash image from a recording and a seed (model below).
- `modules/engine/tests/support/workload.ts`: the recorded workload and the image check (rows plus `amcheck`).

### How NODEFS is reached

PGlite's `NodeFS.init()` returns `emscriptenOpts` whose `preRun` mounts NODEFS. The subclass calls `super.init()` and appends one more `preRun` function. It runs on the Emscripten module after the mount and before initdb or PostgreSQL run, so every later file operation, initdb's included, goes through the patched `NODEFS.stream_ops` (one object shared by every NODEFS node). No private API is touched other than `mod.NODEFS` and `mod.FS.isDir`, both checked at runtime.

### Start parameters

`PGlite.defaultStartParams` minus `-F`, minus any existing `-c fsync=…` or `-c wal_sync_method=…`, plus `-c fsync=on -c wal_sync_method=fsync`. Everything else (`--single -O -j`, `search_path`, `exit_on_error`, `log_checkpoints`, workers, `io_method=sync`) is kept in order. Verified in the engine: `current_setting('fsync') = on`, `current_setting('wal_sync_method') = fsync`.

### fsync and Windows

`stream_ops.fsync(stream)` runs `fs.fsyncSync(stream.nfd)` inside `NODEFS.tryFSOperation`, so a Node error becomes the matching errno for PostgreSQL. On `win32` a directory fsync throws `{ code: 'EINVAL' }` instead (errno 28); PostgreSQL's `fsync_fname` ignores `EINVAL`/`EBADF` for directories. `EngineFsync.syncTree` skips directories on Windows.

### Crash image model

The base image is a copy of the data directory taken right after the durable open (initdb output fully fsynced by `syncTree`). Then:

- a write or truncate is durable if the same file is fsynced later;
- a create is durable if its directory or the new file is fsynced later (the one relaxation from strict POSIX: journaling file systems commit the entry with the file; PostgreSQL does not fsync the directory after creating a relation file, so it depends on this too; reasoned from the PostgreSQL source, not tested per OS);
- a rename or unlink is durable if the directories involved are fsynced later;
- everything else is kept or dropped at random (seeded mulberry32), in order; unsynced writes are split into 4 KiB sectors that survive independently, so torn pages are included.

Crash points: after 200 autocommit inserts (`before-checkpoint`), right after `CHECKPOINT` (`after-checkpoint`), and at the end of a workload with updates on checkpointed pages, a 200-row transaction, `pg_switch_wal()`, a second `CHECKPOINT`, 200 wide autocommit inserts and deletes (`end`). `shared_buffers = 128kB` (16 buffers) forces dirty-page evictions, so unsynced data-file writes are in the images, not only WAL.

## Result

**PASS.**

Test command: `cd /home/kuray/postgres-lite && npx vitest run modules/engine` → 3 files, **25 passed, 0 failed** (run twice). Spike 6 is 21 of them: 6 in `engine.fsync.test.ts`, 15 in `engine.fsync.crash.test.ts`. Typecheck: `npx tsc --noEmit` reports nothing under `modules/engine`.

Lost-unsynced-writes, with the fix (12 images = 3 crash points x seeds 1-4): every image reopened, every acknowledged commit present with the right value, `bt_index_check(index, heapallindexed => true)` clean on every permanent btree index (catalogs included) and `verify_heapam('t')` clean.

| Crash point | Acknowledged rows | Ops recorded up to it | Unsynced ops in the random set | Result |
|---|---|---|---|---|
| before-checkpoint | 200 | 537 | 100 | 4/4 seeds clean |
| after-checkpoint | 200 | 603 | 1 | 4/4 seeds clean |
| end | 515 | 2 272 | 78 | 4/4 seeds clean |

Control, same harness, PGlite's own settings (`-F`, no NODEFS fsync), seeds 1-2 per crash point, each image opened in a worker with a 30 s start timeout: **0 fsyncs recorded; 6 of 6 images failed to open** ("PGlite failed to initialize properly" or `Aborted()`). In an exploratory run opened in-process, the `before-checkpoint` images opened with table `t` missing (all 200 acknowledged commits lost). The control's base image counts initdb's unsynced output as durable, so it is kinder than a real power cut.

fsync counts (recorded at the NODEFS layer):

| Event | fsyncs |
|---|---|
| New data directory (initdb + `syncTree`) | 972 files + 27 directories + parent = 1 000 by `syncTree`, 1 005 in all during open; every file and directory of the tree fsynced |
| 100 autocommit inserts | 100 (1.00 per commit), all in `pg_wal/` |
| `CHECKPOINT` after them | 53: 40 data files under `base/`, `global/pg_control` once, 6 directories, plus `pg_xact`, `pg_multixact`, `pg_logical` files |
| Recorded workload, 1st `CHECKPOINT` with 16 buffers | 35 data files, `pg_control`, directories (`pg_logical`, `pg_xact`, `pg_commit_ts`, `pg_multixact/*`) |

Commit latency, 500 autocommit `INSERT`s after 50 warm-up, WSL2 ext4 virtual disk:

| Run | Without fix: median / p95 | With fix: median / p95 | Cost (median) |
|---|---|---|---|
| test file alone | 0.245 / 0.506 ms | 5.752 / 7.229 ms | +5.5 ms |
| whole module (3 test files in parallel) | 0.315-0.489 / 0.741-1.311 ms | 9.346-9.637 / 12.0-13.4 ms | +9.0 to +9.1 ms |

A plain `fs.fsyncSync` of an 8 KiB overwrite on the same disk takes 5.0 ms median (6.1 ms p95, 300 runs), so the cost is the disk's fsync, one per commit; PGlite adds almost nothing on top.

Windows rule, tested on Linux with `platform: 'win32'`: every directory fsync PostgreSQL asked for during `CREATE TABLE`, `pg_switch_wal()` and `CHECKPOINT` returned errno 28; every file fsync succeeded; the engine kept working (`count(*) = 2` after the checkpoint). Not tested on real Windows.

## Decisions for the plan

- Rule 1 stands as written and is implemented: a `NodeFS` subclass that appends a `preRun` hook (supported API: `Filesystem.init` returns `emscriptenOpts`), `PGlite.defaultStartParams` without `-F` plus `-c fsync=on -c wal_sync_method=fsync`, `EngineFsync.syncTree` after a create. The Phase 0 pass condition is met on Linux.
- PHASES.md should say what a commit costs: one fsync (5-10 ms on a WSL2 ext4 disk, about 100-170 commits per second for one connection). Migrations and seeds that autocommit thousands of statements get slower by that much. Options to decide before Phase A: keep it (the rule says no data loss by default) and document it; or offer an opt-in `synchronous_commit = off` mode (no corruption, but commits since the last WAL flush can be lost on an OS crash; PGlite runs a single backend with no WAL writer process, so that window is not bounded by `wal_writer_delay`: reasoned, not tested). Memory-only test servers are unaffected.
- `syncTree` must also run after any directory written outside PostgreSQL (template copy, restore, upgrade: rule 6), and probably on every open of a directory last written by plain PGlite, because those files may never have been fsynced. PostgreSQL itself only syncs the tree on crash recovery.
- The crash recorder and image builder are reusable for the storage suite of spike 8 and for Phase C (template copy, restore). The model makes one documented relaxation (a fsynced new file's directory entry is durable).
- Keep `asNodefsModule`'s runtime check: a PGlite upgrade that renames NODEFS internals must fail at start, not silently run with fsync off.

## Open questions

- Real macOS (`F_FULLFSYNC` cost) and real Windows (`FlushFileBuffers`, `EINVAL` path, sharing violations) are not tested; spike 8.
- `syncTree` on Windows skips directories; whether NTFS needs anything for new entries (it journals metadata) is not tested.
- The crash points are between statements. A crash in the middle of `CHECKPOINT` or of a commit's WAL write is not tested (the recorder could cut at any op index; not done here). The `after-checkpoint` point leaves only 1 unsynced op for the random set (table above), so its 4 images check little beyond reopening the fsynced state; the `before-checkpoint` and `end` points carry the test.
- `EngineOpen.open` decides "new directory, run `syncTree`" from the absence of `PG_VERSION` before the open. If a first open is killed after initdb wrote `PG_VERSION` but before `syncTree` finished, the next open treats the directory as existing and never fsyncs initdb's output. Not tested; a marker written after `syncTree` (and a full sync when it is missing) would cover this and the plain-PGlite question below.
- Review note: a mutation (NODEFS fsync installed, but `wal_sync_method=fdatasync`, a no-op in PGlite) made 5 of 6 images fail in this harness (invalid pages, `Aborted()`, failed init); one `after-checkpoint` image survived. So the harness detects a partial fix too, not only the no-fix control.
- Whether a data directory created by plain PGlite (or by an older postgres-lite) should be fully fsynced on first durable open is not decided; cost is about 1 000 fsyncs (a few seconds on this disk).
- The 128 kB `shared_buffers` setting is a test setting only. The default PGlite value was not changed and its effect on fsync counts at checkpoint in normal use was not measured.
- Node 20 was not tested (only Node 26.13.1 ran the tests).
