# Episode / Knowledge Utility Retrieval 第1弾 実装計画

> アーカイブ日: 2026-08-15。実装コミット: `3c28e2e`。

Status: implementation plan
Created: 2026-06-29
Related idea note was removed when deferred documentation was deleted.

## Goal

未活用の Knowledge / Episode がなぜ `context_compile` に乗らないのかを、まず実データで見えるようにする。

第1弾では retrieval の採用結果を変えない。既存の direct retrieval、ranking、agentic refine、token budget、pack composition は維持し、utility 候補は最終 pack に入れず trace-only で記録する。

## Non Goals

- `context_compile` の最終 pack に utility candidate を追加しない。
- 既存 text / vector / facet retrieval を置き換えない。
- `dynamicScore` の計算式を変更しない。
- EpisodeCard を Knowledge と同じ scoring lane に混ぜない。
- EpisodeCard を source truth として扱わない。
- negative knowledge 登録の shape を大きくしない。
- 新しい semantic runtime や外部依存を追加しない。

## Current Constraints

- `context_compile_candidate_traces` には rank、selected、suppressed、agentic decision、`evidence` が既にある。
- `context_compile_evals` には outcome と relevance / actionability / coverage / specificity がある。
- `knowledge_usage_events` には selected knowledge の used / not_used / off_topic / wrong verdict がある。
- EpisodeCard は `episode_card` pack item として procedures 側に入るが、Knowledge ではなく precedent として扱う。
- negative knowledge は `polarity=negative`、`avoid`、`prefer`、applicability / metadata を中心にした最小 shape を維持する。
- `context_compile_candidate_traces` は `(run_id, item_kind, item_id)` unique なので、utility lane が既存 candidate と同じ item を出した場合は新規行を作らず既存 trace の `evidence.utilitySignals` に追記する。
- `usage_off_topic_count30d` のような集計値は物理列ではなく、`knowledge_usage_events` から report / lane 計算時に derive する。

## Implementation Surface

第1弾で触る対象を以下に限定する。

- `src/modules/context-compiler/context-compiler.service.ts`
  - utility trace-only candidate の計算呼び出しと candidate trace evidence の付与。
- `src/modules/context-compiler/context-compiler.repository.ts`
  - 既存 trace 保存 API を壊さず、必要なら evidence merge helper を追加する。
- `src/modules/context-compiler/context-compiler.repository.sqlite.ts`
  - SQLite の trace evidence merge / report query。
- `src/modules/knowledge/knowledge.service.ts`
  - negative inverse 用の lightweight intent / metadata 検索 helper。
- `src/modules/knowledge/knowledge-feedback.service.ts`
  - off_topic / wrong / used 集計 helper が必要な場合だけ追加。
- `src/cli/utility-retrieval-report.ts`
  - baseline / observation report 用の新規 CLI。
- `package.json`
  - `utility:retrieval-report` script を追加する。

## Runtime Guard

第1弾は trace-only でも DB 書き込みが増えるため feature flag を置く。

- flag: `CONTEXT_COMPILE_UTILITY_TRACE`
- default: enabled
- disabled value: `0`, `false`, `off`
- disabled 時の期待動作: baseline / report CLI は動くが、`context_compile` 中の utility trace-only candidate 保存は行わない。

## P0: Baseline Snapshot

実装前に、直近 run の現状値を採取する。

### 実装

1. `src/cli/utility-retrieval-report.ts` を追加する。
2. `context_compile` の直近 run から baseline を計算する。デフォルトは `--since-days 14 --limit 200` とする。
3. `--mode baseline` と `--mode observation` を持たせる。
4. `--since-days`、`--limit`、`--json` を受け付ける。
5. baseline は SQLite を主対象にする。PostgreSQL path が残っている場合も、SQLite を先に固定する。
6. 出力は JSON にする。stdout は最終 JSON だけにする。

### 指標

- `activationRate`: `compile_select_count > 0` の active knowledge 割合。
- `coldKnowledgeRate`: `compile_select_count = 0` の active knowledge 割合。
- `negativeSelectionRate`: selected knowledge のうち `polarity=negative` の割合。
- `episodeSelectionRate`: compile run あたり EpisodeCard selected 件数。
- `candidateDropByStage`:
  - `not_retrieved`
  - `retrieved_but_ranked_out`
  - `ranked_but_budgeted_out`
  - `agentic_rejected`
  - `trace_only`
  - `selected`
- `evalBaseline`:
  - average relevance
  - average actionability
  - average coverage
  - average specificity
  - outcome distribution
- `offTopicWrongRate`: knowledge usage verdict の `off_topic` / `wrong` 割合。

