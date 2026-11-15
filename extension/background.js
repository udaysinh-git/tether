// Tether background. Holds the set of tabs the user has shared, keeps a
// WebSocket to the local Tether host while at least one tab is shared, and
// carries out tool calls on those tabs only. Nothing runs on a tab until the
// user shares it from the popup (or a shared tab opens it).
"use strict";

const api = globalThis.browser ?? globalThis.chrome;
const IS_FIREFOX = typeof globalThis.browser !== "undefined" && !!api.runtime.getBrowserInfo;
const HAS_CDP = !!api.debugger;
const AMBER = "#E8A33D";
const NET_MAX = 400;
const CONSOLE_MAX = 400;
const BODY_MAX = 2 * 1024 * 1024;

const state = {
  shared: new Map(), // tabId -> { by, since }
  conn: "off", // off | connecting | connected | waiting | denied
  connError: "",
  agents: [],
  scripts: [],
  activity: new Map(), // tabId -> { agent, summary, at }
  cdp: new Set(), // tabIds with the debugger attached
  cdpRefused: new Set(), // tabIds where the user cancelled the debugger bar
  net: new Map(), // tabId -> [records]
  console: new Map(), // tabId -> [entries]
  userScripts: "unknown",
  bypass: false, // user-approved access to every tab, for this browser session
};
const bypassWaiters = new Map(); // request id -> resolve

let ws = null;
let retryTimer = null;
let retryDelay = 1500;
let pingTimer = null;
let netSeq = 0;
const ports = new Set();
const ready = init();

// ---------------------------------------------------------------- setup

async function init() {
  const saved = (await api.storage.session.get("shared")).shared || {};
  for (const [id, v] of Object.entries(saved)) {
    try {
      await api.tabs.get(Number(id));
      state.shared.set(Number(id), v);
    } catch {}
  }
  state.bypass = !!(await api.storage.session.get("bypass")).bypass;
  const local = await api.storage.local.get(["scripts"]);
  state.scripts = local.scripts || [];
  await checkUserScripts();
  for (const id of state.shared.keys()) {
    setBadge(id, true);
    attachCdp(id);
  }
  if (active()) connect();
}

// The connection stays up while anything is shared or bypass mode is on.
const active = () => state.shared.size > 0 || state.bypass;
const allowed = (tabId) => state.shared.has(tabId) || state.bypass;

async function settings() {
  const s = await api.storage.local.get(["key", "port", "trusted"]);
  return { key: s.key || "", port: s.port || 47821, trusted: s.trusted !== false };
}

async function browserName() {
  if (IS_FIREFOX) return (await api.runtime.getBrowserInfo()).name || "Firefox";
  if (navigator.brave) return "Brave";
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand);
  for (const n of ["Microsoft Edge", "Opera", "Vivaldi", "Google Chrome", "Chromium"]) if (brands.includes(n)) return n === "Microsoft Edge" ? "Edge" : n === "Google Chrome" ? "Chrome" : n;
  return "Chrome";
}

// ---------------------------------------------------------------- connection

