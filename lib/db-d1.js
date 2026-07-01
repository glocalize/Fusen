// Fusen データアクセス層 (Cloudflare D1 / SQLite, 非同期)
// 旧 lib/db.js(JSONファイル)の置き換え。各関数は第1引数に D1 バインディング(env.DB)を取る。
// API が返す JSON 形状は旧実装と一致させる(フロント無改修のため)。boolean 列は 0/1 ⇄ true/false を変換。

// ---- ID 採番(旧 nid を流用。内部IDのみに使用。推測困難性が要る値には使わない) ----
export function nid(prefix = "") {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 共有トークン(#7): Math.random ではなく CSPRNG(16バイト=128bit)で生成し base64url 化。
// ゲスト入口の認証材料なので推測/総当たりに耐えるエントロピーを持たせる。
export function shareToken() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return "s_" + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- bind 値の正規化(undefined→null。D1 は undefined を受け付けない) ----
const v = (x) => (x === undefined ? null : x);
const b = (x) => (x ? 1 : 0); // boolean → 0/1

// ---- 行の正規化(0/1 → boolean。JSON 契約を維持) ----
const normUser = (r) => (r ? { ...r, guest: !!r.guest } : null);
const normCanvas = (r) => (r ? { ...r, archived: !!r.archived } : null);
const normComment = (r) => (r ? { ...r, guest: !!r.guest } : null);
const normReview = (r) => r || null;

// ============================== users ==============================
export async function findUser(db, name, guest) {
  const row = await db.prepare("SELECT * FROM users WHERE name = ? AND guest = ?").bind(v(name), b(guest)).first();
  return normUser(row);
}

export async function addUser(db, u) {
  await db
    .prepare("INSERT INTO users (id, name, guest, created_at) VALUES (?, ?, ?, ?)")
    .bind(v(u.id), v(u.name), b(u.guest), v(u.created_at))
    .run();
  return normUser({ ...u, guest: b(u.guest) });
}

// ============================== canvases ==============================
export async function getCanvas(db, id) {
  const row = await db.prepare("SELECT * FROM canvases WHERE id = ?").bind(v(id)).first();
  return normCanvas(row);
}

export async function getCanvasByToken(db, token) {
  const row = await db.prepare("SELECT * FROM canvases WHERE share_token = ?").bind(v(token)).first();
  return normCanvas(row);
}

export async function addCanvas(db, c) {
  await db
    .prepare(
      "INSERT INTO canvases (id, title, url, host, share_token, archived, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(v(c.id), v(c.title), v(c.url), v(c.host), v(c.share_token), b(c.archived), v(c.created_by), v(c.created_at))
    .run();
  return canvasSummary(db, { ...c, archived: b(c.archived) });
}

export async function updateCanvas(db, id, patch) {
  const sets = [];
  const args = [];
  if (typeof patch.archived === "boolean") { sets.push("archived = ?"); args.push(b(patch.archived)); }
  if (typeof patch.title === "string") { sets.push("title = ?"); args.push(patch.title); }
  if (sets.length) {
    args.push(id);
    await db.prepare(`UPDATE canvases SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
  }
  return getCanvas(db, id);
}

// 集計付きサマリ(旧 canvasSummary 相当): comment_count / open_count / last_review
export async function canvasSummary(db, c) {
  if (!c) return null;
  const comment_count = await db
    .prepare("SELECT count(*) AS n FROM comments WHERE canvas_id = ? AND parent_id IS NULL")
    .bind(c.id).first("n");
  const open_count = await db
    .prepare("SELECT count(*) AS n FROM comments WHERE canvas_id = ? AND parent_id IS NULL AND status != 'resolved'")
    .bind(c.id).first("n");
  const last = await db
    .prepare("SELECT * FROM reviews WHERE canvas_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(c.id).first();
  return { ...normCanvas(c), comment_count, open_count, last_review: normReview(last) };
}

export async function listCanvases(db, archived) {
  const { results } = await db
    .prepare("SELECT * FROM canvases WHERE archived = ? ORDER BY created_at DESC")
    .bind(b(archived)).all();
  return Promise.all(results.map((r) => canvasSummary(db, r)));
}

// ============================== comments ==============================
export async function listComments(db, canvasId, page) {
  // page 指定時: 該当ページのトップレベル + 返信(ページ問わず)。旧実装の filter と等価。
  const stmt = page
    ? db.prepare("SELECT * FROM comments WHERE canvas_id = ? AND (parent_id IS NOT NULL OR page = ?) ORDER BY created_at ASC").bind(v(canvasId), v(page))
    : db.prepare("SELECT * FROM comments WHERE canvas_id = ? ORDER BY created_at ASC").bind(v(canvasId));
  const { results } = await stmt.all();
  return results.map(normComment);
}

export async function getComment(db, id) {
  const row = await db.prepare("SELECT * FROM comments WHERE id = ?").bind(v(id)).first();
  return normComment(row);
}

export async function addComment(db, m) {
  await db
    .prepare(
      "INSERT INTO comments (id, canvas_id, page, selector, rx, ry, ax, ay, body, author, author_id, guest, status, parent_id, resolved_by, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      v(m.id), v(m.canvas_id), v(m.page), v(m.selector),
      v(m.rx), v(m.ry), v(m.ax), v(m.ay),
      v(m.body), v(m.author), v(m.author_id), b(m.guest),
      v(m.status), v(m.parent_id), v(m.resolved_by ?? null), v(m.created_at)
    )
    .run();
  return normComment({ ...m, guest: b(m.guest), resolved_by: m.resolved_by ?? null });
}

export async function setCommentStatus(db, id, status, resolvedBy) {
  await db
    .prepare("UPDATE comments SET status = ?, resolved_by = ? WHERE id = ?")
    .bind(v(status), v(resolvedBy ?? null), v(id))
    .run();
  return getComment(db, id);
}

// 本体 + その返信を削除(旧 splice ループと等価)。存在したら true。
export async function deleteCommentCascade(db, id) {
  const exists = await db.prepare("SELECT 1 AS x FROM comments WHERE id = ?").bind(v(id)).first("x");
  if (!exists) return false;
  await db.prepare("DELETE FROM comments WHERE id = ? OR parent_id = ?").bind(v(id), v(id)).run();
  return true;
}

// ============================== reviews ==============================
export async function listReviews(db, canvasId) {
  const { results } = await db
    .prepare("SELECT * FROM reviews WHERE canvas_id = ? ORDER BY created_at ASC")
    .bind(v(canvasId)).all();
  return results.map(normReview);
}

export async function addReview(db, r) {
  await db
    .prepare("INSERT INTO reviews (id, canvas_id, verdict, comment, author, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(v(r.id), v(r.canvas_id), v(r.verdict), v(r.comment), v(r.author), v(r.created_at))
    .run();
  return normReview(r);
}
