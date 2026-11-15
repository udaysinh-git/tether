// Builds dist/chrome and dist/firefox from extension/ with a manifest for each.
import fs from "node:fs";
import path from "node:path";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const icons = { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };

const base = {
  manifest_version: 3,
  name: "Tether",
  version: pkg.version,
  description: "Share a tab with Claude Code, Codex or any MCP agent. Nothing is shared until you click.",
  icons,
  action: { default_popup: "popup/popup.html", default_title: "Tether", default_icon: icons },
  options_ui: { page: "options/options.html", open_in_tab: true },
  host_permissions: ["<all_urls>"],
};

const targets = {
  chrome: {
    ...base,
    minimum_chrome_version: "120",
    background: { service_worker: "background.js" },
    permissions: ["tabs", "activeTab", "scripting", "storage", "unlimitedStorage", "debugger", "webRequest", "webNavigation", "cookies", "userScripts", "alarms"],
  },
  firefox: {
    ...base,
    background: { scripts: ["background.js"] },
    permissions: ["tabs", "activeTab", "scripting", "storage", "unlimitedStorage", "webRequest", "webRequestBlocking", "webNavigation", "cookies", "alarms"],
    optional_permissions: ["userScripts"],
    browser_specific_settings: {
      gecko: { id: "tether@udaysinh.me", strict_min_version: "128.0", data_collection_permissions: { required: ["none"] } },
    },
  },
};

for (const [name, manifest] of Object.entries(targets)) {
  const out = path.join("dist", name);
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync("extension", out, { recursive: true });
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`built ${out}`);
}
