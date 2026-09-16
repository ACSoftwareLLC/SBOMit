import { test, expect } from "@playwright/test";
import { makeTestAccount, registerAndLogin } from "./helpers/auth";

test.describe("auth lifecycle", () => {
  test("unauthenticated visit to / redirects to /login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("login page renders form and links", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in to sbomit" })).toBeVisible();
    await expect(page.getByLabel("Username or email")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Register" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Forgot your password?" })).toBeVisible();
  });

  test("register creates account, signs in, and lands on home", async ({ page }) => {
    const account = makeTestAccount();
    await page.goto("/register");

    await page.getByLabel("Username").fill(account.username);
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Full name").fill(account.fullName);
    await page.getByLabel("Password", { exact: true }).fill(account.password);
    await page.getByLabel("Confirm password").fill(account.password);
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: /audit npm libraries/i })).toBeVisible();
  });

  test("logout via site header returns to login", async ({ page }) => {
    const account = await registerAndLogin(page);
    await expect(page.getByRole("heading", { name: /audit npm libraries/i })).toBeVisible();

    // The account menu trigger shows the signed-in username.
    await page.getByRole("button", { name: account.username }).click();
    await page.getByRole("button", { name: /sign out/i }).click();

    await expect(page).toHaveURL(/\/login$/);
  });

  test("session persists across reloads", async ({ page }) => {
    await registerAndLogin(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: /audit npm libraries/i })).toBeVisible();
  });

  test("wrong password shows error banner and stays on login", async ({ page }) => {
    const account = await registerAndLogin(page);
    await page.getByRole("button", { name: account.username }).click();
    await page.getByRole("button", { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel("Username or email").fill(account.username);
    await page.getByLabel("Password", { exact: true }).fill("definitely-wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});
