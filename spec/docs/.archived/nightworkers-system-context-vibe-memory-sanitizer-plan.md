# NightWorkers SystemContext Vibe Memory Sanitizer 実装計画

> アーカイブ日: 2026-08-15。実装コミット: `0809d37`。

## 背景

NightWorkers を Codex SDK 経由で実行すると、Codex 側の通常ログでは見えにくい NightWorkers 独自の実行契約が、Codex session JSONL 上では user message の一部として残る場合がある。

代表例は、NightWorkers が Codex SDK に渡す prompt の末尾に付与する `[NightWorkers Runtime Contract]` である。この block は `taskId`、`runId`、`repoRoot`、`executionMode`、MCP tool contract、Todo / closeout / verification の内部規約を含む。

この情報は NightWorkers の監査や失敗解析には有用だが、contextStill の `agent-log-sync` がそのまま vibe memory 化すると、実装タスク履歴ではなく SystemContext / Runtime Contract が後続の memory retrieval / distillation に混入する。

一方で、実装タスクそのものの履歴は vibe memory に残したい。ユーザー依頼、実装の流れ、assistant の報告、tool call 由来の diff、final report は、後続の `context_compile` / `context_decision` / Episode 生成に有用な作業経験である。

この計画は、NightWorkers implementation task の履歴を保持しつつ、implementation lane に混入した SystemContext / Runtime Contract block だけを保存前に除去するための実装順序、検証、停止条件を定義する。

## 目的

- NightWorkers Codex SDK の implementation task 履歴を vibe memory に残す。
- `[NightWorkers Runtime Contract]` 以降の SystemContext / Runtime Contract 本文を vibe memory の `content` に保存しない。
- contract 除去後も、ユーザー依頼や実装タスク本文があれば保存対象として維持する。
- `taskId`、`runId`、`executionMode` などの小さい紐付け情報は metadata として保存できるようにする。
- TypeScript agent-log-sync と resident Rust agent-log-sync の両経路で保存結果を一致させる。
- 既存の project/session 除外や diff 抽出、episode/finding enqueue の挙動を壊さない。

## 非目的

- NightWorkers 側の監査ログ、run event、activity event、Codex SDK prompt 生成を削除しない。
- NightWorkers 全体、または Codex logs 全体を `AGENT_LOG_EXCLUDED_PROJECT_NAMES` で除外しない。
- planning / general_answer / review lane の扱いを同時に再設計しない。
- vibe memory distillation prompt、Episode schema、knowledge schema を変更しない。
- 既存の汚染済み memory cleanup を同じ実装差分に混ぜない。cleanup は別作業として扱う。

## 現状の重要な制約

- TypeScript path では `src/modules/agent-log-sync/sync.service.helpers.ts` の `filterDistillableAgentLogMessages()` が message 単位の除外を担う。
- TypeScript path では `src/modules/agent-log-sync/sync.service.ts` が SQLite / Postgres の `vibe_memories` insert と episode enqueue を持つ。
- TypeScript path には既に `isCodexInternalProviderPromptMessage()` があり、Codex 内部 provider prompt と次 assistant を skip する。ただし NightWorkers Runtime Contract には未対応である。
- Rust resident path では `crates/context-stilld/src/domains/agent_log_sync/ingest.rs` が Codex JSONL を `ChatMessage` に変換し、`store.rs` が transcript 化して `vibe_memories` に保存する。
- resident runtime は agent-log-sync を Rust 側で所有しうるため、TypeScript だけに sanitizer を入れると live runtime で漏れる可能性がある。
- `AGENT_LOG_MIN_DISTILLABLE_CHARS` は readable transcript の長さで保存可否を決める。contract 除去後の readable content に対して判定する必要がある。
- `agent_diff_entries` は tool call や diff extraction に依存するため、contract 除去は chat content に限定し、diff 抽出 path を壊さない。
- `dedupe_key` は `sourceId:memorySessionId:chunkIndex` で作られる。sanitizer の位置で chunk 境界が変わると、同じ履歴が別 chunk として再保存されうる。

## 保存 Contract

### 残す内容

- ユーザーが依頼した実装タスク本文。
- assistant の実装説明、調査結果、検証結果、final report。
- tool call 由来の diff / patch 抽出結果。
- `taskId`、`runId`、`executionMode`、`repoRoot` などの短い識別 metadata。
- session / project metadata。

