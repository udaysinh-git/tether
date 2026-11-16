// Records the launch demo: the real extension and MCP host driving a stage page
// (a terminal on the left, a web app on the right), captured frame by frame.
// Run: npm run build && node demo/record.mjs  -> demo/out/tether-demo.mp4
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "demo", "out");
const framesDir = path.join(outDir, "frames");
fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tether-demo-"));
const PORT = 47897;
const env = { ...process.env, TETHER_HOME: home, TETHER_PORT: String(PORT) };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const stage = fs.readFileSync(path.join(root, "demo", "stage.html"));
const srv = http.createServer((req, res) => {
  if (req.url.startsWith("/fonts/")) {
    const f = path.join(root, "extension", "fonts", path.basename(req.url));
    if (fs.existsSync(f)) { res.setHeader("content-type", "font/woff2"); return res.end(fs.readFileSync(f)); }
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(stage);
}).listen(0);
const site = `http://127.0.0.1:${srv.address().port}`;

const key = "demo-demo-demo-demo";
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: PORT, key }));
const host = spawn(process.execPath, [path.join(root, "host", "cli.js"), "serve"], { env, stdio: "ignore" });
for (let i = 0; i < 40; i++) {
  if (await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false)) break;
  await wait(150);
}

const ext = path.join(root, "dist", "chrome");
const ctx = await chromium.launchPersistentContext(path.join(home, "profile"), {
  channel: "chromium",
  headless: true,
  viewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--window-size=1302,874", "--force-device-scale-factor=1.5", "--hide-scrollbars"],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
await sw.evaluate(async ({ key, port }) => { await chrome.storage.local.set({ key, port, trusted: true, sounds: false }); await refreshStandby(); }, { key, port: PORT });

const page = ctx.pages()[0] || (await ctx.newPage());
// Sound cues: every click, key and reveal, on the same clock as the screencast frames.
const events = [];
const cue = (kind, id, x = null, extra = {}) => events.push({ t: Date.now() / 1000, kind, id, x, ...extra });
await page.exposeFunction("__cue", (kind, id, x, extra) => cue(kind, id, x, extra || {}));
await page.addInitScript(() => {
  addEventListener("click", (e) => window.__cue("click", "ui:click", e.clientX), true);
  addEventListener("change", (e) => e.target.tagName === "SELECT" && window.__cue("tick", "ui:select", e.target.getBoundingClientRect().left), true);
  addEventListener("keydown", (e) => window.__cue("key", "otp:key", e.target.getBoundingClientRect?.().left ?? null), true);
  addEventListener("input", (e) => e.inputType === "insertText" && !e.isTrusted === false && e.target.closest?.("#payform") && window.__cue("key", "fill:memo", e.target.getBoundingClientRect().left), true);
});
await page.goto(site);
await page.evaluate(() => document.fonts.ready);
await wait(500);

// ---- capture
const cdp = await ctx.newCDPSession(page);
const frames = [];
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
  const file = path.join(framesDir, `f${String(frames.length).padStart(5, "0")}.jpg`);
  frames.push({ file, t: metadata.timestamp });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 94, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
// A tiny always-moving element keeps the screencast producing frames while the page is still.
await page.evaluate(() => { const k = document.createElement("div"); k.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:.01;z-index:-1"; document.body.append(k); let i = 0; (function f() { k.style.transform = `translateX(${(i++ % 2)}px)`; requestAnimationFrame(f); })(); });

const client = new Client({ name: "claude-code", version: "demo" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "host", "cli.js")], env, stderr: "inherit" }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text ?? "").join("\n");
  if (r.isError) throw new Error(`${name}: ${text}`);
  return text;
};
const term = (fn, ...a) => page.evaluate(([fn, a]) => window.term[fn](...a), [fn, a]);
// Show a tool line, run it, then mark it done.
async function step(name, arg, args, pause = 380) {
  await page.evaluate(([n, a]) => { window.__t = window.term.tool(n, a); }, [name, arg]);
  await wait(pause);
  const out = await call(name, args);
  await page.evaluate(() => window.__t.done());
  return out;
}
const refOf = (snap, re) => {
  const m = snap.match(new RegExp(re.source + String.raw`[^\n]*?\[(e\d+)\]`));
  if (!m) throw new Error("no ref for " + re + "\n" + snap);
  return m[1];
};

// Real mouse click on the status panel's button (it lives in a closed shadow root).
async function clickPanelButton() {
  const { root: doc } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const find = (n) => {
    if (n.nodeName === "BUTTON" && (n.attributes || []).some((v, i, a) => i % 2 === 0 && v === "class" && /\bact\b/.test(a[i + 1]))) return n;
    for (const k of [...(n.children || []), ...(n.shadowRoots || [])]) { const f = find(k); if (f) return f; }
    return null;
  };
  const btn = find(doc);
  const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId: btn.backendNodeId });
  const [x1, y1, , , x3, y3] = model.content;
  const x = (x1 + x3) / 2, y = (y1 + y3) / 2;
  await page.mouse.move(x - 120, y - 60);
  await page.mouse.move(x, y, { steps: 18 });
  await wait(250);
  await page.mouse.click(x, y);
}

