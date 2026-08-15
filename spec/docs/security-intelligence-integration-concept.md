# Security Intelligence Integration Concept

## Status

- Status: Discussion Draft / Shared Concept
- Concept ID: `security-intelligence-integration-v1`
- Version: `0.1`
- Last updated: 2026-08-15
- Applies to: `vulnWorkbench`, `NightWorkers`, `contextStill`

この文書は、AIを含むソフトウェア開発において、実装前の制約提示、実装後の検証、証拠の保存、再利用可能な知識への蒸留を一つの循環として扱うための共通コンセプトを定義する。

同じ内容を3つのrepositoryへ配置し、各projectが独自解釈で責務を拡張しないための共有境界とする。変更する場合は、3つのcopyを同じConcept IDとversionへ揃える。

この文書は実装計画ではない。database schema、API、MCP tool、Ontology schema、LLM prompt、scanner追加、default activationを確定しない。ただし、後続の実装計画が守るべき責務、trust boundary、段階導入、評価方法を定義する。

既存文書と責務境界が衝突する場合、Security Intelligence Integrationに関する限り、この文書の境界を優先する。各project固有のruntime、module、database、release policyは、それぞれのproject文書を引き続き正本とする。

---

## 1. 背景

AIによるコード生成能力が向上すると、人間が短時間で把握できる量を超える変更が生成される。問題はAI生成コードだけに限定されない。人間、automation、dependency update、migration、configuration changeを含め、すべての変更は検証されるまで未信頼として扱う必要がある。

変更には次のようなSecurity Riskがある。

- Authentication / Authorization Boundaryの欠落
- Tenant Isolationの破壊
- Sensitive Data Flowの変化
- Injection、secret leakage、unsafe external I/O
- Dependency / Supply Chain Riskの追加
- Business Logic上の不正な状態遷移
- Idempotency、Replay Protection、Privilege Separationの破壊
- Security Invariantの意図しない変更
- LLMによる誤解、confabulation、過剰な確信
- 生成量の増加によるreview coverageの低下

必要なのは、AIを信用するための仕組みではない。

> 変更主体を信用しなくても、検証範囲、証拠、未確認事項、残余Riskを説明できるVerification Infrastructureを構築する。

これは「脆弱性を一件も見逃さない」「現在のsystemが安全である」と証明する構想ではない。宣言されたscope、revision、threat model、tool capability、coverageの範囲で、何を確認でき、何を確認できなかったかを明示する構想である。

---

## 2. 目標

中心目標は、次のSecurity Learning Loopを形成することである。

```text
Project declarations + Durable knowledge
                 ↓
Task-scoped security context
                 ↓
Implementation planning and execution
                 ↓
Revision-bound observation and verification
                 ↓
Evidence + limitations + residual risk
                 ↓
Reusable knowledge candidates + feedback
                 ↓
Validated durable knowledge
```

このloopによって目指す状態は次の通り。

- 実装前に壊してはいけないSecurity BoundaryとInvariantを提示できる。
- 変更内容に応じて必要なverificationを選びつつ、最低限のbaselineを維持できる。
- LLMの説明ではなく、再確認可能なEvidenceを中心にVerdictを構成できる。
- 過去のFindingと修正結果から再利用可能なLessonを作れる。
- Knowledgeが実際に役立ったか、害を与えたかを追跡できる。
- systemが不明なことを、成功や安全として表現しない。

「コード生成量が増えてもSecurity Riskを比例増加させない」はNorth Starであり、そのままacceptance criterionにはしない。実際の採否は、coverage、見逃し、誤警告、time-to-evidence、再発率、verification costなど観測可能な指標で判断する。

---

## 3. 基本原則

### 3.1 SafetyではなくAssuranceを返す

systemは`safe`を返さない。最低限、次を返す。

- 対象projectとrevision
- declared scopeとthreat model
- 実行したverification
- 得られたEvidence
- coverageとcoverage gap
- assumptionsとunknowns
- residual risk
- verdictの根拠と有効期限

Zero Findingは`no_findings_observed`であり、安全の証明ではない。

### 3.2 EvidenceをSource of Truthにする

LLMはHypothesis、Planning、Semantic Interpretation、Explanationを担当できるが、Observationを作ったことにはしない。

一次Evidenceの例:

- scanner artifact
- source location
- deterministic structure fact
- call / data-flow trace
- runtime response
- reproduction result
- property violation
- test result
- formal proof / counterexample
- tool、rule、input、revisionのprovenance

