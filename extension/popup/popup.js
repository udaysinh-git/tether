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
  else if (st.conn === "connected") text = "Host ready, no agent yet";
  else if (st.conn === "waiting" || st.conn === "connecting") text = "Waiting for the host";
  else if (st.conn === "denied") text = "Pairing failed";
  else text = "Idle";
  statusEl.innerHTML = `<span class="dot ${dot}"></span><span>${esc(text)}</span>`;
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
      <section class="card">
        ${page}
        <button class="primary share" data-act="share">Share this tab</button>
        <p class="faint">${hint}</p>
      </section>`;
  }

  const who = st.agents.length ? joinNames(st.agents) : "Your agent";
  const a = t.activity;
  const what = a ? `${esc(a.agent)} ${esc(a.summary)} <span class="faint" data-ago="${a.at}">· ${ago(a.at)}</span>` : st.agents.length ? "No actions yet." : "Start Claude Code or Codex with Tether added, and it can pick this tab up.";
  const how = t.by === "bypass" ? "Joined through bypass mode" : t.by === "opener" ? "Opened by a shared tab" : t.by === "agent" ? "Opened by the agent" : `${esc(who)} can use this tab`;
  return `
    <section class="card">
      ${page}
      <div class="live">
        <p class="head"><span class="dot"></span>${how}</p>
        <p class="what">${what}</p>
      </div>
      <button data-act="unshare" data-id="${t.id}">Stop sharing</button>
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
        </div>
        ${scriptResult?.id === s.id ? `<p class="result">${esc(scriptResult.text)}</p>` : ""}`
        )
        .join("")}
    </section>`;
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

function render() {
  renderStatus();
  const err = st.conn === "denied" && st.connError ? `<p class="error" style="padding:0 4px">${esc(st.connError)}</p>` : "";
  app.innerHTML = (st.paired ? tabCard() : pairCard()) + err + othersSection() + scriptsSection() + (st.paired ? bypassRow() : "") + footer();
}

async function refresh() {
  st = await send({ type: "state", tabId });
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
  if (!b) return;
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
        break;
      case "unshare":
        await send({ type: "unshare", tabId: id });
        break;
      case "stopAll":
        await send({ type: "stopAll" });
        break;
      case "bypass":
        await send({ type: "setBypass", on: !st.bypass });
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
    else alert(err.message);
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
