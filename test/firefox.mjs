// End-to-end test in a real Firefox, which takes paths Chromium never does:
// the native bridge instead of a WebSocket, DOM events instead of the
// debugger, webRequest for the network log, the user scripts API for run_js,
// and Firefox's own prompt windows.
//
// Playwright's Firefox can't load extensions, so this drives stock Firefox
// through geckodriver (Selenium downloads both the first time). The extension
// is reached the way a user reaches it: its own pages, its prompt windows and
// the page it is working on.
//
// The bridge is registered under a name of its own (tether_test), pointing at
// a temporary Tether home, so a Tether you have installed is never touched.
// Run: npm run build && node test/firefox.mjs
// TETHER_FIREFOX=<path> uses another Firefox-based browser (Zen, LibreWolf).
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { Builder, By } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tether-fx-"));
const PORT = 47894;
const env = { ...process.env, TETHER_HOME: home, TETHER_PORT: String(PORT) };
const win = process.platform === "win32";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => {
  if (!c) { console.error("FAIL:", m, "\n   last output:", String(globalThis.lastOut || "").slice(0, 1200).replace(/\n/g, "\n   ")); process.exitCode = 1; }
  else console.log("ok  ", m);
};

// ---------------------------------------------------------------- test site
let framePort = 0;
const page = () => `<!doctype html><html><head><title>Shop</title></head><body style="margin:0;font:14px sans-serif">
<h1>Shop</h1>
<form id="f" aria-label="Order" onsubmit="document.getElementById('out').textContent='submitted '+document.getElementById('qty').value; return false">
  <label>Name <input id="name"></label>
  <label>Quantity <input id="qty" value="1"></label>
  <label>Size <select id="size"><option>Small</option><option>Large</option></select></label>
  <label><input id="gift" type="checkbox"> Gift wrap</label>
  <button id="add" type="button">Add to basket</button>
  <button id="buy" type="button">Buy now</button>
</form>
<p id="out">idle</p>
<canvas id="board" width="240" height="120" style="display:block;background:#ccc"></canvas>
<div id="notes"></div>
<a id="dl" href="/report.csv">Download report</a>
<iframe src="http://localhost:${framePort}/widget" width="300" height="70" title="Partner widget"></iframe>
<ul>${Array.from({ length: 50 }, (_, i) => `<li>Product ${100 + i} in stock</li>`).join("")}</ul>
<script>
  const v = (id) => document.getElementById(id), out = v('out');
  v('add').addEventListener('click', (e) => { out.textContent = 'added ' + v('name').value + ' x' + v('qty').value + ' ' + v('size').value + (v('gift').checked ? ' gift' : '') + ' trusted ' + e.isTrusted; });
  v('buy').addEventListener('click', () => { out.textContent = 'bought'; });
  v('qty').addEventListener('focus', () => { console.warn('quantity focused'); });
  v('board').addEventListener('click', (e) => { const r = v('board').getBoundingClientRect(); out.textContent = 'canvas ' + Math.round(e.clientX - r.left) + ',' + Math.round(e.clientY - r.top); });
  const sr = v('notes').attachShadow({ mode: 'open' });
  sr.innerHTML = '<button id="note" type="button">Add note</button>';
  sr.getElementById('note').addEventListener('click', () => { out.textContent = 'noted'; });
  window.shopSecret = 'page-world-42';
  console.log('shop ready');
  fetch('/api/stock').then((r) => r.json()).then((j) => { window.stock = j.left; });
</script></body></html>`;
const widget = `<!doctype html><html><head><title>Widget</title></head><body style="margin:0">
<button id="inner" type="button">Inner button</button><span id="said">quiet</span>
<script>document.getElementById('inner').addEventListener('click', () => { document.getElementById('said').textContent = 'inner clicked'; });</script></body></html>`;
const handler = (req, res) => {
  if (req.url === "/api/stock") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ left: 7, note: "from the api" })); }
  if (req.url === "/report.csv") { res.setHeader("content-type", "text/csv"); res.setHeader("content-disposition", 'attachment; filename="report.csv"'); return res.end("a,b\n1,2\n"); }
  res.setHeader("content-type", "text/html; charset=utf-8");
  // A strict policy: run_js and Tether's own UI must still work on such a page.
  if (req.url.startsWith("/strict")) res.setHeader("content-security-policy", "default-src 'self'; script-src 'unsafe-inline' 'self'");
  res.end(req.url.startsWith("/widget") ? widget : page());
};
const srv = http.createServer(handler).listen(0);
const frameSrv = http.createServer(handler).listen(0);
framePort = frameSrv.address().port;
const site = `http://127.0.0.1:${srv.address().port}`;
const siteHost = `127.0.0.1:${srv.address().port}`;

