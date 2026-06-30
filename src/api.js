// REST API: 認証 / キャンバス / コメント / レビュー(lib/api.js の Workers 移植)。
// 返す JSON 形状は旧実装と一致(フロント無改修)。データは D1(lib/db-d1.js)。
import { Hono } from "hono";
import * as db from "../lib/db-d1.js";
import { getUser, userCookie, browserHeaders, originOf } from "../lib/util-workers.js";
import { basicAuthHeader } from "./proxy.js";

export const api = new Hono();

const requireUser = async (c, next) => {
  const u = getUser(c.req.raw);
  if (!u) return c.json({ error: "ログインが必要です" }, 401);
  c.set("user", u);
  await next();
};

// D1 疎通確認
api.get("/_health", async (c) => {
  try {
    const n = await c.env.DB.prepare("SELECT count(*) AS n FROM canvases").first("n");
    return c.json({ ok: true, db: "d1", canvases: n });
  } catch (e) {
    return c.json({ ok: false, error: String(e?.message || e) }, 500);
  }
});

// ---- 認証(名前だけの簡易方式) ----
api.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = String(body?.name || "").trim().slice(0, 40);
  const guest = !!body?.guest;
  if (!name) return c.json({ error: "名前を入力してください" }, 400);
  let user = await db.findUser(c.env.DB, name, guest);
  if (!user) {
    user = { id: db.nid("u_"), name, guest, created_at: new Date().toISOString() };
    await db.addUser(c.env.DB, user);
  }
  c.header("Set-Cookie", userCookie(user));
  return c.json({ user });
});

api.get("/me", (c) => c.json({ user: getUser(c.req.raw) }));

// ---- URLの表示可否チェック ----
api.post("/check-url", requireUser, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let url = String(body?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  let target;
  try {
    target = new URL(url);
  } catch {
    return c.json({ error: "URLの形式が正しくありません" }, 400);
  }
  try {
    const headers = browserHeaders(c.req.raw);
    const ba = basicAuthHeader(c.env, target.hostname);
    if (ba) headers["authorization"] = ba;
    const r = await fetch(target.href, {
      redirect: "follow",
      headers,
      signal: AbortSignal.timeout(12000),
    });
    const blocked = [401, 403, 406, 429, 503].includes(r.status);
    return c.json({
      ok: r.ok,
      blocked,
      status: r.status,
      message: blocked
        ? `サイト側にアクセスを拒否されました(HTTP ${r.status})。ボット対策(WAF)やログイン保護が原因の可能性があります。`
        : r.ok
          ? "表示できます"
          : `サイトがエラーを返しました(HTTP ${r.status})`,
    });
  } catch (e) {
    return c.json({ ok: false, blocked: false, status: 0, message: `接続できませんでした(${String(e?.cause?.code || e?.message || e)})` });
  }
});

// ---- キャンバス ----
api.get("/canvases", requireUser, async (c) => {
  const archived = c.req.query("archived") === "1";
  const canvases = await db.listCanvases(c.env.DB, archived);
  return c.json({ canvases });
});

api.post("/canvases", requireUser, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  let url = String(body?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return c.json({ error: "URLの形式が正しくありません" }, 400);
  }
  const user = c.get("user");
  const canvas = {
    id: db.nid("c_"),
    title: String(body?.title || "").trim().slice(0, 80) || parsed.hostname,
    url: parsed.href,
    host: parsed.hostname,
    share_token: db.nid("s_"),
    archived: false,
    created_by: user.name,
    created_at: new Date().toISOString(),
  };
  const canvasOut = await db.addCanvas(c.env.DB, canvas);
  return c.json({ canvas: canvasOut });
});

api.get("/canvases/:id", requireUser, async (c) => {
  const canvas = await db.getCanvas(c.env.DB, c.req.param("id"));
  if (!canvas) return c.json({ error: "キャンバスが見つかりません" }, 404);
  const reviews = await db.listReviews(c.env.DB, canvas.id);
  const summary = await db.canvasSummary(c.env.DB, canvas);
  return c.json({ canvas: summary, reviews, share_url: `${originOf(c.req.raw)}/s/${canvas.share_token}` });
});

