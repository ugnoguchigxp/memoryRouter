import { describe, expect, test } from "vitest";
import {
  applySectionTokenBudget,
  estimateTokens,
  estimatedTokenWeight,
  isCjkCodePoint,
  isWhitespaceCodePoint,
  truncateForBudget,
} from "../src/modules/context-compiler/token-budget.js";
import type { ContextPackItem } from "../src/shared/schemas/context-pack.schema.js";

describe("Token Budget Utilities", () => {
  describe("isWhitespaceCodePoint", () => {
    test("detects standard whitespace characters", () => {
      expect(isWhitespaceCodePoint(" ".charCodeAt(0))).toBe(true);
      expect(isWhitespaceCodePoint("\t".charCodeAt(0))).toBe(true);
      expect(isWhitespaceCodePoint("\n".charCodeAt(0))).toBe(true);
    });

    test("detects Unicode whitespace characters", () => {
      expect(isWhitespaceCodePoint("\u3000".charCodeAt(0))).toBe(true); // 全角スペース
      expect(isWhitespaceCodePoint("\u00a0".charCodeAt(0))).toBe(true); // NO-BREAK SPACE
      expect(isWhitespaceCodePoint("\ufeff".charCodeAt(0))).toBe(true); // ZERO WIDTH NO-BREAK SPACE
    });

    test("returns false for non-whitespace characters", () => {
      expect(isWhitespaceCodePoint("a".charCodeAt(0))).toBe(false);
      expect(isWhitespaceCodePoint("あ".charCodeAt(0))).toBe(false);
    });
  });

  describe("isCjkCodePoint", () => {
    test("detects CJK characters", () => {
      expect(isCjkCodePoint("あ".charCodeAt(0))).toBe(true); // ひらがな
      expect(isCjkCodePoint("ア".charCodeAt(0))).toBe(true); // カタカナ
      expect(isCjkCodePoint("漢".charCodeAt(0))).toBe(true); // 漢字
      expect(isCjkCodePoint("ｱ".charCodeAt(0))).toBe(true); // 半角カタカナ
      expect(isCjkCodePoint("안".charCodeAt(0))).toBe(true); // ハングル
    });

    test("returns false for non-CJK characters", () => {
      expect(isCjkCodePoint("a".charCodeAt(0))).toBe(false);
      expect(isCjkCodePoint("1".charCodeAt(0))).toBe(false);
      expect(isCjkCodePoint("!".charCodeAt(0))).toBe(false);
    });
  });

  describe("estimatedTokenWeight", () => {
    test("assigns correct weights to various characters", () => {
      expect(estimatedTokenWeight(" ")).toBe(0.15);
      expect(estimatedTokenWeight("a")).toBe(0.25);
      expect(estimatedTokenWeight("あ")).toBe(0.8);
      expect(estimatedTokenWeight("😀")).toBe(1.0);
    });

    test("returns 0 for empty strings", () => {
      expect(estimatedTokenWeight("")).toBe(0);
    });
  });

  describe("estimateTokens", () => {
    test("calculates token estimate for ASCII strings", () => {
      // "hello" -> 5 * 0.25 = 1.25 -> ceil = 2
      expect(estimateTokens("hello")).toBe(2);
    });

    test("calculates token estimate for CJK strings", () => {
      // "こんにちは" -> 5 * 0.8 = 4.0 -> ceil = 4
      expect(estimateTokens("こんにちは")).toBe(4);
    });

    test("calculates token estimate for mixed strings", () => {
      // "helloこんにちは " -> (5 * 0.25) + (5 * 0.8) + 0.15 = 1.25 + 4.0 + 0.15 = 5.4 -> ceil = 6
      expect(estimateTokens("helloこんにちは ")).toBe(6);
    });

    test("returns at least 1 for empty or near-empty strings", () => {
      expect(estimateTokens("")).toBe(1);
    });
  });

  describe("truncateForBudget", () => {
    test("does not truncate if content is within budget", () => {
      const content = "hello";
      // "hello" is 2 tokens, budget is 5
      expect(truncateForBudget(content, 5)).toBe(content);
    });

    test("truncates and adds suffix if content exceeds budget", () => {
      const content = "abcdefghij"; // 10 chars * 0.25 = 2.5 tokens
      // Limit to 1 token (suffix "..." is 3 chars * 0.25 = 0.75 tokens, so max content tokens is very small)
      const result = truncateForBudget(content, 1);
      expect(result.endsWith("...")).toBe(true);
      expect(estimateTokens(result)).toBeLessThanOrEqual(1);
    });

    test("returns minimum truncated string for extremely small budget", () => {
      expect(truncateForBudget("hello", 1)).toBe("h...");
    });
  });

  describe("applySectionTokenBudget", () => {
    test("returns empty list if input is empty", () => {
      const result = applySectionTokenBudget([], 100);
      expect(result).toEqual({ items: [], dropped: false });
    });

    test("selects all items if they fit in budget", () => {
      const items: ContextPackItem[] = [
        {
          id: "item1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Title 1",
          content: "Content 1",
          score: 1.0,
          rankingReason: "reason",
          sourceRefs: [],
        },
        {
          id: "item2",
          itemKind: "rule",
          itemId: "r2",
          section: "rules",
          title: "Title 2",
          content: "Content 2",
          score: 0.9,
          rankingReason: "reason",
          sourceRefs: [],
        },
      ];
      // Title 1 + Content 1 + reason is well within 100 tokens
      const result = applySectionTokenBudget(items, 100);
      expect(result.items.length).toBe(2);
      expect(result.dropped).toBe(false);
    });

    test("truncates and drops remaining items when budget is exceeded", () => {
      const items: ContextPackItem[] = [
        {
          id: "item1",
          itemKind: "rule",
          itemId: "r1",
          section: "rules",
          title: "Title 1",
          content: "Very long content indeed. ".repeat(20), // ~100 tokens
          score: 1.0,
          rankingReason: "reason",
          sourceRefs: [],
        },
        {
          id: "item2",
          itemKind: "rule",
          itemId: "r2",
          section: "rules",
          title: "Title 2",
          content: "Content 2",
          score: 0.9,
          rankingReason: "reason",
          sourceRefs: [],
        },
      ];

      // Give a tiny budget that only fits part of the first item
      const result = applySectionTokenBudget(items, 10);
      expect(result.items.length).toBe(1);
      expect(result.dropped).toBe(true);
      expect(result.items[0].content.endsWith("...")).toBe(true);
    });

    test("never exceeds the section budget when title and ranking metadata are long", () => {
      const item: ContextPackItem = {
        id: "item1",
        itemKind: "rule",
        itemId: "r1",
        section: "rules",
        title: "A title that consumes the entire section budget by itself".repeat(3),
        content: "Evidence that must not make the rendered item exceed its budget.",
        score: 1,
        rankingReason: "A verbose ranking explanation".repeat(3),
        sourceRefs: [],
      };

      const result = applySectionTokenBudget([item], 10);
      expect(result).toEqual({ items: [], dropped: true });
    });
  });
});
