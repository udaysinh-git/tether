// Scripts and styles are stored in the standard formats other managers use,
// so a file works as-is when dropped into Tampermonkey/Violentmonkey or Stylus:
//
//   ~/.tether/scripts/<id>.user.js    userscript (==UserScript== metadata)
//   ~/.tether/styles/<id>.user.css    UserCSS (==UserStyle== + @-moz-document)
//
// Agent-written code sits between "tether:body" markers so it can be read back
// and edited; files from elsewhere are kept exactly as they came.
import fs from "node:fs";
import path from "node:path";
import { SCRIPTS_DIR, STYLES_DIR } from "./config.js";

const KINDS = {
  script: { dir: () => SCRIPTS_DIR, ext: ".user.js" },
  style: { dir: () => STYLES_DIR, ext: ".user.css" },
};

const US_BLOCK = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/;
const UC_BLOCK = /\/\*\s*==UserStyle==([\s\S]*?)==\/UserStyle==\s*\*\//;
const BODY = /\/\/ tether:body start\n([\s\S]*?)\n\s*\/\/ tether:body end/;
const NAMESPACE = "tether";

export function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "item";
}

const js = (s) => JSON.stringify(String(s));

// ---------------------------------------------------------------- userscripts

function parseMeta(block, linePrefix) {
  const meta = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(linePrefix);
    if (!m) continue;
    const [, k, v = ""] = m;
    (meta[k] ||= []).push(v.trim());
  }
  return meta;
}

export function parseUserScript(id, source) {
  const m = source.match(US_BLOCK);
  const meta = m ? parseMeta(m[1], /^\s*\/\/\s*@([\w:-]+)(?:\s+(.*))?$/) : {};
  const one = (k, d = "") => meta[k]?.[0] ?? d;
  const body = source.match(BODY)?.[1];
  return {
    kind: "script",
    id,
    name: one("name", id),
    namespace: one("namespace"),
    version: one("version", "1.0.0"),
    description: one("description"),
    matches: meta.match || [],
    includes: meta.include || [],
    excludes: meta.exclude || [],
    excludeMatches: meta["exclude-match"] || [],
    runAt: one("run-at", "document-idle"),
    grants: meta.grant || [],
    requires: meta.require || [],
    run: one("tether-run", "auto") === "manual" ? "manual" : "auto",
    body: body !== undefined ? dedent(body) : undefined,
    code: source,
  };
}

const GRANTS = ["GM_addStyle", "GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues", "GM_registerMenuCommand", "GM_openInTab", "GM_setClipboard", "GM_notification", "GM_xmlhttpRequest", "unsafeWindow"];

export function buildUserScript({ name, description = "", matches = [], run = "manual", runAt = "document-idle", version = "1.0.0", code }) {
  const used = GRANTS.filter((g) => code.includes(g));
  if (run === "manual" && !used.includes("GM_registerMenuCommand")) used.push("GM_registerMenuCommand");
  const pad = (k) => `// @${k.padEnd(13)}`;
  const lines = [
    "// ==UserScript==",
    `${pad("name")}${name}`,
    `${pad("namespace")}${NAMESPACE}`,
    `${pad("version")}${version}`,
  ];
  if (description) lines.push(`${pad("description")}${description.replace(/\r?\n/g, " ")}`);
  for (const m of matches.length ? matches : ["*://*/*"]) lines.push(`${pad("match")}${m === "<all_urls>" ? "*://*/*" : m}`);
  for (const g of used.length ? used : ["none"]) lines.push(`${pad("grant")}${g}`);
  lines.push(`${pad("run-at")}${runAt}`, `${pad("tether-run")}${run === "auto" ? "auto" : "manual"}`, "// ==/UserScript==", "");
  const inner = indent(code.trim(), run === "manual" ? 4 : 2);
  const body =
    run === "manual"
      ? [
          "(function () {",
          "  // Manual: a menu command in Tampermonkey and Violentmonkey, the Run button in Tether.",
          "  const run = function () {",
          "    // tether:body start",
          inner,
          "    // tether:body end",
          "  };",
          `  return typeof GM_registerMenuCommand === "function" ? GM_registerMenuCommand(${js(name)}, run) : run();`,
          "})();",
        ]
      : ["(function () {", "  // tether:body start", inner, "  // tether:body end", "})();"];
  return lines.join("\n") + body.join("\n") + "\n";
}

