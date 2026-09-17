import type { AuditResult } from "../audit";
import { generatePublicId } from "./client";
import type { ProviderModelPair } from "./providers";

export interface StoredDependency {
  name: string;
  version: string;
  dependency_type: string;
}

export interface StoredAudit {
  id: number;
  name: string;
  version: string;
  source: string;
  url: string;
  audited_at: string;
}

export interface StoredAuditReport {
  id: number;
  audit_id: number;
  public_id: string;
  prompt: string | null;
  model: string;
  score: number;
  result_json: string;
  cache_key: string | null;
  interaction_json: string | null;
  codebase_inspected: number;
  tokens_total: number | null;
  provider_models: string | null;
  cached: number;
  cache_hits: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export type StoredReport = StoredAuditReport;

export interface StoredAuditReportSummary {
  id: number;
  audit_id: number;
  prompt: string | null;
  model: string;
  score: number;
  created_at: string;
  name: string;
  version: string;
  source: string;
  url: string;
  provider: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_total: number | null;
  started_at: string | null;
  finished_at: string | null;
  codebase_inspected: number;
}

export async function saveDependencyTree(
  db: D1Database,
  audit: {
    name: string;
    version: string;
    source: string;
    url: string;
    userId?: number;
  },
  dependencies: StoredDependency[],
): Promise<number> {
  const insertAudit = db
    .prepare(
      `INSERT INTO package_audits (name, version, source, url, user_id) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(audit.name, audit.version, audit.source, audit.url, audit.userId ?? null);

  const auditResult = await insertAudit.run<{ id: number }>();
  const auditId = auditResult.meta?.last_row_id as number | undefined;
  if (!auditId) {
    throw new Error("Failed to insert package audit.");
  }

  if (dependencies.length > 0) {
    const insertDep = db.prepare(
      `INSERT INTO package_dependencies (audit_id, name, version, dependency_type) VALUES (?, ?, ?, ?)`,
    );
    await db.batch(
      dependencies.map((dep) =>
        insertDep.bind(auditId, dep.name, dep.version, dep.dependency_type),
      ),
    );
  }

  return auditId;
}

interface InteractionLike {
  tokensInput?: number | null;
  tokensOutput?: number | null;
}

function parseAuditResult(resultJson: string): AuditResult | undefined {
  try {
    return JSON.parse(resultJson) as AuditResult;
  } catch {
    return undefined;
  }
}

function computeTokensTotal(interactionJson: string | undefined): number | null {
  if (!interactionJson) return null;
  try {
    const parsed = JSON.parse(interactionJson) as
      | InteractionLike
      | InteractionLike[];
    const interactions = Array.isArray(parsed) ? parsed : [parsed];
    let total = 0;
    let hasTokens = false;
    for (const interaction of interactions) {
      if (interaction.tokensInput != null) {
        total += interaction.tokensInput;
        hasTokens = true;
      }
      if (interaction.tokensOutput != null) {
        total += interaction.tokensOutput;
        hasTokens = true;
      }
    }
    return hasTokens ? total : null;
  } catch {
    return null;
  }
}

export async function saveAuditReport(
  db: D1Database,
  input: {
    name: string;
    version: string;
    source: string;
    url: string;
    prompt?: string;
    model: string;
    score: number;
    resultJson: string;
    cacheKey?: string;
    interactionJson?: string;
    codebaseInspected?: boolean;
    userId?: number;
    providerModels?: ProviderModelPair[];
    cached?: boolean;
    startedAt?: string;
    finishedAt?: string;
  },
): Promise<{ auditId: number; reportId: number }> {
  const insertAudit = db
    .prepare(
      `INSERT INTO package_audits (name, version, source, url, user_id) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(input.name, input.version, input.source, input.url, input.userId ?? null);

  const auditResult = await insertAudit.run<{ id: number }>();
  const auditId = auditResult.meta?.last_row_id as number | undefined;
  if (!auditId) {
    throw new Error("Failed to insert package audit.");
  }

  const publicId = generatePublicId();
  const tokensTotal = computeTokensTotal(input.interactionJson);
  const providerModelsJson =
    input.providerModels && input.providerModels.length > 0
      ? JSON.stringify(input.providerModels)
      : null;

  const insertReport = db
    .prepare(
      `INSERT INTO audit_reports (audit_id, public_id, prompt, model, score, result_json, cache_key, interaction_json, codebase_inspected, tokens_total, provider_models, cached, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      auditId,
      publicId,
      input.prompt ?? null,
      input.model,
      input.score,
      input.resultJson,
      input.cacheKey ?? null,
      input.interactionJson ?? null,
      input.codebaseInspected ? 1 : 0,
      tokensTotal,
      providerModelsJson,
      input.cached ? 1 : 0,
      input.startedAt ?? null,
      input.finishedAt ?? null,
    );

  const reportResult = await insertReport.run<{ id: number }>();
  const reportId = reportResult.meta?.last_row_id as number | undefined;
  if (!reportId) {
    throw new Error("Failed to insert audit report.");
  }

  // Persist all findings into normalized tables for querying and history views.
  const result = parseAuditResult(input.resultJson);
  if (result) {
    const statements: D1PreparedStatement[] = [];
    const risks = result.risks ?? [];
    const cves = result.cves ?? [];
    const investigationAreas = result.investigationAreas ?? [];
    const deepDiveFindings = result.deepDiveFindings ?? [];
    const dependencies = result.dependencies ?? [];

    if (risks.length > 0) {
      const insertRisk = db.prepare(
        `INSERT INTO audit_risks (report_id, severity, title, description) VALUES (?, ?, ?, ?)`,
      );
      for (const risk of risks) {
        statements.push(
          insertRisk.bind(reportId, risk.severity, risk.title, risk.description),
        );
      }
    }

    if (cves.length > 0) {
      const insertCve = db.prepare(
        `INSERT INTO audit_cves (report_id, cve_id, aliases, severity, title, description, published, modified, fixed_version, references_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const cve of cves) {
        statements.push(
          insertCve.bind(
            reportId,
            cve.id,
            JSON.stringify(cve.aliases),
            cve.severity,
            cve.title,
            cve.description,
            cve.published,
            cve.modified,
            cve.fixedVersion,
            JSON.stringify(cve.references),
          ),
        );
      }
    }

    const filesByAreaId = new Map<number, string[]>();
    if (investigationAreas.length > 0) {
      const insertArea = db.prepare(
        `INSERT INTO audit_investigation_areas (report_id, area, rationale) VALUES (?, ?, ?)`,
      );
      for (const area of investigationAreas) {
        const areaResult = await insertArea
          .bind(reportId, area.area, area.rationale)
          .run<{ id: number }>();
        const areaId = areaResult.meta?.last_row_id as number | undefined;
        const files = area.files ?? [];
        if (areaId && files.length > 0) {
          filesByAreaId.set(areaId, files);
        }
      }
    }

    if (filesByAreaId.size > 0) {
      const insertFile = db.prepare(
        `INSERT INTO audit_investigation_files (area_id, file) VALUES (?, ?)`,
      );
      for (const [areaId, files] of filesByAreaId) {
        for (const file of files) {
          statements.push(insertFile.bind(areaId, file));
        }
      }
    }

    if (deepDiveFindings.length > 0) {
      const insertFinding = db.prepare(
        `INSERT INTO audit_findings (report_id, area, file, issue, evidence, severity) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const finding of deepDiveFindings) {
        statements.push(
          insertFinding.bind(
            reportId,
            finding.area,
            finding.file,
            finding.issue,
            finding.evidence ?? null,
            finding.severity,
          ),
        );
      }
    }

    if (dependencies.length > 0) {
      const insertDep = db.prepare(
        `INSERT INTO audit_report_dependencies (report_id, name, version, license, transitive) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const dep of dependencies) {
        statements.push(
          insertDep.bind(
            reportId,
            dep.name,
            dep.version,
            dep.license,
            dep.transitive ? 1 : 0,
          ),
        );
      }
    }

    if (statements.length > 0) {
      await db.batch(statements);
    }
  }

  return { auditId, reportId };
}

export async function incrementCacheHits(
  db: D1Database,
  reportId: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE audit_reports SET cache_hits = COALESCE(cache_hits, 0) + 1 WHERE id = ?`,
    )
    .bind(reportId)
    .run();
}

export async function getAuditById(
  db: D1Database,
  id: number,
): Promise<StoredAudit | null> {
  return db
    .prepare("SELECT * FROM package_audits WHERE id = ? LIMIT 1")
    .bind(id)
    .first<StoredAudit>();
}

export async function getAuditReportById(
  db: D1Database,
  id: number,
): Promise<StoredAuditReport | null> {
  return db
    .prepare("SELECT * FROM audit_reports WHERE id = ? LIMIT 1")
    .bind(id)
    .first<StoredAuditReport>();
}

export async function getAuditReportByCacheKey(
  db: D1Database,
  cacheKey: string,
): Promise<StoredAuditReport | null> {
  return db
    .prepare("SELECT * FROM audit_reports WHERE cache_key = ? LIMIT 1")
    .bind(cacheKey)
    .first<StoredAuditReport>();
}

export async function listAuditReports(
  db: D1Database,
  limit = 100,
): Promise<StoredAuditReportSummary[]> {
  const result = await db
    .prepare(
      `SELECT r.id, r.audit_id, r.prompt, r.model, r.score, r.created_at,
              a.name, a.version, a.source, a.url,
              JSON_EXTRACT(r.interaction_json, '$.provider') AS provider,
              JSON_EXTRACT(r.interaction_json, '$.tokensInput') AS tokens_input,
              JSON_EXTRACT(r.interaction_json, '$.tokensOutput') AS tokens_output,
              r.tokens_total,
              JSON_EXTRACT(r.interaction_json, '$.startedAt') AS started_at,
              JSON_EXTRACT(r.interaction_json, '$.finishedAt') AS finished_at,
              r.codebase_inspected
       FROM audit_reports r
       JOIN package_audits a ON a.id = r.audit_id
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<StoredAuditReportSummary>();
  return result.results || [];
}

export async function deleteAuditReport(
  db: D1Database,
  reportId: number,
): Promise<boolean> {
  const report = await getAuditReportById(db, reportId);
  if (!report) {
    return false;
  }

  // Remove the report, then the parent audit row when no other reports
  // reference it (its dependency rows cascade via FK / are removed first).
  await db.batch([
    db.prepare("DELETE FROM audit_reports WHERE id = ?").bind(reportId),
    db
      .prepare(
        `DELETE FROM package_dependencies
         WHERE audit_id = ?
           AND NOT EXISTS (SELECT 1 FROM audit_reports WHERE audit_id = ?)`,
      )
      .bind(report.audit_id, report.audit_id),
    db
      .prepare(
        `DELETE FROM package_audits
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM audit_reports WHERE audit_id = ?)`,
      )
      .bind(report.audit_id, report.audit_id),
  ]);

  return true;
}

export async function getReportByPublicId(
  db: D1Database,
  publicId: string,
): Promise<StoredReport | null> {
  return db
    .prepare("SELECT * FROM audit_reports WHERE public_id = ? LIMIT 1")
    .bind(publicId)
    .first<StoredReport>();
}

/**
 * Newest report for the same name+source created strictly before the given
 * timestamp, restricted to default-prompt reports (prompt IS NULL) so a
 * re-audit diff compares like with like.
 */
export async function getPreviousAuditReport(
  db: D1Database,
  name: string,
  source: string,
  beforeCreatedAt: string,
): Promise<StoredAuditReport | null> {
  return db
    .prepare(
      `SELECT ar.* FROM audit_reports ar
       JOIN package_audits pa ON pa.id = ar.audit_id
       WHERE pa.name = ? AND pa.source = ?
         AND ar.prompt IS NULL
         AND ar.created_at < ?
       ORDER BY ar.created_at DESC, ar.id DESC
       LIMIT 1`,
    )
    .bind(name, source, beforeCreatedAt)
    .first<StoredAuditReport>();
}
