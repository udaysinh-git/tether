// Long-running host: MCP over Streamable HTTP at /mcp for agents, and a
// WebSocket at /ext for browser extensions. Bound to 127.0.0.1 only.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, safeEqual, setSetting } from "./config.js";
import { Hub } from "./hub.js";
import { registerTools } from "./tools.js";
import { watchAll, remove as removeItem } from "./scripts.js";
import { startWatchers, setWatcherEnabled, runWatcher, getWatcher, deleteWatcher } from "./watchers.js";
import { galleryIndex, shotOf, publishGist, forget } from "./gallery.js";

const VERSION = "0.2.3";
const IDLE_EXIT_MS = 30 * 60 * 1000;

const AGENT_NAMES = { "claude-code": "Claude Code", "codex-mcp-client": "Codex", codex: "Codex", cursor: "Cursor", "gemini-cli": "Gemini CLI" };
const prettyAgent = (n) => AGENT_NAMES[n] || AGENT_NAMES[String(n).toLowerCase()] || n || "Agent";

export async function serve({ quiet = false } = {}) {
  const cfg = loadConfig();
  const log = (...a) => { if (!quiet) console.error("[tether]", ...a); };
  const hub = new Hub(cfg, log);
  const sessions = new Map(); // sessionId -> { transport, server, name }
  const hosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);

  watchAll(() => hub.pushScripts());
  startWatchers(hub, log);

  // Calls from the extension's settings page and popup.
  hub.rpc = {
    setWatcherEnabled: ({ id, on }) => { setWatcherEnabled(id, on); hub.pushWatchers(); return { ok: true }; },
    runWatcher: async ({ id }) => { const r = await runWatcher(hub, getWatcher(id)); hub.pushWatchers(); return r; },
    deleteWatcher: ({ id }) => { deleteWatcher(id); hub.pushWatchers(); return { ok: true }; },
    galleryIndex: () => galleryIndex(),
    galleryImage: ({ kind, id, which }) => ({ dataUrl: shotOf(kind, id, which) }),
    publishGist: ({ kind, id }) => publishGist(kind, id),
    deleteItem: ({ kind, id }) => {
      if (!removeItem(kind, id)) throw new Error(`No ${kind} ${id}`);
      forget(kind, id);
      hub.pushScripts();
      return { ok: true };
    },
    getSettings: () => { const c = loadConfig(); return { ntfyTopic: c.ntfyTopic || "", ntfyServer: c.ntfyServer || "", gistAccount: c.gistAccount || "" }; },
    setSettings: (p) => { for (const k of ["ntfyTopic", "ntfyServer", "gistAccount"]) if (k in p) setSetting(k, String(p[k] || "").trim()); return { ok: true }; },
  };

  const server = http.createServer(async (req, res) => {
    // Refuse anything a web page could send: wrong Host (DNS rebinding) or any Origin.
    if (!hosts.has(req.headers.host) || req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "tether", version: VERSION, browsers: [...hub.browsers.values()].map((b) => (b.version ? `${b.key} v${b.version}` : b.key)), agents: hub.agentNames(), tabs: hub.allTabs().length }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    const auth = req.headers.authorization || "";
    if (!safeEqual(auth.replace(/^Bearer\s+/i, ""), cfg.key)) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Missing or wrong Tether key" }));
      return;
    }

    try {
      const sid = req.headers["mcp-session-id"];
      let entry = sid && sessions.get(sid);

      if (!entry) {
        if (req.method !== "POST" || sid) {
          res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
          return;
        }
        entry = { name: "Agent" };
        const mcp = new McpServer(
          { name: "tether", version: VERSION },
          {
            instructions:
              "Tether gives you the user's real, logged-in browser tabs. Prefer it to a separate automated browser for anything the user would do in their own browser. You can only use tabs the user shared (and tabs those pages open), unless they approve bypass mode. Start with list_tabs; if nothing is shared, call start_session, which opens your own window in their browser after they approve. Then snapshot to read the page and get element refs. Act with click, type, fill_form; each action returns a fresh snapshot. Use network_requests and console_messages to debug. The user can send you change requests (text and images) from the Tether popup: read them with get_requests. To restyle a site, preview with apply_css, check with screenshot, then save_style; use save_script for behaviour. Before working on a site, site_map shows what Tether recorded about how the user uses it. Ask before submitting payments, sending messages or deleting anything. Call end_session when you are done with your window.",
          }
        );
        registerTools(mcp, hub, () => entry.name);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, entry);
            entry.id = id;
          },
          onsessionclosed: (id) => {
            sessions.delete(id);
            hub.setAgent(id, null);
          },
        });
        mcp.server.oninitialized = () => {
          entry.name = prettyAgent(mcp.server.getClientVersion()?.name);
          hub.setAgent(entry.id, entry.name);
          log(`agent connected: ${entry.name}`);
        };
        entry.transport = transport;
        entry.server = mcp;
        await mcp.connect(transport);
        const prevClose = transport.onclose;
        transport.onclose = () => {
          prevClose?.();
          if (entry.id) { sessions.delete(entry.id); hub.setAgent(entry.id, null); }
        };
      }
      entry.seen = Date.now();
      await entry.transport.handleRequest(req, res);
    } catch (err) {
      log("request failed:", err);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  // A TLS hello or other garbage on this plain-HTTP port usually means a
  // client was upgraded to https/wss; say so instead of failing silently.
  server.on("clientError", (err, socket) => {
    if (String(err.code).startsWith("HPE_")) log(`bad request on the port (${err.code}); a client may be using wss/https instead of ws/http`);
    socket.destroy();
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    log(`websocket upgrade ${url.pathname} host=${req.headers.host} origin=${req.headers.origin || "(none)"}`);
    if (url.pathname !== "/ext" || !hosts.has(req.headers.host)) {
      socket.destroy();
      return;
    }
    hub.handleUpgrade(req, socket, head);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, "127.0.0.1", resolve);
  });
  log(`listening on 127.0.0.1:${cfg.port}`);

  // Shims send a DELETE when they exit, but a crashed agent leaves its session
  // behind. Drop sessions idle for an hour, and exit when nothing has used the
  // host for a while so it doesn't linger after the agents are gone.
  let lastUse = Date.now();
  setInterval(() => {
    const now = Date.now();
    for (const [id, e] of sessions) {
      if (now - (e.seen || 0) > 60 * 60 * 1000) { sessions.delete(id); hub.setAgent(id, null); e.transport.close?.(); }
    }
    if (sessions.size || hub.browsers.size) lastUse = now;
    else if (now - lastUse > IDLE_EXIT_MS) { log("idle, exiting"); process.exit(0); }
  }, 60 * 1000).unref();

  return { server, hub, cfg };
}
