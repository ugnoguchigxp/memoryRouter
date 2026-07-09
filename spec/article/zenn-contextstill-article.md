---
title: "AIコーディングエージェントの記憶をローカルで育てる ContextStill"
emoji: "🧠"
type: "tech"
topics: ["ai", "mcp", "sqlite", "rust", "codingagent"]
published: false
---

AI コーディングエージェントを使っていると、ある問題にすぐ気づきます。

エージェントは賢い。けれど、前回の失敗、レビューで決めた方針、リポジトリ固有の検証手順、触ってはいけない境界を、毎回うまく思い出してくれるとは限りません。

ContextStill は、この「作業知識の継続性」を扱うための local-first な knowledge 制御基盤です。

## ContextStill とは

ContextStill は、AI コーディングエージェント向けの記憶基盤です。

Wiki や docs、Web research、agent log、明示的に登録した candidate note などを材料にして、再利用可能な `rule` / `procedure` knowledge を作ります。そして、タスクごとに必要な context pack を MCP、CLI、API、管理 UI から取り出せるようにします。

単なるメモ検索ではありません。

ContextStill の基本ループはこうです。

```text
evidence を集める
-> knowledge に蒸留する
-> task context を compile する
-> 有用性を評価する
-> 新しい学びを candidate 登録する
```

つまり、知識を保存するだけでなく、「その知識が次の作業で役に立ったか」まで扱います。

## なぜ local-first なのか

ContextStill は hosted SaaS ではありません。既定の product path は desktop / local です。

ストレージはローカル app data 配下の SQLite。管理 UI はローカルの制御基盤体験。常駐 runtime は `context-stilld run` が担当し、MCP endpoint もローカルで立ち上がります。

これは、AI エージェントの作業ログやリポジトリ固有の判断履歴が、かなり機密性の高い情報になり得るからです。

「どのブランチで何を失敗したか」
「どの検証を省くと壊れるか」
「どのファイル境界を越えると危険か」
「過去にどんなレビュー指摘を受けたか」

こうした情報は、便利な一方で、外に出したくない情報でもあります。ContextStill はそこをローカル管理する方向に寄せています。

## MCP は入口であり、本体ではない

ContextStill は MCP tools を提供します。中心になるのは次の流れです。

```text
initial_instructions
-> context_compile
-> context_decision
-> context_decision_feedback
-> compile_eval
```

`initial_instructions` は、プロジェクト作業開始時に一度だけ呼ぶ運用ガイドです。

`context_compile` は、これからやるタスクに必要な知識だけを集めて context pack を作ります。毎回すべての記憶を投げるのではなく、goal、changeTypes、technologies、domains を手がかりに必要分だけ編むのがポイントです。

`context_decision` は、エージェントが「このまま進めていいですか？」と聞きたくなる場面の前に使う判断ゲートです。過去の Knowledge evidence を見て、execute / escalate / reject などの判断を返します。

`compile_eval` は、使った context pack が本当に役立ったかを記録します。これがあるため、ContextStill は「記憶を増やすだけ」のシステムではなく、「使われた記憶を強くし、役に立たない記憶を見直す」方向へ育てられます。

## Runtime boundary がはっきりしている

ContextStill の面白いところは、UI と常駐処理を分けていることです。

管理 UI は、knowledge maintenance、review、settings、diagnostics のための操作面です。一方で、MCP endpoint、queue supervision、agent-log sync、doctor、backup などの長く生きる処理は daemon / CLI / MCP 側の責務です。

UI を閉じたら記憶の同期や MCP availability が止まる、という設計にはしていません。

現在の resident owner は Rust の `context-stilld` です。TypeScript / Bun は UI-time Hono や明示的な operator CLI に残りつつ、長期的には durable daemon runtime を Rust 側へ寄せていく構成になっています。

この境界があることで、「ローカルアプリとして開く画面」と「エージェントから常時使える記憶基盤」が混ざりにくくなっています。

## Knowledge と Episode

ContextStill では、最終的に使われる `Knowledge` と、過去作業の事例である `Episode` を分けて考えます。

Knowledge は、再利用可能な rule / procedure です。たとえば「このリポジトリでは verify はこのコマンドを使う」「queue の問題は DB 行と worker 状態を一緒に見る」といった、次の作業に直接効く知識です。

Episode は、過去の具体的な作業事例です。成功・失敗・検証パターンを含む履歴ですが、それ自体を真実の根拠として扱うのではなく、判断軸や確認観点を得るための precedent として扱います。

この分離は重要です。過去ログをそのまま正解扱いすると危険ですが、過去の失敗構造や検証パターンはかなり役に立つからです。

## Knowledge Landscape

ContextStill には Knowledge Landscape という診断・レビューの考え方もあります。

これは、知識をただリストで見るのではなく、graph、replay、review item、approval-gated candidate として扱うものです。

たとえば、よく選ばれるが実際には使われない知識、古くなった知識、根拠が薄い community、重複している candidate などを見つけるための土台になります。

ここでも直接自動削除するのではなく、review item や merge candidate として扱う方針が見えます。AI の記憶を自動で掃除するのではなく、人間が確認可能な形でメンテナンスする設計です。

## 何が嬉しいのか

ContextStill が解こうとしているのは、RAG の精度だけではありません。

より実務的には、次のような問題です。

- エージェントが同じ失敗を繰り返す
- プロジェクト固有の検証手順が毎回抜ける
- レビューで決めた方針が次の作業に継承されない
- 過去ログは大量にあるが、今のタスクに効く形で出てこない
- 判断を止めるべき場面と、自律的に進めるべき場面が曖昧になる

ContextStill は、これらを「記憶」「検索」「判断」「評価」「メンテナンス」の一連のループとして扱います。

AI コーディングエージェントを長く使うほど、重要なのは単発の賢さではなく、作業環境に適応していく能力になります。ContextStill は、その適応をローカルで、監査可能に、少しずつ育てるための基盤です。

## まとめ

ContextStill は、AI エージェントに長期記憶を足すだけのツールではありません。

証拠から knowledge を作り、タスク直前に context を compile し、判断が必要な場面では Decision を通し、作業後に eval を返す。さらに、蓄積された知識を Landscape として点検し、必要なら review / demote / merge の候補にする。

この「知識の PDCA」が ContextStill の核です。

AI エージェントを一回のチャットではなく、継続的な開発プロセスの参加者として扱うなら、こうした制御基盤はかなり重要になっていくはずです。
