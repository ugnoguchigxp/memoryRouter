import { describe, expect, test } from "vitest";
import {
  meanMeasured,
  rankedRetrievalMetrics,
} from "../src/modules/landscape/context-eval-metrics.js";

describe("labelled retrieval metrics", () => {
  test("penalizes missing relevant results at the requested cutoff", () => {
    expect(rankedRetrievalMetrics(["a", "b"], ["a"], 5).ndcg).toBeCloseTo(
      1 / (1 + 1 / Math.log2(3)),
    );
    expect(rankedRetrievalMetrics(["a"], ["x", "a"], 2)).toEqual({
      reciprocalRank: 0.5,
      ndcg: 1 / Math.log2(3),
    });
  });
  test("deduplicates results and distinguishes absent labels from failed retrieval", () => {
    expect(rankedRetrievalMetrics(["a"], ["a", "a"], 5).ndcg).toBe(1);
    expect(rankedRetrievalMetrics(["a"], [], 5)).toEqual({ reciprocalRank: 0, ndcg: 0 });
    expect(rankedRetrievalMetrics([], [], 5)).toEqual({ reciprocalRank: null, ndcg: null });
    expect(meanMeasured([null, 0, 1, undefined])).toBe(0.5);
    expect(meanMeasured([null])).toBeNull();
  });
});
