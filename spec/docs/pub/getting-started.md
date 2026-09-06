# Getting Started

## Default Path

The default path is desktop/local:

- SQLite local backend
- local admin/control-plane runtime
- resident `context-stilld run` ownership of the SQLite writer, MCP, queues, and log sync
- streamable HTTP MCP registration as an optional user action
- local-only minimal usage before LLM-assisted modes

The Tauri shell is the desktop packaging target. Until that shell exists, use the local Bun/admin runtime plus `context-stilld` lifecycle checks as the development baseline for the same product path.

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

| Mode | What works | Setup |
|---|---|---|
| `minimal` | SQLite storage, local sources, manual/MCP candidates, search, compile, eval | Bun + SQLite backend |
| `cloud-review` | Cloud LLM assisted distillation/review/decision support | Provider credentials and route settings |
| `local-llm` | Local LLM and embedding assisted distillation/search | Local endpoint and/or embedding service |

Minimal mode should not require external LLMs, external search APIs, or MCP registration.

## MCP Integration

The quick-start resident process already serves MCP. Inspect the endpoint with:

```bash
cargo run -q -p context-stilld -- mcp endpoint --json
```

Register it in an MCP client only when you want agent integration:

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

Run `bun run setup:mcp-config` to update Codex and Antigravity config files. The direct stdio server and TypeScript MCP HTTP worker are deleted legacy paths and should not be registered in new clients.

The endpoint and exposed tool handlers are owned by the Rust resident process. Client registration is optional; the writer must be running for SQLite mutations.

After connection, call `initial_instructions` once per project session, `context_compile` before task work, `context_decision` before a blocking question/PR decision when autonomous progress may still be possible, and `compile_eval` after the task.

## First Review Loop

1. Open the admin UI at http://localhost:39171.
2. Check **Doctor** for desktop readiness, DB state, optional embedding/LLM state, sync, and queue status.
3. Use **Sources** to import or edit source pages.
4. Use **Knowledge** to review draft knowledge and promote useful items.
5. Use **Decision** to inspect Knowledge-backed autonomous decisions, evidence, coverage traces, and feedback.
6. Use MCP tools when you want the agent workflow connected to the local knowledge base.

## Resident Daemon Preview

Install the resident daemon LaunchAgent on macOS when you want long-lived local ownership for MCP endpoint supervision, queue worker supervision, scheduled agent-log-sync, and runtime status:

```bash
bun run automation:context-stilld -- install
bun run automation:context-stilld -- load
bun run automation:context-stilld -- status
cargo run -q -p context-stilld -- runtime sidecars --json
```

The Rust daemon owns resident work. TypeScript/Bun serves the UI-time API and explicit operator commands. Use `runtime sidecars --json` and `bun run verify:rust-daemon` to inspect the boundary.

## Advanced Server Backend

PostgreSQL / pgvector is legacy compatibility code. It is not maintained as a completion gate for the desktop/local path; use it only for explicit compatibility investigation.

```bash
docker compose up -d
cp .env.example .env
bun run db:migrate
```

This path is advanced and opt-in. It is not required for desktop onboarding.
