import { describe, expect, test } from "vitest";
import { parseRepositoryIsolationReportArgs } from "../src/cli/repository-isolation-report.js";

describe("repository isolation report CLI", () => {
  test("does not accept ad-hoc producer manifests or observation timestamps", () => {
    expect(() =>
      parseRepositoryIsolationReportArgs([
        "--enabled-producers",
        "source.markdown-import,episode-distiller.rust",
      ]),
    ).toThrow("Unknown argument: --enabled-producers");
    expect(() =>
      parseRepositoryIsolationReportArgs([
        "--producer-observation-started-at",
        "2026-08-08T12:00:00.000Z",
      ]),
    ).toThrow("Unknown argument: --producer-observation-started-at");
    expect(parseRepositoryIsolationReportArgs(["--project-ref", "project-A"])).toMatchObject({
      projectRef: "project-A",
    });
  });
});
