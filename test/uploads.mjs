// Uploads: every kind of upload control, filled without a file dialog, and the
// question the user is asked first. Real Chromium with the built extension.
// Run: npm run build && node test/uploads.mjs [--fallback | --bytes]
//   (default) debugger on, browser reads files by path
//   --bytes    debugger on, file access off: bytes through the debugger
//   --fallback debugger off: the page-world route Firefox uses
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tether-up-"));
const PORT = 47897;
const env = { ...process.env, TETHER_HOME: home, TETHER_PORT: String(PORT), TETHER_TOOLS: "all" };
const ok = (c, m) => {
  if (!c) { console.error("FAIL:", m, "\n   last output:", String(globalThis.lastOut || "").slice(0, 900).replace(/\n/g, "\n   ")); process.exitCode = 1; } else console.log("ok  ", m);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TRUSTED = !process.argv.includes("--fallback");
const BYTES = process.argv.includes("--bytes");
const mode = !TRUSTED ? "page world" : BYTES ? "debugger, bytes" : "debugger, by path";
console.log(`-- uploads (${mode})`);

const page = `<!doctype html><html><head><title>Uploads</title>
<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline'"></head><body>
<h1>Uploads</h1>
<label>Resume <input type="file" id="resume"></label>
<p><button id="photo">Choose photo</button><input type="file" id="photoIn" hidden accept="image/*"></p>
<p><button id="attach">Attach files</button></p>
<p><button id="picker">Pick with showPicker</button></p>
<p><button id="menu">Add file</button><span id="menuItems" hidden><button id="fromPc">From computer</button><button>From Drive</button></span></p>
<p style="position:relative;width:180px;height:36px"><span style="display:inline-block;padding:8px;background:#ddd">Upload logo</span>
  <input type="file" id="logoIn" aria-label="logo" style="position:absolute;inset:0;opacity:0;cursor:pointer"></p>
<div id="zone" style="width:300px;height:90px;border:2px dashed #888">Drag files here</div>
<label><input type="checkbox" id="agree"> Agree</label>
<div id="msg" contenteditable="true" role="textbox" aria-label="Message" style="width:300px;height:40px;border:1px solid #888"></div>
<div style="height:1500px"></div>
<script>
window.got = {};
const note = (k, files, e) => { window.got[k] = [...files].map(f => f.name + ':' + f.size).join(',') + (e ? ':trusted=' + e.isTrusted : ''); };
document.getElementById('resume').addEventListener('change', e => note('resume', e.target.files, e));
document.getElementById('photo').addEventListener('click', () => document.getElementById('photoIn').click());
document.getElementById('photoIn').addEventListener('change', e => note('photo', e.target.files, e));
document.getElementById('attach').addEventListener('click', () => {
  const i = document.createElement('input'); i.type = 'file'; i.multiple = true;
  i.addEventListener('change', e => note('attach', i.files, e));
  setTimeout(() => i.click(), 120); // after an await, like many apps
});
document.getElementById('picker').addEventListener('click', () => {
  const i = document.createElement('input'); i.type = 'file';
  i.addEventListener('change', e => note('picker', i.files, e));
  i.showPicker();
});
document.getElementById('menu').addEventListener('click', () => { document.getElementById('menuItems').hidden = false; });
document.getElementById('fromPc').addEventListener('click', () => {
  const i = document.createElement('input'); i.type = 'file';
  i.addEventListener('change', e => note('fromPc', i.files, e));
  i.click();
});
document.getElementById('logoIn').addEventListener('change', e => note('logo', e.target.files, e));
const z = document.getElementById('zone');
z.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
z.addEventListener('drop', e => { e.preventDefault(); note('zone', e.dataTransfer.files, e); });
document.getElementById('msg').addEventListener('paste', e => { if (e.clipboardData.files.length) { e.preventDefault(); note('msg', e.clipboardData.files, e); } });
</script></body></html>`;

const srv = http.createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end(page); }).listen(0);
const site = `http://127.0.0.1:${srv.address().port}`;
const siteHost = new URL(site).host;

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
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
await sw.evaluate(async ({ key, port, trusted, bytes }) => {
  await chrome.storage.local.set({ key, port, trusted });
  NO_FILE_ACCESS = bytes;
  await refreshStandby();
}, { key, port: PORT, trusted: TRUSTED, bytes: BYTES });
const byPath = TRUSTED && !BYTES && (await sw.evaluate(() => fileAccess()));
if (TRUSTED && !BYTES) ok(byPath, "an unpacked extension has file access, so files go by path");

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
const got = (k) => tab.evaluate((k) => window.got[k] || "", k);

