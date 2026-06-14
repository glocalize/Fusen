// 共通ユーティリティ: Cookieの読み書き・ユーザー取得
const COOKIE = "fsn_user";

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function getUser(req) {
  try {
    const c = parseCookies(req)[COOKIE];
    if (!c) return null;
    const u = JSON.parse(c);
    if (!u || !u.id || !u.name) return null;
    return u;
  } catch {
    return null;
  }
}

export function setUserCookie(res, user) {
  const v = encodeURIComponent(JSON.stringify({ id: user.id, name: user.name, guest: !!user.guest }));
  // 社内ツールにつき有効期限は1年・HttpOnlyなし(オーバーレイJSから利用者名を参照するため)
  res.setHeader("Set-Cookie", `${COOKIE}=${v}; Path=/; Max-Age=31536000; SameSite=Lax`);
}

// 実ブラウザに近いリクエストヘッダ(WAF/ボット対策の誤検知を減らす)
export function browserHeaders(req) {
  return {
    "user-agent":
      req.headers["user-agent"] ||
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    accept:
      req.headers["accept"] ||
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": req.headers["accept-language"] || "ja,en-US;q=0.9,en;q=0.8",
    "upgrade-insecure-requests": "1",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "sec-ch-ua": req.headers["sec-ch-ua"] || '"Google Chrome";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "cache-control": "no-cache",
    pragma: "no-cache",
  };
}

// リクエストボディを生のまま読み出す(express.jsonで解析済みならJSONに戻す)
export function readRawBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object" && Object.keys(req.body).length) {
      return resolve(JSON.stringify(req.body));
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on("error", () => resolve(undefined));
  });
}

export function originOf(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  return `${proto}://${req.get("host")}`;
}
