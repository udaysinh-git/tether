// End-to-end tests for the newer features: pause and wait_for_user,
// downloads, cross-origin iframes, media, the element picker request,
// watchers, gallery screenshots, and sharing that survives a reload.
// Run: npm run build && node test/features.mjs [--fallback]
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tether-feat-"));
const PORT = 47898;
const env = { ...process.env, TETHER_HOME: home, TETHER_PORT: String(PORT) };
const TRUSTED = !process.argv.includes("--fallback");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => {
  if (!c) { console.error("FAIL:", m, "\n   last output:", String(globalThis.lastOut || "").slice(0, 900).replace(/\n/g, "\n   ")); process.exitCode = 1; }
  else console.log("ok  ", m);
};

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDGgAcYCAKt2Aw9lH7Q3AAAAAElFTkSuQmCC", "base64");
let price = 2500;

let framePort = 0;
const lab = () => `<!doctype html><html><head><title>Lab</title></head><body>
<h1>Lab page</h1>
<p id="status">idle</p>
<a id="dl" href="/report.csv">Download report</a>
<img id="pic" src="/pic.png" alt="Logo" width="40" height="40">
<img id="blobimg" alt="Generated" width="40" height="40">
<video id="vid" width="64" height="48" muted></video>
<iframe id="fr" src="http://localhost:${framePort}/frame" width="300" height="120" title="Partner widget"></iframe>
<script>
  const c = document.createElement('canvas'); c.width = 8; c.height = 8;
  const g = c.getContext('2d'); g.fillStyle = '#e8a33d'; g.fillRect(0, 0, 8, 8);
  c.toBlob(b => { document.getElementById('blobimg').src = URL.createObjectURL(b); });
  // A live canvas stream gives the video real frames for video_frame.
  const v = document.getElementById('vid'); v.srcObject = c.captureStream(10); v.play().catch(() => {});
  setInterval(() => { g.fillStyle = g.fillStyle === '#e8a33d' ? '#3d8ee8' : '#e8a33d'; g.fillRect(0, 0, 8, 8); }, 100);
</script></body></html>`;

const frame = `<!doctype html><html><head><title>Widget</title></head><body style="margin:0">
<button id="inner" style="margin:20px">Inner button</button><span id="said"></span>
<label>Code <input id="code"></label>
<script>document.getElementById('inner').addEventListener('click', e => { document.getElementById('said').textContent = 'Inner clicked ' + e.isTrusted; });</script>
</body></html>`;

const handler = (req, res) => {
  if (req.url === "/pic.png") { res.setHeader("content-type", "image/png"); return res.end(PNG); }
  if (req.url === "/report.csv") { res.setHeader("content-type", "text/csv"); res.setHeader("content-disposition", 'attachment; filename="report.csv"'); return res.end("a,b\n1,2\n"); }
  if (req.url === "/price") { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ price })); }
  if (req.url === "/frame") { res.setHeader("content-type", "text/html"); return res.end(frame); }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(lab());
};
const srv = http.createServer(handler).listen(0);
const frameSrv = http.createServer(handler).listen(0);
framePort = frameSrv.address().port;
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
  acceptDownloads: true,
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
await sw.evaluate(async ({ port, trusted }) => { await chrome.storage.local.set({ key: "test-test-test-test", port, trusted }); await refreshStandby(); }, { port: PORT, trusted: TRUSTED });

const tab = await ctx.newPage();
await tab.goto(site);
await wait(500);

const client = new Client({ name: "codex-mcp-client", version: "test" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "host", "cli.js")], env, stderr: "inherit" }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const out = { text: r.content.map((c) => c.text ?? `[${c.type}]`).join("\n"), r };
  globalThis.lastOut = `${name}: ${out.text}`;
  return out;
};

