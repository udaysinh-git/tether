#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, rotateKey, HOME, SCRIPTS_DIR } from "./config.js";

// `tether --tools all` is still the stdio server, with an option.
const argv = process.argv.slice(2);
const [cmd, ...rest] = !argv.length || argv[0].startsWith("--") ? ["stdio", ...argv] : argv;
const CLI = fileURLToPath(import.meta.url);
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

const HELP = `tether: hand browser tabs to your coding agent

  tether               Run as a stdio MCP server (what agents launch)
  tether --tools all   The same, with every tool listed up front instead of
                       loading the less common groups when a task needs them
  tether serve         Run the host in the foreground with logs
  tether key           Print the pairing key for the extension
  tether key --new     Make a new key (paste it into the extension again)
  tether status        Show connected browsers, agents and shared tabs
  tether doctor        Check every piece of the setup and say what to fix
  tether setup         Add Tether to Claude Code, Codex, Cursor and OpenCode,
                       link the skill and register the browser bridge
  tether setup --print Show the config for each agent without writing anything
  tether install-native [--chrome-id <id>...]
                       Register the bridge browsers use to reach Tether. Covers
                       Firefox and its forks and the store build for Chrome,
                       Brave and Edge; --chrome-id adds an unpacked build
`;

switch (cmd) {
  case "stdio": {
    const { runShim } = await import("./shim.js");
    await runShim({ tools: flag("--tools") || process.env.TETHER_TOOLS || "" });
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
    const { snippets, setupAgents, linkSkill, tilde } = await import("./setup.js");
    const os = await import("node:os");
    const home = os.homedir();
    const skillDir = path.join(path.dirname(CLI), "..", "skills", "tether-browser");
    const stores = "  Chrome, Brave, Edge: https://chromewebstore.google.com/detail/tether/bdkhlojbkkldeehiolelnmnpaanjdncc\n  Firefox, Zen: https://addons.mozilla.org/firefox/addon/tether/";
    // npx runs from a folder npm clears, so nothing written now would keep working.
    const temporary = /[\\/]_npx[\\/]/.test(CLI);
    if (temporary) {
      console.log("You're running Tether through npx, from a temporary folder that npm can clear.");
      console.log("Install it once so the paths below stay valid:  npm install -g tether-browser\n");
    }
    const indent = (t) => t.replace(/^/gm, "  ");

    if (rest.includes("--print") || temporary) {
      const s = snippets(node, CLI);
      console.log(`Claude Code:\n${indent(s.claude)}\n`);
      console.log(`Codex (~/.codex/config.toml):\n${indent(s.codex)}\n`);
      console.log(`Cursor (~/.cursor/mcp.json, or .cursor/mcp.json in a project):\n${indent(s.cursor)}\n`);
      console.log(`OpenCode (~/.config/opencode/opencode.json):\n${indent(s.opencode)}\n`);
      console.log(`Any other MCP client: run this as a stdio server:\n${indent(s.other)}\n`);
      console.log(`Pairing key, if a browser asks for one: ${loadConfig().key}\n`);
      console.log(`Get the extension:\n${stores}`);
      if (!temporary) console.log("\nNothing was changed. Run `tether setup` without --print to write these for you.");
      break;
    }

    const agents = setupAgents({ home, node, cli: CLI });
    const said = { ok: "already set up", added: "added", updated: "updated to this install" };
    console.log("Agents");
    if (!agents.length) console.log("  None of Claude Code, Codex, Cursor or OpenCode found. For another MCP client, see `tether setup --print`.");
    for (const a of agents) {
      if (a.status === "manual") console.log(`  ${a.name.padEnd(12)} not changed: ${a.why}:\n${a.snippet.replace(/^/gm, "      ")}`);
      else console.log(`  ${a.name.padEnd(12)} ${said[a.status]}${a.where && a.status !== "ok" ? ` (${tilde(home, a.where)})` : ""}`);
    }

    const links = linkSkill({ home, skillDir });
    if (links.length) {
      console.log("\nSkill (tells agents when and how to use Tether)");
      const why = { ok: "already linked", added: "linked", updated: "link updated", own: "has its own copy, left alone", manual: "couldn't link it" };
      for (const l of links) console.log(`  ~/${l.dir.padEnd(16)} ${why[l.status]}${l.status === "manual" && l.why ? ` (${l.why})` : ""}`);
    }

    // --no-bridge: only the agents and the skill, for a machine whose browser
    // side is already set up (or a test that mustn't touch the registry).
    if (!rest.includes("--no-bridge")) {
      console.log("\nBrowser bridge");
      const { installNative } = await import("./install-native.js");
      installNative({ quiet: true }).forEach((l) => console.log(`  ${l}`));
    }

    console.log("\nNext");
    console.log(`  1. Install the extension:\n${indent(stores)}`);
    console.log("  2. It connects by itself. If the Tether popup shows Connect (the extension was there first), press it.");
    console.log(`     Pairing key, if you'd rather paste one: ${loadConfig().key}`);
    if (agents.some((a) => a.status === "added" || a.status === "updated")) console.log("  3. Restart agents that were already running, so they pick Tether up.");
    console.log("\n`tether doctor` checks all of it. `tether setup --print` shows the config without writing it.");
    break;
  }
  case "doctor": {
    const { doctor } = await import("./doctor.js");
    await doctor();
    break;
  }
  case "install-native": {
    const { installNative } = await import("./install-native.js");
    const i = rest.indexOf("--chrome-id");
    installNative({ chromeIds: i >= 0 ? rest.slice(i + 1).filter((x) => !x.startsWith("--")) : [] });
    break;
  }
  default:
    console.log(HELP);
}
