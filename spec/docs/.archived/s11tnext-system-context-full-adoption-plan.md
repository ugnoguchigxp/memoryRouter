# s11tnext SystemContext 全面採用 実装計画

> アーカイブ日: 2026-08-15。実装コミット: `e465154`。

## 背景

ContextStill の LLM 経路では、SystemContext、output contract、tool usage rule、repair instruction、runtime fact の組み立てが TypeScript のロジックと同じファイルに混在している。

代表例:

- `src/modules/context-compiler/context-response-composer.service.ts`
  - response style と見出し条件を分岐しながら SystemContext の自然言語を組み立てる。
- `src/modules/distillation/distillation-prompts.ts`
  - common rule、source kind、verification mode、procedure rule を配列操作で合成する。
- `src/modules/context-decision/context-decision.service.ts`
  - decision logic の途中に大きな英語 SystemContext が 2 系統埋め込まれている。
- `src/modules/episodeDistiller/worker.ts`
  - message builder が runtime data と SystemContext を同時に所有する。
- `src/modules/llm/providers/codex.provider.ts`
  - caller が渡した messages に加えて provider adapter 自身が最終 instruction を追加する。

2026-07-24 時点の機械的な初期棚卸しでは、`role: "system"` は型定義を除いて 23 箇所、12 implementation files に存在する。これとは別に、直接 provider message になっていない SystemContext builder、Codex provider envelope、user role / reminder に混在する author-authored instruction がある。

s11tnext は、この自然言語 authoring を TOML に分離し、検証済み catalog、型付き key/value contract、locale policy、trust boundary、content hash、manifest を application logic へ提供する。

本計画は s11tnext を限定的な補助ライブラリとしてではなく、ContextStill の SystemContext authoring/runtime の標準基盤として全面採用する。移行過程では s11tnext の弱点を回避して隠すのではなく、再現可能な finding として記録し、s11tnext 側を改善・release して ContextStill で再評価する。

## 目的

- ContextStill が provider へ送るすべての SystemContext を s11tnext catalog 由来にする。
- application code から repository-authored な自然言語指示、output contract、tool contract、prompt overlay を除去する。
- code 側には route selection、runtime value construction、provider selection、tool execution、retry、authorization、parsing、persistence を残す。
- context key と runtime variables を生成型で検証し、unknown key、missing value、extra value、invalid value を fail-closed にする。
- user/model/tool/retrieval 由来の値を trust profile で明示し、SystemContext 内へ入れる場合は delimiter と non-raw encoding を強制する。
- provider へ送った最終 text と s11tnext manifest を同じ request trace に保持する。
- source locale、translation coverage、fallback policy を明示し、既存の日本語/英語 prompt の言語を意図的に維持する。
- 移行後に legacy prompt builder と inline system message を残さない。
- s11tnext の DX、API、authoring、runtime、diagnostics、compatibility、auditability の弱点を実利用から発見し、改善 release を反復する。

## 完了条件

全面採用は、次をすべて満たした時だけ完了とする。

1. 型定義を除く `role: "system"` の content が、全経路で s11tnext invocation の `content.text` から渡される。
2. Codex provider adapter を含め、送信直前に自然言語 instruction を文字列結合で追加する経路がない。
3. `*SystemPrompt()`、`*SystemContext()`、system prompt 用文字列配列が `src/modules/system-context/` 以外に残らない。
4. user role、repair reminder、tool result reminder にある repository-authored instruction が棚卸しされ、catalog 移行または明示的な非対象理由を持つ。
5. すべての provider-bound render が `SystemContextInvocation` または `RequestAudit` と関連付けられる。
6. audit payload に runtime values や rendered text を保存せず、manifest と request correlation だけを保存する。
7. `.s11tnext/catalog.json` と `.s11tnext/catalog.generated.ts` が同時に生成・commit され、CI の `build --check` が通る。
8. 全 context が `ja-JP` と `en-US` の required locale coverage を満たす。
9. 現在日本語で送信している route は `ja-JP`、現在英語で送信している route は `en-US` を request し、移行だけで使用言語を変えない。
10. prompt parity、trust-boundary、artifact integrity、provider adapter、multi-round tool runtime、locale fallback、manifest correlation の test が通る。
11. legacy path を削除し、通常 runtime に長期的な dual-render / fallback flag を残さない。
12. s11tnext adoption finding が再現手順、影響、workaround、修正 version、ContextStill 再検証結果を持つ。

## 非目的