LLM review、semantic similarity、risk forecast、historical lessonは補助情報であり、単独ではconfirmed findingを作らない。

### 3.3 Observation、Declaration、Inference、Knowledgeを分離する

```text
Observed:
  revision RでEndpoint EからAdminGuardが見つからない。

Declared:
  Endpoint Eはadmin authorizationを必須とする。

Inferred:
  Authorization Boundaryが削除された可能性が高い。

Knowledge:
  mutating admin endpointではauthorization boundaryを保持する。
```

ObservedをDeclaredへ自動昇格しない。InferredをFactとして表示しない。Knowledgeを現在revisionのEvidenceとして扱わない。

### 3.4 Full GraphではなくPurpose-bound Projectionを使う

AST、Call Graph、Control Flow、Data Flowの全量を永続的な共通Knowledgeへしない。Security判断に必要な部分を、対象revisionと目的に結び付けたbounded projectionとして扱う。

### 3.5 各systemは独立してdegradeできる

3つのproductは相互のSQLiteやprivate schemaを直接読まない。一つが停止しても、他の通常機能までsilent failureさせない。利用できない情報はlimitationとして明示する。

### 3.6 Policy BoundaryをLLMへ委譲しない

次はserver / host側の構造的契約として強制する。

- authorization
- credential access
- target scope
- active scan permission
- network / egress policy
- filesystem boundary
- timeout、CPU、memory、request、token budget
- revision、idempotency、ownership
- approvalとRules of Engagement

### 3.7 段階導入とValue Proofを必須にする

大きなOntology、万能Planner、完全なData Flow、Formal Verificationから開始しない。小さなuse caseでbaselineと比較し、価値と安全性が確認できた段階だけ次へ進む。

---

## 4. System Model

本構想は、3つのproductとproject側のdeclaration sourceを分離する。

```text
Target Repository / future Ontology Core
  declared semantics, owners, invariants, policies
                         │
contextStill             │             vulnWorkbench
  reusable knowledge ────┼───────────> current observations
  rules / procedures     │             security projection
  lessons / heuristics   │             verification / evidence
             │           │                       │
             └──────────> NightWorkers <─────────┘
                          task / run authority
                          planning / implementation
                          admission / orchestration
                          outcome feedback
```

Ontology Coreは将来必要条件を満たした場合の独立componentである。それまでは、repository-owned manifest、policy、test、documentationなどがProject Declarationの正本となる。

---

## 5. Responsibility Boundary

| Actor | Owns | Must not own |
|---|---|---|
| Target Repository / Ontology Core | project固有のdomain意味、owner、security invariant、policy、declaration revision | scanner observationの改変、task/run execution |
| vulnWorkbench | source/security observation、revision-bound Security Projection、scanner execution、evidence、coverage、finding、security assessment | canonical project meaning、task queue、patch適用、Knowledgeのactive化 |
| NightWorkers | goal interpretation、Task/Run、plan、queue admission、implementation、tool orchestration、completionとfeedback | scanner factの捏造、canonical Knowledge lifecycle、vulnWorkbench DBの直接参照 |
| contextStill | reusable rule/procedure/pattern/lesson/heuristic、candidate review、dedupe、retrieval、compile/decision feedback | current program state、scanner execution、task admission、project declarationの正本化 |

### 5.1 vulnWorkbench

vulnWorkbenchはSecurity Investigation / Verification Engineである。

担当すること:

- repository、diff、runtime、dependency、configurationの観測
- scannerのbounded executionとresult normalization
- Diagnostic Evidence Graph
- revision-bound Operational Security Projection
- Security Semantic Diff
- Risk Forecast candidate
- policy envelope内のSecurity Assessment Plan
- Evidence-backed finding、coverage、limitation、residual risk
- reusable Knowledge Candidateの材料生成

担当しないこと:

- Project Ontologyのcanonical lifecycle
- repository固有Invariantの正本管理
- NightWorkersのTask/Run/Queue管理
- source patchの自動適用
- contextStill Knowledgeのactive / rejected判断
- LLM判断だけによるfinding確定

### 5.2 NightWorkers

NightWorkersはExecution Orchestratorである。

担当すること:

- user goalとTaskの解釈
- plan、Todo、Run、worktree、queue、execution authority
- project declaration、contextStill context、vulnWorkbench assessmentのtask-scoped合成
- implementation前後のsecurity requirement保持
- approved interfaceを通じたscan / verification依頼
- 採用済みFeature Planまたは明示project policyが要求する場合のsecurity resultを含むcompletion、needs-human、blocked判断
- 実際に使ったKnowledge、実行したverification、結果のfeedback

担当しないこと:

- scanner artifactを独自にconfirmed findingへ変換すること
- vulnWorkbenchのprivate databaseを読むこと
- contextStillのcandidateを直接active化すること
- observed relationをcanonical declarationへ昇格すること
- policyで許可されていないtool権限をAgentへ与えること

Security evidence、verification、artifactが存在すること自体を、すべてのRunに対する固定completion gateにはしない。Userが採用したTask / Feature Planまたは明示的なproject policyにSecurity Contractが含まれる場合に限り、そのcontractをRunの完了条件へ反映する。

### 5.3 contextStill

contextStillはDurable Knowledge Control Planeである。

担当すること:

- Rule、Procedure、Pattern、Invariant Lesson、Verification Heuristicの蒸留
- source / evidence referenceとapplicabilityの保持
- candidate lifecycle、dedupe、merge、deprecation
- taskに必要な最小Contextのcompile
- positive / negative guardrail、past Episodeの区別
- exposure、selection、use、outcome、feedbackの記録
- Knowledge usefulnessとharmの評価

担当しないこと:

- AST、Full Graph、scanner raw outputの恒久保存
- current revisionのSecurity Verdict
- repository固有declarationのcanonical owner
- scannerやverification commandの実行
- NightWorkersのTask/Run/Queue判断

Project-scoped knowledgeを保持する場合も、canonical declarationとして扱わない。`PaymentService requires ManagerGuard`のようなproject固有の必須条件はrepositoryまたはOntology Coreを正本とし、contextStillはrevision付き参照またはderived lessonとして扱う。

### 5.4 Target Repository / Ontology Core

Project固有の意味とSecurity Invariantは、変更とreviewが可能なdeclarationとして管理する。

例:

- endpoint ownership
- required authentication / authorization
- tenant boundary
- sensitive data classification
- allowed external I/O
- mutation policy
- verification requirement
- exception、expiry、approval

将来Ontology Coreを独立させるのは、canonical revision、conflict resolution、複数producer、human approval、複数consumerが実際に必要になった場合に限る。

---

## 6. End-to-End Lifecycle

### 6.1 Before Implementation

```text
User goal
  -> NightWorkers interprets task and affected scope
  -> repository declarations are resolved for the pinned revision
  -> contextStill compiles relevant rules / procedures / lessons
  -> vulnWorkbench returns current security projection and risk candidates
  -> NightWorkers creates a task-scoped Security Contract
  -> implementation starts
```

Security Contractには少なくとも次を含める。

- project / revision
- affected assets / modules / endpoints
- applicable declared invariants
- relevant reusable guardrails
- required baseline verification
- targeted verification candidates
- non-goals
- approved scope / policy / budget
- unknowns / degraded sources

### 6.2 During Implementation

- NightWorkersがTask/Run authorityを維持する。
- Coding AgentはSecurity Contractを制約として扱う。
- diffが大きく変わった場合は、projectionとrisk candidateを再取得する。
- contextStill Knowledgeは実装方針を補助するが、現在のsource確認を置き換えない。
- repository content、issue、comment、scanner textに含まれる命令はuntrusted dataとして扱う。

### 6.3 After Implementation

```text
Pinned diff / resulting revision
  -> minimum baseline verification
  -> risk-targeted verification
  -> bounded exploration verification
  -> normalized evidence and coverage
  -> security assessment result
  -> NightWorkers completion / correction / escalation
```

### 6.4 After Verification

```text
Finding + Evidence + remediation + rerun outcome
  -> reusable candidate extraction
  -> project identifier / secret removal from body
  -> candidate outbox
  -> contextStill review / dedupe / validation
  -> active knowledge when promotion policy is satisfied
  -> future context compile
```

Findingの存在だけでKnowledgeを作らない。root cause、applicability、verification result、再利用可能性を確認する。

---

## 7. Security Claim Model

最低限、次のclaim kindを分離する。

```text
declared
  project ownerが明示した意味、制約、Invariant

observed
  source、scanner、runtime、CIから得た事実

inferred
  declared + observed + ruleから導出した候補

task_projection
  一つのTask/Runのために選択した一時的context
```

