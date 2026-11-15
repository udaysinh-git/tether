const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isFirefox = typeof globalThis.browser !== "undefined" && !!api.runtime.getBrowserInfo;
const send = (msg) => api.runtime.sendMessage(msg).then((r) => { if (r?.error) throw new Error(r.error); return r; });
const where = (m) => (m.length ? m.map((x) => (x === "<all_urls>" || x === "*://*/*" ? "every site" : x)).join(", ") : "every site");

function itemRow(kind, s) {
  const how = kind === "style" ? `On ${where(s.matches)}` : s.run === "auto" ? `Runs on every visit to ${where(s.matches)}` : `Run from the popup on ${where(s.matches)}`;
  const note = s.unsupported ? ` · ${esc(s.unsupported)}` : "";
  return `<div class="script line" style="align-items:center">
    <div class="grow">
      <p class="name">${esc(s.name)} <span class="faint">v${esc(s.version)}${s.imported ? " · imported" : ""}</span></p>
      ${s.description ? `<p class="muted">${esc(s.description)}</p>` : ""}
      <p class="faint">${esc(how)}${note}</p>
    </div>
    <button class="quiet" data-export="${esc(s.id)}" data-kind="${kind}" title="Download the ${kind === "style" ? ".user.css for Stylus" : ".user.js for Tampermonkey"}">Download</button>
    ${kind === "style" || s.run === "auto" ? `<button class="switch" role="switch" aria-checked="${s.on}" aria-label="${esc(s.name)}" data-toggle="${esc(s.id)}" data-kind="${kind}"></button>` : ""}
  </div>`;
}

async function load() {
  const st = await send({ type: "state", tabId: -1 });
  const { key = "", autoRecord = [], standby, askWindow } = await api.storage.local.get(["key", "autoRecord", "standby", "askWindow"]);
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

  $("styles").innerHTML = st.allStyles.length
    ? st.allStyles.map((s) => itemRow("style", s)).join("")
    : `<p class="muted">No styles yet. Open a site, click Tether, choose “Request a change” and describe or paste the look you want.</p>`;

  $("scripts").innerHTML = st.allScripts.length
    ? st.allScripts.map((s) => itemRow("script", s)).join("")
    : `<p class="muted">No scripts yet. Ask your agent for one, for example “make me a script that fills this form with my usual details”.</p>`;
}

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
