# REST API Reference

The REST API is served under `/api/*`. It primarily supports the local admin UI and local automation.

Except for `/api/health*`, requests under `/api/*` must include the built-in local key or the key
configured by `CONTEXT_STILL_ADMIN_API_KEY` as `x-admin-api-key` or `Authorization: Bearer ...`.
A custom key must contain at least 32 characters. Protected endpoints return `503` when the active
key is invalid and `401` when the supplied key does not match it.

Cross-origin browser access is disabled by default. Configure exact trusted origins with
`CONTEXT_STILL_ALLOWED_ORIGINS`; wildcard origins are not supported. The cookie-based admin UI must
remain same external-origin. A TLS-terminating reverse proxy must list that external origin because
the application receives the proxied request over an internal HTTP hop.

## Admin Session

With the built-in local key, the browser UI creates the session automatically. With an environment
override, the browser UI sends the entered admin key once to `POST /api/admin-session`. The
response sets an `HttpOnly`, `SameSite=Strict` browser-session cookie; the long-lived key is not stored in
the URL or browser storage. `GET /api/admin-session` reports whether a session is
configured/authenticated and includes a machine-readable `configurationError` when the configured
key is missing or too short. The session has no time-based server expiry; `DELETE
/api/admin-session` signs out, closing the browser session drops the cookie, and rotating the admin
key invalidates existing session signatures. Session creation and
state-changing cookie-authenticated requests require an exact trusted `Origin`. CLI clients
continue to use `x-admin-api-key` or Bearer authentication.

API request bodies are capped at 16 MiB. The admin-session exchange applies a narrower 2 KiB cap.

## Health

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Basic health |
| `GET` | `/api/health/live` | Liveness probe |
| `GET` | `/api/health/ready` | 200 when database/schema and SQLite writer are available; otherwise 503 |

Readiness uses read-only schema probes and an authenticated query through the SQLite writer, including confirmation that the reader and writer refer to the same canonical database path. Each dependency has a 1.5-second response budget; optional LLM/embedding services are excluded. PostgreSQL checks its own database/schema and does not require a SQLite writer. Failure responses expose only `database`/`writer` states (`ok` or `unavailable`), without raw dependency errors or paths, and use `Cache-Control: no-store`. Liveness remains 200 during dependency outages. A recovered writer or a database initialized after API startup is checked again automatically.

## Context Compile

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/context/compile` | Compile a context pack |
| `GET` | `/api/context/runs` | List compile runs |
| `GET` | `/api/context/runs/:id` | Get compile run detail |
| `GET` | `/api/context/runs/:id/ranking-trace` | Get ranking trace for a run |
| `POST` | `/api/context/runs/:id/knowledge-feedback` | Record per-knowledge usage feedback |

## Context Decisions

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/context-decisions` | Create a Knowledge-backed decision run |
| `GET` | `/api/context-decisions` | List decision runs with optional `decision`, `status`, `feedback`, `q`, `limit`, and `cursor` filters |
| `GET` | `/api/context-decisions/:id` | Get a decision detail with evidence, coverage traces, feedback, and effects |
| `POST` | `/api/context-decisions/:id/human-feedback` | Record Good/Bad human feedback |
| `POST` | `/api/context-decisions/:id/system-feedback` | Record AI/system outcome feedback |
| `POST` | `/api/context-decisions/pr-discard-scan` | Scan linked PR metadata and optionally record `discarded_pr` feedback |

## Knowledge

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/knowledge` | List and search knowledge |
| `POST` | `/api/knowledge` | Create knowledge |
| `POST` | `/api/knowledge/bulk-status` | Bulk promote/deprecate items |
| `PUT` | `/api/knowledge/:id` | Update knowledge |
| `POST` | `/api/knowledge/:id/feedback` | Record direct feedback |
| `DELETE` | `/api/knowledge/:id` | Delete knowledge |
| `GET` | `/api/knowledge/tags` | List tag definitions |

## Sources

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/sources/health` | Source repository health |
| `GET` | `/api/sources/tree` | Wiki tree |
| `GET` | `/api/sources/search` | Search source pages |
| `POST` | `/api/sources/reindex` | Rebuild source fragments |
| `POST` | `/api/sources/web` | Queue one URL for web ingest |
| `POST` | `/api/sources/web/bulk` | Queue up to 1000 URLs |
| `POST` | `/api/sources/web/upload` | Extract URLs from an uploaded file |
| `GET` | `/api/sources/folders` | List folders |
| `POST` | `/api/sources/folders` | Create folder |
| `PUT` | `/api/sources/folders/*` | Rename folder |
| `DELETE` | `/api/sources/folders/*` | Delete folder |
| `POST` | `/api/sources/pages` | Create page |
| `GET` | `/api/sources/pages/*` | Read page |
| `PUT` | `/api/sources/pages/*` | Update page |
| `DELETE` | `/api/sources/pages/*` | Delete page |
| `GET` | `/api/sources/history/*` | Page Git history |
| `GET` | `/api/sources/diff/*` | Page diff |

