// Change requests sent from the popup: text plus images, kept in
// ~/.tether/requests/<id>/ until an agent resolves them.
import fs from "node:fs";
import path from "node:path";
import { REQUESTS_DIR } from "./config.js";

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export function saveRequest(req) {
  const id = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "") + "-" + Math.random().toString(36).slice(2, 6);
  const d = path.join(REQUESTS_DIR, id);
  fs.mkdirSync(d, { recursive: true });
  const images = [];
  (req.images || []).slice(0, 8).forEach((img, i) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(img.dataUrl || "");
    if (!m) return;
    const file = `image-${i + 1}.${EXT[m[1]] || "png"}`;
    fs.writeFileSync(path.join(d, file), Buffer.from(m[2], "base64"));
    images.push({ file, mimeType: m[1], name: img.name || file });
  });
  const meta = { id, text: String(req.text || "").slice(0, 8000), url: req.url, title: req.title, tab: req.tab, browser: req.browser, images, status: "open", created: Date.now() };
  fs.writeFileSync(path.join(d, "request.json"), JSON.stringify(meta, null, 2));
  return meta;
}

export function listRequests({ status } = {}) {
  if (!fs.existsSync(REQUESTS_DIR)) return [];
  return fs
    .readdirSync(REQUESTS_DIR)
    .map((id) => { try { return JSON.parse(fs.readFileSync(path.join(REQUESTS_DIR, id, "request.json"), "utf8")); } catch { return null; } })
    .filter((r) => r && (!status || status === "all" || r.status === status))
    .sort((a, b) => b.created - a.created);
}

export function imagesOf(r) {
  return r.images.map((img) => ({ ...img, data: fs.readFileSync(path.join(REQUESTS_DIR, r.id, img.file)).toString("base64") }));
}

export function resolveRequest(id, reply) {
  const f = path.join(REQUESTS_DIR, id, "request.json");
  if (!fs.existsSync(f)) throw new Error(`No request ${id}`);
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  Object.assign(r, { status: "done", reply: String(reply || "").slice(0, 2000), resolved: Date.now() });
  fs.writeFileSync(f, JSON.stringify(r, null, 2));
  return r;
}
