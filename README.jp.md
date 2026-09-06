<p align="center">
  <strong>context-still</strong><br/>
  <em>AI コーディングエージェントのための local-first knowledge control plane</em>
</p>

<p align="center">
  <a href="https://github.com/ugnoguchigxp/contextStill/actions/workflows/verify.yml"><img alt="verify" src="https://github.com/ugnoguchigxp/contextStill/actions/workflows/verify.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="#目次">目次</a> ·
  <a href="#デスクトップクイックスタート">デスクトップクイックスタート</a> ·
  <a href="#mcp-integration">MCP Integration</a> ·
  <a href="#ドキュメント">ドキュメント</a> ·
  <a href="#開発">開発</a> ·
  <a href="README.md">English</a>
</p>

---

## context-still とは

context-still は、AI コーディングエージェントの記憶を扱う local-first な control plane です。Wiki / docs、Web research、agent log、明示的に登録された candidate note から再利用可能な `rule` / `procedure` knowledge を作り、タスクごとに必要な context pack を MCP、CLI、API、管理 UI から取得できるようにします。

既定の product path は desktop / local です。

- storage: ローカル app data 配下の SQLite
- UI: local admin / control-plane 体験。Tauri packaging を desktop target として扱う
- daemon: `context-stilld run` がSQLiteの書き込み、MCP、キュー、ログ同期を所有する
- MCP: ユーザーが有効化する任意の streamable HTTP agent integration
- model usage: minimal local usage を先に成立させ、local LLM / cloud-assisted mode は任意の拡張にする

基本ループは次の通りです。

```text
evidence を集める -> knowledge に蒸留する -> task context を compile する -> 有用性を評価する -> 新しい学びを candidate 登録する
```

主な機能:

- source link と candidate review を持つ evidence-backed knowledge distillation
- `initial_instructions`、`context_compile`、`compile_eval`、`context_decision`、knowledge / memory / episode search、candidate 登録の MCP tools
- primary knowledge / search / context compile path 用の SQLite local storage
- Codex、Antigravity、Claude log の同期
- queue worker による staged distillation と health diagnostics
- graph、replay、review item、approval-gated candidate を扱う Knowledge Landscape
- 自律判断の execute / escalate、Knowledge evidence、coverage trace、feedback を保存する Decision 履歴

context-still は hosted SaaS ではありません。DB、source、settings、API/admin runtime、automation worker、MCP registration は自分の環境で管理します。

## 目次

