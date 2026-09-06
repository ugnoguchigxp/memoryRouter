<p align="center">
  <strong>context-still</strong><br/>
  <em>Local-first knowledge control plane for coding agents</em>
</p>

<p align="center">
  <a href="https://github.com/ugnoguchigxp/contextStill/actions/workflows/verify.yml"><img alt="verify" src="https://github.com/ugnoguchigxp/contextStill/actions/workflows/verify.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="#table-of-contents">Contents</a> ·
  <a href="#desktop-quick-start">Desktop Quick Start</a> ·
  <a href="#mcp-integration">MCP Integration</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="#development">Development</a> ·
  <a href="README.jp.md">日本語</a>
</p>

---

## What is context-still?

context-still is a local-first control plane for coding-agent memory. It turns source docs, web research, agent logs, and explicit candidate notes into reusable `rule` / `procedure` knowledge, then compiles task-specific context packs through MCP, CLI, API, and an admin UI.

The default product path is desktop/local:

- storage: SQLite in a local app data path
- UI: local admin/control-plane experience, with Tauri packaging as the desktop target
- daemon: `context-stilld run` owns the resident SQLite writer, MCP endpoint, queues, and log sync
- MCP: optional streamable HTTP agent integration enabled by the user
- model usage: minimal local usage first, with local LLM and cloud-assisted modes as optional upgrades

It is designed for teams and individuals who want an auditable loop:

```text
collect evidence -> distill knowledge -> compile task context -> evaluate usefulness -> register new lessons
```

Core capabilities:

- Evidence-backed knowledge distillation with source links and candidate review.
- Primary MCP workflow tools for `initial_instructions`, `context_compile`, `compile_eval`, `context_decision`, and `context_decision_feedback`, with supplemental MCP lookup, diagnostics, and candidate-registration tools.
- SQLite local storage for the primary knowledge/search/context compile path.
- Agent log sync for Codex, Antigravity, and Claude logs.
- Queue-based distillation workers and health diagnostics.
- Knowledge Landscape diagnostics for graph, replay, review items, and approval-gated candidates.
- Decision history that persists autonomous execute/escalate decisions, Knowledge evidence, coverage traces, and feedback.

context-still is local-first software, not a hosted SaaS. You control the database, sources, settings, API/admin runtime, automation workers, and MCP registration.

## Table of Contents

