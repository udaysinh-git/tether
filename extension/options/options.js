const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isFirefox = typeof globalThis.browser !== "undefined" && !!api.runtime.getBrowserInfo;
const send = (msg) => api.runtime.sendMessage(msg).then((r) => { if (r?.error) throw new Error(r.error); return r; });
const where = (m) => (m.length ? m.map((x) => (x === "<all_urls>" || x === "*://*/*" ? "every site" : x)).join(", ") : "every site");

const rpc = (method, params = {}) => send({ type: "hostRpc", method, params }).then((r) => r.result);
let gallery = {};

function siteOf(matches) {
  for (const m of matches) {
    const h = String(m).match(/([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?|localhost(:\d+)?|\d+\.\d+\.\d+\.\d+(:\d+)?/i);
    if (h) return h[0].replace(/^www\./, "");
  }
  return "Every site";
}

function itemRow(kind, s) {
  const how = kind === "style" ? `On ${where(s.matches)}` : s.run === "auto" ? `Runs on every visit to ${where(s.matches)}` : `Run from the popup on ${where(s.matches)}`;
  const note = s.unsupported ? ` · ${esc(s.unsupported)}` : "";
  return `<div class="script line" style="align-items:center">
    <div class="grow">
      <p class="name">${esc(s.name)} <span class="faint">v${esc(s.version)}${s.imported ? " · imported" : ""}</span></p>
      ${s.description ? `<p class="muted">${esc(s.description)}</p>` : ""}
      <p class="faint">${esc(how)}${note}</p>
      ${gallery[`${kind}:${s.id}`]?.before ? `<div class="shots"><figure><img data-shot="${esc(s.id)}" data-which="before" data-kind="${kind}" alt="Before" /><figcaption>Before</figcaption></figure><figure><img data-shot="${esc(s.id)}" data-which="after" data-kind="${kind}" alt="After" /><figcaption>After</figcaption></figure></div>` : ""}
    </div>
    <button class="quiet" data-export="${esc(s.id)}" data-kind="${kind}" title="Download the ${kind === "style" ? ".user.css for Stylus" : ".user.js for Tampermonkey"}">Download</button>
    ${gallery[`${kind}:${s.id}`]?.gist ? `<a href="${esc(gallery[`${kind}:${s.id}`].gist.raw)}" target="_blank" rel="noopener" title="Install link for Tampermonkey or Stylus">Gist</a>` : ""}
    <button class="quiet" data-publish="${esc(s.id)}" data-kind="${kind}" title="Publish as a secret GitHub Gist">${gallery[`${kind}:${s.id}`]?.gist ? "Update Gist" : "Publish"}</button>
    ${kind === "style" || s.run === "auto" ? `<button class="switch" role="switch" aria-checked="${s.on}" aria-label="${esc(s.name)}" data-toggle="${esc(s.id)}" data-kind="${kind}"></button>` : ""}
  </div>`;
}

async function load() {
  const st = await send({ type: "state", tabId: -1 });
  const { key = "", autoRecord = [], standby, askWindow, showCursor, showPill } = await api.storage.local.get(["key", "autoRecord", "standby", "askWindow", "showCursor", "showPill"]);
  $("showPill").setAttribute("aria-checked", String(showPill !== false));
  $("showCursor").setAttribute("aria-checked", String(showCursor !== false));
  $("standby").setAttribute("aria-checked", String(standby !== false));
  $("askWindow").setAttribute("aria-checked", String(askWindow !== false));
  $("key").value = key;
  $("port").value = st.port;

  if (st.browserHasDebugger) {
    $("trustedSection").hidden = false;
    $("trusted").setAttribute("aria-checked", String(st.trusted));
  }

  const us = $("usStatus");
  if (st.userScripts === "ok") us.textContent = "Scripts set to run on every visit are active.";
  else if (isFirefox) us.innerHTML = `Scripts that run on every visit need one more permission. <button id="grant">Allow user scripts</button>`;
  else us.innerHTML = `To let scripts run on every visit, open <span class="cmd">chrome://extensions</span>, click Details on Tether and turn on “Allow user scripts”. Then <a href="#" id="recheck">check again</a>.`;

  $("recValues").setAttribute("aria-checked", String(st.recordValues));
  $("autoSites").innerHTML = autoRecord.length
    ? `<p class="muted" style="margin-bottom:6px">Always recorded:</p>` + autoRecord.map((h) => `<div class="script line" style="align-items:center"><p class="grow">${esc(h)}</p><button class="quiet" data-host="${esc(h)}">Stop</button></div>`).join("")
    : `<p class="muted">No site is recorded automatically. Turn it on per site from the popup.</p>`;

  try { gallery = (await rpc("galleryIndex")) || {}; } catch { gallery = {}; }
  const bySite = new Map();
  for (const [kind, list] of [["style", st.allStyles], ["script", st.allScripts]]) {
    for (const s of list) {
      const site = siteOf(s.matches);
      if (!bySite.has(site)) bySite.set(site, []);
      bySite.get(site).push(itemRow(kind, s));
    }
  }
  $("gallery").innerHTML = bySite.size
    ? [...bySite].sort((a, b) => (a[0] === "Every site") - (b[0] === "Every site") || a[0].localeCompare(b[0])).map(([site, rows]) => `<h3 class="site">${esc(site)}</h3>${rows.join("")}`).join("")
    : `<p class="muted">Nothing yet. Open a site, click Tether and choose “Request a change”, or ask your agent for a script.</p>`;
  for (const img of document.querySelectorAll("img[data-shot]")) {
    rpc("galleryImage", { kind: img.dataset.kind, id: img.dataset.shot, which: img.dataset.which }).then((r) => { if (r?.dataUrl) img.src = r.dataUrl; }, () => {});
  }

  const ws = st.allWatchers || [];
  $("watchers").innerHTML = ws.length
    ? ws.map((w) => `<div class="script line" style="align-items:center">
        <div class="grow">
          <p class="name">${esc(w.name)}</p>
          <p class="faint">Every ${w.every} min · ${w.mode === "tab" ? "opens the page" : "fetches"} ${esc(w.url)} · ${esc(w.notify.join(" and "))}</p>
          <p class="muted">${w.last ? (w.last.ok ? esc(w.last.message || "checked") : "Last check failed: " + esc(w.last.error || "")) : "Not checked yet"}</p>
        </div>
        <button class="quiet" data-watch-run="${esc(w.id)}">Check now</button>
        <button class="quiet" data-watch-del="${esc(w.id)}">Delete</button>
        <button class="switch" role="switch" aria-checked="${w.enabled}" aria-label="${esc(w.name)}" data-watch="${esc(w.id)}"></button>
      </div>`).join("")
    : `<p class="muted">No watchers. Ask your agent, for example “tell me when the price on this page drops below 2000”.</p>`;

  try {
    const hs = await rpc("getSettings");
    $("ntfyTopic").value = hs.ntfyTopic;
    $("ntfyServer").value = hs.ntfyServer;
    $("gistAccount").value = hs.gistAccount;
  } catch {}
}

$("hostSettings").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await rpc("setSettings", { ntfyTopic: $("ntfyTopic").value, ntfyServer: $("ntfyServer").value, gistAccount: $("gistAccount").value });
    $("hostSaved").textContent = "Saved.";
  } catch (err) {
    $("hostSaved").textContent = err.message;
  }
  setTimeout(() => ($("hostSaved").textContent = ""), 3000);
});

