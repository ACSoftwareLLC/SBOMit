import { z } from "zod";
import { getDb, listNotifications } from "@/app/lib/db";
import { requireAuth } from "@/app/lib/auth";
import { withErrorHandling } from "@/app/lib/api";
import { AuditError } from "@/app/lib/errors";

// Carried route contract (Task 1+2 review): limit=0 must not pass through —
// the DB layer clamps to >=0, which would produce a self-referential
// nextOffset at 0. The route rejects it; the DB keeps its own guard.
const querySchema = z.object({
  unread: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = withErrorHandling(
  async (request: Request): Promise<Response> => {
    const db = await getDb();
    const user = await requireAuth(db, request);

    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      unread: url.searchParams.get("unread") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
    });
    if (!parsed.success) {
      throw new AuditError(
        "MISSING_INPUT",
        "Invalid query parameters.",
        400,
      );
    }
    const { unread, limit, offset } = parsed.data;

    const result = await listNotifications(db, user.id, {
      unreadOnly: unread === "1",
      limit,
      offset,
    });
    return Response.json(result);
  },
);
