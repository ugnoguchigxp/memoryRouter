import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("source creation, editing and deletion persist through the real API", async ({ page }) => {
  const slug = `browser-${Date.now()}`;
  await signIn(page);
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  await page.getByPlaceholder("engineering/onboarding", { exact: true }).fill(slug);
  await page.getByPlaceholder("Page title", { exact: true }).fill("Browser persistence check");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .locator('[contenteditable="true"]')
    .fill("Persist this source through the resident writer.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(`Created: ${slug}`, { exact: false })).toBeVisible();
  const created = await page.request.get(`/api/sources/pages/${slug}`);
  expect(created.ok()).toBe(true);
  expect(await created.json()).toMatchObject({
    title: "Browser persistence check",
    body: expect.stringContaining("resident writer"),
  });
  await page.reload();
  await page.getByRole("button", { name: slug, exact: true }).click();
  await expect(page.getByPlaceholder("Page title", { exact: true })).toHaveValue(
    "Browser persistence check",
  );
  await page.getByPlaceholder("Page title", { exact: true }).fill("Updated browser source");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(`Saved: ${slug}`, { exact: false })).toBeVisible();
  expect(await (await page.request.get(`/api/sources/pages/${slug}`)).json()).toMatchObject({
    title: "Updated browser source",
  });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText(`Deleted: ${slug}`, { exact: false })).toBeVisible();
  expect((await page.request.get(`/api/sources/pages/${slug}`)).status()).toBe(404);
});
