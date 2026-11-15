const api = globalThis.browser ?? globalThis.chrome;
const q = new URLSearchParams(location.search);
const id = q.get("id");

document.getElementById("title").textContent = `${q.get("agent") || "An agent"} wants access to all your tabs`;
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
