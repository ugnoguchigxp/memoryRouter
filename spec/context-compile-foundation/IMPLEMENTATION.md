# Foundation implementation status

Implemented on 2026-08-17. This file records code-level completion and the remaining operational gate; it is not canary evidence.

## Implemented

- A single Rust effective-database resolver and build ID are used by daemon status, MCP endpoint startup, backup, vector health, queue inspection, and Foundation reports.
- MCP endpoint startup captures `CONTEXT_STILL_COMPILE_FOUNDATION_MODE` once. Valid modes are `legacy`, `split_legacy_rank`, `split_shadow_rank`, and `foundation`.
- Split modes perform read-only candidate/settings preparation, compose outside SQLite Writer ownership, then persist the business transaction through one observed Writer operation.
- Foundation ranking uses a larger same-snapshot candidate pool and rejects query-unmatched Knowledge/Episode candidates before delivery. Shadow/Foundation candidate evidence is bounded and content-redacted with a SHA-256 content version.
- Compile counters update only selected, de-duplicated IDs within the same transaction. The final pack snapshot records actual affected-row counts and missing IDs.
- Runtime JSONL telemetry contains Writer queue/work/total timing, build ID, database fingerprint, mode, and no source content, absolute paths, prompt, response, or secret.
- `context-compile capabilities`, `baseline`, `compare`, `experiment`, and `probe` CLI commands, fixtures, manifest, and package scripts are available. Report artifacts use create-new plus atomic rename.

## Verification completed

```text
cargo test -p context-stilld --no-fail-fast      # 263 passed
cargo clippy -p context-stilld --all-targets -- -D warnings
bun run typecheck
bunx vitest run test/repository-isolation-report.test.ts test/repository-isolation-report.cli.test.ts test/repository-isolation-producer-observation.test.ts
bun test ./test/sqlite-repository-isolation-report.bun.ts
```

The CLI was smoke-tested against an isolated, missing-DB App Data directory. Capabilities, baseline, and compare reports were generated successfully without writing a production DB.

## F8 operational handoff — not executed

No resident process was restarted, no live MCP compile call was made, and no canary/probe report was generated for the live database. Those actions write business rows and require an explicitly scheduled operational run.

1. Start a verified binary with `CONTEXT_STILL_COMPILE_FOUNDATION_MODE=split_legacy_rank`.
2. Generate a fresh capabilities report; proceed only when `liveEntryEligible=true` and its build, mode, and database fingerprint match the resident.
3. Run `foundation:probe` with an explicit `--allow-live-writes` flag and record the resulting baseline artifact outside the repository.
4. Promote independently to `split_shadow_rank`, then `foundation`, repeating capability/probe/compare evidence at each boundary.
5. Keep `legacy` as the rollback mode. No Foundation release changes the SQLite schema.
