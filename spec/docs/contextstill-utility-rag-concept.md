# ContextStill Utility-RAG Concept

## Status

- Status: Discussion Draft / Architecture Concept
- Concept ID: contextstill-utility-rag-v1
- Version: 0.3
- Last updated: 2026-08-16
- Applies to: ContextStill SQLite local runtime, context-stilld native MCP, Context Compiler
- Primary decision: adopt bounded hybrid retrieval and a purpose-built Utility Graph; do not adopt a general-purpose semantic Knowledge Graph as the runtime retrieval core

この文書は、ContextStillの現行RAGを置き換えず、検索性能を維持または改善しながら、検索精度、関係知識の発見能力、出力の情報密度を高めるための共通コンセプトを定義する。

この文書の中心命題は次の通りである。

> ContextStillが最適化すべき対象は、意味的に近い文書の件数ではない。与えられたtaskに対して、実際に使える、根拠付きで、重複の少ない、最小のKnowledge集合を、厳格なlatencyとtoken budgetの中で構成することである。

この構想をUtility-RAGと呼ぶ。

Utility-RAGは、FTS、Vector Search、Facet Search、Episode Retrieval、限定的なGraph Expansionを候補生成手段として使う。ただし、最終目的は各retrieverのscore最大化ではない。Task coverage、historical utility、provenance、freshness、novelty、risk、token costを考慮し、期待効用が最大になるContext Packを選ぶ。

この文書は詳細実装計画ではない。最終的なphysical schema、migration番号、embedding model、ranking weight、feature flag名、module分割を確定しない。一方、後続の実装計画とcode reviewが守るべき設計境界、性能条件、評価方法、段階導入順序を定義する。

この文書では、採用状態を次のように区別する。

- Required foundation: 後続laneより先に完了するPhase 0 / 0.5の測定、安全境界、現行ranking補正。
- Core v1 lane: 最初にpromotion対象とするFTS、exact identifier、facet、RRF。
- Conditional lane: data-readinessと個別gateを満たした場合だけpromoteするVector、Utility Graph、Density Selector。
- Deferred experiment: 初期roadmapへ含めず、別文書で再評価条件を管理する案。

Conditional laneがgateを満たさずshadowまたはdisabledのままでも、Required foundationとCore v1 laneの成立を否定しない。

---

## 1. Review Request

この文書をレビューするAIまたは人間は、文章の一般的な改善より、次の設計上の誤りを優先して指摘する。

1. 現行runtimeの読み違い
   - activeなRust native MCP経路と、inactiveまたはsidecarのTypeScript経路を混同していないか。
2. 性能条件の不備
   - network LLM、embedding、SQLite writer queue、index rebuild、cold startを含むend-to-end costを過小評価していないか。
3. 評価の循環性
   - composer自身が作ったused/not_usedやagent generated compile_evalを、独立した正解ラベルとして扱っていないか。
4. Repository isolation
   - candidate limitより前にscopeとclassificationが適用され、別repositoryの候補が混入しないか。
5. Graph drift
   - popularity bias、誤ったco-selection、stale edge、誤ったmulti-hopによってsemantic driftを起こさないか。
6. 情報圧縮による欠落
   - delivery textの短縮が、条件、例外、verification、provenanceを失わせないか。
7. Rollback可能性
   - 新しいlaneを個別に無効化し、既存のlexical経路へ即時復帰できるか。
8. より単純な代替
   - 同等の効果を、Graphや新schemaなしで達成できないか。

レビュー指摘には、可能であれば次を含める。

- Priority: P0 / P1 / P2
- Affected section
- Broken assumption or failure scenario
- Evidence
- Smallest safe correction
- Promotionをblockする問題か、follow-upでよい問題か

---

## 2. Executive Decision

ContextStillは、Semantica型の汎用GraphRAG基盤へ移行しない。

代わりに、次の構成を採用候補とする。

1. SQLite FTS5を使うscope-aware lexical retrieval。
2. scope metadataを持つSQLite Vector retrieval。
3. exact identifierとtask facetを扱うdeterministic retrieval。
4. 各laneのrankをReciprocal Rank Fusionで統合するcandidate fusion。
5. Knowledge間のtask utilityだけを表現するbounded Utility Graph。
6. relevanceではなくmarginal utility per tokenで選ぶDensity Selector。
7. 現行のplanner / Composer経路を増やさず、必要なら削減して使う最終構成。
8. exposure、selection、use、outcomeを分離したfeedback loop。

Graphはprimary source of truthではなく、direct retrievalで得たseedを補強する追加laneとする。Graphだけで候補を生成しない。online traversalは原則1-hop、固定fan-out、固定candidate capとする。

検索時に新しいLLM callを追加しない。現行runtimeが行うplannerとComposerのlogical call、各provider attempt、fallback-route failoverを別々に計測し、deterministic構成、1-call構成、現行2-call構成を同じcohortで比較する。Query expansion、Knowledge atomization、relation extraction、compact delivery text、context capsuleは、必要なものだけをingestionまたはbackground processingで事前計算する。

---

## 3. Background

ContextStillの価値は、大量の文書を検索すること自体ではない。

ContextStillは、Sources、Agent logs、Episodes、Knowledge candidatesを蒸留し、再利用可能なRuleとProcedureとして保持し、現在のcoding taskに必要な最小Contextへcompileする。したがって、一般的なdocument QA RAGとは成功条件が異なる。

一般的なRAGでは、retrieval recallやanswer correctnessが主要指標になりやすい。ContextStillでは、さらに次が必要になる。

- Repository scopeを越えないこと。
- 現在のtaskに適用可能であること。
- Positive guidanceとNegative guardrailを混同しないこと。
- 古いKnowledgeやsuperseded Knowledgeを抑制すること。
- 実装手順だけでなくverificationとavoid条件を含むこと。
- Sourceと過去の利用実績を辿れること。
- Token budget内で重複が少ないこと。
- Agentが実際に使ったかを追跡できること。
- RetrievalやGraphが停止しても安全にdegradeできること。

Semanticaは、vector similarityとtyped graph relationship、multi-hop path、provenanceを組み合わせる方向性を示している。このうち、direct similarityだけでは拾えない関係知識をgraph proximityで補う考え方はContextStillにも有用である。

一方、ContextStillに必要なのは、Person、Organization、Eventなどの一般entityを中心としたworld modelではない。必要なのは、Rule、Procedure、Guardrail、Episode、Sourceが、あるtaskでどのように共同利用されるかを表すpurpose-bound projectionである。

---

## 4. Current Runtime Truth

### 4.1 Active path

2026-08-16時点で、activeなMCP context_compileはcontext-stilldのRust native実装を通る。

Rust native pathは概ね次の処理を行う。

1. goal、technologies、changeTypes、domains、project identityを読む。
2. eligible scope内のactive KnowledgeをSQLiteから読む。
3. titleとbodyに対する単純なsubstring/token matchへdynamic scoreを加える。
4. 上位8件を選ぶ。
5. Episodeを最大3件選ぶ。
6. Agentic Composerが設定されている場合、構成plan生成と最終composeを順次実行する。Composeが失敗してfallback providerへ進むと、次のproviderでplanとcomposeを再度試すため、provider attempt数は増える。
7. Run、Pack、Candidate Trace、Usage EventをSQLiteへ保存する。

このpathでは、SQLite上に作成済みのknowledge_items_ftsを検索に使用していない。Vector laneも使用していない。

現行の構成planは出力構成のために使われる。生成したquery hintを候補検索へ戻していないため、planner callをretrieval query expansionとして扱ってはならない。

### 4.2 TypeScript pathとの乖離

TypeScript側には、次のより高度な要素が存在する。

- intent / domain / combined query round
- positive / negative Knowledgeの分離
- text / vector candidate evidence
- rank and dedupe
- near duplicate suppression
- agentic refinement
- section token budget
- co-selection / exploration / negative inverseのutility trace

ただし、これらを存在するという理由だけでactive runtimeの能力として扱ってはならない。Rust native pathへ移植され、runtime smokeとtraceで確認されるまで、設計上の参考実装またはinactive capabilityとして扱う。

### 4.3 Provisional baseline

2026-08-16にlive SQLiteをread-onlyで調査したsnapshotの暫定値は次の通りである。運用中のDBは変化するため、この表を継続的なsource of truthにはせず、Phase 0の再現可能なbaseline reportで置き換える。

