// Hono ルートの統合テスト。app.request() に node:sqlite 製の D1 シムと
// ASSETS / fetch のモックを渡して、実際のリクエストでルートを叩く。
// 実行: node --experimental-sqlite scripts/test-routes.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import app from "../src/index.js";

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ok   -", msg); }
  else { fail++; console.error("  FAIL -", msg); }
}

// ---- D1 互換シム(node:sqlite) ----
function d1(sq) {
  return {
    prepare(sql) {
      const stmt = sq.prepare(sql);
      let args = [];
      const a = {
        bind(...xs) { args = xs.map((x) => (x === undefined ? null : x)); return a; },
        async all() { return { results: stmt.all(...args), success: true }; },
        async first(col) { const r = stmt.get(...args); if (r == null) return null; return col ? r[col] : r; },
        async run() { const i = stmt.run(...args); return { success: true, meta: { changes: i.changes } }; },
      };
      return a;
    },
  };
}

const here = (p) => new URL(p, import.meta.url);
const sq = new DatabaseSync(":memory:");
sq.exec("PRAGMA foreign_keys = ON;");
sq.exec(readFileSync(here("../migrations/0001_init.sql"), "utf8"));
sq.exec(readFileSync(here("../seed.sql"), "utf8")); // 既存4キャンバス等

// ASSETS モック(静的配信)。リクエストパスを反映した HTML を返す。
const ASSETS = {
  fetch: async (req) => new Response(`<!doctype html><html><body>ASSET ${new URL(req.url).pathname}</body></html>`, { headers: { "content-type": "text/html" } }),
};

// 上流サイトのモック(check-url / proxy / relay 用)。常に HTML 200。
globalThis.fetch = async () => new Response("<html><head></head><body><h1>Hello</h1></body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

const env = { DB: d1(sq), ASSETS };
const req = (path, init = {}) => app.request(path, init, env);
const J = (obj) => ({ headers: { "content-type": "application/json" }, method: "POST", body: JSON.stringify(obj) });

console.log("ルート統合テスト");

// 1) D1 疎通
let r = await req("/api/_health");
let j = await r.json();
assert(r.status === 200 && j.ok && j.canvases === 4, `/api/_health → canvases=4 (got ${j.canvases})`);

// 2) 未ログインの / は /login へ
r = await req("/");
assert(r.status === 302 && r.headers.get("location") === "/login", "未ログインの / は /login へリダイレクト");

// 3) 未ログインの保護APIは 401
r = await req("/api/canvases");
assert(r.status === 401, "未ログインの /api/canvases は 401");

// 4) ログイン
r = await req("/api/login", J({ name: "太郎" }));
j = await r.json();
assert(r.status === 200 && j.user?.name === "太郎" && j.user?.guest === false, "ログインでユーザー作成");
const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
assert(/^fsn_user=/.test(cookie), "Set-Cookie(fsn_user)が返る");
const auth = (extra = {}) => ({ headers: { Cookie: cookie, ...extra } });
const authJ = (obj) => ({ method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify(obj) });

// 5) /api/me
r = await req("/api/me", auth());
j = await r.json();
assert(j.user?.name === "太郎", "/api/me が本人を返す");

// 6) 一覧(seed のアーカイブ状態を実データから算出して検証)
const seedCanvases = JSON.parse(readFileSync(here("../data/db.json"), "utf8")).canvases;
const activeN = seedCanvases.filter((x) => !x.archived).length;
const archivedN = seedCanvases.length - activeN;
r = await req("/api/canvases", auth());
j = await r.json();
assert(r.status === 200 && Array.isArray(j.canvases) && j.canvases.length === activeN, `/api/canvases(active) → ${activeN}件 (got ${j.canvases?.length})`);
assert(typeof j.canvases[0].comment_count === "number" && typeof j.canvases[0].archived === "boolean", "サマリに件数/boolean が含まれる");
const ra = await req("/api/canvases?archived=1", auth());
const ja = await ra.json();
assert(ja.canvases.length === archivedN, `/api/canvases(archived) → ${archivedN}件 (got ${ja.canvases?.length})`);

// 7) キャンバス作成
r = await req("/api/canvases", authJ({ url: "example.com", title: "テストサイト" }));
j = await r.json();
const canvas = j.canvas;
assert(r.status === 200 && canvas.host === "example.com" && canvas.url === "https://example.com/" && canvas.comment_count === 0, "キャンバス作成(URL正規化/初期サマリ)");
const cid = canvas.id;

// 8) 取得(reviews/share_url)
r = await req(`/api/canvases/${cid}`, auth());
j = await r.json();
assert(j.canvas.id === cid && Array.isArray(j.reviews) && j.share_url.includes(`/s/${canvas.share_token}`), "キャンバス取得(reviews/share_url)");

// 9) コメント作成 → 一覧
r = await req(`/api/canvases/${cid}/comments`, authJ({ body: "ここ直して", page: "https://example.com/", selector: "h1", rx: 0.5, ry: 0.5 }));
j = await r.json();
const mid = j.comment.id;
assert(r.status === 200 && j.comment.author === "太郎" && j.comment.guest === false && j.comment.status === "active", "コメント作成");
r = await req(`/api/canvases/${cid}/comments`, auth());
j = await r.json();
assert(j.comments.length === 1, "コメント一覧 1件");

// 10) 返信 → ページ絞り込みでも返信は出る
await req(`/api/canvases/${cid}/comments`, authJ({ body: "返信です", parent_id: mid, page: "https://example.com/other" }));
r = await req(`/api/canvases/${cid}/comments?page=${encodeURIComponent("https://example.com/")}`, auth());
j = await r.json();
assert(j.comments.length === 2, "page絞り込みでも返信が含まれる");

// 11) 解決
r = await req(`/api/comments/${mid}`, { method: "PATCH", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ status: "resolved" }) });
j = await r.json();
assert(j.comment.status === "resolved" && j.comment.resolved_by === "太郎", "コメント解決(resolved_by)");

