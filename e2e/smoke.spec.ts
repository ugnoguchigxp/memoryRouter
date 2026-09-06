import { expect, test } from "@playwright/test";
import { TEST_ADMIN_KEY } from "../scripts/testing/isolated-runtime.mjs";
import { signIn } from "./helpers";

test("expired session returns to sign-in and recovers", async ({ page, context }) => {
  await signIn(page);
  await expect(page.getByText("API: context-still", { exact: false })).toBeVisible();
  await context.clearCookies();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("The admin session is no longer valid.", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Admin API key").fill(TEST_ADMIN_KEY);
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("heading", { name: "Explorer", exact: true })).toBeVisible();
  expect((await page.request.get("/api/sources/tree")).ok()).toBe(true);
});
