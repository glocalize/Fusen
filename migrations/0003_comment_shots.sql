-- コメント作成時のスクリーンショット(サムネイル)を追加 (D1 / SQLite)
-- 本体とは別テーブルにする理由: comments は listComments で SELECT * するため、
-- 同テーブルに画像(base64, 最大40万文字≒300KB)を持たせると一覧取得のたびに
-- 大きなblobを引きずってしまう。画像は必要な時(スレッド表示時)にだけ個別取得する。

CREATE TABLE comment_shots (
  comment_id TEXT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  data_b64   TEXT NOT NULL,
  created_at TEXT NOT NULL
);
