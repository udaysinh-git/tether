// Checks that need neither a browser nor a running host: what `tether setup`
// writes into each agent's config, outline diffs, and flow files.
// Run: node test/unit.mjs
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tether-unit-"));
process.env.TETHER_HOME = path.join(tmp, "tether-home");
const { setupAgents, linkSkill, snippets } = await import("../host/setup.js");
const { outlineDelta } = await import("../host/outline.js");
const { saveFlow, getFlow, listFlows, deleteFlow, draftSteps, holesIn, runFlow } = await import("../host/flows.js");
const { ingest } = await import("../host/sites.js");
const { GROUPS, ANNOTATIONS, LOADERS } = await import("../host/annotations.js");

const ok = (c, m) => {
  if (!c) { console.error("FAIL:", m); process.exitCode = 1; }
  else console.log("ok  ", m);
};
const read = (f) => fs.readFileSync(f, "utf8");

// ---------------------------------------------------------------- tool groups
{
  const grouped = Object.values(GROUPS).flatMap((g) => g.tools);
  const names = Object.keys(ANNOTATIONS).filter((n) => !LOADERS.includes(n));
  ok(new Set(grouped).size === grouped.length, "no tool is in two groups");
  ok(names.every((n) => grouped.includes(n)) && grouped.every((n) => ANNOTATIONS[n]), "every tool is in exactly one group");
  ok(GROUPS.core.tools.length <= 24, `the core group stays small (${GROUPS.core.tools.length} tools)`);
}

