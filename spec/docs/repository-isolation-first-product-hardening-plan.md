# Repository Isolation First Product Hardening Plan

## Status

Status: repository-isolation implementation, live migration, and enforced canary complete; producer observation/final closeout and later architecture/product work pending.

Created: 2026-08-15

この文書は、repository isolation、実装所有権、巨大module、SQLite-first onboarding、release運用を一つのprogramとして並べる上位計画である。個別のidentity contractやmigration手順を重複定義せず、既存計画をどの順で完了させ、次の改善へ進むかを定める。

本書を作成するための調査では、source code、git diff、live resident process、live SQLiteのschema/inventory、active MCP tool ownership、TypeScript/Rustのcompile caller、producer、retrieval、replay/cache、onboarding、CI、release filesを確認した。その後repository-isolation code、live migration、resident daemon更新、50-call enforced cohortを実施した。実行結果は[Closeout Evidence](context-compile-repository-isolation-closeout-evidence.md)を正本とする。

## 1. Executive Decision

優先順位は次のとおりとする。

| Priority | Outcome | Release block |
| --- | --- | --- |
| P0 | repository isolationをactive local profileでfail-closedにする | block |
| P1 | compile semanticsのownerをRustへ一本化し、TypeScriptをclientへ縮小する | block for maintained product release |
| P2 | safety-criticalな巨大moduleを責務単位に分割する | block only for touched critical modules |
| P3 | onboardingをSQLite-firstへ統一し、release運用を成立させる | block for first supported release |

判断は次の6点である。

1. repository isolationはDB fileの統合問題ではない。request identity、write、migration、retrieval、traceを一つのlogical boundaryとして閉じる。
2. working tree上のT1 foundationとlive deploymentを区別する。最終確認時のsource schemaはrevision 5まで進んでいる一方、確認時のresident DBはrevision 1であり、live MCP schemaもidentity fieldを公開していなかった。
3. producer observationは`PERSISTED`だけを数え、enabled producer manifestが省略・空・未観測を含む場合はcompletion gateをfail closedにする。
4. isolationのenforcement完了前に、compile engineの大規模統合や巨大fileの全面分割を混ぜない。
5. MCPのactive ownerはRustだが、CLI、init-project、UI/APIはTypeScript compile serviceを使用している。TypeScript全体をdormantとは扱わない。
6. TypeScriptのcwd既定、Rust daemonのApplication Support既定、LaunchAgentのrepository data指定は意図した運用profileとして維持する。自動mergeや一つのpathへの統一は行わない。

## 2. Existing Plans And Authority

個別の正本は次のとおりである。

| Document | Authority |
| --- | --- |
| [Context Compile Repository Isolation Closeout Plan](context-compile-repository-isolation-improvement-plan.md) | identity operating profile、安全invariant、P0-P5、shadow/canary gate |
| [Context Compile Repository Isolation T0 Evidence](context-compile-repository-isolation-t0-evidence.md) | cross-repository reproduction、inventory、baseline evidence |
| [Rust Runtime Closeout Implementation Plan](rust-runtime-closeout-implementation-plan.md) | effective DB identity、doctor、backup、resident runtime、path truth |
| [Security Intelligence Integration Concept](security-intelligence-integration-concept.md) | trusted projectRef、Security adapter、T7相当の後続作業 |

本書が所有するのはprogram順序、workstream間のentry/exit gate、実装所有権、保守性、onboarding、releaseである。

矛盾がある場合は、repository safety invariantにはisolation closeout plan、effective databaseにはRust runtime closeout planを優先する。本書はそれらを緩和しない。

## 3. Confirmed Evidence Snapshot

数値は2026-08-15のplanning snapshotであり、implementation開始前にread-onlyで再計測する。

### 3.1 Runtime And Schema

| Observation | Evidence | Consequence |
| --- | --- | --- |
| resident MCP ownerはRust-native 12 tools、TS sidecar 0 | native_tools.rsのtool owner inventory | MCP isolationはRustを最初に直す |
| running daemonはworking treeのbinaryより古い | live processとbinary timestamp、live tools/list | source test passだけでdeployment完了にしない |
| sourceのCURRENT_SCHEMA_REVISIONは最終確認時5 | sqlite_writer/schema.rs | restart前にlive revision→対象build宣言revisionをtemp copyでrehearseする |
| live DBのschema_migrationsはrevision 1 | read-only SQLite query | T1はsource foundation complete、operational deployment pending |
| live MCP context_compile schemaにidentity fieldがない | live tools/list | caller adoptionはまだ開始していない |
| live DBはcanonical identity columnsを欠く一方、一部additive tableは存在する | schema capability report | partially-shaped DBとして扱い、table存在だけでmigration済みにしない |

