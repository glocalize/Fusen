// lib/db-d1.js の検証。Node 22 内蔵 node:sqlite で D1 バインディングを模擬する。
// 実行: node --experimental-sqlite scripts/test-d1.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import * as q from "../lib/db-d1.js";
import { buildSeedSql } from "./seed-sql.mjs";

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ok   -", msg); }
  else { fail++; console.error("  FAIL -", msg); }
}

// ---- D1 互換シム: prepare().bind().all()/.first()/.run() を node:sqlite で再現 ----
function d1(sq) {
  return {
    prepare(sql) {
      const stmt = sq.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a.map((x) => (x === undefined ? null : x)); return api; },
        async all() { return { results: stmt.all(...args), success: true }; },
        async first(col) {
          const row = stmt.get(...args);
          if (row === undefined || row === null) return null;
          return col ? row[col] : row;
        },
        async run() { const i = stmt.run(...args); return { success: true, meta: { changes: i.changes } }; },
      };
      return api;
    },
  };
}

const here = (p) => new URL(p, import.meta.url);
// migrations/ 配下の *.sql をファイル名順(0001_..., 0002_...)に全部連結して適用する。
function loadSchema() {
  const dir = here("../migrations/");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  return files.map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
}
const schema = loadSchema();
const now = () => new Date().toISOString();

// ============ Part 1: db-d1.js の関数を実行して検証 ============
console.log("Part 1: データアクセス層の動作");
const sq = new DatabaseSync(":memory:");
sq.exec("PRAGMA foreign_keys = ON;");
sq.exec(schema);
const DB = d1(sq);

const u = await q.addUser(DB, { id: "u_t", name: "テスト", guest: false, created_at: now() });
assert(u.guest === false, "addUser は guest を boolean で返す");
const f = await q.findUser(DB, "テスト", false);
assert(f && f.id === "u_t", "findUser が一致ユーザーを返す");
assert((await q.findUser(DB, "テスト", true)) === null, "findUser は guest 違いを区別する");

const c = await q.addCanvas(DB, { id: "c_t", title: "サイト", url: "https://ex.com/", host: "ex.com", share_token: "s_t", archived: false, created_by: "テスト", created_at: now() });
assert(c.archived === false && c.comment_count === 0 && c.open_count === 0, "addCanvas のサマリ初期値");

const m1 = await q.addComment(DB, { id: "m1", canvas_id: "c_t", page: "https://ex.com/", selector: "a > b:nth-of-type(1)", rx: 0.5, ry: 0.25, ax: 10, ay: 20, body: "親 it's ok", author: "テスト", author_id: "u_t", guest: false, status: "active", parent_id: null, created_at: now() });
assert(m1.guest === false && m1.resolved_by === null, "addComment の正規化(guest/resolved_by)");
await q.addComment(DB, { id: "m2", canvas_id: "c_t", page: "https://ex.com/other", selector: null, rx: 0, ry: 0, ax: 0, ay: 0, body: "返信", author: "テスト", author_id: "u_t", guest: false, status: "active", parent_id: "m1", created_at: now() });

assert((await q.listComments(DB, "c_t")).length === 2, "listComments(page無) は全件");
assert((await q.listComments(DB, "c_t", "https://ex.com/")).length === 2, "listComments(page) は該当トップレベル+返信");

let sum = await q.canvasSummary(DB, await q.getCanvas(DB, "c_t"));
assert(sum.comment_count === 1, "comment_count はトップレベルのみ(返信を除外)");
assert(sum.open_count === 1, "open_count は未解決トップレベル");

await q.setCommentStatus(DB, "m1", "resolved", "テスト");
sum = await q.canvasSummary(DB, await q.getCanvas(DB, "c_t"));
assert(sum.open_count === 0, "解決すると open_count が減る");
const got = await q.getComment(DB, "m1");
assert(got.status === "resolved" && got.resolved_by === "テスト", "setCommentStatus が反映される");

