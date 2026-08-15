# Finding Codex Escalation / Provider Pool Routing Implementation Plan

> アーカイブ日: 2026-08-15。実装コミット: `b860b8d`。

## Purpose

`findingCandidate` の knowledge 発見率を戻すために、次の2案を同じ実装計画として扱う。

1. Codex / 5.4 mini class の高性能モデルを `findingCandidate` の second-pass / escalation に使う。
2. Local LLM の provider target を Pool として定義し、`taskRouting` が model ではなく Pool を向ける運用レイヤーを作る。

この2案は競合しない。Pool routing は通常経路の実行資源を安定させる基盤であり、Codex escalation は通常経路が取り逃がした高価値ログだけを再判定する補助経路である。

## Current Findings

直近調査で見えた事実:

- `findingCandidate` は入口であり、ここで `no_candidate` になると `coveringEvidence` 以降では復活できない。
- `coveringEvidence` は候補が来れば `knowledge_ready` を一定量出しているため、現状の主な歩留まり低下は finding 側に寄っている。
- Ornith 1.0 9B は `episodeDistiller` では有用だが、`findingCandidate` / `coveringEvidence` の主担当としては recall / abstraction が不安定になりやすい。
- Qwen 3.6 27B を2機使える場合でも、同一 pool を複数 route が奪い合うと片方の route だけが進むシナリオがある。
- provider 側の busy 503 は安全弁として有用だが、queue scheduling の主制御にすると「待てばよい」と「壊れている」が混ざる。
- Codex を finding に使う場合、Codex の作業ログが再び Vibe memory に戻る自己汚染を防ぐ必要がある。

## Desired End State

- Settings UI で Provider Target と Provider Pool を定義できる。
- `taskRouting` は `providerPoolId` を第一優先の向き先として扱う。
- `findingCandidate` / `coveringEvidence` / `finalizeDistille` / `episodeDistiller` は、用途別 pool に明示的に割り当てられる。
- 同じ target が同時に複数 job へ lease されない。
- pool full の場合は provider に投げず、queue 側で wait する。
- provider busy 503 は target cooldown / retry-later として扱い、route failure と区別する。
- Codex escalation は一次経路ではなく、条件を満たした `no_candidate` / low-confidence finding だけを second-pass する。
- Codex escalation の実行ログは Vibe memory / findingCandidate の再入力にならない。
- `queue inspect --json` と DB row から、どの queue がどの pool / target を待っているか説明できる。

## Non-Goals

- Codex を `findingCandidate` の主経路にいきなり置かない。
- Provider 側の 503 だけで route fairness を実現しようとしない。
- `coveringEvidence` / `finalizeDistille` の business logic をこの計画で再設計しない。
- `episodeDistiller` を Qwen 優先へ戻すことは目的にしない。
- 既存の `providerPools` / `providerPoolId` を破棄して新規概念へ置き換えない。
- live DB の広範な queue reset をしない。
- Codex 実行ログを Vibe memory として後から filter すればよい、という前提にしない。生成時点で自己汚染を避ける。

## Proposed Runtime Topology

初期推奨構成:

| Task | Pool | Target |
| --- | --- | --- |
| `findingCandidate` | `finding-qwen-pool` | Qwen 3.6 27B #1 |
| `coveringEvidence` | `covering-qwen-or-gemma-pool` | Qwen 3.6 27B #2 or Gemma4 12B |
| `finalizeDistille` | `covering-qwen-or-gemma-pool` | Qwen 3.6 27B #2 or Gemma4 12B |
| `episodeDistiller` | `episode-ornith-pool` | Ornith 1.0 9B |
| Codex escalation | `codex-escalation` route | Codex / 5.4 mini class |

Pool separation rule:

- `findingCandidate` と `coveringEvidence` は同じ Qwen pool を共有しない。
- `coveringEvidence` と `finalizeDistille` は同じ pool を共有してよい。
- `episodeDistiller` は Ornith pool へ逃がし、Qwen pool を消費しない。
- 同じ physical target を複数 pool に入れる場合は global lease で二重使用を禁止する。初期実装では、1 target は1 pool所属を推奨する。

