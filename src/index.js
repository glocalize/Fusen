// Fusen — Cloudflare Workers エントリ。
// Express(server.js)のルート構成を Hono + D1(lib/db-d1.js) + Workers Assets へ移植。
import { Hono } from "hono";
import * as db from "../lib/db-d1.js";
import { getUser } from "../lib/util-workers.js";
import { api } from "./api.js";
import { proxyEntry, proxyPath, relayFallback } from "./proxy.js";

const app = new Hono();

// 静的アセット(Workers Assets / env.ASSETS)を取得して返す
function serveAsset(env, origin, path) {
  return env.ASSETS.fetch(new Request(new URL(path, origin)));
}

// ---- API ----
app.route("/api", api);

// ---- ルート / ログイン / ヘルプ(静的HTML) ----
app.get("/", async (c) => {
  const origin = new URL(c.req.url).origin;
  if (!(await getUser(c.req.raw, c.env.SESSION_SECRET))) return c.redirect("/login");
  return serveAsset(c.env, origin, "/index.html");
});
app.get("/login", (c) => serveAsset(c.env, new URL(c.req.url).origin, "/login.html"));
app.get("/help", (c) => serveAsset(c.env, new URL(c.req.url).origin, "/help.html"));
// ---- デバッグ用サンプル: モーダル等の動的UIに対するピン挙動を、外部サイト無しで検証する ----
// API はページ内でスタブ化しているため DB には触れない(認証不要で安全な自己完結ページ)。
app.get("/debug", (c) => serveAsset(c.env, new URL(c.req.url).origin, "/debug.html"));

// ---- Fusen 自身のアセット: /fsn-assets/* → public 直下へマップ ----
app.all("/fsn-assets/*", (c) => {
  const url = new URL(c.req.url);
  const rest = url.pathname.replace(/^\/fsn-assets/, "") + url.search;
  return c.env.ASSETS.fetch(new Request(new URL(rest, url.origin)));
});

// ---- 共有リンク: ゲスト入口 ----
app.get("/s/:token", async (c) => {
  const token = c.req.param("token");
  const canvas = await db.getCanvasByToken(c.env.DB, token);
  if (!canvas) return c.text("共有リンクが無効です", 404);
  if (!(await getUser(c.req.raw, c.env.SESSION_SECRET))) {
    // token を渡し、ログイン時にゲストをこのキャンバスへ束縛する(#3 認可)
    return c.redirect(`/login?guest=1&token=${encodeURIComponent(token)}&next=${encodeURIComponent("/p/" + canvas.id)}`);
  }
  return c.redirect(`/p/${canvas.id}`);
});

// ---- キャンバスを開く = プロキシ表示へ ----
app.get("/c/:id", (c) => c.redirect(`/p/${c.req.param("id")}`));

// ---- プロキシ ----
app.get("/p/:id", proxyEntry);
app.all("/p/:id/*", proxyPath);

// ---- フォールバック中継(ルート絶対パスの読込・JS遷移・フォーム送信) ----
app.all("*", relayFallback);

export default app;
