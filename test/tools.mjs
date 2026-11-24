// Fast checks that need no browser: every tool carries a title and all four
// MCP annotation hints, an agent starts with the core tools and loads the
// rest when it asks, and the tools that only touch Tether's own files
// (scripts, styles, watchers, site notes, flows) work end to end over MCP.
// Run: node test/tools.mjs
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { GROUPS } from "../host/annotations.js";

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

const connect = async (...args) => {
  const c = new Client({ name: "tools-test", version: "test" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "host", "cli.js"), ...args], env, stderr: "inherit" }));
  return c;
};
// The main client asks for every tool up front; `lazy` is what agents get by default.
const client = await connect("--tools", "all");
const lazy = await connect();
let changed = 0;
lazy.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed++; });
const caller = (c) => async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const out = { text: r.content.map((x) => x.text ?? `[${x.type}]`).join("\n"), r };
  globalThis.lastOut = `${name}: ${out.text}`;
  return out;
};
const call = caller(client);
const lcall = caller(lazy);
const names = async (c) => (await c.listTools()).tools.map((x) => x.name);
const size = async (c) => JSON.stringify((await c.listTools()).tools).length;

try {
  // ---- tools load when asked for
  const all = Object.values(GROUPS).flatMap((g) => g.tools);
  let list = await names(lazy);
  ok(list.length === GROUPS.core.tools.length + 2 && GROUPS.core.tools.every((n) => list.includes(n)) && list.includes("load_tools") && list.includes("call_tool"), `an agent starts with the ${GROUPS.core.tools.length} core tools and the two that load the rest`);
  const small = await size(lazy), big = await size(client);
  ok(small < big * 0.45, `the starting tool list is ${Math.round((small / big) * 100)}% the size of the full one (${small} of ${big} characters)`);
  const loader = (await lazy.listTools()).tools.find((x) => x.name === "load_tools");
  ok(Object.keys(GROUPS).filter((g) => g !== "core").every((g) => loader.description.includes(g + ":")), "load_tools names every group and what it is for");
  let t = await lcall("load_tools", { group: "watchers" });
  ok(/Loaded 4 tools/.test(t.text) && /save_watcher\n/.test(t.text) && /"every_minutes"/.test(t.text), "load_tools returns each tool's description and arguments");
  await wait(100);
  list = await names(lazy);
  ok(changed === 1 && GROUPS.watchers.tools.every((n) => list.includes(n)) && !list.includes("save_style"), "the client is told the list changed and now has that group, and only that group");
  t = await lcall("list_watchers");
  ok(/No watchers/.test(t.text), "a loaded tool is called like any other");
  t = await lcall("call_tool", { name: "list_styles" });
  ok(/No styles saved/.test(t.text), "call_tool reaches a tool in a group that was never loaded");
  t = await lcall("call_tool", { name: "save_style", arguments: { name: "X" } });
  ok(t.r.isError && /Wrong arguments for save_style/.test(t.text) && /"css"/.test(t.text), "call_tool checks arguments and shows the tool's schema when they are wrong");
  t = await lcall("call_tool", { name: "nope" });
  ok(t.r.isError && /No Tether tool called nope/.test(t.text), "call_tool refuses a name that doesn't exist");
  t = await lcall("load_tools", { group: "all" });
  list = await names(lazy);
  ok(all.every((n) => list.includes(n)) && !list.includes("load_tools") && !list.includes("call_tool"), "loading everything leaves the full list, without the loaders");

  // ---- a change request reaches the agent on its next call
  const reqDir = path.join(home, "requests", "20260101000000-test");
  fs.mkdirSync(reqDir, { recursive: true });
  fs.writeFileSync(path.join(reqDir, "request.json"), JSON.stringify({ id: "20260101000000-test", text: "Make the header smaller", url: "https://example.com/a", images: [], status: "open", created: Date.now() }));
  const fresh = await connect();
  const fcall = caller(fresh);
  t = await fcall("list_tabs");
  ok(/The user sent a change request from the Tether popup/.test(t.text) && /20260101000000-test on example\.com: "Make the header smaller"/.test(t.text), "an unrelated call is told about a request the user just sent");
  ok((await names(fresh)).includes("get_requests"), "and the tools to handle it are loaded for it");
  t = await fcall("list_tabs");
  ok(!/change request/.test(t.text), "it is told once");
  t = await fcall("get_requests");
  ok(/Make the header smaller/.test(t.text), "get_requests returns it");
  await fcall("resolve_request", { id: "20260101000000-test", reply: "Done." });
  await fresh.close();

  // ---- annotations
  const { tools } = await client.listTools();
  ok(tools.length === all.length && all.every((n) => tools.some((x) => x.name === n)), `with --tools all the server lists all ${tools.length} tools`);
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
  t = await call("list_scripts");
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

  // ---- flows on disk
  t = await call("save_flow", { site: "example.com", name: "Find order", description: "Opens an order.", inputs: [{ name: "id", description: "Order number", example: "88" }], steps: [{ do: "open", url: "https://example.com/orders/{{id}}" }, { do: "click", selector: "#details", role: "button", name: "Details" }] });
  ok(/Saved flow Find order\(id\) for example\.com with 2 steps/.test(t.text) && fs.existsSync(path.join(home, "sites", "example.com", "flows", "find-order.json")), "save_flow writes the flow under its site");
  t = await call("list_flows");
  ok(/example\.com {2}Find order\(id\) {2}2 steps/.test(t.text), "list_flows shows it with its inputs");
  t = await call("list_flows", { name: "find order" });
  ok(/id: Order number \(e\.g\. "88"\)/.test(t.text) && /"selector": "#details"/.test(t.text), "list_flows with a name shows the inputs and steps");
  t = await call("site_list");
  ok(/example\.com.*1 flow/.test(t.text), "site_list counts flows");
  t = await call("site_map", { site: "example.com" });
  ok(/Saved flows[\s\S]*Find order\(id\) {2}Opens an order\./.test(t.text), "site_map lists the site's flows");
  t = await call("save_flow", { site: "example.com", name: "Bad", steps: [{ do: "type", selector: "#a" }] });
  ok(t.r.isError && /needs value/.test(t.text), "save_flow refuses a step that can't run");
  t = await call("run_flow", { name: "Find order" });
  ok(t.r.isError && /No tab is shared|No browser is connected/.test(t.text), "run_flow needs a shared tab");
  t = await call("delete_flow", { name: "Find order" });
  ok(/Deleted flow/.test(t.text) && (await call("list_flows")).text.includes("No flows saved"), "delete_flow removes it");
} catch (e) {
  console.error("FAIL: threw", e);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  await lazy.close().catch(() => {});
  host.kill();
  console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nall checks passed");
  process.exit();
}