async function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  clearTimeout(retryTimer);
  const { key, port } = await settings();
  if (!key) return setConn("denied", "Add the pairing key to connect.");
  setConn("connecting");
  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${port}/ext`);
  } catch (e) {
    return scheduleRetry();
  }
  ws = sock;
  sock.onopen = async () => {
    sock.send(JSON.stringify({ type: "hello", key, browser: await browserName(), tabs: await tabList() }));
  };
  sock.onmessage = (e) => onHostMessage(sock, e.data);
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    clearInterval(pingTimer);
    state.agents = [];
    if (e.code === 4003) return setConn("denied", "The pairing key doesn't match. Run “tether key” and paste the new one.");
    if (active()) scheduleRetry();
    else setConn("off");
  };
}

function scheduleRetry() {
  setConn("waiting");
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryDelay);
  retryDelay = Math.min(retryDelay * 1.5, 10000);
}

function disconnect() {
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  if (ws) { const s = ws; ws = null; s.close(1000); }
  state.agents = [];
  setConn("off");
}

function setConn(c, err = "") {
  state.conn = c;
  state.connError = err;
  if (c === "connected") retryDelay = 1500;
  broadcast();
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

async function onHostMessage(sock, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  switch (msg.type) {
    case "welcome":
      state.agents = msg.agents || [];
      setConn("connected");
      clearInterval(pingTimer);
      pingTimer = setInterval(() => send({ type: "ping" }), 20000);
      updatePills();
      break;
    case "denied":
      setConn("denied", msg.reason);
      break;
    case "agents":
      state.agents = msg.agents || [];
      updatePills();
      broadcast();
      break;
    case "scripts":
      state.scripts = msg.scripts || [];
      await api.storage.local.set({ scripts: state.scripts });
      await syncUserScripts();
      broadcast();
      break;
    case "activity":
      if (msg.tabId != null && state.shared.has(msg.tabId)) {
        state.activity.set(msg.tabId, { agent: msg.agent, summary: msg.summary, at: msg.at });
        toContent(msg.tabId, { cmd: "activity", agent: msg.agent, summary: msg.summary }).catch(() => {});
      }
      broadcast();
      break;
    case "call": {
      let result, error;
      try {
        result = await handleCall(msg.method, msg.params || {});
      } catch (e) {
        error = e?.message || String(e);
      }
      if (sock.readyState === 1) sock.send(JSON.stringify({ type: "result", id: msg.id, result, error }));
      break;
    }
  }
}

// ---------------------------------------------------------------- sharing

async function share(tabId, by = "user") {
  if (state.shared.has(tabId)) return;
  const tab = await api.tabs.get(tabId);
  if (!shareable(tab.url)) throw new Error("Browser pages can't be shared.");
  state.shared.set(tabId, { by, since: Date.now() });
  await persist();
  setBadge(tabId, true);
  await ensureContent(tabId).catch(() => {});
  await attachCdp(tabId);
  if (!state.cdp.has(tabId)) injectConsoleHook(tabId);
  pushTabs();
  connect();
  broadcast();
}

async function unshare(tabId) {
  if (!state.shared.has(tabId)) return;
  state.shared.delete(tabId);
  state.activity.delete(tabId);
  state.net.delete(tabId);
  state.console.delete(tabId);
  await persist();
  setBadge(tabId, false);
  toContent(tabId, { cmd: "unshared" }, false).catch(() => {});
  detachCdp(tabId);
  pushTabs();
  if (!active()) disconnect();
  broadcast();
}

async function setBypass(on) {
  state.bypass = !!on;
  await api.storage.session.set({ bypass: state.bypass });
  if (!on) {
    for (const [id, v] of [...state.shared]) if (v.by === "bypass") await unshare(id);
  }
  await pushTabsNow();
  if (active()) connect();
  else disconnect();
  broadcast();
}

// Asked for by an agent. Opens a small window where the user allows or denies.
async function requestBypass(agent, reason) {
  if (state.bypass) return { granted: true, note: "Bypass mode is already on." };
  const id = String(Date.now());
  const q = new URLSearchParams({ id, agent: agent || "An agent", reason: reason || "" });
  const win = await api.windows.create({ url: api.runtime.getURL("prompt/prompt.html?" + q), type: "popup", width: 400, height: 300, focused: true });
  const granted = await new Promise((resolve) => {
    bypassWaiters.set(id, resolve);
    const timer = setTimeout(() => resolve(false), 120000);
    const onClose = (wid) => { if (wid === win.id) resolve(false); };
    api.windows.onRemoved.addListener(onClose);
    bypassWaiters.set(id, (v) => { clearTimeout(timer); api.windows.onRemoved.removeListener(onClose); resolve(v); });
  });
  bypassWaiters.delete(id);
  api.windows.remove(win.id).catch(() => {});
  if (granted) await setBypass(true);
  return { granted, note: granted ? "The user turned on bypass mode. Every tab is now available." : "The user declined. Only shared tabs are available." };
}

function shareable(url = "") {
  return /^(https?|file):/.test(url) && !/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|addons\.mozilla\.org)/.test(url);
}

async function persist() {
  await api.storage.session.set({ shared: Object.fromEntries(state.shared) });
}

function setBadge(tabId, on) {
  api.action.setBadgeText({ tabId, text: on ? " " : "" }).catch(() => {});
  if (on) api.action.setBadgeBackgroundColor({ tabId, color: AMBER }).catch(() => {});
  api.action.setTitle({ tabId, title: on ? "Tether: this tab is shared with your agents" : "Tether" }).catch(() => {});
}

async function tabList() {
  const out = [];
  for (const [id, v] of state.shared) {
    try {
      const t = await api.tabs.get(id);
      out.push({ id, title: t.title, url: t.url, active: t.active, windowId: t.windowId, by: v.by, shared: true, favIconUrl: t.favIconUrl });
    } catch {}
  }
  if (state.bypass) {
    for (const t of await api.tabs.query({})) {
      if (state.shared.has(t.id) || !shareable(t.url)) continue;
      out.push({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId, shared: false, favIconUrl: t.favIconUrl });
    }
  }
  return out;
}

let pushTimer;
function pushTabs() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushTabsNow, 100);
}

async function pushTabsNow() {
  clearTimeout(pushTimer);
  send({ type: "tabs", tabs: await tabList() });
}

// Pages opened by a shared tab (target=_blank, window.open) join the session.
// tabs.onCreated isn't enough: Chrome also sets openerTabId for Ctrl+T.
api.webNavigation.onCreatedNavigationTarget.addListener(async (d) => {
  await ready;
  if (!state.shared.has(d.sourceTabId) || state.shared.has(d.tabId)) return;
  state.shared.set(d.tabId, { by: "opener", since: Date.now() });
  await persist();
  setBadge(d.tabId, true);
  attachCdp(d.tabId);
  pushTabs();
  broadcast();
});

api.tabs.onCreated.addListener(async () => {
  await ready;
  if (state.bypass) pushTabs();
});

api.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (state.shared.has(tabId)) {
    state.cdp.delete(tabId);
    unshare(tabId);
  } else if (state.bypass) pushTabs();
});

api.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  await ready;
  if (!state.shared.has(tabId)) {
    if (state.bypass && (info.status === "complete" || info.title || info.url)) pushTabs();
    return;
  }
  if (info.url && !shareable(info.url) && info.url !== "about:blank") return unshare(tabId);
  setBadge(tabId, true);
  if (info.status === "complete") ensureContent(tabId).catch(() => {});
  if (info.status || info.title || info.url) pushTabs();
});

api.tabs.onActivated.addListener(async () => {
  await ready;
  if (active()) pushTabs();
});

api.webNavigation?.onCommitted.addListener(async (d) => {
  await ready;
  if (d.frameId !== 0 || !state.shared.has(d.tabId)) return;
  if (!state.cdp.has(d.tabId)) injectConsoleHook(d.tabId);
});

// ---------------------------------------------------------------- content bridge

async function ensureContent(tabId) {
  try {
    const r = await api.tabs.sendMessage(tabId, { cmd: "ping" }, { frameId: 0 });
    if (r?.ok) return;
  } catch {}
  await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content.js"] });
}

async function toContent(tabId, msg, inject = true) {
  if (inject) await ensureContent(tabId);
  const res = await api.tabs.sendMessage(tabId, { ...msg, agents: state.agents }, { frameId: 0 });
  if (res?.error) throw new Error(res.error);
  return res;
}

function updatePills() {
  for (const id of state.shared.keys()) toContent(id, { cmd: "agents" }, false).catch(() => {});
}

function injectConsoleHook(tabId) {
  api.scripting
    .executeScript({ target: { tabId, allFrames: false }, world: "MAIN", injectImmediately: true, func: consoleHook })
    .catch(() => {});
}

// Runs in the page. Mirrors console output and uncaught errors to the content script.
function consoleHook() {
  const mark = Symbol.for("tether.console");
  if (window[mark]) return;
  Object.defineProperty(window, mark, { value: true });
  const post = (level, args) => {
    let text;
    try {
      text = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack || String(a) : JSON.stringify(a))).join(" ");
    } catch {
      text = args.map(String).join(" ");
    }
    window.postMessage({ __tetherConsole: { level, text: String(text).slice(0, 4000), at: Date.now() } }, "*");
  };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level];
    console[level] = function (...args) {
      post(level, args);
      return orig.apply(this, args);
    };
  }
  window.addEventListener("error", (e) => post("error", [e.error || e.message]));
  window.addEventListener("unhandledrejection", (e) => post("error", ["Unhandled rejection:", e.reason]));
}

// ---------------------------------------------------------------- debugger (Chromium)

async function attachCdp(tabId) {
  if (!HAS_CDP || state.cdp.has(tabId) || state.cdpRefused.has(tabId)) return;
  if (!(await settings()).trusted) return;
  try {
    await api.debugger.attach({ tabId }, "1.3");
    state.cdp.add(tabId);
    await cdp(tabId, "Network.enable", { maxPostDataSize: 65536 });
    await cdp(tabId, "Runtime.enable");
    await cdp(tabId, "Log.enable");
    await cdp(tabId, "Page.enable");
  } catch (e) {
    state.cdp.delete(tabId);
  }
}

function detachCdp(tabId) {
  if (!state.cdp.has(tabId)) return;
  state.cdp.delete(tabId);
  api.debugger.detach({ tabId }).catch(() => {});
}

function cdp(tabId, method, params = {}) {
  return api.debugger.sendCommand({ tabId }, method, params);
}

if (HAS_CDP) {
  api.debugger.onDetach.addListener((src, reason) => {
    if (src.tabId == null) return;
    state.cdp.delete(src.tabId);
    // The user pressed Cancel on the "started debugging" bar: respect it for this tab.
    if (reason === "canceled_by_user") state.cdpRefused.add(src.tabId);
  });

  const byCdpId = new Map(); // `${tabId}:${requestId}` -> record
  api.debugger.onEvent.addListener((src, method, p) => {
    const tabId = src.tabId;
    if (!state.shared.has(tabId)) return;
    const k = `${tabId}:${p?.requestId}`;
    switch (method) {
      case "Network.requestWillBeSent": {
        const prev = byCdpId.get(k);
        if (prev && p.redirectResponse) {
          Object.assign(prev, { status: p.redirectResponse.status, statusText: p.redirectResponse.statusText, resHeaders: p.redirectResponse.headers, done: true, redirected: true });
        }
        const rec = {
          id: "r" + ++netSeq,
          cdpId: p.requestId,
          method: p.request.method,
          url: p.request.url,
          type: (p.type || "other").toLowerCase(),
          reqHeaders: p.request.headers,
          postData: p.request.postData,
          hasPostData: p.request.hasPostData,
          started: p.wallTime ? p.wallTime * 1000 : Date.now(),
          t0: p.timestamp,
        };
        byCdpId.set(k, rec);
        pushNet(tabId, rec);
        break;
      }
      case "Network.responseReceived": {
        const rec = byCdpId.get(k);
        if (!rec) break;
        Object.assign(rec, { status: p.response.status, statusText: p.response.statusText, resHeaders: p.response.headers, mime: p.response.mimeType, fromCache: p.response.fromDiskCache });
        break;
      }
      case "Network.loadingFinished": {
        const rec = byCdpId.get(k);
        if (!rec) break;
        Object.assign(rec, { done: true, size: p.encodedDataLength, ms: Math.round((p.timestamp - rec.t0) * 1000) });
        break;
      }
      case "Network.loadingFailed": {
        const rec = byCdpId.get(k);
        if (!rec) break;
        Object.assign(rec, { done: true, error: p.errorText + (p.blockedReason ? ` (${p.blockedReason})` : ""), ms: Math.round((p.timestamp - rec.t0) * 1000) });
        break;
      }
      case "Runtime.consoleAPICalled":
        pushConsole(tabId, { level: p.type, text: p.args.map(remoteText).join(" "), at: p.timestamp, source: p.stackTrace?.callFrames?.[0]?.url });
        break;
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails;
        pushConsole(tabId, { level: "error", text: d.exception?.description || d.text, at: p.timestamp, source: d.url && `${d.url}:${d.lineNumber + 1}` });
        break;
      }
      case "Log.entryAdded":
        pushConsole(tabId, { level: p.entry.level, text: p.entry.text, at: p.entry.timestamp, source: p.entry.url });
        break;
    }
  });
}

function remoteText(a) {
  if (a.type === "string") return a.value;
  if ("value" in a) return JSON.stringify(a.value);
  return a.unserializableValue || a.description || a.type;
}

function pushNet(tabId, rec) {
  const list = state.net.get(tabId) || [];
  list.push(rec);
  if (list.length > NET_MAX) list.splice(0, list.length - NET_MAX);
  state.net.set(tabId, list);
}

function pushConsole(tabId, entry) {
  const list = state.console.get(tabId) || [];
  list.push({ ...entry, text: String(entry.text ?? "").slice(0, 4000) });
  if (list.length > CONSOLE_MAX) list.splice(0, list.length - CONSOLE_MAX);
  state.console.set(tabId, list);
}

// ---------------------------------------------------------------- webRequest (Firefox, and Chromium without the debugger)

const wrRecs = new Map(); // requestId -> record
const wrFilter = { urls: ["<all_urls>"] };
const wrTracked = (d) => d.tabId >= 0 && state.shared.has(d.tabId) && !state.cdp.has(d.tabId);

api.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (!wrTracked(d)) return;
    const rec = { id: "r" + ++netSeq, method: d.method, url: d.url, type: d.type === "xmlhttprequest" ? "xhr" : d.type, started: d.timeStamp };
    if (d.requestBody) {
      if (d.requestBody.formData) rec.postData = new URLSearchParams(Object.entries(d.requestBody.formData).flatMap(([k, vs]) => vs.map((v) => [k, v]))).toString();
      else if (d.requestBody.raw?.[0]?.bytes) rec.postData = new TextDecoder().decode(d.requestBody.raw[0].bytes).slice(0, 65536);
    }
    wrRecs.set(d.requestId, rec);
    pushNet(d.tabId, rec);
    // Firefox can read response bodies as they stream through.
    if (IS_FIREFOX && api.webRequest.filterResponseData && d.type === "xmlhttprequest") {
      try {
        const f = api.webRequest.filterResponseData(d.requestId);
        const chunks = [];
        let size = 0;
        f.ondata = (e) => {
          if (size < BODY_MAX) chunks.push(e.data);
          size += e.data.byteLength;
          f.write(e.data);
        };
        f.onstop = () => {
          f.close();
          rec.body = { bytes: chunks, truncated: size > BODY_MAX };
        };
        f.onerror = () => {};
      } catch {}
    }
  },
  wrFilter,
  IS_FIREFOX ? ["requestBody", "blocking"] : ["requestBody"]
);

api.webRequest.onSendHeaders.addListener(
  (d) => {
    const rec = wrRecs.get(d.requestId);
    if (rec) rec.reqHeaders = headerObj(d.requestHeaders);
  },
  wrFilter,
  ["requestHeaders"]
);

// Firefox has no debugger API, so on shared tabs the page CSP is removed to let
// run_js and page-world scripts work on strict sites. Only shared tabs.
api.webRequest.onHeadersReceived.addListener(
  (d) => {
    const rec = wrRecs.get(d.requestId);
    if (rec) Object.assign(rec, { status: d.statusCode, statusText: d.statusLine, resHeaders: headerObj(d.responseHeaders), mime: (headerObj(d.responseHeaders)["content-type"] || "").split(";")[0] });
    if (IS_FIREFOX && d.tabId >= 0 && state.shared.has(d.tabId) && (d.type === "main_frame" || d.type === "sub_frame")) {
      return { responseHeaders: d.responseHeaders.filter((h) => !/^content-security-policy(-report-only)?$/i.test(h.name)) };
    }
  },
  wrFilter,
  IS_FIREFOX ? ["responseHeaders", "blocking"] : ["responseHeaders"]
);

api.webRequest.onCompleted.addListener(
  (d) => {
    const rec = wrRecs.get(d.requestId);
    if (!rec) return;
    Object.assign(rec, { done: true, ms: Math.round(d.timeStamp - rec.started), fromCache: d.fromCache });
    wrRecs.delete(d.requestId);
  },
  wrFilter
);

api.webRequest.onErrorOccurred.addListener(
  (d) => {
    const rec = wrRecs.get(d.requestId);
    if (!rec) return;
    Object.assign(rec, { done: true, error: d.error, ms: Math.round(d.timeStamp - rec.started) });
    wrRecs.delete(d.requestId);
  },
  wrFilter
);

function headerObj(list = []) {
  const o = {};
  for (const h of list) o[h.name.toLowerCase()] = h.value ?? "";
  return o;
}

// ---------------------------------------------------------------- tool calls

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requireShared(tabId) {
  if (state.shared.has(tabId)) return;
  if (!state.bypass) throw new Error("That tab is not shared. Ask the user to share it, or call request_bypass.");
  await share(tabId, "bypass"); // bypass mode: the tab joins the session the first time it is used
}

async function waitForLoad(tabId, timeout = 30000) {
  const end = Date.now() + timeout;
  await sleep(150);
  while (Date.now() < end) {
    const t = await api.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error("The tab was closed.");
    if (t.status === "complete") return t;
    await sleep(150);
  }
  return api.tabs.get(tabId);
}

// Give the page a moment to react, and wait out any navigation the action started.
async function settle(tabId) {
  await sleep(300);
  const t = await api.tabs.get(tabId).catch(() => null);
  if (t?.status === "loading") await waitForLoad(tabId, 20000);
}

async function handleCall(method, p) {
  await ready;
  const tabId = p.tabId;
  if (tabId != null && method !== "openTab") await requireShared(tabId);

  switch (method) {
    case "openTab": {
      if (p.openerTabId != null) await requireShared(p.openerTabId);
      const t = await api.tabs.create({ url: p.url, active: true, openerTabId: p.openerTabId });
      state.shared.set(t.id, { by: "agent", since: Date.now() });
      await persist();
      setBadge(t.id, true);
      await attachCdp(t.id);
      await waitForLoad(t.id);
      await ensureContent(t.id).catch(() => {});
      pushTabs();
      broadcast();
      return { id: t.id };
    }
    case "requestBypass":
      return requestBypass(p.agent, p.reason);
    case "closeTab":
      await api.tabs.remove(tabId);
      return {};
    case "navigate": {
      if (p.url) await api.tabs.update(tabId, { url: p.url });
      else if (p.action === "back") await api.tabs.goBack(tabId);
      else if (p.action === "forward") await api.tabs.goForward(tabId);
      else await api.tabs.reload(tabId);
      const t = await waitForLoad(tabId);
      return { note: `Now at ${t.url}` };
    }
    case "screenshot":
      return screenshot(tabId);
    case "runJs":
      return { value: await runJs(tabId, p.code) };
    case "network":
      return listNetwork(tabId, p);
    case "networkDetail":
      return networkDetail(tabId, p);
    case "console":
      return listConsole(tabId, p);
    case "cookies":
      return cookies(tabId);
    case "click":
    case "hover":
      if (state.cdp.has(tabId)) {
        const pt = await toContent(tabId, { cmd: "locate", ref: p.ref, verb: method === "click" ? "Clicked" : "Hovered" });
        await cdpMouse(tabId, pt.x, pt.y, method === "click" ? (p.double ? 2 : 1) : 0);
        await settle(tabId);
        return { note: pt.note };
      }
      break;
    case "type":
      if (state.cdp.has(tabId)) {
        const r = await toContent(tabId, { cmd: "focusFor", ref: p.ref, append: p.append });
        if (!p.append && r.clear) await cdpKey(tabId, "Delete");
        await cdp(tabId, "Input.insertText", { text: p.text });
        if (p.submit) await cdpKey(tabId, "Enter");
        await settle(tabId);
        return { note: r.note };
      }
      break;
    case "press":
      if (state.cdp.has(tabId)) {
        if (p.ref) await toContent(tabId, { cmd: "focusFor", ref: p.ref, append: true });
        await cdpKey(tabId, p.key);
        await settle(tabId);
        return { note: `Pressed ${p.key}` };
      }
      break;
  }

  // Everything else (and the fallbacks above) runs in the content script.
  if (tabId == null) throw new Error(`Unknown method ${method}`);
  const res = await toContent(tabId, { cmd: method, ...p });
  if (!["snapshot", "readText", "waitFor"].includes(method)) await settle(tabId);
  return res;
}

async function cdpMouse(tabId, x, y, clicks) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  if (!clicks) return;
  for (let i = 1; i <= clicks; i++) {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: i });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: i });
  }
}

const KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
};
const MODS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };

async function cdpKey(tabId, combo) {
  const parts = combo.split("+");
  const name = parts.pop();
  let modifiers = 0;
  for (const m of parts) modifiers |= MODS[m] || 0;
  let def = KEYS[name];
  if (!def) {
    const ch = name.length === 1 ? name : name;
    const upper = ch.toUpperCase();
    def = { key: ch, code: /[a-z]/i.test(ch) ? "Key" + upper : /\d/.test(ch) ? "Digit" + ch : "", keyCode: upper.charCodeAt(0), text: ch };
  }
  const key = def.key || name;
  const text = modifiers & ~8 ? undefined : def.text;
  await cdp(tabId, "Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code: def.code, windowsVirtualKeyCode: def.keyCode, text, modifiers });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers });
}

async function screenshot(tabId) {
  await toContent(tabId, { cmd: "pill", hidden: true }).catch(() => {});
  try {
    if (state.cdp.has(tabId)) {
      try {
        const r = await cdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 80 });
        return { data: r.data, mimeType: "image/jpeg" };
      } catch {}
    }
    const t = await api.tabs.update(tabId, { active: true });
    await api.windows.update(t.windowId, { focused: true }).catch(() => {});
    await sleep(250);
    const url = await api.tabs.captureVisibleTab(t.windowId, { format: "jpeg", quality: 80 });
    return { data: url.split(",")[1], mimeType: "image/jpeg" };
  } finally {
    toContent(tabId, { cmd: "pill", hidden: false }).catch(() => {});
  }
}

// Runs code in the page's own world. Chromium with the debugger ignores CSP;
// otherwise the userScripts API, then a plain MAIN-world eval.
async function runJs(tabId, code) {
  if (state.cdp.has(tabId)) {
    const r = await cdp(tabId, "Runtime.evaluate", { expression: code, awaitPromise: true, returnByValue: true, replMode: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  if (api.userScripts?.execute) {
    try {
      const [r] = await api.userScripts.execute({ target: { tabId }, world: "MAIN", js: [{ code }], injectImmediately: true });
      if (r?.error) throw new Error(String(r.error));
      return r?.result;
    } catch (e) {
      if (!/not (available|enabled)|permission/i.test(e.message)) throw e;
    }
  }
  const [r] = await api.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [code, Math.random().toString(36).slice(2)],
    func: pageEval,
  });
  if (r?.result?.__tetherError) throw new Error(r.result.__tetherError);
  return r?.result;
}

// Runs in the page. eval first; if the page CSP forbids eval, an inline
// <script> (allowed on pages with 'unsafe-inline'); otherwise explain.
function pageEval(src, token) {
  const fail = (e) => ({ __tetherError: String(e && e.stack ? e.stack : e) });
  try {
    return Promise.resolve((0, eval)(src)).catch(fail);
  } catch (e) {
    if (!(e instanceof EvalError) && !/unsafe-eval|Content Security Policy/i.test(String(e))) return fail(e);
  }
  const key = "__t" + token;
  const attempt = (body) => {
    let syntax = false;
    const onErr = (ev) => { if (/SyntaxError/.test(ev.message)) syntax = true; };
    window.addEventListener("error", onErr);
    const s = document.createElement("script");
    s.textContent = `window[${JSON.stringify(key)}] = (async () => { ${body} })();`;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
    window.removeEventListener("error", onErr);
    const p = window[key];
    delete window[key];
    return { p, syntax };
  };
  // Try: whole code as an expression; then statements returning the last one; then as-is.
  const trimmed = src.trim().replace(/;+$/, "");
  const cut = Math.max(trimmed.lastIndexOf(";"), trimmed.lastIndexOf("\n"));
  const forms = [`return (\n${src}\n);`];
  if (cut > 0) forms.push(`${trimmed.slice(0, cut + 1)}\nreturn (\n${trimmed.slice(cut + 1)}\n);`);
  forms.push(src);
  let p;
  for (const f of forms) {
    const r = attempt(f);
    p = r.p;
    if (p || !r.syntax) break;
  }
  if (!p) return { __tetherError: "This page's security policy blocks run_js. In Chromium turn on Real input in Tether settings; in Firefox reload the tab once after sharing it, or allow user scripts in Tether settings." };
  return p.then((v) => v, fail);
}

function listNetwork(tabId, p) {
  let list = state.net.get(tabId) || [];
  if (p.clear) { state.net.set(tabId, []); return { text: "Cleared." }; }
  if (p.type) list = list.filter((r) => r.type === p.type.toLowerCase());
  if (p.filter) {
    const f = p.filter.toLowerCase();
    list = list.filter((r) => r.url.toLowerCase().includes(f) || r.method.toLowerCase() === f);
  }
  if (p.failedOnly) list = list.filter((r) => r.error || r.status >= 400);
  list = list.slice(-(p.limit || 60));
  if (!list.length) return { text: "No matching requests captured since the tab was shared." };
  const lines = list.map((r) => {
    const status = r.error ? `ERR ${r.error}` : r.status ?? (r.done ? "?" : "…");
    return `${r.id}  ${r.method} ${status}  ${r.type}  ${r.ms != null ? r.ms + "ms" : ""}  ${kb(r.size)}  ${r.url.slice(0, 300)}`;
  });
  return { text: lines.join("\n") };
}

async function networkDetail(tabId, p) {
  const rec = (state.net.get(tabId) || []).find((r) => r.id === p.id);
  if (!rec) throw new Error(`No request ${p.id} in this tab's log.`);
  const max = p.maxChars || 20000;
  let body = "";
  if (rec.cdpId && state.cdp.has(tabId)) {
    try {
      const r = await cdp(tabId, "Network.getResponseBody", { requestId: rec.cdpId });
      body = r.base64Encoded ? `(binary, ${Math.round((r.body.length * 3) / 4)} bytes, base64 omitted)` : r.body;
    } catch (e) {
      body = `(body not available: ${e.message})`;
    }
    if (rec.hasPostData && !rec.postData) {
      try { rec.postData = (await cdp(tabId, "Network.getRequestPostData", { requestId: rec.cdpId })).postData; } catch {}
    }
  } else if (rec.body) {
    const blob = new Blob(rec.body.bytes);
    body = /json|text|xml|javascript|html|urlencoded/.test(rec.mime || "text") ? await blob.text() : `(binary, ${blob.size} bytes)`;
    if (rec.body.truncated) body += "\n(truncated at 2 MB)";
  } else {
    body = IS_FIREFOX ? "(bodies are captured for fetch/XHR only)" : "(body not captured)";
  }
  const h = (o) => Object.entries(o || {}).map(([k, v]) => `  ${k}: ${v}`).join("\n");
  return {
    text: [
      `${rec.method} ${rec.url}`,
      `Status: ${rec.error ? "failed, " + rec.error : `${rec.status ?? "pending"} ${rec.statusText || ""}`}  Type: ${rec.type}  Time: ${rec.ms ?? "?"}ms`,
      `\nRequest headers:\n${h(rec.reqHeaders)}`,
      rec.postData ? `\nRequest body:\n${String(rec.postData).slice(0, max)}` : "",
      `\nResponse headers:\n${h(rec.resHeaders)}`,
      `\nResponse body:\n${body.length > max ? body.slice(0, max) + `\n(truncated, ${body.length} chars total)` : body}`,
    ].filter(Boolean).join("\n"),
  };
}

