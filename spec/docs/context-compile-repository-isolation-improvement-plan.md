# Context Compile Repository Isolation Improvement Plan

## Status And Decision

Status: implementation in progress. T1 additive foundation landed locally; T0 inventory/baseline and enforcement remain incomplete.

Decision:

- repository isolationは必要であり、`context_compile`のactive Rust pathだけでなく、同じ公開identityを扱うTypeScript retrieval、public search tools、producer、migration、trace、replayまで一つのcontractとして修正する。
- enforcementはschema公開直後に有効化しない。identity adoption、producer修正、分類可能データのmigration、shadow比較を完了してから切り替える。
- safety rollbackで旧unscoped searchへ戻さない。可用性問題が起きた場合も、global-onlyまたは直前のfail-closed predicateを維持する。
- `projectRef`は誤混入防止のselection identityであり、それだけではauthorization boundaryではない。Security Intelligence Integrationではtrusted adapterが供給し、model/user入力で上書きできないことを別途必須にする。

Implementation progress as of 2026-08-15:

- TypeScript/Rust shared fixtureとcompile専用identity resolverを追加した。
- Rust/TypeScript MCP schemaへ`projectRef`、`repoKey`、`repoPath`をadditive公開した。
- SQLite additive revision 2（`user_version=1`互換維持）とPostgreSQL migration 0071へcanonical identity、classification status、alias、run/task trace、pack snapshot columnsを追加した。
- Rust/TypeScript compile runとtask traceはdaemon root/process cwdではなくnormalized request identityを保存する。
- SQLite v1互換binary→additive revision 2 migration、旧writer相当のidentity省略writeが`classification_status=unresolved`になること、両言語fixture parityをtest済みである。
- SQLiteは`user_version=1`をbinary互換境界として維持し、identity schemaを`schema_migrations` revision 2として追跡する。これによりold binary/new schemaは追加列を無視でき、new binary/old schemaは起動時にrevision 2を冪等適用できる。
- T0のshared identity fixtureは追加済みだが、cross-repository retrieval fixture、read-only inventory、baseline cohort計測は未完了である。
- T2 producer修正、T3 deterministic backfill、T4 scope enforcement/shadow、T5 replay/cache、T6 rollout、T7 Security adapterは未着手である。したがって現時点ではrepository isolation完了とは扱わない。

## Purpose

`context_compile`が複数repositoryのKnowledge、Source、EpisodeCardを混在させないように、MCP入力、project identity解決、永続化、retrieval、composer、usage/trace、producer、migration、replay、test、rolloutを一つの境界として修正する。

完了条件は、同じrequestから解決した一つのidentity basisが、すべてのcandidate kindと永続化traceに一貫して使用され、wrong-project itemがcandidate、composer outbound payload、pack、usage eventのいずれにも現れないことである。

## Threat Model And Scope

### Prevents

- repository Aのtaskにrepository BのKnowledge、Source、EpisodeCardが混入すること。
- identityなしrequestがrepo-scoped dataを取得すること。
- scoped 0件時のunscoped/legacy fallbackによる境界拡大。
- malformed、未分類、identity未解決データが通常retrievalへ復帰すること。
- daemon root、process cwd、basename、本文、relative path、Git remoteをcaller identityとして誤用すること。
- ranking、ANN overfetch、candidate limitの位置によってscope predicateが迂回されること。

### Does Not Prevent

- 任意の`projectRef`を指定できるtrustedでないcallerによる別projectの明示検索。
- 同一project内での機密度・role・tenant authorization違反。
- Source本文やKnowledge本文そのものに含まれる秘密情報の漏えい。

Security authorizationが必要なadapterでは、認証済みprincipalとproject declarationから`projectRef`を注入し、caller supplied identityを拒否または上書きする。通常MCPの`projectRef`はselection scopeであり、authorization tokenとして扱わない。

### In Scope

- Rust-native `context_compile`。
- Rust-native `search_knowledge`、`search_episodes`のrepository/facet filtering。
- TypeScript compiler、Knowledge text/vector retrieval、Source text/vector retrieval、EpisodeCard retrieval。
- Knowledge、Source、EpisodeCardのidentity producerと既存データmigration。
- compile run、task trace、candidate trace、pack item、usage/retrieval feedbackのidentity snapshot。
- landscape replay comparison、context evaluation、scope-aware cache invalidation/versioning。
- MCP schema、initial instructions、tool documentation、HTTP MCP smoke。

### Active-Path Clarification

2026-08-15時点のMCP tool ownerはRust-nativeで、TypeScript sidecarは0件である。active Rust `context_compile`はKnowledgeとEpisodeCardをcomposer inputに使い、Sourceを取得していない。

したがって:

- 最初のenforcement対象はactive Rust Knowledge/EpisodeCardとpublic search toolsとする。
- SourceはTypeScript pathの再利用前に同じcontractへ移行する。
- この変更でRust compilerへSource retrievalを新規追加しない。追加する場合は別変更として、同じscope gateを通す。
- Rustの実装実態に合わせ、Sourceを取得しない間はMCP tool descriptionの`knowledge + source evidence`表現を修正する。

## Confirmed Current State

2026-08-15時点でコードとlive SQLiteをread-only確認した結果:

- Rust-native `context_compile` schemaは`goal`、`changeTypes`、`technologies`、`domains`だけで、`repoPath`、`repoKey`、`projectRef`を公開していない。
- TypeScript `compileInputSchema`は`repoPath`と`repoKey`を受け取れるが、TypeScript MCP schemaは両方を公開していない。
- Rust-native `search_knowledge_items`はscope、intent tags、`applies_to`をretrieval判定に使わず、active Knowledgeをimportance順で最大500件取得した後にtext/dynamic scoreで順位付けする。
- Rust-native `search_episode_cards`は`repo_path`、`repo_key`を使わず、active EpisodeCardを最大200件取得する。
- Rust-native public `search_knowledge`はschema上`repoPath`とfacetsを受けるが、実装では使用しない。
- Rust-native public `search_episodes`はschema上repo/facet filtersを受けるが、実装ではstatusとquery以外を使用しない。
- Rust compile runはcaller repositoryではなく`NativeToolContext.project_root`を`context_compile_runs.repo_path`とtask traceへ保存する。
- TypeScript compilerもrequest identityではなく`process.cwd()`をrun/task traceとEpisodeCard fallback scopeに使う。
- TypeScript Knowledge serviceはprimary scoped searchが0件の場合にlegacy metadata search、さらにunscoped searchへfallbackする。
- TypeScript PostgreSQL Knowledge text/vector retrievalはapplicabilityをscoreへ加えるが、facet不一致候補を最終除外しない。
- TypeScript SQLite vector retrievalはscope filter後にapplicability hard gateを適用しない。
- TypeScript Source retrievalは`CompileInput.repoPath` / `repoKey`をrepositoryへ渡していない。
- TypeScript EpisodeCardのglobal fallbackは明示global検索ではなくunscoped検索である。
- replay comparisonはrunからrepo facetsを抽出するが、current retrieval用`CompileInput`へrepo identityを戻さない。
- live active Knowledgeは`global=9`、`repo=7,171`。repo 7,171件の内訳は`repoKey+repoPath=77`、`repoPath only=2`、identity未解決`7,092`である。
- identity未解決7,092件のうち7,043件は`cover-evidence-result://`由来である。
- live active EpisodeCardは6,602件。`repoKey+repoPath=5,364`、`repoKey only=397`、未分類NULL=841であり、未分類841件はすべて`vibe_memory`由来である。
- live Sourceは178件。identityあり79件、未分類99件で、明示scope metadataは0件である。
- active EpisodeCardにも明示scope metadataは0件である。
- 直近100 compile run inputに`repoPath`、`repoKey`、`projectRef`は1件もない。
- 直近100 runのpackには、identity未解決Knowledge 700件、daemon rootと一致しないresolved Knowledge 100件が保存されている。EpisodeCardはdaemon root以外214件、未分類80件、daemon root一致6件である。
- SQLite `knowledge_items`にJSON identity expression indexはなく、現状の候補queryはstatus indexとtemporary sortを使う。
- SQLiteでは`json_valid(value) AND json_extract(value, ...)`でもmalformed JSONによりquery全体が失敗するため、predicate順序だけでは安全にならない。

## Safety Invariants

次のinvariantはphaseやfeature flagに関係なく、enforcement開始後は常に成立させる。

1. requestごとにresolved identityを一度だけ生成する。
2. match basisは一つだけ選び、複数identifierをOR検索しない。
3. `scope=global`、または選択されたbasisで完全一致する`scope=repo` itemだけを候補にする。
4. identityなしrequestはglobal itemだけを候補にする。
5. missing、unresolved、malformed、conflicting identityはfail closedにする。
6. primary scoped resultが0件でもlower-priority identifier、metadata、URI prefix、unscoped searchへfallbackしない。
7. scope/facet eligibilityを適用する前のarbitrary candidate limitにcorrectnessを依存させない。
8. ANN/vector laneがscopeをpre-filterできない場合、unscoped top-K後のfilterだけをretrieval根拠にしない。そのlaneを無効化するか、scope-aware exact searchを使う。
9. composer disabled/enabledの両方で同じeligible candidate setを使用する。
10. pack、usage event、feedback、traceにはselection時点のscope decisionをsnapshotとして残す。
11. absolute pathやcandidate本文をuser-facing diagnosticsへ反復表示しない。
12. safety rollbackでunscoped fallbackを復活させない。

## Identity Contract

### Request Shape

MCPとinternal `CompileInput`へ次をadditiveに追加する。

```ts
type CompileProjectIdentityInput = {
  projectRef?: string;
  repoKey?: string;
  repoPath?: string;
};

type ResolvedCompileProjectIdentity = {
  contractVersion: 1;
  scopeMode: "global_only" | "project";
  matchBasis: "project_ref" | "repo_key" | "repo_path" | "none";
  matchValue: string | null;
  projectRef: string | null;
  repoKey: string | null;
  repoPath: string | null;
  identityFingerprint: string | null;
  trust: "request_hint" | "trusted_adapter";
  bindingStatus: "verified" | "not_applicable" | "unverified";
};
```

`identityFingerprint`は`sha256(contractVersion + "\0" + matchBasis + "\0" + matchValue)`とし、candidate snapshotやaggregate diagnosticsでabsolute pathを複製せず照合するために使う。fingerprintをauthorization tokenとして使用しない。

### `projectRef`

- stable、opaque、case-sensitiveなproject identityとする。
- trim後1-256文字、control characterと改行を拒否する。中身からrepository名、remote、pathを推定しない。
- repository declarationまたはtrusted adapterから供給する。
- 通常MCPでは`request_hint`としてoptional、Security Integration adapterでは`trusted_adapter`としてrequiredにする。
- Knowledge `appliesTo.projectRef`とcanonical identity columnへ保存する。
- Source、EpisodeCard、run/task traceにも同じfieldを追加する。
- projectRefとlegacy identityの対応が必要な場合は、authoritative alias declarationだけを使用する。

### `repoKey`

- legacy compatibility用lookup keyであり、stable cross-machine identityではない。
- trim後1-1024文字、control characterと改行を拒否する。
- separatorを`/`へ正規化し、ASCII文字だけをlowercaseする。非ASCII code pointは保持する。
- 明示`repoKey`だけをbasis候補にし、basenameやGit remoteから生成しない。
- `repoPath`から生成したlegacy lowercase keyをnormal retrievalのbasisにしない。

### `repoPath`

- local checkoutのabsolute lexical pathを表す。
- POSIX absolute path、Windows drive absolute path、またはhostが空/`localhost`のabsolute `file://` URIだけを受け付ける。
- relative path、malformed URI、query/hash付きfile URI、remote-host file URIを`INVALID_REPO_PATH`として拒否する。
- separatorを`/`へ統一し、`.`/`..`をlexical normalizeし、root以外のtrailing separatorを除去する。
- percent encodingはvalid file URIで一度だけdecodeする。
- path caseは保持する。filesystem access、`realpath`、symlink resolution、存在確認は行わない。
- `/repo-a`と`/repo-a-archive`、caseだけが異なるpathを同一とみなさない。

### Authoritative Alias Binding

`projectRef`とrepo aliasesを同時に検証する必要がある場合は、次のlogical contractを持つauthoritative declarationを使用する。

