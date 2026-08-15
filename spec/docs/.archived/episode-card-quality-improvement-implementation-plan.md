# EpisodeCard 品質改善 実装計画

> アーカイブ日: 2026-08-15。実装コミット: `bf02698`。

## 背景

2026-06-22 時点の SQLite 実データでは、`episode_cards` は 84 件存在し、全件が `vibe_memory` 由来で `episode_refs` を持っている。タイトル、状況、判断、教訓は多くのカードで再利用可能な粒度に達している一方、保存マッピング側の固定処理により、カード単体で読むと意味が崩れる箇所が残っている。

確認済みの主な問題:

- `outcome` が 84 件すべてで `vibe memory segment ... から蒸留された Episode。` になっており、実際の成果や結果を表していない。
- `situation` に `Intent:` / `意図:` が全件混入しており、状況欄と意図欄が分離されていない。
- `action` が 6 件で空、66 件で実質 `source 時点の未解決事項` だけになっている。
- `confidence` は 75 / 80 / 90 に偏り、`importance` は 85 が最多で、利用実績 `compile_use_count` / `decision_use_count` は全件 0 のため実績値ではなく生成時推定である。
- `fetch_episode` の互換返却に、永続スキーマから削除済みの `evidenceStatus: "unverified"` が残っている。

この計画の主眼は SystemContext の文言調整ではなく、`episodeDistiller` の canonical schema、保存マッピング、テスト期待値、既存データ補正を修正することに置く。

## 実装開始可否レビュー

| 観点 | 判定 | 対応 |
|---|---|---|
| 原因の切り分け | OK | `outcome` 固定文、`Intent:` 混入、`action` と open loop の混在は `canonicalEpisodeToCardInput` の決定的マッピングで発生している。 |
| SystemContext 依存 | OK | SystemContext は補助的に更新するが、P0 は schema / mapper / test の修正に置く。 |
| 既存データ補正 | OK | 生成済み 84 件に対する backfill / repair CLI を計画に含める。 |
| 受け入れ条件 | OK | DB query と unit/runtime test で pass/fail 判定できる条件を定義する。 |
| 破壊的変更 | 注意 | `EpisodeDistillerCanonical` に `outcome` / `actionTaken` を追加するため、test fixture と parser 期待値を同時に更新する。 |
| 未解決 blocker | なし | 新規テーブルは不要。既存 `metadata.episodeDistillation.canonical` と `episode_refs` を使って補正できる。 |

## 目的

- EpisodeCard の `outcome` を「由来」ではなく「作業結果・意思決定結果・失敗から得られた状態」として読めるようにする。
- `situation`、`intent`、`action`、`openLoops` の責務を保存時に分離する。
- `importance` / `confidence` を、実利用ではなく生成時推定であることを前提に校正し、過大評価を抑える。
- MCP / API / UI が削除済み概念 `evidenceStatus` を EpisodeCard 品質として見せないようにする。
- 既存 84 件を、原典 ref と canonical metadata を使って再保存または補正する。

## 非目的

- EpisodeCard の新規永続テーブルを追加しない。
- Episode と Knowledge の検索レーンを統合しない。
- `findCandidate` に Episode 作成責務を戻さない。
- LLM で既存カードを全文再生成することを前提にしない。まず deterministic repair を優先する。
- `compile_use_count` / `decision_use_count` の利用実績計測をこの計画の中核にはしない。必要なら別差分で扱う。

## 変更対象ファイル

Primary files:

| ファイル | 変更内容 |
|---|---|
| `src/modules/episodeDistiller/schema.ts` | canonical schema に `outcome` と `actionTaken` を追加し、`canonicalEpisodeToCardInput` の保存マッピングを修正する。 |
| `src/modules/episodeDistiller/worker.ts` | System prompt と JSON shape を新 schema に合わせる。低価値 / 低根拠カードの採点指示を締める。 |
| `src/mcp/tools/episode.tool.ts` | 返却に削除済み `evidenceStatus` 互換値が残っていないか確認し、必要なら削除する。 |
| `src/modules/episodic-memory/episode-card.repository.ts` | Postgres 側 map / search の互換表示を確認し、削除済み品質概念を返さない。 |
| `src/modules/episodic-memory/episode-card.repository.sqlite.ts` | SQLite 側 map / search の互換表示を確認し、削除済み品質概念を返さない。 |

