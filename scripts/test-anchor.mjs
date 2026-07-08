// アンカー(ピン位置追従)の視覚回帰テスト / VRT。
// public/debug.html を「本物の overlay」で読み込み、モーダルの開閉・スクロール・DOM変化を
// ヘッドレス Chrome(CDP, 依存ゼロ)で駆動して、ピンの不変条件を検証する。
//   - 通常要素: スクロールに追従する
//   - モーダルを開いている間: 対象要素に乗る
//   - モーダルを閉じた後: 座標フォールバックで浮かせず、ピンを隠す(★回帰の核心)
//   - DOM変化後の再オープン: 安定属性(data-testid)は再アンカー、位置ベースは隠れたまま
// スクショは test/anchor/__screenshots__/ に保存(目視確認用)。
// Chrome 依存のためCIの `npm test` には入れず、ローカルの `npm run test:anchor` で実行する。
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9455;
const SHOTS = join(ROOT, "test", "anchor", "__screenshots__");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// debug.html の /fsn-assets/* を file:// に差し替えて、サーバー無しでヘッドレス読込できる形にする
function buildFixture() {
  let html = readFileSync(join(ROOT, "public", "debug.html"), "utf8");
  const css = pathToFileURL(join(ROOT, "public", "fusen-overlay.css")).href;
  const js = pathToFileURL(join(ROOT, "public", "fusen-overlay.js")).href;
  html = html.replaceAll("/fsn-assets/fusen-overlay.css", css).replaceAll("/fsn-assets/fusen-overlay.js", js);
  const tmp = join(mkdtempSync(join(tmpdir(), "fsn-anchor-")), "debug.html");
  writeFileSync(tmp, html);
  return pathToFileURL(tmp).href;
}

async function browserWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome DevTools に接続できませんでした");
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    };
    ws.onerror = rej;
    ws.onopen = () => res((method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const mid = ++id; pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    }));
  });
}

let pass = 0, fail = 0;
const check = (cond, msg) => { if (cond) { pass++; console.log("  ok   -", msg); } else { fail++; console.error("  FAIL -", msg); } };

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const FIXTURE = buildFixture();
  const profile = mkdtempSync(join(tmpdir(), "fsn-anchor-prof-"));
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--allow-file-access-from-files", "--window-size=1200,900", "--force-device-scale-factor=1", "about:blank",
  ], { stdio: "ignore" });

  try {
    const raw = await connect(await browserWs());
    const { targetId } = await raw("Target.createTarget", { url: FIXTURE });
    const { sessionId } = await raw("Target.attachToTarget", { targetId, flatten: true });
    const send = (m, p) => raw(m, p, sessionId);
    await send("Page.enable"); await send("Runtime.enable");
    await sleep(1400);

    const evalJs = async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(expr + " -> " + JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const shot = async (name) => {
      const r = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(SHOTS, name), Buffer.from(r.data, "base64"));
    };

    await evalJs("window.repro.ready()");

    // --- 1) 通常要素 + スクロール追従 ---
    await evalJs("window.repro.pinOn('#base-target', '通常ボタンへのコメント')");
    check((await evalJs("window.repro.measurePin(1)")).anchoredToLive, "通常要素: Pinが対象に乗る");
    await evalJs("window.repro.scrollTo(300)");
    check((await evalJs("window.repro.measurePin(1)")).anchoredToLive, "通常要素: 300pxスクロールしてもPinが追従する");
    await evalJs("window.repro.scrollTo(0)");

    // --- 2) モーダルを開いている間 ---
    await evalJs("window.repro.openModal()"); await sleep(120);
    await evalJs("window.repro.pinOn('[data-testid=\\'apply\\']', '適用ボタンについて')"); // 安定属性あり
    await evalJs("window.repro.openModal()"); await sleep(120);
    await evalJs("window.repro.pinOn('.mlink', '詳細リンクについて')");                    // 安定属性なし(位置ベース)
    await evalJs("window.repro.openModal()"); await sleep(120);
    check((await evalJs("window.repro.measurePin(2)")).anchoredToLive, "モーダル表示中: 安定属性の要素にPinが乗る");
    check((await evalJs("window.repro.measurePin(3)")).anchoredToLive, "モーダル表示中: 位置ベースの要素にPinが乗る");
    await shot("2-modal-open.png");

    // --- 3) モーダルを閉じた後(★核心: 浮かせず隠す) ---
    await evalJs("window.repro.closeModal()"); await sleep(250);
    const c2 = await evalJs("window.repro.measurePin(2)");
    const c3 = await evalJs("window.repro.measurePin(3)");
    check(!c2.pinVisible, "モーダルを閉じた後: 安定属性のPinはキャンバスに浮かず隠れる");
    check(!c3.pinVisible, "モーダルを閉じた後: 位置ベースのPinはキャンバスに浮かず隠れる");
    // サイドバーの「今は非表示」インジケータがモーダル開閉に反応する(データ変化なしでも更新される)
    const sb1 = await evalJs("window.repro.sidebarHidden(1)");
    const sb3 = await evalJs("window.repro.sidebarHidden(3)");
    check(sb3.isHidden && sb3.tagVisible, "モーダルを閉じた後: サイドバーの該当コメントに「今は非表示」が点灯する");
    check(!sb1.isHidden, "通常要素のコメントは「今は非表示」が点かない");
    await evalJs("document.querySelector('#fsn-tb-comments').click()"); // サイドバーを開いてスクショに写す
    await sleep(200);
    await shot("3-modal-closed.png");

    // --- 4) DOM変化を挟んで再オープン ---
    await evalJs("window.repro.addDecoy()");
    await evalJs("window.repro.openModal()"); await sleep(300);
    const r2 = await evalJs("window.repro.measurePin(2)");
    const r3 = await evalJs("window.repro.measurePin(3)");
    check(r2.pinVisible && r2.anchoredToLive, "再オープン: 安定属性(data-testid)のPinは正しく再アンカーされる");
    check(!r3.pinVisible, "再オープン: DOM変化した位置ベースのPinは誤マッチせず隠れたまま(浮かない)");
    const sb2r = await evalJs("window.repro.sidebarHidden(2)");
    check(!sb2r.isHidden, "再オープン: 再アンカーされたコメントの「今は非表示」は消える");
    await shot("4-reopen-after-domchange.png");

    console.log(`\nスクショ: ${SHOTS}`);
    console.log(`\n=== anchor VRT: ${pass} passed, ${fail} failed ===`);
  } finally {
    chrome.kill();
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
