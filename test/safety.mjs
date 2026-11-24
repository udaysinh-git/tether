// End-to-end tests for the safety features: read-only sharing, asking the
// user before risky actions (in the page, the popup and the side panel), the
// per-site "ask first" setting, and the side panel's activity feed.
// Run: npm run build && node test/safety.mjs [--fallback] [--shots]
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tether-safety-"));
const PORT = 47896;
const env = { ...process.env, TETHER_HOME: home, TETHER_PORT: String(PORT), TETHER_TOOLS: "all" };
const TRUSTED = !process.argv.includes("--fallback");
const SHOTS = process.argv.includes("--shots") ? path.join(root, "test", "shots") : null;
const AGENT = "Claude Code"; // how the host names an MCP client called "claude-code"
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => {
  if (!c) { console.error("FAIL:", m, "\n   last output:", String(globalThis.lastOut || "").slice(0, 900).replace(/\n/g, "\n   ")); process.exitCode = 1; }
  else console.log("ok  ", m);
};

const shop = `<!doctype html><html><head><title>Shop</title></head><body style="font:16px system-ui;padding:24px;min-height:900px;background:#f4f1ea">
<h1>Cart</h1>
<p id="state">cart</p>
<button id="more" onclick="document.getElementById('state').textContent='more'">Show more</button>
<button id="order" onclick="document.getElementById('state').textContent='ordered'">Place order</button>
<button id="del" onclick="document.getElementById('state').textContent='deleted'">Delete account</button>
<form id="msg" onsubmit="event.preventDefault(); document.getElementById('state').textContent='sent ' + this.body.value">
  <label>Message <input name="body"></label>
  <button type="submit">Send message</button>
</form>
<form id="search" onsubmit="event.preventDefault(); document.getElementById('state').textContent='searched ' + this.q.value">
  <label>Search <input name="q"></label>
  <button type="submit">Search</button>
</form>
<a href="/" target="_blank">Open another</a>
</body></html>`;

const srv = http.createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(shop); }).listen(0);
const site = `http://127.0.0.1:${srv.address().port}`;

fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: PORT, key: "test-test-test-test" }));
const host = spawn(process.execPath, [path.join(root, "host", "cli.js"), "serve"], { env, stdio: "ignore" });
for (let i = 0; i < 40; i++) {
  if (await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false)) break;
  await wait(150);
}

const ext = path.join(root, "dist", "chrome");
const ctx = await chromium.launchPersistentContext(path.join(home, "profile"), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1100, height: 720 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;
{
  const pg = await ctx.newPage();
  await pg.goto(`chrome://extensions/?id=${extId}`);
  await pg.waitForTimeout(600);
  await pg.evaluate(() => {
    const row = document.querySelector("extensions-manager")?.shadowRoot?.querySelector("extensions-detail-view")?.shadowRoot?.querySelector("#allow-user-scripts");
    const t = row?.shadowRoot?.querySelector("cr-toggle");
    if (t && !t.checked) t.click();
  });
  await pg.waitForTimeout(300);
  await pg.close();
}
await sw.evaluate(async ({ port, trusted }) => { await chrome.storage.local.set({ key: "test-test-test-test", port, trusted, sounds: false }); await refreshStandby(); }, { port: PORT, trusted: TRUSTED });

const tab = await ctx.newPage();
await tab.goto(site);
await wait(400);

const client = new Client({ name: "claude-code", version: "test" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "host", "cli.js")], env, stderr: "inherit" }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const out = { text: r.content.map((c) => c.text ?? `[${c.type}]`).join("\n"), r };
  globalThis.lastOut = `${name}: ${out.text}`;
  return out;
};
const pageState = () => tab.textContent("#state");
// Wait until the extension shows a question for the tab, and return it.
const asked = async (tabId) => {
  for (let i = 0; i < 60; i++) {
    const c = await sw.evaluate((id) => publicConfirm(state.confirming.get(id)), tabId);
    if (c) return c;
    await wait(100);
  }
  return null;
};
const answer = (tabId, allow) => sw.evaluate(({ id, allow }) => answerConfirm(id, allow), { id: tabId, allow });

