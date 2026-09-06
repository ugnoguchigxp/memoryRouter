import { beforeEach, describe, expect, test, vi } from "vitest";
import { groupedConfig } from "../src/config.js";
import type { LlmProviderHttpError } from "../src/modules/llm/provider-http-error.js";
import { createLocalLlmProvider } from "../src/modules/llm/providers/local-llm.provider.js";

vi.mock("../src/config.js", () => ({
  groupedConfig: {
    localLlm: {
      apiBaseUrl: "http://127.0.0.1:44448",
      apiKey: "",
      model: "gemma-4-e4b-it",
      models: [],
    },
  },
}));

describe("local-llm provider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    groupedConfig.localLlm.apiBaseUrl = "http://127.0.0.1:44448";
    groupedConfig.localLlm.apiKey = "";
    groupedConfig.localLlm.model = "gemma-4-e4b-it";
    groupedConfig.localLlm.models = [];
  });

  test("healthCheck uses the lightweight health endpoint when available", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "ok",
        ready: true,
        loaded: true,
        modelId: "gemma-4-e4b-it",
      }),
    } as unknown as Response);

    const status = await createLocalLlmProvider({ timeoutMs: 1000 }).healthCheck();

    expect(status).toMatchObject({
      provider: "local-llm",
      configured: true,
      reachable: true,
      model: "gemma-4-e4b-it",
      endpoint: "http://127.0.0.1:44448",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:44448/health");
  });

  test("healthCheck can target a configured local model", async () => {
    groupedConfig.localLlm.models = [
      {
        name: "Primary",
        apiBaseUrl: "http://127.0.0.1:44448",
        apiPath: "/v1/chat/completions",
        model: "gemma-4-e4b-it",
      },
      {
        name: "Qwen",
        apiBaseUrl: "http://127.0.0.1:44449",
        apiPath: "/v1/chat/completions",
        model: "qwen-3.6-14b-it",
      },
    ];
    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "ok",
        ready: true,
        loaded: true,
        modelId: "qwen-3.6-14b-it",
      }),
    } as unknown as Response);

    const status = await createLocalLlmProvider({ timeoutMs: 1000 }).healthCheck({
      model: "qwen-3.6-14b-it",
    });

    expect(status).toMatchObject({
      provider: "local-llm",
      configured: true,
      reachable: true,
      model: "qwen-3.6-14b-it",
      endpoint: "http://127.0.0.1:44449",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:44449/health");
  });

  test("healthCheck reports not-ready health payloads without waiting for chat", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "loading",
        ready: false,
        loaded: false,
        preloadError: "model is loading",
      }),
    } as unknown as Response);

    const status = await createLocalLlmProvider({ timeoutMs: 1000 }).healthCheck();

    expect(status.reachable).toBe(false);
    expect(status.error).toContain("model is loading");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("healthCheck falls back to chat when the health endpoint is not available", async () => {
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "not found",
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
        }),
      } as unknown as Response);

    const status = await createLocalLlmProvider({ timeoutMs: 1000 }).healthCheck();

    expect(status.reachable).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[0]).toBe("http://127.0.0.1:44448/v1/chat/completions");
    expect(JSON.parse(spy.mock.calls[1]?.[1]?.body as string).max_tokens).toBe(8);
  });

  test("chat does not append a second v1 segment when base URL already includes v1", async () => {
    groupedConfig.localLlm.apiBaseUrl = "http://127.0.0.1:44448/v1";
    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
      }),
    } as unknown as Response);

    const response = await createLocalLlmProvider({ timeoutMs: 1000 }).chat({
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 8,
      temperature: 0,
    });

    expect(response.content).toBe("pong");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:44448/v1/chat/completions");
  });

  test("chat uses the selected Local LLM endpoint API key", async () => {
    groupedConfig.localLlm.apiKey = "primary-key";
    groupedConfig.localLlm.models = [
      {
        name: "Primary",
        apiBaseUrl: "http://127.0.0.1:44448",
        apiPath: "/v1/chat/completions",
        apiKey: "primary-key",
        model: "gemma-4-e4b-it",
      },
      {
        name: "Qwen",
        apiBaseUrl: "http://127.0.0.1:50041",
        apiPath: "/v1/chat/completions",
        apiKey: "qwen-key",
        model: "qwen-3.6-27b",
      },
    ];
    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
      }),
    } as unknown as Response);

    await createLocalLlmProvider({ timeoutMs: 1000 }).chat({
      model: "qwen-3.6-27b",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 8,
      temperature: 0,
    });

    expect(spy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:50041/v1/chat/completions");
    expect(spy.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer qwen-key",
    });
  });

  test("healthCheck discovers an agent-session model through the runtime model list", async () => {
    const spy = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "muse/muse-spark-1.3-contributor",
              runtime: "muse",
            },
          ],
          runtime: { id: "muse", status: "ready", detail: null },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const status = await createLocalLlmProvider({
      timeoutMs: 1000,
      modelConfig: {
        apiBaseUrl: "http://127.0.0.1:44449",
        apiPath: "/v1/agents/sessions",
        model: "muse/muse-spark-1.3-contributor",
      },
    }).healthCheck();

    expect(status).toMatchObject({
      provider: "local-llm",
      configured: true,
      reachable: true,
      model: "muse/muse-spark-1.3-contributor",
      endpoint: "http://127.0.0.1:44449",
    });
    expect(spy.mock.calls[0]?.[0]).toBe("http://127.0.0.1:44449/v1/agents/models?runtime=muse");
  });

  test("chat runs an agent session turn, reads SSE output, and releases the session", async () => {
    const events = [
      'event: message.delta\ndata: {"data":{"text":"po"}}',
      'event: message.delta\ndata: {"data":{"text":"ng"}}',
      'event: message.completed\ndata: {"data":{"text":"pong"}}',
      'event: turn.completed\ndata: {"data":{"terminal":"completed"}}',
      "",
    ].join("\n\n");
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "ags_test",
            events_url: "/v1/agents/sessions/ags_test/events",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "agt_test", status: "accepted" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(events, { status: 200, headers: { "content-type": "text/event-stream" } }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const response = await createLocalLlmProvider({
      timeoutMs: 1000,
      modelConfig: {
        apiBaseUrl: "http://127.0.0.1:44449",
        apiPath: "/v1/agents/sessions",
        model: "muse/muse-spark-1.3-contributor",
      },
    }).chat({
      messages: [
        { role: "system", content: "Answer briefly." },
        { role: "user", content: "ping" },
      ],
      maxTokens: 8,
      temperature: 0,
    });

    expect(response).toMatchObject({ content: "pong", finishReason: "stop" });
    expect(spy.mock.calls.map((call) => call[0])).toEqual([
      "http://127.0.0.1:44449/v1/agents/sessions",
      "http://127.0.0.1:44449/v1/agents/sessions/ags_test/turns",
      "http://127.0.0.1:44449/v1/agents/sessions/ags_test/events",
      "http://127.0.0.1:44449/v1/agents/sessions/ags_test/release",
    ]);
    for (const callIndex of [0, 1, 3]) {
      expect(spy.mock.calls[callIndex]?.[1]?.headers).toMatchObject({
        "Idempotency-Key": expect.stringMatching(/^contextstill:/),
      });
    }
    const createBody = JSON.parse(spy.mock.calls[0]?.[1]?.body as string);
    expect(createBody).toEqual({
      runtime: "muse",
      model: "muse/muse-spark-1.3-contributor",
      approval_policy: "strict",
    });
    const turnBody = JSON.parse(spy.mock.calls[1]?.[1]?.body as string);
    expect(turnBody.input[0].text).toContain("<system>\nAnswer briefly.\n</system>");
    expect(turnBody.input[0].text).toContain("<user>\nping\n</user>");
  });

  test("chat preserves 503 Retry-After as LlmProviderHttpError", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: false,
      status: 503,
      headers: new Headers({
        "retry-after": "30",
        "x-request-id": "busy-1",
      }),
      text: async () => JSON.stringify({ error: "llm_busy", retryable: true }),
    } as unknown as Response);

    const provider = createLocalLlmProvider({ timeoutMs: 1000 });
    await expect(
      provider.chat({
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 8,
        temperature: 0,
      }),
    ).rejects.toMatchObject({
      name: "LlmProviderHttpError",
      provider: "local-llm",
      status: 503,
      retryAfterSeconds: 30,
      requestId: "busy-1",
    } satisfies Partial<LlmProviderHttpError>);
  });

  test("uses providerOptions.modelConfig when request model is missing", async () => {
    const provider = createLocalLlmProvider({
      modelConfig: {
        apiBaseUrl: "http://options-url",
        model: "options-model",
      },
    });

    const spy = vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
      }),
    } as unknown as Response);

    const response = await provider.chat({
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 100,
    });

    expect(response.content).toBe("pong");
    expect(spy.mock.calls[0]?.[0]).toBe("http://options-url/v1/chat/completions");
  });

  test("healthCheck handles AbortError correctly", async () => {
    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";
    vi.spyOn(global, "fetch").mockRejectedValue(abortError);

    const provider = createLocalLlmProvider({ timeoutMs: 1000 });
    const status = await provider.healthCheck();

    expect(status.reachable).toBe(false);
    expect(status.error).toBe("The operation was aborted.");
  });

  test("healthCheck handles fallback chat failure", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as unknown as Response)
      .mockRejectedValueOnce(new Error("Chat failed"));

    const provider = createLocalLlmProvider({ timeoutMs: 1000 });
    const status = await provider.healthCheck();

    expect(status.reachable).toBe(false);
    expect(status.error).toBe("Chat failed");
  });
});
