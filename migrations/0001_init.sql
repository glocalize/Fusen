-- Fusen 初期スキーマ (D1 / SQLite)
-- 旧 data/db.json の users / canvases / comments / reviews を移植。
-- 参考: Fusen_SQLite移行メモ.md §4。resolved_by 列を追加(api.js のコメント解決で使用)。

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  guest       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE canvases (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  host        TEXT NOT NULL,
  share_token TEXT NOT NULL UNIQUE,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE comments (
  id          TEXT PRIMARY KEY,
  canvas_id   TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  page        TEXT NOT NULL,
  selector    TEXT,
  rx REAL, ry REAL, ax REAL, ay REAL,
  body        TEXT NOT NULL,
  author      TEXT NOT NULL,
  author_id   TEXT,
  guest       INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active',
  parent_id   TEXT,
  resolved_by TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE reviews (
  id          TEXT PRIMARY KEY,
  canvas_id   TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  verdict     TEXT NOT NULL,
  comment     TEXT,
  author      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_comments_canvas ON comments(canvas_id);
CREATE INDEX idx_comments_parent ON comments(parent_id);
CREATE INDEX idx_reviews_canvas  ON reviews(canvas_id);
