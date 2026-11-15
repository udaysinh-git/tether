import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const HOME = process.env.TETHER_HOME || path.join(os.homedir(), ".tether");
export const SCRIPTS_DIR = path.join(HOME, "scripts");
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
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
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
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ port: cfg.port, key: cfg.key }, null, 2));
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
