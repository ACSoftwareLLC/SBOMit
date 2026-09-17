import {
  deleteAuditReport,
  getAuditById,
  getAuditReportById,
  getDb,
  getPreviousAuditReport,
} from "@/app/lib/db";
import { MissingInputError, ReportNotFoundError } from "@/app/lib/errors";
import type { LlmInteraction } from "@/app/lib/llm";
import { auditResultSchema, type AuditResult } from "@/app/lib/audit";
import { diffReports } from "@/app/lib/report-diff";
import { withErrorHandling } from "@/app/lib/api";

function parseReportId(id: string): number {
  const reportId = Number.parseInt(id, 10);
  if (!Number.isInteger(reportId) || reportId <= 0) {
    throw new MissingInputError("A numeric report id is required.");
  }
  return reportId;
}

export const GET = withErrorHandling(async (
  request: Request,
  ctx: RouteContext<"/api/audits/[id]">,
): Promise<Response> => {
  const { id } = await ctx.params;
  const reportId = parseReportId(id);

  const db = await getDb();
  const report = await getAuditReportById(db, reportId);
  if (!report) {
    throw new ReportNotFoundError(reportId);
  }

  const audit = await getAuditById(db, report.audit_id);
  if (!audit) {
    throw new ReportNotFoundError(reportId);
  }

  const result = JSON.parse(report.result_json) as AuditResult;
  const interactions = report.interaction_json
    ? (JSON.parse(report.interaction_json) as LlmInteraction | LlmInteraction[])
    : undefined;
  const normalizedInteractions = interactions
    ? Array.isArray(interactions)
      ? interactions
      : [interactions]
    : undefined;

  // ?diff=1 additionally compares this report against the newest earlier
  // default-prompt report for the same name+source (on-read diffing; see
  // docs/superpowers/specs/2026-09-16-re-audit-scheduling-design.md §6).
  let diffPayload: {
    diff: ReturnType<typeof diffReports> | null;
    previousReportId: number | null;
    previousReportPublicId: string | null;
  } | undefined;
  const url = new URL(request.url);
  if (url.searchParams.get("diff") === "1") {
    const previous = await getPreviousAuditReport(
      db,
      audit.name,
      audit.source,
      report.created_at,
    );
    if (previous && previous.id !== report.id) {
      try {
        const previousResult = auditResultSchema.parse(
          JSON.parse(previous.result_json),
        );
        diffPayload = {
          diff: diffReports(previousResult, result),
          previousReportId: previous.id,
          previousReportPublicId: previous.public_id,
        };
      } catch {
        // Previous report is corrupted — report no diff rather than failing.
        diffPayload = {
          diff: null,
          previousReportId: null,
          previousReportPublicId: null,
        };
      }
    } else {
      diffPayload = {
        diff: null,
        previousReportId: null,
        previousReportPublicId: null,
      };
    }
  }

  return Response.json(
    {
      audit: {
        id: audit.id,
        name: audit.name,
        version: audit.version,
        source: audit.source,
        url: audit.url,
        audited_at: audit.audited_at,
      },
      report: {
        id: report.id,
        prompt: report.prompt,
        model: report.model,
        score: report.score,
        created_at: report.created_at,
        ...(diffPayload ?? {}),
      },
      result,
      interactions: normalizedInteractions,
    },
    { status: 200 },
  );
});

export const DELETE = withErrorHandling(async (
  _request: Request,
  ctx: RouteContext<"/api/audits/[id]">,
): Promise<Response> => {
  const { id } = await ctx.params;
  const reportId = parseReportId(id);

  const db = await getDb();
  const deleted = await deleteAuditReport(db, reportId);
  if (!deleted) {
    throw new ReportNotFoundError(reportId);
  }

  return Response.json({ deleted: true, reportId }, { status: 200 });
});