## Vibe Memory

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/vibe-memory` | List memories |
| `POST` | `/api/vibe-memory` | Create memory |
| `GET` | `/api/vibe-memory/context` | Search contextual raw memory view |
| `GET` | `/api/vibe-memory/:id` | Read memory |
| `DELETE` | `/api/vibe-memory/:id` | Delete memory |

## Episodes

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/episodes` | Search EpisodeCards with optional `q`, `query`, `status`, `domains`, `technologies`, `changeTypes`, `tools`, `repoPath`, `repoKey`, `outcomeKinds`, and `limit` filters |
| `POST` | `/api/episodes` | Register an EpisodeCard |
| `GET` | `/api/episodes/:id` | Fetch one EpisodeCard |

## Graph and Landscape

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/graph` | Graph data |
| `GET` | `/api/graph/nodes/:id` | Graph node detail |
| `GET` | `/api/graph/community-labels` | List community labels |
| `PUT` | `/api/graph/community-labels/:communityKey` | Update community label |
| `GET` | `/api/graph/landscape` | Landscape snapshot |
| `GET` | `/api/graph/landscape/cache-status` | Landscape cache status |
| `GET` | `/api/graph/landscape/replay` | Replay diagnostics |
| `GET` | `/api/graph/landscape/replay/compare` | Baseline/current comparison |
| `POST` | `/api/graph/landscape/replay/queue` | Materialize review items |
| `GET` | `/api/graph/landscape/review-items` | List review items |
| `POST` | `/api/graph/landscape/review-items/candidates` | Create candidate drafts |
| `PATCH` | `/api/graph/landscape/review-items/:id` | Resolve/dismiss review item |
| `PATCH` | `/api/graph/landscape/review-items/:id/candidate-links/:linkId` | Approve/reject candidate link |

## Queue, Candidates, Audit, Doctor, Settings

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/queue` | List distillation targets |
| `GET` | `/api/queue/stats` | Queue stats |
| `GET` | `/api/queue/active` | Active target states |
| `POST` | `/api/queue/:queue/pause` | Pause a queue lane |
| `POST` | `/api/queue/:queue/resume` | Resume a queue lane |
| `POST` | `/api/queue/:queue/:id/pause` | Pause a queue job |
| `POST` | `/api/queue/:queue/:id/resume` | Resume a queue job |
| `POST` | `/api/queue/:queue/:id/retry` | Retry a queue job |
| `GET` | `/api/candidates` | List candidates |
| `POST` | `/api/candidates/:id/premium-reprocess` | Reprocess candidate through premium coverage |
| `GET` | `/api/audit-logs` | Audit log timeline |
| `GET` | `/api/agent-diffs` | Agent diff entries |
| `GET` | `/api/overview` | Overview metrics |
| `GET` | `/api/overview/domains/:domain` | Domain-specific overview |
| `GET` | `/api/doctor` | Full doctor report |
| `GET` | `/api/doctor/domains/:domain` | Domain-specific doctor report |
| `GET` | `/api/settings` | Runtime settings |
| `PUT` | `/api/settings` | Update runtime settings |
| `POST` | `/api/settings/providers/:provider/test` | Test provider |
| `POST` | `/api/settings/providers/azure-openai/deployments/:deployment/test` | Test one Azure OpenAI deployment |
| `POST` | `/api/settings/providers/local-llm/models/test` | Test one local LLM model |
| `GET` | `/api/settings/providers/codex/auth/status` | Codex auth status |
| `POST` | `/api/settings/providers/codex/auth/login-command` | Generate Codex login command |
| `POST` | `/api/settings/reload-runtime-cache` | Reload runtime settings cache |
