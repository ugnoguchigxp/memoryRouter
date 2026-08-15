# Rust Test Coverage 改善計画

> アーカイブ日: 2026-08-15。coverage 数値目標は概ね達成済みで、残る regression test 方針を [Rust Runtime Closeout Implementation Plan](../rust-runtime-closeout-implementation-plan.md) に統合した。

## 背景

`context-stilld` の Rust 実装は、daemon / queue / MCP native handler への責務移行が進んでいる。queue lifecycle 周辺はテストが増えている一方、MCP native handler や一部 service module には未カバー領域が残っている。

この計画は、安価な LLM 実行者へ渡しても安全に進められるよう、カバレッジ改善の対象、順序、禁止事項、検証方法を固定する。

## 現状ベースライン

取得日: 2026-06-23

実行コマンド:

```bash
cargo llvm-cov -p context-stilld --summary-only
```

結果:

| 指標 | 現状 |
|---|---:|
| Rust unit tests | 85 passed |
| Total line coverage | 64.39% |
| Total region coverage | 58.27% |
| Total function coverage | 52.27% |

重要 module の line coverage:

| File | Line coverage | 判断 |
|---|---:|---|
| `domains/queue_lifecycle/claim.rs` | 94.14% | 維持対象 |
| `domains/queue_lifecycle/episode_executor.rs` | 81.12% | 維持しつつ不足 edge case を追加 |
| `domains/queue_lifecycle/executor.rs` | 79.82% | 80% 前後を維持 |
| `domains/queue_lifecycle/inspect.rs` | 93.43% | 維持対象 |
| `domains/queue_lifecycle/provider_lease.rs` | 80.37% | 維持しつつ lease edge case を追加 |
| `domains/queue_lifecycle/state.rs` | 92.02% | 維持対象 |
| `domains/mcp_lifecycle/native_episodes.rs` | 0.00% | 優先改善対象 |
| `domains/mcp_lifecycle/native_knowledge.rs` | 0.00% | 優先改善対象 |
| `domains/mcp_lifecycle/native_memory.rs` | 0.00% | 優先改善対象 |
| `domains/mcp_lifecycle/native_decision.rs` | 0.00% | 優先改善対象 |
| `domains/mcp_lifecycle/native_resources.rs` | 0.00% | 優先改善対象 |
| `domains/mcp_lifecycle/native_handlers.rs` | 0.00% | 優先改善対象 |
| `domains/mcp_lifecycle/native_tools.rs` | 5.59% | 優先改善対象 |
| `domains/mcp_lifecycle/endpoint_server.rs` | 23.13% | 中優先 |
| `domains/admin_api_lifecycle/service.rs` | 9.04% | 中優先 |
| `domains/backup/service.rs` | 37.14% | 中優先 |
| `domains/shared/process.rs` | 46.04% | 中優先 |

## 方針

全体 80% を即時の hard gate にしない。Rust では line coverage の数値だけを品質指標にしないため、まずは重要な状態遷移、DB contract、error path、handler response contract を増やす。

当面の目標:

- `queue_lifecycle` は 80% 以上の line coverage を維持する。
- `mcp_lifecycle/native_*` は 0% module をなくす。
- `context-stilld` 全体は 64.39% から 70% 台へ上げる。
- coverage 向上のためだけに本番ロジックを変えない。
- live daemon、live SQLite、live LLM、network に依存しない unit tests を優先する。

## 実行者への絶対ルール

- 変更前に必ず baseline を取る。
- 1 回の PR / 作業単位で対象 module を広げすぎない。
- 本番コードの意味を coverage のために変えない。
- live app data DB を使わない。テストは temporary SQLite か in-memory fixture を使う。
- live LLM、HTTP provider、LaunchAgent、実 daemon 起動を unit coverage 改善の前提にしない。
- `#[ignore]` で失敗するテストを隠さない。
- flaky な sleep / wall clock 待ちを追加しない。
- 既存の test helper がある場合は再利用する。
- 大きな refactor はしない。必要な場合は、テスト可能にするための小さな helper 抽出だけにする。
- 失敗した検証を未解決のまま完了扱いにしない。

## 共通コマンド

初回セットアップ確認:

```bash
cargo llvm-cov --version
```

入っていない場合:

```bash
cargo install cargo-llvm-cov
```

baseline:

```bash
cargo llvm-cov -p context-stilld --summary-only
```

HTML report:

```bash
cargo llvm-cov -p context-stilld --html --output-dir target/llvm-cov/html
```

特定 module のテスト:

```bash
cargo test -p context-stilld native_episodes -- --nocapture
cargo test -p context-stilld native_memory -- --nocapture
cargo test -p context-stilld queue_lifecycle -- --nocapture
```

