# Rust sqlite-vec First Implementation Plan

> アーカイブ日: 2026-08-15。sqlite-vec 全面移行を既定とせず、[Rust Runtime Closeout Implementation Plan](../rust-runtime-closeout-implementation-plan.md) の benchmark gate に置き換えた。

## Purpose

`sqlite-vec` だけを先行して Rust 化し、Bun SQLite の dynamic extension loading 制約から外す。

この計画は daemon / queue / MCP の全面 Rust 化ではない。対象は vector storage と vector search の ownership だけである。Hono API server と UI-time repository は当面 Drizzle を使い続けてよい。ただし、API server が vector index の rebuild / search / health を必要とする場合は、Drizzle で `sqlite-vec` を直接扱わず、Rust vector layer を呼ぶ。

## Current Baseline

確認済みの現状:

- `bun run doctor` は `SQLITE_VECTOR_EXTENSION_UNAVAILABLE` を返す。
- `sqlite-vec` npm package と `node_modules/sqlite-vec-darwin-arm64/vec0.dylib` は存在する。
- `bun:sqlite` は `OMIT_LOAD_EXTENSION=1` / `ENABLE_LOAD_EXTENSION=0` のため、`db.loadExtension()` が `This build of sqlite3 does not support dynamic extension loading` で失敗する。
- `src/db/sqlite/client.ts` は `sqlite-vec` npm package から loadable path を取得し、Bun SQLite の `loadExtension()` に渡している。
- `src/db/sqlite/core-repository.ts` は `vector.available=false` の場合、`knowledge_items_vec_fallback` / `source_fragments_vec_fallback` の JSON embedding を TypeScript で cosine 計算する。
- live DB では `knowledge_items_vec` / `source_fragments_vec` は存在せず、fallback tables には embedding が入っている。
- `context-stilld` crate はすでに `rusqlite = { version = "0.32", features = ["bundled"] }` を使っている。

## Desired End State

- `sqlite-vec` の registration、vec0 virtual table creation、vector rebuild、vector search は Rust が所有する。
- Rust 側は `sqlite-vec` Rust crate を使い、Bun の dynamic extension loading に依存しない。
- `context-stilld doctor summary --json` または dedicated Rust command が sqlite-vec availability を報告できる。
- `bun run doctor` は Rust vector health を参照し、Bun `loadExtension()` 失敗を sqlite-vec failure の主判定にしない。
- API server は既存 Drizzle repository を維持する。ただし vector-specific operation は Rust layer 経由にする。
- fallback JSON embedding tables は移行中の互換 read / rebuild source として残す。
- npm `sqlite-vec` dependency と Bun vector loading path は、Rust path が default になった後で legacy として削除候補にする。

## Non-Goals

- Hono API server を Rust に書き換えない。
- Drizzle 全体を削除しない。
- API / UI の通常 CRUD repository を Rust 化しない。
- PostgreSQL / pgvector path を同時に整理しない。
- queue business executor migration をこの計画に混ぜない。
- embedding provider selection や embedding generation policy を変えない。
- live DB に破壊的 smoke を直接実行しない。

## Ownership Boundary

Rust-owned:

- sqlite-vec registration and availability probe.
- `knowledge_items_vec` / `source_fragments_vec` vec0 virtual table creation.
- `knowledge_items_vec_map` / `source_fragments_vec_map` rowid mapping mutation when writing vec0 rows.
- vector index rebuild from existing fallback embedding rows.
- vector search through vec0 `MATCH` queries.
- vector health / metadata reporting.

TypeScript / Drizzle remains owner:

- Hono API request routing.
- UI-facing non-vector queries.
- settings, overview, graph, landscape, knowledge CRUD where no vec0 operation is required.
- manual import/export/repair/backfill CLIs until separately migrated.

Shared during transition:

- `knowledge_items_vec_fallback` / `source_fragments_vec_fallback` remain the compatibility source of truth for embeddings until Rust vec0 index is proven and backfilled.
- `core_vector_metadata` records whether the latest rebuild used sqlite-vec.
- API server may call Rust vector layer for vector-specific operations while still using Drizzle for surrounding rows.

## Implementation Order

### V0: Baseline And Fixture Guard

Goal:
Freeze the current failure and fallback behavior before changing ownership.

Tasks:

- Add a non-mutating Rust vector probe command or test fixture plan before live mutation.
- Record the Bun failure as a fixture expectation:
  - `OMIT_LOAD_EXTENSION=1`
  - `db.loadExtension()` returns `This build of sqlite3 does not support dynamic extension loading`
- Record current live table shape:
  - vec0 virtual tables absent or empty.
  - fallback tables populated.
  - embedding dimension is the configured dimension.
- Add tests that create a temporary SQLite DB and do not touch `data/context-still-core.sqlite`.

Completion criteria:

- The current Bun failure can be reproduced without mutating live DB.
- The Rust test fixture can create a temporary SQLite DB and apply the core vector schema.
- The plan has a clear baseline for comparing Rust vec0 results to fallback cosine results.

Verification:

```bash
bun -e 'import { Database } from "bun:sqlite"; const db = new Database(":memory:"); console.log(db.query("pragma compile_options").all())'
cargo test -p context-stilld vector
```

Stop conditions:

- Baseline collection requires writing to the live DB.
- The failure cannot be distinguished from missing npm package or missing dylib.

### V1: Rust sqlite-vec Registration Smoke

Goal:
Prove that Rust can load sqlite-vec independently of Bun dynamic extension loading.

Tasks:

- Add the Rust `sqlite-vec` dependency to `crates/context-stilld/Cargo.toml`.
- Create a small vector module, for example `crates/context-stilld/src/domains/vector_index/`.
- Register sqlite-vec during connection setup for vector operations.
- Add an in-memory smoke test:
  - open `rusqlite::Connection::open_in_memory()`.
  - register sqlite-vec.
  - run `select vec_version()`.
  - create a tiny `vec0` table.
  - insert two vectors.
  - run a `MATCH` top-k query.

Completion criteria:

- Rust test proves `vec_version()` works.
- Rust test proves `vec0` table creation and `MATCH` query work.
- No Bun, Node, npm `sqlite-vec`, or dylib path participates in the test.

Verification:

```bash
cargo test -p context-stilld vector
cargo clippy --workspace --all-targets -- -D warnings
```

Stop conditions:

- The Rust crate cannot be used with the current `rusqlite` / bundled SQLite combination.
- The Rust test silently falls back to JSON cosine instead of using vec0.

### V2: Rust Vector Schema And Metadata Manager

Goal:
Move vec0 table creation and vector metadata ownership to Rust without changing API behavior.

Tasks:

- Implement Rust functions:
  - `ensure_vector_schema(connection, dimension)`.
  - `probe_vector_capability(connection)`.
  - `read_vector_metadata(connection)`.
  - `write_vector_metadata(connection, name, dimension, row_count, uses_sqlite_vec)`.
- Keep the existing SQL table names:
  - `knowledge_items_vec`
  - `source_fragments_vec`
  - `knowledge_items_vec_map`
  - `source_fragments_vec_map`
  - `core_vector_metadata`
- Preserve rowid map semantics used by the TypeScript repository.
- Ensure schema creation is idempotent.
- Do not remove fallback tables.

Completion criteria:

- Rust can create vec0 tables on a temporary DB with the same names as the TypeScript path.
- Re-running schema setup is safe.
- Metadata records `uses_sqlite_vec=true` only when vec0 is actually usable.

Verification:

```bash
cargo test -p context-stilld vector
```

Stop conditions:

- Rust schema diverges from existing table names or rowid semantics.
- Re-running schema setup drops fallback data.

### V3: Rust Rebuild From Fallback Embeddings

Goal:
Build vec0 indexes from existing fallback embedding rows in Rust.

Tasks:

- Implement a Rust rebuild operation for `knowledge_items_vec`.
  - read `knowledge_items_vec_fallback`.
  - upsert `knowledge_items_vec_map`.
  - delete old vec0 row by mapped rowid.
  - insert vector into vec0 rowid.
  - update `core_vector_metadata`.
- Implement the same for `source_fragments_vec`.
- Run rebuild inside `BEGIN IMMEDIATE` transaction.
- Validate embedding dimension before insert.
- Skip malformed vectors with counted diagnostics instead of panicking.
- Provide dry-run mode that counts rows and dimension distribution without writing.

Completion criteria:

- Temporary DB fixture can rebuild both knowledge and source fragment vectors from fallback rows.
- Dry-run reports row count, skipped count, and dimension.
- Apply mode updates vec0 tables and metadata transactionally.

Verification:

```bash
cargo test -p context-stilld vector
cargo run -q -p context-stilld -- vector rebuild --dry-run --json
```

Stop conditions:

- Rebuild requires deleting fallback tables.
- Rebuild cannot explain skipped rows.
- A failed rebuild can leave metadata claiming sqlite-vec is active.

### V4: Rust Vector Search Contract

Goal:
Expose vector search from Rust while preserving existing result contract.

Tasks:

- Implement Rust search operations:
  - `search_knowledge_vectors(embedding, limit)`.
  - `search_source_fragment_vectors(embedding, limit)`.
- Match existing TypeScript output fields:
  - knowledge: `id`, `title`, `body`, `score`.
  - source fragment: `id`, `sourceId`, `sourceUri`, `locator`, `heading`, `content`, `score`.
- Use vec0 `MATCH` query when available.
- Keep TypeScript JSON cosine fallback only for transition and explicit degraded mode.
- Add fixture tests comparing ordering against a small known vector set.

Completion criteria:

- Rust search returns the same public shape as the existing TypeScript repository.
- Top-k order is deterministic for ties.
- Search result includes only active knowledge rows for knowledge search, matching the current TypeScript filter.

Verification:

```bash
cargo test -p context-stilld vector
```

Stop conditions:

- Rust search returns a different response contract.
- Rust search includes inactive knowledge rows.
- Tie ordering is unstable enough to break deterministic tests.

### V5: API Boundary Adapter

Goal:
Let API server keep Drizzle for normal reads/writes while using Rust for vector-specific operations.

Tasks:

- Add the smallest callable Rust boundary:
  - preferred: `context-stilld vector search ... --json` and `context-stilld vector rebuild ... --json` for manual/operator use.
  - if API needs low-latency access: add resident HTTP/MCP internal route for vector search.
- Update TypeScript vector repository calls only where vec0 is needed.
- Keep non-vector Drizzle operations unchanged.
- Add explicit runtime capability:
  - `vectorEngine`: `rust_sqlite_vec` / `typescript_json_fallback` / `unavailable`.
  - `reason` when degraded.
- Do not route every API DB call through Rust.

Completion criteria:

- API server can continue serving non-vector endpoints without Rust adapter calls.
- Vector-specific API path can call Rust vector layer when configured.
- If Rust vector layer is unavailable, the failure is visible and does not masquerade as Bun sqlite-vec failure.

Verification:

```bash
cargo test -p context-stilld vector
bun run doctor
bun run verify:rust-daemon
```

Stop conditions:

- API server starts depending on Rust for unrelated CRUD.
- A vector adapter failure causes unrelated API endpoints to fail.
- The adapter hides whether Rust vec0 or TypeScript fallback was used.

### V6: Doctor And Operational Truth

Goal:
Make doctor report the real vector owner and stop treating Bun dynamic loading as the source of truth.

Tasks:

- Extend Rust doctor summary or add Rust vector doctor detail:
  - sqlite-vec registered.
  - vec version.
  - vec table presence.
  - fallback row counts.
  - metadata uses_sqlite_vec.
  - last rebuild status.
