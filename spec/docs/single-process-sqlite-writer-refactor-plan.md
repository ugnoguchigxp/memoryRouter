# Single-Process SQLite Writer Refactoring Implementation Plan

## 1. 目的

SQLite core database のオンライン書込みを、常駐 `context-stilld run` プロセス内の単一 Writer に集約する。

### 1.1 実装結果（2026-07-18）

Writer限定スコープの実装は完了した。online mutationの所有者は、常駐`context-stilld`内の専用`context-still-sqlite-writer` threadと、そのthreadだけが保持する1本のread-write connectionである。

- Rust MCP、queue maintenance/executor、agent-log-syncは`SqliteWriterHandle`へ送信し、production domain codeからread-write connectionを直接openしない。
- Hono/TypeScript CLIはBun SQLiteを`readonly: true`でopenし、mutationだけをloopback Writer endpointへ送る。resident不在時はdirect-writeへfallbackせず失敗する。
- Writer endpointはowner-only token fileとBearer認証を使い、bounded queue、client transaction ownership、30秒の孤立transaction rollbackを持つ。
- schema bootstrap/migration、`user_version`、sqlite-vec table作成はRust Writerが所有する。新しすぎるschema versionは起動時に拒否する。
- offline backupはRust command `context-stilld backup create`がWriterと同じOS lockを保持して実行し、resident稼働中は拒否する。
- `bun run verify:sqlite-writer-ownership`が、Rustの新規direct read-write openとTypeScriptの新規direct SQLite openをCIで拒否する。

Writer限定スコープのため、TypeScript repositoryにあるdomain SQL自体のRust typed-command化は別作業とした。ただし、そのSQLをSQLiteへ実行できるOS processはRust residentだけであり、TypeScript processはread-onlyである。

運用確認コマンド:

```bash
bun run verify:sqlite-writer-ownership
cargo test -p context-stilld
cargo run -q -p context-stilld -- backup preflight --json
cargo run -q -p context-stilld -- backup create --json
```

現在のコードベースでは「Rust 化」と「単一 Writer 化」は同義ではない。Rust-native MCP、queue executor、queue maintenance、agent-log-sync は Rust に実装されているが、それぞれが独立した SQLite connection を開く。さらに Hono admin API と TypeScript CLI も別プロセスから同じ database を更新する。TypeScript の共通 SQLite open 処理は schema 作成・migration も実行するため、read path に見える起動経路も潜在的 Writer になる。

この計画では、次の状態を最終形とする。

- online runtime で SQLite を更新できる OS process は、常駐 `context-stilld run` のみ。
- 常駐 process 内では、専用 `SqliteWriter` thread が保持する 1 本の read-write connection だけが更新を実行する。
- Rust の MCP、queue、agent-log-sync も database を直接開かず、同じ `SqliteWriterHandle` を使う。
- Hono と online TypeScript CLI は、型付きの daemon write client を呼ぶ。SQLite mutation SQL を持たない。
- TypeScript に残す direct SQLite access は、schema を変更しない read-only connection に限定する。
- migration、restore、vector rebuild、bulk repair などの offline operation は Rust 実装とし、daemon 停止または maintenance mode と OS-level exclusive lock を必須にする。
- WAL と `busy_timeout` は移行中の安全網として維持するが、Writer ownership の代替にはしない。

## 2. 調査範囲と調査方法

調査対象は production code の SQLite open、mutation SQL、repository mutation、process lifecycle、thread spawn、transaction、backup/migration CLI、既存 daemon 移行計画である。test 内だけの connection open は Writer inventory から除外した。

主に次を確認した。

- `crates/context-stilld/src/domains/` の `Connection::open*`、transaction、resident reconciliation、MCP dispatch。
- `src/db/sqlite/` の connection 初期化、schema bootstrap、manual migration、vector table 作成。
- `api/modules/` の mutation route と repository。
- `src/modules/`、`src/cli/` の SQLite mutation、queue state、maintenance、repair/backfill/backup。
- `package.json` の運用可能な write CLI。
- `spec/docs/rust-daemon-replacement-readiness-plan.md`、`spec/docs/daemon-ts-eradication-implementation-plan.md`、`spec/docs/rust-sqlite-vec-first-implementation-plan.md` の ownership 前提。

mutation の静的検索には false positive が含まれ得るため、単なる `INSERT` / `UPDATE` の件数ではなく、実際の database open と呼出し process を追って分類した。Stage W0 では、この調査を機械可読な inventory と CI guard に変える。

## 3. 現状調査結果

### 3.1 結論

現状は単一 Writer process ではない。

SQLite 自身は同時に 1 transaction だけを書き込むよう直列化するが、application ownership は分散している。WAL、`busy_timeout = 5000`、短い transaction が競合を緩和していても、次は保証されない。

- どの process が更新したか。
- 複数 table の domain operation が同じ transaction で commit されるか。
- backup/restore 中に未知の Writer が存在しないか。
- daemon shutdown 時に write request が drain されたか。
- retry により同じ mutation が二重適用されないか。

### 3.2 Writer topology

