// `tether setup`: finds the coding agents on this machine and adds Tether to
// each one's MCP config, then links the skill. `tether doctor` uses the same
// code with write off to report what is missing.
//
// Each agent's file is touched as little as possible: one entry is added or
// replaced, the rest of the file is left as it was, and a file that can't be
// read safely is left alone with the snippet printed instead.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";

const exists = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p, "utf8");
const indentOf = (text) => /\n([ \t]+)"/.exec(text)?.[1] || "  ";
const tilde = (home, p) => (p.startsWith(home) ? "~" + p.slice(home.length).replace(/\\/g, "/") : p);

// The config an agent needs, as text to paste. Also what `setup --print` shows.
export function snippets(node, cli) {
  const sh = (s) => (/\s/.test(s) ? `"${s}"` : s);
  const lit = (s) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);
  return {
    claude: `claude mcp add --scope user tether -- ${sh(node)} ${sh(cli)}`,
    codex: `[mcp_servers.tether]\ncommand = ${lit(node)}\nargs = [${lit(cli)}]`,
    cursor: JSON.stringify({ mcpServers: { tether: { command: node, args: [cli] } } }, null, 2),
    opencode: JSON.stringify({ mcp: { tether: { type: "local", command: [node, cli] } } }, null, 2),
    other: `${sh(node)} ${sh(cli)}`,
  };
}

