import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { GET, DELETE } from "./route";

vi.mock("@/app/lib/db", async () => {
  const actual = await vi.importActual<typeof import("@/app/lib/db")>(
    "@/app/lib/db",
  );
  const { env } = await import("cloudflare:workers");
  return {
    ...actual,
    getDb: async (passedEnv?: Record<string, unknown>) => {
      if (passedEnv?.DB) return passedEnv.DB as D1Database;
      return actual.getDb({ DB: env.DB } as Record<string, unknown>);
    },
  };
});

async function setupSchema(db: D1Database) {
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
    `CREATE TABLE IF NOT EXISTS package_dependencies (` +
      `id INTEGER PRIMARY KEY AUTOINCREMENT,` +
      `audit_id INTEGER NOT NULL,` +
      `name TEXT NOT NULL,` +
      `version TEXT NOT NULL,` +
      `dependency_type TEXT NOT NULL,` +
      `FOREIGN KEY (audit_id) REFERENCES package_audits(id) ON DELETE CASCADE` +
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

async function createReport(db: D1Database) {
  const audit = await db
    .prepare(
      `INSERT INTO package_audits (name, version, source, url) VALUES (?, ?, ?, ?)`,
    )
    .bind("lodash", "4.17.21", "npm", "https://www.npmjs.com/package/lodash")
    .run<{ id: number }>();
  const auditId = audit.meta?.last_row_id as number;

  const report = await db
    .prepare(
      `INSERT INTO audit_reports (audit_id, public_id, prompt, model, score, result_json, interaction_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      auditId,
      "report-1",
      null,
      "gpt-4o-mini",
      85,
      JSON.stringify({ score: 85 }),
      JSON.stringify({
        provider: "openai",
        model: "gpt-4o-mini",
        systemPrompt: "system",
        userPrompt: "user",
        request: { model: "gpt-4o-mini" },
        response: { choices: [] },
        startedAt: "2024-01-01T00:00:00.000Z",
        finishedAt: "2024-01-01T00:00:01.000Z",
        tokensInput: 100,
        tokensOutput: 50,
      }),
    )
    .run<{ id: number }>();
  const reportId = report.meta?.last_row_id as number;

  return { auditId, reportId };
}

describe("GET /api/audits/[id]", () => {
  const db = env.DB;

  beforeAll(async () => {
    await setupSchema(db);
  });

  afterEach(async () => {
    await reset();
    await setupSchema(db);
  });

  it("returns the audit report with interaction log", async () => {
    const { reportId } = await createReport(db);

    const response = await GET(
      new Request(`http://localhost/api/audits/${reportId}`),
      { params: Promise.resolve({ id: String(reportId) }) },
    );
    const data = (await response.json()) as {
      audit: { name: string };
      report: { model: string };
      interactions: { provider: string; tokensInput: number }[];
    };

    expect(response.status).toBe(200);
    expect(data.audit.name).toBe("lodash");
    expect(data.report.model).toBe("gpt-4o-mini");
    expect(data.interactions).toHaveLength(1);
    expect(data.interactions[0].provider).toBe("openai");
    expect(data.interactions[0].tokensInput).toBe(100);
  });

  it("returns 404 for a missing report", async () => {
    const response = await GET(
      new Request("http://localhost/api/audits/9999"),
      { params: Promise.resolve({ id: "9999" }) },
    );
    expect(response.status).toBe(404);
  });

  it("returns 400 for an invalid report id", async () => {
    const response = await GET(
      new Request("http://localhost/api/audits/abc"),
      { params: Promise.resolve({ id: "abc" }) },
    );
    expect(response.status).toBe(400);
  });
});

