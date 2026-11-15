#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, rotateKey, HOME, SCRIPTS_DIR } from "./config.js";

const [cmd = "stdio", ...rest] = process.argv.slice(2);
const CLI = fileURLToPath(import.meta.url);

const HELP = `tether: hand browser tabs to your coding agent

  tether               Run as a stdio MCP server (what agents launch)
  tether serve         Run the host in the foreground with logs
  tether key           Print the pairing key for the extension
  tether key --new     Make a new key (paste it into the extension again)
  tether status        Show connected browsers, agents and shared tabs
  tether setup         Print the lines that add Tether to Claude Code and Codex
`;

switch (cmd) {
  case "stdio": {
    const { runShim } = await import("./shim.js");
    await runShim();
    break;
  }
  case "serve": {
    const { serve } = await import("./daemon.js");
    try {
      await serve();
    } catch (e) {
      if (e.code === "EADDRINUSE") {
        console.error(`Port ${loadConfig().port} is in use. Tether may already be running (try "tether status").`);
        process.exit(1);
      }
      throw e;
    }
    break;
  }
  case "key": {
    const cfg = rest.includes("--new") ? rotateKey() : loadConfig();
    console.log(cfg.key);
    if (rest.includes("--new")) console.error("New key saved. Restart the host (it restarts on its own the next time an agent connects after it idles out) and paste the key into the extension.");
    break;
  }
  case "status": {
    const { health } = await import("./shim.js");
    const cfg = loadConfig();
    const h = await health(cfg.port);
    if (!h) {
      console.log(`Host not running (port ${cfg.port}). It starts when an agent launches tether.`);
      break;
    }
    console.log(`Host running on 127.0.0.1:${cfg.port}`);
    console.log(`Browsers: ${h.browsers.join(", ") || "none"}`);
    console.log(`Agents:   ${h.agents.join(", ") || "none"}`);
    console.log(`Tabs:     ${h.tabs}`);
    console.log(`Config:   ${HOME}`);
    console.log(`Scripts:  ${SCRIPTS_DIR}`);
    break;
  }
  case "setup": {
    const node = process.execPath;
    const q = (s) => (s.includes(" ") ? `"${s}"` : s);
    console.log("Claude Code:");
    console.log(`  claude mcp add --scope user tether -- ${q(node)} ${q(CLI)}\n`);
    console.log("Codex (~/.codex/config.toml):");
    console.log(`  [mcp_servers.tether]\n  command = ${JSON.stringify(node)}\n  args = [${JSON.stringify(CLI)}]\n`);
    console.log("Any other MCP client: run this as a stdio server:");
    console.log(`  ${q(node)} ${q(CLI)}\n`);
    console.log(`Pairing key for the extension: ${loadConfig().key}`);
    break;
  }
  default:
    console.log(HELP);
}