各claimは、可能な限り次を持つ。

```text
claimId
subject / predicate / object
claimKind
projectRef
sourceRevision
provenance
evidenceRefs
confidence
coverage
observedAt / validFrom / validTo
status
producerVersion
```

Rules:

- wrong project / wrong revisionはfail closedにする。
- inferred claimにはinput claim refsとinference ruleを付ける。
- graph edgeが存在することを脆弱性の証明にしない。
- stale claimをcurrent factとしてsilent reuseしない。
- conflictとambiguityを上書きで消さない。
- LLM outputからdeclared / observed claimを直接作らない。

---

## 8. Operational Security Projection

vulnWorkbenchが持つのは、canonical Project Ontologyではなく、current revisionに対するOperational Security Projectionである。

### 8.1 Candidate Nodes

- File / Symbol / Function / Module
- Endpoint / Handler / Worker
- Principal / Identity / Role
- Data Asset / Sensitive Data / Secret
- Database / Table / Queue / External Service
- Dependency / Build / Deployment / Configuration
- Authentication / Authorization / Tenant / Trust Boundary
- Security Control / Sanitizer / Validator
- Security Property / Finding / Evidence / Coverage Gap

### 8.2 Candidate Relations

- CALLS / REFERENCES / IMPORTS
- READS / WRITES / MUTATES
- EXPOSES / FLOWS_TO
- GUARDED_BY / AUTHORIZED_BY
- SANITIZED_BY / VALIDATED_BY
- DEPENDS_ON / DEPLOYED_AS
- CROSSES_BOUNDARY
- AFFECTED_BY / EVIDENCED_BY / VERIFIED_BY

### 8.3 Projection Rules

- Security-relevantなsubgraphだけを保持する。
- node / edgeにsource revision、provenance、confidence、coverageを持たせる。
- raw source bodyやsecretをagent-facing payloadへ含めない。
- full graphの構築完了をscan開始条件にしない。
- analyzer不足は`unavailable`や`degraded`として表現する。
- source revision変更時は再計算またはstale化する。

---

## 9. Security Semantic Diff

Line Diffに加え、Security上の意味の変化を候補として抽出する。

例:

```text
Before: Endpoint E GUARDED_BY AdminGuard
After:  Endpoint E has no observed guard

Candidate:
  authorization_boundary_removed
```

分類候補:

- introduced
- worsened
- unchanged
- resolved
- coverage_lost
- unknown

`guardが観測されない`ことと`guardが存在しない`ことを区別する。analyzer coverageが低下した場合は`resolved`ではなく`coverage_lost`または`unknown`とする。

初期use caseは狭くする。

1. Authorization guardの追加・削除・適用範囲変更
2. Dependency追加・version変更とSCA requirement

Tenant Isolation、business logic、full interprocedural data flowは、上記の価値とcorrectnessが確認された後の候補とする。

---

## 10. Security Risk Forecast

Risk Forecastは脆弱性判定ではなく、verification優先度を決めるためのtriage signalである。

入力候補:

- Task objectiveとplanned change surface
- touched boundary / sensitive asset
- fan-out / entrypoint / dependency delta
- declared invariants
- historical finding / recurrence
- analyzer coverage
- previous verification yield

出力候補:

- risk factors
- affected assets
- required baseline
- targeted verification candidates
- confidence / calibration band
- missing information
- forecast provenance

高risk forecastだけを詳しく検証し、低risk forecastを無検証にする設計にはしない。

---

## 11. Security Assessment Planner

LLMはScannerの代替ではなく、policy-constrained Investigation Plannerとして利用できる。

担当できること:

- Security Contextの要約
- Hypothesis生成
- Threat candidate生成
- verification候補の選択と順序付け
- Evidence不足の指摘
- limitationとresidual riskの説明
- re-plan candidateの作成

担当できないこと:

- target scopeの拡張
- credentialの選択・復号・表示
- active scanの許可
- server policyの緩和
- scanner outputの改変
- verification未実行を成功扱いすること
- LLM仮説だけでfindingをconfirmedにすること

NightWorkersはTask/Run全体を統括する。vulnWorkbenchのSecurity Assessment Plannerは、承認済みscopeとpolicy envelope内でsecurity verification planを作成・実行する。両者が独立したqueue authorityを持たないようにする。

---

## 12. Verification Strategy

