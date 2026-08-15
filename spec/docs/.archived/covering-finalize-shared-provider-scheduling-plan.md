# Covering / Finalize Shared Provider Scheduling Plan

> アーカイブ日: 2026-08-15。実装コミット: `6f2940e`。

## Purpose

`coveringEvidence` と `finalizeDistille` が同じ LLM provider 設定に見える場合、operator の期待どおり、covering の実行余力があるときに finalize も処理される状態へ揃える。

2026-06-26 の調査では、問題は LLM provider そのものではなかった。`coveringEvidence` は `local-llm` かつ `providerPoolId=local-llm-default` で、`com.context-still.covering-worker` が `src/cli/queue-supervisor.ts --continuous --queue coveringEvidence` として常駐していた。一方で `finalizeDistille` は `provider=local-llm` だが `providerPoolId` が空で、queue inspect では `pending=9 / runnablePending=9 / running=0 / lastHeartbeatAt=null` だった。

つまり現在の実態は次のとおり。

- provider 名は同じでも、provider pool scheduling 上は同じ pool に入っていない。
- covering worker は `allowedQueues=["coveringEvidence"]` 固定なので finalize を見ない。
- all-queue supervisor LaunchAgent は plist だけ残り、launchd にはロードされていない。
- Rust resident は queue scheduling/maintenance と一部 native executor を持つが、TypeScript finalize business executor を自動で拾う経路にはなっていない。

この計画では、「同じ provider に設定したら同じ実行余力を共有する」という設定上の意図を、runtime の queue scheduling と LaunchAgent/worker 構成に反映する。

## Desired End State

- `finalizeDistille` が `coveringEvidence` と同じ provider pool を参照する。
- `coveringEvidence` 用の実行余力が空いたとき、同じ pool 内で `finalizeDistille` が claim 対象になる。
- `queue inspect --json` で `finalizeDistille` の runnable pending があるのに `running=0 / lastHeartbeatAt=null` のまま放置されない。
- operator が provider 名だけでなく provider pool / allowed queues / executor ownership を確認できる。
- `coveringEvidence` の処理を壊さず、`finalizeDistille` が pending から completed/skipped/failed のいずれかへ実際に遷移する。
- job が完了扱いになるのは downstream mutation が確認済みの場合だけである。

## Non-Goals

- `finalizeDistille` の business logic や保存形式を再設計しない。
- `coverEvidence` の判定プロンプトや `knowledge_ready` 条件をこの計画に混ぜない。
- Episode distiller、findingCandidate、deadZoneMergeReview の scheduling policy をついでに変更しない。
- Rust-only queue executor 移行をこの計画で完了させない。
- live DB の破壊的リセットや pending job の一括削除をしない。
- provider fallback policy の全面再設計はしない。

## Implementation Order

### T0: Baseline And Invariant Capture

Goal:
修正前の設定差分と queue 実態を固定し、変更後に同じ観点で比較できるようにする。

Tasks:

- `settings.v1` から `coverEvidence.sourceSupport`、`coverEvidence.externalEvidence`、`finalizeDistille` の `provider`、`providerPoolId`、`model` を採取する。
- `queue inspect --json` で `coveringEvidence` と `finalizeDistille` の status counts、runnable pending、running、last heartbeat、active leases を採取する。
- launchd と process tree で、実際に起動している queue worker を確認する。
- `distillation_queue_events` で直近の `coveringEvidence` / `finalizeDistille` の claimed/completed/failed/retried を確認する。
- `finalizeDistille` の pending row が `knowledge_ready` evidence に対応していることを確認する。

Verification:

```bash
sqlite3 -header -column data/context-still-core.sqlite \
  "select json_extract(value,'$.settings.taskRouting.coverEvidence.sourceSupport.provider') as cover_source_provider, json_extract(value,'$.settings.taskRouting.coverEvidence.sourceSupport.providerPoolId') as cover_source_pool, json_extract(value,'$.settings.taskRouting.coverEvidence.externalEvidence.provider') as cover_external_provider, json_extract(value,'$.settings.taskRouting.coverEvidence.externalEvidence.providerPoolId') as cover_external_pool, json_extract(value,'$.settings.taskRouting.finalizeDistille.provider') as finalize_provider, json_extract(value,'$.settings.taskRouting.finalizeDistille.providerPoolId') as finalize_pool, json_extract(value,'$.settings.taskRouting.finalizeDistille.model') as finalize_model from settings where key='settings.v1';"

target/debug/context-stilld queue inspect --json

launchctl list | rg -i 'context-still|queue|cover|final|finding'
ps aux | rg 'queue-supervisor|context-stilld|covering|finalize|finding' | rg -v rg

sqlite3 -header -column data/context-still-core.sqlite \
  "select queue_name, event_type, message, count(*) as count, max(created_at) as last_seen from distillation_queue_events where queue_name in ('coveringEvidence','finalizeDistille') group by queue_name,event_type,message order by queue_name,last_seen desc;"
```

Completion criteria:

