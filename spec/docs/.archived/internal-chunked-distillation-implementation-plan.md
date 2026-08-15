# Internal Chunked Distillation 実装計画

> アーカイブ日: 2026-08-15。実装コミット: `511965e`。findCandidate 部分は後に `0e73ff9` で置換済み。

## 背景

`findCandidate` と `episodeDistiller` は、長い vibe memory / agent log を処理するときに LLM の一発読みまたは LLM の自律 reader 判断へ寄りすぎると、局所的な失敗、判断の揺れ、negative knowledge、後続 compile に効く小さい観察を落としやすい。

一方で、chunk 化や merge のために独立 queue を増やすと、queue 完了条件、provider lease、retry、UI 表示、運用診断が複雑になる。今回の目的は queue family を増やすことではなく、既存 queue job の内部処理を扱いやすい単位へ分け、軽量 LLM でも安定して蒸留できる形にすることである。

この計画は、`findingCandidate` と `episodeDistiller` の既存 queue 境界を維持したまま、job 内部に `global pass` / `semantic chunk pass` / `chunk-local generation pass` / `bridge pass` / `merge pass` を導入するための実装順序、完了条件、検証ゲート、停止条件を定義する。

## 目的

- `findingCandidate` / `episodeDistiller` の queue 境界を増やさず、job 内部の段階処理として chunk / bridge / merge を実装する。
- 長大ログの局所 recall を上げ、`no_candidate` / `no_episode` の誤判定を減らす。
- semantic chunk 作成と chunk-local 生成を、安価な Local LLM でも対応できる粒度に寄せ、全体の蒸留速度を上げる。
- bridge / merge だけを必要に応じてより強いモデルへ回し、品質と待ち時間のバランスを取る。
- `findCandidate` と `episodeDistiller` の処理を混ぜず、それぞれの成果物と保存先を明確に分ける。
- merge 後も `1 source = 1 EpisodeCard` にしない。再利用可能な episode 単位ごとに複数 EpisodeCard を作れる状態を維持する。

## 非目的

- chunk / bridge / merge 用の新しい queue を作らない。
- `findCandidate` に EpisodeCard 作成責務を戻さない。
- `episodeDistiller` から Knowledge candidate / found candidate を作らない。
- `episodelet` や `candidatelet` を validation / dedupe / bridge audit なしに正式成果物として公開しない。
- `episodeDistiller` の merge で 1 source 全体を 1 つの EpisodeCard に圧縮しない。
- provider pool / queue scheduler の優先順位設計をこの計画で広げない。
- live DB 全体の破壊的 requeue / reset をこの計画に含めない。

## 基本方針

### Initial Implementation Slice

最初の実装 PR は TypeScript manual fallback path に限定する。

含める:

- feature flag の追加。
- bounded source window 作成。
- semantic chunk schema / validation。
- `episodeDistiller` の semantic chunking と chunk-local generation。
- `findCandidate` の semantic chunking と chunk-local generation。
- merge 前 validation / dedupe / metadata diagnostics。
- 既存 queue row 内の checkpoint 更新。
- 対象 unit / sqlite runtime tests。

含めない:

- 新 queue。
- resident Rust executor parity。
- UI 表示変更。
- live DB requeue / reset。
- provider pool scheduler の再設計。

この slice が通った後で、Rust resident path と queue inspect / UI 表示を別 PR として扱う。

### Queue 境界

既存 queue は維持する。

| Queue | 内部で追加する処理 | 保存する正式成果物 |
|---|---|---|
| `findingCandidate` | `candidate_global` / `candidate_semantic_chunk` / `candidate_generation` / `candidate_bridge` / `candidate_merge` | `found_candidates` と downstream `covering_evidence_queue` |
| `episodeDistiller` | `episode_global` / `episode_semantic_chunk` / `episode_generation` / `episode_bridge` / `episode_merge` | `episode_cards` と `episode_refs` |

