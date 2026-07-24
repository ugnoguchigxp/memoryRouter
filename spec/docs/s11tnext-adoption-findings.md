# s11tnext Adoption Findings

ContextStill で `s11tnext` と `s11tnext-cli` を production profile で実利用した所見を記録する。初回評価は `0.1.0`、再評価は `0.1.2` で実施した。回避策を恒久化せず、package 側へ還元できる粒度で再現条件と改善案を残す。

## ContextStill implementation result

- production catalog: 25 contexts / 25 files
- required locale coverage: `ja-JP` / `en-US` ともに 100%
- application-owned direct `role: "system"` construction: 0
- legacy boundary allowlist: 0
- package versions: `s11tnext@0.1.2` / `s11tnext-cli@0.1.2` の exact match
- artifact: version 2、compiler `0.1.2`
- provider message: authored role、`messageRole`、`messageHash` を使用
- generated catalog、typecheck、lint、format、unit tests、Web build を含む `bun run verify`: pass

## Summary

| ID | 優先度 | 分類 | 状態 | 所見 |
|---|---:|---|---|---|
| S11N-001 | P1 | Runtime | Resolved in 0.1.2 | `trailingNewline` で provider framing に合わせられる |
| S11N-002 | P1 | Authoring | Resolved in 0.1.2 | optional variable と `omit_if_empty` が追加された |
| S11N-003 | P2 | Locale | Resolved in 0.1.2 | document / keyspace の source locale override が追加された |
| S11N-004 | P2 | TypeScript DX | Mitigated in 0.1.2 | composite project の明示的な設定例が追加された |
| S11N-005 | P2 | Generated output | Resolved in 0.1.2 | `generation.typescript_indent` が追加された |
| S11N-006 | P2 | Audit API | Mitigated in 0.1.2 | role-aware message hash と composition receipt が追加された |
| S11N-007 | P2 | Release docs | Resolved in 0.1.2 | npm 公開状態の説明が修正された |
| S11N-008 | P2 | CI | Resolved in 0.1.2 | 0.1.2 release commitのCI / Release workflowが成功した |
| S11N-009 | P3 | Runtime compatibility | Observe | Bun 1.3.14 で動作したが package engines / support policy は Node のみ |

## Findings

### S11N-001: 末尾改行と exact submission

`invocation.content.text` は常に改行で終わる。単独 system message では扱いやすいが、Codex provider のように複合 prompt の suffix として使うと既存 prompt に末尾改行が追加される。host が `trimEnd()` すると `renderedHash` が実際の送信断片と一致しなくなるため、ContextStill では改行を保持した。

改善案:

- render option または context-level policy として final newline を選択可能にする。
- あるいは `content.text` と別に composition-safe fragment API を提供する。
- hash contract の対象が fragment か final provider payload かを guide で明確にする。

0.1.2 再検証:

- `CatalogBinding.trailingNewline = false` を全 provider-bound binding に設定した。
- rendered hash と role-aware message hash の両方を送信メッセージ生成時に検証した。
- S11N-001 は解消。

### S11N-002: optional variable

`contextCompiler.agenticRefine` の `technologies`、`changeTypes`、`domains` は入力上 optional だが、生成される value map では全変数が必須になる。現在は空文字を渡すため、値がない場合も delimiter block が prompt に残る。

改善案:

- authoring contract に optional variable と section-level conditional rendering を追加する。
- 空文字を意味のある値と区別し、missing 時に section 全体を省略できるようにする。
- generated type を `name?: T` にしつつ、translation 間で条件構造が一致することを compiler が検証する。

0.1.2 再検証:

- `contextCompiler.agenticRefine` の任意 facet を `required = false` に変更した。
- `omit_if_empty = true` により空の delimiter block が描画されないことをテストした。
- S11N-002 は解消。

### S11N-003: catalog-global source locale

ContextStill の既存 prompt は route ごとに日本語と英語が混在する。source locale が project 全体で `ja-JP` のため、英語を正本として維持したい context でも `ja-JP` source と同一の `en-US` translation を重複記述した。

