// End-to-end: real Chromium with the built extension, a local test page,
// and an MCP client talking to the stdio shim. Uses a throwaway TETHER_HOME.
// Run: npm run build && node test/e2e.mjs
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tether-test-"));
const PORT = 47899;
const env = { ...process.env, TETHER_HOME: home, TETHER_PORT: String(PORT) };
const ok = (c, m) => {
  if (!c) { console.error("FAIL:", m, "\n   last output:", String(globalThis.lastOut || "").slice(0, 900).replace(/\n/g, "\n   ")); process.exitCode = 1; } else console.log("ok  ", m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const page = `<!doctype html><html><head><title>Test form</title>
<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline'"></head><body>
<h1>Sign up</h1><p>Fill this in, please.</p>
<form id="f"><label>Email <input name="email" required></label>
<label><input type="checkbox" name="news"> Newsletter</label>
<select name="plan"><option>Free</option><option>Pro</option></select>
<button type="submit">Create account</button></form>
<a href="/two" target="_blank">Open docs</a>
<div id="out"></div>
<script>
document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault();
  window.trusted = window.lastClickTrusted;
  const fd = new FormData(e.target);
  const r = await fetch('/api', {method:'POST', body: JSON.stringify(Object.fromEntries(fd))});
  document.getElementById('out').textContent = 'Saved ' + (await r.json()).email;
  console.warn('submitted', fd.get('email'));
});
document.querySelector('button').addEventListener('click', e => { window.lastClickTrusted = e.isTrusted; });
window.secret = 42;
</script></body></html>`;

const srv = http
  .createServer((req, res) => {
    if (req.url === "/api") {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ email: JSON.parse(b).email, ok: true }));
      });
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(req.url.startsWith("/two") ? "<title>Docs</title><h1>Docs page</h1>" : page);
  })
  .listen(0);
const site = `http://127.0.0.1:${srv.address().port}`;

const key = "test-test-test-test";
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: PORT, key }));

// Our own host, so a stale one from another run can't answer instead.
const host = spawn(process.execPath, [path.join(root, "host", "cli.js"), "serve"], { env, stdio: "ignore" });
for (let i = 0; i < 40; i++) {
  if (await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false)) break;
  await wait(150);
}

const ext = path.join(root, "dist", "chrome");
const ctx = await chromium.launchPersistentContext(path.join(home, "profile"), {
  channel: "chromium",
  headless: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
// Allow user scripts for Tether, as a user does once on its Details page;
// run_js uses that API when the debugger is off.
{
  const id = new URL(sw.url()).host;
  const pg = await ctx.newPage();
  await pg.goto(`chrome://extensions/?id=${id}`);
  await pg.waitForTimeout(600);
  await pg.evaluate(() => {
    const row = document.querySelector("extensions-manager")?.shadowRoot?.querySelector("extensions-detail-view")?.shadowRoot?.querySelector("#allow-user-scripts");
    const t = row?.shadowRoot?.querySelector("cr-toggle");
    if (t && !t.checked) t.click();
  });
  await pg.waitForTimeout(300);
  await pg.close();
}
// TRUSTED=0 exercises the path Firefox uses: synthetic events, webRequest, page-world console hook.
const TRUSTED = process.env.TRUSTED !== "0" && !process.argv.includes("--fallback");
await sw.evaluate(async ({ key, port, trusted }) => { await chrome.storage.local.set({ key, port, trusted }); await refreshStandby(); }, { key, port: PORT, trusted: TRUSTED });

const tab = await ctx.newPage();
await tab.goto(site);

const client = new Client({ name: "claude-code", version: "test" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "host", "cli.js")], env, stderr: "inherit" }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const out = { text: r.content.map((c) => c.text ?? `[${c.type}]`).join("\n"), r };
  globalThis.lastOut = `${name}: ${out.text}`;
  return out;
};

