import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { NO_TABS } from "./hub.js";
import { listScripts, getScript, saveScript, deleteScript } from "./scripts.js";

const tab = z.string().optional().describe('Tab handle from list_tabs, e.g. "chrome:812". Optional when only one tab is shared.');
const ref = z.string().describe('Element ref from the latest snapshot, e.g. "e14".');

const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });

export function registerTools(server, hub, agentName) {
  const tool = (name, description, inputSchema, run, annotations = {}) =>
    server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
      try {
        return await run(args);
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: err.message || String(err) }] };
      }
    });

  // After an action, return a fresh snapshot so the agent rarely needs a second call.
  const act = async (args, method, params, summary, timeout) => {
    const { handle } = hub.resolveTab(args.tab);
    hub.activity(agentName(), method, handle, summary);
    const res = await hub.callTab(handle, method, params, timeout);
    const snap = await hub.callTab(handle, "snapshot", { maxLines: 250 }).catch(() => null);
    return text([res?.note, snap?.text].filter(Boolean).join("\n\n") || "Done.");
  };

  tool(
    "list_tabs",
    "List the browser tabs you can use. Normally these are the tabs the user shared by clicking Tether, plus tabs you or those pages opened. If the user has turned on bypass mode, every tab is listed.",
    {},
    async () => {
      const tabs = hub.allTabs();
      if (!tabs.length) return text(NO_TABS);
      const line = (t) => `${t.tab}${t.active ? " (active)" : ""}  ${t.title || "(untitled)"}\n    ${t.url}`;
      const shared = tabs.filter((t) => t.shared !== false);
      const rest = tabs.filter((t) => t.shared === false);
      let out = shared.length ? "Shared tabs:\n" + shared.map(line).join("\n") : "No tab is shared yet.";
      if (rest.length) out += "\n\nOther tabs (bypass mode is on, you may use these too):\n" + rest.map(line).join("\n");
      return text(out);
    },
    { readOnlyHint: true }
  );

  tool(
    "open_tab",
    "Open a URL in a new tab in the user's browser. The new tab is shared with you.",
    { url: z.string(), browser: z.string().optional().describe("Browser key from list_tabs when several browsers are connected."), opener: tab.describe("Shared tab to open next to.") },
    async ({ url, browser, opener }) => {
      const b = opener ? hub.resolveTab(opener).browser : hub.pickBrowser(browser);
      hub.activity(agentName(), "open_tab", null, `opened ${short(url)}`);
      const t = await hub.call(b, "openTab", { url, openerTabId: opener ? hub.resolveTab(opener).tabId : undefined }, 45000);
      const handle = `${b.key}:${t.id}`;
      const snap = await hub.callTab(handle, "snapshot", { maxLines: 250 }).catch(() => null);
      return text(`Opened ${handle}\n\n${snap?.text || ""}`);
    }
  );

  tool("close_tab", "Close a shared tab.", { tab }, async (a) => {
    const { browser, tabId, handle } = hub.resolveTab(a.tab);
    hub.activity(agentName(), "close_tab", handle, "closed the tab");
    await hub.call(browser, "closeTab", { tabId });
    return text(`Closed ${handle}`);
  });

  tool(
    "navigate",
    "Go to a URL in a shared tab, or go back, forward or reload.",
    { tab, url: z.string().optional(), action: z.enum(["back", "forward", "reload"]).optional() },
    (a) => act(a, "navigate", { url: a.url, action: a.action }, a.url ? `went to ${short(a.url)}` : a.action, 45000)
  );

  tool(
    "snapshot",
    "Read the page as an outline of headings, text and interactive elements. Each element you can act on has a ref like [e14]. Take a snapshot before acting and use the refs in click, type and fill_form.",
    { tab, maxLines: z.number().int().optional().describe("Default 400.") },
    async (a) => {
      const { handle } = hub.resolveTab(a.tab);
      const res = await hub.callTab(handle, "snapshot", { maxLines: a.maxLines ?? 400 });
      return text(res.text);
    },
    { readOnlyHint: true }
  );

  tool(
    "read_text",
    "Get the visible text of the page, or of one element, as plain text. Good for reading articles, tables and results.",
    { tab, ref: ref.optional(), maxChars: z.number().int().optional().describe("Default 20000.") },
    async (a) => text((await hub.callTab(a.tab, "readText", { ref: a.ref, maxChars: a.maxChars ?? 20000 })).text),
    { readOnlyHint: true }
  );

  tool("click", "Click an element.", { tab, ref, double: z.boolean().optional() }, (a) => act(a, "click", { ref: a.ref, double: a.double }, `clicked ${a.ref}`));

  tool("hover", "Move the pointer over an element, e.g. to open a menu.", { tab, ref }, (a) => act(a, "hover", { ref: a.ref }, `hovered ${a.ref}`));

  tool(
    "type",
    "Type into a text field or editable area. Replaces the current value unless append is true.",
    { tab, ref, text: z.string(), append: z.boolean().optional(), submit: z.boolean().optional().describe("Press Enter afterwards.") },
    (a) => act(a, "type", { ref: a.ref, text: a.text, append: a.append, submit: a.submit }, `typed into ${a.ref}`)
  );

  tool(
    "fill_form",
    "Fill several fields at once. Text fields take a string, checkboxes and radios take true or false, selects take the option label or value.",
    { tab, fields: z.array(z.object({ ref, value: z.union([z.string(), z.boolean(), z.number()]) })) },
    (a) => act(a, "fill", { fields: a.fields }, `filled ${a.fields.length} field${a.fields.length === 1 ? "" : "s"}`)
  );

  tool(
    "select_option",
    "Choose one or more options in a select element, by label or value.",
    { tab, ref, values: z.array(z.string()) },
    (a) => act(a, "select", { ref: a.ref, values: a.values }, `picked ${a.values.join(", ")}`)
  );

  tool(
    "press_key",
    'Press a key, optionally on an element. Examples: "Enter", "Escape", "Tab", "ArrowDown", "Control+a".',
    { tab, key: z.string(), ref: ref.optional() },
    (a) => act(a, "press", { key: a.key, ref: a.ref }, `pressed ${a.key}`)
  );

  tool(
    "scroll",
    "Scroll an element into view, or scroll the page by a number of pixels.",
    { tab, ref: ref.optional(), dy: z.number().optional().describe("Pixels down (negative scrolls up). Default one screen.") },
    (a) => act(a, "scroll", { ref: a.ref, dy: a.dy }, "scrolled")
  );

  tool(
    "wait_for",
    "Wait until some text appears or disappears, or for a number of milliseconds.",
    { tab, text: z.string().optional(), gone: z.boolean().optional().describe("Wait for the text to disappear instead."), ms: z.number().optional(), timeout: z.number().optional().describe("Default 15000 ms.") },
    async (a) => {
      const res = await hub.callTab(a.tab, "waitFor", { text: a.text, gone: a.gone, ms: a.ms, timeout: a.timeout ?? 15000 }, (a.timeout ?? 15000) + (a.ms ?? 0) + 5000);
      return text(res.note || "Done.");
    },
    { readOnlyHint: true }
  );

  tool(
    "screenshot",
    "Take a screenshot of the visible part of a shared tab. The tab is brought to the front first.",
    { tab },
    async (a) => {
      const { browser, tabId, handle } = hub.resolveTab(a.tab);
      hub.activity(agentName(), "screenshot", handle, "took a screenshot");
      const res = await hub.call(browser, "screenshot", { tabId });
      return { content: [{ type: "image", data: res.data, mimeType: res.mimeType }] };
    },
    { readOnlyHint: true }
  );

  tool(
    "run_js",
    "Run JavaScript in the page's own context (page globals are visible) and return the result of the last expression, awaited if it is a promise. Works on sites with a strict CSP. Use for reading data the outline does not show or driving page APIs directly.",
    { tab, code: z.string() },
    async (a) => {
      const { handle } = hub.resolveTab(a.tab);
      hub.activity(agentName(), "run_js", handle, "ran a script");
      const res = await hub.callTab(handle, "runJs", { code: a.code });
      return text(res.value === undefined ? "undefined" : JSON.stringify(res.value, null, 2));
    }
  );

  tool(
    "upload_file",
    "Attach local files to a file input, as if the user picked them.",
    { tab, ref, paths: z.array(z.string()).describe("Absolute paths on this machine.") },
    async (a) => {
      const files = a.paths.map((p) => {
        const data = fs.readFileSync(p);
        if (data.length > 25 * 1024 * 1024) throw new Error(`${p} is over 25 MB`);
        return { name: path.basename(p), data: data.toString("base64"), type: mime(p) };
      });
      return act(a, "upload", { ref: a.ref, files }, `attached ${files.map((f) => f.name).join(", ")}`, 60000);
    }
  );

  tool(
    "request_bypass",
    "Ask the user for bypass mode, which gives you every open tab in the browser instead of only the shared ones. The browser shows the user a prompt with your reason and waits up to two minutes for an answer. Only ask when the task needs other tabs.",
    { reason: z.string().describe("One sentence the user will read, saying why you need the other tabs."), browser: z.string().optional() },
    async (a) => {
      const b = hub.pickBrowser(a.browser);
      const res = await hub.call(b, "requestBypass", { agent: agentName(), reason: a.reason }, 130000);
      return text(res.note);
    }
  );

  // ---- devtools ----

  tool(
    "network_requests",
    "List network requests made by a shared tab since it was shared (newest last): id, method, status, type, time, size, URL. Use network_request with an id to see headers and bodies.",
    {
      tab,
      filter: z.string().optional().describe("Substring of the URL, or an HTTP method."),
      type: z.string().optional().describe("xhr, fetch, document, script, stylesheet, image, media, font, websocket, other."),
      failedOnly: z.boolean().optional().describe("Only failed requests and HTTP errors."),
      limit: z.number().int().optional().describe("Default 60."),
      clear: z.boolean().optional().describe("Clear the log instead of listing."),
    },
    async (a) => text((await hub.callTab(a.tab, "network", a)).text),
    { readOnlyHint: true }
  );

  tool(
    "network_request",
    "Show one captured request in full: request and response headers, request body and response body.",
    { tab, id: z.string().describe('Request id from network_requests, e.g. "r42".'), maxChars: z.number().int().optional().describe("Body limit, default 20000.") },
    async (a) => text((await hub.callTab(a.tab, "networkDetail", { id: a.id, maxChars: a.maxChars })).text),
    { readOnlyHint: true }
  );

  tool(
    "console_messages",
    "Read console output and uncaught errors from a shared tab since it was shared.",
    { tab, level: z.string().optional().describe("log, info, warning, error, debug."), limit: z.number().int().optional().describe("Default 100."), clear: z.boolean().optional() },
    async (a) => text((await hub.callTab(a.tab, "console", a)).text),
    { readOnlyHint: true }
  );

  tool(
    "cookies",
    "List the cookies the browser would send to the tab's current page, including httpOnly ones.",
    { tab },
    async (a) => text((await hub.callTab(a.tab, "cookies", {})).text),
    { readOnlyHint: true }
  );

  // ---- user scripts ----

  tool(
    "list_scripts",
    "List the user's saved Tether scripts. They live in ~/.tether/scripts and appear in the extension popup on matching sites.",
    {},
    async () => {
      const s = listScripts();
      if (!s.length) return text("No scripts saved yet.");
      return text(s.map((x) => `${x.id}  ${x.name}  [${x.run}]  ${x.matches.join(" ")}\n    ${x.description}`).join("\n"));
    },
    { readOnlyHint: true }
  );

  tool(
    "save_script",
    "Save a reusable script for the user. It shows up in the Tether popup on pages matching `matches`, where the user can run it with one click. With run=auto it runs on every matching page load. The code runs in an isolated world with DOM access; write plain JavaScript, no imports. Saving with an existing name replaces it.",
    {
      name: z.string(),
      description: z.string().optional(),
      matches: z.array(z.string()).describe('Match patterns, e.g. ["https://mail.example.com/*"].'),
      run: z.enum(["manual", "auto"]).optional(),
      code: z.string(),
    },
    async (a) => {
      const s = saveScript(a);
      hub.pushScripts();
      return text(`Saved "${s.name}" as ${s.id}.js. It appears in the popup on ${s.matches.join(", ")}.`);
    }
  );

  tool(
    "run_script",
    "Run a saved script in a shared tab and return its result.",
    { tab, name: z.string() },
    async (a) => {
      const s = getScript(a.name);
      if (!s) throw new Error(`No script called ${a.name}`);
      const { handle } = hub.resolveTab(a.tab);
      hub.activity(agentName(), "run_script", handle, `ran ${s.name}`);
      const res = await hub.callTab(handle, "runJs", { code: s.code });
      return text(res.value === undefined ? `Ran ${s.name}.` : JSON.stringify(res.value, null, 2));
    }
  );

  tool("delete_script", "Delete a saved script.", { name: z.string() }, async (a) => {
    if (!deleteScript(a.name)) throw new Error(`No script called ${a.name}`);
    hub.pushScripts();
    return text(`Deleted ${a.name}.`);
  }, { destructiveHint: true });
}

function short(url) {
  try { const u = new URL(url); return u.host + (u.pathname === "/" ? "" : u.pathname); } catch { return url; }
}

const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", txt: "text/plain", csv: "text/csv", json: "application/json", zip: "application/zip", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", mp4: "video/mp4", mp3: "audio/mpeg", svg: "image/svg+xml", html: "text/html" };
function mime(p) {
  return MIME[path.extname(p).slice(1).toLowerCase()] || "application/octet-stream";
}
