import { describe, expect, test } from "vitest";
import { buildInitialInstructionsText } from "../src/shared/locales/initial-instructions.js";
import { resolveLocale } from "../src/shared/locales/locale.js";

describe("locale helpers", () => {
  test("resolveLocale falls back to ja", () => {
    expect(resolveLocale(undefined)).toBe("ja");
    expect(resolveLocale("fr")).toBe("ja");
  });

  test("resolveLocale accepts ja/en and locale variants", () => {
    expect(resolveLocale("ja")).toBe("ja");
    expect(resolveLocale("ja-JP")).toBe("ja");
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("en-US")).toBe("en");
  });

  test("buildInitialInstructionsText returns localized headings", () => {
    expect(buildInitialInstructionsText("ja")).toContain("## 常用ルール");
    expect(buildInitialInstructionsText("en")).toContain("## Operational Rules");
  });

  test("initial instructions emphasize primary tools over supplemental tools", () => {
    const ja = buildInitialInstructionsText("ja");
    const en = buildInitialInstructionsText("en");

    for (const text of [ja, en]) {
      expect(text).toContain("initial_instructions");
      expect(text).toContain("context_compile");
      expect(text).toContain("compile_eval");
      expect(text).toContain("context_decision");
      expect(text).toContain("context_decision_feedback");
      expect(text).not.toContain("`register_candidates`");
      expect(text).not.toContain("`register_candidate`");
      expect(text).not.toContain("`session_memo`");
      expect(text).not.toContain("Use when:");
      expect(text).not.toContain("Workflow:");
      expect(text).not.toContain("Verification:");
      expect(text).not.toContain("Avoid:");
    }

    expect(ja).toContain("## 主要MCPツール");
    expect(ja).toContain("ブロッカー由来");
    expect(ja).toContain("pre-question gate");
    expect(ja).toContain("`reject` を返した場合");
    expect(ja).toContain("pre-commit");
    expect(ja).toContain("その他の公開ツールは補助機能");
    expect(ja).not.toContain("プロジェクト依存の記述を除いて");
    expect(ja).not.toContain("title / body / avoid / prefer の自然文は日本語");
    expect(ja).not.toContain("SKILL.md 相当");
    expect(en).toContain("## Primary MCP Tools");
    expect(en).toContain("blocker-derived");
    expect(en).toContain("pre-question gate");
    expect(en).toContain("returns `reject`");
    expect(en).toContain("pre-commit");
    expect(en).toContain("Other exposed tools are supplemental");
    expect(en).not.toContain("remove project-specific wording");
    expect(en).not.toContain("title / body / avoid / prefer natural language in Japanese");
    expect(en).not.toContain("SKILL.md-like shape");
  });
});