try {
  // Intro card.
  await wait(1800);
  await term("intro", false);
  cue("whoosh", "intro:out", 640, { dur: 0.7 });
  await wait(900);

  // The user shares the tab (the popup's Share this tab).
  await sw.evaluate(async (url) => { const [t] = await chrome.tabs.query({ url: url + "/*" }); await share(t.id); }, site);
  await wait(500);

  await term("ask", "Pay the overdue Northwind invoice from the business account and note the invoice number");
  await wait(300);

  let snap = await step("snapshot", "app.ledgerly.io/invoices", {});
  await wait(250);
  snap = await step("click", "Northwind Traders", { ref: refOf(snap, /link "Northwind Traders"/) });
  await wait(500);
  snap = await call("snapshot");
  snap = await step("click", "Pay invoice", { ref: refOf(snap, /button "Pay invoice"/) });
  await wait(400);
  snap = await call("snapshot");
  await step("fill_form", "Pay from, Memo", {
    fields: [
      { ref: refOf(snap, /combobox "Pay from/), value: "Business checking ••6120" },
      { ref: refOf(snap, /textbox "Memo"/), value: "INV-1042, November" },
    ],
  });
  await wait(300);
  snap = await call("snapshot");
  await step("click", "Confirm payment", { ref: refOf(snap, /button "Confirm payment"/) });
  await wait(700);

  // The bank asks for a code: the agent hands the tab over.
  await term("say", "The bank wants a code sent to your phone. Over to you.");
  await wait(300);
  const handoff = (async () => {
    await page.evaluate(() => { window.__t = window.term.tool("wait_for_user", "enter the code, then press Done"); });
    setTimeout(() => cue("bell", "handoff:panel", 1060), 250);
    const out = await call("wait_for_user", { message: "Enter the code from your phone, then press Done." });
    await page.evaluate(() => window.__t.done());
    return out;
  })();
  await wait(1800);
  // The user types the code and hands back.
  for (const d of "482913") { await page.keyboard.type(d); await wait(150 + Math.random() * 90); }
  await wait(500);
  await clickPanelButton();
  snap = await handoff;
  await wait(400);
  if (!/button "Verify"/.test(snap)) snap = await call("snapshot");
  await step("click", "Verify", { ref: refOf(snap, /button "Verify"/) });
  await wait(900);
  await step("wait_for", "Payment sent", { text: "Payment sent" }, 200);
  await term("say", "Paid $2,480.00 to Northwind Traders from checking ••6120. INV-1042 is marked Paid, ref PAY-88213.");
  await wait(2200);

  // Second request: restyle the app.
  await term("ask", "This dashboard is too bright for me. Give it a calm dark theme and keep it");
  await wait(300);
  const css = (`
    .app { --bg: #1d1c1a; --panel: #262522; --line: #34322e; --ink: #ece8df; --mute: #9a958a; --accent: #c9a646; }
    .app .btn { color: #1d1c1a; }
    .app .btn.ghost { color: var(--ink); }
    .app .tag { background: #2f3a2b; color: #a8c79a; }
    .app .tag.due { background: #3a2f24; color: #e0a46f; }
    .app .tag.late { background: #3d2522; color: #e58a80; }
    .app .tick { background: #2f3a2b; } .app .tick svg { stroke: #a8c79a; }
    .app .sheet { box-shadow: -18px 0 40px rgb(0 0 0 / .3); }`).replace(/;/g, " !important;").replace(/ \}/g, " !important }").replace(/!important !important/g, "!important");
  await step("apply_css", "warm dark palette, softer status colours", { css });
  cue("swell", "theme:dark", 870, { dur: 0.6 });
  await wait(1100);
  await step("screenshot", "check contrast", {});
  await wait(300);
  await step("save_style", "\"Ledgerly calm\" for app.ledgerly.io", { name: "Ledgerly calm", matches: [site + "/*"], css });
  await term("say", "Saved as a style for this site, so it stays on. Turn it off any time from Tether's settings.");
  await wait(2600);

  // Outro.
  await sw.evaluate(async () => { for (const t of await chrome.tabs.query({})) await unshare?.(t.id).catch?.(() => {}); }).catch(() => {});
  await term("outro");
  cue("logo", "outro:lockup", 640);
  await wait(3800);
} finally {
  await cdp.send("Page.stopScreencast").catch(() => {});
  await client.close().catch(() => {});
  await ctx.close();
  host.kill();
  srv.close();
}

// ---- encode: frames have real timestamps, so hold each for its own duration.
const lines = [];
for (let i = 0; i < frames.length; i++) {
  const d = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : 0.5;
  lines.push(`file '${frames[i].file.replace(/\\/g, "/")}'`, `duration ${Math.max(0.001, d).toFixed(4)}`);
}
lines.push(`file '${frames.at(-1).file.replace(/\\/g, "/")}'`);
const list = path.join(outDir, "frames.txt");
fs.writeFileSync(list, lines.join("\n"));
const t0 = frames[0].t, FPS = 60;
const cues = { fps: FPS, total: Math.round((frames.at(-1).t + 0.5 - t0) * FPS), events: events.filter((e) => e.t >= t0).map((e) => ({ f: +((e.t - t0) * FPS).toFixed(2), kind: e.kind, id: e.id, weight: 1, pan: e.x == null ? 0 : +((e.x / 640 - 1) * 0.6).toFixed(2), ...(e.dur ? { dur: Math.round(e.dur * FPS) } : {}), ...(e.variant ? { variant: e.variant } : {}) })) };
fs.writeFileSync(path.join(outDir, "cues.json"), JSON.stringify(cues, null, 1));
const mp4 = path.join(outDir, "tether-demo.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=60,scale=1920:1080:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-movflags", "+faststart", mp4], { stdio: "inherit" });
console.log(`${frames.length} frames, ${(frames.at(-1).t - frames[0].t).toFixed(1)}s -> ${mp4}`);
process.exit(0);
