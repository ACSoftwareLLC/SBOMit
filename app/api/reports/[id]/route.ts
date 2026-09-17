import { AuditError } from "@/app/lib/errors";
import {
  getDb,
  getReportByPublicId,
  getAuditById,
  getPreviousAuditReport,
} from "@/app/lib/db";
import { auditResultSchema, type AuditResult } from "@/app/lib/audit";
import { diffReports } from "@/app/lib/report-diff";
import { checkRateLimit } from "@/app/lib/rate-limit";
import { withErrorHandling } from "@/app/lib/api";

const RATE_LIMIT = { maxRequests: 30, windowMs: 60_000 };

export const GET = withErrorHandling(async (
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> => {
  const rateLimit = checkRateLimit(request, RATE_LIMIT);
  if (!rateLimit.allowed) {
    throw new AuditError(
      "RATE_LIMIT_EXCEEDED",
      "Too many requests. Please slow down.",
      429,
      rateLimit.resetAt,
    );
  }

  const { id } = await params;
  if (!id) {
    throw new AuditError("BAD_REQUEST", "Report ID is required.", 400);
  }

  const db = await getDb();
  const report = await getReportByPublicId(db, id);
  if (!report) {
    throw new AuditError("NOT_FOUND", "Report not found.", 404);
  }

  let result: AuditResult;
  try {
    result = auditResultSchema.parse(JSON.parse(report.result_json));
  } catch {
    throw new AuditError(
      "INTERNAL_ERROR",
      "Stored report is corrupted.",
      500,
    );
  }

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
    const audit = await getAuditById(db, report.audit_id);
    const previous = audit
      ? await getPreviousAuditReport(db, audit.name, audit.source, report.created_at)
      : null;

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
      report: {
        id: report.public_id,
        model: report.model,
        score: report.score,
        createdAt: report.created_at,
        result,
        ...(diffPayload ?? {}),
      },
    },
    {
      headers: {
        "X-RateLimit-Limit": String(RATE_LIMIT.maxRequests),
        "X-RateLimit-Remaining": String(rateLimit.remaining),
        "X-RateLimit-Reset": String(rateLimit.resetAt),
      },
    },
  );
});
