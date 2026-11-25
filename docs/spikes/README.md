# Phase 0 spikes

Each spike answers one go / no-go question from [docs/PHASES.md](../PHASES.md#phase-0-spikes-go--no-go). The decisions they led to are listed there under "Phase 0 results".

| # | Report | Result | Code |
|---|---|---|---|
| 1 | [Wire passthrough](01-wire-passthrough.md) | Pass | `modules/wire/` |
| 2 | [Role switching](02-role-switching.md) | Pass | `modules/session/` |
| 3 | [Extension bundle](03-extension-bundle.md) | Pass | `modules/timescale/` |
| 4 | [next-boilerplate on PGlite](04-next-boilerplate-on-pglite.md) | Pass | report only |
| 5 | [SQL parser](05-sql-parser.md) | Pass: `libpg-query` 18.2.2 | report only |
| 6 | [fsync](06-fsync.md) | Pass | `modules/engine/` |
| 7 | [Worker engine](07-worker-engine.md) | Pass | `modules/engine/` |
| 8 | Every OS | Pending: CI on macOS and Windows | `.github/workflows/ci.yml` |

Spike code is a starting point for Phase A and B, not finished product: the wire server is single-client until Phase B.
