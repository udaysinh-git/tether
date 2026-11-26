// Tether background. Holds the set of tabs the user has shared, keeps a
// WebSocket to the local Tether host while at least one tab is shared, and
// carries out tool calls on those tabs only. Nothing runs on a tab until the
// user shares it from the popup (or a shared tab opens it).
"use strict";

const api = globalThis.browser ?? globalThis.chrome;
const IS_FIREFOX = typeof globalThis.browser !== "undefined" && !!api.runtime.getBrowserInfo;
const HAS_CDP = !!api.debugger;
const GOLD = "#d4af37";
const NET_MAX = 400;
const CONSOLE_MAX = 400;
const BODY_MAX = 2 * 1024 * 1024;

const state = {
  shared: new Map(), // tabId -> { by, since, mode: "full" | "read" }
  confirming: new Map(), // tabId -> { id, agent, action, since } while the user decides
  feed: [], // recent agent and user events, newest last, for the side panel
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
  standby: false, // connected and waiting for an agent to ask for a session
  agentWindows: new Set(), // windows opened for an agent; their tabs are shared
  paused: new Map(), // tabId -> { by: "user" | "agent", agent, message, since }
  styles: [],
  disabledStyles: new Set(), // style ids the user switched off in this browser
  disabledScripts: new Set(), // script ids the user switched off in this browser
  applied: new Map(), // tabId -> Map(styleId -> css) currently inserted
  preview: new Map(), // tabId -> css the agent is previewing
  recording: new Map(), // tabId -> { session, manual, host }
  recPaused: new Set(), // tabs where the user stopped an automatic recording
  autoRecord: new Set(), // hosts recorded on every visit
  recordValues: true,
  recQueue: [], // events waiting for the host
  requests: [], // recent change requests, from the host
  pendingRequests: [], // requests waiting for the host
};
const requestWaiters = new Map();
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
  for (const [id, v] of await restore("shared")) state.shared.set(id, v);
  state.bypass = !!(await api.storage.session.get("bypass")).bypass;
  state.feed = (await api.storage.session.get("feed")).feed || [];
  const local = await api.storage.local.get(["scripts", "styles", "disabledStyles", "disabledScripts", "autoRecord", "recordValues", "recQueue", "pendingRequests", "requests"]);
  state.disabledScripts = new Set(local.disabledScripts || []);
  state.scripts = local.scripts || [];
  state.styles = local.styles || [];
  state.disabledStyles = new Set(local.disabledStyles || []);
  state.autoRecord = new Set(local.autoRecord || []);
  state.recordValues = local.recordValues !== false;
  state.recQueue = local.recQueue || [];
  state.pendingRequests = local.pendingRequests || [];
  state.requests = local.requests || [];
  for (const [id, v] of await restore("recording")) state.recording.set(id, v);
  await checkUserScripts();
  for (const id of state.shared.keys()) {
    setBadge(id, true);
    attachCdp(id);
    // After an update the page still shows the old copy's pill; the new
    // content script replaces it straight away.
    ensureContent(id).then(() => toContent(id, { cmd: "agents" }, false)).catch(() => {});
  }
  const wins = (await api.storage.session.get("agentWindows")).agentWindows ?? (await api.storage.local.get("keep_agentWindows")).keep_agentWindows ?? [];
  for (const w of wins) {
    try { await api.windows.get(w); state.agentWindows.add(w); } catch {}
  }
  const s = await settings();
  state.standby = s.paired && s.standby;
  if (active()) connect();
}

// The connection stays up while anything is shared or bypass mode is on.
// Standby: stay connected while paired so an agent can ask to start a session.
// Nothing is visible to it until the user approves.
const active = () => state.shared.size > 0 || state.bypass || state.recording.size > 0 || state.recQueue.length > 0 || state.pendingRequests.length > 0 || state.standby;
const allowed = (tabId) => state.shared.has(tabId) || state.bypass;

async function settings() {
  const s = await api.storage.local.get(["key", "port", "trusted", "standby", "askWindow", "native"]);
  // native: reach the host through the bridge, which needs no key. Firefox
  // always does. Chromium does unless a key was pasted, or the bridge turned
  // out not to be registered (then it waits for the user to press Connect).
  const native = IS_FIREFOX || (!s.key && s.native !== false);
  return { key: s.key || "", native, paired: !!s.key || native, port: s.port || 47821, trusted: s.trusted !== false, standby: s.standby !== false, askWindow: s.askWindow !== false };
}

async function refreshStandby() {
  const s = await settings();
  state.standby = s.paired && s.standby;
  if (active()) connect();
}

// Service workers and event pages sleep; the alarm brings standby back.
api.alarms?.create("tether-standby", { periodInMinutes: 1 });
api.alarms?.onAlarm.addListener(async (a) => {
  if (a.name !== "tether-standby") return;
  await ready;
  if (active() && !ws) connect();
});

async function browserName() {
  if (IS_FIREFOX) return (await api.runtime.getBrowserInfo()).name || "Firefox";
  if (navigator.brave) return "Brave";
  const brands = (navigator.userAgentData?.brands || []).map((b) => b.brand);
  for (const n of ["Microsoft Edge", "Opera", "Vivaldi", "Google Chrome", "Chromium"]) if (brands.includes(n)) return n === "Microsoft Edge" ? "Edge" : n === "Google Chrome" ? "Chrome" : n;
  return "Chrome";
}

// ---------------------------------------------------------------- connection

// Firefox (and Zen, LibreWolf...) upgrades ws://127.0.0.1 to wss:// for MV3
// extensions, so there the browser starts a native bridge (host/native.js)
// and talks to it over native messaging. It also fills in the pairing key,
// which is why Chromium browsers can use it too, to connect without one.
const NATIVE_MISSING = IS_FIREFOX
  ? "Tether's bridge isn't registered with this browser. Run “tether setup” in a terminal, then reload the extension."
  : "Tether isn't set up on this computer yet. Run “npm install -g tether-browser” and then “tether setup” in a terminal, and press Connect again.";

class NativeSocket {
  constructor() {
    this.readyState = 0;
    this.port = api.runtime.connectNative("tether");
    this.parts = new Map(); // id -> [part]: a message over 1 MB arrives in pieces
    this.port.onMessage.addListener((m) => {
      if (m?.type === "bridge") {
        if (m.part) return this.joinPart(m.part);
        if (m.open) { this.readyState = 1; this.onopen?.(); }
        if (m.error) this.error = m.error;
        if (m.closed) this.closeCode = m.closed;
        return;
      }
      this.onmessage?.({ data: JSON.stringify(m) });
    });
    this.port.onDisconnect.addListener((p) => {
      if (this.readyState === 3) return;
      this.readyState = 3;
      const err = p?.error?.message || api.runtime.lastError?.message || this.error || "";
      this.onclose?.({ code: this.closeCode || (/native/i.test(err) ? 4404 : 1006), reason: err });
    });
  }
  // host/bridge-parts.js splits a big message into base64 slices of its UTF-8
  // text. Decode only once every slice is here: a slice can end mid-character.
  joinPart(p) {
    const list = this.parts.get(p.id) || [];
    list[p.i] = p.data;
    this.parts.set(p.id, list);
    if (list.filter((x) => x != null).length < p.n) return;
    this.parts.delete(p.id);
    const chunks = list.map((d) => Uint8Array.from(atob(d), (c) => c.charCodeAt(0)));
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.length; }
    this.onmessage?.({ data: new TextDecoder().decode(bytes) });
  }
  send(s) {
    this.port.postMessage(JSON.parse(s));
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    try { this.port.disconnect(); } catch {}
    this.onclose?.({ code });
  }
}

async function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  clearTimeout(retryTimer);
  const { key, port, native: USE_NATIVE } = await settings();
  if (!key && !USE_NATIVE) return setConn("denied", "Press Connect in the Tether popup.");
  if (USE_NATIVE && typeof api.runtime.connectNative !== "function") return nativeFailed();
  setConn("connecting");
  let sock;
  try {
    sock = USE_NATIVE ? new NativeSocket() : new WebSocket(`ws://127.0.0.1:${port}/ext`);
  } catch (e) {
    if (USE_NATIVE) return nativeFailed();
    return scheduleRetry();
  }
  ws = sock;
  sock.onopen = async () => {
    sock.send(JSON.stringify({ type: "hello", key, browser: await browserName(), version: api.runtime.getManifest().version, tabs: await tabList() }));
  };
  sock.onmessage = (e) => onHostMessage(sock, e.data);
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    clearInterval(pingTimer);
    state.agents = [];
    if (e.code === 4003) return setConn("denied", "The pairing key doesn't match. Run “tether key” and paste the new one.");
    if (e.code === 4404) return nativeFailed();
    if (active()) scheduleRetry();
    else setConn("off");
  };
}

// The bridge isn't registered (or doesn't list this extension). In Chromium
// that puts the popup back on its Connect card, with the reason under it.
async function nativeFailed() {
  if (!IS_FIREFOX) {
    await api.storage.local.set({ native: false });
    // A key pasted while the bridge was being tried: use it.
    if ((await settings()).key) return connect();
  }
  setConn("denied", NATIVE_MISSING);
}

function scheduleRetry() {
  setConn("waiting");
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryDelay);
  // Slower when only waiting in standby: the host may simply not be running.
  const onlyStandby = !state.shared.size && !state.bypass && !state.recording.size && !state.recQueue.length && !state.pendingRequests.length;
  retryDelay = Math.min(retryDelay * 1.5, onlyStandby ? 30000 : 10000);
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
      flushRec();
      flushRequests();
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
    case "styles":
      state.styles = msg.styles || [];
      await api.storage.local.set({ styles: state.styles });
      for (const t of await api.tabs.query({})) applyStyles(t.id, t.url);
      broadcast();
      break;
    case "requests":
      state.requests = msg.requests || [];
      await api.storage.local.set({ requests: state.requests });
      broadcast();
      break;
    case "watchers":
      state.watchers = msg.watchers || [];
      broadcast();
      break;
    case "rpcResult":
    case "importResult":
    case "requestSaved": {
      const w = requestWaiters.get(msg.nonce);
      if (w) { requestWaiters.delete(msg.nonce); w(msg); }
      break;
    }
    case "activity":
      // Page actions report their own line when they finish (or not at all if
      // the user declines), so the host's "clicked e3" is skipped for them.
      if (msg.tabId != null && state.shared.has(msg.tabId) && !FEED_FROM_RESULT.has(msg.tool)) {
        state.activity.set(msg.tabId, { agent: msg.agent, summary: msg.summary, at: msg.at });
        toContent(msg.tabId, { cmd: "activity", agent: msg.agent, summary: msg.summary }).catch(() => {});
      }
      // Page actions go into the feed with the page's own wording once they finish.
      if (!FEED_FROM_RESULT.has(msg.tool)) pushFeed(msg.tabId, msg.agent, msg.summary);
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

async function share(tabId, by = "user", mode = "full") {
  if (state.shared.has(tabId)) return setMode(tabId, mode);
  const tab = await api.tabs.get(tabId);
  if (!shareable(tab.url)) throw new Error("Browser pages can't be shared.");
  state.shared.set(tabId, { by, since: Date.now(), mode: mode === "read" ? "read" : "full" });
  await persist();
  if (by === "user") pushFeed(tabId, "You", mode === "read" ? "shared this tab, read only" : "shared this tab", "user");
  setBadge(tabId, true);
  await ensureContent(tabId).catch(() => {});
  await attachCdp(tabId);
  if (!state.cdp.has(tabId)) injectConsoleHook(tabId);
  pushTabs();
  connect();
  broadcast();
}

// Read only: agents can look (outline, text, screenshots, network, console)
// but every action that would change the page is refused.
async function setMode(tabId, mode) {
  const v = state.shared.get(tabId);
  if (!v) return;
  mode = mode === "read" ? "read" : "full";
  if ((v.mode || "full") === mode) return;
  v.mode = mode;
  await persist();
  pushFeed(tabId, "You", mode === "read" ? "made this tab read only" : "gave agents full control of this tab", "user");
  if (mode === "read") answerConfirm(tabId, false);
  toContent(tabId, { cmd: "mode", mode }, false).catch(() => {});
  pushTabs();
  broadcast();
}

async function unshare(tabId) {
  if (!state.shared.has(tabId)) return;
  const by = state.shared.get(tabId).by;
  state.shared.delete(tabId);
  answerConfirm(tabId, false);
  if (by === "user") pushFeed(tabId, "You", "stopped sharing this tab", "user");
  if (state.paused.has(tabId)) resumeTab(tabId, false);
  state.activity.delete(tabId);
  state.net.delete(tabId);
  state.console.delete(tabId);
  await persist();
  setBadge(tabId, false);
  toContent(tabId, { cmd: "unshared" }, false).catch(() => {});
  detachCdp(tabId);
  await pushTabsNow();
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

// Asks the user in a small window. kind: bypass | window | current.
// Short alert sounds for moments the user isn't clicking anything: a prompt
// opening, an agent asking for help, a watcher firing. Chromium plays them in
// an offscreen document; Firefox's background page can play them itself.
async function ring(name, opts) {
  try {
    if ((await api.storage.local.get("sounds")).sounds === false) return;
    if (api.offscreen) {
      if (!(await api.offscreen.hasDocument?.())) {
        await api.offscreen.createDocument({ url: "offscreen/offscreen.html", reasons: ["AUDIO_PLAYBACK"], justification: "Plays Tether's short alert sounds" });
      }
      await api.runtime.sendMessage({ type: "offscreenSound", name, opts });
    } else {
      globalThis.tetherSound?.play(name, opts);
    }
  } catch {}
}

async function askUser(kind, agent, reason, detail = "") {
  const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
  const q = new URLSearchParams({ id, kind, agent: agent || "An agent", reason: reason || "", detail });
  const win = await api.windows.create({ url: api.runtime.getURL("prompt/prompt.html?" + q), type: "popup", width: 420, height: 320, focused: true });
  ring("hail");
  const granted = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 120000);
    const onClose = (wid) => { if (wid === win.id) resolve(false); };
    api.windows.onRemoved.addListener(onClose);
    bypassWaiters.set(id, (v) => { clearTimeout(timer); api.windows.onRemoved.removeListener(onClose); resolve(v); });
  });
  bypassWaiters.delete(id);
  api.windows.remove(win.id).catch(() => {});
  return granted;
}

