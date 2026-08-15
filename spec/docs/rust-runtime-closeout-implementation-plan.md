# Rust Runtime Closeout Implementation Plan

## Status

Status: implementation-ready after repository and live-runtime review.

Created: 2026-08-15

この文書は、過去の Rust daemon 全面移行、Rust sqlite-vec 先行移行、Rust test coverage 改善の各計画を置き換える。過去計画の未チェック項目は、そのまま現在の残タスクとはみなさない。

現行実装では、resident daemon、MCP、queue executor、agent-log-sync、SQLite Writer、backup、sqlite-vec extension registration の主要 Rust 化は完了している。残作業は Rust 化そのものではなく、live runtime の database identity、readiness、backup、queue execution、vector mode、検証結果を一貫させ、安全に完了判定できる状態へ閉じることである。

## 1. Decision

次の方針で closeout する。

1. daemon をさらに広く Rust 化する計画にはしない。
2. live database identity、doctor、backup、queue execution の不一致は correctness issue として修正する。
3. sqlite-vec の全面移行は既定路線にせず、固定 corpus の benchmark と結果 parity で判断する。
4. coverage 数値だけを上げる test は追加しない。今回変更する behavior contract の regression test を優先する。
5. database file の copy、move、merge、queue bulk reset はこの計画の通常実装に含めない。
6. live mutation は backup と controlled rollout gate を満たした後だけ行う。

## 2. Scope

実装対象は次の 6 項目に限定する。

1. Effective database identity
2. Readiness / doctor truth
3. Backup target safety
4. Resident queue execution truth and controlled recovery
5. Vector mode decision and contract
6. Regression tests, coverage closeout, and documentation

## 3. Non-Goals

- TypeScript の UI-time Hono、manual import/export/repair CLI を Rust へ移植しない。
- PostgreSQL backend を削除または再設計しない。
- SQLite schema 全体を再設計しない。
- repository 内 DB と Application Support DB を自動統合しない。
- live database を暗黙に別 path へ移動しない。
- pending queue を一括 reset、skip、delete しない。
- provider pool、LLM routing、distillation prompt を変更しない。
- sqlite-vec 採用を coverage や文書整理だけを理由に強制しない。
- 全体 coverage 80% 超を branch protection の hard gate にしない。
- unrelated Rust refactor、module rename、format-only rewrite を混ぜない。

## 4. Confirmed Baseline

### 4.1 Repository verification

2026-08-15 に次を確認した。

- `bun run verify:rust-daemon`: pass
  - SQLite Writer ownership
  - `cargo fmt --check`
  - workspace clippy
  - workspace Rust tests
  - paths / status / bootstrap / doctor / backup / queue / vector / MCP commands
  - Rust-managed MCP / queue / admin API / agent-log-sync smokes
  - TypeScript unit tests
- `cargo llvm-cov -p context-stilld --summary-only`: pass
- Rust unit tests: 232 passed
- total line coverage: 80.22%
- queue lifecycle aggregate line coverage: 79.50%
- MCP native module line coverage: 66.08% - 98.91%

この結果から、旧 daemon migration と coverage plan の大部分は実装済みと判断する。

### 4.2 Live database identity mismatch

同日の live runtime では次の不一致がある。

| Surface | Observed database |
|---|---|
| LaunchAgent resident | repository `data/context-still-core.sqlite` |
| `status --json` runtime path | repository `data/context-still-core.sqlite` |
| `queue inspect --json` | repository `data/context-still-core.sqlite` |
| `paths --json` | Application Support `context-still-core.sqlite` |
| `doctor summary --json` bootstrap/vector | Application Support `context-still-core.sqlite` |
| `backup preflight --json` | Application Support `context-still-core.sqlite` |

LaunchAgent は `CONTEXT_STILL_SQLITE_CORE_PATH` で repository DB を明示しているが、別 process から実行した CLI は resident state を参照する command と参照しない command に分かれている。

Application Support 側 DB は `user_version=0` で、bootstrap は migration target 2 に対し `outdated` と報告した。一方、backup preflight は同 DB を `ready` と報告している。

### 4.3 Live readiness mismatch

- doctor の nested bootstrap は `needs_init` / `migration_state=outdated`。
- doctor top-level は `overallStatus=ok`。
- vector health は extension registration 成功だけで `status=ok`。
- 同じ vector report では vector tables と metadata が存在しない。

