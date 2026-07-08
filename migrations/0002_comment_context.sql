-- コメント対象のコンテキスト情報を追加 (D1 / SQLite)
-- モーダル/ダイアログに対するコメントは、モーダルが閉じると「何に対するコメントか」が
-- 分からなくなる問題への対応。作成時に取得できたコンテキストを保存し、取得できなかった
-- 既存コメントには表示時にクライアントから PATCH で遅延バックフィルできるようにする。

ALTER TABLE comments ADD COLUMN ctx_label TEXT;       -- 対象要素の人間可読ラベル
ALTER TABLE comments ADD COLUMN ctx_modal INTEGER;    -- 1=モーダル/ダイアログ内, 0=通常要素, NULL=未取得(migration前の既存コメント)
ALTER TABLE comments ADD COLUMN ctx_modal_label TEXT; -- モーダルの見出しテキスト
