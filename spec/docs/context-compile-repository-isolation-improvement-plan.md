# Context Compile Repository Isolation Closeout Plan

## Status And Decision

Status: reassessment complete; implementation plan revised on 2026-08-15.

- T0（再現、inventory、baseline）とT1（additive identity foundation）は完了している。
- 残作業は旧T2-T7をそのまま実行せず、P0-P5へ再編する。
- repository isolationは実施する価値が高い。live Rust retrievalがrepository identityを使わず、別repositoryのKnowledge/EpisodeCardを選べる状態が実測されているためである。
- 一方、旧計画はinactive path、完全な履歴修復、cache/evaluation再設計、Security adapterまで同じrelease gateへ含めており、目的に対して過大だった。
- 最適な順序は、caller identity adoption、producer closure、利用実績に重み付けしたmigration、active Rust enforcement、最小限のreplay互換、local rolloutである。
- 旧T7 Security Intelligence adapterは本計画から外す。[Security Intelligence Integration Concept](security-intelligence-integration-concept.md)で扱い、repository isolationの完了をblockしない。

本計画のP0-P5が完了し、release evidenceが揃った時点で、本書と[T0 Evidence](context-compile-repository-isolation-t0-evidence.md)を`spec/docs/.archived/`へ移す。

## Reassessment Evidence

### Runtime

2026-08-15のread-only調査では、resident daemonはRust-native `context-stilld`であり、12 MCP toolsを所有し、TypeScript sidecarは0件だった。active Rust `context_compile`はKnowledgeを最大500件、EpisodeCardを最大200件取得してから順位付けし、そのqueryにrequest identityを渡していない。

live processはworking treeより古く、公開中の`context_compile` schemaにもidentity fieldがない。working treeにあるT1実装だけでは、実利用callerのidentity adoptionはまだ始まっていない。

### Live Data

再実行前提のplanning snapshotは次のとおりである。

| Entity | Live inventory | Deterministic migrationの見込み |
| --- | ---: | --- |
| Knowledge | total 7,227、active 7,180。activeの`scope=repo`は7,171、`global`は9 | direct legacy identity 83件。surviving vibe provenance 1,029件、Source provenance 25件を含め、安全に分類できる上限候補はunionで約1,137件。残り約6,043件は未解決の見込み |
| EpisodeCard | active 6,602 | exact repo path 5,364件は候補。repo keyのみ397件、identityなし841件はauthoritative mappingまたはreviewがなければunresolved |
| Source | 178 | metadataにpath/keyがある79件も、旧importerの`process.cwd()`由来である可能性があるため自動確定しない。明示identity付きreimportまたはcapture recordを優先 |

canonical columnsがlive DBにまだないため、現在値はcanonical contract上すべてunresolvedとして扱う。数字はmigration実行直前に再計測し、増減を計画逸脱とはみなさない。

### Usage Concentration

- 全履歴のselected Knowledgeは47,923 selection、2,165 distinct itemだった。
- 上位10 itemが36,442 selection（76.0%）、上位50 itemが38,617 selection（80.6%）を占める。
- 上位itemの多くは一般化可能な知識だが、現在は`scope=repo`として保存されている。
- 直近500 compile packはKnowledge 4,000件、EpisodeCard 1,500件で、empty packはなかった。
- 直近選択Knowledgeのうちdirect identityを持つitemは12 distinct中1件だけだった。

したがって、全7,000件超を先に機械分類するより、利用上位50 Knowledgeをreviewしてglobal/repo/unresolvedへ分類する方が、安全性とavailabilityの両方に効く。

### Why Work Was Left Incomplete

履歴上、scoped searchとunscoped fallbackは同日に追加されている。これはrepository isolationが不要だった証拠ではなく、identity coverageが低い状態でavailabilityを維持するための暫定策だった可能性が高い。

現在の問題は価値不足ではなく、次の依存関係が逆転していたことである。

1. callerがidentityを送らない。
2. producerがauthoritative identityを保存しない。
3. 既存の有用Knowledgeが誤ってrepo scopeに偏っている。
4. その状態でstrict retrievalを有効化すると、有用性が急落する。

本計画はこの順序を正す。

## Goal

通常のlocal workspace利用において、requestから解決した一つのrepository identityがactive retrieval、pack、usage、traceへ一貫して使われ、別repositoryのitemがcandidateまたはoutboundへ入らない状態を作る。

完了時には次を満たす。