api.patch("/canvases/:id", requireUser, async (c) => {
  const id = c.req.param("id");
  const existing = await db.getCanvas(c.env.DB, id);
  if (!existing) return c.json({ error: "キャンバスが見つかりません" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const patch = {};
  if (typeof body?.archived === "boolean") patch.archived = body.archived;
  if (typeof body?.title === "string") {
    const t = body.title.trim().slice(0, 80);
    if (t) patch.title = t;
  }
  await db.updateCanvas(c.env.DB, id, patch);
  const updated = await db.getCanvas(c.env.DB, id);
  const summary = await db.canvasSummary(c.env.DB, updated);
  return c.json({ canvas: summary });
});

// ---- コメント ----
api.get("/canvases/:id/comments", requireUser, async (c) => {
  const page = c.req.query("page") || null;
  const comments = await db.listComments(c.env.DB, c.req.param("id"), page);
  return c.json({ comments });
});

api.post("/canvases/:id/comments", requireUser, async (c) => {
  const canvas = await db.getCanvas(c.env.DB, c.req.param("id"));
  if (!canvas) return c.json({ error: "キャンバスが見つかりません" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const bodyText = String(b?.body || "").trim().slice(0, 4000);
  if (!bodyText) return c.json({ error: "コメントを入力してください" }, 400);
  const user = c.get("user");
  const m = {
    id: db.nid("m_"),
    canvas_id: canvas.id,
    page: String(b?.page || canvas.url),
    selector: b?.selector ? String(b.selector).slice(0, 500) : null,
    rx: Number(b?.rx) || 0,
    ry: Number(b?.ry) || 0,
    ax: Number(b?.ax) || 0,
    ay: Number(b?.ay) || 0,
    body: bodyText,
    author: user.name,
    author_id: user.id,
    guest: !!user.guest,
    status: "active",
    parent_id: b?.parent_id || null,
    resolved_by: null,
    created_at: new Date().toISOString(),
  };
  const saved = await db.addComment(c.env.DB, m);
  return c.json({ comment: saved });
});

api.patch("/comments/:id", requireUser, async (c) => {
  const m = await db.getComment(c.env.DB, c.req.param("id"));
  if (!m) return c.json({ error: "コメントが見つかりません" }, 404);
  const b = await c.req.json().catch(() => ({}));
  if (b?.status && ["active", "resolved"].includes(b.status)) {
    const user = c.get("user");
    const resolvedBy = b.status === "resolved" ? user.name : null;
    const updated = await db.setCommentStatus(c.env.DB, m.id, b.status, resolvedBy);
    return c.json({ comment: updated });
  }
  return c.json({ comment: m });
});

api.delete("/comments/:id", requireUser, async (c) => {
  const ok = await db.deleteCommentCascade(c.env.DB, c.req.param("id"));
  if (!ok) return c.json({ error: "コメントが見つかりません" }, 404);
  return c.json({ ok: true });
});

// ---- レビュー(承認フロー) ----
api.post("/canvases/:id/reviews", requireUser, async (c) => {
  const canvas = await db.getCanvas(c.env.DB, c.req.param("id"));
  if (!canvas) return c.json({ error: "キャンバスが見つかりません" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const verdict = b?.verdict;
  if (!["approved", "changes_requested"].includes(verdict)) return c.json({ error: "判定が不正です" }, 400);
  const user = c.get("user");
  const r = {
    id: db.nid("r_"),
    canvas_id: canvas.id,
    verdict,
    comment: String(b?.comment || "").trim().slice(0, 2000),
    author: user.name,
    created_at: new Date().toISOString(),
  };
  const saved = await db.addReview(c.env.DB, r);
  return c.json({ review: saved });
});
