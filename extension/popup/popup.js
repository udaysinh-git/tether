import { patch, toast, liquidSwitches, rise, SPRING, sound } from "../motion.js";

liquidSwitches();

const api = globalThis.browser ?? globalThis.chrome;
const app = document.getElementById("app");
const statusEl = document.getElementById("status");

let tabId = null;
let st = null;
let pairError = "";
let scriptResult = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const host = (u) => { try { return new URL(u).host || u; } catch { return u || ""; } };
const send = (msg) => api.runtime.sendMessage(msg).then((r) => { if (r?.error) throw new Error(r.error); return r; });

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function joinNames(a) {
  return a.length <= 2 ? a.join(" and ") : `${a.slice(0, -1).join(", ")} and ${a.at(-1)}`;
}

function favicon(url) {
  return url && /^(https?:|data:)/.test(url) ? `<img src="${esc(url)}" alt="" />` : "";
}

function renderStatus() {
  let dot = "off", text;
  if (!st.paired) text = "Not paired";
  else if (st.conn === "connected" && st.agents.length) { dot = ""; text = joinNames(st.agents); }
  else if (st.conn === "connected") text = "Ready, no agent yet";
  else if (st.conn === "waiting" || st.conn === "connecting") text = st.tab?.shared ? "Waiting for the host" : "No agent running";
  else if (st.conn === "denied") text = "Pairing failed";
  else text = "Idle";
  patch(statusEl, `<span class="dot ${dot}"></span><span data-rise>${esc(text)}</span>`);
}

function pairCard() {
  return `
    <section class="card pair">
      <div>
        <p style="font-weight:500">Pair with your agent</p>
        <p class="muted">Run <span class="cmd">tether key</span> in a terminal and paste the key here. You only do this once.</p>
      </div>
      <form id="pair">
        <input id="key" type="text" placeholder="abcd-efgh-jkmn-pqrs" autocomplete="off" spellcheck="false" />
        <button class="primary" type="submit">Pair</button>
      </form>
      ${pairError ? `<p class="error">${esc(pairError)}</p>` : ""}
    </section>`;
}

function tabCard() {
  const t = st.tab;
  if (!t) return "";
  const page = `
    <div class="page">
      ${favicon(t.favIconUrl)}
      <div style="min-width:0">
        <p class="title">${esc(t.title || host(t.url))}</p>
        <p class="host">${esc(host(t.url))}</p>
      </div>
    </div>`;

  if (!t.shareable) {
    return `<section class="card">${page}<p class="muted">Browser and store pages can't be shared.</p></section>`;
  }

  if (!t.shared) {
    const hint = st.bypass ? "Bypass mode is on, so agents can already reach this tab." : "Agents can read and use this tab, and any tab it opens, until you stop.";
    return `
      <section class="card" data-morph="tab">
        ${page}
        <button class="primary share" data-act="share">Share this tab</button>
        <p class="faint">${hint}</p>
      </section>`;
  }

  const who = st.agents.length ? joinNames(st.agents) : "Your agent";
  const a = t.activity;
  const what = a ? `${esc(a.agent)} ${esc(a.summary)} <span class="faint" data-ago="${a.at}">· ${ago(a.at)}</span>` : st.agents.length ? "No actions yet." : "Start Claude Code or Codex with Tether added, and it can pick this tab up.";
  let how = t.by === "bypass" ? "Joined through bypass mode" : t.by === "opener" ? "Opened by a shared tab" : t.by === "agent" ? "Opened by the agent" : `${esc(who)} can use this tab`;
  let detail = what;
  if (t.paused?.by === "agent") { how = `${esc(t.paused.agent || who)} needs you on this page`; detail = esc(t.paused.message || ""); }
  else if (t.paused) { how = "Paused"; detail = `${esc(who)} will wait until you resume.`; }
  return `
    <section class="card" data-morph="tab">
      ${page}
      <div class="live">
        <p class="head" data-rise><span class="dot live-dot"></span>${how}</p>
        <p class="what" data-rise>${detail}</p>
      </div>
      <div class="row-actions">
        <button data-act="${t.paused ? "resume" : "pause"}" ${t.paused?.by === "agent" ? 'class="primary"' : ""}>${t.paused?.by === "agent" ? "Done" : t.paused ? "Resume" : "Pause"}</button>
        <button data-act="unshare" data-id="${t.id}">Stop sharing</button>
      </div>
    </section>`;
}

