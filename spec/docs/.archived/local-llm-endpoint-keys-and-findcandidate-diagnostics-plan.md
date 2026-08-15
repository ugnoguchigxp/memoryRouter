# Local LLM Endpoint Keys / findCandidate Diagnostics 実装計画

> アーカイブ日: 2026-08-15。実装コミット: `8cf1af8`。

## 目的

Local LLM の API key を provider 共通ではなく endpoint/model 単位で扱えるようにする。これにより、同じ PC 上の複数 Local LLM endpoint でも別々の key を設定でき、OpenAI / Azure OpenAI / Local LLM の Provider Endpoint UI をできるだけ同じ操作感に寄せる。

同時に、`findCandidate` の `no_candidate` を「本当に候補なし」と「候補らしき出力が parser / contract で落ちた」に分けて診断できるようにし、未整形の作業ログから rule / procedure / negative knowledge の signal を拾えることをテストで固定する。

## 現状

- `RuntimeSecretKey` は `localLlmApiKey` を 1 個だけ持つ。
- `LocalLlmModelSettings` は `name` / `apiBaseUrl` / `apiPath` / `model` を持つが、endpoint ごとの secret 参照を持たない。
- runtime cache は `secrets.localLlmApiKey` を `groupedConfig.localLlm.apiKey` に入れる。
- Local LLM provider は `groupedConfig.localLlm.apiKey` をすべての Local LLM request の `Authorization: Bearer ...` に使う。
- UI は Local LLM endpoint 行を複数表示できるが、API key editor は先頭行にだけ出る。
- `findCandidate` は `parseStorageCandidatesFromLlmOutput()` 後の候補数が 0 なら queue を `skipped/no_candidate` にするが、raw output が `[]` だったのか parser reject だったのかを永続的に区別できない。

## 非目標

- provider pool scheduler の優先度設計は変更しない。
- Local LLM endpoint の health / lease / route selection 仕様はこの計画では再設計しない。
- negative knowledge を procedure として保存可能にしない。negative は引き続き rule として扱う。
- live Qwen smoke を通常 verify に入れない。必要なら opt-in にする。

## 実装方針

### 1. Local LLM API key を endpoint/model 単位にする

#### 1.1 型と secret key の拡張

- `RuntimeSecretKey` に Local LLM endpoint 用の indexed key を追加する。
  - 例: `localLlmApiKey`, `localLlmApiKey2`, `localLlmApiKey3`, ...
  - Azure OpenAI の `azureOpenAiApiKey2` 方式に合わせ、既存 secret storage を流用する。
- `RuntimeSettingsView.providers["local-llm"]` に `apiKeySecrets: RuntimeSecretStatus[]` を追加する。
- `LocalLlmModelSettings` 自体に raw secret は持たせない。
- 初期互換として、1 番目の endpoint は既存 `localLlmApiKey` を使う。

完了条件:
- settings API view が Local LLM model 数に対応した `apiKeySecrets[]` を返す。
- 既存 `localLlmApiKey` は失効せず、先頭 Local LLM endpoint の key として扱われる。

#### 1.2 settings repository / runtime cache

- secret status 生成で `localLlmApiKey2` 以降を扱う。
- runtime cache で `groupedConfig.localLlm.models[]` に resolved API key を対応付ける。
- `groupedConfig.localLlm.apiKey` は互換用に先頭 endpoint key を保持する。
- `groupedConfig.localLlm.models[]` の型に `apiKey?: string` を追加する。

完了条件:
- `resolveLocalLlmModelConfig()` が選択 endpoint の `apiKey` も返せる。
- route が Qwen 50041 を選ぶ場合、50041 endpoint の key が使われる。
- 50043 endpoint を選ぶ場合、50043 endpoint の key が使われる。

#### 1.3 Local LLM provider / Rust queue executor