// ---------------------------------------------------------------- setup
const node = process.platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/local/bin/node";
const cli = process.platform === "win32" ? "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\tether-browser\\host\\cli.js" : "/usr/local/lib/node_modules/tether-browser/host/cli.js";
{
  const home = path.join(tmp, "home1");
  for (const d of [".claude", ".codex", ".cursor", ".config/opencode"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n');
  fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 4));
  fs.writeFileSync(path.join(home, ".config", "opencode", "opencode.jsonc"), '{\n  // my model\n  "model": "anthropic/claude",\n}\n');
  const ran = [];
  const run = (cmd, args) => { ran.push([cmd, ...args].join(" ")); };

  let rows = setupAgents({ home, node, cli, run });
  const by = (id) => rows.find((r) => r.id === id);
  ok(rows.length === 4 && rows.every((r) => r.status === "added"), "setup adds Tether to all four agents it finds");
  ok(ran.length === 1 && ran[0].startsWith("claude mcp add --scope user tether --") && ran[0].includes(cli), "Claude Code is set up through its own command");

  const toml = read(path.join(home, ".codex", "config.toml"));
  ok(toml.includes('[mcp_servers.other]\ncommand = "x"') && toml.includes(`[mcp_servers.tether]\ncommand = '${node}'\nargs = ['${cli}']`), "Codex gets a block with literal strings and keeps its other servers");

  const cur = JSON.parse(read(path.join(home, ".cursor", "mcp.json")));
  ok(cur.mcpServers.other.command === "x" && cur.mcpServers.tether.command === node && cur.mcpServers.tether.args[0] === cli, "Cursor's mcp.json gains the entry next to the existing one");
  ok(/^ {4}"mcpServers"/m.test(read(path.join(home, ".cursor", "mcp.json"))), "the file keeps its own indentation");

  const oc = read(path.join(home, ".config", "opencode", "opencode.jsonc"));
  ok(oc.includes("// my model") && /"mcp": \{\s+"tether": \{\s+"type": "local"/.test(oc) && oc.indexOf('"mcp"') < oc.indexOf('"model"'), "an OpenCode file with comments is edited as text and keeps them");

  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { tether: { type: "stdio", command: node, args: [cli] } } }));
  rows = setupAgents({ home, node, cli, run });
  ok(rows.every((r) => r.status === "ok") && ran.length === 1, "running setup again changes nothing");
  const before = [".codex/config.toml", ".cursor/mcp.json", ".config/opencode/opencode.jsonc"].map((f) => read(path.join(home, f))).join("|");
  rows = setupAgents({ home, node, cli, run, write: false });
  ok(rows.every((r) => r.status === "ok") && before === [".codex/config.toml", ".cursor/mcp.json", ".config/opencode/opencode.jsonc"].map((f) => read(path.join(home, f))).join("|"), "doctor's dry run reads the same files as set up");

  // Moving the install (a new Node, a new npm prefix) rewrites only Tether's entry.
  const cli2 = cli.replace("tether-browser", "tether-browser-2");
  fs.appendFileSync(path.join(home, ".codex", "config.toml"), "startup_timeout_sec = 20\n\n[mcp_servers.later]\ncommand = \"y\"\n");
  rows = setupAgents({ home, node, cli: cli2, run });
  ok(rows.find((r) => r.id === "codex").status === "updated" && rows.find((r) => r.id === "cursor").status === "updated", "a moved install is updated in place");
  const toml2 = read(path.join(home, ".codex", "config.toml"));
  ok(toml2.includes(`args = ['${cli2}']`) && !toml2.includes(`args = ['${cli}']`) && toml2.includes("startup_timeout_sec = 20") && toml2.includes('[mcp_servers.later]\ncommand = "y"'), "Codex keeps the block's other settings and the tables after it");
  ok(ran.some((c) => c.startsWith("claude mcp remove")) && ran.at(-1).includes(cli2), "Claude Code's entry is replaced");
  ok(by("opencode") && rows.find((r) => r.id === "opencode").status === "manual" && JSON.parse(rows.find((r) => r.id === "opencode").snippet).mcp.tether.command[1] === cli2, "a commented OpenCode file that already has an mcp section is left alone, with the snippet to paste");
}
{
  // OpenCode 2 groups servers under mcp.servers; a fresh install gets a new file.
  const home = path.join(tmp, "home2");
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ mcp: { servers: { pw: { type: "local", command: ["x"] } } } }, null, 2));
  let rows = setupAgents({ home, node, cli, run: () => {} });
  const cfg = JSON.parse(read(path.join(home, ".config", "opencode", "opencode.json")));
  ok(rows.length === 1 && cfg.mcp.servers.tether.command[1] === cli && cfg.mcp.servers.pw && !cfg.mcp.tether, "OpenCode 2 configs get the entry under mcp.servers");

  const home3 = path.join(tmp, "home3");
  fs.mkdirSync(path.join(home3, ".cursor"), { recursive: true });
  fs.mkdirSync(path.join(home3, ".claude"), { recursive: true });
  rows = setupAgents({ home: home3, node, cli, run: () => { throw new Error("not found"); } });
  ok(JSON.parse(read(path.join(home3, ".cursor", "mcp.json"))).mcpServers.tether.args[0] === cli, "a missing mcp.json is created");
  const cl = rows.find((r) => r.id === "claude");
  ok(cl.status === "manual" && cl.snippet === snippets(node, cli).claude, "without the claude command on PATH the line is printed instead");
  ok(setupAgents({ home: path.join(tmp, "nobody"), node, cli }).length === 0, "agents that aren't installed are skipped");

  fs.writeFileSync(path.join(home3, ".cursor", "mcp.json"), "{ not json");
  rows = setupAgents({ home: home3, node, cli, run: () => {} });
  ok(rows.find((r) => r.id === "cursor").status === "manual" && read(path.join(home3, ".cursor", "mcp.json")) === "{ not json", "a config that can't be parsed is never overwritten");
}
{
  const home = path.join(tmp, "home4");
  for (const d of [".claude", ".cursor"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  const skillDir = path.resolve(import.meta.dirname, "..", "skills", "tether-browser");
  let rows = linkSkill({ home, skillDir });
  ok(rows.map((r) => r.dir).join() === ".claude/skills,.agents/skills" && rows.every((r) => r.status === "added"), "the skill is linked where the installed agents read it");
  ok(fs.existsSync(path.join(home, ".agents", "skills", "tether-browser", "SKILL.md")), "the link reaches SKILL.md");
  ok(linkSkill({ home, skillDir }).every((r) => r.status === "ok"), "linking again changes nothing");
  // A stale link (an old install) is replaced; a real folder is left alone.
  const stale = path.join(home, ".claude", "skills", "tether-browser");
  fs.unlinkSync(stale);
  fs.symlinkSync(path.join(tmp, "gone"), stale, process.platform === "win32" ? "junction" : "dir");
  const own = path.join(home, ".agents", "skills", "tether-browser");
  fs.unlinkSync(own);
  fs.mkdirSync(own);
  fs.writeFileSync(path.join(own, "SKILL.md"), "mine");
  rows = linkSkill({ home, skillDir });
  ok(rows[0].status === "updated" && fs.existsSync(path.join(stale, "SKILL.md")), "a link to an install that is gone is pointed at this one");
  ok(rows[1].status === "own" && read(path.join(own, "SKILL.md")) === "mine", "a folder the user made themselves is not touched");
}

// ---------------------------------------------------------------- outline diffs
{
  const head = (scroll) => `Page: Orders\nURL: https://shop.test/orders\nScroll: ${scroll}`;
  const rows = Array.from({ length: 60 }, (_, i) => `text: Order ${i}`);
  const page = (lines, scroll = "page fits the window") => `${head(scroll)}\n\n${lines.join("\n")}`;
  const a = page(["# Orders", "form \"Filter\":", "  textbox \"Search\" [e1] value=\"\"", "  button \"Apply\" [e2]", ...rows]);
  const b = page(["# Orders", "form \"Filter\":", "  textbox \"Search\" [e1] value=\"shoes\"", "  button \"Apply\" [e2]", "  text: 3 results", ...rows]);
  const d = outlineDelta(a, b);
  ok(d && d.length < b.length / 2, `a small change comes back as a short diff (${d?.length} of ${b.length} characters)`);
  ok(/^- {3}textbox "Search" \[e1\] value=""$/m.test(d) && /^\+ {3}textbox "Search" \[e1\] value="shoes"$/m.test(d) && /^\+ {3}text: 3 results$/m.test(d), "the diff has the removed and added lines");
  ok(/^ {2}form "Filter":$/m.test(d) && !d.includes("Order 7"), "it names the form the change is in and leaves the rest out");
  ok(d.startsWith(head("page fits the window")) && /Call snapshot/.test(d), "it keeps the page header and says how to get the whole outline");
  ok(/same as the one you last got/.test(outlineDelta(a, a)), "no change says so in one line");
  ok(outlineDelta(a, b.replace("/orders", "/orders/7")) === null, "another URL gets the whole outline");
  ok(outlineDelta(a, page(rows.map((r) => r + " shipped"))) === null, "a page that mostly changed gets the whole outline");
  ok(outlineDelta(page(["# A", "text: x"]), page(["# A", "text: y"])) === null, "a short page gets the whole outline");
  ok(outlineDelta(null, a) === null, "the first outline of a tab is whole");
}

// ---------------------------------------------------------------- flows
{
  const steps = [
    { do: "open", url: "https://erp.test/invoices/{{invoice}}" },
    { do: "type", selector: "#amount", role: "textbox", name: "Amount", value: "{{amount}}" },
    { do: "click", selector: "#pay", role: "button", name: "Pay" },
  ];
  ok(holesIn(steps).join() === "invoice,amount", "placeholders are found in steps");
  const f = saveFlow({ site: "https://erp.test/x", name: "Pay invoice", inputs: [{ name: "amount", description: "Amount in rupees", example: "1200" }], steps });
  ok(f.id === "pay-invoice" && f.site === "erp.test" && f.inputs.map((i) => i.name).join() === "amount,invoice", "a flow is saved per site, and undeclared placeholders become inputs");
  ok(getFlow("pay invoice").steps.length === 3 && getFlow("Pay invoice", "erp.test").id === "pay-invoice" && listFlows().length === 1, "it is found by name, with or without the site");
  let err = "";
  try { saveFlow({ site: "erp.test", name: "Bad", steps: [{ do: "click" }] }); } catch (e) { err = e.message; }
  ok(/Step 1 \(click\) needs selector or name/.test(err), "a step without a target is refused with the reason");
  try { await runFlow(null, "x:1", f, { amount: "5" }); } catch (e) { err = e.message; }
  ok(/needs these inputs: invoice/.test(err), "running without an input names the one that is missing");

  // A fake browser that answers the calls a flow makes.
  const calls = [];
  const hub = {
    callTab: async (_h, method, p) => {
      calls.push(`${method} ${p.url || p.ref || ""} ${p.text ?? ""}`.trim());
      if (method === "find") return p.selector === "#gone" ? Promise.reject(new Error("No element on this page matches selector #gone.")) : { ref: "e" + p.selector.length };
      return { note: `${method} ok` };
    },
  };
  let r = await runFlow(hub, "x:1", f, { amount: "1200", invoice: 88 }, { agent: "T" });
  ok(r.next === null && r.done.length === 3 && calls.join("|") === "navigate https://erp.test/invoices/88|find|type e7 1200|find|click e4", "a run fills the inputs in and makes one call per step");
  ok(getFlow("Pay invoice").runs === 1, "a finished run is counted");
  const broken = saveFlow({ site: "erp.test", name: "Broken", steps: [{ do: "click", selector: "#pay" }, { do: "click", selector: "#gone", timeout_seconds: 0.2 }, { do: "click", selector: "#pay" }] });
  r = await runFlow(hub, "x:1", broken, {});
  ok(r.why === "failed" && r.next === 1 && r.done.length === 1 && /No element/.test(r.note), "a step whose element is gone stops the run at that step");
  r = await runFlow(hub, "x:1", broken, {}, { from: 2 });
  ok(r.next === null && r.done[0].startsWith("3."), "a run can continue from a later step");
  ok(deleteFlow("Broken").id === "broken" && listFlows("erp.test").length === 1, "a flow can be deleted");

  // Drafting from a recording.
  const t = Date.now();
  const tg = (selector, role, name) => ({ selector, role, name, tag: "x" });
  ingest("chrome", [
    { kind: "nav", session: "s1", t, url: "https://erp.test/invoices", title: "Invoices" },
    { kind: "page", session: "s1", t: t + 1, url: "https://erp.test/invoices", outline: "Page: Invoices" },
    { kind: "click", session: "s1", t: t + 2, url: "https://erp.test/invoices", target: tg("#new", "button", "New invoice") },
    { kind: "nav", session: "s1", t: t + 3, url: "https://erp.test/invoices/new", title: "New" },
    { kind: "input", session: "s1", t: t + 4, url: "https://erp.test/invoices/new", target: tg("#amount", "textbox", "Amount"), value: "12" },
    { kind: "input", session: "s1", t: t + 5, url: "https://erp.test/invoices/new", target: tg("#amount", "textbox", "Amount"), value: "1200" },
    { kind: "input", session: "s1", t: t + 6, url: "https://erp.test/invoices/new", target: tg("#pin", "textbox", "PIN"), value: "(hidden)" },
    { kind: "select", session: "s1", t: t + 7, url: "https://erp.test/invoices/new", target: tg("#cur", "combobox", "Currency"), value: "INR" },
    { kind: "toggle", session: "s1", t: t + 8, url: "https://erp.test/invoices/new", target: tg("#gst", "checkbox", "Add GST"), value: true },
    { kind: "net", session: "s1", t: t + 9, url: "https://erp.test/api/invoices", method: "POST", status: 200 },
    { kind: "key", session: "s1", t: t + 10, url: "https://erp.test/invoices/new", key: "Enter", target: tg("#amount", "textbox", "Amount") },
    { kind: "submit", session: "s1", t: t + 11, url: "https://erp.test/invoices/new", target: tg("form", "form", "Invoice") },
  ]);
  const draft = draftSteps("erp.test", "s1");
  ok(draft.map((s) => s.do).join() === "open,click,type,ask_user,select,check,press", "a recording becomes steps: one open, the clicks and fields, no network noise");
  ok(draft[2].value === "1200" && draft[3].message.includes("PIN") && !JSON.stringify(draft).includes("(hidden)"), "typing is collapsed to its last value and a masked field becomes an ask_user step");
  ok(saveFlow({ site: "erp.test", name: "New invoice", steps: draft }).steps.length === 7, "the draft saves as it is");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(process.exitCode ? "\nSOME CHECKS FAILED" : "\nall checks passed");