`candidateDropByStage.not_retrieved` は candidate trace に存在しない個別行ではない。active knowledge 全体から、観測 window 内で `context_compile_candidate_traces` に一度も出ていない件数として aggregate で計算する。

### Command

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run utility:retrieval-report -- --mode baseline --since-days 14 --limit 200 --json
```

### Verification

- 実データ DB で baseline JSON が出る。
- knowledge が 0 件、candidate trace が 0 件、eval が 0 件の場合も落ちずに理由を出す。
- baseline の query は `context_compile_runs`、`context_compile_candidate_traces`、`context_pack_items`、`knowledge_items`、`context_compile_evals`、`knowledge_usage_events` の現在の実体と一致する。
- stdout に説明ログが混ざらず、JSON parse できる。

## P1: Candidate Drop Classification

未採用の原因を trace 上で分類する。

### 実装

1. candidate trace 保存時の `evidence` に `dropStage` と `dropReason` を追加する。
2. 既存 trace schema は破壊しない。新列を増やす前に `evidence` JSON に入れる。
3. `dropStage` は pack 採用結果から derive できる範囲に限定する。
4. `dropReason` は機械判定できる値だけにする。説明文は `evidence.dropExplanation` に分離する。

### dropStage

```ts
type CandidateDropStage =
  | "selected"
  | "retrieved_but_ranked_out"
  | "ranked_but_budgeted_out"
  | "agentic_rejected"
  | "suppressed_duplicate"
  | "trace_only";
```

### dropReason

```ts
type CandidateDropReason =
  | "selected"
  | "below_final_rank_limit"
  | "section_token_budget"
  | "agentic_rejected"
  | "near_duplicate"
  | "utility_trace_only"
  | "unknown";
```

### Verification

- selected candidate は `dropStage: "selected"` になる。
- duplicate suppression を受けた candidate は `suppressed_duplicate` になる。
- agentic refine が使われた場合、rejected candidate が `agentic_rejected` として追える。
- token budget で落ちた candidate は `ranked_but_budgeted_out` として追える。
- 既存の compile detail 画面や API が壊れない。
- `evidence` JSON が object のまま保存され、既存 reader が未知 field を無視できる。

## P2: Co-selection Trace-only Lane

direct candidate に対して、過去に一緒に選ばれた Knowledge を trace-only 候補として計算する。

### 実装

1. `src/modules/context-compiler/utility-retrieval.service.ts` を追加する。
2. selected direct candidates の knowledge id を seed にする。
3. `context_pack_items` から同一 run 内の co-selection pair を集計する。
4. `context_compile_evals` outcome で重み付けする。
5. 最大 5 件だけ trace-only candidate として `context_compile_candidate_traces` に保存する。
6. final pack には入れない。
7. 同一 run の通常 candidate と同じ item が出た場合は、既存 candidate row に `utilitySignals.coSelection` を merge する。

### scoring

```text
coSelectionScore =
  useful_pair_count * 3
  + partial_pair_count
  - misleading_pair_count * 2
