// `tether doctor`: checks every piece Tether needs and says what to fix.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, HOME } from "./config.js";
import { health } from "./shim.js";
import { setupAgents, linkSkill } from "./setup.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "host", "cli.js");

export async function doctor() {
  const rows = [];
  const check = (ok, what, fix = "") => rows.push({ ok, what, fix });
  const cfg = loadConfig();

  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 20, `Node ${process.versions.node}`, "Install Node 20 or newer.");
  check(!!cfg.key, `Config and pairing key in ${HOME}`, "Run `node host/cli.js key` to create one.");

  // Extension builds (only in a source checkout; an npm install has no
  // extension/ folder, and the extension comes from the release instead)
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const fromSource = fs.existsSync(path.join(ROOT, "extension"));
  if (!fromSource) check(true, `Installed from npm (v${pkg.version}); get the extension from the Chrome Web Store (https://chromewebstore.google.com/detail/tether/bdkhlojbkkldeehiolelnmnpaanjdncc) or Firefox Add-ons (https://addons.mozilla.org/firefox/addon/tether/)`);
  for (const b of fromSource ? ["chrome", "firefox"] : []) {
    const m = path.join(ROOT, "dist", b, "manifest.json");
    const built = fs.existsSync(m);
    const stale = built && newestIn(path.join(ROOT, "extension")) > fs.statSync(m).mtimeMs;
    check(built && !stale, `Extension built for ${b}${built ? ` (v${JSON.parse(fs.readFileSync(m, "utf8")).version})` : ""}`, built ? "extension/ changed since the last build: run `npm run build`, then reload the extension." : "Run `npm run build`.");
  }

  // Firefox bridge
  if (process.platform === "win32") {
    let manifest = "";
    try {
      const out = execFileSync("reg", ["query", "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\tether", "/ve"], { encoding: "utf8" });
      manifest = out.match(/REG_SZ\s+(.+)/)?.[1]?.trim() || "";
    } catch {}
    const launcher = manifest && fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")).path : "";
    const launcherOk = launcher && fs.existsSync(launcher) && fs.readFileSync(launcher, "utf8").includes(path.join(ROOT, "host", "native.js"));
    check(!!launcherOk, "Firefox/Zen bridge registered", "Run `tether setup`.");
    let chromium = false;
    try { chromium = /REG_SZ/.test(execFileSync("reg", ["query", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\tether", "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch {}
    check(chromium, "Chrome/Brave/Edge bridge registered (connects without a pairing key)", "Run `tether setup`.");
  } else {
    const mac = process.platform === "darwin";
    const p = mac ? "Library/Application Support/Mozilla/NativeMessagingHosts/tether.json" : ".mozilla/native-messaging-hosts/tether.json";
    check(fs.existsSync(path.join(os.homedir(), p)), "Firefox bridge registered", "Run `tether setup`.");
    const c = mac ? "Library/Application Support/Google/Chrome/NativeMessagingHosts/tether.json" : ".config/google-chrome/NativeMessagingHosts/tether.json";
    check(fs.existsSync(path.join(os.homedir(), c)), "Chrome/Brave/Edge bridge registered (connects without a pairing key)", "Run `tether setup`.");
  }

  // Host and browsers
  const h = await health(cfg.port);
  if (h) {
    check(true, `Host running on 127.0.0.1:${cfg.port}`);
    check(h.browsers.length > 0, `Browsers connected: ${h.browsers.join(", ") || "none"}`, "Open the browser with Tether installed; it connects by itself. If the Tether popup shows Connect, press it. In Firefox or Zen, reload the extension if it doesn't.");
    check(true, `Agents connected: ${h.agents.join(", ") || "none right now"}`);
  } else {
    check(true, `Host not running (starts when an agent or the Firefox bridge needs it)`);
    const busy = portBusy(cfg.port);
    if (busy) check(false, `Port ${cfg.port} is taken by another program`, `Free it, or set a different "port" in ${path.join(HOME, "config.json")} and in Tether's settings.`);
  }

  // Agents and the skill: the same checks `tether setup` makes, without writing.
  const agents = setupAgents({ cli: CLI, write: false });
  if (!agents.length) check(true, "No Claude Code, Codex, Cursor or OpenCode found (for another MCP client, see `tether setup --print`)");
  for (const a of agents) check(a.status === "ok", `${a.name} has the tether MCP server`, "Run `tether setup`.");
  for (const l of linkSkill({ skillDir: path.join(ROOT, "skills", "tether-browser"), write: false })) {
    check(l.status === "ok" || l.status === "own", `Skill installed in ~/${l.dir}`, l.status === "manual" ? `~/${l.dir}/tether-browser exists but has no SKILL.md. Remove it and run \`tether setup\`.` : "Run `tether setup`.");
  }

  let bad = 0;
  for (const r of rows) {
    console.log(`${r.ok ? "  ok  " : "  FIX "} ${r.what}`);
    if (!r.ok) {
      bad++;
      if (r.fix) console.log(`        ${r.fix}`);
    }
  }
  console.log(bad ? `\n${bad} thing${bad === 1 ? "" : "s"} to fix.` : "\nEverything looks right.");
  process.exitCode = bad ? 1 : 0;
}

function newestIn(dir) {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newestIn(p) : fs.statSync(p).mtimeMs);
  }
  return t;
}

function portBusy(port) {
  try {
    if (process.platform === "win32") return execFileSync("netstat", ["-ano"], { encoding: "utf8" }).includes(`127.0.0.1:${port} `);
    return execFileSync("sh", ["-c", `lsof -i :${port} || true`], { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
}
