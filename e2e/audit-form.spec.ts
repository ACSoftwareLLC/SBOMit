import { test, expect } from "@playwright/test";
import { registerAndLogin } from "./helpers/auth";

test.describe("audit form", () => {
  test.beforeEach(async ({ page }) => {
    await registerAndLogin(page);
  });

  test("renders form controls", async ({ page }) => {
    await expect(
      page.getByPlaceholder("npm package or GitHub URL, e.g. lodash"),
    ).toBeVisible();
    await expect(page.getByLabel("Version")).toBeVisible();
    await expect(page.getByLabel("AI provider")).toBeVisible();
    await expect(page.getByLabel("Model")).toBeVisible();
    await expect(
      page.getByPlaceholder(/optional prompt/i),
    ).toBeVisible();
  });

  test("Audit Library button disabled until URL is filled", async ({ page }) => {
    const submit = page.getByRole("button", { name: /audit library/i });
    await expect(submit).toBeDisabled();

    await page
      .getByPlaceholder("npm package or GitHub URL, e.g. lodash")
      .fill("lodash");
    await expect(submit).toBeEnabled();
  });

  test("version select stays disabled without npm input", async ({ page }) => {
    const version = page.getByLabel("Version");
    await expect(version).toBeDisabled();

    await page
      .getByPlaceholder("npm package or GitHub URL, e.g. lodash")
      .fill("https://github.com/facebook/react");
    // GitHub URLs do not load npm version lists.
    await expect(version).toBeDisabled();
  });

  test("no-providers warning renders when unconfigured", async ({ page }) => {
    await page.route("**/api/providers", (route) =>
      route.fulfill({ json: { providers: [] } }),
    );
    await page.goto("/");
    await expect(
      page.getByText(/add an llm provider in/i),
    ).toBeVisible();
  });

  test("Advanced panel reveals competition mode controls", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Model A" })).toBeHidden();
    await expect(page.getByText("Competition mode")).toBeHidden();

    await page.getByRole("button", { name: /advanced/i }).click();

    await expect(page.getByText("Competition mode")).toBeVisible();
  });
});
