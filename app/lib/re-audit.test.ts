import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { reset } from "cloudflare:test";
import {
  runReAuditTick,
} from "./re-audit";
import { runAudit } from "./run-audit";
import { checkProviderBudget } from "./provider-budget";
import {
  addWatchlistItem,
  getEligibleReAuditTargets,
} from "./db/watchlist";

vi.mock("./run-audit", () => ({ runAudit: vi.fn() }));
vi.mock("./provider-budget", () => ({
  checkProviderBudget: vi.fn(),
  finalizeProviderUsage: vi.fn(),
}));

const runAuditMock = vi.mocked(runAudit);

async function seedUser(username: string): Promise<number> {
  const res = await env.DB.prepare(
    "INSERT INTO users (username, email, full_name, password_hash, is_admin) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(username, `${username}@x.test`, username, "hash", 0)
    .run();
  return res.meta.last_row_id as number;
}

const OK_RUN = {
  result: {},
  meta: {
    cached: false,
    auditId: 1,
    reportId: 1,
    codebaseInspected: false,
    interactions: [],
  },
} as never;

describe("runReAuditTick", () => {
  // The vitest pool applies migrations once per file; `reset()` empties all
  // tables, so the schema needed by these tests is recreated after each test
  // (same pattern as app/lib/db/watchlist.test.ts).
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
    // runReAuditTick resolves the default provider via listProviders(); the
    // providers table must exist for the runner under test.
    await env.DB.exec(
      `CREATE TABLE IF NOT EXISTS providers (` +
        `id TEXT PRIMARY KEY,` +
        `name TEXT NOT NULL,` +
        `provider TEXT NOT NULL,` +
        `api_key TEXT NOT NULL,` +
        `base_url TEXT,` +
        `models TEXT NOT NULL,` +
        `is_default INTEGER NOT NULL DEFAULT 0,` +
        `created_at DATETIME DEFAULT CURRENT_TIMESTAMP,` +
        `updated_at DATETIME DEFAULT CURRENT_TIMESTAMP` +
        `);`,
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    runAuditMock.mockResolvedValue(OK_RUN);
  });

  it("runs one audit per distinct target and marks it audited", async () => {
    const u1 = await seedUser("ra_a1");
    const u2 = await seedUser("ra_a2");
    await addWatchlistItem(env.DB, {
      user_id: u1,
      source: "npm",
      name: "one",
      url: "https://www.npmjs.com/package/one",
    });
    await addWatchlistItem(env.DB, {
      user_id: u2,
      source: "npm",
      name: "one",
      url: "https://www.npmjs.com/package/one",
    });

    const result = await runReAuditTick(env.DB, { limit: 5 });
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(runAuditMock).toHaveBeenCalledTimes(1);
    expect(runAuditMock.mock.calls[0][0].skipCache).toBe(true);
    // The runner must pass the db explicitly so scheduled (worker) context
    // never relies on getDb()'s ambient fallback chain.
    expect(runAuditMock.mock.calls[0][2]).toBe(env.DB);
    const targets = await getEligibleReAuditTargets(env.DB, 10, 24);
    expect(targets.filter((t) => t.name === "one")).toHaveLength(0);
  });

  it("a failing target is recorded and does not kill the tick", async () => {
    const u = await seedUser("ra_b");
    await addWatchlistItem(env.DB, {
      user_id: u,
      source: "npm",
      name: "bad",
      url: "u",
    });
    await addWatchlistItem(env.DB, {
      user_id: u,
      source: "npm",
      name: "good",
      url: "g",
    });
    runAuditMock.mockImplementation(async (input: {
      libraryUrl: string;
    }) => {
      if (input.libraryUrl === "u") throw new Error("boom");
      return OK_RUN;
    });

    const result = await runReAuditTick(env.DB, { limit: 5 });
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.details.find((d) => d.name === "bad")?.status).toBe("error");
  });

  it("budget exhaustion stops the tick with stoppedReason", async () => {
    const u = await seedUser("ra_c");
    await addWatchlistItem(env.DB, {
      user_id: u,
      source: "npm",
      name: "x",
      url: "x",
    });
    vi.mocked(checkProviderBudget).mockRejectedValueOnce(
      new Error("RATE_LIMIT_EXCEEDED"),
    );

    const result = await runReAuditTick(env.DB, { limit: 5 });
    expect(result.stoppedReason).toBe("budget");
    expect(runAuditMock).not.toHaveBeenCalled();
  });

  it("budget exhaustion breaks the loop: no later target is attempted", async () => {
    const u = await seedUser("ra_c2");
    await addWatchlistItem(env.DB, {
      user_id: u,
      source: "npm",
      name: "first",
      url: "first",
    });
    await addWatchlistItem(env.DB, {
      user_id: u,
      source: "npm",
      name: "second",
      url: "second",
    });
    // First budget check (for whichever target is processed first) fails.
    vi.mocked(checkProviderBudget).mockRejectedValueOnce(
      new Error("RATE_LIMIT_EXCEEDED"),
    );

    const result = await runReAuditTick(env.DB, { limit: 5 });
    expect(result.stoppedReason).toBe("budget");
    // `break`, not `continue`: zero attempts, no audits, neither target marked.
    expect(result.attempted).toBe(0);
    expect(runAuditMock).not.toHaveBeenCalled();
    const targets = await getEligibleReAuditTargets(env.DB, 10, 24);
    expect(targets.map((t) => t.name).sort()).toEqual(["first", "second"]);
  });

  it("resolves the default provider for scheduled runs", async () => {
    const u = await seedUser("ra_prov1");
    await addWatchlistItem(env.DB, {
      user_id: u,
      source: "npm",
      name: "prov",
      url: "prov",
    });
    await env.DB.exec(
      `INSERT INTO providers (id, name, provider, api_key, models, is_default, created_at) VALUES` +
        `('cfg-first', 'First', 'openai', 'k', '["m"]', 0, '2026-01-01 00:00:00'),` +
        `('cfg-default', 'Default', 'openai', 'k', '["m"]', 1, '2026-01-02 00:00:00');`,
    );

    await runReAuditTick(env.DB, { limit: 5 });
    expect(runAuditMock.mock.calls[0][0].providerId).toBe("cfg-default");
  });

  it("falls back to the first provider when none is default", async () => {
    const u = await seedUser("ra_prov2");
    await addWatchlistItem(env.DB, {
      user_id: u,
      source: "npm",
      name: "prov",
      url: "prov",
    });
    await env.DB.exec(
      `INSERT INTO providers (id, name, provider, api_key, models, is_default, created_at) VALUES` +
        `('cfg-older', 'Older', 'openai', 'k', '["m"]', 0, '2026-01-01 00:00:00'),` +
        `('cfg-newer', 'Newer', 'openai', 'k', '["m"]', 0, '2026-01-02 00:00:00');`,
    );

    await runReAuditTick(env.DB, { limit: 5 });
    // listProviders orders by created_at ASC; the first row wins.
    expect(runAuditMock.mock.calls[0][0].providerId).toBe("cfg-older");
  });

  it("failed targets are not marked audited (retry next tick)", async () => {
    const u = await seedUser("ra_d");
    await addWatchlistItem(env.DB, {
      user_id: u,
      source: "npm",
      name: "flaky",
      url: "f",
    });
    runAuditMock.mockRejectedValueOnce(new Error("boom"));
    await runReAuditTick(env.DB, { limit: 5 });
    const targets = await getEligibleReAuditTargets(env.DB, 10, 24);
    expect(targets.map((t) => t.name)).toContain("flaky");
  });
});
