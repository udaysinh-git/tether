// Registers the native messaging bridge (host/native.js) with the browsers.
// Firefox and its forks (Zen, LibreWolf, Floorp, Waterfox) read the Mozilla
// location. Chromium browsers only let named extensions use a bridge: the
// Chrome Web Store build is always named, and --chrome-id adds others (an
// unpacked build has its own id). With the bridge a browser needs no pairing key.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOME } from "./config.js";

const NAME = "tether";
const FIREFOX_ID = "tether@udaysinh.me";
export const CHROME_STORE_ID = "bdkhlojbkkldeehiolelnmnpaanjdncc";
const NATIVE_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), "native.js");

const CHROMIUM_REG = {
  Chrome: "Software\\Google\\Chrome\\NativeMessagingHosts",
  Brave: "Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
  Edge: "Software\\Microsoft\\Edge\\NativeMessagingHosts",
  Chromium: "Software\\Chromium\\NativeMessagingHosts",
};

const CHROMIUM_DIRS = {
  darwin: {
    Chrome: "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    Brave: "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    Edge: "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
    Chromium: "Library/Application Support/Chromium/NativeMessagingHosts",
  },
  linux: {
    Chrome: ".config/google-chrome/NativeMessagingHosts",
    Brave: ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    Edge: ".config/microsoft-edge/NativeMessagingHosts",
    Chromium: ".config/chromium/NativeMessagingHosts",
  },
};

const FIREFOX_DIRS = {
  darwin: ["Library/Application Support/Mozilla/NativeMessagingHosts"],
  linux: [".mozilla/native-messaging-hosts", ".librewolf/native-messaging-hosts", ".zen/native-messaging-hosts"],
};

export function installNative({ chromeIds = [], quiet = false } = {}) {
  const dir = path.join(HOME, "native");
  fs.mkdirSync(dir, { recursive: true });
  const win = process.platform === "win32";

  // The browser runs this launcher, which runs the bridge with this Node.
  const launcher = path.join(dir, win ? "tether-native.cmd" : "tether-native.sh");
  if (win) fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${NATIVE_JS}" %*\r\n`);
  else {
    fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${NATIVE_JS}" "$@"\n`);
    fs.chmodSync(launcher, 0o755);
  }

  const base = { name: NAME, description: "Tether bridge between the browser extension and the local Tether host", path: launcher, type: "stdio" };
  const ffManifest = path.join(dir, "tether.firefox.json");
  fs.writeFileSync(ffManifest, JSON.stringify({ ...base, allowed_extensions: [FIREFOX_ID] }, null, 2));
  const done = [];

  if (win) {
    regSet(`HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${NAME}`, ffManifest);
    done.push("Firefox and forks (Zen, LibreWolf, Floorp, Waterfox)");
  } else {
    for (const d of FIREFOX_DIRS[process.platform] || []) {
      const target = path.join(os.homedir(), d);
      fs.mkdirSync(target, { recursive: true });
      fs.copyFileSync(ffManifest, path.join(target, `${NAME}.json`));
    }
    done.push("Firefox and forks");
  }

  {
    const crManifest = path.join(dir, "tether.chromium.json");
    // Ids added on an earlier run stay, so setup doesn't undo --chrome-id.
    let before = [];
    try { before = JSON.parse(fs.readFileSync(crManifest, "utf8")).allowed_origins.map((o) => o.replace(/^chrome-extension:\/\/|\/$/g, "")); } catch {}
    const ids = [...new Set([CHROME_STORE_ID, ...before, ...chromeIds])].filter((id) => /^[a-p]{32}$/.test(id));
    fs.writeFileSync(crManifest, JSON.stringify({ ...base, allowed_origins: ids.map((id) => `chrome-extension://${id}/`) }, null, 2));
    for (const [browser, key] of Object.entries(CHROMIUM_REG)) {
      if (win) regSet(`HKCU\\${key}\\${NAME}`, crManifest);
      else {
        const d = CHROMIUM_DIRS[process.platform]?.[browser];
        if (!d) continue;
        const target = path.join(os.homedir(), d);
        fs.mkdirSync(target, { recursive: true });
        fs.copyFileSync(crManifest, path.join(target, `${NAME}.json`));
      }
    }
    done.push(`Chrome, Brave, Edge, Chromium${ids.length > 1 ? ` (store build and ${ids.length - 1} other id${ids.length === 2 ? "" : "s"})` : ""}`);
  }

  const lines = [`Registered for: ${done.join("; ")}.`, `Launcher: ${launcher}`];
  if (!quiet) for (const l of [...lines, "Reload the Tether extension in your browser to connect."]) console.log(l);
  return lines;
}

function regSet(key, value) {
  execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], { stdio: "ignore" });
}
