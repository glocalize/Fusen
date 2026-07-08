// Issue化テキスト整形(public/issue-format.js)の単体テスト。
// 純関数のため副作用 import で globalThis.FsnIssueFormat を読む。
// 実行: node scripts/test-issue-format.mjs
import "../public/issue-format.js";

const F = globalThis.FsnIssueFormat;
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ok   -", msg); }
  else { fail++; console.error("  FAIL -", msg); }
}

console.log("Issue化テキスト整形テスト");

// fmtDateTime: ローカル時刻の "YYYY-MM-DD HH:mm"
const dt = F.fmtDateTime("2026-07-06T14:20:00");
assert(/^2026-07-06 \d{2}:\d{2}$/.test(dt), `fmtDateTime → "${dt}"`);
assert(F.fmtDateTime("こわれた日付") === "こわれた日付", "fmtDateTime: 不正な日付は原文返し");

// excerpt: 40字で切って…付与、空白畳み
assert(F.excerpt("ボタンの\n余白が  詰まりすぎ") === "ボタンの 余白が 詰まりすぎ", "excerpt: 改行/連続空白を1スペースへ");
const long = "あ".repeat(50);
assert(F.excerpt(long, 40) === "あ".repeat(40) + "…", "excerpt: 40字超は…付与");
assert(F.excerpt("短い", 40) === "短い", "excerpt: 40字以内はそのまま");

// statusLabel
assert(F.statusLabel("resolved") === "解決済み" && F.statusLabel("active") === "未解決", "statusLabel");

// buildThreadBlock: ルート + 返信のネスト
const root = { author: "wakana", created_at: "2026-07-06T14:20:00", body: "ボタンの余白が詰まりすぎ" };
const replies = [
  { author: "taro", created_at: "2026-07-06T14:35:00", body: "8px→16pxに広げます" },
  { author: "wakana", created_at: "2026-07-06T15:01:00", body: "OKです" },
];
const block = F.buildThreadBlock(root, replies);
const lines = block.split("\n");
assert(lines.length === 3, "buildThreadBlock: 行数=ルート+返信");
assert(lines[0].startsWith("- **wakana**（2026-07-06 14:20）: ボタンの余白が詰まりすぎ"), "buildThreadBlock: ルート行");
assert(lines[1].startsWith("  - ↳ **taro**（2026-07-06 14:35）: 8px→16pxに広げます"), "buildThreadBlock: 返信行(ネスト+↳)");
assert(F.buildThreadBlock(root, []).split("\n").length === 1, "buildThreadBlock: 返信なしは1行");

// buildIssueTitle
assert(
  F.buildIssueTitle({ canvasTitle: "トップページ改修", pinNo: 3, rootBody: "ボタンの余白が詰まりすぎ" }) ===
    "[Fusen] トップページ改修 #3: ボタンの余白が詰まりすぎ",
  "buildIssueTitle"
);

// buildIssueBody: テンプレート差し込み全体
const body = F.buildIssueBody({
  canvasTitle: "トップページ改修",
  pageUrl: "https://example.com/top",
  selector: "header .cta",
  pinNo: 3,
  status: "active",
  deepLink: "https://fusen.example/p/abc/top#fsn=cmt_1",
  rootBody: "ボタンの余白が詰まりすぎ",
  threadBlock: block,
  generatedAt: "2026-07-06T15:10:00",
});
assert(body.includes("## 概要\nボタンの余白が詰まりすぎ"), "buildIssueBody: 概要");
assert(body.includes("- キャンバス: トップページ改修"), "buildIssueBody: キャンバス");
assert(body.includes("- ページ: https://example.com/top"), "buildIssueBody: ページURL");
assert(body.includes("- 要素: `header .cta`"), "buildIssueBody: セレクタ");
assert(body.includes("- ピン: #3（未解決）"), "buildIssueBody: ピン番号+状態");
assert(body.includes("- Fusenで開く: https://fusen.example/p/abc/top#fsn=cmt_1"), "buildIssueBody: deep_link");
assert(body.includes("<!-- ここにスクショを貼付"), "buildIssueBody: スクショ プレースホルダ");
assert(body.includes("## スレッド\n" + block), "buildIssueBody: スレッド差し込み");
assert(/Fusenから生成 \/ 2026-07-06 15:10$/.test(body), "buildIssueBody: フッター");
assert(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(body), "buildIssueBody: 絵文字を含まない");

// セレクタ未指定のフォールバック
const body2 = F.buildIssueBody({
  canvasTitle: "x", pageUrl: "u", selector: "", pinNo: 1, status: "resolved",
  deepLink: "d", rootBody: "b", threadBlock: "t", generatedAt: "2026-07-06T00:00:00",
});
assert(body2.includes("- 要素: `(セレクタなし)`"), "buildIssueBody: セレクタ空はフォールバック表示");
assert(body2.includes("- ピン: #1（解決済み）"), "buildIssueBody: 解決済み表示");

// 作成時コンテキスト(ctx)あり: 「- 対象: …（ダイアログ「…」内）」の行が入る
const body3 = F.buildIssueBody({
  canvasTitle: "x", pageUrl: "u", selector: "s", pinNo: 2, status: "active",
  deepLink: "d", rootBody: "b", threadBlock: "t", generatedAt: "2026-07-06T00:00:00",
  ctxLabel: "購入するボタン", ctxModal: true, ctxModalLabel: "購入の確認",
});
assert(body3.includes("- 対象: 購入するボタン（ダイアログ「購入の確認」内）"), "buildIssueBody: ctxあり(モーダル内)は対象行を追加");

// ctxなし(既存コメント): 対象行は出さない
assert(!body.includes("- 対象: "), "buildIssueBody: ctxなしは対象行を出さない");

// ctxあり・モーダル外: ダイアログ表記なしの対象行のみ
const body4 = F.buildIssueBody({
  canvasTitle: "x", pageUrl: "u", selector: "s", pinNo: 2, status: "active",
  deepLink: "d", rootBody: "b", threadBlock: "t", generatedAt: "2026-07-06T00:00:00",
  ctxLabel: "ヒーロー見出し", ctxModal: false, ctxModalLabel: "",
});
assert(body4.includes("- 対象: ヒーロー見出し") && !body4.includes("ダイアログ"), "buildIssueBody: ctxあり(モーダル外)はラベルのみ");

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
