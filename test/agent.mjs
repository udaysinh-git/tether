// End-to-end tests for what keeps an agent's work short: actions that return
// only what changed, click_at for canvas pages, flows that replay a task in
// one call, and the pointer to a site's saved flows.
// Run: npm run build && node test/agent.mjs [--fallback]
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tether-agent-"));
const PORT = 47896;
const env = { ...process.env, TETHER_HOME: home, TETHER_PORT: String(PORT) };
const TRUSTED = !process.argv.includes("--fallback");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => {
  if (!c) { console.error("FAIL:", m, "\n   last output:", String(globalThis.lastOut || "").slice(0, 1200).replace(/\n/g, "\n   ")); process.exitCode = 1; }
  else console.log("ok  ", m);
};

// A list page long enough that its outline is worth diffing, with a canvas.
const app = `<!doctype html><html><head><title>Orders</title></head><body style="margin:0;font:14px sans-serif">
<h1>Orders</h1>
<form id="filter" aria-label="Filter" onsubmit="return false">
  <label>Search <input id="search"></label>
  <button id="apply" type="button">Apply</button>
  <span id="count"></span>
</form>
<canvas id="board" width="300" height="200" style="display:block;background:#ddd"></canvas>
<p id="log">nothing yet</p>
<button id="wipe" type="button">Delete account</button>
<ul>${Array.from({ length: 60 }, (_, i) => `<li>Order ${1000 + i} for customer number ${i}</li>`).join("")}</ul>
<script>
  const log = document.getElementById('log');
  document.getElementById('apply').addEventListener('click', () => { document.getElementById('count').textContent = document.getElementById('search').value.length + ' results'; });
  document.getElementById('wipe').addEventListener('click', () => { log.textContent = 'account deleted'; });
  const c = document.getElementById('board');
  const at = (e) => { const r = c.getBoundingClientRect(); return Math.round(e.clientX - r.left) + ',' + Math.round(e.clientY - r.top); };
  let from = null, moves = 0;
  c.addEventListener('mousedown', (e) => { from = at(e); moves = 0; });
  c.addEventListener('mousemove', (e) => { if (e.buttons) moves++; });
  let dragged = false;
  c.addEventListener('mouseup', (e) => { dragged = !!from && from !== at(e); if (dragged) log.textContent = 'drag ' + from + ' to ' + at(e) + ' moves ' + (moves > 3) + ' trusted ' + e.isTrusted; from = null; });
  // A drag that ends on the canvas is followed by a click; that one isn't logged.
  c.addEventListener('click', (e) => { if (!dragged) log.textContent = 'click ' + at(e) + ' trusted ' + e.isTrusted; dragged = false; });
  c.addEventListener('dblclick', (e) => { log.textContent = 'double ' + at(e); });
</script></body></html>`;

// A page from another origin, embedded in the invoice page.
const widget = `<!doctype html><html><head><title>Review</title></head><body style="margin:0">
<button id="rev" type="button">Mark reviewed</button>
<button id="second" type="button">Second opinion</button>
<p id="said">not reviewed</p>
<script>
  document.getElementById('rev').addEventListener('click', () => { document.getElementById('said').textContent = 'reviewed'; });
  document.getElementById('second').addEventListener('click', () => { document.getElementById('said').textContent += ' twice'; });
</script></body></html>`;

let framePort = 0;
const invoice = () => `<!doctype html><html><head><title>New invoice</title></head><body>
<h1>New invoice</h1>
<form id="inv" aria-label="Invoice" onsubmit="return false">
  <label>Amount <input id="amount" name="amount"></label>
  <label>Currency <select id="currency" name="currency"><option>USD</option><option>INR</option></select></label>
  <label><input id="gst" name="gst" type="checkbox"> Add GST</label>
  <label>PIN <input id="pin" name="pin" type="password"></label>
  <button id="save" type="button">Save draft</button>
  <button id="pay" type="button">Pay invoice</button>
</form>
<p id="result">unpaid</p>
<div id="notes"></div>
<p id="noted">no note</p>
<iframe id="review" src="http://localhost:${framePort}/widget" width="400" height="90" title="Review widget"></iframe>
<script>
  // A component with its own shadow tree, as design systems build them.
  const sr = document.getElementById('notes').attachShadow({ mode: 'open' });
  sr.innerHTML = '<label>Note <input id="note"></label><button id="add" type="button">Add note</button>';
  sr.getElementById('add').addEventListener('click', () => { document.getElementById('noted').textContent = 'note ' + sr.getElementById('note').value; });
  const v = (id) => document.getElementById(id);
  v('save').addEventListener('click', () => { v('result').textContent = 'Draft ' + v('amount').value; });
  v('pay').addEventListener('click', () => { v('result').textContent = 'Paid ' + v('amount').value + ' ' + v('currency').value + (v('gst').checked ? ' gst' : '') + (v('pin').value ? ' pin' : ''); });
</script></body></html>`;