```text
project_identity_aliases(
  project_ref,
  alias_kind,          -- repo_key | repo_path
  normalized_value,
  status,              -- active | revoked
  source,
  created_at,
  updated_at
)
```

- 一つのprojectRefは複数checkout pathを持てる。
- `(project_ref, alias_kind, normalized_value)`をuniqueにする。
- 別のactive projectRefへ同じaliasを割り当てない。
- requestに複数identifierがあり、authoritative bindingと矛盾する場合は`IDENTITY_CONFLICT`でrequest全体を拒否する。
- binding sourceがない通常MCPでは、最優先basisだけをselectionに使い、下位identifierを同一identityの証拠として扱わない。traceには`bindingStatus=unverified`を残す。
- Security adapterは`bindingStatus=verified`またはprojectRef-only requestを必須にする。

### Match Precedence

requestのmatch basisは次の順で一つだけ選ぶ。

1. trustedまたは明示された`projectRef`
2. 明示`repoKey`
3. normalized `repoPath`
4. identityなし

優先basisで0件の場合はglobal itemだけを返す。下位identifier、legacy metadata、URI prefix、unscoped searchへfallbackしない。

legacy dataの救済はread-only inventory、explicit compatibility report、またはmigrationで行い、normal retrievalへ混ぜない。

## Persistence Contract

### Canonical Identity Columns

malformed JSON、backend差、query plan差をretrieval correctnessから外すため、retrieval hard gateはcanonical columnsを正本にする。portable/export用JSONは維持するが、enforcement後のruntime lookupはJSONだけに依存しない。

Knowledge、Source、EpisodeCardには`classification_status`を追加し、値を`classified | unresolved | conflict | malformed`へ固定する。additive migration時のdefaultは`unresolved`とし、旧binaryが新schemaへidentityなしrowを書いても検索対象へ自動昇格しないようにする。normal retrievalは`classified`だけを対象とする。

| Entity | Required additions/contract |
| --- | --- |
| `knowledge_items` | existing `scope`に加え`classification_status`、`project_ref`、`repo_key`、`repo_path` canonical columns。`applies_to`はportable representationとして同値を保持 |
| `sources` | `classification_status`、`scope`、`project_ref`、`repo_key`、`repo_path`。NULLだけをglobalと解釈しない |
| `episode_cards` | `classification_status`、`scope`、`project_ref`を追加し、既存`repo_key`、`repo_path`と統合 |
| `context_compile_runs` | normalized `project_ref`、`repo_key`、`repo_path`、`match_basis`、`identity_contract_version`、`scope_mode` |
| `context_compile_task_traces` | runと同じidentity fields、`identity_fingerprint`、`binding_status` |
| `context_pack_items` | `scope_snapshot` JSON。candidate scope、match basis、identity fingerprint、contract version、decisionを保存 |
| candidate/usage/episode feedback | evidence/metadataへ同じscope snapshotを保存 |

### Write Invariants

- normal writeは`classification_status=classified`を明示する。値を省略した旧writeはdefault `unresolved`となる。
- `classification_status=classified, scope=global`ではproject identity columnsをNULLにする。
- `classification_status=classified, scope=repo`では少なくとも一つのcanonical identityを必須にする。
- `unresolved | conflict | malformed`はnormal retrieval対象外とし、migration/audit以外で`classified`へ変更しない。
- 新規repo itemにidentityがない場合、保存後にunresolved化せずwriteを`PROJECT_IDENTITY_REQUIRED`で拒否する。
- Knowledge `applies_to`とcanonical columnsが矛盾する場合はwriteを拒否する。
- enforcement前にapplication validationを入れ、既存unresolved migration完了後にDB CHECK/trigger相当を有効化する。
- SQLiteとPostgreSQL schema/migrationを同じversionで更新する。
- migrationはsingle-process SQLite writer policyに従い、production TypeScript processから直接writeしない。

### Trace Privacy

- normalized identityはlocal run/task traceに一度保存する。
- candidate/pack/usage側は原則fingerprintを保存し、absolute pathを各rowへ複製しない。
- user-facing markdownにはidentity valueを出さない。
- diagnostics/reportは件数、reason、最大20件のitem ID previewだけを返し、title/body/source contentを返さない。

## Scope And Applicability Predicate

scope判定とfacet判定を分離する。scopeはsecurity/repository isolation hard gate、facetはrelevance hard gateである。

```text
scope_allow(item, request) =
  item.status is allowed
  AND item.classification_status == classified
  AND (
    item.scope == global
    OR (
      item.scope == repo
      AND request.matchBasis != none
      AND item.canonical_identity[request.matchBasis] is present
      AND item.canonical_identity[request.matchBasis] == request.matchValue
    )
  )

facet_allow(item, request) =
  request has no facets
  OR item.general == true
  OR at least one normalized requested facet matches the same facet kind

allow(item, request) = scope_allow(item, request) AND facet_allow(item, request)
```

追加ルール:

- `general=true`はfacet上のgeneralであり、repo boundaryを越える権限ではない。
- `scope=repo`で選択basisのidentityがないitemは、別identity fieldがあってもdenyする。
- candidateのclassification statusまたはscope値がunknown、NULL、malformedならdenyする。
- request facetsがある場合、explicit facet mismatchかつ`general!=true`はdenyする。
- facetなしrequestではscopeを通ったcandidateをfacet理由で除外しない。
- normalization、facet kind、OR semantics、weightはRust/TypeScript shared fixtureで固定する。
- applicability scoreはhard gate通過後のranking signalにのみ使用する。

## Query Execution And Performance Contract

- status、scope、selected identity basis、facet hard gateはarbitrary `LIMIT`より前に適用する。
- hard gate後のtext scoringをRustで行う場合、eligible rowsをstreamしtop-K heapで選ぶか、scope-aware FTS queryを使用する。importance順500件を先に切らない。
- SQLite JSONをmigration/inventoryで読む場合は`CASE WHEN json_valid(...) THEN json_extract(...) ELSE NULL END`または同等のsafe functionを使う。`AND`の左辺評価順へ依存しない。
- malformed JSON countはquery failureにせずdiagnosticsへ記録する。
- canonical identity columnsへ`status/scope/project_ref`、`status/scope/repo_key`、`status/scope/repo_path`の必要なindexを追加する。
- globalとrepoのORでindexが使われない場合は、`UNION ALL`したglobal branchとrepo branchを個別index scanする案を比較する。
- ANN/vector backendがidentity pre-filterを保証できない場合、scoped queryではvector laneをdegraded reason付きで無効化するか、eligible ID setに対するexact distance searchを使う。
- correctnessをoverfetch倍率、candidate limit、index有無に依存させない。
- temp DB、live-size read-only copy、10倍synthetic datasetでquery plan、p50/p95、selected ID parityを測る。

