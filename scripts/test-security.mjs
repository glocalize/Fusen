// セキュリティ回帰テスト。監査レポート(docs/security-audit.md)の各修正が効いていることを検証する。
// 実行: node --experimental-sqlite scripts/test-security.mjs
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import app from "../src/index.js";
import { injectOverlay } from "../src/proxy.js";
import { assertPublicUrl, isPrivateIPv4, isPrivateIPv6, safeFetch, BlockedAddressError } from "../lib/safefetch.js";
import { buildSeedSql } from "./seed-sql.mjs";

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  ok   -", msg); }
  else { fail++; console.error("  FAIL -", msg); }
}
async function throwsBlocked(fn, msg) {
  try { await fn(); ok(false, msg + "(例外が投げられなかった)"); }
  catch (e) { ok(e instanceof BlockedAddressError, msg); }
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
// migrations/ 配下の *.sql をファイル名順(0001_..., 0002_...)に全部連結して適用する。
{
  const dir = here("../migrations/");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) sq.exec(readFileSync(new URL(f, dir), "utf8"));
}
// git 管理外の seed.sql ではなく合成フィクスチャから seed を組み立てる(hermetic)。
sq.exec(buildSeedSql(JSON.parse(readFileSync(here("../test/fixtures/db.json"), "utf8"))));

const ASSETS = { fetch: async (req) => new Response(`<!doctype html><html><body>ASSET ${new URL(req.url).pathname}</body></html>`, { headers: { "content-type": "text/html" } }) };