- s11tnext に LLM provider 呼び出し、retry、authorization、tool execution、output parser、DB persistence を移さない。
- provider の structured-output / tool-call schema を TOML へ全面移動しない。JSON Schema や TypeScript schema は引き続き code-owned contract とする。
- UI 文言、エラーメッセージ、ログ文言、監査画面の copy を s11tnext へ移さない。
- SystemContext 移行と同時に LLM route selection、model selection、queue scheduling、parser semantics を再設計しない。
- 一時的な互換 wrapper を恒久 API にしない。
- s11tnext の弱点を ContextStill 固有の複雑な workaround で覆い隠さない。

## 採用方針

### Version contract

- `s11tnext` と `s11tnext-cli` は同じ exact version に固定する。
- 初期 version は `0.1.0`。2026-07-24 に Runtime / CLI を exact `0.1.2` へ更新した。
- caret / tilde range は使用しない。
- s11tnext 側を修正した場合は、互換 fix は patch、breaking change は minor として両 package を同時 release する。
- upgrade 時は changelog 確認、exact version 同時更新、catalog 再生成、全 gate、canary の順で進める。

### Artifact contract

- source: `contexts/**/*.context.toml`
- config: `s11tnext.config.toml`
- generated output:
  - `.s11tnext/catalog.json`
  - `.s11tnext/catalog.generated.ts`
- 生成 2 files は必ず同じ commit で更新する。
- generated files は手編集しない。
- runtime は JSON を `unknown` として読み、生成された `createAppCatalog()` に渡す。
- catalog は process 内で一度だけ load / validate / freeze する。

### Locale contract

- catalog の source locale は `ja-JP` とする。
- development profile は移行中も `ja-JP` / `en-US` の両方を required にし、新規 context の translation debt を作らない。
- production profile も `ja-JP` / `en-US` を required にする。
- 現在英語の SystemContext は、同じ英語本文を `en-US` translation に移し、対応する `ja-JP` source を新規 authoring する。
- 現在日本語の SystemContext は `ja-JP` source を byte-level baseline とし、`en-US` translation を追加する。
- route ごとの initial instruction locale は registry で固定し、移行時に既存 provider behavior を変えない。
- locale の top-level user setting 化は別作業とし、本計画では route registry の明示設定までに留める。

### Trust contract

中央 profile は最低限次を持つ。

```toml
[variable_profiles."trusted.inline"]
type = "string"
trust = "trusted"
placement = "inline"
encoding = "raw"

[variable_profiles."trusted.number"]
type = "number"
trust = "trusted"
placement = "inline"
encoding = "json-value"

[variable_profiles."trusted.boolean"]
type = "boolean"
trust = "trusted"
placement = "inline"
encoding = "json-value"

[variable_profiles."trusted.json"]
type = "json"
trust = "trusted"
placement = "inline"
encoding = "json-value"

[variable_profiles."untrusted.text"]
type = "string"
trust = "untrusted"
placement = "delimited-context"
encoding = "json-string"

[variable_profiles."untrusted.json"]
type = "json"
trust = "untrusted"
placement = "delimited-context"
encoding = "json-value"
```

Classification:

- reviewed repository-authored fragments: `trusted`
- config 由来の numeric/boolean limit: `trusted`
- user input: `untrusted`
- model output: `untrusted`
- tool result: `untrusted`
- fetched/retrieved document: `untrusted`
- DB に保存された candidate/knowledge/episode body: origin に関係なく `untrusted`
- provider response: `untrusted`

`trusted` への変更は lint 回避手段として使わない。値の origin が不明なら `untrusted` に倒す。

### Section contract

各 `.context.toml` は可能な限り ordered `sections` を使い、manifest の `sectionIds` を意味のある監査情報にする。

Kinds:

- `instruction`: role、判断原則、禁止事項。
- `runtime-fact`: threshold、route mode、tool names などの runtime values。
- `tool-contract`: tool を呼ぶ条件、最大回数、結果の扱い。
- `output-contract`: JSON shape、Markdown shape、language/output restriction。
- `overlay`: source kind、response style、provider-specific supplement。

Severity:

- `must`: parser/security/safety/output shape に必要。
- `should`: quality preference。
- `may`: optional guidance。

Enforcement:

- `prompt`: prompt 文面だけで要求する。
- `schema`: provider structured output / tool schema が直接強制する。
- `host`: parser、validator、authorization、runtime code が強制する。

実際に host/schema enforcement がない section を `schema` / `host` と偽って分類しない。

## Target architecture

