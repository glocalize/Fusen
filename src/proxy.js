// プロキシ: 対象サイトを /p/<キャンバスID>/<元のパス> 配下にミラーし、
// HTML には注釈オーバーレイを注入して配信する(lib/proxy.js + server.js 中継の Workers 移植)。
import * as db from "../lib/db-d1.js";
import { getUser, parseCookies, browserHeaders, originOf, canAccessCanvas } from "../lib/util-workers.js";
import { safeFetch, BlockedAddressError } from "../lib/safefetch.js";

// 中継ボディの上限(#7): 無制限バッファによるメモリ枯渇を防ぐ
const MAX_RELAY_BODY = 25 * 1024 * 1024; // 25MB

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

// SPAモード対象ホストか(クライアントルーティングSPAの表示対応)。指定ホストにのみ適用。
export function isSpaHost(env, hostname) {
  const hosts = String((env && env.PROXY_SPA_HOSTS) || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return hosts.includes(String(hostname).toLowerCase());
}

// CSP(meta)を全除去せず、注入分だけ許可するよう追記する(#4 短期策)。
// script-src に nonce と appOrigin、style-src に appOrigin を足す。該当ディレクティブが無ければ
// default-src を土台にして新設する。対象サイト本来のCSPは可能な範囲で維持する。
function augmentCsp(policy, appOrigin, nonce) {
  const map = new Map();
  for (const part of policy.split(";").map((s) => s.trim()).filter(Boolean)) {
    const toks = part.split(/\s+/);
    map.set(toks.shift().toLowerCase(), toks);
  }
  const ensure = (dir, additions) => {
    let vals = map.get(dir);
    if (!vals) { vals = map.has("default-src") ? [...map.get("default-src")] : []; map.set(dir, vals); }
    for (const a of additions) if (!vals.includes(a)) vals.push(a);
  };
  ensure("script-src", [`'nonce-${nonce}'`, appOrigin]);
  ensure("style-src", [appOrigin]);
  ensure("img-src", ["'self'"]);
  return [...map.entries()].map(([k, v]) => [k, ...v].join(" ")).join("; ");
}

// HTML にオーバーレイ(注釈UI)を注入する
export function injectOverlay(html, { canvas, finalUrl, appOrigin, user, spa }) {
  // 注入スクリプト用の nonce(応答ごとにランダム)
  const nonce = crypto.randomUUID().replace(/-/g, "");
  // CSP メタを全除去せず、注入分(nonce/appOrigin)だけ許可するよう書き換える
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, (tag) => {
    // content の値には 'self' 等の単引用符が入るため、区切り文字を保持して中身を取り出す
    const m = tag.match(/content=(["'])([\s\S]*?)\1/i);
    if (!m) return tag;
    // 悪意ある元ページが content 内に " や > を仕込んで属性/タグを抜け出すのを防ぐため、
    // 書き換え後の値は必ず HTML 属性エスケープしてから二重引用符で埋め込む。
    const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    return tag.replace(/content=(["'])[\s\S]*?\1/i, `content="${escAttr(augmentCsp(m[2], appOrigin, nonce))}"`);
  });

  // PWA manifest はブラウザがデフォルトで credential 無しに取得するため、Cloudflare Access
  // 等の認証境界の内側だと manifest 取得がログインへ 302 され CORS で失敗する(サイト機能
  // 自体には無害だがコンソールにエラーが出続ける)。オーバーレイ配信は対象をアプリ自身の
  // オリジンで返すので、クッキーを載せて取得できるよう crossorigin="use-credentials" を強制する。
  html = html.replace(/<link\b[^>]*\brel=(["']?)manifest\1[^>]*>/gi, (tag) => {
    const cleaned = tag.replace(/\s+crossorigin(=("[^"]*"|'[^']*'|[^\s>]+))?/gi, "");
    return cleaned.replace(/<link\b/i, '<link crossorigin="use-credentials"');
  });

  // SPAモード: /p/<id> プレフィックスをアプリから隠し、ルーターに「ルートにいる」と思わせる。
  // <head>の先頭に注入してアプリのJSより先に実行させる。対象ホストのみ(他サイトには影響させない)。
  if (spa) {
    const shim = `<script nonce="${nonce}">(function(){try{var p=location.pathname;if(p.indexOf("/p/")===0){var seg=p.slice(3);var i=seg.indexOf("/");var rest=i>=0?seg.slice(i):"/";history.replaceState(history.state,"",rest+location.search+location.hash);}}catch(e){}})();</script>`;
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (h) => h + shim);
    else html = shim + html;
  }

  // インライン script への埋め込み対策(保存型XSS):
  // ・</script> での閉じ抜けを防ぐため < をエスケープ
  // ・JS では行区切りとして無効な U+2028 / U+2029 もエスケープ(古い実行環境での構文破壊を防ぐ)
  const cfg = JSON.stringify({
    canvasId: canvas.id,
    canvasTitle: canvas.title,
    canvasHost: canvas.host,
    page: finalUrl,
    apiBase: appOrigin,
    user: { name: user.name, guest: !!user.guest },
  })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  const boot = `
<link rel="stylesheet" href="${appOrigin}/fsn-assets/fusen-overlay.css">
<script nonce="${nonce}">window.__FUSEN__=${cfg};</script>
<script nonce="${nonce}" src="${appOrigin}/fsn-assets/fusen-overlay.js" defer></script>`;

  // 最初ではなく「最後の </body>」に注入する。インラインJS(PDF出力等)が文字列内に
  // </body> を含むと、最初マッチだとスクリプトの途中へ boot が割り込み、boot 内の
  // </script> が実行中スクリプトを強制終了して以降が生テキスト化する(#12)。
  const bodyIdx = html.toLowerCase().lastIndexOf("</body>");
  if (bodyIdx >= 0) return html.slice(0, bodyIdx) + boot + "\n" + html.slice(bodyIdx);
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
  const user = await getUser(c.req.raw, c.env.SESSION_SECRET);
  const canvas = await db.getCanvas(DB, id);
  if (!canvas) return relayFallback(c); // 相対遷移が /p/xxx.html 等に化けたケースは中継へ
  if (!user) return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  if (!canAccessCanvas(user, canvas.id)) return c.html(errorPage("このキャンバスにはアクセスできません", canvas.host || "", "招待された共有リンクのキャンバスのみ表示できます。"), 403);

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
  const user = await getUser(c.req.raw, c.env.SESSION_SECRET);
  const canvas = await db.getCanvas(DB, id);
  if (!canvas) return c.html(errorPage("キャンバスが見つかりません", "", "URLが正しいか確認してください。"), 404);
  const url = new URL(c.req.url);
  if (!user) return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  if (!canAccessCanvas(user, canvas.id)) return c.html(errorPage("このキャンバスにはアクセスできません", canvas.host || "", "招待された共有リンクのキャンバスのみ表示できます。"), 403);

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
    const init = { method, headers, signal: AbortSignal.timeout(20000) };
    if (!["GET", "HEAD"].includes(method)) {
      if (Number(c.req.header("content-length") || 0) > (Number(c.env.MAX_RELAY_BODY) || MAX_RELAY_BODY)) return c.text("リクエストボディが大きすぎます", 413);
      init.body = await c.req.raw.arrayBuffer();
    }
    // SSRF 対策: safeFetch が各リダイレクトホップを内部アドレス検証する
    upstream = await safeFetch(target.href, init);
  } catch (e) {
    if (e instanceof BlockedAddressError) {
      return c.html(errorPage("このURLは表示できません", target.hostname, "内部アドレスやプライベートIP、またはそこへのリダイレクトはレビュー表示できません。"), 400);
    }
    return c.html(errorPage("対象サイトに接続できませんでした", target.hostname, "接続時にエラーが発生しました。URLをご確認ください。"), 502);
  }

  const finalUrl = upstream.url || target.href;
  const ctype = upstream.headers.get("content-type") || "";
  const isHtml = ctype.includes("text/html");

  // ページ表示(GET html)のみ: ブロック検知とリダイレクト先の検証。
  // サブリソース(script/style/画像/fetch 等)が同様にブロック/別ホストの認証ページへ
  // 落ちた場合、ログイン/エラーHTMLを resource 本体として黙って返すと <script> 等が HTML を
  // 実行しようとして壊れ、原因の分かりにくいサイレント失敗になる(例: 対象サイトが Cloudflare
  // Access 配下だと assets/*.js がログインへ 302 → HTML が返り関数未定義)。文書ナビゲーション
  // 以外は明示的な 502 にして、Network タブで失敗を可視化する。
  if (isHtml && method === "GET") {
    const dest = (c.req.header("sec-fetch-dest") || "").toLowerCase();
    const isSubresource = dest !== "" && dest !== "document";
    const blocked = [401, 403, 406, 429, 503].includes(upstream.status);
    let finalHost = "";
    let offHost = false;
    try {
      const fu = new URL(finalUrl);
      finalHost = fu.hostname;
      offHost = !isAllowed(fu, canvas.host);
    } catch {}

    if ((blocked || offHost) && isSubresource) {
      return c.text(
        offHost
          ? "対象サイトがアプリ外(認証ページ等)へリダイレクトしたため、このリソースは取得できません。"
          : `対象サイトがこのリソースへのアクセスを拒否しました(HTTP ${upstream.status})。`,
        502
      );
    }
    if (blocked) {
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
    if (offHost) {
      return c.html(
        errorPage(
          "別のドメインへリダイレクトされました",
          finalHost,
          "対象サイトが認証ページ等へリダイレクトしています。ログイン保護(Cloudflare Access等)が掛かっている場合は、保護を外すかバイパス設定をしてください。"
        ),
        200
      );
    }
  }

  const headers = new Headers();
  headers.set("Cache-Control", "no-store");

  if (isHtml) {
    // フォールバック中継が参照する「現在のキャンバス」クッキー
    headers.append("Set-Cookie", `fsn_canvas=${canvas.id}; Path=/; SameSite=Lax`);
    let html = await upstream.text();
    const spa = isSpaHost(c.env, canvas.host);
    html = injectOverlay(html, { canvas, finalUrl, appOrigin: originOf(c.req.raw), user, spa });
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

  const user = await getUser(c.req.raw, c.env.SESSION_SECRET);
  if (!user) return c.text("Not Found", 404);
  const canvasId = parseCookies(c.req.raw).fsn_canvas;
  if (!canvasId) return c.text("Not Found", 404);
  const canvas = await db.getCanvas(DB, canvasId);
  if (!canvas) return c.text("Not Found", 404);
  if (!canAccessCanvas(user, canvas.id)) return c.text("Not Found", 404); // ゲストは束縛キャンバス以外を中継しない(#3)

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
    const init = { method: c.req.method, headers, signal: AbortSignal.timeout(20000) };
    if (!["GET", "HEAD"].includes(c.req.method)) {
      if (Number(c.req.header("content-length") || 0) > (Number(c.env.MAX_RELAY_BODY) || MAX_RELAY_BODY)) return c.text("リクエストボディが大きすぎます", 413);
      init.body = await c.req.raw.arrayBuffer();
    }
    // SSRF 対策: 中継経路も safeFetch 経由(内部アドレス/内部へのリダイレクトを遮断)
    const upstream = await safeFetch(target.href, init);
    const ctype = upstream.headers.get("content-type") || "";
    const resHeaders = new Headers();
    resHeaders.set("Cache-Control", "no-store");

    if (ctype.includes("text/html")) {
      let html = await upstream.text();
      const spa = isSpaHost(c.env, canvas.host);
      html = injectOverlay(html, { canvas, finalUrl: upstream.url || target.href, appOrigin: originOf(c.req.raw), user, spa });
      resHeaders.set("Content-Type", "text/html; charset=utf-8");
      return new Response(html, { status: upstream.status, headers: resHeaders });
    }
    resHeaders.set("Content-Type", ctype || "application/octet-stream");
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: resHeaders });
  } catch {
    return c.text("Not Found", 404);
  }
}
