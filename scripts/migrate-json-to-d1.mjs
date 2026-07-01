// data/db.json → seed.sql 生成(D1 へ一括投入するための INSERT 文)
// 実行: node scripts/migrate-json-to-d1.mjs   → fusen/seed.sql を出力
// 投入: npx wrangler d1 execute fusen-db --local  --file=seed.sql   (まずローカル)
//       npx wrangler d1 execute fusen-db --remote --file=seed.sql   (本番)
import { readFileSync, writeFileSync } from "node:fs";

const src = JSON.parse(readFileSync(new URL("../data/db.json", import.meta.url), "utf8"));

// SQL リテラル化: null→NULL / boolean→0,1 / number→数値 / それ以外→'...'(' をエスケープ)
function lit(x) {
  if (x === null || x === undefined) return "NULL";
  if (typeof x === "boolean") return x ? "1" : "0";
  if (typeof x === "number") return Number.isFinite(x) ? String(x) : "0";
  return "'" + String(x).replace(/'/g, "''") + "'";
}

// テーブルごとの列(スキーマと一致。順序は明示するので db.json のキー順に依存しない)
const COLS = {
  users: ["id", "name", "guest", "created_at"],
  canvases: ["id", "title", "url", "host", "share_token", "archived", "created_by", "created_at"],
  comments: ["id", "canvas_id", "page", "selector", "rx", "ry", "ax", "ay", "body", "author", "author_id", "guest", "status", "parent_id", "resolved_by", "created_at"],
  reviews: ["id", "canvas_id", "verdict", "comment", "author", "created_at"],
};

// スキーマに無いキーがあれば警告(データ取りこぼし検知)
for (const [t, cols] of Object.entries(COLS)) {
  for (const row of src[t] || []) {
    for (const k of Object.keys(row)) {
      if (!cols.includes(k)) console.error(`WARN ${t}: 未マッピングのキー "${k}" は seed に含まれません`);
    }
  }
}

function inserts(table, cols, rows) {
  return (rows || [])
    .map((r) => `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => lit(r[c])).join(", ")});`)
    .join("\n");
}

// 外部キー順序: users → canvases → comments → reviews
const sql =
  [
    "-- Fusen データ移行 seed (data/db.json から生成)。再生成可。",
    inserts("users", COLS.users, src.users),
    inserts("canvases", COLS.canvases, src.canvases),
    inserts("comments", COLS.comments, src.comments),
    inserts("reviews", COLS.reviews, src.reviews),
  ]
    .filter(Boolean)
    .join("\n\n") + "\n";

writeFileSync(new URL("../seed.sql", import.meta.url), sql);
console.error(
  `seed.sql 生成完了: users=${(src.users || []).length} canvases=${(src.canvases || []).length} comments=${(src.comments || []).length} reviews=${(src.reviews || []).length}`
);
