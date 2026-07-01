# Fusen! セキュリティ診断レポート

対象: `~/DesignReviewTool/fusen`（Express + JSONストア + 素のJS、port 4649）
診断日: 2026-06-14 / 観点: 認証・認可・SSRF・XSS・機密情報・設定

> 前提として、これは「社内向け・小規模」という方針で作られたツールです。以下の指摘は本番／社外公開を想定したときの優先度で並べています。完全に閉じた社内LANのみで使うなら一部は許容できますが、**メモにある通り Cloudflare Pages / AWS Amplify 等のクラウド配信を視野に入れている**ため、SSRF と認証は早めに対処することを強く推奨します。

---

## 重大度サマリー

| # | 深刻度 | 項目 | 場所 |
|---|--------|------|------|
| 1 | 🔴 Critical | 認証クッキーが署名なしで偽造可能（実質認証なし） | `lib/util.js` getUser/setUserCookie |
| 2 | 🔴 Critical | SSRF — 任意URLをサーバーが取得し中身を返す | `lib/api.js` check-url / `lib/proxy.js` / `server.js` |
| 3 | 🟠 High | 認可の欠如（IDOR）— 全キャンバス・全コメントを誰でも閲覧/改変/削除 | `lib/api.js` 各エンドポイント |
| 4 | 🟠 High | 未信頼サイトを自オリジンで配信＋CSP除去（XSS土壌） | `lib/proxy.js` injectOverlay |
| 5 | 🟡 Medium | クッキーが HttpOnly でない | `lib/util.js` setUserCookie |
| 6 | 🟡 Medium | オープンリダイレクト（`next` 無検証） | `public/login.html` |
| 7 | 🟡 Medium | 共有トークンが Math.random 由来で低エントロピー | `lib/db.js` nid |
| 8 | 🟢 Low | レート制限なし / 生ボディ無制限 / エラー詳細露出 | 全体 |

---

## 🔴 1. 認証クッキーが偽造可能（実質的に認証が存在しない）

`getUser()` はクッキー `fsn_user` を **JSON.parse してそのまま信用** しています。署名・暗号化・サーバー側セッションが一切ありません。

```js
// lib/util.js
export function getUser(req) {
  const c = parseCookies(req)[COOKIE];
  const u = JSON.parse(c);          // ← 中身を検証せず信用
  if (!u || !u.id || !u.name) return null;
  return u;
}
```

つまり攻撃者は、ログインすらせずに次のクッキーを手で送るだけで任意のユーザーになりすませます:

```
Cookie: fsn_user={"id":"u_x","name":"管理者","guest":false}
```

ログイン自体も名前のみ（パスワードなし）なので、認証境界が事実上ありません。`requireUser` を通る全API・プロキシ・SSRF（#2）がこのクッキー1つで開きます。

**対策**
- セッションを採用する: `crypto.randomBytes` のセッションIDをサーバー側に保持し、クッキーにはIDのみを入れる。または HMAC 署名クッキー（`cookie-signature` / `express-session`）。
- 社内SSOがあるなら Google OAuth（メモの今後候補）か、最低でも共有パスワード／Basic認証をリバースプロキシ側で。
- クライアントが書き換えた値をサーバーが信用しない構造にする。

---

## 🔴 2. SSRF（Server-Side Request Forgery）

サーバーが**ユーザー指定のURLをそのまま fetch し、レスポンス本文を呼び出し元に返します**。内部ネットワークやクラウドメタデータへの到達が可能です。

該当箇所:
- `POST /api/check-url` — URLのホスト制限が一切なし。`http://169.254.169.254/...`（AWS/GCPメタデータ）、`http://localhost:6379`、社内IPなどへ到達でき、ステータスや到達可否が返る。
- `lib/proxy.js` `/p/:id/*` — キャンバスURLへ fetch し本文を返す。キャンバスは誰でも任意URLで作成可能（`POST /api/canvases`）。**非HTMLレスポンスは無検証でそのまま返す**ため、メタデータJSONや内部APIの中身を丸ごと読み出せる。
- `server.js` フォールバック中継 — `fsn_canvas` クッキー＋`originalUrl` から組み立てたURLへ fetch（リクエストボディ・一部ヘッダも転送）。

`isAllowed()` によるホスト一致チェックは **「HTMLのGET」かつ「最終リダイレクト先」にしか効かない** ため、
1. 非HTML（画像/JSON/プレーン）として返せばチェックを通らずに本文取得、
2. `redirect: "follow"` なので、許可ホストから内部アドレスへ302させればすり抜け、
という2系統でバイパスできます。クラウド配信時は **メタデータ経由でIAM認証情報が盗まれる** 恐れがあり、最も実害の大きい項目です。

**対策**
- 取得先を解決後のIPで検証する。プライベート/ループバック/リンクローカル（`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7` 等）を**ブロックリストではなく許可リスト方式**で拒否。
- DNSリバインディング・リダイレクト対策として、`redirect: "manual"` にして各ホップでIP再検証、またはホスト固定のディスパッチャを使う。
- `check-url` と `canvases` 作成時にスキーム/ホストを検証（`http/https` のみ、内部IP禁止）。
- 可能ならアウトバウンドを許可ドメインのリストに限定（自社ステージング等）。

---

## 🟠 3. 認可の欠如（IDOR / Broken Access Control）

エンドポイントは `requireUser`（ログイン済みか）だけを見ており、**そのリソースへのアクセス権**を確認していません。キャンバス単位のメンバーシップが存在しないため、ログイン済み（=偽造可・ゲスト可）の誰もが全社の全データに触れます。