## Architecture

### Provider Target

Provider Target は実際の endpoint/model を表す。

```ts
type ProviderTarget = {
  id: string;
  label: string;
  provider: "local-llm" | "azure-openai" | "openai" | "codex" | "bedrock";
  enabled: boolean;
  endpoint?: string;
  apiPath?: string;
  model: string;
  secretRef?: string;
  healthStatus?: "unknown" | "healthy" | "busy" | "unhealthy";
};
```

既存の `providers["local-llm"].models[]` は Local LLM target として扱える。最初の slice では物理 schema を大きく変えず、UI と routing で Target として見せる。

### Provider Pool

Provider Pool は実行資源の割当単位である。

```ts
type ProviderPool = {
  id: string;
  label: string;
  enabled: boolean;
  targets: ProviderPoolTarget[];
  maxConcurrent: number;
  staleLeaseSeconds: number;
  lowPriorityAgingSeconds: number;
  fairnessPolicy: "priority_order" | "round_robin_by_queue";
  busyPolicy: "wait" | "fallback_pool";
  fallbackPoolIds?: string[];
};
```

初期実装は `priority_order` と `wait` のみでよい。`round_robin_by_queue` は phase 2 以降に回す。

### Task Routing

Task routing は provider/model 直指定を残しつつ、pool first にする。

```ts
type RuntimeSettingsRoute = {
  provider: RuntimeProviderSetting;
  model: string;
  providerPoolId?: string;
  fallbackPoolIds?: string[];
  fallback: RuntimeProviderSetting[];
  waitPolicy?: "wait_for_pool" | "fallback_on_pool_full";
};
```

優先順位:

1. route の `providerPoolId`
2. route の `fallbackPoolIds`
3. route の provider/model direct target
4. provider default

Pool が指定されている場合、scheduler は pool の free target だけを見る。provider/model direct matching は fallback としてのみ使う。

### Provider Busy Contract

Provider endpoint 側の busy 503 は、主制御ではなく安全弁とする。

| Condition | Runtime Handling |
| --- | --- |
| pool full | provider に投げない。queue は wait |
| target lease active | target を候補から除外 |
| provider busy 503 | target cooldown を記録し、job は retry-later |
| unsupported model 404 | route/target 設定エラーとして failed または operator action |
| timeout / transport closed | target health degradation と retry/backoff |

## Codex Escalation Design

### Role

Codex は primary finding ではなく second-pass reviewer とする。

Flow:

```text
Vibe memory
  -> controlled eligibility filter
  -> primary findingCandidate using local LLM pool
  -> if no_candidate or low-confidence and high-signal:
       Codex escalation
  -> accepted candidates
  -> coveringEvidence
```

### Escalation Trigger

初期条件:

- source kind is `vibe_memory`
- primary result is `no_candidate` OR parser diagnostics shows candidate-like output dropped
- eligibility score >= threshold
- source content has at least one high-value signal:
  - verification / failure / root cause terms
  - runtime / queue / DB / provider terms
  - preference / avoid / must / should terms
  - code review / regression / test gate terms
- no existing finding job or candidate with same `dedupeKey`
- no previous Codex escalation for same `vibeMemoryId + distillationVersion`

Do not escalate:

- boilerplate-heavy content
- progress-only content
- existing `duplicate` / `near_duplicate`
- logs generated by Codex escalation itself
- already terminal `knowledge_ready` source

### Storage

Add minimal persistent trace, either as a new table or as queue metadata. Prefer a new table because escalation should be auditable without overloading queue rows.

```sql
create table if not exists finding_candidate_escalations (
  id text primary key,
  source_kind text not null,
  source_key text not null,
  source_dedupe_key text,
  primary_job_id text,
  escalation_provider text not null,
  escalation_model text not null,
  status text not null,
  reason text not null,
  output_summary text,
  candidate_count integer not null default 0,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);
```

Unique constraint:

```sql
create unique index if not exists finding_candidate_escalations_source_idx
  on finding_candidate_escalations(source_kind, source_key, escalation_provider, escalation_model);
```

### Self-Ingestion Guard

Codex execution must not feed its own operational logs back into Vibe memory.

Preferred approach:

- Use a direct API / SDK adapter for Codex escalation rather than launching an interactive Codex session.
- Store request/response summary in `finding_candidate_escalations`, not in `.codex/sessions`.

If a Codex CLI/session is unavoidable:

- Add a clear session marker:
  - `metadata.generatedBy = "contextStill.codexFindingEscalation"`
  - `metadata.excludedFromVibeMemory = true`
- Update agent-log-sync parsing to skip sessions with that marker.
- Add a second guard in `vibe-finding-enqueue` to reject source metadata with `generatedBy=contextStill.codexFindingEscalation`.
- Add a third guard in `findingCandidate` source loading to reject those memories if they already exist.

This is a hard gate. Codex escalation is not enabled until self-ingestion guards are verified.

## Implementation Order

### Phase 0: Baseline And Safety Gates

Goal:
Current production drop and routing behavior can be compared after changes.

Tasks:

- Capture daily counts for:
  - `vibe_memories`
  - `finding_candidate_queue` by `last_outcome_kind`
  - `found_candidates`
  - `covering_evidence_queue` by `last_outcome_kind`
  - `finalize_distille_queue`
  - `knowledge_items`
- Capture provider target / lease distribution from `llm_provider_leases`.
- Capture current `settings.v1` providerPools and taskRouting.
- Record current `queue inspect --json`.
- Add a diagnostics note to the implementation PR or change summary.

Verification:

```bash
sqlite3 data/context-still-core.sqlite \
  "select status, last_outcome_kind, count(*) from finding_candidate_queue group by status,last_outcome_kind;"

sqlite3 data/context-still-core.sqlite \
  "select target_id, queue_name, status, release_reason, count(*) from llm_provider_leases group by target_id, queue_name, status, release_reason;"

target/debug/context-stilld queue inspect --json
```

Completion criteria:

- Baseline includes route-to-pool mapping and actual target lease distribution.
- No mutation is performed in this phase.

### Phase 1: Pool-First Routing Core

Goal:
Runtime routing can reserve Qwen #1 for finding and Qwen #2/Gemma for covering/finalize.

Tasks:

- Normalize `RuntimeSettingsRoute.providerPoolId` as the primary route key.
- Ensure `providerPoolIdsForQueue` or equivalent scheduler helper resolves queues by route pool, not by provider name alone.
- Add validation that all pool targets exist and are enabled.
- Add validation that one target does not appear in multiple enabled pools unless global lease enforcement is active.
- Add route fixtures:
  - finding -> `finding-qwen-pool`
  - covering/finalize -> `covering-qwen-or-gemma-pool`
  - episode -> `episode-ornith-pool`
- Make pool full return a wait/null assignment rather than falling through to unrelated targets.

Tests:

```bash
bunx vitest run test/queue-provider-pool-scheduler.test.ts test/queue-worker.test.ts
bunx vitest run test/settings-runtime-cache.test.ts
cargo test -p context-stilld queue_lifecycle
```

Completion criteria:

- finding queue cannot lease covering-only target.
- covering/finalize cannot lease finding-only target.
- episode does not consume Qwen pool when Ornith pool is configured.
- pool full does not call provider.

Stop conditions:

- Existing queue workers can no longer claim jobs.
- Direct provider/model routing breaks without a migration path.
- Rust executor and TypeScript scheduler disagree on pool membership.

### Phase 2: Settings UI For Targets And Pools

Goal:
Operators can define targets and pools without editing JSON.

Tasks:

- Add a Provider Targets section or make existing Local LLM endpoint rows explicitly target-like.
- Add a Provider Pools section:
  - pool name
  - enabled
  - target membership
  - max concurrent
  - stale lease seconds
  - low-priority aging seconds
  - busy policy
