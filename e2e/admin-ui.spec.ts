import { expect, test } from "@playwright/test";
import { TEST_ADMIN_KEY } from "../scripts/testing/isolated-runtime.mjs";

test("rejected bootstrap and wrong key can recover to an HttpOnly session", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    (globalThis as { __MEMORY_ROUTER_ADMIN_API_KEY__?: string }).__MEMORY_ROUTER_ADMIN_API_KEY__ =
      "invalid-bootstrap-key-0123456789abcdef";
  });
  await page.goto("/sources?admin_api_key=legacy-secret");
  await page.getByLabel("Admin API key").fill("wrong-custom-key-0123456789abcdef01234567");
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByText("Admin session bootstrap failed: 401")).toBeVisible();
  await page.getByLabel("Admin API key").fill(TEST_ADMIN_KEY);
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("heading", { name: "Explorer", exact: true })).toBeVisible();
  const session = (await context.cookies()).find((cookie) => cookie.httpOnly);
  expect(session).toMatchObject({ httpOnly: true, sameSite: "Strict" });
  expect(await page.evaluate(() => document.cookie)).not.toContain(session?.value);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(TEST_ADMIN_KEY);
  expect(page.url()).not.toContain("admin_api_key");
});
