// REST API: 認証 / キャンバス / コメント / レビュー
import { Router } from "express";
import { db, nid } from "./db.js";
import { getUser, setUserCookie, originOf, browserHeaders } from "./util.js";

export const api = Router();

function requireUser(req, res, next) {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: "ログインが必要です" });
  req.user = u;
  next();
}

// ---- 認証(名前だけの簡易方式) ----
api.post("/login", (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 40);
  const guest = !!req.body?.guest;
  if (!name) return res.status(400).json({ error: "名前を入力してください" });
  let user = db.users.find((u) => u.name === name && !!u.guest === guest);
  if (!user) {
    user = { id: nid("u_"), name, guest, created_at: new Date().toISOString() };
    db.users.push(user);
    db.save();
  }
  setUserCookie(res, user);
  res.json({ user });
});

api.get("/me", (req, res) => res.json({ user: getUser(req) }));

// ---- URLの表示可否チェック(キャンバス作成前の疎通確認) ----
api.post("/check-url", requireUser, async (req, res) => {
  let url = String(req.body?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  let target;
  try {
    target = new URL(url);
  } catch {
    return res.status(400).json({ error: "URLの形式が正しくありません" });
  }
  try {
    const r = await fetch(target.href, {
      redirect: "follow",
      headers: browserHeaders(req),
      signal: AbortSignal.timeout(12000),
    });
    const blocked = [401, 403, 406, 429, 503].includes(r.status);
    res.json({
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
    res.json({ ok: false, blocked: false, status: 0, message: `接続できませんでした(${String(e?.cause?.code || e?.message || e)})` });
  }
});

// ---- キャンバス ----
function canvasSummary(c) {
  const comments = db.comments.filter((m) => m.canvas_id === c.id && !m.parent_id);
  const open = comments.filter((m) => m.status !== "resolved").length;
  const reviews = db.reviews.filter((r) => r.canvas_id === c.id);
  const lastReview = reviews[reviews.length - 1] || null;
  return { ...c, comment_count: comments.length, open_count: open, last_review: lastReview };
}

api.get("/canvases", requireUser, (req, res) => {
  const archived = req.query.archived === "1";
  const list = db.canvases
    .filter((c) => !!c.archived === archived)
    .map(canvasSummary)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  res.json({ canvases: list });
});

api.post("/canvases", requireUser, (req, res) => {
  let url = String(req.body?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "URLの形式が正しくありません" });
  }
  const c = {
    id: nid("c_"),
    title: String(req.body?.title || "").trim().slice(0, 80) || parsed.hostname,
    url: parsed.href,
    host: parsed.hostname,
    share_token: nid("s_"),
    archived: false,
    created_by: req.user.name,
    created_at: new Date().toISOString(),
  };
  db.canvases.push(c);
  db.save();
  res.json({ canvas: canvasSummary(c) });
});

api.get("/canvases/:id", requireUser, (req, res) => {
  const c = db.canvases.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "キャンバスが見つかりません" });
  const reviews = db.reviews.filter((r) => r.canvas_id === c.id);
  res.json({ canvas: canvasSummary(c), reviews, share_url: `${originOf(req)}/s/${c.share_token}` });
});

api.patch("/canvases/:id", requireUser, (req, res) => {
  const c = db.canvases.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "キャンバスが見つかりません" });
  if (typeof req.body?.archived === "boolean") c.archived = req.body.archived;
  if (typeof req.body?.title === "string") c.title = req.body.title.trim().slice(0, 80) || c.title;
  db.save();
  res.json({ canvas: canvasSummary(c) });
});

// ---- コメント ----
api.get("/canvases/:id/comments", requireUser, (req, res) => {
  const page = req.query.page ? String(req.query.page) : null;
  let list = db.comments.filter((m) => m.canvas_id === req.params.id);
  if (page) list = list.filter((m) => m.page === page || m.parent_id);
  res.json({ comments: list });
});

api.post("/canvases/:id/comments", requireUser, (req, res) => {
  const c = db.canvases.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "キャンバスが見つかりません" });
  const b = req.body || {};
  const body = String(b.body || "").trim().slice(0, 4000);
  if (!body) return res.status(400).json({ error: "コメントを入力してください" });
  const m = {
    id: nid("m_"),
    canvas_id: c.id,
    page: String(b.page || c.url),
    selector: b.selector ? String(b.selector).slice(0, 500) : null,
    rx: Number(b.rx) || 0,
    ry: Number(b.ry) || 0,
    ax: Number(b.ax) || 0,
    ay: Number(b.ay) || 0,
    body,
    author: req.user.name,
    author_id: req.user.id,
    guest: !!req.user.guest,
    status: "active",
    parent_id: b.parent_id || null,
    created_at: new Date().toISOString(),
  };
  db.comments.push(m);
  db.save();
  res.json({ comment: m });
});

api.patch("/comments/:id", requireUser, (req, res) => {
  const m = db.comments.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: "コメントが見つかりません" });
  if (req.body?.status && ["active", "resolved"].includes(req.body.status)) {
    m.status = req.body.status;
    m.resolved_by = req.body.status === "resolved" ? req.user.name : null;
  }
  db.save();
  res.json({ comment: m });
});

api.delete("/comments/:id", requireUser, (req, res) => {
  const i = db.comments.findIndex((x) => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "コメントが見つかりません" });
  const id = db.comments[i].id;
  // 返信ごと削除
  for (let j = db.comments.length - 1; j >= 0; j--) {
    if (db.comments[j].id === id || db.comments[j].parent_id === id) db.comments.splice(j, 1);
  }
  db.save();
  res.json({ ok: true });
});

// ---- レビュー(承認フロー) ----
api.post("/canvases/:id/reviews", requireUser, (req, res) => {
  const c = db.canvases.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "キャンバスが見つかりません" });
  const verdict = req.body?.verdict;
  if (!["approved", "changes_requested"].includes(verdict))
    return res.status(400).json({ error: "判定が不正です" });
  const r = {
    id: nid("r_"),
    canvas_id: c.id,
    verdict,
    comment: String(req.body?.comment || "").trim().slice(0, 2000),
    author: req.user.name,
    created_at: new Date().toISOString(),
  };
  db.reviews.push(r);
  db.save();
  res.json({ review: r });
});
