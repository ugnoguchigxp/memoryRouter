# Rust-Only Daemon Completion Implementation Plan

> アーカイブ日: 2026-08-15。現行の残作業は [Rust Runtime Closeout Implementation Plan](../rust-runtime-closeout-implementation-plan.md) に再基準化した。

## Purpose

`context-stilld` の daemon 領域を Rust-only にするための残タスク実装計画である。

この文書は見積もりではない。残作業を、実装順序、完了条件、検証ゲート、停止条件で管理する。

## Definition Of Done

この計画でいう Rust-only daemon は次の状態を指す。

- macOS LaunchAgent / packaged service が起動する常駐プロセスは `context-stilld run` のみ。
- queue scheduling / provider lease / durable worker supervision が Rust 実装である。
- MCP endpoint / session management / default tool dispatch が Rust 実装である。
- agent-log-sync の scheduled discovery / parser / SQLite write が Rust 実装である。
- daemon safety surfaces, including status / doctor / backup guard / active writer visibility, are Rust-native enough to run without Bun.
- TypeScript / Bun can still exist for UI-time Hono, explicit manual migration/import/export tasks, and temporary fallback commands, but not for durable daemon runtime.
- `context-stilld status --json`, LaunchAgent state, process tree, SQLite writer state, and smoke outputs agree.

## Current Baseline

Completed:

- `context-stilld run` is the resident owner.
- `com.context-still.daemon` starts `context-stilld run`.
- Legacy queue and agent-log-sync LaunchAgents are unloaded by `automation:context-stilld -- load`.
- MCP endpoint runs inside the resident `context-stilld run` process, and queue scheduling / SQLite maintenance runs in Rust without a resident queue child process.
- agent-log-sync schedule is owned by the Rust resident daemon.
- `queue inspect --json` reads live SQLite queue counts, active provider leases, active target ids, worker pid, and heartbeat from Rust.
- `status --json` uses the resident daemon's effective SQLite path.
- `runtime sidecars --json` exposes the remaining TypeScript sidecars, fallback classifications, runtime status, and removal task ids from Rust.
- `verify:rust-daemon` includes `queue inspect`.
- `verify:rust-daemon` includes `runtime sidecars`.
- `verify:rust-daemon` has an opt-in live LaunchAgent ownership guard via `CONTEXT_STILL_VERIFY_LIVE_OWNERSHIP=1`.
- Rust has internal SQLite queue claim and provider lease manager transactions with parity tests for priority ordering, running-job blocking, stale recovery, route-target preference, active target uniqueness, pool capacity, heartbeat, release, and `finalizeDistille` `next_run_at` behavior.
- Rust has internal SQLite queue state transition APIs for pause, worker-unavailable wait, resume, retry, pause-running, and queue event append, with parity tests for lock clearing, retry metadata, queue event row shape, and `finalizeDistille` `next_run_at` behavior.
- Rust daemon domain source is split by lifecycle responsibility so no `crates/context-stilld/src` Rust file exceeds the maintainability guard of roughly 600 lines.
- `CONTEXT_STILL_RESIDENT_REQUIRE_RUST_ONLY=1` is compatible with the default resident runtime because MCP endpoint/session state, queue scheduling/maintenance, and agent-log-sync all run in Rust.
- `context-stilld run` owns resident queue scheduling and SQLite queue maintenance in Rust; the TypeScript queue business executor is no longer resident-owned and remains manual fallback until R7 completes.
- MCP endpoint, session state, `tools/list`, and the exposed MCP tool handlers are Rust-owned; the stale TypeScript one-shot dispatch path has been removed from daemon sidecar registry.
- MCP session lifecycle is Rust-managed: client `DELETE` closes sessions immediately, closed sessions are pruned by default, and idle sessions are pruned by the resident endpoint loop after the configured TTL.
- agent-log-sync parser/write now runs in Rust against SQLite; `context-stilld run` no longer executes `src/cli/sync-agent-logs.ts`.

Still not Rust-only:

- Queue scheduler and stale-state maintenance are Rust-owned by default in resident runtime; the TypeScript business executor is manual fallback until R7 completes.
- Queue state transitions and executors are still TypeScript by default; Rust currently has internal deterministic state-transition parity APIs, but the TypeScript executor has not been switched to consume them.
- Some doctor checks still delegate to TypeScript.
- Fallback and legacy command paths are not yet classified tightly enough for final removal.

## Non-Goals