function othersSection() {
  const shared = st.others.filter((o) => o.shared !== false);
  if (!shared.length) return "";
  return `
    <section class="section">
      <h2>Also shared</h2>
      ${shared
        .map(
          (o) => `
        <div class="row">
          ${favicon(o.favIconUrl)}
          <div class="grow">
            <p class="name">${esc(o.title || host(o.url))}</p>
            <p class="sub">${o.activity ? `${esc(o.activity.summary)} · ${ago(o.activity.at)}` : esc(host(o.url))}</p>
          </div>
          <button class="quiet" data-act="focus" data-id="${o.id}" data-win="${o.windowId}" title="Go to tab">Open</button>
          <button class="quiet" data-act="unshare" data-id="${o.id}">Stop</button>
        </div>`
        )
        .join("")}
    </section>`;
}

function scriptsSection() {
  if (!st.scripts.length) return "";
  return `
    <section class="section">
      <h2>Scripts for this site</h2>
      ${st.scripts
        .map(
          (s) => `
        <div class="row">
          <div class="grow">
            <p class="name">${esc(s.name)}</p>
            <p class="sub">${esc(s.description || (s.run === "auto" ? "Runs on every visit" : "Run when you need it"))}</p>
          </div>
          <button class="quiet" data-act="run" data-id="${esc(s.id)}">Run</button>
          ${s.run === "auto" ? `<button class="switch small" role="switch" aria-checked="${s.on}" aria-label="Run ${esc(s.name)} on every visit" title="Run on every visit" data-act="scriptToggle" data-id="${esc(s.id)}" data-on="${!s.on}"></button>` : ""}
        </div>
        ${scriptResult?.id === s.id ? `<p class="result">${esc(scriptResult.text)}</p>` : ""}`
        )
        .join("")}
    </section>`;
}

function pillRow() {
  return `
    <div class="toggle-row">
      <p class="grow faint">Show status on the page (drag it to move)</p>
      <button class="switch small" role="switch" aria-checked="${st.showPill}" aria-label="Show status on the page" data-act="pillToggle" data-on="${!st.showPill}"></button>
    </div>`;
}

function bypassRow() {
  return `
    <section class="bypass">
      <div class="grow">
        <p>Bypass mode</p>
        <p class="faint">${st.bypass ? '<span class="on">On.</span> Agents can use every tab until you turn it off or close the browser.' : "Let agents use every tab, not just shared ones."}</p>
      </div>
      <button class="switch" role="switch" aria-checked="${st.bypass}" aria-label="Bypass mode" data-act="bypass"></button>
    </section>`;
}

function footer() {
  const anything = st.tab?.shared || st.others.some((o) => o.shared !== false) || st.bypass;
  return `
    <footer>
      <a href="#" data-act="options">Settings</a>
      ${anything ? `<button class="quiet" data-act="stopAll">Stop everything</button>` : ""}
    </footer>`;
}

