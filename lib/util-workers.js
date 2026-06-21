// Workers 版 共通ユーティリティ(旧 lib/util.js の移植)。
// Express の req(node) ではなく、Web 標準の Request を受け取る。
const COOKIE = "fsn_user";

export function parseCookies(request) {
  const out = {};
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function getUser(request) {
  try {
    const c = parseCookies(request)[COOKIE];
    if (!c) return null;
    const u = JSON.parse(c);
    if (!u || !u.id || !u.name) return null;
    return u;
  } catch {
    return null;
  }
}

// Set-Cookie 文字列を返す(呼び出し側で c.header("Set-Cookie", ...) する)。
// 社内ツールにつき有効期限1年・HttpOnlyなし(オーバーレイJSが利用者名を参照するため)。
export function userCookie(user) {
  const val = encodeURIComponent(JSON.stringify({ id: user.id, name: user.name, guest: !!user.guest }));
  return `${COOKIE}=${val}; Path=/; Max-Age=31536000; SameSite=Lax`;
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
