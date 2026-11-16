// Builds dist/chrome and dist/firefox from extension/ with a manifest for each.
import fs from "node:fs";
import path from "node:path";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const icons = { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };

const base = {
  manifest_version: 3,
  name: "Tether",
  version: pkg.version,
  description: "Let Claude Code, Codex and any MCP agent use the browser tabs you share, signed in as you. Local, with a cursor you can pause.",
  homepage_url: "https://tether.udaysinh.me",
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
    permissions: ["offscreen", "tabs", "activeTab", "scripting", "storage", "unlimitedStorage", "debugger", "webRequest", "webNavigation", "cookies", "userScripts", "alarms", "downloads", "notifications"],
  },
  firefox: {
    ...base,
    background: { scripts: ["sounds.js", "background.js"] },
    permissions: ["tabs", "activeTab", "scripting", "storage", "unlimitedStorage", "webRequest", "webRequestBlocking", "webNavigation", "cookies", "alarms", "nativeMessaging", "downloads", "notifications"],
    optional_permissions: ["userScripts"],
    // Firefox's MV3 default adds upgrade-insecure-requests, which turns the
    // ws://127.0.0.1 connection to the host into wss:// and breaks it.
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
    browser_specific_settings: {
      gecko: { id: "tether@udaysinh.me", strict_min_version: "142.0", data_collection_permissions: { required: ["none"] } },
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
