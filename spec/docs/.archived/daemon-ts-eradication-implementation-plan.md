# Daemon TypeScript Eradication Implementation Plan

> アーカイブ日: 2026-08-15。実装コミット: `5f1bdb3`。

## Purpose

2026-06-23 の実装課題として、`context-stilld` の daemon 層から TypeScript / Bun / Node 依存を除去する。

この計画でいう daemon 層は、macOS LaunchAgent / packaged service から常時起動される `context-stilld run`、その resident runtime が所有する MCP / queue / agent-log-sync / doctor / backup / bootstrap / process supervision の範囲を指す。

UI 起動時の Hono API、admin UI、Drizzle を使う API/repository、手動の migration/import/export/repair/backfill CLI は対象外である。これらは TypeScript のままでよい。ただし、それらが resident daemon の必須起動経路や child process として混入してはいけない。

## Desired End State

- `context-stilld run` の process tree に `bun`, `node`, `tsx`, `src/cli/*.ts`, `api/index.ts`, `src/mcp/http-server.ts` が出ない。
- `com.context-still.daemon` の LaunchAgent は Rust binary だけを起動する。
- daemon readiness / status / ownership checks は Bun を必要としない。
- MCP endpoint と exposed tool handlers は Rust-native で完結する。未移行 tool は daemon 上で TS fallback せず、明示的に disabled / unsupported にする。
- queue scheduling, provider lease, stale recovery, worker-unavailable handling, state transition は Rust-owned のまま維持する。
- resident queue business execution は Rust-native の範囲だけを実行し、未移行 queue は TS executor に暗黙 fallback せず fail closed する。
- agent-log-sync scheduled path は Rust-native のまま維持する。
- Hono API は UI-time surface として残せるが、resident daemon の default surface にしない。
- Drizzle / TypeScript repository は UI/API/manual CLI では残せるが、daemon runtime の必須依存にしない。

## Current Residual Surfaces

確認済みの主な残存箇所:

- `crates/context-stilld/src/domains/queue_lifecycle/types.rs`
  - `QUEUE_SUPERVISOR` は Rust state/log 用の spec として残る。resident TS executor spec は削除済み。
- `crates/context-stilld/src/domains/queue_lifecycle/service.rs`
  - TS queue executor 起動 helper は削除済み。
- `crates/context-stilld/src/domains/resident_runtime/service.rs`
  - resident queue reconcile は Rust scheduling/maintenance のみを行い、TS executor を起動しない。
- `crates/context-stilld/src/domains/runtime_sidecars/service.rs`
  - `queue-executor-typescript-manual-one-shot`
  - `hono-admin-api-child`
  - `manual-maintenance-typescript-cli`
  - MCP TS dispatch sidecar has been removed from the registry; remaining TypeScript entries must stay UI-time or operator manual-only.
- `src/cli/context-stilld-automation.ts`
  - daemon LaunchAgent install/load/unload/status の操作が TS CLI に残っている。
- `crates/context-stilld/src/domains/admin_api_lifecycle/service.rs`
  - `context-stilld admin-api start` が `bun run api/index.ts` を起動する。
- `crates/context-stilld/src/domains/bootstrap/service.rs`
  - bootstrap report は Rust daemon readiness check を返す。
- `crates/context-stilld/src/domains/doctor/service.rs`
  - doctor summary は Rust daemon readiness check を返す。
- `scripts/verify-rust-daemon.mjs` and related smoke scripts
  - verification tooling itself is Bun-based. This is acceptable for development, but not sufficient as the packaged daemon readiness proof.

## Non-Goals

- Hono API を Rust に書き換えない。
- Drizzle / TypeScript repository を削除しない。
- UI 起動時の TypeScript を削らない。
- import/export/migration/repair/backfill などの手動 CLI を削らない。
- queue の意味論を変えない。
- MCP tool name / schema を変更しない。
- live DB に対する破壊的 smoke を追加しない。