// ---------------------------------------------------------------- host
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: PORT, key: "test-test-test-test" }));
const host = spawn(process.execPath, [path.join(root, "host", "cli.js"), "serve"], { env, stdio: "ignore" });
for (let i = 0; i < 40; i++) {
  if (await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false)) break;
  await wait(150);
}
const health = async () => (await fetch(`http://127.0.0.1:${PORT}/health`)).json();

// ---------------------------------------------------------------- bridge, under a test name
const NAME = "tether_test";
const REG = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NAME}`;
const FILE = path.join(os.homedir(), process.platform === "darwin" ? `Library/Application Support/Mozilla/NativeMessagingHosts/${NAME}.json` : `.mozilla/native-messaging-hosts/${NAME}.json`);
const launcher = path.join(home, win ? "bridge.cmd" : "bridge.sh");
const nativeJs = path.join(root, "host", "native.js");
if (win) fs.writeFileSync(launcher, `@echo off\r\nset TETHER_HOME=${home}\r\nset TETHER_PORT=${PORT}\r\n"${process.execPath}" "${nativeJs}" %*\r\n`);
else { fs.writeFileSync(launcher, `#!/bin/sh\nTETHER_HOME="${home}" TETHER_PORT=${PORT} exec "${process.execPath}" "${nativeJs}" "$@"\n`); fs.chmodSync(launcher, 0o755); }
const hostManifest = path.join(home, `${NAME}.json`);
fs.writeFileSync(hostManifest, JSON.stringify({ name: NAME, description: "Tether bridge (test)", path: launcher, type: "stdio", allowed_extensions: ["tether@udaysinh.me"] }));
if (win) execFileSync("reg", ["add", REG, "/ve", "/t", "REG_SZ", "/d", hostManifest, "/f"], { stdio: "ignore" });
else { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.copyFileSync(hostManifest, FILE); }
const unregister = () => {
  if (win) { try { execFileSync("reg", ["delete", REG, "/f"], { stdio: "ignore" }); } catch {} }
  else fs.rmSync(FILE, { force: true });
};

// The build under test, changed in one place: the name of the bridge it asks for.
const ext = path.join(home, "ext");
fs.cpSync(path.join(root, "dist", "firefox"), ext, { recursive: true });
{
  const f = path.join(ext, "background.js");
  const src = fs.readFileSync(f, "utf8");
  if (src.split('connectNative("tether")').length !== 2) throw new Error("background.js no longer has exactly one connectNative(\"tether\")");
  fs.writeFileSync(f, src.replace('connectNative("tether")', `connectNative("${NAME}")`));
}

