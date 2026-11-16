const api = globalThis.browser ?? globalThis.chrome;
const q = new URLSearchParams(location.search);
const id = q.get("id");
const kind = q.get("kind") || "bypass";
const agent = q.get("agent") || "An agent";
const detail = q.get("detail") || "";

const COPY = {
  bypass: {
    title: `${agent} wants access to all your tabs`,
    body: "Bypass mode lets it read and control every open tab, including ones you haven't shared. It stays on until you turn it off in the Tether popup or close the browser.",
    allow: "Allow",
  },
  window: {
    title: `${agent} wants its own window`,
    body: `It opens a new window in this browser, signed in as you, and works only in the tabs of that window. Your other tabs stay private. Close the window to end the session.${detail ? ` It will start at ${detail}.` : ""}`,
    allow: "Open window",
  },
  current: {
    title: `${agent} wants to use this tab`,
    body: `It can read and control “${detail}” and any tab that page opens, until you press Stop on the page or in the Tether popup.`,
    allow: "Share tab",
  },
};

const c = COPY[kind] || COPY.bypass;
document.title = `Tether: ${c.title}`;
document.getElementById("title").textContent = c.title;
document.getElementById("initial").textContent = (agent.trim()[0] || "A").toUpperCase();
document.getElementById("body").textContent = c.body;
document.getElementById("allow").textContent = c.allow;
const reason = q.get("reason");
if (reason) {
  const el = document.getElementById("reason");
  el.textContent = `“${reason}”`;
  el.hidden = false;
}

const answer = async (allow) => {
  await api.runtime.sendMessage({ type: "bypassAnswer", id, allow });
  window.close();
};
document.getElementById("allow").addEventListener("click", () => answer(true));
document.getElementById("deny").addEventListener("click", () => answer(false));
document.getElementById("deny").focus();
document.addEventListener("keydown", (e) => { if (e.key === "Escape") answer(false); });