// 差し替え可能な上流 fetch モック
let fetchImpl = async () => new Response("<html><head></head><body><h1>Hello</h1></body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
globalThis.fetch = (url, init) => fetchImpl(url, init);

const env = { DB: d1(sq), ASSETS, SESSION_SECRET: "test-secret-please-change", PROXY_BASIC_AUTH: "u:p", PROXY_BASIC_AUTH_HOSTS: "example.com", PROXY_SPA_HOSTS: "example.com" };
const req = (path, init = {}) => app.request(path, init, env);
const authJ = (cookie, obj) => ({ method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify(obj) });

console.log("セキュリティ回帰テスト\n[I2] SSRF");

// --- assertPublicUrl 単体 ---
for (const bad of [
  "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1/", "http://10.0.0.1/",
  "http://192.168.1.1/", "http://172.16.0.1/", "http://localhost/", "http://foo.internal/",
  "http://[::1]/", "http://0x7f000001/", "http://2130706433/", "ftp://example.com/", "file:///etc/passwd",
  // レビュー指摘の回避形も拒否すること
  "http://[::ffff:169.254.169.254]/", "http://[::ffff:10.0.0.1]/", "http://[64:ff9b::a9fe:a9fe]/",
  "http://localhost./", "http://127.0.0.1./", "http://foo.internal./",
]) {
  await throwsBlocked(() => { assertPublicUrl(bad); }, `assertPublicUrl が拒否: ${bad}`);
}
for (const good of ["http://example.com/", "https://sub.example.com/path?q=1", "https://203.0.113.10/"]) {
  ok(assertPublicUrl(good).href.length > 0, `assertPublicUrl が許可: ${good}`);
}
ok(isPrivateIPv4("10.1.2.3") && !isPrivateIPv4("8.8.8.8"), "isPrivateIPv4 の範囲判定");
ok(isPrivateIPv6("fd00::1") && !isPrivateIPv6("2606:4700::1111"), "isPrivateIPv6 の範囲判定");
ok(isPrivateIPv6("::ffff:a9fe:a9fe") && isPrivateIPv6("::ffff:7f00:1"), "isPrivateIPv6: IPv4-mapped(16進)も内部判定");

// --- safeFetch: 許可ホスト→内部IPへの302 を遮断 ---
fetchImpl = async () => ({ status: 302, headers: { get: (k) => (k.toLowerCase() === "location" ? "http://169.254.169.254/" : null) } });
await throwsBlocked(() => safeFetch("http://example.com/"), "safeFetch: 内部IPへの302リダイレクトを遮断");
fetchImpl = async () => new Response("<html><head></head><body><h1>Hello</h1></body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

// --- 統合: ログインして check-url / canvas 作成の内部URLを弾く ---
let r = await req("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "検証" }) });
const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
ok(/^fsn_user=/.test(cookie), "ログインできる");

r = await req("/api/check-url", authJ(cookie, { url: "http://169.254.169.254/" }));
let j = await r.json();
ok(j.blocked === true && j.ok === false, "check-url: メタデータURLは blocked");

r = await req("/api/check-url", authJ(cookie, { url: "https://example.com/" }));
j = await r.json();
ok(j.ok === true, "check-url: 公開URLは通常どおり表示可能");

r = await req("/api/canvases", authJ(cookie, { url: "http://127.0.0.1:6379/" }));
ok(r.status === 400, "canvas作成: 内部アドレスURLは 400 で拒否");

r = await req("/api/canvases", authJ(cookie, { url: "example.com", title: "OK" }));
ok(r.status === 200, "canvas作成: 公開URLは作成できる");

console.log("[I1] 認証(HMAC署名クッキー)");
// 旧攻撃: 署名なしの生JSONクッキーは検証で弾かれる
r = await req("/api/canvases", { headers: { Cookie: 'fsn_user={"id":"u_x","name":"admin","guest":false}' } });
ok(r.status === 401, "偽造(生JSON)クッキーでは 401");

// 署名対象(payload)を1文字改変 → 署名不一致で弾かれる
const flipAt = 12; // "fsn_user=" の先の payload 部
const tampered = cookie.slice(0, flipAt) + (cookie[flipAt] === "A" ? "B" : "A") + cookie.slice(flipAt + 1);
r = await req("/api/canvases", { headers: { Cookie: tampered } });
ok(r.status === 401, "改ざんした署名クッキーでは 401");

// 正規ログイン: HttpOnly が付き、/api/me が本人を返す
r = await req("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "花子" }) });
const sc = r.headers.get("set-cookie") || "";
ok(/HttpOnly/i.test(sc), "ログインクッキーに HttpOnly が付与される");
const cookie2 = sc.split(";")[0];
r = await req("/api/me", { headers: { Cookie: cookie2 } });
j = await r.json();
ok(j.user?.name === "花子", "正規クッキーで /api/me が本人を返す");

// SESSION_SECRET 未設定なら login は 500(fail closed)
r = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) }, { DB: d1(sq), ASSETS });
ok(r.status === 500, "SESSION_SECRET 未設定なら login は 500");

// ログアウトは失効クッキー(Max-Age=0)を返す
r = await req("/api/logout", { method: "POST", headers: { Cookie: cookie2 } });
const lc = r.headers.get("set-cookie") || "";
ok(/Max-Age=0/i.test(lc) && /HttpOnly/i.test(lc), "ログアウトで失効クッキー(Max-Age=0)");

console.log("[I8] インラインJSON注入XSS");
{
  const evilTitle = '</script><img src=x onerror=alert(1)>\u2028\u2029';
  const out = injectOverlay("<html><head></head><body></body></html>", {
    canvas: { id: "c1", title: evilTitle, host: "example.com" },
    finalUrl: "https://example.com/", appOrigin: "https://app", user: { name: "u", guest: false }, spa: false,
  });
  ok(!out.includes("</script><img"), "canvas.titleの</script>で閉じ抜けできない");
  ok(out.includes("\\u003c"), "< が \\u003c にエスケープされる");
  ok(!out.includes("\u2028") && !out.includes("\u2029"), "U+2028/U+2029 が生のまま残らない");
}

console.log("[I3] 認可(IDOR / ゲストスコープ)");
{
  const ca = await (await req("/api/canvases", authJ(cookie, { url: "a.example.com", title: "A" }))).json();
  const cb = await (await req("/api/canvases", authJ(cookie, { url: "b.example.com", title: "B" }))).json();
  const A = ca.canvas.id, B = cb.canvas.id, tokenA = ca.canvas.share_token;

  // ゲストは共有トークンでキャンバスAに束縛される
  r = await req("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ゲスト", guest: true, token: tokenA }) });
  const g = (r.headers.get("set-cookie") || "").split(";")[0];

  r = await req(`/api/canvases/${A}`, { headers: { Cookie: g } });
  ok(r.status === 200, "ゲスト: 束縛キャンバスAは閲覧可");
  r = await req(`/api/canvases/${B}`, { headers: { Cookie: g } });
  ok(r.status === 403, "ゲスト: 別キャンバスBは403");

  r = await req("/api/canvases", { headers: { Cookie: g } });
  j = await r.json();
  ok(Array.isArray(j.canvases) && j.canvases.length === 0, "ゲスト: 一覧を列挙できない(空)");

  r = await req(`/api/canvases/${A}/comments`, { method: "POST", headers: { Cookie: g, "content-type": "application/json" }, body: JSON.stringify({ body: "guest", page: "https://a.example.com/" }) });
  ok(r.status === 200, "ゲスト: 束縛キャンバスAにコメント可");
  r = await req(`/api/canvases/${B}/comments`, { method: "POST", headers: { Cookie: g, "content-type": "application/json" }, body: JSON.stringify({ body: "x" }) });
  ok(r.status === 403, "ゲスト: 別キャンバスBへのコメントは403");

  r = await req(`/api/canvases/${A}`, { method: "PATCH", headers: { Cookie: g, "content-type": "application/json" }, body: JSON.stringify({ title: "改名" }) });
  ok(r.status === 403, "ゲスト: キャンバス改名は403");

  r = await req(`/p/${B}/`, { headers: { Cookie: g, accept: "text/html" } });
  ok(r.status === 403, "ゲスト: 別キャンバスのプロキシ表示は403");

  // IDOR: 他人のコメントは削除できない
  r = await req(`/api/canvases/${A}/comments`, authJ(cookie, { body: "検証のコメント", page: "https://a.example.com/" }));
  const mid = (await r.json()).comment.id;
  r = await req("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "別人" }) });
  const other = (r.headers.get("set-cookie") || "").split(";")[0];
  r = await req(`/api/comments/${mid}`, { method: "DELETE", headers: { Cookie: other } });
  ok(r.status === 403, "他人のコメントはAPIで削除できない(所有者チェック)");
  r = await req(`/api/comments/${mid}`, { method: "DELETE", headers: { Cookie: cookie } });
  ok(r.status === 200, "本人は自分のコメントを削除できる");
}