### 3.2 Isolation Baseline

| Observation | Snapshot |
| --- | ---: |
| canonical contract上unresolved Knowledge | 7,227 |
| canonical contract上unresolved Source | 178 |
| canonical contract上unresolved EpisodeCard | 6,602 |
| legacy repo identityを持つEpisodeCard | 5,761 |
| 直近20 runのidentity-present | 0 |
| 直近20 runのrequest/selection mismatch | 20 |
| 直近30日のcompile run | 1,823 |
| identity-present run | 0 |
| producer identity-bearing accepted event | 5 |
| 観測producer | agent-log-sync.typescriptのみ |
| 観測期間 | 約0.007日 |

このbaselineは、identityを受理するschemaを追加しただけでは安全にならず、caller、producer、migration、retrievalの順序が必要であることを示す。

### 3.3 Producer Observation Resolution And Remaining Gate

実装前draftではidentity validation直後のACCEPTEDをcompletionへ数え、後続write失敗や単一producerへの偏りでfalse completionになる可能性があった。

現在はVALIDATED、REJECTED、PERSISTEDを分離し、entity write成功後または同一transaction内のPERSISTEDだけを7日・200件gateへ数える。failure injectionではentityとPERSISTED auditがともにrollbackすることを検証した。

P1の観測gateは次のとおりである。

- validation成功とdurable persistence成功を区別する。
- completion集計はcommit後、または同じtransaction内でcommitされるPERSISTED eventだけを数える。
- failed writeはPERSISTEDへ数えない。
- release buildでenabledな全producerについて、観測済み、明示disabled、削除済みのいずれかを記録する。
- 7日、identity-bearing persisted 200件、new unresolved 0件に加え、enabled producer coverage 100%を要求する。
- global writeは別cohortとして扱い、identity-bearing件数を水増ししない。

reportには`--enabled-producers`でruntime inventoryを渡す。manifest省略、空manifest、未観測producerありのいずれもcompletion falseとなる。2026-08-15のlive auditには旧ACCEPTEDが5件、PERSISTEDが0件であり、7日間のcompletion windowはまだ開始できていない。

### 3.4 Retrieval Resolution

実装前はactive Rust context_compileがKnowledge最大500件、EpisodeCard最大200件のunscoped候補を先に取得し、public searchと継続TypeScript pathにもpre-limit/fallback gapがあった。

現在はRust context_compile/public searchと継続TypeScript pathでcanonical scope/classification/facet eligibilityをrankingとarbitrary limitより前へ移し、legacy/unscoped fallbackを除去した。scope-aware prefilter不能なSQLite vector laneは安全に無効化する。

修正対象としたTypeScript側の旧経路は次のとおりだった。

- knowledge.service.tsはscoped resultが0件ならlegacy metadata、さらにunscoped searchへfallbackする。
- source-retrieval.service.tsはcompile identityをtext/vector repositoryへ渡さず、scopedSearch=falseを返す。
- EpisodeCard repositoryは最新500件を取得した後でrepo/facetをfilterする。
- replay comparisonはrunのfacetsを読むが、current CompileInputへidentityを戻さない。
- landscape cache keyはraw input由来で、identity contract/retrieval semantics versionを持たない。

これらはshared fixture、limit saturation、identity missing、replay/cache testsと50-call enforced cohortで回帰検証した。

### 3.5 Dual Implementation

active surfaceは次のように分かれている。

| Surface | Current compile owner |
| --- | --- |
| resident MCP context_compile | Rust |
| public Rust search tools | Rust |
| CLI compile | TypeScript |
| init-project compile | TypeScript |
| UI/API compile | TypeScript |
| TypeScript MCP registry | sourceは存在するがresident ownerではない |

さらにsecurityIntelligenceShadowはTypeScript compile schema/toolだけに追加され、Rust context_compileのallowed args/schemaには存在しない。これをrepository-isolation shadowの証拠に数えることはできない。

### 3.6 Maintainability

production codeの大きな単一fileには、行数だけでなく複数責務の同居がある。