- 現在の provider 名一致と providerPoolId 不一致を記録できている。
- `finalizeDistille` の pending/runnable 状態を記録できている。
- 起動中 worker がどの queue を見ているか説明できる。

Stop conditions:

- live DB が開けない。
- runtime owner が特定できない。
- baseline 採取中に queue state が急変して比較不能になる。

### T1: Normalize Finalize Route To The Shared Provider Pool

Goal:
`finalizeDistille` が `coveringEvidence` と同じ provider pool scheduling に参加できるようにする。

Tasks:

- runtime settings normalization で、`finalizeDistille.providerPoolId` が空で、provider/model が `coverEvidence` と同じ場合に、明示的な provider pool へ解決されるべきか確認する。
- 既存 UI / repository / defaults の責務を確認し、設定保存時に providerPoolId を保持するのか、scheduler 側で route から pool を解決するのかを決める。
- 最小変更は以下のどちらかに寄せる。
  - 設定保存/normalization で `finalizeDistille.providerPoolId` を `local-llm-default` へ保存する。
  - scheduler の `providerPoolIdsForQueue("finalizeDistille")` が provider/model から既存 pool を解決できるようにする。
- operator 表示で provider 名だけでなく providerPoolId も見える状態を維持する。

Preferred approach:

設定値として `providerPoolId` を保存する方向を優先する。scheduler に暗黙推論を増やすより、設定と runtime truth が一致しやすい。

Verification:

```bash
sqlite3 -header -column data/context-still-core.sqlite \
  "select json_extract(value,'$.settings.taskRouting.finalizeDistille.provider') as provider, json_extract(value,'$.settings.taskRouting.finalizeDistille.providerPoolId') as providerPoolId from settings where key='settings.v1';"

bunx vitest run test/settings-runtime-cache.test.ts test/components/admin/settings-page.test.tsx test/admin/repositories.sources-settings.test.ts
```

Completion criteria:

- `finalizeDistille.providerPoolId` が空のままにならない。
- `providerPoolIdsForQueue("finalizeDistille")` が `local-llm-default` を返す。
- 既存の covering provider pool 設定を壊していない。

Stop conditions:

- 設定 UI / repository が providerPoolId を意図的に消している場合は、その意図を確認するまで進めない。
- provider/model から pool を一意に解決できない場合は、暗黙推論で進めない。

### T2: Make The Continuous Worker Cover The Intended Queue Set

Goal:
covering worker が covering だけを見続ける構成をやめ、同じ provider pool の中で finalize も claim 対象に入るようにする。

Tasks:

- 現在の `com.context-still.covering-worker` は `--queue coveringEvidence` 固定であることを前提に、LaunchAgent 生成元または setup script を特定する。
- 望ましい起動単位を決める。
  - Option A: shared provider worker として `--queue` を指定せず、全 queue の pool scheduler を使う。
  - Option B: `queue-supervisor.ts` に複数 `--queue` 指定を追加し、`coveringEvidence,finalizeDistille` だけを見る shared lane を作る。
  - Option C: finalize 専用 LaunchAgent を追加する。
- このプロジェクトの期待は「covering が空けば finalize」であるため、Option B を優先する。全 queue を見る Option A は finding/episode まで巻き込みやすい。Option C は同じ provider 余力の共有ではなく別 worker になる。
- `queue-supervisor.ts` が複数 queue を受けられない場合、`--queue` を複数回指定できるようにするか、`--queues coveringEvidence,finalizeDistille` を追加する。
- shared lane の priority は既存の `providerPoolQueuePriorityOrder` に従う。

Verification:

```bash
bunx vitest run test/queue-worker.test.ts

bun run src/cli/queue-supervisor.ts --once --queue coveringEvidence --queue finalizeDistille --limit 1 --worker smoke-covering-finalize
```

Expected result:

- provider pool の free slot があり、covering が claim できない場合に finalize が claim される。
- covering pending がある場合は既存 priority に従い covering が先に claim される。

Completion criteria:

- shared lane が `allowedQueues=["coveringEvidence","finalizeDistille"]` で動く。
- `priorityQueuesForProviderPool` に finalize が含まれる。
- `finalizeDistille` pending が `running` または terminal state へ進む。

Stop conditions:

- `--queue` 複数指定が既存 CLI 利用者を壊す。
- shared lane が finding/episode を誤って claim する。
- provider lease が同じ target に二重取得される。

### T3: Preserve Unpooled Finalize Behavior As A Fallback Only

Goal:
`finalizeDistille` が providerPoolId を持つ場合は pool scheduling に入り、providerPoolId がない設定では既存の unpooled behavior を壊さない。

Tasks:

- `unpooledQueues(["finalizeDistille"])` が providerPoolId 有りでは空になることをテストする。
- providerPoolId なしの fixture では、従来どおり unpooled worker が `runQueueWorkerOnce` できることを維持する。
- queue list / stats 表示で providerPoolId なし finalize を異常扱いするか、legacy/unpooled として明示するかを決める。

Verification:

```bash
bunx vitest run test/queue-worker.test.ts test/settings-runtime-cache.test.ts
```

Completion criteria:

- providerPoolId 有り finalize は pooled queue として扱われる。
- providerPoolId なし finalize は明示的な unpooled fallback として扱われる。
- covering の pooled behavior に回帰がない。

Stop conditions:

- unpooled finalize を使っているテスト/運用経路が silent に壊れる。
- providerPoolId の有無だけで queue visibility が変わり、operator が混乱する。

### T4: Update LaunchAgent Setup And Runtime Ownership

Goal:
実際の常駐プロセスが、新しい shared queue set を見るようにする。

Tasks:

- `com.context-still.covering-worker.plist` の生成元を更新し、`coveringEvidence` と `finalizeDistille` の shared lane を起動する。
- 既存の手動 plist だけを直接編集して終わりにしない。再生成時にも同じ構成になるよう、setup script / automation source を修正する。
- all-queue `com.context-still.queue-supervisor` plist が残っているが未ロードの状態を、operator に誤解させないよう整理する。
- Rust resident ownership と衝突しないことを確認する。

Verification:

```bash
launchctl print gui/$(id -u)/com.context-still.covering-worker
launchctl list | rg -i 'context-still|cover|final|queue'
ps aux | rg 'queue-supervisor|context-stilld|covering|finalize' | rg -v rg
target/debug/context-stilld queue inspect --json
```

Completion criteria:

- shared worker の process args に finalize が含まれる。
- `finalizeDistille` の `lastHeartbeatAt` が更新される。
- `finalizeDistille` pending が減る、または失敗理由付き terminal state へ進む。
- obsolete all-queue plist が runtime truth と矛盾しない。

Stop conditions:

- LaunchAgent reload が stale process を残す。
- Rust resident が同じ queue を同時に claim する。
- worker restart loop が発生する。

### T5: Live Drain Smoke

Goal:
実際の pending finalize を、covering の余力があるときに処理できることを確認する。

Tasks:

- covering pending/running を確認する。
- finalize pending のうち1件を対象に、shared worker または one-shot で処理する。
- `finalize_distille_queue` の status、`knowledge_items` の作成、`distillation_queue_events` の claimed/completed を確認する。
- 失敗した場合は provider failure、schema failure、procedure quality rejection、DB write failure を分ける。

Verification:

```bash
sqlite3 -header -column data/context-still-core.sqlite \
  "select id, evidence_result_id, status, attempt_count, last_error, last_outcome_kind, created_at, updated_at from finalize_distille_queue where status='pending' order by created_at limit 5;"

bun run src/cli/queue.ts --queue finalizeDistille --once --limit 1 --worker smoke-finalize-once

sqlite3 -header -column data/context-still-core.sqlite \
  "select status, count(*) as count, max(updated_at) as newest from finalize_distille_queue group by status;"

sqlite3 -header -column data/context-still-core.sqlite \
  "select event_type, message, count(*) as count, max(created_at) as last_seen from distillation_queue_events where queue_name='finalizeDistille' group by event_type,message order by last_seen desc;"
```

Completion criteria:

- finalize pending が少なくとも1件 terminal state へ進む。
- terminal state が `completed` の場合、対応する `knowledge_id` が入っている。
- terminal state が `failed` / `skipped` の場合、理由が operator に読める。
- covering worker の通常処理に回帰がない。

Stop conditions:

- live finalize が DB 書き込み途中で不整合になる。
- provider が不通で、retry/backoff なしに同じ job を再取得し続ける。
- `knowledge_ready` evidence ではない row を finalize しようとする。

## Test Gate

実装後の最低ゲート:

```bash
bunx vitest run test/queue-worker.test.ts test/settings-runtime-cache.test.ts test/components/admin/settings-page.test.tsx test/admin/repositories.sources-settings.test.ts
bun run verify:rust-daemon
git diff --check
```

必要に応じて追加するゲート:

```bash
bun run verify
```

`bun run verify` は広いので、最初の修正段階では focused tests と live drain smoke を優先し、commit 前または最終確認で実行する。

## Completion Criteria

- `finalizeDistille.providerPoolId` が covering と同じ pool を指す。
- shared worker の `allowedQueues` に `coveringEvidence` と `finalizeDistille` が含まれる。
- `queue inspect --json` で finalize pending があるとき、runner/heartbeat/lease の状態が説明可能になる。
- covering が空いたとき、finalize が claim される。
- live DB で pending finalize が少なくとも1件処理される。
- covering/finalize 以外の queue policy を変更していない。

## Operational Notes

- provider 名一致だけでは不十分である。scheduler は `providerPoolId` と `allowedQueues` を見る。
- `--queue coveringEvidence` 固定 worker は、covering が idle でも finalize を claim しない。
- `finalizeDistille` が providerPoolId 空のままだと pooled scheduling には参加しない。
- all-queue supervisor plist が存在しても、launchd にロードされていなければ実行経路ではない。
- `queue inspect` の `scheduled` 表示は、business executor が finalize を処理している証拠ではない。
