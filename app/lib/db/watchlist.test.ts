import { describe, it, expect, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { reset } from "cloudflare:test";
import {
  addWatchlistItem,
  removeWatchlistItem,
  removeWatchlistItemByUrl,
  listWatchlistForUser,
  getEligibleReAuditTargets,
  markTargetAudited,
} from "./watchlist";

async function seedUser(username: string): Promise<number> {
  const res = await env.DB.prepare(
    "INSERT INTO users (username, email, full_name, password_hash, is_admin) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(username, `${username}@x.test`, username, "hash", 0)
    .run();
  return res.meta.last_row_id as number;
}

describe("watchlist db helpers", () => {
  // The vitest pool applies migrations once per file; `reset()` empties all
  // tables, so the schema needed by these tests is recreated after each test
  // (same pattern as app/lib/auth.test.ts).
  afterEach(async () => {
    await reset();
    await env.DB.exec(
      `CREATE TABLE IF NOT EXISTS users (` +
        `id INTEGER PRIMARY KEY AUTOINCREMENT,` +
        `username TEXT UNIQUE NOT NULL,` +
        `email TEXT UNIQUE NOT NULL,` +
        `full_name TEXT NOT NULL,` +
        `password_hash TEXT NOT NULL,` +
        `is_admin INTEGER NOT NULL DEFAULT 0,` +
        `is_blocked INTEGER NOT NULL DEFAULT 0,` +
        `created_at DATETIME DEFAULT CURRENT_TIMESTAMP,` +
        `updated_at DATETIME DEFAULT CURRENT_TIMESTAMP` +
        `);`,
    );
    await env.DB.exec(
      `CREATE TABLE IF NOT EXISTS watchlist (` +
        `id INTEGER PRIMARY KEY AUTOINCREMENT,` +
        `user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,` +
        `source TEXT NOT NULL,` +
        `name TEXT NOT NULL,` +
        `url TEXT NOT NULL,` +
        `created_at DATETIME DEFAULT CURRENT_TIMESTAMP,` +
        `UNIQUE(user_id, source, name)` +
        `);`,
    );
    await env.DB.exec(
      `CREATE TABLE IF NOT EXISTS watchlist_targets (` +
        `source TEXT NOT NULL,` +
        `name TEXT NOT NULL,` +
        `last_audited_at TEXT,` +
        `PRIMARY KEY (source, name)` +
        `);`,
    );
  });

  it("adds and lists items per user", async () => {
    const uid = await seedUser("wl_a");
    await addWatchlistItem(env.DB, {
      user_id: uid,
      source: "npm",
      name: "lodash",
      url: "https://www.npmjs.com/package/lodash",
    });
    const items = await listWatchlistForUser(env.DB, uid);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe("lodash");
  });

  it("rejects duplicate (user, source, name)", async () => {
    const uid = await seedUser("wl_b");
    const input = {
      user_id: uid,
      source: "npm",
      name: "express",
      url: "https://www.npmjs.com/package/express",
    };
    await addWatchlistItem(env.DB, input);
    await expect(addWatchlistItem(env.DB, input)).rejects.toThrow();
  });

  it("delete enforces ownership", async () => {
    const u1 = await seedUser("wl_c1");
    const u2 = await seedUser("wl_c2");
    const item = await addWatchlistItem(env.DB, {
      user_id: u1,
      source: "npm",
      name: "axios",
      url: "https://www.npmjs.com/package/axios",
    });
    expect(await removeWatchlistItem(env.DB, u2, item.id)).toBe(false);
    expect(await removeWatchlistItem(env.DB, u1, item.id)).toBe(true);
    expect(await listWatchlistForUser(env.DB, u1)).toHaveLength(0);
  });

  it("eligible targets dedupe across watchers and respect age + limit", async () => {
    const u1 = await seedUser("wl_d1");
    const u2 = await seedUser("wl_d2");
    await addWatchlistItem(env.DB, {
      user_id: u1,
      source: "npm",
      name: "pkg-old",
      url: "https://www.npmjs.com/package/pkg-old",
    });
    // Second watcher of the same target.
    await addWatchlistItem(env.DB, {
      user_id: u2,
      source: "npm",
      name: "pkg-old",
      url: "https://www.npmjs.com/package/pkg-old",
    });
    await addWatchlistItem(env.DB, {
      user_id: u1,
      source: "npm",
      name: "pkg-fresh",
      url: "https://www.npmjs.com/package/pkg-fresh",
    });
    await markTargetAudited(env.DB, "npm", "pkg-fresh");

    const targets = await getEligibleReAuditTargets(env.DB, 10, 24);
    const names = targets.map((t) => t.name);
    expect(names).toContain("pkg-old");
    expect(names).not.toContain("pkg-fresh");
    const old = targets.find((t) => t.name === "pkg-old")!;
    expect(old.watcher_count).toBe(2);
    expect(targets.length).toBeLessThanOrEqual(10);
  });

  it("markTargetAudited upserts and makes target ineligible", async () => {
    const uid = await seedUser("wl_e");
    await addWatchlistItem(env.DB, {
      user_id: uid,
      source: "npm",
      name: "marked",
      url: "https://www.npmjs.com/package/marked",
    });
    await markTargetAudited(env.DB, "npm", "marked");
    expect(await getEligibleReAuditTargets(env.DB, 10, 24)).toHaveLength(0);
    // Idempotent upsert.
    await markTargetAudited(env.DB, "npm", "marked");
  });

  it("removeByUrl only touches the caller's row", async () => {
    const u1 = await seedUser("wl_f1");
    const u2 = await seedUser("wl_f2");
    await addWatchlistItem(env.DB, {
      user_id: u1,
      source: "npm",
      name: "shared",
      url: "https://www.npmjs.com/package/shared",
    });
    await addWatchlistItem(env.DB, {
      user_id: u2,
      source: "npm",
      name: "shared",
      url: "https://www.npmjs.com/package/shared",
    });
    expect(await removeWatchlistItemByUrl(env.DB, u1, "npm", "shared")).toBe(
      true,
    );
    expect(await listWatchlistForUser(env.DB, u2)).toHaveLength(1);
  });
});
