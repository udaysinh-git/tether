# Changelog

## 0.3.6 (2026-11-20)

- Every tool now has a title and sets all four MCP hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so hosts can ask before a click, script or delete and skip the prompt for reads. The table lives in `host/annotations.js`, and a tool without an entry fails to register.
- Tests now call all 53 tools. `test/tools.mjs` checks the annotations and the script, style, watcher and notes tools without a browser; the browser suites gained navigation, tab, key, scroll, select, upload, download and video frame checks.

## 0.3.5 (2026-11-17)

- The MCP server reports its real version to clients instead of 0.2.3.
- Listed in the official MCP registry as `io.github.udaysinh-git/tether`.
- Firefox users can share Chrome Web Store pages; only addons.mozilla.org stays off limits there.
- Agent code runs through the user scripts API instead of eval, so it works on pages with strict security policies.
- A Dockerfile for MCP directories that check the server starts.

## 0.3.0 (2026-11-16)

First public release: npm package `tether-browser`, a new look with spring motion, stacked notifications, interface sounds and a fix for agent windows in browsers that pin tabs, such as Zen.
