import type { Page } from "@playwright/test";

export interface TestAccount {
  username: string;
  email: string;
  fullName: string;
  password: string;
}

let counter = 0;

/** Unique account per invocation so tests never collide on existing users. */
export function makeTestAccount(): TestAccount {
  const stamp = `${process.pid}-${Date.now().toString(36)}-${++counter}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    username: `pwtest_${stamp}`,
    email: `pwtest_${stamp}@example.com`,
    fullName: `Playwright Test ${stamp}`,
    password: "correct-horse-battery-staple",
  };
}

/** Register via the real /api/auth/register endpoint and return the session. */
export async function registerViaApi(
  page: Page,
  account: TestAccount,
): Promise<void> {
  const res = await page.request.post("/api/auth/register", {
    data: {
      username: account.username,
      email: account.email,
      fullName: account.fullName,
      password: account.password,
    },
  });
  if (res.status() !== 200 && res.status() !== 201) {
    throw new Error(
      `Registration failed (${res.status()}): ${await res.text()}`,
    );
  }
}

/**
 * Create a fresh account (server-side registration sets the session cookie)
 * and land on the authenticated home page.
 */
export async function registerAndLogin(
  page: Page,
): Promise<TestAccount> {
  const account = makeTestAccount();
  await registerViaApi(page, account);
  await page.goto("/");
  return account;
}
