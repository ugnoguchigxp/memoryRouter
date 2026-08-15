# context_compile Negative Knowledge / EpisodeCard 改善 実装計画

> アーカイブ日: 2026-08-15。実装コミット: `c6ace5f`。

> 状態: plan draft
> 作成日: 2026-06-22
> 最終更新: 2026-06-22
> 関連: [EpisodeCard 品質改善 実装計画](episode-card-quality-improvement-implementation-plan.md), [Decision Signal Integration 実装計画](decision-signal-integration-implementation-plan.md)

## 背景

2026-06-22 時点の `context_compile` は、negative knowledge と EpisodeCard をロジック上すでに利用している。

- negative knowledge は positive knowledge と別に `retrieveKnowledge(... polarities: ["negative"])` で検索され、統合 ranking 後に `guardrails` として pack に入る。
- response composer は `negative guardrails` を参考情報ではなく negative evidence として扱う SystemContext を持つ。
- EpisodeCard は `searchEpisodes()` で検索され、最大 2 件が `episode_card` の procedure item として pack に追加される。
- EpisodeCard は `recordEpisodeUsage({ usageKind: "compile" })` で compile 利用回数も更新される。

一方で、現状には「効いているが見えにくい」箇所が残っている。特に EpisodeCard は knowledge ranking / candidate trace / selected knowledge usage と別レーンなので、利用されていないように見える。また agentic refine には `polarity` が渡らないため、negative knowledge が refine 段階では通常候補に見える。

この計画は、現行設計を大きく変えずに、negative knowledge の扱いをより明示し、EpisodeCard の利用実態を観測しやすくするための小さな改善順序を定義する。

## 目的

- agentic refine が negative knowledge を通常の support と誤認しないようにする。
- EpisodeCard が compile で使われた事実を diagnostics / detail / tests から追えるようにする。
- EpisodeCard を primary evidence や Knowledge と混ぜず、precedent としての境界を維持する。
- 既存 MCP response shape、DB schema、Knowledge ranking、promotion gate を破壊しない。

## 非目的

- EpisodeCard と Knowledge の検索レーンを統合しない。
- production ranking、knowledge score、appliesTo 更新、promotion gates をこの計画では変更しない。
- EpisodeCard 専用の新規テーブルや migration を追加しない。
- `context_compile` の top-level MCP response shape を破壊的に変えない。
- EpisodeCard を `context_decision` の primary evidence に昇格しない。
- Episode 検索を LLM 再ランキングに置き換えない。

## 現状の実装ポイント

| 領域 | 現状 | 評価 |
|---|---|---|
| negative retrieval | `positiveKnowledge` と `negativeKnowledge` を別 `retrieveKnowledge` で取得 | 良い。検索レーンは明確。 |
| negative pack section | `polarity === "negative"` を `guardrails` に変換 | 良い。最終 pack の意味は明確。 |
| agentic refine | 候補に `polarity` / `section` が渡らない | 改善余地。選別 LLM は negative を通常候補として見る。 |
| response composer | `negative guardrails` を negative evidence として扱う指示あり | 良い。最終出力側は意図通り。 |
| Episode retrieval | `searchEpisodes()` で scoped/global を検索し最大 2 件選択 | 良い。過剰投入を避けている。 |
| Episode pack item | `section: "procedures"`、`itemKind: "episode_card"` で追加 | 妥当。ただし見えにくい。 |
| Episode usage | `compile_use_count` を更新 | 良い。ただし compile detail / diagnostics で追跡しづらい。 |
| tests | negative guardrails と Episode precedent の最低限のテストあり | 良い。観測性の回帰テストは追加余地あり。 |

## 変更対象ファイル

Primary files:

| ファイル | 変更内容 |
|---|---|
| `src/modules/context-compiler/agentic-refine.service.ts` | `AgenticCandidate` に `polarity` と `section` 相当の情報を追加し、System/User prompt で negative guardrail の選別ルールを明示する。 |
| `src/modules/context-compiler/context-compiler.service.ts` | agentic refine へ `polarity` を渡す。Episode retrieval stats と selected Episode refs を diagnostics に残す。 |
| `src/modules/context-compiler/context-response-composer.service.ts` | 必要なら EpisodeCard を `knowledge candidates` ではなく `episode precedents` として prompt 表示する。negative guardrail 指示は維持する。 |
| `src/modules/context-compiler/context-compiler.repository.ts` | compile detail で EpisodeCard selected item が追いやすいか確認し、必要なら既存 shape 内で補助情報を整える。 |
| `src/modules/context-compiler/context-compiler.repository.sqlite.ts` | SQLite 側も同じ detail / selected item 表示を維持する。 |