### 落とす内容

- `[NightWorkers Runtime Contract]` marker から始まる Runtime Contract block。
- contract 内の MCP tool rules、Todo rules、verification rules、closeout rules、import rules。
- contract だけで構成される message。

### 対象 lane

初期実装では、contract block 内に次が含まれる場合だけ除去する。

```text
executionMode: implementation
```

`runtime_debug`、`planning`、`review`、`general_answer` はこの計画の対象外とし、必要になった時点で別途判断する。

## Chunk / Dedupe Stability Contract

Sanitizer は `chunkMessages()` の前ではなく、chunk が決まった後、`buildTranscript()` / `buildReadableTranscript()` / diff extraction の直前に適用する。

理由:

- `chunkIndex` と `dedupeKey` を既存 path と同じ計算に保つ。
- Runtime Contract は非常に長く、chunk 前に削ると同じ session の後続 message が別 chunk に移動する可能性がある。
- 保存内容だけを変え、sync cursor、session grouping、chunk identity は変えない方が、既存 memory との重複や大量再取り込みを避けやすい。

Rules:

- grouping と chunking は raw ingest message で行う。
- 各 chunk の中で `sanitizeNightWorkersRuntimeContractChunk(chunk)` を作り、保存用 transcript と diff extraction には sanitized chunk を使う。
- `dedupeKey` は raw chunk の `chunkIndex` から作る。
- sanitizer 後の chunk が空なら、その chunk は保存しない。
- `AGENT_LOG_MIN_DISTILLABLE_CHARS` は sanitized readable transcript に対して判定する。
- metadata には strip された message があったことを chunk aggregate として残す。

## Metadata Contract

既存 metadata key は削除しない。Runtime Contract 除去に関する追加 key は、TypeScript / Rust で同じ名前にする。

Chunk metadata:

```json
{
  "nightWorkersRuntimeContractStripped": true,
  "nightWorkersRuntimeContractStrippedCount": 1,
  "nightWorkersRuntimeContractExecutionMode": "implementation",
  "nightWorkersTaskId": "task-id-if-present",
  "nightWorkersRunId": "run-id-if-present",
  "rawMessageCount": 4,
  "messageCount": 3
}
```

Rules:

- `messageCount` は保存対象になった sanitized message 数を表す。
- `rawMessageCount` は chunking 時点の raw message 数を表す。
- `nightWorkersRuntimeContractStripped` は 1 件以上 strip した場合だけ `true` にする。
- `nightWorkersRuntimeContractStrippedCount` は strip した message 数を表す。
- `nightWorkersTaskId` / `nightWorkersRunId` は contract block から抽出できた場合だけ保存する。
- metadata に Runtime Contract 本文や長い prompt 本文を保存しない。

## Sanitizer 仕様

### TypeScript

新規 helper を `src/modules/agent-log-sync/sync.service.helpers.ts` に追加する。

候補 API:

```ts
export type NightWorkersRuntimeContractSanitizeResult = {
  content: string;
  stripped: boolean;
  executionMode?: string;
};

export function sanitizeNightWorkersRuntimeContractMessage(
  message: ChatMessage,
): ChatMessage | null;

export function sanitizeNightWorkersRuntimeContractChunk(
  chunk: ChatMessage[],
): ChatMessage[];
```

処理 rules:

- `message.metadata.sourceId !== "codex_logs"` の場合は変更しない。
- `message.content` に `[NightWorkers Runtime Contract]` がない場合は変更しない。
- marker 以降の block に `executionMode: implementation` がない場合は変更しない。
- marker より前の本文を trim して残す。
- marker より前が空なら `null` を返して message ごと除外する。
- metadata に次を追加する。
  - `nightWorkersRuntimeContractStripped: true`
  - `nightWorkersRuntimeContractExecutionMode: "implementation"`
  - 可能なら `nightWorkersTaskId`
  - 可能なら `nightWorkersRunId`

`filterDistillableAgentLogMessages()` では、既存の excluded metadata / internal provider prompt / task log skip の意味を変えない。Runtime Contract sanitizer は chunk identity を保つため、`sync.service.ts` の chunk loop 内で `chunkMessages(sessionMessages)` の後に適用する。

### Rust

