# EpisodeDistiller 逐次生成 実装計画

> アーカイブ日: 2026-08-15。実装コミット: `18b1429`。

## 背景

現在の Rust `episodeDistiller` は、source を segment に分割し、各 segment から canonical Episode 候補を生成したあと、job の最後にまとめて `episode_cards` へ保存する。

この方式は job 単位の完了整合性は分かりやすいが、次の問題がある。

- 長時間 job の途中で Episode 出力が見えない。
- heartbeat は更新されても、LLM が進んでいるのか、HTTP request が詰まっているだけなのかを判定しづらい。
- 途中で失敗した場合、保存可能だった Episode まで失われる。
- 「10分以内に新規 Episode 出力があれば正常、20分近く無出力なら回復検討」という運用基準を直接適用できない。

この計画は、`episodeDistiller` を「job 末尾一括保存」から「segment ごとに生成し、保存可能な Episode は即時保存しながら継続する」方式へ移行するための実装順序、完了条件、検証ゲート、停止条件を定義する。

## 目的

- 保存可能な Episode を job 終了前に `episode_cards` へ永続化する。
- 最新 Episode 出力時刻を、稼働判定の主信号として使えるようにする。
- segment 単位の進捗、失敗、保存済み Episode、再開位置を queue metadata に残す。
- 途中失敗後の再実行で、保存済み Episode を壊さず未処理部分から再開できるようにする。
- 重複と低品質 Episode は保存前に抑止する。

## 非目的

- `findCandidate` に Episode 作成責務を戻さない。
- Episode 検索/API/UI の大規模再設計は行わない。
- 既存 EpisodeCard の全文再生成はこの計画に含めない。
- provider pool / queue scheduler の優先順位設計を広げない。
- live DB を使う破壊的 smoke を検証ゲートにしない。

## 現状の重要な制約

- `episode_cards.created_at` は `2026-...T...Z` と `2026-... ...` の形式が混在している。監視SQLでは `MAX(datetime(created_at))` を使う。
- Rust executor の heartbeat は処理本体とは別に更新される。heartbeat だけを正常判定に使わない。
- `create_episode_idempotently()` は deterministic `source_key` を使って既存 Episode を再利用できる。この性質を再開/重複防止の中心に置く。
- 既存の `episodeDistiller` metadata には `generated`、`deduped`、`failedSegments`、`segmentErrors`、`episodeIds` があるが、処理中に更新される progress contract はまだ不足している。

## 変更対象

Primary files:

| File | 変更内容 |
|---|---|
| `crates/context-stilld/src/domains/queue_lifecycle/episode_executor.rs` | segment ごとの即時保存、progress metadata 更新、再開 skip、無出力 watchdog を実装する。 |
| `crates/context-stilld/src/domains/queue_lifecycle/executor.rs` | 必要なら watchdog 判定や timeout 理由を queue executor report に反映する。 |
| `crates/context-stilld/src/domains/queue_lifecycle/inspect.rs` | 必要なら `queue inspect --json` に latest output / progress 情報を追加する。 |
| `src/modules/episodeDistiller/worker.ts` | TypeScript manual fallback との意味差が出る場合だけ追随する。resident path の主実装は Rust とする。 |
| `web/src/modules/admin/components/queue.page.tsx` | 必要なら progress metadata 表示を追加する。初期実装では必須にしない。 |

Test files:

| File | 確認内容 |
|---|---|
| `crates/context-stilld/src/domains/queue_lifecycle/episode_executor.rs` tests | segment ごとの即時保存、再開、重複skip、watchdog metadata を固定する。 |
| `crates/context-stilld/src/domains/queue_lifecycle/provider_lease_tests.rs` | provider lease / heartbeat の既存契約が壊れていないことを確認する。 |
| `test/episode-card.repository.sqlite.test.ts` | 保存済み EpisodeCard の SQLite read path が維持されることを確認する。 |

## Progress Metadata Contract

`episode_distiller_queue.metadata.episodeDistiller` に次のフィールドを追加する。

