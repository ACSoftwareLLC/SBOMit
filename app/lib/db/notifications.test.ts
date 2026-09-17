import { describe, it, expect, afterEach } from "vitest";
import { env, reset } from "cloudflare:test";
import {
  insertNotifications,
  deleteUnreadForTarget,
  listNotifications,
  markNotificationsRead,
  type StoredNotification,
} from "./notifications";

type NotificationInsert = Omit<
  StoredNotification,
  "id" | "created_at" | "read"
>;

async function seedUser(username: string): Promise<number> {
  const res = await env.DB.prepare(
    "INSERT INTO users (username, email, full_name, password_hash, is_admin) VALUES (?, ?, ?, ?, 0)",
  )
    .bind(username, `${username}@x.test`, username, "hash")
    .run();
  return res.meta.last_row_id as number;
}

/** Seed the report chain a notification points at; returns report_id. */
async function seedReport(publicId: string): Promise<number> {
  const audit = await env.DB.prepare(
    "INSERT INTO package_audits (name, version, source, url) VALUES (?, ?, ?, ?)",
  )
    .bind("lodash", "4.17.21", "npm", "https://www.npmjs.com/package/lodash")
    .run<{ id: number }>();
  const auditId = audit.meta?.last_row_id as number;
  const report = await env.DB.prepare(
    "INSERT INTO audit_reports (audit_id, public_id, model, score, result_json) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(auditId, publicId, "test-model", 80, "{}")
    .run<{ id: number }>();
  return report.meta?.last_row_id as number;
}

function row(overrides: Partial<NotificationInsert>): NotificationInsert {
  return {
    user_id: 1,
    type: "re_audit_diff",
    target_source: "npm",
    target_name: "lodash",
    report_id: 1,
    previous_report_id: 2,
    title: "lodash: score dropped 14 points",
    body: "New high risk: prototype pollution.",
    ...overrides,
  };
}

describe("notifications db helpers", () => {
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
    // audit_reports join targets for public-id resolution.
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

  it("inserts and lists notifications with resolved public ids", async () => {
    const uid = await seedUser("nt_a");
    const reportId = await seedReport("pub_new");
    const prevReportId = await seedReport("pub_old");
    await insertNotifications(env.DB, [
      row({
        user_id: uid,
        report_id: reportId,
        previous_report_id: prevReportId,
      }),
    ]);

    const { items, unreadCount, nextOffset } = await listNotifications(
      env.DB,
      uid,
      { limit: 10, offset: 0 },
    );
    expect(items).toHaveLength(1);
    expect(unreadCount).toBe(1);
    expect(nextOffset).toBeNull();
    expect(items[0]).toMatchObject({
      type: "re_audit_diff",
      title: "lodash: score dropped 14 points",
      body: "New high risk: prototype pollution.",
      read: false,
      reportPublicId: "pub_new",
      previousReportPublicId: "pub_old",
    });
    expect(typeof items[0].id).toBe("number");
    expect(typeof items[0].createdAt).toBe("string");
  });

  it("unreadOnly filter and unreadCount accuracy", async () => {
    const uid = await seedUser("nt_b");
    await insertNotifications(env.DB, [
      row({ user_id: uid, target_name: "a" }),
      row({ user_id: uid, target_name: "b" }),
    ]);
    await markNotificationsRead(env.DB, uid, undefined);

    const unread = await listNotifications(env.DB, uid, {
      unreadOnly: true,
      limit: 10,
      offset: 0,
    });
    expect(unread.items).toHaveLength(0);
    expect(unread.unreadCount).toBe(0);
  });

  it("pagination: nextOffset advances and nulls on the final page", async () => {
    const uid = await seedUser("nt_c");
    const rows: NotificationInsert[] = [];
    for (let i = 0; i < 25; i++) {
      rows.push(row({ user_id: uid, target_name: `pkg-${i}` }));
    }
    await insertNotifications(env.DB, rows);

    const page1 = await listNotifications(env.DB, uid, {
      limit: 10,
      offset: 0,
    });
    expect(page1.items).toHaveLength(10);
    expect(page1.nextOffset).toBe(10);

    const page2 = await listNotifications(env.DB, uid, {
      limit: 10,
      offset: 10,
    });
    expect(page2.items).toHaveLength(10);
    expect(page2.nextOffset).toBe(20);

    const page3 = await listNotifications(env.DB, uid, {
      limit: 10,
      offset: 20,
    });
    expect(page3.items).toHaveLength(5);
    expect(page3.nextOffset).toBeNull();
  });

  it("mark-one is scoped to the caller", async () => {
    const u1 = await seedUser("nt_d1");
    const u2 = await seedUser("nt_d2");
    // Same numeric id (1) for both users: the first inserted row per user.
    await insertNotifications(env.DB, [row({ user_id: u1 })]);
    await insertNotifications(env.DB, [row({ user_id: u2 })]);

    const u1Items = await listNotifications(env.DB, u1, {
      limit: 10,
      offset: 0,
    });
    const updated = await markNotificationsRead(env.DB, u1, [u1Items.items[0].id]);
    expect(updated).toBe(1);

    // u2's row with the same numeric id stays unread.
    const u2Items = await listNotifications(env.DB, u2, {
      limit: 10,
      offset: 0,
    });
    expect(u2Items.items[0].read).toBe(false);
    expect(u2Items.unreadCount).toBe(1);
  });

  it("mark-all updates every unread row for the caller", async () => {
    const uid = await seedUser("nt_e");
    await insertNotifications(env.DB, [
      row({ user_id: uid, target_name: "x" }),
      row({ user_id: uid, target_name: "y" }),
      row({ user_id: uid, target_name: "z" }),
    ]);
    const updated = await markNotificationsRead(env.DB, uid, undefined);
    expect(updated).toBe(3);
    const { unreadCount } = await listNotifications(env.DB, uid, {
      limit: 10,
      offset: 0,
    });
    expect(unreadCount).toBe(0);
  });

  it("deleted reports resolve to null public ids", async () => {
    const uid = await seedUser("nt_f");
    const reportId = await seedReport("pub_gone");
    await insertNotifications(env.DB, [row({ user_id: uid, report_id: reportId })]);

    await env.DB.prepare("DELETE FROM audit_reports WHERE id = ?").bind(reportId).run();

    const { items } = await listNotifications(env.DB, uid, {
      limit: 10,
      offset: 0,
    });
    expect(items[0].reportPublicId).toBeNull();
  });

  it("collapse delete removes only unread same-target rows for one user", async () => {
    const u1 = await seedUser("nt_g1");
    const u2 = await seedUser("nt_g2");
    // Row A: u1/lodash, will be marked read — must survive the collapse.
    await insertNotifications(env.DB, [
      row({ user_id: u1, target_name: "lodash", title: "lodash: read row" }),
    ]);
    const before = await listNotifications(env.DB, u1, { limit: 10, offset: 0 });
    await markNotificationsRead(env.DB, u1, [before.items[0].id]);

    await insertNotifications(env.DB, [
      // Row B: u1/lodash unread → collapse deletes this.
      row({ user_id: u1, target_name: "lodash", title: "lodash: unread row" }),
      // Row C: u1/express unread → other target, survives.
      row({ user_id: u1, target_name: "express", title: "express: unread row" }),
      // Row D: u2/lodash unread → other user, survives.
      row({ user_id: u2, target_name: "lodash", title: "lodash: u2 row" }),
    ]);

    await deleteUnreadForTarget(env.DB, u1, "npm", "lodash");

    const after = await listNotifications(env.DB, u1, { limit: 10, offset: 0 });
    const titles = after.items.map((i) => i.title).sort();
    expect(titles).toEqual(["express: unread row", "lodash: read row"]);
    const u2After = await listNotifications(env.DB, u2, {
      limit: 10,
      offset: 0,
    });
    expect(u2After.items.map((i) => i.title)).toEqual([
      "lodash: u2 row",
    ]);
  });
});