$("conn").addEventListener("submit", async (e) => {
  e.preventDefault();
  await send({ type: "setSettings", key: $("key").value, port: $("port").value });
  $("saved").textContent = "Saved.";
  setTimeout(() => ($("saved").textContent = ""), 2000);
});

function flip(btn) {
  const on = btn.getAttribute("aria-checked") !== "true";
  btn.setAttribute("aria-checked", String(on));
  return on;
}

$("installFile").addEventListener("change", async (e) => {
  const out = $("installResult");
  for (const f of e.target.files) {
    try {
      const r = await send({ type: "importItem", text: await f.text(), filename: f.name });
      out.textContent = `Installed ${r.name}.${r.warning ? " " + r.warning : ""}`;
    } catch (err) {
      out.textContent = `${f.name}: ${err.message}`;
    }
  }
  e.target.value = "";
  load();
});

document.addEventListener("click", async (e) => {
  const t = e.target.closest("button, a");
  if (!t) return;
  if (t.id === "trusted") return send({ type: "setSettings", trusted: flip(t) });
  if (t.id === "standby") return send({ type: "setSettings", standby: flip(t) });
  if (t.id === "askWindow") return send({ type: "setSettings", askWindow: flip(t) });
  if (t.id === "showCursor") return api.storage.local.set({ showCursor: flip(t) });
  if (t.id === "showPill") return api.storage.local.set({ showPill: flip(t) });
  if (t.id === "recValues") return send({ type: "setRecordValues", on: flip(t) });
  if (t.id === "grant") {
    if (await api.permissions.request({ permissions: ["userScripts"] })) await send({ type: "recheckScripts" });
    return load();
  }
  if (t.id === "recheck") {
    e.preventDefault();
    await send({ type: "recheckScripts" });
    return load();
  }
  if (t.dataset.host) {
    await send({ type: "setAutoRecord", host: t.dataset.host, on: false });
    return load();
  }
  if (t.dataset.toggle) {
    const on = flip(t);
    return send({ type: t.dataset.kind === "style" ? "toggleStyle" : "toggleScript", id: t.dataset.toggle, on });
  }
  if (t.dataset.watch) {
    const on = flip(t);
    return rpc("setWatcherEnabled", { id: t.dataset.watch, on });
  }
  if (t.dataset.watchRun) {
    t.disabled = true;
    try { await rpc("runWatcher", { id: t.dataset.watchRun }); } catch (err) { alert(err.message); }
    return load();
  }
  if (t.dataset.watchDel) {
    if (!confirm("Delete this watcher?")) return;
    await rpc("deleteWatcher", { id: t.dataset.watchDel });
    return load();
  }
  if (t.dataset.publish) {
    const again = t.textContent.includes("Update");
    if (!again && !confirm("Publish this as a secret GitHub Gist? It won't be listed, but anyone with the link can see and install it.")) return;
    t.disabled = true;
    try {
      const g = await rpc("publishGist", { kind: t.dataset.kind, id: t.dataset.publish });
      $("publishResult").innerHTML = `Published. Install link: <a href="${esc(g.raw)}" target="_blank" rel="noopener">${esc(g.raw)}</a>`;
    } catch (err) {
      $("publishResult").textContent = err.message;
    }
    return load();
  }
  if (t.dataset.export) {
    const r = await send({ type: "exportItem", id: t.dataset.export, kind: t.dataset.kind });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([r.code], { type: "text/plain" }));
    a.download = r.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
});

load();
