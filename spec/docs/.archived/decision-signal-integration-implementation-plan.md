# Decision Signal Integration 実装計画

> アーカイブ日: 2026-08-15。実装コミット: `d593faf`。

> 状態: plan draft
> 作成日: 2026-06-20
> 最終更新: 2026-06-20
> 関連していた Desktop Readiness 設計メモは、将来検討文書の整理時に削除済み。

## 目的

この文書は、`context_decision` の判断品質を 90 点以上に引き上げるために、既存の `context_compile`、graph、community、landscape、attractor 指標を Decision の evidence / scoring / reliability gate / feedback loop に統合する実装計画である。

中心方針は、Decision を単発の Knowledge 検索だけで判断させず、既に蓄積されている「過去に compile で選ばれたか」「実際に使われたか」「wrong/off_topic になったか」「所属 community が strong attractor か negative attractor か」を判断材料として使うことである。

## 目標状態

90 点以上の品質は、次を満たす状態と定義する。

- `reject` / `rollback` / `discard` / `escalate` が返った場合、agent message と mandate が対象アクション停止を明確に示す。
- Good/Bad feedback が final decision に応じた正しい evidence role と community に作用する。
- `counter_evidence` が first-class evidence として保存、表示、LLM judgment prompt、reliability gate に入る。
- `context_compile` の selected / suppressed / feedback / eval signals が Decision scoring に反映される。
- graph / community / landscape / attractor signals が confidence cap、support boost、risk boost、revise/reject rule に反映される。
- 検索や LLM が失敗しても、`decision=escalate` の failed/degraded Decision run が監査可能に残る。
- Decision 関連ユニットテストに加えて、fixture-based calibration test で 90 点以上相当の期待ケースを通す。

## 非目標

- production Knowledge ranking や promotion gate を既定で変更しない。
- landscape replay / diagnostics を理由に Knowledge 本体の score や appliesTo を自動更新しない。
- runtime compile interventions を opt-in なしで入れない。
- MCP response の必須フィールドを破壊的に変更しない。
- Decision UI の大規模再設計をこの計画の主目的にしない。

## 現状評価

現状実装は、`context_decision` 単体としては監査性と危険操作ガードレールの骨格を持っている。

| 領域 | 現状 | 評価 |
|---|---|---|
| Evidence retrieval | support / counter / preference / risk / verification / alternative の query を作る | 良いが、counter evidence の扱いが弱い |
| Knowledge Assessment | support, risk, conflict, coverage を算出する | 良いが、landscape/compile signals は未使用 |
| Reliability Gate | no evidence, weak coverage, strong risk, bad feedback を抑制できる | 良いが、community/attractor rule がない |
| Feedback | Good/Bad と system outcome を保存できる | final decision 非対応。`selected_support` だけに作用する |
| Agent message | LLM answer と fallback がある | final decision と矛盾する文面の post-check がない |
| Persistence | run/evidence/coverage/feedback が保存される | retrieval failure 時の failed run が残らない |

現状の採点は 72 / 100 程度。90 点以上には、既存 signal の統合と feedback loop の修正が必要である。

## 利用する既存データ源

### context_compile signals

既に利用可能なデータ:

- `knowledge_items.compile_select_count`
- `context_pack_items`
- `context_compile_candidate_traces`
- `knowledge_usage_events`
- `context_compile_evals`
- `context_compile_runs.status`
- `context_compile_candidate_traces.agentic_decision`
- `context_compile_candidate_traces.community_key`
- `context_compile_candidate_traces.selected`
- `context_compile_candidate_traces.suppressed`
- `context_compile_candidate_traces.suppression_reason`

Decision での用途:

- `used` が多い Knowledge は support を強める。
- `wrong` / `off_topic` がある Knowledge は risk / counter evidence を強める。
- `not_used` が多い Knowledge は direct execute の根拠として弱める。
- `suppressed` / `agenticDecision=rejected` は support として使う前に confidence cap をかける。
- compile eval が `misleading` / `unused` の run によく出た Knowledge は negative signal として扱う。

### graph / community signals

既に利用可能なデータ:

- `GraphCommunitySummary.communityKey`
- `communityRank`
- `size`
- `compileSelectCount`
- `sourceRefDensity`
- `embeddedCount`
- `staleNodeCount`
- `health.dead`
- `health.stale`
- `health.thinEvidence`
- `knowledge_community_labels`

Decision での用途:

- 同一 community から複数 support が出た場合、単独ヒットより support confidence を上げる。
- `thinEvidence` community は confidence cap をかける。
- `stale` community は freshness cap をかける。
- `dead` community は direct execute の根拠にしない。
- community が過度に分散している場合は根拠が散っているとみなし、`revise_and_execute` へ寄せる。

### landscape / attractor signals

既に利用可能なデータ:

- `LandscapeCommunity.classification.primary`
- `strong_attractor`
- `useful_attractor`
- `negative_attractor_candidate`
- `over_selected_not_used`
- `dead_zone_reachability_risk`
- `dead_zone_stale`
- `feedback_insufficient`
- `wrong_review_required`
- `scores.attractorScore`
- `scores.negativeScore`
- `scores.reachabilityRiskScore`
- `feedback.usedRate`
- `feedback.notUsedRate`
- `feedback.offTopicRate`
- `feedback.wrongRate`
- `representativeKnowledgeIds`
- `risks`

Decision での用途:

- `strong_attractor` / `useful_attractor` は support boost。
- `negative_attractor_candidate` / `wrong_review_required` は reject / revise boost。
- `over_selected_not_used` は direct execute を弱め、`revise_and_execute` に寄せる。
- `dead_zone_reachability_risk` は参考信号として扱い、support にはしない。
- `dead_zone_stale` は confidence cap。
- `feedback_insufficient` は confidence cap と追加 feedback 推奨。

## 設計方針

### Signal Bundle

Decision の各 evidence candidate に、次の optional signal を付与する。

```ts
type DecisionSignalBundle = {
  compile?: {
    compileSelectCount: number;
    recentSelectedCount: number;
    usedCount: number;
    notUsedCount: number;
    offTopicCount: number;
    wrongCount: number;
    suppressedCount: number;
    rejectedByAgenticCount: number;
    misleadingEvalCount: number;
  };
  community?: {
    communityKey: string | null;
    communityLabel: string | null;
    communityRank: number | null;
    sourceRefDensity: number | null;
    compileSelectCount: number;
    health: {
      dead: boolean;
      stale: boolean;
      thinEvidence: boolean;
    };
  };
  landscape?: {
    classification: string | null;
    confidence: "low" | "medium" | "high" | null;
    attractorScore: number;
    negativeScore: number;
    reachabilityRiskScore: number;
    usedRate: number;
    notUsedRate: number;
    offTopicRate: number;
    wrongRate: number;
    flags: string[];
  };
};
```

この情報は、まず `confidenceTrace` と evidence metadata に保存する。MCP result の top-level shape は維持する。

### Decision Signal Repository

新規 module 候補:

- `src/modules/context-decision/context-decision.signals.ts`
- `src/modules/context-decision/context-decision.signals.repository.ts`
- `src/modules/context-decision/context-decision.signals.repository.sqlite.ts`

責務:

- selected/counter/risk/preference evidence の knowledge IDs を受け取る。
- compile usage / feedback / candidate traces を取得する。
- knowledge ID から communityKey を解決する。
- landscape snapshot から該当 community の classification と scores を取得する。
- Decision service に `Map<knowledgeId, DecisionSignalBundle>` を返す。

初期実装では、signal 取得失敗は Decision 実行を止めない。`confidenceTrace.signalStatus` に `partial` / `failed` を記録する。

## 実装マイルストーン

### M0: baseline と評価 fixture

目的: 90 点以上を評価できる土台を作る。

実装:

- `test/context-decision.calibration.test.ts` を追加する。
- 次の fixture を作る。
  - minimal safe execute
  - risky reject
  - counter evidence revise
  - negative attractor revise
  - strong attractor execute
  - over selected not used revise
  - stale/thin community cap
  - retrieval failure escalate persisted
