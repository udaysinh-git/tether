import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { NO_TABS, NO_BROWSER } from "./hub.js";
import { list, get, save, remove, importText } from "./scripts.js";
import { listSites, sessionsOf, readSession, siteMap, readNotes, writeNotes, resolveHost } from "./sites.js";
import { listRequests, imagesOf, resolveRequest } from "./requests.js";
import { saveMedia, formatMedia } from "./media.js";
import { listWatchers, getWatcher, saveWatcher, runWatcher, deleteWatcher } from "./watchers.js";
import { saveShots } from "./gallery.js";
import { ANNOTATIONS, annotationsFor } from "./annotations.js";

const tab = z.string().optional().describe('Tab handle from list_tabs, e.g. "chrome:812". Optional when only one tab is shared.');
const ref = z.string().describe('Element ref from the latest snapshot, e.g. "e14".');

const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 2) }] });

export function registerTools(server, hub, agentName) {
  const tool = (name, description, inputSchema, run) =>
    server.registerTool(name, { title: ANNOTATIONS[name]?.title, description, inputSchema, annotations: annotationsFor(name) }, async (args) => {
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
      if (!tabs.length) return text(hub.browsers.size ? NO_TABS : NO_BROWSER);
      const line = (t) => `${t.tab}${t.active ? " (active)" : ""}  ${t.title || "(untitled)"}\n    ${t.url}`;
      const shared = tabs.filter((t) => t.shared !== false);
      const rest = tabs.filter((t) => t.shared === false);
      let out = shared.length ? "Shared tabs:\n" + shared.map(line).join("\n") : "No tab is shared yet.";
      if (rest.length) out += "\n\nOther tabs (bypass mode is on, you may use these too):\n" + rest.map(line).join("\n");
      return text(out);
    }
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
    }
  );

  tool(
    "read_text",
    "Get the visible text of the page, or of one element, as plain text. Good for reading articles, tables and results.",
    { tab, ref: ref.optional(), maxChars: z.number().int().optional().describe("Default 20000.") },
    async (a) => text((await hub.callTab(a.tab, "readText", { ref: a.ref, maxChars: a.maxChars ?? 20000 })).text)
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
    }
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
    }
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

  // ---- watchers ----

  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

  tool(
    "save_watcher",
    `Watch a page and notify the user when something they care about happens ("tell me when the price drops below 2000", "when results are posted"). The browser fetches the page on a schedule with the user's cookies. mode=fetch (default) loads the URL without rendering it, so point it at the JSON API you found with network_requests when there is one; check is a function body that receives response = { status, url, text, json, contentType } and has no DOM. mode=tab opens the page in a background tab for a moment, for pages built by JavaScript; check runs in the page with full DOM access. check either returns a value (the user is notified when it changes from the last run) or { notify: true/false, message, value }. Notifications go to a browser notification and, with notify including "ntfy", to the user's ntfy topic. Test with run_watcher.`,
    {
      name: z.string(),
      url: z.string(),
      check: z.string().describe("JavaScript function body. Return a value, or { notify, message, value }."),
      mode: z.enum(["fetch", "tab"]).optional(),
      every_minutes: z.number().int().optional().describe("Default 30, minimum 1."),
      notify: z.array(z.enum(["browser", "ntfy"])).optional().describe('Default ["browser"].'),
      description: z.string().optional(),
    },
    async (a) => {
      const w = saveWatcher(a);
      hub.pushWatchers();
      return text(`Saved watcher "${w.name}": every ${w.every} min, ${w.mode} mode, notifying by ${w.notify.join(" and ")}. Run it once with run_watcher to check the result.`);
    }
  );

  tool("list_watchers", "List watchers with their last result.", {}, async () => {
    const all = listWatchers();
    if (!all.length) return text("No watchers yet.");
    return text(all.map((w) => `${w.id}  ${w.name}  every ${w.every} min  ${w.mode}${w.enabled ? "" : "  (off)"}\n    ${w.url}\n    ${w.last ? (w.last.ok ? `last: ${w.last.message ?? ""} (${ago(w.last.at)})` : `last run failed: ${w.last.error} (${ago(w.last.at)})`) : "not run yet"}`).join("\n"));
  });

  tool(
    "run_watcher",
    "Run a watcher now and return what its check produced. Set notify to true to send the notification if it fires; by default this is a dry run that still records the value as the new baseline.",
    { name: z.string(), notify: z.boolean().optional() },
    async (a) => {
      const w = getWatcher(a.name);
      if (!w) throw new Error(`No watcher called ${a.name}`);
      const r = await runWatcher(hub, w, { notify: !!a.notify });
      hub.pushWatchers();
      return text(`value: ${JSON.stringify(r.value)}\nmessage: ${r.message ?? ""}\nwould notify: ${r.notified || (a.notify ? "no" : "dry run")}`);
    }
  );

  tool("delete_watcher", "Delete a watcher.", { name: z.string() }, async (a) => {
    if (!deleteWatcher(a.name)) throw new Error(`No watcher called ${a.name}`);
    hub.pushWatchers();
    return text(`Deleted ${a.name}.`);
  });

  // ---- media ----

  tool(
    "list_media",
    "List the media on a shared tab: images, video and audio (with size, length, playing state), canvases and CSS background images, plus HLS/DASH streams and media files the page loaded (from the network log). Each has an id like m3 for save_media. Streams only appear after the page has requested them, so start playback first.",
    { tab },
    async (a) => {
      const res = await hub.callTab(a.tab, "listMedia", {});
      return text(res.items.length ? formatMedia(res.items) : "No media found on this page.");
    }
  );

  tool(
    "save_media",
    "Save an item from list_media (or any URL) to disk under ~/.tether/media/<site>/, using the browser's cookies. Handles normal files, blob: and data: URLs, canvases, and HLS/DASH streams (through ffmpeg). Returns the file path.",
    { tab, id: z.string().optional().describe("Id from list_media, e.g. m3."), url: z.string().optional(), filename: z.string().optional(), timeout_seconds: z.number().int().optional().describe("Default 900, for long streams.") },
    async (a) => {
      if (!a.id && !a.url) throw new Error("Pass id (from list_media) or url.");
      const { handle } = hub.resolveTab(a.tab);
      hub.activity(agentName(), "save_media", handle, "is saving media");
      const r = await saveMedia(hub, handle, { id: a.id, url: a.url, filename: a.filename, timeoutSeconds: a.timeout_seconds });
      return text(`${r.path}${r.bytes != null ? `\n${Math.round(r.bytes / 1024)} KB` : ""}${r.type ? `, ${r.type}` : ""}${r.note ? `\n${r.note}` : ""}`);
    }
  );

  tool(
    "video_frame",
    "Get the current frame of a video on a shared tab as an image. Falls back to a cropped screenshot when the site doesn't allow reading the video.",
    { tab, ref: ref.describe("The video's ref from list_media or snapshot.") },
    async (a) => {
      const { handle } = hub.resolveTab(a.tab);
      const r = await hub.callTab(handle, "videoFrame", { ref: a.ref }, 45000);
      const m = /^data:([^;]+);base64,(.*)$/.exec(r.dataUrl || "");
      if (!m) throw new Error("Couldn't capture the frame.");
      return { content: [{ type: "text", text: `Frame at ${r.time?.toFixed?.(1) ?? "?"}s${r.fromScreenshot ? " (cropped from a screenshot; the site blocks reading the video)" : ""}` }, { type: "image", data: m[2], mimeType: m[1] }] };
    }
  );

  // ---- downloads ----

  const dl = (d) => (d ? `${d.filename || "(no file yet)"}\n  ${d.state || "in_progress"}${d.error ? ` (${d.error})` : ""}${d.bytes != null ? `, ${Math.round(d.bytes / 1024)} KB` : ""}${d.mime ? `, ${d.mime}` : ""}${d.note ? `, ${d.note}` : ""}\n  from ${d.url}` : "");
  const browserFor = (a) => (a.tab ? hub.resolveTab(a.tab).browser : hub.pickBrowser(a.browser));

  tool(
    "wait_for_download",
    "After clicking something that downloads a file (an invoice, a CSV export, a PDF), wait for it to finish and get its path on disk. Downloads that started in the last 15 seconds count, so call it right after the click.",
    { tab, timeout_seconds: z.number().int().optional().describe("Default 60."), browser: z.string().optional() },
    async (a) => {
      const secs = a.timeout_seconds ?? 60;
      const res = await hub.call(browserFor(a), "waitDownload", { timeout: secs * 1000 }, secs * 1000 + 10000);
      return text(res.item ? dl(res.item) : `No download started within ${secs}s.`);
    }
  );

  tool(
    "download_file",
    "Download a URL through the user's browser, with their cookies, and get the saved file's path. Limited to sites of shared tabs unless bypass mode is on.",
    { url: z.string(), filename: z.string().optional().describe("File name inside the browser's download folder."), tab, browser: z.string().optional() },
    async (a) => {
      const res = await hub.call(browserFor(a), "download", { url: a.url, filename: a.filename }, 135000);
      return text(res.item ? dl(res.item) : "The download didn't finish within two minutes.");
    }
  );

  tool(
    "list_downloads",
    "List files downloaded while tabs were shared with you (not the user's whole download history).",
    { tab, browser: z.string().optional() },
    async (a) => {
      const res = await hub.call(browserFor(a), "downloads", {});
      return text(res.list.length ? res.list.map(dl).join("\n") : "No downloads yet in this session.");
    }
  );

  tool(
    "wait_for_user",
    "Hand a shared tab to the user and wait for them. With message, the page shows it with a Done button and brings the tab to the front: use it for CAPTCHAs, 2FA codes, logins, payment confirmation or any choice that is theirs. Without message, it waits for the user to resume a tab they paused (actions on a paused tab fail with a note saying so). Returns when they press Done or Resume, or after the timeout.",
    { tab, message: z.string().optional().describe("What the user should do, in one or two sentences."), timeout_seconds: z.number().int().optional().describe("Default 300, at most 900.") },
    async (a) => {
      const secs = Math.min(Math.max(a.timeout_seconds ?? 300, 5), 900);
      const { handle } = hub.resolveTab(a.tab);
      if (a.message) hub.activity(agentName(), "wait_for_user", handle, "is waiting for you");
      const res = await hub.callTab(handle, "waitUser", { agent: agentName(), message: a.message, timeout: secs * 1000 }, secs * 1000 + 10000);
      if (!res.resumed) return text(res.note);
      const snap = await hub.callTab(handle, "snapshot", { maxLines: 250 }).catch(() => null);
      return text(`${res.note}${snap?.text ? "\n\n" + snap.text : ""}`);
    }
  );

  tool(
    "start_session",
    "Start working in the user's own browser (their logins and cookies) when no tab is shared yet. mode=window (default) opens a separate window for you, so the user's tabs are left alone; every tab you open in it is yours. mode=current asks to use the tab the user is looking at, for tasks about the page they're on. The user approves in a prompt (up to two minutes). Returns the tab handle and a snapshot.",
    {
      mode: z.enum(["window", "current"]).optional(),
      url: z.string().optional().describe("For mode=window: the page to open first."),
      reason: z.string().describe("One sentence the user will read, saying what you're about to do."),
      browser: z.string().optional().describe("Browser key when several are connected."),
    },
    async (a) => {
      const b = hub.pickBrowser(a.browser);
      const res = await hub.call(b, "startSession", { agent: agentName(), reason: a.reason, url: a.url, mode: a.mode || "window" }, 135000);
      if (!res.granted) return text(res.note);
      const handle = `${b.key}:${res.tabId}`;
      await new Promise((r) => setTimeout(r, 200));
      const snap = a.url || a.mode === "current" ? await hub.callTab(handle, "snapshot", { maxLines: 250 }).catch(() => null) : null;
      return text(`${res.note}\nTab: ${handle}${res.windowId != null && a.mode !== "current" ? `  (window ${res.windowId})` : ""}${snap?.text ? "\n\n" + snap.text : ""}`);
    }
  );

  tool(
    "end_session",
    "Finish a session you started: closes the window start_session opened for you (all of them if you don't name one). With tab, stops using that shared tab instead, leaving it open for the user.",
    { tab: tab.describe("Stop using this tab rather than closing your window."), windowId: z.number().int().optional() },
    async (a) => {
      if (a.tab) {
        const { browser, tabId } = hub.resolveTab(a.tab);
        return text((await hub.call(browser, "endSession", { tabId })).note);
      }
      const notes = [];
      for (const b of hub.browsers.values()) notes.push((await hub.call(b, "endSession", { windowId: a.windowId })).note);
      return text(notes.join("\n") || "Nothing to end.");
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
    async (a) => text((await hub.callTab(a.tab, "network", a)).text)
  );

  tool(
    "network_request",
    "Show one captured request in full: request and response headers, request body and response body.",
    { tab, id: z.string().describe('Request id from network_requests, e.g. "r42".'), maxChars: z.number().int().optional().describe("Body limit, default 20000.") },
    async (a) => text((await hub.callTab(a.tab, "networkDetail", { id: a.id, maxChars: a.maxChars })).text)
  );

  tool(
    "console_messages",
    "Read console output and uncaught errors from a shared tab since it was shared.",
    { tab, level: z.string().optional().describe("log, info, warning, error, debug."), limit: z.number().int().optional().describe("Default 100."), clear: z.boolean().optional() },
    async (a) => text((await hub.callTab(a.tab, "console", a)).text)
  );

  tool(
    "cookies",
    "List the cookies the browser would send to the tab's current page, including httpOnly ones.",
    { tab },
    async (a) => text((await hub.callTab(a.tab, "cookies", {})).text)
  );

  // ---- user scripts (Tampermonkey-compatible .user.js files) ----

  const where = (s) => (s.matches.length ? s.matches : s.includes).join(", ") || "every site";

  tool(
    "list_scripts",
    "List the user's userscripts: ones you saved and ones they imported. They live in ~/.tether/scripts as .user.js files, appear in the Tether popup on matching sites, and work unchanged in Tampermonkey or Violentmonkey.",
    {},
    async () => {
      const s = list("script");
      if (!s.length) return text("No scripts saved yet.");
      return text(s.map((x) => `${x.id}  ${x.name} v${x.version}  [${x.run}]  ${where(x)}${x.body === undefined ? "  (imported)" : ""}\n    ${x.description}`).join("\n"));
    }
  );

  tool(
    "save_script",
    "Save a reusable userscript. `code` is the body of a function: plain JavaScript with full DOM access in the page, no imports; use `return` to hand a result back to run_script. These GM_ APIs work in Tether and in Tampermonkey: GM_addStyle, GM_getValue, GM_setValue, GM_deleteValue, GM_listValues, GM_xmlhttpRequest, GM_openInTab, GM_setClipboard, GM_notification, unsafeWindow. run=manual puts a Run button in the popup (and a menu command in Tampermonkey); run=auto runs on every matching page load. Saving an existing name replaces it and bumps its version.",
    {
      name: z.string(),
      description: z.string().optional(),
      matches: z.array(z.string()).describe('Match patterns, e.g. ["https://mail.example.com/*"].'),
      run: z.enum(["manual", "auto"]).optional(),
      runAt: z.enum(["document-start", "document-end", "document-idle"]).optional().describe("For run=auto. Default document-idle."),
      code: z.string(),
    },
    async (a) => {
      const s = save("script", a);
      hub.pushScripts();
      return text(`Saved "${s.name}" v${s.version} as ~/.tether/scripts/${s.id}.user.js (${s.run}, on ${where(s)}). The same file installs in Tampermonkey or Violentmonkey.`);
    }
  );

  tool("get_script", "Read a saved script, to change it. Returns the editable body for scripts you saved, or the whole file for imported ones.", { name: z.string() }, async (a) => {
    const s = get("script", a.name);
    if (!s) throw new Error(`No script called ${a.name}`);
    return text(s.body !== undefined ? `${s.name} v${s.version} [${s.run}] on ${where(s)}\n\n${s.body}` : s.code);
  });

  tool(
    "run_script",
    "Run a saved script in a shared tab and return its result.",
    { tab, name: z.string() },
    async (a) => {
      const s = get("script", a.name);
      if (!s) throw new Error(`No script called ${a.name}`);
      const { handle } = hub.resolveTab(a.tab);
      hub.activity(agentName(), "run_script", handle, `ran ${s.name}`);
      const res = await hub.callTab(handle, "runItem", { id: s.id });
      return text(res.value === undefined ? `Ran ${s.name}.` : JSON.stringify(res.value, null, 2));
    }
  );

  tool(
    "install_userscript",
    "Install a userscript (.user.js) or user style (.user.css) from a URL, such as Greasy Fork, OpenUserJS or userstyles.world, or from pasted text. It is saved unchanged. @require'd libraries and style preprocessors (Stylus, Less) are not supported.",
    { url: z.string().optional(), text: z.string().optional() },
    async (a) => {
      let src = a.text;
      if (a.url) {
        const r = await fetch(a.url, { redirect: "follow", signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error(`Download failed: HTTP ${r.status}`);
        src = await r.text();
      }
      if (!src) throw new Error("Pass a url or text.");
      const item = importText(src, a.url ? new URL(a.url).pathname.split("/").pop() : "");
      hub.pushScripts();
      const warn = item.requires?.length ? ` It @requires ${item.requires.length} external librar${item.requires.length === 1 ? "y" : "ies"}, which Tether does not load.` : item.unsupported ? ` Note: it ${item.unsupported}.` : "";
      return text(`Installed ${item.kind} "${item.name}" v${item.version} as ${item.id}.${warn}`);
    }
  );

  // ---- change requests from the popup ----

  tool(
    "get_requests",
    "Read change requests the user sent from the Tether popup: what they want changed on a site, often with reference images (screenshots, mockups, mood boards). The tab they sent it from is shared with you. Handle open requests, then call resolve_request.",
    { status: z.enum(["open", "all"]).optional().describe("Default open."), id: z.string().optional() },
    async (a) => {
      let reqs = listRequests({ status: a.id ? "all" : a.status || "open" });
      if (a.id) reqs = reqs.filter((r) => r.id === a.id);
      if (!reqs.length) return text(a.id ? `No request ${a.id}.` : "No open requests. The user can send one from the Tether popup with “Request a change”.");
      const content = [];
      for (const r of reqs.slice(0, 5)) {
        const head = `Request ${r.id} (${r.status}) from ${r.tab || "a tab"}\n${r.title ? r.title + "\n" : ""}${r.url}`;
        const e = r.element;
        const picked = e
          ? `\n\nThe user picked this element on the page:\n  ${e.role} "${e.name || ""}"\n  selector: ${e.selector}${e.context ? `\n  inside: "${e.context}"` : ""}\n  size: ${Math.round(e.viewport?.width || 0)}x${Math.round(e.viewport?.height || 0)} px${e.text ? `\n  text: ${JSON.stringify(e.text.slice(0, 300))}` : ""}${e.outline ? `\n  outline:\n${e.outline.split("\n").slice(0, 40).map((l) => "    " + l).join("\n")}` : ""}${e.html ? `\n  html: ${e.html.slice(0, 1500)}` : ""}`
          : "";
        const tail = picked + (r.images.length ? `\n\n${r.images.length} image(s) attached${e ? " (the element, then the whole page)" : ""}:` : "") + (r.reply ? `\n\nYour reply: ${r.reply}` : "");
        content.push({ type: "text", text: `${head}\n\n${r.text || "(no text)"}${tail}` });
        for (const img of imagesOf(r)) content.push({ type: "image", data: img.data, mimeType: img.mimeType });
      }
      if (reqs.length > 5) content.push({ type: "text", text: `${reqs.length - 5} more not shown.` });
      return { content };
    }
  );

  tool(
    "resolve_request",
    "Mark a change request done and leave a short reply the user sees in the popup (what you changed, and how to turn it off).",
    { id: z.string(), reply: z.string() },
    async (a) => {
      resolveRequest(a.id, a.reply);
      hub.pushRequests();
      return text(`Resolved ${a.id}.`);
    }
  );

  // ---- styles ----

  tool(
    "apply_css",
    "Preview CSS on a shared tab without saving it. Each call replaces the previous preview on that tab; navigation clears it. Check the result with screenshot, then save_style.",
    { tab, css: z.string() },
    async (a) => {
      const { handle } = hub.resolveTab(a.tab);
      hub.activity(agentName(), "apply_css", handle, "is previewing a new look");
      await hub.callTab(handle, "previewCss", { css: a.css });
      return text("Preview applied. Take a screenshot to check it.");
    }
  );

  tool("clear_preview", "Remove the CSS preview from a tab.", { tab }, async (a) => {
    await hub.callTab(a.tab, "previewCss", { css: "" });
    return text("Preview removed.");
  });

  tool(
    "save_style",
    "Save CSS that restyles a site on every visit, in every connected browser. It is stored as a UserCSS file (~/.tether/styles/<id>.user.css) that also installs unchanged in Stylus. It shows in the popup on matching pages, where the user can switch it off. Saving an existing name replaces it and bumps its version. Use !important where the site's own rules win. For changes CSS can't do, pair it with save_script (run=auto).",
    { name: z.string(), description: z.string().optional(), matches: z.array(z.string()).describe('Match patterns, e.g. ["https://mail.google.com/*"].'), css: z.string(), tab: tab.describe("A shared tab the style applies to. Before and after screenshots of it go into the user's gallery.") },
    async (a) => {
      const s = save("style", a);
      hub.pushScripts();
      let shots = "";
      if (a.tab) {
        try {
          await new Promise((r) => setTimeout(r, 600)); // let the browser receive and apply it
          const r = await hub.callTab(a.tab, "styleShots", { id: s.id }, 45000);
          saveShots("style", s.id, r);
          shots = " Before and after screenshots are in the gallery on Tether's settings page.";
        } catch (e) {
          shots = ` (Couldn't take gallery screenshots: ${e.message})`;
        }
      }
      return text(`Saved style "${s.name}" v${s.version} as ~/.tether/styles/${s.id}.user.css. It applies now on open matching tabs and on every visit. The file installs as-is in Stylus.${shots}`);
    }
  );

  tool("list_styles", "List saved site styles, yours and imported ones.", {}, async () => {
    const s = list("style");
    return text(s.length ? s.map((x) => `${x.id}  ${x.name} v${x.version}  ${x.matches.join(" ") || "every site"}${x.body === undefined ? "  (imported)" : ""}\n    ${x.description}`).join("\n") : "No styles saved yet.");
  });

  tool("get_style", "Read a saved style, to change it. Returns the editable CSS for styles you saved, or the whole UserCSS file for imported ones.", { name: z.string() }, async (a) => {
    const s = get("style", a.name);
    if (!s) throw new Error(`No style called ${a.name}`);
    return text(s.body !== undefined ? `${s.name} v${s.version} on ${s.matches.join(", ") || "every site"}\n\n${s.body}` : s.code);
  });

  tool("delete_style", "Delete a saved style.", { name: z.string() }, async (a) => {
    if (!remove("style", a.name)) throw new Error(`No style called ${a.name}`);
    hub.pushScripts();
    return text(`Deleted ${a.name}.`);
  });

  // ---- what Tether recorded about sites ----

  tool(
    "site_list",
    "List sites Tether has recorded the user using (clicks, typing, pages, API calls), and sites with saved notes.",
    {},
    async () => {
      const s = listSites();
      if (!s.length) return text("Nothing recorded yet. The user can record from the Tether popup (Record this tab, or Always record on a site).");
      return text(s.map((x) => `${x.host}  ${x.sessions} sessions, ${x.events} events${x.notes ? ", has notes" : ""}${x.last ? `, last ${new Date(x.last).toISOString().slice(0, 10)}` : ""}`).join("\n"));
    }
  );

  tool(
    "site_map",
    "Summarise everything recorded for a site: its pages, the buttons and links the user actually uses on each (with CSS selectors), the fields they fill, the API endpoints behind it, common paths between pages, and saved notes. Pass page for one page in detail including its last outline. Read this before automating or restyling a site.",
    { site: z.string().describe('Host, e.g. "erp.example.com".'), page: z.string().optional().describe('Path from the map, e.g. "/orders/:id/edit".') },
    async (a) => text(siteMap(resolveHost(a.site), { page: a.page }))
  );

  tool(
    "site_sessions",
    "List recorded sessions for a site, or read one session's timeline step by step.",
    { site: z.string(), session: z.string().optional(), from: z.number().int().optional(), limit: z.number().int().optional().describe("Default 200 events.") },
    async (a) => {
      const host = resolveHost(a.site);
      if (a.session) return text(readSession(host, a.session, { from: a.from, limit: a.limit }));
      const s = sessionsOf(host);
      return text(s.length ? s.map((x) => `${x.id}  ${new Date(x.started).toISOString().slice(0, 16).replace("T", " ")}  ${x.events} events  ${x.browser || ""}  ${x.startUrl}`).join("\n") : `No sessions for ${host}.`);
    }
  );

  tool(
    "site_notes",
    "Read or write notes about a site that persist for future sessions and other agents: how things work, where things are, gotchas. Without text it reads them.",
    { site: z.string(), text: z.string().optional(), append: z.boolean().optional().describe("Add to the notes instead of replacing them.") },
    async (a) => {
      let host;
      try { host = resolveHost(a.site); } catch { host = String(a.site).replace(/^https?:\/\//, "").split("/")[0]; }
      if (a.text == null) return text(readNotes(host) || `No notes for ${host} yet.`);
      writeNotes(host, a.text, a.append);
      return text(`Notes for ${host} saved.`);
    }
  );

  tool("delete_script", "Delete a saved script.", { name: z.string() }, async (a) => {
    if (!remove("script", a.name)) throw new Error(`No script called ${a.name}`);
    hub.pushScripts();
    return text(`Deleted ${a.name}.`);
  });
}

function short(url) {
  try { const u = new URL(url); return u.host + (u.pathname === "/" ? "" : u.pathname); } catch { return url; }
}

const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", txt: "text/plain", csv: "text/csv", json: "application/json", zip: "application/zip", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", mp4: "video/mp4", mp3: "audio/mpeg", svg: "image/svg+xml", html: "text/html" };
function mime(p) {
  return MIME[path.extname(p).slice(1).toLowerCase()] || "application/octet-stream";
}
