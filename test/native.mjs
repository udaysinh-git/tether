// End-to-end test of connecting a Chromium browser without a pairing key:
// the extension starts the native bridge, the bridge supplies the key.
// The browser only starts a bridge that is registered for it, so this test
// registers one for Playwright's Chromium, pointing at a temporary Tether
// home, and puts back whatever was registered before when it finishes.
// Run: npm run build && node test/native.mjs
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tether-native-"));
const PORT = 47895;
const env = { ...process.env, TETHER_HOME: home, TETHER_PORT: String(PORT) };
const win = process.platform === "win32";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => {
  if (!c) { console.error("FAIL:", m); process.exitCode = 1; }
  else console.log("ok  ", m);
};

// ---- where Chromium looks for a bridge called "tether"
const REG = "HKCU\\Software\\Chromium\\NativeMessagingHosts\\tether";
const FILE = path.join(os.homedir(), process.platform === "darwin" ? "Library/Application Support/Chromium/NativeMessagingHosts/tether.json" : ".config/chromium/NativeMessagingHosts/tether.json");
const regGet = () => { try { return execFileSync("reg", ["query", REG, "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).match(/REG_SZ\s+(.+)/)?.[1]?.trim() || null; } catch { return null; } };
const before = win ? regGet() : fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : null;
const register = (manifest) => {
  if (win) execFileSync("reg", ["add", REG, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"], { stdio: "ignore" });
  else { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.copyFileSync(manifest, FILE); }
};
const unregister = () => {
  if (win) { try { execFileSync("reg", ["delete", REG, "/f"], { stdio: "ignore" }); } catch {} }
  else fs.rmSync(FILE, { force: true });
};
const restore = () => {
  if (before == null) return unregister();
  if (win) execFileSync("reg", ["add", REG, "/ve", "/t", "REG_SZ", "/d", before, "/f"], { stdio: "ignore" });
  else fs.writeFileSync(FILE, before);
};

fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: PORT, key: "test-test-test-test" }));
const host = spawn(process.execPath, [path.join(root, "host", "cli.js"), "serve"], { env, stdio: "ignore" });
for (let i = 0; i < 40; i++) {
  if (await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false)) break;
  await wait(150);
}
const health = async () => (await fetch(`http://127.0.0.1:${PORT}/health`)).json();

// The build as it ships.
const ext = path.join(root, "dist", "chrome");
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
ok(manifest.permissions.includes("nativeMessaging") && !manifest.optional_permissions, "the Chromium build has the bridge permission from install, so the browser never has to ask for it later");

// Nothing registered when the browser starts.
unregister();
const ctx = await chromium.launchPersistentContext(path.join(home, "profile"), {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;
const connState = async (want) => {
  let s;
  for (let i = 0; i < 80; i++) {
    s = await sw.evaluate(async () => ({ conn: state.conn, error: state.connError, ...(await chrome.storage.local.get(["native", "key"])), paired: (await settings()).paired }));
    if (want.includes(s.conn)) break;
    await wait(150);
  }
  return s;
};

try {
  // ---- not set up: it tries the bridge by itself and says what to run
  await sw.evaluate(async (port) => { await chrome.storage.local.set({ port, sounds: false }); }, PORT);
  let s = await connState(["denied"]);
  ok(s.conn === "denied" && /tether setup/.test(s.error) && s.native === false && !s.paired && !s.key, "a fresh install tries the bridge by itself; without one it is unpaired and names the command to run");
  await sw.evaluate(async () => { await chrome.storage.local.set({ native: true }); disconnect(); await refreshStandby(); });
  s = await connState(["denied"]);
  ok(s.conn === "denied" && s.native === false && !s.paired, "pressing Connect before setup fails the same way and stays on the Connect card");

  // ---- set up: the bridge connects it, and no key is ever stored in the browser
  const launcher = path.join(home, win ? "bridge.cmd" : "bridge.sh");
  const nativeJs = path.join(root, "host", "native.js");
  if (win) fs.writeFileSync(launcher, `@echo off\r\nset TETHER_HOME=${home}\r\nset TETHER_PORT=${PORT}\r\n"${process.execPath}" "${nativeJs}" %*\r\n`);
  else { fs.writeFileSync(launcher, `#!/bin/sh\nTETHER_HOME="${home}" TETHER_PORT=${PORT} exec "${process.execPath}" "${nativeJs}" "$@"\n`); fs.chmodSync(launcher, 0o755); }
  const hostManifest = path.join(home, "tether.chromium.json");
  fs.writeFileSync(hostManifest, JSON.stringify({ name: "tether", description: "Tether bridge (test)", path: launcher, type: "stdio", allowed_origins: [`chrome-extension://${extId}/`] }));
  register(hostManifest);
  await sw.evaluate(async () => { await chrome.storage.local.set({ native: true }); disconnect(); await refreshStandby(); });
  s = await connState(["connected"]);
  ok(s.conn === "connected" && s.paired && !s.key, "with the bridge registered, Connect connects the browser with no key stored in it");
  const h = await health();
  ok(h.browsers.length === 1 && /^chrom/.test(h.browsers[0]), `the host sees the browser (${h.browsers[0]})`);
  const tabs = await sw.evaluate(async () => { const t = await chrome.tabs.create({ url: "about:blank" }); return t.id; });
  ok(tabs > 0 && (await sw.evaluate(() => popupState(null).then((p) => p.paired && p.canConnect))), "the popup shows it as paired");

  // ---- set up before the extension is installed: no click at all
  await sw.evaluate(async () => { disconnect(); await chrome.storage.local.clear(); await chrome.storage.local.set({ sounds: false }); await init(); });
  s = await connState(["connected"]);
  ok(s.conn === "connected" && s.paired && !s.key && s.native === undefined, "an extension starting fresh on a machine that is set up connects by itself");

  // ---- a bridge that doesn't list this extension is refused by the browser
  fs.writeFileSync(hostManifest, JSON.stringify({ name: "tether", description: "Tether bridge (test)", path: launcher, type: "stdio", allowed_origins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"] }));
  register(hostManifest);
  await sw.evaluate(async () => { disconnect(); await refreshStandby(); });
  s = await connState(["denied"]);
  ok(s.conn === "denied" && s.native === false, "an extension the bridge doesn't name can't use it");

  // ---- a pasted key still works, over the WebSocket
  await sw.evaluate(async (port) => { await chrome.storage.local.set({ key: "test-test-test-test", port }); disconnect(); await refreshStandby(); }, PORT);
  s = await connState(["connected"]);
  ok(s.conn === "connected" && s.paired, "pairing with a key still connects");
} catch (e) {
  console.error("FAIL: threw", e);
  process.exitCode = 1;
} finally {
  restore();
  await ctx.close().catch(() => {});
  host.kill();
  console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nall checks passed");
  process.exit();
}
