// The hub keeps one WebSocket per connected browser extension and routes
// tool calls to the right browser by tab handle ("chrome:812").
import { WebSocketServer } from "ws";
import { safeEqual } from "./config.js";
import { list, importText } from "./scripts.js";
import { ingest } from "./sites.js";
import { saveRequest, listRequests } from "./requests.js";
import { listWatchers, watcherSummary } from "./watchers.js";

const EXT_ORIGIN = /^(chrome-extension|moz-extension|safari-web-extension):\/\//;

export class Hub {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.browsers = new Map(); // key -> { key, name, ws, tabs, pending }
    this.agents = new Map(); // sessionId -> { name, since }
    this.seq = 0;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  }

  handleUpgrade(req, socket, head) {
    const origin = req.headers.origin || "";
    if (!EXT_ORIGIN.test(origin)) {
      this.log(`refused a WebSocket from origin "${origin || "(none)"}"`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, origin));
  }

  accept(ws, origin) {
    let browser = null;
    const authTimer = setTimeout(() => ws.close(4001, "no hello"), 5000);

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (!browser) {
        if (msg.type !== "hello") return;
        clearTimeout(authTimer);
        if (!safeEqual(msg.key, this.cfg.key)) {
          ws.send(JSON.stringify({ type: "denied", reason: "Wrong pairing key" }));
          ws.close(4003, "bad key");
          return;
        }
        browser = this.register(ws, msg.browser || "browser", origin);
        browser.tabs = msg.tabs || [];
        ws.send(JSON.stringify({ type: "welcome", id: browser.key, agents: this.agentNames() }));
        this.pushScripts(browser);
        this.log(`browser connected: ${browser.key} (${browser.tabs.length} shared tabs)`);
        return;
      }

      if (msg.type === "ping") return ws.send(JSON.stringify({ type: "pong" }));
      if (msg.type === "tabs") {
        const before = browser.tabs.filter((t) => t.shared !== false).length;
        browser.tabs = msg.tabs || [];
        const now = browser.tabs.filter((t) => t.shared !== false).length;
        if (now !== before) this.log(`${browser.key}: ${now} shared tab${now === 1 ? "" : "s"}`);
        return;
      }
      if (msg.type === "rec") {
        try { ingest(browser.key, msg.events || []); } catch (e) { this.log("recording write failed:", e.message); }
        if (msg.ack) ws.send(JSON.stringify({ type: "recAck", ack: msg.ack }));
        return;
      }
      if (msg.type === "rpc") {
        // Calls from the extension's own pages (settings, popup) to the host.
        (async () => {
          let result, error;
          try {
            const fn = this.rpc?.[msg.method];
            if (!fn) throw new Error(`Unknown host call ${msg.method}`);
            result = await fn(msg.params || {}, browser);
          } catch (e) {
            error = e.message || String(e);
          }
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: "rpcResult", nonce: msg.nonce, result, error }));
        })();
        return;
      }
      if (msg.type === "importItem") {
        let item, error;
        try { item = importText(String(msg.text || ""), msg.filename || ""); } catch (e) { error = e.message; }
        ws.send(JSON.stringify({ type: "importResult", nonce: msg.nonce, error, id: item?.id, kind: item?.kind, name: item?.name, warning: item?.requires?.length ? "It uses @require libraries, which Tether doesn't load." : item?.unsupported ? `It ${item.unsupported}.` : "" }));
        if (item) this.pushScripts();
        return;
      }
      if (msg.type === "request") {
        let saved, error;
        try { saved = saveRequest({ ...msg.request, browser: browser.key, tab: msg.request.tabId != null ? `${browser.key}:${msg.request.tabId}` : undefined }); }
        catch (e) { error = e.message; }
        ws.send(JSON.stringify({ type: "requestSaved", nonce: msg.nonce, id: saved?.id, error }));
        this.pushRequests();
        this.log(`request ${saved?.id}: ${String(msg.request.text || "").slice(0, 60)}`);
        return;
      }
      if (msg.type === "result") {
        const p = browser.pending.get(msg.id);
        if (!p) return;
        browser.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (!browser) return;
      for (const p of browser.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Browser disconnected")); }
      if (this.browsers.get(browser.key) === browser) this.browsers.delete(browser.key);
      this.log(`browser disconnected: ${browser.key}`);
    });
  }

  register(ws, name, origin) {
    const base = String(name).toLowerCase().replace(/[^a-z]+/g, "") || "browser";
    // Reconnects from the same extension install keep their key.
    for (const b of this.browsers.values()) {
      if (b.origin === origin) { try { b.ws.close(4000, "replaced"); } catch {} this.browsers.delete(b.key); return this.add(b.key, name, ws, origin); }
    }
    let key = base, n = 2;
    while (this.browsers.has(key)) key = `${base}${n++}`;
    return this.add(key, name, ws, origin);
  }

  add(key, name, ws, origin) {
    const b = { key, name, ws, origin, tabs: [], pending: new Map() };
    this.browsers.set(key, b);
    return b;
  }

  // ---- tool-facing API ----

  allTabs() {
    const out = [];
    for (const b of this.browsers.values()) {
      for (const t of b.tabs) out.push({ ...t, tab: `${b.key}:${t.id}`, browser: b.name });
    }
    return out;
  }

  resolveTab(handle) {
    const tabs = this.allTabs();
    if (!tabs.length) throw new Error(this.browsers.size ? NO_TABS : NO_BROWSER);
    if (handle == null || handle === "") {
      const shared = tabs.filter((t) => t.shared !== false);
      if (shared.length === 1) return this.split(shared[0].tab);
      const active = shared.filter((t) => t.active);
      if (active.length === 1) return this.split(active[0].tab);
      if (!shared.length) throw new Error(`No tab is shared yet. Pass "tab" with one of: ${tabs.map((t) => t.tab).join(", ")}`);
      throw new Error(`Several tabs are shared. Pass "tab" with one of: ${shared.map((t) => t.tab).join(", ")}`);
    }
    const h = String(handle);
    const exact = tabs.find((t) => t.tab === h) || tabs.find((t) => String(t.id) === h);
    if (!exact) throw new Error(`Tab ${h} is not shared. Shared tabs: ${tabs.map((t) => t.tab).join(", ")}`);
    return this.split(exact.tab);
  }

  split(handle) {
    const i = handle.lastIndexOf(":");
    return { browser: this.browsers.get(handle.slice(0, i)), tabId: Number(handle.slice(i + 1)), handle };
  }

  pickBrowser(name) {
    if (!this.browsers.size) throw new Error(NO_BROWSER);
    if (name) {
      const b = this.browsers.get(name) || [...this.browsers.values()].find((x) => x.name.toLowerCase() === String(name).toLowerCase());
      if (!b) throw new Error(`No connected browser called ${name}. Connected: ${[...this.browsers.keys()].join(", ")}`);
      return b;
    }
    return [...this.browsers.values()].at(-1);
  }

  call(browser, method, params = {}, timeoutMs = 30000) {
    if (!browser || browser.ws.readyState !== 1) return Promise.reject(new Error("That browser is no longer connected"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        browser.pending.delete(id);
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      browser.pending.set(id, { resolve, reject, timer });
      browser.ws.send(JSON.stringify({ type: "call", id, method, params }));
    });
  }

  callTab(handle, method, params = {}, timeoutMs) {
    const { browser, tabId } = this.resolveTab(handle);
    return this.call(browser, method, { ...params, tabId }, timeoutMs);
  }

  activity(agent, tool, handle, summary) {
    for (const b of this.browsers.values()) {
      if (handle && !handle.startsWith(b.key + ":")) continue;
      const tabId = handle ? Number(handle.split(":").pop()) : null;
      send(b, { type: "activity", agent, tool, tabId, summary, at: Date.now() });
    }
  }

  // ---- agents + scripts ----

  agentNames() {
    return [...new Set([...this.agents.values()].map((a) => a.name))];
  }

  setAgent(sessionId, name) {
    if (name) this.agents.set(sessionId, { name, since: Date.now() });
    else this.agents.delete(sessionId);
    for (const b of this.browsers.values()) send(b, { type: "agents", agents: this.agentNames() });
  }

  pushScripts(browser) {
    const scripts = list("script");
    const styles = list("style");
    for (const b of browser ? [browser] : this.browsers.values()) {
      send(b, { type: "scripts", scripts });
      send(b, { type: "styles", styles });
    }
    this.pushRequests(browser);
    this.pushWatchers(browser);
  }

  pushWatchers(browser) {
    const watchers = listWatchers().map(watcherSummary);
    for (const b of browser ? [browser] : this.browsers.values()) send(b, { type: "watchers", watchers });
  }

  pushRequests(browser) {
    const recent = listRequests({ status: "all" }).slice(0, 30).map(({ id, text, url, status, reply, created, resolved, images }) => ({ id, text, url, status, reply, created, resolved, images: images.length }));
    for (const b of browser ? [browser] : this.browsers.values()) send(b, { type: "requests", requests: recent });
  }
}

function send(b, msg) {
  if (b.ws.readyState === 1) b.ws.send(JSON.stringify(msg));
}

export const NO_TABS =
  "No tab is shared yet. Call start_session to open your own window in the user's browser (they approve it in a prompt), start_session with mode=current to ask for the tab they're on, or ask them to click the Tether button and choose Share this tab.";

export const NO_BROWSER =
  "No browser is connected to Tether. Ask the user to open their browser with the Tether extension installed and paired (Tether popup shows “Ready”). If they haven't set it up: run `node host/cli.js setup` in the tether repo, load dist/chrome or dist/firefox, and paste the pairing key.";
