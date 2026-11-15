// stdio <-> HTTP bridge. Agents launch `tether` as a stdio MCP server; this
// starts the shared host if it isn't running and forwards every message to it,
// so Claude Code, Codex and others all reach the same browsers.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig, HOME } from "./config.js";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.js");

export async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export async function ensureDaemon(cfg) {
  if (await health(cfg.port)) return true;
  const logFile = fs.openSync(path.join(HOME, "host.log"), "a");
  const child = spawn(process.execPath, [CLI, "serve"], { detached: true, stdio: ["ignore", logFile, logFile], windowsHide: true });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await health(cfg.port)) return true;
  }
  return false;
}

export async function runShim() {
  const cfg = loadConfig();
  const endpoint = `http://127.0.0.1:${cfg.port}/mcp`;
  let sessionId = null;
  let protocolVersion = null;
  let initMsg = null;
  let initDone;
  const initialized = new Promise((r) => (initDone = r));

  const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  const fail = (msg, text) => {
    if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: text } });
  };

  async function post(msg) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${cfg.key}` };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
    return fetch(endpoint, { method: "POST", headers, body: JSON.stringify(msg) });
  }

  async function forward(msg, retried = false) {
    let res;
    try {
      res = await post(msg);
    } catch {
      // Host went away (closed, crashed, idled out). Start it and reopen the session.
      if (!retried && (await ensureDaemon(cfg)) && (await reinit())) return forward(msg, true);
      return fail(msg, "Tether host is not reachable.");
    }
    if (res.status === 404 && sessionId && !retried) {
      if (await reinit()) return forward(msg, true);
    }
    if (res.status === 202) return;
    const type = res.headers.get("content-type") || "";
    const body = await res.text();
    if (!res.ok) return fail(msg, `Tether host error ${res.status}: ${body.slice(0, 200)}`);
    if (type.includes("text/event-stream")) {
      for (const line of body.split(/\r?\n/)) if (line.startsWith("data:")) out(JSON.parse(line.slice(5)));
    } else if (body.trim()) {
      const data = JSON.parse(body);
      for (const m of Array.isArray(data) ? data : [data]) out(m);
    }
    return res;
  }

  async function reinit() {
    if (!initMsg) return false;
    sessionId = null;
    try {
      const r = await post(initMsg);
      if (!r.ok) return false;
      sessionId = r.headers.get("mcp-session-id");
      await r.text();
      await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      return true;
    } catch {
      return false;
    }
  }

  await ensureDaemon(cfg);

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method === "initialize") {
      initMsg = msg;
      try {
        const res = await post(msg);
        sessionId = res.headers.get("mcp-session-id");
        const data = JSON.parse(await res.text());
        protocolVersion = data?.result?.protocolVersion || null;
        out(data);
      } catch (e) {
        fail(msg, "Could not start the Tether host. Run `tether serve` to see why.");
      }
      initDone();
      return;
    }
    await initialized;
    forward(msg).catch((e) => fail(msg, String(e?.message || e)));
  });

  const bye = async () => {
    if (sessionId) {
      try {
        await fetch(endpoint, { method: "DELETE", headers: { "mcp-session-id": sessionId, authorization: `Bearer ${cfg.key}` }, signal: AbortSignal.timeout(1000) });
      } catch {}
    }
    process.exit(0);
  };
  rl.on("close", bye);
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