```text
contexts/**/*.context.toml
        │
        ▼
s11tnext-cli lint/build/check
        │
        ├── .s11tnext/catalog.json
        └── .s11tnext/catalog.generated.ts
                         │
                         ▼
src/modules/system-context/catalog.ts
  - load once
  - validate digest/integrity
  - freeze catalog
                         │
                         ▼
src/modules/system-context/system-context.service.ts
  - route -> key/locale
  - bind / bindRequest
  - invocation + request audit
                         │
                         ├── LlmChatRequest
                         └── DistillationModelRequest
                                  │
                                  ▼
                       provider / tool runtime
                                  │
                                  ▼
                       audit manifest correlation
```

### Runtime API

候補 contract:

```ts
export type SystemContextTrace = {
  finalManifest: SystemContextInvocation["manifest"];
  renderTrace?: RequestAudit["renderTrace"];
};

export type RenderedSystemContext = {
  text: string;
  trace: SystemContextTrace;
};

export function renderSystemContext<K extends SystemContextKey>(
  key: K,
  values: SystemContextValueMap[K],
  options?: { locale?: "ja-JP" | "en-US" },
): RenderedSystemContext;
```

Rules:

- provider-bound path は `bind()` または `bindRequest()` を使う。
- `bindText()` は manifest が不要と明示できる non-provider composition にだけ許可する。
- `createTextRenderer()` は top-level locale を呼び出しごとに読み直す必要が発生した時だけ使う。全面採用のためだけに無理に使わない。
- context key を無型の `string` として外部から受け取らない。
- provider へ送る直前に `trim()`、改行除去、文字列追加をしない。
- provider adapter が message framing を行う場合も、s11tnext の rendered text 自体は変更しない。
- Codex adapter の final instruction は catalog key として render し、adapter 内の hard-coded natural language を削除する。

### Request metadata

`LlmChatRequest` と `DistillationModelRequest` の application-owned metadata に `systemContextTrace` を追加する。provider HTTP body / SDK input へ metadata object 自体を送らない。

既存 provider adapter は known request fields だけを provider payload に変換し、trace を local audit/usage 層へ渡す。

Audit payload:

```json
{
  "contextKey": "coverEvidence.externalFinal",
  "catalogDigest": "sha256:...",
  "releaseDigest": "sha256:...",
  "definitionHash": "sha256:...",
  "artifactHash": "sha256:...",
  "renderedHash": "sha256:...",
  "requestedLocale": "ja-JP",
  "resolvedLocale": "ja-JP",
  "fallbackUsed": false,
  "sectionIds": ["role", "web-evidence-boundary", "output-contract"],
  "compilerVersion": "0.1.0",
  "releaseProfile": "production",
  "policyDigest": "sha256:..."
}
```

保存禁止:

- rendered text
- runtime variable values
- user input
- tool result
- model output 全文
- fetched content

## Context inventory と key plan

最終 key は source-relative path から生成する。移行中に命名を変え続けないため、Phase 0 で key map を固定する。

| Domain | Context key | 現在の主な source | 特性 |
|---|---|---|---|
| Provider health | `providerHealth.jsonOnly` | `llm/agentic-llm.service.ts` | static、2 sites 共用 |
| Provider adapter | `provider.codex.finalResponse` | `llm/providers/codex.provider.ts` | hidden provider envelope |
| Context compiler | `contextCompiler.agenticRefine` | `context-compiler/agentic-refine.service.ts` | untrusted goal、optional facet variants |
| Context compiler | `contextCompiler.plan` | `context-response-composer.service.ts` | static output contract |
| Context compiler | `contextCompiler.composeSkill` | 同上 | maxTokens、skill variant |
| Context compiler | `contextCompiler.composeNarrativeWithAvoid` | 同上 | headings、maxTokens |
| Context compiler | `contextCompiler.composeNarrativeWithoutAvoid` | 同上 | headings、maxTokens |
| Find candidate | `findCandidate.wiki` | `findCandidate/domain.ts` | source-kind variant |
| Find candidate | `findCandidate.vibeMemory` | 同上 | source-kind variant |
| Find candidate | `findCandidate.codexEscalation` | `findCandidate/codex-escalation.service.ts` | English route |
| Episode | `episodeDistiller.nearDuplicateReview` | `episodeDistiller/worker.ts` | static |
| Episode | `episodeDistiller.cardGeneration` | 同上 | static + output contract |
| Episode | `episodeDistiller.semanticChunkPlanner` | 同上 | static + output contract |
| Cover evidence | `coverEvidence.negativeEvaluation` | `coverNegativeEvidence/*` | current user prompt instruction を split |
| Cover evidence | `coverEvidence.applicabilityRefinement` | `coverEvidence/prompts.ts` | static |
| Cover evidence | `coverEvidence.valueAssessment` | 同上 | static |
| Cover evidence | `coverEvidence.externalSearchQuery` | 同上 | static |
| Cover evidence | `coverEvidence.externalFetchSelection` | 同上 | trusted number |
| Cover evidence | `coverEvidence.externalFinal` | 同上 | token budget、untrusted evidence boundary |
| Cover evidence | `coverEvidence.mcpEvidence` | 同上 | tool name set |
| Cover evidence | `coverEvidence.procedureRepair` | `procedure-repair.service.ts` | static |
| Source research | `sourceResearch.web` | `sources/web/source-research.service.ts` | tool contract |
| Context decision | `contextDecision.judge` | `context-decision.service.ts` | large English context |
| Context decision | `contextDecision.repair` | 同上 | static English repair |
| Context decision | `contextDecision.answer` | 同上 | large English context |
| Landscape | `landscape.deadZoneMergeReview` | `landscape/deadzone-merge-review-llm.ts` | static English context |