| surface | 実行 process / thread | 現在の connection ownership | 主な更新 | 判定 |
|---|---|---|---|---|
| Rust-native MCP | resident daemon 内の TCP connection ごとの thread | handler が `open_database()` で都度 connection を開く | compile run/eval、decision、feedback、knowledge candidate、usage/trace | 同一 process だが複数 connection・複数 writer thread |
| Rust queue maintenance | resident reconciliation または `context-stilld queue start` を実行した process | tick ごとに read-write connection | stale job/lease recovery、queue status | CLI から別 process Writer になり得る |
| Rust queue executor | resident daemon | executor tick ごとに read-write connection | claim、lease、job/card/FTS、state/event | MCP/maintenance/sync と別 connection |
| Rust agent-log-sync | resident daemon または直接 CLI process | sync 実行ごとに connection、schema ensure | vibe memory、FTS、sync state、queue/event | 直接 CLI では別 process Writer |
| Hono admin API | `bun run api/index.ts` の別 process | process-local singleton Bun SQLite connection | settings、knowledge、source、queue、graph/landscape、vibe memory 等 | 常時並行し得る別 process Writer |
| TypeScript manual CLI / worker | command ごとの Bun process | command ごとに Bun SQLite connection | queue、migration、backfill、repair、seed、backup 等 | 任意時点で増える Writer |
| TypeScript SQLite open | Hono、CLI、test など呼出し元 process | `openSqliteCoreDatabase()` | schema create、manual migration、index/vec table create | read purpose の open も Writer 化する |

### 3.3 Rust resident 内にも単一 Writer はない

`resident_runtime::run()` は MCP、queue、agent-log-sync を同じ resident lifecycle にまとめている。しかし state が保持するのは MCP endpoint と timer/ownership 情報であり、共通 SQLite Writer handle ではない。

- `resident_runtime/service.rs` は MCP endpoint を in-process で開始し、同じ loop から queue と agent-log-sync を reconcile する。
- `mcp_lifecycle/endpoint_server.rs` は accept した TCP stream ごとに OS thread を spawn する。
- `mcp_lifecycle/native_common.rs` の `open_database()` は tool handler ごとに `Connection::open()` する。
- `queue_lifecycle/executor.rs` は tick ごとに `READ_WRITE | NO_MUTEX` connection を開く。
- `queue_lifecycle/maintenance.rs` は executor と別に read-write connection を開く。
- `agent_log_sync/store.rs` は独自に database を開き、必要 schema も ensure する。

このため、Rust コードだけを残しても単一 Writer connection にはならない。MCP request が並行すると handler thread 数だけ connection が増え、同時に queue maintenance/executor と sync も更新を試行できる。

### 3.4 Rust command は resident process 外からも更新できる

Rust-native であることも、resident-owned であることを保証しない。

- `context-stilld queue start` は呼び出した process 内で `run_maintenance_once_report()` を実行する。
- `context-stilld agent-log-sync run` / backfill は routing から service を直接実行する。
- standalone MCP start と resident MCP の lifecycle state は managed process 単位の PID 確認であり、database 全体の exclusive Writer lock ではない。
- resident `run --once` も独立 process から reconciliation/write を開始できる設計である。

最終形では、online CLI は resident control API へ command を転送し、resident が不在なら失敗させる。自動 direct-write fallback は設けない。

### 3.5 Hono は明確な別 process Writer

`admin_api_lifecycle/service.rs` は admin API を `bun run api/index.ts` として起動する。したがって daemon と Hono は別 process である。

Hono route から到達する代表的な SQLite mutation は次のとおり。

| domain | 代表的な mutation |
|---|---|
| context compiler | compile の永続化、knowledge/episode feedback、episode deprecate |
| context decision | decision run、human/system feedback、discarded PR feedback |
| episode | create、status/usage 更新 |
| knowledge | create/update/delete、bulk status、feedback、tag/source link、FTS/vector |
| queue | pause/resume/retry、job enqueue、state/event/lease |
| graph/landscape | merge/deadzone review job、candidate link/status、snapshot/cache、community label |
| source | source metadata/fragment/reindex/delete |
| vibe memory | record/delete、diff、FTS |
| settings | settings document upsert |
| diagnostics | LLM usage、audit log、compile trace/eval |

source folder/page の file operation まで Rust へ移す必要はない。SQLite mutation だけを writer command に分離し、filesystem work は Hono に残してよい。

### 3.6 TypeScript database open 自体が mutation を行う

`src/db/sqlite/client.ts` の `openSqliteCoreDatabase()` は次を実行する。

1. parent directory を作る。
2. `{ create: true }` で database を開く。
3. `foreign_keys`、`busy_timeout`、`journal_mode = WAL`、`synchronous = NORMAL` を設定する。
4. full schema SQL を実行する。
5. `migrateSqliteCoreSchema()` で `UPDATE`、`ALTER TABLE`、`DROP INDEX`、`CREATE INDEX` を実行する。
6. 利用可能なら vec virtual table を作る。

`src/db/sqlite/runtime.ts` の singleton は TypeScript process 内で 1 個でしかなく、process 間 singleton ではない。さらに open 時 migration のため、read-only repository だけを利用する process でも潜在的 Writer になる。

Rust bootstrap は現在 directory 作成と path existence check が中心で、schema 作成・versioned migration を所有していない。preflight の `migration_state` は実 migration の照合ではなく固定の `ok` である。従って、TypeScript を read-only にする前に schema ownership を Rust へ移す必要がある。

### 3.7 transaction boundary も domain operation と一致していない

一部の処理は transaction を使っている。