try {
  const tabId = await sw.evaluate(async (url) => { const [t] = await chrome.tabs.query({ url: url + "/*" }); await share(t.id); return t.id; }, site);
  await wait(800);
  const handle = (await call("list_tabs")).text.match(/(\w+:\d+)/)[1];

  // ---- cross-origin iframe
  let t = await call("snapshot", { tab: handle });
  const inner = t.text.match(/button "Inner button" \[(f\d+\.e\d+)\]/)?.[1];
  ok(!!inner && /frame "Partner widget":/.test(t.text), "cross-origin iframe is read into the outline with frame refs");
  const code = t.text.match(/textbox "Code" \[(f\d+\.e\d+)\]/)?.[1];
  t = await call("click", { tab: handle, ref: inner });
  ok(new RegExp(`Inner clicked ${TRUSTED ? "true" : "(true|false)"}`).test(t.text), `clicking inside the iframe works${TRUSTED ? " as real input" : ""}`);
  t = await call("fill_form", { tab: handle, fields: [{ ref: code, value: "4242" }] });
  ok(/textbox "Code" \[f\d+\.e\d+\] value="4242"/.test(t.text), "fill_form reaches a field inside the iframe");

  // ---- pause and wait_for_user
  await sw.evaluate((id) => pauseTab(id, { by: "user" }), tabId);
  t = await call("click", { tab: handle, ref: inner });
  ok(t.r.isError && /paused this tab/.test(t.text), "actions are refused while the user has paused the tab");
  t = await call("snapshot", { tab: handle });
  ok(!t.r.isError, "reading still works while paused");
  const waiting = call("wait_for_user", { tab: handle, timeout_seconds: 20 });
  await wait(700);
  await sw.evaluate((id) => resumeTab(id, true), tabId);
  t = await waiting;
  ok(/The user resumed/.test(t.text), "wait_for_user returns when the user resumes");

  const asking = call("wait_for_user", { tab: handle, message: "Please solve the CAPTCHA, then press Done.", timeout_seconds: 20 });
  await wait(700);
  const ps = await sw.evaluate((id) => state.paused.get(id), tabId);
  ok(ps?.by === "agent" && /CAPTCHA/.test(ps.message), "the agent's request is shown on the tab");
  await sw.evaluate((id) => resumeTab(id, true), tabId);
  t = await asking;
  ok(/pressed Done/.test(t.text), "wait_for_user with a message returns on Done");

  // ---- downloads
  const dlRef = (await call("snapshot", { tab: handle })).text.match(/link "Download report" \[(e\d+)\]/)[1];
  await call("click", { tab: handle, ref: dlRef });
  t = await call("wait_for_download", { tab: handle, timeout_seconds: 20 });
  ok(/report.*\.csv/.test(t.text) && /complete/.test(t.text), "wait_for_download returns the finished file");
  t = await call("list_downloads", { tab: handle });
  ok(/report/.test(t.text), "list_downloads shows the session's downloads");
  t = await call("download_file", { tab: handle, url: site + "/report.csv", filename: "direct-report.csv" });
  ok(/complete/.test(t.text) && /from \S+\/report\.csv/.test(t.text) && fs.existsSync(t.text.split("\n")[0].trim()), "download_file saves a URL through the browser");

  // ---- media
  t = await call("list_media", { tab: handle });
  const picId = t.text.match(/(m\d+)\s+image \[e\d+\] 2x2 "Logo"/)?.[1];
  const blobId = t.text.match(/(m\d+)\s+image \[e\d+\] \d+x\d+ "Generated"[^\n]*\n\s+blob:/)?.[1];
  ok(picId && blobId && /video \[e\d+\]/.test(t.text), "list_media finds images, blob images and video");
  t = await call("save_media", { tab: handle, id: picId });
  const picPath = t.text.split("\n")[0];
  ok(fs.existsSync(picPath) && fs.readFileSync(picPath).equals(PNG), "save_media saves a normal image byte for byte");
  t = await call("save_media", { tab: handle, id: blobId });
  const blobPath = t.text.split("\n")[0];
  ok(fs.existsSync(blobPath) && fs.readFileSync(blobPath).subarray(1, 4).toString() === "PNG", "save_media reads a blob: URL out of the page");
  const vidRef = (await call("list_media", { tab: handle })).text.match(/video \[(e\d+)\]/)?.[1];
  t = await call("video_frame", { tab: handle, ref: vidRef });
  ok(t.r.content.some((c) => c.type === "image") && /Frame at/.test(t.text), "video_frame returns the video's current frame as an image");

  // ---- element picker request
  const sentPick = await sw.evaluate(async (id) => {
    const r = await chrome.tabs.sendMessage(id, { cmd: "snapshot" }, { frameId: 0 });
    return pickSend(id, "Make this heading orange", { role: "heading", name: "Lab page", tag: "h1", selector: "h1", text: "Lab page", html: "<h1>Lab page</h1>", outline: "# Lab page", viewport: { x: 8, y: 20, width: 300, height: 40, vw: 1280, vh: 720 } });
  }, tabId);
  ok(sentPick && sentPick.queued === false, "picked element request reaches the host");
  t = await call("get_requests");
  ok(/picked this element/.test(t.text) && /selector: h1/.test(t.text) && t.r.content.filter((c) => c.type === "image").length === 2, "agent gets the element, its crop and the page screenshot");

  // ---- watchers
  t = await call("save_watcher", { name: "Price", url: site + "/price", check: "return response.json.price;", every_minutes: 60 });
  t = await call("run_watcher", { name: "Price" });
  ok(/value: 2500/.test(t.text), "fetch watcher reads the API with the browser");
  price = 1999;
  t = await call("run_watcher", { name: "Price", notify: true });
  ok(/value: 1999/.test(t.text) && /2500 → 1999/.test(t.text) && /would notify: true/.test(t.text), "a changed value fires a notification");
  await call("save_watcher", { name: "Heading", url: site + "/", mode: "tab", check: "return document.querySelector('h1').textContent;" });
  t = await call("run_watcher", { name: "Heading" });
  ok(/value: "Lab page"/.test(t.text), "tab watcher runs its check inside the page");
  t = await call("list_watchers");
  ok(/Price/.test(t.text) && /Heading/.test(t.text), "list_watchers shows both");

  // ---- gallery screenshots
  t = await call("save_style", { name: "Orange heading", matches: [site + "/*"], css: "h1 { color: rgb(232, 163, 61) !important; }", tab: handle });
  ok(/gallery/.test(t.text) && fs.existsSync(path.join(home, "gallery", "style-orange-heading-before.jpg")) && fs.existsSync(path.join(home, "gallery", "style-orange-heading-after.jpg")), "save_style with a tab stores before and after screenshots");
  const idx = await sw.evaluate(() => hostRpc("galleryIndex", {}));
  ok(idx?.["style:orange-heading"]?.after, "the settings page can read the gallery from the host");

  // ---- sharing survives an extension reload
  // (Headless Chromium won't restart a command-line extension after
  // runtime.reload, so do what a reload does: wipe session storage and memory,
  // then run the same restore the background runs at startup.)
  await sw.evaluate(async () => {
    await chrome.storage.session.clear();
    state.shared.clear();
    await pushTabsNow();
    for (const [id, v] of await restore("shared")) state.shared.set(id, v);
    await pushTabsNow();
  });
  await wait(500);
  t = await call("list_tabs");
  ok(t.text.includes(`:${tabId}`), "the shared tab is still shared after the extension reloads");
} catch (e) {
  console.error("FAIL: threw", e);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  await ctx.close().catch(() => {});
  srv.close();
  frameSrv.close();
  host.kill();
  console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nall checks passed");
  process.exit();
}
