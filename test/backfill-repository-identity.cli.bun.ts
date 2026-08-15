import { describe, expect, test } from "vitest";
import { parseRepositoryIdentityBackfillArgs } from "../src/cli/backfill-repository-identity.js";

describe("repository identity backfill CLI", () => {
  test("parses guarded write options and reviewed promotions", () => {
    expect(
      parseRepositoryIdentityBackfillArgs([
        "--write",
        "--expected-checksum",
        "checksum",
        "--backup-reference",
        "snapshot-1",
        "--batch-size",
        "50",
        "--promote-global",
        "knowledge:item-1",
      ]),
    ).toMatchObject({
      mode: "write",
      expectedChecksum: "checksum",
      backupReference: "snapshot-1",
      batchSize: 50,
      explicitGlobalPromotions: { knowledge: ["item-1"] },
    });
  });

  test("rejects unknown options and invalid promotion declarations", () => {
    expect(() => parseRepositoryIdentityBackfillArgs(["--unknown"])).toThrow("unknown argument");
    expect(() =>
      parseRepositoryIdentityBackfillArgs(["--promote-global", "repository:item-1"]),
    ).toThrow("--promote-global requires");
  });
});
