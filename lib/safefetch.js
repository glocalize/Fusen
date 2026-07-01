// SSRF 対策の共通ヘルパー(Cloudflare Workers 版)。
// 監査レポート #2 の方針「IP検証を1ヘルパーに集約し、3経路(check-url / proxy / 中継)から呼ぶ」を
// Workers ランタイムに合わせて実装したもの。
//
// 【Workers 特有の前提 — なぜ dns.lookup を使わないか】
// - Workers ランタイムには node:dns(dns.lookup)が無く、ホスト名→IP の事前解決ができない。
//   そのため「解決後の全IPを検査」の代わりに、URL のホスト名が内部アドレス表記
//   (プライベート/ループバック/リンクローカル/localhost/*.internal 等)かどうかを検査する。
// - さらに Cloudflare の fetch はプライベート/メタデータ(169.254.169.254 等)へは
//   そもそも egress しない(プラットフォーム側で遮断)。本ヘルパーは多層防御として、
//   明示的な内部アドレス指定と、リダイレクト経由の内部到達(DNSリバインド類似)を拒否する。
// - 公開ホスト名が内部IPへ解決されるケースは Workers 側で検知できないが、上記のとおり
//   Cloudflare の egress がそこへ到達しないため実害は生じない(この限界はコメントで明示)。

// ブロック対象と判定したときに投げるエラー(呼び出し側が判別できるよう code を持たせる)
export class BlockedAddressError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlockedAddressError";
    this.code = "BLOCKED_ADDRESS";
  }
}

const LITERAL_LOCAL = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

function stripBrackets(h) {
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

// 10進(2130706433)や16進(0x7f000001)のIP表記は正規のホスト名ではないので拒否側に倒す
function isNumericHost(host) {
  return /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host);
}

export function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return true; // 不正な8bit超は拒否側へ
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 (unspecified)
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local(クラウドメタデータ)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  return false;
}

export function isPrivateIPv6(host) {
  const h = host.toLowerCase();
  if (h === "::" || h === "::1") return true; // unspecified / loopback
  if (h.startsWith("fe80")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 ULA
  // IPv4-mapped(ドット表記): ::ffff:127.0.0.1
  const dotted = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (dotted) return isPrivateIPv4(dotted[1]);
  // IPv4-mapped(URL正規化後の16進表記 ::ffff:hhhh:hhhh)/ NAT64(64:ff9b::hhhh:hhhh)。
  // 末尾32bitに埋め込まれた IPv4 を復元して内部判定する(::ffff:169.254.169.254 等の回避を防ぐ)。
  const hex = /(?:::ffff:|^64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

// URL を検証して、公開アドレス宛でなければ BlockedAddressError を投げる。問題なければ URL を返す。
export function assertPublicUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new BlockedAddressError("URLの形式が正しくありません");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new BlockedAddressError("http/https のURLのみ許可されています");
  }
  // 末尾ドット(localhost. / 127.0.0.1. など)は解決先が同じなので除去してから判定する
  const host = stripBrackets(u.hostname).toLowerCase().replace(/\.$/, "");
  if (!host) throw new BlockedAddressError("ホスト名がありません");
  if (LITERAL_LOCAL.has(host)) throw new BlockedAddressError("内部アドレスへのアクセスは禁止されています");
  if (host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new BlockedAddressError("内部アドレスへのアクセスは禁止されています");
  }
  if (isNumericHost(host)) throw new BlockedAddressError("数値形式のホストは許可されていません");
  if (isPrivateIPv4(host)) throw new BlockedAddressError("プライベートIPへのアクセスは禁止されています");
  if (host.includes(":") && isPrivateIPv6(host)) {
    throw new BlockedAddressError("プライベートIPv6へのアクセスは禁止されています");
  }
  return u;
}

// リダイレクトを手動で辿り、各ホップを assertPublicUrl で再検証してから進む安全な fetch。
// redirect:"follow" と違い「許可ホスト→内部IPへの302」で内部へ抜けられない。
export async function safeFetch(urlStr, init = {}, { maxHops = 5 } = {}) {
  let current = assertPublicUrl(urlStr).href;
  let method = (init.method || "GET").toUpperCase();
  let body = init.body;

  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await fetch(current, { ...init, method, body, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res; // リダイレクトでなければ確定
    if (hop === maxHops) throw new BlockedAddressError("リダイレクトが多すぎます");

    const next = assertPublicUrl(new URL(loc, current).href); // 次ホップを必ず再検証
    // ブラウザ準拠の簡易メソッド遷移: 303、および POST への 301/302 は GET 化しボディを落とす
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
    }
    current = next.href;
  }
  throw new BlockedAddressError("リダイレクトが多すぎます");
}
