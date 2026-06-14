// プロキシ: 対象サイトを /p/<キャンバスID>/<元のパス> 配下にミラーし、
// HTMLには注釈オーバーレイを注入して配信する。
//
// URL設計: /p/c_xxx/SD_login.html?a=1 → https://対象サイト/SD_login.html?a=1
// 相対リンク・相対JS遷移(location.href='login.html'等)は自然に /p/c_xxx/ 配下に
// 収まるため、プロキシ内に留まりUIが消えない。
// ルート絶対パス(/api/x 等)への遷移・fetchは server.js のフォールバック中継が拾う。
import { Router } from "express";
import { db } from "./db.js";
import { getUser, originOf, browserHeaders, readRawBody } from "./util.js";

export const proxy = Router();

// 対象キャンバスのホストと同一(またはサブドメイン)のみ許可 — 踏み台化対策
export function isAllowed(target, canvasHost) {
  return target.hostname === canvasHost || target.hostname.endsWith("." + canvasHost);
}

// HTMLにオーバーレイ(注釈UI)を注入する
export function injectOverlay(html, { canvas, finalUrl, appOrigin, user }) {
  // CSPメタタグを除去(注入スクリプトのブロックを防ぐ)
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "");

  const boot = `
<link rel="stylesheet" href="${appOrigin}/fsn-assets/fusen-overlay.css">
<script>window.__FUSEN__=${JSON.stringify({
    canvasId: canvas.id,
    canvasTitle: canvas.title,
    canvasHost: canvas.host,
    page: finalUrl,
    apiBase: appOrigin,
    user: { name: user.name, guest: !!user.guest },
  })};</script>
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

// 入口: /p/:id → 対象サイトの元パスへリダイレクト(/p/:id/path...)
proxy.get("/p/:id", (req, res, next) => {
  // "/p/c_xxx/" (末尾スラッシュ付き)は中継ルートに任せる(自己リダイレクトループ防止)
  if (req.originalUrl.split("?")[0] !== `/p/${req.params.id}`) return next();
  const canvas = db.canvases.find((c) => c.id === req.params.id);
  if (!canvas) return next(); // 相対遷移が /p/xxx.html 等に化けたケースはフォールバックへ
  if (!getUser(req)) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);

  // 旧形式(?u=...)の互換
  if (req.query.u) {
    try {
      const u = new URL(String(req.query.u));
      if (isAllowed(u, canvas.host)) return res.redirect(`/p/${canvas.id}${u.pathname}${u.search}`);
    } catch {}
  }
  const t = new URL(canvas.url);
  res.redirect(`/p/${canvas.id}${t.pathname}${t.search}`);
});

// 本体: /p/:id/<元のパス> を対象サイトへ中継
proxy.all("/p/:id/*", async (req, res) => {
  const user = getUser(req);
  const canvas = db.canvases.find((c) => c.id === req.params.id);
  if (!canvas) return res.status(404).send(errorPage("キャンバスが見つかりません", "", "URLが正しいか確認してください。"));
  if (!user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);

  const prefix = `/p/${canvas.id}`;
  let rest = req.originalUrl.slice(prefix.length);
  if (!rest.startsWith("/")) rest = "/" + rest;
  let target;
  try {
    target = new URL(rest, new URL(canvas.url).origin);
  } catch {
    return res.status(400).send("URLが不正です");
  }

  let upstream;
  try {
    const headers = browserHeaders(req);
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
    const init = {
      method: req.method,
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    };
    if (!["GET", "HEAD"].includes(req.method)) init.body = await readRawBody(req);
    upstream = await fetch(target.href, init);
  } catch (e) {
    return res.status(502).send(errorPage("対象サイトに接続できませんでした", target.hostname, String(e?.message || e)));
  }

  const finalUrl = upstream.url || target.href;
  const ctype = upstream.headers.get("content-type") || "";
  const isHtml = ctype.includes("text/html");
  res.setHeader("Cache-Control", "no-store");

  // ページ表示(GET html)のみ: ブロック検知とリダイレクト先の検証
  if (isHtml && req.method === "GET") {
    if ([401, 403, 406, 429, 503].includes(upstream.status)) {
      return res
        .status(200)
        .send(
          errorPage(
            "このサイトはレビュー表示できません",
            target.hostname,
            `サイト側からアクセスが拒否されました(HTTP ${upstream.status})。` +
              "Akamai・Cloudflare等のボット対策(WAF)で保護された大手商用サイトや、ログイン必須のサイトで起こります。" +
              "自社サイトやステージング環境は通常そのまま表示できます。"
          )
        );
    }
    try {
      if (!isAllowed(new URL(finalUrl), canvas.host)) {
        return res
          .status(200)
          .send(
            errorPage(
              "別のドメインへリダイレクトされました",
              new URL(finalUrl).hostname,
              "対象サイトが認証ページ等へリダイレクトしています。ログイン保護(Cloudflare Access等)が掛かっている場合は、保護を外すかバイパス設定をしてください。"
            )
          );
      }
    } catch {}
  }

  if (isHtml) {
    // フォールバック中継(server.js)が参照する「現在のキャンバス」クッキー
    res.append("Set-Cookie", `fsn_canvas=${canvas.id}; Path=/; SameSite=Lax`);
    let html = await upstream.text();
    html = injectOverlay(html, { canvas, finalUrl, appOrigin: originOf(req), user });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(upstream.status).send(html);
  }

  // アセット類はそのまま中継
  res.setHeader("Content-Type", ctype || "application/octet-stream");
  res.status(upstream.status).send(Buffer.from(await upstream.arrayBuffer()));
});