- agent-log-sync は memory、diff、FTS、sync state の保存を transaction にまとめる。
- episode executor の card/FTS/reference 保存には `BEGIN IMMEDIATE` がある。
- knowledge candidate 登録や vector rebuild にも局所 transaction がある。

一方、複数 repository call を service が順番に呼ぶだけの経路もある。例えば compile は run、snapshot、pack item、candidate trace、usage/retrieval feedback を段階的に保存し、queue route では state 更新と event 追加が別呼出しになり得る。単一 Writer queue に移すだけで自動的に atomic にはならない。

移行時は connection 単位ではなく domain command 単位で transaction を定義する必要がある。

### 3.8 backup guard は完全な Writer gate ではない

現在の Rust backup preflight は managed surface として queue-supervisor、agent-log-sync、admin-api を確認し、backup 本体は TypeScript CLI に delegate する。しかし次の Writer を database lock として包括的には捕捉しない。

- in-process MCP handler。
- 任意の TypeScript manual CLI。
- standalone Rust command。
- process state file に登録されていない外部 connection。

PID/state file の確認は観測情報として有用だが、check-then-act race を防ぐ OS-level lock ではない。backup/restore/migration は Writer actor の maintenance protocol と exclusive lock に統合する。

### 3.9 既存計画との関係

既存の Rust daemon 移行計画は resident daemon から TypeScript sidecar を除くことを主目的とし、Hono と manual TypeScript CLI の存在を許容している。`Rust sqlite-vec First Implementation Plan` も通常の Hono/Drizzle read/write を当面維持する前提である。

本計画はそれらを否定せず、次の段階として SQLite write ownership の境界を process 全体へ拡張する。優先順位が衝突する場合は、本計画の「online SQLite mutation は resident Writer のみ」を最終 ownership rule とする。

## 4. 目標アーキテクチャ

```text
MCP handler threads ─────────────┐
queue/sync Rust services ────────┤ in-process typed command
                                 ▼
Hono API ── local control API ─> SqliteWriterHandle
online CLI ─ local control API ─> bounded command queue
                                          │
                                          ▼
                                  SqliteWriter thread
                                  1 RW connection
                                  short transactions
                                          │
                                          ▼
                                      SQLite/WAL

Hono/CLI/Rust inspect ───────────────> read-only connections

offline migration/restore/rebuild ──> maintenance + exclusive lock
                                      daemon writer quiesced/stopped
```

### 4.1 ownership rule

`context-stilld run` を online Writer process とする。その process の起動時に `SqliteWriter` を最初に開始し、schema migration 完了後に MCP、queue、agent-log-sync、admin API readiness を有効にする。

resident process 内でも任意の thread が `Connection` を共有して直接更新してはならない。`rusqlite::Connection` は Writer thread だけが所有し、他 thread は cloneable な `SqliteWriterHandle` から command を送る。

### 4.2 Writer actor

現在の daemon は synchronous/thread-based で、async runtime を必須としていない。第一実装は bounded `std::sync::mpsc::sync_channel` と per-request response channel で十分である。必要性が計測で確認されるまで Tokio 導入を前提にしない。

Writer job は最低限次を持つ。

- `request_id`: trace と retry dedupe 用。
- `operation`: `queue.retry`、`knowledge.update` 等の安定名。
- `deadline` / enqueue timestamp。
- typed input または Writer 内 closure。
- commit 後に返す typed result / structured error。

closure を使う場合も、public remote API は任意 SQL や任意 closure を受け付けない。domain command だけを公開する。

### 4.3 connection policy

Writer が起動時に 1 本の read-write connection を開き、次を一度設定する。

- `PRAGMA foreign_keys = ON`
- `PRAGMA busy_timeout = 5000`（移行中・offline tooling との競合検出用）
- `PRAGMA journal_mode = WAL`
- `PRAGMA synchronous = NORMAL`
- sqlite-vec registration と schema/version verification

通常 operation は短い transaction とし、network、LLM call、filesystem scan、embedding 計算、large JSON parse は Writer thread の外で行う。Writer には commit に必要な確定 input だけを渡す。

### 4.4 local control API

Hono と online CLI 用に、resident daemon が loopback-only の control HTTP endpoint を所有する。既存 MCP transport の session protocol と混ぜず、versioned internal API とする。

推奨 default:

- bind: `127.0.0.1` の専用 port。既存 default port と衝突しない値を設定から解決する。
- auth: app data 配下に daemon が生成する bearer token。owner-only permission を検証する。
- API: `/control/v1/health` と domain command endpoint。
- request/response: versioned JSON schema。任意 SQL endpoint は作らない。
- success: transaction commit 後だけ 2xx。
- unavailable: direct SQLite fallback をせず 503。
- timeout: 504、validation: 400、not found: 404、version conflict: 409。

Unix domain socket は local-only 性が明確だが、desktop platform 差と Bun client 実装差を増やす。初期実装は loopback HTTP + token を選び、transport abstraction を保って将来変更可能にする。

### 4.5 TypeScript write client

`src/daemon/` または同等の boundary に 1 個の daemon client を置き、Hono repository/service は domain-specific method を呼ぶ。

例:

- `updateSettings(input, requestId)`
- `recordCompileResult(input, requestId)`
- `applyKnowledgeFeedback(input, requestId)`
- `transitionQueueJob(input, requestId, expectedVersion)`

