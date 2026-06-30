// プロキシ: 対象サイトを /p/<キャンバスID>/<元のパス> 配下にミラーし、
// HTML には注釈オーバーレイを注入して配信する(lib/proxy.js + server.js 中継の Workers 移植)。
import * as db from "../lib/db-d1.js";
import { getUser, parseCookies, browserHeaders, originOf } from "../lib/util-workers.js";

// 対象キャンバスのホストと同一(またはサブドメイン)のみ許可 — 踏み台化対策
export function isAllowed(target, canvasHost) {
  return target.hostname === canvasHost || target.hostname.endsWith("." + canvasHost);
}

// Basic 認証付きステージング対応: 指定ホストにだけ Authorization: Basic を付ける。
// 資格情報は Cloudflare secret(env.PROXY_BASIC_AUTH = "ユーザー名:パスワード")で管理し、
// env.PROXY_BASIC_AUTH_HOSTS(カンマ区切りのホスト名)に載るホストにのみ送る(他サイトへ漏らさない)。
export function basicAuthHeader(env, hostname) {
  const cred = env && env.PROXY_BASIC_AUTH;
  if (!cred) return null;
  const hosts = String((env && env.PROXY_BASIC_AUTH_HOSTS) || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!hosts.includes(String(hostname).toLowerCase())) return null;
  try {
    return "Basic " + btoa(cred);
  } catch {
    return null;
  }
}

// HTML にオーバーレイ(注釈UI)を注入する
export function injectOverlay(html, { canvas, finalUrl, appOrigin, user }) {
  // CSP メタタグを除去(注入スクリプトのブロックを防ぐ)
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "");

  // </script> での閉じ抜けを防ぐため < をエスケープ
  const cfg = JSON.stringify({
    canvasId: canvas.id,
    canvasTitle: canvas.title,
    canvasHost: canvas.host,
    page: finalUrl,
    apiBase: appOrigin,
    user: { name: user.name, guest: !!user.guest },
  }).replace(/</g, "\\u003c");

  const boot = `
<link rel="stylesheet" href="${appOrigin}/fsn-assets/fusen-overlay.css">
<script>window.__FUSEN__=${cfg};</script>
<script src="${appOrigin}/fsn-assets/fusen-overlay.js" defer></script>`;

  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, boot + "\n</body>");
  return html + boot;
}

// テーマ準拠のエラー/説明ページ
export function errorPage(title, host, detail) {
  const e = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)} | Fusen!</title>
