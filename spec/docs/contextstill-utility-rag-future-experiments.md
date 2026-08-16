# ContextStill Utility-RAG Future Experiments

## Status

- Status: Experiment Backlog / Concept Notes
- Parent concept: [ContextStill Utility-RAG Concept](./contextstill-utility-rag-concept.md)
- Version: 0.2
- Last updated: 2026-08-16

この文書は、Utility-RAGの初期導入には含めないが、eligible corpus、独立label、online outcome、latency budgetが整った時点で試す価値のある案を保存する。

ここに記載した案はroadmap commitmentではない。各案は、より単純なbaselineとのpaired comparison、repository isolation、rollback、end-to-end latencyを満たした場合だけparent conceptへ昇格する。

---

## 1. Experiment Admission Rules

Experimentを開始する前に、最低限次を確認する。

- Retrievalまたはranking experimentでは、eligible corpusとcandidate capの組み合わせが比較armを実質同一にせず、順位またはrecall差を測定できる。
- Hard query setに、対象案が改善すると予測するquery cohortがある。
- Primary outcomeをComposer自己申告だけに依存しない。
- Current fallbackと比較可能なfeature flag、trace、rollbackがある。
- External LLMを使う場合、logical call、provider attempt、fallback-route failover、SDK内部retryがあればその回数、input/output token、phase latencyを記録する。
- Scopeとclassificationをcandidate limitより前に適用する。
- より単純な代替を同じcohortで比較する。

各experimentは開始前にmanifestを作り、次を固定する。

- experiment ID、version、owner、state
- hypothesisと対象cohort
- baselineとtreatment
- primary metricとguardrail metrics
- sample size、minimum detectable effect、non-inferiority margin、confidence interval
- observation window、停止条件、rollback条件
- promote、defer、rejectの判定条件

結果を見た後にmanifestを変更した場合は、同じexperimentの継続ではなく新versionとして再実行する。

Metricの「改善」と「非劣化」は、parent concept §25のoriented paired differenceとconfidence intervalの定義に従う。

---

## 2. Experiment Register

Stateは次の4種類を使う。

- Parked: 仮説はあるが開始条件を満たしていない。
- Ready: manifest、cohort、instrumentationが揃い、実行可能。
- Running: versioned manifestに従って観測中。
- Closed: Promote、Defer、Rejectのdecisionとevidenceが保存済み。

| ID | Experiment | Initial state | Earliest readiness trigger |
|---|---|---|---|
| E1 | Query-side BM25 / BM25Q | Parked | Core v1 lexical baselineとlong-query hard setが固定済み |
| E2 | Japanese morphological tokenizer | Parked | CJK failure cohortとindex rebuild budgetが固定済み |
| E3 | Planner call as listwise reranker | Parked | Phase 0 call telemetryとPhase 1 candidate poolが利用可能 |
| E4 | Deterministic Context Pack default | Parked | Structured delivery textとindependent quality reviewが利用可能 |
| E5 | Controlled randomized exploration | Parked | Propensity logging、safety monitor、即時rollbackが利用可能 |
| E6 | Online interleaving | Parked | 独立online outcomeと同一candidate universeが利用可能 |
| E7 | Monotone coverage objective | Parked | Coverage keyの品質とPhase 4 baselineが固定済み |
| E8 | UDCG-style annotation | Parked | Independent annotatorとannotation guidelineが利用可能 |
| E9 | Bi-temporal Knowledge validity | Parked | Lifecycle use caseとmigration ownerが明確 |
| E10 | Advanced semantic retrieval | Parked | Scoped dense vector後にも残るrecall gapが再現可能 |
| E11 | Materialized Context Capsule | Parked | Repeated useful membershipとinvalidation telemetryが利用可能 |

Initial stateは文書作成時点の値である。状態変更はevidence linkとmanifest versionを伴う別更新として記録する。

---

## 3. Query-side BM25 and Lexical Fusion

### Hypothesis

長い自然文goalでは、document側だけでなくquery側のterm frequency saturationとlength normalizationを行うBM25Qが、標準BM25よりreasoning termを適切に重み付けできる可能性がある。

### Compare

1. Unicode normalized-term BM25
2. Trigram FTS
3. Standard BM25 + BM25Q fusion
4. Exact identifier / short CJK LIKEを含む現行lexical bundle

