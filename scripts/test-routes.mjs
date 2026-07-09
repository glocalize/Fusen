// Hono ルートの統合テスト。app.request() に node:sqlite 製の D1 シムと
// ASSETS / fetch のモックを渡して、実際のリクエストでルートを叩く。
// 実行: node --experimental-sqlite scripts/test-routes.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import app from "../src/index.js";
import { basicAuthHeader, isSpaHost, injectOverlay } from "../src/proxy.js";
import { buildSeedSql } from "./seed-sql.mjs";

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
// git 管理外の実データ(seed.sql / data/db.json)ではなく、コミット済みの合成
// フィクスチャから seed を組み立てて hermetic に回す(CI でも動く)。
const fixture = JSON.parse(readFileSync(here("../test/fixtures/db.json"), "utf8"));
const sq = new DatabaseSync(":memory:");
sq.exec("PRAGMA foreign_keys = ON;");
// migrations/ 配下の *.sql をファイル名順(0001_..., 0002_...)に全部連結して適用する。
{
  const dir = here("../migrations/");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) sq.exec(readFileSync(new URL(f, dir), "utf8"));
}
sq.exec(buildSeedSql(fixture)); // フィクスチャの4キャンバス等

// ASSETS モック(静的配信)。リクエストパスを反映した HTML を返す。
const ASSETS = {
  fetch: async (req) => new Response(`<!doctype html><html><body>ASSET ${new URL(req.url).pathname}</body></html>`, { headers: { "content-type": "text/html" } }),
};

// 上流サイトのモック(check-url / proxy / relay 用)。常に HTML 200。受け取った headers を記録。
let lastFetch = null;
globalThis.fetch = async (url, init) => {
  lastFetch = { url: String(url), headers: (init && init.headers) || {} };
  return new Response("<html><head></head><body><h1>Hello</h1></body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
};

const env = { DB: d1(sq), ASSETS, SESSION_SECRET: "test-secret-please-change", PROXY_BASIC_AUTH: "revuser:revpass", PROXY_BASIC_AUTH_HOSTS: "example.com", PROXY_SPA_HOSTS: "example.com" };
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

// 6) 一覧(seed のアーカイブ状態をフィクスチャから算出して検証)
const seedCanvases = fixture.canvases;
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

// 12.5) コメントのコンテキスト(#モーダルコメント問題対応)
// (a) POST時にctxを付けると保存されて返る
r = await req(`/api/canvases/${cid}/comments`, authJ({ body: "モーダルのコメント", page: "https://example.com/", selector: "div.modal button", ctx_label: "保存ボタン", ctx_modal: true, ctx_modal_label: "設定" }));
j = await r.json();
const ctxMid = j.comment.id;
assert(j.comment.ctx_label === "保存ボタン" && j.comment.ctx_modal === true && j.comment.ctx_modal_label === "設定", "POST comments: ctxフィールドが保存されて返る");

// (b) ctxなしPOST → PATCHでctxバックフィルできる
r = await req(`/api/canvases/${cid}/comments`, authJ({ body: "後付け対象", page: "https://example.com/", selector: "h2.title" }));
j = await r.json();
const noCtxMid = j.comment.id;
assert(j.comment.ctx_modal === null, "POST comments: ctxなしはctx_modal:nullで作られる");
r = await req(`/api/comments/${noCtxMid}`, { method: "PATCH", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ ctx_label: "後付けラベル", ctx_modal: true, ctx_modal_label: "後付けモーダル" }) });
j = await r.json();
assert(j.comment.ctx_modal === true && j.comment.ctx_label === "後付けラベル" && j.comment.ctx_modal_label === "後付けモーダル", "PATCH comments: ctxなしコメントへのバックフィルが反映される");

// (c) ctx取得済みコメントへのPATCHバックフィルは無視される(値が変わらない)
r = await req(`/api/comments/${ctxMid}`, { method: "PATCH", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ ctx_label: "上書き試行", ctx_modal: false, ctx_modal_label: "上書き試行" }) });
j = await r.json();
assert(j.comment.ctx_modal === true && j.comment.ctx_label === "保存ボタン", "PATCH comments: ctx取得済みへのバックフィルは無視される");

