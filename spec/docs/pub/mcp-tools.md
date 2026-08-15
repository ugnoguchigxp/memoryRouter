# MCP Tools

context-still exposes a compact MCP surface for coding agents. The tools are designed around this repeatable workflow:

```text
initial_instructions -> context_compile -> context_decision as a pre-question gate when a blocker-derived decision would stop progress -> work or stop on reject -> context_decision_feedback when the decision outcome is known -> compile_eval
```

## Client Registration

Register the daemon-owned streamable HTTP endpoint in MCP clients:

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

Use `bun run setup:mcp-config` to update Codex and Antigravity configs. Command-based context-still MCP registration has been removed and must not be restored.

## Primary Tool Inventory

| Tool                        | Primary use                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `initial_instructions`      | Load operating rules and hook guidance once per project session                                       |
| `context_compile`           | Compile task-specific context before work                                                             |
| `compile_eval`              | Record post-task usefulness scores for compiled context                                               |
| `context_decision`          | Decide execute/revise/reject/rollback/discard/escalate from Knowledge evidence before asking the user |
| `context_decision_feedback` | Record Good/Bad or system/AI outcome feedback for a decision                                          |

## Supplemental Tool Inventory

These tools remain exposed for focused inspection, diagnostics, and explicit knowledge maintenance, but they are not part of the normal primary workflow.

| Tool                    | Supplemental use                                                             |
| ----------------------- | ---------------------------------------------------------------------------- |
| `search_knowledge`      | Inspect raw knowledge candidates and retrieval behavior                       |
| `register_candidates`   | Register positive or negative rule/procedure candidates in one call           |
| `search_memory`         | Search past sessions and diffs                                                |
| `fetch_memory`          | Fetch one memory item                                                         |
| `doctor`                | Diagnose DB, embedding, sync, queue, provider, decision, and compile health   |

Deprecated hidden aliases remain for compatibility but are not listed:

- `memory_search` -> `search_memory`
- `memory_fetch` -> `fetch_memory`

## Recommended Agent Workflow

1. Call `initial_instructions` once when starting work in this project.
2. Call `context_compile` with the actual task goal and, for workspace tasks, a stable `projectRef`, explicit `repoKey`, or absolute `repoPath`.
3. Call `context_decision` before asking the user when the next response would be a confirmation question and autonomous progress might still be possible.
4. Do the work and verify changes, unless the decision is `reject`.
5. If `context_decision` returns `reject`, stop the target action and report or wait for confirmation instead of continuing implementation, file changes, or PR creation.
6. Call `context_decision_feedback` after work based on a decision completes, including at pre-commit time when the outcome is known.
7. Call `compile_eval` for the compile run used during the task.

Supplemental tools can be used when clearly needed, for example `doctor` for runtime health diagnostics, `search_memory` / `fetch_memory` for past-session lookup, `search_knowledge` for retrieval debugging, or `register_candidates` for explicit durable knowledge maintenance.

## Tool Contracts

### `initial_instructions`

Purpose: Return project operating guidance for agents.

Input: none.

Output:

- Common rules.
- Primary MCP tool categories.
- Hook/compile evaluation reminders.

Use once at project-session start. Do not call before every small subtask unless the session context has been lost.

### `context_compile`

Purpose: Produce a task-specific context pack.

Input:

| Field          | Required | Description                                                                            |
| -------------- | -------: | -------------------------------------------------------------------------------------- |
| `goal`         |      yes | Natural-language task goal. Use a milestone or problem statement, not a document path. |
| `changeTypes`  |       no | Tags such as `bugfix`, `docs`, `backend`, `plan`.                                      |
| `technologies` |       no | Technology tags such as `typescript`, `bun`, `react`.                                  |
| `domains`      |       no | Domain tags such as `context-compiler`, `onboarding`, `queue`.                         |
| `projectRef`   |       no | Stable opaque project selection identity. This is not an authorization token.          |
| `repoKey`      |       no | Explicit legacy repository key. It is not derived from `repoPath`.                     |
| `repoPath`     |       no | Absolute lexical repository path or local absolute `file://` URI.                      |

Output:

- Markdown context pack.
- Compile run metadata.
- Diagnostics and degraded reasons when available.

Behavior:

- The result emphasizes implementation focus, steps, and verification points.
- Project identity is normalized once and persisted in the compile run/task trace; daemon cwd is not used as caller identity.
- Until repository enforcement is enabled in a later rollout phase, these fields are additive trace/contract data and do not by themselves prove authorization.
- If no useful knowledge is selected, output can be `No Content`.
- A weak compile result should not stop the workflow. Use `doctor`, docs, and direct repository inspection to supplement it.