try {
  let t = await call("list_tabs");
  ok(/No tab is shared yet[\s\S]*start_session/.test(t.text), "browser waits in standby; nothing visible before the user shares");

  // The user clicks Share in the popup.
  const tabId = await sw.evaluate(async (url) => {
    const [t] = await chrome.tabs.query({ url: url + "/*" });
    await share(t.id);
    return t.id;
  }, site);
  await wait(1500);

  t = await call("list_tabs");
  ok(t.text.includes(`:${tabId}`), "shared tab is listed");
  const handle = t.text.match(/(\w+:\d+)/)[1];

  t = await call("snapshot");
  ok(/textbox "Email" \[e\d+\]/.test(t.text) && /button "Create account"/.test(t.text), "snapshot has refs");
  let snap = t.text;
  const ref = (label) => snap.match(new RegExp(`${label.replace(/[()[\]]/g, "\\$&")}[^\\n]*?\\[(e\\d+)\\]`))[1];
  const email = ref('textbox "Email"'), news = ref('checkbox "Newsletter"'), plan = ref("combobox"), submit = ref('button "Create account"'), docs = ref('link "Open docs"');

  t = await call("fill_form", { fields: [{ ref: news, value: true }, { ref: plan, value: "Pro" }] });
  ok(/checkbox "Newsletter" \[e\d+\] checked/.test(t.text) && /selected="Pro"/.test(t.text), "fill_form sets checkbox and select");

  t = await call("type", { ref: email, text: "uday@example.com" });
  ok(t.text.includes('value="uday@example.com"'), "type sets value");

  await call("click", { ref: submit });
  t = await call("wait_for", { text: "Saved uday@example.com" });
  ok(/Found/.test(t.text), "form submitted through the page's own handler");

  t = await call("run_js", { code: "({ trusted: window.trusted, secret: window.secret })" });
  if (TRUSTED) ok(/"trusted": true/.test(t.text) && /"secret": 42/.test(t.text), "click was trusted input; run_js sees page globals under CSP");
  else ok(/"secret": 42/.test(t.text), "run_js sees page globals");

  t = await call("network_requests", { filter: "/api" });
  const rid = t.text.match(/(r\d+)\s+POST 200/)?.[1];
  ok(!!rid, "network log has the POST");
  t = await call("network_request", { id: rid });
  if (TRUSTED) ok(t.text.includes('"ok":true') && t.text.includes("uday@example.com"), "request detail has bodies");
  else ok(t.text.includes("uday@example.com"), "request detail has the request body");

  t = await call("console_messages");
  ok(t.text.includes("submitted uday@example.com"), "console captured");

  t = await call("cookies");
  ok(!t.r.isError, "cookies tool works");

  await call("click", { ref: docs });
  await wait(1500);
  t = await call("list_tabs");
  ok(t.text.includes("Docs"), "tab opened by a shared page joins the session");

  const other = await ctx.newPage();
  await other.goto(site + "/two?private");
  await wait(500);
  t = await call("list_tabs");
  ok(!t.text.includes("private"), "unshared tab stays invisible");

  t = await call("screenshot", { tab: handle });
  ok(t.r.content?.[0]?.type === "image", "screenshot of a named tab");

  // ---- scripts, in Tampermonkey's format
  await call("save_script", { name: "Fill test", matches: [site + "/*"], code: "document.querySelector('input[name=email]').value = 'from-script';\nreturn 'filled';" });
  const scriptFile = path.join(home, "scripts", "fill-test.user.js");
  ok(fs.existsSync(scriptFile) && /==UserScript==[\s\S]*@match\s+http[\s\S]*@grant\s+GM_registerMenuCommand/.test(fs.readFileSync(scriptFile, "utf8")), "script saved as a Tampermonkey userscript");
  await wait(300);
  t = await call("run_script", { tab: handle, name: "Fill test" });
  ok(/filled/.test(t.text), "script runs and returns its result");

  // A script downloaded from elsewhere, using GM_ storage.
  t = await call("install_userscript", { text: `// ==UserScript==\n// @name GM test\n// @include ${site}/*\n// @grant GM_setValue\n// @grant GM_getValue\n// ==/UserScript==\nGM_setValue("n", 41);\nwindow.gmResult = GM_getValue("n") + 1;` });
  ok(/Installed script "GM test"/.test(t.text), "foreign userscript installs");
  await wait(300);
  await call("run_script", { tab: handle, name: "GM test" });
  t = await call("run_js", { tab: handle, code: "window.gmResult" });
  ok(t.text.trim() === "42", "GM_setValue/GM_getValue work");

  // ---- styles, as UserCSS
  const h1Color = async () => (await call("run_js", { tab: handle, code: "getComputedStyle(document.querySelector('h1')).color" })).text;
  await call("apply_css", { tab: handle, css: "h1 { color: rgb(9, 9, 9) !important; }" });
  ok((await h1Color()).includes("rgb(9, 9, 9)"), "apply_css previews");
  await call("clear_preview", { tab: handle });
  ok(!(await h1Color()).includes("rgb(9, 9, 9)"), "clear_preview removes it");
  await call("save_style", { name: "Calm test", matches: [site + "/*"], css: "h1 { color: rgb(1, 2, 3) !important; }" });
  const styleFile = path.join(home, "styles", "calm-test.user.css");
  ok(fs.existsSync(styleFile) && /==UserStyle==[\s\S]*@-moz-document url-prefix\("http:\/\/127\.0\.0\.1/.test(fs.readFileSync(styleFile, "utf8")), "style saved as UserCSS");
  await wait(800);
  ok((await h1Color()).includes("rgb(1, 2, 3)"), "saved style applies to the open tab");
  await sw.evaluate(async () => { state.disabledStyles.add("calm-test"); for (const t of await chrome.tabs.query({})) await applyStyles(t.id, t.url); });
  ok(!(await h1Color()).includes("rgb(1, 2, 3)"), "switching a style off removes it");
  await sw.evaluate(async () => { state.disabledStyles.delete("calm-test"); for (const t of await chrome.tabs.query({})) await applyStyles(t.id, t.url); });
  await tab.reload();
  await wait(1200);
  ok((await h1Color()).includes("rgb(1, 2, 3)"), "style applies again after a reload");

  // ---- recording: the user clicks and types, the agent reads the site map
  await sw.evaluate((id) => startRecording(id, true), tabId);
  await wait(800);
  await tab.fill("input[name=email]", "rec@example.com");
  await tab.click("text=Create account");
  await tab.waitForSelector("text=Saved rec@example.com");
  await wait(2500);
  await sw.evaluate((id) => stopRecording(id), tabId);
  await wait(800);
  const hostKey = new URL(site).host;
  t = await call("site_list");
  ok(t.text.includes(hostKey.replace(":", "_")), "recorded site is listed");
  t = await call("site_map", { site: hostKey });
  ok(/button "Create account"/.test(t.text) && /POST \/api/.test(t.text) && /textbox "Email"/.test(t.text), "site map has the clicked button, the field and the API call");
  t = await call("site_map", { site: hostKey, page: "/" });
  ok(/Latest outline/.test(t.text) && /Sign up/.test(t.text), "site map has the page outline");
  t = await call("site_sessions", { site: hostKey });
  const sid = t.text.split(/\s+/)[0];
  t = await call("site_sessions", { site: hostKey, session: sid });
  ok(/type\s+textbox "Email".*= "rec@example.com"/.test(t.text) && /submit/.test(t.text), "session timeline has typing and submit");
  await call("site_notes", { site: hostKey, text: "Sign-up form posts to /api." });
  t = await call("site_map", { site: hostKey });
  ok(t.text.includes("Sign-up form posts to /api."), "notes show in the site map");

  // ---- change request from the popup, with an image
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const sent = await sw.evaluate(({ id, png }) => sendRequest(id, "Make this page dark and calm", [{ name: "ref.png", dataUrl: png }]), { id: tabId, png });
  ok(sent && sent.queued === false, "request reaches the host");
  t = await call("get_requests");
  ok(t.text.includes("Make this page dark and calm") && t.r.content.some((c) => c.type === "image"), "agent gets the request text and image");
  const reqId = t.text.match(/Request (\S+)/)[1];
  await call("resolve_request", { id: reqId, reply: "Added the Calm test style." });
  await wait(500);
  const reqs = await sw.evaluate(() => state.requests);
  ok(reqs.some((r) => r.id === reqId && r.status === "done" && r.reply.includes("Calm test")), "reply shows up in the extension");

  // ---- an agent starts its own session: a separate window, after the user agrees
  const askPage = () => ctx.waitForEvent("page", { predicate: (p) => p.url().includes("prompt.html"), timeout: 15000 });
  let ask = askPage();
  let pendingSession = call("start_session", { url: site + "/two?agentwin", reason: "Check the docs page for you" });
  let pp = await ask;
  await pp.waitForLoadState();
  ok((await pp.textContent("body")).includes("wants its own window") && (await pp.textContent("body")).includes("Check the docs page for you"), "window prompt names the agent and the reason");
  await pp.click("#allow");
  t = await pendingSession;
  const agentTab = t.text.match(/Tab: (\S+)/)?.[1];
  const agentWin = Number(t.text.match(/window (\d+)/)?.[1]);
  ok(agentTab && /Docs page/.test(t.text), "start_session opens a window and returns its tab with a snapshot");
  const winTabs = await sw.evaluate((w) => chrome.tabs.query({ windowId: w }), agentWin);
  ok(winTabs.length === 1 && !winTabs.some((x) => x.url.includes("private")), "the agent window is separate from the user's tabs");
  await sw.evaluate((w) => chrome.tabs.create({ windowId: w, url: "about:blank" }), agentWin);
  await wait(500);
  t = await call("list_tabs");
  ok((t.text.match(new RegExp(`\\(window|${agentTab.split(":")[0]}:`, "g")) || []).length >= 4 && t.text.includes("agentwin"), "new tabs in the agent window are shared");
  t = await call("end_session", {});
  await wait(500);
  ok(/Closed 1 agent window/.test(t.text) && !(await sw.evaluate(() => chrome.windows.getAll())).some((w) => w.id === agentWin), "end_session closes the window");

  // Declining leaves nothing shared.
  ask = askPage();
  pendingSession = call("start_session", { reason: "Try something" });
  pp = await ask;
  await pp.waitForLoadState();
  await pp.click("#deny");
  t = await pendingSession;
  ok(/declined/.test(t.text), "a declined session opens nothing");

  // mode=current asks for the tab the user is on.
  await other.bringToFront();
  await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: "*://*/two?private" }); await chrome.windows.update(t.windowId, { focused: true }); await chrome.tabs.update(t.id, { active: true }); });
  ask = askPage();
  pendingSession = call("start_session", { mode: "current", reason: "Read this page" });
  pp = await ask;
  await pp.waitForLoadState();
  ok((await pp.textContent("body")).includes("wants to use this tab"), "current-tab prompt");
  await pp.click("#allow");
  t = await pendingSession;
  ok(/Using the user's tab/.test(t.text) && /Docs page/.test(t.text), "mode=current shares the user's tab");
  const curTab = t.text.match(/Tab: (\S+)/)?.[1];
  await call("end_session", { tab: curTab });
  t = await call("list_tabs");
  ok(!t.text.includes("private"), "end_session with a tab stops sharing it");

  // Bypass: answer the prompt as the user would.
  const promptPage = ctx.waitForEvent("page", { predicate: (p) => p.url().includes("prompt.html"), timeout: 15000 });
  const pending = call("request_bypass", { reason: "Compare prices across tabs" });
  const prompt = await promptPage;
  await prompt.waitForLoadState();
  ok((await prompt.textContent("body")).includes("Compare prices across tabs"), "bypass prompt shows the reason");
  await prompt.click("#allow");
  t = await pending;
  ok(/turned on bypass/.test(t.text), "bypass granted");
  t = await call("list_tabs");
  ok(t.text.includes("private"), "bypass mode lists every tab");

  await sw.evaluate(() => setBypass(false));
  await sw.evaluate((id) => unshare(id), tabId);
  await wait(500);
  t = await call("snapshot", { tab: handle });
  ok(t.r.isError, "stopped tab can't be used");
} catch (e) {
  console.error("FAIL: threw", e);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  await ctx.close().catch(() => {});
  srv.close();
  host.kill();
  console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nall checks passed");
  process.exit();
}