## Rollout Modes

一つのruntime settingで次のmodeを切り替える。

| Mode | Returned result | New predicate | Writes |
| --- | --- | --- | --- |
| `legacy` | 現行結果 | 未実行 | identity schemaへ可能な範囲で記録 |
| `shadow` | 現行結果 | read-onlyで計算し差分監査 | new traceのみ。usage countやfeedbackへ影響させない |
| `enforced` | new predicate結果 | active | new trace/usageのみ |

rules:

- schema/migration rollout直後は`shadow`を既定にしない。まずproducerが新contractを書けることを確認してから`shadow`へ進む。
- shadow candidateはcomposerやexternal providerへ送らない。
- shadow計算はselection count、wrong-project exclusion、unresolved exclusion、No Content予測だけを保存する。
- enforced後のrollbackは`global_only_safe_mode`または直前のenforced versionへ戻す。`legacy` unscoped resultへ戻さない。
- setting changeはaudit logへactor、from/to、reason、contract versionを保存する。

## Implementation Order

### Expected Implementation Surface

T0のinventoryで確定するが、少なくとも次の既存file群を変更対象として追跡する。新しいresolverやmigrationを追加する場合も、各行のownerから参照される一つのshared contractに集約する。

| Concern | Primary files/modules |
| --- | --- |
| Rust MCP schema/runtime | `crates/context-stilld/src/domains/mcp_lifecycle/native_tools.rs`、`native_compile.rs`、`native_knowledge.rs`、`native_episodes.rs` |
| Rust persistence | `crates/context-stilld/src/domains/sqlite_writer/schema.rs`とsingle-writer migration path |
| TypeScript input/runtime | `src/shared/schemas/compile.schema.ts`、`src/mcp/tools/context-compile.tool.ts`、`src/modules/context-compiler/query-context.ts`、`context-compiler.service.ts` |
| Knowledge retrieval | `src/modules/knowledge/knowledge.service.ts`、`knowledge.repository.ts`、`knowledge.repository.sqlite.ts` |
| Source retrieval | `src/modules/sources/source-retrieval.service.ts`、`source.repository.ts`、`source.repository.sqlite.ts` |
| Episode retrieval | `src/modules/episodic-memory/episode-card.service.ts`、`episode-card.repository.ts`、`episode-card.repository.sqlite.ts` |
| Schema/trace/pack | `src/db/schema-knowledge.ts`、`schema-sources.ts`、`schema-context.ts`、`src/db/sqlite/schema.ts`、compile run/task/pack schemas and repositories |
| Producers | `src/modules/registerCandidate/register-candidate.service.ts`、`src/cli/finalize-distille.ts`、`src/modules/finalizeDistille/*`、`src/modules/sources/markdown-importer.service.ts`、episode distiller/vibe-memory paths |
| Replay/cache/audit | `src/modules/landscape/landscape-replay*.ts`、`landscape-snapshot-cache*.ts`、context compile evaluation repositories/services |
| Public search tools | Rust `native_tools.rs`/`native_knowledge.rs`/`native_episodes.rs`とTypeScript `knowledge.tool.ts`/`episode.tool.ts`のenabled owners |

各phaseのPR descriptionには、この表を基に「変更済み」「調査の結果対象外」「後続phase」のいずれかを全行について記録する。これによりactive pathだけ直してside pathを残すことを防ぐ。

### T0: Reproduction, Full Inventory, And Shared Fixtures

Goal:
現行のwrong-project選択とデータ分類状態を再現し、全backend/toolが同じsemanticsを検証できる基準線を作る。

Tasks:

- temp SQLiteへRepo A、Repo B、global、identity未解決、malformed、conflicting identityのKnowledge/Source/EpisodeCardを登録する。
- shared JSON fixtureへ次を含める。
  - identityなし、projectRef、repoKey、repoPath
  - prefix collision、path case collision、trailing slash、dot segment
  - POSIX/Windows/file URI、malformed/relative/remote-host file URI
  - multiple identifier一致/不一致
  - missing/malformed candidate identity
  - global、repo+general、facet match/mismatch
  - 500件超と120件超のsaturation case
- current Rust compileがRepo Bまたはunresolved itemを選択するred testを追加する。
- composer disabled/enabledの両方でfinal markdownだけでなくcandidate ID、outbound ID、pack IDを取得するtest harnessを作る。
- read-only inventoryをdoctor/reportへ追加する。
  - entity別global/repo/unresolved/malformed/conflict
  - identity basis別件数
  - producer/source kind別unresolved件数
  - request identityごとのwould-select/would-exclude
  - 直近runのselected IDとscope decision再評価
- inventoryはtitle/bodyを出さず、件数と最大20件のitem ID previewだけを返す。
- baseline availabilityを記録する。
  - identity presence rate
  - No Content rate
  - selected Knowledge/Source/Episode count distribution
  - compile p50/p95 latency
  - agentic composer failure rate
- baseline cohortは直前14日間のidentity-present compile requestとする。500件未満なら観測期間を最長30日まで延長し、それでも不足する場合は全件数と不足を明記してfixture/synthetic計測と分けて扱う。

Completion criteria:

- wrong-project selectionが修正前に自動testで再現される。
- Knowledge 7,092、Source 99、EpisodeCard 841の未分類をlive DBへwriteせず観測できる。
- Rust、TypeScript SQLite、TypeScript PostgreSQLが同じfixtureを読み、現行差分をreportできる。
- integration suiteがskipされた場合は成功扱いにしない。

Stop conditions:

- live DBへfixture writeが必要になる。
- final markdownだけを検証し、candidate/composer/pack IDを観測できない。
- inventoryがcontentやabsolute pathを過剰に出力する。