TypeScript 側は SQLite table、FTS shadow table、queue event の整合性を知らない。複数 table の更新は Rust command の 1 transaction に閉じ込める。

### 4.6 read-only policy

TypeScript には `openSqliteCoreReadOnlyDatabase()` を新設する。次を禁止する。

- `{ create: true }`
- schema SQL / migration の実行
- `journal_mode` の変更
- vec virtual table 作成
- parent directory/database file の作成
- read path からの opportunistic repair

read-only open は database missing、schema version mismatch、required extension unavailable を明示的に失敗させる。Rust 側の inspect/read path も `SQLITE_OPEN_READ_ONLY` を標準 helper にする。

### 4.7 online と offline の境界

| class | 例 | 実行規則 |
|---|---|---|
| online short write | API mutation、MCP feedback、queue claim/state/event、sync incremental save | resident Writer queue のみ |
| online read | UI list/search、inspect、doctor | read-only connection 可 |
| online snapshot | backup | 原則 daemon command として Writer を barrier 後に snapshot。少なくとも Writer truth を使う |
| offline exclusive write | schema migration、restore、VACUUM、full vector rebuild、PostgreSQL import、bulk repair/backfill | Rust command、maintenance mode、queue drain、exclusive lock 必須 |

offline tool も TypeScript direct writer として残さない。ただし全件処理を通常 Writer queue に流して interactive write を長時間止めることもしない。

## 5. 完了条件

次をすべて満たした時だけ single-process Writer 化完了とする。

- live daemon + Hono + MCP + scheduled queue/sync + supported online CLI を同時実行しても、write audit の PID が resident daemon の 1 PID だけである。
- resident daemon 内の production mutation は 1 本の Writer connection から実行される。
- production Rust domain code に、Writer module と明示的 read-only/offline module 以外の `Connection::open*` mutation path がない。
- `src/` / `api/` に online SQLite mutation SQL、Drizzle insert/update/delete、write-capable runtime open がない。
- TypeScript read-only process の起動で database、WAL、schema、index、vec table の metadata が変化しない。
- Hono/CLI は daemon unavailable 時に fail closed し、direct-write fallback をしない。
- compile、decision、queue state+event、knowledge+FTS/vector 等の定義済み aggregate が transaction atomic である。
- schema migration は Rust-owned、versioned、idempotent で、preflight が実 version を報告する。
- backup/restore/migration が Writer maintenance state と OS-level lock を検証する。
- graceful shutdown は新規 command を停止し、期限内に queue を drain して connection を close する。
- CI static guard と multi-client integration test が ownership regression を検出する。

## 6. 実装原則

1. **移植単位は repository file ではなく domain command にする。**
   FTS、audit、event、usage count を含む整合性単位を 1 transaction にする。

2. **dual-write をしない。**
   migration 中の route flag は request ごとに legacy または Writer の一方だけを選ぶ。両方へ書かない。

3. **自動 fallback をしない。**
   control API failure 時に TypeScript direct write へ戻すと ownership が再び不明になる。

4. **long work を Writer thread に入れない。**
   network/LLM/embedding/file scan は外で行い、commit payload だけを enqueue する。

5. **read-only 化より先に Rust migration parity を作る。**
   現在は TypeScript open が schema lifecycle を担っているため、順序を逆にできない。

6. **process state file と exclusive lock を区別する。**
   state file は観測用、OS lock は排他制御用とする。

7. **PostgreSQL backend を壊さない。**
   SQLite adapter の境界を差し替え、PostgreSQL repository contract は別経路として維持する。

## 7. 実装ステージ

### W0: Writer inventory と regression guard の固定

#### 目的

現在の全 write surface を機械可読にし、移行中の取りこぼしと新規 direct writer 増加を止める。

#### 実装

- `scripts/` に SQLite writer audit を追加する。
- production file を次の class に分類した manifest を置く。
  - `resident_writer_target`
  - `online_remote_client_target`
  - `read_only_allowed`
  - `offline_exclusive_target`
  - `test_only`
- `Connection::open*`、Bun `new Database`、`openSqliteCoreDatabase`、Drizzle mutation、mutation SQL を検出する。
- false positive は path + rationale 付き allowlist に限定し、無条件除外を作らない。
- domain operation inventory に、caller process、tables、side effects、現 transaction boundary、retry semantics を記録する。
- temporary DB で現行 behavior の characterization test を追加する。

#### 完了条件

- 本文 3.2 と 3.5 の surface が inventory にすべて現れる。
- production に direct writer を追加すると CI が失敗する。
- test fixture 内の SQL と production writer を区別できる。

#### 検証

```bash
bun run audit:sqlite-writers
rg -n "Connection::open|openSqliteCoreDatabase|new Database" crates/context-stilld/src src api
```

#### 停止条件

- dynamic table name や wrapper により mutation caller を分類できない。
- SQLite/PostgreSQL branch が静的に区別できず、allowlist が広すぎる。

### W1: Rust-owned schema lifecycle と Writer foundation

#### 目的

TypeScript open に依存せず database を作成・upgrade できるようにし、単一 Writer actor の土台を導入する。

#### 実装

- `sqlite_runtime` domain を追加し、次を分離する。
  - versioned schema migrations
  - Writer connection setup
  - read-only connection setup
  - offline exclusive connection setup
