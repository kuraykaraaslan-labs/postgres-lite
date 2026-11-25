# Spike 5: SQL parser for the rewrite layer

## Goal

Choose the PostgreSQL parser that the rewrite layer (Phase C: databases and roles; Phase H: `timescaledb.*` options and continuous aggregates) uses to find and rewrite statements in client SQL strings. The parser must be the real PostgreSQL grammar compiled to WASM, ideally version 18 to match PGlite 0.5.16 (PostgreSQL 18.6). It must split multi-statement strings (with `DO $$ … $$` blocks, dollar quoting, comments, non-ASCII text and `$n` parameters) into statements with byte offsets, work from CommonJS on Node 20, and load quickly. Deparse fidelity was also measured. A cheap keyword pre-filter was measured as a way to skip parsing for most traffic. The spike ends with one recommended package and version, and the code shape for detecting and rewriting one `ALTER TABLE … SET (timescaledb.*)` statement.

## What was built

No code in the repository. Everything is in the scratch folder `/tmp/claude-1000/-home-kuray-redis-lite/dd75f3c8-a2c6-41ac-adf5-a7b1a8a12c8f/scratchpad/spike-5-parser/`:

- `pkgs/<candidate>/`: each candidate installed on its own (`npm install --ignore-scripts`).
- `corpus.cjs`: 26 single statements (every Phase C/H target, plus role and grant variants), 3 multi-statement strings, 15 ordinary ORM statements.
- `eval-libpg.cjs`: parses with libpg-query, deparses with pgsql-deparser, reparses, and compares the trees with locations removed. Also prints the statement split with byte offsets.
- `eval-supa.cjs`: the same checks for `@supabase/pg-parser`, which has its own C deparser.
- `eval-pg18.cjs`: PostgreSQL 18-only syntax probes, scan offsets, parse throughput and the keyword pre-filter.
- `load.cjs`, `leak.cjs`: load time and RSS in a fresh process, and RSS after up to 200 000 parses with GC forced.
- `node20/`: Node v20.20.2 from the `node@20` npm package, used only to run the same scripts on Node 20.
- `proto/rewrite.parser.ts`, `proto/rewrite.table-options.ts`, `proto/check.ts`: a TypeScript prototype of the recommended shape, compiled with the repository's `tsc` 7.0.2 (NodeNext, CommonJS, strict, `noUncheckedIndexedAccess`).
- `proto/pglite-check.mjs`: runs the rewritten SQL on the repository's PGlite 0.5.16, in memory, with a stub catalog function.

## Result

**PASS**, with one change to the plan: the deparser is not used (see Decisions).

Prototype checks: `cd /tmp/claude-1000/-home-kuray-redis-lite/dd75f3c8-a2c6-41ac-adf5-a7b1a8a12c8f/scratchpad/spike-5-parser/proto && /home/kuray/postgres-lite/node_modules/.bin/tsc -p tsconfig.json && node out/check.js && node pglite-check.mjs`. Result: typecheck clean; **14 passed, 0 failed** on Node v26.13.1 and on Node v20.20.2. On PGlite 0.5.16 (`PostgreSQL 18.6 (PGlite 0.5.16) on wasm3`), the original string fails with `22023 unrecognized parameter namespace "timescaledb"`. The rewritten string runs all 4 statements, and the stub received exactly the expected relation, options, `missing_ok` and `recurse` values. No vitest tests were added, because the task allows no code in the repository.

### Candidates (npm, checked 2026-11-25; "usable" means published on or before 2026-11-11)

| Package | Newest usable version | Grammar | Deparse | Unpacked size | Notes |
|---|---|---|---|---|---|
| `libpg-query` | **18.2.2** (2026-10-29) | PG 18 (`version` 180004), libpg_query `18-constructive` | none in WASM | 1.84 MB (WASM 1.72 MB) + `@pgsql/types` 86 kB | MIT. CJS `main` `wasm/index.cjs`, typings included. Sync API after one `loadModule()`. 150 versions since 2021; one npm maintainer (pyramation / Constructive). Newest 18.2.5 (2026-11-23) is too new. |
| `pgsql-deparser` | 18.4.3 (2026-11-05) | AST from libpg-query 18 | TypeScript deparser | 1.0 MB + `@pgsql/quotes` | MIT. Same maintainer. |
| `pgsql-parser` | 18.3.3 (2026-11-05) | wraps libpg-query 18.2.1 + pgsql-deparser 18.4.3 | as pgsql-deparser | 12 kB + deps | Adds nothing over the two above. |
| `@pgsql/parser` | 1.6.3 (2026-10-29) | PG 13–18, same WASM per version | none | 7.5 MB | Ships all six grammars; the v18 entry point has the same API as libpg-query. |
| `@supabase/pg-parser` | 0.1.7 (2026-02-10) | **PG 15–17 only** | C deparser (pg_query) | 5.3 MB | MIT, ESM + CJS, async-only API. No release since February 2026; no PG 18. |
| `pg-query-emscripten` | 5.1.0 (2024-09-04) | old | — | — | Unmaintained; not tested. |
| `pgsql-ast-parser` | 12.0.2 | hand-written grammar, not PostgreSQL's | — | — | Not the real parser; not tested. |

