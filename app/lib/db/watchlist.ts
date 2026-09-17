// D1 helpers for watchlists and re-audit target scheduling (M3).

export interface StoredWatchlistItem {
  id: number;
  user_id: number;
  source: string;
  name: string;
  url: string;
  created_at: string;
}

export interface WatchlistTargetRow {
  source: string;
  name: string;
  url: string;
  last_audited_at: string | null;
  watcher_count: number;
}

export async function addWatchlistItem(
  db: D1Database,
  input: { user_id: number; source: string; name: string; url: string },
): Promise<StoredWatchlistItem> {
  const res = await db
    .prepare(`INSERT INTO watchlist (user_id, source, name, url) VALUES (?, ?, ?, ?)`)
    .bind(input.user_id, input.source, input.name, input.url)
    .run();
  const id = res.meta?.last_row_id as number;
  const row = await db
    .prepare(`SELECT * FROM watchlist WHERE id = ?`)
    .bind(id)
    .first<StoredWatchlistItem>();
  if (!row) throw new Error("Failed to load watchlist item.");
  return row;
}

export async function removeWatchlistItem(
  db: D1Database,
  userId: number,
  id: number,
): Promise<boolean> {
  const res = await db
    .prepare(`DELETE FROM watchlist WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function removeWatchlistItemByUrl(
  db: D1Database,
  userId: number,
  source: string,
  name: string,
): Promise<boolean> {
  const res = await db
    .prepare(`DELETE FROM watchlist WHERE user_id = ? AND source = ? AND name = ?`)
    .bind(userId, source, name)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function listWatchlistForUser(
  db: D1Database,
  userId: number,
): Promise<StoredWatchlistItem[]> {
  const { results } = await db
    .prepare(`SELECT * FROM watchlist WHERE user_id = ? ORDER BY created_at DESC`)
    .bind(userId)
    .all<StoredWatchlistItem>();
  return results ?? [];
}

export async function getEligibleReAuditTargets(
  db: D1Database,
  limit: number,
  minAgeHours: number,
): Promise<WatchlistTargetRow[]> {
  const { results } = await db
    .prepare(
      `SELECT w.source, w.name, w.url, t.last_audited_at, COUNT(*) as watcher_count
       FROM watchlist w
       LEFT JOIN watchlist_targets t ON t.source = w.source AND t.name = w.name
       GROUP BY w.source, w.name
       HAVING t.last_audited_at IS NULL
          OR t.last_audited_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now','-' || ? || ' hours')
       ORDER BY t.last_audited_at IS NOT NULL, t.last_audited_at ASC
       LIMIT ?`,
    )
    .bind(minAgeHours, limit)
    .all<WatchlistTargetRow>();
  return results ?? [];
}

export async function markTargetAudited(
  db: D1Database,
  source: string,
  name: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO watchlist_targets (source, name, last_audited_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT (source, name) DO UPDATE SET last_audited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(source, name)
    .run();
}