- 現状スコアを記録し、M1 以降の改善で期待値を上げる。

検証:

- 現状は一部 failing または TODO expectation でもよい。
- 最終 milestone では全 fixture が通る。

### M1: feedback target を decision-aware に修正

目的: 学習ループの誤強化を止める。

実装:

- `listSelectedSupportKnowledgeIds()` だけに依存しない。
- final decision ごとに feedback 対象 evidence role を選ぶ。

対応表:

| final decision | Good の主対象 | Bad の主対象 |
|---|---|---|
| `execute` | `selected_support`, `user_preference` | `selected_support` |
| `revise_and_execute` | `risk_warning`, `counter_evidence`, verification-related evidence | selected support if revision was unnecessary |
| `reject` | `risk_warning`, `counter_evidence` | risk/counter if reject was wrong |
| `rollback` | risk/counter/failed prior evidence | rollback-driving evidence |
| `discard` | risk/counter/off_topic evidence | discard-driving evidence |
| `escalate` | missing/weak coverage signal | escalation-driving evidence |

検証:

- Good `reject` が support を boost しない。
- Good `reject` が risk/counter evidence を boost する。
- Bad `execute` が selected support を penalize する。

### M2: counter evidence を first-class evidence にする

目的: counter evidence を scoring だけでなく、保存・表示・LLM prompt・feedback に接続する。

実装:

- `ContextDecisionEvidenceRole` に `counter_evidence` を追加する。
- `counterHits` の上位を `evidenceCandidates` に含める。
- `buildKnowledgeBriefs()` と prompt に `Counter Evidence` section を追加する。
- UI の `Knowledge Used` と `Risk Evidence` とは別に counter evidence を表示する。
- feedback target の対象 role に含める。

検証:

- counter evidence のみで `revise_and_execute` または `reject` に寄る。
- final answer が counter evidence の具体的根拠を説明する。
- counter evidence が coverage だけでなく evidence rows に残る。

### M3: compile signals を Decision scoring に統合

目的: Decision が過去 compile の「実際に使われた/間違っていた」情報を使う。

実装:

- evidence knowledge IDs から compile signals を取得する。
- `scoreContextDecision()` に compile support boost / penalty を入れる。
- `ContextDecisionKnowledgeAssessment` に compile signal summary を追加する。
- `confidenceTrace.compileSignals` を保存する。

初期 rule:

- `usedCount > 0` かつ `wrongCount = 0` なら support boost。
- `wrongCount > 0` は blocking risk。
- `offTopicCount > 0` は reject/revise boost。
- `notUsedRate` が高い場合は direct execute を弱める。
- `suppressedCount` が多い場合は confidence cap。

検証:

- compile `wrong` がある support は execute にならない。
- compile `used` が安定している support は weak coverage でも confidence が上がる。
- `off_topic` が多い Knowledge は risk/counter 扱いになる。

### M4: graph/community/landscape signals を統合

目的: community 単位の構造的信頼度を Decision に入れる。

実装:

- knowledge ID から communityKey を解決する。
- graph community health を取得する。
- landscape snapshot から該当 community の classification / scores / rates を取得する。
- `confidenceTrace.communitySignals` と `confidenceTrace.landscapeSignals` を保存する。

初期 rule:

- `strong_attractor` は support boost。
- `useful_attractor` は moderate support boost。
- `negative_attractor_candidate` は reject boost。
- `wrong_review_required` flag は reject boost。
- `over_selected_not_used` は revise boost。
- `dead_zone_stale` は confidence cap。
- `thinEvidence` は confidence cap。
- `dead` は support evidence として使わない。

検証:

- negative attractor community の support hit は execute にならない。
- strong attractor community の support は execute に寄る。
- stale/thin community は confidence cap が入る。

### M5: reliability gate を signal-aware に拡張

目的: LLM が signal を無視しても、最終判断を安全側に補正する。

追加 rule:

- `compile_wrong_requires_revision`
- `compile_off_topic_requires_revision`
- `negative_attractor_requires_revision`
- `wrong_review_required_requires_revision`
- `dead_community_requires_revision`
- `over_selected_not_used_requires_revision`
- `thin_community_caps_confidence`
- `stale_community_caps_confidence`
- `strong_attractor_supports_execute`