- Do not rewrite the UI.
- Do not make the full Hono admin API a resident daemon dependency.
- Do not rewrite every TypeScript CLI.
- Do not change MCP tool names or schemas as part of the daemon migration.
- Do not change queue completion semantics without an explicit parity contract update.
- Do not run queue mutation smokes against the live non-test DB.
- Do not remove TypeScript fallback before Rust parity gates pass.

## Migration Rules

1. Rust ownership must remain true after every task.
   If a change reintroduces a LaunchAgent-owned Bun queue, MCP, or scheduled sync process, stop.

2. Replace behavior behind a stable contract.
   The public CLI/MCP/queue behavior should not change unless the contract file and tests change in the same task.

3. Prefer read-only Rust visibility before Rust mutation.
   Every durable writer migration needs a Rust status/inspect surface first.

4. Keep fallback explicit.
   A fallback may remain only if it is manual or resident-owned-temporary, documented, and tracked to removal.

5. Default switch requires evidence.
   No Rust implementation becomes default without focused Rust tests, existing TypeScript parity tests, smoke output, and rollback path.

## Implementation Order

### R0: Baseline Guard

Goal:
Keep the current verified ownership state from regressing while the remaining implementation proceeds.

Tasks:

- Add a focused live ownership check script or extend `verify:rust-daemon` with a non-mutating optional live check.
- Assert:
  - `com.context-still.daemon` is loaded when live checks are enabled.
  - legacy queue LaunchAgents are not loaded.
  - legacy agent-log-sync LaunchAgents are not loaded.
  - `context-stilld status --json` reports resident / MCP / queue truth from Rust state.
- Keep live check opt-in so CI/test environments without LaunchAgent are not broken.

Completion criteria:

- Ownership drift is detected by one command.
- The command does not mutate live DB.

Verification:

```bash
bun run verify:rust-daemon
cargo run -q -p context-stilld -- status --json
cargo run -q -p context-stilld -- queue inspect --json
```

Stop conditions:

- The check cannot distinguish Rust-owned child processes from independent Bun processes.
- The check needs live DB mutation.

### R1: Sidecar Registry And Fallback Classification

Goal:
Make every remaining TypeScript use visible, classified, and removable.

Tasks:

- Add a Rust-side sidecar registry for temporary TS work.
- Classify each sidecar:
  - `ui-time`;
  - `manual-one-shot`;
  - `resident-owned-temporary`;
  - `forbidden-resident`.
- Expose sidecar owners in a JSON command, for example:

```bash
context-stilld runtime sidecars --json
```

- Add current entries:
  - MCP endpoint Bun child;
  - MCP tool worker / TypeScript handler path;
  - queue worker Bun child;
  - Hono admin API child.
- Add removal task id for every `resident-owned-temporary` entry.

Completion criteria:

- No daemon-relevant Bun execution path is implicit.
- `resident-owned-temporary` entries map to later tasks in this plan.

Verification:

```bash
cargo test -p context-stilld sidecar
cargo run -q -p context-stilld -- runtime sidecars --json
bun run verify:rust-daemon
```

Stop conditions:

- A resident sidecar is discovered but cannot be classified.
- A fallback path can start independent of `context-stilld` and is not explicitly deprecated.

### R2: Rust MCP Endpoint And Session Manager

Goal:
Remove the Bun MCP HTTP server from resident runtime.

Tasks:

- Implement Rust streamable HTTP MCP endpoint inside the resident `context-stilld run` process.
- Move endpoint metadata writing into Rust.
- Move session state into Rust:
  - session id;
  - client metadata;
  - created / last activity;
  - in-flight request count;
  - close reason.
- Prune closed sessions immediately by default and idle sessions on a resident timer so MCP client disconnects do not accumulate resident memory/state.
- Preserve existing endpoint URL contract.
- Keep tool execution behind the Rust dispatch layer.
- Make `mcp endpoint`, `mcp sessions`, and `mcp smoke` read the Rust endpoint state.
- Remove `bun run src/mcp/http-server.ts` and `context-stilld mcp serve` child ownership from resident startup.

Completion criteria:

- No `src/mcp/http-server.ts` process exists under `context-stilld run`.
- No `context-stilld mcp serve` child process exists under `context-stilld run`.
- Port 39172 is owned directly by the `context-stilld run` pid.
- MCP smoke reaches the Rust endpoint.
- Session state is generated by Rust.
- `mcp sessions --json` returns zero active sessions after client shutdown or idle prune.
- Tool owner inventory reports zero MCP TS sidecars.

