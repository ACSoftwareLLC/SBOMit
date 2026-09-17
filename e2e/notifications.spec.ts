import { test, expect } from "@playwright/test";
import { registerAndLogin } from "./helpers/auth";

test.describe("notification bell", () => {
  test("bell renders for logged-in users on home", async ({ page }) => {
    await registerAndLogin(page);
    const bell = page.getByRole("button", { name: /notifications/i });
    await expect(bell).toBeVisible();
    // No notifications yet -> no unread badge.
    await expect(page.locator("nav span.badge-count")).toHaveCount(0);
  });

  test("bell absent for anonymous visitors", async ({ page }) => {
    // / renders SiteHeader; the auth guard redirects to /login only after
    // the session check resolves, so assert absence early in that window.
    await page.goto("/");
    await expect(page.getByRole("button", { name: /notifications/i })).toHaveCount(0);
  });

  test("dropdown shows empty state when no notifications", async ({ page }) => {
    await registerAndLogin(page);
    await page.getByRole("button", { name: /notifications/i }).click();
    await expect(page.getByText(/no notifications/i)).toBeVisible();
  });
});
