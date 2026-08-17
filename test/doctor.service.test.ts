import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { getDb } from "../src/db/index.js";
import { getRuntimeSqliteCoreDatabase } from "../src/db/sqlite/runtime.js";
import { getExposedToolEntries } from "../src/mcp/tools/index.js";
import { runDoctor, runDoctorAiServiceTools } from "../src/modules/doctor/doctor.service.js";
import { inspectCompileRuns } from "../src/modules/doctor/inspectors/compile.inspector.js";
import { inspectDatabase } from "../src/modules/doctor/inspectors/database.inspector.js";
import { inspectVibeDistillation } from "../src/modules/doctor/inspectors/vibe-distillation.inspector.js";
import { embeddingHealth } from "../src/modules/embedding/embedding.service.js";
import {
  checkAgenticLlmHealth,
  checkLlmProviderHealthMatrix,
} from "../src/modules/llm/agentic-llm.service.js";
import { resolveAgenticCompileRouting } from "../src/modules/settings/settings.service.js";

vi.mock("../src/db/index.js", () => ({
  db: {
    transaction: vi.fn(),
  },
  getDb: vi.fn(),
}));
vi.mock("../src/db/sqlite/runtime.js", () => ({
  getRuntimeSqliteCoreDatabase: vi.fn(),
}));
vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  cleanupExpiredAuditLogsSafe: vi.fn(),
}));
vi.mock("node:fs/promises");
vi.mock("node:child_process");
vi.mock("../src/mcp/tools/index.js");
vi.mock("../src/modules/embedding/embedding.service.js");
vi.mock("../src/modules/llm/agentic-llm.service.js");
vi.mock("../src/modules/settings/settings.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/settings/settings.service.js")>();
  return {
    ...actual,
    resolveAgenticCompileRouting: vi.fn(),
  };
});
vi.mock("../src/modules/context-compiler/context-compiler.repository.js", () => ({
  listRecentCompileRuns: vi.fn(() => []),
}));

function flattenSqlChunks(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(record.value)) return record.value.join("");
  if ("value" in record && typeof record.value !== "object") return String(record.value);
  if (Array.isArray(record.queryChunks)) return record.queryChunks.map(flattenSqlChunks).join("");
  return String(value);
}

