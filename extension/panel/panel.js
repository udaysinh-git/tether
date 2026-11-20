// Tether side panel: stays open beside the page and shows, live, every tab
// agents can use, anything waiting for the user (Allow/Deny, Done), and a
// running feed of what agents did and what the user answered.
import { patch, toast, sound } from "../motion.js";

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const host = (u) => { try { return new URL(u).host || u; } catch { return u || ""; } };
const send = (msg) => api.runtime.sendMessage(msg).then((r) => { if (r?.error) throw new Error(r.error); return r; });
const joinNames = (a) => (a.length <= 2 ? a.join(" and ") : `${a.slice(0, -1).join(", ")} and ${a.at(-1)}`);
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const favicon = (url) => (url && /^(https?:|data:)/.test(url) ? `<img src="${esc(url)}" alt="" />` : `<span class="fav"></span>`);

let st = null;

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function renderStatus() {
  let dot = "off", text;
  if (!st.paired) text = "Not paired";
  else if (st.conn === "connected" && st.agents.length) { dot = ""; text = joinNames(st.agents); }
  else if (st.conn === "connected") text = "Ready, no agent yet";
  else if (st.conn === "waiting" || st.conn === "connecting") text = "No agent running";
  else if (st.conn === "denied") text = "Pairing failed";
  else text = "Idle";
  patch($("status"), `<span class="dot ${dot}"></span><span data-rise>${esc(text)}</span>`);
}

// Things only the user can unblock come first.
function renderAsks() {
  const cards = [];
  for (const t of st.tabs) {
    const where = `${esc(t.title || t.host)}${t.title ? ` · ${esc(t.host)}` : ""}`;
    if (t.confirming) {
      const c = t.confirming;
      cards.push(`
        <section class="card ask-card" data-morph="ask-${t.id}">
          <p class="head" data-rise><span class="dot"></span><span>${esc(c.agent)} wants to ${esc(c.action)}</span></p>
          <p class="where">${where}</p>
          <div class="actions">
            <button data-act="deny" data-tab="${t.id}" data-cid="${esc(c.id)}">Deny</button>
            <button class="primary" data-act="allow" data-tab="${t.id}" data-cid="${esc(c.id)}">Allow</button>
          </div>
        </section>`);
    } else if (t.paused?.by === "agent") {
      cards.push(`
        <section class="card ask-card" data-morph="ask-${t.id}">
          <p class="head" data-rise><span class="dot"></span><span>${esc(t.paused.agent || "Your agent")} needs you: ${esc(t.paused.message || "take over this tab")}</span></p>
          <p class="where">${where}</p>
          <div class="actions">
            <button data-act="focus" data-tab="${t.id}" data-win="${t.windowId}">Go to tab</button>
            <button class="primary" data-act="resume" data-tab="${t.id}">Done</button>
          </div>
        </section>`);
    }
  }
  patch($("asks"), cards.join(""));
}

function renderTabs() {
  if (!st.tabs.length) {
    patch($("tabs"), `
      <section class="card empty-card">
        <p>Nothing is shared</p>
        <p class="faint">Share a tab from the Tether button, or let an agent ask for its own window. Everything agents do shows up here as it happens.</p>
      </section>`);
    return;
  }
  const rows = st.tabs.map((t) => {
    const tags = [
      t.mode === "read" ? `<span class="tag">Read only</span>` : "",
      t.paused && t.paused.by !== "agent" ? `<span class="tag">Paused</span>` : "",
      t.confirming || t.paused?.by === "agent" ? `<span class="tag gold">Waiting for you</span>` : "",
    ].join("");
    const last = t.activity ? `${esc(t.activity.agent)} ${esc(t.activity.summary)} · <span data-ago="${t.activity.at}">${ago(t.activity.at)}</span>` : esc(t.host);
    return `
      <div class="tab">
        ${favicon(t.favIconUrl)}
        <div class="grow">
          <p class="name" data-act="focus" data-tab="${t.id}" data-win="${t.windowId}" title="Go to this tab">${esc(t.title || t.host)}</p>
          <p class="sub">${tags}${last}</p>
        </div>
        <div class="btns">
          ${t.paused ? (t.paused.by === "agent" ? "" : `<button class="quiet" data-act="resume" data-tab="${t.id}">Resume</button>`) : t.mode === "read" ? "" : `<button class="quiet" data-act="pause" data-tab="${t.id}" title="Hold the agent on this tab">Pause</button>`}
          <button class="quiet" data-act="unshare" data-tab="${t.id}" title="Stop sharing this tab">Stop</button>
        </div>
      </div>`;
  });
  patch($("tabs"), `<section class="section"><h2>Shared tabs</h2>${rows.join("")}</section>`);
}

function renderFeed() {
  const list = $("feed");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const items = st.feed.map((f) => {
    const who = f.agent || "Agent";
    return `
      <li class="${esc(f.kind)}">
        <time datetime="${new Date(f.at).toISOString()}">${clock(f.at)}</time>
        <span class="line"><span class="who">${esc(who)}</span> ${esc(f.text)}${f.host ? `<span class="where">${esc(f.title || f.host)}</span>` : ""}</span>
      </li>`;
  });
  patch(list, items.length ? items.join("") : `<li><span></span><span class="empty">Nothing yet. Agent actions and your answers appear here.</span></li>`);
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

function renderFoot() {
  const any = st.tabs.length || st.bypass;
  patch($("foot"), `
    <a href="#" data-act="options">Settings</a>
    ${any ? `<button class="quiet" data-act="stopAll">Stop everything</button>` : ""}`);
}

async function refresh() {
  st = await send({ type: "panelState" });
  renderStatus();
  renderAsks();
  renderTabs();
  renderFeed();
  renderFoot();
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  e.preventDefault();
  const tabId = Number(b.dataset.tab);
  if (b.tagName === "BUTTON") b.disabled = true;
  try {
    switch (b.dataset.act) {
      case "allow":
      case "deny":
        await send({ type: "confirmAnswer", tabId, id: b.dataset.cid, allow: b.dataset.act === "allow" });
        sound(b.dataset.act === "allow" ? "paid" : "hush");
        break;
      case "pause":
      case "resume":
        await send({ type: b.dataset.act, tabId });
        sound(b.dataset.act === "pause" ? "drape" : "float");
        break;
      case "unshare":
        await send({ type: "unshare", tabId });
        sound("hush");
        break;
      case "stopAll":
        await send({ type: "stopAll" });
        sound("hush", { pitch: 0.85 });
        break;
      case "focus":
        await api.tabs.update(tabId, { active: true });
        await api.windows.update(Number(b.dataset.win), { focused: true });
        break;
      case "options":
        api.runtime.openOptionsPage();
        break;
    }
  } catch (err) {
    toast("That didn't work", { tone: "bad", body: err.message });
  }
  refresh();
});

api.runtime.connect({ name: "popup" }).onMessage.addListener(() => refresh());
await refresh();
const list = $("feed");
list.scrollTop = list.scrollHeight;

setInterval(() => {
  for (const el of document.querySelectorAll("[data-ago]")) el.textContent = ago(Number(el.dataset.ago));
}, 1000);