## Implementation Order

### T0: Baseline And Guard

Goal:
変更前に daemon-owned TS/Bun 経路を固定し、以降の差分を機械的に検出できるようにする。

Tasks:

- `context-stilld runtime sidecars --json` の現在値を確認する。
- `context-stilld status --json` と LaunchAgent の実 PID を確認する。
- `ps` で `context-stilld run` の子に Bun がいるか確認する。
- `rg` で `crates/context-stilld` 内の `command: "bun"` / `src/cli/*.ts` / `api/index.ts` 参照を棚卸しする。
- Rust 側に `runtime assert-rust-only --json` か同等の non-mutating check を追加する。

Completion criteria:

- daemon 層の TS/Bun 参照が一覧化される。
- check は live DB を変更しない。
- check は UI-time Hono と manual CLI を daemon failure と誤判定しない。

Verification:

```bash
cargo run -q -p context-stilld -- status --json
cargo run -q -p context-stilld -- runtime sidecars --json
ps -axo pid,ppid,command | rg 'context-stilld|bun|node|queue-supervisor|api/index.ts|mcp-dispatch'
rg -n 'command: "bun"|src/cli/.*\\.ts|api/index\\.ts|mcp-dispatch|http-server\\.ts' crates/context-stilld src/cli/context-stilld-automation.ts scripts
```

Stop conditions:

- The check cannot distinguish resident daemon ownership from UI-time/manual commands.
- The check requires starting Hono or queue mutation.

### T1: Move Daemon Automation Into Rust

Goal:
Install/load/unload/status for `com.context-still.daemon` should not require `bun run src/cli/context-stilld-automation.ts`.

Tasks:

- Add Rust commands for daemon automation:
  - `context-stilld daemon install --json`
  - `context-stilld daemon load --json`
  - `context-stilld daemon unload --json`
  - `context-stilld daemon uninstall --json`
  - `context-stilld daemon status --json`
- Preserve the LaunchAgent behavior:
  - `ProgramArguments` points at the built `context-stilld` binary and `run`.
  - `CONTEXT_STILL_DB_BACKEND=sqlite`
  - `CONTEXT_STILL_SQLITE_CORE_PATH`
  - `CONTEXT_STILL_PROJECT_ROOT`
  - `CONTEXT_STILL_APP_DATA_DIR`
  - resident MCP/queue/agent-log-sync flags.
- Keep `src/cli/context-stilld-automation.ts` only as a temporary wrapper or mark it legacy/manual. It must not be the documented daemon path.
- Update docs/scripts so daemon operations prefer Rust command first.

Completion criteria:

- A fresh daemon install/load/status path works with the Rust binary alone.
- Legacy queue and agent-log-sync LaunchAgents are still unloaded or rejected.
- No Bun is needed to start or inspect the daemon.

Verification:

```bash
cargo run -q -p context-stilld -- daemon status --json
cargo run -q -p context-stilld -- daemon install --json
cargo run -q -p context-stilld -- daemon load --json
launchctl print gui/$(id -u)/com.context-still.daemon
cargo run -q -p context-stilld -- status --json
```

Stop conditions:

- Rust automation cannot preserve the exact LaunchAgent environment.
- Loading the daemon re-enables legacy queue or agent-log-sync LaunchAgents.

### T2: Remove Resident Queue TS Executor

Goal:
`context-stilld run` must not spawn `bun run src/cli/queue-supervisor.ts`.

Tasks:

- Keep Rust-only resident behavior as the default.
- Keep the resident path from `resident_runtime::reconcile_queue` disconnected from any TS queue executor.
- Change unsupported queue execution to fail closed:
  - keep jobs pending / waiting for worker;
  - record Rust-visible reason;
  - do not silently start TS executor.
- Keep explicit manual one-shot queue CLI outside daemon scope if needed.
- Update sidecar registry so queue TS fallback is not classified as daemon resident or resident-owned.