- identity-present requestは、matching repo itemと明示global itemだけを取得する。
- identityなしrequestはglobal itemだけを取得する。
- unresolved、conflict、malformed itemはnormal retrievalへ入らない。
- scoped resultが0件でもunscoped fallbackへ戻らない。
- active Rust pathで安全性を実測し、必要なavailabilityを維持する。

## Scope

### Required For Closeout

- Rust-native `context_compile`。
- Rust-native public `search_knowledge`と`search_episodes`。
- local workspace MCP、CLI、HTTP/APIのうち実際に利用するcaller。
- active producerと、今後もrepo-scoped dataを書き込めるwrite path。
- Knowledge/EpisodeCardのusage-weighted migration。
- minimum replay identity compatibility。
- local shadow/canary rolloutとrelease evidence。

### Conditional

- TypeScript retrieval pathは、公開または利用を継続する場合だけRustと同じcontractへ揃える。揃えないpathはenforced modeで明示的に無効化する。
- Source retrievalは現在active Rust compileで使用していない。再度有効化する前に同じscope gateを実装するが、本計画でRust compileへSource retrievalを新規追加しない。

### Not Required For Closeout

- 全履歴itemの完全分類。
- full cache parity、長期evaluation framework、完全なpost-run audit system。
- tenant authorizationやrole-based access control。
- Security Intelligence adapterとassessment revision binding。
- unresolved itemの自動削除または本文からの推測分類。
- `repoKey`をstable cross-machine identityへ再定義すること。

## Identity Operating Profile

### Normal Local Workspace

通常のlocal workspace callerはabsolute `repoPath`を必須で渡す。

- callerは自身が開いているworkspace rootをcaptureし、requestごとに同じ値を送る。
- daemon root、process cwd、content directory、basename、Git remoteからidentityを推測しない。
- `repoPath`はlexical normalizeするが、filesystem access、`realpath`、symlink解決、存在確認は行わない。
- POSIX absolute path、Windows drive absolute path、またはhostが空/`localhost`のabsolute `file://` URIだけを受け付ける。
- relative path、query/hash付きfile URI、remote-host file URI、malformed encodingは拒否する。
- path caseは保持し、root以外のtrailing separatorを除く。

### Legacy Compatibility

`repoKey`は明示的に保存済みのlegacy identityを移行または検索する場合だけ使う。

- `repoPath`、project name、basename、Git remoteから新しい`repoKey`を生成しない。
- lower-priority identityへのfallbackを行わない。
- key-only dataはauthoritative alias mappingがなければunresolvedのままにする。

### Security Integration

`projectRef`は将来のtrusted Security adapter用に予約する。通常local profileでは必要としない。

- `projectRef`はselection identityであり、それだけでauthorization tokenにはならない。
- Security adapterはauthenticated project declarationから注入し、model/user supplied identityによる上書きを拒否する。
- このadapterの実装とrolloutは本計画のrelease gateに含めない。

### Single-Basis Rule

requestごとに一つのmatch basisだけを選ぶ。

1. trustedまたは明示`projectRef`
2. 明示`repoKey`
3. normalized `repoPath`
4. identityなし（global only）

選択basisでrepo matchが0件でも、下位basis、legacy metadata、URI prefix、daemon root、unscoped queryへfallbackしない。

## Safety Invariants

enforced pathでは次を常に守る。

1. request identityは一度だけresolveし、retrievalとtraceで同じobjectを使う。
2. `scope=global`または選択basisで完全一致する`scope=repo` itemだけをeligibleにする。
3. `classification_status=classified`だけをnormal retrievalへ入れる。
4. missing identityはglobal onlyにする。
5. malformed、unresolved、conflict、identifier conflictはfail closedにする。
6. scope/classification/facet predicateをarbitrary candidate limitより前に適用する。
7. scope-aware prefilterができないvector laneは無効化するか、eligible IDを先に確定する。
8. shadow candidateの本文をcomposerまたはexternal providerへ送らない。
9. pack、usage、traceへselection時点のidentity basisとscope decisionをsnapshotする。
10. safety rollbackでunscoped fallbackを復活させない。

## Existing Foundation: T0 And T1

### T0: Complete

- Repo A requestがRepo B Knowledgeを選ぶcross-repository reproductionを作成済み。
- candidate、outbound、pack IDを追跡するharnessを作成済み。
- live read-only inventoryとbaselineを記録済み。
- 詳細は[T0 Evidence](context-compile-repository-isolation-t0-evidence.md)を正本とする。

