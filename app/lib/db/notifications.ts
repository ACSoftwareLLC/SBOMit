export interface StoredNotification {
  id: number;
  user_id: number;
  type: string;
  target_source: string;
  target_name: string;
  report_id: number;
  previous_report_id: number;
  title: string;
  body: string;
  read: number;
  created_at: string;
}

export interface NotificationItem {
  id: number;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
  reportPublicId: string | null;
  previousReportPublicId: string | null;
}

export type NotificationInsert = Array<
  Omit<StoredNotification, "id" | "created_at" | "read">
>[number];

export async function insertNotifications(
  db: D1Database,
  rows: Array<Omit<StoredNotification, "id" | "created_at" | "read">>,
): Promise<void> {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO notifications (user_id, type, target_source, target_name, report_id, previous_report_id, title, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const stmts = rows.map((r) =>
    stmt.bind(r.user_id, r.type, r.target_source, r.target_name, r.report_id, r.previous_report_id, r.title, r.body),
  );
  await db.batch(stmts);
}

export async function deleteUnreadForTarget(
  db: D1Database,
  userId: number,
  source: string,
  name: string,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM notifications WHERE user_id = ? AND target_source = ? AND target_name = ? AND read = 0`,
    )
    .bind(userId, source, name)
    .run();
}

export async function listNotifications(
  db: D1Database,
  userId: number,
  opts: { unreadOnly?: boolean; limit: number; offset: number },
): Promise<{
  items: NotificationItem[];
  unreadCount: number;
  nextOffset: number | null;
}> {
  const limit = Math.max(0, Math.floor(opts.limit));
  const offset = Math.max(0, Math.floor(opts.offset));

  const readFilter = opts.unreadOnly ? " AND n.read = 0" : "";
  const { results } = await db
    .prepare(
      `SELECT n.id, n.user_id, n.type, n.title, n.body, n.read, n.created_at,
              r.public_id AS report_public_id,
              p.public_id AS previous_report_public_id
       FROM notifications n
       LEFT JOIN audit_reports r ON r.id = n.report_id
       LEFT JOIN audit_reports p ON p.id = n.previous_report_id
       WHERE n.user_id = ?${readFilter}
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(userId, limit, offset)
    .all<{
      id: number;
      type: string;
      title: string;
      body: string;
      read: number;
      created_at: string;
      report_public_id: string | null;
      previous_report_public_id: string | null;
    }>();

  const countRow = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM notifications n WHERE n.user_id = ?${readFilter}`,
    )
    .bind(userId)
    .first<{ c: number }>();

  const items: NotificationItem[] = (results ?? []).map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body,
    read: r.read === 1,
    createdAt: r.created_at,
    reportPublicId: r.report_public_id ?? null,
    previousReportPublicId: r.previous_report_public_id ?? null,
  }));

  const unreadCountRow = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0`,
    )
    .bind(userId)
    .first<{ c: number }>();

  const unreadCount = unreadCountRow?.c ?? 0;
  const nextOffset = offset + items.length < (countRow?.c ?? 0) ? offset + limit : null;

  return { items, unreadCount, nextOffset };
}

export async function markNotificationsRead(
  db: D1Database,
  userId: number,
  ids?: number[],
): Promise<number> {
  if (ids && ids.length === 0) return 0;
  if (ids) {
    const placeholders = ids.map(() => "?").join(", ");
    const res = await db
      .prepare(
        `UPDATE notifications SET read = 1 WHERE user_id = ? AND id IN (${placeholders}) AND read = 0`,
      )
      .bind(userId, ...ids)
      .run();
    return res.meta?.changes ?? 0;
  }
  const res = await db
    .prepare(`UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0`)
    .bind(userId)
    .run();
  return res.meta?.changes ?? 0;
}