| Metric | Observed value | Caveat |
|---|---:|---|
| Active Knowledge | 7,180 | scope/classification別の利用可能数ではない |
| Active classified Knowledge | 98 | 全repository合計。通常検索へ入れる候補の上限 |
| Active unresolved Knowledge | 7,082 | fail-closedで通常検索から除外される |
| contextStill eligible Knowledge | 33 | global 29 + repo-path exact 4のpoint-in-time値 |
| Latest 500 compile p50 | 10,965 ms | row insertion orderで抽出 |
| Latest 500 compile p95 | 18,387 ms | LLM Composerを含む |
| Latest 500 compile p99 | 20,292 ms | provider状態の影響を含む |
| All recorded compile p50 | 12,088 ms | planner、Composer、provider attemptをphase分離していない |
| All recorded compile p95 | 19,870 ms | 同上 |
| All recorded compile p99 | 25,212 ms | 同上 |
| Selected Knowledge per run | 8.0 | native pathの固定上限 |
| Usage verdict used | 3,008 / 4,000, 75.2% | Composer自己申告でありhuman goldではない |
| Usage verdict not_used | 992 / 4,000, 24.8% | 同上 |

Snapshotの抽出contractは、Knowledge件数を`status`と`classification_status`で集計し、eligible件数にはactive Rust pathと同じ`eligible_scope_clause`を適用する。Latencyは`context_compile_runs.duration_ms`、usage比率は同じlatest-500 run cohortのusage eventを使用する。Phase 0ではquery text、DB fingerprint、取得時刻、row countをbaseline reportへ保存する。

このbaselineは最終的な採否判定には不十分である。eligible corpusはrepositoryとidentity match basisごとに大きく異なるため、全active件数をretrieval規模として使用しない。Unresolved 7,082件はrepository isolationを守るfail-closed分類の結果であり、全件解消をrollout blockerにはしない。一方、各repositoryで品質差を測れるeligible件数がなければ、そのlaneはshadowのままとする。

また、現在のcreated_atにはISO timestampとunix-ms prefix形式が混在し、一部reportがSQLite datetime関数でunix-ms形式を正しく扱えない。compile_select_countもactive Rust native pathで更新されないため、cold Knowledge rateをそのまま信用できない。

最初のimplementation phaseでは、time normalization、phase timing、counter update、runtime path identificationを修正し、再現可能なbaselineを作る。

---

## 5. Problem Statement

現行pathには、品質面と性能面で別々の問題がある。

### 5.1 Quality problems

- Token containmentだけでは、言い換え、暗黙の前提、関連する失敗事例を拾いにくい。
- title/bodyのraw text scoreは最大16である一方、dynamic scoreは0から100相当の尺度で加算される。Raw加算により、query matchが強くてもdynamic score差を逆転できない候補が存在する。
- FTS、Vector、Facetのscore scaleを比較できるfusion contractがない。
- Candidateを8件へ早期に切るため、rerankerが見る前に有用候補を失う可能性がある。
- Positive guidance、negative guardrail、prerequisite、verificationのcoverageを最適化していない。
- 上位候補間の重複を、最終token costと関連付けて評価していない。
- Historical feedbackは独立featureとしてcalibrateされず、dynamic scoreへ集約された状態でraw text scoreに直接加算される。
- Source-linked Knowledge、origin-linked Knowledge、unsupported Knowledgeの扱いが弱い。

### 5.2 Performance problems

- Read、external LLM call、writeが同じSQLite writer job内で行われる。
- Long-running Composer callがsingle writer queueを占有し得る。
- Read-only search toolもwriter pathを利用する箇所がある。
- Retrieval phase、queue wait、Composer phase、persistence phaseの時間が分離記録されていない。
- Planner、Composer、provider attempt、fallback-route failoverの回数と個別latencyが分離記録されていない。
- Query embeddingを追加した場合、provider latencyがそのままcritical pathへ入る恐れがある。
- Scopeを持たないvector top-Kを後段filterすると、correctnessかrecallのどちらかを失う。

### 5.3 Information density problems

Current top-Kは、各itemが新しく何を追加するかではなく、個別scoreだけで決まる。

そのため、次が起き得る。

- 同じ原則を言い換えたKnowledgeが複数入る。
- Workflowは多いがVerificationがない。
- General guidanceが多く、repository-specific constraintが埋もれる。
- Guardrailがpositive sectionを圧迫する。
- 長いProcedureがtoken budgetを使うが、現在taskに必要なのは一部だけである。
- 短いが根拠のないKnowledgeが、長いが重要なKnowledgeより有利になる。

必要なのは単純な要約ではない。必要条件、例外、確認方法、provenanceを維持したまま、重複を除き、task decisionに必要なdistinct informationを増やすことである。

---

## 6. Goals

### G1. Preserve or improve performance

- End-to-end context_compile latencyを悪化させない。
- Retrieval lane追加によってSQLite writer queueを長時間占有しない。
- EmbeddingまたはGraphが利用不能でも、FTS/facet経路へ即時fallbackする。
- Runtime LLM call数を増やさない。現行のplanner + Composerを固定前提にせず、deterministic構成または1-call構成への削減も比較する。

### G2. Improve retrieval recall without increasing composition input

- Candidate generation段階では現行8件より広い候補を探索する。
- Fusionとlightweight rankingで候補を絞り、composition routeへ渡すtoken数はcorrected baseline以下にする。
- Exact symbol、error、file path、Japanese query、semantic paraphraseのそれぞれを扱う。

### G3. Improve task coverage

- Workflow、Prerequisite、Verification、Failure、Avoidの不足を検出する。
- Positive、Negative、Episodeを別laneとして扱う。
- Relationからしか見つからないsupporting Knowledgeを限定的に追加する。

### G4. Improve information density

- Selected item数ではなく、useful information per tokenを最大化する。
- 重複するKnowledgeを抑制する。
- Retrieval向けの冗長な語彙と、LLMへ渡すcompact textを分離する。
- 圧縮されたstatementからsourceとfull bodyへ辿れるようにする。

### G5. Learn safely from feedback

- Retrieved、Selected、Used、Outcomeを別イベントとして記録する。
- Popularityだけで同じKnowledgeが強化され続けるfeedback loopを避ける。
- Wrong、off_topic、stale、supersededを明示的にpenalizeする。
- 新laneはshadow observationから始める。

---

## 7. Non-goals

この構想では次を行わない。

- Semanticaまたは他のGraph platformへの全面移行。
- RDF、OWL、SHACL、SPARQLをContext Compilerの必須runtimeにする。
- すべてのSourceから一般entityとrelationを抽出してworld modelを作る。
- Runtimeで任意深度のmulti-hop reasoningを行う。
- GraphだけでKnowledge candidateを決める。
- 検索ごとにLLM query expansionまたはcross-encoderを追加する。
- PostgreSQL parityをSQLite local rolloutのblockerにする。
- Coldまたは未選択という理由だけでKnowledgeを削除する。
- LLM Composerのused判定だけで自動的にKnowledgeをactive、deprecated、mergeする。
- Token削減を、coverageやcorrectnessより優先する。

---

## 8. Core Definition

Utility-RAGを次のように定義する。

~~~text
Given:
  task query Q
  repository scope S
  token budget B
  latency budget L
  candidate knowledge set K

Select:
  context set C subset of K

Maximize:
  expected task utility
  + required decision coverage
  + evidence and provenance strength
  + useful relation coverage
  - redundancy
  - stale or contradiction risk
  - token cost

Subject to:
  repository isolation
  token budget B
  latency budget L
  deterministic fallback availability
~~~

Utilityは単一の学習済みscoreではない。初期段階では、観測可能なfeatureを組み合わせた説明可能なrankingとgreedy selectionを使う。

---

## 9. Design Principles

### 9.1 Direct retrieval remains primary

FTS、exact match、facet、vectorがdirect seedを作る。Graphはseedを補強するだけで、seedがない状態から自由探索しない。

### 9.2 Scope before limit

Repository identity、classification、status、polarity、typeのeligibilityをcandidate limitより前に適用する。

Globalとrepository-specificを同時に扱う場合も、unscoped top-Kを取得して後からfilterしない。各scope partitionを個別に検索し、eligible resultだけをmergeする。

### 9.3 One query representation per run

Goal、facets、identifiers、query embeddingをQuery Planとして一度だけ生成し、positive Knowledge、negative Knowledge、Source、Episodeで共有する。

### 9.4 Rank fusion before learned ranking

FTS score、vector cosine、facet score、historical scoreを直接足さない。まずlane内rankをRRFで融合し、その後に共通featureでrankingする。

### 9.5 Graph expansion is bounded

原則1-hop、固定seed数、固定fan-out、固定relation allowlist、固定candidate capとする。Latencyとsemantic driftを構造的に上限化する。

### 9.6 Retrieval text and delivery text are different products