`ok` は「その library を process に登録できる」ではなく、「選択された effective database が意図した mode で利用可能」を表す必要がある。

### 4.4 Live queue state

確認時点の effective resident DB では次だった。

- runnable pending: 756
- active lease: 0
- executor mode: `maintenance_only`
- blocked reason: runnable jobs exist but no executor is active
- resident process start: 2026-07-24
- local binary build: 2026-08-15

古い resident process と current binary の差を解消する前に、queue implementation defect と断定しない。ただし runnable backlog があるのに top-level status / doctor が正常に見える状態は修正対象とする。

### 4.5 Vector data baseline

repository DB の確認値:

| Dataset | Rows |
|---|---:|
| knowledge fallback embeddings | 7,190 |
| source fragment fallback embeddings | 2,138 |
| knowledge items | 7,227 |
| source fragments | 2,260 |

Rust は sqlite-vec extension registration、in-memory `MATCH` smoke、read-only health を持つ。一方、production TypeScript read path は sqlite-vec を直接 load できず、Rust vector search / rebuild service への完全移行も終わっていない。

## 5. Target Invariants

### 5.1 Database identity

1 command 内で、database identity は一度だけ解決する。

最低限次の情報を持つ。

```rust
struct EffectiveDatabaseIdentity {
    configured_path: PathBuf,
    resident_path: Option<PathBuf>,
    effective_path: PathBuf,
    source: DatabaseIdentitySource,
    resident_pid: Option<u32>,
    resident_running: bool,
    mismatch: bool,
}

enum DatabaseIdentitySource {
    ExplicitEnvironment,
    LiveResidentState,
    AppDataDefault,
}
```

Rules:

- resident start は explicit environment または app-data default を使用し、その effective path を process state に保存する。
- resident が live で、CLI に explicit path がない場合、runtime-aware command は resident state の path を使う。
- explicit path と live resident path が異なる場合、両方を report し、mutation command は fail closed する。
- stale state、dead PID、missing path は live resident identity として採用しない。
- path equality は lexical string だけでなく absolute normalized path で比較する。ただし filesystem canonicalization failure を理由に既存 file を別 file と推測しない。

### 5.2 Readiness

- top-level status は nested critical state と矛盾しない。
- schema outdated / missing required tables は `ok` にならない。
- queue backlog と executor absence は少なくとも `degraded` になる。
- optional vector fallback は desktop blocker にしないが、mode と index readiness を明示する。
- active lease がないことだけで executor missing と判定しない。
- last executor tick、executor configured state、last outcome、blocked reason を分けて表示する。

### 5.3 Backup

- backup preflight と create は同じ `EffectiveDatabaseIdentity` を使用する。
- live resident が別 DB を使用中なら、非 resident DB の backup を暗黙に成功させない。
- report は source path、effective path、resident PID、writer lock、refusal reason を返す。
- actual backup target を output 前に確定し、途中で再解決しない。
- path mismatch 時は database copy や migration を提案だけで実行しない。

### 5.4 Queue execution

- executor existence と active job lease を別概念として report する。
- resident は last executor tick state を永続化し、inspect / doctor が読めるようにする。
- runnable backlog がある場合、次のいずれかを必ず説明する。
  - executing
  - waiting for next tick
  - provider unavailable / cooldown
  - executor disabled
  - executor unconfigured
  - unsupported queue
  - stale resident binary / restart required
- completed job は downstream mutation 確認後だけ completed にする既存 invariant を維持する。

### 5.5 Vector mode

vector health は少なくとも次を分離する。

```text
engineAvailable
databaseInitialized
indexMode = sqlite_vec | json_fallback | unavailable
indexReady
knowledgeRows
sourceRows
metadataValid
```

Extension registration 成功だけで `status=ok` にしない。

## 6. Implementation Plan

### T0: Freeze Fixtures And Safe Baseline

変更前に deterministic fixture を追加する。

Required scenarios:

1. no explicit path / no resident state
2. explicit path / no resident state
3. live resident path / no explicit path
4. explicit path equals live resident path
5. explicit path conflicts with live resident path
6. dead PID with stale resident state
7. live resident DB current, configured DB outdated
8. runnable queue with executor configured but between ticks
9. runnable queue with executor disabled
10. sqlite-vec engine available but DB uninitialized
11. JSON fallback initialized and ready
12. sqlite-vec tables and metadata initialized and ready

