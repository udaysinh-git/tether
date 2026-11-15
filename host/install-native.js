// Registers the native messaging bridge (host/native.js) with the browsers.
// Firefox and its forks (Zen, LibreWolf, Floorp, Waterfox) read the Mozilla
// location. Chromium browsers need the extension's id, given with --chrome-id.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HOME } from "./config.js";

const NAME = "tether";
const FIREFOX_ID = "tether@udaysinh.me";
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

export function installNative({ chromeIds = [] } = {}) {
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

  if (chromeIds.length) {
    const crManifest = path.join(dir, "tether.chromium.json");
    fs.writeFileSync(crManifest, JSON.stringify({ ...base, allowed_origins: chromeIds.map((id) => `chrome-extension://${id}/`) }, null, 2));
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
    done.push("Chrome, Brave, Edge, Chromium");
  }

  console.log(`Registered the Tether bridge for: ${done.join("; ")}.`);
  console.log(`Launcher: ${launcher}`);
  console.log("Reload the Tether extension in your browser to connect.");
}

function regSet(key, value) {
  execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], { stdio: "ignore" });
}