| File | Lines | Mixed responsibilities |
| --- | ---: | --- |
| web/src/modules/admin/components/settings.page.tsx | 4,385 | form model、route transform、secret、provider UI、tabs、page orchestration |
| crates/context-stilld/src/domains/queue_lifecycle/episode_executor.rs | 3,687 | queue execution、domain transition、persistence、provider interaction |
| crates/context-stilld/src/domains/mcp_lifecycle/native_compile.rs | 3,016 | input、retrieval、composer transport/parser、persistence、trace、tests |
| src/modules/queue/core/worker.ts | 2,347 | multiple queue workflowsとfailure handling |
| src/modules/context-compiler/context-compiler.service.ts | 2,044 | retrieval lanes、pack assembly、trace、usage、composer orchestration |

context-compiler.service.tsは将来削除候補の二重実装である。先に美しく分割するのではなく、必要なsafety fixだけを行い、Rust ownerへcallerを移した後に縮退・削除する方が総保守コストは低い。

### 3.7 Product Entry And Release

- READMEはSQLite-firstと明記し、PostgreSQLをlegacy compatibilityと位置付けている。
- CONTRIBUTINGのdefault setupはDocker Compose、PostgreSQL migrationである。
- interactive startupのtypes/prompts/serviceはprovider=postgresを固定し、Docker、PostgreSQL validation、db:migrateを実行する。
- setup.service.tsにはSQLite branchが既にあるため、新しい三つ目のonboarding implementationを作る必要はない。
- verify:desktop-readiness scriptはあるが、verify workflowに独立した必須jobとして現れない。
- Tauri source/configはなく、READMEもpackaging未実装を認めている。
- package.jsonとRust daemonは0.1.0だが、release workflowとGit tagがない。
- CHANGELOGはGit historyへ委任しており、Unreleasedの少数項目しか持たない。

GitHub star数はproduct maturityの参考値にはなるが、correctnessやrelease gateには使わない。

## 4. Safety Invariants And Non-Goals

### 4.1 Program Invariants

1. identityはrequestごとに一度resolveし、retrieval、pack、usage、traceで同じsnapshotを使う。
2. project requestはmatching repoと明示globalだけ、identityなしは明示globalだけをeligibleにする。
3. unresolved、conflict、malformed dataをnormal retrievalへ入れない。
4. lower-priority identity、legacy metadata、URI prefix、cwd、daemon root、unscoped queryへfallbackしない。
5. eligibilityをranking、ANN top-K、arbitrary limitより前に適用する。
6. shadow-only contentをcomposer、pack、usage、external providerへ渡さない。
7. safety rollbackでunscoped fallbackを復活させない。
8. enabled backend/surfaceは同じsafety contractを満たす。満たさないsurfaceはnormal profileで無効化する。

### 4.2 Non-Goals

- TypeScript cwd DB、Rust Application Support DB、LaunchAgent repository DBを一つへ統合しない。
- queue.sqlite、test DB、E2E DBをrepository isolation inventoryへ混ぜない。
- repository DBとApplication Support DBを自動copy、merge、moveしない。
- isolation変更のついでにRust compileへSource retrievalを新規追加しない。
- historical unresolved itemを本文、basename、Git remote、類似度から自動分類しない。
- projectRefをauthorization tokenとして扱わない。
- Tauri packagingが存在するように文書やrelease名を先行させない。
- isolation enforcementと大規模format/refactorを同じdelivery unitへ混ぜない。

## 5. Target Architecture

安全なselection pathは次の一方向になる。

```text
workspace caller
  -> canonical request identity
  -> scope/classification/facet eligibility
  -> text/vector ranking
  -> composer
  -> pack / usage / trace identity snapshot

producer
  -> write identity validation
  -> durable entity write
  -> persisted producer observation

deterministic migration
  -> canonical columns
  -> migration audit
  -> the same eligibility predicate
```

長期的にはRust daemonをcompile semanticsの単一ownerにする。TypeScriptはUI/API/CLIのpresentationとtransport adapterを担当し、独自retrieval/composer semanticsを持たない。

## 6. Program Gates

### G0: Worktree Containment And Operational Baseline

Goal: 現在の大きな未コミット変更を、検証可能でrollback可能なdelivery unitへ分け、live migrationを安全に開始できる状態にする。

Tasks:

- current diffをrepository identity foundation/producer、backfill/report、Security ingress concurrency、TypeScript-only Security shadow、その他へ分類する。
- 共有fileに複数topicがある場合は、commit/PR単位のownership manifestを作る。既存変更をresetして分けない。
- live schema revisionから対象buildが宣言するCURRENT_SCHEMA_REVISIONまでをlive DBのcopyでrehearseする。計画書の固定値をmigration targetにしない。
- migration前後のschema_migrations、table/column/index、row count、integrity_check、DB file checksumを記録する。
- current draftではrevision 2 identity、revision 3 Security ingress、revision 4 backfill audit、revision 5 Security candidate provenanceが同時適用される影響を確認する。
- effective live DBをdaemon status/doctor/backup/pathsが同じidentityとして報告できることをRust runtime closeout planで先に保証する。
- resident binaryのversionだけでなく、実行pathとbuild identityを確認できるdiagnosticを用意する。

Exit gate:

- topicごとのdelivery unitとrollback ownerが明示されている。
- temp-copy migrationを2回行い、同じschema結果とrow countを得る。
- backup/restore targetがeffective live DBと一致する。
- live DBを変更せずにmigration runbookをreviewできる。

Stop conditions:

- effective DBが曖昧なままbackupまたはrestartする。
- dirty worktree全体を一つのrepository isolation changeとしてmergeする。
- tableが存在するだけでrevision完了と判断する。

### G1: Caller Adoption And Durable Producer Closure

Goal: active requestがidentityを送り、新規repo-scoped dataがcanonical identity付きでdurably保存される状態にする。既存closeout planのP0/P1に対応する。

Caller tasks:

- new Rust daemonをcontrolled restartし、tools/listのcontext_compile/search toolsでidentity fieldsを確認する。
- workspace MCP、CLI、init-project、UI/API callerをinventoryする。
- workspace rootをauthoritative repoPathとしてcaptureできるcallerだけがproject requestを送る。
- identityをcaptureできないcallerはglobal-onlyを明示し、cwdで補わない。
- request/run/task traceにcontract version、basis、fingerprintが一致して保存されることを確認する。

Producer tasks:

- TS/Rustのwrite contract fixtureを一つのcanonical behavior setとして維持する。
- repository method以外のdirect writer、seed、migration CLI、queue worker、Security ingress、portability importもproducer inventoryへ含める。
- producerごとにruntime active、maintenance-only、test-only、disabledを分類する。
- agent logのprojectNameをrepoKeyへ昇格しない。
- markdown contentRootをrepository rootと同一視しない。
- compile-derived EpisodeCardはrequest/run snapshotだけを使う。
- global writeはidentity columns NULL、repo writeはexact identity requiredにする。

Observation redesign:

- VALIDATED、REJECTED、PERSISTEDを区別するか、既存ACCEPTEDをcommit後へ移す。
- SQLiteではentity writeとPERSISTED auditを可能な限り同一transactionでcommitする。
- 複数database/remote backendではoperation IDでwrite resultとobservationをcorrelateする。
- reportはPERSISTEDだけをcompletion countへ含める。
- producer別、entity別、repo/global別、rejection code別のcoverageを出す。

Exit gate:

- live tools/listにidentity fieldsがある。
- 20連続active workspace callのidentity-present率100%、request/trace mismatch 0。
- omitted identity smokeはglobal-onlyで、cwd/daemon rootを保存しない。
- 7日以上、identity-bearing PERSISTED 200件以上、new unresolved 0。
- enabled producer coverage 100%。未観測producerはrelease buildでdisabledか削除済み。
- validation後にwriteを故意に失敗させるtestでPERSISTEDが増えない。

### G2: Deterministic Migration

Goal: availabilityを維持する価値のあるitemとauthoritative provenanceを持つitemだけをclassifiedにする。既存closeout planのP2に対応する。

Current draft assessment:

- repository-identity-backfill.tsはpure deterministic planner、fingerprint、reason code、conflict/malformed処理を持つ。
- repository_identity_migration_audits schemaもdraftにある。
- 一方、live inventory reader、dry-run artifact、transactional writer、restore command、top-50 review input、post-write zero-update verificationはまだ別途必要である。
- legacy backfill:knowledge-project-contextはJSON metadata中心でcanonical migration auditを満たさないため、本migration runnerとして再利用しない。

Tasks:

- read-only inventoryからstable-sorted migration planを生成する。
- dry-run artifactにentity ID、before/after fingerprint、reason、provenance source、migration version、checksumを含める。本文は既定で出力しない。
- dry-runを同一snapshotへ2回実行し、checksumを一致させる。
- historical selection上位50 Knowledgeをlocal reviewし、明示global/repo/unresolved decisionを残す。
- exact canonical/legacy path、trusted capture、identity-bearing run、authoritative alias、review decisionだけを根拠にする。
- Sourceは旧process.cwd由来metadataを自動確定せず、identity付きreimportを優先する。
- writerは一transactionまたはentity batch単位でauditとrow updateをcommitする。
- write後に同じmigrationを再実行し、updates 0を確認する。
- temp-copy restore drillと直近500 runのoffline eligibility simulationを行う。

Exit gate:

- top-50 review完了。
- dry-run repeat checksum一致。
- write countとaudit count一致。
- rerun update 0。
- wrong-project eligible 0。
- unresolved残数とavailability影響が記録されている。unresolved 0は要求しない。

### G3: Retrieval Enforcement And Side-Effect-Free Shadow

Goal: active retrievalがcanonical scope boundaryをquery時に適用し、user-visible切替前に安全性を比較できる状態にする。既存closeout planのP3に対応する。

Canonical eligibility:

```text
classified
AND (
  scope = global
  OR (
    request has identity
    AND scope = repo
    AND selected identity basis equals exactly
  )
)
AND facet eligibility
```

Implementation order:

1. Rust context_compile Knowledge.
2. Rust context_compile EpisodeCard.
3. Rust public search_knowledge.
4. Rust public search_episodes.
5. releaseで公開継続するTypeScript/SQLite/PostgreSQL path。

Tasks:

- resolved identity objectをsearchへ渡す。
- SQL eligibility predicateと必要indexを用意し、limit/ranking前に適用する。
- missing identityはglobal-only queryを使う。
- TS knowledgeのlegacy/unscoped fallbackを削除する。
- TS Sourceを公開継続する場合はidentityをrepositoryへ渡し、text/vector双方をscope-awareにする。
- EpisodeCardの500件pre-limit後filterをscope-aware SQLへ置換する。
- vector laneがpre-filterできない場合はeligible ID先行方式かsafe text/exact fallbackへdegradeする。
- public search schemaとimplementationのrepo/facet fieldsを一致させる。
- shadowはcandidate ID、count、exclusion reason、latencyだけを保存する。
- TypeScript-only securityIntelligenceShadowをisolation shadowの実績に数えず、Security workstreamへ分離する。

Exit gate:

- Repo A/B/global/unresolved/malformed shared fixtureがRustと公開継続pathで同じeligible setになる。
- wrong-project shadow candidate 0。
- missing identityのrepo candidate 0。
- 500/200を超えるwrong-repo saturation fixtureでもmatching itemを取得する。
- shadow-only contentのoutbound、pack、usage 0。
- identity-present shadow 50 call以上。
- compile p95、selected count、No Content rateがcloseout planのgate内。

### G4: Replay, Canary, Default Enforcement

Goal: identityを失わずにreplayでき、active local profileをenforcedへ切り替える。既存closeout planのP4/P5に対応する。

Tasks:

- compileInputFromRunへnormalized identityとbasisを復元する。
- legacy identityなしrunをlegacy_identity_unknown/not_comparableにする。
- current rollout中はcacheをdisabledのまま維持し、old semantics payloadをstale化する。
- Repo A/B/global-only replay smokeを行う。
- dedicated local canaryを20 call以上実行する。
- canaryを24時間以上維持し、通常操作とnegative smokeを含める。
- live read-only auditとsafe rollback drillを実行する。

Hard-zero gate:

- wrong-project candidate/outbound/pack/usage: 0。
- unresolved/malformed/conflict selected item: 0。
- request/trace identity mismatch: 0。
- shadow-only content outbound: 0。

Exit gate:

- active normal local profileがenforced default。
- availability/performance gate pass。
- rollbackがglobal-only safe modeまたは直前のsafe predicateへ戻り、unscoped fallbackを復活させない。
- closeout evidenceを保存し、isolation planをarchiveできる。

G4完了をrepository isolationの完了点とする。Security adapter、全履歴分類、full cache frameworkはblockerにしない。

### G5: Compile Semantic Ownership Convergence

Goal: Rust/TypeScript driftの構造的原因を除去する。

