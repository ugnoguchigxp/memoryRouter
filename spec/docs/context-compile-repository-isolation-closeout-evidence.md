# Context Compile Repository Isolation Closeout Evidence

## Status

Status: implementation and enforced canary complete; producer observation and 24-hour/final audit gates pending.

- Observation started: 2026-08-15 22:15 JST（2026-08-15T13:15Z）
- Earliest 24-hour gate audit: 2026-08-16 22:15 JST（2026-08-16T13:15Z）
- Active runtime: resident Rust `context-stilld`、12 Rust-native MCP tools、TypeScript sidecar 0
- Effective database: `/Users/y.noguchi/Code/contextStill/data/context-still-core.sqlite`

上記のearliest archive decisionは24-hour canaryだけの下限である。producer observationはenabled manifest確定後に7日、identity-bearing PERSISTED 200件、coverage 100%、new unresolved 0を要求するため、実際のarchive日はこれより後になる可能性がある。観測期間中にSafety Gate違反、新規unresolved producer、またはnormal workspaceのavailability回帰が発生した場合はarchiveせず、`global_only_safe_mode`またはexact/text pathで原因を修正する。unscoped fallbackは復活させない。

## Delivered Contract

- CLI compileは`--repo-path`または明示`--global`を必須にし、cwdをidentityへ昇格しない。
- markdown/source importはcontent rootとproject rootを分離し、repo/global scopeを明示する。
- Rust/TypeScript producerはcaptured project rootだけをrepo identityへ使い、project name、content root、cwdから`repoKey`を生成しない。
- repo-scoped writeはcanonical identityを必須にし、identityなしを自動global化しない。
- Knowledge、EpisodeCard、Sourceのmigrationはdeterministic provenanceとreview decisionだけを使用する。
- Rust-native compile/searchと公開継続するTypeScript pathは、`classification_status=classified`かつglobalまたは選択basis完全一致をlimit/ranking前に適用する。
- unscoped fallbackとunscoped vector laneを無効化し、scope decisionをrun、pack、usage、candidate traceへ保存する。
- replayはidentity snapshotを保持し、identity不明のlegacy runを`not_comparable`として扱う。cache semanticsはversion 2、cacheは既定無効である。

## Live Migration Evidence

### Backup And Rehearsal

- Offline backup: `/Users/y.noguchi/Library/Application Support/contextStill/backup/core-unix-ms-1786799658660.sqlite`
- Backup size: 1,175,113,728 bytes
- Backup SHA-256: `862570d04a66ef7dbbeae13fbd17a757fafe10914c68a5dd82aedcc7c2067119`
- Dry-run checksum（2回一致）: `eec9a33dbce715ff4276c25ac8ac59c6ef94f21a0b9171f8f680990b2f0e3ff9`
- Temp-copy write: 5,943 updates、14,007 migration audit rows。再実行更新0。
- Temp-copy restore drill: backupから復元後、review対象rowが`unresolved`へ戻り、migration audit 0を確認。
- Live DB `PRAGMA integrity_check`: `ok`
- Applied additive revisions: 1-5。revision 2がidentity contract、4がbackfill auditを所有する。

### Review And Write Result

- Top-50 review artifact: [review decisions](.archived/context-compile-repository-isolation-top50-review.json)
- Review audit: 50 `REPOSITORY_IDENTITY_REVIEW_DECISION` events
- Migration batch audit: 29 events
- Migration row audit: 14,007 rows
- Live write: 5,943 rows updated。write後のdry-runは14,007 rowsすべてunchanged。

| Entity | classified global | classified repo | unresolved |
| --- | ---: | ---: | ---: |
| Knowledge | 29 | 69 | 7,129 |
| EpisodeCard | 0 | 5,761 | 841 |
| Source | 0 | 79 | 99 |

未分類long tailは削除も推測分類もしていない。normal retrievalからfail-closedで除外されるため、残数0はcloseout条件ではない。

## Enforced Canary Evidence

### Shadow Deviation Decision

計画上のside-effect-free shadow 50 callsを個別modeとして収集する前にenforcementを有効化した。代わりに、切替直前50 runとidentity-present enforced 50 runを同じSafety/Availability/Performance指標で比較し、wrong-scope candidate/pack hard zeroとnegative fixtureを確認した。既にuser-visible enforced cohortが成功しているため、後からlegacy candidateを再び通常pathで扱うshadowを追加せず、この比較cohortをshadow目的の代替evidenceとする。shadow-only contentをcomposerへ送らないinvariantはfixture/unit testで検証する。

### Identity-Present Cohort

50 compile callsを2026-08-15 22:15-22:23 JSTに実行した。全runは`repo_path=/Users/y.noguchi/Code/contextStill`、`match_basis=repo_path`、`scope_mode=project`、identity contract version 1を保存した。