追加棚卸し対象:

- `src/modules/distillation/distillation-prompts.ts`
- `src/modules/distillation/procedure-system-context.ts`
- `src/modules/coverEvidence/helpers.ts`
- `blankResponseReminder`
- `requireToolCallReminder`
- `toolResultReminder`
- user prompt 内の role/output/tool instruction
- provider adapter が追加する instruction

未使用 builder は catalog へ機械的に移さず、call graph と test-only import を確認して削除する。再利用される共通 section は `bindRequest()` で最終 invocation に取り込む。

## 実装フェーズ

### Phase 0: Baseline と完全 inventory

1. `role: "system"` 23 sites を route、provider path、現在言語、builder、runtime values、test、audit path と紐付ける。
2. provider adapter が追加する自然言語 instruction を列挙する。
3. system 以外の message / reminder に含まれる author-authored instruction を列挙する。
4. `distillation-prompts.ts` など test-only / dead builder の call graph を確認する。
5. 各 active route について代表 input fixture と現在の rendered system text を保存する。
6. current prompt の hash、文字数、推定 token 数、末尾改行の有無を記録する。
7. current behavior baseline を route ごとに記録する。
   - parser success / failure
   - JSON shape compliance
   - tool-call compliance
   - blank response
   - no-candidate
   - fallback provider
   - input truncation
8. SystemContext inventory を machine-readable な fixture にし、移行状態を追跡する。

Acceptance:

- active / dead / provider-generated / reminder の分類が完了している。
- すべての active route が予定 context key を持つ。
- 全移行後に比較できる golden text と behavior baseline がある。

Failure handling:

- active か判断できない builder は削除せず、test と runtime call graph を追加確認する。
- runtime data と instruction の境界が不明な prompt は次 phase へ進めず、origin/trust を先に分類する。

### Phase 1: Package、config、artifact pipeline

1. `s11tnext@0.1.0` を exact dependency に追加する。
2. `s11tnext-cli@0.1.0` を exact devDependency に追加する。
3. `s11tnext.config.toml` を追加する。
4. keyspace owner と variable profiles を追加する。
5. development / production release profile に `ja-JP` と `en-US` を required 設定する。
6. scripts を追加する。

```json
{
  "s11tnext:lint": "s11tnext lint --release-profile development",
  "s11tnext:build": "s11tnext build --release-profile development",
  "s11tnext:check": "s11tnext build --check --release-profile development",
  "s11tnext:inspect:coverage": "s11tnext inspect --coverage --locale en-US --fallback-locale ja-JP --release-profile development --format json"
}
```

7. `.s11tnext/catalog.generated.ts` を `tsconfig.json` の include に追加する。
8. 最初の bootstrap context と generated pair を commit 対象にする。
9. `bun run verify` に `s11tnext:lint` と `s11tnext:check` を追加する。
10. package version 一致を CI で確認する。

Acceptance:

- fresh checkout + install から同じ catalog digest を生成できる。
- `build --check` は file を変更しない。
- TypeScript が生成 key/value types を認識する。
- stale artifact、missing translation、unsafe variable profile が CI failure になる。

### Phase 2: Catalog loader、typed facade、audit correlation

1. `src/modules/system-context/catalog.ts` を追加する。
2. generated `createAppCatalog()` で JSON を `unknown` から検証する。
3. process singleton として catalog を一度だけ生成する。
4. `system-context.service.ts` に typed render API を追加する。
5. route -> key / locale の registry を追加する。
6. `SystemContextTrace` を LLM application request metadata に追加する。
7. `runDistillationCompletion()` が trace を multi-round request で保持する。
8. existing coverEvidence audit payload に manifest を追加する。
9. existing domain audit がない provider call には `SYSTEM_CONTEXT_USED` event を追加する。
10. event は logical completion ごとに 1 件とし、tool round ごとの重複記録を避ける。
11. manifest と実際の system message text の `verifyRenderedHash()` を provider dispatch 直前に test/dev で検証する。

