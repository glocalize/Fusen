// ================================================
// Fusen! Issue化 — コメントスレッドを GitHub Issue 用テキストへ整形する純関数群。
// ブラウザでは classic <script> として読み込まれ globalThis.FsnIssueFormat に載る。
// import/export を使わないため、type=module の node からも副作用 import して同名で参照できる
// (scripts/test-issue-format.mjs)。CFG や DOM には一切触れない純粋なテキスト整形のみ。
// ================================================
(function (g) {
  // ISO文字列 → "YYYY-MM-DD HH:mm"(ローカル時刻)。GitHubに貼る人間可読な日時。
  function fmtDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso ?? "");
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // 本文の先頭 n 文字(改行・連続空白は1スペースに畳む)。タイトル用。
  function excerpt(body, n = 40) {
    const s = String(body ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  // status コード → 日本語表示
  function statusLabel(status) {
    return status === "resolved" ? "解決済み" : "未解決";
  }

  // スレッド(ルート + 返信配列)を Markdown 箇条書きへ。
  // ルート = "- **author**（日時）: body" / 返信 = "  - ↳ **author**（日時）: body"
  function buildThreadBlock(root, replies) {
    const line = (m, reply) =>
      `${reply ? "  - ↳ " : "- "}**${m.author}**（${fmtDateTime(m.created_at)}）: ${m.body}`;
    return [line(root, false), ...(replies || []).map((r) => line(r, true))].join("\n");
  }

  // タイトル: "[Fusen] <canvasTitle> #<pinNo>: <本文先頭40字>"
  function buildIssueTitle({ canvasTitle, pinNo, rootBody }) {
    return `[Fusen] ${canvasTitle} #${pinNo}: ${excerpt(rootBody, 40)}`;
  }

  // Issue 本文 Markdown(仕様 v0.2 の既定テンプレート)。
  // ctxLabel / ctxModal / ctxModalLabel は任意(作成時コンテキスト)。
  // ctxLabel があるときだけ「- 対象: …」の行が入り、モーダル内ならダイアログ名を添える。
  function buildIssueBody(opt) {
    const {
      canvasTitle,
      pageUrl,
      selector,
      pinNo,
      status,
      deepLink,
      rootBody,
      threadBlock,
      generatedAt,
      ctxLabel,
      ctxModal,
      ctxModalLabel,
    } = opt;
    const ctxLines = ctxLabel
      ? [`- 対象: ${ctxLabel}${ctxModal ? `（ダイアログ${ctxModalLabel ? `「${ctxModalLabel}」` : ""}内）` : ""}`]
      : [];
    return [
      "## 概要",
      rootBody,
      "",
      "## 対象",
      `- キャンバス: ${canvasTitle}`,
      `- ページ: ${pageUrl}`,
      "- 要素: `" + (selector || "(セレクタなし)") + "`",
      ...ctxLines,
      `- ピン: #${pinNo}（${statusLabel(status)}）`,
      `- Fusenで開く: ${deepLink}`,
      "",
      "## スクリーンショット",
      "<!-- ここにスクショを貼付（「画像をコピー」→ Ctrl/Cmd+V） -->",
      "",
      "## スレッド",
      threadBlock,
      "",
      "---",
      `Fusenから生成 / ${fmtDateTime(generatedAt)}`,
    ].join("\n");
  }

  g.FsnIssueFormat = { fmtDateTime, excerpt, statusLabel, buildThreadBlock, buildIssueTitle, buildIssueBody };
})(typeof globalThis !== "undefined" ? globalThis : this);