Recommended decision:

- Rust daemonをcompile、retrieval、composer、trace semanticsのsingle ownerとする。
- TypeScript CLI/UI/APIはRust daemonへのtyped clientまたはthin adapterにする。
- TS MCP server sourceはcompatibility requirementがなければ削除する。
- cross-languageの手書きschemaを増やさず、canonical JSON schemaとgolden fixtureからcontract testを作る。

Decision gate:

- CLI/UI/APIをmaintained product surfaceに含めるか。
- Rust compileがSource evidenceを将来扱うか、Knowledge sourceRefsだけを正本にするか。
- PostgreSQLをsupported advanced backendにするか、legacy-disabledにするか。

Tasks:

- ADRでmaintained caller/backend、Source lane、transport、error contract、rollbackを確定する。
- candidate IDs、selected IDs、outbound IDs、pack IDs、trace identityを比較するgolden parity harnessを作る。
- Rust compileへ内部control/API boundaryを用意する。
- CLI、init-project、UI/APIを一surfaceずつRust ownerへrouteする。
- language固有feature flagを禁止し、unsupported fieldはschema公開しない。
- caller migration後、TypeScript compile serviceと重複retrievalをdeprecatedにする。
- production reference 0、rollback window終了、parity evidence保存後にだけ削除する。

Exit gate:

- maintained全surfaceのsemantic ownerがRust一つ。
- TypeScriptに独自candidate selection/composer implementationが残らない。
- schema、fixture、versionが一つのcontract releaseで更新される。
- TypeScript-only securityIntelligenceShadow driftが解消または機能ごとdisabled。

### G6: Responsibility-Based Module Decomposition

Goal: behaviorを変えずにreview surface、test isolation、ownershipを改善する。

Rules:

- line countだけを目的に分割しない。
- isolation semanticsまたはowner migrationと同じPRで大規模移動をしない。
- 各抽出PRはbefore/after golden resultとfocused testを持つ。
- module間に循環dependencyを作らない。
- context-compiler.service.tsはowner移行前に全面refactorせず、必要なadapter seamだけを抽出する。

Recommended split:

| Current file | Target boundaries |
| --- | --- |
| native_compile.rs | input、retrieval、composer/settings、composer/transport、composer/parser、persistence/trace、tests |
| settings.page.tsx | pure settings model、provider route editor、secret/health components、tab components、page shell |
| episode_executor.rs | input loading、state transition、provider execution、artifact persistence、retry/failure mapping |
| queue/core/worker.ts | queue-specific handlers、shared execution policy、failure/audit adapter |
| context-compiler.service.ts | thin Rust clientへ縮小後、legacy implementationを削除 |

Initial review targets:

- orchestration fileは主要flowを一画面で追える規模にする。
- pure transformはDOM/network/databaseから分離し、unit test可能にする。
- provider transport/parserはretrieval/persistenceをimportしない。
- settings tabは他tabのdraft stateを直接更新せず、typed actionを使う。
- source file size budgetをCI warningにし、hard gateは新規/大幅増加だけへ段階導入する。

Exit gate:

- behavior/golden parity pass。
- public APIとpersisted schemaに意図しないdiffがない。
- production moduleの新規循環dependency 0。
- touched critical fileに責務ownerとfocused testsがある。

### G7: SQLite-First Product Entry

Goal: README、contributor setup、interactive setup、CIが同じdefault product pathを示す。

Recommended direction:

- bun run setupをcanonical onboarding serviceにする。
- interactive startupはsetup serviceを呼ぶthin UIへ変更するかdeprecatedにする。
- default backendはSQLite、Docker/PostgreSQLは明示advanced optionにする。
- packaged Tauri appがない間は「local web/admin + Rust resident daemon」を開発baselineとして正直に記述する。

Tasks:

- onboarding database typeをsqlite/postgres unionへ変更し、sqliteをdefaultにする。
- SQLite path未指定時は実行surfaceごとのdocumented defaultとpath originを表示する。
- SQLite setupではDocker、Postgres connection、db:migrateを実行しない。
- CONTRIBUTINGのquick startをSQLite-firstへ更新する。
- READMEのstartup caveatを解消し、canonical commandを一つにする。
- verify:desktop-readinessをCIの明示jobにする。
- clean clone、temp workspace、temp DB、envなしのfirst-run smokeを追加する。
- Postgresを維持するならisolation parity testを必須にする。維持しないならnormal profile/APIから明示disableする。

