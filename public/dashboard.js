// Fusen! ダッシュボード
let tab = "active";

// 静的HTML内のアイコンプレースホルダを描画
document.querySelectorAll("[data-icon]").forEach((s) => {
  s.innerHTML = fsnIcon(s.dataset.icon, Number(s.dataset.size) || 16);
});

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2600);
}

// サムネ用: ホスト名から安定した楽しいグラデーションを作る
const PALETTES = [
  ["#FF6B35", "#FFC53D"],
  ["#0FB5A5", "#7BE0D3"],
  ["#FF4F9A", "#FFB1D0"],
  ["#5B7FFF", "#9DDCFF"],
  ["#FF8A3D", "#FF4F9A"],
  ["#21B573", "#C6F06E"],
];
function thumbStyle(host) {
  let h = 0;
  for (const ch of host) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [a, b] = PALETTES[h % PALETTES.length];
  const deg = 115 + (h % 90);
  return `background: linear-gradient(${deg}deg, ${a}, ${b})`;
}

function reviewBadge(c) {
  if (!c.last_review) return `<span class="badge reviewing">${fsnIcon("clock", 13)} レビュー中</span>`;
  return c.last_review.verdict === "approved"
    ? `<span class="badge approved">${fsnIcon("check", 13)} 承認済み</span>`
    : `<span class="badge changes">${fsnIcon("pen", 13)} 修正依頼</span>`;
}

async function me() {
  const r = await fetch("/api/me");
  const d = await r.json();
  if (!d.user) return (location.href = "/login");
  $("#userName").textContent = d.user.name;
  $("#avatar").textContent = d.user.name.slice(0, 1);
}

async function load() {
  const r = await fetch(`/api/canvases?archived=${tab === "archived" ? 1 : 0}`);
  if (r.status === 401) return (location.href = "/login");
  const { canvases } = await r.json();
  const grid = $("#grid");
  $("#empty").style.display = canvases.length ? "none" : "block";
  grid.innerHTML = canvases
    .map(
      (c) => `
    <div class="card" data-id="${c.id}">
      <div class="tape"></div>
      <div class="thumb" style="${thumbStyle(c.host)}">${esc(c.host.slice(0, 1).toUpperCase())}</div>
      <div class="body">
        <h3>${esc(c.title)}</h3>
        <div class="url">${esc(c.host)}</div>
        <div class="meta">
          ${reviewBadge(c)}
          <span class="badge count">${fsnIcon("bubble", 13)} ${c.open_count}/${c.comment_count}</span>
        </div>
      </div>
      <div class="actions">
        <button class="icon-btn act-share" title="共有リンクをコピー">${fsnIcon("link", 15)}</button>
        <button class="icon-btn act-archive" title="${tab === "archived" ? "戻す" : "アーカイブ"}">${tab === "archived" ? fsnIcon("undo", 15) : fsnIcon("archive", 15)}</button>
      </div>
    </div>`
    )
    .join("");

  grid.querySelectorAll(".card").forEach((card) => {
    const id = card.dataset.id;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".actions")) return;
      location.href = `/p/${id}`;
    });
    card.querySelector(".act-share").addEventListener("click", async () => {
      const r = await fetch(`/api/canvases/${id}`);
      const d = await r.json();
      await navigator.clipboard.writeText(d.share_url);
      toast("共有リンクをコピーしました(ログイン不要でコメントできます)");
    });
    card.querySelector(".act-archive").addEventListener("click", async () => {
      await fetch(`/api/canvases/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: tab !== "archived" }),
      });
      load();
    });
  });
}

// タブ
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    tab = t.dataset.tab;
    load();
  })
);

// 新規モーダル
$("#newBtn").addEventListener("click", () => $("#newModal").classList.add("open"));
$("#newCancel").addEventListener("click", () => $("#newModal").classList.remove("open"));
$("#newModal").addEventListener("click", (e) => {
  if (e.target.id === "newModal") $("#newModal").classList.remove("open");
});
let urlChecked = false; // 警告表示後の「それでも作成」用フラグ
$("#cvUrl").addEventListener("input", () => {
  urlChecked = false;
  $("#urlWarn").style.display = "none";
  $("#newSubmit").textContent = "作成する";
});

$("#newForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = $("#newSubmit");

  // 作成前にURLの表示可否をチェック(警告後の再送信ならスキップ)
  if (!urlChecked) {
    submitBtn.disabled = true;
    submitBtn.textContent = "確認中…";
    let check = null;
    try {
      const cr = await fetch("/api/check-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: $("#cvUrl").value }),
      });
      check = await cr.json();
      if (!cr.ok) {
        submitBtn.disabled = false;
        submitBtn.textContent = "作成する";
        return toast(check.error || "URLを確認できませんでした");
      }
    } catch {}
    submitBtn.disabled = false;
    if (check && !check.ok) {
      urlChecked = true;
      $("#urlWarn").innerHTML = `${fsnIcon("alert", 14)} ${esc(check.message)} このまま作成しても表示できない可能性があります。`;
      $("#urlWarn").style.display = "block";
      submitBtn.textContent = "それでも作成する";
      return;
    }
    submitBtn.textContent = "作成する";
  }

  const r = await fetch("/api/canvases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: $("#cvUrl").value, title: $("#cvTitle").value }),
  });
  const d = await r.json();
  if (!r.ok) return toast(d.error || "作成に失敗しました");
  $("#newModal").classList.remove("open");
  $("#cvUrl").value = "";
  $("#cvTitle").value = "";
  $("#urlWarn").style.display = "none";
  $("#newSubmit").textContent = "作成する";
  urlChecked = false;
  toast("キャンバスを作成しました!");
  load();
});

// ログアウト(HttpOnly クッキーは JS から消せないためサーバーで失効させる)
$("#logoutBtn").addEventListener("click", async () => {
  try { await fetch("/api/logout", { method: "POST" }); } catch {}
  location.href = "/login";
});

me();
load();