Search recallのためのtextと、Context Packのためのtextを同じbodyへ押し込まない。

### 9.7 Optimize a set, not independent items

最終選択では、すでに選ばれたitemに対して何を追加するかを評価する。個別score上位だけを取らない。

### 9.8 Feedback is evidence, not truth

Composer、Agent、Human、Systemのfeedback sourceを区別する。Self-generated labelsだけでranking modelを学習しない。

### 9.9 Every new lane can be disabled independently

FTS、Vector、Graph、Utility Ranker、Density Selector、Capsuleは独立feature flagとtraceを持つ。障害時はcurrent lexical path相当へ戻せる。

### 9.10 Data readiness before lane complexity

Eligible corpus、独立label、query cohortが小さすぎて改善を測れないlaneはuser-visibleへ昇格しない。実装可能であることと、現時点で導入価値を測定できることを分ける。

---

## 10. Target System Model

~~~mermaid
flowchart LR
    Q["Goal + Facets + Repository Identity"] --> P["Query Plan"]

    P --> F["FTS5 / BM25 Lane"]
    P --> T["Trigram / Exact Identifier Lane"]
    P --> V["Scoped Vector Lane"]
    P --> A["Applicability / Intent Lane"]
    P --> E["Episode Lane"]

    F --> R["Rank Fusion"]
    T --> R
    V --> R
    A --> R
    E --> R

    R --> S["Direct Seeds"]
    S --> G["Bounded Utility Graph Expansion"]
    G --> L["Explainable Feature Ranker"]
    L --> D["Density Selector"]
    D --> C["Composition Route: deterministic / 1-call / 2-call"]
    C --> PERSIST["Short Persistence Transaction"]

    OFF["Offline Projection Builder"] --> F
    OFF --> T
    OFF --> V
    OFF --> G
    OFF --> D

    FEEDBACK["Exposure / Use / Outcome Feedback"] --> OFF
~~~

### 10.1 Offline path

Offline pathは、Knowledgeが作成または更新された時、またはbackground rebuild時に次を行う。

- search text projection生成
- compact delivery text生成
- coverage key抽出
- exact identifier抽出
- token cost計算
- embedding生成
- source/provenance summary計算
- duplicate fingerprint計算
- Utility edge materialization
- index更新

Retrieval alias、relation extraction、delivery projectionなど、検索高度化のために追加するLLM処理はoffline pathに限定する。最終Contextのcomposition routeはこの制限の例外だが、現行call数を増やさず、provider callをwriter ownership外で実行する。LLM生成結果はversioned derived projectionであり、Knowledge bodyまたはSourceの正本を置き換えない。

### 10.2 Online path

Online pathは固定budgetで次を行う。

1. Query Planを構築する。
2. EnabledなRetrieval laneを並列または短絡評価する。
3. RRFでcandidateを融合する。
4. Graph laneがenabledかつdata-readyな場合だけ、Direct top seedsから1-hop展開する。
5. Explainable featureでrerankする。
6. Density Selectorがenabledな場合はcoverageとtoken costを考慮して最小Contextを選び、disabledまたはfailure時はbounded rank orderへfallbackする。
7. 選択済みContextをdeterministic formatter、single compose、または現行planner + Composerへ渡す。
8. 構成終了後、短いtransactionでtraceとfeedbackを保存する。

---

## 11. Query Plan

Query Planの構造とidentifier / facet抽出はruntime generative LLMを使わず、deterministicに生成する。Query embeddingはoptional derived fieldであり、model/versionを記録し、deadline内に得られなければunavailableとする。

最低限、次を保持する。

- normalized goal
- exact identifiers
  - file path
  - basename
  - extension
  - snake_case / camelCase symbol
  - package name
  - error code
  - command
- technologies
- changeTypes
- domains
- inferred constrained intents
- repository identity snapshot
- positive / negative query role
- query embedding
- embedding status、provider、model、dimension
- query hash
- deadline

Japanese queryはwhitespace tokenizationだけに依存しない。

初期案は次の三系統である。

- Unicode word/normalized-term FTS
  - distillation時に抽出した検索語をspace-separated textとしてindexする。
- Trigram FTS
  - 3文字以上の日本語、長いidentifier、部分path、error fragmentを扱う。
- Scope-filter済みsubstring fallback
  - Trigramでは検索できない1から2文字のCJK termを、eligible集合へのbounded LIKEで扱う。

FTS5 queryへraw user textを演算子として渡さない。Hyphen、quote、parenthesisなどを安全にescapeまたはphrase化し、identifierをFTS5のNOT等へ誤解釈させない。

FTS5のtrigram tokenizerはsubstring matchingに利用できるが、index sizeとranking特性が異なる。単一indexへ即決せず、shadow benchmarkでword index、trigram index、短いCJK termのLIKE fallback、組み合わせを比較する。形態素解析tokenizerやBM25Qは、標準BM25とのfusionを含む将来experimentとし、初期必須要件にしない。

---

## 12. Retrieval Lanes

### 12.1 Lexical lane

FTS5を使い、title、normalized retrieval terms、bodyへ異なるweightを与える。

初期candidate cap:

- repo scope: 16
- global scope: 8
- merged lexical cap: 20

Better matchを表すFTS5 rankの向きを正規化し、candidate traceにはraw BM25 rankとnormalized rankの両方を残す。

### 12.2 Exact identifier lane

次はsemantic similarityよりexact matchを優先する。

- file path
- source locator
- class/function/table/column名
- error code
- CLI command
- environment variable名
- framework/module名

Exact laneは高いprecisionを持つが、単独一致で最終選択を保証しない。Repository scope、status、applicability、stalenessを引き続き適用する。

### 12.3 Facet and applicability lane

technologies、changeTypes、domains、intentTags、general applicabilityを扱う。

Facet matchは候補生成とranking featureの両方に使う。ただし、広いgeneral Knowledgeがspecific Knowledgeを押し出さないよう、specific scopeとexact facet matchへ追加weightを与える。

### 12.4 Vector lane

Vector laneはsemantic paraphraseを拾う追加laneとする。

Physical strategyにかかわらず、vector rowまたは対象Knowledgeから最低限次を解決できるようにする。

- scope partition
- classification status
- Knowledge status
- type
- polarity
- embedding
- content hash
- embedding model/version

Scope-filter済みeligible集合をRustでbrute-force cosineする方式と、metadata filter / partitionを持つvec0方式をbenchmarkする。Globalとresolved repositoryを別のeligible集合として検索し、結果だけをmergeする。Unscoped KNNの後段filterは禁止する。

Query embeddingはrunごとに最大1回生成する。Goal hash、model、dimensionが一致するcacheを利用できる。Soft deadlineを超えた場合は待たず、embedding unavailableとしてlexical resultを採用する。

Vector laneはmandatory dependencyにしない。

### 12.5 Negative lane

Negative Knowledgeはpositive candidateと同じ順位列へ混ぜない。

Negative laneはexplicit polarity negativeであり、さらに次の少なくとも一つに一致した場合だけ候補を返す。

- constrained intent
- exact identifierまたはmatching facet
- direct relation from selected positive Knowledge

Historical guardrail utilityは候補生成条件にせず、上記で得たnegative candidate内のbounded ranking featureとしてだけ使う。

最終ContextではAvoid、Guardrail、Verification failureとして別budgetを持つ。

### 12.6 Episode lane

EpisodeはRule/Procedureと同じitemとして競争させない。

Episodeは次の価値を持つ場合に選ぶ。

- same failure signature
- same change type
- same repository/module
- same verification outcome
- direct relation to selected Knowledge

Episode上限は初期値2件とし、長いsituation全文ではなくtask-relevant lessonと必要なlocatorをdeliveryする。

---

## 13. Rank Fusion

初期fusionはReciprocal Rank Fusionを使う。

~~~text
rrf(candidate) =
  sum over lanes l:
    lane_weight(l) / (k + rank_l(candidate))
~~~

初期kは60を候補とするが、固定決定ではない。

RRFを選ぶ理由:

- FTS、Vector、Facetのraw score scaleを揃える必要がない。
- 実装と説明が簡単である。
- Lane追加または削除時にdegradeしやすい。
- Learned ranker用の十分な独立labelがなくても開始できる。

Lane weightの初期優先度:

1. exact repository-specific match
2. lexical FTS
3. facet/applicability
4. vector
5. behavioral/graph expansion

最終weightはoffline replayとhard query setで調整する。Composer-generated used labelだけでweightを最適化しない。

---

## 14. Utility Graph

### 14.1 Definition