### T1: Foundation Complete, Deployment Pending

working treeでは次のadditive foundationが実装済みである。

- Rust/TypeScript shared identity fixtureとresolver。
- MCP schemaの`projectRef`、`repoKey`、`repoPath`。
- SQLite additive revision 2とPostgreSQL migration 0071のcanonical identity/classification fields。
- compile run/task traceのnormalized request identity保存。
- old/new schema compatibility test。

ただし、resident daemonの再配備とcaller adoptionは未完了であり、P0で扱う。T1完了をrepository isolation完了とはみなさない。

## Remaining Work

### P0: Caller Identity Adoption

Goal: active requestがauthoritative local workspace identityを実際に送る状態にする。

Tasks:

- T1を含むRust daemonをbuildし、resident processを安全にrestartする。
- `tools/list`で`context_compile`、`search_knowledge`、`search_episodes`のidentity fieldを確認する。
- workspace MCP integrationが開いているworkspaceのabsolute `repoPath`を送るようにする。
- local CLI/APIが`repoPath`を受理し、compile inputまで落とさず渡すようにする。現在のCLIの`--repo-path`拒否を解消する。
- current working directoryをfallback identityとして使わない。identityをcaptureできないcallerは明示的にglobal-onlyになる。
- run/task traceにnormalized `repoPath`、basis、contract versionが保存されることを確認する。

Completion criteria:

- live `tools/list`にidentity fieldsがある。
- local workspaceから20回以上の連続compile callを行い、identity-present率が100%である。
- request、run、task traceのidentity mismatchが0件である。
- identity omitted smokeでdaemon root/process cwdが保存されず、global-only diagnosticになる。

Stop conditions:

- `repoPath`をbasenameやproject nameから再構成する。
- caller adoption前にenforced modeを既定化する。
- stale daemonのままworking treeのschemaだけを根拠に完了扱いする。

### P1: Producer Identity Closure

Goal: 新しいrepo-scoped unresolved itemを増やさない。

Tasks:

- active Rust producersを先に列挙し、各writeにcaptured project rootを伝播する。
- agent log syncはcapture時の`projectRoot`を`repoPath`として保存する。`projectName`を`repoKey`として渡さない。
- markdown importerは`contentRoot`と`projectRoot`/project identityをAPI上で分離する。docs subdirectoryをrepository rootとみなさない。
- compile run由来EpisodeCardはrequest/run snapshot identityだけを使用する。
- Knowledge register/finalize、vibe memory、Source fragment/import、portability/import pathのうち、現在も到達可能なwriterを検査する。
- repo-scoped writeはexact identityを要求する。identityなしの一般知識はcallerが明示した場合だけglobalとして保存する。
- inactive TypeScript writerは、将来再有効化時にcontract testを必須にするか、到達不能であることを明示する。

Completion criteria:

- active producerごとのcontract testがある。
- repo writeはcanonical identity付き、global writeはidentity columnsがNULLになる。
- identityなしrepo writeは拒否され、自動global化されない。
- P3 shadow/P5 rollout観測中のnew unresolved producer countが0件である。

Known draft corrections before merge:

- Rust/TypeScript agent log syncの`projectName -> repoKey`伝播を除去する。
- markdown importerのimport directoryとproject rootの同一視を除去する。
- producer listをactive runtimeから再取得し、存在するだけのinactive codeを完了blockerにしない。

### P2: Usage-Weighted Migration

Goal: enforcement前に、利用価値の高い既存itemとdeterministic provenanceを持つitemだけを安全に分類する。

Step 1: re-inventory and dry-run

- live DBのread-only copyでentity count、selection frequency、provenance coverageを再計測する。
- migrationはdry-run/writeを分け、entity ID、before/after fingerprint、reason code、provenance、migration versionを記録する。
- dry-runを2回実行し、count/checksumが一致することを確認する。

Step 2: top-50 Knowledge review

- historical selection上位50 Knowledgeを、本文を外部へ送らずlocal reviewする。
- repositoryに依存しない原則・手順は`global`へpromotionする。
- 特定repositoryのarchitecture、path、component、decisionに依存するitemはexact identity付き`repo`へ分類する。
- 判断が曖昧なitemは`unresolved`のままにする。
- review decision、reviewer、reason、timestampをmigration auditへ残す。

