// Recorded sessions and what we learn from them, one folder per site:
//
//   ~/.tether/sites/<host>/sessions/<id>.jsonl   one event per line
//   ~/.tether/sites/<host>/sessions/<id>.json    session summary
//   ~/.tether/sites/<host>/pages/<hash>.txt      page outlines, stored once
//   ~/.tether/sites/<host>/notes.md              what agents wrote down about the site
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SITES_DIR } from "./config.js";

export const safe = (h) => String(h).toLowerCase().replace(/[^a-z0-9.\-]/g, "_");

function dir(host, ...sub) {
  const d = path.join(SITES_DIR, safe(host), ...sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function hostOf(url) {
  try { return new URL(url).host || "local"; } catch { return "unknown"; }
}

// Collapse ids in paths so /orders/48213/edit and /orders/50117/edit are one page.
export function normPath(url) {
  let u;
  try { u = new URL(url); } catch { return url; }
  const p = u.pathname
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) || /^[0-9a-f-]{32,36}$/i.test(seg) || (seg.length > 20 && /\d/.test(seg) && /[a-z]/i.test(seg)) ? ":id" : seg))
    .join("/");
  const keys = [...u.searchParams.keys()].sort();
  return (p || "/") + (keys.length ? "?" + keys.join("&") : "") + (u.hash.startsWith("#/") ? u.hash.split("?")[0].replace(/\/\d+/g, "/:id") : "");
}

export function ingest(browserKey, events) {
  const groups = new Map();
  for (const e of events) {
    const host = hostOf(e.url);
    if (e.kind === "page" && e.outline) {
      const hash = crypto.createHash("sha1").update(e.outline).digest("hex").slice(0, 12);
      const f = path.join(dir(host, "pages"), hash + ".txt");
      if (!fs.existsSync(f)) fs.writeFileSync(f, e.outline);
      e.lines = e.outline.split("\n").length;
      e.outline = undefined;
      e.page = hash;
    }
    const k = host + "\n" + e.session;
    if (!groups.has(k)) groups.set(k, { host, session: e.session, list: [] });
    groups.get(k).list.push(e);
  }
  for (const { host, session, list } of groups.values()) {
    const d = dir(host, "sessions");
    fs.appendFileSync(path.join(d, session + ".jsonl"), list.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const metaFile = path.join(d, session + ".json");
    let meta = { id: session, browser: browserKey, started: list[0].t, events: 0, startUrl: list[0].url };
    try { meta = JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch {}
    meta.events += list.length;
    meta.ended = list.at(-1).t;
    meta.started = Math.min(meta.started, list[0].t);
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  }
}

export function listSites() {
  if (!fs.existsSync(SITES_DIR)) return [];
  return fs
    .readdirSync(SITES_DIR)
    .map((host) => {
      const sessions = sessionsOf(host);
      const notes = fs.existsSync(path.join(SITES_DIR, host, "notes.md"));
      let flows = 0;
      try { flows = fs.readdirSync(path.join(SITES_DIR, host, "flows")).filter((f) => f.endsWith(".json")).length; } catch {}
      return { host, sessions: sessions.length, events: sessions.reduce((n, s) => n + s.events, 0), last: Math.max(0, ...sessions.map((s) => s.ended || 0)), notes, flows };
    })
    .filter((s) => s.sessions || s.notes || s.flows)
    .sort((a, b) => b.last - a.last);
}

export function sessionsOf(host) {
  const d = path.join(SITES_DIR, safe(host), "sessions");
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), "utf8")); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.started - a.started);
}

export function eventsOf(host, session) {
  const f = path.join(SITES_DIR, safe(host), "sessions", session + ".jsonl");
  if (!fs.existsSync(f)) return [];
  // Page events arrive in batches a moment after network events, so order by time.
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).sort((a, b) => a.t - b.t);
}