### Parse and split (libpg-query 18.2.2)

- Every target statement parses: CREATE DATABASE (plain, `WITH TEMPLATE = … OWNER = … ENCODING`, `OWNER`), DROP DATABASE (`IF EXISTS … WITH (FORCE)`, `(FORCE)`), `ALTER DATABASE … RENAME TO`, ALTER TABLE `SET (timescaledb.*)` / `RESET (timescaledb.*)` / mixed with `fillfactor`, `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS SELECT time_bucket(…) … GROUP BY 1 WITH NO DATA`, `ALTER MATERIALIZED VIEW … SET (timescaledb.*)`, `DROP MATERIALIZED VIEW`, CREATE/ALTER/DROP ROLE and USER, `GRANT r TO u WITH INHERIT TRUE, SET TRUE`, `WITH ADMIN OPTION GRANTED BY`, and `REVOKE INHERIT OPTION FOR`.
- `CREATE DATABASE IF NOT EXISTS` is a syntax error in the PostgreSQL 18 grammar (and in 17). Real PostgreSQL also rejects it, so it is not a rewrite target.
- PostgreSQL 18-only syntax (`VIRTUAL` generated column, `NOT ENFORCED`, `WITHOUT OVERLAPS`): libpg-query 18 parses all 3. `@supabase/pg-parser` (PG 17) rejects all 3 with a syntax error.
- A migration string of 7 statements, with a UTF-8 line comment, a nested block comment containing `;`, `DO $$ … $$` with `;` in the body, `$fn$` quoting, `E'…\' ;'`, `U&'…'` and a `"col;name"` identifier, splits into exactly 7 statements. `stmt_location` / `stmt_len` are **UTF-8 byte offsets**. The statement starts after any leading comment or whitespace. `stmt_len` is absent for the last statement, which means it runs to the end of the string. `;; SELECT 1 ; ; DROP …; -- end` gives 2 statements. `$1 $2 $3` come back as `ParamRef { number }`. PGlite executed the rewritten 4-statement string as 4 statements, the same split.
- `@supabase/pg-parser` splits the same string into the same 7 statements, but its `stmt_location` includes the leading comments and whitespace (PG 17 behaviour).
- `scanSync` token offsets are also byte offsets. In 18.2.2 and 18.2.5, `tokenName` is `UNKNOWN` for keywords: use `keywordName` or `keywordKind` with `text` instead.
- A syntax error throws `SqlError` with `sqlDetails.cursorPosition`. For example, `SELECT 1;\nALTER TABLE x SET (` gives position 29.

### Deparse round trip (parse → deparse → parse; trees compared without locations)

- **pgsql-deparser 18.4.3: 18 of 25 parsable statements equal, 7 wrong.** The newest version (18.5.5, too new to use) gives the same result.
  - `DROP DATABASE … WITH (FORCE)` becomes `WITH FORCE`, a syntax error.
  - `ALTER DATABASE a RENAME TO b` becomes `ALTER DATABASE RENAME TO b`: the old name is lost (syntax error).
  - Options without a value lose their namespace: `timescaledb.compress` becomes `COMPRESS`, `timescaledb.continuous` becomes `CONTINUOUS`, and `RESET (timescaledb.segmentby, …)` becomes `RESET (SEGMENTBY, …)`. Each of these is valid SQL with a different meaning.
  - `timescaledb.compress_segmentby = 'device_id'` becomes the unquoted `device_id`.
  - Roles, grants (including `WITH INHERIT TRUE, SET TRUE`) and `SET (timescaledb.x = …)` with a value round-trip correctly.
- **@supabase/pg-parser 0.1.7: 25 of 25 equal.** It only covers PostgreSQL 17.

### Cost

| Measure | Node 26.13.1 | Node 20.20.2 |
|---|---|---|
| `require` + `loadModule()` of libpg-query 18.2.2 (3 runs) | 16.9 / 18.5 / 18.3 ms | 24.3 / 23.4 / 23.7 ms |
| RSS added by that load | +9.5 to +10.6 MiB | +11.1 to +11.3 MiB |
| …plus pgsql-deparser loaded and used once | 43.4 ms, +15.5 MiB | 51.5 ms, +17.8 MiB |
| @supabase/pg-parser load (PG 17) | 18.5 ms, +10.9 MiB | 27.0 ms, +12.3 MiB |
| @pgsql/parser v18 load | 19.1 ms, +9.7 MiB | 31.2 ms, +10.9 MiB |

