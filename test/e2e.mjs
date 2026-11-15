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
  if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok  ", m);
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
// TRUSTED=0 exercises the path Firefox uses: synthetic events, webRequest, page-world console hook.
const TRUSTED = process.env.TRUSTED !== "0" && !process.argv.includes("--fallback");
await sw.evaluate(({ key, port, trusted }) => chrome.storage.local.set({ key, port, trusted }), { key, port: PORT, trusted: TRUSTED });

const tab = await ctx.newPage();
await tab.goto(site);

const client = new Client({ name: "claude-code", version: "test" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "host", "cli.js")], env, stderr: "inherit" }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text ?? `[${c.type}]`).join("\n"), r };
};

try {
  let t = await call("list_tabs");
  ok(/No tabs are shared/.test(t.text), "nothing visible before the user shares");

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

  await call("save_script", { name: "Fill test", matches: [site + "/*"], code: "document.querySelector('input[name=email]').value = 'from-script'; 'filled'" });
  ok(fs.existsSync(path.join(home, "scripts", "fill-test.js")), "script saved to disk");
  t = await call("run_script", { tab: handle, name: "Fill test" });
  ok(/filled/.test(t.text), "script runs");

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
