// User scripts live as plain .js files in ~/.tether/scripts so they work in
// every browser and can be edited by hand. Each file starts with a header:
//
//   // ==Tether==
//   // @name        Fill timesheet
//   // @description Fills this week's hours from the defaults
//   // @match       https://erp.example.com/*
//   // @run         manual            (manual | auto)
//   // ==/Tether==
import fs from "node:fs";
import path from "node:path";
import { SCRIPTS_DIR } from "./config.js";

const HEADER = /\/\/\s*==Tether==([\s\S]*?)\/\/\s*==\/Tether==/;

export function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "script";
}

export function parseScript(id, source) {
  const meta = { id, name: id, description: "", matches: [], run: "manual" };
  const m = source.match(HEADER);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^\s*\/\/\s*@(\w+)\s+(.+?)\s*$/);
      if (!kv) continue;
      const [, k, v] = kv;
      if (k === "match") meta.matches.push(v);
      else if (k === "name") meta.name = v;
      else if (k === "description") meta.description = v;
      else if (k === "run") meta.run = v === "auto" ? "auto" : "manual";
    }
  }
  if (!meta.matches.length) meta.matches = ["<all_urls>"];
  return { ...meta, code: source };
}

export function buildSource({ name, description = "", matches = [], run = "manual", code }) {
  const lines = ["// ==Tether==", `// @name        ${name}`];
  if (description) lines.push(`// @description ${description.replace(/\r?\n/g, " ")}`);
  for (const m of matches.length ? matches : ["<all_urls>"]) lines.push(`// @match       ${m}`);
  lines.push(`// @run         ${run === "auto" ? "auto" : "manual"}`, "// ==/Tether==", "");
  return lines.join("\n") + code.replace(HEADER, "").trimStart();
}

export function listScripts() {
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  return fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => parseScript(f.slice(0, -3), fs.readFileSync(path.join(SCRIPTS_DIR, f), "utf8")));
}

export function getScript(idOrName) {
  const all = listScripts();
  return all.find((s) => s.id === idOrName) || all.find((s) => s.name.toLowerCase() === String(idOrName).toLowerCase()) || all.find((s) => s.id === slug(idOrName));
}

export function saveScript(input) {
  const id = slug(input.name);
  fs.writeFileSync(path.join(SCRIPTS_DIR, id + ".js"), buildSource(input));
  return getScript(id);
}

export function deleteScript(idOrName) {
  const s = getScript(idOrName);
  if (!s) return false;
  fs.rmSync(path.join(SCRIPTS_DIR, s.id + ".js"));
  return true;
}

export function watchScripts(onChange) {
  let timer;
  try {
    fs.watch(SCRIPTS_DIR, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 150);
    });
  } catch {}
}