async function requestBypass(agent, reason) {
  if (state.bypass) return { granted: true, note: "Bypass mode is already on." };
  const granted = await askUser("bypass", agent, reason);
  if (granted) await setBypass(true);
  return { granted, note: granted ? "The user turned on bypass mode. Every tab is now available." : "The user declined. Only shared tabs are available." };
}

// ---------------------------------------------------------------- downloads
// Only downloads that start while something is shared (or bypass is on) are
// tracked, so the agent never sees the user's download history.

const downloads = new Map(); // id -> { id, url, filename, state, bytes, mime, started, error }
const downloadWaiters = [];

function trackDownload(item) {
  const d = downloads.get(item.id) || { id: item.id, started: Date.now() };
  if (item.url) d.url = item.finalUrl || item.url;
  if (item.filename) d.filename = typeof item.filename === "string" ? item.filename : item.filename.current;
  if (item.state) d.state = typeof item.state === "string" ? item.state : item.state.current;
  if (item.mime) d.mime = item.mime;
  if (item.totalBytes != null && item.totalBytes >= 0) d.bytes = item.totalBytes;
  if (item.fileSize != null && item.fileSize >= 0) d.bytes = item.fileSize;
  if (item.error) d.error = typeof item.error === "string" ? item.error : item.error.current;
  downloads.set(item.id, d);
  if (d.state === "complete" || d.state === "interrupted") {
    for (const w of downloadWaiters.splice(0)) w.check();
  }
  return d;
}

if (api.downloads) {
  api.downloads.onCreated.addListener((item) => {
    if (!(state.shared.size || state.bypass)) return;
    trackDownload(item);
  });
  api.downloads.onChanged.addListener(async (delta) => {
    if (!downloads.has(delta.id)) return;
    const [item] = await api.downloads.search({ id: delta.id });
    if (item) trackDownload(item);
  });
}

function waitDownload({ since = Date.now() - 15000, timeout = 60000 }) {
  return new Promise((resolve) => {
    const w = {
      check() {
        const done = [...downloads.values()].filter((d) => d.started >= since && (d.state === "complete" || d.state === "interrupted"));
        if (done.length) {
          clearTimeout(w.timer);
          resolve(done.at(-1));
          return true;
        }
        downloadWaiters.push(w);
        return false;
      },
    };
    w.timer = setTimeout(() => {
      const i = downloadWaiters.indexOf(w);
      if (i >= 0) downloadWaiters.splice(i, 1);
      const pending = [...downloads.values()].filter((d) => d.started >= since);
      resolve(pending.length ? { ...pending.at(-1), note: "still downloading" } : null);
    }, timeout);
    w.check();
  });
}

async function downloadUrl({ url, filename }) {
  const host = hostOf(url);
  let ok = state.bypass;
  for (const id of state.shared.keys()) {
    if (ok) break;
    try { ok = hostOf((await api.tabs.get(id)).url) === host; } catch {}
  }
  if (!ok) throw new Error(`Downloads are limited to sites of shared tabs (${host} isn't one). Share a tab on that site or ask for bypass mode.`);
  const since = Date.now() - 1000;
  const id = await api.downloads.download({ url, filename: filename || undefined, conflictAction: "uniquify", saveAs: false });
  const [item] = await api.downloads.search({ id });
  trackDownload({ ...item, id });
  const d = await waitDownload({ since, timeout: 120000 });
  return d;
}

// ---------------------------------------------------------------- pause
// The user can pause a shared tab from the pill or popup; agent actions on it
// are refused until they resume. An agent can also hand the tab to the user
// (a CAPTCHA, a 2FA code, a login) with wait_for_user and continue on Done.

const pauseWaiters = new Map(); // tabId -> [resolve]
const READ_ONLY = new Set(["snapshot", "readText", "network", "networkDetail", "console", "cookies", "waitUser", "listMedia", "mediaInfo", "mediaRead", "videoFrame", "downloads", "find"]);

function pauseTab(tabId, info) {
  state.paused.set(tabId, { ...info, since: Date.now() });
  if (info.by === "user") pushFeed(tabId, "You", "paused this tab", "user");
  else pushFeed(tabId, info.agent, `asked you: ${info.message || "take over this tab"}`, "ask");
  toContent(tabId, { cmd: "paused", paused: state.paused.get(tabId) }, false).catch(() => {});
  broadcast();
}

function resumeTab(tabId, resumed = true) {
  const was = state.paused.get(tabId);
  state.paused.delete(tabId);
  if (was && resumed) pushFeed(tabId, "You", was.by === "agent" ? "pressed Done" : "resumed this tab", "user");
  for (const r of pauseWaiters.get(tabId) || []) r(resumed);
  pauseWaiters.delete(tabId);
  toContent(tabId, { cmd: "paused", paused: null }, false).catch(() => {});
  broadcast();
}

async function waitUser(tabId, { agent, message, timeout = 300000, keep = false }) {
  if (message) {
    pauseTab(tabId, { by: "agent", agent, message });
    ring("beacon");
    const t = await api.tabs.update(tabId, { active: true }).catch(() => null);
    if (t) api.windows.update(t.windowId, { focused: true }).catch(() => {});
  } else if (!state.paused.has(tabId)) {
    return { resumed: true, note: "The tab isn't paused." };
  }
  const resumed = await new Promise((resolve) => {
    const list = pauseWaiters.get(tabId) || [];
    list.push(resolve);
    pauseWaiters.set(tabId, list);
    setTimeout(() => resolve(null), timeout);
  });
  if (resumed === null) {
    // keep: the caller will come back with wait_for_user, so the message stays up.
    if (message && !keep && state.paused.get(tabId)?.by === "agent") resumeTab(tabId, false);
    return { resumed: false, note: `The user hasn't responded after ${Math.round(timeout / 1000)}s.` };
  }
  if (!resumed) return { resumed: false, note: "The user stopped sharing the tab." };
  return { resumed: true, note: message ? "The user pressed Done." : "The user resumed." };
}

// ---------------------------------------------------------------- read only + asking first
// Actions that change a page. A read-only tab refuses them all.
const ACTING = new Set(["click", "clickAt", "hover", "type", "fill", "select", "press", "upload", "drag", "runJs", "runItem", "previewCss", "navigate", "closeTab", "styleShots"]);
// Actions the user can be asked to allow first. Risky ones (a button that
// buys, sends, posts or deletes; Enter in such a form) ask by default; a site
// set to "every action" asks for all of these, and "never" trusts the site.
const ASKABLE = new Set(["click", "clickAt", "type", "fill", "select", "press", "upload", "drag", "runJs", "runItem", "navigate", "closeTab"]);
// MCP clients give up on a tool call after about a minute (Codex's default is
// 60 s), so one call waits at most WAIT_MS. The question stays on screen for
// QUESTION_MS; calling the same action again picks it back up, and an answer
// given between calls is kept for that next call.
let WAIT_MS = 45000; // let: the tests shorten it
const QUESTION_MS = 300000;
const confirmWaiters = new Map(); // tabId -> [resolve(true | false | "expired")]
const answered = new Map(); // tabId -> { action, allow, at } waiting for the agent's next call
const STILL_DECIDING = "The user is still deciding whether to allow your previous action on this tab. Repeat that same call to keep waiting, or ask them in chat.";

const READ_ONLY_NOTE = "The user shared this tab read only. You can read it (snapshot, read_text, screenshot, network_requests, console_messages) but not click, type, navigate or run scripts. Ask the user in chat to give you full control from the Tether popup if you need to act.";

async function siteAsk(host) {
  const { siteAsk: map = {}, askRisky } = await api.storage.local.get(["siteAsk", "askRisky"]);
  return map[host] || (askRisky === false ? "never" : "risky");
}

// Sites where the user chose "Always allow uploads here".
async function uploadsAllowed(host) {
  const { siteUploads: map = {} } = await api.storage.local.get("siteUploads");
  return !!map[host];
}

async function setUploadsAllowed(host, on) {
  const { siteUploads: map = {} } = await api.storage.local.get("siteUploads");
  if (on) map[host] = true;
  else delete map[host];
  await api.storage.local.set({ siteUploads: map });
}

const sizeText = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function setSiteAsk(host, value) {
  const { siteAsk: map = {} } = await api.storage.local.get("siteAsk");
  if (value === "all" || value === "never") map[host] = value;
  else delete map[host];
  await api.storage.local.set({ siteAsk: map });
}

function shortUrl(url) {
  try { const u = new URL(url); return u.host + (u.pathname === "/" ? "" : u.pathname); } catch { return url || ""; }
}

// What the user will read after "<agent> wants to ...".
function describeAction(method, p, what) {
  switch (method) {
    case "click": return `click ${what || "an element"}`;
    case "clickAt": return p.toX != null ? `drag across ${what || "the page"}` : `click ${what || "a point on the page"}`;
    case "type": return p.submit ? `type into ${what || "a field"} and submit the form` : `type into ${what || "a field"}`;
    case "fill": return `fill ${p.fields?.length || 0} field${p.fields?.length === 1 ? "" : "s"}`;
    case "select": return `choose ${(p.values || []).map((v) => `“${v}”`).join(", ")}`;
    case "press": return `press ${p.key}${what ? ` in ${what}` : ""}`;
    case "upload": return `attach ${p.files?.length || 0} file${p.files?.length === 1 ? "" : "s"}`;
    case "drag": return `drag something onto ${what || "an element"}`;
    case "runJs": return "run JavaScript on this page";
    case "runItem": return "run a saved script on this page";
    case "navigate": return p.url ? `go to ${shortUrl(p.url)}` : p.action === "reload" || !p.action ? "reload the page" : `go ${p.action}`;
    case "closeTab": return "close this tab";
  }
  return method;
}

async function gate(tabId, method, p) {
  const open = state.confirming.get(tabId);
  const tab = await api.tabs.get(tabId).catch(() => null);
  const host = hostOf(tab?.url || "");
  const mode = await siteAsk(host);
  // Sending a file from this computer to a website always asks, unless bypass
  // mode is on or the user allowed uploads on this site (or never asks here).
  if (method === "upload") {
    if (state.bypass || mode === "never" || (await uploadsAllowed(host))) {
      if (open) throw new Error(STILL_DECIDING);
      return;
    }
    const fr = splitRef(p.ref);
    const target = await toContent(tabId, { cmd: "risk", ref: fr.ref, kind: "click" }, true, fr.frameId).catch(() => null);
    const files = p.files || [];
    const list = files.length <= 3 ? files.map((f) => `${f.name}${f.size != null ? ` (${sizeText(f.size)})` : ""}`).join(", ") : `${files.length} files (${sizeText(files.reduce((n, f) => n + (f.size || 0), 0))})`;
    await confirmAction(tabId, p.agent, `attach ${list} to ${host || "this page"}`, target?.what ? `through ${target.what}` : "", p.askWaitMs, { kind: "upload", host });
    return;
  }
  if (mode === "never" || !ASKABLE.has(method)) {
    if (open) throw new Error(STILL_DECIDING);
    return;
  }
  let kind = null;
  if (method === "click" || method === "clickAt" || method === "drag") kind = "click";
  else if (method === "type" && p.submit) kind = "submit";
  else if (method === "press" && p.ref && /(^|\+)Enter$/i.test(p.key || "")) kind = "submit";
  let risk = null;
  if (method === "clickAt") risk = await riskAt(tabId, p.x, p.y);
  else if (kind || (mode === "all" && p.ref)) {
    const fr = splitRef(method === "drag" ? p.to : p.ref);
    risk = await toContent(tabId, { cmd: "risk", ref: fr.ref, kind: kind || "click" }, true, fr.frameId).catch(() => null);
  }
  if (!(mode === "all" || (kind && risk?.risky))) {
    if (open) throw new Error(STILL_DECIDING);
    return;
  }
  const what = kind === "submit" && risk?.risky ? `the form with ${risk.what}` : risk?.what;
  const action = kind === "submit" && risk?.risky ? `submit ${what}` : describeAction(method, p, what);
  await confirmAction(tabId, p.agent, action, risk?.reason, p.askWaitMs);
}

// What is under a point, for click_at. A point inside another site's frame is
// passed down to that frame, which is the only place it can be looked at.
async function riskAt(tabId, x, y, frameId = 0, depth = 0) {
  if (!depth) await prepareFrames(tabId).catch(() => {});
  const r = await toContent(tabId, { cmd: "risk", x, y, kind: "click" }, true, frameId).catch(() => null);
  if (r?.frame != null && depth < 4) return riskAt(tabId, r.x, r.y, r.frame, depth + 1);
  return r;
}

