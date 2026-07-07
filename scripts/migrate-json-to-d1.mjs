// data/db.json → seed.sql 生成(D1 へ一括投入するための INSERT 文)
// 実行: node scripts/migrate-json-to-d1.mjs   → fusen/seed.sql を出力
// 投入: npx wrangler d1 execute fusen-db --local  --file=seed.sql   (まずローカル)
//       npx wrangler d1 execute fusen-db --remote --file=seed.sql   (本番)
import { readFileSync, writeFileSync } from "node:fs";
import { buildSeedSql, findUnmappedKeys } from "./seed-sql.mjs";

const src = JSON.parse(readFileSync(new URL("../data/db.json", import.meta.url), "utf8"));

// スキーマに無いキーがあれば警告(データ取りこぼし検知)
for (const w of findUnmappedKeys(src)) {
  console.error(`WARN ${w.table}: 未マッピングのキー "${w.key}" は seed に含まれません`);
}

writeFileSync(new URL("../seed.sql", import.meta.url), buildSeedSql(src));
console.error(
  `seed.sql 生成完了: users=${(src.users || []).length} canvases=${(src.canvases || []).length} comments=${(src.comments || []).length} reviews=${(src.reviews || []).length}`
);