- [What is context-still?](#what-is-context-still)
- [Desktop Quick Start](#desktop-quick-start)
- [Product Modes](#product-modes)
- [Runtime Boundary](#runtime-boundary)
- [MCP Integration](#mcp-integration)
- [Advanced Server Backend](#advanced-server-backend)
- [Common Workflows](#common-workflows)
- [Documentation](#documentation)
- [Project Structure](#project-structure)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Desktop Quick Start

Requirements: Bun 1.3.14, Git, and the stable Rust toolchain (Cargo and a native C compiler).

```bash
git clone https://github.com/ugnoguchigxp/contextStill.git
cd contextStill
bun install --frozen-lockfile
```

In the first terminal, initialize a dedicated local data directory and keep the resident writer running. Background queue execution and personal log import are disabled for this first run:

```bash
export CONTEXT_STILL_APP_DATA_DIR="$PWD/data/local"
export CONTEXT_STILL_SQLITE_CORE_PATH="$CONTEXT_STILL_APP_DATA_DIR/context-still-core.sqlite"
export CONTEXT_STILL_DB_BACKEND=sqlite
export CONTEXT_STILL_SOURCE_CONTENT_ROOT="$CONTEXT_STILL_APP_DATA_DIR/wiki"
export CONTEXT_STILL_EMBEDDING_PROVIDER=disabled
cargo build --locked -p context-stilld
./target/debug/context-stilld bootstrap init --json
CONTEXT_STILL_RESIDENT_QUEUE=0 CONTEXT_STILL_RESIDENT_AGENT_LOG_SYNC=0 \
  ./target/debug/context-stilld run
```

In a second terminal, open the same repository and use the same absolute paths:

```bash
export CONTEXT_STILL_APP_DATA_DIR="$PWD/data/local"
export CONTEXT_STILL_SQLITE_CORE_PATH="$CONTEXT_STILL_APP_DATA_DIR/context-still-core.sqlite"
export CONTEXT_STILL_DB_BACKEND=sqlite
export CONTEXT_STILL_SOURCE_CONTENT_ROOT="$CONTEXT_STILL_APP_DATA_DIR/wiki"
export CONTEXT_STILL_EMBEDDING_PROVIDER=disabled
./target/debug/context-stilld bootstrap preflight --json
bun run compile --goal "understand this repository's development workflow" \
  --repo-path "$PWD" --change-types docs,plan --domains onboarding,workflow --json
bun run dev
```

Open http://localhost:39171. The API shares that origin under `/api/*`. An empty database returns an empty context pack; this is expected until knowledge has been added. `--repo-path` is required for repository-specific retrieval; `--global` explicitly selects global knowledge only.

For use without model calls, open **Settings → taskRouting → agenticCompile.runtime**, turn **enabled** off, and save before compiling populated knowledge. Embeddings are disabled by the environment above. A configured custom admin key is entered in the sign-in form; the built-in local key signs in automatically.

`bootstrap init` creates directories. The resident `run` command initializes/migrates SQLite and owns its writer; `mcp start` by itself does not start that writer. Client registration remains optional. Stop the first terminal with Ctrl+C when finished.

The automated equivalent runs in a temporary directory, retrieves newly saved knowledge, checks outage/recovery, and verifies a backup and restore without provider calls:

```bash
bun run verify:onboarding
```

The Tauri shell remains a packaging target. For the current development runtime, follow these SQLite commands; interactive `startup` still targets the advanced server path.

## Product Modes

| Mode | Purpose | Required setup |
|---|---|---|
| `minimal` | SQLite + local sources + manual/MCP candidates + context compile | Bun, Rust and a local SQLite path |
| `cloud-review` | Cloud LLM assisted distillation, review, and decision support | Provider credentials and route settings |
| `local-llm` | Local LLM / local embedding assisted distillation | Local OpenAI-compatible endpoint and/or embedding service |

Minimal mode should remain useful without external LLMs, external search APIs, or MCP client registration.

## Runtime Boundary

context-still separates the long-lived runtime from the admin UI surface:

| Surface | Default lifetime | Responsibility |
|---|---|---|
| Daemon / worker runtime | Runs independently of the UI | MCP endpoint supervision, CLI commands, queue scheduling/maintenance, agent-log sync scheduling, automation, doctor, backup, bootstrap, process supervision, and runtime sidecar visibility |
| Hono API | Runs when the admin UI needs HTTP access | Admin UI facade for knowledge, sources, graph, queue controls, settings, context runs, decision history, and dashboards |
| Tauri / web UI | Opened on demand | Knowledge maintenance, review, settings, diagnostics, and operator actions |

The Hono API should stay a UI-facing facade. Durable background work and external agent integration belong to the daemon/CLI/MCP side, so closing the UI does not imply stopping log sync scheduling, queue supervision, MCP availability, or scheduled maintenance. The current Rust daemon is the resident owner. MCP endpoint/session management, exposed MCP tool handlers, queue scheduling/maintenance, and agent-log-sync parser/write paths are Rust-owned. TypeScript/Bun remains available for UI-time Hono and explicit operator CLIs, not as a resident daemon dependency.

## MCP Integration

The resident process in the quick start already serves MCP. Confirm its endpoint:

```bash
cargo run -q -p context-stilld -- mcp endpoint --json
```

For an MCP client, use:

```json
{
  "mcpServers": {
    "context-still": {
      "url": "http://127.0.0.1:39172/mcp",
      "enabled": true
    }
  }
}
```

`bun run setup:mcp-config` writes this URL-based registration for Codex and Antigravity. The old direct stdio context-still MCP server and TypeScript MCP HTTP worker have been removed and must not be restored for client registration. The endpoint and exposed tool handlers are owned by `context-stilld`.

After connecting the MCP server, call `initial_instructions` once at the start of a project session. The primary workflow is `context_compile` before task work, `context_decision` before asking the user or creating a PR when autonomous progress may still be possible, `context_decision_feedback` when a decision outcome is known, and `compile_eval` after task work. Other exposed tools remain available as supplemental diagnostics, lookup, or explicit knowledge-maintenance tools, but they are not part of the normal primary workflow.

MCP is an agent integration surface. It is not a hidden requirement for opening the local app or inspecting existing knowledge.

## Advanced Server Backend

The PostgreSQL / pgvector backend is legacy compatibility code. It is not maintained as a completion gate and is not required for the default desktop/local path.

Use it when you are explicitly testing or operating the server backend:

```bash
docker compose up -d
cp .env.example .env
bun run db:migrate
```

Server backend constraints are documented in [Architecture Overview](spec/docs/pub/architecture.md) and [Operations](spec/docs/pub/operations.md). Treat this path as opt-in until server productization, auth, multi-user operation, and remote DB latency assumptions are settled.

## Common Workflows

Import local source docs:

```bash
bun run import:wiki ./wiki/pages
```

Sync local agent logs:

```bash
bun run sync:agent-logs
```

Run the distillation pipeline one stage at a time:

```bash
bun run queue:finding:once
bun run queue:covering:once
bun run queue:merge-review:once
bun run queue:finalize:once
bun run queue:merge-activation-finalize:once
```

Scan Context Decision records for closed linked PRs and record `discarded_pr` feedback when you explicitly apply it:

```bash
bun run decision:pr-discard-scan -- --dry-run
bun run decision:pr-discard-scan -- --apply
```

Install the resident daemon automation on macOS:

```bash
bun run automation:context-stilld -- install
bun run automation:context-stilld -- load
```

Install optional Git hooks that remind agents to evaluate compile output and register durable candidates:

```bash
./scripts/setup-candidate-registration-hook.sh install
```

## Documentation

Public user and operator documentation lives under `spec/docs/pub/`.

| Document | Purpose |
|---|---|
| [Documentation Index](spec/docs/pub/README.md) | Public documentation map |
| [Getting Started](spec/docs/pub/getting-started.md) | Desktop quick start, MCP integration, and first compile |
| [Architecture Overview](spec/docs/pub/architecture.md) | Product modes, backend boundaries, and runtime components |
| [MCP Tools](spec/docs/pub/mcp-tools.md) | Detailed MCP tool contract and workflow |
| [CLI Reference](spec/docs/pub/cli.md) | Supported commands and examples |
| [REST API Reference](spec/docs/pub/api.md) | HTTP API endpoint inventory |
| [Configuration](spec/docs/pub/configuration.md) | Desktop defaults and advanced configuration |
| [Operations](spec/docs/pub/operations.md) | Doctor, backups, automation, and server backend operations |

Internal implementation plans and design notes live under `spec/docs/`.

## Project Structure

```text
src/          TypeScript runtime, CLI, MCP server, domain modules
api/          Hono REST API
web/          React admin UI
drizzle/      Server backend migrations
scripts/      Verification, automation, and maintenance scripts
github-pages/ Landing page source and generated Pages artifact
spec/docs/pub/ Public documentation
spec/docs/    Internal implementation and design documents
test/         Unit and integration tests
e2e/          Playwright end-to-end tests
```

## Development

Run the daily fast verification gate before opening a pull request:

```bash
bun run verify
```

Run the desktop/local readiness gate before starting packaging or Tauri shell work:

```bash
bun run verify:desktop-readiness
```

Run the Rust daemon boundary gate when changing resident runtime ownership, lifecycle commands, or sidecar classification:

```bash
bun run verify:rust-daemon
```

Run the full release gate before tagging or cutting a release:

```bash
bun run verify:full
```

Useful focused commands:

```bash
bun run typecheck
bun run test:unit
bun run build:web
bun run verify:sqlite
bun run verify:mcp
bun run verify:queue:smoke
```

`bun run verify` is intentionally limited to typecheck, lint, format check, unit tests, and web build. Integration, MCP, server backend, and queue smoke checks are separate gates. Integration tests and queue smoke are destructive and must use a dedicated test database whose name includes `test`.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and review [SECURITY.md](SECURITY.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SUPPORT.md](SUPPORT.md) before filing issues or pull requests.

## License

[MIT](LICENSE)
