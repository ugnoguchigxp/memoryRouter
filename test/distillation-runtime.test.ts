import { describe, expect, test } from "vitest";
import {
  type DistillationChatClient,
  type DistillationToolExecutor,
  buildBedrockConversation,
  buildBedrockToolConfig,
  distillationToolEventsFromError,
  parseBedrockResponse,
  parseOpenAiStyleResponse,
  parseToolCalls,
  runDistillationCompletion,
} from "../src/modules/distillation/distillation-runtime.service.js";
import { normalizeDistillationSearchQuery } from "../src/modules/distillation/distillation-tools.service.js";

describe("distillation runtime", () => {
  test("normalizes search queries before evidence cache lookup", () => {
    expect(normalizeDistillationSearchQuery("  TanStack   Query　API  ")).toBe(
      "tanstack query api",
    );
  });

  test("executes tool calls and feeds results back before final JSON", async () => {
    const seenMessages: unknown[] = [];
    const chatClient: DistillationChatClient = async (request) => {
      seenMessages.push(request.messages.map((message) => ({ ...message })));
      if (seenMessages.length === 1) {
        expect(request.tools?.map((tool) => tool.function.name)).toEqual([
          "search_web",
          "fetch_content",
        ]);
        return {
          content: null,
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "fetch_content",
                arguments: '{"url":"https://example.com/docs"}',
              },
            },
          ],
        };
      }

      expect(request.toolChoice).toBe("auto");
      expect(request.messages.some((message) => message.role === "tool")).toBe(true);
      return {
        content:
          '{"candidates":[{"type":"rule","title":"Use cited docs","body":"Use fetched documentation before preserving external behavior claims.","confidence":90,"importance":70}]}',
        finishReason: "stop",
        toolCalls: [],
      };
    };
    const toolExecutor: DistillationToolExecutor = async (toolCall, auditContext) => {
      expect(auditContext).toMatchObject({ candidateRowId: "candidate-1" });
      return {
        callId: toolCall.id,
        name: toolCall.function.name,
        ok: true,
        content: '{"url":"https://example.com/docs","text":"Fetched documentation body"}',
      };
    };

    const result = await runDistillationCompletion(
      {
        model: "gemma-4-e4b-it",
        messages: [
          { role: "system", content: "Return JSON." },
          { role: "user", content: "https://example.com/docs" },
        ],
        maxTokens: 256,
      },
      {
        chatClient,
        toolExecutor,
        maxToolRounds: 2,
        auditContext: { candidateRowId: "candidate-1" },
      },
    );

    expect(result.content).toContain('"candidates"');
    expect(result.toolEvents).toHaveLength(1);
    expect(result.messages.some((message) => message.role === "tool")).toBe(true);
  });

  test("can require the first verification round to call a tool", async () => {
    const seenToolChoices: unknown[] = [];
    const chatClient: DistillationChatClient = async (request) => {
      seenToolChoices.push(request.toolChoice);
      if (seenToolChoices.length === 1) {
        return {
          content: null,
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search_web", arguments: '{"query":"memory router"}' },
            },
          ],
        };
      }
      return {
        content: '{"candidates":[]}',
        toolCalls: [],
      };
    };
    const toolExecutor: DistillationToolExecutor = async (toolCall) => ({
      callId: toolCall.id,
      name: toolCall.function.name,
      ok: true,
      content: "Search evidence",
    });

    await runDistillationCompletion(
      { model: "m", messages: [{ role: "user", content: "verify" }], maxTokens: 10 },
      { chatClient, toolExecutor, requireToolCall: true },
    );

    expect(seenToolChoices).toEqual(["required", "auto"]);
  });

  test("forwards per-call timeout to the chat client", async () => {
    const seenTimeouts: Array<number | undefined> = [];
    const chatClient: DistillationChatClient = async (request) => {
      seenTimeouts.push(request.timeoutMs);
      return {
        content: '{"candidates":[]}',
        toolCalls: [],
      };
    };

    await runDistillationCompletion(
      { model: "m", messages: [{ role: "user", content: "verify" }], maxTokens: 10 },
      { chatClient, timeoutMs: 123_456 },
    );

    expect(seenTimeouts).toEqual([123_456]);
  });

  test("feeds over-limit tool calls back without executing them", async () => {
    let chatCalls = 0;
    let executedTools = 0;
    const offeredToolsByCall: string[][] = [];
    const chatClient: DistillationChatClient = async (request) => {
      chatCalls += 1;
      offeredToolsByCall.push(request.tools?.map((tool) => tool.function.name) ?? []);
      if (chatCalls === 3) {
        return {
          content: '{"candidates":[]}',
          toolCalls: [],
        };
      }
      return {
        content: null,
        toolCalls: [
          {
            id: `call_${chatCalls}`,
            type: "function",
            function: { name: "search_web", arguments: '{"query":"memory router"}' },
          },
        ],
      };
    };
    const toolExecutor: DistillationToolExecutor = async (toolCall) => {
      executedTools += 1;
      return {
        callId: toolCall.id,
        name: toolCall.function.name,
        ok: true,
        content: "Search evidence",
      };
    };

    const result = await runDistillationCompletion(
      { model: "m", messages: [{ role: "user", content: "verify" }], maxTokens: 10 },
      {
        chatClient,
        toolExecutor,
        maxToolRounds: 4,
        toolCallLimits: { search_web: 1, fetch_content: 3 },
      },
    );

    expect(result.content).toBe('{"candidates":[]}');
    expect(executedTools).toBe(1);
    expect(offeredToolsByCall[0]).toContain("search_web");
    expect(offeredToolsByCall[1]).not.toContain("search_web");
    expect(offeredToolsByCall[1]).toContain("fetch_content");
    expect(result.toolEvents).toHaveLength(2);
    expect(result.toolEvents[1]).toMatchObject({
      name: "search_web",
      ok: false,
      metadata: { limit: 1, limitExceeded: true },
    });
  });

  test("does not offer zero-limit tools to a required tool call", async () => {
    const offeredToolsByCall: string[][] = [];
    const seenToolChoices: unknown[] = [];
    const chatClient: DistillationChatClient = async (request) => {
      offeredToolsByCall.push(request.tools?.map((tool) => tool.function.name) ?? []);
      seenToolChoices.push(request.toolChoice);
      return {
        content: null,
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "fetch_content", arguments: '{"url":"https://example.com"}' },
          },
        ],
      };
    };
    const toolExecutor: DistillationToolExecutor = async (toolCall) => ({
      callId: toolCall.id,
      name: toolCall.function.name,
      ok: true,
      content: "Fetched content",
    });

    await expect(
      runDistillationCompletion(
        { model: "m", messages: [{ role: "user", content: "verify" }], maxTokens: 10 },
        {
          chatClient,
          toolExecutor,
          maxToolRounds: 1,
          requireToolCall: true,
          toolCallLimits: { search_web: 0, fetch_content: 1 },
        },
      ),
    ).rejects.toThrow("distillation tool loop exceeded max rounds");

    expect(seenToolChoices[0]).toBe("required");
    expect(offeredToolsByCall[0]).not.toContain("search_web");
    expect(offeredToolsByCall[0]).toContain("fetch_content");
  });

  test("reprompts once when required tool use is skipped", async () => {
    const seenToolChoices: unknown[] = [];
    const seenMessages: string[][] = [];
    const chatClient: DistillationChatClient = async (request) => {
      seenToolChoices.push(request.toolChoice);
      seenMessages.push(request.messages.map((message) => String(message.content ?? "")));
      if (seenToolChoices.length === 1) {
        return {
          content: '{"candidates":[{"type":"rule","title":"Premature","body":"No tool yet"}]}',
          toolCalls: [],
        };
      }
      if (seenToolChoices.length === 2) {
        expect(request.messages.at(-1)?.content).toContain("tool call が必須");
        return {
          content: null,
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search_web", arguments: '{"query":"memory router"}' },
            },
          ],
        };
      }
      return {
        content: '{"candidates":[]}',
        toolCalls: [],
      };
    };
    const toolExecutor: DistillationToolExecutor = async (toolCall) => ({
      callId: toolCall.id,
      name: toolCall.function.name,
      ok: true,
      content: "Search evidence",
    });

    const result = await runDistillationCompletion(
      { model: "m", messages: [{ role: "user", content: "verify" }], maxTokens: 10 },
      { chatClient, toolExecutor, requireToolCall: true },
    );

    expect(result.toolEvents).toHaveLength(1);
    expect(seenToolChoices).toEqual(["required", "required", "auto"]);
    expect(seenMessages[1]?.some((content) => content.includes("直前の応答"))).toBe(true);
  });

  test("reprompts once when the final assistant response is blank", async () => {
    const seenMessages: string[][] = [];
    const chatClient: DistillationChatClient = async (request) => {
      seenMessages.push(request.messages.map((message) => String(message.content ?? "")));
      if (seenMessages.length === 1) {
        return {
          content: "",
          toolCalls: [],
        };
      }
      expect(request.messages.at(-1)?.content).toContain("TYPE: rule");
      expect(request.messages.at(-1)?.content).toContain(
        "TYPE / TITLE / BODY のような見出し行だけを出さない",
      );
      return {
        content: '{"candidates":[]}',
        toolCalls: [],
      };
    };

    const result = await runDistillationCompletion(
      {
        model: "m",
        messages: [{ role: "user", content: "distill" }],
        maxTokens: 10,
      },
      { chatClient },
    );

    expect(result.content).toBe('{"candidates":[]}');
    expect(seenMessages).toHaveLength(2);
  });

  test("throws error when tool rounds exceeded", async () => {
    const chatClient: DistillationChatClient = async () => ({
      content: null,
      toolCalls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
    });
    const toolExecutor: DistillationToolExecutor = async () => ({
      callId: "c1",
      name: "t",
      ok: true,
      content: "",
    });

    let thrown: unknown;
    try {
      await runDistillationCompletion(
        { model: "m", messages: [], maxTokens: 10 },
        { chatClient, toolExecutor, maxToolRounds: 1 },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("distillation tool loop exceeded max rounds");
    expect(distillationToolEventsFromError(thrown)).toHaveLength(1);
    expect(distillationToolEventsFromError(thrown)[0]).toMatchObject({ name: "t", ok: true });
  });

  test("throws error when response content is missing", async () => {
    const chatClient: DistillationChatClient = async () => ({
      content: null,
      toolCalls: [],
    });

    let thrown: unknown;
    try {
      await runDistillationCompletion({ model: "m", messages: [], maxTokens: 10 }, { chatClient });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "distillation response did not include assistant content",
    );
    expect(distillationToolEventsFromError(thrown)).toHaveLength(0);
  });

  describe("parsing helpers", () => {
    test("parseToolCalls extracts function info", () => {
      const raw = [
        {
          id: "call_1",
          type: "function",
          function: { name: "test_tool", arguments: '{"a":1}' },
        },
      ];
      const result = parseToolCalls(raw);
      expect(result).toHaveLength(1);
      expect(result[0].function.name).toBe("test_tool");
      expect(result[0].function.arguments).toBe('{"a":1}');
    });

    test("parseToolCalls fills missing function tool type", () => {
      const raw = [
        {
          id: "call_1",
          function: { name: "test_tool", arguments: '{"a":1}' },
        },
      ];

      const result = parseToolCalls(raw);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: "call_1",
        type: "function",
        function: { name: "test_tool", arguments: '{"a":1}' },
      });
    });

    test("parseOpenAiStyleResponse maps choices to chat response", () => {
      const raw = {
        choices: [{ message: { content: "hello", tool_calls: [] }, finish_reason: "stop" }],
      };
      const result = parseOpenAiStyleResponse(raw);
      expect(result.content).toBe("hello");
      expect(result.finishReason).toBe("stop");
    });

    test("parseOpenAiStyleResponse recovers tool call when model returns call JSON in content", () => {
      const raw = {
        choices: [
          {
            message: {
              content: '{"name":"search_web","arguments":{"query":"memory router"}}',
              tool_calls: [],
            },
            finish_reason: "stop",
          },
        ],
      };

      const result = parseOpenAiStyleResponse(raw);
      expect(result.content).toBeNull();
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toMatchObject({
        type: "function",
        function: {
          name: "search_web",
          arguments: '{"query":"memory router"}',
        },
      });
    });

    test("parseOpenAiStyleResponse prefers explicit tool_calls over content recovery", () => {
      const raw = {
        choices: [
          {
            message: {
              content: '{"name":"search_web","arguments":{"query":"ignored"}}',
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "fetch_content", arguments: '{"url":"https://example.com"}' },
                },
              ],
            },
          },
        ],
      };

      const result = parseOpenAiStyleResponse(raw);
      expect(result.content).toBe('{"name":"search_web","arguments":{"query":"ignored"}}');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]?.function.name).toBe("fetch_content");
    });
  });

  describe("bedrock conversion", () => {
    test("buildBedrockConversation handles system, user, assistant and tool messages", () => {
      const messages: any[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "ok",
          tool_calls: [{ id: "c1", function: { name: "t", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "done" },
      ];
      const result = buildBedrockConversation(messages);

      expect(result.system).toEqual([{ text: "sys" }]);
      expect(result.messages).toHaveLength(3); // user, assistant, tool-result-as-user
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[1].role).toBe("assistant");
      expect(result.messages[2].role).toBe("user"); // Bedrock expects tool results as user role
    });

    test("buildBedrockToolConfig maps distillation tools to bedrock specs", () => {
      const tools: any[] = [
        { function: { name: "t1", description: "d1", parameters: { type: "object" } } },
      ];
      const result = buildBedrockToolConfig(tools);
      expect(result?.tools).toHaveLength(1);
      expect((result?.tools?.[0] as any).toolSpec.name).toBe("t1");
    });

    test("buildBedrockToolConfig can require a tool call", () => {
      const tools: any[] = [
        { function: { name: "t1", description: "d1", parameters: { type: "object" } } },
      ];
      const result = buildBedrockToolConfig(tools, "required");
      expect(result?.toolChoice).toEqual({ any: {} });
    });

    test("parseBedrockResponse extracts text and tool calls", () => {
      const raw = {
        output: {
          message: {
            content: [
              { text: "thinking" },
              { toolUse: { toolUseId: "c1", name: "t1", input: { x: 1 } } },
            ],
          },
        },
        stopReason: "tool_use",
      };
      const result = parseBedrockResponse(raw);
      expect(result.content).toBe("thinking");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].id).toBe("c1");
      expect(result.toolCalls[0].function.name).toBe("t1");
    });
  });
});