const declined = (action) => new Error(`The user declined: ${action}. Don't retry it; ask them in chat if it still matters.`);

async function confirmAction(tabId, agent, action, reason, waitMs, extra = {}) {
  // Answered while the agent's previous call had already given up waiting.
  const done = answered.get(tabId);
  answered.delete(tabId);
  if (done && done.action === action && Date.now() - done.at < QUESTION_MS) {
    if (!done.allow) throw declined(action);
    return;
  }
  let c = state.confirming.get(tabId);
  if (c && c.action !== action) throw new Error(STILL_DECIDING);
  if (!c) {
    c = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), agent: agent || "Your agent", action, reason: reason || "", since: Date.now(), kind: extra.kind || "", host: extra.host || "" };
    state.confirming.set(tabId, c);
    c.expire = setTimeout(() => expireConfirm(tabId, c.id), QUESTION_MS);
    pushFeed(tabId, c.agent, `asked to ${action}`, "ask");
    toContent(tabId, { cmd: "confirm", confirm: publicConfirm(c) }, false).catch(() => {});
    ring("hail");
    const t = await api.tabs.update(tabId, { active: true }).catch(() => null);
    if (t) api.windows.update(t.windowId, { focused: true }).catch(() => {});
    broadcast();
  }
  const allow = await new Promise((resolve) => {
    // A flow passes the time its own call has left, so a question can't outlast it.
    const timer = setTimeout(() => finish(undefined), Math.min(WAIT_MS, waitMs || WAIT_MS));
    const finish = (v) => { clearTimeout(timer); const list = confirmWaiters.get(tabId) || []; const i = list.indexOf(finish); if (i >= 0) list.splice(i, 1); resolve(v); };
    confirmWaiters.set(tabId, [...(confirmWaiters.get(tabId) || []), finish]);
  });
  if (allow === undefined) throw new Error(`The user hasn't answered yet; the question “${action}” is still on their screen. Repeat the same call to keep waiting for their answer, or ask them in chat.`);
  if (allow === "expired") throw new Error(`The user didn't answer, so Tether didn't ${action}. Ask them in chat before trying again.`);
  if (!allow) throw declined(action);
}

// The parts of a question the page, popup and panel may see.
const publicConfirm = (c) => (c ? { id: c.id, agent: c.agent, action: c.action, reason: c.reason, since: c.since, kind: c.kind, host: c.host } : null);

function closeConfirm(tabId, c) {
  clearTimeout(c.expire);
  state.confirming.delete(tabId);
  toContent(tabId, { cmd: "confirm", confirm: null }, false).catch(() => {});
}

function answerConfirm(tabId, allow, always) {
  const c = state.confirming.get(tabId);
  if (!c) return false;
  closeConfirm(tabId, c);
  // "Always allow uploads here" on an upload question.
  if (allow && always && c.kind === "upload" && c.host) setUploadsAllowed(c.host, true).catch(() => {});
  pushFeed(tabId, "You", `${allow ? "allowed" : "declined"}: ${c.action}`, allow ? "allow" : "deny");
  const waiting = confirmWaiters.get(tabId) || [];
  confirmWaiters.delete(tabId);
  if (waiting.length) for (const w of [...waiting]) w(!!allow);
  else answered.set(tabId, { action: c.action, allow: !!allow, at: Date.now() });
  broadcast();
  return true;
}

function expireConfirm(tabId, id) {
  const c = state.confirming.get(tabId);
  if (!c || c.id !== id) return;
  closeConfirm(tabId, c);
  pushFeed(tabId, "You", `didn't answer: ${c.action}`, "deny");
  const waiting = confirmWaiters.get(tabId) || [];
  confirmWaiters.delete(tabId);
  for (const w of [...waiting]) w("expired");
  broadcast();
}

// ---------------------------------------------------------------- activity feed
// What agents did and what the user answered, for the side panel. Kept for
// this browser session only.
const FEED_MAX = 200;
// Tools whose finished result (from the page) is a better line than the host's summary.
const FEED_FROM_RESULT = new Set(["click", "click_at", "hover", "type", "fill_form", "select_option", "press_key", "scroll", "upload_file", "drag", "navigate"]);
const FEED_METHODS = new Set(["click", "clickAt", "hover", "type", "fill", "select", "press", "scroll", "upload", "drag", "navigate"]);
let feedTimer;

function pushFeed(tabId, agent, text, kind = "act") {
  if (!text) return;
  const at = Date.now();
  const add = (tab) => {
    state.feed.push({ tabId: tabId ?? null, agent: agent || "", text: String(text), kind, at, host: tab ? hostOf(tab.url) : "", title: tab?.title || "" });
    state.feed.sort((a, b) => a.at - b.at);
    if (state.feed.length > FEED_MAX) state.feed.splice(0, state.feed.length - FEED_MAX);
    clearTimeout(feedTimer);
    feedTimer = setTimeout(() => api.storage.session.set({ feed: state.feed }).catch(() => {}), 300);
    broadcast();
  };
  if (tabId == null) return add(null);
  api.tabs.get(tabId).then(add, () => add(null));
}

const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

// ---------------------------------------------------------------- agent sessions
// An agent can ask for its own window (same logins, separate from the user's
// tabs) or for the tab the user is looking at. Tabs in an agent window are shared.

async function persistWindows() {
  await api.storage.session.set({ agentWindows: [...state.agentWindows] });
  await api.storage.local.set({ keep_agentWindows: [...state.agentWindows] });
}

async function startSession({ agent, reason, url, mode = "window" }) {
  const s = await settings();
  if (mode === "current") {
    const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true, windowType: "normal" });
    if (!tab) throw new Error("The user has no browser tab in front.");
    if (!shareable(tab.url)) throw new Error("The user's current tab is a browser page and can't be shared. Use mode=window instead.");
    if (!state.shared.has(tab.id)) {
      const ok = await askUser("current", agent, reason, tab.title || tab.url);
      if (!ok) return { granted: false, note: "The user declined to share their current tab." };
      await share(tab.id, "user");
    }
    await waitForLoad(tab.id).catch(() => {});
    return { granted: true, tabId: tab.id, windowId: tab.windowId, note: `Using the user's tab: ${tab.title || tab.url}` };
  }

  if (s.askWindow) {
    const ok = await askUser("window", agent, reason, url || "");
    if (!ok) return { granted: false, note: "The user declined. Ask them to share a tab instead, or try again later." };
  }
  const win = await api.windows.create({ url: url || "about:blank", focused: true, type: "normal", width: 1280, height: 860 });
  state.agentWindows.add(win.id);
  await persistWindows();
  // Zen and some other forks put pinned or "essential" tabs into every new
  // window, so the first tab isn't necessarily ours: take the active one.
  const tabs = win.tabs?.length ? win.tabs : await api.tabs.query({ windowId: win.id });
  const tab = tabs.find((t) => t.active && !t.pinned) || tabs.find((t) => !t.pinned) || tabs.find((t) => t.active) || tabs[0];
  state.shared.set(tab.id, { by: "agent", since: Date.now() });
  await persist();
  setBadge(tab.id, true);
  await attachCdp(tab.id);
  if (url) {
    await waitForLoad(tab.id).catch(() => {});
    await ensureContent(tab.id).catch(() => {});
  }
  await pushTabsNow();
  broadcast();
  return { granted: true, tabId: tab.id, windowId: win.id, note: "Opened a new window for you. Tabs you open in it are shared; the user's other tabs are not." };
}

async function endSession({ windowId, tabId }) {
  const wins = windowId != null ? [windowId] : [...state.agentWindows];
  for (const w of wins) {
    state.agentWindows.delete(w);
    await api.windows.remove(w).catch(() => {});
  }
  await persistWindows();
  if (tabId != null && windowId == null) await unshare(tabId);
  return { note: wins.length ? `Closed ${wins.length} agent window${wins.length === 1 ? "" : "s"}.` : "Stopped using the tab." };
}

api.windows.onRemoved.addListener(async (wid) => {
  await ready;
  if (state.agentWindows.delete(wid)) persistWindows();
});

// Each browser keeps extensions off its own add-on store: Chromium off the
// Chrome Web Store, Firefox off addons.mozilla.org. Other stores are ordinary
// pages in that browser.
const STORE = IS_FIREFOX ? /^https:\/\/addons\.mozilla\.org/ : /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;
function shareable(url = "") {
  return /^(https?|file):/.test(url) && !STORE.test(url);
}

async function persist() {
  await api.storage.session.set({ shared: Object.fromEntries(state.shared) });
  await keep("shared", state.shared);
}

// Session storage is wiped when the extension reloads or updates. A copy in
// local storage, with each tab's address, lets sharing survive that; tabs are
// only restored if they still exist and are still on the same site.
async function keep(key, map) {
  const out = {};
  for (const [id, v] of map) {
    try { out[id] = { ...v, url: (await api.tabs.get(id)).url }; } catch {}
  }
  await api.storage.local.set({ ["keep_" + key]: out });
}

async function restore(key) {
  const session = (await api.storage.session.get(key))[key];
  const src = session ?? (await api.storage.local.get("keep_" + key))["keep_" + key] ?? {};
  const out = [];
  for (const [id, v] of Object.entries(src)) {
    try {
      const t = await api.tabs.get(Number(id));
      if (!session && v.url && hostOf(v.url) !== hostOf(t.url)) continue;
      const { url, ...rest } = v;
      out.push([Number(id), rest]);
    } catch {}
  }
  return out;
}

// A fresh browser start reuses tab ids for different tabs: forget the kept copies.
api.runtime.onStartup.addListener(async () => {
  await api.storage.local.remove(["keep_shared", "keep_recording", "keep_agentWindows"]);
  await ready;
  for (const id of [...state.shared.keys()]) await unshare(id);
  for (const id of [...state.recording.keys()]) await stopRecording(id);
  state.agentWindows.clear();
});

function setBadge(tabId, on) {
  api.action.setBadgeText({ tabId, text: on ? " " : "" }).catch(() => {});
  if (on) api.action.setBadgeBackgroundColor({ tabId, color: GOLD }).catch(() => {});
  api.action.setTitle({ tabId, title: on ? "Tether: this tab is shared with your agents" : "Tether" }).catch(() => {});
}

async function tabList() {
  const out = [];
  for (const [id, v] of state.shared) {
    try {
      const t = await api.tabs.get(id);
      out.push({ id, title: t.title, url: t.url, active: t.active, windowId: t.windowId, by: v.by, shared: true, readOnly: v.mode === "read", favIconUrl: t.favIconUrl });
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
  // A read-only tab's children are read only too.
  state.shared.set(d.tabId, { by: "opener", since: Date.now(), mode: state.shared.get(d.sourceTabId).mode || "full" });
  await persist();
  setBadge(d.tabId, true);
  attachCdp(d.tabId);
  pushTabs();
  broadcast();
});

api.tabs.onCreated.addListener(async (tab) => {
  await ready;
  // Any tab in an agent's own window belongs to its session, except pinned
  // ones a browser like Zen copies into every new window.
  if (state.agentWindows.has(tab.windowId) && !tab.pinned && !state.shared.has(tab.id)) {
    state.shared.set(tab.id, { by: "agent", since: Date.now() });
    await persist();
    setBadge(tab.id, true);
    attachCdp(tab.id);
    pushTabs();
    broadcast();
  } else if (state.bypass) pushTabs();
});

api.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  state.applied.delete(tabId);
  state.preview.delete(tabId);
  state.recPaused.delete(tabId);
  if (state.recording.has(tabId)) {
    state.recording.delete(tabId);
    persistRec();
  }
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

api.webNavigation.onCommitted.addListener(async (d) => {
  await ready;
  if (d.frameId !== 0) return;
  // A new document: nothing we inserted survives.
  state.applied.delete(d.tabId);
  state.preview.delete(d.tabId);
  applyStyles(d.tabId, d.url);
  if (state.shared.has(d.tabId) && !state.cdp.has(d.tabId)) injectConsoleHook(d.tabId).then(() => docHolds.get(d.tabId)?.());
});

api.webNavigation.onDOMContentLoaded.addListener(async (d) => {
  await ready;
  if (d.frameId !== 0) return;
  applyStyles(d.tabId, d.url); // in case the commit-time insert was too early
  await autoRecordCheck(d.tabId, d.url);
  if (state.recording.has(d.tabId)) {
    await ensureContent(d.tabId).catch(() => {});
    toContent(d.tabId, { cmd: "record", on: true, values: state.recordValues }, false).catch(() => {});
  }
});

api.webNavigation.onHistoryStateUpdated.addListener(async (d) => {
  await ready;
  if (d.frameId !== 0) return;
  applyStyles(d.tabId, d.url);
  if (state.recording.has(d.tabId)) toContent(d.tabId, { cmd: "recNav" }, false).catch(() => {});
});

// ---------------------------------------------------------------- styles

async function applyStyles(tabId, url) {
  if (!url || !/^(https?|file):/.test(url)) return;
  const want = new Map(
    state.styles
      .filter((s) => !state.disabledStyles.has(s.id))
      .map((s) => [s.id, styleCss(s, url)])
      .filter(([, css]) => css.trim())
  );
  const have = state.applied.get(tabId) || new Map();
  for (const [id, css] of have) {
    if (want.get(id) !== css) {
      await api.scripting.removeCSS({ target: { tabId }, css }).catch(() => {});
      have.delete(id);
    }
  }
  for (const [id, css] of want) {
    if (have.has(id)) continue;
    try {
      await api.scripting.insertCSS({ target: { tabId }, css });
      have.set(id, css);
    } catch {}
  }
  state.applied.set(tabId, have);
}

async function previewCss(tabId, css) {
  const old = state.preview.get(tabId);
  if (old) await api.scripting.removeCSS({ target: { tabId }, css: old }).catch(() => {});
  state.preview.delete(tabId);
  if (css) {
    await api.scripting.insertCSS({ target: { tabId }, css });
    state.preview.set(tabId, css);
  }
}

// ---------------------------------------------------------------- recording

const hostOf = (url) => { try { return new URL(url).host; } catch { return ""; } };

async function persistRec() {
  await api.storage.session.set({ recording: Object.fromEntries(state.recording) });
  await keep("recording", state.recording);
}

async function startRecording(tabId, manual) {
  const tab = await api.tabs.get(tabId);
  if (!shareable(tab.url)) throw new Error("Browser pages can't be recorded.");
  state.recPaused.delete(tabId);
  if (!state.recording.has(tabId)) {
    state.recording.set(tabId, { session: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), manual, host: hostOf(tab.url), since: Date.now() });
    await persistRec();
  }
  await ensureContent(tabId).catch(() => {});
  await toContent(tabId, { cmd: "record", on: true, values: state.recordValues }, false).catch(() => {});
  connect();
  broadcast();
}