Utility Graphは、Knowledgeがworldにおいてどう関係するかではなく、ContextStillのtask contextとしてどう共同利用されるかを表す。

Nodeの主対象:

- Knowledge Rule
- Knowledge Procedure
- Negative Guardrail
- Episode
- Source Fragment
- optional Context Capsule

初期online expansionはKnowledgeからKnowledgeへのedgeに限定する。EpisodeとSourceはretrievalまたはprovenance参照として扱い、Graph scopeを広げすぎない。

### 14.2 Relation types

| Relation | Meaning | Online use |
|---|---|---|
| requires | Aを適用する前にBが必要 | Bをprerequisite候補へ追加 |
| supports | BがAを補足または根拠付ける | coverage不足時に追加 |
| contradicts | AとBが同じ条件下で両立しない | conflict/guardrailとして提示 |
| supersedes | AがBの新しい置換 | Bを通常候補から抑制 |
| co_useful | 過去の有用runで共同利用された | 弱い補助候補 |
| same_concept | 同じ概念の重複または近縁 | expansionせずredundancy penalty |
| derived_from | KnowledgeがSource/Episodeから導かれた | provenanceのみ |

### 14.3 Edge provenance

全edgeは最低限次を持つ。

- from ID
- to ID
- relation
- direction
- weight
- confidence
- source kind
  - human
  - deterministic
  - distillation
  - behavioral
- support count
- supporting run/source IDs
- scope partition
- valid from
- valid to
- updated at
- extractor/version

LLM抽出relationは、confidenceが高くてもhuman factと同等に扱わない。Source referenceまたは独立human / task outcomeによる検証がないrelationはshadow-onlyとする。Propensity-awareでないbehavioral supportが複数あっても、単独ではuser-visibleへpromoteしない。

### 14.4 Co-useful edge

単純なco-selection countはpopular Knowledgeをさらに強くするため使用しない。

Candidate formulaの例:

~~~text
support(A, B) =
  number of runs where:
    A and B were both marked used
    and run outcome was useful or partial

lift(A, B) =
  P(B used | A used) / P(B used)

confidence =
  support / (support + smoothing)

edge_weight =
  normalized(log(1 + support) * log(1 + lift) * confidence)
~~~

最低条件の初期案:

- support >= 3
- positive lift
- recent off_topic / wrong = 0
- same repository scopeまたはglobal-safe
- source dataが時刻正規化済み

この最低条件はshadow materializationの足切りであり、user-visible promotion gateではない。

Composerとcompile_evalが同じAgentから生成される場合は、independent evidenceではないことをedge metadataに残す。

Deterministic exposureから計算したsupportとliftはdescriptive evidenceであり、因果的な共同効用を表さない。Behavioral co_useful edgeをuser-visible rankingへ使う場合は、propensity-aware exposureまたは独立human / task outcomeで別途検証する。

### 14.5 Online expansion contract

初期値:

- seed count: 4
- max hops: 1
- max neighbors per seed: 2
- max graph candidates: 6
- allowed relations: requires、supports、contradicts、co_useful
- same_concept: suppression only
- supersedes: exclusion only

Graph candidate scoreの初期形:

~~~text
graph_score =
  seed_fused_score
  * edge_weight
  * relation_multiplier
  * freshness_factor
~~~

Graph candidateはdirect candidateより高い順位へ自動昇格しない。Missing coverageを満たす場合、または複数seedからsupportされた場合に優先する。

Supersedesによるhard exclusionは、human correction、deterministic migration、またはcurrent Sourceで検証済みのedgeに限定する。LLM抽出またはbehavioral edgeだけが示すsupersedesはshadowまたはbounded penaltyに留める。

### 14.6 No unrestricted traversal

次は禁止する。

- QueryごとにLLMが任意relationを選ぶ。
- Resultが増えなくなるまでmulti-hopする。
- Community centralityだけで候補を追加する。
- Semantic similarity edgeをrequires/supportsとして扱う。
- Graph path自体をEvidenceとみなす。

---

## 15. Retrieval Projection

Knowledge Itemはdurable source of truthとして維持する。検索高度化のため、versioned derived projectionを追加する。

Logical fields:

| Field | Purpose |
|---|---|
| knowledge_id | canonical Knowledgeへの参照 |
| projection_version | builder contract version |
| content_hash | stale projection検出 |
| scope_partition | globalまたはresolved repository identity |
| search_text | retrieval向け正規化text |
| exact_terms | symbol、path、error、command |
| retrieval_aliases | paraphrase、synonym、abbreviation |
| delivery_text | Context Pack向けcompact text |
| coverage_keys | workflow、prerequisite、verification、failure、avoid |
| token_cost | delivery textのmodel-aware推定 |
| provenance_strength | source/origin support summary |
| duplicate_fingerprint | same-concept検出 |
| embedding_ref | vector projection version |
| updated_at | rebuild判定 |

Projection生成に失敗したKnowledgeは削除しない。Current bodyを使うlegacy projectionへfallbackする。

Projectionのcontent hashがKnowledgeのcurrent hashと一致しない場合、vectorとdelivery textをstaleとして除外し、lexical current bodyだけを使用する。

---

## 16. Retrieval Text and Delivery Text

### 16.1 Retrieval text

Retrieval textはrecall向上用であり、user-visible outputではない。

含められるもの:

- title
- canonical body
- normalized facets
- intent tags
- API/symbol/path/error
- source heading
- safe aliases
- Japanese/English paraphrase
- abbreviation expansion

AliasはSourceまたはKnowledgeから説明できるものを優先する。LLMが生成した可能性だけの高いaliasはlow-confidenceとして分離する。

### 16.2 Delivery text

Delivery textは、Knowledgeの意味を次の構造で保持する。

- Use when / Preconditions
- Action / Rule
- Rationale
- Verification
- Avoid / Exception
- Source references

すべてのKnowledgeが全fieldを持つ必要はない。存在しない情報をLLMで補完しない。

Delivery textはcanonical bodyを置き換えない。Agentまたはreviewerはfull KnowledgeとSourceへ辿れる。

### 16.3 Compression safety

Delivery text生成時に次を欠落させない。

- must / must not
- conditional applicability
- exception
- ordering
- verification command or success condition
- destructive action boundary
- repository-specific constraint
- source uncertainty

Semantic equivalenceを自動証明できないため、初期rolloutではdelivery textをshadowで比較する。User-visibleへpromoteするには、must / must not、condition、exception、verification、source locatorのretention hard setを全件通過し、blind human reviewでcanonical bodyに対して非劣化であることを必要とする。

---

## 17. Explainable Feature Ranker

RRF後のcandidateを、同じfeature spaceでrerankする。

初期feature:

- RRF score
- lexical rank
- exact match type
- vector rank
- facet overlap
- repository specificity
- polarity and query role
- importance
- confidence
- dynamic utility
- source/origin support
- freshness / decay
- requires/support edge count
- superseded status
- recent used / not_used / off_topic / wrong
- token cost
- duplicate similarity
- coverage keys

初期rankerは明示weightを持つlinear modelまたはrule-based scoreとする。Candidate traceにfeature breakdownを保存する。

Dynamic utilityをraw lexical scoreへ直接加算しない。共通尺度へcalibrateして上限を設けるか、同等relevance内のtie-breakerとして扱う。Query evidenceだけでは到達できないscore lockoutをfixtureで禁止する。

Sufficient independent labelsが蓄積した場合のみ、logistic regression、pairwise ranker、small gradient boosted modelなどを検討する。Online neural rerankerまたはremote cross-encoderを初期導入しない。

Rankerはhard eligibilityを上書きできない。

- wrong repository
- unresolved classification
- inactive status
- superseded
- human correctionまたは再現可能なverificationで確認されたwrong
- incompatible applicability

はscoreではなくfilterまたはstrict penalty contractとして扱う。

Composer、Agent、run-level compile_evalだけが示すwrong / off_topicは、sourceとconfidenceを保持したbounded penaltyまたはreview triggerに留める。Lower-trust signalだけでhard exclusionしない。

---

## 18. Density Selector

### 18.1 Objective

Density Selectorは、候補を独立にsortしてtop-Kを取らない。

選択済み集合Cに対して、新候補xのmarginal gainを評価する。

~~~text
marginal_gain(x | C) =
  query_relevance(x)
  + new_coverage(x, C)
  + provenance_value(x)
  + historical_utility(x)
  + relation_support(x, C)
  - semantic_redundancy(x, C)
  - stale_or_conflict_risk(x)

density(x | C) =
  marginal_gain(x | C) / max(token_cost(x), minimum_cost)
~~~

