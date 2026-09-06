# コンテキストの検索・生成評価

検索の回帰確認と、生成したコンテキストが課題の回答に役立つかの比較は、別々に実行します。

## 検索ケースの回帰確認

JSONL の各行に課題と正解の Knowledge ID を書きます。リポジトリ固有の情報を評価するときは `projectRef`、`repoKey`、`repoPath` のいずれかを指定してください。複数指定する場合も通常の compile と同じ identity 契約に従います。

```json
{"id":"scope-regression","goal":"SQLite writerの占有時間を短くする","repoPath":"/absolute/path/to/repository","expectedKnowledgeIds":["actual-knowledge-id"],"forbiddenKnowledgeIds":["wrong-project-id"]}
```

```sh
bun run eval:context --cases /absolute/path/to/cases.jsonl --current-limit 8 --check --json
```

`--check` は全ケースが合格したときだけ終了コード 0 を返します。失敗、degraded、空のケース集合、採点ラベルのないケースは成功になりません。`--check` を省略すると集計用の動作になり、評価上の不合格だけでは終了コードを変えません。`--check` は `--cases` 専用です。

- `expectNoContent: true` は、検索結果が空であることを明示的な正解にします。取得エラーは合格になりません。
- `judgmentsComplete: true` は、期待 ID の集合がその課題の関連情報を網羅する場合に限って指定します。適合率と F1 はこのケースだけで計算します。未判定の検索結果を自動的に不正解にはしません。
- MRR と nDCG は正解 ID があるケースで計算します。欠測値は `null`、正解が一件も取れなかった場合は `0` です。
- 重複ケース ID や期待 ID と禁止 ID の重なりは実行前に拒否します。

このコマンドは TypeScript の Knowledge 検索を評価します。Rust MCP の生成品質を測った結果とは区別してください。

## 記憶なし／記憶ありの比較

```sh
CONTEXT_STILL_SQLITE_CORE_PATH=/absolute/path/to/active/context-still-core.sqlite \
  bun run foundation:experiment -- \
  --manifest spec/context-compile-foundation/manifest.decisions.v1.json \
  --out /absolute/path/to/new-experiment.json \
  --allow-provider-calls
```

設定 DB は読み取り専用で開き、設定済みの `agenticCompile` provider を使います。稼働中 resident と DB の指定が違う場合は実行を拒否します。出力先には新しいファイルを指定します。実験用の知識はメモリ上の独立した SQLite に投入するため、稼働中の知識・利用回数・compile run は変更しません。モデルへの呼び出しには通常の利用料金が発生し得ます。

同じ課題について、記憶なし、従来検索＋生成、Foundation検索＋生成の3条件を比較します。回答モデルは同一です。記憶あり条件には planner・composer の呼び出し時間とトークンも含めます。provider の自動切替は行わず、条件順を課題ごとに変えます。

課題セットには corpus、課題文、採点用の JSON pointer と期待値、検索の期待 ID／禁止 ID、出典、反復回数、最大呼び出し数を定義します。モデルに送る課題文と採点情報は分離されています。付属セットは12件の仕様判断で、8件の履歴スコアが高い無関係な知識と別プロジェクトの知識を含みます。実装を生成してテストを通す評価ではありません。

レポートには入力と実装のハッシュ、実際のモデル名、各回答、品質、検索指標、時間、provider の使用量、不完全なペア、課題単位の bootstrap 区間を保存します。失敗・未実行は全試行の品質集計で0点として残ります。価格設定やトークン使用量が欠ける場合、費用は `null` です。費用を推計する場合は課題セットの `pricing` に `currency`、`inputPerMillion`、`outputPerMillion` を明示します。

付属データは改善用の小規模な回帰課題です。結果は本番への自動切替条件を満たさず、レポートの `promotionEligible` は `false` になります。実作業への効果を判断するには、改善に使っていない課題、実際のコード変更とテスト成否、修正時間、異なるプロジェクト・モデルでの評価を追加してください。

## 日常の検証

```sh
bun run maintainability:check
bun run test:context-effectiveness
bun run verify
```

通常の検証では課金されるモデルを呼び出しません。固定 fixture とローカル HTTP mock で、検索の取りこぼし、scope、採点情報の漏れ、失敗時の集計、provider 呼び出し数を確認します。ネットワークを使う比較実験は、上の明示コマンドで実行します。