async function stopRecording(tabId) {
  const r = state.recording.get(tabId);
  if (!r) return;
  state.recording.delete(tabId);
  if (state.autoRecord.has(r.host)) state.recPaused.add(tabId);
  await persistRec();
  toContent(tabId, { cmd: "record", on: false }, false).catch(() => {});
  flushRec();
  if (!active()) disconnect();
  broadcast();
}

async function autoRecordCheck(tabId, url) {
  if (state.watchTabs?.has(tabId)) return;
  const host = hostOf(url);
  const r = state.recording.get(tabId);
  // Automatic sessions belong to one site; leaving it ends the session.
  if (r && !r.manual && r.host !== host) await stopRecording(tabId);
  if (!state.recording.has(tabId) && !state.recPaused.has(tabId) && state.autoRecord.has(host)) await startRecording(tabId, false).catch(() => {});
}

function queueRec(tabId, events) {
  const r = state.recording.get(tabId);
  if (!r) return;
  for (const e of events) state.recQueue.push({ ...e, session: r.session });
  if (state.recQueue.length > 20000) state.recQueue.splice(0, state.recQueue.length - 20000);
  scheduleFlush();
}

let flushTimer;
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushRec, 1500);
}

async function flushRec() {
  clearTimeout(flushTimer);
  if (ws && ws.readyState === 1 && state.conn === "connected" && state.recQueue.length) {
    while (state.recQueue.length) send({ type: "rec", events: state.recQueue.splice(0, 200) });
  } else if (state.recQueue.length) {
    connect();
  }
  await api.storage.local.set({ recQueue: state.recQueue });
}

// ---------------------------------------------------------------- change requests

async function sendRequest(tabId, text, images, element) {
  const tab = await api.tabs.get(tabId);
  // The agent needs the tab to try changes on, so sending a request shares it.
  if (shareable(tab.url) && !state.shared.has(tabId)) await share(tabId);
  const request = { text, images, url: tab.url, title: tab.title, tabId, element };
  state.pendingRequests.push(request);
  await api.storage.local.set({ pendingRequests: state.pendingRequests });
  connect();
  const sent = await flushRequests(5000);
  return { queued: !sent };
}

// ---------------------------------------------------------------- media

const MEDIA_RX = /\.(m3u8|mpd|mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|oga|opus|wav|flac)(\?|#|$)/i;
const SEGMENT_RX = /\.(ts|m4s|cmfv|cmfa|aac)(\?|#|$)/i;
state.media = new Map(); // tabId -> items with ids

async function listMediaFor(tabId) {
  const page = (await toContent(tabId, { cmd: "listMedia" })).items;
  const net = state.net.get(tabId) || [];
  const streams = [];
  const segments = new Map();
  for (const r of net) {
    const mime = (r.mime || "").toLowerCase();
    if (/mpegurl|dash\+xml/.test(mime) || /\.(m3u8|mpd)(\?|#|$)/i.test(r.url)) {
      if (!streams.some((x) => x.url === r.url)) streams.push({ kind: "stream", url: r.url, format: /mpd|dash/i.test(r.url + mime) ? "DASH" : "HLS", status: r.status });
    } else if (SEGMENT_RX.test(r.url)) {
      const key = r.url.replace(/[^/]*$/, "");
      segments.set(key, (segments.get(key) || 0) + 1);
    } else if (/^(video|audio)\//.test(mime) || r.type === "media" || MEDIA_RX.test(r.url)) {
      if (!page.some((x) => x.url === r.url) && !streams.some((x) => x.url === r.url)) streams.push({ kind: "file", url: r.url, mime, status: r.status, size: r.size });
    }
  }
  const items = [...page, ...streams];
  for (const [prefix, count] of segments) items.push({ kind: "segments", url: prefix, count });
  items.forEach((x, i) => (x.id = "m" + (i + 1)));
  state.media.set(tabId, items);
  return items;
}

async function mediaInfo(tabId, { id, url }) {
  const item = id ? (state.media.get(tabId) || []).find((x) => x.id === id) : { kind: "url", url };
  if (!item) throw new Error(`No media ${id} on this tab. Call list_media first.`);
  const tab = await api.tabs.get(tabId);
  let cookie = "";
  if (/^https?:/.test(item.url || "")) {
    try { cookie = (await api.cookies.getAll({ url: item.url })).map((c) => `${c.name}=${c.value}`).join("; "); } catch {}
  }
  return { item, cookie, referer: tab.url, userAgent: navigator.userAgent };
}

async function videoFrameFor(tabId, ref) {
  const fr = splitRef(ref);
  const res = await toContent(tabId, { cmd: "videoFrame", ref: fr.ref }, true, fr.frameId);
  if (res.dataUrl) return res;
  const off = await frameOffset(tabId, fr.frameId).catch(() => ({ x: 0, y: 0 }));
  await toContent(tabId, { cmd: "pill", hidden: true }).catch(() => {});
  try {
    const full = await visibleShot(tabId);
    const crop = await cropShot(full, { ...res.viewport, x: res.viewport.x + off.x, y: res.viewport.y + off.y });
    return { dataUrl: crop || full, time: res.time, fromScreenshot: true };
  } finally {
    toContent(tabId, { cmd: "pill", hidden: false }).catch(() => {});
  }
}

// ---------------------------------------------------------------- watchers, notifications, gallery

state.watchers = [];
const notifyUrls = new Map();

// Fetched by the extension so the user's cookies for the site are sent.
async function watchFetch({ url }) {
  const r = await fetch(url, { credentials: "include", redirect: "follow", cache: "no-store" });
  let text = await r.text();
  if (text.length > 2_000_000) text = text.slice(0, 2_000_000);
  return { status: r.status, url: r.url, text, contentType: r.headers.get("content-type") || "" };
}

// Pages that need JavaScript: open in a background tab, run the check there, close it.
async function watchTab({ url, code, waitMs = 1500 }) {
  const [win] = await api.windows.getAll({ windowTypes: ["normal"] });
  const tab = await api.tabs.create({ url, active: false, windowId: win?.id });
  state.watchTabs = (state.watchTabs || new Set()).add(tab.id);
  try {
    await waitForLoad(tab.id, 45000);
    await sleep(waitMs);
    return { value: await runJs(tab.id, `(async function () {\n${code}\n})()`) };
  } finally {
    state.watchTabs.delete(tab.id);
    api.tabs.remove(tab.id).catch(() => {});
  }
}

async function notify({ title, message, url }) {
  if (!api.notifications) return { ok: false };
  const id = "tether-" + Date.now();
  if (url) notifyUrls.set(id, url);
  ring("perk");
  await api.notifications.create(id, { type: "basic", iconUrl: api.runtime.getURL("icons/icon128.png"), title: String(title || "Tether"), message: String(message || "") });
  return { ok: true };
}

api.notifications?.onClicked.addListener((id) => {
  const url = notifyUrls.get(id);
  if (url) api.tabs.create({ url });
  api.notifications.clear(id);
});

// Before and after screenshots of a saved style on a shared tab.
async function styleShots(tabId, id) {
  const s = state.styles.find((x) => x.id === id);
  const t = await api.tabs.update(tabId, { active: true });
  await api.windows.update(t.windowId, { focused: true }).catch(() => {});
  await toContent(tabId, { cmd: "pill", hidden: true }).catch(() => {});
  const applied = state.applied.get(tabId) || new Map();
  const css = applied.get(id) || (s ? styleCss(s, t.url) : "");
  try {
    if (css) await api.scripting.removeCSS({ target: { tabId }, css }).catch(() => {});
    await sleep(350);
    const before = await visibleShot(tabId);
    if (css) await api.scripting.insertCSS({ target: { tabId }, css });
    if (css) applied.set(id, css);
    state.applied.set(tabId, applied);
    await sleep(350);
    const after = await visibleShot(tabId);
    return { before, after };
  } finally {
    toContent(tabId, { cmd: "pill", hidden: false }).catch(() => {});
  }
}

// Calls from the settings page and popup to the host.
async function hostRpc(method, params) {
  if (!ws || state.conn !== "connected") {
    connect();
    const end = Date.now() + 5000;
    while (state.conn !== "connected" && Date.now() < end) await sleep(200);
    if (state.conn !== "connected") throw new Error("The Tether host isn't running. Start your agent, or run “tether serve”.");
  }
  const nonce = Math.random().toString(36).slice(2);
  const res = await new Promise((r) => {
    requestWaiters.set(nonce, r);
    setTimeout(() => r({ error: "The host didn't answer." }), 60000);
    send({ type: "rpc", nonce, method, params });
  });
  requestWaiters.delete(nonce);
  if (res.error) throw new Error(res.error);
  return res.result;
}

// ---------------------------------------------------------------- element picker

async function startPick(tabId) {
  const tab = await api.tabs.get(tabId);
  if (!shareable(tab.url)) throw new Error("Browser pages can't be picked from.");
  await ensureContent(tabId);
  await toContent(tabId, { cmd: "pick" }, false);
}

function bytesToDataUrl(buf, type) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

async function visibleShot(tabId) {
  if (state.cdp.has(tabId)) {
    try { return "data:image/jpeg;base64," + (await cdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 85 })).data; } catch {}
  }
  const t = await api.tabs.get(tabId);
  return api.tabs.captureVisibleTab(t.windowId, { format: "jpeg", quality: 85 });
}

// The picked element, cut out of a screenshot with a little room around it.
async function cropShot(dataUrl, v) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = bmp.width / v.vw;
  const pad = 16;
  const sx = Math.max(0, (v.x - pad) * scale), sy = Math.max(0, (v.y - pad) * scale);
  const sw = Math.min(bmp.width - sx, (v.width + pad * 2) * scale), sh = Math.min(bmp.height - sy, (v.height + pad * 2) * scale);
  if (sw < 4 || sh < 4) return null;
  const c = new OffscreenCanvas(Math.round(sw), Math.round(sh));
  c.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const out = await c.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  return bytesToDataUrl(await out.arrayBuffer(), "image/jpeg");
}

async function pickSend(tabId, text, element) {
  const images = [];
  try {
    const full = await visibleShot(tabId);
    const crop = await cropShot(full, element.viewport);
    if (crop) images.push({ name: "picked element", dataUrl: crop });
    images.push({ name: "whole page", dataUrl: full });
  } catch (e) {
    console.warn("Tether: screenshot for picked element failed", e);
  }
  return sendRequest(tabId, text || "(no note: the user picked this element)", images, element);
}

// Installing a .user.js / .user.css from the settings page. The host parses
// and stores it, then pushes it back like any other script or style.
async function importItem(text, filename) {
  connect();
  const end = Date.now() + 5000;
  while (state.conn !== "connected" && Date.now() < end) await sleep(200);
  if (state.conn !== "connected") throw new Error("The Tether host isn't running. Start your agent, or run “tether serve”, then try again.");
  const nonce = Math.random().toString(36).slice(2);
  const res = await new Promise((r) => {
    requestWaiters.set(nonce, r);
    setTimeout(() => r({ error: "The host didn't answer." }), 10000);
    send({ type: "importItem", nonce, text, filename });
  });
  requestWaiters.delete(nonce);
  if (res.error) throw new Error(res.error);
  if (!active()) disconnect();
  return res;
}

async function flushRequests(waitMs = 0) {
  if (waitMs) {
    const end = Date.now() + waitMs;
    while (state.conn !== "connected" && Date.now() < end) await sleep(200);
  }
  if (!ws || ws.readyState !== 1 || state.conn !== "connected") return false;
  while (state.pendingRequests.length) {
    const request = state.pendingRequests[0];
    const nonce = Math.random().toString(36).slice(2);
    const ack = new Promise((r) => { requestWaiters.set(nonce, r); setTimeout(() => r(null), 10000); });
    send({ type: "request", nonce, request });
    const res = await ack;
    if (!res || res.error) return false;
    state.pendingRequests.shift();
    await api.storage.local.set({ pendingRequests: state.pendingRequests });
  }
  broadcast();
  return true;
}

// ---------------------------------------------------------------- content bridge

async function ensureContent(tabId, frameId = 0) {
  try {
    const r = await api.tabs.sendMessage(tabId, { cmd: "ping" }, { frameId });
    if (r?.ok) return;
  } catch {}
  await api.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ["content.js"] });
}