function requestsSection() {
  const t = st.tab;
  if (!st.paired || !t?.shareable) return "";
  const rows = st.requests
    .map(
      (r) => `
      <div class="row req">
        <span class="dot ${r.status === "done" ? "off" : ""}"></span>
        <div class="grow">
          <p class="name">${esc(r.text || "(images only)")}</p>
          <p class="sub ${r.status === "done" ? "done" : ""}">${r.status === "done" ? esc(r.reply || "Done.") : `Waiting for your agent${r.images ? ` · ${r.images} image${r.images === 1 ? "" : "s"}` : ""} · ${ago(r.created)}`}</p>
        </div>
      </div>`
    )
    .join("");
  const pending = st.pendingRequests ? `<p class="faint" style="padding:0 8px">${st.pendingRequests} request${st.pendingRequests === 1 ? "" : "s"} will send when the host is running.</p>` : "";
  return `
    <section class="section">
      <h2 style="display:flex;justify-content:space-between;align-items:center;padding-right:0">Changes for this site
        ${composer.open ? "" : `<span><button class="quiet" data-act="pick" title="Point at something on the page and tell your agent about it">Pick</button><button class="quiet" data-act="compose">Request a change</button></span>`}</h2>
      ${rows}${pending}
    </section>`;
}

function stylesSection() {
  if (!st.styles.length) return "";
  return `
    <section class="section">
      <h2>Styles on this site</h2>
      ${st.styles
        .map(
          (s) => `
        <div class="toggle-row">
          <div class="grow">
            <p class="name">${esc(s.name)}</p>
            ${s.description ? `<p class="sub faint">${esc(s.description)}</p>` : ""}
          </div>
          <button class="switch small" role="switch" aria-checked="${s.on}" aria-label="${esc(s.name)}" data-act="style" data-id="${esc(s.id)}" data-on="${!s.on}"></button>
        </div>`
        )
        .join("")}
    </section>`;
}

function watchersSection() {
  if (!st.watchers?.length) return "";
  return `
    <section class="section">
      <h2>Watching this site</h2>
      ${st.watchers
        .map((w) => {
          const last = w.last ? (w.last.ok ? `${esc(w.last.message || "checked")} · ${ago(w.last.at)}` : `Last check failed · ${ago(w.last.at)}`) : "Not checked yet";
          return `
        <div class="toggle-row">
          <div class="grow">
            <p class="name">${esc(w.name)}</p>
            <p class="sub faint">Every ${w.every} min · ${last}</p>
          </div>
          <button class="switch small" role="switch" aria-checked="${w.enabled}" aria-label="${esc(w.name)}" data-act="watcher" data-id="${esc(w.id)}" data-on="${!w.enabled}"></button>
        </div>`;
        })
        .join("")}
    </section>`;
}

function recordSection() {
  const t = st.tab;
  if (!st.paired || !t?.shareable) return "";
  const r = st.recording;
  const status = r
    ? `<p><span class="dot rec-dot" style="margin-right:8px"></span>Recording this visit</p><p class="faint">Started ${ago(r.since)}. Clicks, typing and page structure go to ~/.tether/sites/${esc(st.host)}.</p>`
    : `<p>Record this visit</p><p class="faint">Saves what you click and type and how the pages are built, so agents learn the site. No video.</p>`;
  return `
    <section class="bypass" style="padding-top:4px">
      <div class="grow">${status}</div>
      <button data-act="${r ? "stopRec" : "startRec"}">${r ? "Stop" : "Record"}</button>
    </section>
    <div class="toggle-row">
      <p class="grow faint">Always record on ${esc(st.host)}</p>
      <button class="switch small" role="switch" aria-checked="${st.autoRecord}" aria-label="Always record on ${esc(st.host)}" data-act="autoRec" data-on="${!st.autoRecord}"></button>
    </div>`;
}

function render() {
  renderStatus();
  const err = st.conn === "denied" && st.connError ? `<p class="error" style="padding:0 4px">${esc(st.connError)}</p>` : "";
  patch(document.getElementById("top"), (st.paired ? tabCard() : pairCard()) + err + requestsSection());
  patch(document.getElementById("rest"), othersSection() + stylesSection() + scriptsSection() + watchersSection() + recordSection() + (st.paired ? pillRow() + bypassRow() : "") + footer());
}

// ---------------------------------------------------------------- composer
// Lives outside the re-rendered parts so typing isn't interrupted by updates.