| Safety metric | Result |
| --- | ---: |
| request/run identity mismatch | 0 |
| wrong-scope or unclassified Knowledge in pack | 0 |
| wrong-scope or unclassified EpisodeCard in pack | 0 |
| missing selected Knowledge/EpisodeCard | 0 |
| new unresolved Knowledge/EpisodeCard/Source during cohort | 0 |

### Availability And Performance

比較条件は切替直前50 runとidentity-present canary 50 runである。

| Metric | Baseline | Canary | Gate |
| --- | ---: | ---: | --- |
| No Content | 0/50 | 0/50 | pass |
| median selected Knowledge | 8 | 8 | pass |
| median selected EpisodeCard | 3 | 3 | pass |
| persisted duration p50 | 11,761 ms | 8,958 ms | pass（-23.8%） |
| persisted duration p95 | 19,050 ms | 14,922 ms | pass（-21.7%） |

31/50 canary runsはexternal composerのgoal-alignment failureによりfallback compositionとなり`degraded`だった。candidate、pack、No Content、latencyのrelease gateは通過しておりrepository isolation違反ではないが、24-hour observationではこの既存composer laneも継続観測する。

### Negative Smoke

| Case | Persisted behavior | Violation |
| --- | --- | ---: |
| identity omitted | `match_basis=none`、`scope_mode=global_only` | 0 |
| `contextStill` / `contextStill-shadow` prefix collision | distinct exact `repo_path` basis | 0 |
| Repo B `/Users/y.noguchi/Code/NightWorkers` | exact Repo B scope | 0 |
| nonexistent absolute path | exact path scope、global以外は完全一致のみ | 0 |
| relative malformed path | `INVALID_REPO_PATH`、run未保存 | 0 |

path case、malformed percent encoding、selected-basis欠落、limit saturation（Knowledge 501超、Episode 201超）、composer on/off outboundはshared TypeScript fixtureとRust native testsで検証した。

## Producer Observation

producer監査はVALIDATED、REJECTED、PERSISTEDを分離し、completion判定にはdurable write後のPERSISTEDだけを使用する。reportは`--enabled-producers`で宣言した全producerの観測を要求し、manifest省略、空、未観測producerありをfail closedにする。

2026-08-15 22:35 JSTのlive read-only audit結果:

| Event | Count | Interpretation |
| --- | ---: | --- |
| legacy `PROJECT_IDENTITY_PRODUCER_ACCEPTED` | 5 | completion対象外 |
| `PROJECT_IDENTITY_PRODUCER_PERSISTED` | 0 | 7-day/200-event window未開始 |

resident-onlyの暫定manifest（`agent-log-sync.rust`、`episode-distiller.rust`、`register-candidates.rust`）でreportを実行すると、missing 3、coverage 0、completion falseとなる。TypeScript/API/maintenance surfaceを含む最終manifestはruntime reachability分類後に確定する。

残作業はruntime active、maintenance-only、test-only、disabledのproducer inventoryを確定し、active名をmanifestへ保存したうえで、7日以上・identity-bearing PERSISTED 200件以上・coverage 100%・new unresolved 0を実観測することである。人工的なfixture writeをlive completion countへ含めない。

## Verification

2026-08-15に次を実行した。

- `cargo test -p context-stilld`: 243 passed
- `cargo clippy --workspace --all-targets -- -D warnings`: pass（third-party `sqlite-vec` C compiler warningのみ）
- `cargo fmt --all -- --check`: pass
- targeted repository identity/backfill/replay tests: 88 passed
- `bun run typecheck`: pass
- `bun run lint`: 801 files pass
- `bun run verify`: pass（system-context checks、typecheck、lint、format、unit tests、web build）
- `bun run rust:mcp:smoke`: 12 Rust-native tools、0 TypeScript sidecars
- `bun run mcp:smoke:sqlite`: pass against resident port 39172
- `bun run docs:check-links`: pass

最初の`bun run verify` rerunで、repoPathをrepoKeyへ派生しなくなった新contractに対する旧test expectationを1件検出し、expectationをcanonical repoPathへ修正した。修正後の全gateはpassした。24-hour observation終了時にも同じcommandを再実行する。

## Archive Checklist

- [x] P0 caller identity adoption and resident deployment
- [x] P1 producer identity write contract and durable audit semantics
- [x] P2 reviewed deterministic migration and rollback drill
- [x] P3 active Rust/TypeScript retrieval enforcement
- [x] P4 replay compatibility and cache stale handling
- [x] 50 identity-present calls and hard-zero Safety Gate
- [x] negative smoke, Availability Gate, Performance Gate
- [x] live backup, write, post-write idempotence, integrity check
- [x] enforced comparison cohort accepted as documented shadow deviation
- [ ] enabled producer inventory/manifest is fixed
- [ ] 7 days、identity-bearing PERSISTED 200件、enabled coverage 100%、new unresolved 0
- [ ] 24 hours elapsed with no Safety Gate violation
- [ ] final read-only audit and `bun run verify` closeout rerun
- [ ] move this document, the plan, and T0 evidence to `spec/docs/.archived/`; update `spec/docs/README.md`