```json
{
  "segmentCount": 9,
  "currentSegment": 3,
  "lastSegmentStartedAt": "2026-06-23T03:13:00Z",
  "lastSegmentCompletedAt": "2026-06-23T03:16:20Z",
  "lastEpisodeCreatedAt": "2026-06-23T03:16:20Z",
  "savedEpisodeIds": ["..."],
  "savedSourceKeys": ["vibe_memory:...:episode:..."],
  "acceptedCandidateCount": 4,
  "generated": 4,
  "deduped": 1,
  "skipped": 2,
  "valueSkipped": 1,
  "duplicateGenerationKindSkipped": 1,
  "failedSegments": 1,
  "segmentResults": [
    {
      "segment": 0,
      "status": "saved",
      "episodeIds": ["..."],
      "startedAt": "...",
      "completedAt": "..."
    }
  ],
  "segmentErrors": [
    {
      "segment": 2,
      "error": "..."
    }
  ]
}
```

Rules:

- `savedEpisodeIds` is append-only for one job execution.
- `savedSourceKeys` is used for restart skip checks.
- `lastEpisodeCreatedAt` updates only after an actual `episode_cards` insert or dedupe confirmation.
- `lastSegmentCompletedAt` updates after a segment is fully handled, even if it produced no saved Episode.
- `currentSegment` is the segment currently being attempted or the next segment to resume.
- Existing summary fields remain available at job completion.

## Runtime Freshness Contract

監視の主信号は Episode 出力時刻である。

Normal:

- `MAX(datetime(episode_cards.created_at)) >= datetime('now', '-10 minutes')`

Warning:

- running `episodeDistiller` があり、latest Episode output が 10 分より古い。

Recovery candidate:

- running `episodeDistiller` があり、latest Episode output が 20 分より古い。
- かつ `lastSegmentCompletedAt` または `lastEpisodeCreatedAt` が 20 分以上進んでいない。

Do not use as normal signal:

- queue row heartbeat only.
- provider lease heartbeat only.
- daemon PID existence only.

Baseline SQL:

```sql
select
  datetime('now') as now,
  max(datetime(created_at)) as latest_episode_created_utc,
  round((julianday(datetime('now')) - julianday(max(datetime(created_at)))) * 24 * 60, 2)
    as minutes_since_latest_episode
from episode_cards;

select
  id,
  status,
  locked_at,
  heartbeat_at,
  json_extract(metadata, '$.episodeDistiller.currentSegment') as current_segment,
  json_extract(metadata, '$.episodeDistiller.segmentCount') as segment_count,
  json_extract(metadata, '$.episodeDistiller.lastSegmentCompletedAt') as last_segment_completed_at,
  json_extract(metadata, '$.episodeDistiller.lastEpisodeCreatedAt') as last_episode_created_at
from episode_distiller_queue
where status = 'running';
```

## P0: Baseline And Fixtures

Goal:
現在の一括保存挙動をテストで固定し、変更後に意図した差分だけを確認できるようにする。

Tasks:

- Rust episode executor tests に、複数 segment の fixture を追加する。
- 既存の job-end save 挙動を baseline として記録する。
- `datetime(created_at)` を使う freshness SQL をテスト/ドキュメントに固定する。
- `create_episode_idempotently()` の source key dedupe 挙動を再開前提としてテストする。

Completion criteria:

- 変更前の一括保存挙動を再現するテストがある。
- created_at 形式混在でも latest output が正しく取れる。
- source key dedupe が再実行で duplicate insert を作らない。

Verification:

```bash
cargo test -p context-stilld episode
cargo test -p context-stilld queue_lifecycle::episode_executor -- --nocapture
```

Stop conditions:

- baseline fixture が live DB の偶然の形に依存する。
- created_at の文字列 `MAX()` を監視基準に使う。

## P1: Segment Progress Metadata

Goal:
保存タイミングを変える前に、segment 進捗を queue row へ記録する。

Tasks:

- `process_episode_distiller_job()` の segment loop で `currentSegment`、`segmentCount`、`lastSegmentStartedAt` を更新する。
- segment 完了時に `lastSegmentCompletedAt` と `segmentResults` を更新する。
- parse failure、low value skip、duplicate generation kind skip を segment result として記録する。
- metadata 更新は best-effort ではなく、失敗したら job failure として扱う。

Completion criteria:

- running job の metadata から現在 segment と最終完了 segment が読める。
- segment が Episode を保存しない場合でも進捗が更新される。
- 既存 summary metadata と互換性を保つ。

Verification:

```bash
cargo test -p context-stilld episode
cargo run -q -p context-stilld -- queue inspect --json
```

Stop conditions:

- heartbeat だけが進み、segment progress が更新されない。
- metadata 更新失敗を無視して job が進む。

## P2: Immediate Save Per Segment

Goal:
保存可能な Episode を segment 完了時点で `episode_cards` へ保存する。

Tasks:

- `pending: Vec<PendingEpisode>` を job 全体の蓄積ではなく segment-local に変更する。
- segment ごとに canonical candidate を品質判定し、保存可能なものだけ `create_episode_idempotently()` へ渡す。
- 保存成功後すぐに `savedEpisodeIds`、`savedSourceKeys`、`lastEpisodeCreatedAt` を metadata に反映する。
- job 完了時は summary metadata を既存 shape と互換になるよう集計する。
- segment 内で複数 Episode が作られる場合は、保存順と source key を deterministic に保つ。

Completion criteria:

- job が running のままでも、合格 Episode は `episode_cards` に存在する。
- latest Episode output freshness が running job の途中で更新される。
- job completion metadata の `episodeIds` は実在 EpisodeCard id と一致する。

Verification:

```bash
cargo test -p context-stilld episode
bun test --timeout=30000 --max-concurrency=1 ./test/episode-card.repository.sqlite.test.ts
```

Live read-only check after deploy:

```sql
select max(datetime(created_at)) from episode_cards;
select id, status, json_extract(metadata, '$.episodeDistiller.savedEpisodeIds')
from episode_distiller_queue
where status in ('running', 'completed')
order by datetime(coalesce(completed_at, locked_at)) desc
limit 5;
```

Stop conditions:

- queue job が completed になる前に保存された Episode が refs なしになる。
- immediate save 後の job failure で保存済み Episode が orphan になる。
- summary metadata と saved Episode ids が食い違う。

## P3: Resume From Saved Progress

Goal:
途中失敗後の再実行で、保存済み Episode を壊さず未処理 segment から続行する。

Tasks:

- job load 時に metadata の `savedSourceKeys` と `segmentResults` を読む。
- 既存 `episode_cards` からも source key を確認し、metadata 欠落時にも dedupe できるようにする。
- 完了済み segment は skip し、skip したことを `segmentResults` に追記または維持する。
- 前回失敗 segment は再試行対象にする。
- 保存済み Episode の再保存は `deduped` として数える。

Completion criteria:

- segment 途中で失敗した job を再実行しても、保存済み Episode は重複しない。
- 未処理 segment だけが処理される。
- metadata が一部欠落しても source key dedupe で安全に復旧できる。

Verification:

```bash
cargo test -p context-stilld episode_resume
cargo test -p context-stilld queue
```

Stop conditions:

- 再実行で同一 source key の Episode が複数保存される。
- metadata 欠落時に全 segment を無条件再生成して重複を作る。

## P4: No-Output Watchdog And Recovery State

Goal:
「20分近く無出力なら強制終了を検討する」状態を機械的に判定できるようにする。

Tasks:

- running job の `locked_at`、`lastEpisodeCreatedAt`、`lastSegmentCompletedAt` を使って freshness を算出する helper を追加する。
- `queue inspect --json` に episodeDistiller の latest output freshness を追加するか、doctor/operation query で読める形にする。
- Recovery candidate は即 kill ではなく、まず `stalled_output` 状態または diagnostic field として見せる。
- 強制終了する場合の仕様を決める。
  - active provider lease を `stale_recovered` または `worker_failed` 理由で解放する。
  - queue row は保存済み progress を残して `pending` に戻す。
  - `next_run_at` に短い cooldown を設定する。
  - `distillation_queue_events` に `retried` または `failed` を記録する。

