import { getDb } from "@/app/lib/db";
import { requireAdmin } from "@/app/lib/auth";
import { parseJsonBody, withErrorHandling } from "@/app/lib/api";
import { runReAuditTick } from "@/app/lib/re-audit";

const DEFAULT_LIMIT = 5;
const MIN_LIMIT = 1;
const MAX_LIMIT = 20;

function clampLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(parsed)));
}

export const POST = withErrorHandling(async (request: Request): Promise<Response> => {
  const db = await getDb();
  await requireAdmin(db, request);

  const body = (await parseJsonBody(request)) as
    | { limit?: unknown }
    | undefined;

  const limit = clampLimit(body?.limit);
  const result = await runReAuditTick(db, { limit });

  return Response.json({
    attempted: result.attempted,
    succeeded: result.succeeded,
    failed: result.failed,
    ...(result.stoppedReason ? { stoppedReason: result.stoppedReason } : {}),
    details: result.details,
  });
});