const handler = (req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(req.url.startsWith("/widget") ? widget : req.url.startsWith("/invoice") ? invoice() : app);
};
const srv = http.createServer(handler).listen(0);
const frameSrv = http.createServer(handler).listen(0);
framePort = frameSrv.address().port;
const site = `http://127.0.0.1:${srv.address().port}`;
const siteHost = `127.0.0.1:${srv.address().port}`;

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
  // No emulated viewport: it makes the page report a size the real window
  // doesn't have, and click_at maps screenshot pixels onto the real one.
  viewport: null,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
await sw.evaluate(async ({ port, trusted }) => { await chrome.storage.local.set({ key: "test-test-test-test", port, trusted, sounds: false }); await refreshStandby(); }, { port: PORT, trusted: TRUSTED });

const tab = await ctx.newPage();
await tab.goto(site);
await wait(400);

const connect = async (...args) => {
  const c = new Client({ name: "claude-code", version: "test" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "host", "cli.js"), ...args], env, stderr: "inherit" }));
  return c;
};
const caller = (c) => async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const out = { text: r.content.map((x) => x.text ?? `[${x.type}]`).join("\n"), r };
  globalThis.lastOut = `${name}: ${out.text}`;
  return out;
};
const client = await connect("--tools", "all");
const call = caller(client);
const asked = async (tabId) => {
  for (let i = 0; i < 80; i++) {
    const c = await sw.evaluate((id) => publicConfirm(state.confirming.get(id)), tabId);
    if (c) return c;
    await wait(100);
  }
  return null;
};
const answer = (tabId, allow) => sw.evaluate(({ id, allow }) => answerConfirm(id, allow), { id: tabId, allow });
const logText = () => tab.textContent("#log");