Step 3: deterministic backfill

許可する根拠:

- 既存のexact canonical/legacy `repoPath`、明示`projectRef`。
- exact project rootを保持したcapture/import record。
- request identityを保持したcompile run/task trace。
- authoritative alias declaration。
- review済みglobal promotionまたはrepo assignment。
- `cover-evidence-result://`からauthoritative captureまで切れずに辿れるprovenance chain。

禁止する根拠:

- title/body中のproject名。
- relative path、URI prefix、directory basename。
- 類似repository名、Git remoteの推測。
- daemon root、`process.cwd()`、旧importerの曖昧なroot。

Entity policy:

- Knowledgeは約1,137件というcandidate上限を再検証し、provenanceが完全なrowだけを書く。
- EpisodeCardはexact repo pathを持つ約5,364件を優先する。key-only 397件とidentityなし841件は、authoritative mapping/reviewがなければunresolvedにする。
- Sourceは旧metadataだけで確定せず、identity付きreimportまたはauthoritative capture recordを優先する。
- unresolvedを一括global化、削除、本文類似度で分類しない。

Completion criteria:

- top-50 Knowledge reviewが完了する。
- dry-runとwriteの対象count/checksumが一致する。
- write後の再実行で更新0件になる。
- backup/restore drillまたはtemp-copy rollbackが成功する。
- 直近500 runを用いたoffline simulationでwrong-project eligible countが0件になり、availability影響が記録される。
- 未分類残数を明記し、残数0を完了条件にしない。

### P3: Active Retrieval Enforcement And Minimal Shadow

Goal: active Rust retrievalを正しいscope boundaryへ移し、user-visible切替前に比較する。

Implementation order:

1. Rust `context_compile` Knowledge retrieval。
2. Rust `context_compile` EpisodeCard retrieval。
3. Rust public `search_knowledge`。
4. Rust public `search_episodes`。
5. 公開継続するTypeScript compile/search path。parityを実装しないpathはenforced modeで無効化する。

Tasks:

- resolved identityをretrievalへ渡し、canonical columnsでscope/classificationをquery時にhard gateする。
- facet/applicability eligibilityをRust/TypeScript/backend間で揃え、limit前に適用する。
- current 500/200 pre-limitをscope-aware queryへ置換する。
- primary 0件時のlegacy/unscoped fallbackを除去する。
- scope-awareでないvector laneを無効化またはeligible-ID先行方式へ変更する。
- shadowではlegacy/new candidate ID、count、exclusion reasonだけを保存する。
- shadow itemのtitle/body/contentをcomposer、pack、usage、external providerへ送らない。
- pack/usage/traceへbasis、identity fingerprint、classification/scope decisionをsnapshotする。
- dormant Security-only shadowやinactive TS sidecarを、本phaseのshadow実績として数えない。

Completion criteria:

- shared identity/scope fixtureがRustと公開継続pathで一致する。
- Repo A/B/global/unresolved/malformed fixtureでwrong-project shadow candidateが0件である。
- matching repo/global itemがlimit saturation下でも取得できる。
- identity missing shadow resultにrepo itemが0件である。
- composer on/offのどちらでもnew shadow contentのoutboundが0件である。
- active local profileでidentity-present shadow callを50回以上収集する。

Stop conditions:

- scope predicateを500/200件取得後にだけ適用する。
- unscoped vector top-K後filterだけでcorrectnessを主張する。
- mismatch原因が不明なままenforced canaryへ進む。

### P4: Minimal Replay Compatibility

Goal: scoped runを再現するときにidentityを失わず、legacy runを誤比較しない。

Tasks:

- `compileInputFromRun`へrun snapshotのnormalized identityとbasisを戻す。
- identity snapshotがないlegacy runは`legacy_identity_unknown`かつ`not_comparable`として扱う。
- legacy daemon `repo_path`をrequest identityへ昇格しない。
- snapshot/cacheは本rollout中もdisabledを維持する。
- old semanticsのcache payloadをpurgeまたはstale化し、新contractの結果として返さない。
- replay smokeでRepo A/B/global-onlyを検証する。

Completion criteria:

- identity付きrunのreplayが同じscope basisを使う。
- legacy runをcurrent global-only resultと同等と誤判定しない。
- cache disabled状態でold payloadが参照されない。

Deferred from this phase:

- cache enabled時の完全parity。
- versioned landscape evaluationの全面再設計。
- 全履歴runのscope audit UI。
- 長期ranking regression framework。

