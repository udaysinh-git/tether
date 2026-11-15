// Before/after screenshots of styles, and publishing scripts and styles as
// secret GitHub Gists that Tampermonkey and Stylus can install from.
//
//   ~/.tether/gallery/<kind>-<id>-before.jpg, -after.jpg, index.json
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { HOME, loadConfig } from "./config.js";
import { get } from "./scripts.js";

const DIR = path.join(HOME, "gallery");
const INDEX = path.join(DIR, "index.json");

function readIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX, "utf8")); } catch { return {}; }
}

function writeIndex(idx) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2));
}

const file = (kind, id, which) => path.join(DIR, `${kind}-${id}-${which}.jpg`);

export function saveShots(kind, id, shots) {
  fs.mkdirSync(DIR, { recursive: true });
  const idx = readIndex();
  const entry = (idx[`${kind}:${id}`] ||= {});
  for (const which of ["before", "after"]) {
    const m = /^data:[^;]+;base64,(.*)$/.exec(shots[which] || "");
    if (!m) continue;
    fs.writeFileSync(file(kind, id, which), Buffer.from(m[1], "base64"));
    entry[which] = Date.now();
  }
  writeIndex(idx);
}

export function shotOf(kind, id, which) {
  const f = file(kind, id, which);
  return fs.existsSync(f) ? "data:image/jpeg;base64," + fs.readFileSync(f).toString("base64") : null;
}

export function galleryIndex() {
  return readIndex();
}

function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const acct = loadConfig().gistAccount;
  try {
    return execFileSync("gh", acct ? ["auth", "token", "-u", acct] : ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Publishing needs the GitHub CLI signed in (`gh auth login`), or GITHUB_TOKEN set." + (acct ? ` Account: ${acct}.` : ""));
  }
}

// Secret gist: not listed or searchable, but anyone with the link can install it.
export async function publishGist(kind, id) {
  const item = get(kind, id);
  if (!item) throw new Error(`No ${kind} ${id}`);
  const name = item.id + (kind === "style" ? ".user.css" : ".user.js");
  const idx = readIndex();
  const entry = (idx[`${kind}:${id}`] ||= {});
  const body = { description: `${item.name}${item.description ? ": " + item.description : ""} (${kind === "style" ? "UserCSS for Stylus" : "userscript for Tampermonkey"})`, files: { [name]: { content: item.code } } };
  const existing = entry.gist?.id;
  const res = await fetch(existing ? `https://api.github.com/gists/${existing}` : "https://api.github.com/gists", {
    method: existing ? "PATCH" : "POST",
    headers: { authorization: `Bearer ${githubToken()}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "tether" },
    body: JSON.stringify(existing ? body : { ...body, public: false }),
  });
  if (!res.ok) throw new Error(`GitHub said ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const g = await res.json();
  // The raw URL without the revision always points at the latest version.
  const raw = `https://gist.githubusercontent.com/${g.owner?.login}/${g.id}/raw/${name}`;
  entry.gist = { id: g.id, url: g.html_url, raw, at: Date.now() };
  writeIndex(idx);
  return entry.gist;
}
