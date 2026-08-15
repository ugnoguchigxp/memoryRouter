import { describe, expect, test } from "vitest";
import {
  enumerateLandscapeTaskFacetEntries,
  extractLandscapeTaskFacets,
} from "../src/modules/landscape/landscape-facets.js";

describe("landscape facets", () => {
  test("extracts task facets from compile input without goal inference", () => {
    const facets = extractLandscapeTaskFacets({
      runInput: {
        repoPath: "/Users/example/Code/memoryRouter",
        technologies: ["TypeScript", "Drizzle"],
        changeTypes: ["Feature"],
        domains: ["Graph-UI"],
      },
      repoPath: null,
      retrievalMode: "hybrid",
      source: "mcp",
      runStatus: "degraded",
      degradedReasons: ["vector_failed"],
    });

    expect(facets.repoKey).toBeUndefined();
    expect(facets.repoPath).toBe("/Users/example/Code/memoryRouter");
    expect(facets.technologies).toEqual(["typescript", "drizzle"]);
    expect(facets.changeTypes).toEqual(["feature"]);
    expect(facets.domains).toEqual(["graph-ui"]);

    expect(enumerateLandscapeTaskFacetEntries(facets)).toEqual(
      expect.arrayContaining([
        { facetKind: "retrievalMode", facetValue: "hybrid" },
        { facetKind: "technology", facetValue: "typescript" },
        { facetKind: "domain", facetValue: "graph-ui" },
        { facetKind: "runStatus", facetValue: "degraded" },
        { facetKind: "degradedReasonBucket", facetValue: "vector_failed" },
      ]),
    );
  });

  test("keeps missing facets explicit as unknown", () => {
    const facets = extractLandscapeTaskFacets({
      runInput: {},
      repoPath: null,
      retrievalMode: "",
      source: "",
      runStatus: "ok",
      degradedReasons: [],
    });

    expect(enumerateLandscapeTaskFacetEntries(facets)).toEqual(
      expect.arrayContaining([
        { facetKind: "repoKey", facetValue: "unknown" },
        { facetKind: "technology", facetValue: "unknown" },
        { facetKind: "changeType", facetValue: "unknown" },
        { facetKind: "domain", facetValue: "unknown" },
        { facetKind: "degradedReasonBucket", facetValue: "unknown" },
      ]),
    );
  });
});