初期selectorは正のmarginal gainを持つ候補だけを追加し、budget内greedy集合とbest singletonを比較して良い方を採用する。小規模fixtureでは全組み合わせの最適解と比較し、regretを記録する。この目的関数は必ずしも単調submodularではないため、一般の近似保証を主張しない。Stale、superseded、scope violationなどのhard riskは、可能な限りselection前のeligibilityへ移す。

### 18.2 Required coverage

Retrieval modeごとにcoverage templateを定義する。

例:

| Retrieval mode | Required or preferred coverage |
|---|---|
| review_context | invariant、risk、verification、avoid |
| debug_context | symptom、cause、procedure、verification |
| architecture_context | constraint、trade-off、boundary、verification |
| procedure_context | prerequisite、ordered workflow、success condition、rollback |
| learning_context | principle、example、failure lesson、applicability |

すべてのslotを無理に埋めない。Evidenceのないslotはmissingとしてdiagnosticsへ残す。

### 18.3 Section budgets

Positive Rule、Procedure、Guardrail、Episodeは別budgetを持つ。ただし固定ratioだけでなく、query roleとmissing coverageで調整する。

初期online cap:

- retrieved candidates: 最大32
- fused direct candidates: 最大12
- graph candidates: 最大6
- ranker input: 最大18
- final Knowledge: 6から8を目安
- final Episode: 最大2
- Composition input tokens: corrected baseline以下

数値はbenchmarkで変更できるが、capのない動的拡張は禁止する。

### 18.4 Redundancy

同じtitle、same source、same-concept edge、high semantic similarity、overlapping coverage keysをredundancy signalにする。

Contradictionはredundancyとして消さない。条件が重なる場合はconflictまたはguardrailとして明示する。

---

## 19. Context Capsule

Context CapsuleはPhase 4以降のoptional optimizationである。

Capsuleは、繰り返し同時利用されるKnowledge集合へのretrieval shortcutであり、新しいcanonical Knowledgeではない。

Logical contents:

- capsule ID
- retrieval mode / facet signature
- member Knowledge IDs and versions
- coverage summary
- optional materialized composed view、初期導入では未使用
- token cost
- historical support
- provenance map
- stale condition

初期段階はmembership shortcutだけを対象とし、text summaryを保存・選択しない。Capsuleが選ばれた場合も、current member delivery textを再構成する。Materialized composed viewはFuture Experimentsの個別gateへ分離する。

Memberのstatus、version、scope、supersedes relationが変わった場合、Capsuleをstaleにする。

CapsuleはMicrosoft GraphRAGのcommunity reportに似た圧縮効果を狙うが、broad corpus summaryではなく、task utilityとrepeated successful usageに限定する。

---

## 20. Feedback and Learning Contract

Feedbackを次の段階に分ける。

~~~text
Exposure:
  retrieverが候補として返した

Selection:
  ranker / density selectorがComposer入力に選んだ

Use:
  ComposerまたはAgentが出力・実装判断に明示利用した

Outcome:
  compile_eval、human feedback、task resultが得られた

Correction:
  not_used、off_topic、wrong、stale、supersededが判明した
~~~

各eventには次を持たせる。

- run ID
- item ID and version
- stage
- actor
- source of signal
- rank / score / feature explanation
- query and scope snapshot
- policy version、slot、exposure probability
- timestamp
- confidence
- reason

### 20.1 Label trust

Trustの初期優先度:

1. Human explicit wrong / off_topic / useful
2. Reproducible task outcomeまたはverification result
3. Agent explicit item-level feedback
4. Composer used reference
5. Run-level compile_eval
6. Selection count

Lower-trust signalがhigher-trust correctionを上書きしない。

### 20.2 Feedback-loop protection

- Selection countだけでutilityを上げない。
- Position biasを記録する。
- 新laneはまずshadow trace-onlyで候補差分を観測する。未配信候補にはuse labelが付かないため、この期間のlogを因果的なutility学習に使わない。
- Frequently selectedだがnot_usedのKnowledgeは、signal sourceとposition biasを考慮したbounded penaltyにする。Composer自己申告だけでhard exclusionしない。
- Rare Knowledgeをcoldという理由だけでpenalizeしない。
- Controlled explorationを行う場合は、safety gate通過後に限定slotへ確率的に露出し、policy version、slot、exposure probabilityを保存する。
- New itemへのminimum exploration opportunityは、hard eligibility、must-include retention、repository isolationを満たす範囲に限定する。
- Ranker weight更新はoffline replay後にversioned releaseする。

Deterministic exposureから得たco-selection、lift、Composer self-labelはdescriptive evidenceとしては使えるが、不偏な因果効果とはみなさない。Behavioral co_useful edgeやlearned weightをpromotion判断へ使う場合は、propensity-aware logまたは独立したhuman / task outcome labelを必要とする。

---

## 21. Runtime and Concurrency Boundary

現行の最大の構造的性能riskは、retrieval complexityよりSQLite writer ownershipである。

Target flow:

~~~text
Phase A: Prepare
  query plan
  no writer ownership

Phase B: Parallel candidate preparation
  read-only lexical / exact / facet / episode retrieval
  optional query embedding with a soft deadline
  no writer ownership

Phase C: Complete retrieval
  read-only scoped vector retrieval when embedding is available
  graph expansion
  ranking
  density selection

Phase D: External composition
  deterministic formatter、1-call compose、または現行planner + Composer
  no writer ownership

Phase E: Persist
  short writer transaction
  compile run
  candidate traces
  context pack
  usage feedback
~~~

Lexical retrievalとquery embeddingは並行実行できる。Embeddingのsoft deadlineまでにlexical候補が得られている場合、embeddingを待つためだけにcritical pathを延長しない。

Read snapshotとpersistの間にKnowledgeが変更される可能性があるため、selected item version/content hashをsnapshotへ保存する。

Persist時にcurrent itemが変わっていても、過去runの再現性のためselection snapshotを保存する。Current Knowledgeを古いsnapshotで上書きしない。

SQLiteはWAL/read-only connectionを使い、single writer原則を維持する。External provider callをtransactionまたはwriter job内で実行しない。

Phase timingはproviderごとのplanner attemptとcompose attemptを分離し、logical call数、provider attempt数、fallback-route failoverを保存する。現行Rust pathには同一provider内の明示retry loopがないため、failoverをretryと混同しない。現行plannerがretrieval query expansionへ接続されていない限り、候補検索の改善効果として計上しない。

---

## 22. Performance Budget

Phase 0で正確なbaselineを取り直した後、paired benchmarkで判定する。

この節のbaselineは、Phase 0で作成したversioned corrected baselineを指す。

各promotion experimentは実行前に、baseline window、query cohort、sample size、primary metric、guardrail metric、minimum detectable effect、non-inferiority margin、confidence interval、停止条件をmanifestへ固定する。結果を見た後に閾値またはcohortを変更した場合は、新しいexperiment versionとして取り直す。

暫定promotion gate:

| Area | Gate |
|---|---|
| End-to-end compile p50 | manifestのnon-inferiority gateを満たす |
| End-to-end compile p95 | baselineの1.02倍以下 |
| Retrieval p95 | 100 ms以下、またはcorrected baseline + 5 ms以下の厳しい方 |
| Writer queue wait p95 | 20 ms以下 |
| Graph expansion p95 | 10 ms以下 |
| Persistence p95 | 25 ms以下 |
| Runtime logical LLM calls | corrected baselineから増加0。削減variantを必ず比較 |
| Provider attempts | planner / compose / provider別に記録し、failover率とfailure率が同一route baselineを悪化させない |
| Composition input tokens | corrected baseline以下 |

Provider latencyの分散が大きいため、LLM route同士のend-to-end比較は同一provider、同一routing、同一query cohortのpaired testを使う。Deterministic routeとの比較では、retrievalまでを共通区間として分離し、composition routeごとのend-to-end latencyとqualityを同じquery cohortで比較する。

Phase 0ではdeterministic formatter、single compose、現行planner + composeを同じ候補集合で比較する。Human/task outcomeが非劣化であれば、少ないcall数を優先する。

Embedding soft deadlineの初期候補は、cache hitまたはlocal providerについて30から50 msとする。Remote network embeddingはこの値を前提にcritical pathへ追加せず、別budgetとpaired benchmarkなしではpromoteしない。Deadline超過時はbackground completionを待たず、そのrunではvector disabledとする。適切な値はprovider別の実測後に確定する。

---

## 23. Quality and Density Metrics

### 23.1 Retrieval metrics

- Recall@K
- nDCG@K
- Mean Reciprocal Rank
- Exact identifier hit rate
- Negative guardrail recall
- Relation-only useful candidate rate
- Wrong-repository candidate count

