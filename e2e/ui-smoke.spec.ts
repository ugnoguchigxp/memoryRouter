import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("page validation prevents an empty-title write", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  await page
    .getByPlaceholder("engineering/onboarding", { exact: true })
    .fill("invalid-empty-title");
  await page.getByPlaceholder("Page title", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("title is required", { exact: true })).toBeVisible();
  expect((await page.request.get("/api/sources/pages/invalid-empty-title")).status()).toBe(404);
});
