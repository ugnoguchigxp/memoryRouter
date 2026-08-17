# Configuration

The desktop/local path should work with SQLite defaults and without a mandatory `.env` file. Environment variables remain the development and advanced-configuration surface.

## Desktop Defaults

| Setting | Default | Purpose |
|---|---|---|
| `CONTEXT_STILL_DB_BACKEND` | `sqlite` for the desktop product path | Selects the local SQLite backend |
| `CONTEXT_STILL_SQLITE_CORE_PATH` | `./data/context-still-core.sqlite` in development | SQLite core database path |
| `CONTEXT_STILL_SOURCE_CONTENT_ROOT` | `./wiki` | Local source/wiki root |
| `CONTEXT_STILL_ADMIN_API_KEY` | `context-still-local-admin-api-key-2026` | Optional override for every admin API endpoint except `/api/health*`; a custom value must contain at least 32 characters |
| `CONTEXT_STILL_ALLOWED_ORIGINS` | empty | Exact comma-separated browser origins; empty disables cross-origin requests |

For the current Bun/admin development runtime, pass the backend explicitly. The built-in local key
is exchanged for an admin session automatically, so no key setup or login input is needed:

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run dev
```

Set `CONTEXT_STILL_ADMIN_API_KEY` to a custom value of at least 32 characters when the built-in
local credential is inappropriate. With a custom value, the admin UI displays the login form and
exchanges the entered key for a session.

Serve the admin UI and API from the same external origin so the strict session cookie remains
first-party. Direct same-origin development does not need `CONTEXT_STILL_ALLOWED_ORIGINS`. When a
trusted reverse proxy terminates TLS, override the built-in admin key and list the external UI
origin so Origin validation can account
for the internal HTTP hop. Exact origins may also be listed for trusted header-authenticated browser
clients; wildcards are not supported. The admin UI exchanges the built-in or entered key for a 15-minute
`HttpOnly`, `SameSite=Strict` session. API keys in URL parameters and browser `localStorage` are
ignored and removed.

Future Tauri packaging should resolve SQLite DB, logs, backups, runtime settings, daemon state, and MCP registration metadata from app data paths instead of requiring terminal setup.

## Product Modes

| Mode | Variables usually touched |
|---|---|
| `minimal` | `CONTEXT_STILL_DB_BACKEND`, optional `CONTEXT_STILL_SQLITE_CORE_PATH`, optional source root |
| `cloud-review` | LLM provider credentials and route settings |
| `local-llm` | local LLM endpoint/model and embedding settings |

Minimal mode should still support source import, manual candidate registration, search, compile, and eval when no external model is configured.

## LLM Providers

| Variable | Purpose |
|---|---|
| `CONTEXT_STILL_DISTILLATION_PROVIDER` | Main distillation provider: `local-llm`, `azure-openai`, `bedrock`, or `auto` |
| `CONTEXT_STILL_DISTILLATION_FIND_CANDIDATE_PROVIDER` | Optional candidate extraction provider override |
| `CONTEXT_STILL_LOCAL_LLM_API_BASE_URL` | OpenAI-compatible local LLM endpoint |
| `CONTEXT_STILL_LOCAL_LLM_MODEL` | Local LLM model name |
| `CONTEXT_STILL_AZURE_OPENAI_*` | Azure OpenAI endpoint, deployment, and key settings |
| `CONTEXT_STILL_BEDROCK_*` | AWS Bedrock region/model settings |

Runtime task routing can also be edited from the admin Settings page. Each route stores a primary provider/model plus fallback providers. When `local-llm` is used as either the primary provider or a fallback provider, the route can carry a `localLlmModel` value.

## Search Providers

| Variable | Purpose |
|---|---|
| `CONTEXT_STILL_DISTILLATION_SEARCH_PROVIDERS` | Ordered providers for `search_web` |
| `BRAVE_SEARCH_API_KEY` | Brave Search API key |
| `CONTEXT_STILL_EXA_API_KEY` / `EXA_API_KEY` | Exa API key |
| `CONTEXT_STILL_FETCH_MAX_RESPONSE_BYTES` | Maximum `fetch_content` response size; defaults to 2 MiB and is capped at 16 MiB |

Omit external search API keys when you do not want distillation to call external search providers.

## Embedding

| Variable | Default | Purpose |
|---|---|---|
| `CONTEXT_STILL_EMBEDDING_PROVIDER` | `auto` | `auto`, `daemon`, `cli`, or `disabled` |
| `CONTEXT_STILL_EMBEDDING_DAEMON_URL` | `http://127.0.0.1:44512` | Embedding daemon URL |
| `CONTEXT_STILL_EMBEDDING_DIMENSION` | `384` | Vector dimension |
| `CONTEXT_STILL_LOCAL_LLM_EMBEDDING_*` | varies | CLI embedding fallback settings |

Embedding improves semantic search and distillation quality, but it should not block minimal desktop usage.

## Rust Daemon Boundary