Acceptance:

- provider payload に trace metadata が混入しない。
- audit に content/runtime value を保存しない。
- Bedrock/OpenAI/Azure/Local/Codex の各 adapter で rendered text と manifest の相関を失わない。
- input budget 処理は system message を変更しない。
- Codex framing 後も、catalog text の hash と framing 追加部分の責務を区別できる。

### Phase 3: Static context pilot

次を最初に移す。

- `providerHealth.jsonOnly`
- `sourceResearch.web`
- `landscape.deadZoneMergeReview`
- `coverEvidence.externalSearchQuery`
- `coverEvidence.applicabilityRefinement`
- `coverEvidence.valueAssessment`
- `coverEvidence.procedureRepair`
- `episodeDistiller.nearDuplicateReview`
- `episodeDistiller.semanticChunkPlanner`

各 context で:

1. source と translation を同時に authoring する。
2. section id/kind/severity/enforcement を付ける。
3. legacy builder と catalog render の golden diff を確認する。
4. s11tnext が付与する最終 newline は provider へそのまま送る。
5. route 切替後に legacy builder を削除する。
6. route 単位 test と full typecheck を通す。

Acceptance:

- static prompt 本文が application code から消える。
- requested locale で既存言語を維持する。
- newline 以外の意図しない差分がない。
- output/parser behavior が baseline を満たす。

### Phase 4: Typed runtime variables と trust boundary

対象:

- `contextCompiler.agenticRefine`
- `coverEvidence.externalFetchSelection`
- `coverEvidence.externalFinal`
- `coverEvidence.mcpEvidence`
- `coverEvidence.negativeEvaluation`

1. number/boolean/internal tool names は trusted typed values とする。
2. goal、candidate、evidence、retrieved content を SystemContext に含める必要がある場合は untrusted profile を使う。
3. instruction と runtime evidence を同じ raw variable へまとめない。
4. optional values は空文字でごまかさず、variant key または section composition に分ける。
5. candidate/evidence を user message に維持できる経路では、SystemContext には policy だけを置き、runtime data は user message として分離する。
6. `coverNegativeEvidence` の巨大 user prompt は、policy/output contract を SystemContext へ移し、candidate title/body は untrusted user data に分ける。
7. delimiter closing tag、HTML/XML boundary、Unicode separator、cyclic JSON、sparse array、accessor object を attack fixture に含める。

Acceptance:

- missing/extra/type mismatch が s11tnext error になる。
- untrusted value を `raw` へ変更できない。
- delimiter breakout fixture が構造境界を閉じられない。
- manifest に runtime values が含まれない。
- parser success と tool behavior が baseline を下回らない。

### Phase 5: Variant selection と request composition

対象:

- `contextCompiler.composeSkill`
- `contextCompiler.composeNarrativeWithAvoid`
- `contextCompiler.composeNarrativeWithoutAvoid`
- `findCandidate.wiki`
- `findCandidate.vibeMemory`
- distillation common/source/type-specific context

Rules:

- branch condition は code に残す。
- branch が選ぶ自然言語は context key variant にする。
- arbitrary `extraLines` API は廃止し、有限 variant、typed overlay、または別 context composition に置き換える。
- common context を再利用する場合は `bindRequest()` で共通 fragment を render し、最後の `invoke()` が provider へ送る完全な text を返す。
- `finalize()` は request 内の最新 invocation にだけ行う。
- render trace は「呼び出した fragment」であり、最終 prompt に byte-for-byte 含まれた証明ではないことを test/documentation に明記する。

Acceptance:

- `sourceKind` / `responseStyle` の branch は readable な key selection になる。
- prompt 文面の array splice / conditional text construction が消える。
- common fragment と final invocation の manifest trace が残る。
- arbitrary instruction injection point が残らない。

### Phase 6: Complex domain migration

対象:

- `episodeDistiller.cardGeneration`
- `findCandidate.codexEscalation`
- `contextDecision.judge`
- `contextDecision.repair`
- `contextDecision.answer`
- remaining coverEvidence final/repair context

1. 大きな prompt を意味 section に分割する。
2. output JSON shape は `output-contract` section に分離する。
3. host parser/validator が強制する規則は `enforcement = "host"` とする。
4. current English route は `en-US` を bind して本文を維持する。
5. 日本語 source は翻訳として別途 authoring し、coverage を満たす。
6. ContextDecision では deterministic decision logic と natural-language judgment policy を混ぜない。
7. EpisodeDistiller では source segment / episode candidate data を user message または untrusted runtime fact として扱う。
8. provider-specific behavior 差を mock provider matrix で確認する。