async function toContent(tabId, msg, inject = true, frameId = 0) {
  if (inject) await ensureContent(tabId, frameId);
  const res = await api.tabs.sendMessage(tabId, { ...msg, agents: state.agents }, { frameId });
  if (res?.error) throw new Error(res.error);
  return res;
}

// ---------------------------------------------------------------- frames
// Cross-origin iframes get their own content script. Their outlines are
// spliced into the page's, with refs like f12.e5 that route to frame 12.

async function prepareFrames(tabId) {
  let frames = [];
  try { frames = await api.webNavigation.getAllFrames({ tabId }); } catch {}
  const children = (frames || []).filter((f) => f.frameId !== 0 && /^https?:/.test(f.url));
  if (!children.length) return frames || [];
  await api.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] }).catch(() => {});
  await Promise.all(children.map((f) => api.tabs.sendMessage(tabId, { cmd: "frameHello", frameId: f.frameId }, { frameId: f.frameId }).catch(() => {})));
  await sleep(120);
  return frames;
}

function splitRef(ref) {
  const m = /^\[?f(\d+)\.(e\d+)\]?$/.exec(String(ref || ""));
  return m ? { frameId: Number(m[1]), ref: m[2] } : { frameId: 0, ref };
}

async function stitch(tabId, text, depth = 0) {
  if (depth > 4 || !text.includes("@@frame:")) return text;
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^(\s*)@@frame:(\d+)@@$/.exec(line);
    if (!m) { out.push(line); continue; }
    const [, pad, id] = m;
    try {
      const res = await toContent(tabId, { cmd: "snapshot", maxLines: 300 }, true, Number(id));
      let body = res.text.split("\n\n").slice(1).join("\n\n");
      body = body.replace(/\[(e\d+)\]/g, `[f${id}.$1]`);
      body = await stitch(tabId, body, depth + 1);
      out.push(...body.split("\n").filter(Boolean).map((l) => pad + l));
    } catch {
      out.push(`${pad}(this frame could not be read)`);
    }
  }
  return out.join("\n");
}

// Offset of a frame's viewport inside the top-level viewport, for real clicks.
async function frameOffset(tabId, frameId) {
  if (!frameId) return { x: 0, y: 0 };
  const frames = await api.webNavigation.getAllFrames({ tabId });
  let x = 0, y = 0, cur = frameId;
  while (cur) {
    const f = frames.find((fr) => fr.frameId === cur);
    if (!f) throw new Error("frame gone");
    const r = await api.tabs.sendMessage(tabId, { cmd: "frameRect", childFrameId: cur }, { frameId: f.parentFrameId });
    if (!r?.rect) throw new Error("frame position unknown");
    x += r.rect.x;
    y += r.rect.y;
    cur = f.parentFrameId;
  }
  return { x, y };
}

function updatePills() {
  for (const id of state.shared.keys()) toContent(id, { cmd: "agents" }, false).catch(() => {});
}

function injectConsoleHook(tabId) {
  return api.scripting
    .executeScript({ target: { tabId, allFrames: false }, world: "MAIN", injectImmediately: true, func: consoleHook })
    .catch(() => {});
}

// Firefox: a page's own scripts can run before the hook lands, and what they
// log while loading is lost. So the first bytes of a shared tab's document are
// held back for the moment it takes to install the hook, then let through
// untouched. If the hook is slow or never comes, the page is released anyway.
const HOOK_WAIT_MS = 300;
const docHolds = new Map(); // tabId -> release()
function holdDocument(d) {
  let f;
  try { f = api.webRequest.filterResponseData(d.requestId); } catch { return; }
  const held = [];
  let open = false, ended = false;
  const release = () => {
    if (open) return;
    open = true;
    clearTimeout(timer);
    if (docHolds.get(d.tabId) === release) docHolds.delete(d.tabId);
    try {
      for (const chunk of held.splice(0)) f.write(chunk);
      ended ? f.close() : f.disconnect();
    } catch {}
  };
  const timer = setTimeout(release, HOOK_WAIT_MS);
  docHolds.get(d.tabId)?.(); // an earlier load of this tab that never finished
  docHolds.set(d.tabId, release);
  f.ondata = (e) => { open ? f.write(e.data) : held.push(e.data); };
  f.onstop = () => { ended = true; if (open) { try { f.close(); } catch {} } };
  f.onerror = release;
}

// Runs in the page. Mirrors console output and uncaught errors to the content
// script. On a page that is still loading the content script isn't there yet,
// so messages wait here until it says it is listening.
function consoleHook() {
  const mark = Symbol.for("tether.console");
  if (window[mark]) return;
  Object.defineProperty(window, mark, { value: true });
  let listening = false;
  const waiting = [];
  const send = (entry) => window.postMessage({ __tetherConsole: entry }, "*");
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data?.__tetherConsoleReady || listening) return;
    listening = true;
    for (const entry of waiting.splice(0)) send(entry);
  });
  window.postMessage({ __tetherConsoleHello: true }, "*");
  const post = (level, args) => {
    let text;
    try {
      text = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack || String(a) : JSON.stringify(a))).join(" ");
    } catch {
      text = args.map(String).join(" ");
    }
    const entry = { level, text: String(text).slice(0, 4000), at: Date.now() };
    if (listening) send(entry);
    else if (waiting.length < 300) waiting.push(entry);
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
      case "Page.fileChooserOpened":
        chooserWaiters.get(tabId)?.(p);
        break;
      case "Input.dragIntercepted":
        dragWaiters.get(tabId)?.(p.data);
        break;
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
    if (IS_FIREFOX && api.webRequest.filterResponseData && d.type === "main_frame") holdDocument(d);
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

const recStarts = new Map(); // requestId -> start time, for recorded tabs
api.webRequest.onBeforeRequest.addListener(
  (d) => { if (d.tabId >= 0 && state.recording.has(d.tabId) && (d.type === "xmlhttprequest")) recStarts.set(d.requestId, d.timeStamp); },
  { urls: ["<all_urls>"] }
);
function recordNet(d, error) {
  const t0 = recStarts.get(d.requestId);
  if (t0 == null) return;
  recStarts.delete(d.requestId);
  if (!state.recording.has(d.tabId)) return;
  queueRec(d.tabId, [{ kind: "net", t: Date.now(), url: d.url, method: d.method, status: error ? undefined : d.statusCode, error, ms: Math.round(d.timeStamp - t0) }]);
}
api.webRequest.onErrorOccurred.addListener((d) => recordNet(d, d.error), { urls: ["<all_urls>"] });

api.webRequest.onCompleted.addListener(
  (d) => {
    recordNet(d);
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
  if (tabId != null && state.paused.has(tabId) && !READ_ONLY.has(method)) {
    const ps = state.paused.get(tabId);
    throw new Error(ps.by === "agent" ? "Waiting for the user to press Done on this tab. Call wait_for_user to wait for them." : "The user paused this tab. Call wait_for_user to wait until they resume, or ask them in chat.");
  }
  if (tabId != null && ACTING.has(method)) {
    if (state.shared.get(tabId)?.mode === "read") throw new Error(READ_ONLY_NOTE);
    if (state.confirming.has(tabId) && !ASKABLE.has(method)) throw new Error(STILL_DECIDING);
    await gate(tabId, method, p);
  }
  const res = await runCall(method, p);
  if (tabId != null && FEED_METHODS.has(method)) {
    const line = method === "navigate" ? (p.url ? `went to ${shortUrl(p.url)}` : p.action === "back" || p.action === "forward" ? `went ${p.action}` : "reloaded the page") : lowerFirst(res?.note);
    pushFeed(tabId, p.agent, line);
    // The popup and panel show this line instead of the host's "clicked e3".
    if (line && state.shared.has(tabId)) state.activity.set(tabId, { agent: p.agent || state.activity.get(tabId)?.agent || "Agent", summary: line, at: Date.now() });
  }
  return res;
}

async function runCall(method, p) {
  const tabId = p.tabId;
  switch (method) {
    case "openTab": {
      if (p.openerTabId != null) await requireShared(p.openerTabId);
      const t = await api.tabs.create({ url: p.url, active: true, openerTabId: p.openerTabId });
      state.shared.set(t.id, { by: "agent", since: Date.now(), mode: p.openerTabId != null ? state.shared.get(p.openerTabId)?.mode || "full" : "full" });
      await persist();
      setBadge(t.id, true);
      await attachCdp(t.id);
      await waitForLoad(t.id);
      await ensureContent(t.id).catch(() => {});
      pushTabs();
      broadcast();
      return { id: t.id };
    }
    case "runItem": {
      const s = state.scripts.find((x) => x.id === p.id);
      if (!s) throw new Error(`This browser doesn't have script ${p.id} yet.`);
      return { value: await runJs(tabId, runnable(s, true)) };
    }
    case "previewCss":
      await previewCss(tabId, p.css);
      return {};
    case "waitUser":
      return waitUser(tabId, p);
    case "watchFetch":
      return watchFetch(p);
    case "watchTab":
      return watchTab(p);
    case "notify":
      return notify(p);
    case "styleShots":
      return styleShots(tabId, p.id);
    case "listMedia":
      return { items: await listMediaFor(tabId) };
    case "mediaInfo":
      return mediaInfo(tabId, p);
    case "videoFrame":
      return videoFrameFor(tabId, p.ref);
    case "downloads":
      return { list: [...downloads.values()].slice(-(p.limit || 30)) };
    case "waitDownload":
      return { item: await waitDownload(p) };
    case "download":
      return { item: await downloadUrl(p) };
    case "requestBypass":
      return requestBypass(p.agent, p.reason);
    case "startSession":
      return startSession(p);
    case "endSession":
      return endSession(p);
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
      return screenshot(tabId, p.maxSide);
    case "find":
      return findElement(tabId, p);
    case "clickAt":
      if (state.cdp.has(tabId)) {
        const pt = await toContent(tabId, { cmd: "pointAt", x: p.x, y: p.y, toX: p.toX, toY: p.toY });
        if (p.toX != null) await cdpDrag(tabId, p.x, p.y, p.toX, p.toY);
        else await cdpMouse(tabId, p.x, p.y, p.double ? 2 : 1);
        await settle(tabId);
        return { note: pt.note };
      }
      break;
    case "upload":
      return upload(tabId, p);
    case "drag":
      return drag(tabId, p);
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
        const fr = splitRef(p.ref);
        const pt = await toContent(tabId, { cmd: "locate", ref: fr.ref, verb: method === "click" ? "Clicked" : "Hovered" }, true, fr.frameId);
        let off = { x: 0, y: 0 };
        try { off = await frameOffset(tabId, fr.frameId); } catch { break; } // fall back to DOM events
        await cdpMouse(tabId, pt.x + off.x, pt.y + off.y, method === "click" ? (p.double ? 2 : 1) : 0);
        await settle(tabId);
        return { note: pt.note };
      }
      break;
    case "type":
      if (state.cdp.has(tabId)) {
        const fr = splitRef(p.ref);
        const r = await toContent(tabId, { cmd: "focusFor", ref: fr.ref, append: p.append }, true, fr.frameId);
        if (!p.append && r.clear) await cdpKey(tabId, "Delete");
        await cdp(tabId, "Input.insertText", { text: p.text });
        if (p.submit) await cdpKey(tabId, "Enter");
        await settle(tabId);
        return { note: r.note };
      }
      break;
    case "press":
      if (state.cdp.has(tabId)) {
        if (p.ref) { const fr = splitRef(p.ref); await toContent(tabId, { cmd: "focusFor", ref: fr.ref, append: true }, true, fr.frameId); }
        await cdpKey(tabId, p.key);
        await settle(tabId);
        return { note: `Pressed ${p.key}` };
      }
      break;
  }

  // Everything else (and the fallbacks above) runs in the content script.
  if (tabId == null) throw new Error(`Unknown method ${method}`);
  if (method === "snapshot") {
    await prepareFrames(tabId);
    const res = await toContent(tabId, { cmd: "snapshot", ...p });
    return { text: await stitch(tabId, res.text) };
  }
  if (method === "fill") {
    // Fields can live in different frames.
    const groups = new Map();
    for (const f of p.fields) {
      const fr = splitRef(f.ref);
      if (!groups.has(fr.frameId)) groups.set(fr.frameId, []);
      groups.get(fr.frameId).push({ ...f, ref: fr.ref });
    }
    const notes = [];
    for (const [frameId, fields] of groups) notes.push((await toContent(tabId, { cmd: "fill", fields }, true, frameId)).note);
    await settle(tabId);
    return { note: notes.join("; ") };
  }
  const fr = splitRef(p.ref);
  const res = await toContent(tabId, { cmd: method, ...p, ref: fr.ref }, true, fr.frameId);
  if (!["readText", "waitFor", "mediaRead", "find"].includes(method)) await settle(tabId);
  return res;
}

// Finds a flow step's element: in the page (which covers its shadow roots and
// same-origin frames), then in each frame from another site, whose refs are
// written f<frame>.e<n>. With p.frame only frames whose address contains that
// text are searched.
async function findElement(tabId, p) {
  let last;
  if (!p.frame) {
    try { return await toContent(tabId, { cmd: "find", ...p }); } catch (e) { last = e; }
  }
  const frames = (await prepareFrames(tabId)).filter((f) => f.frameId !== 0 && /^https?:/.test(f.url) && (!p.frame || f.url.includes(p.frame)));
  if (p.frame && !frames.length) throw new Error(`No element: no frame on this page has “${p.frame}” in its address.`);
  for (const f of frames) {
    try {
      const r = await toContent(tabId, { cmd: "find", ...p }, true, f.frameId);
      return { ...r, ref: `f${f.frameId}.${r.ref}` };
    } catch (e) {
      last = last || e;
    }
  }
  throw last;
}