全verificationを毎回実行する方式と、Plannerが選んだverificationだけを実行する方式のどちらにも寄せ切らない。

```text
Always-on minimum baseline
  + Risk-targeted verification
  + Bounded exploration budget
```

### 12.1 Minimum Baseline

project / technologyごとに、変更内容に関係なく維持する最小確認を定義する。

例:

- secret detection
- dependency / lockfile check
- owned SAST baseline
- required unit / integration security tests
- configuration / policy validation
- coverage integrity check

### 12.2 Targeted Verification

例:

```text
Auth change
  -> authorization matrix
  -> related SAST
  -> targeted DAST / replay test

Dependency change
  -> SCA
  -> provenance / license / supply-chain policy

Parser change
  -> property-based test / fuzzing

IaC change
  -> IaC scan / policy check
```

### 12.3 Exploration Budget

Risk modelが知らないclassの問題を検出するため、少量の固定またはrandomized explorationを残す。targeted pathとbaselineとの差分をshadow evaluationできるようにする。

### 12.4 Budget Selection

Plannerは次のresource limit内で動く。

- wall-clock time
- CPU / memory
- network requests
- tool runs
- artifact size
- LLM tokens / cost

`Security Information Gain`を直接観測できる前提にしない。初期は次のproxyで比較する。

- new coverage
- previously unverified invariantの確認数
- evidence strengthの改善
- historical yield
- false-positive reduction
- execution time / failure rate
- rerun reproducibility

---

## 13. Security Invariant and Contract

Invariantのsourceを区別する。

### Project-specific Declared Invariant

repositoryまたはOntology Coreが正本を持つ。

```text
Different tenant
  -> resource access must be denied
```

```text
Non-admin principal
  -> cannot execute admin mutation
```

### Reusable Knowledge

contextStillが一般化されたrule / procedureとして保持する。

```text
Request-provided tenant identifiers must be compared with authenticated identity.
```

### Observed Property Candidate

vulnWorkbenchがcurrent code / runtimeから候補を生成する。

```text
Endpoint E appears to reject cross-tenant object access in test run T.
```

NightWorkersはこれらをTask-scoped Security Contractへcompileする。Contractはcanonical invariantを複製せず、source refとrevisionを保持する。

---

## 14. Knowledge Distillation

### 14.1 Candidate Types

- Security Rule
- Verification Procedure
- Vulnerability Pattern
- Generalized Invariant Lesson
- Historical Lesson
- Verification Heuristic
- False-positive Lesson
- Negative Guardrail

### 14.2 Candidate Requirements

- LLM推測だけではないEvidence Reference
- applicable domain / technology / change type
- project固有identifierを除いたbody
- source projectとrevisionのprovenance metadata
- confidenceとknown limitation
- deterministic fingerprint
- secret / credential / private pathの除去
- downstream registration outcomeの追跡

### 14.3 Lifecycle

```text
candidate
  -> quarantined / draft
  -> validated
  -> active
  -> deprecated / superseded / rejected
```

LLMが生成したcandidateを自動的にactiveにしない。高影響のnegative guardrail、verification省略heuristic、cross-project ruleは、Evidenceとpromotion policyを満たすまでdraftに留める。

### 14.4 Feedback and Poisoning Control

次を別々に記録する。

- retrieved / exposed
- selected
- actually used
- verification outcome
- prevented recurrence candidate
- false warning / harmful guidance
- user override
- regression after use

system自身のLLM verdictをground truthとして再学習しない。scanner、test、reproduction、human correction、external benchmarkなど独立したsignalを使う。Knowledgeの利用頻度だけで正しさを決めない。

---

## 15. Information Lifecycle

### Long-lived

- validated Rule / Procedure / Pattern
- generalized Lesson / Heuristic
- promotion / deprecation history

主にcontextStill。

### Revision-bound / Medium-lived

- Operational Security Projection
- Finding / Reproduction / Assessment
- Security Graph Delta
- verification Evidence / coverage
- Task-scoped Security Contract

主にvulnWorkbenchとNightWorkers。

### Short-lived / Cache

- raw LSP response
- temporary call / data-flow trace
- fuzzing intermediate data
- temporary hypothesis
- planner scratch state

主にvulnWorkbench。必要なprovenanceとbounded artifactを除き、無期限保存しない。

### Recomputable

- risk score
- blast radius candidate
- reachability classification
- semantic ranking
- cost / information-gain proxy

input revisionとproducer versionを保持し、必要時に再計算する。