Test files:

| ファイル | 追加/更新する確認 |
|---|---|
| `test/context-compiler.service.test.ts` | negative `polarity` が agentic refine に渡ること、Episode stats / sourceRefs / usage が保存されることを確認する。 |
| `test/agentic-refine.service.test.ts` または既存の agentic refine test | negative 候補が prompt 上で guardrail として提示されることを確認する。 |
| `test/context-response-composer.service.test.ts` | EpisodeCard が composer prompt 上で Knowledge と混同されないことを確認する。 |
| `test/context-compiler-repository.test.ts` | compile detail が `episode_card` selected item を維持して返すことを確認する。 |

## P0: negative knowledge を agentic refine でも guardrail として扱う

### 変更

`AgenticCandidate` に次を追加する。

```ts
type AgenticCandidate = {
  id: string;
  type: KnowledgeItem["type"];
  status: KnowledgeStatus;
  title: string;
  content: string;
  score: number;
  sourceRefs: string[];
  polarity?: "positive" | "negative" | "neutral";
  section?: "rules" | "procedures" | "guardrails";
};
```

`compileContextPack` から `agenticRefine()` を呼ぶとき、`compressedKnowledge` の `polarity` を渡す。

agentic refine system prompt に追加する指示:

- `polarity=negative` または `section=guardrails` の候補は、実行を後押しする support ではなく、避ける条件、先に確認する条件、修正してから進む条件として評価する。
- 現在の goal に直接適用される negative guardrail は、positive support が少なくても選別対象に残す。
- goal に関係しない negative guardrail は落としてよい。
- selectedIds の順序は「直接実行に必要な positive context」と「直接適用される guardrail」の両方を反映する。

### 受け入れ条件

- `agenticRefine()` の user prompt JSON に negative 候補の `polarity` または `section` が含まれる。
- negative guardrail が agentic refine で選ばれた場合、最終 pack では従来通り `guardrails` に入る。
- agentic refine が無効な場合の挙動は不変。
- `selectedKnowledgeIds`、`knowledge_usage_events`、candidate trace の既存保存形式を破壊しない。

## P1: EpisodeCard 利用を diagnostics で見える化する

### 変更

`retrieveEpisodePrecedents()` の stats を、現在の `hitCount` / `selectedCount` / `searchFailed` から、既存 shape 互換を維持しつつ次の補助情報を加える。

```ts
episodes: {
  hitCount: number;
  selectedCount: number;
  searchFailed: boolean;
  selectedIds?: string[];
  selectedTitles?: string[];
  scopedHitCount?: number;
  globalHitCount?: number;
  usedFor?: "compile_precedent";
}
```

`sourceRefs` には現状通り `context-still://episodes/{id}` と raw refs を含める。新規 top-level field は追加しない。

### 受け入れ条件

- Episode が選ばれた compile run の `pack.diagnostics.retrievalStats.episodes.selectedIds` で ID を確認できる。
- `pack.sourceRefs` に `context-still://episodes/{id}` が残る。
- `recordEpisodeUsage({ usageKind: "compile" })` が従来通り呼ばれる。
- Episode が 0 件の場合も existing diagnostics shape と互換で、`No Content` 判定を悪化させない。

## P2: Composer prompt で EpisodeCard を Knowledge と混同しない

### 変更

現状の EpisodeCard pack item は `section: "procedures"` であり、composer では procedures の一部として扱われる。まずは output shape を変えず、prompt 上のラベルだけ分ける。

候補:

- `buildComposerUserPrompt()` で `item.itemKind === "episode_card"` を `episode precedents:` に分離する。
- 通常の `knowledge candidates:` には `rule` / `procedure` の Knowledge だけを載せる。
- Episode precedent には `id`、`title`、`summary`、`sourceRefs` の短いヒントだけを載せる。