New files:

| ファイル | 役割 |
|---|---|
| `src/cli/repair-episode-card-quality.ts` | 既存 EpisodeCard の `outcome` / `situation` / `action` を canonical metadata から deterministic に補正する CLI。 |

Test files:

| ファイル | 追加/更新する確認 |
|---|---|
| `test/sqlite-runtime-support.bun.ts` | `outcome` が由来マーカーでないこと、`situation` に `Intent:` が混入しないこと、openLoops が `action` を占有しないことを固定する。 |
| `test/mcp.tools.test.ts` | `fetch_episode` / `search_episodes` で削除済み `evidenceStatus` を返さないことを確認する。 |
| `test/episode-card.repository.test.ts` | Postgres repository の返却 shape と score fields の互換を確認する。 |
| `test/episode-card-quality-repair.test.ts` | repair CLI の dry-run / write、idempotency、対象件数、補正後の pass/fail を確認する。 |

## P0: 保存マッピングを正す

### 変更

`EpisodeDistillerCanonical` に次のフィールドを追加する。

```ts
outcome: string;
actionTaken: string;
```

責務:

- `context`: 状況、背景、発生した問題。
- `intent`: 作業者またはユーザーが達成しようとした目的。永続本文ではなく metadata と必要な UI 表示に残す。
- `keyDecisions`: 重要な判断、設計選択、制約。
- `actionTaken`: 実際に行った修正、実行、検証、または明示的に避けたこと。
- `outcome`: 最終的にどうなったか。テストが通った、キューが再試行可能になった、設計方針が確定した、未完了のまま残った、など。
- `openLoops`: source 時点の未解決事項。本文の `action` には混ぜず metadata / antiApplicability に残す。

`canonicalEpisodeToCardInput` の保存マッピング:

```ts
return {
  title: canonical.title,
  situation: canonical.context,
  observations: joinList(canonical.keyDecisions, "主要な判断は特定されませんでした。"),
  action: canonical.actionTaken || canonical.failedApproach,
  outcome: canonical.outcome,
  lesson: canonical.reusableLesson,
  antiApplicability: {
    requiresRawEvidenceCheck: true,
    stalenessRisk: canonical.scores.staleness_risk,
    openLoops: canonical.openLoops,
  },
  metadata: {
    episodeDistillation: {
      canonical,
      sourceFragmentKey,
      ...
    },
    triggers: canonical.usefulFutureTriggers,
  },
};
```

### 受け入れ条件

- `select count(*) from episode_cards where outcome like 'vibe memory segment%';` が新規生成カードで 0。
- 新規生成カードの `situation` に `Intent:` / `意図:` が含まれない。
- 新規生成カードの `action` は空ではなく、実施内容または避けた approach を含む。
- `openLoops` は `metadata.episodeDistillation.canonical.openLoops` と `antiApplicability.openLoops` に残る。
- `refs` と `metadata.episodeDistillation.sourceFragmentKey` は現状どおり残る。

## P1: SystemContext / prompt を新 schema に合わせる

### 変更

`buildMessages` の system prompt と user JSON shape を更新する。

追加する指示:

- `outcome` は source locator や蒸留由来ではなく、作業の結果を書く。
- `actionTaken` は実行した変更、検証、運用操作、明示的に避けた approach を書く。
- `openLoops` は現在も未解決と断定せず、`source 時点` のものとして配列にだけ残す。
- `context` に intent を混ぜない。
- `outcomeKind=success` でも openLoops が残る場合は、`outcome` に「完了範囲」と「残った確認」を短く含める。
- 単一の小さなテスト fixture 変更、分類だけの作業、UI微調整は `importance` を 60 前後に抑える。
- `compile_use_count` / `decision_use_count` が 0 の段階では、`importance` は実利用実績ではなく推定である。