これらはcache/evaluationを再有効化する時点で別計画にする。

### P5: Local Rollout And Closeout

Goal: local normal profileの既定をenforcedへ切り替え、archive可能な証拠を残す。

Entry gates:

- P0-P4が完了している。
- identity-present shadow callが50回以上あり、Safety Gate違反が0件である。
- new unresolved producer countが0件である。
- top-50 reviewとdeterministic migrationが完了している。
- resident daemonが対象buildであることを確認できる。

Rollout:

1. dedicated local sessionでenforced canaryを20 compile call以上実行する。
2. canaryを24時間以上維持し、通常workspace操作とnegative smokeを含める。
3. Safety、Availability、Performance Gateを再評価する。
4. local normal profileをenforced既定にする。
5. live read-only auditとrollback drillを実行し、evidenceを本書またはcloseout evidenceへ記録する。

Required negative smoke:

- Repo A requestとRepo B high-importance items。
- identity missing。
- `/repo-a`と`/repo-a-archive`。
- path case collision。
- malformed repoPathとmalformed legacy metadata。
- selected basis field missingだがlower basisだけ一致するitem。
- scoped 0件だがunrelated repo itemが存在するcase。

Completion criteria:

- wrong-project candidate/outbound/pack/usageが0件である。
- unresolved/malformed selected itemが0件である。
- request/trace identity mismatchが0件である。
- identity missing requestがglobal-only + diagnosticになる。
- availability/performanceが下記gate内である。
- rollback drillがunscoped fallbackを復活させず成功する。

## Delivery Units And Dependencies

| Unit | Content | Merge/activation condition |
| --- | --- | --- |
| C0 | P0 daemon deployment、caller/CLI identity adoption | live schema確認、20 calls identity 100% |
| C1 | P1 active producer closure | producer contract tests pass、known draft corrections完了 |
| C2 | P2 top-50 review、dry-run/write migration | checksum一致、backup/restore成功 |
| C3 | P3 Rust gates、public search、side-effect-free shadow | C0-C2 ready、shadowのみ有効 |
| C4 | P4 minimal replay/cache stale handling | scoped replay smoke pass |
| C5 | P5 local canary、24h audit、default enforcement | 50 shadow + Safety/Availability/Performance Gate pass |

C0-C2は並行開発できるが、C3 shadow計測はidentity adoptionと分類結果を含むbuildで行う。C5 enforcementはすべての前段を必要とする。

## Test Matrix

### Identity And Scope

| Request | Candidate | Expected |
| --- | --- | --- |
| identityなし | global classified | allow |
| identityなし | repo classified | deny |
| Repo A | global classified | allow |
| Repo A | Repo A exact basis | allow |
| Repo A | Repo B exact basis | deny |
| Repo A | unresolved/conflict/malformed | deny |
| Repo A | selected basisなし、lower basis一致 | deny |
| Repo A, repo match 0 | lower basisまたはunrelated repo | deny; global only |
| `/repo-a` | `/repo-a-archive` | deny |
| `/Work/A` | `/work/a` | deny for repoPath basis |

### Ordering And Saturation

- wrong-project high-importance itemを500件以上入れてもmatching Knowledgeを取得できる。
- wrong-project EpisodeCardを200件以上入れてもmatching EpisodeCardを取得できる。
- facet mismatch itemがlimitを埋めてもmatching facet itemを取得できる。
- text/vector laneでscope-eligible ID setが一致するか、安全にdegradeする。

### Persistence And Side Effects

- request、run、task、pack、usageのidentity fingerprint/basisが一致する。
- daemon root/process cwdがomitted requestへ保存されない。
- composer disabled/enabledでeligible ID setが同じである。
- shadow-only itemのoutbound、pack、usageが0件である。
- agent log project nameとmarkdown contentRootがrepo identityへ誤昇格しない。

### Migration And Replay

- dry-run再実行でcount/checksumが一致する。
- write後再実行で更新0件になる。
- unresolved/conflicting provenanceはskipされる。
- top-50 review decisionがaudit可能である。
- scoped replayはidentityを保持し、legacy unknownはnot comparableになる。

## Release Gates

### Safety Gate: Hard Zero

- wrong-project selected candidate: 0
- wrong-project composer outbound: 0
- wrong-project pack item: 0
- wrong-project usage/feedback event: 0
- unresolved/malformed/conflict selected item: 0
- request/trace identity mismatch: 0
- shadow-only content outbound: 0