// ---------------------------------------------------------------- uploads
// The agent points at whatever the user would use and Tether delivers the
// files without a file dialog: fill the file input, catch the picker a button
// opens and fill that, drop them on a drop area, or paste them into a text box.
// Chromium with the debugger catches the picker itself and, when the user
// allowed file access, lets the browser read the files from disk (trusted
// events, no size limit). Everywhere else the bytes come from the host and a
// short page-world function does the work.

const PICKER_WAIT_MS = 2500;
const chooserWaiters = new Map(); // tabId -> resolve(event params)

let NO_FILE_ACCESS = false; // let: the tests turn the path route off
async function fileAccess() {
  if (NO_FILE_ACCESS) return false;
  try { return !!(await api.extension?.isAllowedFileSchemeAccess?.()); } catch { return false; }
}

const fileNames = (files) => files.map((f) => f.name).join(", ");

async function upload(tabId, p) {
  const files = p.files || [];
  if (!files.length) throw new Error("No files to upload.");
  const fr = splitRef(p.ref);
  const t = await toContent(tabId, { cmd: "uploadTarget", ref: fr.ref, via: p.via }, true, fr.frameId);
  // The debugger's events and input only reach the top frame's process, so a
  // ref inside another site's frame always takes the page-world way.
  const top = fr.frameId === 0;
  const useCdp = top && state.cdp.has(tabId);
  const byPath = useCdp && files.every((f) => f.path) && (await fileAccess());
  if (!byPath && files.some((f) => f.data == null)) {
    await toContent(tabId, { cmd: "uploadDone", marker: t.marker }, false, fr.frameId).catch(() => {});
    throw new Error(`${fileNames(files.filter((f) => f.data == null))} ${files.length === 1 ? "is" : "are"} too big to send through the extension (50 MB at a time). In Chrome, turning on “Allow access to file URLs” on Tether's Details page in chrome://extensions lets the browser read big files itself.`);
  }
  const page = (action, opts = {}) => pageUpload(tabId, fr.frameId, action, t.marker, files, opts);
  let note;
  try {
    switch (t.kind) {
      case "input":
        note = await fillInput(tabId, t, files, byPath, page);
        break;
      case "paste": {
        const r = await page("paste");
        note = `Pasted ${fileNames(r.files)} into ${t.what}${r.taken ? "" : " (the page didn't react to the paste; check that it took them)"}`;
        break;
      }
      case "drop":
        note = await dropFiles(tabId, t, files, byPath, useCdp, page, true);
        break;
      case "click":
        // No picker: the click may have opened a menu ("From computer"),
        // which the outline that comes back shows.
        note = (await viaPicker(tabId, t, files, byPath, useCdp, page)) || `Clicked ${t.what}, but no file picker opened, so nothing is uploaded yet. If it opened a menu, call upload_file on the item that picks a file from the computer.`;
        break;
      default:
        // Not a button, field or input: a drop area if it takes a drag.
        // Clicking something that isn't clickable could toggle or open
        // anything, so that is left to an explicit via "picker".
        note = await dropFiles(tabId, t, files, byPath, useCdp, page, false);
    }
  } finally {
    await toContent(tabId, { cmd: "uploadDone", marker: t.marker, note }, false, fr.frameId).catch(() => {});
  }
  if (!note) {
    const h = await toContent(tabId, { cmd: "uploadHints" }, false, fr.frameId).catch(() => ({ inputs: [], areas: [] }));
    const where = [...h.inputs, ...h.areas];
    throw new Error(`${t.what} didn't take the files: it isn't a file input, a button or a drop area.${where.length ? ` Places on this page that might:\n  ${where.join("\n  ")}` : " Nothing on this page looks like an upload control; it may appear after another step."}`);
  }
  await settle(tabId);
  return { note };
}

async function fillInput(tabId, t, files, byPath, page) {
  const list = t.input?.multiple ? files : files.slice(0, 1);
  const extra = files.length > list.length ? ` (it takes one file, so ${fileNames(files.slice(1))} ${files.length === 2 ? "was" : "were"} left out)` : "";
  if (byPath) {
    const node = await markedNode(tabId, t.marker);
    if (node) {
      await cdp(tabId, "DOM.setFileInputFiles", { objectId: node, files: list.map((f) => f.path) });
      return `Attached ${fileNames(list)} to ${t.input?.what || t.what}${extra}`;
    }
  }
  await page("input", { single: !t.input?.multiple });
  return `Attached ${fileNames(list)} to ${t.input?.what || t.what}${extra}`;
}

// Clicks the element with the picker caught. Returns null when no picker opened.
async function viaPicker(tabId, t, files, byPath, useCdp, page) {
  if (useCdp) {
    let ev;
    await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      const opened = new Promise((resolve) => {
        const timer = setTimeout(() => { chooserWaiters.delete(tabId); resolve(null); }, PICKER_WAIT_MS);
        chooserWaiters.set(tabId, (e) => { clearTimeout(timer); chooserWaiters.delete(tabId); resolve(e); });
      });
      await cdpMouse(tabId, t.x, t.y, 1);
      ev = await opened;
      if (ev) {
        const list = ev.mode === "selectSingle" ? files.slice(0, 1) : files;
        if (byPath) await cdp(tabId, "DOM.setFileInputFiles", { backendNodeId: ev.backendNodeId, files: list.map((f) => f.path) });
        else {
          const { object } = await cdp(tabId, "DOM.resolveNode", { backendNodeId: ev.backendNodeId });
          await cdp(tabId, "Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: FILL_INPUT, arguments: [{ value: list.map(({ name, type, data }) => ({ name, type, data })) }], awaitPromise: true });
        }
        const extra = list.length < files.length ? ` (it takes one file, so ${fileNames(files.slice(1))} ${files.length === 2 ? "was" : "were"} left out)` : "";
        return `Filled the file picker that ${t.what} opened with ${fileNames(list)}${extra}`;
      }
    } finally {
      await cdp(tabId, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
    return null;
  }
  const r = await page("click");
  if (!r.caught) return null;
  const left = files.slice(r.files.length);
  return `Filled the file picker that ${t.what} opened with ${fileNames(r.files)}${left.length ? ` (it takes one file, so ${fileNames(left)} ${left.length === 1 ? "was" : "were"} left out)` : ""}`;
}

// force: the agent asked for a drop, so drop even if the page doesn't say it
// takes one. Returns null when the element turned the drag down.
async function dropFiles(tabId, t, files, byPath, useCdp, page, force) {
  if (byPath && useCdp) {
    const probe = force ? { accepted: true } : await page("probe");
    if (!probe.accepted) return null;
    const data = { items: [], files: files.map((f) => f.path), dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) await cdp(tabId, "Input.dispatchDragEvent", { type, x: t.x, y: t.y, data });
    return `Dropped ${fileNames(files)} on ${t.what}`;
  }
  const r = await page("drop", { force });
  if (!r.accepted && !force) return null;
  return `Dropped ${fileNames(files)} on ${t.what}${r.accepted ? "" : " (the page didn't say it takes a drop; check that it took them)"}`;
}

// The marked element as a debugger object, searching open shadow roots and
// same-origin frames. Null when it can't be reached that way.
async function markedNode(tabId, marker) {
  const r = await cdp(tabId, "Runtime.evaluate", { expression: `(${FIND_MARKED})(${JSON.stringify(marker)})`, returnByValue: false }).catch(() => null);
  return r?.result?.objectId || null;
}

const FIND_MARKED = `function (marker) {
  const sel = '[data-tether-mark="' + marker + '"]';
  const find = (root) => {
    const hit = root.querySelector(sel);
    if (hit) return hit;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) { const h = find(el.shadowRoot); if (h) return h; }
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") { try { const d = el.contentDocument; if (d) { const h = find(d); if (h) return h; } } catch {} }
    }
    return null;
  };
  return find(document);
}`;

// Runs on a file input the picker named (this = the input).
const FILL_INPUT = `function (files) {
  const W = this.ownerDocument.defaultView;
  const dt = new W.DataTransfer();
  for (const f of files) {
    const bin = W.atob(f.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new W.File([bytes], f.name, { type: f.type || "" }));
  }
  this.files = dt.files;
  this.dispatchEvent(new W.Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new W.Event("change", { bubbles: true }));
  return this.files.length;
}`;

// The page-world part, injected into the frame that holds the element.
// Content scripts see page objects through wrappers in Firefox, so files and
// events are made in the page's own world.
async function pageUpload(tabId, frameId, action, marker, files, opts) {
  const slim = files.map(({ name, type, data }) => ({ name, type, data }));
  let r;
  try {
    [r] = await api.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: "MAIN", func: pageUploadFn, args: [action, marker, slim, { ...opts, wait: PICKER_WAIT_MS }] });
  } catch (e) {
    throw new Error(`Couldn't reach the page to upload: ${e.message}`);
  }
  if (r?.error) throw new Error(String(r.error.message || r.error));
  const out = r?.result;
  if (out?.error) throw new Error(out.error);
  return out || {};
}

// Serialised into the page, so it uses nothing from this file.
async function pageUploadFn(action, marker, files, opts) {
  const sel = `[data-tether-mark="${marker}"]`;
  const find = (root) => {
    const hit = root.querySelector(sel);
    if (hit) return hit;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) { const h = find(el.shadowRoot); if (h) return h; }
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") { try { const d = el.contentDocument; if (d) { const h = find(d); if (h) return h; } } catch {} }
    }
    return null;
  };
  const el = find(document);
  if (!el) return { error: "The element is gone. Take a new snapshot." };
  const W = el.ownerDocument.defaultView;
  const make = (list) => list.map((f) => {
    const bin = W.atob(f.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new W.File([bytes], f.name, { type: f.type || "" });
  });
  const transfer = (list) => { const dt = new W.DataTransfer(); for (const f of list) dt.items.add(f); return dt; };
  const fill = (input, list) => {
    input.files = transfer(list).files;
    input.dispatchEvent(new W.Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new W.Event("change", { bubbles: true }));
  };
  const r = el.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  const names = (list) => list.map((f) => ({ name: f.name }));

  if (action === "input") {
    const list = make(opts.single ? files.slice(0, 1) : files);
    fill(el, list);
    return { files: names(list) };
  }

  if (action === "paste") {
    const list = make(files);
    el.focus();
    let e = new W.ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true, clipboardData: transfer(list) });
    // Firefox ignores clipboardData in the constructor; its event has its own to fill.
    if (!e.clipboardData || !e.clipboardData.files.length) {
      e = new W.ClipboardEvent("paste", { bubbles: true, cancelable: true, composed: true });
      if (!e.clipboardData) return { error: "This browser can't paste files into a page. Try via drop or picker." };
      for (const f of list) e.clipboardData.items.add(f);
    }
    el.dispatchEvent(e);
    return { files: names(list), taken: e.defaultPrevented };
  }

  if (action === "probe" || action === "drop") {
    const list = action === "probe" ? [new W.File([""], "probe.txt", { type: "text/plain" })] : make(files);
    const dt = transfer(list);
    const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...at };
    el.dispatchEvent(new W.DragEvent("dragenter", init));
    const accepted = !el.dispatchEvent(new W.DragEvent("dragover", init));
    if (action === "drop" && (accepted || opts.force)) el.dispatchEvent(new W.DragEvent("drop", init));
    else el.dispatchEvent(new W.DragEvent("dragleave", init));
    return { accepted, files: names(list) };
  }

  if (action === "click") {
    // For the length of the call, a file input asked to open its picker (or
    // the File System Access picker) gets the files instead. The originals go
    // back as soon as the picker is caught or the wait is over.
    const list = make(files);
    const proto = W.HTMLInputElement.prototype;
    const orig = { click: proto.click, showPicker: proto.showPicker, open: W.showOpenFilePicker };
    let caught = null;
    const isFile = (i) => (i.type || "").toLowerCase() === "file";
    const take = (input) => { const l = input.multiple ? list : list.slice(0, 1); fill(input, l); caught = l; };
    proto.click = function () { if (isFile(this) && !caught) return take(this); return orig.click.call(this); };
    if (orig.showPicker) proto.showPicker = function () { if (isFile(this) && !caught) return take(this); return orig.showPicker.call(this); };
    if (orig.open) {
      W.showOpenFilePicker = async (o = {}) => {
        if (caught) return orig.open.call(W, o);
        caught = o.multiple ? list : list.slice(0, 1);
        return caught.map((f) => ({ kind: "file", name: f.name, getFile: async () => f, queryPermission: async () => "granted", requestPermission: async () => "granted", isSameEntry: async (h) => h?.name === f.name }));
      };
    }
    try {
      const mouse = (type, extra = {}) => el.dispatchEvent(new (type.startsWith("pointer") ? W.PointerEvent : W.MouseEvent)(type, { bubbles: true, cancelable: true, composed: true, view: W, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, ...at, ...extra }));
      mouse("pointerdown", { buttons: 1 }); mouse("mousedown", { buttons: 1 });
      mouse("pointerup"); mouse("mouseup");
      el.click();
      const end = Date.now() + opts.wait;
      while (!caught && Date.now() < end) await new Promise((res) => setTimeout(res, 50));
    } finally {
      proto.click = orig.click;
      if (orig.showPicker) proto.showPicker = orig.showPicker;
      if (orig.open) W.showOpenFilePicker = orig.open;
    }
    return { caught: !!caught, files: names(caught || []) };
  }
  return { error: "Unknown upload action " + action };
}