chunk / bridge / merge は queue row の `metadata` に checkpoint と diagnostics を残すだけで、独立した runnable row にはしない。

### Episode と findCandidate を混ぜない

`episodeDistiller` は過去作業の文脈・判断・失敗・教訓を EpisodeCard として残す。

`findCandidate` は再利用可能な rule / procedure の候補を探す。negative knowledge は `polarity=negative` の rule 候補として扱い、EpisodeCard の `failure_episode` とは別物として保存する。

同じ source document / chunking helper を共有してもよいが、prompt、intermediate schema、merge logic、保存先は分ける。

### Merge の意味

merge は「全部を 1 枚にする」処理ではない。

merge は次を行う。

- 重複した episodelet / candidatelet をまとめる。
- chunk をまたぐ因果関係を復元する。
- 局所的な観察に global context を足して誤読を減らす。
- 低価値・根拠不足・一回限りの断片を落とす。
- 保存単位を `reusable episode` または `reusable knowledge candidate` として整える。

`episodeDistiller` の merge 後出力は複数 EpisodeCard になり得る。`findCandidate` の merge 後出力も複数 found candidate になり得る。

## Intermediate Schema

### SemanticChunk

安価な Local LLM は、source 全体を直接読むのではなく、runtime が作る bounded source window を入力として semantic chunk を作る。

```ts
type SemanticChunk = {
  chunkIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  eventIds: string[];
  taskBoundaryKind:
    | "request_to_result"
    | "investigation"
    | "implementation"
    | "verification"
    | "failure_resolution"
    | "decision_turn"
    | "misc";
  title: string;
  boundaryReason: string;
  expectedOutputs: Array<"episode" | "candidate" | "both" | "none">;
  openBoundary: boolean;
};
```

Rules:

- semantic chunk 作成は安価な Local LLM の担当に含める。
- runtime は Local LLM に無制限長を渡さないための bounded source window だけを作る。
- chunk boundary は「最初の依頼から一つの結果まで」を優先するが、長すぎる場合は investigation / implementation / verification / failure_resolution などへ分ける。
- `request_to_result` は最優先だが、source window をまたいだ場合は `openBoundary=true` にして bridge へ渡す。
- `openBoundary=true` は、次の window / chunk へ因果が続く可能性を示す。bridge pass はこれを優先的に見る。
- source span と event ids は必須。Local LLM が boundary を提案しても、保存前に runtime が byte range を検証する。
- semantic chunk は window 内 byte range を完全に覆う必要はない。低価値範囲は `expectedOutputs=["none"]` として残す。

### Episodelet

`episodeDistiller` の chunk-local generation は、semantic chunk ごとに EpisodeCard 保存候補として `episodelet` を返す。

```ts
type Episodelet = {
  chunkIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  eventIds: string[];
  title: string;
  situation: string;
  localObservation: string;
  decisionOrFailure: string;
  actionTaken: string;
  outcomeAtChunk: string;
  possibleLesson: string;
  openLoops: string[];
  generationKind: "task_episode" | "failure_episode" | "decision_episode";
  outcomeKind: "success" | "failure" | "mixed" | "unknown";
  domains: string[];
  technologies: string[];
  changeTypes: string[];
  tools: string[];
  scores: {
    importance: number;
    confidence: number;
    reusability: number;
    failure_value: number;
    causal_clarity: number;
    evidence_quality: number;
  };
};
```

Rules:

- `episodelet` は chunk-local の EpisodeCard 保存候補である。
- validation / dedupe / bridge audit を通るまでは永続化しない。
- source span と event ids を必ず持つ。
- chunk 内で完結しない因果は `openLoops` に残し、断定しない。
- confidence は chunk 単独根拠なら低めに抑える。

### Candidatelet

`findCandidate` の chunk-local generation は、semantic chunk ごとに found candidate 保存候補として `candidatelet` を返す。