assert((await q.deleteCommentCascade(DB, "m1")) === true, "deleteCommentCascade は存在時 true");
assert((await q.listComments(DB, "c_t")).length === 0, "親削除で返信も連鎖削除");
assert((await q.deleteCommentCascade(DB, "m1")) === false, "存在しない削除は false");

await q.addReview(DB, { id: "r1", canvas_id: "c_t", verdict: "approved", comment: "OK", author: "テスト", created_at: now() });
assert((await q.listReviews(DB, "c_t")).length === 1, "addReview / listReviews");
sum = await q.canvasSummary(DB, await q.getCanvas(DB, "c_t"));
assert(sum.last_review && sum.last_review.verdict === "approved", "サマリに last_review");

await q.updateCanvas(DB, "c_t", { archived: true, title: "改名" });
const c2 = await q.getCanvas(DB, "c_t");
assert(c2.archived === true && c2.title === "改名", "updateCanvas(archived/title)");
assert((await q.listCanvases(DB, false)).length === 0, "listCanvases(false) はアーカイブ除外");
assert((await q.listCanvases(DB, true)).length === 1, "listCanvases(true) はアーカイブのみ");
assert((await q.getCanvasByToken(DB, "s_t")).id === "c_t", "getCanvasByToken");

// ---- コメントのコンテキスト(#モーダルコメント問題対応) ----
const mCtxA = await q.addComment(DB, {
  id: "mctxA", canvas_id: "c_t", page: "https://ex.com/", selector: "div.modal button",
  rx: 0, ry: 0, ax: 0, ay: 0, body: "モーダルのコメント", author: "テスト", author_id: "u_t",
  guest: false, status: "active", parent_id: null, created_at: now(),
  ctx_label: "保存ボタン", ctx_modal: true, ctx_modal_label: "設定",
});
assert(
  mCtxA.ctx_modal === true && mCtxA.ctx_label === "保存ボタン" && mCtxA.ctx_modal_label === "設定",
  "addComment: ctx_label/ctx_modal(true)/ctx_modal_label を渡すと boolean で返る"
);

const mCtxB = await q.addComment(DB, {
  id: "mctxB", canvas_id: "c_t", page: "https://ex.com/", selector: "h1",
  rx: 0, ry: 0, ax: 0, ay: 0, body: "通常コメント", author: "テスト", author_id: "u_t",
  guest: false, status: "active", parent_id: null, created_at: now(), ctx_modal: null,
});
assert(mCtxB.ctx_modal === null, "addComment: ctx_modal:null で作ったコメントは null で返る");

const backfilled = await q.setCommentContext(DB, "mctxB", { ctx_label: "後付けラベル", ctx_modal: true, ctx_modal_label: "後付けモーダル" });
assert(
  backfilled.ctx_modal === true && backfilled.ctx_label === "後付けラベル" && backfilled.ctx_modal_label === "後付けモーダル",
  "setCommentContext: ctx_modal IS NULL のときは反映される"
);

const notOverwritten = await q.setCommentContext(DB, "mctxB", { ctx_label: "上書き試行", ctx_modal: false, ctx_modal_label: "上書き試行モーダル" });
assert(
  notOverwritten.ctx_modal === true && notOverwritten.ctx_label === "後付けラベル",
  "setCommentContext: 取得済み(ctx_modal IS NOT NULL)は2回目の呼び出しで上書きされない"
);

