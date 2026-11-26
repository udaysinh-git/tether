// Native messaging bridge. The browser starts this process (connectNative)
// and talks to it over stdin/stdout; it relays every message to the host's
// WebSocket. Firefox can't open ws://127.0.0.1 from an MV3 extension (it
// upgrades it to wss://), so this is how Firefox and its forks connect.
// It also starts the host if it isn't running and fills in the pairing key.
import WebSocket from "ws";
import { loadConfig } from "./config.js";
import { ensureDaemon } from "./shim.js";
import { parts } from "./bridge-parts.js";

const cfg = loadConfig();

// Chrome passes the caller's origin; Firefox passes the manifest path and the add-on id.
const args = process.argv.slice(2);
const origin = args.find((a) => a.startsWith("chrome-extension://"))?.replace(/\/$/, "") || `moz-extension://${args.find((a) => /@|^\{/.test(a)) || "tether"}`;

function frame(body) {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([head, body]));
}

function write(obj) {
  for (const body of parts(Buffer.from(JSON.stringify(obj)))) frame(body);
}

let ws = null;
const queue = [];

async function open() {
  if (!(await ensureDaemon(cfg))) {
    write({ type: "bridge", error: "The Tether host could not start. Run `node host/cli.js serve` to see why." });
    process.exit(1);
  }
  ws = new WebSocket(`ws://127.0.0.1:${cfg.port}/ext`, { origin, maxPayload: 64 * 1024 * 1024 });
  ws.on("open", () => {
    write({ type: "bridge", open: true });
    for (const m of queue.splice(0)) send(m);
  });
  ws.on("message", (data) => {
    try { write(JSON.parse(String(data))); } catch {}
  });
  ws.on("close", (code) => {
    write({ type: "bridge", closed: code });
    process.exit(0);
  });
  ws.on("error", () => {});
}

function send(msg) {
  // The bridge knows the key, so the extension doesn't need to be paired by hand.
  if (msg.type === "hello" && !msg.key) msg.key = cfg.key;
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
  else queue.push(msg);
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const body = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    try { send(JSON.parse(body.toString("utf8"))); } catch {}
  }
});
process.stdin.on("end", () => process.exit(0));

open();