保存しないもの:

- LLM chain-of-thought
- raw secret / credential
- 無制限のsource全文
- project間共有のためだけのraw scanner output複製
- provenanceのないKnowledge

---

## 16. Integration Contracts

ここではAPI名やtransportを固定せず、意味上のcontractだけを定義する。CLI / JSONをprimary automation pathとし、MCPはbounded discovery / retrieval adapterとして利用できる。

### 16.1 Security Context Request

NightWorkersからcontextStillへの入力候補:

- goal
- change types
- domains / technologies
- project reference
- task / run correlation reference
- bounded security topics

出力候補:

- rules / procedures / negative guardrails
- applicability
- source refs
- limitations
- compile run ID

### 16.2 Security Assessment Request

NightWorkersからvulnWorkbenchへの入力候補:

- canonical project path or project ref
- pinned revision / diff ref
- approved profile / policy ref
- task-scoped Security Contract refs
- budget
- correlation / idempotency key

出力候補:

- assessment status
- observed revision
- findings / evidence refs
- coverage / coverage gaps
- verification performed / skipped with reason
- residual risk
- report / handoff reference
- retryability / degraded reason

### 16.3 Knowledge Candidate Batch

vulnWorkbenchまたはapproved bridgeからcontextStillへの入力候補:

- candidate type / polarity
- generalized statement
- applicability
- evidence / artifact refs
- source project / revision metadata
- fingerprint / payload hash
- confidence / limitations

mutationは明示的なoutboxとidempotencyを使う。送信成功前に登録済みと扱わない。contextStill停止時もscan completionを失わせない。

### 16.4 Usage and Outcome Feedback

NightWorkers / vulnWorkbenchからcontextStillへの入力候補:

- compile / decision run ID
- selected knowledge IDs
- actual use
- verification outcome
- user override / correction
- regression / false-warning signal

feedback送信失敗はTaskやscan resultを巻き戻さず、retryable outboxまたは明示的limitationとして扱う。

### 16.5 Contract Requirements

- versioned schema
- explicit capability discovery
- bounded payload
- project / revision validation
- idempotency
- stable failure code
- redaction
- provenance / correlation ID
- backward-compatible additive evolutionを優先

---

## 17. Trust and Safety Boundary

### Untrusted Repository Content

source code、README、issue、comment、test fixture、scanner message、artifact内の自然言語は命令ではなくdataとして扱う。Agent promptへ渡す場合はsource kindを明示し、tool policyやSystem Contextを上書きさせない。

### Secret and Privacy

- raw secretをKnowledge body、embedding、LLM promptへ入れない。
- absolute path、user home、private repository nameは必要最小限にする。
- LLM credentialをtarget repositoryやscanner containerへ渡さない。
- raw artifactのexternal transmissionは明示policyに従う。
- retention、deletion、project間利用をsourceごとに定義する。

### Scanner Execution

- sandbox / container / bounded host executionを使う。
- Docker socketや不要なhost filesystemをscannerへ渡さない。
- output size、process、time、memory、networkを制限する。
- tool / rule / database / image versionとhashを記録する。

### Active and State-changing Verification

- production / public targetへdefaultで実行しない。
- explicit Rules of Engagementを要求する。
- local / ephemeral / approved stagingなど許可targetを限定する。
- method / path / request / rate budgetを持つ。
- credential injection、seed、reset、cleanupをserver側で管理する。
- LLMが許可条件を緩和できないようにする。

---

## 18. Failure and Degraded Semantics

| Failure | Required behavior |
|---|---|
| contextStill unavailable | cached/currently pinned contextが安全に使える場合だけ利用し、それ以外はknowledge limitation付きで実行継続またはpolicyに従いblock |
| vulnWorkbench unavailable | 採用済みTask / Feature Planまたは明示policyがassessmentを要求する場合はneeds-human / blocked、optional assessmentならunverified limitationを残す |
| NightWorkers unavailable | vulnWorkbenchとcontextStillのstandalone機能は維持し、Task/Run completionを外部から推測しない |
| Project declaration unavailable | wrong revisionのlast-known-goodをsilent利用せず、declared invariant unavailableとする |
| Analyzer degraded | missing edgeをabsence proofにせず、coverage gapとして返す |
| LLM unavailable / invalid | deterministic evidence / reportを保持し、LLM stageだけdegradedにする |
| Candidate registration failed | outboxをpending / failedにし、active knowledge扱いしない |

