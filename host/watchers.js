// Watchers check a page on a schedule and tell the user when something they
// care about happens. The browser does the fetching so the user's cookies
// apply; the check runs here (fetch mode) or in the page (tab mode).
//
//   ~/.tether/watchers/<id>.json
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { HOME, loadConfig } from "./config.js";

const DIR = path.join(HOME, "watchers");
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "watcher";

export function listWatchers() {
  fs.mkdirSync(DIR, { recursive: true });
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getWatcher(n) {
  const all = listWatchers();
  return all.find((w) => w.id === n) || all.find((w) => w.name.toLowerCase() === String(n).toLowerCase()) || all.find((w) => w.id === slug(n));
}

function write(w) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, w.id + ".json"), JSON.stringify(w, null, 2));
  return w;
}

export function saveWatcher(input) {
  const id = slug(input.name);
  const prev = getWatcher(id);
  return write({
    id,
    name: input.name,
    description: input.description || "",
    url: input.url,
    mode: input.mode === "tab" ? "tab" : "fetch",
    every: Math.max(1, Math.round(input.every_minutes || 30)),
    check: input.check,
    notify: input.notify?.length ? input.notify : ["browser"],
    enabled: input.enabled !== false,
    created: prev?.created || Date.now(),
    last: prev && prev.check === input.check && prev.url === input.url ? prev.last : null,
  });
}

export function setWatcherEnabled(id, on) {
  const w = getWatcher(id);
  if (!w) throw new Error(`No watcher ${id}`);
  w.enabled = !!on;
  return write(w);
}

export function deleteWatcher(n) {
  const w = getWatcher(n);
  if (!w) return false;
  fs.rmSync(path.join(DIR, w.id + ".json"));
  return true;
}

// Fetch-mode checks run in a fresh V8 context with no Node APIs.
function runCheck(code, response) {
  const ctx = vm.createContext({ response, URL, URLSearchParams, console: { log() {} } });
  return vm.runInContext(`(function (response) {\n${code}\n})(response)`, ctx, { timeout: 2000 });
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const short = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > 160 ? s.slice(0, 157) + "…" : s;
};

export async function runWatcher(hub, w, { notify = true } = {}) {
  const browser = [...hub.browsers.values()].at(-1);
  if (!browser) throw new Error("No browser is connected, so the watcher can't load the page.");
  let result;
  if (w.mode === "tab") {
    const r = await hub.call(browser, "watchTab", { url: w.url, code: w.check }, 90000);
    result = r.value;
  } else {
    const r = await hub.call(browser, "watchFetch", { url: w.url }, 60000);
    let json = null;
    try { json = JSON.parse(r.text); } catch {}
    result = runCheck(w.check, { status: r.status, url: r.url, text: r.text, json, contentType: r.contentType });
  }

  // A check returns either { notify, message, value } or just a value;
  // a plain value notifies when it changes from the last run.
  let fire, message, value;
  if (result && typeof result === "object" && "notify" in result) {
    fire = !!result.notify;
    value = "value" in result ? result.value : result.message;
    message = result.message || short(value);
  } else {
    value = result;
    fire = !!w.last && w.last.ok && !same(w.last.value, value);
    message = w.last ? `${short(w.last.value)} → ${short(value)}` : short(value);
  }

  const fresh = getWatcher(w.id) || w;
  fresh.last = { at: Date.now(), ok: true, value, message, notified: fire && notify };
  write(fresh);
  if (fire && notify) await notifyUser(hub, browser, fresh, message);
  return fresh.last;
}

async function notifyUser(hub, browser, w, message) {
  const cfg = loadConfig();
  if (w.notify.includes("browser")) {
    await hub.call(browser, "notify", { title: w.name, message: message || "Something changed.", url: w.url }).catch(() => {});
  }
  if (w.notify.includes("ntfy") && cfg.ntfyTopic) {
    const server = (cfg.ntfyServer || "https://ntfy.sh").replace(/\/$/, "");
    await fetch(`${server}/${encodeURIComponent(cfg.ntfyTopic)}`, {
      method: "POST",
      body: message || "Something changed.",
      headers: { Title: w.name.replace(/[^\x20-\x7e]/g, ""), Click: w.url, Tags: "eyes" },
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  }
}

export function startWatchers(hub, log) {
  let busy = false;
  const tick = async () => {
    if (busy || !hub.browsers.size) return;
    busy = true;
    try {
      for (const w of listWatchers()) {
        if (!w.enabled) continue;
        if (w.last && Date.now() - w.last.at < w.every * 60000) continue;
        try {
          const r = await runWatcher(hub, w);
          if (r.notified) log(`watcher ${w.name}: ${r.message}`);
        } catch (e) {
          const fresh = getWatcher(w.id) || w;
          fresh.last = { ...(fresh.last || {}), at: Date.now(), ok: false, error: String(e.message || e).slice(0, 300) };
          write(fresh);
        }
      }
      hub.pushWatchers?.();
    } finally {
      busy = false;
    }
  };
  setInterval(tick, 30000).unref();
  setTimeout(tick, 5000).unref();
}

export function watcherSummary(w) {
  return { id: w.id, name: w.name, url: w.url, every: w.every, mode: w.mode, enabled: w.enabled, notify: w.notify, last: w.last ? { at: w.last.at, ok: w.last.ok, message: w.last.message, error: w.last.error } : null };
}