Exit gate:

- clean environmentでDocker/Postgresなしにsetup、doctor、daemon/MCP smokeがpass。
- README、CONTRIBUTING、--help、interactive promptsが同じdefaultを示す。
- path outputがTS dev、Rust desktop default、LaunchAgent explicit pathのどれを使っているか示す。
- test/queue/E2E DBをeffective product DBとして報告しない。

### G8: Release Operations

Goal: 何を配布し、どう検証し、どう戻すかが再現可能なreleaseを作る。

Artifact decision:

- Tauriがない現状で「desktop app release」と呼ばない。
- 最初にsource/developer release、daemon binary bundle、将来のpackaged desktopのどれをsupportするかADRで確定する。
- binaryを配布する場合だけplatform matrix、codesign/notarization、checksumをrelease gateへ加える。

Tasks:

- package.jsonとCargo versionを一つのrelease checkで同期する。
- CHANGELOGをGit history委任からUnreleased→versioned entryへ変更する。
- tag-triggered release workflowを追加する。
- artifact、checksum、build metadata、verification resultをreleaseへ紐付ける。
- fresh install、upgrade、DB backup/migration、rollback runbookを作る。
- release candidateでverify:full、desktop readiness、isolation closeout evidenceを確認する。
- release後smokeとrollback decision ownerを決める。

Exit gate:

- annotated tag、versioned changelog、reproducible verification recordがある。
- advertised artifactがclean machineでinstall/start/doctor/MCP smokeを通る。
- upgrade前backupとrollback drillがpass。
- known limitationsにPostgres/Tauri/legacy TS surfaceの実態が一致する。

## 7. Delivery Units

各unitは独立review、独立rollbackを原則とする。

| Unit | Scope | Depends on |
| --- | --- | --- |
| W0 | worktree topic manifestとcurrent evidence freeze | none |
| O0 | effective DB/build identityとmigration rehearsal | W0 |
| I0 | caller identity adoption | O0 |
| I1 | durable producer audit semantics | W0 |
| I2 | active producer closure | I1 |
| I3 | deterministic backfill runner/audit | O0 |
| I4 | Rust retrieval predicateとpublic search | I0、I2、I3 |
| I5 | replay compatibilityとside-effect-free shadow | I4 |
| I6 | canary、default enforcement、closeout | I5 |
| A0 | compile ownership ADRとgolden contract | I6 |
| A1 | Rust control boundaryとTS client migration | A0 |
| A2 | legacy TS compile removal | A1 |
| M0 | native_compile responsibility split | A1 |
| M1 | settings page model/components/tabs split | I6 |
| M2 | episode/queue executor split | I6 |
| U0 | canonical SQLite setup/startup convergence | I6 |
| U1 | contributor docsとdesktop-readiness CI | U0 |
| R0 | artifact/release ADR | U1、A1 |
| R1 | changelog/tag/artifact/rollback automation | R0 |

I0、I1、I3は別file ownershipを確保できれば並行開発できる。I4 enforcementはすべてを待つ。onboarding文書の調査は先行できるが、supported releaseの宣言はI6後にする。

## 8. Verification Matrix

| Layer | Required evidence |
| --- | --- |
| identity contract | TS/Rust shared fixture、malformed/conflict/precedence tests |
| producer | failure injection、commit/PERSISTED correlation、enabled producer coverage |
| migration | repeated checksum、audit count、rerun zero、restore drill |
| retrieval | Repo A/B/global、missing identity、limit saturation、vector safe-degrade |
| persistence | request/run/task/pack/usage identity snapshot一致 |
| shadow | candidate ID diffのみ、shadow outbound/pack/usage zero |
| replay | identity-preserving current run、legacy not-comparable |
| operations | effective DB/build identity、tools/list、schema revision、24h canary |
| architecture | maintained caller golden parity、TS production references zero |
| onboarding | clean clone/temp DB/no Docker first-run |
| release | fresh install、upgrade、backup、rollback、artifact checksum |

Repository isolation closeoutでは少なくとも次を実行し、exit code、実行test数、skip数、duration、artifact pathをevidenceへ残す。

```bash
bun run typecheck
bun run lint
bun run test:unit
bun run test:repository-isolation:sqlite
bun run verify:sqlite
bun run verify:rust-daemon
cargo clippy --workspace --all-targets -- -D warnings
bun run rust:mcp:smoke
bun run docs:check-links
```

