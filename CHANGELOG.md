# Changelog

## 0.4.1 (2026-11-21)

- Tether is on the Chrome Web Store and Firefox Add-ons. `tether setup`, `tether doctor` and the hint agents get when no browser is connected now link to both stores.
- The README opens with store buttons and status badges.
- `scripts/sign-firefox.ps1 -Channel listed` submits a version to the public Firefox listing.
- Firefox gets this version from Firefox Add-ons only; Mozilla allows one build per version number, so there is no separate signed file this time.

## 0.4.0 (2026-11-20)

- Read-only sharing. **Read only** next to Share this tab lets agents read a page (outline, text, screenshots, network, console) while every click, keystroke, navigation and script is refused. Tabs it opens inherit it, and the popup switches a shared tab either way.
- Tether asks before risky actions. A click on a button that buys, pays, sends, posts, deletes or confirms, or Enter in such a form, waits for **Allow** in the page's status panel, the popup or the side panel. Only a real click answers, so pages can't approve for you. A declined action fails with a note telling the agent not to retry.
- Each site can ask before risky actions (the default), before every action, or never. A switch in settings turns the default off.
- A side panel (Chrome side panel, Firefox sidebar) lists shared tabs with Pause, Resume and Stop, puts questions waiting for you first, and logs what agents did and what you answered.
- Questions survive agents' tool time limits: one call waits up to 45 seconds, the question stays up for five minutes, and the agent's next identical call gets your answer.
- `list_tabs` marks read-only tabs, and the `click` and `type` descriptions explain the Allow step.

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
