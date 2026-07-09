// ================================================
// Fusen! オーバーレイ — プロキシ配信されたページに注入される注釈UI本体
// ピンは「毎フレームDOM要素を再特定して現在位置に追従」する方式。
// sticky/fixed要素や読み込みで動くレイアウトでもずれない。
// ================================================
(() => {
  if (window.__FUSEN_LOADED__) return;
  window.__FUSEN_LOADED__ = true;

  const CFG = window.__FUSEN__;
  if (!CFG) return;
  const API = CFG.apiBase;

  // 自身の script タグの nonce を引き継ぐ。対象サイトが strict-dynamic な CSP でも、
  // 信頼済みスクリプトが動的に追加した <script>(html2canvas 等)が実行を許可される。
  const NONCE = (document.currentScript && document.currentScript.nonce) || "";

  // アイコン(外部ファイルに依存せず内蔵 — 読み込み順・キャッシュの影響を受けない)
  const ICON_PATHS = {
    pin: '<path d="M12 21c-3.8-3.4-6-6.7-6-9.9A6 6 0 0 1 18 11.1c0 3.2-2.2 6.5-6 9.9z"/><circle cx="12" cy="11" r="2.3"/>',
    bubble: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3.5l2-3.2A8.5 8.5 0 1 1 21 11.5z"/>',
    eye: '<path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z"/><circle cx="12" cy="12" r="3"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7.1-7.1L11.7 5.1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4h13l-2.5 4L18 12H5"/>',
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 13l4 4L19 7"/>',
    undo: '<path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.6-7.4L3 8.6"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    alert: '<path d="M12 3L1.8 20.2h20.4z"/><path d="M12 10v4"/><path d="M12 17.2v.6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.5"/>',
    eyeOff: '<path d="M1.5 12S5.5 5 12 5c1.7 0 3.2.4 4.6 1.1"/><path d="M22.5 12s-1.7 2.9-4.7 4.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  };
  const I = (name, size = 16, sw = 2.4) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;flex:none;display:inline-block">${ICON_PATHS[name] || ""}</svg>`;

  // ---------- ユーティリティ ----------
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const normalize = (u) => {
    try {
      const x = new URL(u);
      x.hash = "";
      return x.href;
    } catch {
      return u;
    }
  };
  const PAGE = normalize(CFG.page);

  const el = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };

  const timeAgo = (iso) => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "たった今";
    if (s < 3600) return `${Math.floor(s / 60)}分前`;
    if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
    return `${Math.floor(s / 86400)}日前`;
  };

  async function apiCall(path, opt = {}) {
    const r = await fetch(API + path, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      ...opt,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "通信エラー");
    return d;
  }

  // ---------- 状態 ----------
  let mode = "browse"; // browse | comment
  let comments = [];
  let filter = "open";
  let search = "";
  let currentPageOnly = false; // サイドバー: 既定は全ページ集約(他ページのコメントに気づきやすくするため)
  let popEl = null;
  let popTrack = null; // 開いているポップオーバーの追従関数 () => {x,y,el}
  let tempPinEl = null;
  let tempAnchor = null;
  // 新規コメントの撮影対象要素。anchor に DOM 要素を入れると POST 時の
  // JSON.stringify が循環参照で落ちるため、モジュール変数で別渡しする。
  let tempTargetEl = null;
  let hoverHl = null; // コメントモードのホバー対象
  const pinEls = new Map(); // comment.id -> pin要素
  const sbItemEls = new Map(); // comment.id -> サイドバー項目要素(現在ページのみ)。非表示バッジを反応的に更新するため
  let openThreadId = null; // 現在開いているスレッドのコメントID(ポーリング更新時の判定に使う)
  let lastSig = ""; // 直近に反映したコメント状態の署名(差分検知用)

  const roots = () =>
    comments
      .filter((c) => !c.parent_id && normalize(c.page) === PAGE)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const repliesOf = (id) =>
    comments.filter((c) => c.parent_id === id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  // 全ページのルートコメント(サイドバーのページ別グループ表示用)
  const rootsAllPages = () =>
    comments.filter((c) => !c.parent_id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  // ページURL → サイドバー見出し用の短いラベル
  const pageLabel = (u) => {
    try {
      const x = new URL(u);
      const p = (x.pathname || "/") + (x.search || "");
      return p === "/" ? "トップページ" : p;
    } catch {
      return u;
    }
  };

  // コメント集合の署名。id・状態・親の変化(=追加/解決/削除/返信)を検知する
  const sigOf = (list) =>
    list
      .map((c) => `${c.id}:${c.status}:${c.parent_id || ""}`)
      .sort()
      .join("|");
  const markSynced = () => {
    lastSig = sigOf(comments);
  };

  // ---------- ルートUI構築 ----------
  const root = el(`<div id="fsn-root" data-fsn></div>`);
  const pinsLayer = el(`<div id="fsn-pins" data-fsn></div>`);
  const hlBox = el(`<div id="fsn-hl" data-fsn></div>`);
  const catcher = el(`<div id="fsn-catcher" data-fsn></div>`);
  const hint = el(`<div class="fsn-hint" data-fsn>${I("pin", 14)} コメントしたい場所をクリック!(「見る」に戻すと操作できます)</div>`);
  const toastEl = el(`<div class="fsn-toast" data-fsn></div>`);

  const toolbar = el(`
    <div class="fsn-toolbar" data-fsn>
      <span class="fsn-tb-logo" title="Fusen!"></span>
      <button class="fsn-tb-btn" id="fsn-tb-comments">${I("bubble", 15)} <span>コメント</span> <span class="fsn-tb-count" id="fsn-count">0</span></button>
      <span class="fsn-tb-sep"></span>
      <span class="fsn-mode">
        <button id="fsn-mode-browse" class="fsn-on">${I("eye", 15)} 見る</button>
        <button id="fsn-mode-comment">${I("pin", 15)} コメント</button>
      </span>
      <span class="fsn-tb-sep"></span>
      <button class="fsn-tb-btn" id="fsn-tb-share">${I("link", 15)} 共有</button>
      <button class="fsn-tb-btn fsn-cta" id="fsn-tb-review">${I("flag", 15)} レビュー完了</button>
      <button class="fsn-tb-btn" id="fsn-tb-home" title="ダッシュボードへ">${I("home", 16)}</button>
      <span class="fsn-avatar" title="${esc(CFG.user.name)}">${esc(CFG.user.name.slice(0, 1))}</span>
    </div>`);

  const sidebar = el(`
    <div class="fsn-sidebar" data-fsn>
      <div class="fsn-sb-head">
        <h2>コメント <button class="fsn-btn fsn-plain" id="fsn-sb-close">${I("x", 14)}</button></h2>
        <input id="fsn-sb-search" type="text" placeholder="コメントを検索…">
        <div class="fsn-chips">
          <button class="fsn-chip" data-f="all">すべて</button>
          <button class="fsn-chip fsn-on" data-f="open">未解決</button>
          <button class="fsn-chip" data-f="resolved">解決済み</button>
        </div>
        <label class="fsn-sb-toggle"><input type="checkbox" id="fsn-sb-thispage"> このページのコメントだけ表示</label>
      </div>
      <div class="fsn-sb-list" id="fsn-sb-list"></div>
    </div>`);

  function mount() {
    document.body.appendChild(root);
    root.appendChild(hlBox);
    root.appendChild(pinsLayer);
    root.appendChild(catcher);
    root.appendChild(hint);
    root.appendChild(toolbar);
    root.appendChild(sidebar);
    root.appendChild(toastEl);
  }

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("fsn-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("fsn-show"), 2600);
  }

  // ---------- セレクタ生成(近くの安定な手がかりを基点に安定化) ----------
  // 位置ベース(nth-of-type)だけだと、モーダルの開閉やDOM再描画で兄弟の並びが変わった瞬間に
  // 別要素へ誤マッチする。そこで一意なid・テスト用ID・アクセシビリティ属性があればそれを基点に
  // 使い、再描画をまたいでも同じ要素を指せるようにする(再アンカー率を上げる)。
  function cssPath(elm) {
    const uniqueSel = (node) => {
      if (!node.getAttribute) return null;
      const tryUnique = (sel) => {
        try { return document.querySelectorAll(sel).length === 1 ? sel : null; } catch { return null; }
      };
      if (node.id) { const s = tryUnique(`#${CSS.escape(node.id)}`); if (s) return s; }
      const tag = node.tagName.toLowerCase();
      for (const attr of ["data-testid", "data-test", "data-cy", "data-qa", "name", "aria-label"]) {
        const val = node.getAttribute(attr);
        if (val) {
          const esc = String(val).replace(/["\\]/g, "\\$&");
          const s = tryUnique(`${tag}[${attr}="${esc}"]`);
          if (s) return s;
        }
      }
      return null;
    };
    const parts = [];
    let cur = elm;
    let base = "body";
    while (cur && cur !== document.body && cur.nodeType === 1 && parts.length < 12) {
      const idSel = uniqueSel(cur);
      if (idSel) {
        base = idSel;
        break;
      }
      const tag = cur.tagName.toLowerCase();
      let nth = 1;
      let sib = cur;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === cur.tagName) nth++;
      parts.unshift(`${tag}:nth-of-type(${nth})`);
      cur = cur.parentElement;
    }
    return parts.length ? `${base} > ${parts.join(" > ")}` : base;
  }

  // ---------- モーダルルート判定 ----------
  // 対象要素を包むモーダル(ダイアログ・ドロワー等)のルート要素を返す。無ければ null。
  // contextOf(コンテキスト保存)と captureShotFor(撮影領域の決定)で共用する。
  function modalRootOf(target) {
    try {
      if (!target || target.nodeType !== 1) return null;
      const attr = (node, name) => (node.getAttribute ? node.getAttribute(name) : null);
      // 第一候補: セマンティクス
      let modalRoot = target.closest ? target.closest('dialog, [role="dialog"], [aria-modal="true"]') : null;
      // 第二候補: 保守的ヒューリスティック
      // position:fixed かつ z-index>=10 かつ class/id が modal|dialog|popup|drawer|sheet にマッチする祖先
      if (!modalRoot) {
        let cur = target;
        while (cur && cur !== document.body && cur.nodeType === 1) {
          if (cur.hasAttribute && cur.hasAttribute("data-fsn")) break; // Fusen自身のUIは対象外
          const hint = `${attr(cur, "class") || ""} ${cur.id || ""}`;
          if (/modal|dialog|popup|drawer|sheet/i.test(hint)) {
            try {
              const st = getComputedStyle(cur);
              const z = parseInt(st.zIndex, 10);
              if (st.position === "fixed" && !isNaN(z) && z >= 10) {
                modalRoot = cur;
                break;
              }
            } catch {}
          }
          cur = cur.parentElement;
        }
      }
      if (modalRoot && modalRoot.closest && modalRoot.closest("[data-fsn]")) modalRoot = null;
      return modalRoot;
    } catch {
      return null;
    }
  }

  // ---------- 作成時コンテキスト取得(対象ラベル + モーダル内か) ----------
  // モーダルが閉じてアンカーが迷子になっても「何へのコメントだったか」を表示できるよう、
  // クリック時点の対象要素から人間可読な手がかりを取っておく。
  function contextOf(target) {
    try {
      if (!target || target.nodeType !== 1) return { ctx_label: null, ctx_modal: false, ctx_modal_label: null };
      // 空白を畳んで先頭 max 文字。巨大な textContent でも重くならないよう先に粗く切る
      const norm = (s, max) => String(s ?? "").slice(0, 2000).replace(/\s+/g, " ").trim().slice(0, max);
      const attr = (node, name) => (node.getAttribute ? node.getAttribute(name) : null);

      // 対象ラベル: aria-label → img の alt → title → textContent(先頭60字) → タグ名
      let label =
        norm(attr(target, "aria-label"), 120) ||
        (target.tagName === "IMG" ? norm(attr(target, "alt"), 120) : "") ||
        norm(attr(target, "title"), 120) ||
        norm(target.textContent, 60) ||
        (target.tagName ? target.tagName.toLowerCase() : "");

      // モーダル判定(セマンティクス + 保守的ヒューリスティック)
      const modalRoot = modalRootOf(target);

      // モーダルのラベル: aria-label → aria-labelledby の解決テキスト → 最初の見出し
      let modalLabel = null;
      if (modalRoot) {
        modalLabel = norm(attr(modalRoot, "aria-label"), 120);
        if (!modalLabel) {
          const ids = String(attr(modalRoot, "aria-labelledby") || "").trim();
          if (ids) {
            const txt = ids
              .split(/\s+/)
              .map((i) => {
                const n = document.getElementById(i);
                return n ? n.textContent : "";
              })
              .join(" ");
            modalLabel = norm(txt, 120);
          }
        }
        if (!modalLabel) {
          const h = modalRoot.querySelector("h1,h2,h3,h4,h5,h6,[role=heading]");
          if (h) modalLabel = norm(h.textContent, 120);
        }
        modalLabel = modalLabel || null;
      }

      return { ctx_label: label || null, ctx_modal: !!modalRoot, ctx_modal_label: modalLabel };
    } catch {
      return { ctx_label: null, ctx_modal: false, ctx_modal_label: null };
    }
  }

  // ---------- 遅延バックフィル(既存コメントのコンテキスト後付け) ----------
  // ctx 未取得(ctx_modal == null)の既存ルートコメントは、selector が解決できた
  // 最初のタイミングでコンテキストを取得してサーバーへ追記する。
  // updatePositions は rAF で高頻度に走るため、コメントIDごとに1回だけ送る。
  // 失敗しても静かに諦める(ユーザー操作起点ではないので toast は出さない)。
  const ctxBackfillTried = new Set();
  function maybeBackfillCtx(c, elm) {
    try {
      if (!elm || !c || c.parent_id || !c.selector) return;
      if (c.ctx_modal != null) return; // 取得済み(true/false)は対象外
      if (ctxBackfillTried.has(c.id)) return;
      ctxBackfillTried.add(c.id);
      const ctx = contextOf(elm);
      apiCall(`/api/comments/${c.id}`, { method: "PATCH", body: JSON.stringify(ctx) })
        .then((d) => {
          const cur = comments.find((x) => x.id === c.id);
          if (cur && d && d.comment) Object.assign(cur, d.comment);
        })
        .catch(() => {}); // リトライ嵐を防ぐため Set に入れたままにする
    } catch {}
  }

  // ---------- アンカー解決(ビューポート座標で返す) ----------
  // orphaned: 対象要素が今DOMに無い/見つからない状態(モーダルを閉じた等)。座標フォールバックで
  // 無理に表示すると無関係な場所に浮くため、呼び出し側でキャンバス上のピンを隠す。
  function resolveViewport(a) {
    if (a.selector) {
      try {
        const elm = document.querySelector(a.selector);
        if (elm) {
          const r = elm.getBoundingClientRect();
          if (r.width > 0 || r.height > 0) {
            return { x: r.left + r.width * a.rx, y: r.top + r.height * a.ry, el: elm, orphaned: false };
          }
        }
      } catch {}
    }
    // 対象要素が今DOMに無い/非表示(モーダルを閉じた・別ページ・再描画で消えた等)。
    // ここで保存時のページ絶対座標(ax/ay)に落として無理に表示すると、モーダルが在った位置の
    // 無関係なコンテンツ上にピンが浮き、レビュアーを誤解させる。よって orphaned として返し、
    // 呼び出し側はキャンバス上のピンを隠す(サイドバーには「非表示」と明示して見失わせない)。
    // 座標はポップオーバー配置用の参考値として残す(placePop がビューポート内にクランプする)。
    return { x: a.ax - scrollX, y: a.ay - scrollY, el: null, orphaned: true };
  }

  // ---------- ハイライト ----------
  function setHighlight(elm) {
    if (!elm || !elm.isConnected) {
      hlBox.style.display = "none";
      return;
    }
    const r = elm.getBoundingClientRect();
    hlBox.style.display = "block";
    hlBox.style.left = r.left - 4 + "px";
    hlBox.style.top = r.top - 4 + "px";
    hlBox.style.width = r.width + 8 + "px";
    hlBox.style.height = r.height + 8 + "px";
  }

  // ---------- 位置更新ループ(スクロール・レイアウト変化に追従) ----------
  let rafQueued = false;
  function updatePositions() {
    rafQueued = false;
    for (const [id, pin] of pinEls) {
      const c = comments.find((x) => x.id === id);
      if (!c) continue;
      const p = resolveViewport(c);
      // サイドバー項目の「今は非表示」表示をピンと同じ判定で反応的に同期する
      // (モーダル開閉はコメントデータを変えないので、ここで毎フレーム追従させる)。
      const sbItem = sbItemEls.get(id);
      if (sbItem) sbItem.classList.toggle("fsn-is-hidden", p.orphaned);
      // 対象要素が見つからないピンはキャンバスに出さない(座標フォールバックで浮かせない)。
      if (p.orphaned) { pin.style.display = "none"; continue; }
      pin.style.display = "";
      pin.style.left = p.x + "px";
      pin.style.top = p.y + "px";
      if (p.el) maybeBackfillCtx(c, p.el); // ctx未取得の既存コメントを解決できた瞬間に補完
    }
    if (tempPinEl && tempAnchor) {
      const p = resolveViewport(tempAnchor);
      tempPinEl.style.left = p.x + "px";
      tempPinEl.style.top = p.y + "px";
    }
    if (popEl && popTrack) {
      const p = popTrack();
      placePop(popEl, p.x, p.y);
      setHighlight(p.el);
    } else if (hoverHl) {
      setHighlight(hoverHl);
    } else {
      setHighlight(null);
    }
  }
  function queueUpdate() {
    if (rafQueued) return;
    rafQueued = true;
    requestAnimationFrame(updatePositions);
  }

  // スクロール(入れ子のスクロールコンテナ含む)・リサイズ・DOM変化で追従
  addEventListener("scroll", queueUpdate, { capture: true, passive: true });
  addEventListener("resize", queueUpdate);
  const mo = new MutationObserver((muts) => {
    if (muts.every((m) => m.target && m.target.closest && m.target.closest("[data-fsn]"))) return;
    queueUpdate();
    if (mode === "comment") sizeCatcher();
  });

  // ---------- ピン描画(データ変化時のみ再生成) ----------
  function renderPins() {
    pinsLayer.innerHTML = "";
    pinEls.clear();
    roots().forEach((c, i) => {
      const pin = el(
        `<div class="fsn-pin ${c.status === "resolved" ? "fsn-resolved" : ""}"><span>${i + 1}</span></div>`
      );
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        openThread(c.id);
      });
      pin.addEventListener("mouseenter", () => {
        if (!popEl) {
          hoverHl = resolveViewport(c).el;
          queueUpdate();
        }
      });
      pin.addEventListener("mouseleave", () => {
        hoverHl = null;
        queueUpdate();
      });
      pinsLayer.appendChild(pin);
      pinEls.set(c.id, pin);
    });
    const openCount = roots().filter((c) => c.status !== "resolved").length;
    const cnt = toolbar.querySelector("#fsn-count");
    if (cnt) cnt.textContent = String(openCount);
    renderSidebar();
    updatePositions();
  }

  // ---------- ポップオーバー ----------
  function closePop() {
    if (popEl) popEl.remove();
    popEl = null;
    popTrack = null;
    if (tempPinEl) tempPinEl.remove();
    tempPinEl = null;
    tempAnchor = null;
    tempTargetEl = null;
    openThreadId = null;
    setHighlight(null);
  }

  // スレッド表示の共通部品(通常スレッドと別ページスレッドで共用)
  const msgHtml = (m, reply) => `
    <div class="fsn-msg ${reply ? "fsn-reply" : ""}">
      <div class="fsn-who">${esc(m.author)} ${m.guest ? '<span class="fsn-guest-tag">ゲスト</span>' : ""} <span class="fsn-when">${timeAgo(m.created_at)}</span></div>
      <div class="fsn-text">${esc(m.body)}</div>
    </div>`;
  // 対象情報行(何にコメントしたか)。ctx はサーバー由来のため必ず esc() を通す
  function ctxLineOf(c) {
    if (c.ctx_modal === true) {
      return `ダイアログ${c.ctx_modal_label ? `「${esc(c.ctx_modal_label)}」` : ""}内${c.ctx_label ? ` · 対象: ${esc(c.ctx_label)}` : ""}`;
    }
    if (c.ctx_label) return `対象: ${esc(c.ctx_label)}`;
    return "";
  }

  // コメント削除(スレッドポップオーバー・別ページスレッド・サイドバーで共用)。
  // 破壊操作はサーバー側でも投稿者本人のみに制限(#3 IDOR)。成否を返す。
  async function deleteComment(id) {
    if (!confirm("このコメントを削除しますか?(返信も消えます)")) return false;
    try {
      await apiCall(`/api/comments/${id}`, { method: "DELETE" });
      comments = comments.filter((x) => x.id !== id && x.parent_id !== id);
      markSynced();
      if (openThreadId === id) closePop(); // 開いていたスレッドが消えたら閉じる
      renderPins(); // renderSidebar() も走るのでサイドバーからの削除でも一覧が更新される
      toast("削除しました");
      return true;
    } catch (e) {
      toast(e.message);
      return false;
    }
  }

  function placePop(pop, x, y) {
    const W = 320;
    let left = x + 22;
    if (left + W > innerWidth - 12) left = x - W - 22;
    if (left < 8) left = 8;
    const h = pop.offsetHeight || 200;
    let top = y - 30;
    if (top + h > innerHeight - 12) top = innerHeight - h - 12;
    if (top < 8) top = 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  // 新規コメント入力
  function openNewComment(anchor, targetEl) {
    closePop();
    tempAnchor = anchor;
    tempTargetEl = targetEl || null; // スクショ撮影用。closePop() が null に戻すため必ずこの位置で設定する
    tempPinEl = el(`<div class="fsn-pin fsn-temp"><span>${I("plus", 14, 3)}</span></div>`);
    pinsLayer.appendChild(tempPinEl);

    popEl = el(`
      <div class="fsn-pop" data-fsn>
        <div class="fsn-pop-head">${I("pin", 14)} 新しいコメント <button class="fsn-x">${I("x", 14)}</button></div>
        <div class="fsn-pop-foot" style="border-top:none">
          <textarea placeholder="ここにコメントを書く…(例: この見出し、もう少し大きく!)"></textarea>
          <div class="fsn-pop-actions">
            <button class="fsn-btn" data-act="cancel">キャンセル</button>
            <button class="fsn-btn fsn-primary" data-act="save">ペタッと貼る</button>
          </div>
        </div>
      </div>`);
    root.appendChild(popEl);
    popTrack = () => resolveViewport(anchor);
    updatePositions();
    const ta = popEl.querySelector("textarea");
    ta.focus();

    popEl.querySelector(".fsn-x").addEventListener("click", closePop);
    popEl.querySelector('[data-act="cancel"]').addEventListener("click", closePop);
    popEl.querySelector('[data-act="save"]').addEventListener("click", async () => {
      const body = ta.value.trim();
      if (!body) return toast("コメントを入力してください");
      const shotTarget = tempTargetEl; // closePop() で消える前に確保
      try {
        const d = await apiCall(`/api/canvases/${CFG.canvasId}/comments`, {
          method: "POST",
          body: JSON.stringify({ ...anchor, body, page: PAGE }),
        });
        comments.push(d.comment);
        markSynced();
        closePop();
        renderPins();
        toast("ペタッ!コメントを貼りました");
        // 作成時スクリーンショット: fire-and-forget(UIをブロックしない。失敗しても静かに諦める)
        if (d.comment && d.comment.id) captureShotFor(d.comment.id, shotTarget);
      } catch (e) {
        toast(e.message);
      }
    });
  }

  // スレッド表示
  function openThread(id) {
    closePop();
    const c = comments.find((x) => x.id === id);
    if (!c) return;
    openThreadId = id;
    const idx = roots().findIndex((x) => x.id === id) + 1;
    const reps = repliesOf(id);
    const mine = c.author === CFG.user.name;
    const hidden = resolveViewport(c).orphaned; // 対象要素が今表示されていない(動的UIが閉じている等)

    const ctxLine = ctxLineOf(c);
    // 作成時スクリーンショット(同一オリジン・Cookie認証。表示できない環境では onerror でブロックごと消す)
    const shotUrl = c.has_shot === true ? `${API}/api/comments/${encodeURIComponent(c.id)}/screenshot` : null;

    popEl = el(`
      <div class="fsn-pop" data-fsn>
        <div class="fsn-pop-head">${I("bubble", 14)} コメント #${idx} ${c.status === "resolved" ? "(解決済み)" : ""}${hidden ? ` <span class="fsn-pop-hidden">${I("eyeOff", 12)} 対象は非表示</span>` : ""} <button class="fsn-x">${I("x", 14)}</button></div>
        ${ctxLine ? `<div class="fsn-ctx">${I("pin", 12, 2.6)} <span>${ctxLine}</span></div>` : ""}
        ${shotUrl ? `<div class="fsn-shot" title="クリックで原寸表示"><img src="${esc(shotUrl)}" alt="作成時のスクリーンショット" loading="lazy"><div class="fsn-shot-cap">作成時のスクリーンショット</div></div>` : ""}
        <div class="fsn-pop-body">
          ${msgHtml(c, false)}
          ${reps.map((r) => msgHtml(r, true)).join("")}
        </div>
        <div class="fsn-pop-foot">
          <textarea placeholder="返信を書く…"></textarea>
          <div class="fsn-pop-actions">
            ${mine ? '<button class="fsn-btn fsn-plain fsn-danger" data-act="del">削除</button>' : ""}
            <button class="fsn-btn fsn-plain" data-act="issue" title="このスレッドをGitHub Issue用テキストにする">${I("flag", 13)} Issue化</button>
            <button class="fsn-btn ${c.status === "resolved" ? "" : "fsn-teal"}" data-act="resolve">${c.status === "resolved" ? I("undo", 13) + " 再オープン" : I("check", 13) + " 解決にする"}</button>
            <button class="fsn-btn fsn-primary" data-act="reply">返信</button>
          </div>
        </div>
      </div>`);
    root.appendChild(popEl);
    popTrack = () => resolveViewport(c);
    updatePositions();

    popEl.querySelector(".fsn-x").addEventListener("click", closePop);
    // スクリーンショット: クリックで原寸を新規タブ表示。読み込めない環境では崩れないようブロックごと非表示
    const shotBlock = popEl.querySelector(".fsn-shot");
    if (shotBlock && shotUrl) {
      shotBlock.querySelector("img").addEventListener("error", () => {
        shotBlock.style.display = "none";
      });
      shotBlock.addEventListener("click", () => window.open(shotUrl, "_blank"));
    }
    popEl.querySelector('[data-act="reply"]').addEventListener("click", async () => {
      const ta = popEl.querySelector("textarea");
      const body = ta.value.trim();
      if (!body) return toast("返信を入力してください");
      try {
        const d = await apiCall(`/api/canvases/${CFG.canvasId}/comments`, {
          method: "POST",
          body: JSON.stringify({ body, page: PAGE, parent_id: id }),
        });
        comments.push(d.comment);
        markSynced();
        openThread(id);
        renderPins();
      } catch (e) {
        toast(e.message);
      }
    });
    popEl.querySelector('[data-act="resolve"]').addEventListener("click", async () => {
      try {
        const next = c.status === "resolved" ? "active" : "resolved";
        const d = await apiCall(`/api/comments/${id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
        Object.assign(c, d.comment);
        markSynced();
        renderPins();
        openThread(id);
        if (next === "resolved") toast("解決済みにしました");
      } catch (e) {
        toast(e.message);
      }
    });
    popEl.querySelector('[data-act="issue"]').addEventListener("click", () => openIssuePanel(id));
    const delBtn = popEl.querySelector('[data-act="del"]');
    if (delBtn) delBtn.addEventListener("click", () => deleteComment(id));
  }

  // 別ページのコメントを「遷移せずに」読み取り専用で表示する。
  // 以前はサイドバーから別ページのコメントを開くと location.href でそのページへ強制遷移していたが、
  // 削除済みページ(プロキシ先が404/リダイレクトを返す)ではその取得が繰り返されてループになる。
  // 閲覧・解決・削除はここで完結させ、生きたページで文脈確認したい場合だけ「このページを開く」で遷移する。
  function openThreadOther(c) {
    closePop();
    const reps = repliesOf(c.id);
    const mine = c.author === CFG.user.name;
    const ctxLine = ctxLineOf(c);
    const shotUrl = c.has_shot === true ? `${API}/api/comments/${encodeURIComponent(c.id)}/screenshot` : null;

    const bg = el(`
      <div class="fsn-modal-bg" data-fsn>
        <div class="fsn-modal fsn-thread-modal">
          <h2>${I("bubble", 18)} 別ページのコメント${c.status === "resolved" ? "(解決済み)" : ""}</h2>
          <div class="fsn-other-page" title="${esc(c.page)}">${I("home", 12)} <span>${esc(pageLabel(c.page))}</span></div>
          ${ctxLine ? `<div class="fsn-ctx">${I("pin", 12, 2.6)} <span>${ctxLine}</span></div>` : ""}
          ${shotUrl ? `<div class="fsn-shot" title="クリックで原寸表示"><img src="${esc(shotUrl)}" alt="作成時のスクリーンショット" loading="lazy"><div class="fsn-shot-cap">作成時のスクリーンショット</div></div>` : ""}
          <div class="fsn-pop-body">
            ${msgHtml(c, false)}
            ${reps.map((r) => msgHtml(r, true)).join("")}
          </div>
          <div class="fsn-pop-actions" style="margin-top:14px">
            ${mine ? '<button class="fsn-btn fsn-plain fsn-danger" data-act="del">削除</button>' : ""}
            <button class="fsn-btn ${c.status === "resolved" ? "" : "fsn-teal"}" data-act="resolve">${c.status === "resolved" ? I("undo", 13) + " 再オープン" : I("check", 13) + " 解決にする"}</button>
            <button class="fsn-btn" data-act="open">${I("home", 13)} このページを開く</button>
            <button class="fsn-btn fsn-primary" data-act="close">閉じる</button>
          </div>
        </div>
      </div>`);
    root.appendChild(bg);
    const close = () => bg.remove();
    bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
    bg.querySelector('[data-act="close"]').addEventListener("click", close);

    // スクリーンショット: クリックで原寸表示。読み込めない環境ではブロックごと非表示
    const shotBlock = bg.querySelector(".fsn-shot");
    if (shotBlock && shotUrl) {
      shotBlock.querySelector("img").addEventListener("error", () => { shotBlock.style.display = "none"; });
      shotBlock.addEventListener("click", () => window.open(shotUrl, "_blank"));
    }

    // このページを開く: 生きているページで文脈込みに見たい場合の明示的な遷移(既定の閲覧では遷移しない)
    bg.querySelector('[data-act="open"]').addEventListener("click", () => {
      try {
        const u = new URL(c.page);
        location.href = `${API}/p/${CFG.canvasId}${u.pathname}${u.search}#fsn=${encodeURIComponent(c.id)}`;
      } catch {
        toast("このコメントのページを開けませんでした");
      }
    });

    bg.querySelector('[data-act="resolve"]').addEventListener("click", async () => {
      try {
        const next = c.status === "resolved" ? "active" : "resolved";
        const d = await apiCall(`/api/comments/${c.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
        Object.assign(c, d.comment);
        markSynced();
        renderPins();
        close();
        openThreadOther(c); // 解決状態を反映して開き直す
        if (next === "resolved") toast("解決済みにしました");
      } catch (e) {
        toast(e.message);
      }
    });

    const delBtn = bg.querySelector('[data-act="del"]');
    if (delBtn) delBtn.addEventListener("click", async () => {
      if (await deleteComment(c.id)) close();
    });
  }

  // ---------- サイドバー(ページ別グループ表示) ----------
  function renderSidebar() {
    const list = sidebar.querySelector("#fsn-sb-list");
    sbItemEls.clear();
    let items = currentPageOnly ? roots() : rootsAllPages();
    if (filter === "open") items = items.filter((c) => c.status !== "resolved");
    if (filter === "resolved") items = items.filter((c) => c.status === "resolved");
    if (search) {
      const q = search.toLowerCase();
      items = items.filter((c) => c.body.toLowerCase().includes(q) || c.author.toLowerCase().includes(q));
    }
    if (!items.length) {
      list.innerHTML = `<div class="fsn-sb-empty">${currentPageOnly ? "このページには" : "まだ"}<br>該当するコメントがありません</div>`;
      return;
    }

    // 見出しの件数バッジ用: 絞り込みに関係なくページごとの真の「未解決/全体(解決済み込み)」を集計
    const pageTotals = new Map();
    for (const c of rootsAllPages()) {
      const k = normalize(c.page);
      const t = pageTotals.get(k) || { open: 0, total: 0 };
      t.total++;
      if (c.status !== "resolved") t.open++;
      pageTotals.set(k, t);
    }

    // ページごとにグループ化(現在のページを先頭、以降は最初のコメント時刻順)
    const groups = new Map();
    for (const c of items) {
      const key = normalize(c.page);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === PAGE) return -1;
      if (b === PAGE) return 1;
      return groups.get(a)[0].created_at.localeCompare(groups.get(b)[0].created_at);
    });

    const pageRoots = roots(); // 現在ページのピン番号に対応させる
    list.innerHTML = "";
    for (const key of keys) {
      const isCurrent = key === PAGE;
      const arr = groups.get(key);
      const tot = pageTotals.get(key) || { open: 0, total: arr.length };
      list.appendChild(
        el(`
        <div class="fsn-pg-head ${isCurrent ? "fsn-pg-current" : ""}">
          ${I("home", 12)} <span class="fsn-pg-name" title="${esc(arr[0].page)}">${esc(pageLabel(arr[0].page))}</span>
          ${isCurrent ? '<span class="fsn-pg-tag">今見てるページ</span>' : ""}
          <span class="fsn-pg-count" title="未解決 ${tot.open} / 全 ${tot.total}(解決済み含む)">${tot.open}/${tot.total}</span>
        </div>`)
      );
      arr.forEach((c) => {
        const reps = repliesOf(c.id).length;
        const num = isCurrent ? pageRoots.findIndex((x) => x.id === c.id) + 1 : 0;
        // 現在ページの項目は「今は非表示」タグを常に埋め込んでおき、fsn-is-hidden クラスの
        // 付け外し(updatePositions が反応的に行う)で表示/非表示を切り替える。動的UI(モーダル等)
        // 上のコメントは、対象が閉じている間だけこのタグが点灯して「動的UI上にある」と示す。
        const subBits = [];
        if (reps) subBits.push(`返信 ${reps}件`);
        if (!isCurrent) subBits.push("クリックで開く");
        const mine = c.author === CFG.user.name; // 削除は投稿者本人のみ(サーバー側でも #3 IDOR で制限)
        const item = el(`
          <div class="fsn-sb-item ${c.status === "resolved" ? "fsn-done" : ""} ${isCurrent ? "" : "fsn-other"}">
            <div class="fsn-row1">
              <span class="fsn-sb-num">${num ? num : I("pin", 11, 2.6)}</span>
              <strong style="font-size:12.5px">${esc(c.author)}</strong>
              ${isCurrent ? `<span class="fsn-hidden-tag" title="この要素は今表示されていません。モーダルやタブを開くと表示されます">${I("eyeOff", 11, 2.4)} 今は非表示</span>` : ""}
              <span class="fsn-sub">${timeAgo(c.created_at)}</span>
              ${mine ? `<button class="fsn-sb-del" title="このコメントを削除" aria-label="このコメントを削除">${I("trash", 13, 2.4)}</button>` : ""}
            </div>
            <div class="fsn-prev">${esc(c.body)}</div>
            ${c.ctx_modal === true ? `<div class="fsn-sb-ctx">ダイアログ内${c.ctx_modal_label ? ": " + esc(c.ctx_modal_label) : ""}</div>` : ""}
            <div class="fsn-sub">${subBits.join("  ·  ")}</div>
          </div>`);
        item.addEventListener("click", () => openFromSidebar(c));
        const sbDel = item.querySelector(".fsn-sb-del");
        if (sbDel) sbDel.addEventListener("click", (e) => { e.stopPropagation(); deleteComment(c.id); });
        if (isCurrent) sbItemEls.set(c.id, item);
        list.appendChild(item);
      });
    }
    // 非表示インジケータの初期反映(フィルタ/検索など単独再描画からも即時に効かせる)
    queueUpdate();
  }

  // サイドバー項目クリック: 同じページなら開く、別ページならそのページへ移動して開く
  function openFromSidebar(c) {
    if (normalize(c.page) === PAGE) {
      const p = resolveViewport(c);
      // 対象が今表示されていない(モーダルを閉じている等): 何もない場所へスクロールさせず、
      // 「どこにあるか」を明示してスレッドだけ開く(読む/返信/Issue化は可能)。
      if (p.orphaned) {
        toast("この要素は今表示されていません。モーダルやタブを開くと表示されます");
        openThread(c.id);
        return;
      }
      window.scrollTo({ top: Math.max(0, scrollY + p.y - innerHeight / 3), behavior: "smooth" });
      setTimeout(() => openThread(c.id), 400);
    } else {
      // 別ページ: 遷移せず読み取り専用スレッドで開く(削除済みページでの取得ループを避ける)。
      openThreadOther(c);
    }
  }

  // ---------- Issue化(コメントスレッド → GitHub Issue用テキスト) ----------
  // 依存(html2canvas / issue-format)は使う瞬間に遅延ロード。全プロキシページを重くしない。
  function loadScriptOnce(src, globalKey, cache) {
    if (window[globalKey]) return Promise.resolve(window[globalKey]);
    if (cache.p) return cache.p;
    cache.p = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src;
      // nonce は IDL プロパティのみで渡す。content 属性に書くと、同一オリジンで動く未信頼な
      // プロキシ対象JSが CSS 属性セレクタで nonce を抜ける余地を残すため付けない(nonce hiding)。
      if (NONCE) s.nonce = NONCE;
      s.onload = () => (window[globalKey] ? res(window[globalKey]) : rej(new Error("no global")));
      s.onerror = () => { cache.p = null; rej(new Error("load failed")); };
      (document.head || document.documentElement).appendChild(s);
    });
    return cache.p;
  }
  const _h2c = {}, _fmt = {};
  const loadHtml2Canvas = () => loadScriptOnce(`${API}/fsn-assets/html2canvas.min.js`, "html2canvas", _h2c);
  const loadIssueFormat = () => loadScriptOnce(`${API}/fsn-assets/issue-format.js`, "FsnIssueFormat", _fmt);

  // deep_link: 既存 openByHash() が拾える「現在のプロキシページURL + #fsn=<id>」を組み立てる。
  function deepLinkFor(c) {
    try {
      const u = new URL(c.page);
      return `${API}/p/${CFG.canvasId}${u.pathname}${u.search}#fsn=${encodeURIComponent(c.id)}`;
    } catch {
      return `${location.origin}${location.pathname}${location.search}#fsn=${encodeURIComponent(c.id)}`;
    }
  }

  // クリップボード/ダウンロード補助
  async function copyText(text) { await navigator.clipboard.writeText(text); }
  async function copyImage(blob) {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard || !navigator.clipboard.write)
      throw new Error("clipboard-image-unsupported");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // キャンバスがほぼ真っ白/透明か(スクショ失敗の簡易判定)。粗いグリッドサンプリング。
  function isBlankCanvas(canvas) {
    try {
      const ctx = canvas.getContext("2d");
      const step = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / 40));
      let total = 0, blank = 0;
      for (let y = 0; y < canvas.height; y += step) {
        for (let x = 0; x < canvas.width; x += step) {
          const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
          total++;
          if (a < 8 || (r > 248 && g > 248 && b > 248)) blank++;
        }
      }
      return total === 0 || blank / total > 0.995;
    } catch { return false; }
  }

  // 画面全体(現在のビューポート)をキャプチャして PNG Blob を返す。ピンは残す。撮れない/空なら null。
  async function captureThreadShot(c) {
    const h2c = await loadHtml2Canvas();
    // 対象のピンが画面内に写るよう、対象要素(なければピン座標)をビューポート中央へ寄せてから撮る
    const before = resolveViewport(c);
    if (before.el) before.el.scrollIntoView({ block: "center", inline: "center" });
    else window.scrollTo({ top: Math.max(0, c.ay - innerHeight / 2) });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    updatePositions();

    // Fusen自身のUI(data-fsn)は写さない。ただし #fsn-root と #fsn-pins は残してピンだけ写す。
    const ignoreElements = (elm) =>
      elm && elm.nodeType === 1 && elm.hasAttribute && elm.hasAttribute("data-fsn") &&
      elm.id !== "fsn-root" && elm.id !== "fsn-pins";

    // 画面全体 = 現在のビューポート矩形(スクロール位置基準)
    const canvas = await h2c(document.body, {
      backgroundColor: "#ffffff",
      scale: Math.min(2, window.devicePixelRatio || 1),
      useCORS: true,
      logging: false,
      x: scrollX,
      y: scrollY,
      width: innerWidth,
      height: innerHeight,
      windowWidth: document.documentElement.scrollWidth,
      windowHeight: document.documentElement.scrollHeight,
      ignoreElements,
    });
    if (isBlankCanvas(canvas)) return null;
    return await new Promise((res) => canvas.toBlob(res, "image/png"));
  }

  // ---------- 作成時スクリーンショット(方針C: モーダルが閉じても見た目が残る) ----------
  // コメント POST 成功直後に fire-and-forget で呼ばれる。撮れたら儲けもの:
  // ロード失敗・描画例外・サイズ超過・4xx/5xx はすべて toast を出さず静かに諦める
  // (コメント本体は既に成立している。サーバー未デプロイ環境でも壊れない)。
  async function captureShotFor(commentId, targetEl) {
    try {
      if (!commentId || !targetEl || targetEl.nodeType !== 1 || !targetEl.isConnected) return;
      const h2c = await loadHtml2Canvas();
      if (!targetEl.isConnected) return; // ロード待ちの間に消えたら諦める

      // 撮影領域(ページ絶対座標):
      // モーダル内クリックならモーダルルートの矩形、そうでなければ要素の矩形 + 周囲80px
      const modalRoot = modalRootOf(targetEl);
      const baseEl = modalRoot || targetEl;
      const r = baseEl.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return; // 非表示要素は撮っても意味がない
      const PAD = modalRoot ? 0 : 80;
      let x = r.left + scrollX - PAD;
      let y = r.top + scrollY - PAD;
      let w = r.width + PAD * 2;
      let h = r.height + PAD * 2;
      // 最小 320x200 を中心を保ったまま確保
      const MIN_W = 320, MIN_H = 200;
      if (w < MIN_W) { x -= (MIN_W - w) / 2; w = MIN_W; }
      if (h < MIN_H) { y -= (MIN_H - h) / 2; h = MIN_H; }
      // document の範囲にクランプ(先にサイズを縮めてから位置を寄せる。巨大モーダルでも負座標にならない)
      const docW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
      const docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      w = Math.min(w, docW);
      h = Math.min(h, docH);
      x = Math.round(Math.min(Math.max(0, x), docW - w));
      y = Math.round(Math.min(Math.max(0, y), docH - h));
      w = Math.round(w);
      h = Math.round(h);

      // Fusen自身のUI(data-fsn)は全て写さない(作成直後でピンはまだ無いので全除外でよい)
      const ignoreElements = (elm) =>
        elm && elm.nodeType === 1 && elm.hasAttribute && elm.hasAttribute("data-fsn");
      const canvas = await h2c(document.body, {
        backgroundColor: "#ffffff",
        scale: 1,
        useCORS: true,
        logging: false,
        x, y, width: w, height: h,
        windowWidth: document.documentElement.scrollWidth,
        windowHeight: document.documentElement.scrollHeight,
        ignoreElements,
      });
      if (!canvas || !canvas.width || !canvas.height || isBlankCanvas(canvas)) return;

      // JPEG化: 幅 maxW 超は白背景キャンバスで縮小してから toDataURL
      const encode = (maxW, quality) => {
        let src = canvas;
        if (canvas.width > maxW) {
          const c2 = document.createElement("canvas");
          c2.width = maxW;
          c2.height = Math.max(1, Math.round((canvas.height * maxW) / canvas.width));
          const ctx = c2.getContext("2d");
          ctx.fillStyle = "#ffffff"; // JPEGは透過不可のため白で埋める
          ctx.fillRect(0, 0, c2.width, c2.height);
          ctx.drawImage(canvas, 0, 0, c2.width, c2.height);
          src = c2;
        }
        return src.toDataURL("image/jpeg", quality);
      };
      // base64 部分 40万文字(≒300KB)がサーバー上限。超えたら 480px/品質0.6 で1回だけ再試行
      const LIMIT = 400000;
      const b64len = (u) => u.length - (u.indexOf(",") + 1);
      let dataUrl = encode(640, 0.75);
      if (b64len(dataUrl) > LIMIT) dataUrl = encode(480, 0.6);
      if (b64len(dataUrl) > LIMIT) return;

      await apiCall(`/api/comments/${encodeURIComponent(commentId)}/screenshot`, {
        method: "PUT",
        body: JSON.stringify({ data_url: dataUrl }),
      });
      // ローカル状態に反映(次回 openThread からサムネイルが出る)
      const cur = comments.find((c) => c.id === commentId);
      if (cur) cur.has_shot = true;
    } catch {} // 全て静かに諦める(対象ページのDOM/グローバルは触っていない)
  }

  async function openIssuePanel(id) {
    const c = comments.find((x) => x.id === id);
    if (!c) return;
    const idx = roots().findIndex((x) => x.id === id) + 1;
    const reps = repliesOf(id);

    let F;
    try { F = await loadIssueFormat(); }
    catch { return toast("Issue化機能の読み込みに失敗しました"); }

    const threadBlock = F.buildThreadBlock(c, reps);
    const title = F.buildIssueTitle({ canvasTitle: CFG.canvasTitle, pinNo: idx, rootBody: c.body });
    const body = F.buildIssueBody({
      canvasTitle: CFG.canvasTitle,
      pageUrl: c.page,
      selector: c.selector,
      pinNo: idx,
      status: c.status,
      deepLink: deepLinkFor(c),
      rootBody: c.body,
      threadBlock,
      generatedAt: new Date().toISOString(),
      // 作成時コンテキスト(あれば「対象: …」の行が入る)
      ctxLabel: c.ctx_label || "",
      ctxModal: c.ctx_modal === true,
      ctxModalLabel: c.ctx_modal_label || "",
    });

    closePop();
    const bg = el(`
      <div class="fsn-modal-bg" data-fsn>
        <div class="fsn-modal fsn-issue-modal">
          <h2>${I("flag", 18)} Issue にする</h2>
          <p class="fsn-issue-hint">Issueの新規作成画面で ①タイトルを貼付 → ②本文を貼付 → ③本文中の「スクリーンショット」欄で画像を貼付(Ctrl/Cmd+V)します。</p>
          <label class="fsn-issue-label">タイトル</label>
          <div class="fsn-issue-titlerow">
            <input class="fsn-issue-title-in" type="text" readonly value="${esc(title)}">
            <button class="fsn-btn" data-act="copytitle">コピー</button>
          </div>
          <label class="fsn-issue-label">本文(Markdown)</label>
          <textarea class="fsn-issue-body" readonly>${esc(body)}</textarea>
          <div class="fsn-issue-bodyrow">
            <button class="fsn-btn fsn-primary" data-act="copybody">本文をコピー</button>
          </div>
          <div class="fsn-pop-actions fsn-issue-shotrow" style="margin-top:14px">
            <button class="fsn-btn fsn-teal" data-act="copyimg">${I("pin", 13)} 画像をコピー</button>
            <button class="fsn-btn" data-act="dlimg">PNG保存</button>
            <span class="fsn-issue-shotnote"></span>
            <button class="fsn-btn" data-act="close">閉じる</button>
          </div>
        </div>
      </div>`);
    root.appendChild(bg);
    const note = bg.querySelector(".fsn-issue-shotnote");
    const close = () => bg.remove();
    bg.addEventListener("click", (e) => { if (e.target === bg) close(); });
    bg.querySelector('[data-act="close"]').addEventListener("click", close);

    bg.querySelector('[data-act="copytitle"]').addEventListener("click", async () => {
      try { await copyText(title); toast("タイトルをコピーしました"); }
      catch { toast("コピーできませんでした"); }
    });
    bg.querySelector('[data-act="copybody"]').addEventListener("click", async () => {
      try { await copyText(body); toast("本文をコピーしました"); }
      catch { toast("コピーできませんでした"); }
    });

    // 画像コピー / PNG保存: 撮影中はモーダルを一時的に隠してページとピンを写す
    async function withShot(handler, label) {
      note.textContent = "撮影中…";
      bg.style.visibility = "hidden";
      let blob = null;
      try { blob = await captureThreadShot(c); }
      catch { blob = null; }
      bg.style.visibility = "";
      if (!blob) {
        note.textContent = "";
        return toast("スクショの自動取得に失敗しました。手動で添付してください");
      }
      note.textContent = "";
      await handler(blob);
      void label;
    }
    bg.querySelector('[data-act="copyimg"]').addEventListener("click", () =>
      withShot(async (blob) => {
        try { await copyImage(blob); toast("画像をコピーしました。GitHubでCtrl/Cmd+V"); }
        catch {
          downloadBlob(blob, `fusen-issue-${idx}.png`);
          toast("画像コピー非対応のためPNGを保存しました");
        }
      })
    );
    bg.querySelector('[data-act="dlimg"]').addEventListener("click", () =>
      withShot(async (blob) => {
        downloadBlob(blob, `fusen-issue-${idx}.png`);
        toast("PNGを保存しました");
      })
    );
  }

  // ---------- レビュー(承認)モーダル ----------
  async function openReviewModal() {
    closePop();
    let verdict = null;
    let detail = { reviews: [] };
    try {
      detail = await apiCall(`/api/canvases/${CFG.canvasId}`);
    } catch {}
    const openCount = roots().filter((c) => c.status !== "resolved").length;

    const bg = el(`
      <div class="fsn-modal-bg" data-fsn>
        <div class="fsn-modal">
          <h2>${I("flag", 18)} レビューを完了する</h2>
          ${openCount ? `<p style="margin:0 0 12px;font-size:13px;font-weight:700;color:#ff4f9a">${I("alert", 13)} 未解決のコメントが ${openCount} 件あります</p>` : ""}
          <div class="fsn-verdicts">
            <div class="fsn-verdict" data-v="approved">${I("checkCircle", 15)} 承認する</div>
            <div class="fsn-verdict" data-v="changes_requested">${I("pen", 15)} 修正を依頼</div>
          </div>
          <textarea placeholder="ひとことコメント(任意)" style="width:100%;font-family:inherit;font-size:13.5px;border:2.5px solid #21283b;border-radius:10px;background:#fff6e9;padding:8px 10px;min-height:64px;outline:none"></textarea>
          <div class="fsn-pop-actions" style="margin-top:12px">
            <button class="fsn-btn" data-act="close">閉じる</button>
            <button class="fsn-btn fsn-primary" data-act="submit">送信する</button>
          </div>
          <div class="fsn-history">
            <h3>これまでのレビュー</h3>
            ${
              detail.reviews.length
                ? detail.reviews
                    .slice()
                    .reverse()
                    .map(
                      (r) => `
              <div class="fsn-h-item">
                <span class="fsn-h-badge ${r.verdict === "approved" ? "ok" : "ng"}">${r.verdict === "approved" ? "承認" : "修正依頼"}</span>
                <span><strong>${esc(r.author)}</strong> ${r.comment ? "「" + esc(r.comment) + "」" : ""} <span style="color:#8a90a3">${timeAgo(r.created_at)}</span></span>
              </div>`
                    )
                    .join("")
                : `<div style="font-size:12.5px;color:#8a90a3;font-weight:700">まだレビューはありません</div>`
            }
          </div>
        </div>
      </div>`);
    root.appendChild(bg);

    bg.addEventListener("click", (e) => {
      if (e.target === bg) bg.remove();
    });
    bg.querySelector('[data-act="close"]').addEventListener("click", () => bg.remove());
    bg.querySelectorAll(".fsn-verdict").forEach((v) =>
      v.addEventListener("click", () => {
        verdict = v.dataset.v;
        bg.querySelectorAll(".fsn-verdict").forEach((x) => x.classList.remove("fsn-sel-ok", "fsn-sel-ng"));
        v.classList.add(verdict === "approved" ? "fsn-sel-ok" : "fsn-sel-ng");
      })
    );
    bg.querySelector('[data-act="submit"]').addEventListener("click", async () => {
      if (!verdict) return toast("「承認する」か「修正を依頼」を選んでください");
      try {
        await apiCall(`/api/canvases/${CFG.canvasId}/reviews`, {
          method: "POST",
          body: JSON.stringify({ verdict, comment: bg.querySelector("textarea").value }),
        });
        bg.remove();
        celebrate(verdict);
      } catch (e) {
        toast(e.message);
      }
    });
  }

  // 送信後のフィードバック画面(承認時はダッシュボードへ自動帰還)
  function celebrate(verdict) {
    const ok = verdict === "approved";
    const goHome = ok && !CFG.user.guest;
    const bg = el(`
      <div class="fsn-modal-bg" data-fsn>
        <div class="fsn-modal fsn-celebrate">
          <div class="fsn-celebrate-icon ${ok ? "fsn-c-ok" : "fsn-c-ng"}">${I(ok ? "checkCircle" : "pen", 46, 2)}</div>
          <h2 style="text-align:center">${ok ? "承認しました!" : "修正依頼を送りました"}</h2>
          <p style="text-align:center;margin:0;font-size:13.5px;font-weight:700;color:#5a6175">
            ${ok ? "このキャンバスのレビューは完了です。おつかれさまでした!" : "コメントをもとに修正をお願いしましょう。"}
          </p>
          ${goHome ? `<p style="text-align:center;margin:12px 0 0;font-size:12px;font-weight:700;color:#8a90a3">ダッシュボードに戻ります…</p>` : `<div style="text-align:center;margin-top:14px"><button class="fsn-btn" data-act="close">閉じる</button></div>`}
        </div>
      </div>`);
    root.appendChild(bg);
    const closeBtn = bg.querySelector('[data-act="close"]');
    if (closeBtn) closeBtn.addEventListener("click", () => bg.remove());
    if (goHome) setTimeout(() => (location.href = API + "/"), 1800);
    else if (!ok) setTimeout(() => bg.isConnected && bg.remove(), 2500);
  }

  // ---------- モード切替 ----------
  function sizeCatcher() {
    catcher.style.height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) + "px";
  }
  function setMode(m) {
    mode = m;
    toolbar.querySelector("#fsn-mode-browse").classList.toggle("fsn-on", m === "browse");
    toolbar.querySelector("#fsn-mode-comment").classList.toggle("fsn-on", m === "comment");
    hint.style.display = m === "comment" ? "block" : "none";
    if (m === "comment") {
      catcher.style.display = "block";
      sizeCatcher();
    } else {
      catcher.style.display = "none";
      hoverHl = null;
      closePop();
      queueUpdate();
    }
  }

  // 実要素の取得(自前UIを一瞬すり抜けさせる)
  function elementAt(cx, cy) {
    catcher.style.pointerEvents = "none";
    const t = document.elementFromPoint(cx, cy);
    catcher.style.pointerEvents = "auto";
    if (!t || (t.closest && t.closest("[data-fsn]"))) return null;
    return t;
  }

  // コメントモード: ホバーで対象要素をハイライト
  let hoverThrottle = 0;
  catcher.addEventListener("mousemove", (e) => {
    const now = Date.now();
    if (now - hoverThrottle < 60) return;
    hoverThrottle = now;
    if (popEl) return;
    hoverHl = elementAt(e.clientX, e.clientY);
    queueUpdate();
  });
  catcher.addEventListener("mouseleave", () => {
    hoverHl = null;
    queueUpdate();
  });

  catcher.addEventListener("click", (e) => {
    const target = elementAt(e.clientX, e.clientY);
    if (!target) return;
    const r = target.getBoundingClientRect();
    const anchor = {
      selector: cssPath(target),
      rx: r.width ? (e.clientX - r.left) / r.width : 0,
      ry: r.height ? (e.clientY - r.top) / r.height : 0,
      ax: scrollX + e.clientX,
      ay: scrollY + e.clientY,
    };
    // 作成時コンテキスト(対象ラベル・モーダル内か)も一緒に保存する。
    // anchor ごと POST ボディへ展開されるので ctx_label / ctx_modal / ctx_modal_label が送られる
    Object.assign(anchor, contextOf(target));
    hoverHl = null;
    openNewComment(anchor, target); // 第2引数はスクショ撮影用(anchor には DOM を入れない)
  });

  // ---------- ブラウズモードのリンク制御 ----------
  // ・対象サイトへの絶対リンク → プロキシ表示URLに変換
  // ・相対リンク(=自オリジン宛になる) → そのまま通す(サーバーのフォールバック中継が処理)
  // ・外部サイト → 新しいタブで素のまま開く
  function handleLinkClick(e) {
    if (e.target.closest && e.target.closest("[data-fsn]")) return;
    const a = e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    let href;
    try {
      href = new URL(a.getAttribute("href"), location.href);
    } catch {
      return;
    }
    if (!/^https?:$/.test(href.protocol)) return;

    // 別タブで開く意図(target=_blank / 修飾キー / 中クリック)を尊重する。
    // これを無視して現在タブを location.href でプロキシ遷移させると、遷移先が
    // リロードやリダイレクトを繰り返すページ(=削除済みページ等の取得ループ)だった場合、
    // 作業中タブごと固まる。別タブ意図があるときは現在タブを巻き込まず新タブで開く。
    const wantsNewTab =
      /^_blank$/i.test(a.getAttribute("target") || "") ||
      e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1;

    // 相対リンク等で自オリジン宛になったもの: 通常はサーバー側中継(relayFallback)が
    // /p/<id>/... へ誘導するのでそのまま通す。ただし別タブ意図の中クリックだけは、
    // 既定だと生の自オリジンURLが新タブに開くのを避けるため明示的にプロキシURLを開く。
    if (href.host === location.host) {
      if (wantsNewTab && e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        window.open(`${API}/p/${CFG.canvasId}${href.pathname}${href.search}`, "_blank");
      }
      return;
    }

    const sameSite = href.hostname === CFG.canvasHost;
    e.preventDefault();
    e.stopPropagation();
    if (sameSite) {
      const proxied = `${API}/p/${CFG.canvasId}${href.pathname}${href.search}`;
      if (wantsNewTab) window.open(proxied, "_blank"); // 作業中タブは温存
      else location.href = proxied;
    } else {
      window.open(href.href, "_blank");
      toast("対象サイトの外側のリンクなので新しいタブで開きました");
    }
  }
  // 中クリック(button===1)は click ではなく auxclick で拾う
  document.addEventListener("click", handleLinkClick, true);
  document.addEventListener("auxclick", (e) => { if (e.button === 1) handleLinkClick(e); }, true);
  // フォーム送信はサーバーのフォールバック中継がそのまま対象サイトへ届けるため、横取りしない

  // ---------- ツールバー操作 ----------
  toolbar.querySelector("#fsn-mode-browse").addEventListener("click", () => setMode("browse"));
  toolbar.querySelector("#fsn-mode-comment").addEventListener("click", () => setMode("comment"));
  toolbar.querySelector("#fsn-tb-comments").addEventListener("click", () => sidebar.classList.toggle("fsn-open"));
  sidebar.querySelector("#fsn-sb-close").addEventListener("click", () => sidebar.classList.remove("fsn-open"));
  sidebar.querySelectorAll(".fsn-chip").forEach((ch) =>
    ch.addEventListener("click", () => {
      sidebar.querySelectorAll(".fsn-chip").forEach((x) => x.classList.remove("fsn-on"));
      ch.classList.add("fsn-on");
      filter = ch.dataset.f;
      renderSidebar();
    })
  );
  sidebar.querySelector("#fsn-sb-search").addEventListener("input", (e) => {
    search = e.target.value.trim();
    renderSidebar();
  });
  sidebar.querySelector("#fsn-sb-thispage").addEventListener("change", (e) => {
    currentPageOnly = e.target.checked;
    renderSidebar();
  });
  toolbar.querySelector("#fsn-tb-share").addEventListener("click", async () => {
    try {
      const d = await apiCall(`/api/canvases/${CFG.canvasId}`);
      await navigator.clipboard.writeText(d.share_url);
      toast("共有リンクをコピーしました(ログイン不要でコメントできます)");
    } catch (e) {
      toast(e.message);
    }
  });
  toolbar.querySelector("#fsn-tb-review").addEventListener("click", openReviewModal);
  const homeBtn = toolbar.querySelector("#fsn-tb-home");
  if (homeBtn) homeBtn.addEventListener("click", () => (location.href = API + "/"));

  // Escで閉じる
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closePop();
      sidebar.classList.remove("fsn-open");
    }
  });

  // ---------- 簡易リアルタイム同期(ポーリング) ----------
  // 数秒ごとにサーバーからコメントを取り直し、他メンバーの追加・解決・削除を自動反映する。
  // サーバー1台 + data/db.json の現構成のまま動作し、外部DBやWebSocketは不要。
  // 入力中(新規コメント作成中・返信記入中)は反映を次回に回し、編集内容を壊さない。
  async function poll() {
    if (document.hidden) return; // 非表示タブでは通信しない
    if (tempPinEl) return; // 新規コメント入力中はピン再描画で消えるため次回へ
    let d;
    try {
      d = await apiCall(`/api/canvases/${CFG.canvasId}/comments`);
    } catch {
      return; // 一時的な通信失敗は無視(次回再試行)
    }
    const sig = sigOf(d.comments);
    if (sig === lastSig) return; // 変化なし
    lastSig = sig;
    comments = d.comments;
    renderPins(); // ポップオーバーはrootに付くため再描画で消えない
    if (openThreadId) {
      const still = comments.find((x) => x.id === openThreadId);
      const ta = popEl && popEl.querySelector("textarea");
      const typing = ta && ta.value.trim().length > 0;
      if (!still) {
        closePop();
        toast("このコメントは他のメンバーが削除しました");
      } else if (!typing) {
        openThread(openThreadId); // 新着返信・解決状態を反映(返信入力中は触らない)
      }
    }
  }

  // 別ページから「#fsn=<id>」付きで来たとき、そのコメントへスクロールして開く
  function openByHash() {
    const m = location.hash.match(/fsn=([^&]+)/);
    if (!m) return;
    const id = decodeURIComponent(m[1]);
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {}
    const c = comments.find((x) => x.id === id);
    if (!c || normalize(c.page) !== PAGE) return;
    // 画像読み込み等でレイアウトが定まるのを待ってから移動
    setTimeout(() => {
      const p = resolveViewport(c);
      window.scrollTo({ top: Math.max(0, scrollY + p.y - innerHeight / 3), behavior: "smooth" });
      setTimeout(() => openThread(c.id), 500);
    }, 700);
  }

  // ---------- 起動 ----------
  async function init() {
    mount();
    try {
      const d = await apiCall(`/api/canvases/${CFG.canvasId}/comments`);
      comments = d.comments;
      markSynced();
    } catch (e) {
      toast(e.message);
    }
    renderPins();
    openByHash();
    mo.observe(document.body, { childList: true, subtree: true, attributes: false });
    // 画像読み込み等でレイアウトが動くため遅延更新 + 低頻度の保険更新
    setTimeout(queueUpdate, 1500);
    setInterval(queueUpdate, 2000);
    setInterval(poll, 3000); // 他メンバーのコメントを取り込む(簡易リアルタイム同期)
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
