import { describe, it, expect, afterEach } from "vitest";
import { env, reset } from "cloudflare:test";
import {
  isDiffSignificant,
  buildDiffMessages,
  notifyWatchersOfDiff,
} from "./notifications";
import { addWatchlistItem } from "./db/watchlist";
import { listNotifications } from "./db/notifications";
import type { ReportDiff } from "./report-diff";
import type { Risk } from "./audit";

function diff(overrides: Partial<ReportDiff>): ReportDiff {
  return {
    scoreDelta: 0,
    risks: { added: [], removed: [], severityChanged: [] },
    advisories: { newCves: [], resolvedCves: [] },
    licenseChanged: false,
    versionChanged: false,
    ...overrides,
  };
}

function risk(severity: Risk["severity"], title = "Some risk"): Risk {
  return { severity, title, description: "d" };
}

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
    `CREATE TABLE IF NOT EXISTS notifications (` +
      `id INTEGER PRIMARY KEY AUTOINCREMENT,` +
      `user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,` +
      `type TEXT NOT NULL DEFAULT 're_audit_diff',` +
      `target_source TEXT NOT NULL,` +
      `target_name TEXT NOT NULL,` +
      `report_id INTEGER NOT NULL,` +
      `previous_report_id INTEGER NOT NULL,` +
      `title TEXT NOT NULL,` +
      `body TEXT NOT NULL,` +
      `read INTEGER NOT NULL DEFAULT 0,` +
      `created_at DATETIME DEFAULT CURRENT_TIMESTAMP` +
      `);`,
  );
  // listNotifications JOINs audit_reports for public-id resolution.
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS package_audits (` +
      `id INTEGER PRIMARY KEY AUTOINCREMENT,` +
      `name TEXT NOT NULL,` +
      `version TEXT NOT NULL,` +
      `source TEXT NOT NULL,` +
      `url TEXT NOT NULL,` +
      `audited_at DATETIME DEFAULT CURRENT_TIMESTAMP` +
      `);`,
  );
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS audit_reports (` +
      `id INTEGER PRIMARY KEY AUTOINCREMENT,` +
      `audit_id INTEGER NOT NULL,` +
      `public_id TEXT NOT NULL UNIQUE,` +
      `prompt TEXT,` +
      `model TEXT NOT NULL,` +
      `score INTEGER NOT NULL,` +
      `result_json TEXT NOT NULL,` +
      `cache_key TEXT UNIQUE,` +
      `interaction_json TEXT,` +
      `codebase_inspected INTEGER DEFAULT 0,` +
      `created_at DATETIME DEFAULT CURRENT_TIMESTAMP,` +
      `FOREIGN KEY (audit_id) REFERENCES package_audits(id) ON DELETE CASCADE` +
      `);`,
  );
});

describe("isDiffSignificant", () => {
  it("scoreDelta -10 is significant, -9 is not", () => {
    expect(isDiffSignificant(diff({ scoreDelta: -10 }))).toBe(true);
    expect(isDiffSignificant(diff({ scoreDelta: -9 }))).toBe(false);
  });

  it("added high risk is significant, medium-only is not", () => {
    expect(
      isDiffSignificant(diff({ risks: { added: [risk("high")] } as never, scoreDelta: 0 })),
    ).toBe(true);
    expect(
      isDiffSignificant(diff({ risks: { added: [risk("medium")] } as never })),
    ).toBe(false);
  });

  it("any new CVE is significant", () => {
    expect(
      isDiffSignificant(
        diff({
          advisories: {
            newCves: [
              {
                id: "CVE-2026-1234",
                aliases: [],
                severity: null,
                title: "t",
                description: "d",
                published: null,
                modified: null,
                fixedVersion: null,
                references: [],
              },
            ],
            resolvedCves: [],
          },
        }),
      ),
    ).toBe(true);
  });

  it("threshold overrides flip decisions", () => {
    const mediumOnly = diff({ risks: { added: [risk("medium")] } as never });
    expect(
      isDiffSignificant(mediumOnly, { riskSeverities: ["medium"] }),
    ).toBe(true);
    const dropNine = diff({ scoreDelta: -9 });
    expect(isDiffSignificant(dropNine, { minScoreDrop: 9 })).toBe(true);
  });
});

describe("buildDiffMessages", () => {
  it("critical chip wins over CVE and score", () => {
    const { title, body } = buildDiffMessages(
      { source: "npm", name: "lodash" },
      diff({
        scoreDelta: -20,
        risks: { added: [risk("critical", "RCE in parser")] } as never,
        advisories: {
          newCves: [
            {
              id: "CVE-2026-1",
              aliases: [],
              severity: null,
              title: "t",
              description: "d",
              published: null,
              modified: null,
              fixedVersion: null,
              references: [],
            },
          ],
          resolvedCves: [],
        },
      }),
    );
    expect(title).toBe("lodash: 1 new critical risk");
    expect(body).toContain("New critical risk: RCE in parser");
    expect(body).toContain("CVE-2026-1");
    expect(body).toContain("Score dropped 20 points");
  });

  it("CVE chip when no critical risks", () => {
    const { title } = buildDiffMessages(
      { source: "npm", name: "lodash" },
      diff({
        advisories: {
          newCves: [
            {
              id: "CVE-2026-2",
              aliases: [],
              severity: null,
              title: "t",
              description: "d",
              published: null,
              modified: null,
              fixedVersion: null,
              references: [],
            },
          ],
          resolvedCves: [],
        },
      }),
    );
    expect(title).toBe("lodash: 1 new advisory");
  });

  it("score chip when only the score dropped", () => {
    const { title, body } = buildDiffMessages(
      { source: "npm", name: "lodash" },
      diff({ scoreDelta: -12 }),
    );
    expect(title).toBe("lodash: score dropped 12 points");
    expect(body).toContain("Score dropped 12 points");
  });
});