Rust resident path に同等 helper を追加する。

候補配置:

- `crates/context-stilld/src/domains/agent_log_sync/store.rs`
  - transcript 化直前に処理できるため、保存境界に近い。
- または `ingest.rs`
  - parse 時点で metadata を付与できる。

初期実装では `store.rs` 側を優先する。理由は、保存直前の content leak guard を TypeScript の `sync.service.ts` と同じ境界で持てるためである。Rust でも raw message で chunk を決め、chunk ごとに sanitized copy を作って transcript 化する。

候補 API:

```rust
fn sanitize_nightworkers_runtime_contract_message(message: &ChatMessage) -> Option<ChatMessage>;
fn sanitize_nightworkers_runtime_contract_chunk(chunk: &[ChatMessage]) -> Vec<ChatMessage>;
fn strip_nightworkers_runtime_contract(content: &str) -> Option<(String, String)>;
```

metadata は `serde_json::Value` に同じ key を追加する。

## 保存直前 Leak Guard

Sanitizer とは別に、保存直前で最終 guard を入れる。

TypeScript:

- SQLite path の `vibe_memories` insert 前。
- Postgres path の `tx.insert(vibeMemories)` 前。

Rust:

- `store_source_result()` の `insert into vibe_memories` 前。
- `vibe_memories_fts` insert 前。

Guard rules:

- targeted implementation Runtime Contract が `content` に残っている場合、保存しない。
- 初期実装の対象外 lane の marker はこの guard で新しく解釈しない。対象外 lane まで落とす必要が出た場合は、対象 lane の拡張として別途扱う。
- summary / warning に `nightWorkersRuntimeContractLeakSkipped` 相当の count を残すか、初期実装では warnings に短い文言を追加する。
- fail-fast ではなく skip にする。agent-log-sync 全体を止めると他の有用履歴を失うため。

## 変更対象

Primary files:

| File                                                         | 変更内容                                                                                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/agent-log-sync/sync.service.helpers.ts`         | NightWorkers Runtime Contract sanitizer、executionMode 判定、metadata 付与、message null 化、chunk sanitizer を追加する。              |
| `src/modules/agent-log-sync/sync.service.ts`                 | chunk loop 内で sanitizer を適用し、SQLite / Postgres 保存直前 leak guard を追加する。必要なら sync summary warning/count を追加する。 |
| `crates/context-stilld/src/domains/agent_log_sync/store.rs`  | Rust resident path の sanitizer と保存直前 leak guard を追加する。                                                                     |
| `crates/context-stilld/src/domains/agent_log_sync/ingest.rs` | store.rs だけで metadata 付与が不自然な場合に限り、Codex parse 時点の補助 metadata を追加する。                                        |

Test files:

| File                                                                    | 確認内容                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `test/agent-log-sync.service.test.ts`                                   | implementation Runtime Contract だけを剥がし、前半の実装依頼は保存対象に残ることを固定する。           |
| `test/agent-log-sync.service.test.ts`                                   | sanitizer が chunking 前に走らず、`dedupeKey` / `chunkIndex` の identity が保たれることを固定する。    |
| `test/agent-log-sync.test.ts` または `test/ingest-service-core.test.ts` | Codex JSONL parse から sync までの TypeScript path regression を追加する。                             |
| `crates/context-stilld/src/domains/agent_log_sync/service_tests.rs`     | Rust resident path で contract が content / FTS に残らず、履歴本文だけが保存されることを固定する。     |
| `crates/context-stilld/src/domains/agent_log_sync/store.rs` tests       | helper 単体で marker 前後、contract only、non-implementation lane、chunk/dedupe stability を固定する。 |

## 実装ステップ

### Step 0: 変更前ベースラインを採取する

1. live SQLite で既存の Runtime Contract 混入件数を確認する。
2. `sync_states` の `codex_logs` / `codex_logs_historical_backfill` cursor を確認し、検証対象の Codex JSONL が増分 sync 対象になるかを把握する。
3. 直近の NightWorkers implementation run 由来と思われる `vibe_memories` を 1-3 件だけ抽出し、保存されている content と metadata の形を記録する。
4. Rust resident agent-log-sync が有効か、TypeScript CLI path が使われているかを確認する。

Baseline queries:

```sql
select count(*) as runtime_contract_memories
from vibe_memories
where content like '%[NightWorkers Runtime Contract]%';
```

```sql
select id, last_synced_at, cursor
from sync_states
where id in ('codex_logs', 'codex_logs_historical_backfill');
```

Runtime ownership check:

```bash
bun run automation:context-stilld -- status
```

Acceptance:

- 変更前の marker 件数が分かっている。
- 検証後に「増えていない」ことを比較できる。
- 実際に動く agent-log-sync path が TypeScript / Rust のどちらか、または両方かを説明できる。

Failure handling:

- live DB path が解決できない場合は、実装へ進まず runtime ownership / config を先に確認する。
- baseline 件数が既に 0 であっても、fixture-based regression test は省略しない。

### Step 1: Fixture と判定 helper を固定する

1. NightWorkers implementation prompt の最小 fixture を追加する。
2. fixture には次を含める。
   - marker 前の実装依頼本文。
   - `[NightWorkers Runtime Contract]`。
   - `taskId`。
   - `runId`。
   - `repoRoot`。
   - `executionMode: implementation`。
   - Todo / MCP / verification rules の代表行。
3. non-implementation fixture を追加する。
   - `executionMode: planning`。
   - `executionMode: general_answer`。
4. TypeScript helper の unit test を先に落ちる形で追加する。
5. Rust helper の unit test を先に落ちる形で追加する。
6. chunk 前 sanitizer 禁止の fixture を追加する。
   - 1 chunk に収まらない長い Runtime Contract を含める。
   - sanitizer 後も raw chunkIndex 由来の dedupe key が変わらないことを期待値にする。

Acceptance:

- implementation fixture は marker 前だけ残る。
- contract-only fixture は保存対象から落ちる。
- non-implementation fixture は初期実装では変更されない。
- sanitizer は chunking 後に適用され、raw `chunkIndex` と `dedupeKey` を変えない。

Failure handling:

- marker 境界や executionMode 判定が fixture で曖昧なら、保存側の実装に進まず fixture を先に増やす。
- non-implementation lane が誤って strip される場合は、この計画のスコープ外変更として止める。

### Step 2: TypeScript sanitizer を実装する

1. `stripNightWorkersRuntimeContract(content)` を追加する。
2. marker 以降の block から `executionMode`、`taskId`、`runId` を抽出する。
3. `executionMode !== "implementation"` なら変更しない。
4. `sanitizeNightWorkersRuntimeContractChunk(chunk)` を追加する。
5. `sync.service.ts` の chunk loop で、raw chunk から sanitized chunk を作る。
6. `buildTranscript()`、`buildReadableTranscript()`、`extractUnifiedDiffsFromText()`、`extractAgentDiffsFromToolCalls()` は sanitized chunk を使う。
7. sanitizer 後に empty chunk になった場合は保存しない。
8. `dedupeKey` は raw chunk の `chunkIndex` で作り、sanitized content から再計算しない。
9. metadata 付与後も `isExcludedAgentLogMetadata()` が機能するよう、既存 key を維持する。

Acceptance:

- `syncAllAgentLogs` の imported count は、実装依頼本文が残る場合は 1 のまま。
- `vibe_memories.content` に `[NightWorkers Runtime Contract]` が入らない。
- metadata に strip 済みであることが残る。
- sanitizer によって chunking / dedupe key が変わらない。

Failure handling:

- imported count が 0 になる場合は、contract 前の実装依頼本文まで削っていないか確認する。
- dedupe key が fixture の期待値から変わる場合は、sanitizer の適用位置を chunk 前に戻していないか確認する。

### Step 3: TypeScript 保存直前 guard を追加する

1. SQLite path で `redactedContent` insert 前に marker 残存を確認する。
2. Postgres path で `redactedContent` insert 前に marker 残存を確認する。
3. targeted implementation Runtime Contract marker が残っている場合は該当 chunk を skip する。
4. warning/count は noisy にならない粒度にする。
5. skip count は source summary の warnings または metadata に残す。transaction 内外で count が失われないよう、ローカル変数で集計してから summary に反映する。

Acceptance:

- sanitizer 漏れがあっても `vibe_memories` には保存されない。
- agent-log-sync run 自体は他 chunk を処理し続ける。

Failure handling:

- guard が non-implementation lane まで skip する場合は、target predicate を implementation lane に戻す。
- skip count が transaction rollback で失われる場合は、transaction 外の local accumulator に移す。

### Step 4: Rust resident sanitizer を実装する

1. `store.rs` に TypeScript と同じ marker / executionMode 判定を追加する。
2. `chunk_messages` 後、`build_readable_transcript` 前に sanitizer を通す。
3. 空になった message は除外する。
4. `build_memory_metadata()` が strip metadata を集約できるようにする。
5. `insert into vibe_memories` 前に marker guard を追加する。
6. `vibe_memories_fts` には sanitized content だけを入れる。
7. finding candidate enqueue と episode enqueue は sanitized content / metadata を使う。

Acceptance:

- Rust resident path でも `vibe_memories.content` と `vibe_memories_fts.content` に marker が残らない。
- readable transcript の min char 判定は stripped content に対して行われる。
- raw chunkIndex 由来の `dedupeKey` は変わらない。
- existing Rust agent-log-sync tests は通る。

Failure handling:

- TypeScript と Rust の metadata key がズレる場合は、Rust 側の key を TypeScript に合わせる。
- `vibe_memories` は sanitized でも FTS に marker が残る場合は、FTS insert の content source を修正するまで完了扱いにしない。

### Step 5: 既存汚染データの診断だけを追加する

この計画の実装差分では既存 data mutation を行わない。ただし、運用手順として診断 query を docs または closeout に残す。

SQLite diagnostic:

```sql
select id, session_id, created_at
from vibe_memories
where content like '%[NightWorkers Runtime Contract]%'
order by created_at desc
limit 50;
```

FTS diagnostic:

```sql
select id
from vibe_memories_fts
where content match '"NightWorkers Runtime Contract"'
limit 50;
```

Episode / finding derivative の扱いは別 cleanup 計画で判断する。

Failure handling:

- 既存汚染データの削除や episode derivative cleanup が必要になった場合は、この実装差分に混ぜず、別 cleanup 計画として切り出す。

## 検証ゲート

Focused TypeScript:

```bash
bunx vitest run test/agent-log-sync.service.test.ts
```

Rust resident path:

```bash
cargo test -p context-stilld agent_log_sync
```

Rust daemon focused gate:

```bash
bun run verify:rust-daemon
```

Repo-wide closeout:

```bash
bun run verify
```

Live SQLite 確認:

```bash
sqlite3 "$CONTEXT_STILL_SQLITE_CORE_PATH" \
  "select count(*) from vibe_memories where content like '%[NightWorkers Runtime Contract]%';"
