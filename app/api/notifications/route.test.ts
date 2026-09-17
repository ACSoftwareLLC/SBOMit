import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { POST as register } from "../auth/register/route";
import { GET } from "./route";
import { POST as markRead } from "./read/route";

vi.mock("@/app/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/db")>();
  return {
    ...actual,
    getDb: vi.fn(() => Promise.resolve(env.DB)),
  };
});

async function setupTables(db: D1Database) {
  await db.exec(
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
  await db.exec(
    `CREATE TABLE IF NOT EXISTS sessions (` +
      `id TEXT PRIMARY KEY,` +
      `user_id INTEGER NOT NULL,` +
      `expires_at DATETIME NOT NULL,` +
      `created_at DATETIME DEFAULT CURRENT_TIMESTAMP` +
      `);`,
  );
  await db.exec(
    `CREATE TABLE IF NOT EXISTS blocked_emails (` +
      `id INTEGER PRIMARY KEY AUTOINCREMENT,` +
      `email TEXT UNIQUE NOT NULL,` +
      `created_at DATETIME DEFAULT CURRENT_TIMESTAMP` +
      `);`,
  );
  await db.exec(
    `CREATE TABLE IF NOT EXISTS blocked_usernames (` +
      `id INTEGER PRIMARY KEY AUTOINCREMENT,` +
      `username TEXT UNIQUE NOT NULL,` +
      `created_at DATETIME DEFAULT CURRENT_TIMESTAMP` +
      `);`,
  );
  await db.exec(
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
  await db.exec(
    `CREATE TABLE IF NOT EXISTS package_audits (` +
      `id INTEGER PRIMARY KEY AUTOINCREMENT,` +
      `name TEXT NOT NULL,` +
      `version TEXT NOT NULL,` +
      `source TEXT NOT NULL,` +
      `url TEXT NOT NULL,` +
      `audited_at DATETIME DEFAULT CURRENT_TIMESTAMP` +
      `);`,
  );
  await db.exec(
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
}

interface SeededUser {
  userId: number;
  cookie: string;
}

async function seedUser(username: string): Promise<SeededUser> {
  const res = await register(
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@example.com`,
        fullName: username,
        password: "password123",
      }),
    }),
  );
  if (res.status !== 201) {
    throw new Error(`seedUser(${username}) failed: ${await res.text()}`);
  }
  const cookie =
    res.headers.getSetCookie().find((c) => c.startsWith("sbomit_session=")) ??
    "";
  const row = await env.DB.prepare(
    "SELECT id FROM users WHERE username = ?",
  )
    .bind(username)
    .first<{ id: number }>();
  return { userId: row!.id, cookie };
}

/** Seed the report chain for public-id joins; returns report_id. */
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

async function seedNotification(
  userId: number,
  reportId: number,
  overrides?: { read?: number; targetName?: string },
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO notifications (user_id, target_source, target_name, report_id, previous_report_id, title, body, read)
     VALUES (?, 'npm', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      userId,
      overrides?.targetName ?? "lodash",
      reportId,
      reportId,
      "lodash: 1 new advisory",
      "CVE-2026-0001",
      overrides?.read ?? 0,
    )
    .run<{ id: number }>();
  return res.meta?.last_row_id as number;
}

function getRequest(path: string, cookie?: string): Request {
  return new Request(`http://localhost${path}`, {
    ...(cookie ? { headers: { cookie } } : {}),
  });
}

function postRequest(path: string, body: unknown, cookie?: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("/api/notifications", () => {
  const db = env.DB;

  beforeAll(async () => {
    await setupTables(db);
  });

  afterEach(async () => {
    await reset();
    await setupTables(db);
  });

  it("requires authentication for GET and POST read", async () => {
    expect((await GET(getRequest("/api/notifications"))).status).toBe(401);
    expect(
      (await markRead(postRequest("/api/notifications/read", { ids: [1] })))
        .status,
    ).toBe(401);
  });

  it("answers 401 (not 400) before body parsing on read without a session", async () => {
    // Auth-first ordering: malformed garbage + no cookie must be 401.
    const res = await markRead(
      new Request("http://localhost/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("answers 400 MISSING_INPUT for malformed JSON on read with a session", async () => {
    const user = await seedUser("ntf_malformed");
    const res = await markRead(
      new Request("http://localhost/api/notifications/read", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: user.cookie,
        },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("MISSING_INPUT");
  });

  it("rejects non-numeric limit with 400 MISSING_INPUT", async () => {
    const user = await seedUser("ntf_limitabc");
    const res = await GET(
      getRequest("/api/notifications?limit=abc", user.cookie),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("MISSING_INPUT");
  });

  it("lists seeded items with resolved public ids and unreadCount", async () => {
    const user = await seedUser("ntf_a");
    const reportId = await seedReport("rep-aaa");
    await seedNotification(user.userId, reportId);

    const res = await GET(getRequest("/api/notifications", user.cookie));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      items: Array<{
        id: number;
        title: string;
        read: boolean;
        reportPublicId: string | null;
        previousReportPublicId: string | null;
      }>;
      unreadCount: number;
    };
    expect(data.items).toHaveLength(1);
    expect(data.items[0].title).toBe("lodash: 1 new advisory");
    expect(data.items[0].read).toBe(false);
    expect(data.items[0].reportPublicId).toBe("rep-aaa");
    expect(data.items[0].previousReportPublicId).toBe("rep-aaa");
    expect(data.unreadCount).toBe(1);
  });

  it("unread=1 filters to unread rows only", async () => {
    const user = await seedUser("ntf_b");
    const reportId = await seedReport("rep-bbb");
    await seedNotification(user.userId, reportId, { read: 0 });
    await seedNotification(user.userId, reportId, { read: 1 });

    const res = await GET(
      getRequest("/api/notifications?unread=1", user.cookie),
    );
    const data = (await res.json()) as {
      items: Array<{ read: boolean }>;
      unreadCount: number;
    };
    expect(data.items).toHaveLength(1);
    expect(data.items[0].read).toBe(false);
    expect(data.unreadCount).toBe(1);
  });

  it("paginates with limit/offset and reports nextOffset", async () => {
    const user = await seedUser("ntf_c");
    const reportId = await seedReport("rep-ccc");
    for (let i = 0; i < 3; i++) {
      await seedNotification(user.userId, reportId);
    }

    const page1 = await GET(
      getRequest("/api/notifications?limit=2&offset=0", user.cookie),
    );
    const data1 = (await page1.json()) as {
      items: unknown[];
      nextOffset: number | null;
    };
    expect(data1.items).toHaveLength(2);
    expect(data1.nextOffset).toBe(2);

    const page2 = await GET(
      getRequest("/api/notifications?limit=2&offset=2", user.cookie),
    );
    const data2 = (await page2.json()) as {
      items: unknown[];
      nextOffset: number | null;
    };
    expect(data2.items).toHaveLength(1);
    expect(data2.nextOffset).toBeNull();
  });

  it("POST read marks one own notification and returns updated count", async () => {
    const user = await seedUser("ntf_d");
    const reportId = await seedReport("rep-ddd");
    const id = await seedNotification(user.userId, reportId);

    const res = await markRead(
      postRequest("/api/notifications/read", { ids: [id] }, user.cookie),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { updated: number };
    expect(data.updated).toBe(1);

    const list = (await (
      await GET(getRequest("/api/notifications?unread=1", user.cookie))
    ).json()) as { items: unknown[]; unreadCount: number };
    expect(list.items).toHaveLength(0);
    expect(list.unreadCount).toBe(0);
  });

  it("POST read is ownership-scoped (other user's row stays unread)", async () => {
    const owner = await seedUser("ntf_e1");
    const other = await seedUser("ntf_e2");
    const reportId = await seedReport("rep-eee");
    const ownerId = await seedNotification(owner.userId, reportId);
    await seedNotification(other.userId, reportId);

    const res = await markRead(
      postRequest(
        "/api/notifications/read",
        { ids: [ownerId] },
        other.cookie,
      ),
    );
    const data = (await res.json()) as { updated: number };
    expect(data.updated).toBe(0);

    const ownerList = (await (
      await GET(getRequest("/api/notifications?unread=1", owner.cookie))
    ).json()) as { unreadCount: number };
    expect(ownerList.unreadCount).toBe(1);
  });

  it("POST read without ids marks all of the caller's notifications", async () => {
    const user = await seedUser("ntf_f");
    const reportId = await seedReport("rep-fff");
    await seedNotification(user.userId, reportId);
    await seedNotification(user.userId, reportId);

    const res = await markRead(
      postRequest("/api/notifications/read", {}, user.cookie),
    );
    const data = (await res.json()) as { updated: number };
    expect(data.updated).toBe(2);
  });

  it("POST read with ids:[] is a no-op (updated 0), not mark-all", async () => {
    // Carried contract from Task 1+2 review: empty ids must NOT fall through
    // to mark-all semantics.
    const user = await seedUser("ntf_g");
    const reportId = await seedReport("rep-ggg");
    await seedNotification(user.userId, reportId);

    const res = await markRead(
      postRequest("/api/notifications/read", { ids: [] }, user.cookie),
    );
    const data = (await res.json()) as { updated: number };
    expect(data.updated).toBe(0);

    const list = (await (
      await GET(getRequest("/api/notifications?unread=1", user.cookie))
    ).json()) as { unreadCount: number };
    expect(list.unreadCount).toBe(1);
  });

  it("rejects limit=0 with 400 (DB layer would yield a self-referential nextOffset)", async () => {
    const user = await seedUser("ntf_h");
    const res = await GET(
      getRequest("/api/notifications?limit=0", user.cookie),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("MISSING_INPUT");
  });

  it("rejects ids arrays over the 99-element D1 bound with 400", async () => {
    const user = await seedUser("ntf_i");
    const res = await markRead(
      postRequest(
        "/api/notifications/read",
        { ids: Array.from({ length: 100 }, (_, i) => i + 1) },
        user.cookie,
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("MISSING_INPUT");
  });
});