describe("notifyWatchersOfDiff", () => {
  it("fans out one row per watcher with the built messages", async () => {
    const u1 = await seedUser("nf_a1");
    const u2 = await seedUser("nf_a2");
    await addWatchlistItem(env.DB, {
      user_id: u1,
      source: "npm",
      name: "lodash",
      url: "https://www.npmjs.com/package/lodash",
    });
    await addWatchlistItem(env.DB, {
      user_id: u2,
      source: "npm",
      name: "lodash",
      url: "https://www.npmjs.com/package/lodash",
    });

    await notifyWatchersOfDiff(
      env.DB,
      { source: "npm", name: "lodash" },
      diff({ scoreDelta: -14 }),
      101,
      100,
    );

    for (const uid of [u1, u2]) {
      const { items, unreadCount } = await listNotifications(env.DB, uid, {
        limit: 10,
        offset: 0,
      });
      expect(items).toHaveLength(1);
      expect(unreadCount).toBe(1);
      expect(items[0].title).toBe("lodash: score dropped 14 points");
      expect(items[0].read).toBe(false);
    }
    // Verify report ids landed via the DB (public ids need audit rows).
    const raw = await env.DB.prepare(
      "SELECT report_id, previous_report_id FROM notifications ORDER BY user_id",
    )
      .all<{ report_id: number; previous_report_id: number }>();
    expect(raw.results).toHaveLength(2);
    for (const r of raw.results) {
      expect(r.report_id).toBe(101);
      expect(r.previous_report_id).toBe(100);
    }
  });

  it("collapses unread same-target rows but preserves read rows", async () => {
    const uid = await seedUser("nf_b");
    await addWatchlistItem(env.DB, {
      user_id: uid,
      source: "npm",
      name: "lodash",
      url: "https://www.npmjs.com/package/lodash",
    });

    // Pre-existing unread row for the same target (from an earlier tick).
    await notifyWatchersOfDiff(
      env.DB,
      { source: "npm", name: "lodash" },
      diff({ scoreDelta: -5 }),
      90,
      89,
    );
    // Mark the first notification read (simulates the user having seen it).
    const { items } = await listNotifications(env.DB, uid, {
      limit: 10,
      offset: 0,
    });
    const { markNotificationsRead } = await import("./db/notifications");
    await markNotificationsRead(env.DB, uid, [items[0].id]);

    // Second tick: new significant diff → new row; old READ row survives.
    await notifyWatchersOfDiff(
      env.DB,
      { source: "npm", name: "lodash" },
      diff({ scoreDelta: -20 }),
      101,
      100,
    );

    const after = await listNotifications(env.DB, uid, { limit: 10, offset: 0 });
    expect(after.items).toHaveLength(2);
    expect(after.items.filter((i) => i.read)).toHaveLength(1);
    expect(after.items.filter((i) => !i.read)).toHaveLength(1);
    // The unread row references the newest report pair.
    const unread = after.items.find((i) => !i.read)!;
    expect(unread.title).toBe("lodash: score dropped 20 points");
  });

  it("collapses an UNREAD prior row (replaced, not stacked)", async () => {
    const uid = await seedUser("nf_c");
    await addWatchlistItem(env.DB, {
      user_id: uid,
      source: "npm",
      name: "lodash",
      url: "https://www.npmjs.com/package/lodash",
    });
    await notifyWatchersOfDiff(
      env.DB,
      { source: "npm", name: "lodash" },
      diff({ scoreDelta: -5 }),
      90,
      89,
    );
    await notifyWatchersOfDiff(
      env.DB,
      { source: "npm", name: "lodash" },
      diff({ scoreDelta: -20 }),
      101,
      100,
    );
    const after = await listNotifications(env.DB, uid, { limit: 10, offset: 0 });
    expect(after.items).toHaveLength(1);
    expect(after.items[0].title).toBe("lodash: score dropped 20 points");
  });

  it("a watcher of a different target is untouched", async () => {
    const uid = await seedUser("nf_d");
    await addWatchlistItem(env.DB, {
      user_id: uid,
      source: "npm",
      name: "express",
      url: "https://www.npmjs.com/package/express",
    });
    await notifyWatchersOfDiff(
      env.DB,
      { source: "npm", name: "lodash" },
      diff({ scoreDelta: -14 }),
      101,
      100,
    );
    const { items } = await listNotifications(env.DB, uid, {
      limit: 10,
      offset: 0,
    });
    expect(items).toHaveLength(0);
  });

  it("zero watchers is a no-op", async () => {
    await expect(
      notifyWatchersOfDiff(
        env.DB,
        { source: "npm", name: "unwatched" },
        diff({ scoreDelta: -14 }),
        1,
        2,
      ),
    ).resolves.toBeUndefined();
    const raw = await env.DB.prepare("SELECT COUNT(*) AS c FROM notifications").first<{ c: number }>();
    expect(raw?.c).toBe(0);
  });
});

async function seedUser(username: string): Promise<number> {
  const res = await env.DB.prepare(
    "INSERT INTO users (username, email, full_name, password_hash, is_admin) VALUES (?, ?, ?, ?, 0)",
  )
    .bind(username, `${username}@x.test`, username, "hash")
    .run();
  return res.meta.last_row_id as number;
}
