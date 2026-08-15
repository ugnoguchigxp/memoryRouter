# FindCandidate Recovery Implementation Plan

> アーカイブ日: 2026-08-15。retry/backoff/diagnosticsは後続実装へ反映済みで、現在のlive queue closeoutは [Rust Runtime Closeout Implementation Plan](../rust-runtime-closeout-implementation-plan.md) に置き換えた。

## Purpose

`findCandidate` が候補を作れなくなっている状態を、運用復旧と恒久修正の両方で解消する。

2026-06-26 の調査では、直近の支配原因は `source_missing` や `no_candidate` ではなかった。`finding_candidate_queue` の pending/running `vibe_memory` 178件は全て `vibe_memories` に存在していた。一方で `found_candidates` の最新作成は `2026-06-22T16:01:40Z`、`llm_usage_logs` の `find-candidate` 最新記録は `2026-06-23T10:01:57Z` で止まっていた。

Local LLM endpoint は `/health` と `/v1/models` には応答するが、保存済み secret を使った短い chat completion では以下だった。

| Endpoint | Result |
|---|---|
| `http://127.0.0.1:44448` | connection refused |
| `http://192.168.0.61:50043/v1` | 60s abort |
| `http://192.168.0.61:50041/v1` | 60s abort |

さらに、古い `worker_unavailable` / transient 503 再投入ジョブが `attempt_count = 0`、`next_run_at = null` または期限切れのまま先頭に残り、同じ少数ジョブを繰り返し claim して新規ジョブを塞いでいる。

この計画では、この3系統を混ぜずに直す。

1. Local LLM 実生成不通
2. `worker_unavailable` ジョブ滞留
3. fallback 不在

## Desired End State

- `findCandidate` が少なくとも1件の新規 `found_candidates` を作成できる。
- Local LLM が不調でも、同一ジョブが短周期で先頭を占有し続けない。
- `worker_unavailable` は観測可能な backoff / attempt / last error を残す。
- provider pool の health は `/health` だけでなく、短い chat completion の実生成可否も判定できる。
- primary Local LLM が実生成不能な場合、設定された fallback へ進むか、fallback 不在として明示的に停止する。
- `source_missing`、`no_candidate`、provider timeout、unsupported executor を別々に説明できる。

## Non-Goals

- 候補抽出プロンプト全体の再設計はしない。
- `findCandidate` と Episode distiller の責務境界を戻さない。
- SQLite schema の大規模変更はしない。
- live DB の破壊的リセットはしない。
- Local LLM サーバー自体の実装やモデルロード設定は、この repo 側の改修範囲に含めない。ただし疎通検証と設定切り替えは対象にする。

## Implementation Order

### T0: Baseline And Stop Conditions

Goal:
修正前の失敗状態を固定し、以降の改善を DB / queue events / logs / provider smoke で比較できるようにする。

Tasks:

- `finding_candidate_queue` の status / outcome / oldest / newest を採取する。
- `found_candidates` と `llm_usage_logs` の最新時刻を採取する。
- `distillation_queue_events` で `claimed` / `retried` / `completed` の直近を確認する。
- pending/running `vibe_memory` の source existence を確認する。
- Local LLM の endpoint ごとに以下を分けて確認する。
  - `/health`
  - `/v1/models`
  - authenticated short chat completion
- 実行中 owner を確認する。
  - `context-stilld run`
  - `context-stilld mcp serve`
  - legacy `bun run src/cli/queue-supervisor.ts`

Verification:

```bash
sqlite3 -header -column data/context-still-core.sqlite \
  "select status, last_outcome_kind, count(*) as count, min(created_at) as oldest, max(updated_at) as newest from finding_candidate_queue group by status, last_outcome_kind order by status, count desc;"

sqlite3 -header -column data/context-still-core.sqlite \
  "select count(*) as found_candidates, max(created_at) as newest from found_candidates;"

sqlite3 -header -column data/context-still-core.sqlite \
  "select source, count(*) as calls, max(created_at) as newest from llm_usage_logs where source='find-candidate' group by source;"

sqlite3 -header -column data/context-still-core.sqlite \
  "select count(*) as pending_total, sum(case when vm.id is null then 1 else 0 end) as missing_vibe_memory from finding_candidate_queue fq left join vibe_memories vm on vm.id = fq.source_key where fq.status in ('pending','running') and fq.source_kind='vibe_memory';"

ps aux | rg 'context-stilld|queue-supervisor|bun run src/cli/queue-supervisor'
```

Completion criteria:

- Baseline が1つの記録として残る。
- 入力欠損と provider 不通を混同していない。
- 以降の実装で比較する指標が決まっている。

