import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { POST as register } from "../auth/register/route";
import { GET, POST, DELETE } from "./route";

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
}

interface SeededUser {
  username: string;
  cookie: string;
}

/** Register a real user through the auth route and capture the session cookie. */
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
  return { username, cookie };
}

function jsonRequest(
  path: string,
  method: "GET" | "POST" | "DELETE",
  body: unknown,
  cookie?: string,
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: {
            "Content-Type": "application/json",
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify(body),
        }),
    ...(body === undefined && cookie ? { headers: { cookie } } : {}),
  });
}

describe("/api/watchlist", () => {
  const db = env.DB;

  beforeAll(async () => {
    await setupTables(db);
  });

  afterEach(async () => {
    await reset();
    await setupTables(db);
  });

  it("requires authentication for GET, POST, and DELETE", async () => {
    expect(
      (await GET(jsonRequest("/api/watchlist", "GET", undefined))).status,
    ).toBe(401);
    expect(
      (
        await POST(
          jsonRequest("/api/watchlist", "POST", {
            libraryUrl: "https://www.npmjs.com/package/lodash",
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (await DELETE(jsonRequest("/api/watchlist", "DELETE", { id: 1 }))).status,
    ).toBe(401);
  });

  it("returns 401 before body parsing on POST without a session", async () => {
    // Auth-first ordering: even a request that would fail body parsing must
    // answer 401 (not 400) when no session cookie is present.
    const res = await POST(
      jsonRequest(
        "/api/watchlist",
        "POST",
        { libraryUrl: "https://www.npmjs.com/package/lodash" },
      ),
    );
    expect(res.status).toBe(401);
  });

  it("creates a watchlist item from a bare npm package name and lists it", async () => {
    const user = await seedUser("wl_route_a");

    const create = await POST(
      jsonRequest(
        "/api/watchlist",
        "POST",
        { libraryUrl: "lodash" },
        user.cookie,
      ),
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      item: { source: string; name: string; url: string };
    };
    expect(created.item.source).toBe("npm");
    expect(created.item.name).toBe("lodash");
    expect(created.item.url).toBe("https://www.npmjs.com/package/lodash");

    const list = await GET(
      jsonRequest("/api/watchlist", "GET", undefined, user.cookie),
    );
    expect(list.status).toBe(200);
    const data = (await list.json()) as {
      items: Array<{ source: string; name: string }>;
    };
    expect(data.items).toHaveLength(1);
    expect(data.items[0].name).toBe("lodash");
  });

  it("creates a watchlist item from a GitHub repository URL", async () => {
    const user = await seedUser("wl_route_b");

    const create = await POST(
      jsonRequest(
        "/api/watchlist",
        "POST",
        { libraryUrl: "https://github.com/facebook/react" },
        user.cookie,
      ),
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      item: { source: string; name: string };
    };
    expect(created.item.source).toBe("github");
    expect(created.item.name).toBe("facebook/react");
  });

  it("rejects duplicate watches with 409", async () => {
    const user = await seedUser("wl_route_c");

    const first = await POST(
      jsonRequest(
        "/api/watchlist",
        "POST",
        { libraryUrl: "lodash" },
        user.cookie,
      ),
    );
    expect(first.status).toBe(201);

    const second = await POST(
      jsonRequest(
        "/api/watchlist",
        "POST",
        { libraryUrl: "lodash" },
        user.cookie,
      ),
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as { code: string };
    expect(body.code).toBe("CONFLICT");
  });

  it("rejects unsupported sources with 422", async () => {
    const user = await seedUser("wl_route_d");

    const res = await POST(
      jsonRequest(
        "/api/watchlist",
        "POST",
        { libraryUrl: "https://gitlab.com/foo/bar" },
        user.cookie,
      ),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("UNSUPPORTED_SOURCE");
  });

  it("captures full scoped package names (@types/lodash)", async () => {
    const user = await seedUser("wl_route_h");

    const create = await POST(
      jsonRequest(
        "/api/watchlist",
        "POST",
        { libraryUrl: "@types/lodash" },
        user.cookie,
      ),
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      item: { source: string; name: string; url: string };
    };
    expect(created.item.source).toBe("npm");
    expect(created.item.name).toBe("@types/lodash");
    expect(created.item.url).toBe(
      "https://www.npmjs.com/package/@types/lodash",
    );

    // Same scope, different package: must NOT spuriously 409.
    const second = await POST(
      jsonRequest(
        "/api/watchlist",
        "POST",
        { libraryUrl: "@types/node" },
        user.cookie,
      ),
    );
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as {
      item: { name: string };
    };
    expect(secondBody.item.name).toBe("@types/node");
  });

  it("rejects a missing libraryUrl with 400", async () => {
    const user = await seedUser("wl_route_e");

    const res = await POST(
      jsonRequest("/api/watchlist", "POST", {}, user.cookie),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("MISSING_INPUT");
  });

  it("DELETE by id enforces ownership (other user's item → 404)", async () => {
    const owner = await seedUser("wl_route_f1");
    const other = await seedUser("wl_route_f2");

    const create = await POST(
      jsonRequest(
        "/api/watchlist",
        "POST",
        { libraryUrl: "lodash" },
        owner.cookie,
      ),
    );
    const { item } = (await create.json()) as { item: { id: number } };

    const stranger = await DELETE(
      jsonRequest("/api/watchlist", "DELETE", { id: item.id }, other.cookie),
    );
    expect(stranger.status).toBe(404);

    const mine = await DELETE(
      jsonRequest("/api/watchlist", "DELETE", { id: item.id }, owner.cookie),
    );
    expect(mine.status).toBe(200);
    const list = (await (
      await GET(jsonRequest("/api/watchlist", "GET", undefined, owner.cookie))
    ).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(0);
  });

  it("DELETE by libraryUrl removes the caller's row only", async () => {
    const u1 = await seedUser("wl_route_g1");
    const u2 = await seedUser("wl_route_g2");

    await POST(
      jsonRequest(
        "/api/watchlist",
        "POST",
        { libraryUrl: "express" },
        u1.cookie,
      ),
    );
    await POST(
      jsonRequest(
        "/api/watchlist",
        "POST",
        { libraryUrl: "express" },
        u2.cookie,
      ),
    );

    const res = await DELETE(
      jsonRequest(
        "/api/watchlist",
        "DELETE",
        { libraryUrl: "express" },
        u1.cookie,
      ),
    );
    expect(res.status).toBe(200);

    const list1 = (await (
      await GET(jsonRequest("/api/watchlist", "GET", undefined, u1.cookie))
    ).json()) as { items: unknown[] };
    const list2 = (await (
      await GET(jsonRequest("/api/watchlist", "GET", undefined, u2.cookie))
    ).json()) as { items: unknown[] };
    expect(list1.items).toHaveLength(0);
    expect(list2.items).toHaveLength(1);
  });
});
