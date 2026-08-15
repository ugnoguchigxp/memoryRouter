# Internal Design Documents

この directory 直下には、現在進行中の internal implementation plan と、現行実装が参照する恒久 contract / shared concept だけを置く。

これらの文書では、unfinished work、implementation constraints、rejected alternatives、local operational details を扱ってよい。public user/operator documentation は `pub/` に置く。実装済み・置換済みの文書は通常探索対象へ戻さない。

| Document | 目的 |
|---|---|
| [Context Compile Repository Isolation Improvement Plan](context-compile-repository-isolation-improvement-plan.md) | repository identityを全candidate、trace、producer、migrationへ一貫して適用し、wrong-project retrievalをfail-closedで防ぐ進行中の実装計画 |
| [Rust Runtime Closeout Implementation Plan](rust-runtime-closeout-implementation-plan.md) | live database identity、doctor/backup、queue executor truth、vector modeの測定判断、regression testを一貫させてRust runtimeを安全に完了判定する計画 |
| [LLM Provider busy 503 contract](llm-provider-busy-503-contract.md) | provider busyを恒久障害や完了として扱わず、`Retry-After`に従うretryable queue状態へ戻す契約 |
| [Security Intelligence Integration Concept](security-intelligence-integration-concept.md) | vulnWorkbench、NightWorkers、contextStillが共有するSecurity Learning Loop、責務境界、trust boundary、段階導入、評価方法 |
