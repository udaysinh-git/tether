// Fast checks that need no browser: every tool carries a title and all four
// MCP annotation hints, and the tools that only touch Tether's own files
// (scripts, styles, watchers, site notes) work end to end over MCP.
// Run: node test/tools.mjs
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tether-tools-"));
const PORT = 47897;
const env = { ...process.env, TETHER_HOME: home, TETHER_PORT: String(PORT) };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => {
  if (!c) { console.error("FAIL:", m, "\n   last output:", String(globalThis.lastOut || "").slice(0, 900)); process.exitCode = 1; }
  else console.log("ok  ", m);
};

fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ port: PORT, key: "test-test-test-test" }));
const host = spawn(process.execPath, [path.join(root, "host", "cli.js"), "serve"], { env, stdio: "ignore" });
for (let i = 0; i < 40; i++) {
  if (await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false)) break;
  await wait(150);
}

const client = new Client({ name: "tools-test", version: "test" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "host", "cli.js")], env, stderr: "inherit" }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const out = { text: r.content.map((c) => c.text ?? `[${c.type}]`).join("\n"), r };
  globalThis.lastOut = `${name}: ${out.text}`;
  return out;
};

try {
  // ---- annotations
  const { tools } = await client.listTools();
  ok(tools.length >= 53, `server lists ${tools.length} tools`);
  const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
  const missing = tools.filter((t) => !HINTS.every((h) => typeof t.annotations?.[h] === "boolean")).map((t) => t.name);
  ok(!missing.length, `every tool sets all four hints as booleans${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  const untitled = tools.filter((t) => !t.title || !t.annotations?.title).map((t) => t.name);
  ok(!untitled.length, `every tool has a title${untitled.length ? ` (missing: ${untitled.join(", ")})` : ""}`);
  const contradict = tools.filter((t) => t.annotations.readOnlyHint && t.annotations.destructiveHint).map((t) => t.name);
  ok(!contradict.length, `no tool is both read-only and destructive${contradict.length ? ` (${contradict.join(", ")})` : ""}`);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  ok(["snapshot", "list_tabs", "cookies", "site_map"].every((n) => byName[n].readOnlyHint), "reading tools are read-only");
  ok(["click", "run_js", "close_tab", "delete_script", "delete_style", "delete_watcher"].every((n) => byName[n].destructiveHint), "tools that can lose data or act on a site are destructive");
  const noDesc = tools.filter((t) => !t.description || t.description.length < 15).map((t) => t.name);
  ok(!noDesc.length, `every tool has a real description${noDesc.length ? ` (${noDesc.join(", ")})` : ""}`);

  // ---- userscripts on disk
  await call("save_script", { name: "Hello", matches: ["https://example.com/*"], code: "return 1;" });
  let t = await call("list_scripts");
  ok(/hello\s+Hello v/.test(t.text), "list_scripts shows a saved script");
  t = await call("get_script", { name: "Hello" });
  ok(/return 1;/.test(t.text), "get_script returns the body");
  t = await call("delete_script", { name: "Hello" });
  ok(/Deleted/.test(t.text) && !fs.existsSync(path.join(home, "scripts", "hello.user.js")), "delete_script removes the file");
  t = await call("get_script", { name: "Hello" });
  ok(t.r.isError, "a deleted script is gone");

  // ---- styles on disk
  await call("save_style", { name: "Calm", matches: ["https://example.com/*"], css: "body { background: #222 !important; }" });
  t = await call("list_styles");
  ok(/calm\s+Calm v/.test(t.text), "list_styles shows a saved style");
  t = await call("get_style", { name: "Calm" });
  ok(/background: #222/.test(t.text), "get_style returns the CSS");
  t = await call("delete_style", { name: "Calm" });
  ok(/Deleted/.test(t.text) && !fs.existsSync(path.join(home, "styles", "calm.user.css")), "delete_style removes the file");
  t = await call("delete_style", { name: "Calm" });
  ok(t.r.isError, "deleting a missing style is an error");

  // ---- watchers on disk
  await call("save_watcher", { name: "Later", url: "https://example.com/", check: "return 1;" });
  t = await call("list_watchers");
  ok(/Later/.test(t.text), "list_watchers shows a saved watcher");
  t = await call("delete_watcher", { name: "Later" });
  ok(/Deleted/.test(t.text), "delete_watcher deletes it");
  t = await call("list_watchers");
  ok(/No watchers/.test(t.text), "the watcher is gone");

  // ---- site notes
  await call("site_notes", { site: "example.com", text: "First." });
  await call("site_notes", { site: "example.com", text: "Second.", append: true });
  t = await call("site_notes", { site: "example.com" });
  ok(/First\.[\s\S]*Second\./.test(t.text), "site_notes writes, appends and reads");
} catch (e) {
  console.error("FAIL: threw", e);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  host.kill();
  console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nall checks passed");
  process.exit();
}