function listConsole(tabId, p) {
  let list = state.console.get(tabId) || [];
  if (p.clear) { state.console.set(tabId, []); return { text: "Cleared." }; }
  if (p.level) list = list.filter((e) => e.level === p.level || (p.level === "error" && /error|assert/.test(e.level)));
  list = list.slice(-(p.limit || 100));
  if (!list.length) return { text: "No console messages captured since the tab was shared." };
  return { text: list.map((e) => `[${e.level}] ${e.text}${e.source ? `  (${e.source})` : ""}`).join("\n") };
}

async function cookies(tabId) {
  const t = await api.tabs.get(tabId);
  const all = await api.cookies.getAll({ url: t.url });
  if (!all.length) return { text: "No cookies for this page." };
  return {
    text: all
      .map((c) => `${c.name}=${c.value.length > 200 ? c.value.slice(0, 200) + "…" : c.value}  (${c.domain}${c.path}${c.httpOnly ? ", httpOnly" : ""}${c.secure ? ", secure" : ""}${c.sameSite ? ", " + c.sameSite : ""}${c.expirationDate ? ", expires " + new Date(c.expirationDate * 1000).toISOString().slice(0, 10) : ", session"})`)
      .join("\n"),
  };
}

function kb(n) {
  if (n == null) return "";
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

// ---------------------------------------------------------------- user scripts

async function checkUserScripts() {
  if (!api.userScripts) {
    state.userScripts = IS_FIREFOX ? "needs-permission" : "needs-toggle";
    return;
  }
  try {
    await api.userScripts.getScripts();
    state.userScripts = "ok";
  } catch {
    state.userScripts = "needs-toggle";
  }
}

async function syncUserScripts() {
  await checkUserScripts();
  if (state.userScripts !== "ok") return;
  try {
    const existing = (await api.userScripts.getScripts()).map((s) => s.id).filter((id) => id.startsWith("tether-"));
    if (existing.length) await api.userScripts.unregister({ ids: existing });
    const auto = state.scripts.filter((s) => s.run === "auto");
    if (auto.length) {
      await api.userScripts.register(
        auto.map((s) => ({ id: "tether-" + s.id, matches: s.matches, js: [{ code: s.code }], runAt: "document_idle", world: "MAIN" }))
      );
    }
  } catch (e) {
    console.warn("Tether: could not register scripts", e);
  }
}

function scriptsFor(url) {
  return state.scripts.filter((s) => s.matches.some((m) => matchPattern(m, url)));
}

function matchPattern(pattern, url) {
  if (pattern === "<all_urls>") return /^(https?|file|ftp):/.test(url);
  const m = pattern.match(/^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/);
  if (!m) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  const [, scheme, host, path] = m;
  if (scheme === "*" ? !/^https?:$/.test(u.protocol) : u.protocol !== scheme + ":") return false;
  if (host !== "*" && host !== "") {
    if (host.startsWith("*.")) {
      const base = host.slice(2);
      if (u.hostname !== base && !u.hostname.endsWith("." + base)) return false;
    } else if (u.hostname !== host) return false;
  }
  const re = new RegExp("^" + path.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(u.pathname + u.search);
}

// ---------------------------------------------------------------- popup + content messages

async function popupState(tabId) {
  const s = await settings();
  let tab = null;
  try { tab = await api.tabs.get(tabId); } catch {}
  return {
    paired: !!s.key,
    bypass: state.bypass,
    port: s.port,
    trusted: s.trusted,
    conn: state.conn,
    connError: state.connError,
    agents: state.agents,
    browserHasDebugger: HAS_CDP,
    userScripts: state.userScripts,
    tab: tab && { id: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl, shareable: shareable(tab.url), shared: state.shared.has(tab.id), by: state.shared.get(tab.id)?.by, cdp: state.cdp.has(tab.id), activity: state.activity.get(tab.id) },
    others: (await tabList()).filter((t) => t.id !== tabId).map((t) => ({ ...t, activity: state.activity.get(t.id) })),
    scripts: tab ? scriptsFor(tab.url) : [],
    allScripts: state.scripts,
  };
}

function broadcast() {
  for (const port of ports) port.postMessage({ type: "changed" });
}

api.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
});

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await ready;
    switch (msg.type) {
      case "state":
        return popupState(msg.tabId);
      case "share":
        await share(msg.tabId);
        return { ok: true };
      case "unshare":
        await unshare(msg.tabId);
        return { ok: true };
      case "stopAll":
        if (state.bypass) await setBypass(false);
        for (const id of [...state.shared.keys()]) await unshare(id);
        return { ok: true };
      case "setBypass":
        await setBypass(msg.on);
        return { ok: true };
      case "bypassAnswer": {
        const w = bypassWaiters.get(msg.id);
        if (w) w(!!msg.allow);
        return { ok: true };
      }
      case "setSettings": {
        const patch = {};
        if ("key" in msg) patch.key = String(msg.key).trim();
        if ("port" in msg) patch.port = Number(msg.port) || 47821;
        if ("trusted" in msg) patch.trusted = !!msg.trusted;
        await api.storage.local.set(patch);
        if ("trusted" in msg) {
          for (const id of state.shared.keys()) (msg.trusted ? attachCdp : detachCdp)(id);
        }
        disconnect();
        if (active()) connect();
        return { ok: true };
      }
      case "runScript": {
        const s = state.scripts.find((x) => x.id === msg.id);
        if (!s) throw new Error("Script not found");
        return { value: await runJs(msg.tabId, s.code) };
      }
      case "recheckScripts":
        await syncUserScripts();
        broadcast();
        return { ok: true };
      // from content scripts
      case "heartbeat":
        return { shared: state.shared.has(sender.tab?.id) };
      case "stop":
        if (sender.tab) await unshare(sender.tab.id);
        return { ok: true };
      case "console":
        if (sender.tab && state.shared.has(sender.tab.id) && !state.cdp.has(sender.tab.id)) pushConsole(sender.tab.id, msg.entry);
        return { ok: true };
      case "pillState":
        return { shared: state.shared.has(sender.tab?.id), agents: state.agents, conn: state.conn, activity: state.activity.get(sender.tab?.id) };
    }
  })().then(
    (r) => sendResponse(r),
    (e) => sendResponse({ error: e?.message || String(e) })
  );
  return true;
});