try {
  // ---- read-only sharing
  const tabId = await sw.evaluate(async (url) => { const [t] = await chrome.tabs.query({ url: url + "/*" }); await share(t.id, "user", "read"); return t.id; }, site);
  await wait(800);
  let t = await call("list_tabs");
  ok(/\(read only/.test(t.text), "list_tabs marks a read-only tab");
  const handle = t.text.match(/(\w+:\d+)/)[1];
  t = await call("snapshot", { tab: handle });
  const more = t.text.match(/button "Show more"[^\n]*?\[(e\d+)\]/)?.[1];
  ok(!!more && !t.r.isError, "a read-only tab can be read");
  ok(!(await call("screenshot", { tab: handle })).r.isError, "a read-only tab can be screenshotted");
  t = await call("click", { tab: handle, ref: more });
  ok(t.r.isError && /read only/.test(t.text) && (await pageState()) === "cart", "a click on a read-only tab is refused and nothing happens");
  t = await call("run_js", { tab: handle, code: "document.title = 'changed'" });
  ok(t.r.isError && /read only/.test(t.text) && (await tab.title()) === "Shop", "run_js is refused on a read-only tab");
  t = await call("navigate", { tab: handle, url: site + "/?x" });
  ok(t.r.isError && /read only/.test(t.text), "navigate is refused on a read-only tab");

  // A page a read-only tab opens is read only too.
  await tab.click("text=Open another");
  await wait(1200);
  const kids = await sw.evaluate((src) => [...state.shared].filter(([id]) => id !== src).map(([, v]) => v.mode), tabId);
  ok(kids.length === 1 && kids[0] === "read", "a tab opened by a read-only tab is read only");
  for (const p of ctx.pages()) if (p !== tab && p.url().startsWith(site)) await p.close();
  await wait(300);

  // ---- full control
  await sw.evaluate((id) => setMode(id, "full"), tabId);
  await wait(300);
  t = await call("list_tabs");
  ok(!/read only/.test(t.text), "switching to full control clears the mark");
  t = await call("click", { tab: handle, ref: more });
  ok(!t.r.isError && (await pageState()) === "more", "an ordinary click goes through without asking");

  // ---- risky click: allowed from the page itself, with a real click on Allow
  const snap = (await call("snapshot", { tab: handle })).text;
  const sref = (label) => snap.match(new RegExp(`${label}[^\\n]*?\\[(e\\d+)\\]`))?.[1];
  let pending = call("click", { tab: handle, ref: sref('button "Place order"') });
  let c = await asked(tabId);
  ok(c && /click button “Place order”/.test(c.action) && c.agent === AGENT, "clicking Place order asks the user first, naming the agent and the button");
  await wait(700);
  ok((await pageState()) === "more", "nothing happens while the user decides");
  if (SHOTS) await tab.screenshot({ path: path.join(SHOTS, "confirm-page.png") });
  t = await call("click", { tab: handle, ref: more });
  ok(t.r.isError && /still deciding/.test(t.text), "other actions on the tab wait while a question is open");
  // The page's own code can't answer: a synthetic click on the pill does nothing.
  await tab.evaluate(() => document.querySelector("[data-tether-pill]")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  ok(!!(await sw.evaluate((id) => state.confirming.get(id), tabId)), "the page can't answer for the user");
  // A real click on the pill's Allow button (the rightmost one).
  const box = await tab.evaluate(() => { const r = document.querySelector("[data-tether-pill]").getBoundingClientRect(); return { x: r.right, y: r.top + r.height / 2 }; });
  await tab.mouse.click(box.x - 42, box.y);
  t = await pending;
  ok(!t.r.isError && (await pageState()) === "ordered", "Allow on the page lets the click through");

  // ---- risky click: denied from the side panel
  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 380, height: 760 });
  await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
  await panel.waitForSelector("text=Shared tabs");
  pending = call("click", { tab: handle, ref: sref('button "Delete account"') });
  c = await asked(tabId);
  ok(c && /Delete account/.test(c.action), "Delete account asks first");
  await panel.waitForSelector("text=wants to click button “Delete account”", { timeout: 5000 });
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, "panel-ask.png") });
  await panel.click("button[data-act=deny]");
  t = await pending;
  ok(t.r.isError && /declined/.test(t.text) && (await pageState()) === "ordered", "Deny in the side panel blocks the click and tells the agent");

  // ---- the agent's call gives up waiting, the user answers later, the retry picks it up
  await sw.evaluate(() => { WAIT_MS = 1500; });
  t = await call("click", { tab: handle, ref: sref('button "Place order"') });
  ok(t.r.isError && /hasn't answered yet/.test(t.text) && !!(await asked(tabId)), "a long wait returns to the agent while the question stays on screen");
  await answer(tabId, true);
  await tab.evaluate(() => { document.getElementById("state").textContent = "cart"; });
  t = await call("click", { tab: handle, ref: sref('button "Place order"') });
  ok(!t.r.isError && (await pageState()) === "ordered", "an answer given between calls is used by the agent's next call");
  await sw.evaluate(() => { WAIT_MS = 45000; });

  // ---- Enter / submit in a risky form, and a harmless form
  pending = call("type", { tab: handle, ref: sref('textbox "Message"'), text: "hello", submit: true });
  c = await asked(tabId);
  ok(c && /submit the form with button “Send message”/.test(c.action), "typing with submit into a Send form asks first");
  await answer(tabId, true);
  t = await pending;
  ok(!t.r.isError && (await pageState()) === "sent hello", "allowed submit goes through");
  t = await call("type", { tab: handle, ref: sref('textbox "Search"'), text: "shoes", submit: true });
  ok(!t.r.isError && (await pageState()) === "searched shoes", "a search form submits without asking");

  // ---- per-site setting: every action, then never
  const siteHost = new URL(site).host;
  await sw.evaluate((h) => setSiteAsk(h, "all"), siteHost);
  pending = call("click", { tab: handle, ref: more });
  c = await asked(tabId);
  ok(c && /click button “Show more”/.test(c.action), "with Every action, even a harmless click asks");
  await answer(tabId, true);
  await pending;
  pending = call("run_js", { tab: handle, code: "1 + 1" });
  c = await asked(tabId);
  ok(c && /run JavaScript/.test(c.action), "with Every action, run_js asks too");
  await answer(tabId, false);
  t = await pending;
  ok(t.r.isError && /declined/.test(t.text), "a declined run_js fails");
  await sw.evaluate((h) => setSiteAsk(h, "never"), siteHost);
  t = await call("click", { tab: handle, ref: sref('button "Delete account"') });
  ok(!t.r.isError && (await pageState()) === "deleted", "with Never, risky clicks go through without asking");
  await sw.evaluate((h) => setSiteAsk(h, "risky"), siteHost);

  // ---- global switch off
  await sw.evaluate(() => chrome.storage.local.set({ askRisky: false }));
  await tab.evaluate(() => { document.getElementById("state").textContent = "cart"; });
  t = await call("click", { tab: handle, ref: sref('button "Place order"') });
  ok(!t.r.isError && (await pageState()) === "ordered", "turning off Ask before risky actions stops the questions");
  await sw.evaluate(() => chrome.storage.local.set({ askRisky: true }));

  // ---- the popup answers too
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  pending = call("click", { tab: handle, ref: sref('button "Delete account"') });
  c = await asked(tabId);
  const st = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: "state", tabId: id }), tabId);
  ok(st.tab?.confirming?.action && st.siteAsk === "risky", "popup state carries the open question and the site setting");
  await popup.evaluate(({ id, cid }) => chrome.runtime.sendMessage({ type: "confirmAnswer", tabId: id, id: cid, allow: false }), { id: tabId, cid: c.id });
  t = await pending;
  ok(t.r.isError && /declined/.test(t.text), "an answer from the popup reaches the waiting agent");
  await popup.close();

  // ---- the activity feed
  await wait(500);
  const feed = await sw.evaluate(() => state.feed.map((f) => [f.agent, f.kind, f.text]));
  const has = (agent, kind, rx) => feed.some(([a, k, x]) => a === agent && k === kind && rx.test(x));
  ok(has("You", "user", /^shared this tab, read only/), "feed records the read-only share");
  ok(has(AGENT, "ask", /^asked to click button “Place order”/) && has("You", "allow", /^allowed: click button “Place order”/), "feed records the question and the Allow");
  ok(has("You", "deny", /^declined: click button “Delete account”/), "feed records the Deny");
  ok(has(AGENT, "act", /^clicked button “Show more”/), "feed records finished actions in the page's words");
  await panel.bringToFront();
  await panel.waitForSelector("text=declined: click button “Delete account”");
  const panelText = await panel.textContent("body");
  ok(/Shared tabs/.test(panelText) && /Shop/.test(panelText) && /Activity/.test(panelText), "side panel lists the shared tab and the activity");
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, "panel-feed.png") });

  // Pause from the panel.
  await panel.click(`button[data-act=pause][data-tab="${tabId}"]`);
  await wait(300);
  ok(await sw.evaluate((id) => state.paused.has(id), tabId), "Pause in the side panel pauses the tab");
  await panel.click(`button[data-act=resume][data-tab="${tabId}"]`);
  await wait(300);
  ok(!(await sw.evaluate((id) => state.paused.has(id), tabId)), "Resume in the side panel resumes it");

  // Stopping sharing answers an open question with no.
  pending = call("click", { tab: handle, ref: sref('button "Place order"') });
  await asked(tabId);
  await sw.evaluate((id) => unshare(id), tabId);
  t = await pending;
  ok(t.r.isError && /declined/.test(t.text), "stopping sharing cancels an open question");
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