```ts
type Candidatelet = {
  chunkIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  type: "rule" | "procedure";
  polarity: "positive" | "negative";
  title: string;
  contentDraft: string;
  reusableSignal: string;
  evidenceSummary: string;
  appliesTo: {
    technologies: string[];
    domains: string[];
    changeTypes: string[];
  };
  confidence: number;
  mergeKeyHint: string;
  rejectIfOnlyLocalProgress: boolean;
};
```

Rules:

- `candidatelet` は chunk-local の found candidate 保存候補である。
- validation / dedupe / bridge audit を通るまでは `found_candidates` へ永続化しない。
- negative は procedure にしない。merge 前から `polarity=negative` rule として扱う。
- `procedure` は merge 後に `Use when:` / `Workflow:` / `Verification:` / `Avoid:` を満たせるものだけ残す。
- parser reject と本当の `[]` を diagnostics で分ける。

## Pass Design

### 0. Bounded source window

目的:

- Local LLM に渡す入力を、安価なモデルでも安定して扱える長さに制限する。
- semantic chunk boundary は LLM に作らせるが、source span identity は runtime が守る。

入力:

- normalized source document。
- event ids / byte offsets / created_at / file_path。

出力:

```ts
type BoundedSourceWindow = {
  windowIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  eventIds: string[];
  text: string;
  previousOpenBoundarySummary?: string;
};
```

Rules:

- default は 8K から 16K tokens 相当。
- max は 32K tokens 相当。
- byte range と event ids は runtime が生成し、LLM output からは採用しない。
- semantic chunk が window 外を指した場合は reject し、同じ window を再分割または deterministic fallback する。

### 1. Global pass

目的:

- source 全体の粗い地図を作る。
- main phases、最終状態、方針転換、明らかな失敗領域、重要な file/tool/domain を抽出する。
- semantic chunk pass と chunk-local generation pass の prompt に短い global hint として渡す。

入力:

- source metadata。
- event headers。
- bounded excerpt。
- global pass が生成した compressed summary。生成できなかった場合は空として扱い、semantic chunk pass を止めない。

出力:

```ts
type DistillationGlobalMap = {
  sourceKind: "vibe_memory";
  sourceKey: string;
  sessionId?: string;
  project?: string;
  cwd?: string;
  phases: Array<{
    label: string;
    eventStart?: string;
    eventEnd?: string;
    summary: string;
  }>;
  likelyFailureZones: string[];
  likelyDecisionZones: string[];
  finalState: string;
  routingHints: {
    technologies: string[];
    domains: string[];
    changeTypes: string[];
    tools: string[];
  };
};
```

軽量 LLM 方針:

- global pass は安価なモデルでよいが、長すぎる source を全部渡さない。
- event headers と short excerpts だけで粗く作る。
- global pass が失敗しても semantic chunk pass は続行できる。

### 2. Semantic chunk pass

目的:

- runtime が作る bounded source window から、安価な Local LLM が semantic chunk boundary を提案する。
- 「依頼から一つの結果まで」を優先しつつ、長すぎる場合は investigation / implementation / verification / failure_resolution などに分ける。
- 安価な Local LLM が扱える粒度へ、source を task-aware に落とし込む。

入力:

- global map。
- bounded source window。
- event headers。
- previous window の open boundary summary。

出力:

- `SemanticChunk[]`。

Rules:

- semantic chunk pass は安価な Local LLM の担当にする。
- runtime の固定長 window は safety boundary であり、semantic chunk そのものではない。
- semantic chunk の byte range は runtime が検証し、window 外を指す output は reject する。
- 1 semantic chunk が大きすぎる場合は、runtime が再分割依頼を出す。
- parse failure が 2 回続く場合、その window は deterministic fallback chunk 1 件として処理し、metadata に `semanticChunkFallback=true` を残す。

### 3. Chunk-local generation pass

目的:

- semantic chunk ごとに保存候補レベルの EpisodeCard / candidate を作る。
- 安価な Local LLM の主担当領域にする。
- Episode と Candidate で別 schema / 別 prompt を使う。

Episode chunk-local generation:

- `episodelet[]` を返す。
- 原則 1 semantic chunk から 0 から 2 件。
- 低品質でも即捨てず、明確な reject reason を metadata に残す。

Candidate chunk-local generation:

- `candidatelet[]` を返す。
- source に再利用 signal がない場合のみ `[]`。
- progress chat でも、原因・修正・検証・継続 preference がある場合は候補化する。

### 4. Bridge pass

目的:

- chunk 間の因果関係を復元する。
- 前半の判断が後半で問題化したケースを拾う。
- 未解決から解決への流れ、方針転換、negative knowledge の条件を確定する。

入力:

- global map。
- 隣接 chunk の episodelets / candidatelets。
- mergeKeyHint が近い非隣接 let。
- 必要最小限の source snippets。

出力:

```ts
type BridgeFinding = {
  kind: "causal_link" | "decision_reversal" | "failure_resolution" | "negative_condition" | "duplicate_group";
  relatedChunkIndexes: number[];
  relatedLetIndexes: number[];
  finding: string;
  mergeInstruction: string;
  confidence: number;
};
```

軽量 LLM 方針:

- 初回 PR では deterministic bridge を基本にする。
- LLM bridge は feature flag 下の follow-up とし、全件には使わない。
- trigger は `openLoops`、同じ mergeKeyHint、failure と later success の組み合わせ、negative candidatelet の存在に限定する。

### 5. Merge pass

目的:

- 正式保存前の最終整形と dedupe。
- Episode は複数 EpisodeCard 単位へまとめる。
- Candidate は複数 found candidate 単位へまとめる。

Episode merge:

- `episodelet + bridge finding` から `EpisodeDistillerCanonical[]` を作る。
- 1 source 全体を 1 枚にしない。
- source span は union ではなく、代表 span + supporting spans を metadata に残す。
- `sourceFragmentKey` は final EpisodeCard 単位で deterministic に作る。
- value review は merge 後 canonical に対して行う。

Candidate merge:

- `candidatelet + bridge finding` から `CandidateRecord[]` を作る。
- duplicate rule を merge する。
- negative procedure を rule に落とすか reject する。
- procedure shape は merge 後に構造検証する。
- `no_candidate` は semantic chunk / chunk-local generation / merge pass のすべてを通って候補がない場合だけにする。

## Metadata Contract

### `episode_distiller_queue.metadata.episodeDistiller`

追加する内部 checkpoint:

```json
{
  "pipelineVersion": "internal-chunked-v1",
  "global": {
    "status": "completed",
    "phaseCount": 4,
    "failed": false
  },
  "sourceWindows": {
    "windowCount": 6,
    "completedWindowIndexes": [0, 1, 2],
    "fallbackWindowIndexes": []
  },
  "chunks": {
    "chunkCount": 12,
    "completedChunkIndexes": [0, 1, 2],
    "failedChunkIndexes": [],
    "episodeletCount": 8,
    "rejectedEpisodeletCount": 3
  },
  "bridge": {
    "status": "completed",
    "bridgeFindingCount": 4,
    "skippedReason": null
  },
  "merge": {
    "status": "completed",
    "acceptedEpisodeCount": 5,
    "valueSkipped": 2,
    "duplicateSkipped": 1
  },
  "episodeIds": ["episode-id"],
  "diagnostics": {
    "semanticChunkModel": "local-llm",
    "chunkGenerationModel": "local-llm",
    "bridgeModel": "local-llm",
    "fallbackUsed": false
  }
}
```

Rules:

- checkpoint は queue row metadata に残す。
- raw source text や巨大 LLM output は保存しない。
- parse failure は chunk index と短い error summary だけ保存する。
- completed 扱いは、保存対象 EpisodeCard が実在し `episodeIds` に入った後に限る。

### `finding_candidate_queue.metadata.findCandidate`

追加する内部 checkpoint:

```json
{
  "pipelineVersion": "internal-chunked-v1",
  "global": {
    "status": "completed",
    "failed": false
  },
  "sourceWindows": {
    "windowCount": 6,
    "completedWindowIndexes": [0, 1, 2],
    "fallbackWindowIndexes": []
  },
  "chunks": {
    "chunkCount": 12,
    "completedChunkIndexes": [0, 1, 2],
    "candidateletCount": 6,
    "rejectedCandidateletCount": 2
  },
  "bridge": {
    "status": "completed",
    "bridgeFindingCount": 2,
    "skippedReason": null
  },
  "merge": {
    "status": "completed",
    "acceptedCandidateCount": 3,
    "dedupedCandidateletCount": 3,
    "rejectedInvalidProcedureCount": 1
  },
  "diagnostics": {
    "semanticChunkModel": "local-llm",
    "chunkGenerationModel": "local-llm",
    "bridgeModel": "local-llm",
    "rawEmptyArrayChunkCount": 4,
    "parserRejectedChunkCount": 1
  }
}
```

Rules:

- found candidate / covering queue enqueue が完了するまで queue completed にしない。
- `no_candidate` は merge 後に `acceptedCandidateCount=0` の場合だけ使う。
- parser reject と true empty を分ける。

## 変更対象

Primary files:

| File | 変更内容 |
|---|---|
| `src/config.ts` | `CONTEXT_STILL_INTERNAL_CHUNKED_DISTILLATION` を feature flag として読む。default は off。 |
| `src/modules/distillation/source-window.ts` | 安価な Local LLM に渡す bounded source window と event header を作る。semantic chunk 自体は LLM output として作る。 |
| `src/modules/episodeDistiller/worker.ts` | segment 直 canonical 生成を `semantic chunk -> episodelet -> bridge -> merge -> canonical` に分ける。 |
| `src/modules/episodeDistiller/schema.ts` | `SemanticChunk`、`Episodelet`、`BridgeFinding`、merge 後 canonical validation を追加する。 |
| `src/modules/findCandidate/domain.ts` | feature flag 有効時の vibe memory / long source path に chunked candidatelet pipeline を追加する。 |
| `src/modules/findCandidate/parser.ts` | chunk output diagnostics と final candidate validation を分ける。 |
| `src/modules/queue/core/worker.ts` | completion metadata と `no_candidate` / `no_episode` diagnostics の受け渡しを最小限追加する。 |
| `crates/context-stilld/src/domains/queue_lifecycle/*` | 初回 PR では変更しない。TS path が通った後の parity PR で同じ contract を実装する。 |

Test files:

| File | 確認内容 |
|---|---|
| `test/sqlite-runtime-support.bun.ts` | `episodeDistiller` の source window / semantic chunk / generation / bridge / merge metadata、複数 EpisodeCard、低価値 skip、重複 skip を確認する。 |
| `test/queue-worker.test.ts` | `findingCandidate` の accepted candidate / no_candidate / parser reject diagnostics と covering enqueue を確認する。 |
| `test/find-candidate.test.ts` | semantic chunking、candidatelet merge、negative rule、invalid procedure reject を確認する。 |
| `crates/context-stilld/src/domains/queue_lifecycle/*_tests.rs` | 初回 PR では対象外。Rust parity PR で同じ checkpoint / completion semantics を確認する。 |

## New Module Contracts

初回 PR で追加する TypeScript exports:

```ts
// src/modules/distillation/source-window.ts
export type BoundedSourceWindow = {
  windowIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  eventIds: string[];
  text: string;
  previousOpenBoundarySummary?: string;
};
export type SemanticChunk = {
  chunkIndex: number;
  sourceStartOffset: number;
  sourceEndOffset: number;
  eventIds: string[];
  taskBoundaryKind:
    | "request_to_result"
    | "investigation"
    | "implementation"
    | "verification"
    | "failure_resolution"
    | "decision_turn"
    | "misc";
  title: string;
  boundaryReason: string;
  expectedOutputs: Array<"episode" | "candidate" | "both" | "none">;
  openBoundary: boolean;
};
export function buildBoundedSourceWindows(input: {
  content: string;
  events: Array<{ id: string; startOffset: number; endOffset: number; createdAt: string; filePath?: string | null }>;
  maxTokens?: number;
}): BoundedSourceWindow[];
export function validateSemanticChunks(input: {
  windows: BoundedSourceWindow[];
  chunks: unknown;
}): SemanticChunk[];
```