PostgreSQLをsupported surfaceとして残す場合は専用test DBで同じisolation contract testを追加する。testのskipをpassに数えず、live DBへfixtureを書かない。

## 9. Rollback Strategy

| Failure | Safe rollback |
| --- | --- |
| migration rehearsal mismatch | live restartを中止し、copyとmigration codeを修正 |
| live schema/startup failure | verified backupからrestoreし、旧binaryへ戻す |
| wrong-project candidate 1件 | enforcement拡大停止、global-only safe mode |
| availability regression | caller/producer/classificationを修正。unscoped fallbackは戻さない |
| vector correctness不明 | scoped exact/text laneへdegrade |
| TS client migration regression | 直前のclient adapterへ戻す。safe retrieval contractは維持 |
| refactor parity mismatch | file move PRだけrevertし、behavior changeを持ち込まない |
| release smoke failure | artifact公開停止、既知のgood tag/buildへ戻す |

## 10. Risks Requiring Explicit Review

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| stale resident daemon | sourceとlive schema/tool contractが異なる | build identityとtools/listをdeployment gateにする |
| partial schema shape | table存在がrevision完了を意味しない | schema_migrations + column/index capabilityを検証 |
| accepted-before-write audit | false completion signal | PERSISTED semanticsとfailure injection |
| one-producer observation bias | 低頻度writerが未検証のままになる | enabled producer coverage 100% |
| pre-limit filtering | matching itemが候補集合へ入らない | eligibilityをSQL/eligible-IDで先行 |
| dual compile owner | feature flag、trace、rankingがdriftする | Rust single ownerとgolden contract |
| current large mixed diff | review不能、rollback単位が大きい | W0 topic manifestと小さいdelivery unit |
| path-default conflation | 正しい複数profileを誤って統合する | effective path originの表示だけを統一 |
| Postgres legacy escape path | normal safety boundaryを迂回し得る | parityを満たすかnormal profileでdisable |
| refactor before convergence | 削除予定TS codeへ投資しregressionを増やす | TSはadapter化優先、Rustを分割 |
| desktop naming without artifact | 利用者期待と実態がずれる | artifact ADRまでlocal productと表現 |

## 11. Definition Of Done

### Repository Isolation Done

- G0-G4完了。
- active local profileでwrong-project candidate/outbound/pack/usage hard zero。
- missing identityはglobal-only。
- new unresolved producer 0、enabled producer coverage 100%。
- resident build/schema/tool contractをevidenceで確認。
- rollback drill pass。

### Architecture Done

- maintained compile semantics ownerはRust一つ。
- TypeScript CLI/UI/APIはthin client。
- language-only schema/feature flagがない。
- legacy TS compile production reference 0。

### Maintainability Done

- touched safety-critical modulesが責務単位に分離される。
- behavior/golden parityとfocused testsがある。
- file splitによるschema/API driftがない。

### Product Entry Done

- SQLite-firstの一つのcanonical setupがある。
- README、CONTRIBUTING、CLI prompts、CIが一致する。
- default pathの違いをorigin付きで説明し、自動統合しない。

### Release Operations Done

- supported artifactを明示。
- version/tag/changelog/artifact/verificationが追跡可能。
- fresh install、upgrade、backup、rollbackを再現できる。

## 12. Immediate Next Actions

1. runtime producer inventoryを確定し、`--enabled-producers` manifestを保存して7日・200 PERSISTED観測を開始する。
2. 2026-08-16 22:15 JST以降に24-hour enforced observationのfinal read-only auditを行う。
3. producer coverage、new unresolved、Safety/Availability/Performance Gateと`bun run verify`を再確認し、closeout evidenceを確定する。
4. archive gateをすべて満たしたらcloseout plan、T0 evidence、closeout evidenceをarchiveし、READMEを更新する。
5. G4 closeout後にcompile ownership ADRを確定し、Rust single-owner migrationを開始する。
6. owner convergence後にnative_compile/settings/episode executorを責務単位に分割し、SQLite-first onboardingとrelease automationを完成させる。

この順序を変える場合は、変える作業がSafety Gate hard zeroを弱めないこと、rollback単位を大きくしないこと、削除予定の二重実装へ新しいsemanticsを追加しないことをdecision recordで示す。
