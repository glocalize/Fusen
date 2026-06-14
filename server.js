// Fusen! — 社内向けWebサイトレビューツール
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "./lib/api.js";
import { proxy, injectOverlay, errorPage } from "./lib/proxy.js";
import { db } from "./lib/db.js";
import { getUser, parseCookies, browserHeaders, readRawBody, originOf } from "./lib/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4649; // ヨロシク

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Fusen自身のアセットは /fsn-assets/ 配下に隔離
// (ルート直下はレビュー対象サイトのパス中継に使うため衝突させない)
app.use("/fsn-assets", express.static(path.join(__dirname, "public"), { index: false }));

app.get("/", (req, res) => {
  if (!getUser(req)) return res.redirect("/login");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// アクセス方法のヘルプ(認証不要で閲覧可)
app.get("/help", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "help.html"));
});

// 共有リンク: ゲスト入口
app.get("/s/:token", (req, res) => {
  const c = db.canvases.find((x) => x.share_token === req.params.token);
  if (!c) return res.status(404).send("共有リンクが無効です");
  if (!getUser(req)) {
    return res.redirect(`/login?guest=1&next=${encodeURIComponent("/p/" + c.id)}`);
  }
  res.redirect(`/p/${c.id}`);
});

// キャンバスを開く = プロキシ表示へ
app.get("/c/:id", (req, res) => res.redirect(`/p/${req.params.id}`));

app.use("/api", api);
app.use(proxy);

// ============================================================
// フォールバック中継:
// レビュー対象サイトの相対パス読込・JS遷移・フォーム送信は、
// プロキシ表示中の自オリジン(localhost:4649/xxx)に届く。
// それを「直前に開いていたキャンバス」(fsn_canvasクッキー)の
// 対象サイトへ中継する。HTMLならオーバーレイ付きのプロキシ表示へ戻す。
// ============================================================
app.use(async (req, res, next) => {
  const user = getUser(req);
  if (!user) return next();
  const canvasId = parseCookies(req).fsn_canvas;
  if (!canvasId) return next();
  const canvas = db.canvases.find((c) => c.id === canvasId);
  if (!canvas) return next();

  // 対象サイトのオリジン + 同じパス&クエリ
  let target;
  try {
    target = new URL(req.originalUrl, canvas.url);
  } catch {
    return next();
  }

  // HTMLページへのGET(=JSによるルート絶対パス遷移など)はプロキシ表示へリダイレクト
  const wantsHtml = (req.headers.accept || "").includes("text/html");
  if (req.method === "GET" && wantsHtml) {
    return res.redirect(`/p/${canvas.id}${req.originalUrl}`);
  }

  try {
    const headers = browserHeaders(req);
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
    headers["sec-fetch-dest"] = "empty";
    headers["sec-fetch-mode"] = "cors";
    headers["sec-fetch-site"] = "same-origin";
    const init = {
      method: req.method,
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    };
    if (!["GET", "HEAD"].includes(req.method)) {
      init.body = await readRawBody(req);
    }
    const upstream = await fetch(target.href, init);
    const ctype = upstream.headers.get("content-type") || "";
    res.status(upstream.status);
    res.setHeader("Cache-Control", "no-store");

    // POST等の応答がHTMLの場合もオーバーレイを注入して返す(フォームログイン後の画面など)
    if (ctype.includes("text/html")) {
      let html = await upstream.text();
      html = injectOverlay(html, {
        canvas,
        finalUrl: upstream.url || target.href,
        appOrigin: originOf(req),
        user,
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(html);
    }

    res.setHeader("Content-Type", ctype || "application/octet-stream");
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    return next();
  }
});

app.listen(PORT, () => {
  console.log(`\n  Fusen! が起動しました → http://localhost:${PORT}\n`);
});