- 現在の `createSqliteCoreSchemaSql()` と `migrateSqliteCoreSchema()` を ordered Rust migration に移植する。
- `schema_migrations` table または `PRAGMA user_version` の一方を正式 contract として採用する。
- schema/column/index/FTS/trigger/vec table parity test を、TypeScript 生成 DB と Rust 生成 DB の比較で固定する。
- sqlite-vec registration と vector dimension mismatch の失敗 contract を固定する。
- `SqliteWriter` thread、bounded queue、`SqliteWriterHandle`、typed error、deadline、shutdown/drain を実装する。
- writer PID、thread state、queue depth/capacity、active operation、last commit/failure、schema version を status/doctor に出す。
- resident 起動の最初に OS-level single-instance/exclusive Writer lock を取得する。PID file の check-then-write だけに依存しない。
- `observe | resident_writer | enforced` の migration mode を追加する。automatic fallback と dual-write は禁止する。

#### 完了条件

- 空の temporary path から Rust だけで current schema を作成できる。
- current production-compatible fixture を Rust migration で最新化できる。
- N thread から enqueue しても Writer thread だけが transaction を実行する。
- panic/error/timeout で transaction が rollback され、次の command を処理できる。
- 2 個目の resident Writer process は lock acquisition で起動に失敗する。

#### 検証

```bash
cargo test -p context-stilld sqlite_runtime
cargo test -p context-stilld sqlite_writer
cargo run -q -p context-stilld -- bootstrap preflight --json
```

#### 停止条件

- TypeScript schema と Rust migration の parity を temporary DB で証明できない。
- sqlite-vec / FTS table の再作成で既存データ損失の可能性がある。
- Writer job が `Send + 'static` boundary に収まらず、domain API の再設計が必要になる。

### W2: resident 内 Rust writer の集約

#### 目的

MCP、queue、agent-log-sync の Rust mutation を共通 WriterHandle に通す。

#### 実装順

1. queue maintenance の stale recovery。
2. queue claim/lease/state/event。
3. agent-log-sync incremental store。
4. MCP `compile_eval` と feedback/candidate の小さい mutation。
5. MCP compile/decision の aggregate persistence。
6. episode executor の card/FTS/reference と job completion。

#### transaction 再定義

- queue state transition + event append + lease release を 1 command にする。
- compile run + snapshot + selected items + trace + usage/retrieval feedback を、成功/失敗 contract に沿う transaction にする。
- decision run + evidence + coverage + effect/feedback を transaction にする。
- knowledge main row + FTS + tag/source links + vector metadata + audit を operation ごとに transaction 化する。
- agent-log-sync は既存 transaction semantics を維持しつつ、connection ownership だけを Writer へ移す。

LLM 実行中に Writer connection を保持しない。claim commit 後に LLM/network work を行い、結果 commit を別 command として戻す。claim command と result command は job version/lease token で stale write を拒否する。

#### CLI の扱い

- resident が動作中の `queue start`、`agent-log-sync run` は control command に転送する。
- resident が不在なら online action は明示的に失敗する。
- backfill は W6 まで dry-run のみ許可するか、exclusive offline mode に限定する。
- standalone MCP writer mode は default から外し、最終的に削除する。

#### 完了条件

- production Rust domain module から direct read-write `Connection::open*` が消える。
- Rust read path は read-only helper、test は temporary connection として明示分類される。
- MCP concurrent request と queue/sync tick が同時でも commit は Writer event sequence 上で直列になる。

#### 検証

```bash
cargo test -p context-stilld
bun run verify:rust-daemon
bun run mcp:smoke:sqlite
bun run audit:sqlite-writers
```

#### 停止条件

- Writer command 内に LLM/network/file scan が残る。
- 既存の partial persistence を transactional に変えることで retry/recovery contract が不明になる。
- queue lease token なしに長時間 job の stale result を安全に拒否できない。

### W3: authenticated control API と TypeScript client

#### 目的

別 process から SQLite を触らず、resident Writer へ typed command を送れる boundary を作る。

#### 実装

- loopback-only control server と token lifecycle を実装する。
- token file/endpoint file の owner permission、rotation、stale file cleanup を実装する。
- `/control/v1/health` に daemon PID、writer ready、schema version、queue saturation、maintenance state を返す。
- command envelope に `requestId`、`operationVersion`、deadline、optional idempotency key を含める。
- retry 可能な create/enqueue operation は idempotency key の uniqueness を Rust transaction 内で保証する。
- update/transition は `expectedVersion` または lease token を受け、lost update を 409 にする。
- payload size、rate/queue capacity、request timeout を制限する。
- TypeScript daemon client と Hono error mapping を追加する。
- contract test で Rust response と TypeScript decoding を固定する。

#### 完了条件

- Hono test process から temporary resident daemon へ authenticated mutation を送り、commit 後の response を受け取れる。
- token 不正、daemon unavailable、queue full、deadline exceeded、conflict が区別される。
- generic SQL execution endpoint が存在しない。
- client に direct SQLite fallback がない。

#### 検証

```bash
cargo test -p context-stilld control_api
bun test test/daemon-write-client.test.ts
bun run typecheck
```

#### 停止条件

- control endpoint が loopback 外へ bind される。
- token file permission を対象 platform で保証できない。
- request timeout 後に commit 成否を照会できず、非 idempotent retry が必要になる。

### W4: 低リスク Hono mutation の移行

#### 目的

contract が小さく Rust parity を作りやすい route から control API へ切り替える。