### Promote when

- Japanese / English mixed long-query cohortでRecall@KまたはnDCG@Kが再現可能に改善する。
- Exact identifier hit rateを悪化させない。
- Query-side処理を含むretrieval p95がbudget内である。

### Do not promote when

- BRIGHT型の長いqueryだけで改善し、通常coding goalへ汎化しない。
- 標準BM25との単純fusionで同等結果が得られる。

---

## 4. Japanese Morphological Tokenizer

### Hypothesis

Lindera等のRust-native形態素解析tokenizerは、Unicode normalized term、trigram、短いCJK LIKEより日本語のprecision / recall balanceを改善できる可能性がある。

### Preconditions

- 1から2文字CJK、複合語、technical identifierを含むhard queryがmanifestのsample sizeを満たす。
- Eligible corpusとcandidate capが、tokenizer間の差を測定できる。

### Compare

- Unicode word index
- Trigram index
- Short-token LIKE fallback
- Morphological tokenizer with dictionary/version pinning

Dictionary size、build reproducibility、index rebuild時間、unknown technical termの扱いも測る。

---

## 5. Reuse the Planner Call as a Listwise Reranker

### Hypothesis

現行planner callをcandidate generation後のlistwise rerankへ再配置すると、logical LLM call数を増やさず、現在の構成planよりretrieval qualityへ直接寄与できる可能性がある。

### Compare

1. Deterministic formatter、plannerなし
2. Explainable local ranker + single compose
3. Current planner + compose
4. Planner slotをlistwise rerankへ再利用 + compose

### Required evidence

- Candidate generation後の同一候補集合を使う。
- Hard-set must include / must not include、blind human preference、task outcomeを比較する。
- PlannerとComposerのprovider attempt、fallback-route failover、latencyを分離する。
- Reranker failure時はRRF orderへfallbackする。

### Risk

- Provider latencyとsilent rerank errorが増える。
- Candidate bodyの追加送信でtoken costが増える。
- LLMがrepository eligibilityを上書きしてはならない。

---

## 6. Deterministic Context Pack as the Default Path

### Hypothesis

Density Selectorとstructured delivery textが十分な品質に達すれば、LLM Composerをcritical pathから外し、deterministic Context Packをdefaultにできる可能性がある。

### Compare

- Deterministic section formatter
- Single-call compose
- Planner + compose

### Promote when

- Hard-set coverage、human actionability、verification completeness、guardrail safetyが非劣化である。
- End-to-end p50 / p95とfailure rateが改善する。
- Canonical Knowledge、source、condition、exceptionを欠落しない。

Composer unavailable時のfallback smokeだけでは昇格根拠にしない。通常cohortで同じ品質gateを通す。

---

## 7. Controlled Randomized Exploration

### Hypothesis

Bounded randomized exposureとpropensity logにより、deterministic top-Kでは観測できないcandidateのutilityを推定し、behavioral co_useful edgeやlearned rankerのposition biasを軽減できる。

### Preconditions

- Repository isolationとhard negative testが0 violationである。
- User-visibleなwrong / off_topicを監視し即時停止できる。
- Policy version、slot、exposure probability、selection、use、outcomeを一貫して保存できる。
- Exploration対象にmanifestで定義したrelevance / safety thresholdを適用できる。

### Initial shape

- 固定の1 slotへ直ちに決めず、offline replayでslot数と確率を選ぶ。
- Must-include候補、negative guardrail、repository-specific constraintを探索で追い出さない。
- Shadow trace-onlyをexploration outcomeとして扱わない。

### Promote when

- Propensity-aware推定が独立human / task outcomeと方向一致する。
- Wrong / off_topicとuser-visible qualityを悪化させない。

---

## 8. Online Interleaving for Rank-only Comparisons

### Hypothesis

独立click / action / task signalがmanifestのsample sizeを満たした場合、rank-onlyのcandidate ordering比較ではteam-draft interleavingがA/Bより高感度になる可能性がある。

### Scope limitation

- Phase 1から3のうち、同一candidate universeに対するrank orderingだけを対象候補とする。Graph expansion等のcandidate generation差分には適用しない。
- Density Selectorのようなset-level optimizationには適用しない。
- Composer自己申告だけをwinner signalにしない。