`unknown`、`unsupported`、`not_applicable`、`blocked`、`failed`を区別する。

---

## 19. Parallel Development Model

3projectを同時開発する場合も、最初にcontractとfixtureを固定する。

### Shared Lane: Contract First

- concept version
- responsibility matrix
- project / revision identity
- request / result schema
- error / degraded codes
- redaction policy
- correlation / idempotency
- cross-repository golden fixtures

### vulnWorkbench Lane

- revision-bound Security Projection
- authorization / dependency delta use case
- assessment request / result
- evidence / coverage / limitation
- Knowledge Candidate material

### NightWorkers Lane

- task-scoped Security Contract composition
- context and assessment request adapters
- queue / run / approval boundary
- result projection and completion semantics
- usage / outcome feedback

### contextStill Lane

- Security Knowledge Candidate validation
- candidate lifecycle / dedupe / promotion
- security-aware context compilation
- source / applicability / provenance
- usefulness and harm feedback

### Integration Lane

- same fixtureを3consumerで検証
- wrong project / revision negative tests
- service unavailable / timeout tests
- secret / path redaction tests
- end-to-end paired pilot

各laneはprivate database schemaを共有しない。shared contractが不安定な間は、各project内部実装を先行して外部契約へ固定しない。

---

## 20. Staged Rollout

### Stage 0: Contract and Baseline

追加するもの:

- common concept
- versioned semantic contract
- current behavior / cost / coverage baseline
- pilot datasetとfailure taxonomy

まだ追加しないもの:

- default activation
- full ontology
- autonomous planner
- automatic candidate activation

Exit gate:

- 3projectが同じidentity、revision、failure semanticsを解釈する。
- wrong project / revision / secret leakage testが通る。
- 変更前baselineが保存される。

### Stage 1: Two Narrow Use Cases

対象:

1. Authorization guard change
2. Dependency addition / version change

追加するもの:

- bounded observation
- semantic delta candidate
- baseline + targeted verification
- evidence-backed assessment result

Exit gate:

- known positive / negative fixturesで説明可能な結果を出す。
- analyzer degradationをsafe resultへ変換しない。
- existing scan / task completionを非劣化に保つ。

### Stage 2: Project Loop

追加するもの:

- NightWorkers Security Contract
- pre / post assessment correlation
- rerun outcome
- project declaration参照

Exit gate:

- implementation前のconstraintが変更後verificationまでtraceできる。
- evidence refs、coverage、unknownがRunから追える。
- security integration不使用時の通常Runを壊さない。

### Stage 3: Knowledge Shadow Loop

追加するもの:

- candidate outbox
- contextStill draft / quarantine
- retrieval shadow mode
- use / outcome / harm feedback

まだ追加しないもの:

- automatic active promotion
- verificationの自動省略
- knowledgeによるpolicy緩和

Exit gate:

- candidate provenanceとdedupeが安定する。
- harmful / irrelevant retrievalを測定できる。
- Knowledge利用有無を比較できる。

### Stage 4: Prevention and Recommendation

追加するもの:

- pre-change risk forecast
- targeted verification recommendation
- user / policy-controlled adoption
- calibrated confidence

Exit gate:

- baselineよりtime-to-evidenceまたはcoverageを改善する。
- required verification omissionを増やさない。
- low confidenceで安全にfallbackする。

### Stage 5: Advanced Verification

候補:

- incremental graph update
- broader data flow
- business logic invariant engine
- fuzzing / property-based verification
- budget optimization
- formal verification

Stage 4までのvalue evidenceがない場合は着手しない。

既存のProject Intelligence paired pilotが`INSUFFICIENT_EVIDENCE`である限り、この文書だけを理由にdefault ONや大規模Ontology投資へ進まない。

---

## 21. Evaluation Metrics

### Correctness and Coverage

- known fixture recall / precision
- false-positive / unknown rate
- coverage loss detection rate
- wrong project / revision incident
- evidence provenance completeness
- reproduction / rerun consistency

### Planner and Forecast

- risk band calibration
- required verification selection recall
- baselineに対するadditional coverage
- time / cost / tool-run budget error
- low-confidence fallback success
- planner recommendationの採用 / 却下 / override

### Knowledge

- candidate acceptance / rejection / duplicate rate
- retrieval precision / not-relevant rate
- selected / actually-used rate
- harmful guidance / false-warning rate
- recurrence reduction candidate
- stale / superseded knowledge rate
- evidence ref integrity