// Runs a command the way a terminal would, so `claude` resolves on Windows
// too, where it is a .cmd or .exe on PATH.
function shell(cmd, args) {
  if (process.platform !== "win32") return execFileSync(cmd, args, { stdio: "pipe", encoding: "utf8" });
  return execSync([cmd, ...args.map((a) => (/[\s"]/.test(a) ? `"${a}"` : a))].join(" "), { stdio: "pipe", encoding: "utf8" });
}

// JSON with comments and trailing commas, as OpenCode and Cursor accept.
function parseJsonc(text) {
  let out = "", i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      i = i < 0 ? text.length : i + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => path.normalize(String(x)) === path.normalize(b[i]));

function claude({ home, node, cli, write, run }) {
  const file = path.join(home, ".claude.json");
  if (!exists(file) && !exists(path.join(home, ".claude"))) return null;
  let entry = null;
  try { entry = JSON.parse(read(file)).mcpServers?.tether || null; } catch {}
  if (entry && sameList([entry.command, ...(entry.args || [])], [node, cli])) return { status: "ok" };
  if (!write) return { status: "missing" };
  try {
    if (entry) { try { run("claude", ["mcp", "remove", "--scope", "user", "tether"]); } catch {} }
    run("claude", ["mcp", "add", "--scope", "user", "tether", "--", node, cli]);
    return { status: entry ? "updated" : "added", where: "claude mcp add" };
  } catch {
    return { status: "manual", why: "the claude command isn't on your PATH, so run this yourself", snippet: snippets(node, cli).claude };
  }
}

function codex({ home, node, cli, write }) {
  const dir = path.join(home, ".codex");
  if (!exists(dir)) return null;
  const file = path.join(dir, "config.toml");
  const text = exists(file) ? read(file) : "";
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[mcp_servers\.tether\]\s*$/.test(l));
  const block = snippets(node, cli).codex;
  if (start < 0) {
    if (!write) return { status: "missing" };
    fs.writeFileSync(file, text + (text && !text.endsWith("\n") ? "\n" : "") + (text.trim() ? "\n" : "") + block + "\n");
    return { status: "added", where: file };
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  const body = lines.slice(start + 1, end);
  const raw = body.join("\n");
  // Paths may be written with either slash, and with backslashes doubled.
  const flat = (s) => s.replace(/\\\\/g, "\\").replace(/\\/g, "/");
  // A lone backslash inside double quotes (a pasted Windows path) is invalid TOML.
  const badEscape = /"[^"\n]*\\[^nrtbfu"][^"\n]*"/.test(raw.replace(/\\\\/g, ""));
  const good = flat(raw).includes(flat(cli)) && flat(raw).includes(flat(node)) && !badEscape;
  if (good) return { status: "ok" };
  if (!write) return { status: "missing" };
  // Replace command and args, keep anything else the user set (env, timeouts).
  const kept = [];
  for (let i = 0; i < body.length; i++) {
    if (!/^\s*(command|args)\s*=/.test(body[i])) { kept.push(body[i]); continue; }
    if (/^\s*args\s*=/.test(body[i])) while (!body[i].includes("]") && i < body.length - 1) i++;
  }
  lines.splice(start, end - start, ...block.split("\n"), ...kept);
  fs.writeFileSync(file, lines.join("\n"));
  return { status: "updated", where: file };
}

function cursor({ home, node, cli, write }) {
  const dir = path.join(home, ".cursor");
  if (!exists(dir)) return null;
  const file = path.join(dir, "mcp.json");
  const want = { command: node, args: [cli] };
  const text = exists(file) ? read(file) : "";
  let cfg = {};
  if (text.trim()) {
    try { cfg = JSON.parse(text); } catch { return write ? { status: "manual", why: `${file} isn't plain JSON, so merge this in yourself`, snippet: snippets(node, cli).cursor } : { status: "missing" }; }
  }
  const cur = cfg.mcpServers?.tether;
  if (cur && sameList([cur.command, ...(cur.args || [])], [node, cli])) return { status: "ok" };
  if (!write) return { status: "missing" };
  cfg.mcpServers = { ...cfg.mcpServers, tether: { ...cur, ...want } };
  fs.writeFileSync(file, JSON.stringify(cfg, null, text ? indentOf(text) : 2) + "\n");
  return { status: cur ? "updated" : "added", where: file };
}

function opencode({ home, node, cli, write }) {
  const dir = path.join(home, ".config", "opencode");
  if (!exists(dir)) return null;
  const file = ["opencode.json", "opencode.jsonc"].map((f) => path.join(dir, f)).find(exists) || path.join(dir, "opencode.json");
  const want = { type: "local", command: [node, cli] };
  const manual = (why) => (write ? { status: "manual", why, snippet: snippets(node, cli).opencode } : { status: "missing" });
  const text = exists(file) ? read(file) : "";
  let cfg = {}, plain = true;
  if (text.trim()) {
    try { cfg = JSON.parse(text); } catch {
      plain = false;
      try { cfg = parseJsonc(text); } catch { return manual(`${file} couldn't be read, so merge this in yourself`); }
    }
  }
  // OpenCode 2 groups servers under mcp.servers; older configs put them in mcp.
  const v2 = cfg.mcp?.servers && typeof cfg.mcp.servers === "object";
  const cur = v2 ? cfg.mcp.servers.tether : cfg.mcp?.tether;
  if (cur && sameList(cur.command, [node, cli])) return { status: "ok" };
  if (!write) return { status: "missing" };
  if (plain) {
    if (v2) cfg.mcp.servers.tether = { ...cur, ...want };
    else cfg.mcp = { ...cfg.mcp, tether: { ...cur, ...want } };
    if (!text.trim()) cfg = { $schema: "https://opencode.ai/config.json", ...cfg };
    fs.writeFileSync(file, JSON.stringify(cfg, null, text ? indentOf(text) : 2) + "\n");
    return { status: cur ? "updated" : "added", where: file };
  }
  // A file with comments is edited as text so the comments survive. That is
  // only safe when it has no mcp section yet: the entry goes in as the first key.
  if (cfg.mcp) return manual(`${file} has comments and already has an mcp section, so add this entry to it yourself`);
  const open = text.indexOf("{");
  const pad = indentOf(text);
  const entry = JSON.stringify({ tether: want }, null, pad).split("\n").map((l, i) => (i ? pad + l : l)).join("\n");
  fs.writeFileSync(file, `${text.slice(0, open + 1)}\n${pad}"mcp": ${entry}${Object.keys(cfg).length ? "," : ""}${text.slice(open + 1)}`);
  return { status: "added", where: file };
}

const AGENTS = [
  { id: "claude", name: "Claude Code", fn: claude },
  { id: "codex", name: "Codex", fn: codex },
  { id: "cursor", name: "Cursor", fn: cursor },
  { id: "opencode", name: "OpenCode", fn: opencode },
];

// Looks at every known agent. Returns one row per agent that is installed:
// status is ok, added, updated, missing (write was off) or manual (the user
// has to paste `snippet`, for the reason in `why`).
export function setupAgents({ home = os.homedir(), node = process.execPath, cli, write = true, run = shell } = {}) {
  const rows = [];
  for (const a of AGENTS) {
    let r;
    try { r = a.fn({ home, node, cli, write, run }); } catch (e) { r = { status: "manual", why: `couldn't update it (${e.message}), so add this yourself`, snippet: snippets(node, cli)[a.id] }; }
    if (r) rows.push({ id: a.id, name: a.name, ...r });
  }
  return rows;
}

// Agents read skills from these folders. Cursor and OpenCode read ~/.agents
// and ~/.claude, so three links cover all four agents.
export function linkSkill({ home = os.homedir(), skillDir, write = true } = {}) {
  const has = (d) => exists(path.join(home, d));
  const wanted = [
    has(".claude") && ".claude/skills",
    has(".codex") && ".codex/skills",
    (has(".agents") || has(".codex") || has(".cursor") || has(".config/opencode")) && ".agents/skills",
  ].filter(Boolean);
  const rows = [];
  for (const d of wanted) {
    const link = path.join(home, d, "tether-browser");
    let stat = null;
    try { stat = fs.lstatSync(link); } catch {}
    const isLink = !!stat?.isSymbolicLink();
    let target = "";
    if (isLink) { try { target = fs.readlinkSync(link); } catch {} }
    const current = isLink && path.resolve(target.replace(/^\\\\\?\\/, "")) === path.resolve(skillDir) && exists(path.join(link, "SKILL.md"));
    if (current) { rows.push({ dir: d, status: "ok" }); continue; }
    // A real folder is the user's own copy: leave it. Only a stale link is replaced.
    if (stat && !isLink) { rows.push({ dir: d, status: exists(path.join(link, "SKILL.md")) ? "own" : "manual" }); continue; }
    if (!write) { rows.push({ dir: d, status: "missing" }); continue; }
    try {
      if (isLink) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } }
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(skillDir, link, process.platform === "win32" ? "junction" : "dir");
      rows.push({ dir: d, status: isLink ? "updated" : "added" });
    } catch (e) {
      rows.push({ dir: d, status: "manual", why: e.message });
    }
  }
  return rows;
}

export { tilde };
