import { describe, expect, test } from "vitest";
import { contextCompileTool } from "../src/mcp/tools/context-compile.tool.js";

describe("context_compile static tool contract", () => {
  test("exposes additive repository identity without exposing internal compile controls", () => {
    expect(contextCompileTool.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["goal"],
    });
    const properties = (
      contextCompileTool.inputSchema as { properties?: Record<string, Record<string, unknown>> }
    ).properties;
    const noControlsPattern = "^[^\\u0000-\\u001F\\u007F-\\u009F]+$";
    expect(properties?.projectRef).toMatchObject({
      type: "string",
      maxLength: 256,
      pattern: noControlsPattern,
    });
    expect(properties?.repoKey).toMatchObject({
      type: "string",
      maxLength: 1024,
      pattern: noControlsPattern,
    });
    expect(properties?.repoPath).toMatchObject({
      type: "string",
      maxLength: 4096,
      pattern: noControlsPattern,
    });
    expect(properties).not.toHaveProperty("queryEmbedding");
    expect(properties).not.toHaveProperty("tokenBudget");
    expect(properties).not.toHaveProperty("includeDraft");
  });

  test("runtime handler rejects internal and unknown controls before database access", async () => {
    await expect(
      contextCompileTool.handler({ goal: "Strict MCP input", tokenBudget: 1000 }),
    ).rejects.toThrow();
    await expect(
      contextCompileTool.handler({ goal: "Strict MCP input", unexpectedIdentity: "repo-A" }),
    ).rejects.toThrow();
    await expect(
      contextCompileTool.handler({ goal: "Strict MCP input", projectRef: "project-A\n" }),
    ).rejects.toThrow();
  });
});