| Variable | Default | Purpose |
|---|---|---|
| `CONTEXT_STILL_APP_DATA_DIR` | OS-specific app data directory | Overrides the app data root used by `context-stilld` path, preflight, pid, log, and backup state |
| `CONTEXT_STILL_SQLITE_CORE_PATH` | `appDataDir/context-still-core.sqlite` | Overrides the SQLite core database path reported by Rust preflight/backup checks |
| `CONTEXT_STILL_PROJECT_ROOT` | current working directory | Project root used when Rust delegates TypeScript child processes |
| `CONTEXT_STILL_MCP_HOST` / `CONTEXT_STILL_MCP_PORT` | `127.0.0.1` / `39172` | Managed MCP endpoint host and port; host must be `127.0.0.1` or `::1` |
| `CONTEXT_STILL_ADMIN_API_READY_URL` | derived from `PORT` or `39170` | Admin API readiness URL used by `context-stilld admin-api start` |
| `CONTEXT_STILL_DAEMON_MANAGED_MCP` | unset | Status-only flag indicating MCP is a Rust-default candidate |
| `CONTEXT_STILL_DAEMON_MANAGED_QUEUE` | unset | Status-only flag indicating queue is a Rust-default candidate |
| `CONTEXT_STILL_DAEMON_MANAGED_AGENT_LOG_SYNC` | unset | Status-only flag indicating agent log sync is a Rust-default candidate |
| `CONTEXT_STILL_DAEMON_MANAGED_ADMIN_API` | unset | Status-only flag indicating admin API is a Rust-default candidate |

These variables are for development, packaging, and advanced runtime integration. `context-stilld run` is the resident owner when launched through the daemon automation, but the `CONTEXT_STILL_DAEMON_MANAGED_*` flags are status markers rather than hidden package-script switches. Use `context-stilld runtime sidecars --json` to see which surfaces are still TypeScript/Bun sidecars.

## Agent Log Sync

| Variable | Purpose |
|---|---|
| `CONTEXT_STILL_CODEX_SESSION_DIR` | Primary Codex session directory |
| `CONTEXT_STILL_CODEX_SESSION_DIRS` | Additional Codex session roots |
| `CONTEXT_STILL_CODEX_ARCHIVED_SESSION_DIRS` | Additional Codex archived-session roots |
| `CONTEXT_STILL_ANTIGRAVITY_LOG_DIR` | Primary Antigravity log directory |
| `CONTEXT_STILL_ANTIGRAVITY_LOG_DIRS` | Additional Antigravity log roots |
| `CONTEXT_STILL_CLAUDE_PROJECTS_DIR` | Claude projects directory |
| `CONTEXT_STILL_RESIDENT_AGENT_LOG_SYNC` | `1` | Enables resident `context-stilld run` to own scheduled agent log sync |
| `CONTEXT_STILL_RESIDENT_QUEUE_MODE` | `rust-managed-one-shot` | Legacy value retained for compatibility; resident queue scheduling is Rust maintenance and no longer starts Bun continuous mode |
| `CONTEXT_STILL_RESIDENT_QUEUE_INTERVAL_MS` | `5000` | Minimum interval between Rust-managed queue maintenance ticks |
| `CONTEXT_STILL_QUEUE_STALE_SECONDS` | `120` | Stale threshold for Rust queue maintenance to recover active leases and running jobs |
| `CONTEXT_STILL_AGENT_LOG_SYNC_INTERVAL_SECONDS` | `3600` | Resident daemon / legacy LaunchAgent scheduled sync interval |
| `CONTEXT_STILL_AGENT_LOG_SYNC_RUN_AT_LOAD` | `0` | Set `1` to run agent log sync immediately when resident daemon starts |
| `CONTEXT_STILL_AGENT_LOG_SYNC_TIMEOUT_MS` | `300000` | Timeout for each resident-owned Rust agent-log-sync run |
| `CONTEXT_STILL_AGENT_LOG_INITIAL_LOOKBACK_HOURS` | Initial import lookback window |
| `CONTEXT_STILL_AGENT_LOG_MIN_DISTILLABLE_CHARS` | Minimum agent-log chunk size to save for distillation; default `2000` |

## Advanced Server Backend

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:7889/context_still` | PostgreSQL connection for the server backend |
| `CONTEXT_STILL_DB_BACKEND` | inferred from `DATABASE_URL` unless set | Set `postgres` to select the server backend explicitly |
| `CONTEXT_STILL_DB_POOL_MAX` | `3` | Per-process PostgreSQL pool max |
| `CONTEXT_STILL_DB_POOL_IDLE_TIMEOUT_MS` | `10000` | Milliseconds before idle DB pool clients are released |
| `CONTEXT_STILL_DB_POOL_CONNECTION_TIMEOUT_MS` | `5000` | Milliseconds to wait for a DB connection before failing |

PostgreSQL / pgvector remains an advanced backend for compatibility and future server-style deployments. It is not required for default desktop onboarding.

## Backend Support Notes

- SQLite mode covers primary `register_candidates`, `search_knowledge`, source search, `context_compile` run/snapshot path, runtime settings, audit logs, `compile_eval`, and several landscape/overview paths.
- PostgreSQL remains available for advanced queue/distillation/admin compatibility while remaining stores are migrated.
- Integration tests truncate data and must target a dedicated test database.