### T1: Additive Identity Schema, Resolver, And Trace Storage

Goal:
retrieval挙動をまだ変えず、callerがidentityを明示でき、全entity/runが新contractを保存できる状態にする。

Tasks:

- Rust/TypeScript MCP schemaと`CompileInput`へ`repoPath`、`repoKey`、`projectRef`を追加する。
- `additionalProperties`、max length、control character、absolute path validationをRust/TypeScriptで一致させる。
- 共通仕様に従う`CompileProjectIdentity` resolverをRust/TypeScriptへ実装する。
- resolver fixtureを両言語で共有する。
- `project_identity_aliases` contractと必要なschemaを追加する。
- Persistence Contract記載のcanonical columns、trace fields、scope snapshotをSQLite/PostgreSQLへadditive migrationする。
- migration前後のschema version、index、NULL/default behaviorをtestする。
- Rust `NativeToolContext.project_root`とTypeScript `process.cwd()`をrequest identity resolverへ渡さない。
- run inputにはcaller raw valueではなく、validation済みnormalized identityとcontract versionを保存する。
- request raw identityを保存する必要がある場合はsecret redactionとlength制限を適用し、normalized fieldsと分離する。
- `initial_instructions`とtool docsへ、workspace taskではabsolute `repoPath`、explicit `repoKey`、またはstable `projectRef`を渡すことを追記する。
- active Rust tool descriptionを実際のcandidate kindsに合わせる。
- modeは`legacy`のままとし、selection behaviorをこのphaseで変えない。

Completion criteria:

- tools/listに3 fieldが現れる。
- valid/invalid path、conflict、precedence fixtureがRust/TypeScriptで一致する。
- run/task traceにnormalized request identity、basis、version、trust、binding statusが保存される。
- identity未指定時、daemon root/process cwdはidentity fieldsへ保存されない。
- old binary/new schema、new binary/old schemaの対応方針がmigration testで明確である。

Stop conditions:

- projectRefをrepo name/path/remoteから推測する。
- T1だけでglobal-only enforcementを有効化する。
- traceにprojectRefを保存できないまま`project_ref` basisを公開する。

### T2: Fix All Identity Producers

Goal:
新しいunresolved repo-scoped itemを生成せず、shadow/enforcement前にwrite pathを閉じる。

Tasks:

- 次のproducerへnormalized identityを伝播する。
  - Rust `register_candidates`
  - TypeScript register candidate/bulk registration
  - finalizeDistille / `cover-evidence-result://`
  - markdown/wiki Source importer
  - Source fragment/vector producer
  - compile-run-to-EpisodeCard distiller
  - vibe memoryからEpisodeCardを生成する経路
  - migration/import/portability path
- `register_candidates`はitemまたはtrusted request contextのidentityを受け取る。generalでないのにidentityがなければ拒否する。
- finalize匿名化はtitle/body/referenceからproject identifierを除去するが、authoritative identityをcontent外canonical columnsへ保存する。
- compile run由来EpisodeCardはrun input/task traceのrequest identityだけを使用し、legacy daemon `repo_path`を根拠にしない。
- Source importerはcapture開始時のauthoritative root/declarationをSource canonical columnsへ保存する。
- producerごとにwrite contract testを追加する。
- DB CHECKをまだ有効化できない既存DBでも、application write boundaryでunresolved repo itemを拒否する。
- producer rejection countをdiagnostics/auditへ保存する。

Completion criteria:

- 全producerのnew repo-scoped fixtureが少なくとも一つのcanonical identityを持つ。
- identityなしrepo writeはすべて`PROJECT_IDENTITY_REQUIRED`で拒否される。
- global writeはidentity columnsがNULLである。
- 7連続日かつ200件以上のidentity-bearing producer eventからなるobservation windowでnew unresolved countが0である。低volume環境では期間を延長し、test fixtureだけで代替しない。

Stop conditions:

- availability維持のためidentityなしitemを自動global化する。
- anonymized contentへabsolute path/projectRefを埋め戻す。
- daemon root/process cwdをproducer identityとして暗黙利用する。

### T3: Dry-Run Migration And Deterministic Backfill

Goal:
根拠がある既存データだけを分類し、enforcementによるavailability影響を事前に確定する。

Tasks:

- Knowledge、Source、EpisodeCardそれぞれにidempotentなdry-run/write migrationを作る。
- migration rowごとにentity ID、before/after fingerprint、reason code、provenance source、migration versionをaudit tableへ保存する。
- deterministic sourceとして次だけを許可する。
  - 既存canonical metadataのexact `repoPath` / `repoKey` / `projectRef`
  - source capture/import sessionに保存されたexact project root/declaration
  - request identityが保存されたcompile run/task trace
  - authoritative `project_identity_aliases`
  - explicit user-reviewed global promotion
- 次を根拠に使用しない。
  - title/body中のproject名
  - relative source pathやsource URI prefixだけの推定
  - directory basename
  - 類似repository名
  - Git remoteの推測
  - legacy daemon root/process cwd
- `cover-evidence-result://`はTargetState、finding job、source captureまでprovenance chainを辿り、authoritative identityがある場合だけbackfillする。
- null EpisodeCardはsource compile runにrequest identityが保存されている場合だけbackfillする。841件のvibe-memory episodeを一括global化しない。
- Sourceはimport session/declarationがある場合だけ分類し、URI文字列だけでは分類しない。
- unresolvedは削除せず`classification_status=unresolved`、矛盾は`conflict`、parse不能は`malformed`として明示し、通常retrievalから除外する。`scope`のNULLや非標準値で分類状態を代用しない。
- write前にoffline backup/restore手順、batch size、transaction boundary、再実行手順を確認する。
- dry-runとwrite後の件数/checksumが一致することを検証する。

Completion criteria:

- entity別backfill、skip、conflict、malformed件数と理由が出る。
- dry-runを2回実行して結果が同一である。
- write後再実行で更新件数0になる。
- unresolved itemはretrieval対象へ戻らない。
- backupからのrestore drillまたはtemp-copy rollback testが成功する。

Stop conditions:

- unresolvedを本文類似度でprojectへ割り当てる。
- unresolvedを一括global化する。
- dry-runとwriteで件数またはfingerprintが一致しない。
- migrationがlive composer/searchと同じDBへtest fixtureを書き込む。

