import { describe, expect, it } from "vitest";
// @ts-expect-error The verification script is also run directly by Node/Bun.
import { auditSizes } from "../scripts/verify-maintainability.mjs";

describe("maintainability budget", () => {
  const baseline = { version: 1, maxLines: 1200, exceptions: { "legacy.rs": 2000 } };
  it("rejects new oversized modules and growth of existing debt", () => {
    expect(auditSizes({ "legacy.rs": 2001, "new.ts": 1201 }, baseline)).toHaveLength(2);
    expect(auditSizes({ "legacy.rs": 1999, "new.ts": 1200 }, baseline)).toEqual([]);
  });
  it("requires removal of stale exemptions after a split", () => {
    expect(auditSizes({ "new.ts": 500 }, baseline)).toEqual([
      "legacy.rs: stale maintainability exception",
    ]);
  });
});