```ts
// src/modules/episodeDistiller/schema.ts
export const episodeSemanticChunkArraySchema: z.ZodType<SemanticChunk[]>;
export const episodeletArraySchema: z.ZodType<Episodelet[]>;
export function episodeletsToCanonicalCandidates(input: {
  chunks: SemanticChunk[];
  episodelets: Episodelet[];
  bridgeFindings: BridgeFinding[];
}): EpisodeDistillerCanonical[];
```

```ts
// src/modules/findCandidate/parser.ts or src/modules/findCandidate/chunk-schema.ts
export const candidateletArraySchema: z.ZodType<Candidatelet[]>;
export function candidateletsToCandidateRecords(input: {
  chunks: SemanticChunk[];
  candidatelets: Candidatelet[];
  bridgeFindings: BridgeFinding[];
}): CandidateRecord[];
```

Rules:

- module contracts are allowed to evolve during implementation, but the first PR must expose equivalent boundaries.
- raw LLM output is parsed into these schemas before queue metadata or downstream mutation is updated.
- schema parse errors are recorded as bounded diagnostics, not raw output blobs.

## 実装順序

### Phase 0: Baseline

実装前に現状を固定する。

Tasks:

- 現行 `episodeDistiller` の representative fixture を確認する。
- 現行 `findCandidate` の long vibe memory fixture / no_candidate fixture を確認する。
- queue 境界が `findingCandidate` と `episodeDistiller` のままであることを確認する。

Verification:

```bash
bunx vitest run test/sqlite-runtime-support.bun.ts test/queue-worker.test.ts
```

Completion criteria:

- 現状の失敗 / skip / completion metadata を説明できる。
- 新 queue が不要であることを確認済み。

Stop conditions:

- resident Rust executor と TS fallback のどちらが実処理 owner か不明な場合は、実装前に runtime truth を確認する。

### Phase 1: Source windowing and semantic chunking

Episode と Candidate が同じ bounded source window を読めるようにする。ただし semantic chunk 作成は安価な Local LLM のタスクにし、成果物 schema は共有しない。

Tasks:

- `EpisodeSourceDocument` 相当の document/event model を reusable helper へ切り出す。
- runtime は bounded source window を作る。
  - default: 8K から 16K tokens 相当。
  - max: 32K tokens 相当。
- 安価な Local LLM に semantic chunk plan を作らせる。
- semantic chunk は byte range、event ids、taskBoundaryKind、boundaryReason、openBoundary を持つ。
- semantic chunk id は source span + taskBoundaryKind + pipelineVersion から deterministic に作る。
- window 外 byte range、空 range、過大 range は validation で reject する。

Completion criteria:

- runtime windowing は source span identity を壊さない。
- 安価な Local LLM が `SemanticChunk[]` を返せる。
- `episodeDistiller` と `findCandidate` は同じ semantic chunk plan を使えるが、Episode / Candidate schema には依存しない。

Verification:

```bash
bunx vitest run test/sqlite-runtime-support.bun.ts
```

Stop conditions:

- source span identity が不安定になる場合は、semantic chunking を止め、Episode 側の既存 reader contract を先に固定する。

### Phase 2: Episode internal pipeline

`episodeDistiller` を `episodelet -> bridge -> merge -> EpisodeCard` にする。

Tasks:

- `Episodelet` schema を追加する。
- semantic chunk pass prompt を追加する。
- chunk-local generation prompt を Episodelet 用に変更する。
- bridge pass を追加する。
  - trigger: `openLoops`、failure later success、decision reversal、duplicate merge hint。
