// Workers 版 共通ユーティリティ(旧 lib/util.js の移植)。
// Express の req(node) ではなく、Web 標準の Request を受け取る。
//
// 【認証(#1 修正)】fsn_user は「値.署名」形式の HMAC-SHA256 署名クッキー。
// 署名鍵は env.SESSION_SECRET(Cloudflare secret)だけが持つため、クライアントが中身を
// 書き換えても正しい署名を作れず、なりすまし(偽造)ができない。サーバー側に状態を持たない
// ステートレス方式で Workers に適する。クッキーは HttpOnly を付与し JS から読めない。
const COOKIE = "fsn_user";
const MAX_AGE = 31536000; // 1年
const enc = new TextEncoder();

export function parseCookies(request) {
  const out = {};
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---- base64url ----
function b64urlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// user から署名付きトークン("payload.signature")を生成
async function signSession(user, secret) {
  const payload = JSON.stringify({ id: user.id, name: user.name, guest: !!user.guest, canvasId: user.canvasId || null });
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  return b64urlEncode(enc.encode(payload)) + "." + b64urlEncode(sig);
}

// 署名を検証して user を返す。secret 未設定・署名不一致・改変時は null(=未認証)。
export async function getUser(request, secret) {
  try {
    if (!secret) return null;
    const raw = parseCookies(request)[COOKIE];
    if (!raw) return null;
    const dot = raw.lastIndexOf(".");
    if (dot < 1) return null;
    const payloadBytes = b64urlDecode(raw.slice(0, dot));
    const sigBytes = b64urlDecode(raw.slice(dot + 1));
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, sigBytes, payloadBytes);
    if (!valid) return null;
    const u = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (!u || !u.id || !u.name) return null;
    return { id: u.id, name: u.name, guest: !!u.guest, canvasId: u.canvasId || null };
  } catch {
    return null;
  }
}

// Set-Cookie 文字列(署名付き・HttpOnly)。secure は https のとき true を渡す。
export async function userCookie(user, secret, { secure = true } = {}) {
  const val = await signSession(user, secret);
  const attrs = ["Path=/", `Max-Age=${MAX_AGE}`, "SameSite=Lax", "HttpOnly"];
  if (secure) attrs.push("Secure");
  return `${COOKIE}=${val}; ${attrs.join("; ")}`;
}

// ログアウト用: クッキーを失効させる Set-Cookie。
export function clearCookie({ secure = true } = {}) {
  const attrs = ["Path=/", "Max-Age=0", "SameSite=Lax", "HttpOnly"];
  if (secure) attrs.push("Secure");
  return `${COOKIE}=; ${attrs.join("; ")}`;
}

// キャンバスへのアクセス可否(#3 認可)。
// ・通常ユーザー(社内メンバー)は全キャンバスにアクセス可。
// ・ゲストは招待された1キャンバス(セッションに束縛した canvasId)のみ。
export function canAccessCanvas(user, canvasId) {
  if (!user) return false;
  if (user.guest) return !!user.canvasId && user.canvasId === canvasId;
  return true;
}

// リクエストが https かどうか(Secure 属性の付与判定に使う)。
export function isSecureRequest(request) {
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

// 実ブラウザ風リクエストヘッダ(WAF/ボット対策の誤検知を減らす)。
export function browserHeaders(request) {
  const h = request.headers;
  return {
    "user-agent":
      h.get("user-agent") ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    accept:
      h.get("accept") ||
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": h.get("accept-language") || "ja,en-US;q=0.9,en;q=0.8",
    "upgrade-insecure-requests": "1",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "sec-ch-ua": h.get("sec-ch-ua") || '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "cache-control": "no-cache",
    pragma: "no-cache",
  };
}

export function originOf(request) {
  return new URL(request.url).origin;
}
