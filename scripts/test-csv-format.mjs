// CSVエクスポート整形(public/csv-format.js)の単体テスト。
// 純関数のため副作用 import で globalThis.FsnCsvFormat を読む。
// 実行: node scripts/test-csv-format.mjs
import "../public/csv-format.js";

const F = globalThis.FsnCsvFormat;
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ok   -", msg); }
  else { fail++; console.error("  FAIL -", msg); }
}

console.log("CSVエクスポート整形テスト");

// ---- csvCell: RFC 4180 クォート ----
assert(F.csvCell("普通の文") === '"普通の文"', "csvCell: 全セルをクォート");
assert(F.csvCell('引用"符') === '"引用""符"', 'csvCell: 内部の " は "" へ');
assert(F.csvCell("カンマ,改行\nあり") === '"カンマ,改行\nあり"', "csvCell: カンマ/改行はクォート内に温存");
assert(F.csvCell(null) === '""' && F.csvCell(undefined) === '""', "csvCell: null/undefined は空セル");
assert(F.csvCell(3) === '"3"', "csvCell: 数値は文字列化");

// ---- csvCell: CSV(formula)injection 対策 ----
for (const head of ["=", "+", "-", "@", "\t", "\r"]) {
  const out = F.csvCell(head + "1+1");
  assert(out === '"\'' + head + '1+1"', `csvCell: 先頭 ${JSON.stringify(head)} に ' を前置`);
}
assert(F.csvCell("本文中の = は無害") === '"本文中の = は無害"', "csvCell: 先頭以外の = はそのまま");
assert(F.csvCell("=HYPERLINK(\"http://evil\",\"x\")") === '"\'=HYPERLINK(""http://evil"",""x"")"', "csvCell: 数式+引用符の複合");

// ---- statusLabel ----
assert(F.statusLabel("resolved") === "解決済み" && F.statusLabel("active") === "未解決", "statusLabel");

// ---- orderRows: ページ→ルート→返信の順、ピン番号はページ内連番 ----
const comments = [
  { id: "m_1", page: "https://ex.com/a", parent_id: null, body: "A1", author: "wakana", status: "active", created_at: "2026-07-01T10:00:00" },
  { id: "m_2", page: "https://ex.com/b", parent_id: null, body: "B1", author: "taro", status: "resolved", resolved_by: "wakana", created_at: "2026-07-01T11:00:00" },
  { id: "m_3", page: "https://ex.com/a", parent_id: "m_1", body: "A1への返信", author: "taro", status: "active", created_at: "2026-07-01T12:00:00" },
  { id: "m_4", page: "https://ex.com/a", parent_id: null, body: "A2", author: "wakana", status: "active", created_at: "2026-07-01T13:00:00", ctx_label: "購入ボタン", ctx_modal_label: "確認ダイアログ" },
];
const rows = F.orderRows(comments);
assert(rows.map((r) => r.c.id).join(",") === "m_1,m_3,m_4,m_2", "orderRows: ページ初出順→ルート作成順→返信はルート直後");
assert(rows[0].pinNo === 1 && rows[1].pinNo === 1 && rows[2].pinNo === 2, "orderRows: ピン番号はページ内連番、返信はルートと同番");
assert(rows[3].pinNo === 1, "orderRows: 別ページは番号を1から振り直す");
assert(rows[1].reply === true && rows[0].reply === false, "orderRows: reply フラグ");

// 親が消えた返信も取りこぼさない(末尾・番号なし)
const orphanRows = F.orderRows([
  { id: "m_r", page: "https://ex.com/a", parent_id: "m_gone", body: "迷子", author: "x", created_at: "2026-07-01T10:00:00" },
]);
assert(orphanRows.length === 1 && orphanRows[0].pinNo === null, "orderRows: 迷子の返信は末尾に番号なしで出す");

// ---- buildCommentsCsv ----
const csv = F.buildCommentsCsv(comments);
assert(csv.startsWith("﻿"), "buildCommentsCsv: 先頭に BOM");
const csvLines = csv.slice(1).split("\r\n");
assert(csvLines.at(-1) === "" && csvLines.length === 6, "buildCommentsCsv: ヘッダー+4行+末尾CRLF");
assert(csvLines[0].includes('"ピンNo"') && csvLines[0].includes('"親コメントID"'), "buildCommentsCsv: ヘッダー行");
assert(csvLines[1].includes('"コメント"') && csvLines[2].includes('"返信"'), "buildCommentsCsv: 種別列");
assert(csvLines[2].includes('"m_1"') && csvLines[2].includes('"—"'), "buildCommentsCsv: 返信行に親IDとステータス—");
assert(csvLines[3].includes('"購入ボタン"') && csvLines[3].includes('"確認ダイアログ"'), "buildCommentsCsv: ctx ラベル列");
assert(csvLines[4].includes('"解決済み"') && csvLines[4].includes('"wakana"'), "buildCommentsCsv: 解決済み+解決者");
assert(F.buildCommentsCsv([]) === "﻿" + csvLines[0] + "\r\n", "buildCommentsCsv: 空一覧はヘッダーのみ");

// 本文の改行が1セルに収まってCSV全体の行構造を壊さない
const multi = F.buildCommentsCsv([
  { id: "m_x", page: "p", parent_id: null, body: "1行目\n2行目", author: "a", status: "active", created_at: "2026-07-01T10:00:00" },
]);
assert(multi.slice(1).split("\r\n").length === 3, "buildCommentsCsv: セル内改行(LF)はレコード区切り(CRLF)と衝突しない");

// ---- buildCsvFilename ----
const d = new Date(2026, 6, 28);
assert(F.buildCsvFilename("トップページ改修", d) === "fusen_トップページ改修_20260728.csv", "buildCsvFilename: 基本形");
assert(F.buildCsvFilename('a/b\\c:d*e?f"g<h>i|j k', d) === "fusen_a_b_c_d_e_f_g_h_i_j_k_20260728.csv", "buildCsvFilename: 危険文字と空白を _ へ");
assert(F.buildCsvFilename("", d) === "fusen_canvas_20260728.csv", "buildCsvFilename: 空タイトルは canvas");
assert(F.buildCsvFilename("あ".repeat(80), d).length <= "fusen_".length + 50 + "_20260728.csv".length, "buildCsvFilename: 50字で打ち切り");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