### 23.2 Set quality metrics

- Required coverage completion
- Distinct coverage keys per 1,000 tokens
- Pairwise redundancy
- Contradiction surfacing rate
- Provenance-supported selected ratio
- Stale/superseded selected ratio

### 23.3 Utility metrics

次の指標はComposer / Agent由来を含み、単独でpromotionを決めない。

- Used item ratio
- Not-used item ratio
- Off-topic / wrong rate
- Used token mass / delivered token mass
- Useful outcome rate
- Later-selected rate for shadow candidates

### 23.4 Information density definition

Diagnostic density metric:

~~~text
useful_token_density =
  token mass of selected items later marked used
  / total delivered context token mass
~~~

Independent set-quality metric:

~~~text
coverage_density =
  number of distinct supported coverage keys
  / delivered tokens in thousands
~~~

Primary outcomeは、hard query setのmust include / must not include、blind human preference、再現可能なverificationまたはtask resultとする。Token削減、used ratio、useful token densityはdiagnosticであり、配信量を減らすだけで改善するため単独のpromotion gateにしない。

---

## 24. Evaluation Dataset

単一のhistorical replayだけで評価しない。

### Cohort A: Historical retention

- 直近500から2,000 compile query
- Existing used Knowledgeが新retrieverのcandidate setに残るか
- Scope、facet、latency、candidate countを比較

用途:

- Regression detection
- Existing behavior retention

制約:

- Existing retrieverが露出しなかったKnowledgeは正解labelに現れない。
- Composer自己ラベルに偏る。

### Cohort B: Hard query set

100から200 queryを人間または独立reviewで作る。

含めるもの:

- Japanese paraphrase
- English/Japanese mixed query
- exact symbol / error / file
- broad architecture question
- multi-facet query
- negative guardrail
- prerequisite relation
- superseded Knowledge
- two-hopを要求するように見えるが一-hop supportで解けるquery
- no relevant Knowledge
- wrong repository trap

各queryに、must include、acceptable、must not include、coverage expectationを付ける。

### Cohort C: Online shadow

- User-visible outputはcurrent pathのまま
- New laneのcandidate ID、rank、reason、latencyだけ保存
- BodyをComposerへ送らない
- Manifestで事前定義した最小run数と観測期間の両方を満たすまで観測

制約:

- Shadow候補にはuser-visibleなuse labelが付かない。
- Candidate差分、scope violation、latency、hard-set replayの観測には使えるが、causal utilityの推定には使わない。

### Cohort D: Human review

High-impact queryだけをsamplingし、blind pairwise reviewする。

Review axes:

- Which context is more actionable
- Which is less redundant
- Which has better verification
- Which has safer guardrails
- Which contains unsupported or off-topic content

### Cohort E: Controlled exploration, optional

- Foundation、repository isolation、hard negative gate通過後だけ有効化する。
- Bounded slotへ確率的に候補を露出する。
- Policy version、slot、exposure probability、selection、use、outcomeを保存する。
- Wrong / off_topicがmanifestで事前定義した停止閾値を超えたら即時停止する。

初期評価にinterleavingを必須としない。ContextStillは独立したclick / conversion signalが疎で、Density Selectorはset-level optimizationである。将来、候補rank単体を比較できるonline outcomeがmanifestのsample sizeを満たした場合に限り、適用範囲を再検討する。

---

## 25. Promotion Gates

この節では、higher-is-better metricは `new - baseline`、lower-is-better metricは `baseline - new` として、正の値が改善を表すoriented paired differenceへ揃える。「改善」は、そのconfidence interval下限がmanifestで定義したminimum effectを上回ることを指す。「非劣化」は、同じ下限が事前定義した許容劣化幅 `-Δ` 以上であることを指す。`0 violation`は統計推定ではなく、対象cohort内の全件一致条件である。Manifestにsample size、`Δ`、minimum effectがないexperimentはpromotionできない。

### 25.1 Foundation gate

- New writeのtimestampがcanonical representationへ統一され、historical形式はaudited backfillまたはnormalized query projectionで同じsort orderになる。
- Eligible corpusがrepository / identity match basis / classification status別に記録され、全active件数と区別される。
- Planner、Composer、provider attempt、fallback-route failoverを含むruntime phase timingとcall数が保存される。
- Active runtime pathがtraceに記録される。
- Read、external call、writeが分離される。
- Repository isolation negative testが0 violation。
- Raw text scoreとdynamic utilityの尺度混在が解消され、query evidenceで到達不能になるscore lockout fixtureが0件。
- Unresolvedを安全性検証なしに一括classifiedへ変更しない。

### 25.2 FTS/RRF gate

- Existing used Knowledge retention >= 99%。Composer由来のbiased regression diagnosticとして扱う
- Hard set Recall@16がbaselineに対して非劣化
- nDCG@8がmanifestのminimum effect以上改善、またはnDCG@8が非劣化かつretrieval latencyが改善。nDCG@8の初期minimum effect候補はabsolute +0.05
- Retrieval p95がbudget内
- Exact identifier cohortのregressionなし

### 25.3 Vector gate

- Repositoryごとのeligible corpusとsemantic hard setが、manifestのsample sizeを満たす
- Semantic paraphrase cohortでrecallがmanifestのminimum effect以上改善
- Exact cohortで非劣化
- Scope prefilter violation 0
- Embedding unavailable時のfallback成功100%
- End-to-end p95で非劣化

### 25.4 Utility Graph gate

- Behavioral co_usefulを使う場合、propensity-aware exposureまたは独立human / task outcome labelがmanifestのsample sizeを満たす
- Co_useful edgeの上位node集中率がmanifestの上限以下
- Shadow graph candidateがmanifestの最小件数以上存在する
- Later-selectedまたはhuman-accepted rate >= 25%
- 独立review済みpromotion cohortでwrong / off_topic = 0
- Direct candidate retentionで非劣化
- Graph p95 <= 10 ms
- 1-hopを超える必要がある事例は別途記録し、初期gateを拡張しない

### 25.5 Density Selector gate

- Hard query setのmust include retentionがbaseline以上
- Hard query setのmust not include violationがbaseline以下
- Blind pairwise human reviewで非劣化、またはmanifestのminimum effect以上改善
- 再現可能なverification / task outcomeで非劣化
- 上記を満たしたうえで、output tokenを15%以上削減
- Used item ratio、not-used ratio、useful token densityはdiagnosticとして改善方向を確認

数値はPhase 0でcorrected baselineを得た後に再承認する。

---

## 26. Rollout Plan

### Phase 0: Measurement and runtime truth

目的:

- 高度化前に正しい測定とconcurrency boundaryを作る。

内容:

- Canonical timestamp writeとhistorical timestamp normalization
- Runtime engine/version trace
- Repository / identity basis別eligible corpus baseline
- Planner / Composer / provider attempt / failover別のphase timingとcall count
- Read-only retrieval connection
- Composerをwriter job外へ移動
- Short persistence transaction
- Native counter/feedback update
- TypeScript/Rust capability matrix
- Deterministic formatter、single compose、現行planner + composeのpaired comparison
- Experiment manifest templateとbaseline report format

Exit:

- Reproducible baselineとrollback smokeがある。
- Baseline window、cohort、sample size、statistical margin、停止条件がversioned manifestへ固定される。
- Unresolvedはfail-closedのまま扱え、全件解消をexit条件にしない。

### Phase 0.5: Current ranking correction

目的:

- 新retrieval laneより前に、現行rankerのscore scale lockoutを解消する。

内容:

- Raw text scoreとdynamic utilityを別featureにする。
- Dynamic utilityをcalibrate / capするかtie-breakerへ降格する。
- Query-sensitive candidate retentionとhistorical cohortを、classification一括更新の前後で分離評価する。
- Current top-8 fallbackのcontractとrollback flagを維持する。

Exit:

- Foundation gateのscore lockout条件を満たす。

### Phase 1: Native FTS and rank fusion

目的:

- 最小変更でlexical qualityとscalabilityを改善する。

内容:

- Rust native FTS5
- normalized retrieval terms
- 1から2文字CJKのbounded LIKE fallback
- FTS5 queryのsafe quoting / escaping
- exact identifier lane
- facet lane
- RRF
- candidate trace expansion
- shadow/current comparison

Exit:

- FTS/RRF gateを満たす。

### Phase 2: Scoped Vector

目的:

- Semantic paraphrase recallを追加する。

内容:

- Scope-filter済みRust brute-force cosineと、metadata-filtered / partitioned vec0を同じeligible corpusでbenchmark
- Promotion gateを満たす最も単純なphysical strategyを選択
- content hash/version
- one embedding per query
- cache and soft deadline
- global/repository two-query merge
- shadow lane

Exit:

- Eligible corpusとhard setがrecall差を測れる規模に達し、Vector gateを満たす。満たさなければVectorはoptionalかshadowのまま。

### Phase 3: Utility Graph

目的:

- Direct similarityだけでは見つからないprerequisite、support、guardrailを追加する。

内容:

- Edge schema
- requires/supports/contradicts/supersedes
- co-useful materializer
- TypeScript utility traceのnative parity
- one-hop expansion
- trace-only rollout

Exit:

- Static human / deterministic edgeは個別に評価できる。Behavioral co_usefulをuser-visible rankingへ使うには、propensity-aware exposureまたは独立labelがmanifestのsample sizeを満たし、Utility Graph gateを通過する。

### Phase 4: Density optimization

目的:

- 最終Contextを小さく、広いcoverageへする。

内容:

- delivery text
- coverage keys
- token cost
- set-level redundancy
- marginal utility selector
- optional membership-only Context Capsule。Materialized textはdeferred experiment

Exit:

- Density Selector gateを満たす。

### Phase 5: Learned ranking, only if justified

目的:

- Explainable heuristicで残るranking gapを改善する。

前提:

- Independent labelsがPhase 5 manifestのsample sizeを満たす。
- Feature driftとrollbackを管理できる。
- Modelなしfallbackが同じcontractを満たす。

初期構想のcompletionにPhase 5は不要である。

---

## 27. Failure and Degradation Model

| Failure | Required behavior |
|---|---|
| FTS unavailable | Current deterministic lexical fallback |
| Embedding timeout | Vector laneをskipし、FTS/facetを使用 |
| Vec index stale | Stale rowを除外し、lexicalを使用 |
| Graph unavailable | Direct retrievalのみ |
| Graph materialization stale | Stale edgeを除外 |
| Ranker failure | RRF orderへfallback |
| Delivery projection stale | Canonical bodyへfallback |
| Composer unavailable | Existing deterministic fallbackまたはNo Content contract |
| Persistence failure | User-visible resultと未保存状態を区別し、silent successにしない |
| Repository identity missing | Existing global-only fail-closed contract |

複数laneが失敗しても、degraded reasonを個別に残す。一つのgeneric retrieval failedへ潰さない。

---

## 28. Trust and Safety Boundary

- Source content、repository text、agent logsはuntrusted inputである。
- Retrieval textに含まれる命令をsystem instructionとして扱わない。
- Only active and classified Knowledgeがnormal Context Packへ入る。
- LLM-generated alias、delivery text、relationはderived projectionとしてsourceを保持する。
- Graph relationはEvidenceではない。Relationが指すSourceまたはKnowledgeがEvidenceである。
- Human correctionはbehavioral popularityより優先する。
- Destructive guidance、credential handling、external I/Oは既存policy boundaryを維持する。
- Repository identityはranking featureではなくeligibility contractである。

---

## 29. Data Migration and Rollback

新indexとprojectionはadditiveに導入する。

推奨手順:

1. Existing Knowledgeを変更せずprojection tableを追加する。
2. Read-only snapshotでrebuild dry-runする。
3. Count、content hash、scope distributionを検証する。
4. Shadow indexを構築する。
5. Current/new candidate diffを保存する。
6. Feature flagでread pathを切り替える。
7. 問題時はflagを戻す。
8. Manifestで定義した観測期間とrollback windowを完了し、rollback triggerがなく、明示reviewを通した後にだけ旧projectionを削除候補とする。

Vec0を採用してschema変更する場合は、existing tableをin-placeで破壊せず、versioned virtual tableを作ってrebuild後に切り替える。Scope-filter済みbrute-force cosineを採用する場合は、不要なvirtual tableを追加しない。

Knowledge merge、deprecation、Capsule作成はretrieval rolloutと分離する。Retrieval改善のためにcanonical dataを一括変更しない。

---

## 30. Observability

各compile runは次を追跡可能にする。

- runtime engine and build
- query plan version
- repository identity snapshot
- lane status
- lane candidate count
- lane latency
- embedding status/model/cache
- RRF rank
- graph edge/path
- feature score explanation
- density selection reason
- suppression reason
- token cost
- selected coverage
- missing coverage
- Used IDs and feedback actor
- final outcome feedback
- persistence latency

Candidate traceは選ばれたitemだけでなく、上限内でranked-out、duplicate、graph-only、stale、scope-filteredの理由を記録する。

Body全文をtraceへ重複保存せず、ID、version、content hash、score explanationを保存する。

---

## 31. Alternatives Considered

### A. Full Semantica adoption

Decision: Reject as primary runtime.

Reason:

- ContextStillのdurable Knowledge lifecycle、repository isolation、compile/eval loopを置き換える範囲が大きい。
- General ontology、reasoning engine、polyglot graph storeは現在のprimary use caseに過剰である。
- Migrationとdual source of truthが大きなriskになる。

Adopted idea:

- Vector + graph hybrid
- typed relation
- provenance
- bounded graph expansion

### B. Microsoft-style full GraphRAG

Decision: Reject for current task context retrieval.

Reason:

- Corpus-wide entity extraction、community detection、community summaryはbroad document QA向けである。
- ContextStillは少数のtask-specific Rule/Procedureを選ぶことが中心である。
- Indexing cost、summary staleness、provenance lossが大きい。

Adopted idea:

- Direct local searchをgraph relationとsource textで補う。
- Capsuleはtask utilityに限定する。

### C. Pure Vector Search

Decision: Reject.

Reason:

- Exact symbol、path、error、negative constraint、scopeをsemantic similarityだけでは安全に扱えない。
- Embedding unavailable時のhard dependencyになる。

### D. Online Cross-encoder / LLM reranking

Decision: Defer.

Reason:

- 現在の8件候補より前のcandidate generation問題を解決しない。
- Explainable local rankerで先に価値を証明できる。

Current planner callをcandidate generation後のlistwise rerankへ再利用する案は、logical call数を増やさずに比較できる。ただし現行plannerはretrieval hintへ接続されておらず、provider latency、failover、independent evaluationが必要であるため、初期必須経路にはしない。

### E. ColBERT-style late interaction

Decision: Defer.

Reason:

- Fine-grained semantic matchingの利点はあるが、multi-vector storageとruntime complexityが増える。
- 現在のKnowledge規模では、FTS、scoped dense vector、RRF、utility graphを先に評価すべきである。

### F. Keep current top-8 lexical path

Decision: Preserve only as fallback.

Reason:

- Simpleでdegradeしやすい。
- ただしparaphrase、relation coverage、set diversity、token utilityを最適化できない。

---

## 32. Open Decisions

次は実装計画前に確定またはexperimentで選ぶ。

1. Japanese lexical strategy
   - normalized word index、trigram index、短いCJK termのLIKE fallbackをどう組み合わせるか。
2. Embedding model
   - local model、dimension、Matryoshka対応、cache policy。
3. Scope partition key
   - canonical projectRef、repoKey、repoPathの優先順位をphysical keyへどう表現するか。
4. Delivery text ownership
   - distillation時生成か、projection worker生成か。
5. Provenance threshold
   - Source/Originのないactive Knowledgeをどのlaneまで許可するか。
6. Utility label trust
   - Agent feedback、Composer use、compile_eval、human feedbackのweight。
7. Context Capsule
   - membershipのみか、versioned compact textも保存するか。
8. PostgreSQL path
   - SQLite rollout後にparityを実装するか、advanced backend向け別計画にするか。
9. Evaluation ownership
   - Hard query setの作成・更新・review責任者。
10. User-facing explanation
   - Graph-derived candidateとdirect candidateをUI/MCP diagnosticsでどこまで表示するか。
11. Current score calibration
   - Dynamic utilityをbounded feature、normalized feature、tie-breakerのどれにするか。
12. Composition route
   - Deterministic formatter、single compose、planner + composeのどれをdefaultにするか。
13. Vector physical strategy
   - Scope-filter済みbrute-force cosineとmetadata-filtered / partitioned vec0のどちらが実測上単純か。
14. Controlled exploration
   - 導入条件、slot、exposure probability、停止条件をどう定義するか。
15. Lane data-readiness threshold
   - Repositoryごとのeligible件数、hard query数、independent label数をいくつ必要とするか。

---

## 33. Recommended First Implementation Slice

最初のsliceはGraphではない。

最初にPhase 0 / 0.5のfoundation releaseを実施する。

