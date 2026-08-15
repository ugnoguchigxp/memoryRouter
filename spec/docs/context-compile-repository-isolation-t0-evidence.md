# Context Compile Repository Isolation T0 Evidence

## Status

Recorded at 2026-08-15 20:35 JST. T0 reproduction, shared fixture, read-only inventory, and baseline collection are complete. This document records aggregate evidence only; it contains no Knowledge/Source/Episode content and no absolute repository path.

## Shared Fixture And Reproduction

The canonical fixture is `test/fixtures/context-compile-repository-isolation-v1.json`. Rust, TypeScript, SQLite, and PostgreSQL consume the same file or its candidate records. It covers:

- no identity, `projectRef`, `repoKey`, and `repoPath` selection bases;
- POSIX, Windows, and local `file://` paths plus invalid relative, remote-host, query-bearing, and malformed-percent file URIs;
- authoritative multi-identifier agreement and conflict;
- global, repository, unresolved, malformed, conflict, inactive, general, facet-match, and facet-mismatch candidates;
- exact prefix and path-case collision behavior;
- 501 Knowledge wrong-project rows, 501 Knowledge facet-mismatch rows, and 121 Episode wrong-project rows before a matching anchor;
- Knowledge, Source, and Episode candidates for Repo A, Repo B, and global scope.

The Rust legacy reproduction intentionally proves that the pre-enforcement compile path selects both a Repo B Knowledge item and an unresolved Knowledge item for a Repo A request. The test observes selected candidate-trace IDs and persisted pack IDs, not only final Markdown. The agentic harness uses a local mock HTTP composer and observes candidate, external outbound, and pack IDs. The existing disabled-agentic test covers the local fallback path.

## Live Read-Only Inventory

Command:

```bash
bun run repository-isolation:report -- --preview-limit 0 --recent-run-limit 0
```

The command completed successfully in 1.3 seconds against the configured SQLite database. It performed no migration or fixture write.

| Entity | Total | Reported unresolved | Canonical classification column | Existing legacy identity signal |
| --- | ---: | ---: | --- | --- |
| Knowledge | 7,227 | 7,227 | absent | none in canonical columns |
| Source | 178 | 178 | absent | none in canonical columns |
| EpisodeCard | 6,602 | 6,602 | absent | `repo_key` on 5,761 rows; no identity on 841 rows |

Because the live database predates the additive canonical entity columns, the report deliberately maps rows to unresolved instead of inferring `classified` or `global`. In particular, a legacy EpisodeCard `repo_key` is an inventory signal but does not override the missing `classification_status` contract.

The earlier plan snapshot of Knowledge 7,092 / Source 99 / EpisodeCard 841 was stale. The 841 value remains the count of EpisodeCards with no legacy repository identity; it is not the total number that is safe to treat as canonically classified.

## Baseline Cohort

The 14-day identity-present cohort had fewer than 500 samples, so the report extended to the required maximum of 30 days.

| Metric | Observed |
| --- | ---: |
| Compile runs in 30-day window | 1,809 |
| Identity-present compile runs | 0 |
| Identity presence rate | 0% |
| Minimum requested identity-present samples | 500 |
| Cohort sufficient | no |

No Content rate, selected-kind distribution, latency percentiles, and composer failure rate for identity-present requests are therefore unavailable rather than silently replaced with synthetic values. Fixture measurements remain separate from the live cohort.

## Verification Evidence

| Surface | Command | Executed | Skipped | Result |
| --- | --- | ---: | ---: | --- |
| TypeScript fixture semantics | `bunx vitest run test/context-compile-repository-isolation.fixture.test.ts` | 11 | 0 | pass |
| SQLite fixture/report | `bun test ./test/sqlite-repository-isolation-report.bun.ts` | 1 | 0 | pass |
| Rust reproduction/composer harness | `cargo test -p context-stilld native_compile -- --nocapture` | 9 | 0 | pass |
| PostgreSQL fixture/report | `CONTEXT_STILL_RUN_DB_TESTS=1 bunx vitest run test/repository-isolation-report.integration.test.ts` | 1 | 0 | pass |
| TypeScript types | `bun run typecheck` | 1 command | 0 | pass |

The PostgreSQL suite used a dedicated `context_still_test` database. A skipped integration suite is not counted as success; the recorded run executed the test.

## T0 Decision

T0 is complete. Its evidence blocks immediate enforcement: live canonical identity adoption is 0%, canonical entity classification columns are absent in the current live SQLite file, and the legacy Rust path has an automated wrong-project reproduction. T2 producer closure and T3 deterministic migration must precede shadow/enforced rollout.