Acceptance:

- large SystemContext が service/worker ファイルから消える。
- context key と route decision が 1 対 1 で追える。
- English/Japanese の response quality baseline を満たす。
- deterministic decision、parser、reliability gate の意味を変えない。

### Phase 7: Codex provider envelope と secondary instructions

1. `codex.provider.ts` の `[Instructions]` 以下の自然言語 suffix を `provider.codex.finalResponse` へ移す。
2. role labels と framing delimiter は provider protocol として code に残してよいが、自然言語 directive は残さない。
3. `blankResponseReminder`、`requireToolCallReminder`、`toolResultReminder` を棚卸しする。
4. output/behavior を指示する reminder は catalog key へ移す。
5. runtime result を構造化するだけの label は code-owned framing として理由を記録する。
6. user prompt 内に残る author-authored directive を移行または allowlist 化する。
7. allowlist には file、line-independent pattern、owner、理由、review date を必須にする。
8. tool JSON schema description は本計画では code-owned とするが、SystemContext と重複する narrative contract は削る。

Acceptance:

- provider adapter が caller の意図を hidden instruction で上書きしない。
- repair/reminder の文面変更も catalog digest と manifest で追跡できる。
- allowlist に「移行が面倒」という理由を許可しない。

### Phase 8: Boundary lint と legacy removal

`scripts/check-system-context-boundary.mjs` を追加する。

Check:

- `src/modules/system-context/` 以外の inline `role: "system"` content。
- `SystemPrompt` / `SystemContext` builder。
- provider adapter の instruction suffix。
- known message/reminder properties の長い自然言語 literal。
- catalog に存在しない inventory key。
- inventory にない catalog context。
- context route の locale 未指定。
- provider-bound request の trace 未指定。

既存 test が直接 prompt builder を import している場合は、typed catalog facade を通す test へ変更する。

Acceptance:

- boundary check が legacy literal を 1 行追加しただけで失敗する。
- active route count と catalog mapping count が一致する。
- dead prompt builder が削除される。
- long-term fallback/dual-render flag が削除される。

### Phase 9: Full locale、artifact、provider verification

1. `inspect --coverage` で `ja-JP` / `en-US` の direct coverage を確認する。
2. fallback behavior test を追加する。
3. missing locale が暗黙 fallback しないことを確認する。
4. catalog JSON の field/hash tamper test を追加する。
5. generated TS と JSON の片側だけを更新した failure test を追加する。
6. OpenAI/Azure/Bedrock/Local/Codex adapter の contract test を通す。
7. tool multi-round で system text/manifest が変わらないことを確認する。
8. renderedHash が実送信 text と一致することを確認する。
9. production profile build と canary runtime を実行する。

Acceptance:

- 全 context が direct locale coverage を持つ。
- fallback は明示された test だけで発生する。
- artifact tamper/stale pair は fail-closed。
- 全 provider adapter で correlation が維持される。

### Phase 10: 使用感評価と s11tnext 改善 loop

ContextStill 側に adoption finding ledger を置く。

候補:

```text
spec/docs/.archived/s11tnext-adoption-findings.md
```

Finding fields:

- id
- discoveredAt
- s11tnext version
- ContextStill route/context key
- category
  - authoring
  - CLI
  - generated types
  - runtime API
  - composition
  - locale
  - trust boundary
  - manifest/audit
  - diagnostics
  - Bun/Node compatibility
  - documentation
- severity
  - blocking
  - correctness
  - security
  - DX
  - documentation
- reproduction
- expected
- actual
- ContextStill impact
- temporary workaround
- upstream fix commit/version
- ContextStill revalidation result
- status

Loop:

1. ContextStill で reproduction を最小化する。
2. package defect か integration defect かを切り分ける。
3. package defect は s11tnext repository の failing test にする。
4. s11tnext を修正する。
5. version policy に従って release する。
6. ContextStill の両 package を exact 同時 upgrade する。
7. catalog を再生成する。
8. target route test、boundary test、full verify、canary を通す。
9. finding に結果を記録して close する。

Blocking finding は ContextStill 固有 workaround で先へ進まない。DX/documentation finding は migration を継続してよいが、ledger から消さない。

## 積極的に検証する s11tnext の弱点仮説

### Authoring / CLI

- context 数が増えた時に TOML の重複が大きくならないか。
- common section reuse が不十分で copy/paste drift を起こさないか。
- optional variable がないことで variant 爆発が起きないか。
- path-derived key rename が application code と audit continuity に与える影響が大きすぎないか。
- error code/message/file/path/line/column が修正に十分か。
- `inspect` が large catalog の日常 review に十分か。
- `build --check` の diff/原因表示が CI troubleshooting に十分か。
- source/translation の placeholder mismatch diagnostic が理解しやすいか。