#### 対象

- settings upsert。
- compile eval と既存 feedback。
- vibe memory record/delete。
- episode create/status/usage。
- queue pause/resume/retry と event。
- LLM usage/audit は単独 command にせず、可能なら原因となる domain transaction に組み込む。

#### 実装

- repository interface は維持し、SQLite adapter 実装を daemon client adapter に差し替える。
- PostgreSQL adapter は変更しない。
- route ごとに `legacy_direct | resident_writer` を選ぶ feature gate を一時導入する。ただし 1 request で両方は呼ばない。
- response status/body、validation、not-found、conflict semantics の parity test を追加する。
- resident unavailable 時の 503 と UI/operator message を固定する。

#### 完了条件

- 対象 route 実行中、Hono process の SQLite connection は read-only だけである。
- FTS/event/audit を含む副作用が Rust transaction で一致する。
- migrated route に legacy direct-write fallback がない。

#### 検証

```bash
bun test test/api test/sqlite-runtime-support.bun.ts
bun run typecheck
bun run audit:sqlite-writers
```

#### 停止条件

- Hono behavior と Rust command の validation/error semantics が一致しない。
- 1 route の処理が複数 control command に分かれ、partial commit が生じる。

### W5: core domain と graph/landscape/queue mutation の移行

#### 目的

table 間依存が大きい TypeScript writer を domain aggregate として Rust へ移す。

#### 実装順

1. knowledge row、feedback、tags、source/origin links、FTS。
2. source metadata/fragment/reindex/delete。filesystem scan/fetch は TypeScript に残し、commit payload を送る。
3. context compile/decision の Hono route を、W2 と同じ Rust domain command に統合する。
4. queue enqueue/claim/state/event/lease の Hono/TS path を Rust queue command に統一する。
5. graph/landscape review candidate、deadzone/merge job、snapshot/cache、community label。
6. vector insert/rebuild metadata。large rebuild 自体は W6 offline path へ分ける。

#### 設計上の注意

- Hono の既存 service orchestration をそのまま細粒度 RPC に写さない。
- `update row` と `append event`、`knowledge` と FTS、`card` と reference のような不変条件を 1 Rust command にする。
- deterministic computation は client/Rust service のどちらでもよいが、commit 前 validation と database-derived precondition は Writer transaction 内で再確認する。
- large payload は上限を設け、fragment bulk upsert は chunked command + import session semantics を使う。

#### 完了条件

- API の SQLite mutation route がすべて daemon client adapter を通る。
- `api/` に mutation SQL/Drizzle mutation が残らない。
- nested service が旧 SQLite repository を直接 import していない。
- domain parity tests が row だけでなく FTS、event、audit、reference、version を確認する。

#### 検証

```bash
bun run typecheck
bun test
cargo test -p context-stilld
bun run verify:sqlite
bun run audit:sqlite-writers
```

#### 停止条件

- 既存 route の副作用 inventory に未分類 table が現れる。
- bulk command が interactive writer latency budget を継続的に超える。
- vector engine ownership が既存 sqlite-vec plan と整合しない。

### W6: TypeScript CLI と保守 operation の Rust 化・排他化

#### 目的

任意に起動可能な別 process Writer を除去し、online command と offline exclusive operation を分離する。

#### 対象

- queue one-shot/enqueue/requeue/migration。
- knowledge embedding/value/project/source/origin link backfill。
- episode/card repair/reset/backfill。
- PostgreSQL-to-SQLite import/migration。
- seed/sample data。
- SQLite backup/restore/vector rebuild/VACUUM。

#### 実装

- online queue/enqueue/retry CLI は control API client にする。
- dry-run/read/report CLI は read-only open にする。
- bulk write は Rust offline command へ移植する。
- offline command の開始手順を固定する。
  1. control API で maintenance intent を登録。
  2. 新規 write request を拒否。
  3. Writer queue と active operation を drain。
  4. resident Writer connection を close、または daemon を停止。
  5. OS-level exclusive database lock を取得。
  6. backup + integrity/schema check。
  7. operation 実行。
  8. integrity/schema/version 検証。
  9. lock release、Writer reopen、health check。
- backup は可能なら resident command にし、barrier 後に SQLite backup API または整合 snapshot を作る。restore は必ず stopped/exclusive とする。
- legacy TypeScript write script は package script から削除し、移行案内を出す wrapper も一定期間後に削除する。

#### 完了条件

- `package.json` に TypeScript direct-write CLI がない。
- offline operation は active Writer を検知したら実行せず、maintenance handshake なしに bypass できない。
- backup preflight は surface 名の推測ではなく、Writer lock/status を truth とする。
- restore/rebuild failure から backup へ戻す手順が rehearsal 済みである。

#### 検証

```bash
bun run audit:sqlite-writers
cargo test -p context-stilld offline_maintenance
cargo run -q -p context-stilld -- backup preflight --json
sqlite3 "$CONTEXT_STILL_SQLITE_CORE_PATH" "PRAGMA integrity_check;"
```

検証用 database は必ず temporary copy を使い、live `data/context-still-core.sqlite` を破壊的 test に使わない。

#### 停止条件

- maintenance mode 中にも MCP/Hono/CLI から write を受理する。
- lock の対象が database path と一致しない symlink/relative path alias を許す。
- backup なしに schema/bulk mutation を開始する。