<link href="https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@400;700;800&display=swap" rel="stylesheet">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:"M PLUS Rounded 1c",sans-serif;color:#21283b;background:#fff6e9;
background-image:radial-gradient(rgba(33,40,59,.1) 1.2px,transparent 1.2px);background-size:22px 22px;padding:20px}
.card{background:#fff;border:2.5px solid #21283b;border-radius:18px;box-shadow:8px 8px 0 #21283b;
max-width:480px;padding:32px;text-align:center}
.ic{width:70px;height:70px;margin:0 auto 14px;background:#ffc53d;border:2.5px solid #21283b;border-radius:50%;
display:flex;align-items:center;justify-content:center;box-shadow:4px 4px 0 #21283b}
h1{font-size:20px;margin:0 0 6px}.host{font-size:13px;font-weight:800;color:#ff6b35;margin-bottom:12px;word-break:break-all}
p{font-size:13.5px;font-weight:500;line-height:1.8;margin:0 0 20px;text-align:left}
a{display:inline-block;font-weight:800;font-size:14px;color:#fff;background:#ff6b35;border:2.5px solid #21283b;
border-radius:999px;padding:10px 24px;text-decoration:none;box-shadow:3px 3px 0 #21283b}
</style></head><body><div class="card">
<div class="ic"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#21283b" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3L1.8 20.2h20.4z"/><path d="M12 10v4"/><path d="M12 17.2v.6"/></svg></div>
<h1>${e(title)}</h1><div class="host">${e(host)}</div><p>${e(detail)}</p>
<a href="/">ダッシュボードに戻る</a></div></body></html>`;
}

// 入口: GET /p/:id → 対象サイトの元パスへリダイレクト(/p/:id/path...)
export async function proxyEntry(c) {
  const DB = c.env.DB;
  const id = c.req.param("id");
  const url = new URL(c.req.url);
  const user = getUser(c.req.raw);
  const canvas = await db.getCanvas(DB, id);
  if (!canvas) return relayFallback(c); // 相対遷移が /p/xxx.html 等に化けたケースは中継へ
  if (!user) return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);

  // 旧形式(?u=...)の互換
  const uParam = url.searchParams.get("u");
  if (uParam) {
    try {
      const uu = new URL(uParam);
      if (isAllowed(uu, canvas.host)) return c.redirect(`/p/${canvas.id}${uu.pathname}${uu.search}`);
    } catch {}
  }
  const t = new URL(canvas.url);
  return c.redirect(`/p/${canvas.id}${t.pathname}${t.search}`);
}

// 本体: /p/:id/<元のパス> を対象サイトへ中継
export async function proxyPath(c) {
  const DB = c.env.DB;
  const id = c.req.param("id");
  const user = getUser(c.req.raw);
  const canvas = await db.getCanvas(DB, id);
  if (!canvas) return c.html(errorPage("キャンバスが見つかりません", "", "URLが正しいか確認してください。"), 404);
  const url = new URL(c.req.url);
  if (!user) return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);

  const prefix = `/p/${id}`;
  let rest = url.pathname.slice(prefix.length) + url.search;
  if (!rest.startsWith("/")) rest = "/" + rest;
  let target;
  try {
    target = new URL(rest, new URL(canvas.url).origin);
  } catch {
    return c.text("URLが不正です", 400);
  }

  const method = c.req.method;
  let upstream;
  try {
    const headers = browserHeaders(c.req.raw);
    const ct = c.req.header("content-type");
    if (ct) headers["content-type"] = ct;
    const ba = basicAuthHeader(c.env, target.hostname);
    if (ba) headers["authorization"] = ba;
    const init = { method, headers, redirect: "follow", signal: AbortSignal.timeout(20000) };
    if (!["GET", "HEAD"].includes(method)) init.body = await c.req.raw.arrayBuffer();
    upstream = await fetch(target.href, init);
  } catch (e) {
    return c.html(errorPage("対象サイトに接続できませんでした", target.hostname, String(e?.message || e)), 502);
  }

  const finalUrl = upstream.url || target.href;
  const ctype = upstream.headers.get("content-type") || "";
  const isHtml = ctype.includes("text/html");

  // ページ表示(GET html)のみ: ブロック検知とリダイレクト先の検証
  if (isHtml && method === "GET") {
    if ([401, 403, 406, 429, 503].includes(upstream.status)) {
      return c.html(
        errorPage(
          "このサイトはレビュー表示できません",
          target.hostname,
          `サイト側からアクセスが拒否されました(HTTP ${upstream.status})。` +
            "Akamai・Cloudflare等のボット対策(WAF)で保護された大手商用サイトや、ログイン必須のサイトで起こります。" +
            "自社サイトやステージング環境は通常そのまま表示できます。"
        ),
        200
      );
    }
    try {
      if (!isAllowed(new URL(finalUrl), canvas.host)) {
        return c.html(
          errorPage(
            "別のドメインへリダイレクトされました",
            new URL(finalUrl).hostname,
            "対象サイトが認証ページ等へリダイレクトしています。ログイン保護(Cloudflare Access等)が掛かっている場合は、保護を外すかバイパス設定をしてください。"
          ),
          200
        );
      }
    } catch {}
  }

  const headers = new Headers();
  headers.set("Cache-Control", "no-store");

  if (isHtml) {
    // フォールバック中継が参照する「現在のキャンバス」クッキー
    headers.append("Set-Cookie", `fsn_canvas=${canvas.id}; Path=/; SameSite=Lax`);
    let html = await upstream.text();
    html = injectOverlay(html, { canvas, finalUrl, appOrigin: originOf(c.req.raw), user });
    headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(html, { status: upstream.status, headers });
  }

  // アセット類はそのまま中継
  headers.set("Content-Type", ctype || "application/octet-stream");
  return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
}

// フォールバック中継: ルート絶対パスの読込/JS遷移/フォーム送信を、
// fsn_canvas クッキーが指すキャンバスの対象サイトへ中継する。
export async function relayFallback(c) {
  const DB = c.env.DB;
  const url = new URL(c.req.url);
  // /p/ 配下は専用ルートの担当(中継ループ防止のためここでは扱わない)
  if (url.pathname.startsWith("/p/")) return c.text("Not Found", 404);

  const user = getUser(c.req.raw);
  if (!user) return c.text("Not Found", 404);
  const canvasId = parseCookies(c.req.raw).fsn_canvas;
  if (!canvasId) return c.text("Not Found", 404);
  const canvas = await db.getCanvas(DB, canvasId);
  if (!canvas) return c.text("Not Found", 404);

  const originalUrl = url.pathname + url.search;
  let target;
  try {
    target = new URL(originalUrl, canvas.url);
  } catch {
    return c.text("Not Found", 404);
  }

  // HTMLページへのGET(=JSによるルート絶対パス遷移など)はプロキシ表示へリダイレクト
  const wantsHtml = (c.req.header("accept") || "").includes("text/html");
  if (c.req.method === "GET" && wantsHtml) return c.redirect(`/p/${canvas.id}${originalUrl}`);

  try {
    const headers = browserHeaders(c.req.raw);
    const ct = c.req.header("content-type");
    if (ct) headers["content-type"] = ct;
    headers["sec-fetch-dest"] = "empty";
    headers["sec-fetch-mode"] = "cors";
    headers["sec-fetch-site"] = "same-origin";
    const ba = basicAuthHeader(c.env, target.hostname);
    if (ba) headers["authorization"] = ba;
    const init = { method: c.req.method, headers, redirect: "follow", signal: AbortSignal.timeout(20000) };
    if (!["GET", "HEAD"].includes(c.req.method)) init.body = await c.req.raw.arrayBuffer();
    const upstream = await fetch(target.href, init);
    const ctype = upstream.headers.get("content-type") || "";
    const resHeaders = new Headers();
    resHeaders.set("Cache-Control", "no-store");

    if (ctype.includes("text/html")) {
      let html = await upstream.text();
      html = injectOverlay(html, { canvas, finalUrl: upstream.url || target.href, appOrigin: originOf(c.req.raw), user });
      resHeaders.set("Content-Type", "text/html; charset=utf-8");
      return new Response(html, { status: upstream.status, headers: resHeaders });
    }
    resHeaders.set("Content-Type", ctype || "application/octet-stream");
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: resHeaders });
  } catch {
    return c.text("Not Found", 404);
  }
}
