// ================================================
// Fusen! CSVエクスポート — キャンバスのコメント一覧を CSV テキストへ整形する純関数群。
// ブラウザでは classic <script> として読み込まれ globalThis.FsnCsvFormat に載る。
// import/export を使わないため、type=module の node からも副作用 import して同名で参照できる
// (scripts/test-csv-format.mjs)。CFG や DOM には一切触れない純粋なテキスト整形のみ。
// ================================================
(function (g) {
  // ISO文字列 → "YYYY-MM-DD HH:mm"(ローカル時刻)。issue-format.js と同じ表示形式。
  function fmtDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso ?? "");
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // 1セル分のエスケープ。RFC 4180(全セルをダブルクォートで囲み、内部の " は "" へ)に加え、
  // CSV(formula)injection 対策: = + - @ タブ CR で始まる値は Excel/Sheets が数式として
  // 実行しうるため、先頭にシングルクォートを付けて文字列扱いに固定する。
  // コメント本文・投稿者名はゲスト(共有リンクのみで投稿可)由来の未信頼入力なので必須。
  function csvCell(value) {
    let s = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  const HEADER = ["ピンNo", "ページURL", "対象", "モーダル名", "本文", "種別", "投稿者", "ステータス", "解決者", "投稿日時", "コメントID", "親コメントID"];

  // status コード → 日本語表示
  function statusLabel(status) {
    return status === "resolved" ? "解決済み" : "未解決";
  }

  // API返却のコメント配列(created_at ASC)を出力順の行データへ並べ替える。
  // ページ(初出順) → ルート(作成順) → その返信(作成順)。ピン番号はページ内のルート連番で、
  // オーバーレイのピン表示(作成順 = ページ内連番)と一致する。返信はルートと同じ番号。
  // 親が見つからない返信(通常は起きない)は取りこぼさず末尾に番号なしで出す。
  function orderRows(comments) {
    const repliesByParent = new Map();
    for (const c of comments) {
      if (!c.parent_id) continue;
      if (!repliesByParent.has(c.parent_id)) repliesByParent.set(c.parent_id, []);
      repliesByParent.get(c.parent_id).push(c);
    }
    const pages = new Map(); // page → ルート配列(作成順)
    for (const c of comments) {
      if (c.parent_id) continue;
      if (!pages.has(c.page)) pages.set(c.page, []);
      pages.get(c.page).push(c);
    }
    const rows = [];
    for (const roots of pages.values()) {
      roots.forEach((root, i) => {
        rows.push({ c: root, pinNo: i + 1, reply: false });
        for (const rep of repliesByParent.get(root.id) || []) rows.push({ c: rep, pinNo: i + 1, reply: true });
        repliesByParent.delete(root.id);
      });
    }
    for (const orphans of repliesByParent.values()) {
      for (const rep of orphans) rows.push({ c: rep, pinNo: null, reply: true });
    }
    return rows;
  }

  // コメント一覧 → CSV文字列。先頭に BOM(日本語環境の Excel が UTF-8 を正しく開くため)、
  // 行区切りは CRLF(RFC 4180)。セル内の改行はクォート内に収まる。
  function buildCommentsCsv(comments) {
    const lines = [HEADER.map(csvCell).join(",")];
    for (const { c, pinNo, reply } of orderRows(comments || [])) {
      lines.push(
        [
          pinNo ?? "",
          c.page,
          reply ? "" : c.ctx_label || "",
          reply ? "" : c.ctx_modal_label || "",
          c.body,
          reply ? "返信" : "コメント",
          c.author,
          reply ? "—" : statusLabel(c.status),
          reply ? "" : c.resolved_by || "",
          fmtDateTime(c.created_at),
          c.id,
          c.parent_id || "",
        ]
          .map(csvCell)
          .join(",")
      );
    }
    return "\uFEFF" + lines.join("\r\n") + "\r\n";
  }

  // ダウンロードファイル名: "fusen_<タイトル>_<YYYYMMDD>.csv"。
  // タイトルはファイル名に使えない文字と空白を _ に潰し、50字で打ち切る(空なら "canvas")。
  function buildCsvFilename(title, date) {
    const d = date instanceof Date && !isNaN(date.getTime()) ? date : null;
    const p = (n) => String(n).padStart(2, "0");
    const ymd = d ? `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` : "";
    const safe = String(title ?? "")
      .replace(/[\\/:*?"<>|\s]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50);
    return `fusen_${safe || "canvas"}${ymd ? "_" + ymd : ""}.csv`;
  }

  g.FsnCsvFormat = { fmtDateTime, csvCell, statusLabel, orderRows, buildCommentsCsv, buildCsvFilename };
})(typeof globalThis !== "undefined" ? globalThis : this);
