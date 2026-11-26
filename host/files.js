// Finding the files an agent wants to upload. The host runs as the user, so
// it can read what the user can; this turns what an agent writes ("~/Downloads/
// invoice-*.pdf", "%USERPROFILE%\Desktop\cv.pdf", "download:12") into real
// files, explains a path that doesn't exist, and keeps a few places off limits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Bigger files can still go by path when the browser reads them itself
// (Chromium with "Allow access to file URLs"); their bytes never travel.
export const BYTES_CAP = 50 * 1024 * 1024;
const MAX_FILES = 50;

const HOME = os.homedir();
const norm = (p) => path.resolve(p).toLowerCase().replace(/\\/g, "/");

// Never uploaded, whatever the agent asks: keys, Tether's own data, browser
// profiles (cookies, saved passwords).
const BLOCKED_DIRS = [
  ".ssh", ".gnupg", ".tether", ".aws", ".azure", ".kube", ".docker", ".mozilla", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".zen",
  "AppData/Local/Google/Chrome/User Data", "AppData/Local/Chromium/User Data", "AppData/Local/Microsoft/Edge/User Data", "AppData/Local/BraveSoftware", "AppData/Roaming/Opera Software", "AppData/Local/Vivaldi",
  "AppData/Roaming/Mozilla", "AppData/Roaming/zen", "AppData/Roaming/Microsoft/Credentials", "AppData/Local/Microsoft/Credentials", "AppData/Roaming/Microsoft/Protect",
  "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox", "Library/Application Support/BraveSoftware", "Library/Application Support/zen", "Library/Keychains",
].map((d) => norm(path.join(HOME, d)));
const BLOCKED_NAMES = /^(id_(rsa|dsa|ecdsa|ed25519)(_sk)?|.*\.(pem|key|p12|pfx|kdbx|keystore|jks)|\.env(\..*)?|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?|known_hosts|authorized_keys)$/i;

export function blockedReason(p) {
  const n = norm(p);
  if (BLOCKED_DIRS.some((d) => n === d || n.startsWith(d + "/"))) return "it is in a folder Tether never uploads from (keys, browser profiles, Tether's own data)";
  if (BLOCKED_NAMES.test(path.basename(p))) return "it looks like a key or credentials file, which Tether never uploads";
  return "";
}

// ~, %VAR% and $VAR / ${VAR}.
export function expand(p) {
  let s = String(p).trim().replace(/^["']|["']$/g, "");
  s = s.replace(/%([A-Za-z_][\w()]*)%/g, (m, v) => process.env[v] ?? m);
  s = s.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => process.env[a || b] ?? m);
  if (s === "~" || /^~[\\/]/.test(s)) s = path.join(HOME, s.slice(1));
  return s;
}

const hasGlob = (s) => /[*?]/.test(s);
const globRe = (pat) => new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", process.platform === "win32" ? "i" : "");

// Wildcards in the last part of the path only ("~/Downloads/invoice-*.pdf").
function globFiles(p) {
  const dir = path.dirname(p);
  if (hasGlob(dir)) throw new Error(`“${p}”: wildcards only work in the file name, not in folder names.`);
  const re = globRe(path.basename(p));
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => re.test(n)).map((n) => path.join(dir, n)).filter((f) => isFile(f));
}

function isFile(f) {
  try { return fs.statSync(f).isFile(); } catch { return false; }
}

function info(f) {
  const st = fs.statSync(f);
  return { path: f, name: path.basename(f), size: st.size, modified: st.mtimeMs, type: mime(f) };
}

// Places people keep files they upload, searched when a path is wrong.
const PLACES = ["Desktop", "Downloads", "Documents", "Pictures", "Videos", "Music", "OneDrive/Desktop", "OneDrive/Documents", "OneDrive/Pictures"].map((d) => path.join(HOME, d));

function similar(want, dir, depth = 1, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  // Words of the name: "cv-final (2).pdf" -> cv, final. A file is similar when
  // its whole name is one of those words, or they share a word of 3+ letters.
  const words = (s) => s.toLowerCase().replace(/\.[^.]+$/, "").split(/[^a-z0-9]+/).filter(Boolean);
  const w = words(want);
  for (const e of entries) {
    if (out.length >= 200) break;
    const full = path.join(dir, e.name);
    if (e.isFile()) {
      const n = words(e.name);
      const whole = n.join("");
      if ((whole.length >= 2 && w.includes(whole)) || n.some((x) => x.length >= 3 && w.includes(x))) out.push(full);
    } else if (e.isDirectory() && depth > 0 && !e.name.startsWith(".") && e.name !== "node_modules") {
      similar(want, full, depth - 1, out);
    }
  }
  return out;
}

