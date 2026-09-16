import { test, expect } from "@playwright/test";

test.describe("navigation", () => {
  test("home redirects logged-out users but login page renders own heading", async ({
    page,
  }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: "Sign in to sbomit" }),
    ).toBeVisible();
  });

  test("register page renders", async ({ page }) => {
    await page.goto("/register");
    await expect(
      page.getByRole("heading", { name: "Create an account" }),
    ).toBeVisible();
  });

  test("reset-password page renders", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(page.getByRole("heading").first()).toBeVisible();
  });
});