検証:

- 各 rule が `reliabilityGate.appliedRules` に残る。
- blocking rule がある場合、LLM が `execute` を返しても final decision が `reject` または `revise_and_execute` になる。

### M6: agentMessage validator と failed run persistence

目的: Decision result と返却文言の矛盾をなくし、失敗時も監査可能にする。

実装:

- final decision と `agentMessage` の post-check を追加する。
- `reject` / `rollback` / `discard` / `escalate` で proceed claims があれば fallback message に差し替える。
- `searchKnowledge` / signal repository / LLM 失敗時に `decision=escalate`, `status=failed` or `degraded` の run を保存する。

検証:

- `reject` なのに「進めます」「execute」などを含む LLM answer は fallback になる。
- retrieval failure でも Decision run が残る。
- MCP response は既存 shape を維持する。

### M7: calibration と 90 点 gate

目的: 90 点以上の品質を継続的に守る。

実装:

- calibration fixture の期待 decision / confidence band / appliedRules / feedback effect を固定する。
- `bunx vitest run test/context-decision*.test.ts` に加えて calibration test を代表 gate に含める。
- 必要なら `doctor` に Decision signal health を追加する。

合格条件:

- calibration fixture で 90 点以上。
- `reject` stop semantics の回帰なし。
- feedback target の誤強化なし。
- signal 取得失敗時も fail closed かつ auditable。

## 実装順序

推奨順:

1. M0 baseline と calibration fixture
2. M1 feedback target 修正
3. M2 counter evidence first-class 化
4. M6 agentMessage validator と failed run persistence
5. M3 compile signals
6. M4 graph/community/landscape signals
7. M5 reliability gate 拡張
8. M7 90 点 gate

M1、M2、M6 は現行の明確な不具合リスクを潰すため先に行う。M3 以降は精度改善であり、段階的に signal を追加する。

## API / MCP 互換方針

MCP `context_decision` response の top-level fields は維持する。

維持する fields:

- `decisionId`
- `decision`
- `mandate`
- `confidence`
- `agentMessage`
- `feedbackHandle`
- `coverageSummary`

追加情報は原則として persisted detail に入れる。

- `confidenceTrace.compileSignals`
- `confidenceTrace.communitySignals`
- `confidenceTrace.landscapeSignals`
- evidence metadata の `signals`
- coverage scope の `signalStatus`

UI と REST detail API は additive change とする。

## 検証コマンド

段階ごとの基本検証:

```bash
bunx vitest run test/context-decision*.test.ts
bun run typecheck
```

signal 統合後:

```bash
bunx vitest run test/context-decision*.test.ts test/landscape-*.test.ts test/context-compiler*.test.ts
bun run test:sqlite-runtime
```

最終確認:

```bash
bun run verify
```

## リスクと対策

| リスク | 対策 |
|---|---|
| signal が多すぎて判断が不透明になる | `confidenceTrace` に rule-by-rule で保存し、agentMessage には主要理由だけ出す |
| landscape snapshot 生成が重い | cache 済み snapshot を優先し、失敗時は partial signal として扱う |
| compile feedback が少なく偏る | feedback confidence を持ち、少数 signal は cap に使いすぎない |
| community signal が古い | `labelUpdatedAt` / snapshot freshness を見て confidence cap にする |
| LLM が signal を無視する | reliability gate で final decision を補正する |
| 既存 MCP caller が壊れる | top-level response を維持し、追加情報は detail/trace に限定する |

## 完了定義

- Decision 関連テストと calibration test が通る。
- `reject` Good が support を誤って boost しない。
- `counter_evidence` が evidence row と prompt に入る。
- compile wrong/off_topic が final decision に影響する。
- negative attractor / wrong_review_required が execute を止める。
- strong/useful attractor が support の信頼度を上げる。
- stale/thin/dead community が confidence cap か support 除外に使われる。
- retrieval / LLM / signal failure が auditable な failed/degraded Decision run として残る。
- `bun run verify` が通る。