### Product Value

- time-to-first-evidence
- time-to-actionable-handoff
- correction cycle
- escaped known-class regression
- same-class recurrence
- verification cost per actionable result
- integrationを利用したRunのcompletion / failure差

benchmark score、real-repository value、user adoptionを一つのscoreへ混ぜない。sample size、selection bias、unsupported scope、unknownをreportから省略しない。

---

## 22. Stop and Rollback Conditions

次を観測した場合、default activationまたは次Stageへの移行を停止する。

- wrong repository / wrong revisionのcontextまたはEvidence混入
- inferred claimのdeclared / observedへのsilent promotion
- zero findingの安全判定化
- active scan scope / credential / network policy違反
- secret、private source、absolute pathの不適切な外部送信
- baseline verificationのsilent omission
- analyzer failureをresolved findingとして扱う挙動
- candidate登録失敗のactive扱い
- Knowledge利用による有意な誤警告・誤修正増加
- cost増加に対するcoverage / actionability改善がない状態
- source artifactとnormalized resultの説明不能な不一致

rollbackはfeature flag、independent adapter、versioned contractによってproject単位で可能にする。既存Evidenceとhistorical outcomeを破壊的に書き換えない。

---

## 23. Non-Goals

- system全体が安全だと証明すること
- professional penetration testを無条件に置き換えること
- LLMに自由探索させ、推測だけで脆弱性を作ること
- Full AST / Program GraphをDurable Knowledgeとして保存すること
- vulnWorkbench、NightWorkers、contextStillのいずれかをcanonical Project Ontologyにすること
- contextStillをscanやTask実行の必須依存にすること
- project間でprivate databaseを直接参照すること
- MCPをarbitrary filesystem / command / mutation surfaceにすること
- source patchをSecurity Learning Loopから自動適用すること
- low-risk forecastをverification不要の根拠にすること
- Knowledge popularityをtruthとみなすこと
- Formal Verificationを初期導入の前提にすること
- 全scanner、全言語、全threatを一度に扱うこと

---

## 24. Open Decisions

後続の実装計画で、Evidenceを採取して決める。

1. Stage 1の最小Security Projection schema。
2. Project Declarationの初期formatとrepository ownership。
3. Security Contractのversioned schema。
4. vulnWorkbench plannerとNightWorkers orchestrationの具体的handoff。
5. required / optional security gateのproject policy。
6. candidate promotionに必要なEvidenceとhuman review範囲。
7. project-scoped lessonのretention / revision expiry。
8. baseline、targeted、exploration budgetの割合。
9. paired pilotのsample、holdout、success threshold。
10. Ontology Coreを独立させるmandatory triggerの到達時期。

---

## 25. Concept Completion Definition

このconceptを前提に作られる実装計画は、少なくとも次を満たす。

- Safety claimではなくscope / coverage / evidence / unknownを返す。
- 4 actorの責務が重複しない。
- declared / observed / inferred / task projectionを区別する。
- vulnWorkbench graphをrevision-bound projectionとして扱う。
- NightWorkersがTask/Run authorityを維持する。
- contextStill Knowledgeをcurrent Evidenceの代替にしない。
- baseline + targeted + explorationを維持する。
- LLMにpolicy boundaryを委譲しない。
- candidate poisoningとself-reinforcing feedbackへのcontrolを持つ。
- service unavailable時のdegraded behaviorを定義する。
- baseline、evaluation、stop / rollback conditionを本文に含める。
- 3projectがversioned contractとfixtureで独立に検証できる。

---

## 26. Center Statement

本構想の中心は、Scannerを増やすことでも、巨大なOntologyを作ることでもない。

> Project固有の宣言と再利用可能な知識を使って変更前の制約を作り、current revisionを観測し、必要なverificationを安全なpolicy内で実行し、Evidenceと未確認事項を返し、検証済みの教訓だけを次の実装へ戻す。

役割を短く表すと次の通り。

```text
Target Repository / Ontology Core
  = Declare and govern project meaning

vulnWorkbench
  = Observe, investigate, verify, produce evidence

NightWorkers
  = Plan, execute, orchestrate, correlate outcomes

contextStill
  = Distill, validate, remember, compile knowledge
```

この境界を維持し、狭いuse caseから価値を実証できた場合に限り、Security Learning Loopを段階的に広げる。
