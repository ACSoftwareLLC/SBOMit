import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { GET } from "./route";

vi.mock("@/app/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/lib/db")>();
  return {
    ...actual,
    getDb: vi.fn(() => Promise.resolve(env.DB)),
  };
});

async function setupTables(db: D1Database) {
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
      `created_at DATETIME DEFAULT CURRENT_TIMESTAMP,` +
      `cached INTEGER NOT NULL DEFAULT 0,` +
      `cache_hits INTEGER NOT NULL DEFAULT 0,` +
      `started_at TEXT,` +
      `finished_at TEXT` +
      `);`,
  );
  await db.exec(
    `CREATE TABLE IF NOT EXISTS audit_risks (` +
      `id INTEGER PRIMARY KEY AUTOINCREMENT,` +
      `report_id INTEGER NOT NULL,` +
      `severity TEXT NOT NULL,` +
      `title TEXT NOT NULL,` +
      `description TEXT NOT NULL` +
      `);`,
  );
}

function resultJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "lodash",
    version: "4.17.21",
    score: 80,
    summary: "ok",
    risks: [
      {
        severity: "low",
        title: "Prototype pollution history",
        description: "Historical advisories resolved in 4.17.21.",
        sources: null,
      },
    ],
    investigationAreas: [],
    deepDiveFindings: [],
    dependencies: [],
    license: { type: "MIT", compatible: true, note: "" },
    maintainers: [],
    lastPublished: "",
    weeklyDownloads: "",
    cves: [],
    ...overrides,
  });
}

interface SeededReport {
  id: number;
  publicId: string;
  auditId: number;
}

async function seedReport(
  db: D1Database,
  opts: {
    publicId: string;
    name: string;
    source?: string;
    version?: string;
    prompt?: string | null;
    createdAt: string;
    result?: string;
  },
): Promise<SeededReport> {
  const source = opts.source ?? "npm";
  const version = opts.version ?? "4.17.21";
  const auditRes = await db
    .prepare(
      `INSERT INTO package_audits (name, version, source, url, audited_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(opts.name, version, source, `https://www.npmjs.com/package/${opts.name}`, opts.createdAt)
    .run();
  const auditId = auditRes.meta.last_row_id as number;

  const reportRes = await db
    .prepare(
      `INSERT INTO audit_reports (audit_id, public_id, prompt, model, score, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      auditId,
      opts.publicId,
      opts.prompt ?? null,
      "test-model",
      80,
      opts.result ?? resultJson(),
      opts.createdAt,
    )
    .run();
  return { id: reportRes.meta.last_row_id as number, publicId: opts.publicId, auditId };
}

describe("/api/reports/[id] diff", () => {
  const db = env.DB;

  beforeAll(async () => {
    await setupTables(db);
  });

  afterEach(async () => {
    await reset();
    await setupTables(db);
  });

  it("GET with ?diff=1 returns diff + previous report ids", async () => {
    const older = await seedReport(db, {
      publicId: "diffolder0001",
      name: "lodash",
      createdAt: "2026-01-01 00:00:00",
    });
    const newer = await seedReport(db, {
      publicId: "diffnewer0001",
      name: "lodash",
      createdAt: "2026-02-01 00:00:00",
      result: resultJson({
        score: 60,
        risks: [
          {
            severity: "high",
            title: "New injection risk",
            description: "Appeared in the re-audit.",
            sources: null,
          },
        ],
      }),
    });

    const res = await GET(
      new Request(`http://localhost/api/reports/${newer.publicId}?diff=1`, {
        method: "GET",
      }),
      { params: Promise.resolve({ id: newer.publicId }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: {
        diff: {
          scoreDelta: number;
          risks: { added: Array<{ title: string }> };
        } | null;
        previousReportId: number | null;
        previousReportPublicId: string | null;
      };
    };
    expect(body.report.previousReportId).toBe(older.id);
    expect(body.report.previousReportPublicId).toBe(older.publicId);
    expect(body.report.diff).not.toBeNull();
    expect(body.report.diff!.scoreDelta).toBe(-20);
    expect(body.report.diff!.risks.added.map((r) => r.title)).toContain(
      "New injection risk",
    );
  });

  it("GET without ?diff=1 returns no diff fields", async () => {
    const newer = await seedReport(db, {
      publicId: "nodiff000001",
      name: "lodash",
      createdAt: "2026-02-01 00:00:00",
    });
    await seedReport(db, {
      publicId: "nodiff000002",
      name: "lodash",
      createdAt: "2026-01-01 00:00:00",
    });

    const res = await GET(
      new Request(`http://localhost/api/reports/${newer.publicId}`, {
        method: "GET",
      }),
      { params: Promise.resolve({ id: newer.publicId }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: Record<string, unknown>;
    };
    expect(body.report.diff).toBeUndefined();
    expect(body.report.previousReportId).toBeUndefined();
    expect(body.report.previousReportPublicId).toBeUndefined();
  });

  it("first audit (?diff=1) returns null diff + null ids", async () => {
    const only = await seedReport(db, {
      publicId: "firstonly001",
      name: "lodash",
      createdAt: "2026-01-01 00:00:00",
    });

    const res = await GET(
      new Request(`http://localhost/api/reports/${only.publicId}?diff=1`, {
        method: "GET",
      }),
      { params: Promise.resolve({ id: only.publicId }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: { diff: unknown; previousReportId: number | null; previousReportPublicId: string | null };
    };
    expect(body.report.diff).toBeNull();
    expect(body.report.previousReportId).toBeNull();
    expect(body.report.previousReportPublicId).toBeNull();
  });
});