Initial files:

- `crates/context-stilld/src/domains/daemon/service.rs`
- `crates/context-stilld/src/domains/queue_lifecycle/inspect.rs`
- `crates/context-stilld/src/domains/bootstrap/service.rs`
- `crates/context-stilld/src/domains/doctor/service.rs`
- `crates/context-stilld/src/domains/backup/service.rs`
- `crates/context-stilld/src/domains/vector_index/service.rs`
- focused test modules for each domain

Completion:

- all 12 scenarios have failing characterization or explicit current-behavior assertions;
- no live DB mutation is required;
- fixture DBs use temporary directories;
- current live command outputs are saved as redacted text in the implementation report, not committed as machine-specific fixtures.

Verification:

```bash
cargo test -p context-stilld daemon
cargo test -p context-stilld queue_lifecycle
cargo test -p context-stilld doctor
cargo test -p context-stilld backup
cargo test -p context-stilld vector_index
```

Stop if fixture setup requires copying the live DB.

### T1: Introduce Shared Effective Database Identity

Create a small Rust-owned resolver shared by status, doctor, backup, queue, and vector domains. Do not keep separate variants of `paths_with_resident_sqlite_path()` and queue-only effective path logic.

Suggested location:

```text
crates/context-stilld/src/domains/runtime_identity/
  mod.rs
  service.rs
  service_tests.rs
```

Required behavior:

- resolve configured and resident paths once;
- validate resident PID liveness;
- return additive diagnostics fields;
- preserve current `sqliteCorePath` field as the effective path;
- add `configuredSqliteCorePath`, `residentSqliteCorePath`, `databaseIdentitySource`, and `databaseIdentityMismatch` where relevant;
- do not change MCP tool schema or database schema.

Consumers:

- `paths --json`
- `status --json`
- `doctor summary --json`
- `backup preflight|create --json`
- `queue status|inspect --json`
- `vector health --json`

Completion:

- all consumers report the same effective path in one invocation context;
- explicit conflict is visible and mutation commands reject it;
- dead resident state does not override configured/default path;
- existing JSON fields remain compatible.

Verification:

```bash
cargo test -p context-stilld runtime_identity
cargo test -p context-stilld daemon
cargo test -p context-stilld queue_lifecycle
cargo test -p context-stilld backup
```

Stop if the change requires moving either existing DB.

### T2: Make Doctor, Backup, And Vector Health Truthful

#### T2.1 Doctor

Derive top-level status from effective database state.

Recommended severity:

| Condition | Result |
|---|---|
| effective DB missing | `needs_setup` |
| effective DB schema outdated | `needs_setup` |
| database identity conflict | `degraded` and mutation refusal |
| runnable backlog + executor disabled/missing | `degraded` |
| vector JSON fallback explicitly ready | `ok` or optional improvement |
| vector engine present but DB uninitialized | `optional improvement` unless vector is required |

Do not treat PostgreSQL/pgvector absence as a SQLite desktop blocker.

#### T2.2 Backup

- preflight must target the effective DB;
- mismatch must return non-ready with stable reason;
- resident writer ownership and OS lock remain authoritative;
- create must revalidate the same identity immediately before opening the DB;
- output must name the actual source and destination.

#### T2.3 Vector health

- split engine availability from DB/index readiness;
- validate table presence, metadata dimension, row counts, and selected mode;
- report `ready_fallback` when JSON fallback is intentionally healthy;
- report `uninitialized` when extension is available but no vector storage exists;
- use the effective DB from T1.

Completion:

- the observed `bootstrap=needs_init` / top-level `ok` contradiction is impossible;
- backup cannot report an unrelated non-resident DB as ready while resident is active;
- vector engine-only success is not index readiness.

Verification:

```bash
cargo test -p context-stilld doctor
cargo test -p context-stilld backup
cargo test -p context-stilld vector_index
bun run verify:rust-daemon
```

### T3: Persist Queue Executor Truth

Extend resident/queue runtime state additively with:

- `executorConfigured`
- `executorEnabled`
- `lastExecutorTickAt`
- `lastExecutorTickStatus`
- `lastExecutorOutcomeKind`
- `lastExecutorTargetId`
- `lastExecutorError` with bounded length
- effective SQLite path
- running binary/build identifier