### Generated types

- ContextStill の TypeScript 6 / bundler resolution / Bun で生成型が安定するか。
- large key union / value map が typecheck performance を悪化させないか。
- generated file の formatting が repository formatter と衝突しないか。
- JSON と generated TS の pair 更新が merge conflict を増やさないか。

### Runtime

- catalog load/clone/freeze/integrity validation の startup cost。
- large catalog の memory footprint。
- final newline 強制が既存 prompt parity と token usageへ与える影響。
- `bindRequest()` composition が自然で、最終 prompt と render trace の関係を誤解しないか。
- `bindText()` で manifest を失う API footgun。
- provider adapter が text を frame/transform した時の renderedHash の意味。
- runtime error の path と context key が production diagnosis に十分か。
- Bun と supported Node matrix の差。

### Trust boundary

- delimiter/encoding が actual prompt readability と model response qualityを悪化させないか。
- trusted/untrusted の authoring が developer に理解しやすいか。
- DB 保存済み data の origin 判定が一貫するか。
- nested JSON、large text、Unicode、boundary-like input の安全性。
- host authorization/tool enforcement と prompt-level trust boundary を混同しやすくないか。

### Locale

- catalog 単位の source locale が混在言語 prompt corpus に十分か。
- route ごとの instruction locale を application 側で管理する負担。
- translation review と source drift を検出する仕組みが十分か。
- fallback manifest が operational debugging に十分か。

### Audit / operations

- manifest fields だけで prompt version を十分に特定できるか。
- catalog digest と context release digest の使い分けが明確か。
- context rename 後の historical audit を追えるか。
- audit event の volume と retention。
- secret/redaction layer と manifest payload の相性。

## Test plan

### s11tnext contract tests

- catalog load success
- expected digest mismatch
- definition/artifact/release/catalog hash mismatch
- unknown artifact field
- unknown context key
- missing/extra runtime value
- string/number/boolean/json type mismatch
- invalid locale
- explicit fallback success
- implicit fallback failure
- immutable invocation/manifest
- rendered hash verification
- request finalize ordering
- request reuse after finalize failure

### Security fixtures

- `</S11TNEXT_DELIMITED_CONTEXT>` を含む user text
- `<`, `>`, `&`, U+2028, U+2029
- JSON object 内の boundary-like string
- cyclic JSON
- sparse array
- accessor property
- non-finite number
- prototype/null-prototype object
- huge untrusted evidence

### Prompt parity

- current golden と catalog render の diff
- required final newline の明示差分
- Japanese route の本文維持
- English route の本文維持
- section order
- output schema text
- tool rule text
- dynamic threshold
- variant selection

### Provider matrix

- OpenAI messages
- Azure OpenAI messages
- Bedrock system blocks
- Local OpenAI-compatible endpoint
- Codex flattened framing
- provider fallback
- multi-round tool calls
- input budget truncation
- cancellation / timeout

### Domain regression

- `context_compile` agentic refine / plan / compose
- `findCandidate` wiki / vibe memory / Codex escalation
- `coverEvidence` applicability / value / web / MCP / negative / repair
- `episodeDistiller` chunk / card / duplicate review
- `context_decision` judge / repair / answer
- dead-zone merge review
- web source research
- health checks

## Verification commands

移行中の focused gate:

```bash
bun run s11tnext:lint
bun run s11tnext:build
bun run s11tnext:check
bun run s11tnext:inspect:coverage
bunx vitest run test/system-context*.test.ts
bun run typecheck
```

Domain gate:

```bash
bunx vitest run test/agentic-refine.unit.test.ts
bunx vitest run test/context-response-composer.service.test.ts
bunx vitest run test/find-candidate.test.ts
bunx vitest run test/cover-evidence.test.ts
bunx vitest run test/cover-negative-evidence.test.ts
bunx vitest run test/episode-distiller-system-context.test.ts
bunx vitest run test/context-decision*.test.ts
bunx vitest run test/distillation-runtime.test.ts
bunx vitest run test/distillation-runtime.service.test.ts
bunx vitest run test/codex-provider.test.ts
bunx vitest run test/bedrock-provider.test.ts
```

Final gate:

```bash
bun run verify
bun run verify:sqlite
bun run verify:rust-daemon
```

Rust code が SystemContext manifest を保存・転送する変更を含む場合:

```bash
cargo test -p context-stilld
cargo clippy -p context-stilld --all-targets -- -D warnings
```

## Rollout

