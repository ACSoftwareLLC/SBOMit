-- Watchlists for scheduled re-audits (M3).
-- Per-user watch entries; UNIQUE constraint makes re-watching idempotent-safe.
CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, source, name)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_target ON watchlist(source, name);

-- Dedupe/scheduling state: one row per distinct watched target, independent
-- of how many users watch it. The re-audit runner updates last_audited_at.
CREATE TABLE IF NOT EXISTS watchlist_targets (
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  last_audited_at TEXT,
  PRIMARY KEY (source, name)
);
