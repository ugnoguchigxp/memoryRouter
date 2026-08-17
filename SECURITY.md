# Security Policy

## Supported Versions

context-still is currently pre-1.0. Security fixes are made on `main`.

## Reporting a Vulnerability

Please do not open a public issue for suspected vulnerabilities.

Report privately through GitHub Security Advisories if available, or contact the repository owner directly. Include:

- Affected version or commit.
- Reproduction steps.
- Impact and affected data.
- Whether secrets, local files, or external services are involved.

## Security Model

context-still is local-first software. It can read local source files, local wiki content, local agent logs, and configured provider credentials. Treat the admin UI, API, MCP server, and automation workers as trusted local infrastructure.

Important boundaries:

- Do not expose the admin API or MCP server to untrusted networks.
- The built-in admin API key is intended only for loopback/local use. Before exposing the service through a proxy or any non-local interface, override `CONTEXT_STILL_ADMIN_API_KEY` with a unique value of at least 32 characters; protected endpoints fail closed when a custom key is too short.
- Keep `CONTEXT_STILL_ALLOWED_ORIGINS` empty for direct same-origin use. List only exact trusted browser origins; a TLS-terminating reverse proxy must include the external admin UI origin.
- The admin UI uses a short-lived `HttpOnly` session; do not place the admin key in URLs or browser storage.
- `CONTEXT_STILL_MCP_HOST` accepts loopback IP literals only. Remote MCP transport requires a separately designed authenticated TLS boundary.
- Keep `.env` and provider credentials out of Git.
- Review source and agent-log content before sending it to external LLM or search providers.
- Use dedicated test databases for integration tests.

## External Providers

If configured, distillation can call external LLM and search providers. Disable external providers or omit API keys for the most local setup.