console.log("[I9] CSRF(状態変更の同一オリジン検証)");
// 別オリジンの Origin ヘッダ付きは拒否
r = await req("/api/login", { method: "POST", headers: { "content-type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ name: "x" }) });
ok(r.status === 403, "別オリジンからの状態変更は403");
// 同一オリジン(http://localhost)は許可
r = await req("/api/login", { method: "POST", headers: { "content-type": "application/json", Origin: "http://localhost" }, body: JSON.stringify({ name: "y" }) });
ok(r.status === 200, "同一オリジンの状態変更は許可");
// GET は Origin に関係なく通る(状態変更でない)
r = await req("/api/_health", { headers: { Origin: "https://evil.example" } });
ok(r.status === 200, "GETはCSRF検証の対象外");

console.log("[I4] プロキシ短期堅牢化(CSP nonce)");
{
  const withCsp = '<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'"></head><body></body></html>';
  const out = injectOverlay(withCsp, { canvas: { id: "c1", title: "T", host: "example.com" }, finalUrl: "https://example.com/", appOrigin: "https://app.example", user: { name: "u" }, spa: false });
  ok(/content-security-policy/i.test(out), "CSP metaは全除去されず残る");
  const nm = out.match(/<script nonce="([^"]+)">window\.__FUSEN__/);
  ok(!!nm, "注入inline scriptにnonceが付く");
  const nonce = nm ? nm[1] : "";
  ok(out.includes(`script-src 'self' 'nonce-${nonce}' https://app.example`), "script-srcにnonceとappOriginが追記される");
  ok(/style-src 'self' https:\/\/app\.example/.test(out), "style-srcにappOriginが追記される");
  ok(out.includes(`<script nonce="${nonce}" src="https://app.example/fsn-assets/fusen-overlay.js"`), "外部scriptにも同じnonceが付く");

  // 悪意ある元ページが CSP content 値に " を仕込んで属性を抜け出すのを防ぐ(レビュー指摘#3)
  const cspDq = `<html><head><meta http-equiv="Content-Security-Policy" content='default-src "self"'></head><body></body></html>`;
  const outDq = injectOverlay(cspDq, { canvas: { id: "c1", title: "T", host: "example.com" }, finalUrl: "https://example.com/", appOrigin: "https://app.example", user: { name: "u" }, spa: false });
  ok(!outDq.includes('content="default-src "self"'), "CSP値内の\"がエスケープされ属性を抜け出さない");
  ok(outDq.includes("&quot;"), "CSP値の\" は &quot; にエスケープされる");
}

console.log("[manifest] Cloudflare Access 下での PWA manifest crossorigin 付与");
{
  const io = { canvas: { id: "c1", title: "T", host: "example.com" }, finalUrl: "https://example.com/", appOrigin: "https://app.example", user: { name: "u" }, spa: false };
  // crossorigin 無しの manifest link に use-credentials を付与(Access のログイン302→CORS失敗を防ぐ)
  const out1 = injectOverlay('<html><head><link rel="manifest" href="/site.webmanifest"></head><body></body></html>', io);
  ok(/<link[^>]*rel=["']?manifest[\s\S]*?crossorigin="use-credentials"|crossorigin="use-credentials"[\s\S]*?rel=["']?manifest/i.test(out1), "manifest link に crossorigin=use-credentials を付与");
  // 既存 crossorigin(anonymous 等)は use-credentials へ置換し重複させない
  const out2 = injectOverlay('<html><head><link rel="manifest" crossorigin="anonymous" href="/m.webmanifest"></head><body></body></html>', io);
  ok((out2.match(/crossorigin=/gi) || []).length === 1 && /crossorigin="use-credentials"/i.test(out2) && !/anonymous/i.test(out2), "既存 crossorigin は use-credentials に置換され重複しない");
  // manifest 以外の link(stylesheet 等)には crossorigin を付けない
  const out3 = injectOverlay('<html><head><link rel="stylesheet" href="/a.css"></head><body></body></html>', io);
  ok(!/crossorigin/i.test(out3), "manifest 以外の link には crossorigin を付けない");
  // 別オリジンの絶対URL manifest は触らない(credentialed CORS の強制は ACAO:* を逆に壊す)
  const out4 = injectOverlay('<html><head><link rel="manifest" href="https://cdn.example/m.webmanifest"></head><body></body></html>', io);
  ok(!/crossorigin/i.test(out4), "絶対URLの manifest には crossorigin を付けない");
  // スキーム相対(//host/...)も別オリジンになり得るため触らない
  const out5 = injectOverlay('<html><head><link rel="manifest" href="//cdn.example/m.webmanifest"></head><body></body></html>', io);
  ok(!/crossorigin/i.test(out5), "スキーム相対URLの manifest には crossorigin を付けない");
  // 相対パス(assets/m.webmanifest)は同一オリジン解決なので付与する
  const out6 = injectOverlay('<html><head><link rel="manifest" href="assets/m.webmanifest"></head><body></body></html>', io);
  ok(/crossorigin="use-credentials"/i.test(out6), "相対パスの manifest には crossorigin を付与する");
}

console.log("[I5] オープンリダイレクト対策(login.htmlのnext)");
{
  const html = readFileSync(here("../public/login.html"), "utf8");
  ok(html.includes("function safeNext"), "login.htmlにsafeNextガードがある");
  const safeNext = (raw, origin = "https://app.example") => {
    if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
    try { const u = new URL(raw, origin); if (u.origin !== origin) return "/"; return u.pathname + u.search + u.hash; } catch { return "/"; }
  };
  ok(safeNext("/p/abc") === "/p/abc", "相対パスは許可");
  ok(safeNext("//evil.example/") === "/", "//evil は / にフォールバック");
  ok(safeNext("https://evil.example") === "/", "外部URLは / にフォールバック");
  ok(safeNext("javascript:alert(1)") === "/", "javascript: は / にフォールバック");
}

console.log("[I6] 共有トークンCSPRNG化");
{
  const c1 = await (await req("/api/canvases", authJ(cookie, { url: "t1.example.com" }))).json();
  const c2 = await (await req("/api/canvases", authJ(cookie, { url: "t2.example.com" }))).json();
  const t1 = c1.canvas.share_token, t2 = c2.canvas.share_token;
  ok(/^s_[A-Za-z0-9_-]{20,}$/.test(t1), "share_tokenが十分な長さのbase64url");
  ok(t1 !== t2, "share_tokenは毎回異なる(推測困難)");
}

console.log("[I7] 堅牢化(中継ボディ上限)");
{
  const c7 = await (await req("/api/canvases", authJ(cookie, { url: "u7.example.com" }))).json();
  env.MAX_RELAY_BODY = 10; // テスト用に上限を小さく
  r = await req(`/p/${c7.canvas.id}/`, { method: "POST", headers: { Cookie: cookie, "content-type": "text/plain", "content-length": "16" }, body: "0123456789ABCDEF" });
  ok(r.status === 413, "上限超の中継ボディは413");
  delete env.MAX_RELAY_BODY;
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
