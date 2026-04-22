-- FullSession Performance Monitor schema
-- Run with: sqlite3 data/perf.db < schema.sql

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS urls (
  url          TEXT PRIMARY KEY,
  tier         TEXT NOT NULL CHECK (tier IN ('tier0', 'core', 'post', 'other')),
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  last_checked TEXT,
  lastmod      TEXT,
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_urls_tier ON urls(tier);
CREATE INDEX IF NOT EXISTS idx_urls_active ON urls(active);

CREATE TABLE IF NOT EXISTS runs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  url               TEXT NOT NULL,
  gh_run_id         TEXT,
  device            TEXT NOT NULL CHECK (device IN ('mobile', 'desktop')),
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  status            TEXT NOT NULL CHECK (status IN ('ok', 'error', 'timeout')),
  error_message     TEXT,
  lcp_ms            REAL,
  fcp_ms            REAL,
  tbt_ms            REAL,
  cls               REAL,
  ttfb_ms           REAL,
  speed_index_ms    REAL,
  total_byte_weight INTEGER,
  request_count     INTEGER,
  performance_score REAL,
  screenshot_path   TEXT,
  report_path       TEXT,
  console_errors    INTEGER NOT NULL DEFAULT 0,
  console_errors_json TEXT,
  top_resources_json TEXT,
  is_retest         INTEGER NOT NULL DEFAULT 0,
  retest_median_of  INTEGER,
  FOREIGN KEY (url) REFERENCES urls(url)
);

CREATE INDEX IF NOT EXISTS idx_runs_url         ON runs(url);
CREATE INDEX IF NOT EXISTS idx_runs_url_device  ON runs(url, device, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_started     ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status      ON runs(status);

CREATE TABLE IF NOT EXISTS regressions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL,
  url            TEXT NOT NULL,
  device         TEXT NOT NULL,
  metric         TEXT NOT NULL,
  current_value  REAL,
  baseline_value REAL,
  pct_delta      REAL,
  severity       TEXT NOT NULL CHECK (severity IN ('warn', 'fail')),
  kind           TEXT NOT NULL CHECK (kind IN ('absolute', 'relative', 'console')),
  detected_at    TEXT NOT NULL,
  gh_issue       INTEGER,
  acknowledged   INTEGER NOT NULL DEFAULT 0,
  cleared_at     TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (url)    REFERENCES urls(url)
);

CREATE INDEX IF NOT EXISTS idx_reg_url      ON regressions(url);
CREATE INDEX IF NOT EXISTS idx_reg_open     ON regressions(cleared_at) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reg_detected ON regressions(detected_at DESC);

-- Queue of URLs needing attention (new, changed, flagged)
CREATE TABLE IF NOT EXISTS queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  url           TEXT NOT NULL,
  reason        TEXT NOT NULL CHECK (reason IN ('new', 'changed', 'flagged')),
  device        TEXT NOT NULL,
  runs_required INTEGER NOT NULL DEFAULT 1,
  enqueued_at   TEXT NOT NULL,
  processed_at  TEXT,
  FOREIGN KEY (url) REFERENCES urls(url)
);

CREATE INDEX IF NOT EXISTS idx_queue_pending ON queue(processed_at) WHERE processed_at IS NULL;
