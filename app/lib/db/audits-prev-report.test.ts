import { describe, it, expect, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { reset } from "cloudflare:test";
import { getPreviousAuditReport } from "./audits";

// The vitest pool applies migrations once per file; `reset()` empties all
// tables, so the schema needed by these tests is recreated after each test
// (same pattern as app/lib/db/watchlist.test.ts and app/lib/re-audit.test.ts).
async function setupSchema(db: D1Database) {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS package_audits (` +
      `id INTEGER PRIMARY KEY AUTOINCREMENT,` +
      `name TEXT NOT NULL,` +
      `version TEXT NOT NULL,` +
      `source TEXT NOT NULL,` +
      `url TEXT NOT NULL,` +
      `user_id INTEGER,` +
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
      `tokens_total INTEGER,` +
      `provider_models TEXT,` +
      `cached INTEGER NOT NULL DEFAULT 0,` +
      `cache_hits INTEGER NOT NULL DEFAULT 0,` +
      `started_at TEXT,` +
      `finished_at TEXT,` +
      `created_at DATETIME DEFAULT CURRENT_TIMESTAMP,` +
      `FOREIGN KEY (audit_id) REFERENCES package_audits(id) ON DELETE CASCADE` +
      `);`,
  );
}

interface SeedInput {
  name: string;
  source: string;
  prompt: string | null;
  createdAt: string;
}

describe("getPreviousAuditReport", () => {
  const db = env.DB;

  afterEach(async () => {
    await reset();
    await setupSchema(db);
  });

  async function seedReport(
    seed: SeedInput,
    publicId: string,
  ): Promise<number> {
    const audit = await db
      .prepare(
        `INSERT INTO package_audits (name, version, source, url) VALUES (?, ?, ?, ?)`,
      )
      .bind(seed.name, "1.0.0", seed.source, `https://example.com/${seed.name}`)
      .run<{ id: number }>();
    const auditId = audit.meta?.last_row_id as number;
    const report = await db
      .prepare(
        `INSERT INTO audit_reports (audit_id, public_id, prompt, model, score, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        auditId,
        publicId,
        seed.prompt,
        "gpt-4o-mini",
        80,
        "{}",
        seed.createdAt,
      )
      .run<{ id: number }>();
    return report.meta?.last_row_id as number;
  }

  it("returns the newest earlier default-prompt report for the same name+source", async () => {
    await seedReport(
      { name: "lodash", source: "npm", prompt: null, createdAt: "2026-01-01T00:00:00.000Z" },
      "oldest",
    );
    const middleId = await seedReport(
      { name: "lodash", source: "npm", prompt: null, createdAt: "2026-02-01T00:00:00.000Z" },
      "middle",
    );
    await seedReport(
      { name: "lodash", source: "npm", prompt: null, createdAt: "2026-03-01T00:00:00.000Z" },
      "current",
    );

    const previous = await getPreviousAuditReport(
      db,
      "lodash",
      "npm",
      "2026-03-01T00:00:00.000Z",
    );
    expect(previous).not.toBeNull();
    expect(previous?.id).toBe(middleId);
    expect(previous?.prompt).toBeNull();
  });

  it("never matches a report with a custom prompt", async () => {
    await seedReport(
      { name: "express", source: "npm", prompt: "focus on supply chain", createdAt: "2026-01-01T00:00:00.000Z" },
      "prompted",
    );
    await seedReport(
      { name: "express", source: "npm", prompt: null, createdAt: "2026-02-01T00:00:00.000Z" },
      "current",
    );

    const previous = await getPreviousAuditReport(
      db,
      "express",
      "npm",
      "2026-02-01T00:00:00.000Z",
    );
    // The only earlier report has a prompt — not a valid previous report.
    expect(previous).toBeNull();
  });

  it("never matches a later or equal-created report", async () => {
    await seedReport(
      { name: "axios", source: "npm", prompt: null, createdAt: "2026-03-01T00:00:00.000Z" },
      "later",
    );
    await seedReport(
      { name: "axios", source: "npm", prompt: null, createdAt: "2026-02-01T00:00:00.000Z" },
      "same-as-cutoff",
    );
    const previous = await getPreviousAuditReport(
      db,
      "axios",
      "npm",
      "2026-02-01T00:00:00.000Z",
    );
    // Nothing strictly earlier exists.
    expect(previous).toBeNull();
  });

  it("never matches a different name or source", async () => {
    await seedReport(
      { name: "axios", source: "npm", prompt: null, createdAt: "2026-01-01T00:00:00.000Z" },
      "other-name",
    );
    await seedReport(
      { name: "lodash", source: "github", prompt: null, createdAt: "2026-01-01T00:00:00.000Z" },
      "other-source",
    );
    await seedReport(
      { name: "lodash", source: "npm", prompt: null, createdAt: "2026-02-01T00:00:00.000Z" },
      "current",
    );

    const previous = await getPreviousAuditReport(
      db,
      "lodash",
      "npm",
      "2026-02-01T00:00:00.000Z",
    );
    expect(previous).toBeNull();
  });
});