// ---------------------------------------------------------------- UserCSS

// Splits UserCSS into @-moz-document sections. Rules outside any section apply everywhere.
export function parseSections(css) {
  const sections = [];
  let global = "";
  let i = 0;
  const re = /@-moz-document\s+/g;
  let m;
  while ((m = re.exec(css))) {
    global += css.slice(i, m.index);
    const open = css.indexOf("{", re.lastIndex);
    if (open < 0) break;
    const rules = [];
    const head = css.slice(re.lastIndex, open);
    for (const r of head.matchAll(/(url-prefix|url|domain|regexp)\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*))\s*\)/g)) {
      rules.push({ fn: r[1], arg: (r[2] ?? r[3] ?? r[4] ?? "").replace(/\\\\/g, "\\") });
    }
    let depth = 1, j = open + 1;
    while (j < css.length && depth) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      else if (css[j] === "/" && css[j + 1] === "*") { const end = css.indexOf("*/", j + 2); j = end < 0 ? css.length : end + 1; }
      else if (css[j] === '"' || css[j] === "'") { const q = css[j]; j++; while (j < css.length && css[j] !== q) j += css[j] === "\\" ? 2 : 1; }
      j++;
    }
    sections.push({ rules, css: css.slice(open + 1, j - 1).trim() });
    i = j;
    re.lastIndex = j;
  }
  global += css.slice(i);
  global = global.replace(UC_BLOCK, "").trim();
  if (global) sections.unshift({ rules: [], css: global });
  return sections;
}

