# CLI Reference

Run commands from the repository root.

## Setup and Health

| Command | Description |
|---|---|
| `bun run startup` | Interactive dry-run startup and health plan for the advanced server setup path |
| `bun run startup -- --apply` | Apply advanced server startup changes after review |
| `bun run init:project -- --json` | Initialize project state and print next actions |
| `bun run setup:mcp-config` | Write URL-based MCP registration for Codex and Antigravity |
| `bun run doctor` | Full health report |
| `bun run db:migrate` | Apply database migrations |
| `bun run db:seed` | Upsert seed knowledge |
| `bun run db:seed:export` | Export knowledge seed data |

## Rust Daemon Boundary Preview

`context-stilld` is the Rust boundary host under migration. It is safe to use for path/status/preflight inspection and delegated lifecycle experiments, but it is not the default replacement for TypeScript commands yet.

| Command | Description |
|---|---|
| `cargo run -q -p context-stilld -- paths --json` | Resolve app data, logs, run, backup, and SQLite paths |
| `cargo run -q -p context-stilld -- status --json` | Report Rust-managed process state from pid/state files |
| `cargo run -q -p context-stilld -- bootstrap preflight --json` | Read-only first-run readiness summary |
| `cargo run -q -p context-stilld -- bootstrap init --json` | Explicitly create app data/logs/run/backup directories |
| `cargo run -q -p context-stilld -- doctor summary --json` | Desktop-focused summary that delegates full detail to `bun run doctor` |
| `cargo run -q -p context-stilld -- backup preflight --json` | Check SQLite path and active managed writers before an offline Rust backup |
| `cargo run -q -p context-stilld -- backup preflight --require-idle --json` | Fail if Rust-managed writer processes are active |
| `bun run sqlite:backup --json` | Create an offline backup after stopping the resident writer |
| `bun run sqlite:backup:verify --path /absolute/backup.sqlite --json` | Verify integrity, references, schema and SHA-256 without modifying the file |
| `bun run verify:onboarding` | Isolated first-use, dependency recovery and backup/restore smoke |
| `cargo run -q -p context-stilld -- mcp endpoint --json` | Print the daemon-owned streamable HTTP MCP endpoint URL and readiness |
| `cargo run -q -p context-stilld -- mcp status --json` | Report the managed MCP endpoint worker state |
| `cargo run -q -p context-stilld -- mcp sessions --json` | List daemon-visible MCP sessions and close reasons |
| `cargo run -q -p context-stilld -- mcp smoke --json` | Check endpoint readiness and exposed tool inventory |
| `cargo run -q -p context-stilld -- mcp start\|stop` | Legacy endpoint-worker lifecycle helper; clients should use URL registration, not command spawning |
| `cargo run -q -p context-stilld -- queue start\|stop\|status` | Run Rust queue maintenance, stop stale managed state, or report queue scheduler status |
| `cargo run -q -p context-stilld -- queue inspect --json` | Read live SQLite queue counts, active provider leases, active target ids, worker pid, and last heartbeat |
| `cargo run -q -p context-stilld -- agent-log-sync run\|stop\|status` | Delegate agent log sync lifecycle |
| `cargo run -q -p context-stilld -- agent-log-sync run --wait --json` | Run one-shot sync and record exit status |
| `cargo run -q -p context-stilld -- admin-api start\|stop\|status` | Start/stop Hono admin API for UI/operator sessions only; start waits for readiness |
| `cargo run -q -p context-stilld -- runtime sidecars --json` | List remaining TypeScript sidecars, fallback classifications, runtime status, and removal task ids |

Focused pre-switch smoke scripts:

```bash
bun run rust:mcp:smoke
bun run rust:queue:smoke
bun run rust:admin-api:smoke
bun run rust:agent-log-sync:smoke
```

The `CONTEXT_STILL_DAEMON_MANAGED_MCP`, `CONTEXT_STILL_DAEMON_MANAGED_QUEUE`, `CONTEXT_STILL_DAEMON_MANAGED_AGENT_LOG_SYNC`, and `CONTEXT_STILL_DAEMON_MANAGED_ADMIN_API` flags are currently observable in `status --json`; they do not change package script defaults yet.

## Compile and Knowledge

