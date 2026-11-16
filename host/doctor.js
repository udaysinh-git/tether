// `tether doctor`: checks every piece Tether needs and says what to fix.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, HOME } from "./config.js";
import { health } from "./shim.js";

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
  if (!fromSource) check(true, `Installed from npm (v${pkg.version}); get the extension from https://github.com/udaysinh-git/tether/releases/latest`);
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
    check(!!launcherOk, "Firefox/Zen bridge registered", "Run `node host/cli.js install-native`.");
  } else {
    const p = process.platform === "darwin" ? "Library/Application Support/Mozilla/NativeMessagingHosts/tether.json" : ".mozilla/native-messaging-hosts/tether.json";
    check(fs.existsSync(path.join(os.homedir(), p)), "Firefox bridge registered", "Run `node host/cli.js install-native`.");
  }

  // Host and browsers
  const h = await health(cfg.port);
  if (h) {
    check(true, `Host running on 127.0.0.1:${cfg.port}`);
    check(h.browsers.length > 0, `Browsers connected: ${h.browsers.join(", ") || "none"}`, "Open the browser with Tether loaded. Chrome/Brave/Edge: paste the pairing key in the popup. Firefox/Zen: reload the extension after install-native.");
    check(true, `Agents connected: ${h.agents.join(", ") || "none right now"}`);
  } else {
    check(true, `Host not running (starts when an agent or the Firefox bridge needs it)`);
    const busy = portBusy(cfg.port);
    if (busy) check(false, `Port ${cfg.port} is taken by another program`, `Free it, or set a different "port" in ${path.join(HOME, "config.json")} and in Tether's settings.`);
  }

  // Agent configs
  const claude = path.join(os.homedir(), ".claude.json");
  const claudeOk = fs.existsSync(claude) && /"tether"\s*:/.test(fs.readFileSync(claude, "utf8")) && fs.readFileSync(claude, "utf8").includes(CLI.replace(/\\/g, "\\\\"));
  check(claudeOk, "Claude Code has the tether MCP server", `Run: claude mcp add --scope user tether -- "${process.execPath}" "${CLI}"`);
  const codex = path.join(os.homedir(), ".codex", "config.toml");
  if (fs.existsSync(codex)) {
    const t = fs.readFileSync(codex, "utf8");
    const block = t.match(/\[mcp_servers\.tether\][^[]*/)?.[0] || "";
    const badEscape = /"[^"\n]*\\[^\\"\n][^"\n]*"/.test(block) && !/'/.test(block);
    check(!!block && !badEscape, "Codex has the tether MCP server", block ? "The [mcp_servers.tether] block uses backslashes inside double quotes; switch to single quotes or forward slashes." : `Add to ${codex}:\n    [mcp_servers.tether]\n    command = '${process.execPath}'\n    args = ['${CLI}']`);
  }

  // Skill links
  for (const dir of [".claude/skills", ".codex/skills", ".agents/skills"]) {
    const base = path.join(os.homedir(), dir);
    if (!fs.existsSync(base)) continue;
    check(fs.existsSync(path.join(base, "tether-browser", "SKILL.md")), `Skill installed in ~/${dir}`, `Link it: see "The skill" in README.md.`);
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
