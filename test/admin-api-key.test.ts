import { describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_API_KEY, resolveAdminApiKey } from "../src/shared/admin-api-key.js";

describe("admin API key defaults", () => {
  it("uses a valid built-in key when the environment value is missing or blank", () => {
    expect(DEFAULT_ADMIN_API_KEY.length).toBeGreaterThanOrEqual(32);
    expect(resolveAdminApiKey(undefined)).toBe(DEFAULT_ADMIN_API_KEY);
    expect(resolveAdminApiKey("   ")).toBe(DEFAULT_ADMIN_API_KEY);
  });

  it("prefers and trims an environment override", () => {
    expect(resolveAdminApiKey("  custom-admin-api-key  ")).toBe("custom-admin-api-key");
  });
});