- Update TypeScript doctor database inspector to consume Rust vector health.
- Keep Bun `loadExtension()` failure as legacy diagnostic evidence, not the primary health check.
- Add a doctor reason for Rust vector degraded if vec0 is unavailable after Rust registration.

Completion criteria:

- `bun run doctor` no longer reports sqlite-vec unavailable solely because Bun cannot load dynamic extensions.
- Rust doctor can independently prove vec0 availability.
- Doctor output makes fallback mode visible when fallback is intentionally used.

Verification:

```bash
cargo run -q -p context-stilld -- doctor summary --json
bun run doctor
```

Stop conditions:

- Doctor reports green while vec0 tables are absent and fallback mode is not declared.
- Doctor cannot identify whether Bun, Rust, or fallback executed the vector path.

### V7: Default Switch And Legacy Cleanup

Goal:
Make Rust sqlite-vec the default vector engine, then remove obsolete Bun vector loading.

Tasks:

- Default vector-specific operations to Rust engine.
- Keep TypeScript JSON fallback behind explicit degraded path until live validation is complete.
- Remove or disable `loadVec()` as default behavior in `src/db/sqlite/client.ts`.
- Remove npm `sqlite-vec` only after `rg "sqlite-vec|getLoadablePath|loadExtension"` shows no default code path depends on it.
- Update docs to state Rust owns sqlite-vec.

Completion criteria:

- Default vector engine is Rust sqlite-vec.
- `SQLITE_VECTOR_EXTENSION_UNAVAILABLE` is gone when Rust vec0 is healthy.
- npm `sqlite-vec` is no longer needed for default runtime.
- API server still uses Drizzle for non-vector operations.

Verification:

```bash
rg -n "sqlite-vec|getLoadablePath|loadExtension|typescript_json_fallback" package.json src api crates
cargo test -p context-stilld vector
bun run doctor
bun run verify:rust-daemon
bun run verify
```

Stop conditions:

- Removing npm `sqlite-vec` breaks manual migration/backfill tools that still need it.
- Default switch changes non-vector API behavior.
- Live validation has not rebuilt or probed vec0 indexes.

## Live DB Validation Gate

Live DB mutation is allowed only after V1 through V4 pass on temporary fixtures.

Before apply mode:

```bash
cargo run -q -p context-stilld -- vector rebuild --dry-run --json
sqlite3 data/context-still-core.sqlite "pragma integrity_check;"
```

Apply mode must:

- use `BEGIN IMMEDIATE`;
- write metadata only after successful vec0 inserts;
- report row counts and skipped rows;
- keep fallback tables intact;
- fail without partial metadata success.

After apply mode:

```bash
cargo run -q -p context-stilld -- vector health --json
cargo run -q -p context-stilld -- vector search-smoke --json
bun run doctor
```

Stop immediately if:

- `pragma integrity_check` is not `ok`;
- dimension distribution does not match configured embedding dimension;
- vec0 search returns empty while fallback tables have valid rows;
- doctor cannot distinguish Rust vec0 from TypeScript fallback.

## Review Checklist

- [ ] The change only touches sqlite-vec/vector ownership.
- [ ] API server remains Drizzle-backed for non-vector operations.
- [ ] Rust vector tests use temporary SQLite DBs.
- [ ] Rust vec0 path is proven with `vec_version()` and `MATCH`.
- [ ] Fallback JSON embeddings are preserved.
- [ ] Doctor reports vector owner and fallback mode explicitly.
- [ ] No Bun dynamic extension loading is required for healthy sqlite-vec.
- [ ] Full repo verify runs only after focused Rust/vector gates pass.

## References

- Current Bun failure point: `src/db/sqlite/client.ts`
- Current TypeScript fallback vector search: `src/db/sqlite/core-repository.ts`
- Rust daemon crate: `crates/context-stilld/Cargo.toml`
- sqlite-vec Rust integration: https://alexgarcia.xyz/sqlite-vec/rust.html
