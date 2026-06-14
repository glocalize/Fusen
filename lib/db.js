// 超軽量JSONファイルストア(社内小規模利用向け)
// 書き込みは一時ファイル→rename のアトミック方式
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const EMPTY = { users: [], canvases: [], comments: [], reviews: [] };

let data;

function load() {
  try {
    data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    data = structuredClone(EMPTY);
  }
  for (const k of Object.keys(EMPTY)) if (!Array.isArray(data[k])) data[k] = [];
}

let saveTimer = null;
function save() {
  // 連続書き込みをまとめる(100ms デバウンス)
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, DB_FILE);
  }, 100);
}

export function nid(prefix = "") {
  return (
    prefix +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  );
}

load();

export const db = {
  get users() { return data.users; },
  get canvases() { return data.canvases; },
  get comments() { return data.comments; },
  get reviews() { return data.reviews; },
  save,
};
