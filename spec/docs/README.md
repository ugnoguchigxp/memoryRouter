# Internal Design Documents

この directory 直下には、現在進行中の internal implementation plan と、現行実装が参照する恒久 contract / shared concept だけを置く。

これらの文書では、unfinished work、implementation constraints、rejected alternatives、local operational details を扱ってよい。public user/operator documentation は `pub/` に置く。実装済み・置換済みの文書は通常探索対象へ戻さない。

| Document | 目的 |
|---|---|
| [Repository Isolation First Product Hardening Plan](repository-isolation-first-product-hardening-plan.md) | repository isolationを最優先に、compile ownership、巨大module、SQLite-first onboarding、release運用までの依存順序と完了gateを定める上位改善計画 |
| [Context Compile Repository Isolation Closeout Plan](context-compile-repository-isolation-improvement-plan.md) | caller adoptionからactive Rust enforcementまでをP0-P5で完了し、wrong-project retrievalをfail-closedで防ぐ進行中の実装計画 |
| [Context Compile Repository Isolation T0 Evidence](context-compile-repository-isolation-t0-evidence.md) | cross-repository fixture、legacy再現、read-only inventory、baseline cohortの実行証拠 |
| [Context Compile Repository Isolation Closeout Evidence](context-compile-repository-isolation-closeout-evidence.md) | P0-P5の実装、live migration、50-call canary、negative smoke、release gateと24時間観測の証拠 |
| [Rust Runtime Closeout Implementation Plan](rust-runtime-closeout-implementation-plan.md) | live database identity、doctor/backup、queue executor truth、vector modeの測定判断、regression testを一貫させてRust runtimeを安全に完了判定する計画 |
| [LLM Provider busy 503 contract](llm-provider-busy-503-contract.md) | provider busyを恒久障害や完了として扱わず、`Retry-After`に従うretryable queue状態へ戻す契約 |
| [Security Intelligence Integration Concept](security-intelligence-integration-concept.md) | vulnWorkbench、NightWorkers、contextStillが共有するSecurity Learning Loop、責務境界、trust boundary、段階導入、評価方法 |
| [ContextStill Utility-RAG Concept](contextstill-utility-rag-concept.md) | 現行RAGを性能低下なしで高度化し、hybrid retrieval、bounded Utility Graph、utility-per-token選択によって情報密度を高める設計構想 |
| [ContextStill Utility-RAG Future Experiments](contextstill-utility-rag-future-experiments.md) | Utility-RAGの初期roadmapへ含めない実験候補を、開始条件、評価manifest、昇格・延期・棄却条件とともに管理するbacklog |
