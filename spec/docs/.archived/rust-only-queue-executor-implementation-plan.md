# Rust-Only Queue Executor Implementation Plan

> アーカイブ日: 2026-08-15。実装コミット: `39c90e2`。

## Purpose

`context-stilld run` が queue を実処理まで Rust で所有するための実装計画である。

この文書は見積もりではない。今回の queue 停止事故を受けて、TypeScript queue supervisor に戻さず、Rust resident が claim、provider lease、heartbeat、job execution、完了/失敗確定まで担うための実装順序、完了条件、検証ゲート、停止条件を定義する。

## Incident Baseline

確認された停止状態:

- `context-stilld run` は稼働していた。
- `context-stilld status --json` は `queueSupervisor=scheduled` を返していた。
- しかし `queue inspect --json` は `workerPid=null`、active lease なし、pending queue ありの状態だった。
- Rust resident の continuous queue path は stale lease/job maintenance だけを実行しており、実 executor は起動していなかった。
- 既存の `src/cli/queue-supervisor.ts --continuous` は SIGTERM 後に停止していた。
- LocalLLM Qwen targets は認証付き chat completion が正常応答した。
- `local-llm HTTP 503 Loading model` は過去の failed row に残っていたが、今回の全停止の直接原因ではなかった。

この計画で防ぐべき事故:

- pending job があるのに executor が存在しない。
- `scheduled` 表示が実処理中のように見える。
- active lease / heartbeat がないのに queue が正常に見える。
- unsupported executor が silent idle として扱われる。

## Definition Of Done

Rust-only queue executor は次の状態を指す。

- resident queue runtime は `context-stilld run` 内で動く。
- resident runtime は `src/cli/queue-supervisor.ts` を起動しない。
- Rust が provider pool scheduling、queue claim、provider lease、heartbeat、job execution、state transition、queue event append を所有する。
- job が完了扱いになるのは downstream mutation が確認済みの場合だけである。
- 一時的な provider failure は cooldown 付き retryable state になり、即時再取得ループに入らない。
- `status`、`queue inspect`、LaunchAgent/process tree、SQLite rows、smoke output が同じ実態を示す。

## Non-Goals

- TypeScript queue supervisor を resident runtime に戻さない。
- queue migration と同時に UI を作り替えない。
- MCP tool migration や doctor 全面 Rust 化をこの計画に混ぜない。
- LocalLLM model 運用ポリシーの大幅変更をこの計画に混ぜない。
- live production DB を破壊的な smoke test の対象にしない。
- queue completion semantics を fixture や contract なしに変更しない。

## Migration Rules

1. Rust ownership must remain true.
   - resident process tree に Bun queue worker が戻ったら停止する。

2. Unsupported work must fail closed.
   - 未移植 queue は silent idle にしない。
   - `unsupported_executor` など、operator が判断できる状態で返す。

3. Status must describe runtime truth.
   - executor がない状態を `scheduled` だけで表現しない。
   - pending があるのに claim できない状態を green にしない。

4. Verified mutation only.
   - EpisodeCard、found_candidates、covering queue、finalize output などの downstream mutation が確認できるまで completed にしない。

5. Provider failures must cool down.
   - `Loading model`、connection refused、timeout、unsupported model は即時再取得ループにしない。

6. Every phase needs a rollback boundary.
   - ただし rollback は TypeScript resident worker 復帰ではなく、Rust executor feature flag disable または fail-closed idle に限定する。

## Implementation Order

### Q0: Truthful Queue Status

Goal:
現在の `scheduled` 表示を、実 executor の有無まで表す状態へ変える。

Tasks:

- `queue inspect --json` に executor truth を追加する。
  - `executorMode`: `rust_native` / `maintenance_only` / `disabled` / `unsupported`
  - `executorRunning`: boolean
  - `executorPid`: resident pid when in-process
  - `lastExecutorTickAt`
  - `runnablePendingCount`
  - `blockedReason`
- `status --json` の `queueSupervisor` を単一文字列だけに依存しない形へ拡張する。
- pending job があるのに executor が maintenance-only の場合は `degraded` または `executor_missing` として出す。
- `verify:rust-daemon` に non-mutating guard を追加する。

Completion criteria:

- 今回の停止状態が green にならない。
- `workerPid=null` かつ runnable pending > 0 が検出される。
- operator が maintenance-only と実 execution を区別できる。

Verification:

```bash
cargo test -p context-stilld queue
cargo run -q -p context-stilld -- queue inspect --json
cargo run -q -p context-stilld -- status --json
bun run verify:rust-daemon
```

Stop conditions:

- status shape の変更で既存 UI/CLI が queue 状態を読めなくなる。
- executor 不在なのに `scheduled` のみで正常扱いが残る。

### Q1: Rust Resident Executor Loop Skeleton

Goal:
Rust resident 内に queue executor loop を作り、claim から heartbeat までを TypeScript なしで実行する。

Tasks:

- `resident_runtime` に queue executor loop state を追加する。
- loop は resident process 内 thread として動かす。
- 既存の Rust provider lease claim API を使って job と lease を取得する。
- job 実行中は queue row と provider lease の heartbeat を更新する。
- shutdown 時に active job を安全に release / pause / stale-recoverable state に戻す。
- unsupported queue は `unsupported_executor` として明示的に記録する。
- executor loop の tick / claim / heartbeat / release を structured log に出す。

Completion criteria:

- `context-stilld run` 単体で active provider lease を作れる。
- heartbeat が Rust resident から更新される。
- unsupported queue が silent idle にならない。
- resident process tree に `queue-supervisor.ts` が存在しない。

Verification:

```bash
cargo test -p context-stilld queue
cargo run -q -p context-stilld -- run --once --json
cargo run -q -p context-stilld -- queue inspect --json
ps aux | rg 'queue-supervisor|context-stilld run'
```

Stop conditions:

- heartbeat なし active lease が残る。
- shutdown で running job が復旧不能になる。
- unsupported executor が completed / skipped 扱いになる。

### Q2: Rust LocalLLM Provider Client

Goal:
queue executor が LocalLLM を Rust から呼べるようにする。

Tasks:

- SQLite settings から provider pool、target、API key、model config を読む。
- provider lease target id から LocalLLM endpoint/model を解決する。
- OpenAI-compatible chat completions client を Rust に実装する。
- timeout、abort、response body truncation、error classification を実装する。
- `503 Loading model`、connection refused、timeout、unsupported model を retryable worker-unavailable に分類する。
- API key を logs/status に出さない。

Completion criteria:

- Rust から Qwen target に authenticated chat completion を実行できる。
- provider target id と実 endpoint/model が一致する。
- provider failure が cooldown 付き retryable state へ変換される。

Verification:

```bash
cargo test -p context-stilld local_llm
cargo test -p context-stilld queue
cargo run -q -p context-stilld -- queue inspect --json
```

Stop conditions:

- API key が log / JSON output に漏れる。
- model mismatch が unsupported executor と混同される。
- provider error が failed storm を作る。

### Q3: EpisodeDistiller Rust Executor

Goal:
最初の LLM-backed executor として `episodeDistiller` を Rust 化する。

Reason:
現在の backlog の大半が `episodeDistiller` であり、source read、LLM call、EpisodeCard persistence の境界が比較的閉じている。`findingCandidate` は candidate extraction と covering enqueue へ広がるため後段に回す。

Tasks:

- `episode_distiller_queue` row reader を Rust に実装する。
- `vibe_memories` / source metadata reader を Rust に実装する。
- Episode prompt / schema parse / validation contract を fixture 化する。
- EpisodeCard writer を Rust に実装する。
  - `episode_cards`
  - `episode_refs`
  - FTS rows
  - queue metadata `episodeIds`
- segment failure aggregation を実装する。
- no episode、worker unavailable、schema parse failure、source missing を分離する。
- successful downstream mutation を確認してから queue completed にする。

Completion criteria:

- Rust resident が `episodeDistiller` を claim し、EpisodeCard を作成する。
- completed queue row の metadata に実在する EpisodeCard id が入る。
- failed/skipped/retried の意味が TypeScript 現行と一致する。
- provider failure で immediate retry loop が発生しない。

Verification:

```bash
cargo test -p context-stilld episode
cargo test -p context-stilld queue
bun test --timeout=30000 --max-concurrency=1 ./test/episode-card.repository.sqlite.test.ts
bun run rust:queue:smoke
bun run verify:rust-daemon
```

Live verification, read before and after:

```sql
select status, count(*) from episode_distiller_queue group by status;
select count(*) from episode_cards;
select queue_name, event_type, count(*) from distillation_queue_events group by queue_name, event_type;
select status, queue_name, queue_job_id, heartbeat_at from llm_provider_leases where status = 'active';
```

Stop conditions:

- queue completed が EpisodeCard 作成より先に起きる。
- generated EpisodeCard が source refs なしで保存される。
- 1つの provider failure が failed storm を作る。

### Q4: FindingCandidate Rust Executor

Goal:
`findingCandidate` を Rust resident で処理する。

Tasks:

- `provided_candidate` path を先に Rust 化する。
  - payload parse
  - `found_candidates` upsert
  - `covering_evidence_queue` enqueue
  - completed event append
- source target path を Rust 化する。
  - source reader
  - prompt construction
  - LocalLLM call
  - candidate schema parse
  - polarity / applicability metadata persistence
- `source_missing` と `no_candidate` を分離する。
- candidate ありの場合は `found_candidates` と covering queue enqueue を transaction boundary で扱う。

Completion criteria:

- Rust resident が `findingCandidate` pending を消化する。
- no candidate は skipped + `no_candidate` になる。
- source missing は skipped + `source_missing` になる。
- candidate ありでは covering queue が作られる。

Verification:

```bash
cargo test -p context-stilld finding_candidate
cargo test -p context-stilld queue
bun test --timeout=30000 --max-concurrency=1 ./test/sqlite-runtime-support.bun.ts
bun run rust:queue:smoke
```

Stop conditions:

- source missing と no candidate が混ざる。
- found candidate は作られるが covering queue が作られない。
- LLM parse failure が retryable/provider failure と混同される。

### Q5: Deterministic Persistence Executors

Goal:
LLM 境界が小さい queue を Rust 化する。

Migration order:

1. `mergeActivationFinalize`
2. `finalizeDistille`
3. deterministic parts of `coveringEvidence`
4. `deadZoneMergeReview`

Tasks:

- queue ごとに fixture を追加する。
- state transition と event append を Rust API に統一する。
- downstream mutation がある場合は確認後に completed にする。
- unsupported LLM/tool path は fail-closed にする。

Completion criteria:

- migrated queue は Rust resident だけで処理できる。
- non-migrated path は明示的に unsupported になる。
- TypeScript executor fallback は manual command としてのみ残る。

Verification:

```bash
cargo test -p context-stilld queue
bun test --timeout=30000 --max-concurrency=1 ./test/sqlite-runtime-support.bun.ts
bun run verify:sqlite
bun run verify:rust-daemon
```

Stop conditions:

- deterministic persistence の結果が fixture と一致しない。
- unsupported path が silent success になる。

### Q6: Remove Resident Queue Fallback

Goal:
resident runtime から TypeScript queue supervisor 依存を削除済みであることを固定する。

Tasks:

- sidecar registry で queue TS fallback を `manual-one-shot` に限定する。
- resident startup から queue Bun child の起動経路を削除または禁止する。
- LaunchAgent install/load path が Bun queue worker を起動できないことを検証する。
- `verify:rust-daemon` に process tree assertion を追加する。

Completion criteria:

- `context-stilld run` の resident runtime は Rust queue executor のみを所有する。
- TypeScript queue command は明示的な manual fallback だけである。
- status / inspect / doctor が Rust executor truth を返す。

Verification:

```bash
bun run verify:rust-daemon
CONTEXT_STILL_VERIFY_LIVE_OWNERSHIP=1 bun run verify:rust-daemon
ps aux | rg 'queue-supervisor|context-stilld run'
launchctl list | rg 'context-still|queue'
```

Stop conditions:

- resident queue 実行に Bun が必要になる。
- manual fallback が自動起動経路から到達可能なまま残る。

## Runtime Verification Matrix

| Check | Expected |
| --- | --- |
| pending exists + executor running | active lease appears and heartbeat updates |
| pending exists + executor unsupported | status is degraded / unsupported, not scheduled-green |
| LocalLLM 503 Loading model | job cooldown retryable, no immediate retry storm |
| connection refused | job cooldown retryable, target visible in error metadata |
| daemon shutdown | active job becomes recoverable and lease is released or stale-recoverable |
| completed episode job | EpisodeCard exists and queue metadata references it |
| completed finding job | found_candidates / covering queue effects are present when candidate exists |
| process tree | no `queue-supervisor.ts` under resident runtime |

## Live Operational Commands

Read-only baseline:

```bash
cargo run -q -p context-stilld -- status --json
cargo run -q -p context-stilld -- queue inspect --json
sqlite3 data/context-still-core.sqlite "select status, count(*) from episode_distiller_queue group by status"
sqlite3 data/context-still-core.sqlite "select status, count(*) from finding_candidate_queue group by status"
sqlite3 data/context-still-core.sqlite "select status, queue_name, queue_job_id, heartbeat_at from llm_provider_leases where status = 'active'"
```

Ownership check:

```bash
ps aux | rg 'context-stilld run|queue-supervisor'
launchctl list | rg 'context-still|queue'
lsof -nP -iTCP:39172 -sTCP:LISTEN
```

Verification gate:

```bash
cargo test -p context-stilld queue
bun run rust:queue:smoke
bun run verify:rust-daemon
```

Live ownership gate:

```bash
CONTEXT_STILL_VERIFY_LIVE_OWNERSHIP=1 bun run verify:rust-daemon
```

## Relationship To Existing Rust Daemon Plan

This plan is a focused replacement for the broad R7 queue executor section in `spec/docs/rust-daemon-replacement-readiness-plan.md`.

The broad daemon plan remains useful for overall Rust-only migration, but queue executor work should be driven from this document until resident queue execution is Rust-native and stable.

## Final Completion Criteria

- `context-stilld run` owns queue execution in Rust.
- `queue inspect --json` shows executor truth, active lease state, heartbeat, and blocked reason.
- pending runnable queue rows are claimed by Rust executor.
- `episodeDistiller` and `findingCandidate` execute without TypeScript resident worker.
- provider failures cool down instead of creating retry storms.
- completed queue rows have verified downstream mutations.
- live ownership verification proves no resident Bun queue worker is running.