- TypeScript Local LLM provider は `resolveLocalLlmModelConfig(model)` の結果から endpoint-specific key を使う。
- key が endpoint に無い場合だけ provider-level legacy key に fallback する。
- Rust queue executor が settings JSON から Local LLM target を読む箇所にも endpoint key 解決を追加する。
  - Rust 側に raw secret を settings JSON へ保存しない。
  - secret table から `localLlmApiKey{index}` を読む。
  - endpoint target ID と model index の対応が必要なら、settings の `models[]` 順で解決する。

完了条件:
- TS 経路と Rust queue 経路の両方で、同じ endpoint に同じ key が使われる。
- secret 未設定 endpoint は key なし request または legacy fallback になり、別 endpoint の key を誤用しない。

#### 1.4 Provider Endpoint UI

- Local LLM 各 endpoint row に API Key editor を表示する。
- Azure OpenAI と同じく、2 番目以降は `API Key 2` / `API Key 3` のように見せる。
- OpenAI / Azure OpenAI / Local LLM の endpoint card の field order をできるだけ揃える。
  - Name
  - Kind
  - Endpoint
  - API Path / API Version
  - Models
  - API Key
  - Health
- Local LLM の provider-level key editor は廃止または legacy 表示にしない。ユーザーには endpoint key として見せる。

完了条件:
- Qwen endpoint 行にも API Key field が見える。
- gemma endpoint 行と Qwen endpoint 行で別々の key を保存できる。
- key の clear / masked status が endpoint ごとに表示される。

### 2. `findCandidate` の `no_candidate` 診断を分ける

#### 2.1 parser reject reason を返す

- `parseStorageCandidatesFromLlmOutput()` は現在 `CandidateRecord[]` だけを返す。
- 追加 API を作る。
  - 例: `parseStorageCandidatesWithDiagnostics(llmOutput)`
  - return: `{ candidates, diagnostics }`
- diagnostics には最低限これを含める。
  - `rawWasEmptyArray`
  - `rawCandidateLikeCount`
  - `droppedMissingType`
  - `droppedMissingPolarity`
  - `droppedNeutral`
  - `droppedNegativeProcedure`
  - `droppedInvalidProcedureShape`
  - `plainTextFallbackUsed`

完了条件:
- 既存 parser API は互換維持する。
- 新 API で「本当に `[]`」と「candidate-like object が全落ち」を区別できる。

#### 2.2 audit / queue event に保存する

- `runFindCandidate()` の storage/CLI 共通部分で parser diagnostics を作る。
- `candidateCount=0` の場合だけ、短い raw output preview と diagnostics を audit payload に保存する。
  - preview は長さ上限を設ける。
  - secret / prompt 全文 / tool result 全文は保存しない。
- queue 側の `no_candidate` event metadata にも diagnostics summary を入れる。

完了条件:
- `skipped/no_candidate` 行を見たとき、`[]` だったのか parser reject だったのか追える。
- raw preview は短く、機密や巨大 text を保存しない。

### 3. 未整形作業ログからの抽出テストを追加する

#### 3.1 SystemContext 文言テストを強化

既存テストは次の文言を確認している。

- `Use when: / Workflow: / Verification: / Avoid:`
- `失敗原因、修正方法、検証方法`
- `negative の rule 候補として出す`

これに加えて、未整形作業ログから構成してよいことを確認する。

- source に見出しがなくても、手順・検証・回避条件が読み取れるなら procedure に構成してよい。
- source に直接 `negative` と書かれていなくても、禁止・誤方針・再発防止なら negative rule にしてよい。
- 単なる進捗報告だけなら `[]` でよい。

完了条件:
- SystemContext が「完成済み候補の変換」ではなく「作業ログから signal を発見して候補化する」ことをテストで固定する。

#### 3.2 parser contract テスト

未整形ログを直接 parser に入れるのではなく、LLM が未整形ログから生成した想定 output を parser へ入れる。

ケース:
- positive rule:
  - 入力 signal: `status だけで判断せず live DB / LaunchAgent / process truth を見る`
  - 期待: `type=rule`, `polarity=positive`