```

期待値:

- 新規 sync 後の増分では 0。
- 既存汚染がある場合は、変更前 baseline 件数から増えない。

## 完了条件

- implementation Runtime Contract は vibe memory content に保存されない。
- implementation task の依頼本文と作業履歴は保存される。
- contract-only message は保存されない。
- non-implementation lane の挙動は初期実装では変えない。
- TypeScript と Rust resident path の挙動が一致する。
- 保存直前 guard により、sanitizer 漏れが content / FTS に入らない。
- focused tests、Rust daemon gate、repo-wide verify が通る。
- live SQLite で marker 件数が増えていないことを確認する。

## 停止条件

- marker 前後の境界が曖昧で、実装依頼本文まで削る可能性がある。
- live resident runtime が TypeScript path ではなく Rust path を使っているのに、Rust 側対応が未完了である。
- `vibe_memories.content` は抑止できても `vibe_memories_fts` に marker が残る。
- sanitizer 後の metadata 付与で既存 dedupe key が変わり、同じ session/chunk が大量再取り込みされる。
- existing dirty data cleanup を同じ変更に混ぜる必要が出て、検証範囲が保存前 sanitizer から逸脱する。

## Rejected Alternatives

### NightWorkers project 全体を除外する

実装タスク履歴まで失われるため不採用。

### NightWorkers 側で Runtime Contract をログに残さない

監査、失敗解析、contract warning の証跡を失うため不採用。

### vibe memory 保存後の distillation 側で無視する

raw memory と FTS には既に混入してしまうため不採用。

### implementation 以外も一括 strip する

今回の要件は implementation task 履歴の保存であり、planning / review / general_answer の意味差を同時に変更すると影響範囲が広がるため不採用。