describe("GET /api/audits/[id] diff", () => {
  const db = env.DB;

  beforeAll(async () => {
    await setupSchema(db);
  });

  afterEach(async () => {
    await reset();
    await setupSchema(db);
  });

  function diffResultJson(overrides: Record<string, unknown> = {}): string {
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

  async function seedDiffReport(
    opts: {
      publicId: string;
      name?: string;
      source?: string;
      createdAt: string;
      score?: number;
      result?: string;
    },
  ): Promise<{ id: number; publicId: string }> {
    const auditRes = await db
      .prepare(
        `INSERT INTO package_audits (name, version, source, url, audited_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        opts.name ?? "lodash",
        "4.17.21",
        opts.source ?? "npm",
        `https://www.npmjs.com/package/${opts.name ?? "lodash"}`,
        opts.createdAt,
      )
      .run();
    const auditId = auditRes.meta?.last_row_id as number;

    const reportRes = await db
      .prepare(
        `INSERT INTO audit_reports (audit_id, public_id, prompt, model, score, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        auditId,
        opts.publicId,
        null,
        "test-model",
        opts.score ?? 80,
        opts.result ?? diffResultJson(),
        opts.createdAt,
      )
      .run();
    return {
      id: reportRes.meta?.last_row_id as number,
      publicId: opts.publicId,
    };
  }

  it("GET with ?diff=1 returns diff payload against the previous report", async () => {
    const older = await seedDiffReport({
      publicId: "adiffolder001",
      createdAt: "2026-01-01 00:00:00",
      score: 80,
    });
    const newer = await seedDiffReport({
      publicId: "adiffnewer01",
      createdAt: "2026-02-01 00:00:00",
      score: 60,
      result: diffResultJson({
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
      new Request(`http://localhost/api/audits/${newer.id}?diff=1`),
      { params: Promise.resolve({ id: String(newer.id) }) },
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

  it("GET without ?diff=1 omits diff fields entirely", async () => {
    await seedDiffReport({
      publicId: "anodiffold001",
      createdAt: "2026-01-01 00:00:00",
    });
    const newer = await seedDiffReport({
      publicId: "anodiffnew01",
      createdAt: "2026-02-01 00:00:00",
    });

    const res = await GET(
      new Request(`http://localhost/api/audits/${newer.id}`),
      { params: Promise.resolve({ id: String(newer.id) }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: Record<string, unknown> };
    expect(body.report.diff).toBeUndefined();
    expect(body.report.previousReportId).toBeUndefined();
    expect(body.report.previousReportPublicId).toBeUndefined();
  });

  it("first audit with ?diff=1 returns triple-null diff payload", async () => {
    const only = await seedDiffReport({
      publicId: "afirstonly001",
      createdAt: "2026-01-01 00:00:00",
    });

    const res = await GET(
      new Request(`http://localhost/api/audits/${only.id}?diff=1`),
      { params: Promise.resolve({ id: String(only.id) }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: {
        diff: unknown;
        previousReportId: number | null;
        previousReportPublicId: string | null;
      };
    };
    expect(body.report.diff).toBeNull();
    expect(body.report.previousReportId).toBeNull();
    expect(body.report.previousReportPublicId).toBeNull();
  });

  it("corrupted previous result_json with ?diff=1 returns triple-null payload", async () => {
    await seedDiffReport({
      publicId: "acorruptprev1",
      createdAt: "2026-01-01 00:00:00",
      result: "{not-valid-json",
    });
    const newer = await seedDiffReport({
      publicId: "acorruptnew01",
      createdAt: "2026-02-01 00:00:00",
    });

    const res = await GET(
      new Request(`http://localhost/api/audits/${newer.id}?diff=1`),
      { params: Promise.resolve({ id: String(newer.id) }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: {
        diff: unknown;
        previousReportId: number | null;
        previousReportPublicId: string | null;
      };
    };
    expect(body.report.diff).toBeNull();
    expect(body.report.previousReportId).toBeNull();
    expect(body.report.previousReportPublicId).toBeNull();
  });
});

describe("DELETE /api/audits/[id]", () => {
  const db = env.DB;

  beforeAll(async () => {
    await setupSchema(db);
  });

  afterEach(async () => {
    await reset();
    await setupSchema(db);
  });

  it("deletes an existing report", async () => {
    const { reportId } = await createReport(db);

    const response = await DELETE(
      new Request(`http://localhost/api/audits/${reportId}`),
      { params: Promise.resolve({ id: String(reportId) }) },
    );
    const data = (await response.json()) as { deleted: boolean };

    expect(response.status).toBe(200);
    expect(data.deleted).toBe(true);
  });
});