1. Timestamp normalizationとcorrected recent-run query。
2. context_compileをread、external compose、short writeへ分離。
3. Repository / identity basis別eligible corpus baseline。
4. Planner / Composer / provider attempt / failover別のphase timingとcall count。
5. Raw text scoreとdynamic utilityの尺度分離。
6. Query-sensitive score lockout fixture。
7. Deterministic formatter、single compose、現行2-call構成のpaired comparison。
8. Expanded candidate traceとcurrent top-8 fallbackのrollback smoke。

このsliceで、次を確認する。

- Writer contentionが減るか。
- Query evidenceで候補集合が変わり、dynamic utilityだけで到達不能になる候補がないか。
- LLM callを削減してもhard set、human review、task outcomeを維持できるか。
- 正しいeligible corpusとruntime baselineを後続laneが利用できるか。

このfoundationが成功してから、次のsliceとしてRust native FTS5、短いCJK fallback、exact / facet lane、RRFを追加する。Scoped Vector、Utility Graph、Density Selectorは、それぞれのdata-readinessとpromotion gateを満たす場合だけ順に追加する。

---

## 34. Acceptance Summary

### 34.1 Core v1 acceptance

Required foundationとCore v1 laneが成立したとみなす条件は次の通り。

- Active Rust runtimeがFTS、exact identifier、Facet、Episodeを共通Query Planから利用できる。
- Repository isolationが全laneでlimit前に適用される。
- Raw text scoreとdynamic utilityのscale lockoutが解消される。
- Runtime logical LLM call数とcomposition input tokenがcorrected baseline以下である。
- End-to-end p95がmanifestのnon-inferiority gateを満たす。
- Existing used Knowledge retentionが99%以上である。ただしComposer由来のbiased regression diagnosticとして扱う。
- Hard query setのretrieval qualityが改善する。
- Hard-set must include / must not include、blind human preference、reproducible task outcomeが非劣化または改善する。
- Wrong/off-topic、stale、cross-repository candidateがguardrailを悪化させない。
- Full Knowledge、Source、projection、selection reasonを追跡できる。

### 34.2 Conditional lane acceptance

- Vector、Utility Graph、Density Selectorは個別gateを満たしたlaneだけpromoteする。
- Graphはpromoteする場合も1-hop bounded augmentationであり、primary retrieverにしない。
- Conditional laneがshadowまたはdisabledでもCore v1 acceptanceを妨げない。
- 各laneは独立してshadow、promote、disable、rollbackできる。
- Promoted Graph candidateはedge、path、provenance、suppression reasonを追跡できる。
- Used item ratioとuseful token densityはdiagnosticとして記録し、単独のacceptance条件にしない。

---

## 35. References

- Semantica Context Module: https://docs.getsemantica.ai/reference/context/
- Semantica Core Concepts: https://docs.getsemantica.ai/concepts/
- SQLite FTS5: https://www.sqlite.org/fts5.html
- SQLite FTS5 trigram tokenizer constraints: https://www.sqlite.org/fts5.html#the_trigram_tokenizer
- sqlite-vec metadata filtering and partition keys: https://alexgarcia.xyz/blog/2024/sqlite-vec-metadata-release/index.html
- sqlite-vec hybrid search: https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html
- Reciprocal Rank Fusion: https://doi.org/10.1145/1571941.1572114
- Maximal Marginal Relevance: https://aclanthology.org/X98-1025/
- ColBERTv2: https://arxiv.org/abs/2112.01488
- Microsoft GraphRAG query overview: https://microsoft.github.io/graphrag/query/overview/
- HippoRAG 2: https://arxiv.org/abs/2502.14802
- UDCG, Utility and Distraction-aware Cumulative Gain: https://aclanthology.org/2026.eacl-long.391/
- Compute Allocation for Reasoning-Intensive Retrieval Agents, arXiv preprint: https://arxiv.org/abs/2603.14635
- Lighting the Way for BRIGHT, SIGIR 2026: https://doi.org/10.1145/3805712.3808570

初期導入へ採用しないが、将来のdata-readiness次第で再評価する案は、[ContextStill Utility-RAG Future Experiments](./contextstill-utility-rag-future-experiments.md)へ分離して管理する。

---

## 36. Repository Evidence

この構想の現状認識は、主に次の実装に基づく。

- Rust native Context Compiler、planner / Composer、deterministic fallback:
  - crates/context-stilld/src/domains/mcp_lifecycle/native_compile.rs
- Rust native lexical score:
  - crates/context-stilld/src/domains/mcp_lifecycle/native_common.rs
- Rust native repository eligibility:
  - crates/context-stilld/src/domains/mcp_lifecycle/repository_scope.rs
- SQLite FTS and vector schema:
  - src/db/sqlite/core-schema.ts
  - src/db/sqlite/client.ts
  - src/db/sqlite/core-repository.ts
- SQLite Knowledge retrieval:
  - src/modules/knowledge/knowledge.repository.sqlite.ts
- TypeScript retrieval orchestration:
  - src/modules/knowledge/knowledge.service.ts
  - src/modules/context-compiler/context-compiler.service.ts
- Ranking and duplicate suppression:
  - src/modules/context-compiler/ranking.service.ts
  - src/modules/context-compiler/duplicate-suppression.service.ts
- Existing utility trace:
  - src/modules/context-compiler/utility-retrieval.service.ts
- Feedback and utility score:
  - src/modules/knowledge/knowledge-feedback.service.ts
  - src/modules/knowledge/knowledge-value.service.ts

---

## 37. Final Review Questions

1. Utility-RAGの定義は、ContextStillのproduct価値を正しく表しているか。
2. Direct retrievalをprimary、Graphをbounded augmentationとする判断は妥当か。
3. Phase 0で修正すべきruntime/concurrency/evaluation問題に漏れはないか。
4. Raw text scoreとdynamic utilityのscale correctionは、candidate lockoutを防げるか。
5. FTS、exact、facet、vectorのlane境界は重複しすぎていないか。
6. Japanese retrievalで、Unicode FTS、trigram、短いCJK LIKEの境界は妥当か。
7. Scope-filter済みbrute-force cosineとvec0を選ぶbenchmarkは十分か。
8. RRFを初期fusionに使う判断は妥当か。
9. Utility edgeのrelation種別は多すぎるか、または不足しているか。
10. Co-useful edgeをpromoteできるだけの独立labelまたはpropensity-aware logがあるか。
11. One-hop、seed 4、neighbor 2、graph cap 6は安全な初期値か。
12. Delivery textが条件や例外を失わないために追加gateが必要か。
13. Marginal utility per tokenのfeatureに欠けているものはあるか。
14. Current Composer self-labelをどこまでdiagnosticに利用してよいか。
15. Hard query setはどのcohortを追加すべきか。
16. Planner / Composer / provider attempt / failover別のperformance gateは十分か。
17. Context CapsuleはPhase 4でも過剰か。
18. この構想より小さな変更で、同等の品質改善を達成できるか。

---

## Appendix A. Copyable AI Review Prompt

次のpromptは、この文書を別のAIへレビュー依頼するときにそのまま使用できる。

~~~text
ContextStill Utility-RAG Conceptをarchitecture reviewしてください。

目的は文章の要約や賛同ではなく、実装前に設計上の欠陥、誤った前提、
過剰設計、測定不能な成功条件、性能回帰、repository isolation違反、
feedback loopのbias、情報圧縮による欠落を見つけることです。

特に次を確認してください。

1. active Rust native runtimeについての現状認識は正しいか。
2. Phase 0、0.5、1から5の依存順序とConditional laneの開始条件は妥当か。
3. FTS5、exact、facet、vector、graphの責務境界は明確か。
4. scope before limitが全laneで実現可能か。
5. RRFとExplainable Rankerの二段構成は必要か。
6. Utility Graphのrelation、one-hop制限、co-useful計算は安全か。
7. marginal utility per tokenが重要な条件や例外を落とさないか。
8. Composer由来feedbackを評価・学習に使う際の循環性を防げるか。
9. latency budgetとpromotion gateは測定可能で十分に厳しいか。
10. 同等の効果を得られる、より単純な代替案がないか。

指摘は次の形式にしてください。

- Priority: P0 / P1 / P2
- Section:
- Finding:
- Failure scenario:
- Evidence:
- Smallest safe correction:
- Promotion blocker: yes / no

最後に、次のいずれかを選んでください。

- Accept concept as implementation-planning baseline
- Accept with required corrections
- Reject and propose a simpler architecture

Repositoryを参照できる場合、文書の主張を実装と照合してください。
文書内の暫定数値や自己生成feedbackを独立したground truthとして扱わないでください。
~~~
