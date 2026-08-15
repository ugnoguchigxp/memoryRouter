# FindCandidate Vibe Memory Filtered Input 実装計画

> アーカイブ日: 2026-08-15。実装コミット: `0e73ff9`。

## 背景

`agent-log-sync` は vibe memory を chunk に分割し、同じ chunk `vibe_memories.id` を `finding_candidate_queue` と `episode_distiller_queue` の両方へ enqueue している。これは Episode 側では長い作業ログを扱うための入力分割として意味があるが、`findCandidate` 側では chunk 単位の `no_candidate` が大量に発生し、候補抽出率を下げている。

この計画は、`findCandidate` から chunk 化と chunk 依存の要約・候補抽出を廃止し、代わりに deterministic な Context 圧縮入力を LLM に渡すための実装順序を定義する。

## 目的

- `findCandidate` から chunk 単位の候補抽出を削除する。
- `findCandidate` から chunk に依存した要約・まとめ・再構成ロジックを削除する。
- `agent-log-sync` の chunk 化は Episode 専用にする。
- `findCandidate` は vibe memory 全文ではなく、ロジックで不要部分を削った filtered input を読む。
- filtered input は LLM 要約ではなく、既存テキスト・tool call・diff・command の機械的な抽出、重複排除、上限制御だけで作る。

## 非目的

- EpisodeDistiller の chunk 化を削除しない。
- EpisodeDistiller の semantic chunk / segment generation を変更しない。
- `findCandidate` で semantic chunk、candidatelet、chunk merge を作り直さない。
- LLM による事前要約、意図推定、分類、編集概念生成を追加しない。
- raw JSON 全体を LLM に渡す方式へ戻さない。
- queue scheduler、provider pool、coverEvidence、finalizeDistille の設計変更を含めない。
- live DB の破壊的 requeue / reset をこの計画に含めない。

## 設計方針

### Task 1: findCandidate の chunk 依存廃止

`findCandidate` では chunk を入力単位にしない。

削除対象:

- `agent-log-sync` から `finding_candidate_queue` への chunk ごとの enqueue。
- Rust resident `agent_log_sync` から `finding_candidate_queue` への chunk ごとの enqueue。
- `src/modules/findCandidate/domain.ts` の vibe memory 用 semantic chunk planner。
- `find-candidate:semantic-chunk` と `find-candidate:chunk-generation` の LLM call。
- chunk 単位の `no_candidate` / `candidates_found` 判定。
- chunk 依存 metadata diagnostics。

残す対象:

- Episode 用の `vibe_memories` chunk 保存。
- Episode 用の `episode_distiller_queue` enqueue。
- wiki / web ingest の findCandidate 経路。
- `found_candidates` と `covering_evidence_queue` の既存 downstream mutation。

### Task 2: filtered input reader 追加

`findCandidate` は vibe memory 全文を直接読むのではなく、deterministic な filtered input を読む。

filtered input は「素材を薄くする」だけで、知識候補に近づける意味づけはしない。

含める情報:

- user / assistant の実メッセージ本文。ただし定型文と進捗だけの短文は削る。
- tool call の名前と、候補判断に必要な引数の短い抜粋。
- shell command のコマンド文字列。
- test / verify / build / lint など検証コマンド。
- error / failed / timeout / panic / assertion / TypeScript error などの短いエラー断片。
- `agent_diff_entries` の file path、change type、diff hunk。ただしサイズ上限と重複排除をかける。
- source 追跡用の `vibeMemoryId`、`sessionId`、`dedupeKey`、`source_key`。

生成しない情報:

- intent
- editedConcepts
- diffSummary
- area
- finalOutcome
- reusableSignals
- decisions
- task boundary
- semantic chunk

### Path の扱い

file path は候補本文の主材料にはしない。filtered input では、diff や tool call の出所として必要な場合だけ短く残す。

残す条件:

- path がないと同一 diff / tool call の区別ができない。
- path 自体が設定キー、DB path、queue/table 名など適用条件になる。
- source trace として必要。

削る条件:

- 絶対 path、workspace root、ユーザー名など、知識蒸留に不要な局所情報。
- 同じ file path の繰り返し。
- path がなくても command / diff / error の意味が変わらない場合。

## Filtered Input Schema

実装上の内部型は最小限にする。

```ts
type FilteredVibeMemoryForCandidate = {
  source: {
    vibeMemoryId: string;
    sessionId: string;
    sourceKey: string;
    sourceUri: string;
  };
  content: string;
  stats: {
    originalChars: number;
    filteredChars: number;
    droppedMessages: number;
    droppedToolOutputs: number;
    includedDiffHunks: number;
    truncatedDiffHunks: number;
  };
};
```

`content` は LLM にそのまま渡す text block とし、JSON schema を大きくしない。LLM の候補抽出は従来どおり `parseStorageCandidatesWithDiagnostics` の契約に従う。

## Filtering Rules

### Message filtering

残す:

- `USER:` の依頼、修正要求、停止条件、設計判断。
- `ASSISTANT:` の最終報告、エラー説明、検証結果、変更要約。
- `TOOL:` / tool output のうち、短い error、test failure、重要な command output。

削る:

- AGENTS / environment_context / initial_instructions の定型ブロック。
- 「確認します」「次に実行します」だけの進捗報告。
- 長い tool output 全体。
- 同一内容の繰り返し。
- secret / env / token に見える値。

### Tool call filtering

残す:

- `exec_command` の command。
- `apply_patch` の対象 file と hunk 先頭。
- `view_image` / `read_mcp_resource` など、判断に使った入力の識別子。

削る:

- stdout の巨大全文。
- `rg` の大量 hit 全体。
- package install / cache / build artifact の冗長ログ。

### Diff filtering

残す:

- `agent_diff_entries.file_path`
- `change_type`
- diff hunk の先頭と、`+` / `-` 行の代表部分。

削る:

- 同一 file path / hunk の重複。
- 巨大 diff の中間部。
- generated / lock / coverage / build output と判定できる diff。

## Implementation Order

### T0: Baseline

Goal:
変更前に、chunk 依存の実績と現在の呼び出し箇所を固定する。

Tasks:

- `finding_candidate_queue` の `source_kind='vibe_memory'` を chunkIndex 有無で集計する。
- `distillation_queue_events` の `findingCandidate` completed / no candidate を確認する。
- `src/modules/findCandidate/domain.ts` の chunk 関連関数を列挙する。
- `agent-log-sync` TypeScript / Rust の finding enqueue 箇所を列挙する。

Verification:

```bash
sqlite3 -header -column data/context-still-core.sqlite \
  "select json_type(metadata,'$.chunkIndex') as has_chunk_index, status, last_outcome_kind, count(*) from finding_candidate_queue where source_kind='vibe_memory' group by 1,2,3 order by 1,2,3;"

rg -n "find-candidate:semantic-chunk|find-candidate:chunk-generation|runChunkedVibeMemoryFindCandidate|buildCandidateSemanticChunkMessages|enqueue_finding_candidate|finding_candidate_queue" src/modules/findCandidate src/modules/agent-log-sync crates/context-stilld/src/domains/agent_log_sync test
```

Completion criteria:

- 削除対象の呼び出し箇所が確定している。
- chunkIndex 付き job の現状を記録できている。

### T1: agent-log-sync から finding enqueue を外す

Goal:
新規 agent log chunk が `finding_candidate_queue` に入らないようにする。

Tasks:

- `src/modules/agent-log-sync/sync.service.ts` で `findingCandidateQueue` insert を削除または無効化する。
- 同じファイルの `enqueuedFindingJobs` 集計と sync result metadata を整理する。
- `crates/context-stilld/src/domains/agent_log_sync/store.rs` で `enqueue_finding_candidate` 呼び出しを削除する。
- 未使用になった Rust helper は削除する。
- Episode 用 `enqueue_episode_distiller` は維持する。

Verification:

```bash
bunx vitest run test/agent-log-sync.test.ts
cargo test -p context-stilld agent_log_sync
rg -n "enqueue_finding_candidate|finding candidate enqueued from Rust agent log sync|finding candidate enqueued from agent log sync" src/modules/agent-log-sync crates/context-stilld/src/domains/agent_log_sync test
```

Completion criteria:

- agent-log-sync は vibe memory chunk と Episode job だけを作る。
- 新規 chunk から finding job が作られない。
- 既存 pending finding job の扱いはこのタスクでは変更しない。

Stop conditions:

- sync result API が `enqueuedFindingJobs` を外すと UI / API 契約を壊す場合は、0 件として残す形にする。

### T2: findCandidate の chunk pipeline を削除する

Goal:
`findCandidate` の vibe memory 経路から semantic chunk / chunk generation を完全に外す。

Tasks:

- `src/modules/findCandidate/domain.ts` から以下を削除する。
  - `buildCandidateSemanticChunkMessages`
  - `buildCandidateGenerationMessages`
  - `createFindCandidateSemanticChunks`
  - `runChunkedVibeMemoryFindCandidate`
  - chunk pipeline metadata 分岐
- `internalChunkedDistillationEnabled` による findCandidate 分岐を削除する。
- `find-candidate:semantic-chunk` / `find-candidate:chunk-generation` usageSource を findCandidate から消す。
- `test/find-candidate.test.ts` の chunked findCandidate tests を削除または新方針の tests に置き換える。

Verification:

```bash
bunx vitest run test/find-candidate.test.ts
rg -n "find-candidate:semantic-chunk|find-candidate:chunk-generation|findCandidate chunk planner|runChunkedVibeMemoryFindCandidate|candidatelet" src/modules/findCandidate test/find-candidate.test.ts
```

Completion criteria:

- `findCandidate` は chunk planner を呼ばない。
- chunk 単位の candidate generation が存在しない。
- `internalChunkedDistillationEnabled` は Episode 側だけに残る。

### T3: deterministic filtered input reader を追加する

