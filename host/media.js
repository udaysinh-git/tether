// Saving media from a shared tab to ~/.tether/media/<site>/.
//   http(s) files: fetched here with the browser's cookies for that URL
//   blob:, data: and canvases: read out of the page in chunks
//   HLS/DASH streams: ffmpeg, with the same cookies and referer
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { HOME } from "./config.js";

const CHUNK = 4 * 1024 * 1024;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/svg+xml": "svg", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "application/pdf": "pdf" };

let ffmpegPath;
function ffmpeg() {
  if (ffmpegPath !== undefined) return ffmpegPath;
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); ffmpegPath = "ffmpeg"; } catch { ffmpegPath = null; }
  return ffmpegPath;
}

const safe = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").replace(/^\.+/, "").slice(0, 120) || "media";

function nameFrom(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    return last && last.includes(".") ? last : "";
  } catch { return ""; }
}

function unique(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; ; i++) {
    const q = path.join(dir, `${name} (${i})${ext}`);
    if (!fs.existsSync(q)) return q;
  }
}

export async function saveMedia(hub, handle, { id, url, filename, timeoutSeconds = 900 }) {
  const info = await hub.callTab(handle, "mediaInfo", { id, url });
  const item = info.item;
  let site = "page";
  try { site = new URL(info.referer).host; } catch {}
  const dir = path.join(HOME, "media", safe(site));
  fs.mkdirSync(dir, { recursive: true });
  const src = item.url || "";

  if (item.kind === "segments") throw new Error("Those are pieces of a stream. Save the stream itself (its .m3u8 or .mpd entry in list_media).");
  if (item.streamed && src.startsWith("blob:")) {
    throw new Error("This player streams through MediaSource, so there's no single file behind its blob: URL. Save the HLS or DASH stream listed by list_media instead (play the video first if none is listed).");
  }

  // Read out of the page in chunks.
  if (item.kind === "canvas" || /^(blob|data):/.test(src)) {
    let out = null, fd = null, offset = 0, total = Infinity, type = "";
    try {
      while (offset < total) {
        const r = await hub.callTab(handle, "mediaRead", { url: item.kind === "canvas" ? undefined : src, ref: item.kind === "canvas" ? item.ref : undefined, offset, size: CHUNK }, 120000);
        total = r.total;
        type = r.type;
        if (!out) {
          out = unique(path.join(dir, safe(filename || `${item.kind}-${Date.now()}.${EXT[type.split(";")[0]] || "bin"}`)));
          fd = fs.openSync(out, "w");
        }
        const buf = Buffer.from(r.data, "base64");
        if (!buf.length) break;
        fs.writeSync(fd, buf);
        offset += buf.length;
      }
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    return { path: out, bytes: offset, type };
  }

  const headers = { "user-agent": info.userAgent, referer: info.referer };
  if (info.cookie) headers.cookie = info.cookie;

  // Streams: ffmpeg copies them into one file without re-encoding.
  if (item.kind === "stream" || /\.(m3u8|mpd)(\?|#|$)/i.test(src)) {
    if (!ffmpeg()) throw new Error("Saving HLS/DASH streams needs ffmpeg on PATH. Install it, or save individual files instead.");
    const out = unique(path.join(dir, safe(filename || `${(nameFrom(src) || "stream").replace(/\.(m3u8|mpd)$/i, "")}.mp4`)));
    const hdr = `Referer: ${info.referer}\r\n${info.cookie ? `Cookie: ${info.cookie}\r\n` : ""}`;
    const args = ["-hide_banner", "-loglevel", "error", "-y", "-user_agent", info.userAgent, "-headers", hdr, "-i", src, "-c", "copy", out];
    const proc = spawn(ffmpeg(), args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    proc.stderr.on("data", (d) => (err += d).length > 4000 && (err = err.slice(-4000)));
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => resolve("timeout"), timeoutSeconds * 1000);
      proc.on("close", (c) => { clearTimeout(t); resolve(c); });
    });
    if (code === "timeout") return { path: out, note: `still saving after ${timeoutSeconds}s; ffmpeg keeps going in the background` };
    if (code !== 0) throw new Error(`ffmpeg failed: ${err.trim().split("\n").slice(-3).join(" ") || "exit " + code}`);
    return { path: out, bytes: fs.statSync(out).size, type: "video/mp4" };
  }

  // Plain files.
  const res = await fetch(src, { headers, redirect: "follow", signal: AbortSignal.timeout(timeoutSeconds * 1000) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const type = (res.headers.get("content-type") || "").split(";")[0];
  let name = filename || nameFrom(res.url) || nameFrom(src) || `${item.kind || "file"}-${Date.now()}`;
  if (!path.extname(name) && EXT[type]) name += "." + EXT[type];
  const out = unique(path.join(dir, safe(name)));
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(out, buf);
  return { path: out, bytes: buf.length, type };
}

export function formatMedia(items) {
  const dur = (s) => (s == null ? "" : s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m` : s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`);
  const short = (u) => (u && u.length > 140 ? u.slice(0, 137) + "…" : u || "");
  return items
    .map((x) => {
      const ref = x.ref ? ` [${x.ref}]` : "";
      switch (x.kind) {
        case "video":
        case "audio":
          return `${x.id}  ${x.kind}${ref}${x.w ? ` ${x.w}x${x.h}` : ""} ${dur(x.duration)} ${x.paused ? "paused" : "playing"} at ${dur(x.time)}${x.streamed ? "  (streamed; save the stream entry below)" : ""}\n      ${short(x.url) || "(no source yet)"}`;
        case "image":
          return `${x.id}  image${ref} ${x.w}x${x.h}${x.alt ? ` "${x.alt}"` : ""}${x.visible ? "" : " (hidden)"}\n      ${short(x.url)}`;
        case "background":
          return `${x.id}  background image${ref}\n      ${short(x.url)}`;
        case "canvas":
          return `${x.id}  canvas${ref} ${x.w}x${x.h}`;
        case "stream":
          return `${x.id}  ${x.format} stream (from the network log)\n      ${short(x.url)}`;
        case "file":
          return `${x.id}  media file ${x.mime || ""} (from the network log)\n      ${short(x.url)}`;
        case "segments":
          return `${x.id}  ${x.count} stream segments under ${short(x.url)}`;
        default:
          return `${x.id}  ${x.kind} ${short(x.url)}`;
      }
    })
    .join("\n");
}
