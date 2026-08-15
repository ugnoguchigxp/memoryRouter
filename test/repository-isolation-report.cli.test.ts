import { describe, expect, test } from "vitest";
import { parseRepositoryIsolationReportArgs } from "../src/cli/repository-isolation-report.js";

describe("repository isolation report CLI", () => {
  test("parses an explicit producer observation start timestamp", () => {
    const options = parseRepositoryIsolationReportArgs([
      "--enabled-producers",
      "source.markdown-import,episode-distiller.rust",
      "--producer-observation-started-at",
      "2026-08-08T12:00:00.000Z",
    ]);

    expect(options.enabledProducers).toEqual(["source.markdown-import", "episode-distiller.rust"]);
    expect(options.producerObservationStartedAt?.toISOString()).toBe("2026-08-08T12:00:00.000Z");
  });

  test("rejects missing, timezone-free, and invalid observation timestamps", () => {
    expect(() => parseRepositoryIsolationReportArgs(["--producer-observation-started-at"])).toThrow(
      "requires a value",
    );
    expect(() =>
      parseRepositoryIsolationReportArgs([
        "--producer-observation-started-at",
        "2026-08-08T12:00:00",
      ]),
    ).toThrow("ISO-8601 timestamp with a timezone");
    expect(() =>
      parseRepositoryIsolationReportArgs([
        "--producer-observation-started-at",
        "2026-02-30T12:00:00Z",
      ]),
    ).toThrow("valid ISO-8601 timestamp");
  });
});