改善案:

- document 単位の `source_locale` override を許可する。
- keyspace 単位の source locale default を検討する。
- 同文 translation の重複を compiler が診断または参照可能にする。

0.1.2 再検証:

- 英語正本の keyspace と document に `source_locale = "en-US"` を設定した。
- route の既存言語を変えず、manifest の source locale を正しい値にできた。
- S11N-003 は解消。

### S11N-004: composite TypeScript project

生成された `.s11tnext/catalog.generated.ts` を source module から import すると、`composite: true` の TypeScript 6 project は `TS6307` を出した。`tsconfig.json` の `include` へ生成物を追加すると解消した。

改善案:

- getting started の TypeScript integration に composite project の設定例を追加する。
- `out_dir` を `src` 配下へ置く選択肢と repository root に置く選択肢の trade-off を記載する。
- CLI が tsconfig を検出した場合に actionable hint を出す。

0.1.2 再検証:

- composite project 向けの `include` 設定例が公式 guide に追加された。
- host側の明示設定自体は必要なため、状態は Mitigated とする。

### S11N-005: generated formatting

生成 TS は tab indent で、ContextStill は Biome の space indent を使う。generated file を formatter 対象にすると毎回差分が生じるため、`.s11tnext/**` を formatter/linter 対象外にした。

改善案:

- generated output を formatter-neutral な最小形式にする。
- indent style option、または host formatter を通しても `build --check` が壊れない contract を提供する。
- guide で generated directory の formatter ignore を案内する。

0.1.2 再検証:

- `generation.typescript_indent = 2` を設定し、生成TSがContextStillのformatter規約と一致した。
- S11N-005 は解消。

### S11N-006: request trace と送信証明

`bindRequest().finalize()` の trace が包含証明ではない点は API documentation に明記されており正しい。ただし production audit では provider 成功境界で manifest を別途保存する必要がある。ContextStill は request metadata に manifest を載せ、provider routing 成功後に `SYSTEM_CONTEXT_SUBMITTED` を記録する実装を追加した。

改善案:

- provider adapter 向けに exact submitted text/hash を検証する helper を提供する。
-複数 fragment から final payload digest を作る composition receipt contract を検討する。
- `bindText()` が manifest を失うことを型/API名でさらに目立たせる。

0.1.2 再検証:

- manifest に `messageRole` と `messageHash` が追加され、host側でroleと本文の組を検証可能になった。
- `bindRequest().finalize()` にbyte-range composition receiptが追加された。
- 外部providerへのdelivery証明は引き続きhost責務であるため、状態は Mitigated とする。

### S11N-007: 公開状態と README

npm から 0.1.0 を導入できる一方、両 package の同梱 README は「npm registry では未公開」と記載している。

改善案:

- publish 前 check で README の prerelease marker を検出する。
- registry install command を現在形へ更新する。

0.1.2 再検証:

- npm公開済みであることとregistry確認手順が公式documentへ反映された。
- S11N-007 は解消。

### S11N-008: coverage CI

package 調査時点では通常 test、build、package matrix は成功したが coverage job が失敗していた。全面採用では package release の green CI が更新判断に直結する。

改善案:

- critical coverage failure を release blocking にするか、期待値を現状へ校正する。
- badge または release checklist で package と CLI の検証状態を見えるようにする。

0.1.2 再検証:

- release commit `c9e9341` のCI workflowとRelease workflowが成功していることを確認した。
- S11N-008 は解消。

### S11N-009: Bun support

ContextStill の Bun 1.3.14 では lint、build、check、runtime render が動作した。ただし package の engines と README は Node 20.19/22/24 のみを support 対象としている。

改善案:

- Bun を正式 support しない場合も「動作するが未保証」と明記する。
- 正式 support する場合は CI matrix と compatibility policy に Bun を追加する。

0.1.2 再検証:

- Bunはdogfooding環境であり正式support対象外であることが明記された。
- ContextStillのBun 1.3.14では、lint、build、artifact v2 load、render、全verifyが成功した。