// ---------------------------------------------------------------- drag
// Drag libraries wait before they start a drag: a few pixels of movement
// (dnd-kit, SortableJS) or a short hold (react-beautiful-dnd, touch-style
// sensors). So the pointer moves a little, waits, travels in small steps a
// frame apart and rests over the target before letting go. HTML5 drag and
// drop (draggable=true) never starts from synthetic mouse moves; Chromium
// hands that drag to the debugger (Input.setInterceptDrags), which then
// drives it with drag events.

const dragWaiters = new Map(); // tabId -> resolve(drag data)
const dragPath = (x, y, toX, toY, n) => Array.from({ length: n }, (_, i) => ({ x: x + ((toX - x) * (i + 1)) / n, y: y + ((toY - y) * (i + 1)) / n }));

async function cdpDrag(tabId, x, y, toX, toY) {
  const move = (p, buttons = 1) => cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "left", buttons });
  let intercepted = null;
  // Pressing on selected text drags the text instead of the element, and a
  // click anywhere would have cleared it first.
  await cdp(tabId, "Runtime.evaluate", { expression: "getSelection().removeAllRanges()" }).catch(() => {});
  await cdp(tabId, "Input.setInterceptDrags", { enabled: true }).catch(() => {});
  dragWaiters.set(tabId, (data) => { intercepted = data; });
  try {
    await move({ x, y }, 0);
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    // A few pixels first, so the drag starts where it was picked up.
    const dir = Math.hypot(toX - x, toY - y) || 1;
    for (const d of [3, 6, 10]) {
      await move({ x: x + ((toX - x) / dir) * d, y: y + ((toY - y) / dir) * d });
      await sleep(16);
    }
    await sleep(150);
    const steps = dragPath(x, y, toX, toY, 18);
    if (!intercepted) {
      for (const p of steps) {
        if (intercepted) break;
        await move(p);
        await sleep(16);
      }
    }
    if (intercepted) {
      // An HTML5 drag: finish it with drag events, which is what a person's
      // mouse does once the browser has taken over.
      const data = intercepted;
      await cdp(tabId, "Input.dispatchDragEvent", { type: "dragEnter", x: steps[0].x, y: steps[0].y, data });
      for (const p of steps) {
        await cdp(tabId, "Input.dispatchDragEvent", { type: "dragOver", x: p.x, y: p.y, data });
        await sleep(16);
      }
      await sleep(100);
      await cdp(tabId, "Input.dispatchDragEvent", { type: "dragOver", x: toX, y: toY, data });
      await cdp(tabId, "Input.dispatchDragEvent", { type: "drop", x: toX, y: toY, data });
    } else {
      await sleep(100);
      await move({ x: toX, y: toY });
    }
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: toX, y: toY, button: "left", buttons: 0, clickCount: 1 });
    return { html5: !!intercepted };
  } finally {
    dragWaiters.delete(tabId);
    await cdp(tabId, "Input.setInterceptDrags", { enabled: false }).catch(() => {});
  }
}

async function drag(tabId, p) {
  const a = splitRef(p.from), b = splitRef(p.to);
  if (a.frameId !== b.frameId) throw new Error("from and to are in different frames. Drag within one frame, or use click_at with to_x and to_y.");
  const pt = await toContent(tabId, { cmd: "dragPoints", from: a.ref, to: b.ref, position: p.position }, true, a.frameId);
  let res;
  try {
    let off = null;
    if (state.cdp.has(tabId)) { try { off = await frameOffset(tabId, a.frameId); } catch {} }
    if (off) res = await cdpDrag(tabId, pt.x1 + off.x, pt.y1 + off.y, pt.x2 + off.x, pt.y2 + off.y);
    else {
      const [r] = await api.scripting.executeScript({ target: { tabId, frameIds: [a.frameId] }, world: "MAIN", func: pageDragFn, args: [pt.marker, p.position || ""] });
      if (r?.result?.error) throw new Error(r.result.error);
      res = r?.result || {};
    }
  } finally {
    await toContent(tabId, { cmd: "dragDone", marker: pt.marker, toX: pt.x2, toY: pt.y2 }, false, a.frameId).catch(() => {});
  }
  await settle(tabId);
  return { note: pt.note };
}

// Without the debugger: pointer and mouse events along the way, and the
// HTML5 drag events when the element (or an ancestor) is draggable. Runs in
// the page's world, so it uses nothing from this file.
async function pageDragFn(marker, position) {
  const find = (sel, root = document) => {
    const hit = root.querySelector(sel);
    if (hit) return hit;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) { const h = find(sel, el.shadowRoot); if (h) return h; }
      if (el.tagName === "IFRAME") { try { const d = el.contentDocument; if (d) { const h = find(sel, d); if (h) return h; } } catch {} }
    }
    return null;
  };
  const from = find(`[data-tether-mark="${marker}-from"]`), to = find(`[data-tether-mark="${marker}-to"]`);
  if (!from || !to) return { error: "The element is gone. Take a new snapshot." };
  const W = from.ownerDocument.defaultView;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ra = from.getBoundingClientRect(), rb = to.getBoundingClientRect();
  const x1 = ra.left + ra.width / 2, y1 = ra.top + ra.height / 2;
  const x2 = rb.left + rb.width / 2;
  const y2 = position === "before" ? rb.top + rb.height * 0.2 : position === "after" ? rb.top + rb.height * 0.8 : rb.top + rb.height / 2;
  const at = (x, y) => from.ownerDocument.elementFromPoint(x, y) || to;
  const fire = (el, type, x, y, extra = {}) => {
    const E = type.startsWith("pointer") ? W.PointerEvent : W.MouseEvent;
    return el.dispatchEvent(new E(type, { bubbles: true, cancelable: true, composed: true, view: W, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true, ...extra }));
  };
  W.getSelection()?.removeAllRanges();
  const source = from.closest("[draggable=true]");
  fire(from, "pointerover", x1, y1); fire(from, "pointerdown", x1, y1, { buttons: 1 }); fire(from, "mousedown", x1, y1, { buttons: 1 });
  let dt = null;
  if (source) {
    dt = new W.DataTransfer();
    const go = source.dispatchEvent(new W.DragEvent("dragstart", { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x1, clientY: y1 }));
    if (!go) dt = null;
  }
  await sleep(150);
  let over = null;
  for (let i = 1; i <= 18; i++) {
    const x = x1 + ((x2 - x1) * i) / 18, y = y1 + ((y2 - y1) * i) / 18;
    const el = at(x, y);
    if (dt) {
      if (el !== over) { el.dispatchEvent(new W.DragEvent("dragenter", { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y })); over?.dispatchEvent(new W.DragEvent("dragleave", { bubbles: true, composed: true, dataTransfer: dt, clientX: x, clientY: y })); over = el; }
      el.dispatchEvent(new W.DragEvent("dragover", { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y }));
      source.dispatchEvent(new W.DragEvent("drag", { bubbles: true, composed: true, dataTransfer: dt, clientX: x, clientY: y }));
    } else {
      fire(el, "pointermove", x, y, { buttons: 1 }); fire(el, "mousemove", x, y, { buttons: 1 });
    }
    await sleep(16);
  }
  await sleep(100);
  const end = at(x2, y2);
  if (dt) {
    end.dispatchEvent(new W.DragEvent("drop", { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x2, clientY: y2 }));
    source.dispatchEvent(new W.DragEvent("dragend", { bubbles: true, composed: true, dataTransfer: dt, clientX: x2, clientY: y2 }));
  }
  fire(end, "pointerup", x2, y2); fire(end, "mouseup", x2, y2);
  return { html5: !!dt };
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

async function screenshot(tabId, maxSide) {
  await toContent(tabId, { cmd: "pill", hidden: true }).catch(() => {});
  try {
    if (state.cdp.has(tabId)) {
      try {
        const r = await cdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 80 });
        return await sized(tabId, r.data, maxSide);
      } catch {}
    }
    const t = await api.tabs.update(tabId, { active: true });
    await api.windows.update(t.windowId, { focused: true }).catch(() => {});
    await sleep(250);
    const url = await api.tabs.captureVisibleTab(t.windowId, { format: "jpeg", quality: 80 });
    return await sized(tabId, url.split(",")[1], maxSide);
  } finally {
    toContent(tabId, { cmd: "pill", hidden: false }).catch(() => {});
  }
}

// Adds the image's size and the page's viewport size, which is what turns a
// point in the image into a point on the page for click_at. With maxSide the
// image is scaled down first, so the agent sees it at the size it was sent.
async function sized(tabId, data, maxSide) {
  const out = { data, mimeType: "image/jpeg" };
  try {
    const bmp = await createImageBitmap(await (await fetch("data:image/jpeg;base64," + data)).blob());
    out.width = bmp.width;
    out.height = bmp.height;
    const scale = maxSide > 0 ? Math.min(1, maxSide / Math.max(bmp.width, bmp.height)) : 1;
    if (scale < 1) {
      const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(bmp, 0, 0, c.width, c.height);
      const small = await c.convertToBlob({ type: "image/jpeg", quality: 0.85 });
      out.data = bytesToDataUrl(await small.arrayBuffer(), "image/jpeg").split(",")[1];
      out.width = c.width;
      out.height = c.height;
    }
    out.viewport = await toContent(tabId, { cmd: "viewport" });
  } catch {}
  return out;
}