- Add per-route pool picker to Task Routing UI.
- Show effective route summary:
  - queue/task
  - primary pool
  - fallback pools
  - effective target list
- Add validation messages:
  - target appears in multiple pools
  - pool has no enabled target
  - route points at disabled pool
  - pool target model does not match endpoint `/v1/models`

Tests:

```bash
bunx vitest run test/components/admin/settings-page.test.tsx
bunx vitest run test/admin/repositories.sources-settings.test.ts
bun run typecheck
```

Completion criteria:

- UI can save and reload pool definitions.
- Task route can point at a pool.
- Existing settings without explicit pools are migrated to `local-llm-default`.

### Phase 3: Codex Escalation Trace-Only

Goal:
Measure whether Codex would recover useful candidates without mutating downstream queues.

Tasks:

- Add escalation eligibility planner for `findingCandidate`.
- Add `finding_candidate_escalations` persistence.
- Add Codex adapter behind a feature flag:
  - `FINDING_CODEX_ESCALATION=trace`
  - no downstream `found_candidates` insertion
  - no covering enqueue
- Add self-ingestion guard before any live Codex call.
- Add trace output:
  - source key
  - primary outcome
  - escalation reason
  - Codex candidate count
  - short output summary
  - rejected reason if any

Tests:

```bash
bunx vitest run test/finding-codex-escalation.test.ts
bunx vitest run test/agent-log-sync.test.ts
bunx vitest run test/vibe-finding-enqueue.service.test.ts
```

Completion criteria:

- Codex is called only when trigger conditions match.
- Trace-only mode never inserts `found_candidates`.
- Codex-generated sessions/logs are excluded from Vibe memory ingestion.
- Existing `findingCandidate` path behaves unchanged when flag is off.

Stop conditions:

- Any Codex escalation log appears as new Vibe memory.
- Escalation runs for low-signal or boilerplate-only memories.
- Codex output cannot be audited without storing full prompts.

### Phase 4: Codex Escalation Write Mode

Goal:
Promote proven Codex second-pass candidates into normal downstream flow.

Entry criteria:

- Trace-only Utility Hit Rate is acceptable.
- Off-topic increase is controlled.
- Self-ingestion guard is verified.
- Operator explicitly enables write mode.

Tasks:

- Add `FINDING_CODEX_ESCALATION=write`.
- Insert accepted Codex candidates into `found_candidates`.
- Enqueue `covering_evidence_queue` only after candidate persistence succeeds.
- Mark escalation status:
  - `accepted`
  - `no_candidate`
  - `parser_rejected`
  - `provider_failed`
  - `self_ingestion_blocked`
- Add queue events for escalated candidates.

Tests:

```bash
bunx vitest run test/queue-worker.test.ts test/finding-codex-escalation.test.ts
bun run verify
```

Completion criteria:

- One source produces at most one active escalation per provider/model/version.
- Accepted candidates enter covering through the same path as primary finding.
- Failed Codex calls do not mark primary job failed retroactively.
- Downstream mutation is confirmed before completed state.

### Phase 5: Fairness And Pool Health

Goal:
Prevent one route from starving another route even inside intended shared pools.

Tasks:

- Add pool health view:
  - active leases
  - target cooldowns
  - pending by queue
  - oldest pending per queue
  - recent provider busy / unsupported / timeout counts
- Add optional fairness policy:
  - `priority_order` for strict priority
  - `round_robin_by_queue` for shared pools
- Add target cooldown on provider busy 503.
- Add operator warning when a route has pending jobs but no eligible targets.

Tests:

```bash
bunx vitest run test/queue-provider-pool-scheduler.test.ts
target/debug/context-stilld queue inspect --json
```

Completion criteria:

- `queue inspect --json` explains blocked reason as pool full, no eligible target, paused queue, or provider cooldown.
- Provider busy does not create noisy failed rows.
- Unsupported model is surfaced as settings error.

## Rollout Plan

### Slice A: Pool Partition Without Codex

Implement phases 0-2 only.

Recommended live routing:

```text
findingCandidate -> finding-qwen-pool
coveringEvidence -> covering-qwen-or-gemma-pool
finalizeDistille -> covering-qwen-or-gemma-pool
episodeDistiller -> episode-ornith-pool
```

Success metrics:

- `findingCandidate` no longer consumes covering/finalize target.
- `coveringEvidence` no longer consumes finding target.
- `no_candidate` rate is measured against a stable Qwen finding route.
- `knowledge_items/day` recovers without Codex.

### Slice B: Codex Trace-Only

Implement phase 3.

Run for several days with:

```text
FINDING_CODEX_ESCALATION=trace
```

Success metrics:

- Codex trace candidates have high estimated usefulness.
- No Codex escalation logs enter Vibe memory.
- Escalation volume is small enough to control cost.

### Slice C: Codex Write Mode

Implement phase 4 only if Slice B shows value.

Write mode should start with a small cap:

```text
maxEscalationsPerDay = 20
maxEscalationsPerSource = 1
```

Success metrics:

- Additional `found_candidates` from Codex pass covering at a useful rate.
- `off_topic` / `insufficient` does not spike.
- No feedback loop appears in Vibe memory.

## Metrics

Track before/after:

| Metric | Definition | Target |
| --- | --- | --- |
| Finding Hit Rate | `candidates_found / (candidates_found + no_candidate)` | Increase |
| Knowledge Production | `knowledge_items` per day | Recover toward previous baseline |
| Covering Ready Rate | `knowledge_ready / covering completed` | No regression |
| Escalation Hit Rate | Codex accepted candidates that pass covering | >= 25% initially |
| Self-Ingestion Count | Codex escalation logs entering `vibe_memories` | 0 |
| Pool Starvation | Pending route with no eligible target while other route consumes target | 0 for dedicated pools |
| Provider Busy Noise | provider busy rows marked as failed | Decrease |

## Verification Commands

```bash
bun run typecheck
bun run lint
bun run format:check
bun run docs:check-links
bunx vitest run test/queue-provider-pool-scheduler.test.ts test/queue-worker.test.ts
bunx vitest run test/settings-runtime-cache.test.ts test/components/admin/settings-page.test.tsx
cargo test -p context-stilld queue_lifecycle
bun run verify
```

Live checks:

```bash
target/debug/context-stilld queue inspect --json

sqlite3 -header -column data/context-still-core.sqlite \
  "select target_id, queue_name, status, release_reason, count(*) from llm_provider_leases group by target_id, queue_name, status, release_reason order by count(*) desc;"

sqlite3 -header -column data/context-still-core.sqlite \
  "select status, last_outcome_kind, count(*) from finding_candidate_queue group by status, last_outcome_kind order by count(*) desc;"

sqlite3 -header -column data/context-still-core.sqlite \
  "select json_extract(metadata,'$.generatedBy') as generated_by, count(*) from vibe_memories group by generated_by;"
```

## Open Questions

- Codex escalation should use direct API/SDK or Codex CLI? Direct API/SDK is preferred because it avoids `.codex/sessions` self-ingestion.
- Should Gemma4 12B be restored as the covering pool target if available?
- Should `finalizeDistille` share with covering or have its own small pool?
- Do we want `round_robin_by_queue` in the first pool implementation, or is dedicated pool partition enough?
- Should provider target health checks call `/v1/models` and validate configured model IDs before queue workers start?

## Decision Recommendation

Implement Pool-first routing first. It fixes the resource contention problem without introducing Codex cost or self-ingestion risk.

Then add Codex escalation in trace-only mode. Codex should remain a second-pass path for high-signal `no_candidate` rows, not the default `findingCandidate` executor.

Recommended first live configuration after Pool-first routing:

```text
finding-qwen-pool:
  Qwen 3.6 27B #1

covering-qwen-or-gemma-pool:
  Qwen 3.6 27B #2 or Gemma4 12B

episode-ornith-pool:
  Ornith 1.0 9B

codex-escalation:
  disabled initially, then trace-only
```