全 Rust test:

```bash
cargo test -p context-stilld
```

repo verification:

```bash
bun run verify:rust-daemon
bun run verify
git diff --check
```

docs を変更した場合:

```bash
bun run docs:check-links
```

## P0: Coverage Script と Baseline 記録

Goal:
実行者が毎回同じ測定をできるようにする。

対象:

- `package.json`
- `spec/docs/rust-test-coverage-improvement-plan.md`

Tasks:

- `package.json` に Rust coverage 用 script を追加する。
- script 名は既存 style に合わせる。
- 推奨 script:

```json
{
  "coverage:rust": "cargo llvm-cov -p context-stilld --summary-only",
  "coverage:rust:html": "cargo llvm-cov -p context-stilld --html --output-dir target/llvm-cov/html"
}
```

Completion criteria:

- `bun run coverage:rust` で summary が出る。
- `bun run coverage:rust:html` で HTML report が生成される。
- baseline の数値を作業メモまたは PR description に残す。

Verification:

```bash
bun run coverage:rust
bun run coverage:rust:html
git diff --check
```

Stop conditions:

- `cargo llvm-cov` が未インストールで、実行者が install できない。
- coverage command が test failure 以外の理由で安定して完了しない。

## P1: `native_episodes` の Unit Tests

Goal:
`domains/mcp_lifecycle/native_episodes.rs` を 0% から脱出させ、EpisodeCard の read/search contract を固定する。

対象:

- `crates/context-stilld/src/domains/mcp_lifecycle/native_episodes.rs`

優先して追加する tests:

- 空 DB または対象 table がない場合、panic せず error payload または空結果を返す。
- `search_episodes` が `limit` を尊重する。
- `search_episodes` が `query` に一致する Episode だけを返す。
- `search_episodes` が `status` / `repoPath` / `technologies` などの filter を尊重する。
- `fetch_episode` が存在する id を full payload と refs つきで返す。
- `fetch_episode` が存在しない id に対して stable error / not found payload を返す。
- `episode_search_text` 相当の検索対象に title、situation、lesson、refs が含まれることを固定する。

実装指示:

- temporary SQLite connection を作り、必要最小限の schema と rows だけを入れる。
- live `episode_cards` を読まない。
- 既存の `NativeToolContext` 作成 pattern があればそれに合わせる。
- private helper を直接テストしたい場合は同一 file の `#[cfg(test)] mod tests` に追加する。

Completion criteria:

- `native_episodes.rs` の line coverage が 0% ではなくなる。
- happy path と not found/error path の両方がある。
- refs 付き payload の schema が固定される。

Verification:

```bash
cargo test -p context-stilld native_episodes -- --nocapture
cargo llvm-cov -p context-stilld --summary-only
```

## P2: `native_memory` の Unit Tests

Goal:
`domains/mcp_lifecycle/native_memory.rs` の search/fetch contract を固定する。

対象:

- `crates/context-stilld/src/domains/mcp_lifecycle/native_memory.rs`

優先して追加する tests:

- `search_memory` が query に一致する memory を返す。
- `search_memory` が `limit` と preview 長を尊重する。
- `search_memory` が `includeContent=false` のとき preview/body を過剰に返さない。
- `fetch_memory` が `start` / `end` / `maxChars` を尊重する。
- `fetch_memory` が `returnMetaOnly=true` のとき本文を返さない。
- `fetch_memory` が `includeAgentDiffs=true` のとき関連 diff を含める。
- 存在しない id は stable error / not found payload を返す。

実装指示:

- temporary SQLite に memory row と diff row を最小件数だけ入れる。
- 文字数境界の test は ASCII で作る。Unicode 境界は既存仕様がなければ追加しない。
- coverage のために truncation 仕様を変えない。

Completion criteria:

- happy path、limit、range、not found がテストされる。
- body と metadata の返却境界が固定される。

Verification:

```bash
cargo test -p context-stilld native_memory -- --nocapture
cargo llvm-cov -p context-stilld --summary-only
```

## P3: `native_knowledge` の Read Path Tests

Goal:
`search_knowledge` の filter / source refs / status contract を固定する。register 系の write path は次フェーズへ分ける。

対象:

- `crates/context-stilld/src/domains/mcp_lifecycle/native_knowledge.rs`

優先して追加する tests:

- `search_knowledge` が `query`、`statuses`、`technologies`、`changeTypes`、`domains` を尊重する。
- default status filter が期待通りに働く。
- `source_refs` が関連 refs を stable order で返す。
- JSON array column の parse failure が panic にならない。
- `selected_support_knowledge_ids` が Decision evidence から support knowledge id を拾う。