Completion criteria:

- 10分以内の Episode output は normal と判定される。
- 20分以上 output/progress がない running job は recovery candidate と判定される。
- heartbeat が新しくても output/progress が止まっていれば normal にならない。

Verification:

```bash
cargo test -p context-stilld queue_lifecycle::inspect
cargo test -p context-stilld episode
```

Stop conditions:

- 正常に長い LLM request を無条件 kill する。
- 保存済み Episode を未確定扱いに戻す。
- provider lease だけ解放して queue row を running のまま残す。

## P5: UI / Operations Surface

Goal:
運用者が heartbeat ではなく output freshness と segment progress を見て判断できるようにする。

Tasks:

- Queue page に `latestEpisodeOutputAt`、`minutesSinceLatestEpisodeOutput`、`currentSegment/segmentCount` を表示する。
- running job で 10分超の無出力は warning、20分超は recovery candidate として表示する。
- `spec/docs/pub/operations.md` に read-only SQL と判断基準を追記する。
- 強制終了操作は初期実装では自動化しない。まず read-only 判定と手動回復手順を固定する。

Completion criteria:

- UI/operations で heartbeat と output freshness が区別される。
- 20分無出力の job を見つける read-only 手順がある。
- 強制終了は明示操作であり、自動 kill は別計画に分離される。

Verification:

```bash
bun run typecheck
bunx vitest run web/src
bun run docs:check-links
```

Stop conditions:

- heartbeat freshness を正常表示の主条件として使う。
- recovery candidate 表示が自動 kill と同義になる。

## Runtime Verification Matrix

| Scenario | Expected evidence |
|---|---|
| running job produced an Episode | `episode_cards` has a new row before queue completion |
| segment produced no valuable Episode | `segmentResults` records skipped/valueSkipped and `lastSegmentCompletedAt` advances |
| segment parse failed | `segmentErrors` records segment index and job continues when other segments can proceed |
| job fails after saving some Episodes | saved Episode ids remain, queue row returns to pending/failed with progress metadata |
| job resumes | saved source keys are skipped or deduped, remaining segments run |
| no output for 20 minutes | inspect/operations marks recovery candidate despite heartbeat updates |

## Final Completion Criteria

- `episodeDistiller` no longer waits until job end to save all EpisodeCards.
- A running job can update latest Episode output within the job lifetime.
- `episode_distiller_queue.metadata.episodeDistiller` contains enough progress to explain current segment, saved Episodes, skipped segments, and failure points.
- Re-running a partially completed job does not duplicate saved Episodes.
- Completed queue rows still reference real EpisodeCard ids.
- Read-only operations can classify normal/warning/recovery candidate without relying on heartbeat alone.

## Global Verification Gate

Run before considering the migration complete:

```bash
cargo test -p context-stilld episode
cargo test -p context-stilld queue
bun test --timeout=30000 --max-concurrency=1 ./test/episode-card.repository.sqlite.test.ts
bun run verify:rust-daemon
bun run docs:check-links
```

Read-only live sanity check:

```bash
cargo run -q -p context-stilld -- queue inspect --json
sqlite3 data/context-still-core.sqlite "
select max(datetime(created_at)) as latest_episode_created_utc from episode_cards;
select status, count(*) from episode_distiller_queue group by status;
select status, queue_name, queue_job_id, heartbeat_at from llm_provider_leases where status = 'active';
"
```

## Global Stop Conditions

Stop and review if:

- queue completion happens before downstream EpisodeCard persistence is confirmed.
- immediate save creates EpisodeCards without `episode_refs`.
- partial failure loses saved Episode ids from metadata.
- resume creates duplicate EpisodeCards for the same deterministic source key.
- output freshness cannot be computed from SQLite without ad hoc timestamp parsing.
- watchdog logic would kill a job solely because heartbeat is old or solely because heartbeat is fresh.
