// drag: HTML5 drag and drop, a board whose drag library waits before a drag
// starts, reordering with position, and asking before a drop on "Delete".
// Run: npm run build && node test/drag.mjs [--fallback]
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tether-drag-"));
const PORT = 47896;
const env = { ...process.env, TETHER_HOME: home, TETHER_PORT: String(PORT), TETHER_TOOLS: "all" };
const ok = (c, m) => {
  if (!c) { console.error("FAIL:", m, "\n   last output:", String(globalThis.lastOut || "").slice(0, 900).replace(/\n/g, "\n   ")); process.exitCode = 1; } else console.log("ok  ", m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TRUSTED = !process.argv.includes("--fallback");
console.log(`-- drag (${TRUSTED ? "debugger" : "page world"})`);

const page = `<!doctype html><html><head><title>Board</title><style>
body { font: 14px sans-serif; margin: 10px }
li { padding: 8px; margin: 4px 0; background: #ddd; width: 200px; list-style: none }
.col { display: inline-block; vertical-align: top; width: 180px; min-height: 160px; margin-right: 20px; background: #eee; padding: 6px }
.card { padding: 10px; margin: 6px 0; background: #fff; border: 1px solid #999; cursor: grab; touch-action: none }
#trash { display: inline-block; width: 140px; height: 60px; background: #f99; padding: 6px }
</style></head><body>
<h2>Order</h2>
<ul id="list"><li draggable="true" id="A">Apples</li><li draggable="true" id="B">Bread</li><li draggable="true" id="C">Cheese</li><li draggable="true" id="D">Dates</li></ul>
<div class="col" id="todo"><h3>Todo</h3><div class="card" id="c1" role="button" aria-roledescription="draggable" tabindex="0">Write report</div><div class="card" id="c2" role="button" aria-roledescription="draggable" tabindex="0">Call bank</div></div>
<div class="col" id="done"><h3>Done</h3></div>
<div id="trash">Delete</div>
<script>
// HTML5 list
let dragged = null;
for (const li of document.querySelectorAll('#list li')) {
  li.addEventListener('dragstart', (e) => { dragged = li; e.dataTransfer.setData('text/plain', li.id); e.dataTransfer.effectAllowed = 'move'; });
  li.addEventListener('dragover', (e) => e.preventDefault());
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    const src = document.getElementById(id);
    if (!src || src === li) return;
    const r = li.getBoundingClientRect();
    li.parentNode.insertBefore(src, e.clientY < r.top + r.height / 2 ? li : li.nextSibling);
    window.html5Trusted = e.isTrusted;
  });
}
window.order = () => [...document.querySelectorAll('#list li')].map((l) => l.id).join('');
// A pointer drag library with a delay sensor: the drag starts only after the
// pointer has been held 120 ms and moved 5 px.
let pick = null;
for (const c of document.querySelectorAll('.card')) {
  c.addEventListener('pointerdown', (e) => { pick = { el: c, t: performance.now(), x: e.clientX, y: e.clientY, active: false }; });
}
document.addEventListener('pointermove', (e) => {
  if (!pick || pick.active) return;
  if (performance.now() - pick.t >= 120 && Math.hypot(e.clientX - pick.x, e.clientY - pick.y) > 5) { pick.active = true; pick.el.style.opacity = .5; }
});
document.addEventListener('pointerup', (e) => {
  if (!pick) return;
  const p = pick; pick = null; p.el.style.opacity = 1;
  if (!p.active) { window.tooEarly = (window.tooEarly || 0) + 1; return; }
  const under = document.elementFromPoint(e.clientX, e.clientY);
  if (under?.closest('#trash')) { p.el.remove(); window.deleted = p.el.id; return; }
  const col = under?.closest('.col');
  if (col) col.appendChild(p.el);
});
window.column = (id) => document.getElementById(id)?.parentElement?.id || 'gone';
</script></body></html>`;

const srv = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(page); }).listen(0);
const site = `http://127.0.0.1:${srv.address().port}`;
const key = "test-test-test-test";
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
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--window-size=1100,800"],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
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
const ev = (code) => tab.evaluate(code);

