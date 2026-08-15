# Daemon-Owned MCP Runtime Plan

> アーカイブ日: 2026-08-15。実装コミット: `64cdcf2`、legacy path 削除: `5f1bdb3`。

## Purpose

MCP の所有権を stdio child process から常駐 `context-stilld` daemon へ戻す。

過去の direct stdio MCP は、MCP client の再起動・切断・親プロセス不整合時に `bun run src/index.ts` が残留しやすい。stdio 側の graceful shutdown は防御策にはなるが、ゾンビプロセスを完全には防げない。MCP は常駐 daemon が接続、tool execution、worker、状態、cleanup を一元管理するべき runtime boundary である。

この計画では stdio MCP server を削除対象にし、互換 shim を復元しない。

## Decisions

- MCP server runtime は `context-stilld` が所有する。
- MCP client registration は command/stdin/stdout 型ではなく、daemon の local MCP endpoint を指す。
- `bun run src/index.ts` direct stdio MCP は削除し、復元しない。
- `StdioServerTransport` / `StdioClientTransport` を本番 runtime path から外す。
- TypeScript tool logic は短期的には残せるが、stdio process としてではなく daemon-managed worker / local RPC として扱う。
- cleanup コマンドで残骸を掃除する運用は mainline にしない。接続破棄、idle timeout、worker stop は daemon の責務にする。

## Target Architecture

```text
MCP client
  -> local HTTP / streamable MCP endpoint
  -> context-stilld resident daemon
  -> MCP session manager
  -> tool execution bridge
  -> TypeScript tool worker or Rust-native tool handler
  -> SQLite / source files / logs
```

The important boundary is ownership:

- Client connection lifecycle: daemon owned.
- Active session registry: daemon owned.
- Tool worker process: daemon owned.
- SQLite writer safety and shutdown: daemon owned.
- UI/Hono lifecycle: not required for MCP availability.
- stdio compatibility: legacy only, scheduled for deletion.

## Current Legacy Surfaces

These surfaces must be treated as migration targets, not long-term architecture:

| Surface | Current role | Target |
|---|---|---|
| `src/index.ts` | deleted stdio MCP server entrypoint | Do not restore |
| `src/mcp/server.ts` transport binding | transport-neutral tool/resource registry | Keep transport-neutral |
| `bun run start:mcp:stdio` | deleted direct stdio server start | Do not restore |
| `src/cli/setup-mcp-config.ts` | writes command-based MCP config | write daemon URL-based MCP config |
| `src/cli/onboarding/mcp-config.ts` | prints command-based MCP config | print daemon URL-based MCP config |
| `src/cli/mcp-smoke.ts` | deleted stdio client smoke | Use daemon endpoint smoke |
| `context-stilld mcp start` | starts managed endpoint worker | keep only as legacy lifecycle helper; clients must not use command registration |
| `context-stilld mcp serve` plan | foreground stdio proxy | reject; superseded by daemon-owned endpoint |

## Command Model

### Keep

```bash
context-stilld daemon start|stop|status
context-stilld mcp status --json
context-stilld mcp sessions --json
context-stilld mcp disconnect <session-id>
context-stilld doctor summary --json
```

### Add

```bash
context-stilld mcp endpoint --json
context-stilld mcp smoke --json
```

`mcp endpoint` returns the local endpoint URL, readiness state, auth/token state if any, and active session counts.

### Deleted / Forbidden

```bash
bun run start:mcp:stdio
context-stilld mcp serve
```

`context-stilld mcp start|stop` may manage only the daemon endpoint worker. They must not spawn a stdio MCP child.

## Daemon Endpoint

Default endpoint:

```text
http://127.0.0.1:<daemon-port>/mcp
```

Requirements:

- Bind only to loopback by default.
- Use a daemon-owned random or configured port.
- Store endpoint metadata under app data, not repo-local paths.
- Never write MCP protocol messages to logs.
- Keep logs separate from protocol response streams.
- Expose readiness only after the MCP endpoint can list tools.

If the MCP client supports streamable HTTP MCP, generated config should use URL registration, not command registration.

Example target Codex config:

```toml
[mcp_servers.context-still]
url = "http://127.0.0.1:45678/mcp"
enabled = true
```

## Tool Execution Bridge

Short-term implementation can keep TypeScript tool logic, but it must not keep stdio as the process model.

Allowed bridge options:

1. Long-lived daemon-managed Bun worker exposing local RPC over Unix domain socket.
2. One-shot Bun worker for specific heavy tasks, with daemon-owned timeout and exit metadata.
3. Gradual Rust-native implementation for stable deterministic tools.