現時点では独立online actionが疎であるため、初期評価手法には採用しない。

---

## 9. Monotone Coverage Objective

### Hypothesis

Density Selectorの目的をweighted coverage中心の単調submodular関数へ制約し、riskをeligibilityへ移すと、selection挙動を解析しやすくできる可能性がある。

### Compare

- 現行の説明可能なmarginal utility / token
- Weighted coverage saturation
- Greedy + best singleton
- 小規模fixtureでのexhaustive optimum

理論保証を採用理由にする前に、実際のcoverage key品質、non-monotone exception、regretを検証する。特定の近似率を根拠なしに主張しない。

---

## 10. UDCG-style Independent Utility Annotation

### Hypothesis

Relevant / not relevantだけでなく、useful、neutral、distracting、harmfulを独立annotatorが付けると、Context Packのend-to-end utilityをnDCGより良く予測できる可能性がある。

### Initial mapping candidate

- useful: must includeを満たし、task decisionへ寄与
- neutral: 正しいが追加価値がない
- distracting: off_topicまたはredundantでattentionを消費
- harmful: wrong、stale、cross-repository、危険なguardrail欠落

Current `used` / `not_used` / `off_topic` / `wrong`を自動的にgoldへ変換しない。Independent reviewとの一致率を先に測る。

---

## 11. Bi-temporal Knowledge Validity

### Hypothesis

Knowledgeにvalid timeとtransaction timeを分けて持たせると、supersede、stale、過去run再現をheuristic freshness penaltyより明確に扱える可能性がある。

### Questions

- `valid_from` / `invalid_at`を誰が確定するか。
- Sourceの時点とKnowledge distillation時点をどう区別するか。
- 過去run snapshotとbi-temporal queryの責務をどう分けるか。
- Correction時にcanonical rowを更新するか、新versionを作るか。

Schema migrationとauthoring workflowの影響が大きいため、retrieval rolloutから分離する。

---

## 12. Advanced Semantic Retrieval

### Candidate experiments

- ColBERT-style late interaction
- Local cross-encoder
- Multi-vector field representation
- Query / document contextual embeddings

### Preconditions

- FTS + exact + facet + scoped dense vectorで残る明確なrecall gapがある。
- Gapを表すhard query setとindependent labelsがある。
- Storage、rebuild、cold start、runtime latencyを含むend-to-end budgetがある。

単にsemantic matchingが高度であることは採用理由にしない。

---

## 13. Context Capsule with Materialized Text

### Hypothesis

同じKnowledge集合が独立outcomeで繰り返し有用と確認された場合、versioned compact textを持つCapsuleがtokenとComposer latencyを削減できる可能性がある。

### Preconditions

- Membershipがdeterministic exposure biasだけで形成されていない。
- Member version、scope、supersede、source updateで確実にinvalidateできる。
- Canonical memberとprovenanceへ逆参照できる。

初期はmembership shortcutだけを比較し、materialized summaryはcompression safety review後に試す。

---

## 14. Evidence and Reading List

次はexperiment hypothesisの出発点であり、ContextStillへの外的妥当性を保証しない。各experimentは対象cohortで再検証する。

- Compute Allocation for Reasoning-Intensive Retrieval Agents, arXiv preprint; BRIGHT / Gemini 2.5条件: https://arxiv.org/abs/2603.14635
- UDCG, Utility and Distraction-aware Cumulative Gain; five datasets / six LLMs: https://aclanthology.org/2026.eacl-long.391/
- Lighting the Way for BRIGHT, SIGIR 2026; BM25Qの利得は主にBRIGHT固有で、標準BM25とのfusionがより一貫: https://doi.org/10.1145/3805712.3808570
- Airbnb interleaving and counterfactual evaluation, KDD 2025; user actionを持つsearch ranking条件: https://doi.org/10.1145/3711896.3737232
- A Refined Analysis of Submodular Greedy: https://arxiv.org/abs/2102.12879
- Graphiti bi-temporal model: https://github.com/getzep/graphiti
- Lindera SQLite tokenizer: https://docs.rs/lindera-sqlite/latest/lindera_sqlite/
- ColBERTv2: https://arxiv.org/abs/2112.01488