1. route 単位で legacy render と catalog render を test/shadow 比較する。
2. parity と trust test が通った route だけ provider input を catalog へ切り替える。
3. route 切替後、legacy builder を同じ change set で削除する。
4. domain test と audit manifest を確認する。
5. canary run で parser/tool/output quality を baseline と比較する。
6. regression がなければ次 route group へ進む。
7. 全 route 後に boundary lint allowlist をゼロまたは明示的非対象だけにする。
8. dual-render code を削除して production profile へ固定する。

## リスクと対策

- リスク: TOML へ移すだけで巨大 prompt の責務分離が改善しない。
  - 対策: ordered section と section metadata を必須にし、role/runtime/tool/output/overlay を分ける。
- リスク: variant key が増えすぎる。
  - 対策: optional value を空文字化する前に s11tnext finding として評価し、必要なら package の composition/optional contract を改善する。
- リスク: delimiter 導入で LLM output quality が変わる。
  - 対策: attack safety と behavior quality を別々に測り、unsafe raw へ戻さない。
- リスク: current English prompt を日本語 source 化する際に意味が変わる。
  - 対策: provider には既存 English translation を送り続け、source translation review を独立して行う。
- リスク: final newline や provider framing で renderedHash が実送信 text とずれる。
  - 対策: provider dispatch boundary で exact text を検証し、catalog render 後の mutation を禁止する。
- リスク: manifest audit が高 volume になる。
  - 対策: logical completion 単位で保存し、tool round ごとに重複させず、既存 retention を使う。
- リスク: catalog/generated pair の conflict。
  - 対策: source TOML を conflict resolution source とし、generated pair は再生成する。
- リスク: ContextStill workaround が s11tnext defect を固定化する。
  - 対策: blocking/correctness/security finding は package fix/release を先に行う。
- リスク: prompt migration と domain behavior change が混在する。
  - 対策: route selection/parser/business logic を同時変更せず、intentional trust-boundary差分を testで明示する。

## 停止条件

次の場合、対象 route の切替を止めて s11tnext または integration layer を修正する。

- untrusted runtime value を safe contract のまま表現できない。
- provider へ送信した text と `renderedHash` の一致を証明できない。
- artifact/generated pair の不整合を fail-closed にできない。
- requested locale と実際の送信言語が一致しない。
- parser success、tool-call compliance、decision consistency に重大回帰がある。
- catalog load failure が silent fallback して legacy prompt を使う。
- runtime values/rendered text が audit log に漏れる。
- provider adapter が catalog render 後に自然言語 instruction を追加する。
- boundary lint が active SystemContext の残存を検知する。
- s11tnext package version mismatch がある。

## 主な変更対象

新規:

- `s11tnext.config.toml`
- `contexts/**/*.context.toml`
- `.s11tnext/catalog.json`
- `.s11tnext/catalog.generated.ts`
- `src/modules/system-context/catalog.ts`
- `src/modules/system-context/system-context.service.ts`
- `src/modules/system-context/system-context-audit.ts`
- `src/modules/system-context/system-context-registry.ts`
- `scripts/check-system-context-boundary.mjs`
- `test/system-context-catalog.test.ts`
- `test/system-context-trust-boundary.test.ts`
- `test/system-context-provider-contract.test.ts`
- `test/episode-distiller-system-context.test.ts`
- `test/fixtures/system-context-baseline/*`
- `spec/docs/.archived/s11tnext-adoption-findings.md`

変更:

- `package.json`
- lockfile
- `tsconfig.json`
- `scripts/verify.mjs`
- `src/modules/llm/llm-provider.ts`
- `src/modules/llm/providers/*.provider.ts`
- `src/modules/distillation/types.ts`
- `src/modules/distillation/distillation-runtime.service.ts`
- inventory に列挙した各 domain service/worker/prompt file
- 関連 unit/integration tests

削除候補:

- migrated `*SystemPrompt()` builder
- `procedure-system-context.ts`
- dead/test-only distillation prompt builder
- provider adapter の hard-coded final instruction
- route migration 用 temporary dual-render helper

## 最終 acceptance checklist

- [x] active SystemContext inventory 100%
- [x] catalog mapping 100%
- [x] provider-bound manifest correlation 100%
- [x] `ja-JP` direct coverage 100%
- [x] `en-US` direct coverage 100%
- [x] boundary allowlist は空
- [x] package versions exact match
- [x] generated pair current
- [x] prompt parity reviewed
- [x] trust attack fixtures passed
- [x] provider matrix passed
- [x] domain regression passed
- [x] full verify passed
- [ ] canary behavior baseline passed
- [x] temporary fallback removed
- [x] adoption findings triaged
- [x] blocking findings closed