| Command | Description |
|---|---|
| `bun run compile --goal "<goal>" --repo-path "$PWD"` | Compile task-specific context |
| `bun run eval:context` | Run deterministic context evaluation tooling |
| `bun run import:wiki <path>` | Import Markdown source tree |
| `bun run import:markdown <file>` | Import one Markdown file |
| `bun run backfill:knowledge-project-context` | Backfill project context metadata |
| `bun run backfill:knowledge-value` | Backfill value metrics |
| `bun run backfill:knowledge-source-links` | Backfill source evidence links |
| `bun run backfill:knowledge-origin-links` | Backfill origin trace links |
| `bun run knowledge:apply-feedback-quality` | Apply feedback-derived quality adjustments |

## Decisions

| Command | Description |
|---|---|
| `bun run decision:pr-discard-scan -- --dry-run` | Preview `discarded_pr` feedback for closed PRs linked from Context Decision metadata |
| `bun run decision:pr-discard-scan -- --apply` | Create `discarded_pr` system feedback and effects for confirmed closed linked PRs |
| `bun run decision:pr-discard-scan -- --since <iso-date>` | Limit the scan to recent decision runs |

## Distillation Queue

| Command | Description |
|---|---|
| `bun run queue:finding:once` | Run one finding-candidate cycle |
| `bun run queue:episode-distiller:once` | Run one episode-distiller cycle |
| `bun run queue:covering:once` | Run one evidence-coverage cycle |
| `bun run queue:merge-review:once` | Run one DeadZone merge-review cycle |
| `bun run queue:finalize:once` | Run one finalization cycle |
| `bun run queue:merge-activation-finalize:once` | Run one merge-activation finalization cycle |
| `bun run queue:migrate:dry-run` | Preview queue migration mapping |
| `bun run queue:migrate:write` | Write queue migration mapping rows |
| `bun run distill:reprocess-rejected` | Reprocess rejected candidates where eligible |

## Agent Logs and Automation

| Command | Description |
|---|---|
| `bun run sync:agent-logs` | One-time Codex / Antigravity / Claude log sync |
| `bun run automation:context-stilld -- install` | Install macOS LaunchAgent for resident `context-stilld run` |
| `bun run automation:context-stilld -- load` | Load resident daemon and unload legacy queue / agent-log-sync LaunchAgent owners |
| `bun run automation:context-stilld -- status` | Inspect resident daemon LaunchAgent and legacy owner state |

## Landscape

| Command | Description |
|---|---|
| `bun run landscape -- --window-days 30` | Generate a landscape snapshot |
| `bun run landscape -- --window-days 30 --json` | Emit full snapshot JSON |
| `bun run landscape -- --queue --queue-source replay_compare,landscape_snapshot` | Materialize review items |
| `bun run landscape -- --queue-list --queue-status pending` | List review items |
| `bun run landscape -- --queue-create-candidates --queue-status pending` | Create candidate drafts from review items |

## Development and Verification

| Command | Description |
|---|---|
| `bun run dev` | Start Vite dev server with API |
| `bun run start:api` | Start API server |
| `cargo run -q -p context-stilld -- mcp start` | Start the local streamable HTTP MCP endpoint |
| `bun run typecheck` | TypeScript check |
| `bun run lint` | Biome lint |
| `bun run format:check` | Biome format check |
| `bun run test:unit` | Unit tests |
| `bun run test:integration` | Destructive integration tests against a test DB |
| `bun run verify` | Daily fast quality gate without DB/MCP/queue dependencies |
| `bun run verify:fast` | Alias for the daily fast quality gate |
| `bun run verify:sqlite` | SQLite local backend verification |
| `bun run verify:desktop-readiness` | Desktop/local readiness preflight |
| `bun run verify:mcp` | Rust MCP endpoint smoke plus SQLite MCP smoke |
| `bun run verify:queue:smoke` | Queue operational smoke against a test DB |
| `bun run verify:full` | Release/full gate: fast verify, SQLite verify, and Rust daemon verify |

## Examples

```bash
bun run compile --goal "fix context compiler ranking" \
  --repo-path "$PWD" \
  --change-types bugfix,backend \
  --technologies bun,typescript \
  --domains context-compiler \
  --json
```

```bash
bun run landscape -- --queue-create-candidates --queue-status pending --queue-limit 20
bun run queue:covering:once
```
