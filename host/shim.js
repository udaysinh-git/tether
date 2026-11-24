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

// tools: "all" gives the agent every tool up front; anything else is the
// default, where the less common groups load on demand.
export async function runShim({ tools = "" } = {}) {
  const cfg = loadConfig();
  let groups = []; // tool groups this agent has loaded, restored after a host restart
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
    if (tools === "all") headers["x-tether-tools"] = "all";
    if (groups.length) headers["x-tether-groups"] = groups.join(",");
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
    const msgs = [];
    if (type.includes("text/event-stream")) {
      for (const line of body.split(/\r?\n/)) if (line.startsWith("data:")) msgs.push(JSON.parse(line.slice(5)));
    } else if (body.trim()) {
      const data = JSON.parse(body);
      msgs.push(...(Array.isArray(data) ? data : [data]));
    }
    for (const m of msgs) {
      out(m);
      // The host marks a result when the call changed which tools exist (a
      // group was loaded). It has no stream to this client to say so itself,
      // so the notification is sent from here.
      const meta = m?.result?._meta;
      if (meta?.["tether/toolsChanged"]) {
        if (Array.isArray(meta["tether/groups"])) groups = meta["tether/groups"].filter((g) => g !== "core");
        listChanged();
      }
    }
    return res;
  }

  const listChanged = () => out({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });

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