const composer = { open: false, images: [], sending: false };
const composerEl = document.getElementById("composer");

function openComposer() {
  composer.open = true;
  composerEl.hidden = false;
  composerEl.innerHTML = `
    <textarea id="reqText" placeholder="What should change? For a new look, paste or drop screenshots or mockups and say what you like about them."></textarea>
    <div class="thumbs" id="thumbs"></div>
    <div class="bar">
      <label class="attach">Add images<input id="reqFiles" type="file" accept="image/*" multiple /></label>
      <span class="grow"></span>
      <button class="quiet" data-act="cancelReq">Cancel</button>
      <button class="primary" data-act="sendReq">Send</button>
    </div>
    <p class="faint">Sending shares this tab so your agent can try changes on it.</p>`;
  composerEl.animate([{ opacity: 0, transform: "translateY(8px) scale(0.98)", filter: "blur(6px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], { duration: 460, easing: SPRING });
  document.getElementById("reqText").focus();
  document.getElementById("reqFiles").addEventListener("change", (e) => addImages([...e.target.files]));
  render();
}

function closeComposer() {
  composer.open = false;
  composer.images = [];
  composerEl.hidden = true;
  composerEl.innerHTML = "";
  render();
}

function renderThumbs() {
  document.getElementById("thumbs").innerHTML = composer.images
    .map((img, i) => `<div class="thumb"><img src="${img.dataUrl}" alt="${esc(img.name)}" /><button type="button" data-act="dropImg" data-i="${i}" aria-label="Remove ${esc(img.name)}">×</button></div>`)
    .join("");
  const last = document.getElementById("thumbs").lastElementChild;
  if (last) last.animate([{ opacity: 0, transform: "scale(0.6)" }, { opacity: 1, transform: "none" }], { duration: 520, easing: "linear(0, 0.096, 0.292, 0.534, 0.774, 0.977, 1.137, 1.22, 1.248, 1.233, 1.188, 1.13, 1.064, 1.012, 0.973, 0.949, 0.939, 0.941, 0.951, 0.966, 0.981, 0.994, 1.005, 1.012, 1.015, 1.015, 1.013, 1.009, 1.006, 1.002, 0.999, 0.997, 0.996, 0.996, 0.997, 0.998, 0.998, 0.999, 1, 1.001, 1)" });
}

// Large screenshots are scaled to 1600px on the long side to keep requests small.
async function toDataUrl(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await c.convertToBlob(file.type === "image/png" && file.size < 1.5e6 ? { type: "image/png" } : { type: "image/jpeg", quality: 0.86 });
  return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
}

async function addImages(files) {
  for (const f of files.filter((f) => f.type.startsWith("image/")).slice(0, 8 - composer.images.length)) {
    composer.images.push({ name: f.name || "pasted image", dataUrl: await toDataUrl(f) });
  }
  renderThumbs();
}

composerEl.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addImages(files); }
});
composerEl.addEventListener("dragover", (e) => { e.preventDefault(); composerEl.classList.add("drag"); });
composerEl.addEventListener("dragleave", () => composerEl.classList.remove("drag"));
composerEl.addEventListener("drop", (e) => {
  e.preventDefault();
  composerEl.classList.remove("drag");
  addImages([...e.dataTransfer.files]);
});

async function sendComposer(button) {
  const text = document.getElementById("reqText").value.trim();
  if (!text && !composer.images.length) return document.getElementById("reqText").focus();
  button.disabled = true;
  button.textContent = "Sending…";
  try {
    const r = await send({ type: "sendRequest", tabId, text, images: composer.images });
    closeComposer();
    sound("landed");
    if (r.queued) toast("Request saved", { body: "It reaches your agent once the Tether host runs." });
  } catch (err) {
    button.disabled = false;
    button.textContent = "Send";
    toast("That didn't work", { tone: "bad", body: err.message });
  }
}