- [context-still とは](#context-still-とは)
- [デスクトップクイックスタート](#デスクトップクイックスタート)
- [Product Modes](#product-modes)
- [Runtime Boundary](#runtime-boundary)
- [MCP Integration](#mcp-integration)
- [Advanced Server Backend](#advanced-server-backend)
- [よく使うワークフロー](#よく使うワークフロー)
- [ドキュメント](#ドキュメント)
- [開発](#開発)
- [コントリビュート](#コントリビュート)
- [License](#license)

## デスクトップクイックスタート

Bun 1.3.14、Git、stable Rust（CargoとCコンパイラ）が必要です。

```bash
git clone https://github.com/ugnoguchigxp/contextStill.git
cd contextStill
bun install --frozen-lockfile
```

1つ目のターミナルで専用の保存先を設定し、常駐プロセスを起動します。初回はキュー処理と個人ログの取り込みを無効にしています。

```bash
export CONTEXT_STILL_APP_DATA_DIR="$PWD/data/local"
export CONTEXT_STILL_SQLITE_CORE_PATH="$CONTEXT_STILL_APP_DATA_DIR/context-still-core.sqlite"
export CONTEXT_STILL_DB_BACKEND=sqlite
export CONTEXT_STILL_SOURCE_CONTENT_ROOT="$CONTEXT_STILL_APP_DATA_DIR/wiki"
export CONTEXT_STILL_EMBEDDING_PROVIDER=disabled
cargo build --locked -p context-stilld
./target/debug/context-stilld bootstrap init --json
CONTEXT_STILL_RESIDENT_QUEUE=0 CONTEXT_STILL_RESIDENT_AGENT_LOG_SYNC=0 \
  ./target/debug/context-stilld run
```

2つ目のターミナルで同じリポジトリを開き、同じ保存先を指定します。

```bash
export CONTEXT_STILL_APP_DATA_DIR="$PWD/data/local"
export CONTEXT_STILL_SQLITE_CORE_PATH="$CONTEXT_STILL_APP_DATA_DIR/context-still-core.sqlite"
export CONTEXT_STILL_DB_BACKEND=sqlite
export CONTEXT_STILL_SOURCE_CONTENT_ROOT="$CONTEXT_STILL_APP_DATA_DIR/wiki"
export CONTEXT_STILL_EMBEDDING_PROVIDER=disabled
./target/debug/context-stilld bootstrap preflight --json
bun run compile --goal "understand this repository's development workflow" \
  --repo-path "$PWD" --change-types docs,plan --domains onboarding,workflow --json
bun run dev
```

http://localhost:39171 を開きます。知識が未登録なら、最初のcompile結果が空になるのは正常です。リポジトリを対象にするときは `--repo-path`、共通知識だけを対象にするときは `--global` を指定します。

外部モデルを使わない場合は、知識を登録する前に **Settings → taskRouting → agenticCompile.runtime** の **enabled** をオフにして保存してください。上記の設定では埋め込みも無効です。独自の管理APIキーを設定している場合はログイン画面に入力します。

`bootstrap init` はディレクトリを作成し、`run` がDBの初期化・移行と書き込みを担当します。`mcp start` 単独では書き込みサービスが起動しません。MCPクライアントへの登録は任意です。終了時は1つ目のターミナルでCtrl+Cを押します。

一時ディレクトリで、初回compile、保存した知識の検索、障害からの復帰、バックアップ検証・復元を確認できます。

```bash
bun run verify:onboarding
```

Tauriのパッケージ化までは、このローカル環境を使ってください。対話型の `startup` はadvanced server向けです。

## Product Modes

| Mode | 目的 | 必須セットアップ |
|---|---|---|
| `minimal` | SQLite + local sources + manual/MCP candidates + context compile | Bun と local SQLite path |
| `cloud-review` | cloud LLM assisted distillation、review、decision support | provider credentials と route settings |
| `local-llm` | local LLM / local embedding assisted distillation | local OpenAI-compatible endpoint や embedding service |

Minimal mode は、外部 LLM、外部 search API、MCP client registration がなくても使える状態を維持します。

## Runtime Boundary

context-still は、常駐 runtime と管理 UI surface を分けて扱います。

| Surface | 既定の lifetime | 責務 |
|---|---|---|
| Daemon / worker runtime | UI とは独立して常駐 | MCP endpoint supervision、CLI commands、queue scheduling/maintenance、agent-log sync scheduling、automation、doctor、backup、bootstrap、process supervision、runtime sidecar visibility |
| Hono API | 管理 UI が HTTP access を必要とする時に起動 | knowledge、sources、graph、queue controls、settings、context runs、decision history、dashboards の admin UI facade |
| Tauri / web UI | 必要時に開く | knowledge maintenance、review、settings、diagnostics、operator actions |

Hono API は UI 向け facade に留めます。継続的な background work と外部 agent integration は daemon / CLI / MCP 側の責務なので、UI を閉じても log sync scheduling、queue supervision、MCP availability、scheduled maintenance が止まる前提にはしません。現時点の Rust daemon は resident owner です。MCP endpoint/session manager、exposed MCP tool handlers、queue scheduling/maintenance、agent-log-sync parser/write path は Rust owner です。TypeScript/Bun は UI-time Hono と明示的な operator CLI 用に残し、resident daemon dependency にはしません。

## MCP Integration

起動済みの常駐プロセスのMCP endpointを確認:

```bash
cargo run -q -p context-stilld -- mcp endpoint --json
```

MCP client には次のように登録します。

```json
{
  "mcpServers": {
    "context-still": {
      "url": "http://127.0.0.1:39172/mcp",
      "enabled": true
    }
  }
}
```

`bun run setup:mcp-config` は Codex と Antigravity にこの URL 方式の登録を書き込みます。古い direct stdio MCP server と TypeScript MCP HTTP worker は削除済みで、新規 client registration として復元しません。endpoint と exposed tool handlers は `context-stilld` が所有します。

接続後は、project session 開始時に `initial_instructions` を一度だけ呼びます。作業前に `context_compile`、ユーザーへ質問する前や PR 作成前に自律継続できる余地がある場合は `context_decision`、作業後に `compile_eval` を使います。永続化したい知見は `register_candidates` で登録し、negative guardrail は `polarity: "negative"` と明示的な `technologies` / `changeTypes` / `domains` を指定します。

MCP は agent integration surface です。local app を開くことや既存 knowledge を確認することの隠れた必須条件ではありません。

## Advanced Server Backend

PostgreSQL / pgvector backend は legacy compatibility code です。完了ゲートとしてはメンテナンスせず、既定の desktop / local path には不要です。

明示的に server backend をテスト・運用する場合だけ使います。

```bash
docker compose up -d
cp .env.example .env
bun run db:migrate
```

server backend の制約は [Architecture Overview](spec/docs/pub/architecture.md) と [Operations](spec/docs/pub/operations.md) に記載しています。server productization、auth、multi-user operation、remote DB latency assumptions が固まるまでは opt-in path として扱います。

## よく使うワークフロー

ローカル source docs を import:

```bash
bun run import:wiki ./wiki/pages
```

ローカル agent logs を同期:

```bash
bun run sync:agent-logs
```

distillation pipeline を 1 stage ずつ実行:

```bash
bun run queue:finding:once
bun run queue:covering:once
bun run queue:merge-review:once
bun run queue:finalize:once
bun run queue:merge-activation-finalize:once
```

Context Decision に紐づく PR が closed/discarded になっているかを scan し、明示的に適用した場合だけ `discarded_pr` feedback を記録:

```bash
bun run decision:pr-discard-scan -- --dry-run
bun run decision:pr-discard-scan -- --apply
```

macOS の resident daemon automation を install:

```bash
bun run automation:context-stilld -- install
bun run automation:context-stilld -- load
```

compile evaluation と candidate 登録を促す任意の Git hooks:

```bash
./scripts/setup-candidate-registration-hook.sh install
```

## ドキュメント

公開向けドキュメントは `spec/docs/pub/` にあります。

| Document | Purpose |
|---|---|
| [Documentation Index](spec/docs/pub/README.md) | 公開ドキュメントの目次 |
| [Getting Started](spec/docs/pub/getting-started.md) | Desktop quick start、MCP integration、最初の compile |
| [Architecture Overview](spec/docs/pub/architecture.md) | product modes、backend boundaries、runtime components |
| [MCP Tools](spec/docs/pub/mcp-tools.md) | MCP tool contract と推奨 workflow |
| [CLI Reference](spec/docs/pub/cli.md) | コマンド一覧と例 |
| [REST API Reference](spec/docs/pub/api.md) | HTTP API endpoint inventory |
| [Configuration](spec/docs/pub/configuration.md) | desktop defaults と advanced configuration |
| [Operations](spec/docs/pub/operations.md) | doctor、backup、automation、server backend operations |

内部実装計画と設計メモは `spec/docs/` にあります。

## 開発

Pull request 前の日常 fast gate:

```bash
bun run verify
```

packaging や Tauri shell work の前に使う desktop/local readiness gate:

```bash
bun run verify:desktop-readiness
```

resident runtime ownership、lifecycle commands、sidecar classification を変更した時に使う Rust daemon boundary gate:

```bash
bun run verify:rust-daemon
```

tag / release 前の full gate:

```bash
bun run verify:full
```

よく使う確認:

```bash
bun run typecheck
bun run test:unit
bun run build:web
bun run verify:sqlite
bun run verify:mcp
bun run verify:queue:smoke
```

`bun run verify` は typecheck、lint、format check、unit test、web build に限定した fast gate です。Integration、MCP、server backend、queue smoke は別 gate です。Integration test と queue smoke は破壊的です。必ず名前に `test` を含む専用 DB を使ってください。

## コントリビュート

Issue や pull request の前に [CONTRIBUTING.md](CONTRIBUTING.md)、[SECURITY.md](SECURITY.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)、[SUPPORT.md](SUPPORT.md) を確認してください。

## License

[MIT](LICENSE)
