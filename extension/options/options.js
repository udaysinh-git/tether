const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isFirefox = typeof globalThis.browser !== "undefined" && !!api.runtime.getBrowserInfo;

async function load() {
  const st = await api.runtime.sendMessage({ type: "state", tabId: -1 });
  const { key = "" } = await api.storage.local.get("key");
  $("key").value = key;
  $("port").value = st.port;

  if (st.browserHasDebugger) {
    $("trustedSection").hidden = false;
    $("trusted").setAttribute("aria-checked", String(st.trusted));
  }

  const us = $("usStatus");
  if (st.userScripts === "ok") us.textContent = "Scripts set to run on every visit are active.";
  else if (isFirefox) {
    us.innerHTML = `Scripts that run on every visit need one more permission. <button id="grant">Allow user scripts</button>`;
    $("grant").addEventListener("click", async () => {
      if (await api.permissions.request({ permissions: ["userScripts"] })) {
        await api.runtime.sendMessage({ type: "recheckScripts" });
        load();
      }
    });
  } else {
    us.innerHTML = `To let scripts run on every visit, open <span class="cmd">chrome://extensions</span>, click Details on Tether and turn on “Allow user scripts”. Then <a href="#" id="recheck">check again</a>.`;
    $("recheck").addEventListener("click", async (e) => {
      e.preventDefault();
      await api.runtime.sendMessage({ type: "recheckScripts" });
      load();
    });
  }

  $("scripts").innerHTML = st.allScripts.length
    ? st.allScripts
        .map(
          (s) => `<div class="script">
            <p class="name">${esc(s.name)}</p>
            ${s.description ? `<p class="muted">${esc(s.description)}</p>` : ""}
            <p class="faint">${s.run === "auto" ? "Runs on every visit to" : "Run from the popup on"} ${esc(s.matches.map((m) => (m === "<all_urls>" ? "every site" : m)).join(", "))}</p>
          </div>`
        )
        .join("")
    : `<p class="muted">No scripts yet. Ask your agent to save one, for example “make me a script that fills this form with my usual details”.</p>`;
}

$("conn").addEventListener("submit", async (e) => {
  e.preventDefault();
  await api.runtime.sendMessage({ type: "setSettings", key: $("key").value, port: $("port").value });
  $("saved").textContent = "Saved.";
  setTimeout(() => ($("saved").textContent = ""), 2000);
});

$("trusted").addEventListener("click", async (e) => {
  const on = e.currentTarget.getAttribute("aria-checked") !== "true";
  e.currentTarget.setAttribute("aria-checked", String(on));
  await api.runtime.sendMessage({ type: "setSettings", trusted: on });
});

load();