Stop conditions:

- DB が開けない。
- live worker owner が特定できない。
- baseline が取れないまま状態変更が必要になる。

### T1: Recover Live Provider Path

Goal:
まず実生成できる provider 経路を作り、`findCandidate` が候補を作れる状態へ戻す。

Tasks:

- Local LLM の全 configured models に authenticated short chat completion smoke を追加または手順化する。
- `/health` success だけで reachable と見なさないよう、operator 向け診断で chat completion 可否を表示する。
- `findCandidate` route が実生成不能な Local LLM だけを指している場合、暫定復旧として以下のどちらかを選ぶ。
  - Local LLM サーバー側を復旧する。
  - `findCandidate.source` / `findCandidate.vibe` に Azure fallback を設定する。
- fallback を設定する場合、`providerPoolId` と route context によって fallback が意図せず潰れないか確認する。

Verification:

```bash
bun -e "import { ensureRuntimeSettingsLoaded } from './src/modules/settings/settings.service.ts'; import { checkLlmProviderHealthMatrix } from './src/modules/llm/agentic-llm.service.ts'; await ensureRuntimeSettingsLoaded(); const rows = await checkLlmProviderHealthMatrix(15000, { selectedProvider: 'local-llm', routeOrder: ['local-llm'] }); console.log(JSON.stringify(rows.map((row) => { const { provider, ...rest } = row; return rest; }), null, 2));"
```

Expected result:

- `findCandidate` で使う primary target か fallback target の少なくとも1つが short chat completion まで成功する。
- 成功しない target は `reachable: false` または diagnostic error として見える。

Completion criteria:

- provider smoke が `/health` だけでなく実生成で成功する。
- `findCandidate` が利用する route に成功可能な target が含まれている。

Stop conditions:

- Local LLM が全 target で実生成不能、かつ Azure fallback も使えない。
- fallback 追加が cost / data routing policy の判断を必要とする。

### T2: Fix Worker-Unavailable Starvation

Goal:
`worker_unavailable` の一時失敗ジョブがキュー先頭を占有し続けないようにする。

Tasks:

- `keepQueueJobWaitingForWorker` の `findingCandidate` 挙動を見直す。
- `worker_unavailable` でも以下を記録する。
  - retry counter または worker-unavailable counter
  - exponential backoff された `next_run_at`
  - last error category
  - provider target id when available
- `attempt_count` を通常 failure と同じ意味で増やすか、別 counter にするかを決める。
  - 推奨: semantic failure と混ぜたくない場合は metadata counter を追加し、queue ordering ではその counter を使う。
  - 簡易案: `attempt_count` を増やし、provider recovery 時の retry reset path を用意する。
- claim order が古い失敗ジョブを永久優先しないようにする。
  - `next_run_at` が未来のジョブは claim しない。
  - `worker_unavailable` の backoff 中は新規 pending が先に進める。
- `updated_at` / event metadata で、同じ2件がループしていることを後から説明できるようにする。

Verification:

```bash
bunx vitest run test/queue-state.test.ts test/queue-worker.test.ts test/sqlite-runtime-support.bun.ts
```

Expected result:

- `worker_unavailable` 後の `next_run_at` は固定30秒ではなく、再試行回数に応じて伸びる。
- 同じ provider timeout ジョブが即座に再claimされない。
- 新規 pending job が starvation しない。

Completion criteria:

- focused tests が通る。
- live DB で `worker_unavailable` ジョブが先頭を占有し続けない。
- `distillation_queue_events` に retry reason と backoff が残る。

Stop conditions:

- `source_missing` や `no_candidate` が retry 扱いに変わる。
- provider 不通時に job が `completed` 扱いになる。
- claim logic が queue ごとの同時実行制御を壊す。

### T3: Add FindCandidate Provider Fallback Semantics

Goal:
primary Local LLM が timeout したとき、設定済み fallback があるなら候補生成を継続できるようにする。

Tasks:

- `runDistillationCompletion` と `runFindCandidate` の provider fallback 挙動を確認する。
- `isQueueWorkerUnavailableError` で即 queue retry に戻す前に、provider route 内 fallback が試される構造になっているか確認する。
- `findCandidate.source` / `findCandidate.vibe` の fallback 設定を honoring する。
- provider pool lease context が Local LLM target 固定時に fallback を完全に消す現行挙動を再評価する。
  - provider pool worker の target lease は primary attempt に限定する。
  - fallback は同じ pool 内の別 target、または explicit fallback provider に進める設計にする。
- fallback が発火した場合、queue event metadata に primary failure と fallback provider を残す。

Verification:

```bash
bunx vitest run test/queue-worker.test.ts test/sqlite-runtime-support.bun.ts
```

Add focused cases:

- primary Local LLM timeout, Azure fallback success, job completed with candidates.
- primary Local LLM timeout, no fallback, job remains pending with `worker_unavailable`.
- primary Local LLM timeout, fallback also timeout, job backoff applies.

Completion criteria:

- fallback configured path は実際に候補生成まで進む。
- fallback absent path は明示的に `worker_unavailable` で待つ。
- queue event から primary / fallback の成否が追える。

Stop conditions:

- fallback が provider lease の同時実行制御を迂回する。
- fallback によって意図しない cloud provider 利用が発生する。
- candidate content の保存前に worker が completed を返す。

### T4: Live Recovery Run

Goal:
実装後、live queue を破壊せずに最小件数で復旧を確認する。

Tasks:

- queue lane を必要に応じて一時停止し、現在の running job を確認する。
- stale running があれば既存の recovery path で pending に戻す。
- 1件だけ `findingCandidate` worker を手動実行する。
- `found_candidates` / `covering_evidence_queue` / `distillation_queue_events` を確認する。
- 問題がなければ continuous worker に戻す。

Verification:

```bash
sqlite3 -header -column data/context-still-core.sqlite \
  "select id,status,attempt_count,next_run_at,last_outcome_kind,substr(last_error,1,160) as last_error,updated_at from finding_candidate_queue where status in ('pending','running') order by priority desc, created_at asc limit 20;"

bun run src/cli/queue-supervisor.ts --queue findingCandidate --limit 1

sqlite3 -header -column data/context-still-core.sqlite \
  "select count(*) as found_candidates, max(created_at) as newest from found_candidates;"

sqlite3 -header -column data/context-still-core.sqlite \
  "select queue_job_id,event_type,message,metadata,created_at from distillation_queue_events where queue_name='findingCandidate' order by created_at desc limit 20;"
```

Expected result:

- 1件の worker run が timeout ループでは終わらない。
- 候補ありなら `found_candidates` が増える。
- 候補なしなら `no_candidate` として completed/skipped され、provider timeout と混ざらない。
- provider 不調なら backoff 付き `worker_unavailable` になり、同一ジョブがすぐ先頭に戻らない。

Completion criteria:

- live DB で `findCandidate` の最新処理時刻が進む。
- `found_candidates` が増える、または正しい terminal/skipped reason が残る。
- pending queue が同じ2件の retry loop から抜ける。

Stop conditions:

- worker が candidate persistence 前に completed を返す。
- `source_missing` が急増する。
- Local LLM timeout が続き、fallback も失敗する。

### T5: Regression Gates

Goal:
同じ故障を検出できる検証ゲートを残す。

Tasks:

- `doctor` または queue inspector に、`findCandidate` の以下を出す。
  - latest `found_candidates.created_at`
  - latest `llm_usage_logs` for `find-candidate`
  - pending/running `worker_unavailable` count
  - oldest pending age
  - source existence mismatch count
- Local LLM health matrix に実生成 smoke の結果を追加する。
- queue tests に starvation regression を追加する。
- docs に復旧手順を短く残す。

Verification:

```bash
bun run verify:rust-daemon
bun run verify
```

Completion criteria:

- repo-native verify が通る。
- `doctor` または queue inspector で今回の状態を一目で検出できる。
- Local LLM `/health` 成功だけで false healthy にならない。

Stop conditions:

- verify が live external provider 必須になり、offline 開発で常に失敗する。
- doctor が live DB を変更する。

## Operational Recovery Shortcut

実装修正に入る前に運用復旧だけを試す場合は、次の順で行う。

1. Local LLM `50041` / `50043` の authenticated short chat completion を復旧する。
2. 復旧できない場合、`findCandidate.source` / `findCandidate.vibe` の fallback に Azure を一時設定する。
3. `worker_unavailable` で詰まっている先頭ジョブを一括リセットせず、まず1件 worker run で挙動を見る。
4. 同じ2件が再び先頭を占有するなら、T2 の starvation fix なしに全体 drain へ進まない。

## Final Verification Checklist

- [ ] `source_missing` と `no_candidate` の分類が維持されている。
- [ ] Local LLM 実生成 smoke が provider target ごとに見える。
- [ ] `worker_unavailable` が backoff される。
- [ ] fallback configured path が実候補生成まで通る。
- [ ] fallback absent path が明示的に待機する。
- [ ] `found_candidates` の最新時刻が進む。
- [ ] `distillation_queue_events` から retry / fallback / completed が追える。
- [ ] `bun run verify:rust-daemon` が通る。
- [ ] `bun run verify` が通る。