Verification:

```bash
cargo test -p context-stilld mcp
cargo run -q -p context-stilld -- mcp endpoint --json
cargo run -q -p context-stilld -- mcp sessions --json
cargo run -q -p context-stilld -- mcp smoke --json
bun run verify:mcp
bun run verify:rust-daemon
ps aux | rg 'src/mcp/http-server|mcp-dispatch-once|context-stilld run'
lsof -nP -iTCP:39172 -sTCP:LISTEN
```

Stop conditions:

- MCP schemas drift.
- The client cannot use streamable HTTP and would require restoring stdio as default.
- Rust endpoint cannot expose enough session state for operator diagnosis.

### R3: Rust MCP Tool Registry And Read-Only Tool Dispatch

Goal:
Move deterministic read-only MCP tools into Rust and make ownership visible per tool.

Tasks:

- Split tool metadata/schema contracts from TypeScript handlers.
- Implement Rust-native handlers for:
  - initial instructions; **implemented**
  - status / paths / doctor summary;
  - queue inspect;
  - MCP endpoint/session inspection;
  - read-only episode fetch/search if repository parity is available.
- Add per-tool owner:
  - `rust-native`;
  - `ts-sidecar`;
  - `disabled`.
- Expose tool owner in `mcp smoke --json` or a debug command. **implemented for smoke health inventory**
- Keep non-migrated tools behind explicit TS sidecar dispatch.

Completion criteria:

- Rust serves tool list/schema for migrated tools.
- Migrated read-only tools do not invoke Bun. `initial_instructions` now resolves in Rust.
- Tool owner inventory shows no MCP TS sidecar. `mcp smoke --json` reports `rustNative=12`, `tsSidecar=0`.

Verification:

```bash
cargo test -p context-stilld mcp
cargo run -q -p context-stilld -- mcp smoke --json
bun run verify:mcp
bun run verify:rust-daemon
```

Stop conditions:

- Tool input/output schema changes without contract update.
- Read-only Rust implementation cannot reproduce TypeScript output shape.

### R4: Rust MCP Write Tool Dispatch

Goal:
Move stable SQLite-writing MCP tools into Rust.

Tasks:

- Port write tools only after repository parity exists.
- Start with small transactional tools:
  - `compile_eval`;
  - decision feedback;
  - simple feedback/write surfaces with clear schema.
- Defer LLM-backed tools until provider abstraction and timeout behavior are stable.
- Add SQLite transaction tests for each migrated tool.
- Preserve idempotency and error shape.

Completion criteria:

- Migrated write tools are Rust-native and transactional.
- Existing SQLite MCP smoke and Rust MCP smoke remain green.
- TS sidecar owner list no longer includes migrated tools.

Verification:

```bash
cargo test -p context-stilld mcp
bun run verify:mcp
bun run verify:rust-daemon
```

Stop conditions:

- A migrated tool changes persistence semantics.
- Error shape differs in a way clients observe.
- LLM-backed behavior is needed before provider parity exists.

### R5: Rust Queue Scheduler And Provider Lease Manager

Goal:
Move queue claim, route scheduling, and provider leases from TypeScript to Rust.

Tasks:

- Port SQLite queue polling to Rust.
- Port queue pause controls.
- Port provider pool capacity logic.
- Port target-specific active lease uniqueness.
- Port stale lease recovery.
- Port heartbeat update.
- Preserve route-target granularity:
  - same route / same target waits;
  - different route / different free target can run concurrently.
- Add Rust claim API consumed by the current TS executor during transition.
- Make `queue inspect --json` show Rust scheduler state and lease state.

Completion criteria:

- Rust owns claim transaction and provider lease rows.
- TypeScript worker no longer decides which provider target can run.
- TS executor can only execute a job already claimed by Rust.

Verification:

```bash
cargo test -p context-stilld queue
bun test --timeout=30000 --max-concurrency=1 ./test/sqlite-runtime-support.bun.ts
bun run rust:queue:smoke
bun run verify:rust-daemon
```

Stop conditions:

- Claim order diverges without accepted contract change.
- Active target uniqueness fails.
- Stale lease recovery differs from current behavior.
- Queue mutation tests would require the live DB.

### R6: Rust Queue State Machine And Maintenance

Goal:
Move deterministic queue state transitions and maintenance from TypeScript to Rust before moving business executors.

Tasks:

- Port retry / fail / skip / complete state transitions.
- Port stale running job recovery.
- Port heartbeat ownership.
- Port queue event writing.
- Keep business execution behind TS sidecar until executor parity is available.

Completion criteria:

- Rust owns durable queue state transitions.
- TS sidecar cannot directly mutate queue state except through Rust API.
- Queue events remain compatible.

Verification:

```bash
cargo test -p context-stilld queue
bun test --timeout=30000 --max-concurrency=1 ./test/sqlite-runtime-support.bun.ts
bun run rust:queue:smoke
```

Stop conditions:

- Event history or retry semantics drift.
- TS executor still writes queue status directly.

### R7: Rust Queue Executors

Goal:
Remove the resident TypeScript queue worker from daemon runtime.

Migration order:

1. Deterministic maintenance executor.
2. Episode distiller source reading and EpisodeCard persistence.
3. cover/finalize deterministic persistence pieces.
4. findCandidate orchestration after LLM/provider/tool contracts are Rust-ready.
5. remaining LLM-backed execution paths.

Tasks:

- Define per-queue contract fixtures.
- Add golden input/output fixtures before each executor migration.
- Add Rust provider abstraction for LLM calls.
- Add timeout and retry parity.
- Keep per-queue TS fallback only until its Rust executor passes parity.
- Make unsupported queue execution fail closed instead of silently using an untracked sidecar.

Completion criteria:

- `context-stilld run` no longer spawns `src/cli/queue-supervisor.ts`.
- All resident queue execution is Rust-native.
- Any remaining TypeScript queue command is manual fallback only.

Verification:

```bash
cargo test -p context-stilld queue
bun test --timeout=30000 --max-concurrency=1 ./test/sqlite-runtime-support.bun.ts
bun run verify:sqlite
bun run verify:rust-daemon
ps aux | rg 'queue-supervisor|context-stilld run'
```

Stop conditions:

- Queue output differs from fixture without accepted contract change.
- LLM timeout / fallback behavior cannot be matched.
- A TS queue worker remains in the resident process tree.

### R8: Rust Agent Log Sync

Goal:
Remove the scheduled agent-log-sync TypeScript sidecar from daemon runtime.

Tasks:

- Port agent root discovery to Rust.
- Port sync state reading/writing.
- Port parsers incrementally:
  - Codex;
  - Claude;
  - Antigravity.
- Port SQLite writes and dedupe behavior.
- Preserve fixture output for each parser.
- Remove resident one-shot Bun sidecar after parser/write parity.

Completion criteria:

- `context-stilld run` no longer executes `src/cli/sync-agent-logs.ts`.
- Scheduled sync is Rust-native.
- Existing parser fixture tests have Rust parity coverage.

Verification:

```bash
cargo test -p context-stilld agent_log_sync
bun test --timeout=30000 --max-concurrency=1 ./test/agent-log-sync.test.ts ./test/agent-log-sync-codex-parser.test.ts ./test/agent-log-sync-claude-parser.test.ts ./test/agent-log-sync-antigravity-parser.test.ts
bun run rust:agent-log-sync:smoke
bun run verify:rust-daemon
ps aux | rg 'sync-agent-logs|agent-log-sync|context-stilld run'
```

Stop conditions:

- Parser output diverges.
- Dedupe behavior diverges.
- Rust sync cannot safely resume from existing sync state.

### R9: Rust Doctor And Backup Guard Completion

Goal:
Make daemon safety checks independent of TypeScript for daemon readiness and backup safety.

Tasks:

- Expand Rust SQLite checks.
- Include active queue/MCP/sync writer details.
- Include active lease details.
- Include sidecar registry status.
- Keep provider/LLM live checks optional and non-destructive.
- Remove TypeScript dependency from backup preflight required for local daemon operation.

Completion criteria:

- `doctor summary --json` can diagnose daemon readiness without Bun.
- `backup preflight --require-idle --json` blocks on all Rust-owned active writers.
- Backup guard does not need Hono or TypeScript runtime.

Verification:

```bash
cargo test -p context-stilld doctor backup
cargo run -q -p context-stilld -- doctor summary --json
cargo run -q -p context-stilld -- backup preflight --require-idle --json
bun run verify:rust-daemon
```

Stop conditions:

- A required backup safety check still needs TypeScript.
- Active writer details are incomplete.

### R10: Default Switch And Legacy Removal

Goal:
Make Rust-only daemon the default and remove resident TypeScript daemon paths.

Tasks:

- Remove resident TS sidecars from `context-stilld run`.
- Remove or deprecate LaunchAgent install/load paths that start Bun resident workers.
- Keep manual fallback commands separate from resident runtime.
- Update docs:
  - CLI;
  - operations;
  - configuration;
  - MCP registration;
  - rollback.
- Add final live ownership check.
- Add a one-command rollback only for the last accepted fallback boundary.

Completion criteria:

- LaunchAgent starts only `context-stilld run`.
- Resident process tree has no Bun child for queue, MCP, or scheduled sync.
- `runtime sidecars --json` has no `resident-owned-temporary` entries.
- `verify:rust-daemon` and focused smoke gates pass.

Verification:

```bash
bun run verify:rust-daemon
bun run verify
cargo run -q -p context-stilld -- status --json
cargo run -q -p context-stilld -- queue inspect --json
cargo run -q -p context-stilld -- mcp smoke --json
ps aux | rg 'context-stilld|bun|queue-supervisor|sync-agent-logs|mcp/http-server|mcp-dispatch-once'
```

Stop conditions:

- Any durable daemon surface still needs resident Bun.
- Rollback would require manual multi-step surgery.
- A hidden Bun process can still be started by default config.

## Tracking Table

| ID | Task | Depends on | Gate | Status |
|---|---|---|---|---|
| R0 | Baseline ownership guard | current live state | `verify:rust-daemon`, optional live check | implemented |
| R1 | Sidecar registry and fallback classification | R0 | `runtime sidecars --json` | implemented |
| R2 | Rust MCP endpoint/session manager | R1 | Rust/SQLite MCP smoke | implemented |
| R3 | Rust read-only MCP tool dispatch | R2 | Rust/SQLite MCP smoke + owner inventory | in progress |
| R4 | Rust write MCP tool dispatch | R3 | SQLite transaction tests + Rust/SQLite MCP smoke | pending |
| R5 | Rust queue scheduler/provider leases | R1 | Rust queue tests + TS SQLite parity | in progress |
| R6 | Rust queue state machine/maintenance | R5 | queue state/event parity | in progress |
| R7 | Rust queue executors | R6 | per-queue fixtures + smoke | pending |
| R8 | Rust agent log sync parser/write | R1 | parser parity + sync smoke | implemented |
| R9 | Rust doctor/backup guard completion | R1, R5 | doctor/backup JSON gates | pending |
| R10 | Default switch and legacy removal | R2-R9 | full verify + live process tree | pending |

## Global Verification Matrix

| Area | Command | Required before |
|---|---|---|
| Rust tests | `cargo test -p context-stilld` | every task |
| Rust lint | `cargo clippy --workspace --all-targets -- -D warnings` | default switches |
| Daemon gate | `bun run verify:rust-daemon` | every default switch |
| Queue parity | `bun test --timeout=30000 --max-concurrency=1 ./test/sqlite-runtime-support.bun.ts` | R5-R7 |
| Queue smoke | `bun run rust:queue:smoke` | R5-R7 |
| MCP smoke | `bun run verify:mcp` | R2-R4 |
| MCP smoke | `cargo run -q -p context-stilld -- mcp smoke --json` | R2-R4 |
| Agent sync parity | parser fixture tests plus `bun run rust:agent-log-sync:smoke` | R8 |
| Backup guard | `cargo run -q -p context-stilld -- backup preflight --require-idle --json` | R9-R10 |
| Live ownership | LaunchAgent/status/process tree check | R0, R10 |

## Global Stop Conditions

Stop and ask for review if:

- Both a legacy LaunchAgent and `context-stilld` can own the same durable surface.
- `status --json` and process tree disagree.
- A live non-test DB mutation is needed for a smoke.
- MCP schemas or tool names would change.
- Queue completion/retry semantics would change.
- A TS fallback must be deleted before Rust parity exists.
- A new resident Bun path is introduced.
- A required Rust check cannot distinguish manual fallback from resident runtime.

## Next Task

Continue with R3 and R5.

R0 now provides the optional live LaunchAgent ownership guard, R1 creates the map needed to delete resident TypeScript intentionally, and R2 moves the MCP endpoint/session owner into Rust. R3 has Rust-native `tools/list`, `initial_instructions`, and smoke-visible owner inventory; the remaining read-only tool handlers still need to move before the one-shot TypeScript tool dispatch can shrink materially. R5 has Rust claim / provider lease manager parity APIs, and R6 has deterministic state-transition plus queue-event parity APIs, but TS executor handoff is still pending.