### `compile_eval`

Purpose: Persist a post-task evaluation of a compile run.

Input:

| Field           | Required | Description                                                                          |
| --------------- | -------: | ------------------------------------------------------------------------------------ |
| `outcome`       |      yes | `useful`, `partial`, `misleading`, or `unused`.                                      |
| `body`          |      yes | Short rationale.                                                                     |
| `relevance`     |      yes | `0` to `100`, how well the pack matched the goal.                                    |
| `actionability` |      yes | `0` to `100`, how directly it supported implementation or judgment.                  |
| `coverage`      |      yes | `0` to `100`, whether required information was covered.                              |
| `clarity`       |      yes | `0` to `100`, where `100` means clean and low-noise.                                 |
| `specificity`   |      yes | `0` to `100`, whether the pack was concrete rather than abstract.                    |
| `runId`         |       no | Explicit compile run ID. If omitted, latest session compile is used when resolvable. |
| `title`         |       no | Short label for the evaluation.                                                      |

Use after completing the task that used `context_compile`.

### `context_decision`

Purpose: Make an autonomous blocker-derived decision from Knowledge evidence before asking the user.

Input:

| Field            | Required | Description                                                                       |
| ---------------- | -------: | --------------------------------------------------------------------------------- |
| `decisionPoint`  |      yes | Decision brief: the decision that would otherwise block progress or ask the user. |
| `retrievalHints` |       no | Structured search hints: `technologies`, `changeTypes`, `domains`.                |
| `sessionId`      |       no | External session/thread identifier.                                               |
| `metadata`       |       no | Optional branch, PR, Todo, task, or caller metadata.                              |

Behavior:

- Builds four Knowledge searches: support, counter-evidence, prior user preference, and risk/guardrail.
- Persists the decision run, selected evidence, coverage traces, confidence trace, and metadata.
- Returns one decision, not a menu of options.
- Use it as a pre-question gate when the agent's next response would ask the user for confirmation but autonomous progress may still be possible.
- Use it for decisions that would otherwise block progress, such as proceed vs revise, reject, rollback, discard, escalation, PR creation readiness, risky operations, or unfinished Todo/status handling.
- Treat `reject` as a stop condition. Do not continue the rejected action; report the decision or wait for user confirmation instead.
- In the current v1 implementation, `execute` is returned when Knowledge support clears the confidence threshold; otherwise it returns `escalate`.

Output is compact and intended to stay under an 8k token response budget. It includes `decisionId`, decision, mandate, confidence, the LLM-written `agentMessage`, coverage summary, and feedback handle. Evidence bodies and source refs are not returned by the MCP tool; they remain persisted for audit and can be inspected from the Decision screen/detail API. The generated `agentMessage` may use short selected-Knowledge excerpts to explain the supporting prior tendency, best-practice rule, or procedure guidance.

### `context_decision_feedback`

Purpose: Feed Good/Bad or system/AI outcome feedback back into the decision record and effects table after work based on a decision completes.

Input:

| Field        |    Required | Description                                                       |
| ------------ | ----------: | ----------------------------------------------------------------- |
| `decisionId` |         yes | ID returned by `context_decision`.                                |
| `source`     |         yes | `human`, `ai`, or `system`.                                       |
| `value`      | conditional | Human `good` or `bad`.                                            |
| `outcome`    | conditional | AI/system outcome such as `success`, `failed`, or `discarded_pr`. |
| `reason`     |          no | Short inferred reason.                                            |
| `metadata`   |          no | Optional trace data.                                              |

Human feedback is intentionally Good/Bad only.

Record feedback as soon as the outcome is known. Pre-commit is an appropriate point when verification has completed and the result of the decision is clear.

### `search_knowledge`

Purpose: Inspect raw retrieval candidates when compile output needs investigation.

Input:

| Field          | Required | Description                                    |
| -------------- | -------: | ---------------------------------------------- |
| `query`        |      yes | Search query.                                  |
| `repoPath`     |       no | Scope search to a repository path.             |
| `changeTypes`  |       no | Change-type tags.                              |
| `technologies` |       no | Technology tags.                               |
| `domains`      |       no | Domain tags.                                   |
| `types`        |       no | Knowledge types such as `rule` or `procedure`. |
| `statuses`     |       no | Knowledge statuses.                            |
| `limit`        |       no | Maximum result count.                          |
| `includeDraft` |       no | Include draft knowledge.                       |

Output includes candidates, scores, status, scope, source refs, metadata, degraded reasons, and stats.

### `register_candidates`

Purpose: Register multiple durable knowledge candidates. Use this for both ordinary positive lessons and negative guardrails/review corrections.

