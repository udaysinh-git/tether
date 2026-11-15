import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const HOME = process.env.TETHER_HOME || path.join(os.homedir(), ".tether");
export const SCRIPTS_DIR = path.join(HOME, "scripts");
export const STYLES_DIR = path.join(HOME, "styles");
export const SITES_DIR = path.join(HOME, "sites");
export const REQUESTS_DIR = path.join(HOME, "requests");
const CONFIG_FILE = path.join(HOME, "config.json");

const DEFAULTS = { port: 47821 };

// Pairing key: readable groups so it is easy to paste into the extension.
function newKey() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 4 === 3 && i < 15) out += "-";
  }
  return out;
}

export function loadConfig() {
  for (const d of [SCRIPTS_DIR, STYLES_DIR, SITES_DIR, REQUESTS_DIR]) fs.mkdirSync(d, { recursive: true });
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {}
  let changed = false;
  if (!cfg.port) { cfg.port = DEFAULTS.port; changed = true; }
  if (!cfg.key) { cfg.key = newKey(); changed = true; }
  if (process.env.TETHER_PORT) cfg.port = Number(process.env.TETHER_PORT);
  if (changed) saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  let onDisk = {};
  try { onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch {}
  // TETHER_PORT is a per-run override; don't persist it.
  const out = { ...onDisk, ...cfg };
  if (process.env.TETHER_PORT && onDisk.port) out.port = onDisk.port;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2));
}

// Optional settings: ntfyTopic, ntfyServer, gistAccount.
export function setSetting(name, value) {
  const cfg = loadConfig();
  if (value === "" || value == null) delete cfg[name];
  else cfg[name] = value;
  let onDisk = {};
  try { onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch {}
  if (value === "" || value == null) delete onDisk[name];
  else onDisk[name] = value;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(onDisk, null, 2));
  return cfg;
}

export function rotateKey() {
  const cfg = loadConfig();
  cfg.key = newKey();
  saveConfig(cfg);
  return cfg;
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
