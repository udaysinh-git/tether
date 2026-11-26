# Changelog

## 0.6.0 (2026-11-27)

- Uploads without a file dialog. `upload_file` takes whatever the user would use: a file input, a button that opens a file dialog (Tether catches the dialog and fills it, also for inputs made on the fly and `showPicker()`), a drop area, or a chat box that takes pasted files. A button that opens a menu first returns the menu, so the agent can pick "From computer". Before, an upload button opened the system dialog and the agent had to hand over to you.
- Paths can use `~`, `%USERPROFILE%` and `$HOME`, a wildcard in the file name, a folder, or `download:<id>` from `list_downloads`. `upload_file` without a ref lists what the paths match, and a wrong path comes back with files of a similar name. Keys, `.env` files, `~/.ssh`, `~/.tether` and browser profiles are refused.
- Every upload asks first, naming the files, their size and the site, unless bypass mode is on or the site is set to never ask. A third button, **Always here**, stops the question on that site; **Ask again** in the popup brings it back. Before, uploads asked only on sites set to ask before every action.
- In Chromium with **Allow access to file URLs** on, the browser reads uploads from disk itself: no size limit, and the page sees real input. Without it, files of up to 50 MB at a time are sent from the host.
- Fixed: messages over 1 MB from the bridge were dropped by the browser, so uploads over about 750 KB failed in Firefox and in keyless Chrome. The bridge now sends big messages in parts.
- `drag` moves one element onto another, with `position` before or after for reordering. It handles HTML5 drag and drop through the debugger in Chromium, and drag libraries that wait for a short hold; either end can be named by its visible text. A drop onto Delete or Trash asks first.
- `click_at` drags move like a hand now: a short hold, then small steps a frame apart, so drag libraries with an activation delay notice them.
- The outline gives drop areas and `draggable="true"` items a ref.
- Flows have an `upload` step, and a recording where the user picked a file drafts one with a `{{file}}` input in place of the click that opened the dialog.

## 0.5.0 (2026-11-24)

- `tether setup` does the setup. It finds Claude Code, Codex, Cursor and OpenCode, adds Tether to each one's MCP config, links the skill and registers the browser bridge. It changes one entry per file, keeps comments and other settings, and prints the snippet for any file it can't edit safely. `tether setup --print` shows the config without writing it, as before.
- Cursor (`~/.cursor/mcp.json`) and OpenCode (`~/.config/opencode/opencode.json`, both config formats) are supported next to Claude Code and Codex, and `tether doctor` checks all four.
- No pairing key in Chrome, Brave and Edge. `tether setup` registers the bridge for the Chrome Web Store build, and the extension connects through it by itself, as Firefox does. If the extension was installed first, opening the popup connects it. This adds the `nativeMessaging` permission to the Chromium build, so Chrome asks people who already have Tether to accept it once when they update. Pasting a key still works.
- Agents start with 22 tools and load the rest when a task needs them. `load_tools` lists five groups (devtools, media, watchers, customize, sites) in one line each and returns a group's tools; clients that don't refresh their tool list reach them through `call_tool`. The starting tool list is 43% the size of the full one. `tether --tools all` or `TETHER_TOOLS=all` lists everything up front.
- Actions return what changed. After a click or a keystroke the agent gets the lines that were added and removed, under the form or dialog they sit in, and its existing refs keep working. A navigation, a short page or a page that mostly changed still returns the whole outline, and `snapshot` always does.
- A change request sent from the popup reaches a working agent on its next tool call, with the tools to handle it loaded.
- Flows. `save_flow` stores a task on a site as steps with `{{inputs}}`, and `run_flow` replays it in one call. `site_sessions` with `as_flow` drafts the steps from a recording. Steps find their element by selector, then by role and name. A risky step still waits for Allow, passwords are never stored (an `ask_user` step hands the tab over), a long or waiting flow returns with the step to continue from, and a flow that can't find an element stops and returns the page. An agent's first outline of a site names its saved flows. Steps reach into open shadow roots and into frames from other sites; `scope` and `frame` on a step say where, and without them the whole page and then its frames are searched.
- `click_at` clicks or drags at a point in the latest screenshot, for canvas apps the outline can't describe. `screenshot` takes `max_side` and reports the image's size.
- Firefox: `network_request` now shows fetch and XHR response bodies. They were never captured, because the build lacked the `webRequestFilterResponse` permission.
- Firefox: console output from the first moments of a page load is captured. The page's first bytes are held (for at most 0.3 s) until the console hook is in, and the hook keeps messages until the content script is listening.
- A new suite drives the Firefox build in a real Firefox (`test/firefox.mjs`, through geckodriver), and `test/native.mjs` connects the shipped Chromium build through the bridge.

## 0.4.1 (2026-11-21)

- Tether is on the Chrome Web Store and Firefox Add-ons. `tether setup`, `tether doctor` and the hint agents get when no browser is connected now link to both stores.
- The README opens with store buttons and status badges.
- `scripts/sign-firefox.ps1 -Channel listed` submits a version to the public Firefox listing.

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