### W7: TypeScript SQLite の read-only 強制と legacy path 削除

#### 目的

TypeScript process が SQLite Writer に戻れない状態を code と runtime の両方で強制する。

#### 実装

- `openSqliteCoreReadOnlyDatabase()` を default runtime open にする。
- `openSqliteCoreDatabase()`、TypeScript schema bootstrap/migration、Bun sqlite-vec loading/virtual table creation を production path から削除する。
- migrated SQLite repository を read-only query adapter と daemon command adapter に分割する。
- static audit を required CI check にする。
- TypeScript read process 起動前後で schema version、`sqlite_master`、row count、database/WAL mtime が変わらない test を追加する。
- Rust production code も Writer/offline helper 外の read-write open を CI で禁止する。
- final mode を `enforced` にし、legacy feature gate を削除する。

#### 完了条件

- Hono と全 supported TypeScript CLI が read-only open または daemon client のみを使う。
- TypeScript startup だけでは database file が作成されない。
- `rg` と audit script の allowlist は test、read-only、offline Rust module だけになる。
- direct-write regression を意図的に追加した test fixture で CI failure を確認する。

#### 検証

```bash
bun run audit:sqlite-writers
bun run typecheck
bun test
cargo test -p context-stilld
bun run verify:sqlite
```

#### 停止条件

- read-only open の内部で schema ensure/repair が残る。
- compatibility の名目で automatic direct-write fallback が残る。
- CI allowlist が directory 単位で mutation を許す。

### W8: concurrency、障害、運用 gate と hard cutover

#### 目的

単一 Writer ownership が高負荷、shutdown、crash、backup を含めて運用可能であることを証明する。

#### test matrix

| case | 確認事項 |
|---|---|
| MCP + Hono + queue + sync 同時 write | commit 順序、1 writer PID/thread、`SQLITE_BUSY` なし |
| queue saturation | bounded backpressure、429/503、memory 無制限増加なし |
| duplicate request | idempotency key で 1 commit |
| stale queue result | lease/version conflict で拒否、event 整合 |
| transaction failure | aggregate 全 rollback、次 command 継続 |
| client timeout | request status を照会可能、blind retry しない |
| SIGTERM | accept stop、drain、deadline 後 cancel/rollback、clean close |
| daemon crash | WAL recovery、lock reclaim、in-flight 状態の明示 |
| backup/restore | maintenance handshake、integrity、schema version、再起動 |
| read-only Hono | process 起動/queries で schema/mtime 不変 |

#### runtime observability

- `writerPid`
- `writerThreadState`
- `schemaVersion`
- `queueDepth` / `queueCapacity`
- `activeOperation` / elapsed time
- `lastCommittedAt`
- `lastFailure`（secret/input を含めない）
- operation ごとの enqueue wait、transaction duration、commit/failure count
- maintenance/lock owner

#### hard cutover gate

- 連続した実運用観測期間で unknown Writer と `SQLITE_BUSY` が 0。
- p95 enqueue wait/transaction duration が設定した SLO 内。
- backup/restore rehearsal が成功。
- legacy direct mode と package script を削除済み。
- operations/configuration/architecture docs を新 ownership に更新済み。

#### 完了条件

- 完了条件 5 の全項目に test/report evidence がある。
- `doctor`、`status`、backup preflight が同じ Writer PID/lock/schema state を報告する。
- rollback rehearsal と crash recovery test が temporary DB で成功する。

## 8. 推奨 module 境界

具体的な file 名は実装時の既存 domain 構造に合わせて調整してよいが、責務は次のように分ける。

```text
crates/context-stilld/src/domains/sqlite_runtime/
  service.rs          # start/stop/status, migration mode
  writer.rs           # writer thread, queue, handle, shutdown
  connection.rs       # RW/RO/offline connection policy
  migrations/         # ordered embedded migrations
  lock.rs             # resident/offline exclusive lock
  types.rs            # command envelope, error/status

crates/context-stilld/src/domains/control_api/
  server.rs           # loopback HTTP, auth, limits
  routing.rs          # versioned typed domain commands
  token.rs            # token lifecycle and permissions

src/daemon/
  write-client.ts     # transport/error/idempotency
  command-types.ts    # TS contract types/decoders

src/db/sqlite/
  read-only-client.ts # query-only open
```

domain SQL は巨大な中央 `match` に集めず、knowledge、queue、compile、decision 等の Rust domain module に置く。connection ownership と transaction execution だけを Writer が中央管理する。

## 9. API command 設計チェックリスト

各 mutation を移行する前に、次を記入する。

- command name/version。
- caller と authorization。
- idempotency key の要否。
- expected version / lease token。
- 読み取る table と更新する table。
- FTS/vector/audit/event の副作用。
- transaction の開始・commit boundary。
- validation を client 前処理と transaction 内再検証のどちらで行うか。
- maximum payload と chunking。
- timeout 後の status lookup。
- retry-safe / retry-unsafe の分類。
- error mapping。
- temporary DB parity test。

## 10. Rollout と rollback

### rollout

1. W0/W1 は write routing を変えず foundation と観測を追加する。
2. W2 以降は domain/route 単位で `resident_writer` へ切り替える。
3. 同じ request の dual-write は行わない。
4. 各 stage で temporary DB backup、schema checksum、row/FTS/vector/event parity を保存する。
5. W7 で `enforced` にし、legacy path を削除する。