// (d) 120字超のctx_labelが切り詰められる
const longLabel = "あ".repeat(150);
r = await req(`/api/canvases/${cid}/comments`, authJ({ body: "長いラベル", page: "https://example.com/", selector: "p.long", ctx_label: longLabel, ctx_modal: true, ctx_modal_label: longLabel }));
j = await r.json();
assert(j.comment.ctx_label.length === 120 && j.comment.ctx_modal_label.length === 120, "POST comments: 120字超のctx_labelが切り詰められる");

// 12.6) コメント作成時スクリーンショット
{
  const putReq = (path, obj, ck = cookie) => req(path, { method: "PUT", headers: { Cookie: ck, "content-type": "application/json" }, body: JSON.stringify(obj) });
  const smallB64 = "QUFBQUFBQUFBQUFB"; // 適当なbase64本体(内容は検証しない)
  const dataUrl = `data:image/jpeg;base64,${smallB64}`;

  r = await req(`/api/canvases/${cid}/comments`, authJ({ body: "スクショ対象", page: "https://example.com/", selector: "h1" }));
  j = await r.json();
  const shotMid = j.comment.id;
  assert(j.comment.has_shot === false, "コメント作成直後は has_shot: false");

  // PUT → GET 往復(content-type と body が一致)
  r = await putReq(`/api/comments/${shotMid}/screenshot`, { data_url: dataUrl });
  j = await r.json();
  assert(r.status === 200 && j.ok === true && !j.existing, "PUT screenshot: 新規保存は {ok:true}");
  r = await req(`/api/comments/${shotMid}/screenshot`, auth());
  const gotBytes = new Uint8Array(await r.arrayBuffer());
  const expectedBytes = Uint8Array.from(atob(smallB64), (ch) => ch.charCodeAt(0));
  assert(r.status === 200 && r.headers.get("content-type") === "image/jpeg", "GET screenshot: content-typeが保存したmimeと一致");
  assert(gotBytes.length === expectedBytes.length && gotBytes.every((v, i) => v === expectedBytes[i]), "GET screenshot: bodyが保存したデータと一致");
  assert(r.headers.get("cache-control") === "private, max-age=3600", "GET screenshot: cache-controlヘッダ");

  // listComments 応答に has_shot が出る
  r = await req(`/api/canvases/${cid}/comments`, auth());
  j = await r.json();
  const listedShot = j.comments.find((x) => x.id === shotMid);
  assert(listedShot && listedShot.has_shot === true, "listComments応答: 保存後は has_shot: true");

  // 既存ありのPUTが {ok:true, existing:true}
  r = await putReq(`/api/comments/${shotMid}/screenshot`, { data_url: `data:image/png;base64,${smallB64}` });
  j = await r.json();
  assert(r.status === 200 && j.ok === true && j.existing === true, "PUT screenshot: 既存ありは {ok:true, existing:true}");

  // shot なし GET 404
  r = await req(`/api/canvases/${cid}/comments`, authJ({ body: "shotなし", page: "https://example.com/" }));
  const noShotMid = (await r.json()).comment.id;
  r = await req(`/api/comments/${noShotMid}/screenshot`, auth());
  j = await r.json();
  assert(r.status === 404 && j.error, "GET screenshot: shotが無ければ404");

  // 返信への PUT 400
  r = await req(`/api/canvases/${cid}/comments`, authJ({ body: "返信です", parent_id: shotMid }));
  const replyMid = (await r.json()).comment.id;
  r = await putReq(`/api/comments/${replyMid}/screenshot`, { data_url: dataUrl });
  assert(r.status === 400, "PUT screenshot: 返信には保存不可(400)");

  // data_url 形式不正 400
  r = await putReq(`/api/comments/${noShotMid}/screenshot`, { data_url: "data:text/plain;base64,QUFB" });
  assert(r.status === 400, "PUT screenshot: mimeが不正なら400");
  r = await putReq(`/api/comments/${noShotMid}/screenshot`, { data_url: "not-a-data-url" });
  assert(r.status === 400, "PUT screenshot: data:形式でなければ400");

  // 413 サイズ超過
  const hugeB64 = "A".repeat(400_001);
  r = await putReq(`/api/comments/${noShotMid}/screenshot`, { data_url: `data:image/jpeg;base64,${hugeB64}` });
  j = await r.json();
  assert(r.status === 413 && j.error, "PUT screenshot: 400,000字超は413");

  // 別キャンバス束縛ゲストの PUT/GET は 403
  const otherCanvasResp = await (await req("/api/canvases", authJ({ url: "shots-other.example.com", title: "別キャンバス" }))).json();
  const otherToken = otherCanvasResp.canvas.share_token;
  r = await req("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "スクショゲスト", guest: true, token: otherToken }) });
  const guestCookie = (r.headers.get("set-cookie") || "").split(";")[0];
  r = await putReq(`/api/comments/${noShotMid}/screenshot`, { data_url: dataUrl }, guestCookie);
  assert(r.status === 403, "PUT screenshot: 別キャンバス束縛ゲストは403");
  r = await req(`/api/comments/${shotMid}/screenshot`, { headers: { Cookie: guestCookie } });
  assert(r.status === 403, "GET screenshot: 別キャンバス束縛ゲストは403");
}

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
assert(lastFetch && lastFetch.headers.authorization === "Basic " + btoa("revuser:revpass"), "Basic認証ヘッダが対象ホスト(example.com)へ付与される");
assert(html.includes("history.replaceState(history.state"), "SPAモード: 対象ホストのHTMLにルーティングshimが注入される");

// 17) /c/:id, /s/:token
r = await req(`/c/${cid}`, auth());
assert(r.status === 302 && r.headers.get("location") === `/p/${cid}`, "/c/:id → /p/:id");
r = await req(`/s/${canvas.share_token}`, auth());
assert(r.status === 302 && r.headers.get("location") === `/p/${cid}`, "/s/:token(ログイン済) → /p/:id");

// 18) フォールバック中継: ルート絶対パスのHTML GET → /p/:id へ(fsn_canvas 利用)
r = await req("/some/app/route", { headers: { Cookie: `${cookie}; fsn_canvas=${cid}`, accept: "text/html" } });
assert(r.status === 302 && (r.headers.get("location") || "") === `/p/${cid}/some/app/route`, "中継: HTML GET はプロキシ表示へ");

// Basic認証ヘルパー単体
assert(basicAuthHeader({ PROXY_BASIC_AUTH: "u:p", PROXY_BASIC_AUTH_HOSTS: "example.com" }, "example.com") === "Basic " + btoa("u:p"), "basicAuthHeader: 対象ホストは付与");
assert(basicAuthHeader({ PROXY_BASIC_AUTH: "u:p", PROXY_BASIC_AUTH_HOSTS: "example.com" }, "evil.com") === null, "basicAuthHeader: 対象外ホストは付与しない");
assert(basicAuthHeader({ PROXY_BASIC_AUTH_HOSTS: "example.com" }, "example.com") === null, "basicAuthHeader: 資格情報なしは付与しない");
assert(isSpaHost({ PROXY_SPA_HOSTS: "example.com" }, "example.com") === true, "isSpaHost: 対象ホストは true");
assert(isSpaHost({ PROXY_SPA_HOSTS: "example.com" }, "evil.com") === false, "isSpaHost: 対象外は false");
assert(isSpaHost({}, "example.com") === false, "isSpaHost: 未設定は false");

// injectOverlay: インラインJS(PDF出力等)が文字列に </body> を含んでも壊さない(#12)
{
  const io = { canvas: { id: "c1", title: "t", host: "example.com" }, finalUrl: "https://example.com/", appOrigin: "https://app.test", user: { name: "太郎", guest: false }, spa: false };
  const page =
    "<html><head></head><body><h1>本文</h1>" +
    "<script>var doc = `<html><body>PDF内容</body></html>`; window.open('','_blank').document.write(doc);<\/script>" +
    "</body></html>";
  const out = injectOverlay(page, io);
  const bootIdx = out.indexOf("fusen-overlay.js");
  const realBodyIdx = out.lastIndexOf("</body>");
  assert(bootIdx >= 0 && bootIdx < realBodyIdx, "injectOverlay: boot は本物の(最後の)</body>直前に注入される");
  assert(out.indexOf("</body>") < bootIdx, "injectOverlay: スクリプト内の偽</body>には注入しない");
  assert(out.includes("window.open('','_blank').document.write(doc)"), "injectOverlay: 元のインラインJSが分断されず残る");
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
