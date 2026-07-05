# Knowledge / Episode Maintenance Threshold Concept

Status: concept
Created: 2026-07-06

## Purpose

Knowledge と Episode の蓄積が十分に増えた後だけ有効になる、機械学習・統計的メンテナンス機能の考え方を定義する。

この文書は実装計画ではない。0 ベースの初期状態では動かさない機能を、どの蓄積量から概念上成立するかで整理する。

## Current Snapshot

2026-07-06 時点の local SQLite では、次の規模が確認できている。

| Metric | Count |
|---|---:|
| total knowledge | 6,937 |
| active knowledge | 6,879 |
| knowledge with embedding rows | 6,900 |
| knowledge usage events | 22,852 |
| knowledge with usage | 2,178 |
| context compile candidate traces | 54,942 |
| context compile evals | 3,162 |
| active EpisodeCards | 4,856 |
| episode retrieval feedback events | 3,978 |
| EpisodeCards with feedback | 297 |

直近 30 日 / 500 compile run の baseline では、active knowledge の cold rate は 69.7%、Episode selection rate は 2.2% だった。

この状態では、Knowledge 側は近傍比較・未使用検出・間引き候補抽出を試せる。Episode 側はカード数は十分だが feedback 付き Episode が少ないため、削除や間引きより露出探索と評価ログ作りを優先する。

## Core Principle

Maintenance intelligence is a late-stage feature.

Knowledge や Episode が少ない状態では、機械学習・統計的メンテナンスは価値より誤判定のリスクが大きい。したがって、次の状態では機能を起動しない。

- 初期セットアップ直後。
- knowledge / episode が 1,000 件未満。
- usage / feedback / compile eval などの評価ログが不足している。
- 変更前 baseline を採取できない。
- 露出ログ、選出ログ、評価ログのいずれかが欠けている。

件数未達時は「何もしない」が正しい挙動である。UI や doctor に出す場合も、エラーではなく `Not enough data` として扱う。

## Activation Levels

| Level | Meaning | Minimum data shape | Allowed behavior |
|---|---|---|---|
| L0: empty | ほぼ初期状態 | knowledge / episode が 1,000 件未満 | 機能を無効化する |
| L1: observable | 候補数はあるが評価が薄い | 対象 1,000 件以上、評価ログは不足 | 露出ログと baseline だけ作る |
| L2: analyzable | 統計的な比較ができる | 対象 1,000 件以上、評価ログ 1,000 件以上 | 候補抽出と review item 化を許可 |
| L3: actionable | 間引き判断の根拠がある | 評価済み対象 1,000 件以上、直近 baseline 100 run 以上 | demote / merge / suppress 候補を出す |
| L4: automated assist | 安全な補助自動化ができる | L3 に加えて drift monitor と rollback 条件あり | 自動提案まで許可し、削除は人間確認を維持 |

削除や非表示は L3 以上でも直接実行しない。まず review item、demote candidate、merge candidate、露出抑制候補として扱う。

## Top Use Cases And Thresholds

| Rank | Use case | Applies to | Minimum border | Do not run when |
|---:|---|---|---|---|
| 1 | Near-neighbor Champion / Challenger comparison | Knowledge | embedding 1,000 件以上、usage 5,000 件以上、比較ペアごとに評価 5 件以上 | embedding または usage が薄い |
| 2 | Dead Knowledge Detector | Knowledge | active knowledge 1,000 件以上、未選出 100 件以上、30 日 baseline あり | 初期投入直後、または未選出が自然な状態 |
| 3 | Interleaving Exposure Test | Knowledge / Episode | 直近 compile run 100 件以上、compile eval 50 件以上、比較候補ペア 50 組以上 | 露出ログを保存できない |
| 4 | Cluster Dominated Item detection | Knowledge | embedding 2,000 件以上、クラスタ内に評価済み item が複数ある | 近傍はあるが評価差がない |
| 5 | Episode exploration allocation | Episode | EpisodeCard 1,000 件以上、feedback 不足時は探索のみ | feedback 100 件未満で間引き判断する |
| 6 | Over-selected but not-used detection | Knowledge | 選出 3 回以上、feedback 5 件以上、not_used rate 70% 以上 | feedback 5 件未満 |
| 7 | Knowledge decay score | Knowledge | 更新日、選出数、usage、根拠リンク、近傍代替が揃う | 古さだけで判断する |
| 8 | Near-duplicate canonicalization | Knowledge | 類似度 0.85 以上、title/body 類似、片方に明確な usage 優位 | 類似度だけで merge する |
| 9 | Retrieval blind spot finder | Knowledge | importance / confidence が高い未選出が 100 件以上 | knowledge が少なく未選出が自然な状態 |
| 10 | Evaluation drift monitor | Knowledge / Episode | 変更前 baseline run 100 件以上、compile eval 50 件以上 | baseline なしで rerank / suppress する |

These thresholds are concept gates, not tuning constants. 実装時に調整してよいが、しきい値未満では機能を silent no-op にする原則は維持する。

## Knowledge-Specific Concept

Knowledge は現時点で L3 に近い。蓄積量、embedding、usage、compile trace、compile eval が揃っているため、次の用途は概念上成立する。

- 近傍ペア比較。
- cold knowledge の dead-zone 検出。
- over-selected / not-used の抽出。
- duplicate / canonical candidate の検出。
- retrieval blind spot の検出。
- rerank や間引き前後の evaluation drift 監視。

ただし、削除は最終アクションにしない。最初の出力は次のいずれかに限定する。

- `review_only`
- `demote_to_draft_candidate`
- `split_or_merge_review`
- `repair_reachability`
- exposure suppression candidate

## Episode-Specific Concept

Episode は件数だけ見れば十分だが、feedback 付き EpisodeCard が少ない。このため、現時点の主目的は品質判定ではなく評価ログ作りである。

Episode に対して許可すること:

- 少量の exploration exposure。
- `used` / `not_relevant` feedback の収集。
- direct / analogical retrieval lane の観測。
- 高 `not_relevant` 率の Episode を review 候補にする。

Episode に対してまだ許可しないこと:

- feedback 不足の状態での削除。
- 類似度だけによる deprecated 判断。
- Episode を source truth として扱う判断。
- raw log の代替として Episode だけを根拠にする判断。

Episode の間引き判断は、feedback 付き EpisodeCard が 1,000 件以上、または `used` / `not_relevant` がそれぞれ 500 件程度揃ってから扱う。

## Behavior Below Threshold

しきい値未満の状態では、各機能は次のように振る舞う。

- UI: `Not enough data` を表示する。
- API: empty result と reason を返す。
- CLI: dry-run summary のみ返す。
- background worker: job を claim しない。
- doctor: failure ではなく optional improvement として表示する。

件数未達をエラーにしない。初期状態のユーザーに、壊れているように見せないことが重要である。

## Non Goals

- この文書では実装順序を定義しない。
- 具体的な library / model を確定しない。
- 0 ベースから動く機能として扱わない。
- しきい値未満で自動補正、自動削除、自動 deprecated を行わない。
- Episode を source truth として扱わない。
- 予測精度だけを成功条件にしない。

## Concept-Level Success Criteria

このコンセプトが成立している状態は次の通り。

- 件数未達では no-op になる。
- 件数到達後も、最初の出力は review / demote / merge / suppress 候補に留まる。
- 削除や deprecated は、baseline と後続評価で安全性を確認してから扱う。
- Knowledge と Episode の maturity 差を混同しない。
- 機能が空 DB や初期導入の価値を下げない。
