import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { POST as register } from "../../auth/register/route";
import { POST } from "./route";

vi.mock("@/app/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/db")>();
  return {
    ...actual,
    getDb: vi.fn(() => Promise.resolve(env.DB)),
  };
});

vi.mock("@/app/lib/re-audit", () => ({
  runReAuditTick: vi.fn(),
}));

import { runReAuditTick } from "@/app/lib/re-audit";

const runReAuditTickMock = vi.mocked(runReAuditTick);

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
}

interface SeededUser {
  cookie: string;
}

/**
 * Register a real user through the auth route and capture the session cookie.
 * The FIRST registered user in a fresh database becomes an admin (see
 * app/api/auth/register/route.ts), so register the admin before others.
 */
async function seedUser(
  username: string,
  expectAdmin: boolean,
): Promise<SeededUser> {
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
  const data = (await res.json()) as { user: { isAdmin: boolean } };
  if (data.user.isAdmin !== expectAdmin) {
    throw new Error(
      `seedUser(${username}): expected isAdmin=${expectAdmin}, got ${data.user.isAdmin}`,
    );
  }
  const cookie =
    res.headers.getSetCookie().find((c) => c.startsWith("sbomit_session=")) ??
    "";
  return { cookie };
}

function jsonRequest(body: unknown, cookie?: string): Request {
  return new Request("http://localhost/api/admin/re-audit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("/api/admin/re-audit", () => {
  const db = env.DB;

  beforeAll(async () => {
    await setupTables(db);
  });

  afterEach(async () => {
    await reset();
    await setupTables(db);
    vi.clearAllMocks();
  });

  it("requires authentication", async () => {
    const res = await POST(jsonRequest(undefined));
    expect(res.status).toBe(401);
  });

  it("rejects non-admin users with 403", async () => {
    await seedUser("reaudit_admin_a", true); // first user = admin
    const pleb = await seedUser("reaudit_pleb_a", false);
    const res = await POST(jsonRequest({}, pleb.cookie));
    expect(res.status).toBe(403);
    expect(runReAuditTickMock).not.toHaveBeenCalled();
  });

  it("runs the tick with default limit 5 when no body fields", async () => {
    const admin = await seedUser("reaudit_admin_b", true);
    runReAuditTickMock.mockResolvedValue({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      details: [],
    });

    const res = await POST(jsonRequest({}, admin.cookie));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      attempted: number;
      succeeded: number;
      failed: number;
      details: unknown[];
    };
    expect(data.attempted).toBe(0);
    expect(data.succeeded).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.details).toEqual([]);

    expect(runReAuditTickMock).toHaveBeenCalledTimes(1);
    expect(runReAuditTickMock.mock.calls[0][1]).toEqual({ limit: 5 });
    // db must be passed explicitly so the runner never relies on ambient env.
    expect(runReAuditTickMock.mock.calls[0][0]).toBe(env.DB);
  });

  it("clamps limit above 20 down to 20", async () => {
    const admin = await seedUser("reaudit_admin_c", true);
    runReAuditTickMock.mockResolvedValue({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      details: [],
    });

    await POST(jsonRequest({ limit: 25 }, admin.cookie));
    expect(runReAuditTickMock.mock.calls[0][1]).toEqual({ limit: 20 });
  });

  it("clamps limit below 1 up to 1", async () => {
    const admin = await seedUser("reaudit_admin_d", true);
    runReAuditTickMock.mockResolvedValue({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      details: [],
    });

    await POST(jsonRequest({ limit: 0 }, admin.cookie));
    expect(runReAuditTickMock.mock.calls[0][1]).toEqual({ limit: 1 });
  });

  it("forwards a valid limit and the tick result shape", async () => {
    const admin = await seedUser("reaudit_admin_e", true);
    runReAuditTickMock.mockResolvedValue({
      attempted: 2,
      succeeded: 1,
      failed: 1,
      details: [
        { source: "npm", name: "one", status: "ok" },
        {
          source: "npm",
          name: "bad",
          status: "error",
          error: "boom",
        },
      ],
    });

    const res = await POST(jsonRequest({ limit: 7 }, admin.cookie));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      attempted: number;
      succeeded: number;
      failed: number;
      details: Array<{ name: string; status: string; error?: string }>;
    };
    expect(runReAuditTickMock.mock.calls[0][1]).toEqual({ limit: 7 });
    expect(data.attempted).toBe(2);
    expect(data.succeeded).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.details.find((d) => d.name === "bad")?.error).toBe("boom");
  });
});
