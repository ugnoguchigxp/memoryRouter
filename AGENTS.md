このプロジェクトでの作業を開始する際、最初に一度だけ `initial_instructions` MCP ツールを実行してください。以降の個別のタスクごとに実行する必要はありません。

## Spec HTML documents

- 内部設計書、実装計画、恒久contract、調査結果は `spec/docs/` 直下へSpec HTMLとして置く。公開ユーザー／運用ドキュメントである `spec/docs/pub/` はMarkdownのまま維持する。
- 各HTML fileは主言語を示す `lang` 属性を持つ1つの `article` をrootとし、`h1`を1つだけ置く。`html`、`head`、`body`、文書固有CSS、独自navigationは追加しない。
- linkとassetは `spec/docs/` 内へ置き、相対URLで参照する。重要な要件、結論、数値はHTML本文だけでも理解できる形で残す。
- 進行中または現行実装が参照する文書は `spec/docs/` 直下、実装済みまたは後続計画で置換済みの文書は `spec/docs/.archived/` 直下へ置く。ViewerのArchive／Restore操作を使ってよい。
- 文書を作成・編集したら `bun run spec:fix` で安全な修正と整形を適用し、完了前に `bun run spec:check` を実行する。