実装指示:

- まず read-only helper と `search_knowledge` に限定する。
- `register_candidates`、`context_decision_feedback` は write path なので P4 まで触らない。
- schema fixture は必要最小限にする。

Completion criteria:

- read path の主要 filter が固定される。
- malformed JSON でも panic しないことが確認される。

Verification:

```bash
cargo test -p context-stilld native_knowledge -- --nocapture
cargo llvm-cov -p context-stilld --summary-only
```

## P4: `register_candidates` と Decision Feedback Tests

Goal:
Knowledge write path の validation と persistence contract を固定する。

対象:

- `crates/context-stilld/src/domains/mcp_lifecycle/native_knowledge.rs`
- `crates/context-stilld/src/domains/mcp_lifecycle/native_decision.rs`

優先して追加する tests:

- `register_candidates` が valid SKILL-like candidate を insert する。
- `register_candidates` が required fields 不足を reject する。
- `register_candidates` が invalid polarity / type / status を reject する。
- `infer_title` が body 先頭から安定した title を作る。
- `has_skill_like_sections` が `Use when` / `Workflow` / `Verification` / `Avoid` を判定する。
- `context_decision_feedback` が known decision id に feedback を保存する。
- unknown decision id は stable error を返す。

実装指示:

- DB write は temporary SQLite transaction 内で完結させる。
- validation を弱めて test を通さない。
- user-facing message の全文一致は避け、stable field と category を検証する。

Completion criteria:

- valid insert と invalid reject の両方がある。
- write path が live DB に触らない。

Verification:

```bash
cargo test -p context-stilld register_candidates -- --nocapture
cargo test -p context-stilld native_decision -- --nocapture
cargo llvm-cov -p context-stilld --summary-only
```

## P5: `native_decision` の Decision Gate Tests

Goal:
`context_decision` の autonomous GO/NO-GO contract を unit test で固定する。

対象:

- `crates/context-stilld/src/domains/mcp_lifecycle/native_decision.rs`

優先して追加する tests:

- 明確な hard stop language がある場合は `reject` になる。
- 十分な supporting knowledge がある場合は `execute` または `revise_and_execute` になる。
- evidence が弱い場合は confidence / coverage が低くなる。
- `decision_query` が `decisionPoint` と `retrievalHints` を含む。
- `mandate` が decision ごとに stable な説明を返す。
- decision run、evidence、coverage trace が transaction 内で保存される。

実装指示:

- LLM call を追加しない。
- scoring の厳密な数値固定より、decision category、persisted row、主要 field を検証する。
- prompt wording の全文一致を避ける。

Completion criteria:

- reject / execute / revise 系の代表 path が固定される。
- persistence tables への write が確認される。

Verification:

```bash
cargo test -p context-stilld native_decision -- --nocapture
cargo llvm-cov -p context-stilld --summary-only
```

## P6: `native_resources` / `native_tools` / `native_handlers`

Goal:
MCP native surface の tool/resource inventory と dispatch contract を固定する。

対象:

- `crates/context-stilld/src/domains/mcp_lifecycle/native_resources.rs`
- `crates/context-stilld/src/domains/mcp_lifecycle/native_tools.rs`
- `crates/context-stilld/src/domains/mcp_lifecycle/native_handlers.rs`

優先して追加する tests:

- `list_resources` が expected URI を返す。
- `read_resource` が known URI を content payload として返す。
- unknown resource URI が stable error を返す。
- `exposed_tool_count` と `tool_owner_inventory` が主要 tool を含む。
- `handle_native_dispatch` が known tool を正しい handler へ渡す。
- unknown tool が stable error を返す。
- `initial_instructions` が空でない guidance を返す。

実装指示:

- handler の中で別 module の詳細まで再検証しない。dispatch されたことだけを見る。
- resource snapshot は temporary SQLite に最小 row を置いて確認する。
- locale や環境変数で変わる文字列は全文一致しない。

Completion criteria:

- MCP native inventory の退行が test で検出できる。
- unknown tool/resource の error contract が固定される。

Verification:

```bash
cargo test -p context-stilld native_resources -- --nocapture
cargo test -p context-stilld native_tools -- --nocapture
cargo test -p context-stilld native_handlers -- --nocapture
cargo llvm-cov -p context-stilld --summary-only
```

## P7: Low-Risk Service Modules

Goal:
小さく閉じた service/routing module の error path を埋め、全体 coverage を底上げする。

対象候補:

- `crates/context-stilld/src/domains/admin_api_lifecycle/service.rs`
- `crates/context-stilld/src/domains/backup/service.rs`
- `crates/context-stilld/src/domains/bootstrap/service.rs`
- `crates/context-stilld/src/domains/doctor/service.rs`
- `crates/context-stilld/src/shared/config.rs`
- `crates/context-stilld/src/shared/fs_paths.rs`
- `crates/context-stilld/src/shared/process.rs`

優先して追加する tests:

- missing file / missing directory の error handling。
- invalid env var / override の handling。
- JSON report の stable fields。
- process supervisor の failure path。
- preflight が live writer を検出した場合の response。

実装指示:

- OS process を本当に長時間起動しない。
- filesystem は temporary directory を使う。
- macOS LaunchAgent の実状態には依存しない。

Completion criteria:

- 各 module に happy path と代表 error path がある。
- test が local machine 状態に依存しない。

Verification:

```bash
cargo test -p context-stilld admin_api backup bootstrap doctor shared -- --nocapture
cargo llvm-cov -p context-stilld --summary-only
```

## P8: Queue Lifecycle の維持テスト

Goal:
すでに高い coverage の queue lifecycle を維持し、EpisodeDistiller 逐次生成の退行を防ぐ。

対象:

- `crates/context-stilld/src/domains/queue_lifecycle/episode_executor.rs`
- `crates/context-stilld/src/domains/queue_lifecycle/executor.rs`
- `crates/context-stilld/src/domains/queue_lifecycle/provider_lease.rs`
- `crates/context-stilld/src/domains/queue_lifecycle/inspect.rs`

追加する場合の test 候補:

- provider 503 は pending 継続で attempt increment しない。
- permanent provider error は retry metadata を残す。
- saved segment metadata がある job は保存済み segment を再処理しない。
- `queue inspect --json` の output watchdog が latest episode / segment progress を使う。
- unsupported queue は fail-closed になる。

実装指示:

- ここはすでに coverage が高いため、数値目的で薄い test を増やさない。
- bug fix や仕様追加に連動する test だけを追加する。

Completion criteria:

- `queue_lifecycle` の line coverage が 80% 未満へ落ちない。
- EpisodeDistiller 逐次生成の core contract が維持される。

Verification:

```bash
cargo test -p context-stilld queue_lifecycle -- --nocapture
cargo llvm-cov -p context-stilld --summary-only
```

## 完了条件

短期完了条件:

- `cargo test -p context-stilld` が通る。
- `cargo llvm-cov -p context-stilld --summary-only` が通る。
- `mcp_lifecycle/native_*` の 0% module が少なくとも 3 つ以上なくなる。
- `queue_lifecycle` の line coverage が 80% 以上を維持する。
- 全体 line coverage が baseline 64.39% から上がる。

中期完了条件:

- 全体 line coverage が 70% 以上になる。
- `native_episodes`、`native_memory`、`native_resources`、`native_tools` がそれぞれ 50% 以上になる。
- `native_knowledge`、`native_decision` は read path / write path の代表 contract がテストされる。

まだ目指さない条件:

- 全体 80% を hard gate にする。
- branch coverage を gate にする。
- live LLM / live daemon / LaunchAgent 依存の coverage を unit test に混ぜる。

## 作業単位の推奨順序

1. P0 coverage script を追加する。
2. P1 `native_episodes` を実装し、coverage を比較する。
3. P2 `native_memory` を実装し、coverage を比較する。
4. P6 `native_resources` / `native_tools` の inventory tests を追加する。
5. P3 `native_knowledge` read path を追加する。
6. P4/P5 の write path / decision path を小さく分割して追加する。
7. P7 の service modules を小さな PR 単位で追加する。
8. P8 は regression が見つかった場合だけ追加する。

## 作業ごとの報告テンプレート

各作業後に、実行者は次を報告する。

```text
対象:
- 変更した module:
- 追加した tests:

検証:
- cargo test -p context-stilld ...: pass/fail
- cargo llvm-cov -p context-stilld --summary-only: pass/fail
- bun run verify:rust-daemon: pass/fail, 実行しない場合は理由
- git diff --check: pass/fail

coverage:
- before total line:
- after total line:
- 対象 file before:
- 対象 file after:

未対応:
- 残した edge case:
- 次に触るべき module:
```

## 停止条件

次の場合は実装を進めず、原因調査または人間確認に戻す。

- baseline coverage が取得できない。
- 対象 module の schema / context fixture が分からず、live DB を使いたくなる。
- test を通すために本番ロジックの意味変更が必要になる。
- live LLM、network、LaunchAgent がないと test できない設計になっている。
- 追加 test が flaky になる。
- `cargo test -p context-stilld` が失敗する。
- `cargo llvm-cov -p context-stilld --summary-only` が失敗する。
- coverage は上がったが、behavior contract を何も固定していない。