// Files to upload.
const dir = path.join(home, "files");
fs.mkdirSync(dir);
const file = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
const cv = file("cv.pdf", "%PDF-1.4 hello");
const photo = file("photo.png", Buffer.alloc(2048, 1));
const notes = file("notes.txt", "notes");
const big = file("big.bin", Buffer.alloc(5 * 1024 * 1024, 7));
const trusted = TRUSTED && !BYTES ? ":trusted=true" : "";

try {
  const tabId = await sw.evaluate(async (url) => {
    const [t] = await chrome.tabs.query({ url: url + "/*" });
    await share(t.id);
    return t.id;
  }, site);
  await wait(1200);

  let t = await call("snapshot");
  let snap = t.text;
  const ref = (label) => snap.match(new RegExp(`${label.replace(/[()[\]]/g, "\\$&")}[^\\n]*?\\[(e\\d+)\\]`))?.[1];

  // ---- finding files
  t = await call("upload_file", { paths: [path.join(dir, "*.p*")] });
  ok(/2 files match/.test(t.text) && t.text.includes("cv.pdf") && t.text.includes("photo.png") && /Nothing was uploaded/.test(t.text), "without ref, upload_file lists what a wildcard matches");
  t = await call("upload_file", { paths: [path.join(dir, "cv-final.pdf")] });
  ok(t.r.isError && /doesn't exist/.test(t.text) && t.text.includes("cv.pdf"), "a wrong name comes back with similar files");
  t = await call("upload_file", { paths: ["cv.pdf"], ref: ref('file input "Resume"') });
  ok(t.r.isError && /relative path/.test(t.text), "a relative path is refused with a hint");
  const sshDir = path.join(os.homedir(), ".ssh");
  t = await call("upload_file", { paths: [path.join(sshDir, "id_rsa")] });
  ok(t.r.isError && /never uploads/.test(t.text), "keys and ~/.ssh are refused");
  const envFile = file(".env", "SECRET=1");
  t = await call("upload_file", { paths: [envFile] });
  ok(t.r.isError && /never uploads/.test(t.text), "a .env file is refused");

  // ---- asking first (nothing allowed yet)
  const confirming = () => sw.evaluate((id) => state.confirming.get(id) || null, tabId);
  let pending = call("upload_file", { ref: ref('file input "Resume"'), paths: [cv] });
  let c = null;
  for (let i = 0; i < 30 && !c; i++) { await wait(150); c = await confirming(); }
  ok(c && c.kind === "upload" && /attach cv\.pdf \(1 KB\) to 127\.0\.0\.1/.test(c.action), "an upload asks first and names the file, its size and the site");
  await sw.evaluate((id) => answerConfirm(id, false), tabId);
  t = await pending;
  ok(t.r.isError && /declined/.test(t.text) && !(await got("resume")), "Deny leaves the input empty");

  pending = call("upload_file", { ref: ref('file input "Resume"'), paths: [cv] });
  c = null;
  for (let i = 0; i < 30 && !c; i++) { await wait(150); c = await confirming(); }
  await sw.evaluate((id) => answerConfirm(id, true, true), tabId);
  t = await pending;
  ok(!t.r.isError && /Attached cv\.pdf to file “Resume”/.test(t.text), "Allow attaches the file");
  ok((await got("resume")) === "cv.pdf:14" + (trusted || ":trusted=false"), `the page got the file${trusted ? " as trusted input" : ""}`);
  const allowed = await sw.evaluate((h) => uploadsAllowed(h), siteHost);
  ok(allowed, "Always here remembers the site");

  // ---- every kind of control (no more questions on this site)
  t = await call("upload_file", { ref: ref('button "Choose photo"'), paths: [photo] });
  ok(/Filled the file picker that button “Choose photo” opened with photo\.png/.test(t.text) || /Attached photo\.png/.test(t.text), "a button that clicks a hidden input");
  ok((await got("photo")).startsWith("photo.png:2048"), "the hidden input got the photo");

  t = await call("upload_file", { ref: ref('button "Attach files"'), paths: [cv, notes] });
  ok(/Filled the file picker that button “Attach files” opened with cv\.pdf, notes\.txt/.test(t.text), "a button that makes an input on the fly, after a delay");
  ok((await got("attach")).startsWith("cv.pdf:14,notes.txt:5"), "both files arrived");

  t = await call("upload_file", { ref: ref('button "Pick with showPicker"'), paths: [notes, cv] });
  ok(/Filled the file picker/.test(t.text) && /left out/.test(t.text), "showPicker on a single-file input takes the first file and says so");
  ok((await got("picker")).startsWith("notes.txt:5"), "showPicker input got the file");

  t = await call("upload_file", { ref: ref('button "Add file"'), paths: [cv] });
  ok(!t.r.isError && /nothing is uploaded yet/.test(t.text) && /From computer/.test(t.text) && !(await got("fromPc")), "a button that opens a menu: the menu comes back, nothing uploaded yet");
  snap = (await call("snapshot")).text;
  t = await call("upload_file", { ref: ref('button "From computer"'), paths: [cv] });
  ok((await got("fromPc")).startsWith("cv.pdf:14"), "then the menu item opens the picker and gets the file");

  t = await call("upload_file", { ref: ref("Upload logo") || ref('file input "logo"'), paths: [photo] });
  ok((await got("logo")).startsWith("photo.png:2048"), "an invisible input laid over a label");

  ok(/drop area "Drag files here" \[e\d+\]/.test(snap), "the outline gives the drop area a ref");
  t = await call("upload_file", { ref: ref('drop area "Drag files here"'), paths: [photo, notes] });
  ok(/Dropped photo\.png, notes\.txt on/.test(t.text), "a drop area with no input gets a drop");
  ok((await got("zone")).startsWith("photo.png:2048,notes.txt:5"), "the drop area got both files");

  t = await call("upload_file", { ref: ref('textbox "Message"'), paths: [photo] });
  ok(/Pasted photo\.png into/.test(t.text) && (await got("msg")).startsWith("photo.png:2048"), "a text box gets the file pasted");

  t = await call("upload_file", { ref: ref('checkbox "Agree"'), paths: [cv] });
  ok(t.r.isError && /didn't take the files/.test(t.text) && /file input/.test(t.text) && /drop area/.test(t.text), "an element that takes nothing says so and lists where files could go");
  ok(!(await tab.evaluate(() => document.getElementById("agree").checked)), "and it wasn't clicked");

  t = await call("upload_file", { ref: ref('file input "Resume"'), paths: [big] });
  ok(!t.r.isError && (await got("resume")).startsWith("big.bin:5242880"), "a 5 MB file");

  // Real dialog is back for the user: the intercept is off again.
  if (TRUSTED) {
    const on = await sw.evaluate(async (id) => {
      let opened = false;
      const l = (src, m) => { if (m === "Page.fileChooserOpened") opened = true; };
      chrome.debugger.onEvent.addListener(l);
      await chrome.debugger.sendCommand({ tabId: id }, "Page.enable");
      await new Promise((r) => setTimeout(r, 300));
      chrome.debugger.onEvent.removeListener(l);
      return opened;
    }, tabId);
    ok(!on, "the file picker is no longer caught after the call");
  }
  const left = await tab.evaluate(() => document.querySelectorAll("[data-tether-mark]").length);
  ok(left === 0, "no marks are left on the page");
  const hooks = await tab.evaluate(() => HTMLInputElement.prototype.click.toString().includes("native code"));
  ok(hooks, "the page's input.click is its own again");

  // ---- bypass mode: no question even on a new site
  await sw.evaluate((h) => setUploadsAllowed(h, false), siteHost);
  await sw.evaluate(() => setBypass(true));
  t = await call("upload_file", { ref: ref('file input "Resume"'), paths: [notes] });
  ok(!t.r.isError && (await got("resume")).startsWith("notes.txt:5"), "bypass mode uploads without asking");
  await sw.evaluate(() => setBypass(false));

  // ---- downloads by id
  const dl = await sw.evaluate(({ p }) => { downloads.set(9901, { id: 9901, filename: p, state: "complete", started: Date.now() }); return 9901; }, { p: cv });
  t = await call("upload_file", { paths: [`download:${dl}`] });
  ok(/cv\.pdf/.test(t.text), "download:<id> resolves to the downloaded file");

  // ---- read only
  await sw.evaluate((id) => setMode(id, "read"), tabId);
  t = await call("upload_file", { ref: ref('file input "Resume"'), paths: [cv] });
  ok(t.r.isError && /read only/.test(t.text), "a read only tab refuses uploads");
  await sw.evaluate((id) => setMode(id, "full"), tabId);
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