`queue inspect` must not infer executor absence solely from zero active leases. Active lease means a job is currently executing; it is not the executor liveness record.

Required tests:

- between-tick idle with runnable jobs is not `maintenance_only` when executor is healthy;
- disabled executor is explicit;
- unconfigured provider is explicit;
- failed tick remains visible until a later successful tick;
- stale state from dead PID is ignored;
- backlog count comes from the same effective DB as executor state.

Completion:

- runnable backlog has an actionable state;
- status, doctor, queue inspect, and resident state agree;
- no new resident TypeScript process is introduced.

Verification:

```bash
cargo test -p context-stilld resident_runtime
cargo test -p context-stilld queue_lifecycle
bun run rust:queue:smoke
bun run verify:rust-daemon
```

### T4: Controlled Live Runtime Revalidation

This phase changes live process state and must not be executed as part of an ordinary unit-test run.

Order:

1. Record current resident PID, start time, binary path, effective DB, queue counts, and provider lease state.
2. Confirm T1-T3 focused and full daemon gates pass.
3. Resolve the canonical live DB choice. Do not migrate data during this phase.
4. Ensure backup preflight identifies that exact DB.
5. Stop the resident cleanly.
6. Take a recoverable backup of the exact live DB while the Writer lock is released.
7. Start the current binary with queue executor disabled or controlled one-tick mode.
8. Confirm paths, status, doctor, backup preflight, vector health, and queue inspect agree.
9. Enable one controlled executor tick.
10. Confirm at most the intended job was claimed and its state/downstream mutation is valid.
11. Only then restore continuous execution.

Required evidence:

- new resident PID and binary/build identifier;
- one effective SQLite path across all reports;
- backup artifact path and integrity result;
- before/after queue row and queue event for the controlled job;
- no bulk reset/delete;
- no orphan active lease after the tick.

Stop and leave continuous execution disabled if:

- the backup target differs from queue inspect target;
- schema migration would run against an unexpected DB;
- more than the controlled job is claimed;
- completed state lacks downstream mutation;
- resident starts a Bun/Node child;
- provider failure produces a tight retry loop.

### T5: Decide Vector Mode From Measurement

Do not implement Rust vector search before this gate.

Create a fixed, non-sensitive benchmark fixture and measure both available paths.

Benchmark:

- 200 deterministic query embeddings;
- top-k 20;
- warm-up excluded;
- p50 / p95 latency;
- peak process RSS or bounded memory estimate;
- top-k overlap and ordering against the current expected result;
- knowledge and source fragment lanes separately.

Decision rule:

Choose explicit JSON fallback when all are true:

- p95 is at most 100 ms at the current data scale;
- peak additional memory is at most 128 MiB;
- top-k set overlap with sqlite-vec is at least 0.90;
- compile/search end-to-end latency shows no material regression;
- fallback health and metadata are truthful.

Choose Rust sqlite-vec completion when any of the following is true:

- JSON fallback exceeds the latency or memory limit;
- result correctness differs materially;
- expected near-term data growth invalidates fallback;
- fallback full scans dominate compile/search latency.

#### Branch A: Keep JSON fallback

- make `json_fallback` an explicit supported mode;
- remove misleading extension-unavailable warnings for a healthy fallback;
- keep Rust sqlite-vec smoke as capability diagnostics;
- do not add Rust RPC/search surface;
- document the benchmark date, data scale, and reconsideration threshold.

#### Branch B: Complete Rust sqlite-vec

- implement Rust-owned real-DB search for knowledge and source fragments;
- implement rebuild/status through the resident Writer ownership boundary;
- route production TypeScript callers through the Rust layer;
- remove production Bun sqlite-vec loading attempts;
- preserve JSON fallback and test parity during rollout;
- do not expose a remote network listener beyond the existing loopback daemon boundary.

Completion:

- one branch is selected with saved benchmark evidence;
- health reports the selected mode accurately;
- production callers use the selected mode;
- the unselected path is either explicit fallback or removed from production reachability.

### T6: Coverage And Verification Closeout

The coverage target is a regression signal, not an implementation objective.

Baseline:

- total lines: 80.22%
- queue lifecycle: 79.50%
- native modules: 66.08% - 98.91%

Required:

- add tests for T1-T5 behavior and failure paths;
- total line coverage must not fall below 80.0%;
- queue lifecycle must not fall below the 79.50% measured baseline;
- modified modules must not lose meaningful contract coverage;
- no test may require live LLM, network, LaunchAgent, or the user's live DB;
- live rollout evidence remains a separate opt-in verification.

Do not add branch-only or getter-only tests solely to reach 80.0% queue coverage.

Commands:

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo llvm-cov -p context-stilld --summary-only
bun run verify:rust-daemon
bun run verify
bun run docs:check-links
git diff --check
```

## 7. Expected Change Surface

Likely Rust files:

- `crates/context-stilld/src/domains/mod.rs`
- new `crates/context-stilld/src/domains/runtime_identity/*`
- `crates/context-stilld/src/domains/bootstrap/service.rs`
- `crates/context-stilld/src/domains/daemon/service.rs`
- `crates/context-stilld/src/domains/doctor/service.rs`
- `crates/context-stilld/src/domains/backup/service.rs`
- `crates/context-stilld/src/domains/queue_lifecycle/inspect.rs`
- `crates/context-stilld/src/domains/queue_lifecycle/types.rs`
- `crates/context-stilld/src/domains/resident_runtime/service.rs`
- `crates/context-stilld/src/domains/vector_index/service.rs`
- associated focused test modules

Possible TypeScript/scripts:

- schema consumers for additive JSON fields
- `scripts/verify-rust-daemon.mjs`
- vector benchmark command/test if Branch A/B decision requires it
- public operations documentation for effective path and backup refusal reasons

Do not modify unrelated domain prompts, queue policies, provider settings UI, or context compilation ranking.

## 8. Compatibility Contract

- Existing JSON fields remain present.
- `sqliteCorePath` becomes consistently defined as effective path.
- New identity/readiness fields are additive.
- Existing exit code 0 remains for healthy or explicitly supported fallback states.
- Identity conflict, unsafe backup target, or invalid mutation target returns a non-zero runtime failure.
- MCP tool names and schemas do not change.
- SQLite schema changes are not expected for T0-T3. If persistent queue runtime state needs schema storage rather than process-state JSON, stop and review the migration separately.

## 9. Rollback

Code rollback:

- retain additive fields but restore the previous resolver only if it still fails closed on identity conflict;
- never roll back to silently backing up a non-resident DB;
- queue executor status persistence may be disabled without reintroducing a TypeScript resident worker;
- vector Branch B may roll back to explicit JSON fallback if parity is maintained.

Live rollback:

- stop the current resident cleanly;
- restore the previous binary/config while keeping the same verified DB path;
- restore database backup only when corruption or invalid mutation is confirmed;
- do not restore a backup merely because queue processing is slow;
- do not re-enable continuous queue execution until inspect and doctor agree.

## 10. Global Stop Conditions

Stop and review when:

- canonical database choice requires merging two live DBs;
- an existing DB would be overwritten or moved;
- backup source cannot be proven identical to resident/queue source;
- status and process state disagree about the live PID;
- controlled queue tick cannot limit mutation scope;
- queue completed state precedes downstream mutation;
- vector benchmark fixture cannot compare equivalent data;
- JSON fallback and sqlite-vec return materially different results without an explained contract;
- T1-T3 require a breaking JSON or MCP schema change;
- full verification exposes a regression outside the defined scope.

## 11. Final Completion Criteria

The Rust runtime closeout is complete only when all are true.

- one effective database identity is reported consistently by paths, status, doctor, backup, queue, and vector commands;
- mutation commands fail closed on identity conflict;
- doctor top-level status reflects schema/readiness/blocking queue state truthfully;
- backup preflight and create target the actual resident DB and produce verified evidence;
- current resident binary is running and identified;
- runnable queue backlog is executing or has a precise actionable blocked reason;
- one controlled live queue transition has verified downstream mutation;
- vector mode is selected by recorded benchmark evidence;
- vector health reports engine, index mode, and readiness separately;
- regression tests pass without live infrastructure;
- total coverage remains at least 80.0% and queue coverage does not regress below 79.50%;
- `verify:rust-daemon`, repo verification, docs links, and diff checks pass;
- old Rust migration/coverage plans remain historical only;
- this plan is moved to the hidden archive after implementation evidence is recorded at the top.