- `DELETE /api/comments/:id` — **所有者チェックなし**。UIは自分のコメントしか削除ボタンを出しませんが、APIを直叩きすれば他人のコメント（と返信）を誰でも削除可能。
- `PATCH /api/comments/:id` — 任意コメントを解決/再オープン可能。
- `PATCH /api/canvases/:id` — 任意キャンバスを改名/アーカイブ可能。
- `GET /api/canvases`・`GET /api/canvases/:id`・`/comments` — 1つの共有リンクに招待されたゲストでも、**全キャンバス一覧と全コメントを取得可能**（共有トークンがスコープとして機能していない）。

**対策**
- キャンバスにメンバー（とゲストの許可キャンバスID）を持たせ、各エンドポイントで「このユーザーがこのキャンバスにアクセスできるか」を確認。
- 破壊的操作（削除/編集）は作成者または権限者のみに制限。
- ゲストはトークンで指定された1キャンバスにのみアクセス可能にする。

---

## 🟠 4. 未信頼サイトを自オリジンで配信 ＋ CSP 除去

`injectOverlay` は **プロキシ対象HTMLからCSP metaタグを削除** したうえで、対象サイトのコンテンツを Fusen 自身のオリジン（`localhost:4649`）で配信します。

```js
html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "");
```

レビュー対象は「AIでプロトタイピングしたサイト」（=信用しきれない）です。その中の任意のJS／侵害された対象サイトのJSが、**Fusenのオリジンで実行**されます。結果:
- `fsn_user` クッキーの窃取（#5 で HttpOnly でないため JS から読める）、
- Fusen API の呼び出しによる全キャンバス／コメント／共有トークンの抜き取り（#3 と連鎖）、
- 他レビュアーへのなりすまし投稿。

同一オリジンで未信頼コンテンツを配す設計自体がリスクで、CSP除去がそれを増幅しています。

**対策（難易度順）**
- コメント本文・著者名は `esc()` で適切にエスケープ済み（良い点）。問題はオーバーレイ側ではなく「対象サイトのJSが同一オリジンで動く」構造。
- 中長期: プロキシ配信を **別オリジン／サンドボックス iframe**（`sandbox` 属性、別ドメイン）に隔離し、オーバーレイUIは親フレーム側に置いて postMessage 連携。
- 短期: クッキーを HttpOnly + SameSite=Strict 化し（#5）、API側で Origin/Referer を検証、CSP除去をやめて注入分のみ `nonce` で許可。

---

## 🟡 5. 認証クッキーが HttpOnly でない

```js
// 「オーバーレイJSから利用者名を参照するため」コメントあり
res.setHeader("Set-Cookie", `${COOKIE}=...; Path=/; Max-Age=31536000; SameSite=Lax`);
```

JS から読める＝ XSS（#4）で即漏洩。ユーザー名表示は `/api/me` から取得すれば足ります。

**対策**: `HttpOnly` を付与し、本番は `Secure` も付与。`SameSite=Lax`→可能なら `Strict`。有効期限1年は長め。

---

## 🟡 6. オープンリダイレクト（`next` パラメータ無検証）

`public/login.html`:
```js
const next = q.get("next") || "/";
...
location.href = next;   // ← 外部URLでもそのまま遷移
```

`/?next=https://evil.example/...` のようなリンクでフィッシング誘導に使えます（ログイン直後に外部へ飛ばす）。

**対策**: `next` は「`/` で始まる相対パスのみ」許可。`new URL(next, location.origin)` で同一オリジン確認、それ以外は `/` にフォールバック。

---

## 🟡 7. 共有トークンが低エントロピー

```js
// lib/db.js
export function nid(prefix="") {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
```

`share_token`（ゲストアクセス用）が `Math.random()` 由来の約6文字。`Math.random` は暗号学的に安全でなく、作成時刻も推測しやすいため、総当たり／推測の余地があります。トークンはゲスト入口の認証材料なので要強化。

**対策**: 共有トークンは `crypto.randomBytes(16).toString("base64url")` 等で生成。

---

## 🟢 8. その他（Low）

- **レート制限なし**: `login` / `check-url` / プロキシ / 共有トークン入口にスロットリングがなく、トークン総当たり・SSRFスキャン・DoSが容易。`express-rate-limit` 等の導入を。
- **生ボディが無制限**: `readRawBody` は非GETリクエストのボディを上限なくバッファリング（`express.json` は1mb制限だがこちらは別経路）。メモリ枯渇DoSの余地。サイズ上限を設ける。
- **エラー詳細の露出**: `errorPage` が upstream の `e.message` をそのまま表示。内部ホスト名等が漏れうるので一般化したメッセージに。
- **`x-forwarded-proto` を無検証で信用**（`originOf`）: 共有URL生成等に使われるため、信頼できるプロキシ背後でのみ有効にする。

## 良かった点
- コメント本文・著者名・レビュー文を出力時に `esc()` で一貫してエスケープしており、**保存型XSSは（オーバーレイ／ダッシュボード双方で）適切に防御**されている。
- `data/` は `.gitignore` 済みで、DBに平文パスワード等の機密は含まれない。
- DB書き込みは tmp→rename のアトミック方式で、`x-powered-by` も無効化済み。

---

## 推奨対応順
1. **#2 SSRF** と **#1 認証偽造** — クラウド配信前に必須。最悪ケースで認証情報窃取・なりすまし全開。
2. **#3 認可** と **#4 オリジン分離** — データ漏洩・改ざんの実害に直結。
3. #5〜#7 — 比較的小改修で対応可。
4. #8 — 運用上の堅牢化。