```

同じ pair でも方向を保持する。

```text
directKnowledgeId -> utilityKnowledgeId
```

### trace evidence

```json
{
  "utilityLane": "co_selection",
  "traceOnly": true,
  "seedKnowledgeIds": ["..."],
  "coSelectionScore": 0,
  "supportingRunCount": 0,
  "outcomeBreakdown": {
    "useful": 0,
    "partial": 0,
    "misleading": 0
  },
  "adoptionReason": "...",
  "rejectIf": ["..."]
}
```

### Verification

- co-selection candidate は `selected=false` で保存される。
- `rankingReason` から `utility_trace_only:co_selection` と判別できる。
- direct candidate と同じ knowledge id は重複保存しない。
- `wrong` / `off_topic` verdict が強い knowledge は candidate にしない。
- historical pair が 0 件の DB では lane が空になり、compile は degraded / failed にならない。

## P3: Exploration Trace-only Lane

一度も、またはほとんど選ばれていない Knowledge に出会う機会を trace-only で作る。

### 実装

1. active knowledge から eligible candidate を抽出する。
2. `compile_select_count <= 2`、`importance >= 40`、`confidence >= 50` を初期条件にする。
3. `explicit_downvote_count > 0`、30日以内の `off_topic` / `wrong` verdict、deprecated / stale は除外する。
4. retrievalMode / facets / polarity に極端に反するものは除外する。
5. 最大 1 件だけ trace-only candidate として保存する。

### Selection Strategy

初期は deterministic weighted random にする。

- seed: `runId` または goal hash
- weight: `importance * 0.6 + confidence * 0.4`
- 同一 run で同じ candidate が二重に出ないようにする

### Verification

- final pack は変わらない。
- exploration candidate は `selected=false` で保存される。
- 同じ条件で同じ run を再評価しても候補が安定する。
- deprecated / stale / wrong / off_topic の候補は出ない。
- eligible candidate が 0 件でも compile は通常どおり完了する。

## P4: Negative Inverse Trace-only Lane

negative knowledge は goal とテキスト類似しにくいため、逆引き候補を trace-only で記録する。

### 実装

1. goal / changeTypes / domains から constrained intent を軽量に推定する。
2. まずは既存の `intentTags`、applicability、metadata を検索対象にする。
3. 新しい必須列や専用テーブルは追加しない。
4. `polarity=negative` の candidate だけを対象にする。
5. 最大 1 件だけ trace-only candidate として保存する。
6. `metadata.constrainedIntents` が存在する場合だけ補助的に読む。存在しない場合は `intentTags` と facets だけで判定する。

### 初期 intent 例

- `modify_schema`
- `production_change`
- `requeue`
- `delete_or_reset`
- `restart_owner`
- `provider_change`
- `runtime_truth_check`

### Verification

- positive knowledge path に影響しない。
- negative candidate は `polarity=negative` のものだけになる。
- `technologies`、`changeTypes`、`domains` の applicability が落ちない。
- negative body / avoid / prefer の日本語保存ルールを壊さない。
- `register_candidate(s)` の input schema を第1弾では変更しない。

## P5: Observation Report

第1弾の実装後、約2週間の観測に使う report を出せるようにする。

### 実装

1. baseline と同じ指標を、実装後の期間で再計算する。
2. utility lane ごとに hit / reject / off_topic / wrong を集計する。
3. `compile_eval` の coverage / actionability が悪化していないか見る。
4. EpisodeCard は selected 件数と feedback verdict を Knowledge とは分けて出す。

### Command

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run utility:retrieval-report -- --mode observation --since-days 14 --limit 500 --json
```

### 第1弾の成功条件

- `activationRate` が改善傾向、または `coldKnowledgeRate` が低下傾向。
- utility trace-only candidate のうち、後続 feedback / eval で有用そうなものが 25% 以上。
- `off_topic` / `wrong` が増えない。
- `context_compile` の pack 内容は第1弾で変わらない。
- baseline / observation report で、次に進むべき lane が説明できる。

### 第2弾に進む条件

約2週間観測して、次のいずれかを満たす場合だけ第2弾へ進む。

- `activationRate` がほぼ変わらない。
- `coldKnowledgeRate` が下がらない。
- negative knowledge が依然として必要な goal で拾われない。
- EpisodeCard が selected されても `used` / `needs_raw_check` 以外の価値に繋がらない。
- compile eval の coverage が改善しない。

## Tests

- `test/context-compile-candidate-trace.test.ts`
- `test/context-compiler.service.test.ts`
- `test/knowledge-value.service.test.ts`
- `test/knowledge-feedback.service.test.ts`
- `test/episode-card.repository.sqlite.test.ts`
- baseline / observation report 用の新規 CLI test

## Verification Commands

第1弾の実装 PR では、最低限この順で確認する。

```bash
bunx vitest run test/context-compile-candidate-trace.test.ts test/context-compiler.service.test.ts test/knowledge-feedback.service.test.ts test/episode-card.repository.sqlite.test.ts
CONTEXT_STILL_DB_BACKEND=sqlite bun run utility:retrieval-report -- --mode baseline --since-days 14 --limit 50 --json
bun run docs:check-links
bun run typecheck
```

期待結果:

- targeted tests が通る。
- report command が JSON を返す。
- docs link check が通る。
- typecheck が通る。

失敗時対応:

- report command が JSON 以外を stdout に出す場合は CLI を修正してから進む。
- trace-only candidate が selected pack に混入した場合は feature flag を off にし、P2-P4 の保存処理を止める。
- typecheck が既存 unrelated error で止まる場合は、該当 error が今回変更と無関係であることを記録し、targeted tests と CLI JSON を最低限の gate にする。

## Stop Conditions

- trace-only candidate が final pack に混入する。
- selected knowledge count や pack snapshot が第1弾で変わる。
- negative knowledge 登録 shape が肥大化する。
- EpisodeCard が Knowledge usage / Knowledge signals に混ざる。
- baseline が取れないまま utility lane 実装に進む。
- `off_topic` / `wrong` の増加を観測できない設計になる。
- `CONTEXT_COMPILE_UTILITY_TRACE=0` で trace-only 書き込みを止められない。

## Done

- baseline JSON を実データで取得できる。
- co-selection / exploration / negative inverse の trace-only candidate が保存される。
- final pack は第1弾前後で意図せず変わらない。
- 約2週間後に第2弾へ進むか判断できる observation report が出せる。
- 上記 Verification Commands の結果が記録されている。
