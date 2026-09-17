import { z } from "zod";
import {
  getDb,
  addWatchlistItem,
  listWatchlistForUser,
  removeWatchlistItem,
  removeWatchlistItemByUrl,
} from "@/app/lib/db";
import { requireAuth } from "@/app/lib/auth";
import { parseJsonBody, parseWithSchema, withErrorHandling } from "@/app/lib/api";
import { AuditError } from "@/app/lib/errors";
import { normalizeLibraryUrl, parseGitHubUrl } from "@/app/lib/audit";

const watchTargetSchema = z.object({ libraryUrl: z.string().min(1) });

interface WatchTarget {
  source: string;
  name: string;
  url: string;
}

function resolveTarget(input: string): WatchTarget {
  const normalized = normalizeLibraryUrl(input);
  const github = parseGitHubUrl(normalized);
  if (github) {
    return {
      source: "github",
      name: `${github.owner}/${github.repo}`,
      url: normalized,
    };
  }
  // npm: normalizeLibraryUrl already produced /package/<name>
  const match = normalized.match(/npmjs\.com\/package\/(.+?)(?:\/|$)/);
  if (match) {
    return {
      source: "npm",
      name: decodeURIComponent(match[1]),
      url: normalized,
    };
  }
  throw new AuditError(
    "UNSUPPORTED_SOURCE",
    "Only npm package and GitHub repository URLs are supported.",
    422,
  );
}

export const GET = withErrorHandling(async (request: Request): Promise<Response> => {
  const db = await getDb();
  const user = await requireAuth(db, request);
  const items = await listWatchlistForUser(db, user.id);
  return Response.json({ items });
});

export const POST = withErrorHandling(async (request: Request): Promise<Response> => {
  const body = await parseJsonBody(request);
  const { libraryUrl } = parseWithSchema(watchTargetSchema, body);
  const db = await getDb();
  const user = await requireAuth(db, request);
  const target = resolveTarget(libraryUrl);
  try {
    const item = await addWatchlistItem(db, {
      user_id: user.id,
      ...target,
    });
    return Response.json({ item }, { status: 201 });
  } catch (err) {
    if (String(err).includes("UNIQUE")) {
      throw new AuditError("CONFLICT", "Already watching this package.", 409);
    }
    throw err;
  }
});

export const DELETE = withErrorHandling(
  async (request: Request): Promise<Response> => {
    const body = (await parseJsonBody(request)) as {
      id?: unknown;
      libraryUrl?: unknown;
    };
    const db = await getDb();
    const user = await requireAuth(db, request);
    if (typeof body.id === "number") {
      const ok = await removeWatchlistItem(db, user.id, body.id);
      if (!ok) {
        throw new AuditError("NOT_FOUND", "Watchlist item not found.", 404);
      }
      return Response.json({ ok: true });
    }
    if (typeof body.libraryUrl === "string") {
      const target = resolveTarget(body.libraryUrl);
      const ok = await removeWatchlistItemByUrl(
        db,
        user.id,
        target.source,
        target.name,
      );
      if (!ok) {
        throw new AuditError("NOT_FOUND", "Watchlist item not found.", 404);
      }
      return Response.json({ ok: true });
    }
    throw new AuditError("MISSING_INPUT", "Provide id or libraryUrl.", 400);
  },
);