try {
  const tabId = await sw.evaluate(async (url) => {
    const [t] = await chrome.tabs.query({ url: url + "/*" });
    await share(t.id);
    return t.id;
  }, site);
  await wait(1200);
  const snap = (await call("snapshot")).text;
  const ref = (label) => snap.match(new RegExp(`${label.replace(/[()[\]]/g, "\\$&")}[^\\n]*?\\[(e\\d+)\\]`))?.[1];
  ok(/draggable "Apples" \[e\d+\]/.test(snap), "draggable items get a ref in the outline");

  // HTML5: Apples after Cheese, then Dates before Bread.
  let t = await call("drag", { from: ref('draggable "Apples"'), to: ref('draggable "Cheese"'), position: "after" });
  ok(!t.r.isError && /Dragged \S+ “Apples” to just after \S+ “Cheese”/.test(t.text), "drag reports what it moved and where");
  ok((await ev("order()")) === "BCAD", `HTML5 drag and drop reorders the list (${await ev("order()")})`);
  if (TRUSTED) ok((await ev("window.html5Trusted")) === true, "the drop is trusted input through the debugger");
  await call("drag", { from: ref('draggable "Dates"'), to: ref('draggable "Bread"'), position: "before" });
  ok((await ev("order()")) === "DBCA", `position before puts it in front (${await ev("order()")})`);

  // A library that waits 120 ms and 5 px before a drag starts. Done has no ref: use its heading text.
  t = await call("drag", { from: ref('button "Write report"'), to: "Done" });
  ok(!t.r.isError && (await ev("column('c1')")) === "done" && !(await ev("window.tooEarly")), "a delayed pointer drag moves the card to the column named by its heading text");

  // Dropping on Delete asks first.
  const pending = call("drag", { from: ref('button "Call bank"'), to: "Delete" });
  let c = null;
  for (let i = 0; i < 30 && !c; i++) { await wait(150); c = await sw.evaluate((id) => state.confirming.get(id) || null, tabId); }
  ok(c && /drag something onto .*Delete/.test(c.action), "a drop onto Delete asks the user first");
  await sw.evaluate((id) => answerConfirm(id, false), tabId);
  t = await pending;
  ok(t.r.isError && /declined/.test(t.text) && (await ev("column('c2')")) === "todo", "declining leaves the card where it was");

  t = await call("drag", { from: ref('draggable "Bread"'), to: "Nothing like this" });
  ok(t.r.isError && /Nothing on the page says/.test(t.text), "an unknown target says so");
  ok((await ev("document.querySelectorAll('[data-tether-mark]').length")) === 0, "no marks are left on the page");

  // click_at drags got the same timing.
  if (TRUSTED) {
    const shot = await call("screenshot", { max_side: 1100 });
    const box = await tab.evaluate(() => { const a = document.getElementById("c2").getBoundingClientRect(), b = document.getElementById("done").getBoundingClientRect(); return { x: a.left + a.width / 2, y: a.top + a.height / 2, tx: b.left + b.width / 2, ty: b.top + b.height - 20, w: innerWidth }; });
    const s = shot.r.content.find((x) => x.type === "text")?.text.match(/(\d+)x(\d+)/);
    const k = s ? Number(s[1]) / box.w : 1;
    await call("click_at", { x: box.x * k, y: box.y * k, to_x: box.tx * k, to_y: box.ty * k });
    ok((await ev("column('c2')")) === "done", "click_at drags work with a delayed drag library too");
  }
} catch (e) {
  console.error("FAIL: threw", e);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  await ctx.close().catch(() => {});
  srv.close();
  host.kill();
  fs.rmSync(home, { recursive: true, force: true });
  console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nall checks passed");
  process.exit();
}