Input:

| Field   | Required | Description                         |
| ------- | -------: | ----------------------------------- |
| `items` |      yes | Array of 1 to 10 candidate objects. |

Candidate item fields:

| Field          | Required                        | Description                                                                 |
| -------------- | ------------------------------: | --------------------------------------------------------------------------- |
| `title`        |                              no | Clear candidate title. If omitted, the server infers it from `body`/`text`. |
| `body`         | conditional                     | Candidate body. Required unless `text` is provided, or negative `avoid`/`prefer` are provided. |
| `text`         | conditional                     | Raw note or JSON-like candidate text alternative to `body`.                 |
| `type`         |                              no | `rule` or `procedure`; negative candidates are normalized to `rule`.        |
| `polarity`     |                              no | `positive`, `negative`, or `neutral`; omitted defaults to positive behavior. |
| `avoid`        | negative without `body`/`text`; optional for procedures | Failure, decision, implementation, or operation to avoid. For non-negative `type: "procedure"`, it may populate a missing `Avoid:` section. |
| `prefer`       | negative without `body`/`text`  | Safer decision, implementation, or operation to prefer.                     |
| `technologies` | negative                        | Non-empty applicability tags for concrete stacks, runtimes, languages, or libraries. |
| `changeTypes`  | negative                        | Non-empty applicability tags for change categories such as `implementation`, `testing`, or `diagnosis`. |
| `domains`      | negative                        | Non-empty applicability tags for product or engineering domains.            |
| `appliesTo`    | no                              | Existing applicability object. For negative candidates it must include `technologies`, `changeTypes`, and `domains` if the top-level fields are omitted. |
| `general`      | no                              | Set only when the candidate is intentionally cross-repository. Negative candidates still require `changeTypes` and `domains`. |
| `intentTags`   | no                              | Optional retrieval/role tags such as `guardrail` or `failure_pattern`.      |
| `metadata`     | no                              | Optional caller metadata such as source system or review finding ID.        |

Behavior is best-effort. Inspect the result for per-item failures.

Negative example:

```json
{
  "items": [
    {
      "title": "Avoid trusting queue counts alone",
      "polarity": "negative",
      "avoid": "Assuming a pending count proves the worker is progressing.",
      "prefer": "Check persisted queue rows, worker events, and runtime logs together.",
      "technologies": ["sqlite"],
      "changeTypes": ["diagnosis"],
      "domains": ["queue"],
      "intentTags": ["guardrail", "failure_pattern"],
      "metadata": {
        "source": "human-review",
        "reviewFindingId": "queue-count-truth"
      }
    }
  ]
}
```

### `search_memory`

Purpose: Search past conversations and diffs.

Input:

| Field            | Required | Description                               |
| ---------------- | -------: | ----------------------------------------- |
| `query`          |      yes | Search query.                             |
| `sessionId`      |       no | Restrict to a session.                    |
| `limit`          |       no | Maximum result count.                     |
| `includeContent` |       no | Include full content instead of previews. |
| `previewChars`   |       no | Preview length.                           |

### `fetch_memory`

Purpose: Fetch a specific memory item.

Input:

| Field               | Required | Description                      |
| ------------------- | -------: | -------------------------------- |
| `id`                |      yes | Memory ID.                       |
| `start`             |       no | Start offset or line boundary.   |
| `end`               |       no | End offset or line boundary.     |
| `maxChars`          |       no | Maximum returned characters.     |
| `query`             |       no | Highlight/search hint.           |
| `includeAgentDiffs` |       no | Include related diff entries.    |
| `returnMetaOnly`    |       no | Return metadata without content. |

### `doctor`

Purpose: Diagnose system health.

Input: none.

Output includes:

- DB and expected table status.
- Desktop readiness summary for the selected backend.
- SQLite vector or advanced server vector status.
- Embedding provider status.
- LLM provider health.
- Agent log sync state.
- Queue and distillation state.
- Compile run health.
- Knowledge lifecycle warnings.

Use when task context is unexpectedly empty, stale, degraded, or when automation appears stopped.

## Failure Handling

| Condition                                            | Recommended response                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `context_compile` returns `No Content`               | Run `doctor`, inspect docs/code, and continue with direct repository evidence. |
| `doctor` reports DB failure                          | Check the selected backend, SQLite path or server `DATABASE_URL`, and migrations. |
| Search tools return no matches                       | Broaden query/tags, inspect source imports, and check knowledge status.        |
| Candidate registration succeeds but no draft appears | Check queue status and distillation logs.                                      |

## Client Configuration

Generic MCP client configuration:

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

Call `initial_instructions` once after the client connects to this project.