### 受け入れ条件

- LLM 出力 schema validation が `outcome` / `actionTaken` 欠落時に失敗する。
- blank response reminder も新 shape を要求する。
- 既存 test hook の canonical fixture が新 shape を満たす。
- 自然文は日本語、enum / path / command / API name は原文保持される。

## P2: スコア校正を実装する

### 変更

`episodeDistillerScoreSchema` の正規化は維持しつつ、保存前に score calibration helper を通す。

候補:

```ts
function calibrateEpisodeScores(canonical: EpisodeDistillerCanonical) {
  const scores = canonical.scores;
  const lowActionSignal = !canonical.actionTaken.trim() && !canonical.failedApproach.trim();
  const hasOpenLoops = canonical.openLoops.length > 0;
  const singleSourceCap = scores.confidence > 80 ? 80 : scores.confidence;
  const valueScore = computeValueReviewScore(scores);

  return {
    ...scores,
    confidence: singleSourceCap,
    importance: Math.min(scores.importance, valueScore + 10, lowActionSignal ? 65 : 100),
  };
}
```

設計方針:

- `confidence` は source segment 単独なら 80 cap を守る。複数独立根拠が明示される場合だけ 90 以上を許す。
- `importance` は `reusability`、`decision_density`、`failure_value`、`evidence_quality`、`compression_quality` からの value score と大きく乖離させない。
- `failure_episode` は `failure_value` が高ければ importance を高く保てる。
- `actionTaken` が空、または単なる分類・fixture 変更だけのカードは importance を抑える。

### 受け入れ条件

- 小さな分類・fixture 変更の Episode が importance 85 以上にならない。
- `failure_episode` で causal clarity / failure value が高いものは importance 85 以上を維持できる。
- `confidence` 90 以上は、metadata に複数独立根拠または明示的な justification がある場合だけ。
- score calibration の unit test が 0-1 float 入力、100 超過、負値、文字列数値をカバーする。

## P3: MCP / API / UI の削除済み品質概念を掃除する

### 変更

`fetch_episode` / `search_episodes` の返却、API detail、UI detail から、EpisodeCard 永続スキーマに存在しない `evidenceStatus` を品質指標として見せない。

扱い:

- `vibe_memories.evidence_status` は原典履歴の概念として残す。
- EpisodeCard の信頼度は `confidence`、再利用価値は `importance`、原典有無は `refs` で表す。
- raw evidence 未確認の注意は `antiApplicability.requiresRawEvidenceCheck` で表す。

### 受け入れ条件

- `fetch_episode` の返却 JSON に top-level `evidenceStatus` がない。
- `search_episodes` の返却 JSON に top-level `evidenceStatus` がない。
- UI detail は `importance` / `confidence` / `refs` / `requiresRawEvidenceCheck` を表示し、`evidenceStatus` を表示しない。
- `vibe_memories.evidence_status` を参照する既存機能は壊さない。

## P4: 既存データ補正 CLI

### 方針

既存 84 件は、可能な限り `metadata.episodeDistillation.canonical` から deterministic に補正する。新たな LLM 再生成はデフォルトでは行わない。

補正ルール:

- `situation`: `canonical.context` に置換する。
- `outcome`: `canonical.outcome` があればそれを使う。ない場合は `outcomeKind`、`openLoops`、`keyDecisions` から短い deterministic 文を作る。
- `action`: `canonical.actionTaken` があれば使う。なければ `failedApproach` を使う。どちらもなければ空のままにせず、`主要な実施内容は source metadata からは特定できません。` とするか、補正対象として report する。
- `antiApplicability.openLoops`: `canonical.openLoops` を移す。
- `metadata.episodeDistillation.repair`: repair version、実行時刻、旧値 hash、dry-run summary を残す。

CLI:

```bash
CONTEXT_STILL_DB_BACKEND=sqlite bun run src/cli/repair-episode-card-quality.ts --dry-run
CONTEXT_STILL_DB_BACKEND=sqlite bun run src/cli/repair-episode-card-quality.ts --write --backup
```

