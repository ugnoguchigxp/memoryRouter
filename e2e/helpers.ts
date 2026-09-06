import { type Page, expect } from "@playwright/test";
import { TEST_ADMIN_KEY } from "../scripts/testing/isolated-runtime.mjs";

export async function signIn(page: Page, route = "/sources") {
  await page.goto(route);
  await page.getByLabel("Admin API key").fill(TEST_ADMIN_KEY);
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("navigation", { name: "main navigation" })).toBeVisible();
}