### T4: Implement Scope Gates And Shadow Comparison

Goal:
new predicateを全retrieval pathへ実装し、user-visible結果を変えずに安全性・可用性・性能差を測る。

Tasks:

- Rust `context_compile` Knowledge/EpisodeCard retrievalへresolved identityとfacetsを渡す。
- Rust public `search_knowledge`、`search_episodes`へ同じresolver/predicateを共有する。
- TypeScript Knowledge text/vector、Source text/vector、EpisodeCard retrievalへ同じidentity objectを渡す。
- TypeScript primary/legacy/unscoped fallbackをnormal retrievalから削除する。
- TypeScript compilerの`process.cwd()` trace/episode fallbackを削除する。
- canonical columnsでscope SQL predicateをhard gateとして適用する。
- applicability predicateをRust/TypeScript/PostgreSQL/SQLiteで一致させる。
- eligible set前の500/200/120 limitを削除またはscope-aware queryへ置換する。
- scope-awareでないvector laneは無効化またはexact eligible-ID searchへ置換する。
- malformed/unresolved/conflictをdenyし、reason別excluded countを記録する。
- `shadow` modeでlegacy/new candidate IDを比較する。
- shadow candidateをcomposer、usage count、external providerへ送らない。
- agentic enabled時はmock transportでlegacy outboundだけが送られ、new shadow candidate本文が送信されないことを確認する。
- context pack item、usage event、episode feedbackへscope snapshotを保存するコードを実装する。

Completion criteria:

- shared fixture全件でRust/TypeScript/backend parityが成立する。
- shadow new candidateにwrong-project itemが0件である。
- missing identity shadow resultにrepo itemが0件である。
- matching repo/global itemが取得できる。
- no matchをunrelated repo itemで埋めない。
- query planとp95 latencyがPerformance Gate内である。

Stop conditions:

- shadow candidateをexternal providerへ送信する。
- unscoped top-K後filterだけでvector correctnessを主張する。
- facet/scope filterをarbitrary limit後に適用する。
- mismatchの原因が不明なままenforcedへ進む。

### T5: Replay, Evaluation, Cache, And Audit Parity

Goal:
runtime selectionだけでなく、replay、evaluation、cache、post-run auditも同じidentity semanticsで説明可能にする。

Tasks:

- replay `compileInputFromRun`へnormalized projectRef/repoKey/repoPathとbasisを戻す。
- legacy runのdaemon repo_pathをrequest identityとして使用せず、identity missingとして扱う。
- replay reportで`legacy_identity_unknown`と`current_global_only`を区別する。
- landscape/context evaluationがscope changeによるexpected candidate lossをranking regressionと誤判定しないversioned comparisonを追加する。
- replay/snapshot cache keyへ`identityContractVersion`とretrieval semantics versionを含める。
- rollout時に旧versionのcacheをstale化する。
- post-run auditはselection時scope snapshotを基準にし、後から変更されたitem metadataだけで判定しない。
- wrong-project、unresolved selected、missing trace、fingerprint mismatchを別metricにする。
- audit resultはread-onlyで、contentを返さない。

Completion criteria:

- scoped replayが元runのtrusted/request identityを保持する。
- identity不明legacy runはglobal-onlyまたはnot-comparableとして明示される。
- cache enabled/disabledで同じcandidate semanticsになる。
- 旧cache payloadがnew contractの結果として返らない。
- scope snapshotによるpost-run auditがfixture mismatchをすべて検出する。

### T6: Enforce Default Behavior With Safe Rollout

Goal:
MCP requestからcomposer/traceまでのproject isolationを本番既定動作にする。

Entry gates:

- T0-T5完了。
- new unresolved producer countがobservation windowで0。
- shadow wrong-project countが0。
- identity-capable client/tool schemaの配備が完了。
- availability/performance metricsが閾値内。

Tasks:

- canary client/sessionで`enforced`へ切り替える。
- HTTP MCP smokeでRepo A/Repo B/global/unresolved/malformed/conflict fixtureを使う。
- agentic composer disabled/enabledの両方でcandidate、outbound、pack、usage IDを検証する。
- missing identity、wrong projectRef、wrong repoKey、prefix/case collision、malformed path/JSONのnegative testを実行する。
- canary後に段階的に対象を増やし、各段階でSafety/Availability/Performance Gateを再評価する。
- mismatchが一件でもあれば拡大を停止し、global-only safe modeへ切り替える。
- enforced後の直近runをscope snapshotでread-only auditする。
- initial instructionsとclient examplesをenforced semanticsへ更新する。

Completion criteria:

- normal MCP requestでwrong-project candidate/outbound/pack/usage数が0。
- identityなしrequestでrepo candidate数が0。
- unresolved/malformed/conflict itemのselected数が0。
- live read-only auditのmismatchが0。
- availability/performanceがRelease Gate内。
- rollback drillがunscoped fallbackを復活させず成功する。

Rollout stages:

1. dedicated canary client/sessionで50 compile run以上。
2. identity-capable client/sessionの25%で100 compile run以上かつ24時間以上。
3. identity-capable client/sessionの100%で200 compile run以上かつ72時間以上。

各stageは必要run数と期間の両方を満たしてから進む。単一client環境では割合の代わりにsession cohortを分ける。Safety Gate違反は即停止し、Availability/Performance Gate違反はstageを維持またはsafe rollbackして原因を直す。

### T7: Security Intelligence Adapter Gate

Goal:
stable project identityをSecurity Integrationへtrustedに供給し、通常MCPのselection hintより強いcontractを適用する。

Tasks:

- adapterがauthenticated project declarationから`projectRef`を注入する。
- model/user supplied `projectRef`、repoKey、repoPathによる上書きを拒否する。
- `projectRef` missing、binding conflict、revoked aliasをrequest errorにする。
- assessment/revision authorizationはこのselection contractとは別に検証する。
- Security adapter requestを`trust=trusted_adapter`としてtraceする。
- Stage 3開始前にlive audit mismatch 0とbinding coverage 100%を確認する。

Completion criteria:

- adapter requestはtrusted projectRefなしで実行できない。
- spoofed lower-priority identityでscopeを変更できない。
- repository isolationとauthorizationのtestが分離され、両方passする。