// 12) 削除(返信ごと連鎖)
r = await req(`/api/comments/${mid}`, { method: "DELETE", headers: { Cookie: cookie } });
j = await r.json();
assert(j.ok === true, "コメント削除 ok");
r = await req(`/api/canvases/${cid}/comments`, auth());
j = await r.json();
assert(j.comments.length === 0, "親削除で返信も消える");

// 13) レビュー
r = await req(`/api/canvases/${cid}/reviews`, authJ({ verdict: "approved", comment: "OK" }));
j = await r.json();
assert(r.status === 200 && j.review.verdict === "approved", "レビュー追加");
r = await req(`/api/canvases/${cid}/reviews`, authJ({ verdict: "bogus" }));
assert(r.status === 400, "不正な判定は 400");

// 14) check-url(上流モックは200)
r = await req("/api/check-url", authJ({ url: "example.com" }));
j = await r.json();
assert(j.ok === true && j.blocked === false, "check-url は表示可能を返す");

// 15) プロキシ入口 → /p/:id/ へリダイレクト
r = await req(`/p/${cid}`, auth());
assert(r.status === 302 && (r.headers.get("location") || "").startsWith(`/p/${cid}/`), "プロキシ入口は /p/:id/ へ");

// 16) プロキシ本体(HTML注入 + fsn_canvas)
r = await req(`/p/${cid}/`, auth({ accept: "text/html" }));
const html = await r.text();
assert(r.status === 200 && html.includes("__FUSEN__") && html.includes("fusen-overlay.js"), "プロキシHTMLにオーバーレイ注入");
assert((r.headers.get("set-cookie") || "").includes(`fsn_canvas=${cid}`), "fsn_canvas クッキー付与");

// 17) /c/:id, /s/:token
r = await req(`/c/${cid}`, auth());
assert(r.status === 302 && r.headers.get("location") === `/p/${cid}`, "/c/:id → /p/:id");
r = await req(`/s/${canvas.share_token}`, auth());
assert(r.status === 302 && r.headers.get("location") === `/p/${cid}`, "/s/:token(ログイン済) → /p/:id");

// 18) フォールバック中継: ルート絶対パスのHTML GET → /p/:id へ(fsn_canvas 利用)
r = await req("/some/app/route", { headers: { Cookie: `${cookie}; fsn_canvas=${cid}`, accept: "text/html" } });
assert(r.status === 302 && (r.headers.get("location") || "") === `/p/${cid}/some/app/route`, "中継: HTML GET はプロキシ表示へ");

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