- merge pass で `EpisodeDistillerCanonical[]` を生成する。
- value review は merge 後 canonical に対して実行する。
- `episode_cards` 保存は merge 後の accepted canonical に限定する。
- metadata に global/chunk/bridge/merge checkpoint を残す。

Completion criteria:

- 1 source から複数 EpisodeCard が作れる。
- 安価な Local LLM が semantic chunk と chunk-local EpisodeCard 保存候補を作る。
- chunk episodelet は validation / dedupe / bridge audit なしでは直接 EpisodeCard にならない。
- semantic chunk をまたぐ失敗から解決への流れが 1 つの EpisodeCard として保存される。
- unrelated episode は別 EpisodeCard のまま保存される。

Verification:

```bash
bunx vitest run test/sqlite-runtime-support.bun.ts
```

Stop conditions:

- merge が source 全体を 1 枚に潰す場合は停止する。
- completed queue row に実在しない EpisodeCard id が入る場合は停止する。

### Phase 3: findCandidate internal pipeline

`findCandidate` の long source / vibe memory path を `candidatelet -> bridge -> merge -> CandidateRecord` にする。

Tasks:

- `Candidatelet` schema を追加する。
- semantic chunk pass prompt を追加する。
- chunk-local generation prompt を candidatelet 用に追加する。
- negative candidate は chunk-local generation から `polarity=negative` rule として扱う。
- bridge pass で条件付き negative knowledge、方針転換、重複候補を復元する。
- merge pass で `CandidateRecord[]` へ変換する。
- procedure は merge 後に SKILL-like structure を検証する。
- `no_candidate` は final accepted candidate が 0 件のときだけ返す。
- parser reject diagnostics を queue metadata / audit に残す。

Completion criteria:

- progress chat 由来でも原因・修正・検証・継続 preference がある場合は candidate として残る。
- parser reject と true empty が区別できる。
- candidate がある場合は `found_candidates` と `covering_evidence_queue` の downstream mutation が確認されてから completed になる。

Verification:

```bash
bunx vitest run test/queue-worker.test.ts
bunx vitest run test/find-candidate.test.ts
```

Stop conditions:

- EpisodeCard 由来の prompt/schema が findCandidate に混入する場合は停止する。
- negative procedure が保存される場合は停止する。

### Phase 4: Lightweight LLM routing

semantic chunking と chunk-local generation を軽量 LLM に寄せ、bridge / merge は必要時だけ強いモデルへ逃がせるようにする。

Tasks:

- `taskRouting.findingCandidate` / `taskRouting.episodeDistiller` の中で stage hint を扱う。
- 初期実装は queue route を増やさず、runtime request metadata に `stage: semantic_chunk|chunk_generation|bridge|merge` を渡す。
- semantic chunking と chunk-local generation は安価な Local LLM target を優先する。
- bridge / merge は trigger がある場合だけ、設定された bridge/merge target を使う。未設定なら chunk-local generation と同じ route を使う。
- preferred target が busy の場合は既存 provider lease policy に従って待つ。意図しない fallback へ流さない。

Completion criteria:

- semantic chunking の request は stage diagnostics に `semanticChunkModel` として残る。
- chunk-local generation の request は stage diagnostics に `chunkGenerationModel` として残る。
- bridge / merge の request は stage diagnostics に `bridgeModel` / `mergeModel` として残る。
- route fallback で意図しない model へ流れた場合に診断できる。

Verification:

```bash
bunx vitest run test/queue-provider-pool-scheduler.test.ts test/queue-worker.test.ts
```

Stop conditions:

- stage routing のために新 queue / 新 scheduler family が必要になる場合は停止する。
- preferred target 待ちの既存仕様を壊す場合は停止する。

### Phase 5: Rust resident parity

resident Rust executor が実処理 owner の場合、TS fallback と同じ internal pipeline semantics にする。

Tasks:

- Rust `episodeDistiller` executor に Episodelet / bridge / merge contract を実装する。
- Rust `findingCandidate` executor に Candidatelet / bridge / merge contract を実装する。
- TS manual fallback と metadata / completion semantics を一致させる。
- Rust 側で未対応 stage がある場合は silent success にせず visible unsupported にする。

Completion criteria:

- resident path と manual fallback path の queue metadata shape が一致する。
- completed row は downstream mutation を確認済み。
- unsupported stage は `completed` ではなく診断可能な状態になる。

Verification:

```bash
cargo test -p context-stilld queue
bun run rust:queue:smoke
```

Stop conditions:

- Rust executor が TS fallback と異なる保存単位を作る場合は停止する。
- unsupported stage を成功扱いする場合は停止する。

## Quality Gates

Functional:

- `episodeDistiller` は 1 source から 0..N EpisodeCard を作る。
- `episodeDistiller` は raw episodelet を保存しない。
- `findCandidate` は 1 source から 0..N found candidate を作る。
- `findCandidate` は raw candidatelet を保存しない。
- both queues は new queue row を作らず既存 row 内で完結する。

Recall:

- synthetic long log で、前半の判断が後半で失敗し別案へ変わるケースを拾える。
- localized failure / negative knowledge が global summary に潰されない。
- progress chat でも再利用 signal がある場合は candidate 化される。

Precision:

- 一回限りの進捗や未検証仮説は落ちる。
- duplicate episode / duplicate candidate が merge される。
- invalid procedure は found candidate にならない。

Operational:

- queue completed は downstream mutation 確認後だけ。
- provider lease / heartbeat の既存契約を壊さない。
- queue page / inspect で stage diagnostics を追える。

## Rollout

1. Feature flag を追加する。
   - `CONTEXT_STILL_INTERNAL_CHUNKED_DISTILLATION=1`
   - 初期状態は off。
2. Episode path だけで fixture tests を通す。
3. findCandidate path だけで fixture tests を通す。
4. Local LLM stage routing diagnostics を入れる。
5. 小さい sample の manual one-shot で live 確認する。
6. resident Rust executor parity を確認してから default on を検討する。

## Manual Live Check

Live DB を使う場合は sample を絞る。

```bash
bun run queue:episode-distiller:once
bun run queue:finding:once
```

確認 SQL:

```sql
select status, last_outcome_kind, json_extract(metadata, '$.episodeDistiller.pipelineVersion')
from episode_distiller_queue
order by updated_at desc
limit 5;

select status, last_outcome_kind, json_extract(metadata, '$.findCandidate.pipelineVersion')
from finding_candidate_queue
order by updated_at desc
limit 5;

select id, source_key, title, created_at
from episode_cards
order by created_at desc
limit 10;

select fc.id, fc.title, fc.type, fc.metadata
from found_candidates fc
join finding_candidate_queue fq on fq.id = fc.finding_job_id
order by fq.updated_at desc
limit 10;
```

## Stop Conditions

- 新 queue が必要になった場合。
- Episode と Candidate の intermediate schema が混ざった場合。
- merge が 1 source を 1 EpisodeCard に圧縮し始めた場合。
- queue completed が downstream mutation より先に起きた場合。
- lightweight LLM の parse failure が増え、bridge / merge で回復できない場合。
- stage routing が preferred target 待ちを壊し、意図しない fallback target へ流れる場合。

## Completion Definition

- `findingCandidate` と `episodeDistiller` の queue family は増えていない。
- semantic chunk / chunk-local generation / bridge / merge は queue row metadata で診断可能だが、独立 runnable queue ではない。
- `episodeDistiller` は merge 後の reusable episode 単位で複数 EpisodeCard を作れる。
- `findCandidate` は merge 後の reusable knowledge 単位で複数 found candidate を作れる。
- 安価な Local LLM を semantic chunking と chunk-local generation に使える。
- bridge / merge は必要時だけ強いモデルに逃がせる。
- 既存 verify と対象 queue tests が通る。