describe("Doctor Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MEMORY_ROUTER_MCP_V2 = "1";
    process.env.CONTEXT_STILL_DB_BACKEND = "postgres";
    vi.mocked(resolveAgenticCompileRouting).mockReturnValue({
      provider: "azure-openai",
      localLlmModel: undefined,
      fallback: [],
      azureDeploymentSlots: undefined,
    } as any);
    vi.mocked(embeddingHealth).mockResolvedValue({
      configured: true,
      provider: "daemon",
      effectiveMode: "daemon",

      daemon: {
        url: "http://localhost:1234",
        reachable: true,
        status: "external_ready",
        managedBy: "external",
      },
      cli: { python: "python3", root: "/tmp", modelDir: "/tmp/models", usable: true },
      openai: { configured: false, model: "" },
    });
    vi.mocked(getExposedToolEntries).mockReturnValue([
      { name: "initial_instructions" },
      { name: "context_compile" },
      { name: "compile_eval" },
      { name: "context_decision" },
      { name: "context_decision_feedback" },
      { name: "search_knowledge" },
      { name: "register_candidates" },
      { name: "search_memory" },
      { name: "fetch_memory" },
      { name: "search_episodes" },
      { name: "fetch_episode" },
      { name: "doctor" },
    ] as any);
    vi.mocked(checkAgenticLlmHealth).mockResolvedValue({
      providerSetting: "azure-openai",
      selectedProvider: "azure-openai",
      fallbackOrder: ["azure-openai"],
      provider: "azure-openai",
      configured: true,
      reachable: true,
      model: "gpt-5-4-mini",
      endpoint: "https://example.openai.azure.com",
    });
    vi.mocked(checkLlmProviderHealthMatrix).mockResolvedValue([
      {
        id: "azure-openai:1",
        label: "Azure OpenAI #1",
        provider: "azure-openai",
        configured: true,
        reachable: true,
        model: "gpt-5-4-mini",
        endpoint: "https://example.openai.azure.com",
        deploymentIndex: 1,
        selected: true,
        routeOrder: 0,
      },
    ]);
  });

  test("returns failed status when DB is unreachable", async () => {
    const mockDb = {
      execute: vi.fn().mockRejectedValue(new Error("Connection refused")),
    };
    vi.mocked(getDb).mockReturnValue(mockDb as any);
    vi.mocked(fs.access).mockResolvedValue(undefined);

    const report = await runDoctor();
    expect(report.status).toBe("failed");
    expect(report.reasons).toContain("DB_UNREACHABLE");
  });

  test("marks advanced server readiness as setup-needed when PostgreSQL is unreachable", async () => {
    process.env.CONTEXT_STILL_DB_BACKEND = "postgres";
    const mockDb = {
      execute: vi.fn().mockRejectedValue(new Error("Connection refused")),
    };
    vi.mocked(getDb).mockReturnValue(mockDb as any);
    vi.mocked(fs.access).mockResolvedValue(undefined);

    const report = await runDoctor();

    expect(report.desktopReadiness).toEqual(
      expect.objectContaining({
        backendCategory: "postgres-server",
        status: "Needs setup",
        defaultBackendReady: false,
      }),
    );
    expect(report.desktopReadiness?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "postgres-server-backend",
          state: "Needs setup",
          scope: "advanced",
        }),
        expect.objectContaining({
          id: "sqlite-local-db",
          state: "Advanced server backend only",
        }),
      ]),
    );
  });

  test("detects missing primary MCP tools", async () => {
    vi.mocked(getExposedToolEntries).mockReturnValue([{ name: "doctor" }] as any);
    const mockDb = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    const report = await runDoctor();
    expect(report.reasons).toContain("MCP_PRIMARY_TOOLS_MISSING");
    expect(report.mcp.missingPrimaryTools).toContain("initial_instructions");
  });

  test("reports stale context compile runs", async () => {
    const { listRecentCompileRuns } = await import(
      "../src/modules/context-compiler/context-compiler.repository.js"
    );
    vi.mocked(listRecentCompileRuns).mockResolvedValue([
      {
        id: "550e8400-e29b-41d4-a716-446655440001",
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        status: "ok",
        degradedReasons: [],
        durationMs: 120,
        selectedItemCount: 1,
        outputMarkdownKind: "narrative",
      },
    ] as any);

    const mockDb = {
      execute: vi.fn().mockResolvedValue({ rows: [{ table_name: "context_compile_runs" }] }),
    };
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    const report = await runDoctor({ freshnessThresholdMinutes: 30 });
    expect(report.reasons).toContain("CONTEXT_COMPILE_STALE");
  });

  test("treats source-only misses with selected context as usable compile runs", async () => {
    const { listRecentCompileRuns } = await import(
      "../src/modules/context-compiler/context-compiler.repository.js"
    );
    vi.mocked(listRecentCompileRuns).mockResolvedValue([
      {
        createdAt: new Date(),
        status: "degraded",
        degradedReasons: ["NO_SOURCE_MATCH"],
        selectedItemCount: 3,
        outputMarkdownKind: "narrative",
        durationMs: 100,
      },
    ] as any);

    const inspection = await inspectCompileRuns({
      windowSize: 20,
      freshnessThresholdMinutes: 30,
      degradedRateThreshold: 0.5,
      compileRunsTableAvailable: true,
    });

    expect(inspection.runs.blockingRuns).toBe(0);
    expect(inspection.runs.usableRuns).toBe(1);
    expect(inspection.runs.warningOnlyRuns).toBe(1);
    expect(inspection.reasons).not.toContain("DEGRADED_RATE_HIGH");
    expect(inspection.reasons).not.toContain("USABLE_PACK_RATE_LOW");
  });

  test("detects missing vector extension and stale knowledge", async () => {
    const mockDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ ok: 1 }] }) // select 1
        .mockResolvedValueOnce({ rows: [{ installed: false }] }) // vector extension check
        .mockResolvedValueOnce({
          rows: [{ table_name: "knowledge_items" }, { table_name: "sources" }],
        }) // tables check
        .mockResolvedValueOnce({ rows: [{ count: 5 }] }) // stale knowledge
        .mockResolvedValueOnce({
          rows: [
            {
              draft_count: 1,
              oldest_draft_at: new Date(),
            },
          ],
        }) // hitl backlog
        .mockResolvedValueOnce({
          rows: [
            {
              active_count: 3,
              zero_use_active_count: 2,
              stale_by_decay_count: 1,
              stale_procedure_count: 1,
              dynamic_score_avg: 42,
              dynamic_score_p95: 88,
              last_compiled_at: new Date(),
            },
          ],
        }),
    };
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    const report = await runDoctor();
    expect(report.reasons).toContain("VECTOR_EXTENSION_MISSING");
    expect(report.mcp.staleKnowledgeCount).toBe(5);
    expect(report.mcp.staleSourceCount).toBe(0);
  });

  test("inspects agent log sync states", async () => {
    const mockDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ ok: 1 }] }) // select 1
        .mockResolvedValueOnce({ rows: [{ installed: true }] }) // vector
        .mockResolvedValueOnce({ rows: [{ table_name: "sync_states" }] }), // tables
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "codex_logs",
          lastSyncedAt: `unix-ms:${Date.now()}`,
          updatedAt: `unix-ms:${Date.now()}`,
          cursor: {},
          metadata: { warnings: ["Low disk"] },
        },
      ]),
    };
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    const report = await runDoctor();
    expect(report.agentLogSync.states).toHaveLength(1);
    expect(report.agentLogSync.states[0].warnings).toContain("Low disk");
  });

  test("inspects distillation run history", async () => {
    const mockDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ ok: 1 }] }) // select 1
        .mockResolvedValueOnce({ rows: [{ installed: true }] }) // vector
        .mockResolvedValueOnce({
          rows: [{ table_name: "finding_candidate_queue" }],
        }) // tables
        .mockResolvedValue({ rows: [{ total_runs: 10, ok_runs: 8, last_run_at: new Date() }] }),
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    const report = await runDoctor();
    expect(report.vibeDistillation.runs.totalRuns).toBe(10);
    expect(report.sourceDistillation.runs.totalRuns).toBe(10);
  });

  test("uses sqlite terminal queue rows for vibe distillation run history", async () => {
    process.env.CONTEXT_STILL_DB_BACKEND = "sqlite";
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(execFileSync).mockReturnValue("state = running\n" as any);

    const sqliteDb = {
      query: vi.fn((query: string) => {
        if (query.includes("status, last_outcome_kind")) {
          return {
            all: vi.fn(() => [
              {
                status: "completed",
                last_outcome_kind: "candidates_found",
                ended_at: "2026-06-26T06:12:13.686Z",
              },
              {
                status: "skipped",
                last_outcome_kind: "source_missing",
                ended_at: "2026-06-26T06:19:46.253Z",
              },
            ]),
          };
        }
        if (query.includes("status, last_error")) {
          return {
            all: vi.fn(() => [
              {
                status: "completed",
                last_error: null,
                updated_at: "2026-06-26T06:12:13.686Z",
              },
            ]),
          };
        }
        return {
          all: vi.fn(() => [
            {
              source_kind: "vibe_memory",
              status: "completed",
              created_at: "2026-06-26T06:12:13.000Z",
              locked_at: null,
              heartbeat_at: null,
              updated_at: "2026-06-26T06:12:13.686Z",
              next_run_at: null,
              last_error: null,
            },
          ]),
        };
      }),
    };
    vi.mocked(getRuntimeSqliteCoreDatabase).mockResolvedValue({ db: sqliteDb } as any);

    const report = await inspectVibeDistillation({ canQueryDb: true });

    expect(report.runs.totalRuns).toBe(2);
    expect(report.runs.okRuns).toBe(1);
    expect(report.runs.lastRunAt).toBe("2026-06-26T06:19:46.253Z");
    expect(report.runs.lastOkRunAt).toBe("2026-06-26T06:12:13.686Z");
  });

  test("keeps sqlite vector health time out of the DB response metric", async () => {
    process.env.CONTEXT_STILL_DB_BACKEND = "sqlite";
    vi.mocked(execFileSync).mockImplementation(() => {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 20) {
        // Simulate a slow current vector health check without using a cache.
      }
      return JSON.stringify({ vecUsable: true }) as any;
    });

    const sqliteDb = {
      query: vi.fn((query: string) => {
        if (query.includes("select 1")) {
          return { get: vi.fn(() => ({ ok: 1 })) };
        }
        return { all: vi.fn(() => []) };
      }),
    };
    vi.mocked(getRuntimeSqliteCoreDatabase).mockResolvedValue({
      db: sqliteDb,
      path: "/tmp/context-still-test.sqlite",
      vector: { available: false },
    } as any);

    const inspection = await inspectDatabase({
      freshnessThresholdMinutes: 30,
      staleDecayFactor: 0.5,
      zeroUseWarningMinActiveCount: 10,
    });

    expect(inspection.vector.healthMs).toBeGreaterThanOrEqual(15);
    expect(inspection.db.responseMs).toBeLessThan(inspection.vector.healthMs ?? 0);
    expect(inspection.db.durationMs).toBe(Math.round(inspection.db.responseMs));
  });

  test("inspects launch agents via launchctl", async () => {
    vi.mocked(fs.access).mockResolvedValue(undefined); // Plist exists
    vi.mocked(execFileSync).mockReturnValue("state = running\n" as any);

    const mockDb = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    const report = await runDoctor();
    expect(report.agentLogSync.launchAgent.loaded).toBe(true);
    expect(report.agentLogSync.launchAgent.state).toBe("running");
  });

  test("reports knowledge value update failures from recent audit logs", async () => {
    const mockDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
        .mockResolvedValueOnce({ rows: [{ installed: true }] })
        .mockResolvedValueOnce({
          rows: [
            { table_name: "knowledge_items" },
            { table_name: "sources" },
            { table_name: "audit_logs" },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ count: 0 }] })
        .mockResolvedValueOnce({
          rows: [
            {
              draft_count: 0,
              oldest_draft_at: null,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              active_count: 10,
              zero_use_active_count: 0,
              stale_by_decay_count: 0,
              stale_procedure_count: 0,
              dynamic_score_avg: 10,
              dynamic_score_p95: 20,
              last_compiled_at: new Date(),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // unknown tags count
        .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // negative without origin count
        .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // negative as positive count
        .mockResolvedValueOnce({ rows: [{ count: 2 }] }), // audit_logs check count
    };
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    const report = await runDoctor();
    expect(report.reasons).toContain("KNOWLEDGE_VALUE_UPDATE_FAILED");
  });

  test("detects stale agent log sync state", async () => {
    const mockDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
        .mockResolvedValueOnce({ rows: [{ installed: true }] })
        .mockResolvedValueOnce({ rows: [{ table_name: "sync_states" }] }),
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "codex_logs",
          lastSyncedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
          cursor: {},
          metadata: { warnings: [] },
        },
      ]),
    };
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    const report = await runDoctor({ freshnessThresholdMinutes: 30 });
    expect(report.reasons).toContain("CODEX_LOGS_SYNC_STALE");
  });

  test("uses the last sync check time for agent log freshness", async () => {
    const mockDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
        .mockResolvedValueOnce({ rows: [{ installed: true }] })
        .mockResolvedValueOnce({ rows: [{ table_name: "sync_states" }] }),
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "antigravity_logs",
          lastSyncedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
          updatedAt: new Date(),
          cursor: { "task.log": {} },
          metadata: { syncedAt: new Date().toISOString(), warnings: [] },
        },
      ]),
    };
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    const report = await runDoctor({ freshnessThresholdMinutes: 30 });

    expect(report.reasons).not.toContain("ANTIGRAVITY_LOGS_SYNC_STALE");
    expect(report.agentLogSync.states[0]?.lastSyncedAgeMinutes).toBeGreaterThan(30);
    expect(report.agentLogSync.states[0]?.lastCheckedAgeMinutes).toBeLessThan(30);
  });

  test("detects embedding provider unavailable when daemon unreachable and cli unusable", async () => {
    vi.mocked(embeddingHealth).mockResolvedValue({
      configured: true,
      provider: "daemon",
      effectiveMode: "unavailable",
      daemon: {
        url: "http://localhost:1234",
        reachable: false,
        status: "offline",
        managedBy: "none",
      },
      cli: { python: "python3", root: "/tmp", modelDir: "/tmp/models", usable: false },
      openai: { configured: false, model: "" },
    });

    const mockDb = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    const report = await runDoctor();
    expect(report.reasons).toContain("EMBEDDING_PROVIDER_UNAVAILABLE");
  });

  test("detects an unconfigured OpenAI embedding provider", async () => {
    vi.mocked(embeddingHealth).mockResolvedValue({
      configured: true,
      provider: "openai",
      effectiveMode: "openai",
      daemon: {
        url: "http://localhost:1234",
        reachable: false,
        status: "not_required",
        managedBy: "none",
      },
      cli: { python: "python3", root: "/tmp", modelDir: "/tmp/models", usable: false },
      openai: { configured: false, model: "", error: "API key is empty" },
    });
    vi.mocked(getDb).mockReturnValue({
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    } as any);

    const report = await runDoctor();

    expect(report.reasons).toContain("EMBEDDING_PROVIDER_UNAVAILABLE");
  });

  test("detects agentic llm issues when disabled or unreachable", async () => {
    vi.mocked(checkAgenticLlmHealth).mockResolvedValue({
      providerSetting: "azure-openai",
      selectedProvider: "azure-openai",
      fallbackOrder: [],
      provider: "azure-openai",
      configured: false,
      reachable: false,
      model: "",
      endpoint: "",
    });

    const mockDb = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    let report = await runDoctor();
    expect(report.reasons).toContain("AGENTIC_LLM_NOT_CONFIGURED");

    vi.mocked(checkAgenticLlmHealth).mockResolvedValue({
      providerSetting: "azure-openai",
      selectedProvider: "azure-openai",
      fallbackOrder: [],
      provider: "azure-openai",
      configured: true,
      reachable: false,
      model: "",
      endpoint: "",
    });

    report = await runDoctor();
    expect(report.reasons).toContain("AGENTIC_LLM_UNREACHABLE");
  });

  test("AI service-tools domain does not run database inspection", async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("AI service-tools domain should not inspect the database");
    });

    const report = await runDoctorAiServiceTools();

    expect(report.agenticLlm.reachable).toBe(true);
    expect(report.mcp.exposedTools).toContain("doctor");
    expect(report.mcp.staleKnowledgeCount).toBe(0);
    expect(report.mcp.staleSourceCount).toBe(0);
    expect(getDb).not.toHaveBeenCalled();
  });

  test("AI service-tools domain selects local LLM health by the resolved provider model", async () => {
    vi.mocked(getDb).mockImplementation(() => {
      throw new Error("AI service-tools domain should not inspect the database");
    });
    vi.mocked(resolveAgenticCompileRouting).mockReturnValue({
      provider: "local-llm",
      localLlmModel: "qwen3",
      fallback: ["openai", "local-llm"],
      azureDeploymentSlots: undefined,
    } as any);
    vi.mocked(checkAgenticLlmHealth).mockResolvedValue({
      providerSetting: "openai",
      selectedProvider: "local-llm",
      fallbackOrder: ["openai", "local-llm"],
      provider: "local-llm",
      configured: true,
      reachable: true,
      model: "qwen3",
      endpoint: "http://127.0.0.1:11434",
    });

    await runDoctorAiServiceTools();

    const providerHealthCall = vi.mocked(checkLlmProviderHealthMatrix).mock.calls.at(-1);
    expect(providerHealthCall?.[1]).not.toHaveProperty("verifyLocalLlmGeneration");
    expect(checkLlmProviderHealthMatrix).toHaveBeenCalledWith(
      5000,
      expect.objectContaining({
        selectedProvider: "local-llm",
        routeOrder: ["openai", "local-llm"],
        selectedLocalLlmModel: "qwen3",
      }),
    );
    expect(getDb).not.toHaveBeenCalled();
  });

  test("detects negative knowledge diagnostics and warnings", async () => {
    const mockDb = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ ok: 1 }] })
        .mockResolvedValueOnce({ rows: [{ installed: true }] })
        .mockResolvedValueOnce({
          rows: [
            { table_name: "knowledge_items" },
            { table_name: "sources" },
            { table_name: "audit_logs" },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ count: 0 }] })
        .mockResolvedValueOnce({
          rows: [
            {
              draft_count: 0,
              oldest_draft_at: null,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              active_count: 10,
              zero_use_active_count: 0,
              stale_by_decay_count: 0,
              stale_procedure_count: 0,
              dynamic_score_avg: 10,
              dynamic_score_p95: 20,
              last_compiled_at: new Date(),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ count: 2 }] }) // unknown tags count
        .mockResolvedValueOnce({ rows: [{ count: 3 }] }) // negative without provenance count
        .mockResolvedValueOnce({ rows: [{ count: 1 }] }) // negative as positive count
        .mockResolvedValueOnce({ rows: [{ count: 0 }] }), // audit_logs check count
    };
    vi.mocked(getDb).mockReturnValue(mockDb as any);

    const report = await runDoctor();
    expect(report.reasons).toContain("KNOWLEDGE_UNKNOWN_INTENT_TAGS");
    expect(report.reasons).toContain("KNOWLEDGE_NEGATIVE_WITHOUT_ORIGIN");
    expect(report.reasons).toContain("KNOWLEDGE_NEGATIVE_AS_POSITIVE");

    const executedSql = mockDb.execute.mock.calls
      .map(([query]) => flattenSqlChunks(query))
      .join("\n");
    expect(executedSql).toContain("operational_risk");
    expect(executedSql).toContain("data_integrity");
    expect(executedSql).toContain("knowledge_origin_links");
    expect(executedSql).toContain("knowledge_source_links");
    expect(executedSql).toContain("sourceDocumentUri");
  });
});
