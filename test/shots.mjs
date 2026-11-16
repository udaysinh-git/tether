// Renders the popup in its states and the in-page pill, for design review.
// Run: npm run build && node test/shots.mjs  -> test/shots/*.png
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "test", "shots");
fs.mkdirSync(out, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tether-shots-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = http
  .createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<title>Quarterly invoices · Ledgerly</title><body style="font:16px system-ui;padding:40px;background:#f1f0ed;height:900px"><h1>Invoices</h1><p>March 2026, 14 open</p><button>New invoice</button></body>`);
  })
  .listen(0);
const site = `http://127.0.0.1:${srv.address().port}`;

const ext = path.join(root, "dist", "chrome");
const ctx = await chromium.launchPersistentContext(path.join(home, "p"), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1000, height: 640 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const extId = new URL(sw.url()).host;

const tab = await ctx.newPage();
await tab.goto(site);
const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u + "/*" }))[0].id, site);

// Open the popup as a page that thinks the test tab is active.
async function popup(name, setup, after) {
  if (setup) await setup();
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 360, height: 520 });
  await p.addInitScript((id) => {
    const q = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (o) => (o.active ? [await chrome.tabs.get(id)] : q(o));
  }, tabId);
  await p.goto(`chrome-extension://${extId}/popup/popup.html`);
  await wait(400);
  if (after) await after(p);
  const h = await p.evaluate(() => document.body.scrollHeight);
  await p.setViewportSize({ width: 360, height: h });
  await p.screenshot({ path: path.join(out, `popup-${name}.png`) });
  await p.close();
}

await popup("unpaired");
await sw.evaluate(() => chrome.storage.local.set({ key: "abcd-efgh-jkmn-pqrs", port: 47898 }));
await popup("ready");
await popup("shared", async () => {
  await sw.evaluate(async (id) => {
    await share(id);
    // There is no host here, so hold the popup's status at "connected" for this shot.
    Object.defineProperty(state, "conn", { get: () => "connected", set() {}, configurable: true });
    Object.defineProperty(state, "agents", { get: () => ["Claude Code"], set() {}, configurable: true });
    state.activity.set(id, { agent: "Claude Code", summary: "clicked “New invoice”", at: Date.now() - 4000 });
    const script = (o) => ({ matches: ["*://*/*"], includes: [], excludes: [], excludeMatches: [], version: "1.0.0", ...o });
    state.scripts = [
      script({ id: "export-csv", name: "Export open invoices", description: "Downloads this month's open invoices as CSV", run: "manual" }),
      script({ id: "hide-promos", name: "Hide upgrade banners", description: "", run: "auto" }),
    ];
    state.styles = [{ id: "calm-ledger", name: "Calm Ledgerly", description: "Dark, low-contrast tables", sections: [{ rules: [], css: "h1{}" }], matches: [] }];
    state.requests = [{ id: "r1", text: "Make the invoice table dark and easier on the eyes, like the screenshot", url: location.href, status: "done", reply: "Added the Calm Ledgerly style. Switch it off below.", created: Date.now() - 600000, images: 1 }];
    state.requests[0].url = (await chrome.tabs.get(id)).url;
    await startRecording(id, true);
  }, tabId);
});
await sw.evaluate(() => { delete state.conn; delete state.agents; state.conn = "waiting"; state.agents = []; });
await popup("composer", null, async (p) => {
  await p.click("text=Request a change");
  await p.fill("#reqText", "Make this look like the attached screenshot: dark sidebar, bigger totals.");
});
await tab.bringToFront();
await sw.evaluate((id) => chrome.tabs.sendMessage(id, { cmd: "activity", agent: "Claude Code", summary: "clicked “New invoice”", agents: ["Claude Code"] }), tabId);
await wait(300);
await tab.screenshot({ path: path.join(out, "page-pill.png") });

// The agent's cursor heading for a button.
const snapText = (await sw.evaluate((id) => chrome.tabs.sendMessage(id, { cmd: "snapshot" }, { frameId: 0 }), tabId)).text;
const btnRef = snapText.match(/button "New invoice" \[(e\d+)\]/)[1];
await sw.evaluate(({ id, ref }) => chrome.tabs.sendMessage(id, { cmd: "hover", ref, agents: ["Claude Code"] }, { frameId: 0 }), { id: tabId, ref: btnRef });
await wait(150);
await tab.screenshot({ path: path.join(out, "cursor.png"), clip: { x: 0, y: 0, width: 700, height: 420 } });

// Drag the pill up to the top-left.
await tab.mouse.move(850, 605);
await tab.mouse.down();
await tab.mouse.move(600, 400, { steps: 8 });
await tab.mouse.move(380, 120, { steps: 8 });
await tab.mouse.up();
await wait(200);
await tab.screenshot({ path: path.join(out, "pill-dragged.png") });
await sw.evaluate(() => chrome.storage.local.remove("pillPos"));
await wait(200);

// The agent hands the tab to the user.
await sw.evaluate((id) => pauseTab(id, { by: "agent", agent: "Claude Code", message: "Please type the 6-digit code from your phone, then press Done." }), tabId);
await wait(300);
await tab.screenshot({ path: path.join(out, "page-pill-ask.png"), clip: { x: 500, y: 520, width: 500, height: 120 } });
await popup("paused-agent");
await sw.evaluate((id) => { resumeTab(id, true); pauseTab(id, { by: "user" }); }, tabId);
await wait(300);
await tab.screenshot({ path: path.join(out, "page-pill-paused.png"), clip: { x: 500, y: 540, width: 500, height: 100 } });
await sw.evaluate((id) => resumeTab(id, true), tabId);

// Picker, mid-selection.
await sw.evaluate((id) => startPick(id), tabId);
await wait(300);
await tab.mouse.move(150, 130);
await wait(200);
await tab.mouse.click(150, 130);
await wait(300);
await tab.keyboard.type("Make this heading match our brand orange");
await tab.screenshot({ path: path.join(out, "picker.png") });
await tab.keyboard.press("Escape");

const prompt = await ctx.newPage();
await prompt.setViewportSize({ width: 400, height: 300 });
await wait(300);
await prompt.goto(`chrome-extension://${extId}/prompt/prompt.html?id=1&agent=Codex&reason=${encodeURIComponent("Compare the same order across your three supplier tabs")}`);
await wait(400);
await prompt.screenshot({ path: path.join(out, "prompt.png") });

const opts = await ctx.newPage();
await opts.setViewportSize({ width: 900, height: 900 });
await opts.goto(`chrome-extension://${extId}/options/options.html`);
await wait(400);
await opts.screenshot({ path: path.join(out, "options.png"), fullPage: true });

await ctx.close();
srv.close();
console.log("shots in", out);
process.exit();
