import { z } from "zod";
import { getDb, markNotificationsRead } from "@/app/lib/db";
import { requireAuth } from "@/app/lib/auth";
import {
  parseJsonBody,
  parseWithSchema,
  withErrorHandling,
} from "@/app/lib/api";

// Carried route contracts (Task 1+2 review):
// - ids:[] is an explicit NO-OP (updated 0), never mark-all.
// - ids length capped at 99: D1's ~100 bound-parameter limit would reject
//   larger IN(...) lists at the DB layer with an opaque error.
const readSchema = z.object({
  ids: z.array(z.number().int()).max(99).optional(),
});

export const POST = withErrorHandling(
  async (request: Request): Promise<Response> => {
    const db = await getDb();
    const user = await requireAuth(db, request);
    const body = await parseJsonBody(request);
    const { ids } = parseWithSchema(readSchema, body);

    const updated = await markNotificationsRead(db, user.id, ids);
    return Response.json({ updated });
  },
);