export function suggestions(p, limit = 8) {
  const want = path.basename(p);
  const near = similar(want, path.dirname(p), 0);
  const elsewhere = PLACES.flatMap((d) => similar(want, d, 1));
  const seen = new Set();
  return [...near, ...elsewhere]
    .filter((f) => !seen.has(norm(f)) && seen.add(norm(f)) && !blockedReason(f))
    .map((f) => { try { return info(f); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.modified - a.modified)
    .slice(0, limit);
}

export const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const fileLine = (f) => `${f.path}  (${kb(f.size)}, ${new Date(f.modified).toISOString().slice(0, 16).replace("T", " ")})`;

// Turns what the agent passed into files. downloads(id) looks up a download
// the browser tracked. Throws with help when something is wrong.
export async function resolveFiles(inputs, { downloads } = {}) {
  const out = [];
  for (const raw of inputs) {
    const d = /^download:(\d+)$/i.exec(String(raw).trim());
    if (d) {
      const item = await downloads?.(Number(d[1]));
      if (!item) throw new Error(`There is no download ${d[1]} in this session. list_downloads shows the ones Tether tracked.`);
      if (item.state !== "complete" || !item.filename) throw new Error(`Download ${d[1]} hasn't finished (${item.state || "in progress"}). Wait for it with wait_for_download.`);
      out.push(item.filename);
      continue;
    }
    const p = expand(raw);
    if (!path.isAbsolute(p)) throw new Error(`“${raw}” is a relative path. Tether's host is shared by every agent and doesn't know your working folder, so pass an absolute path (~ and %USERPROFILE% work).`);
    const why = blockedReason(p);
    if (why) throw new Error(`Tether won't upload ${p}: ${why}.`);
    if (hasGlob(p)) {
      const hits = globFiles(p);
      if (!hits.length) throw new Error(`Nothing matches “${raw}”.${hint(p)}`);
      out.push(...hits);
      continue;
    }
    let st;
    try { st = fs.statSync(p); } catch { throw new Error(`“${raw}” doesn't exist.${hint(p)}`); }
    if (st.isDirectory()) {
      const files = fs.readdirSync(p).map((n) => path.join(p, n)).filter((f) => !path.basename(f).startsWith(".") && isFile(f));
      if (!files.length) throw new Error(`The folder “${raw}” has no files in it.`);
      out.push(...files);
    } else out.push(p);
  }
  const seen = new Set();
  const files = [];
  for (const f of out) {
    const k = norm(f);
    if (seen.has(k)) continue;
    seen.add(k);
    const why = blockedReason(f);
    if (why) throw new Error(`Tether won't upload ${f}: ${why}.`);
    files.push(info(f));
  }
  if (!files.length) throw new Error("No files to upload.");
  if (files.length > MAX_FILES) throw new Error(`That is ${files.length} files; upload at most ${MAX_FILES} at a time.`);
  return files;
}

// What goes to the browser for each file: name, type, size and path, plus
// the bytes while they fit in BYTES_CAP. The browser can read the rest by path
// when the user allowed file access (Chromium).
export function payload(files) {
  let budget = BYTES_CAP;
  return files.map((f) => {
    const item = { name: f.name, type: f.type, size: f.size, path: f.path };
    if (f.size <= budget) { item.data = fs.readFileSync(f.path).toString("base64"); budget -= f.size; }
    return item;
  });
}

function hint(p) {
  const s = suggestions(p);
  return s.length ? ` Files with a similar name, newest first:\n${s.map((f) => "  " + fileLine(f)).join("\n")}` : ` Nothing with a similar name in that folder or in Desktop, Downloads, Documents or Pictures.`;
}

const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", heic: "image/heic", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", html: "text/html", htm: "text/html", xml: "application/xml", rtf: "application/rtf",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", "7z": "application/x-7z-compressed", rar: "application/vnd.rar",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", opus: "audio/opus",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo",
  js: "text/javascript", css: "text/css", ttf: "font/ttf", otf: "font/otf", woff: "font/woff", woff2: "font/woff2", epub: "application/epub+zip", apk: "application/vnd.android.package-archive",
};

export function mime(p) {
  return MIME[path.extname(p).slice(1).toLowerCase()] || "application/octet-stream";
}