// Runs code in the page's own world. Chromium uses the debugger (it ignores
// the page's CSP); otherwise the browser's userScripts API, which exists for
// running code the user supplies. There is no eval fallback: without either,
// the user is asked to allow user scripts once.
const NEEDS_USER_SCRIPTS = "Running JavaScript needs user scripts allowed once. Firefox: open Tether settings and press Allow user scripts. Chrome: turn on Real input in Tether settings, or Allow user scripts on Tether's Details page in chrome://extensions.";
async function runJs(tabId, code) {
  // Tabs Tether opened itself, like a watcher's background tab, may not be
  // on the debugger yet.
  if (!state.cdp.has(tabId)) await attachCdp(tabId);
  if (state.cdp.has(tabId)) {
    // Take a handle first: in REPL mode a promise the code evaluates to can
    // come back unresolved, and a by-value result loses the handle to wait on.
    let r = await cdp(tabId, "Runtime.evaluate", { expression: code, awaitPromise: true, returnByValue: false, replMode: true, userGesture: true, allowUnsafeEvalBlockedByCSP: true });
    if (!r.exceptionDetails && r.result?.subtype === "promise" && r.result.objectId) {
      r = await cdp(tabId, "Runtime.awaitPromise", { promiseObjectId: r.result.objectId, returnByValue: false });
    }
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    if (r.result?.objectId) {
      const v = await cdp(tabId, "Runtime.callFunctionOn", { objectId: r.result.objectId, functionDeclaration: "function () { return this; }", returnByValue: true });
      return v.result?.value;
    }
    return r.result?.value;
  }
  if (!api.userScripts?.execute) throw new Error(NEEDS_USER_SCRIPTS);
  let r;
  try {
    [r] = await api.userScripts.execute({ target: { tabId }, world: "MAIN", js: [{ code }], injectImmediately: true });
  } catch (e) {
    if (/not (available|enabled)|permission|userScripts/i.test(e.message)) throw new Error(NEEDS_USER_SCRIPTS);
    throw e;
  }
  if (r?.error) throw new Error(String(r.error));
  return r?.result;
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

const RUN_AT = { "document-start": "document_start", "document-end": "document_end", "document-idle": "document_idle", "document-body": "document_end" };
const validPattern = (m) => m === "<all_urls>" || /^(\*|https?|file|ftp):\/\/[^/]*\/.*$/.test(m);

async function syncUserScripts() {
  await checkUserScripts();
  if (state.userScripts !== "ok") return;
  try {
    const existing = (await api.userScripts.getScripts()).map((s) => s.id).filter((id) => id.startsWith("tether-"));
    if (existing.length) await api.userScripts.unregister({ ids: existing });
  } catch {}
  // One at a time, so one script with an odd pattern doesn't block the rest.
  for (const s of state.scripts.filter((x) => x.run === "auto" && !state.disabledScripts.has(x.id))) {
    const matches = s.matches.filter(validPattern);
    const globs = s.includes.filter((g) => !g.startsWith("/"));
    if (!matches.length && !globs.length) continue;
    const reg = { id: "tether-" + s.id, matches: matches.length ? matches : ["<all_urls>"], js: [{ code: runnable(s, false) }], runAt: RUN_AT[s.runAt] || "document_idle", world: "MAIN" };
    if (!matches.length) reg.includeGlobs = globs;
    const exM = s.excludeMatches.filter(validPattern);
    if (exM.length) reg.excludeMatches = exM;
    const exG = s.excludes.filter((g) => !g.startsWith("/"));
    if (exG.length) reg.excludeGlobs = exG;
    try {
      await api.userScripts.register([reg]);
    } catch (e) {
      console.warn(`Tether: could not register ${s.name}`, e);
    }
  }
}

// Userscript @include/@exclude globs, and /regex/ forms.
function globMatch(g, url) {
  if (g.length > 2 && g.startsWith("/") && g.endsWith("/")) {
    try { return new RegExp(g.slice(1, -1)).test(url); } catch { return false; }
  }
  const re = "^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\?/g, ".").replace(/\*/g, ".*").replace(/\\\.tld\b/g, "\\.[a-z.]+") + "$";
  try { return new RegExp(re, "i").test(url); } catch { return false; }
}

function scriptMatches(s, url) {
  const yes = s.matches.some((m) => matchPattern(m === "*://*/*" ? "<all_urls>" : m, url)) || s.includes.some((g) => globMatch(g, url));
  return yes && !s.excludeMatches.some((m) => matchPattern(m, url)) && !s.excludes.some((g) => globMatch(g, url));
}

function scriptsFor(url) {
  return state.scripts.filter((s) => scriptMatches(s, url));
}

// UserCSS @-moz-document rules.
function ruleMatch(r, url) {
  if (r.fn === "url") return url === r.arg;
  if (r.fn === "url-prefix") return url.startsWith(r.arg);
  if (r.fn === "domain") {
    let h;
    try { h = new URL(url).hostname; } catch { return false; }
    return h === r.arg || h.endsWith("." + r.arg);
  }
  if (r.fn === "regexp") {
    try { return new RegExp("^(?:" + r.arg + ")$").test(url); } catch { return false; }
  }
  return false;
}

function styleCss(s, url) {
  return s.sections.filter((sec) => !sec.rules.length || sec.rules.some((r) => ruleMatch(r, url))).map((sec) => sec.css).join("\n");
}

// What runs in the page: stand-ins for the GM_ API that userscripts expect,
// then the script. Our own scripts return their body's result.
function runnable(item, runNow) {
  const key = JSON.stringify("tether:" + item.id + ":");
  const info = JSON.stringify({ script: { name: item.name, version: item.version, namespace: item.namespace || "", description: item.description || "" }, scriptHandler: "Tether", version: api.runtime.getManifest().version });
  const prelude = `var unsafeWindow = window;
var GM_info = ${info};
var GM_addStyle = function (css) { var s = document.createElement("style"); s.textContent = css; (document.head || document.documentElement).appendChild(s); return s; };
var GM_getValue = function (k, d) { try { var v = localStorage.getItem(${key} + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
var GM_setValue = function (k, v) { try { localStorage.setItem(${key} + k, JSON.stringify(v)); } catch (e) {} };
var GM_deleteValue = function (k) { try { localStorage.removeItem(${key} + k); } catch (e) {} };
var GM_listValues = function () { var out = []; try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k.indexOf(${key}) === 0) out.push(k.slice(${key}.length)); } } catch (e) {} return out; };
var GM_registerMenuCommand = function (name, fn) { return ${runNow ? "fn()" : "undefined"}; };
var GM_unregisterMenuCommand = function () {};
var GM_openInTab = function (url) { return window.open(url, "_blank"); };
var GM_setClipboard = function (t) { try { navigator.clipboard.writeText(String(t)); } catch (e) {} };
var GM_notification = function (o) { console.info("[" + GM_info.script.name + "]", typeof o === "string" ? o : o && o.text); };
var GM_xmlhttpRequest = function (d) {
  fetch(d.url, { method: d.method || "GET", headers: d.headers, body: d.data, credentials: d.anonymous ? "omit" : "include" })
    .then(function (r) { return r.text().then(function (t) { var res = { status: r.status, statusText: r.statusText, responseText: t, response: t, finalUrl: r.url, readyState: 4, responseHeaders: "" }; if (d.onload) d.onload(res); if (d.onloadend) d.onloadend(res); }); })
    .catch(function (e) { if (d.onerror) d.onerror(e); });
};
var GM = { info: GM_info, addStyle: GM_addStyle, openInTab: GM_openInTab, setClipboard: GM_setClipboard, notification: GM_notification, registerMenuCommand: GM_registerMenuCommand, xmlHttpRequest: GM_xmlhttpRequest,
  getValue: function (k, d) { return Promise.resolve(GM_getValue(k, d)); }, setValue: function (k, v) { return Promise.resolve(GM_setValue(k, v)); },
  deleteValue: function (k) { return Promise.resolve(GM_deleteValue(k)); }, listValues: function () { return Promise.resolve(GM_listValues()); } };`;
  const inner = item.body !== undefined ? `return (function () {\n${item.body}\n})();` : `${item.code}\n;`;
  return `(function () {\n${prelude}\n${inner}\n})()`;
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
    paired: s.paired,
    canConnect: !IS_FIREFOX,
    bypass: state.bypass,
    recordValues: state.recordValues,
    recording: tab ? state.recording.get(tab.id) || null : null,
    autoRecord: tab ? state.autoRecord.has(hostOf(tab.url)) : false,
    host: tab ? hostOf(tab.url) : "",
    styles: tab ? state.styles.filter((x) => styleCss(x, tab.url || "").trim()).map(({ id, name, description }) => ({ id, name, description, on: !state.disabledStyles.has(id) })) : [],
    requests: tab ? state.requests.filter((r) => hostOf(r.url) === hostOf(tab.url)).slice(0, 3) : [],
    pendingRequests: state.pendingRequests.length,
    watchers: tab ? state.watchers.filter((w) => hostOf(w.url) === hostOf(tab.url)) : [],
    allWatchers: state.watchers,
    port: s.port,
    trusted: s.trusted,
    conn: state.conn,
    connError: state.connError,
    agents: state.agents,
    browserHasDebugger: HAS_CDP,
    userScripts: state.userScripts,
    tab: tab && { id: tab.id, title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl, shareable: shareable(tab.url), shared: state.shared.has(tab.id), paused: state.paused.get(tab.id) || null, by: state.shared.get(tab.id)?.by, mode: state.shared.get(tab.id)?.mode || "full", confirming: publicConfirm(state.confirming.get(tab.id)), cdp: state.cdp.has(tab.id), activity: state.activity.get(tab.id) },
    siteAsk: tab ? await siteAsk(hostOf(tab.url)) : "risky",
    siteUploads: tab ? await uploadsAllowed(hostOf(tab.url)) : false,
    hasPanel: !!(api.sidePanel || api.sidebarAction),
    others: (await tabList()).filter((t) => t.id !== tabId).map((t) => ({ ...t, activity: state.activity.get(t.id) })),
    scripts: tab ? scriptsFor(tab.url).map(({ id, name, description, run }) => ({ id, name, description, run, on: !state.disabledScripts.has(id) })) : [],
    allScripts: state.scripts.map(({ id, name, description, run, matches, includes, version, body }) => ({ id, name, description, run, matches: matches.length ? matches : includes, version, imported: body === undefined, on: !state.disabledScripts.has(id) })),
    allStyles: state.styles.map(({ id, name, description, matches, version, body, unsupported }) => ({ id, name, description, matches, version, imported: body === undefined, unsupported, on: !state.disabledStyles.has(id) })),
  };
}

// Everything the side panel shows: every shared tab with its state, what is
// waiting for an answer, and the activity feed.
async function panelState() {
  const s = await settings();
  const tabs = (await tabList()).filter((t) => t.shared !== false).map((t) => ({
    ...t,
    host: hostOf(t.url),
    mode: state.shared.get(t.id)?.mode || "full",
    paused: state.paused.get(t.id) || null,
    confirming: publicConfirm(state.confirming.get(t.id)),
    activity: state.activity.get(t.id) || null,
  }));
  return { paired: s.paired, conn: state.conn, agents: state.agents, bypass: state.bypass, tabs, feed: state.feed.slice(-120) };
}

let broadcastTimer;
function broadcast() {
  // Coalesce bursts (an action can change several things at once).
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => { for (const port of ports) port.postMessage({ type: "changed" }); }, 40);
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
      case "ring":
        ring(msg.name, msg.opts);
        return { ok: true };
      case "share":
        await share(msg.tabId, "user", msg.mode);
        return { ok: true };
      case "panelState":
        return panelState();
      case "setMode":
        await setMode(msg.tabId, msg.mode);
        return { ok: true };
      case "setSiteUploads":
        await setUploadsAllowed(msg.host, !!msg.value);
        broadcast();
        return { ok: true };
      case "setSiteAsk":
        await setSiteAsk(msg.host, msg.value);
        broadcast();
        return { ok: true };
      case "confirmAnswer": {
        // From the popup or side panel (extension pages, which name the tab), or
        // from the pill on the page itself, which may only answer for its own tab.
        const fromPage = !String(sender.url || "").startsWith(api.runtime.getURL(""));
        const id = fromPage ? sender.tab?.id : msg.tabId;
        if (id == null || (fromPage && msg.tabId != null && msg.tabId !== id)) return { ok: false };
        const c = state.confirming.get(id);
        if (!c || (msg.id && msg.id !== c.id)) return { ok: false };
        return { ok: answerConfirm(id, msg.allow, msg.always) };
      }
      case "unshare":
        await unshare(msg.tabId);
        return { ok: true };
      case "stopAll":
        if (state.bypass) await setBypass(false);
        for (const id of [...state.shared.keys()]) await unshare(id);
        return { ok: true };
      case "startRec":
        await startRecording(msg.tabId, true);
        return { ok: true };
      case "stopRec":
        await stopRecording(msg.tabId);
        return { ok: true };
      case "setAutoRecord": {
        msg.on ? state.autoRecord.add(msg.host) : state.autoRecord.delete(msg.host);
        await api.storage.local.set({ autoRecord: [...state.autoRecord] });
        if (msg.tabId != null) {
          if (msg.on) await startRecording(msg.tabId, false);
          else if (state.recording.get(msg.tabId)?.manual === false) await stopRecording(msg.tabId);
        }
        broadcast();
        return { ok: true };
      }
      case "setRecordValues":
        state.recordValues = !!msg.on;
        await api.storage.local.set({ recordValues: state.recordValues });
        broadcast();
        return { ok: true };
      case "toggleStyle": {
        msg.on ? state.disabledStyles.delete(msg.id) : state.disabledStyles.add(msg.id);
        await api.storage.local.set({ disabledStyles: [...state.disabledStyles] });
        for (const t of await api.tabs.query({})) applyStyles(t.id, t.url);
        broadcast();
        return { ok: true };
      }
      case "sendRequest":
        return sendRequest(msg.tabId, msg.text, msg.images || []);
      case "hostRpc":
        return { result: await hostRpc(msg.method, msg.params || {}) };
      case "startPick":
        await startPick(msg.tabId);
        return { ok: true };
      case "pickSend":
        if (sender.tab) pickSend(sender.tab.id, msg.text, msg.element).then(() => broadcast(), (e) => console.warn(e));
        return { ok: true };
      case "rec":
        if (sender.tab) queueRec(sender.tab.id, msg.events || []);
        return { ok: true };
      case "setBypass":
        await setBypass(msg.on);
        return { ok: true };
      case "pause":
      case "resume": {
        const id = msg.tabId ?? sender.tab?.id;
        if (id == null || !state.shared.has(id)) return { ok: false };
        if (msg.type === "pause") pauseTab(id, { by: "user" });
        else resumeTab(id, true);
        return { ok: true };
      }
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
        if ("standby" in msg) patch.standby = !!msg.standby;
        if ("askWindow" in msg) patch.askWindow = !!msg.askWindow;
        if ("native" in msg) patch.native = !!msg.native;
        await api.storage.local.set(patch);
        if ("trusted" in msg) {
          for (const id of state.shared.keys()) (msg.trusted ? attachCdp : detachCdp)(id);
        }
        // Only reconnect when the connection itself changed.
        if ("key" in msg || "port" in msg || "standby" in msg || "native" in msg) {
          disconnect();
          await refreshStandby();
        }
        broadcast();
        return { ok: true };
      }
      case "runScript": {
        const s = state.scripts.find((x) => x.id === msg.id);
        if (!s) throw new Error("Script not found");
        return { value: await runJs(msg.tabId, runnable(s, true)) };
      }
      case "toggleScript":
        msg.on ? state.disabledScripts.delete(msg.id) : state.disabledScripts.add(msg.id);
        await api.storage.local.set({ disabledScripts: [...state.disabledScripts] });
        await syncUserScripts();
        broadcast();
        return { ok: true };
      case "importItem":
        return importItem(msg.text, msg.filename);
      case "exportItem": {
        const item = [...state.scripts, ...state.styles].find((x) => x.id === msg.id && x.kind === msg.kind);
        if (!item) throw new Error("Not found");
        return { code: item.code, filename: item.id + (item.kind === "style" ? ".user.css" : ".user.js") };
      }
      case "recheckScripts":
        await syncUserScripts();
        broadcast();
        return { ok: true };
      // from content scripts
      case "heartbeat":
        return { shared: state.shared.has(sender.tab?.id), recording: state.recording.has(sender.tab?.id) };
      case "stop":
        if (sender.tab) {
          await stopRecording(sender.tab.id);
          await unshare(sender.tab.id);
        }
        return { ok: true };
      case "console":
        if (sender.tab && state.shared.has(sender.tab.id) && !state.cdp.has(sender.tab.id)) pushConsole(sender.tab.id, msg.entry);
        return { ok: true };
      case "pillState":
        return { shared: state.shared.has(sender.tab?.id), paused: state.paused.get(sender.tab?.id) || null, confirm: publicConfirm(state.confirming.get(sender.tab?.id)), mode: state.shared.get(sender.tab?.id)?.mode || "full", agents: state.agents, conn: state.conn, activity: state.activity.get(sender.tab?.id), recording: state.recording.has(sender.tab?.id) ? { values: state.recordValues } : null };
    }
  })().then(
    (r) => sendResponse(r),
    (e) => sendResponse({ error: e?.message || String(e) })
  );
  return true;
});