export function parseUserStyle(id, source) {
  const m = source.match(UC_BLOCK);
  const meta = m ? parseMeta(m[1], /^\s*@([\w:-]+)(?:\s+(.*))?$/) : {};
  const one = (k, d = "") => meta[k]?.[0] ?? d;
  const sections = parseSections(source);
  const vars = (meta.var || []).length > 0;
  const preprocessor = one("preprocessor", "default");
  return {
    kind: "style",
    id,
    name: one("name", id),
    namespace: one("namespace"),
    version: one("version", "1.0.0"),
    description: one("description"),
    matches: sections.flatMap((s) => s.rules.map((r) => `${r.fn}(${r.arg})`)),
    sections,
    unsupported: preprocessor !== "default" ? `uses the ${preprocessor} preprocessor` : vars ? "has @var settings; their default values are used" : "",
    vars: vars ? meta.var : [],
    body: ((b) => (b === undefined ? undefined : dedent(b)))(source.match(/\/\* tether:css start \*\/\n([\s\S]*?)\n\s*\/\* tether:css end \*\//)?.[1]),
    code: source,
  };
}

// Match pattern -> @-moz-document rule, so the file works in Stylus.
function docRule(pattern) {
  if (pattern === "<all_urls>" || pattern === "*://*/*") return null;
  const m = pattern.match(/^(\*|https?|file):\/\/([^/]*)(\/.*)$/);
  if (!m) return `regexp(${js(pattern)})`;
  const [, scheme, host, p] = m;
  const pathIsAll = p === "/*";
  if (scheme === "*" && pathIsAll) return host.startsWith("*.") ? `domain(${js(host.slice(2))})` : `domain(${js(host)})`;
  if (!host.includes("*") && /^[^*]*\*?$/.test(p)) return `url-prefix(${js(`${scheme === "*" ? "https" : scheme}://${host}${p.replace(/\*$/, "")}`)})`;
  const rx = "^" + (scheme === "*" ? "https?" : scheme) + "://" + host.replace(/\./g, "\\.").replace(/^\*\\\./, "([^/]+\\.)?").replace(/\*/g, "[^/]*") + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
  return `regexp(${js(rx)})`;
}

export function buildUserStyle({ name, description = "", matches = [], version = "1.0.0", css }) {
  const pad = (k) => `@${k.padEnd(13)}`;
  const lines = ["/* ==UserStyle==", `${pad("name")}${name}`, `${pad("namespace")}${NAMESPACE}`, `${pad("version")}${version}`];
  if (description) lines.push(`${pad("description")}${description.replace(/\r?\n/g, " ")}`);
  lines.push("==/UserStyle== */", "");
  const rules = [...new Set(matches.map(docRule))];
  const body = `/* tether:css start */\n${css.trim()}\n/* tether:css end */`;
  if (rules.includes(null) || !rules.length) return lines.join("\n") + body + "\n";
  return lines.join("\n") + `@-moz-document ${rules.join(", ")} {\n${indent(body, 2)}\n}\n`;
}

// ---------------------------------------------------------------- files

const parsers = { script: parseUserScript, style: parseUserStyle };

export function list(kind = "script") {
  const { dir, ext } = KINDS[kind];
  fs.mkdirSync(dir(), { recursive: true });
  return fs
    .readdirSync(dir())
    .filter((f) => f.endsWith(ext))
    .sort()
    .map((f) => parsers[kind](f.slice(0, -ext.length), fs.readFileSync(path.join(dir(), f), "utf8")));
}

export function get(kind, idOrName) {
  const all = list(kind);
  const n = String(idOrName).toLowerCase();
  return all.find((s) => s.id === idOrName) || all.find((s) => s.name.toLowerCase() === n) || all.find((s) => s.id === slug(idOrName));
}

function bump(v) {
  const p = String(v || "1.0.0").split(".").map((x) => parseInt(x, 10) || 0);
  while (p.length < 3) p.push(0);
  p[2]++;
  return p.join(".");
}

export function save(kind, input) {
  const { dir, ext } = KINDS[kind];
  const id = slug(input.name);
  const prev = get(kind, id);
  const version = prev ? bump(prev.version) : "1.0.0";
  const text = kind === "style" ? buildUserStyle({ ...input, version }) : buildUserScript({ ...input, version });
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), id + ext), text);
  return get(kind, id);
}

// Files from Greasy Fork, OpenUserJS, userstyles.world or a friend, kept as they are.
export function importText(text, filename = "") {
  const kind = US_BLOCK.test(text) ? "script" : UC_BLOCK.test(text) ? "style" : null;
  if (!kind) throw new Error("Not a userscript (==UserScript==) or UserCSS (==UserStyle==) file.");
  const parsed = parsers[kind]("x", text);
  const id = slug(parsed.name !== "x" ? parsed.name : filename.replace(/\.user\.(js|css)$/, ""));
  const { dir, ext } = KINDS[kind];
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), id + ext), text);
  return get(kind, id);
}

export function remove(kind, idOrName) {
  const s = get(kind, idOrName);
  if (!s) return false;
  const { dir, ext } = KINDS[kind];
  fs.rmSync(path.join(dir(), s.id + ext));
  return true;
}

export function watchAll(onChange) {
  let timer;
  for (const { dir } of Object.values(KINDS)) {
    fs.mkdirSync(dir(), { recursive: true });
    try {
      fs.watch(dir(), () => {
        clearTimeout(timer);
        timer = setTimeout(onChange, 150);
      });
    } catch {}
  }
}

function indent(s, n) {
  const pad = " ".repeat(n);
  return s.split("\n").map((l) => (l ? pad + l : l)).join("\n");
}

function dedent(s) {
  const lines = s.split("\n");
  const min = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(Number.isFinite(min) ? min : 0)).join("\n");
}

export const listScripts = () => list("script");
export const getScript = (n) => get("script", n);
export const saveScript = (i) => save("script", i);
export const deleteScript = (n) => remove("script", n);