Goal:
vibe memory 全文の代わりに、ロジックだけで不要部分を削った filtered input を `findCandidate` に渡す。

Tasks:

- 新規 module を追加する。
  - `src/modules/findCandidate/vibe-memory-filter.ts`
- SQLite / Postgres の両方で既存の `readVibeMemoryByTokenWindow` が読む前の材料にアクセスできるか確認する。
- 最初の実装は `vibe_memories.content` と `agent_diff_entries` を入力にする。
- message filtering / tool call filtering / diff filtering を deterministic に実装する。
- filter stats を返す。
- token window は filter 後 content に対して適用する。
- LLM 用 prompt には「これは filtered transcript であり、source にない意味づけを補完しない」と明記する。

Verification:

```bash
bunx vitest run test/find-candidate.test.ts
bunx vitest run test/sqlite-runtime-support.bun.ts -t "vibe memory"
```

Completion criteria:

- AGENTS / environment_context / initial_instructions の定型ブロックが削られる。
- command / error / diff hunk は上限付きで残る。
- LLM 事前要約や意味推定を行っていない。
- filter stats が audit payload または parse diagnostics で確認できる。

Stop conditions:

- `vibe_memories.content` に tool call / diff の十分な素材がなく、`agent_diff_entries` だけでも編集情報が追えない場合は、素材不足を報告して filter 仕様を広げる前に停止する。

### T4: findCandidate vibe memory path を filtered input に差し替える

Goal:
`memory_reader` が raw / compressed 全文 window ではなく filtered content window を返すようにする。

Tasks:

- `runFindCandidate` の vibe memory 初回 read で filtered reader を使う。
- 追加 window が必要な場合も filtered content の token range を読む。
- `memoryReaderMode` は findCandidate vibe path では廃止または無視し、filtered mode に固定する。
- `readRanges` は filtered content token range として保存する。
- source trace には元 `vibeMemoryId` を残す。
- no_candidate diagnostics に filter stats を含める。

Verification:

```bash
bunx vitest run test/find-candidate.test.ts
```

Completion criteria:

- vibe memory findCandidate は filtered input を LLM に渡す。
- raw JSON / raw transcript 全文を直接渡さない。
- existing wiki / web ingest path は変わらない。

### T5: runtime and diagnostics cleanup

Goal:
運用上、Finding 側が chunk 廃止済みであることを確認できるようにする。

Tasks:

- doctor / queue inspector に必要なら、`findingCandidate` の agent-log chunk enqueue 廃止を反映する。
- 古い `internal-chunked-distillation-implementation-plan.md` の findCandidate 部分が superseded であることを README か新計画に明記する。
- live DB の既存 chunk finding jobs は自動削除しない。必要なら別計画で archive / skip 方針を決める。

Verification:

```bash
bun run docs:check-links
bun run verify:rust-daemon
bun run verify
```

Completion criteria:

- docs link check が通る。
- Rust daemon focused verification が通る。
- repo-wide verification が通る。

## Tests To Update

- `test/find-candidate.test.ts`
  - chunked findCandidate tests を削除する。
  - filtered input が定型文を削り、command / diff / error を残すことを追加する。
  - no_candidate diagnostics に filter stats が出ることを追加する。
- `test/agent-log-sync.test.ts`
  - chunkMessages は Episode 用 helper として残す。
  - sync が finding job を作らないことを追加する。
- `test/sqlite-runtime-support.bun.ts`
  - Episode chunk tests は維持する。
  - queue priority tests が finding chunk enqueue 前提なら更新する。
- `crates/context-stilld`
  - Rust agent log sync が finding job を作らないことを確認する。

## Data Migration Policy

この計画では live DB の既存 rows を変更しない。

- 既存 `finding_candidate_queue` の chunkIndex 付き pending / skipped rows はそのまま残す。
- 新規 enqueue を止めることを優先する。
- 既存 rows の archive / skip / delete は、運用判断を伴うため別タスクにする。

## Stop Conditions

- filtered input が raw transcript とほぼ同じ長さになり、トークン節約できない。
- filtered input から command / diff / error が消え、知識蒸留の材料が不足する。
- findCandidate から chunk usageSource が消えない。
- EpisodeDistiller の chunk tests が壊れる。
- Rust resident と TypeScript sync の挙動がずれる。
- `source_missing` と `no_candidate` の診断が再び混ざる。

## Final Verification Gate

最終的に以下を満たすまで完了にしない。

```bash
rg -n "find-candidate:semantic-chunk|find-candidate:chunk-generation|findCandidate chunk planner|runChunkedVibeMemoryFindCandidate" src test

bunx vitest run test/find-candidate.test.ts test/agent-log-sync.test.ts
cargo test -p context-stilld agent_log_sync
bun run docs:check-links
bun run verify:rust-daemon
bun run verify
```

Expected:

- `rg` は findCandidate 側の chunk pipeline を返さない。
- agent-log-sync は Episode job だけを enqueue する。
- findCandidate vibe memory path は filtered input を使う。
- EpisodeDistiller の chunk behavior は維持される。