一件でも発生した場合はenforcement拡大を停止する。平均や割合で許容しない。

### Availability Gate

identity-present requestを同じlocal cohortと比較する。

- No Content rate増加: 5 percentage points以内。
- median selected Knowledge count低下: 20%以内。
- EpisodeCard enabled pathのmedian selected count低下: 20%以内。
- matching classified itemが存在するfixture/sampleでfalse exclusion: 0。
- top-50 review後も高頻度の一般知識がexpected globalとして取得できる。

identity missingによるglobal-onlyは、caller adoption defectとして別metricにする。閾値超過時はunscoped fallbackを戻さず、caller、producer、classificationを修正する。

### Performance Gate

- compile p95 latencyはbaseline比+20%以内、かつlocal通常利用の追加100ms以内を目標とする。
- scope/classification predicateがindexを利用し、不要な全件scanを増やさない。
- migration/inventoryをrequest pathで同期実行しない。
- performance理由でscope correctnessを緩めない。

## Verification Commands

実装変更に応じて対象を絞って実行し、最終closeoutでは次をrelease evidenceに残す。

```bash
cargo test -p context-stilld native_compile -- --nocapture
cargo test -p context-stilld native_knowledge -- --nocapture
cargo test -p context-stilld native_episodes -- --nocapture
cargo test -p context-stilld agent_log_sync -- --nocapture

bunx vitest run \
  test/mcp.contract.test.ts \
  test/schemas.test.ts \
  test/knowledge.service.test.ts \
  test/knowledge-repository.test.ts \
  test/source-retrieval.service.test.ts \
  test/episode-card.repository.sqlite.test.ts \
  test/context-compiler.service.test.ts \
  test/landscape-replay-comparison.service.test.ts

bun run typecheck
bun run lint
cargo clippy --workspace --all-targets -- -D warnings
bun run rust:mcp:smoke
bun run mcp:smoke:sqlite
bun run docs:check-links
```

- DB integrationは専用test DBまたはlive DBのread-only copyで行う。
- live DBへfixtureを書き込まない。
- testのskipを成功扱いしない。
- command、exit code、executed/skipped count、duration、artifact pathを記録する。

## Rollback

Before enforcement:

- additive schemaとshadow flagを維持し、user-visible selectionを変えずに修正できる。
- migrationはbackup/read-only copyで検証し、元contentを削除しない。

After enforcement:

- Safety Gate違反時は`global_only_safe_mode`へ切り替える。
- latency/availability問題時は直前のenforced predicateまたはvector-disabled exact/text pathへ戻す。
- unscoped fallback、legacy metadata fallback、URI prefix fallback、daemon root fallbackを復活させない。
- rollback reason、affected run range、follow-up auditを記録する。

## Transferred And Deferred Work

### Transferred: Former T7

Security Intelligence adapterは[Security Intelligence Integration Concept](security-intelligence-integration-concept.md)へ移管する。次のいずれかが成立した時点で別の実装計画を作る。

- Security integration flagが有効化される。
- security receipt/item/feedback dataが実際に生成される。
- authenticated project adapterを稼働させる。

その計画ではtrusted `projectRef`、alias binding、authorization、spoof preventionをrelease gateにする。現在これらのlive data/adapterは稼働していないため、本計画のcloseout条件にはしない。

### Deferred

- full cache parityとcache enablement。
- long-term evaluation/audit UI。
- inactive TypeScript retrievalの機能拡張。
- Rust compileへのSource retrieval追加。
- unresolved historical dataの低頻度long-tail review。

deferred項目は本書内の未完了taskとして残さず、必要になった時点で新規計画を作る。

## Archive Gate

次をすべて満たしたらrepository isolationを完了とし、本書とT0 evidenceを`spec/docs/.archived/`へ移す。

- P0-P5のcompletion criteriaを満たす。
- 50回以上のidentity-present shadowと、20回以上かつ24時間のenforced canaryを完了する。
- Safety Gate hard zero、Availability/Performance Gate pass。
- resident daemonとnormal local profileがenforced contractを使用する。
- live read-only auditとsafe rollback drillがpassする。
- 未分類残数とdeferred workがcloseout evidenceに記録されている。
- READMEからactive plan linkを除去またはarchive linkへ変更する。

Security adapter、full cache/evaluation、全履歴分類はarchiveをblockしない。