Completion criteria:

- `context-stilld run` starts queue scheduling/maintenance but no TS queue worker.
- `queue inspect --json` explains when runnable jobs are waiting for Rust executor coverage.
- The process tree has no `queue-supervisor.ts` under `context-stilld`.

Verification:

```bash
cargo test -p context-stilld queue resident
cargo run -q -p context-stilld -- queue inspect --json
cargo run -q -p context-stilld -- runtime sidecars --json
ps -axo pid,ppid,command | rg 'context-stilld|queue-supervisor|bun'
```

Stop conditions:

- Queue jobs are marked complete without Rust execution parity.
- Queue state becomes invisible from `queue inspect`.
- TS queue worker remains under the resident process tree.

### T3: Remove MCP TS Dispatch From Daemon

Goal:
MCP requests handled by the resident daemon must not invoke `bun run src/cli/mcp-dispatch-once.ts`.

Tasks:

- Confirm all exposed MCP tools are Rust-native or explicitly unsupported.
- Delete stale Rust sidecar registry entry for `mcp-tool-dispatch-typescript-one-shot` after proving no code path invokes it.
- Remove or archive `src/cli/mcp-dispatch-once.ts` if it is no longer referenced by supported commands.
- Make unknown/unmigrated MCP tools return a structured unsupported error instead of launching TS.
- Update `mcp smoke --json` owner inventory to fail if any daemon tool owner is `tsSidecar`.

Completion criteria:

- `mcp smoke --json` reports zero daemon TS sidecars.
- `tools/list` does not advertise tools that would need TS dispatch.
- No MCP request can create a Bun child process.

Verification:

```bash
cargo test -p context-stilld mcp
cargo run -q -p context-stilld -- mcp smoke --json
cargo run -q -p context-stilld -- runtime sidecars --json
rg -n 'mcp-dispatch-once|tsSidecar|typescript-one-shot' crates/context-stilld src package.json
```

Stop conditions:

- A public MCP tool disappears without a deliberate compatibility decision.
- A migrated tool's output shape differs from the existing contract.

### T4: Split UI-Time Hono From Daemon Namespace

Goal:
Hono can stay TypeScript, but it must not look like a resident daemon dependency.

Tasks:

- Keep `api/index.ts` as UI-time/admin surface.
- Ensure `context-stilld run` never starts `admin-api`.
- Decide whether `context-stilld admin-api start` remains as an explicit UI helper or moves to a UI/runtime command outside daemon readiness.
- Update sidecar classification so Hono is not counted as daemon debt when it is UI-time only.
- Make daemon readiness checks ignore stopped UI-time Hono but fail if Hono is resident-owned.

Completion criteria:

- Rust daemon can be installed, loaded, inspected, and stopped with Hono absent.
- Hono start remains available only as an explicit UI/operator action.
- `runtime assert-rust-only` passes while Hono is stopped.

Verification:

```bash
cargo run -q -p context-stilld -- status --json
cargo run -q -p context-stilld -- runtime sidecars --json
ps -axo pid,ppid,command | rg 'context-stilld|api/index.ts|bun'
```

Stop conditions:

- Admin UI becomes required for background daemon work.
- Hono is promoted into resident startup by default.

### T5: Replace TypeScript Doctor/Bootstrap Delegation For Daemon Readiness

Goal:
Daemon readiness must be diagnosable without `bun run src/cli/doctor.ts` or `bun run src/cli/startup.ts`.

Tasks:

- Add Rust daemon-readiness doctor output covering:
  - SQLite path and access;
  - MCP endpoint readiness;
  - queue maintenance state;
  - provider leases and active targets;
  - agent-log-sync schedule/state;
  - LaunchAgent owner;
  - forbidden resident sidecars;
  - backup idle guard.
- Keep TypeScript full doctor as an optional UI/manual diagnostic, not a daemon prerequisite.
- Keep `needs_typescript_doctor` out of daemon readiness status.
- Ensure backup/preflight does not depend on TS.

