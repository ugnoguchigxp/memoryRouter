import { describe, expect, test } from "vitest";
import { suppressNearDuplicateKnowledge } from "../src/modules/context-compiler/duplicate-suppression.service.js";

describe("suppressNearDuplicateKnowledge", () => {
  test("keeps higher-ranked representative and suppresses near duplicate", () => {
    const result = suppressNearDuplicateKnowledge([
      {
        id: "k-high",
        type: "rule",
        status: "active",
        title: "Use queue supervisor for distillation lanes",
        content:
          "Use queue supervisor for distillation lanes. Keep the queue healthy and observable.",
        sourceRefs: ["wiki://queue#runbook"],
      },
      {
        id: "k-low",
        type: "rule",
        status: "active",
        title: "Use queue supervisor for distillation lanes",
        content:
          "Use queue supervisor for distillation lanes. Keep queue operations observable and healthy.",
        sourceRefs: ["wiki://queue#runbook"],
      },
      {
        id: "k-other",
        type: "rule",
        status: "active",
        title: "Run doctor after queue repair",
        content: "Run doctor after queue repair and before resuming distillation.",
        sourceRefs: ["wiki://doctor#workflow"],
      },
    ]);

    expect(result.items.map((item) => item.id)).toEqual(["k-high", "k-other"]);
    expect(result.suppressedById.get("k-low")).toEqual(
      expect.objectContaining({
        representativeId: "k-high",
      }),
    );
    expect(result.groups).toEqual([
      expect.objectContaining({
        representativeId: "k-high",
        memberIds: ["k-high", "k-low"],
      }),
    ]);
  });

  test("does not suppress when status differs", () => {
    const result = suppressNearDuplicateKnowledge([
      {
        id: "k-active",
        type: "rule",
        status: "active",
        title: "Use queue supervisor",
        content: "Use queue supervisor to process lanes.",
        sourceRefs: ["wiki://queue#active"],
      },
      {
        id: "k-deprecated",
        type: "rule",
        status: "deprecated",
        title: "Use queue supervisor",
        content: "Use queue supervisor to process lanes.",
        sourceRefs: ["wiki://queue#active"],
      },
    ]);

    expect(result.items.map((item) => item.id)).toEqual(["k-active", "k-deprecated"]);
    expect(result.suppressedById.size).toBe(0);
  });

  test("preserves a negative guardrail even when its positive counterpart is textually identical", () => {
    const result = suppressNearDuplicateKnowledge([
      {
        id: "k-positive",
        type: "rule",
        status: "active",
        polarity: "positive" as const,
        title: "Use the production database during final verification",
        content: "Use the production database during final verification after approval.",
        sourceRefs: ["runbook://verification"],
      },
      {
        id: "k-negative",
        type: "rule",
        status: "active",
        polarity: "negative" as const,
        title: "Use the production database during final verification",
        content: "Use the production database during final verification after approval.",
        sourceRefs: ["runbook://verification"],
      },
    ]);

    expect(result.items.map((item) => item.id)).toEqual(["k-positive", "k-negative"]);
    expect(result.suppressedById.size).toBe(0);
  });
});
