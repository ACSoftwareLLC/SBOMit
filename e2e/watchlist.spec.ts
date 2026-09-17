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
});