- `parseSync` on Node 26: short ORM `SELECT` 22.8 µs; `ALTER TABLE … SET (timescaledb.*)` 15.7 µs; the 7-statement migration 117 µs. `scanSync` on one CREATE MATERIALIZED VIEW took 97 µs (slower than parsing it).
- Memory under load: with GC forced, RSS was 51 MiB after load, then 96 / 100 / 108 MiB after 20 k / 100 k / 200 k parses of the migration. `heapUsed` stayed at 4.7 MiB and `external` at 1.8 MiB. That is a plateau, not a leak. Not tested past 200 k parses.
- Keyword pre-filter `/\b(?:DATABASE|ROLE|USER|GRANT|REVOKE|MATERIALIZED|timescaledb)\b/i` over the raw text: **127 ns per statement**, about 180× cheaper than a parse. 0 false negatives on the 26 target statements and the 2 multi-statement strings that contain targets. 1 of 15 ordinary ORM statements matched: TypeORM's alias `"User"`, which costs one extra parse. Without `MATERIALIZED`, the filter missed `DROP MATERIALIZED VIEW`.

## Decisions for the plan

1. **Dependency:** `libpg-query` **18.2.2**, exact pin. It brings `@pgsql/types` 18.0.0 transitively (types only, plus a runtime re-export). Do not depend on `pgsql-deparser`, `pgsql-parser` or `@pgsql/parser`. `@supabase/pg-parser` is rejected because it has no PostgreSQL 18 grammar: a PG 18-only statement in the same string as a `timescaledb.*` option would fail to parse, and the option would then reach the engine un-rewritten.
2. **Phase 0 item 5 should say:** "libpg-query 18.2.2 parses every Phase C/H statement and splits strings with byte offsets; load is 17–24 ms and about 11 MiB. The rewrite layer does not deparse."
3. **No deparser. Rewrite by byte span.** The rewrite layer parses, decides from the AST, and replaces only the byte span `[stmt_location, stmt_location + stmt_len)` of a target statement with SQL it generates itself (quoted identifiers and literals). The edits are applied from the last statement to the first. Every other byte (comments, DO bodies, `$n`) is copied unchanged. For a continuous aggregate, the `SELECT` text is sliced from the original string (from after `AS` to before the final top-level `WITH [NO] DATA`, found with `scanSync` keyword tokens), never regenerated. Reason: the only PG 18 deparser on npm breaks exactly the Phase C/H forms (FORCE, RENAME, value-less `timescaledb.*`).
4. **Pipeline:** pre-filter regex (above) → `parseSync` → per-statement detectors → span edits. If the parse fails, forward the original text: PostgreSQL then reports its own SQLSTATE and position. Load the parser once at server start, so the hot path stays synchronous.
5. **One statement in, one statement out.** A rewrite produces exactly one statement, so it also works inside an extended-protocol `Parse`. Mixed lists such as `SET (timescaledb.x = …, fillfactor = 70)` therefore go to the catalog function as a whole; the function applies the native options with its own `ALTER TABLE`. An ALTER TABLE that mixes `timescaledb.*` options with other subcommands (`ADD COLUMN`, …) raises `0A000`.
6. **Command tag.** Each rewrite carries the tag the client must see (`ALTER TABLE`, `CREATE MATERIALIZED VIEW`, …). The wire layer replaces `CommandComplete` and drops the `RowDescription`/`DataRow` of the generated `SELECT`. On `Describe`, it answers `NoData`. Phase A/H must plan for this.
7. **AST gotchas, for the detectors:** the JSON tree omits `false`, `0` and empty fields. `ONLY` shows up as a missing `relation.inh`, not as `inh: false`, and `IF EXISTS` as `missing_ok: true`. Option values arrive as `String` (`true` is the string `"true"`), `Integer`, `Float`, `Boolean`, `TypeName` (bare identifiers) or nothing (a bare key means true). Named arguments in generated SQL must avoid reserved words: a parameter called `only` made the generated call a syntax error, and the reparse check caught it. Keep "reparse the rewritten string" as a test assertion.
8. **Limit, already documented:** SQL built with `EXECUTE format(…)` inside PL/pgSQL bypasses the rewrite layer. next-boilerplate's runtime path issues its `ALTER TABLE … SET (timescaledb.enable_columnstore …)` and `CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous)` as top-level statements (`modules/db/server/db.time-series.ts`). Only a bench script, `scripts/bench/telemetry-isolation/sql/b_caggs.sql`, uses `EXECUTE format`.

