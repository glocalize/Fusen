// データ(users/canvases/comments/reviews)→ D1 投入用 INSERT 文の生成。
// 実データ移行(migrate-json-to-d1.mjs)と、テストの合成フィクスチャの
// 両方から使う共有ロジック。ここを単一の真実にしておくことで、テストが
// git 管理外の seed.sql に依存せず hermetic に動く。

// テーブルごとの列(スキーマと一致。順序は明示するのでソースのキー順に依存しない)
export const SEED_COLS = {
  users: ["id", "name", "guest", "created_at"],
  canvases: ["id", "title", "url", "host", "share_token", "archived", "created_by", "created_at"],
  comments: ["id", "canvas_id", "page", "selector", "rx", "ry", "ax", "ay", "body", "author", "author_id", "guest", "status", "parent_id", "resolved_by", "created_at"],
  reviews: ["id", "canvas_id", "verdict", "comment", "author", "created_at"],
};

// SQL リテラル化: null→NULL / boolean→0,1 / number→数値 / それ以外→'...'(' をエスケープ)
function lit(x) {
  if (x === null || x === undefined) return "NULL";
  if (typeof x === "boolean") return x ? "1" : "0";
  if (typeof x === "number") return Number.isFinite(x) ? String(x) : "0";
  return "'" + String(x).replace(/'/g, "''") + "'";
}

function inserts(table, cols, rows) {
  return (rows || [])
    .map((r) => `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => lit(r[c])).join(", ")});`)
    .join("\n");
}

// スキーマに無いキー(seed に含まれず取りこぼす)を検出して列挙。呼び出し側で警告表示に使う。
export function findUnmappedKeys(src) {
  const warnings = [];
  for (const [t, cols] of Object.entries(SEED_COLS)) {
    for (const row of src[t] || []) {
      for (const k of Object.keys(row)) {
        if (!cols.includes(k)) warnings.push({ table: t, key: k });
      }
    }
  }
  return warnings;
}

// ソースオブジェクトから seed SQL 文字列を生成。外部キー順序: users → canvases → comments → reviews。
export function buildSeedSql(src) {
  return (
    [
      "-- Fusen データ seed(buildSeedSql で生成)。再生成可。",
      inserts("users", SEED_COLS.users, src.users),
      inserts("canvases", SEED_COLS.canvases, src.canvases),
      inserts("comments", SEED_COLS.comments, src.comments),
      inserts("reviews", SEED_COLS.reviews, src.reviews),
    ]
      .filter(Boolean)
      .join("\n\n") + "\n"
  );
}