Completion criteria:

- `context-stilld doctor summary --json` can make a daemon readiness judgment without Bun.
- `context-stilld bootstrap` does not instruct daemon users to run TS startup for daemon readiness.
- A missing Bun binary does not prevent daemon status/doctor/backup guard.

Verification:

```bash
cargo test -p context-stilld doctor bootstrap backup
cargo run -q -p context-stilld -- doctor summary --json
cargo run -q -p context-stilld -- bootstrap preflight --json
cargo run -q -p context-stilld -- backup preflight --require-idle --json
```

Stop conditions:

- Rust doctor cannot expose enough detail to debug daemon failures.
- Backup guard loses writer visibility.

### T6: Tighten Verification And Documentation

Goal:
Make the TS-free daemon boundary hard to regress.

Tasks:

- Add a Rust-only daemon readiness gate that does not run Bun.
- Keep `bun run verify:rust-daemon` as development coverage, but add one explicit Rust-only command for packaged/runtime readiness.
- Update `spec/docs/pub/architecture.md` and operations docs:
  - resident daemon is Rust-only;
  - Hono is UI-time;
  - manual TS CLIs are outside daemon;
  - Drizzle remains API/manual storage tooling, not daemon runtime.
- Update `runtime sidecars --json` so daemon debt is zero when only UI/manual TS remains.
- Add a process-tree live check that fails if `context-stilld run` owns Bun/Node.

Completion criteria:

- One command proves daemon runtime is TS-free.
- Docs no longer imply daemon-owned TS sidecars are acceptable as the target state.
- Existing TypeScript test gates still run for product compatibility, but they are not required to start the daemon.

Verification:

```bash
cargo fmt --check
cargo test -p context-stilld
cargo run -q -p context-stilld -- runtime assert-rust-only --json
CONTEXT_STILL_VERIFY_LIVE_OWNERSHIP=1 cargo run -q -p context-stilld -- runtime assert-rust-only --json
bun run verify:rust-daemon
```

Stop conditions:

- The new Rust-only gate duplicates the Bun verify path instead of proving runtime independence.
- Documentation removes necessary TS compatibility information for UI/manual workflows.

## Suggested 2026-06-23 Work Slice

The highest-value one-day slice is:

1. Implement `runtime assert-rust-only --json`.
2. Move daemon LaunchAgent automation into Rust or add the Rust command skeleton with status/load coverage.
3. Make resident queue TS executor unreachable by default and fail closed with visible queue status.
4. Keep the MCP TS dispatch sidecar removed; do not reintroduce `src/cli/mcp-dispatch-once.ts`.
5. Update sidecar registry/docs to distinguish:
   - daemon debt: must be zero;
   - UI-time Hono: allowed;
   - manual TS CLI: allowed outside daemon.

Do not attempt to port every LLM-backed queue executor in the same day unless the fail-closed resident behavior is already verified. Removing resident TS ownership is the first milestone; full Rust execution parity can continue queue by queue.

## Final Acceptance Checklist

- [ ] `launchctl print gui/$(id -u)/com.context-still.daemon` shows only `context-stilld run`.
- [ ] `ps` shows no Bun/Node child under `context-stilld run`.
- [ ] `context-stilld status --json` is usable with Bun absent.
- [ ] `context-stilld doctor summary --json` is usable with Bun absent.
- [ ] `context-stilld runtime sidecars --json` has zero daemon-owned TS sidecars.
- [ ] MCP smoke reaches Rust endpoint and reports zero TS tool owners.
- [ ] Queue inspect explains Rust-owned scheduling and unsupported execution without starting TS.
- [ ] Agent-log-sync scheduled path remains Rust-native.
- [ ] Hono/admin API remains UI-time only.
- [ ] Manual migration/import/export/repair/backfill TS commands remain available but are documented outside daemon runtime.