try {
  const tabId = await sw.evaluate(async (url) => { const [t] = await chrome.tabs.query({ url: url + "/*" }); await share(t.id); return t.id; }, site);
  await wait(800);
  const handle = (await call("list_tabs")).text.match(/(\w+:\d+)/)[1];

  // ---- actions return what changed
  let t = await call("click_at", { tab: handle, x: 10, y: 10 });
  ok(t.r.isError && /Take a screenshot of this tab first/.test(t.text), "click_at before any screenshot says to take one");
  const full = await call("snapshot", { tab: handle });
  const ref = (name) => full.text.match(new RegExp(`"${name}" \\[(e\\d+)\\]`))?.[1];
  ok(full.text.split("\n").length > 60 && ref("Search") && ref("Apply"), "the first outline is whole");
  t = await call("type", { tab: handle, ref: ref("Search"), text: "shoes" });
  ok(/Changed since the outline you last got/.test(t.text) && /^\+ +textbox "Search" \[e\d+\] value="shoes"$/m.test(t.text) && /^- +textbox "Search" \[e\d+\] value=""$/m.test(t.text), "typing returns only the line that changed");
  ok(/^ {2}form "Filter":$/m.test(t.text) && !/Order 1030/.test(t.text) && t.text.length < full.text.length / 4, `the diff names the form and is a fraction of the page (${t.text.length} of ${full.text.length} characters)`);
  t = await call("click", { tab: handle, ref: ref("Apply") });
  ok(/^\+ +text: 5 results$/m.test(t.text) && /Clicked button/.test(t.text), "a ref from an unchanged line still works, and the new text comes back as an added line");
  t = await call("hover", { tab: handle, ref: ref("Apply") });
  ok(/The outline is the same as the one you last got/.test(t.text), "an action that changes nothing says so in a line");
  t = await call("snapshot", { tab: handle });
  ok(/Order 1030/.test(t.text) && !/Changed since/.test(t.text), "snapshot always gives the whole outline");
  t = await call("navigate", { tab: handle, url: site + "/invoice" });
  ok(/# New invoice/.test(t.text) && /button "Pay invoice"/.test(t.text) && !/Changed since/.test(t.text), "another page comes back whole");
  await call("navigate", { tab: handle, url: site + "/" });

  // ---- click_at
  t = await call("screenshot", { tab: handle, max_side: 500 });
  const dims = t.text.match(/(\d+)x(\d+) px/);
  ok(t.r.content[0].type === "image" && dims && Number(dims[1]) === 500 && Number(dims[2]) < 500, `screenshot with max_side is scaled down and says its size (${dims?.[0]})`);
  const geo = await tab.evaluate(() => { const r = document.getElementById("board").getBoundingClientRect(); return { left: r.left, top: r.top, vw: innerWidth, vh: innerHeight }; });
  const k = Number(dims[1]) / geo.vw;
  const img = (cx, cy) => ({ x: (geo.left + cx) * k, y: (geo.top + cy) * k });
  t = await call("click_at", { tab: handle, ...img(120, 80) });
  let m = (await logText()).match(/click (\d+),(\d+) trusted (\w+)/);
  ok(m && Math.abs(m[1] - 120) <= 2 && Math.abs(m[2] - 80) <= 2 && /Clicked canvas at \(/.test(t.text), `click_at lands on the point the image shows (${m?.[1]},${m?.[2]} for 120,80)`);
  if (TRUSTED) ok(m?.[3] === "true", "with the debugger it is real input");
  t = await call("click_at", { tab: handle, ...img(40, 40), double: true });
  ok(/double 4\d,4\d|double 3\d,3\d/.test(await logText()), "double clicks at a point");
  const to = img(220, 150);
  t = await call("click_at", { tab: handle, ...img(30, 30), to_x: to.x, to_y: to.y });
  m = (await logText()).match(/drag (\d+),(\d+) to (\d+),(\d+) moves (\w+)/);
  ok(m && Math.abs(m[1] - 30) <= 2 && Math.abs(m[3] - 220) <= 2 && Math.abs(m[4] - 150) <= 2 && m[5] === "true" && /Dragged on canvas/.test(t.text), "to_x and to_y drag with the button held");
  t = await call("click_at", { tab: handle, x: 9000, y: 10 });
  ok(t.r.isError && /outside the screenshot/.test(t.text), "a point outside the image is refused");
  const wipe = await tab.evaluate(() => { const r = document.getElementById("wipe").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const risky = call("click_at", { tab: handle, x: wipe.x * k, y: wipe.y * k });
  const question = await asked(tabId);
  ok(/click button “Delete account”/.test(question?.action || ""), "a point on a button that deletes asks the user first");
  await answer(tabId, false);
  t = await risky;
  ok(t.r.isError && /declined/.test(t.text) && (await logText()) !== "account deleted", "and declining stops the click");
  // Tether's own panel: an agent must not be able to press Stop, Pause or Allow.
  const pill = await tab.evaluate(() => {
    const host = [...document.body.children].reverse().find((e) => e.tagName === "DIV" && e.style.position === "fixed" && e.style.zIndex === "2147483647");
    for (let y = innerHeight - 4; y > 0; y -= 6) for (let x = innerWidth - 4; x > 0; x -= 6) if (document.elementsFromPoint(x, y)[0] === host) return { x, y };
    return null;
  });
  if (pill) {
    t = await call("click_at", { tab: handle, x: pill.x * k, y: pill.y * k });
    ok(t.r.isError && /Tether's own panel/.test(t.text) && (await sw.evaluate((id) => state.shared.has(id) && !state.paused.has(id), tabId)), "a point on Tether's own panel is refused, so an agent can't press its buttons");
  } else ok(false, "found Tether's panel on the page");
  await sw.evaluate((id) => setMode(id, "read"), tabId);
  t = await call("click_at", { tab: handle, ...img(10, 10) });
  ok(t.r.isError && /read only/.test(t.text), "a read-only tab refuses click_at");
  await sw.evaluate((id) => setMode(id, "full"), tabId);

  // ---- flows
  const steps = [
    { do: "open", url: site + "/invoice" },
    { do: "type", selector: "#amount", role: "textbox", name: "Amount", value: "{{amount}}" },
    { do: "select", selector: "#currency", role: "combobox", name: "Currency", value: "{{currency}}" },
    { do: "check", selector: "#gst", role: "checkbox", name: "Add GST", value: true },
    // A selector that no longer exists: the button is found by its role and name.
    { do: "click", selector: "#old-pay-button", role: "button", name: "Pay invoice" },
    { do: "wait", text: "Paid" },
  ];
  t = await call("save_flow", { site: siteHost, name: "Pay invoice", description: "Fills and pays a new invoice.", inputs: [{ name: "amount", description: "Amount", example: "1200" }], steps });
  ok(/Saved flow Pay invoice\(amount, currency\)/.test(t.text), "save_flow saves a task with its inputs");
  t = await call("run_flow", { tab: handle, name: "Pay invoice", inputs: { amount: 1200 } });
  ok(t.r.isError && /needs these inputs: currency/.test(t.text), "run_flow asks for a missing input");
  let run = call("run_flow", { tab: handle, name: "Pay invoice", inputs: { amount: 1200, currency: "INR" } });
  let q = await asked(tabId);
  ok(/click button “Pay invoice”/.test(q?.action || ""), "a risky step in a flow still waits for the user");
  await answer(tabId, true);
  t = await run;
  ok(!t.r.isError && /all 6 steps done/.test(t.text) && (await tab.textContent("#result")) === "Paid 1200 INR gst", "run_flow does the whole task in one call");
  ok(/5\. Clicked button “Pay invoice”/.test(t.text) && /text: Paid 1200 INR gst/.test(t.text), "it reports each step and returns the page it ended on");

  // The question outlives one call: the flow comes back and is continued.
  await sw.evaluate(() => { WAIT_MS = 1500; });
  t = await call("run_flow", { tab: handle, name: "Pay invoice", inputs: { amount: 7, currency: "USD" } });
  ok(!t.r.isError && /Step 5 of 6 is waiting for the user/.test(t.text) && /run_flow again with from_step=5/.test(t.text), "a flow waiting for Allow returns with the step to continue from");
  await answer(tabId, true);
  t = await call("run_flow", { tab: handle, name: "Pay invoice", inputs: { amount: 7, currency: "USD" }, from_step: 5 });
  ok(/all 6 steps done/.test(t.text) && (await tab.textContent("#result")) === "Paid 7 USD gst", "continuing picks up the answer given in between");
  await sw.evaluate(() => { WAIT_MS = 45000; });

  await call("save_flow", { site: siteHost, name: "Broken", steps: [{ do: "open", url: site + "/invoice" }, { do: "click", selector: "#nope", timeout_seconds: 1 }, { do: "click", selector: "#save" }] });
  t = await call("run_flow", { tab: handle, name: "Broken" });
  ok(t.r.isError && /stopped at step 2 of 3/.test(t.text) && /No element on this page matches selector #nope/.test(t.text) && /button "Save draft"/.test(t.text), "a step that can't find its element stops the flow and returns the page to finish by hand");

  await call("save_flow", { site: siteHost, name: "With pin", steps: [{ do: "open", url: site + "/invoice" }, { do: "ask_user", message: "Type your PIN, then press Done." }, { do: "type", selector: "#amount", value: "5" }, { do: "click", selector: "#save" }] });
  run = call("run_flow", { tab: handle, name: "With pin" });
  let ps = null;
  for (let i = 0; i < 50 && !ps; i++) { await wait(100); ps = await sw.evaluate((id) => state.paused.get(id), tabId); }
  ok(ps?.by === "agent" && /Type your PIN/.test(ps.message), "an ask_user step hands the tab to the user with its message");
  await tab.fill("#pin", "4321");
  await sw.evaluate((id) => resumeTab(id, true), tabId);
  t = await run;
  ok(/all 4 steps done/.test(t.text) && /They pressed Done/.test(t.text) && (await tab.textContent("#result")) === "Draft 5", "the flow carries on when they press Done");

  // ---- flows reach into shadow roots and frames from another site
  await call("save_flow", {
    site: siteHost,
    name: "Review",
    steps: [
      { do: "open", url: site + "/invoice" },
      // In a shadow root, by the host the recorder would have noted.
      { do: "type", selector: "#note", scope: ["#notes"], value: "{{note}}" },
      // In a shadow root, by role and name alone.
      { do: "click", role: "button", name: "Add note" },
      // In a frame from another origin, named by part of its address.
      { do: "click", selector: "#rev", frame: `localhost:${framePort}/widget` },
      // In that frame, with nothing saying so: the page is searched, then its frames.
      { do: "click", role: "button", name: "Second opinion" },
    ],
  });
  t = await call("run_flow", { tab: handle, name: "Review", inputs: { note: "check totals" } });
  ok(!t.r.isError && /all 5 steps done/.test(t.text), "a flow runs steps inside a shadow root and inside a cross-origin frame");
  ok((await tab.textContent("#noted")) === "note check totals", "the shadow root's field was typed into and its button clicked");
  ok(/text: reviewed twice/.test(t.text) && /4\. Clicked button “Mark reviewed”/.test(t.text) && /5\. Clicked button “Second opinion”/.test(t.text), "both clicks landed in the frame, with and without the frame named");
  await call("save_flow", { site: siteHost, name: "Wrong frame", steps: [{ do: "click", selector: "#rev", frame: "nowhere.example", timeout_seconds: 1 }] });
  t = await call("run_flow", { tab: handle, name: "Wrong frame" });
  ok(t.r.isError && /no frame on this page has “nowhere\.example”/.test(t.text), "a step that names a frame the page doesn't have says so");

  // ---- a recording becomes a flow
  await call("navigate", { tab: handle, url: site + "/invoice" });
  await sw.evaluate((id) => startRecording(id, true), tabId);
  await wait(500);
  await tab.fill("#amount", "88");
  await tab.selectOption("#currency", "INR");
  await tab.fill("#pin", "9999");
  await tab.click("#add");
  await tab.click("#save");
  await wait(1200);
  await sw.evaluate((id) => stopRecording(id), tabId);
  await wait(1200);
  t = await call("site_sessions", { site: siteHost });
  const session = t.text.match(/^(\S+)\s+\d{4}-/m)?.[1];
  t = await call("site_sessions", { site: siteHost, session, as_flow: true });
  const draft = JSON.parse(t.text.slice(t.text.indexOf("[")));
  ok(draft[0].do === "open" && draft.some((s) => s.do === "type" && s.value === "88" && s.name === "Amount") && draft.some((s) => s.do === "select" && s.value === "INR") && draft.some((s) => s.do === "click" && s.name === "Save draft"), "site_sessions as_flow turns what the user did into draft steps");
  ok(draft.some((s) => s.do === "ask_user" && /PIN/.test(s.message)) && !t.text.includes("9999"), "the password they typed is not in the draft; it becomes an ask_user step");
  const inShadow = draft.find((s) => s.do === "click" && s.name === "Add note");
  ok(inShadow?.selector === "#add" && inShadow.scope?.join() === "#notes", "a click inside a shadow root is recorded with the host it sits in");
  const mine = draft.filter((s) => s.do !== "ask_user").map((s) => (s.value === "88" ? { ...s, value: "{{amount}}" } : s));
  await call("save_flow", { site: siteHost, name: "Draft invoice", steps: mine });
  t = await call("run_flow", { tab: handle, name: "Draft invoice", inputs: { amount: "431" } });
  ok(/steps done/.test(t.text) && (await tab.textContent("#result")) === "Draft 431" && (await tab.inputValue("#currency")) === "INR", "the recorded task replays with a new value");

  // ---- an agent that connects later is pointed at the flows
  const later = await connect();
  const lcall = caller(later);
  t = await lcall("snapshot", { tab: handle });
  ok(new RegExp(`Saved flows for ${siteHost.replace(/[.:]/g, "\\$&")}[^\\n]*run_flow \\(call load_tools with group "sites" first\\): [^\\n]*Pay invoice\\(amount, currency\\)`).test(t.text), "its first outline of the site lists the saved flows and how to get run_flow");
  t = await lcall("snapshot", { tab: handle });
  ok(!/Saved flows for/.test(t.text), "the pointer is given once");
  await lcall("load_tools", { group: "sites" });
  t = await lcall("call_tool", { name: "run_flow", arguments: { tab: handle, name: "Draft invoice", inputs: { amount: "9" } } });
  ok(/steps done/.test(t.text) && (await tab.textContent("#result")) === "Draft 9", "and it can run one after loading the group");
  await later.close();
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