### Code shape (prototype, compiled and run; `proto/`)

```ts
// rewrite.parser.ts
const REWRITE_KEYWORDS = /\b(?:DATABASE|ROLE|USER|GRANT|REVOKE|MATERIALIZED|timescaledb)\b/i;
export default class RewriteParser {
  private static ready: Promise<void> | null = null;
  static load(): Promise<void> { RewriteParser.ready ??= loadModule(); return RewriteParser.ready; }
  static mayNeedRewrite(sql: string): boolean { return REWRITE_KEYWORDS.test(sql); }
  static split(sql: string): { bytes: Buffer; statements: SqlStatement[] } | null {
    let tree: ParseResult;
    try { tree = parseSync(sql); } catch { return null; }      // PostgreSQL reports the error itself
    const bytes = Buffer.from(sql, 'utf8');
    const statements = (tree.stmts ?? []).flatMap((raw) => raw.stmt === undefined ? [] : [{
      node: raw.stmt, start: raw.stmt_location ?? 0,
      end: raw.stmt_len ? (raw.stmt_location ?? 0) + raw.stmt_len : bytes.length }]);
    return { bytes, statements };
  }
}

// rewrite.table-options.ts (detector for one statement)
export function rewriteAlterTableOptions(node: Node): StatementRewrite | null {
  if (!('AlterTableStmt' in node)) return null;
  const stmt = node.AlterTableStmt;
  if (stmt.objtype !== 'OBJECT_TABLE' || stmt.relation === undefined) return null;
  // walk cmds: AT_SetRelOptions → set[ns.name] = value, AT_ResetRelOptions → reset.push(ns.name);
  // return null when no DefElem has defnamespace === 'timescaledb'
  return {
    sql: `SELECT _timescaledb_functions.pl_alter_table_options(${quoteLiteral(qualified)}, ` +
         `${quoteLiteral(JSON.stringify(set))}::jsonb, ARRAY[${reset.map(quoteLiteral).join(', ')}]::text[], ` +
         `missing_ok => ${stmt.missing_ok === true}, recurse => ${rel.inh === true})`,
    commandTag: 'ALTER TABLE',
  };
}

// caller
if (RewriteParser.mayNeedRewrite(sql)) {
  const split = RewriteParser.split(sql);
  if (split) {
    const edits = split.statements.flatMap((s) => {
      const r = rewriteAlterTableOptions(s.node);
      return r ? [{ start: s.start, end: s.end, sql: r.sql }] : [];
    });
    if (edits.length > 0) sql = applyRewrites(split.bytes, edits); // back to front, byte spans
  }
}
```

Example input: `ALTER TABLE public."Metrics" SET (timescaledb.enable_columnstore = true, timescaledb.segmentby = 'a, b', timescaledb.orderby = 'ts DESC', fillfactor = 70);`. It becomes `SELECT _timescaledb_functions.pl_alter_table_options('"public"."Metrics"', '{"timescaledb.enable_columnstore":"true","timescaledb.segmentby":"a, b","timescaledb.orderby":"ts DESC","fillfactor":"70"}'::jsonb, ARRAY[]::text[], missing_ok => false, recurse => true);`. The function name is a placeholder; Phase H fixes it. The real module would put its error strings in `rewrite.messages.ts` and log through `Logger`; the prototype does neither.

## Open questions

- The function name, signature and error texts for `_timescaledb_functions.*` rewrite targets (Phase H). Unknown-option errors should match Timescale's SQLSTATE and message from the reference; not tested.
- `libpg-query` ships only an MIT LICENSE file. The WASM is compiled from PostgreSQL (PostgreSQL License) and libpg_query (BSD-3-Clause). Should postgres-lite add a third-party notice? Not checked further.
- Single npm maintainer and frequent releases (6 in November 2026). Pin exactly, and re-run the corpus on each bump.
- `standard_conforming_strings = off` set by a client would change how the generated `'…'` literals are read. Either refuse that `SET` in the session layer or generate `E''` / dollar-quoted literals. Not tested.
- Detectors for CREATE/DROP/ALTER DATABASE, roles, GRANT/REVOKE role, and continuous aggregates were only shown to parse; their rewrites were not prototyped. The `scanSync` SELECT-span slice for continuous aggregates was designed but not run end to end.
- Whether `DROP OWNED` / `REASSIGN OWNED` and `SET ROLE` / `SET SESSION AUTHORIZATION` also need the rewrite path (Phase B/C). If so, add `OWNED` / `AUTHORIZATION` to the pre-filter.
- Not tested: macOS and Windows (WASM, so expected to behave the same), bundlers, a parser running inside the engine's worker thread, and parse error positions on non-ASCII input (bytes or characters).
