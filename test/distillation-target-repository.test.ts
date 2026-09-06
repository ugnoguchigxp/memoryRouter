import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDistillationTargetStateById } from "../src/modules/distillationTarget/repository.js";

const mockSelect = vi.fn();
vi.mock("../src/db/index.js", () => ({
  db: { select: (...args: unknown[]) => mockSelect(...args) },
}));

const makeChain = (rows: unknown[]) => ({
  from: () => ({
    where: () => ({ limit: async () => rows }),
  }),
});

describe("distillationTarget repository", () => {
  beforeEach(() => vi.clearAllMocks());
  const mockRow = {
    id: "target-1",
    targetKind: "wiki_file" as const,
    targetKey: "test/key.md",
    sourceUri: "/wiki/test/key.md",
    distillationVersion: "select-distillation-target-v1",
    status: "pending" as const,
    phase: "selected" as const,
    priorityGroup: "wiki",
    sortKey: "key",
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  describe("getDistillationTargetStateById", () => {
    it("returns row by id", async () => {
      mockSelect.mockReturnValueOnce(makeChain([mockRow]));

      const result = await getDistillationTargetStateById("target-1");
      expect(result).toEqual(mockRow);
    });

    it("returns null if not found", async () => {
      mockSelect.mockReturnValueOnce(makeChain([]));

      const result = await getDistillationTargetStateById("target-missing");
      expect(result).toBeNull();
    });
  });
});