export function resolveHost(site) {
  const s = safe(String(site).replace(/^https?:\/\//, "").split("/")[0]);
  const all = fs.existsSync(SITES_DIR) ? fs.readdirSync(SITES_DIR) : [];
  const hit = all.find((h) => h === s) || all.find((h) => h.endsWith("." + s) || h === "www." + s) || all.find((h) => h.includes(s));
  if (!hit) throw new Error(`Nothing recorded for ${site}. Recorded sites: ${all.join(", ") || "none yet"}.`);
  return hit;
}

const q = JSON.stringify;
const time = (t) => new Date(t).toISOString().replace("T", " ").slice(0, 19);
const el = (x) => (x ? `${x.role || x.tag} ${q(x.name || x.text || "")}${x.selector ? ` [${x.selector}]` : ""}` : "?");

export function formatEvent(e) {
  const where = e.url ? `  @ ${normPath(e.url)}` : "";
  switch (e.kind) {
    case "nav": return `open    ${e.url}  ${q(e.title || "")}`;
    case "page": return `page    ${normPath(e.url)}  outline ${e.page} (${e.lines} lines)`;
    case "click": return `click   ${el(e.target)}${e.target?.context ? `  in ${q(e.target.context)}` : ""}${where}`;
    case "input": return `type    ${el(e.target)} = ${e.value === undefined ? "(not recorded)" : q(e.value)}${where}`;
    case "select": return `pick    ${el(e.target)} = ${q(e.value)}${where}`;
    case "toggle": return `check   ${el(e.target)} ${e.value ? "on" : "off"}${where}`;
    case "submit": return `submit  ${el(e.target)}${where}`;
    case "key": return `key     ${e.key} on ${el(e.target)}${where}`;
    case "net": return `api     ${e.method} ${e.url.replace(/^https?:\/\/[^/]+/, "")}  ${e.status ?? "ERR"}${e.ms != null ? `  ${e.ms}ms` : ""}`;
    default: return `${e.kind}  ${where}`;
  }
}

export function readSession(host, session, { from = 0, limit = 200 } = {}) {
  const events = eventsOf(host, session);
  if (!events.length) throw new Error(`No session ${session} for ${host}.`);
  const slice = events.slice(from, from + limit);
  const lines = slice.map((e, i) => `${String(from + i).padStart(4)}  ${time(e.t).slice(11)}  ${formatEvent(e)}`);
  if (from + limit < events.length) lines.push(`… ${events.length - from - limit} more. Call again with from=${from + limit}.`);
  return `Session ${session} on ${host}, ${time(events[0].t)}, ${events.length} events\n\n` + lines.join("\n");
}

export function readPage(host, hash) {
  const f = path.join(SITES_DIR, safe(host), "pages", hash + ".txt");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
}

export function readNotes(host) {
  const f = path.join(SITES_DIR, safe(host), "notes.md");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
}

export function writeNotes(host, text, append) {
  const f = path.join(dir(host), "notes.md");
  if (append) fs.appendFileSync(f, (fs.existsSync(f) ? "\n" : "") + text.trimEnd() + "\n");
  else fs.writeFileSync(f, text.trimEnd() + "\n");
}

// Everything recorded for a site, folded into one map an agent can read.
export function siteMap(host, { page } = {}) {
  const sessions = sessionsOf(host);
  const pages = new Map();
  const apis = new Map();
  const flows = new Map();
  let total = 0;

  const pageOf = (p) => {
    if (!pages.has(p)) pages.set(p, { path: p, visits: 0, titles: new Set(), outline: null, outlineAt: 0, actions: new Map(), fields: new Map() });
    return pages.get(p);
  };

  for (const s of sessions) {
    let prev = null;
    for (const e of eventsOf(host, s.id)) {
      total++;
      const p = e.url ? normPath(e.url) : null;
      if (e.kind === "nav" && p) {
        const pg = pageOf(p);
        pg.visits++;
        if (e.title) pg.titles.add(e.title);
        if (prev && prev !== p) flows.set(`${prev} -> ${p}`, (flows.get(`${prev} -> ${p}`) || 0) + 1);
        prev = p;
      } else if (e.kind === "page" && p) {
        const pg = pageOf(p);
        if (e.t >= pg.outlineAt) { pg.outline = e.page; pg.outlineAt = e.t; }
      } else if (["click", "submit", "key"].includes(e.kind) && p && e.target) {
        const pg = pageOf(p);
        const k = e.kind + "|" + (e.target.selector || e.target.role + e.target.name);
        const a = pg.actions.get(k) || { kind: e.kind, target: e.target, key: e.key, count: 0 };
        a.count++;
        pg.actions.set(k, a);
      } else if (["input", "select", "toggle"].includes(e.kind) && p && e.target) {
        const pg = pageOf(p);
        const k = e.target.selector || e.target.role + e.target.name;
        const f = pg.fields.get(k) || { target: e.target, kind: e.kind, count: 0, examples: new Set() };
        f.count++;
        if (e.value !== undefined && e.value !== "(hidden)" && f.examples.size < 3) f.examples.add(String(e.value).slice(0, 60));
        pg.fields.set(k, f);
      } else if (e.kind === "net") {
        let u;
        try { u = new URL(e.url); } catch { continue; }
        const k = `${e.method} ${safe(u.host) === host ? "" : u.host}${normPath(e.url)}`;
        const a = apis.get(k) || { count: 0, statuses: new Set(), from: new Set() };
        a.count++;
        a.statuses.add(e.status ?? "ERR");
        if (prev) a.from.add(prev);
        apis.set(k, a);
      }
    }
  }

  if (page) {
    const want = page.startsWith("/") ? page : "/" + page;
    const pg = pages.get(want) || [...pages.values()].find((x) => x.path.startsWith(want));
    if (!pg) throw new Error(`No page ${page} on ${host}. Pages: ${[...pages.keys()].slice(0, 30).join(", ")}`);
    const out = [`${host}${pg.path}  ${[...pg.titles].map((t) => q(t)).join(", ")}  visited ${pg.visits} times`];
    if (pg.actions.size) out.push("\nWhat the user does here:", ...[...pg.actions.values()].sort((a, b) => b.count - a.count).map((a) => `  ${a.kind}${a.key ? " " + a.key : ""} ${el(a.target)} ×${a.count}${a.target.context ? `  in ${q(a.target.context)}` : ""}`));
    if (pg.fields.size) out.push("\nFields they fill:", ...[...pg.fields.values()].map((f) => `  ${el(f.target)}${f.examples.size ? "  e.g. " + [...f.examples].map((x) => q(x)).join(", ") : ""}`));
    const outline = pg.outline && readPage(host, pg.outline);
    if (outline) out.push(`\nLatest outline (refs are from that recording, take a fresh snapshot before acting):\n${outline}`);
    return out.join("\n");
  }

  const notes = readNotes(host);
  const out = [`Site: ${host}`, `Recorded: ${sessions.length} sessions, ${total} events${sessions.length ? `, ${time(sessions.at(-1).started).slice(0, 10)} to ${time(sessions[0].ended || sessions[0].started).slice(0, 10)}` : ""}`];
  if (notes) out.push("", "Notes:", notes.trim());
  const byVisits = [...pages.values()].sort((a, b) => b.visits - a.visits || b.actions.size - a.actions.size);
  if (byVisits.length) {
    out.push("", "Pages, most visited first:");
    for (const pg of byVisits.slice(0, 40)) {
      out.push(`${pg.path}  ${pg.titles.size ? q([...pg.titles][0]) : ""}  ${pg.visits} visits`);
      const acts = [...pg.actions.values()].sort((a, b) => b.count - a.count).slice(0, 8);
      if (acts.length) out.push("  uses: " + acts.map((a) => `${el(a.target)} ×${a.count}`).join("; "));
      const fields = [...pg.fields.values()].slice(0, 8);
      if (fields.length) out.push("  fills: " + fields.map((f) => el(f.target)).join("; "));
    }
  }
  if (apis.size) {
    out.push("", "API calls the site makes:");
    for (const [k, a] of [...apis].sort((x, y) => y[1].count - x[1].count).slice(0, 40)) out.push(`${k}  ${[...a.statuses].join("/")} ×${a.count}${a.from.size ? `  (on ${[...a.from].slice(0, 3).join(", ")})` : ""}`);
  }
  if (flows.size) {
    out.push("", "Common paths:");
    for (const [k, n] of [...flows].sort((a, b) => b[1] - a[1]).slice(0, 15)) out.push(`${k} ×${n}`);
  }
  out.push("", 'For one page in detail (what is clicked there, fields, the full outline) call site_map with page="/path".');
  return out.join("\n");
}