- positive procedure:
  - 入力 signal: `backup -> DB 集計 -> stale worker 確認 -> 対象 worker restart -> heartbeat / event 確認`
  - 期待: SKILL.md 風 body を持つ `type=procedure`, `polarity=positive`
- negative rule:
  - 入力 signal: `findCandidate と coverEvidence を優先したいだけで、Task Routing を単一 target に固定してはいけない`
  - 期待: `type=rule`, `polarity=negative`

完了条件:
- 3 種類が parser/storage contract 上すべて受け入れられる。
- negative procedure は引き続き落ちる。

#### 3.3 opt-in live smoke

- 通常 verify には入れない。
- `FIND_CANDIDATE_LIVE_LLM=1` の時だけ、短い fixture を Qwen target に投げる。
- timeout / provider unavailable は test failure ではなく skipped diagnostic にする。

完了条件:
- live Qwen が利用可能な時だけ、parsed candidate の type/polarity 分布を確認できる。
- provider 停止や timeout が通常開発を壊さない。

### 4. SystemContext 改善

追加する文意:

- source が完成済み rule/procedure 形式でなくてもよい。
- 作業ログから、適用条件・操作順序・検証・回避条件が読み取れる場合は、procedure body を SKILL.md 風に構成してよい。
- source が `negative` と明示していなくても、ユーザーが否定した方針、レビューで退けられた実装、再発防止の禁止条件は negative rule として扱う。
- ただし、source にない事実を補完してはいけない。

完了条件:
- no_candidate を減らすために何でも候補化するのではなく、候補化してよい signal の範囲が明確になる。
- 単なる進捗報告だけのログは引き続き `[]` にできる。

## 実装順序

1. `RuntimeSecretKey` / settings view / web repository 型に Local LLM indexed key を追加する。
2. settings API が Local LLM endpoint ごとの secret status を返すようにする。
3. UI で各 Local LLM endpoint row に API Key editor を出す。
4. runtime cache と Local LLM provider で endpoint-specific key を解決する。
5. Rust queue executor の Local LLM target key 解決を endpoint-specific に合わせる。
6. parser diagnostics API を追加する。
7. `findCandidate` audit / queue event に no_candidate diagnostics を保存する。
8. 未整形作業ログ fixture の unit tests を追加する。
9. SystemContext を最小限強化する。
10. opt-in live Qwen smoke を追加する。

## 検証ゲート

- `bunx vitest run test/settings-runtime-cache.test.ts`
- `bunx vitest run test/components/admin/settings-page.test.tsx`
- `bunx vitest run test/find-candidate.test.ts`
- `bunx vitest run test/queue-worker.test.ts`
- `bun run typecheck`
- Rust 側を触った場合:
  - `cargo test -p context-stilld queue_lifecycle`
  - `cargo clippy -p context-stilld --all-targets -- -D warnings`
- 任意:
  - `FIND_CANDIDATE_LIVE_LLM=1 bunx vitest run test/live/find-candidate-live.test.ts`

## リスクと対策

- リスク: endpoint index の変更で secret が別 endpoint に見える。
  - 対策: 既存 Azure と同じ index secret 方式を採る場合でも、UI の delete / reorder 仕様を確認する。必要なら endpoint `id` ベース secret key へ切り替える。
- リスク: settings JSON に raw key を入れてしまう。
  - 対策: settings JSON は secret ref / status のみ。raw key は settings table の secret row だけに保存する。
- リスク: SystemContext 強化で低価値ログまで候補化される。
  - 対策: 単なる進捗報告は除外する既存指示を残し、fixture に no-candidate case を含める。
- リスク: live Qwen smoke が遅い。
  - 対策: opt-in にし、timeout は diagnostic skip として扱う。

## 停止条件

- endpoint-specific key を TS と Rust の両経路で同じように解決できない。
- key が settings JSON や audit log に raw で残る。
- parser diagnostics が raw output を過剰に保存する。
- SystemContext 改善で単なる進捗ログを大量に候補化する回帰が出る。