### Delivery Units And Dependencies

巨大な一括変更を避け、次の順でmerge可能なdelivery unitへ分ける。後続unitは記載したentry conditionを満たすまで有効化しない。

| Unit | Content | Entry/merge condition |
| --- | --- | --- |
| PR-0 | T0 fixtures、red tests、read-only inventory、baseline | production behaviorを変更しない |
| PR-1 | T1 additive schema、resolver、trace、tool schema | old/new schema compatibility test pass、mode=`legacy` |
| PR-2 | T2 producer propagation/write rejection | producer contract tests pass、新規unresolved 0の観測開始 |
| PR-3 | T3 dry-run/write migration tooling | dry-run deterministic、backup/restore drill pass |
| PR-4 | T4 predicates、public search parity、side-effect-free shadow | migration/write path ready、mode=`shadow`のみ |
| PR-5 | T5 replay/cache/audit versioning | shadow semanticsとreplay parity pass |
| PR-6 | T6 canary enforcement、docs/client examples | T0-T5 Release Gate pass |
| PR-7 | T7 trusted Security adapter | normal enforcement stable、binding coverage 100% |

PR-1からPR-5はadditive schemaとflagged behaviorで順方向互換にする。各PRは単独rollback手順と観測metricを持ち、PR-6以後だけはsafety rollback contractに従って`legacy`へ戻さない。

## Test Matrix

### Scope And Identity

| Request | Candidate | Expected |
| --- | --- | --- |
| identityなし | `scope=global` | allow |
| identityなし | `scope=repo`, exact identityあり | deny + `PROJECT_SCOPE_MISSING` |
| Repo A | `scope=global` | allow |
| Repo A | Repo A exact selected basis | allow |
| Repo A | Repo B exact | deny |
| `/repo-a` | `/repo-a-archive` | deny |
| `/Work/A` | `/work/a` | deny for repoPath basis |
| Repo A | selected basis field missing、別basis fieldあり | deny |
| Repo A | repo identity未解決 | deny + diagnostic |
| Repo A | malformed identity JSON/legacy metadata | deny + diagnostic、query succeeds |
| Repo A | Repo B + `general=true` | deny |
| `projectRef=A` | `projectRef=B` | deny |
| `projectRef=A, repoPath=B` | binding says A!=B | reject `IDENTITY_CONFLICT` |
| projectRef basis 0件 | lower repoKey matchあり | global only、no lower fallback |
| scoped 0件 | unrelated repo itemあり | no unscoped fallback |

### Path Validation

| Input | Expected |
| --- | --- |
| absolute POSIX path | normalize/accept |
| absolute Windows drive path | normalize/accept |
| absolute `file://` URI、empty/localhost host | normalize/accept |
| relative path | reject `INVALID_REPO_PATH` |
| malformed percent encoding | reject |
| file URI with query/hash | reject |
| remote-host file URI | reject |
| path with `.`/`..` | lexical normalize |
| root以外のtrailing slash | remove |
| nonexistent absolute fixture path | accept |

### Facets

| Request | Candidate | Expected |
| --- | --- | --- |
| facetsなし | scope match + facetsなし | allow |
| facetsあり | scope match + one facet match | allow/rank |
| facetsあり | scope match + explicit `general=true` | allow/rank below specific match |
| facetsあり | scope match + all explicit facets mismatch | deny |
| facetsあり | global + explicit facets mismatch | deny |
| facetsあり | other repo + facet match | deny |

### Saturation And Vector

- wrong-project high-importance itemを500件以上入れてもmatching repo itemを取得できる。
- facet mismatch itemを500件以上入れてもmatching facet itemを取得できる。
- SQLite text、PostgreSQL text、vector enabled/disabledでscope-eligible ID setが一致する。
- scope-aware prefilter不能なvector laneは明示degradedとなり、unscoped candidateを返さない。

### Persistence And Composer

- request normalized identityとrun/task traceが一致する。
- candidate scope fingerprintとpack/usage/feedback snapshotが一致する。
- daemon root/process cwdがidentityへ保存されない。
- composer disabled/enabledでeligible candidate IDが同じ。
- mock external provider outboundにwrong-project/shadow itemが0件。
- item metadataをrun後に変更してもsnapshot audit結果が変わらない。

### Migration

- dry-run再実行で同一件数/checksum。
- write後再実行で更新0件。
- conflicting/malformed/unresolvedはskipされる。
- Knowledge/Source/EpisodeCardのproducerごとにnew unresolved 0件。
- backup/restore後の件数とfingerprintが一致する。

## Safety, Availability, And Performance Gates

### Safety Gate: hard zero

- wrong-project selected candidate: 0
- wrong-project composer outbound: 0
- wrong-project pack item: 0
- wrong-project usage/feedback event: 0
- unresolved/malformed selected item: 0
- request/trace identity mismatch: 0
- security adapter untrusted/missing projectRef acceptance: 0

一件でも発生した場合はrolloutを停止する。平均や割合で許容しない。

### Availability Gate

shadow/enforcedのidentity-present requestを同じbaseline cohortと比較する。

- No Content rate増加: 5 percentage points以内。
- median selected Knowledge count低下: 20%以内。
- source/episode enabled pathのmedian selected count低下: 20%以内。
- matching identity itemが存在するfixture/live sampled requestでfalse exclusion 0。
- identity missingによるglobal-onlyはavailability regressionと混同せず別metricにする。

閾値を超えた場合はunscoped fallbackを戻さず、producer/migration/client adoptionを修正して再評価する。閾値変更にはowner承認と理由のauditを必要とする。

### Performance Gate

- compile p95 latency: baseline比+20%以内、かつローカル通常利用で追加100ms以内を目標とする。
- inventory/migrationをcompile request pathで同期実行しない。
- live-size copyと10倍synthetic datasetでquery planに全active tableの不要なfull scanがないことを確認する。
- performanceのためにscope/facet correctnessを緩めない。

## Required Verification Commands

実装時にrepository標準commandへ合わせ、専用temp/test DBだけで実行する。