// ---------------------------------------------------------------- Firefox
const UUID = "7d0e2f1a-3b4c-4d5e-8f90-a1b2c3d4e5f6";
const downloads = path.join(home, "downloads");
fs.mkdirSync(downloads);
const opts = new firefox.Options().addArguments("-headless").windowSize({ width: 1100, height: 800 });
if (process.env.TETHER_FIREFOX) opts.setBinary(process.env.TETHER_FIREFOX);
// A fixed address for the extension's pages, so the test can open them.
opts.setPreference("extensions.webextensions.uuids", JSON.stringify({ "tether@udaysinh.me": UUID }));
// Optional permissions (user scripts) are granted on the click that asks,
// without the doorhanger a test can't reach.
opts.setPreference("extensions.webextOptionalPermissionPrompts", false);
opts.setPreference("browser.download.folderList", 2);
opts.setPreference("browser.download.dir", downloads);
opts.setPreference("browser.helperApps.neverAsk.saveToDisk", "text/csv");
opts.setPreference("browser.download.alwaysOpenPanel", false);
// System access is what lets WebDriver open moz-extension:// pages.
const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(opts).setFirefoxService(new firefox.ServiceBuilder().addArguments("--allow-system-access")).build();
const caps = await driver.getCapabilities();
const fxVersion = `${caps.get("browserName")} ${caps.get("browserVersion")}`;
await driver.installAddon(ext, true);

// Tether's settings page, kept open: from it the test talks to the extension
// the way its own popup does (runtime messages), and reads its state.
const pageHandle = await driver.getWindowHandle();
await driver.switchTo().newWindow("tab");
await driver.get(`moz-extension://${UUID}/options/options.html`);
const ctl = await driver.getWindowHandle();
const inExt = async (body, ...args) => {
  const back = await driver.getWindowHandle().catch(() => pageHandle);
  await driver.switchTo().window(ctl);
  try { return await driver.executeScript(`const b = window.browser; const args = arguments; return (async () => { ${body} })()`, ...args); }
  finally { await driver.switchTo().window(back).catch(() => {}); }
};
const msg = (m) => inExt("return b.runtime.sendMessage(args[0]);", m);
const onPage = async (script, ...args) => { await driver.switchTo().window(pageHandle); return driver.executeScript(script, ...args); };
const outText = () => onPage("return document.getElementById('out').textContent;");

const connect = async (...args) => {
  const c = new Client({ name: "claude-code", version: "test" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "host", "cli.js"), ...args], env, stderr: "inherit" }));
  return c;
};
const client = await connect("--tools", "all");
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const out = { text: r.content.map((x) => x.text ?? `[${x.type}]`).join("\n"), r };
  globalThis.lastOut = `${name}: ${out.text}`;
  return out;
};
const asked = async (tabId) => {
  for (let i = 0; i < 80; i++) {
    const c = (await msg({ type: "state", tabId })).tab?.confirming;
    if (c) return c;
    await wait(120);
  }
  return null;
};