composer system prompt に追加する指示:

- Episode precedents are past similar cases, not Knowledge rules.
- Episode precedent は実装方針の参考にできるが、現在の source truth や decision evidence としては扱わない。
- 使う場合は「過去の類似ケース」として要約し、現在のコード確認を前提にする。

### 受け入れ条件

- agentic composer 有効時の user prompt に `episode precedents:` が出る。
- `knowledge candidates:` には `episode_card` が混ざらない。
- fallback composer は現状通り procedures に Episode を含めてもよいが、文言が `Past episode:` であることを維持する。
- MCP response の `pack.procedures` 互換は維持する。

## P3: Compile detail / UI で利用状況を追えるようにする

### 変更

既存の `context_pack_items` と `packSnapshot` には `itemKind: "episode_card"` が保存される。まず repository/API の返却でこれが欠落していないことをテストで固定する。

必要なら、既存 detail response 内で次を derived summary として追加する。ただし top-level MCP response には追加しない。

```ts
episodeSignals?: Array<{
  episodeId: string;
  title: string;
  section: "procedures";
  sourceRefs: string[];
}>;
```

この derived summary は UI/API detail 専用とし、compile pack schema には追加しない。

### 受け入れ条件

- `getCompileRunDetail()` で `selectedItems` または derived summary から EpisodeCard が追える。
- SQLite/Postgres の repository で挙動が一致する。
- `knowledgeSignals` に EpisodeCard を混ぜない。
- UI 変更が必要な場合も、既存 table/card の小さな追加表示に留める。

## P4: 実データで効果確認する

### 変更

実装後、手元 SQLite で代表的な compile を 2-3 件実行して、次を確認する。

- negative guardrail がある goal で `guardrails` が落ちていない。
- EpisodeCard にヒットする goal で `episodes.selectedIds` が残る。
- `context-still://episodes/{id}` が `sourceRefs` に残る。
- `compile_use_count` が増える。

### 受け入れ条件

確認 SQL 例:

```sql
select id, json_extract(pack_snapshot, '$.diagnostics.retrievalStats.episodes.selectedCount') as selected_count
from context_compile_runs
order by created_at desc
limit 10;
```

```sql
select id, title, compile_use_count
from episode_cards
where compile_use_count > 0
order by updated_at desc
limit 10;
```

## 実装順序

1. P0: `AgenticCandidate` に `polarity` / `section` を追加し、prompt と tests を更新する。
2. P1: Episode retrieval stats に selected IDs / titles を追加し、service tests を更新する。
3. P2: Composer prompt の `episode precedents` 分離を追加し、composer tests を更新する。
4. P3: compile detail repository の EpisodeCard 可視性をテストで固定し、必要なら derived summary を追加する。
5. P4: SQLite 実データで compile smoke を実行し、diagnostics と usage count を確認する。

## 検証コマンド

Focused:

```bash
bunx vitest run test/context-compiler.service.test.ts test/context-response-composer.service.test.ts
```

追加テスト作成後:

```bash
bunx vitest run test/context-compiler.service.test.ts test/context-response-composer.service.test.ts test/context-compiler-repository.test.ts
```

代表 gate:

```bash
bun run verify
```

Docs only 変更時:

```bash
bun run docs:check-links
```

## 停止条件

- agentic refine の変更で negative guardrail が `rules` / `procedures` に混ざる場合は停止する。
- EpisodeCard を Knowledge usage / Knowledge signals に混ぜる必要が出た場合は停止し、設計を再確認する。
- compile pack schema の破壊的変更が必要になった場合は停止する。
- DB schema migration が必要になった場合は、この計画から切り出す。
- Episode 検索品質そのものを大きく変えたくなった場合は、実データで「良い Episode が存在するのに出ない」証拠を先に取る。

## 完了条件

- negative knowledge は retrieve / refine / compose の全段階で guardrail として扱われる。
- EpisodeCard は compile precedent として利用され、diagnostics と sourceRefs から利用事実を追える。
- EpisodeCard は Knowledge として記録されず、primary evidence とも混ざらない。
- focused tests と docs link check が通る。
- 実データで少なくとも 1 件、EpisodeCard の `compile_use_count` 増加と diagnostics の `selectedIds` を確認できる。