### 受け入れ条件

- dry-run は対象件数、補正理由、変更予定フィールド別件数を表示する。
- write 前に SQLite backup を作れる。
- write は idempotent。2 回目の dry-run で変更予定が 0 件になる。
- 補正後、次の query が pass する。

```sql
select count(*) from episode_cards where outcome like 'vibe memory segment%';
select count(*) from episode_cards where situation like '%Intent:%' or situation like '%意図:%';
select count(*) from episode_cards where length(trim(action)) = 0;
```

期待値:

- `outcome` 由来マーカー: 0
- `situation` intent 混入: 0
- `action` 空欄: 原則 0。source から特定できない場合だけ report に残す。

## P5: UI 表示の微修正

### 変更

Admin Episode detail では、本文欄を次の順で見せる。

1. Situation
2. Observations
3. Action
4. Outcome
5. Lesson
6. Open loops at source time
7. Source refs

`Open loops at source time` は `metadata.episodeDistillation.canonical.openLoops` または `antiApplicability.openLoops` から読む。通常本文の `action` に混ぜない。

### 受け入れ条件

- Detail view で source ref と open loops が別欄に見える。
- List view の Quality は `I:` / `C:` を維持してよいが、`evidenceStatus` は表示しない。
- 空欄の `action` / `outcome` がある場合、UI は空文字ではなく「未記録」と表示する。

## 実装順序

1. P0 schema / mapper を変更し、test fixture を新 canonical shape に更新する。
2. P1 prompt を新 schema と保存責務に合わせる。
3. P2 score calibration helper と unit test を追加する。
4. P3 MCP / API / UI の `evidenceStatus` 互換表示を掃除する。
5. P4 repair CLI を dry-run で作成し、ローカル DB で対象件数を確認する。
6. P4 write を backup 付きで実行し、補正後 query を確認する。
7. P5 UI detail の open loops 表示を整える。
8. repo-native verify を実行する。

## 検証手順

Representative tests:

```bash
bunx vitest run test/mcp.tools.test.ts test/episode-card.repository.test.ts
bun test ./test/sqlite-runtime-support.bun.ts
CONTEXT_STILL_DB_BACKEND=sqlite bun run src/cli/repair-episode-card-quality.ts --dry-run
```

Full gate:

```bash
bun run verify
```

Data checks:

```bash
sqlite3 data/context-still-core.sqlite "
select count(*) as source_marker_outcomes
from episode_cards
where outcome like 'vibe memory segment%';

select count(*) as intent_mixed_situations
from episode_cards
where situation like '%Intent:%' or situation like '%意図:%';

select count(*) as empty_actions
from episode_cards
where length(trim(action)) = 0;

select confidence, count(*)
from episode_cards
group by confidence
order by confidence;

select importance, count(*)
from episode_cards
group by importance
order by importance;
"
```

## Stop Conditions

- 新 schema にした結果、既存 `episode_distiller_queue` の parse failure が増える場合は、prompt と blank response reminder を先に修正し、repair CLI の write は止める。
- deterministic repair で `outcome` を合理的に作れないカードが 10% を超える場合は、write を止めて対象一覧をレビューする。
- `fetch_episode` から `evidenceStatus` を消す変更で外部 contract test が壊れる場合は、互換 field を `metadata.legacyEvidenceStatus` のような明示的 legacy 名に隔離する。
- `importance` calibration により高価値 failure episode が 70 未満へ落ちる場合は、failure episode の補正式を見直す。

## 完了条件

- 新規生成 EpisodeCard の `outcome` が由来マーカーではない。
- 新規生成 EpisodeCard の `situation` に intent label が混入しない。
- `action` は実施内容または避けた approach を表し、open loops は別の場所に残る。
- `fetch_episode` / `search_episodes` は EpisodeCard の top-level `evidenceStatus` を返さない。
- 既存 DB の補正 dry-run / write が idempotent に通る。
- `bun run verify` が通る。