try {
  // ---- connecting: the bridge, no key
  let h = null;
  for (let i = 0; i < 60 && !h?.browsers.length; i++) { await wait(250); h = await health(); }
  ok(h.browsers.length === 1 && /^firefox/.test(h.browsers[0]), `${fxVersion} connects through the native bridge (${h.browsers[0] || "nothing connected"})`);
  const stored = await inExt("return b.storage.local.get(['key']);");
  ok(!stored.key && (await msg({ type: "panelState" })).paired, "no pairing key is stored in the browser");

  // ---- sharing and the outline
  await driver.switchTo().window(pageHandle);
  await driver.get(site);
  await wait(600);
  const tabId = await inExt("return (await b.tabs.query({})).find((x) => x.url.startsWith(args[0])).id;", site);
  let t = await call("list_tabs");
  ok(/No tab is shared yet/.test(t.text), "nothing is visible to the agent before a tab is shared");
  await msg({ type: "share", tabId });
  await wait(800);
  t = await call("list_tabs");
  const handle = t.text.match(/(\w+:\d+)/)?.[1];
  ok(handle?.startsWith("firefox:") && /Shop/.test(t.text), "a shared tab is listed");
  const full = await call("snapshot", { tab: handle });
  const ref = (name, text = full.text) => text.match(new RegExp(`"${name}" \\[((?:f\\d+\\.)?e\\d+)\\]`))?.[1];
  ok(/# Shop/.test(full.text) && ref("Name") && ref("Add to basket") && /Product 149 in stock/.test(full.text), "snapshot reads the page as an outline with refs");
  ok(/frame "Partner widget":/.test(full.text) && /^f\d+\.e\d+$/.test(ref("Inner button") || ""), "a cross-origin iframe is read into the outline with frame refs");
  ok(/button "Add note" \[e\d+\]/.test(full.text), "an open shadow root is part of the outline");

  // ---- acting (DOM events in Firefox)
  t = await call("type", { tab: handle, ref: ref("Name"), text: "Asha" });
  ok(/Changed since the outline you last got/.test(t.text) && /^\+ +textbox "Name" \[e\d+\] value="Asha"$/m.test(t.text), "typing returns only the changed line");
  t = await call("fill_form", { tab: handle, fields: [{ ref: ref("Quantity"), value: "3" }, { ref: ref("Size"), value: "Large" }, { ref: ref("Gift wrap"), value: true }] });
  ok(/value="3"/.test(t.text) && /selected="Large"/.test(t.text) && /checkbox "Gift wrap" \[e\d+\] checked/.test(t.text), "fill_form sets a text field, a select and a checkbox");
  t = await call("click", { tab: handle, ref: ref("Add to basket") });
  ok(/added Asha x3 Large gift trusted false/.test(await outText()), "click reaches the page (as a DOM event, which Firefox reports as untrusted)");
  t = await call("select_option", { tab: handle, ref: ref("Size"), values: ["Small"] });
  ok(/selected="Small"/.test(t.text), "select_option picks an option");
  t = await call("press_key", { tab: handle, ref: ref("Quantity"), key: "Enter" });
  ok(/submitted 3/.test(await outText()), "Enter in a field submits its form");
  t = await call("click", { tab: handle, ref: ref("Inner button") });
  ok(/text: inner clicked/.test(t.text), "a click inside the cross-origin iframe works");
  t = await call("read_text", { tab: handle });
  ok(/Product 120 in stock/.test(t.text), "read_text returns the page's text");
  t = await call("wait_for", { tab: handle, text: "submitted 3" });
  ok(/Found/.test(t.text), "wait_for sees text on the page");

  // ---- screenshot and click_at
  t = await call("screenshot", { tab: handle, max_side: 600 });
  const dims = t.text.match(/(\d+)x(\d+) px/);
  ok(t.r.content[0].type === "image" && dims && Math.max(Number(dims[1]), Number(dims[2])) === 600, `screenshot works and is scaled to max_side (${dims?.[0]})`);
  const geo = await onPage("const r = document.getElementById('board').getBoundingClientRect(); return { left: r.left, top: r.top, vw: innerWidth };");
  const k = Number(dims[1]) / geo.vw;
  t = await call("click_at", { tab: handle, x: (geo.left + 100) * k, y: (geo.top + 60) * k });
  const m = (await outText()).match(/canvas (\d+),(\d+)/);
  ok(m && Math.abs(m[1] - 100) <= 2 && Math.abs(m[2] - 60) <= 2, `click_at lands on the point the image shows (${m?.[1]},${m?.[2]} for 100,60)`);

  // ---- devtools: webRequest and the console hook
  t = await call("navigate", { tab: handle, action: "reload" });
  ok(/# Shop/.test(t.text) && !/Changed since/.test(t.text), "navigate reloads and returns the whole outline");
  await wait(700);
  t = await call("network_requests", { tab: handle, filter: "/api/stock" });
  const rid = t.text.match(/\b(r\d+)\b/)?.[1];
  ok(rid && /200/.test(t.text) && /GET/.test(t.text), "the network log has the page's fetch");
  t = await call("network_request", { tab: handle, id: rid });
  ok(/"note":"from the api"/.test(t.text), "with its response body");
  t = await call("console_messages", { tab: handle });
  ok(/shop ready/.test(t.text), "console output from the page's load is captured");
  await call("click", { tab: handle, ref: ref("Quantity") });
  t = await call("console_messages", { tab: handle });
  ok(/quantity focused/.test(t.text), "console output after an action is captured");
  await onPage("const s = document.createElement('script'); s.textContent = 'console.error(\"said once\")'; document.body.appendChild(s);");
  await wait(400);
  t = await call("console_messages", { tab: handle, level: "error" });
  ok(t.text.split("said once").length === 2, `a message is logged once, not once per copy of the page script (${t.text.split("said once").length - 1} times)`);
  t = await call("cookies", { tab: handle });
  ok(!t.r.isError, "cookies are listed");

  // ---- run_js through the user scripts API
  t = await call("run_js", { tab: handle, code: "1 + 1" });
  ok(t.r.isError && /user scripts/i.test(t.text), "run_js says user scripts must be allowed first");
  await driver.switchTo().window(ctl);
  await driver.navigate().refresh();
  await wait(500);
  await driver.findElement(By.id("grant")).click();
  await wait(1200);
  ok(await inExt("return b.permissions.contains({ permissions: ['userScripts'] });"), "pressing Allow user scripts in settings grants it");
  t = await call("run_js", { tab: handle, code: "window.shopSecret + ' ' + document.title" });
  ok(/page-world-42 Shop/.test(t.text), "run_js runs in the page's own world");
  await call("navigate", { tab: handle, url: site + "/strict" });
  t = await call("run_js", { tab: handle, code: "document.querySelectorAll('li').length" });
  ok(/\b50\b/.test(t.text), "and on a page with a strict content security policy");
  await call("save_script", { name: "Count", matches: [site + "/*"], code: "return document.querySelectorAll('li').length + 1;" });
  await wait(600);
  t = await call("run_script", { tab: handle, name: "Count" });
  ok(/\b51\b/.test(t.text), "a saved userscript runs and returns its value");
  await call("navigate", { tab: handle, url: site + "/" });

  // ---- restyling
  await call("apply_css", { tab: handle, css: "h1 { color: rgb(1, 2, 3) !important; }" });
  ok((await onPage("return getComputedStyle(document.querySelector('h1')).color;")) === "rgb(1, 2, 3)", "apply_css previews CSS on the page");
  await call("clear_preview", { tab: handle });
  await call("save_style", { name: "Green", matches: [site + "/*"], css: "h1 { color: rgb(0, 128, 0) !important; }" });
  await wait(900);
  ok((await onPage("return getComputedStyle(document.querySelector('h1')).color;")) === "rgb(0, 128, 0)", "a saved style applies to the open page");

  // ---- asking first, read only, pause
  let snap = (await call("snapshot", { tab: handle })).text;
  const buy = call("click", { tab: handle, ref: ref("Buy now", snap) });
  let question = await asked(tabId);
  ok(/click button “Buy now”/.test(question?.action || ""), "a click on a button that buys waits for the user");
  await msg({ type: "confirmAnswer", tabId, id: question.id, allow: false });
  t = await buy;
  ok(t.r.isError && /declined/.test(t.text) && (await outText()) !== "bought", "declining stops it");
  const buy2 = call("click", { tab: handle, ref: ref("Buy now", snap) });
  question = await asked(tabId);
  await msg({ type: "confirmAnswer", tabId, id: question.id, allow: true });
  t = await buy2;
  ok(!t.r.isError && (await outText()) === "bought", "allowing lets it through");
  await msg({ type: "setMode", tabId, mode: "read" });
  t = await call("click", { tab: handle, ref: ref("Add to basket", snap) });
  ok(t.r.isError && /read only/.test(t.text) && !(await call("snapshot", { tab: handle })).r.isError, "a read-only tab can be read but not acted on");
  await msg({ type: "setMode", tabId, mode: "full" });
  await msg({ type: "pause", tabId });
  t = await call("click", { tab: handle, ref: ref("Add to basket", snap) });
  ok(t.r.isError && /paused this tab/.test(t.text), "a paused tab refuses actions");
  const waiting = call("wait_for_user", { tab: handle, timeout_seconds: 20 });
  await wait(600);
  await msg({ type: "resume", tabId });
  t = await waiting;
  ok(/The user resumed/.test(t.text), "wait_for_user returns when the user resumes");

  // ---- downloads
  await call("click", { tab: handle, ref: ref("Download report", snap) });
  t = await call("wait_for_download", { tab: handle, timeout_seconds: 25 });
  ok(/report.*\.csv/.test(t.text) && /complete/.test(t.text), "wait_for_download returns the finished file");

  // ---- recording, and a flow that reaches a shadow root and a frame
  await msg({ type: "startRec", tabId });
  await wait(500);
  await driver.switchTo().window(pageHandle);
  await driver.findElement(By.id("name")).clear();
  await driver.findElement(By.id("name")).sendKeys("Ravi");
  await driver.findElement(By.id("qty")).click();
  await driver.findElement(By.id("add")).click();
  await wait(1300);
  await msg({ type: "stopRec", tabId });
  await wait(1500);
  t = await call("site_sessions", { site: siteHost });
  const session = t.text.match(/^(\S+)\s+\d{4}-/m)?.[1];
  t = await call("site_sessions", { site: siteHost, session, as_flow: true });
  const draft = session ? JSON.parse(t.text.slice(t.text.indexOf("["))) : [];
  ok(draft.some((s) => s.do === "type" && s.value === "Ravi" && s.name === "Name") && draft.some((s) => s.do === "click" && s.name === "Add to basket"), "what the user did is recorded and comes back as draft flow steps");
  await call("save_flow", {
    site: siteHost,
    name: "Order",
    steps: [
      { do: "open", url: site + "/" },
      { do: "type", selector: "#name", role: "textbox", name: "Name", value: "{{who}}" },
      { do: "click", selector: "#gone", role: "button", name: "Add to basket" },
      { do: "click", selector: "#note", scope: ["#notes"] },
      { do: "click", role: "button", name: "Inner button", frame: `localhost:${framePort}` },
    ],
  });
  t = await call("run_flow", { tab: handle, name: "Order", inputs: { who: "Meera" } });
  ok(!t.r.isError && /all 5 steps done/.test(t.text) && (await outText()) === "noted" && /text: inner clicked/.test(t.text), "run_flow replays a task, including a step in a shadow root and one in a cross-origin frame");
  ok(/3\. Clicked button “Add to basket”/.test(t.text), "a step whose selector is gone is found by its role and name");

  // ---- an agent starting its own session: Firefox's prompt window
  const before = await driver.getAllWindowHandles();
  const starting = call("start_session", { reason: "Checking the shop's second page.", url: site + "/?second" });
  let prompt = null;
  for (let i = 0; i < 60 && !prompt; i++) { await wait(200); prompt = (await driver.getAllWindowHandles()).find((x) => !before.includes(x)) || null; }
  ok(!!prompt, "start_session opens a prompt window");
  await driver.switchTo().window(prompt);
  await wait(500);
  const title = await driver.findElement(By.id("title")).getText();
  const reason = await driver.findElement(By.id("reason")).getText();
  ok(/Claude Code wants its own window/.test(title) && /Checking the shop's second page/.test(reason), "the prompt names the agent and shows its reason");
  await driver.findElement(By.id("allow")).click();
  t = await starting;
  const mine = t.text.match(/Tab: (\w+:\d+)/)?.[1];
  ok(!t.r.isError && mine && /# Shop/.test(t.text), "after the user allows it, the agent gets its own window with the page open");
  t = await call("list_tabs");
  ok(t.text.includes(handle) && t.text.includes(mine), "both tabs are now shared");
  t = await call("end_session", {});
  ok(/Closed 1 agent window/.test(t.text), "end_session reports the window closed");
  await wait(800);
  ok(!(await call("list_tabs")).text.includes(mine) && !(await driver.getAllWindowHandles()).includes(prompt), "and the agent's window is gone");

  // ---- stopping
  await msg({ type: "unshare", tabId });
  await wait(400);
  t = await call("list_tabs");
  ok(/No tab is shared yet/.test(t.text), "after Stop sharing the agent has nothing");
} catch (e) {
  console.error("FAIL: threw", e);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  await driver.quit().catch(() => {});
  unregister();
  srv.close();
  frameSrv.close();
  host.kill();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nall checks passed");
  process.exit();
}