Rejected bridge options:

- daemon spawning `bun run src/index.ts` as a background stdio MCP server.
- daemon foreground stdio proxy as the default MCP client path.
- cleanup-only process management that lets orphaned stdio servers happen first.

## Session Lifecycle

The daemon must own MCP session cleanup.

Session state should include:

- `sessionId`
- client name / version when available
- remote address
- created time
- last activity time
- in-flight request count
- worker id / route
- close reason

Cleanup rules:

- idle sessions close after a configured timeout.
- transport close immediately removes the session.
- daemon shutdown closes all sessions before stopping workers.
- worker crash marks affected sessions degraded and returns structured MCP errors.
- stale sessions are visible in `context-stilld mcp sessions --json` until reconciled or archived.

## Migration Phases

### Phase 1: Document and Guard Legacy stdio

- Add this plan.
- Update `rust-daemon-replacement-readiness-plan.md` to supersede MCP stdio proxy.
- Remove direct stdio MCP from public docs.
- Add diagnostics that warn when MCP config still uses command-based registration.

Verification:

```bash
rg -n "src/index\\.ts|start:mcp:stdio|StdioServerTransport|mcp-smoke" README.md spec docs src crates package.json
```

Expected result: no production context-still MCP runtime references.

### Phase 2: Add Daemon MCP Endpoint Skeleton

- Add daemon HTTP/streamable MCP endpoint.
- Implement `mcp endpoint`, `mcp status`, and `mcp sessions`.
- Serve a minimal list-tools response from the daemon endpoint.
- Do not yet remove TypeScript MCP tools.

Verification:

```bash
cargo test --workspace
bun run verify:rust-daemon
context-stilld mcp endpoint --json
context-stilld mcp smoke --json
```

### Phase 3: Move Tool Execution Behind Daemon Bridge

- Split MCP tool definitions/handlers from stdio transport.
- Add daemon-managed TypeScript worker RPC or Rust-native handlers.
- Ensure daemon tracks worker pid, health, request timeout, and exit reason.
- Ensure no tool request creates a detached Bun process.

Verification:

```bash
context-stilld mcp smoke --json
context-stilld mcp sessions --json
pgrep -af "bun run src/index.ts" # must return no daemon-owned MCP process
```

### Phase 4: Switch Client Registration

- Change `setup-mcp-config` to write URL-based daemon config.
- Change onboarding snippets to URL-based daemon config.
- Update `README.md`, `spec/docs/pub/getting-started.md`, and `spec/docs/pub/mcp-tools.md`.
- Add migration warning for command-based configs.

Verification:

```bash
bun run setup:mcp-config -- --dry-run
rg -n '"args": \\["run", "start:mcp"\\]|args = \\[ "run", "src/index.ts" \\]' ~/.codex ~/.gemini
```

### Phase 5: Delete stdio MCP Runtime

Delete or repurpose:

- `src/index.ts`
- stdio-specific code in `src/mcp/server.ts`
- `start:mcp:stdio`
- stdio MCP smoke path
- `context-stilld mcp serve`
- `context-stilld mcp start|stop` if they only manage stdio child processes

Keep only transport-neutral tool modules and daemon-owned endpoint tests.

Verification:

```bash
rg -n "StdioServerTransport|start:mcp:stdio|src/index\\.ts|mcp serve|mcp-smoke"
bun run verify
bun run verify:rust-daemon
context-stilld mcp smoke --json
```

The `rg` command should return no production runtime references.

## Acceptance Criteria

- MCP client registration no longer spawns `bun`.
- `pgrep -af "bun run src/index.ts"` remains empty during normal MCP use.
- Killing or restarting the MCP client does not leave daemon worker or session state stale.
- `context-stilld mcp sessions --json` shows active sessions and close reasons.
- Stopping `context-stilld` closes MCP sessions and tool workers.
- Restarting `context-stilld` restores endpoint availability without user editing MCP config.
- All command-based context-still MCP docs are removed.
- `StdioServerTransport` is absent from production context-still MCP runtime code.

## Rollback

Rollback must not reintroduce unbounded stdio process spawning.

Allowed rollback:

- Keep daemon endpoint enabled but route tool execution to a simpler daemon-managed worker.
- Disable selected MCP tools while keeping session ownership in daemon.
- Restore a single daemon-owned worker from a known-good version.

Disallowed rollback:

- Re-register MCP clients to run `bun run src/index.ts` directly.
- Reintroduce foreground stdio proxy as the default path.
- Rely on cleanup scripts as the main orphan prevention strategy.