```bash
cargo test -p context-stilld native_compile -- --nocapture
cargo test -p context-stilld native_knowledge -- --nocapture
cargo test -p context-stilld native_episodes -- --nocapture
cargo test -p context-stilld native_tools -- --nocapture
cargo test -p context-stilld sqlite_writer -- --nocapture

bunx vitest run \
  test/mcp.contract.test.ts \
  test/schemas.test.ts \
  test/query-context.test.ts \
  test/knowledge.service.test.ts \
  test/knowledge-repository.test.ts \
  test/source-retrieval.service.test.ts \
  test/episode-card.repository.sqlite.test.ts \
  test/context-compiler.service.test.ts \
  test/landscape-replay-comparison.service.test.ts \
  test/landscape-snapshot-cache.service.test.ts

CONTEXT_STILL_RUN_DB_TESTS=1 bunx vitest run \
  test/knowledge.repository.test.ts \
  test/context-compiler.integration.test.ts

bun run typecheck
bun run lint
cargo clippy --workspace --all-targets -- -D warnings
bun run rust:mcp:smoke
bun run mcp:smoke:sqlite
```

Verification rules:

- DB integration commandはdatabase名に`test`を含む専用PostgreSQL DBを設定する。
- test summaryのexecuted test数を保存し、対象suiteにskipが1件でもあればRelease Gate失敗とする。
- live DBへfixtureを書き込まない。
- migration verificationはlive DBのread-only copyまたはtemp DBで行う。
- smokeはtools/list schemaだけでなくcandidate/outbound/pack/usage IDを検証する。
- command、exit code、executed/skipped count、duration、artifact pathをrelease evidenceへ保存する。

## Operational Rollback

### Before Enforcement

- schemaはadditiveなのでcode flagを`legacy`へ戻せる。
- migration writeを行った場合もcanonical columnsの追加値は保持し、旧contentを削除しない。
- producerが新identityを書いたデータを旧binaryが破壊しないことをcompatibility testで確認する。

### After Enforcement

- wrong-project mismatch時は即座に`global_only_safe_mode`へ切り替える。
- availability/latency問題時は直前のenforced predicate versionまたはvector-disabled exact/text pathへ戻す。
- unscoped fallback、legacy metadata/URI prefix fallback、daemon root fallbackを復活させない。
- rollback action、reason、affected run range、follow-up auditを記録する。

## Non-Goals

- Active Knowledgeのactivation policy変更。
- title/body品質やLLM ranking全体の再設計。
- unresolved dataの自動削除・自動global化。
- `repoKey`をstable identityへ再定義すること。
- contextStill製品自身の`src/project-identity.ts`をrepository identityとして流用すること。
- Git remote、basename、本文、relative pathからidentityを推定すること。
- Rust compilerへ新しいSource retrieval機能を追加すること。
- projectRefだけでtenant authorizationを実装したとみなすこと。
- Security assessment revision bindingを`context_compile`へ同時実装すること。
- safety gateをavailability理由で緩和すること。

## Release Gate

次をすべて満たすまで「repository isolation完了」としない。

PR-0開始時にRust MCP、TypeScript retrieval、persistence/migration、release operations、Security adapterの各logical ownerと最終承認者をissueへ実名で割り当てる。未割当領域が一つでもあればimplementation-ready扱いを解除する。

### Contract

- 公開MCP schemaが3 identity fieldを受け取る。
- Rust/TypeScript resolverがshared fixture全件で一致する。
- match basisが一つだけで、lower/unscoped fallbackがない。
- projectRefのtrust/authorization上の限界がdocumentedである。

### Persistence And Producers

- Knowledge/Source/EpisodeCardに明示scopeとcanonical identityがある。
- run/task/pack/usage/feedbackへcontract versionとscope snapshotが保存される。
- daemon root/process cwdがrequest identityとして保存されない。
- 全producerでnew unresolved repo itemが0。
- migrationがidempotentで、unresolvedを推測分類していない。

### Retrieval

- scope/facet hard gateがarbitrary limitより前に適用される。
- missing identityがglobal-onlyになる。
- malformed/unresolved/conflictがfail closedになる。
- Knowledge、Source、EpisodeCardのenabled pathが同じidentity境界を通る。
- public `search_knowledge`、`search_episodes`も同じ境界を通る。
- vector laneがscope prefilter不能時に安全にdegradeする。

### Rollout And Verification

- shadow Safety Gateがhard zero。
- Availability/Performance Gateが閾値内。
- integration suiteにskipがない。
- agentic on/off、HTTP MCP smoke、migration、replay/cache testがpassする。
- live read-only audit mismatchが0。
- safe rollback drillがunscoped behaviorを復活させず成功する。
- Security Integration adapterはtrusted projectRefなしのrequestをfail closedにする。

## Plan Review Checklist

実装開始前レビューでは次の20項目を0-5点で採点し、95点未満なら計画を再修正する。

1. active runtime ownerと変更対象が明確。
2. threat modelとauthorization非目標が明確。
3. identity normalizationがplatform差を含め具体的。
4. match precedenceが単一basisである。
5. conflicting identifiersの扱いが定義済み。
6. projectRef trust/bindingが定義済み。
7. 全entityのpersistence contractが定義済み。
8. run/pack/usageのscope snapshotが定義済み。
9. malformed JSONのsafe queryが定義済み。
10. candidate limit/vector laneのcorrectness条件が定義済み。
11. 全producerの修正対象が列挙済み。
12. Knowledge/Source/EpisodeCard migrationがidempotent。
13. unresolved dataを推測分類しない。
14. shadow modeがside effect free。
15. enforcement entry gateが測定可能。
16. safety rollbackがunscopedへ戻らない。
17. replay/cacheがversioned identityを保持する。
18. shared fixtureとnegative/saturation testが十分。
19. integration testのskipを成功扱いしない。
20. Safety/Availability/Performance Release Gateが数値化されている。

### Current Plan Review Result

自己レビュー結果は`98 / 100`。contract/safety 50/50、persistence/migration 20/20、rollout/rollback 15/15、verification/operability 13/15と評価する。

残る2点は、T0 inventory完了前なので変更対象fileの完全性を確定できないことと、実測baseline前なのでavailability/latency閾値の妥当性を実データで再校正できていないことによる。どちらもPR-0の成果物とし、結果が現行閾値を支持しなければ理由と承認者を記録して本計画を再採点する。95点以上を維持できない変更はPR-1へ進めない。