composerEl.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  if (b.dataset.act === "cancelReq") closeComposer();
  if (b.dataset.act === "sendReq") sendComposer(b);
  if (b.dataset.act === "dropImg") { composer.images.splice(Number(b.dataset.i), 1); renderThumbs(); }
});

async function refresh() {
  st = await send({ type: "state", tabId });
  st.showPill = (await api.storage.local.get("showPill")).showPill !== false;
  render();
}

app.addEventListener("submit", async (e) => {
  if (e.target.id !== "pair") return;
  e.preventDefault();
  const key = document.getElementById("key").value.trim();
  if (!/^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/.test(key)) {
    pairError = "That doesn't look like a Tether key. It has four groups of four letters and digits.";
    return render();
  }
  pairError = "";
  await send({ type: "setSettings", key });
  refresh();
});

app.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b || composerEl.contains(b)) return;
  e.preventDefault();
  const id = Number(b.dataset.id);
  b.disabled = true;
  try {
    switch (b.dataset.act) {
      case "share":
        // Firefox lets users withhold site access at install; ask on the first share.
        if (!(await api.permissions.contains({ origins: ["<all_urls>"] }))) {
          if (!(await api.permissions.request({ origins: ["<all_urls>"] }))) break;
        }
        await send({ type: "share", tabId });
        sound("landed");
        break;
      case "unshare":
        await send({ type: "unshare", tabId: id });
        sound("hush");
        break;
      case "stopAll":
        await send({ type: "stopAll" });
        sound("hush", { pitch: 0.85 });
        break;
      case "bypass":
        await send({ type: "setBypass", on: !st.bypass });
        break;
      case "compose":
        sound("whisk", { pitch: 1.6 });
        openComposer();
        return;
      case "pick":
        await send({ type: "startPick", tabId });
        window.close();
        return;
      case "style":
        await send({ type: "toggleStyle", id: b.dataset.id, on: b.dataset.on === "true" });
        break;
      case "pause":
      case "resume":
        await send({ type: b.dataset.act, tabId });
        sound(b.dataset.act === "pause" ? "drape" : st.tab?.paused?.by === "agent" ? "paid" : "float");
        break;
      case "watcher":
        await send({ type: "hostRpc", method: "setWatcherEnabled", params: { id: b.dataset.id, on: b.dataset.on === "true" } });
        break;
      case "pillToggle":
        await api.storage.local.set({ showPill: b.dataset.on === "true" });
        break;
      case "scriptToggle":
        await send({ type: "toggleScript", id: b.dataset.id, on: b.dataset.on === "true" });
        break;
      case "startRec":
        await send({ type: "startRec", tabId });
        break;
      case "stopRec":
        await send({ type: "stopRec", tabId });
        break;
      case "autoRec":
        await send({ type: "setAutoRecord", host: st.host, on: b.dataset.on === "true", tabId });
        break;
      case "focus":
        await api.tabs.update(id, { active: true });
        await api.windows.update(Number(b.dataset.win), { focused: true });
        window.close();
        return;
      case "run": {
        const r = await send({ type: "runScript", id: b.dataset.id, tabId });
        scriptResult = { id: b.dataset.id, text: r.value === undefined ? "Done." : typeof r.value === "string" ? r.value : JSON.stringify(r.value) };
        break;
      }
      case "options":
        api.runtime.openOptionsPage();
        window.close();
        return;
    }
  } catch (err) {
    if (b.dataset.act === "run") scriptResult = { id: b.dataset.id, text: err.message };
    else toast("That didn't work", { tone: "bad", body: err.message });
  }
  refresh();
});

const [active] = await api.tabs.query({ active: true, currentWindow: true });
tabId = active?.id ?? null;
api.runtime.connect({ name: "popup" }).onMessage.addListener(() => refresh());
await refresh();

// Keep "4s ago" honest without re-rendering everything.
setInterval(() => {
  for (const el of document.querySelectorAll("[data-ago]")) el.textContent = `· ${ago(Number(el.dataset.ago))}`;
}, 1000);