### rollback

- W1 の additive schema/actor だけなら routing flag を戻せる。
- W2-W6 の route rollback は、当該 domain の migration schema が backward-compatible で、同一稼働期間に old/new Writer を混在させない場合だけ許可する。
- control API failure を契機とした runtime automatic fallback は禁止する。rollback は operator が process 全体を止め、mode を変更して再起動する。
- destructive schema migration 前には verified backup を作る。
- hard cutover 後は direct Writer code を復活させず、Rust command の forward fix を優先する。

## 11. リスクと対策

| リスク | 対策 |
|---|---|
| Writer queue が global bottleneck になる | short transaction、bounded queue、latency metric、bulk offline/chunking |
| LLM/network 中に connection を占有する | claim/result の 2 command 化、lease/version token |
| HTTP timeout 後に commit 済みか不明 | request ID、idempotency record、status lookup |
| Hono contract drift | route-level contract/parity test、typed decoder |
| schema parity 不足で TS read-only 化に失敗 | W1 を先行し、empty/current fixture の比較 gate |
| FTS/vector の副作用漏れ | domain command inventory と aggregate transaction test |
| offline CLI が lock を bypass | canonical path、OS lock、maintenance handshake、CI/package script 削除 |
| PID file stale/race | PID は観測のみ、排他は OS lock |
| Writer panic で daemon 全体が不健全 | health state、fail closed、supervised shutdown/restart、no silent respawn loop |
| migration 中に legacy/new Writer が混在 | process-wide mode、route ownership inventory、短い cutover window、no fallback |

## 12. 初期実装の推奨 PR 分割

| PR | 内容 | 依存 |
|---|---|---|
| PR1 | writer inventory、audit script、characterization tests | なし |
| PR2 | Rust schema migrations/parity、read-only/RW connection policy | PR1 |
| PR3 | Writer actor、status/doctor、OS lock、shutdown tests | PR2 |
| PR4 | queue maintenance/claim/state/event を Writer 化 | PR3 |
| PR5 | agent-log-sync と small MCP writes を Writer 化 | PR3 |
| PR6 | compile/decision/episode aggregate transaction 化 | PR4/PR5 |
| PR7 | control API、token、TypeScript client、contract tests | PR3 |
| PR8 | low-risk Hono routes | PR7 + relevant Rust command |
| PR9 | knowledge/source/queue/graph/landscape routes | PR6-PR8 |
| PR10 | Rust offline maintenance/backup/migration、TS CLI 除去 | PR9 |
| PR11 | TS read-only enforcement、legacy deletion、hard-cutover tests/docs | PR10 |

PR4 と PR5 は共通 Writer API が固定された後なら並行可能である。PR8/PR9 は domain command parity が先で、TypeScript route の切替だけを先行させない。

## 13. 実装開始時の最初の判断事項

実装前に ADR として次を確定する。

1. schema versioning に `schema_migrations` と `user_version` のどちらを使うか。
2. Writer queue capacity、default deadline、shutdown drain timeout。
3. control API の port resolution と token file path/permission。
4. idempotency record の保存期間と cleanup。
5. online backup を SQLite backup API と `VACUUM INTO` のどちらで実装するか。
6. offline exclusive lock の cross-platform library と canonical database identity。
7. compile/decision failure record を成功 aggregate と別 transaction にするか。
8. vector full rebuild の chunk/maintenance policy。

推奨は、schema migration table、bounded synchronous queue、loopback HTTP + token、domain command の明示的 idempotency、online backup API、OS file lock の組合せである。

## 14. 調査根拠となる主要 file

- `crates/context-stilld/src/domains/resident_runtime/service.rs`
- `crates/context-stilld/src/domains/mcp_lifecycle/endpoint_server.rs`
- `crates/context-stilld/src/domains/mcp_lifecycle/native_common.rs`
- `crates/context-stilld/src/domains/mcp_lifecycle/native_compile.rs`
- `crates/context-stilld/src/domains/mcp_lifecycle/native_decision.rs`
- `crates/context-stilld/src/domains/mcp_lifecycle/native_knowledge.rs`
- `crates/context-stilld/src/domains/queue_lifecycle/executor.rs`
- `crates/context-stilld/src/domains/queue_lifecycle/maintenance.rs`
- `crates/context-stilld/src/domains/queue_lifecycle/service.rs`
- `crates/context-stilld/src/domains/agent_log_sync/store.rs`
- `crates/context-stilld/src/domains/agent_log_sync/routing.rs`
- `crates/context-stilld/src/domains/admin_api_lifecycle/service.rs`
- `crates/context-stilld/src/domains/bootstrap/service.rs`
- `crates/context-stilld/src/domains/backup/service.rs`
- `src/db/sqlite/client.ts`
- `src/db/sqlite/runtime.ts`
- `src/db/sqlite/core-repository.ts`
- `api/modules/`
- `src/modules/queue/core/`
- `src/modules/context-compiler/`
- `src/modules/context-decision/`
- `src/modules/knowledge/`
- `src/modules/landscape/`
- `src/modules/settings/settings.repository.sqlite.ts`
- `src/modules/sources/source.repository.sqlite.ts`
- `src/modules/vibe-memory/`
- `src/modules/sqlite-migration/postgres-to-sqlite.service.ts`
- `src/cli/`
- `package.json`
