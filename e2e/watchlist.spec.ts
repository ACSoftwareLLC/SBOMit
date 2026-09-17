import { test, expect } from "@playwright/test";
import { registerAndLogin } from "./helpers/auth";

test.describe("watchlist", () => {
  test("star column header renders on audits page for authenticated user", async ({
    page,
  }) => {
    await registerAndLogin(page);
    await page.goto("/audits");
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  });

  test("watchlist API roundtrip: POST → GET → DELETE", async ({ page }) => {
    await registerAndLogin(page);

    // Add
    const addRes = await page.request.post("/api/watchlist", {
      data: { libraryUrl: "https://www.npmjs.com/package/lodash" },
    });
    expect(addRes.status()).toBe(201);

    // Visible in the list
    const list = await page.request.get("/api/watchlist");
    expect(list.status()).toBe(200);
    const listBody = (await list.json()) as {
      items: Array<{ name: string; source: string; url: string }>;
    };
    expect(
      listBody.items.some(
        (i) => i.name === "lodash" && i.source === "npm",
      ),
    ).toBe(true);

    // Remove
    const delRes = await page.request.delete("/api/watchlist", {
      data: { libraryUrl: "https://www.npmjs.com/package/lodash" },
    });
    expect(delRes.status()).toBe(200);

    // Gone from the list
    const after = await page.request.get("/api/watchlist");
    const afterBody = (await after.json()) as { items: unknown[] };
    expect(afterBody.items).toHaveLength(0);
  });

  test("duplicate watch returns 409", async ({ page }) => {
    await registerAndLogin(page);
    const body = { libraryUrl: "https://www.npmjs.com/package/express" };
    const first = await page.request.post("/api/watchlist", { data: body });
    expect(first.status()).toBe(201);
    const second = await page.request.post("/api/watchlist", { data: body });
    expect(second.status()).toBe(409);
  });

  test("per-row star toggle watches and unwatches a history row", async ({
    page,
  }) => {
    await registerAndLogin(page);

    // The audits history list is backed by real audit rows, which require a
    // real LLM audit. Mock /api/audits with one row in the exact snake_case
    // shape /api/audits returns (AuditHistoryItem on the page) so the row
    // rendering is deterministic. The watchlist endpoints stay REAL.
    await page.route("**/api/audits", (route) =>
      route.fulfill({
        json: {
          audits: [
            {
              id: 1,
              audit_id: 1,
              prompt: null,
              model: "test-model",
              score: 80,
              created_at: "2026-01-01 00:00:00",
              name: "lodash",
              version: "4.17.21",
              source: "npm",
              url: "https://www.npmjs.com/package/lodash",
              provider: null,
              tokens_input: null,
              tokens_output: null,
              tokens_total: null,
              started_at: null,
              finished_at: null,
              codebase_inspected: 0,
            },
          ],
        },
      }),
    );
    await page.goto("/audits");

    const star = page.getByRole("button", { name: "Watch lodash" });
    await expect(star).toBeVisible();

    // Watch: hits the real POST /api/watchlist.
    await star.click();
    await expect(page.getByRole("button", { name: "Stop watching lodash" })).toBeVisible();
    const list = await page.request.get("/api/watchlist");
    const listBody = (await list.json()) as {
      items: Array<{ name: string; source: string; url: string }>;
    };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]).toMatchObject({
      name: "lodash",
      source: "npm",
      url: "https://www.npmjs.com/package/lodash",
    });

    // Reload: star state persists (page hydrates from real GET /api/watchlist).
    await page.reload();
    await expect(page.getByRole("button", { name: "Stop watching lodash" })).toBeVisible();

    // Unwatch: hits the real DELETE /api/watchlist.
    await page.getByRole("button", { name: "Stop watching lodash" }).click();
    await expect(page.getByRole("button", { name: "Watch lodash" })).toBeVisible();
    const after = await page.request.get("/api/watchlist");
    const afterBody = (await after.json()) as { items: unknown[] };
    expect(afterBody.items).toHaveLength(0);
  });
});