// ---- コメントのスクリーンショット(comment_shots) ----
{
  const shotOwner = await q.addComment(DB, {
    id: "mshot", canvas_id: "c_t", page: "https://ex.com/", selector: "h1",
    rx: 0, ry: 0, ax: 0, ay: 0, body: "スクショ対象", author: "テスト", author_id: "u_t",
    guest: false, status: "active", parent_id: null, created_at: now(),
  });
  assert(shotOwner.has_shot === false, "addComment: 直後は has_shot が false");

  const inserted1 = await q.addCommentShot(DB, { comment_id: "mshot", mime: "image/jpeg", data_b64: "AAAA", created_at: now() });
  assert(inserted1 === true, "addCommentShot: 初回挿入は true");
  const inserted2 = await q.addCommentShot(DB, { comment_id: "mshot", mime: "image/png", data_b64: "BBBB", created_at: now() });
  assert(inserted2 === false, "addCommentShot: 2回目(冪等)は false");

  const shot = await q.getCommentShot(DB, "mshot");
  assert(shot && shot.mime === "image/jpeg" && shot.data_b64 === "AAAA", "getCommentShot: first-writer-wins の内容が返る(2回目で上書きされない)");
  assert((await q.getCommentShot(DB, "no-such-comment")) === null, "getCommentShot: 無い場合は null");

  const withShot = await q.getComment(DB, "mshot");
  assert(withShot.has_shot === true, "getComment: shot があると has_shot が true");
  const listed = await q.listComments(DB, "c_t");
  const listedShot = listed.find((x) => x.id === "mshot");
  assert(listedShot.has_shot === true, "listComments: has_shot が boolean(true)で載る");
  assert(typeof listedShot.has_shot === "boolean" && listed.every((x) => typeof x.has_shot === "boolean"), "listComments: 全件で has_shot が boolean");

  // 返信にも shot を付けて、親削除で両方消えることを確認
  await q.addComment(DB, {
    id: "mshotReply", canvas_id: "c_t", page: "https://ex.com/", selector: null,
    rx: 0, ry: 0, ax: 0, ay: 0, body: "返信", author: "テスト", author_id: "u_t",
    guest: false, status: "active", parent_id: "mshot", created_at: now(),
  });
  await q.addCommentShot(DB, { comment_id: "mshotReply", mime: "image/jpeg", data_b64: "CCCC", created_at: now() });
  assert((await q.getCommentShot(DB, "mshotReply")) !== null, "返信にも shot が保存できる");

  await q.deleteCommentCascade(DB, "mshot");
  assert((await q.getCommentShot(DB, "mshot")) === null, "deleteCommentCascade: 本体の shot も消える");
  assert((await q.getCommentShot(DB, "mshotReply")) === null, "deleteCommentCascade: 返信の shot も連鎖で消える");
}

// ============ Part 2: データ移行(buildSeedSql)の件数/整合性 ============
// git 管理外の実データではなく合成フィクスチャで検証する(hermetic)。
// buildSeedSql の出力がソースの件数どおりに投入され、FK 的にも孤立が無いことを確認。
console.log("Part 2: データ移行(buildSeedSql)の検証");
{
  const src = JSON.parse(readFileSync(here("../test/fixtures/db.json"), "utf8"));
  const sq2 = new DatabaseSync(":memory:");
  sq2.exec("PRAGMA foreign_keys = ON;");
  sq2.exec(schema);
  sq2.exec(buildSeedSql(src));
  const cnt = (t) => sq2.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
  assert(cnt("users") === src.users.length, `users 件数一致 (${cnt("users")} = ${src.users.length})`);
  assert(cnt("canvases") === src.canvases.length, `canvases 件数一致 (${cnt("canvases")} = ${src.canvases.length})`);
  assert(cnt("comments") === src.comments.length, `comments 件数一致 (${cnt("comments")} = ${src.comments.length})`);
  assert(cnt("reviews") === src.reviews.length, `reviews 件数一致 (${cnt("reviews")} = ${src.reviews.length})`);
  const orphC = sq2.prepare("SELECT count(*) AS n FROM comments WHERE canvas_id NOT IN (SELECT id FROM canvases)").get().n;
  const orphR = sq2.prepare("SELECT count(*) AS n FROM reviews WHERE canvas_id NOT IN (SELECT id FROM canvases)").get().n;
  assert(orphC === 0 && orphR === 0, "孤立した comments/reviews が無い");
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
