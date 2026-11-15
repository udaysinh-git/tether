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
async function popup(name, setup) {
  if (setup) await setup();
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 360, height: 520 });
  await p.addInitScript((id) => {
    const q = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (o) => (o.active ? [await chrome.tabs.get(id)] : q(o));
  }, tabId);
  await p.goto(`chrome-extension://${extId}/popup/popup.html`);
  await wait(400);
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
    state.agents = ["Claude Code"];
    state.conn = "connected";
    state.activity.set(id, { agent: "Claude Code", summary: "clicked “New invoice”", at: Date.now() - 4000 });
    state.scripts = [{ id: "export-csv", name: "Export open invoices", description: "Downloads this month's open invoices as CSV", matches: ["<all_urls>"], run: "manual" }];
  }, tabId);
});
await tab.bringToFront();
await sw.evaluate((id) => chrome.tabs.sendMessage(id, { cmd: "activity", agent: "Claude Code", summary: "clicked “New invoice”", agents: ["Claude Code"] }), tabId);
await wait(300);
await tab.screenshot({ path: path.join(out, "page-pill.png") });

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
