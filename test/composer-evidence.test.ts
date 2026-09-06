import { describe, expect, it } from "vitest";
import { composerEvidence } from "../src/modules/context-compiler/composer-evidence.js";

describe("composer evidence", () => {
  it("retains later sentences, negation, exact numbers and code layout", () => {
    const content =
      "Use Foundation ranking. Knowledge is limited to 8; episodes to 3.\nDo not accept relative paths.";
    expect(composerEvidence(content)).toEqual({ text: content, truncated: false });
  });
  it("bounds Unicode evidence and explicitly marks omitted middle text", () => {
    const value = composerEvidence(`START ${"🙂".repeat(1400)} END do not write`);
    expect(Array.from(value.text)).toHaveLength(1200);
    expect(value.truncated).toBe(true);
    expect(value.text.startsWith("START ")).toBe(true);
    expect(value.text.endsWith("END do not write")).toBe(true);
    expect(value.text).toContain("[... omitted ...]");
  });
});
