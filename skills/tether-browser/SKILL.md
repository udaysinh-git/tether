---
name: tether-browser
description: Use the user's own browser (their real logins, cookies and extensions) through the Tether MCP tools instead of Playwright, Puppeteer or a headless browser. Use it whenever a task means opening a website, reading a page, clicking, filling or submitting a form, logging in, checking an account, downloading or uploading through a site, testing or debugging a web app in a real browser, reading a site's network calls or console, restyling a site, or writing a userscript or user style for it. Also use it when the user says "my browser", "this tab", "the page I'm on", "Tether", or asks for something only possible while signed in. Covers starting a session (own window or the user's current tab), the snapshot-and-ref loop, loading the less common tool groups, devtools, styles and scripts, recorded site knowledge, saved flows, and the consent rules.
---

# Using the user's browser with Tether

Tether connects you to the browser the user is already using, through a small extension. You get their real sessions: logged-in accounts, saved cookies, their extensions, their region. That is why you use it instead of Playwright. A fresh automated browser starts signed out, trips bot checks and can't see what the user sees.

The tools come from the `tether` MCP server (in Claude Code they are named `mcp__tether__<tool>`). If they aren't available, Tether isn't set up for this agent: tell the user to run `tether setup` (after `npm install -g tether-browser`) and restart the agent, then stop. Don't fall back to Playwright silently.

## Tools load when you need them

You start with the everyday tools: tabs and sessions, `snapshot`, `read_text`, the actions, `screenshot`, `run_js`, `click_at`. The rest are in groups that stay out of your context until you call `load_tools` with the group's name:

| Group | What it holds |
| --- | --- |
| `devtools` | `network_requests`, `network_request`, `console_messages`, `cookies` |
| `media` | `list_media`, `save_media`, `video_frame`, `wait_for_download`, `download_file`, `list_downloads` |
| `watchers` | `save_watcher`, `list_watchers`, `run_watcher`, `delete_watcher` |
| `customize` | styles (`apply_css`, `save_style`, ...), userscripts (`save_script`, `run_script`, ...), `get_requests`, `resolve_request` |
| `sites` | `site_list`, `site_map`, `site_sessions`, `site_notes`, and flows (`save_flow`, `run_flow`, `list_flows`, `delete_flow`) |

`load_tools` returns each tool's description and arguments, and the tools join your tool list. If your client doesn't show them, call them through `call_tool` with `name` and `arguments`. When a section below uses a tool you don't have, load its group first. Tether also tells you in a tool result when a group is worth loading: when the user sends a change request, or when the site you are on has saved flows.

## When to use something else

Use Playwright or a headless browser only when the user asks for it, when the job has to run unattended in CI or on a server, when you need many parallel isolated browsers, or when it must not touch the user's accounts at all. Everything else that a person would do in their own browser goes through Tether.

## Starting

1. Call `list_tabs`.
   - Tabs listed: work in those. The user already shared them.
   - "No tab is shared yet": go to step 2.
   - "No browser is connected": the user's browser isn't running Tether. Ask them to open it, and say what you were going to do.
2. Call `start_session` with a one-sentence `reason` the user will read.
   - Default `mode: "window"` opens a new window in their browser, signed in as them, and leaves their own tabs alone. Use it for anything you do on your own: research, filling something in, checking an account, testing an app. Pass `url` to open the first page directly.
   - `mode: "current"` asks for the tab the user is looking at. Use it when the task is about "this page" or "what I'm looking at".
   - The user approves in a prompt and has two minutes. If they decline, say so and ask how they'd like to proceed. Don't retry in a loop.
3. Use the tab handle it returns (like `chrome:812`) as `tab` in later calls. With one shared tab you can leave `tab` out.

Tabs you open with `open_tab` and tabs the page opens (links to new tabs, popups) join your session on their own. Everything in your own window is yours.

Only call `request_bypass` (access to every tab) when the task really needs tabs the user already has open, like comparing what's in five of them. Give the reason in one plain sentence.

## The loop

1. `snapshot`: the page as an outline. Every control you can act on has a ref like `[e14]`, with its role, name, value and state.
2. Act by ref: `click`, `type`, `fill_form` (several fields in one call, checkboxes take true/false, selects take the option label), `select_option`, `press_key`, `hover`, `scroll`, `upload_file`, `drag`.
3. Every action returns the page. After a navigation, or when most of it changed, that is the whole outline. Otherwise it is only the lines that changed: `+` lines were added, `-` lines were removed, and the lines above them show which form or dialog they sit in. Read it to confirm the result before the next step. Don't call `snapshot` again right after an action.
4. A ref keeps working for as long as its element is on the page, so refs from an earlier outline are fine on lines that haven't changed. After a navigation, use the refs in the new outline. "Element e14 is gone" means call `snapshot`, which always returns the whole outline.

More tools:
- `wait_for` text to appear or disappear after something slow (search results, a save, a toast). Prefer it to fixed waits.
- `read_text` for long content: articles, tables, results. It's cheaper than reading a big outline.
- `screenshot` when layout or visuals matter, or the outline isn't enough (canvas apps, charts, image-heavy pages). Don't screenshot after every step.
- `click_at` for what the outline can't name: a canvas app (a design tool, a spreadsheet grid, a map, a game), a custom-drawn control, a spot in a chart. Take a `screenshot` with `max_side: 1280` first, then pass `x` and `y` as pixels in that image. `to_x` and `to_y` turn it into a drag. Use `click` with a ref whenever the element is in the outline: refs don't miss.
- `upload_file` puts files from this computer into the page without a file dialog. Point `ref` at what the user would use: the Upload or Attach button, a `drop area` line, a chat box (the files are pasted), or a `file input` line. Don't go looking for a hidden input, and never click an upload button with `click`: that opens a dialog only the user can close. If the button opens a menu ("From computer", "From Drive"), the result shows it; call `upload_file` again on the menu item. `paths` take absolute paths, `~`, `%USERPROFILE%`, a wildcard in the file name (`~/Downloads/invoice-*.pdf`), a folder, or `download:<id>` from `list_downloads`. Call it without `ref` to see which files match, newest first, before uploading. A wrong path returns files with a similar name. Keys, `.env` files, `~/.ssh` and browser profiles are refused.
- `drag` moves one element onto another: a card to a column, an item in a list (`position: "before"` or `"after"` to reorder), a file into a folder. Items with `draggable="true"` have `draggable` lines in the outline. A target with no ref, like a column, can be given by its visible text (`to: "Done"`).
- `run_js` to read data the outline doesn't show or call the page's own APIs. The value of the last expression comes back. Prefer the normal tools for clicking and typing so the user sees what happens.
- `navigate` (url, back, forward, reload), `open_tab`, `close_tab`.

Cross-origin iframes (payment forms, embedded Google Forms, widgets) are part of the outline. Their refs look like `[f12.e5]` and work in every tool.

Clicks and keys arrive as real input in Chromium browsers, so sites treat them like the user's own. Firefox gets ordinary DOM events, which a few strict sites ignore. If a click seems to do nothing there, try `press_key` Enter on the element, or tell the user.

## When the user has to act

- A CAPTCHA, a login, a 2FA or OTP code, a payment confirmation, or any choice that is theirs: call `wait_for_user` with a one-sentence `message`. The tab comes to the front with your message and a Done button, and the call returns when they press it (default wait 5 minutes). Then continue from the snapshot it returns.
- If an action fails with "The user paused this tab", they pressed Pause to do something themselves. Call `wait_for_user` without a message to wait for Resume. Don't retry the action in a loop.
- An upload waits for the user to press Allow on the page, which names the files and the site, unless bypass mode is on or they chose "Always here" for that site before. Find the files and the control first, so the question is the only thing left.
- A click on a button that buys, pays, sends, posts or deletes (or Enter in such a form) waits for the user to press Allow on the page. If the call says they haven't answered yet, repeat the exact same call to keep waiting. If they declined, don't retry; ask in chat. Some sites are set to ask before every action.
- A tab marked "read only" in `list_tabs` can be read but not acted on. If the task needs actions there, ask the user to switch it to full control in the Tether popup.

## Files, media and downloads

These tools are in the `media` group.

- After clicking something that downloads (an invoice, a CSV export, a PDF), call `wait_for_download` right away. It returns the file's path on disk. `download_file` fetches a URL on a shared site with the user's cookies.
- `list_media` lists images, video, audio, canvases, background images and the HLS/DASH streams the page loaded, each with an id like `m3`. `save_media` saves one to `~/.tether/media/<site>/`. Streams need the video to have started playing so they appear in the list; a video whose source is a MediaSource `blob:` has no file, so save its stream entry instead.
- `video_frame` returns the frame a video is showing.

## Watching a page for the user

These tools are in the `watchers` group.

When the user wants to hear about something later ("tell me when the price drops", "when results come out", "if this slot opens"), save a watcher instead of polling yourself:
1. Find the cheapest source. Check `network_requests` for a JSON API behind the page; if there is one, use `mode: "fetch"` on that URL and read `response.json` in `check`. Otherwise use `mode: "tab"` with DOM code.
2. `check` is a function body. Return the value to track (they're notified when it changes), or `{ notify: price < 2000, message: "Now " + price, value: price }` for a threshold.
3. `save_watcher` with a sensible `every_minutes` (30 by default; don't go under 5 for normal sites), then `run_watcher` once to show the user the current value.
4. Use `notify: ["browser", "ntfy"]` when they want it on their phone. The ntfy topic is set in Tether's settings.

## Debugging a site or web app

These tools are in the `devtools` group.

- `console_messages` (filter `level: "error"`) for errors and logs.
- `network_requests` to list calls (filter by URL text, `type: "xhr"`, or `failedOnly`), then `network_request` with an id for headers and both bodies.
- `cookies` for the current page's cookies, including httpOnly.

Logs start when the tab is shared. To catch a page load, share or open the tab first, then `navigate` with `action: "reload"`.

## Learning a site before you work on it

These tools are in the `sites` group.

The user can record how they use a site. Before automating or restyling a site, call `site_list`, and if the site is there, `site_map`. It summarises the pages, the buttons and links the user actually uses (with CSS selectors), the fields they fill, the APIs behind them and the usual paths. `site_map` with `page: "/path"` gives one page in detail, and `site_sessions` replays a recording step by step. When you work out something useful about a site, save it with `site_notes` (`append: true`) for next time.

## Flows: a task in one call

A flow is a task on a site saved as steps: open this URL, type into this field, click that button. Running it is one `run_flow` call, where doing it by hand is a snapshot and a call per step.

- Before a task on a site, check for one. The first outline you get of a site names its saved flows, and `site_map` and `list_flows` list them. If one fits, `run_flow` with its `inputs`.
- After you finish a task the user is likely to ask for again (a weekly export, filing an expense, paying a bill), offer to save it with `save_flow`. Write the steps from what you did: each names its element by `selector` plus `role` and `name`, so it is still found if the selector goes stale. For an element inside an embedded frame from another site (its refs look like `f12.e5`), add `frame` with part of that frame's address; for one inside a shadow root, `scope` lists the host elements' selectors. Both are optional: without them the page is searched, then its frames. Put `{{name}}` wherever a value changes between runs and describe it in `inputs`.
- To build one from what the user did themselves, `site_sessions` with `as_flow: true` turns a recording into draft steps. Drop the steps that aren't part of the task and swap the changing values for placeholders.
- Never put a password, card number or code in a flow. Use an `ask_user` step with a message; the tab is handed to the user at that point.
- Steps run as real clicks and typing. A step that buys, sends or deletes still waits for the user's Allow, and a read-only or paused tab still refuses.
- `run_flow` may return part way: the flow is long, or it is waiting for the user. The result says which `from_step` to call it with next. If a step fails because the site changed, finish from the page it returns, then fix the flow with `save_flow` under the same name.

## Changing how a site looks or works

These tools are in the `customize` group.

The user can send requests from the Tether popup ("Request a change") with text and images: screenshots, mockups, sketches. They can also **Pick** an element on the page and attach a note; then the request carries that element's selector, text, HTML and outline, a cropped screenshot of it and one of the page. A request sent while you are working is added to the result of your next tool call, with its id and first line, and the `customize` tools load by themselves. Read it in full with `get_requests`. Also call `get_requests` when they say they sent something or ask you to check Tether. The tab they sent it from is shared with you.

Restyling:
1. `snapshot` and `screenshot` to see the page as it is. Use `run_js` to read class names or the structure you need to target.
2. Write CSS. Target stable hooks (ids, `data-` attributes, roles, element structure) over generated class names. Use `!important` where the site's own rules win.
3. `apply_css` to preview, `screenshot` to check, and repeat until it matches the request. Look at more than one page of the site if the style covers them.
4. `save_style` with match patterns as narrow as the request (one site, not every site), and pass `tab` so before and after screenshots go into the user's gallery.
5. `resolve_request` with a short reply: what changed, and that they can switch it off in the popup.

For things CSS can't do (moving elements, adding a button, reacting to content that loads late), add a script with `save_script`.

Scripts:
- `code` is the body of a function: plain JavaScript, no imports, full DOM access in the page. Use `return` to hand a value back to `run_script`.
- `run: "manual"` gives the user a Run button in the popup. `run: "auto"` runs on every matching page load, and the user has to allow user scripts once for that.
- GM functions that work: `GM_addStyle`, `GM_getValue`, `GM_setValue`, `GM_deleteValue`, `GM_listValues`, `GM_xmlhttpRequest`, `GM_openInTab`, `GM_setClipboard`, `GM_notification`, `unsafeWindow`.
- Test with `run_script` on a shared tab before telling the user it works.
- To change an existing one, `get_script` or `get_style` returns the editable part. Saving again under the same name replaces it and bumps its version.

Files are standard `.user.js` userscripts and `.user.css` UserCSS, so they also install in Tampermonkey, Violentmonkey and Stylus. `install_userscript` adds one from a URL such as Greasy Fork or userstyles.world.

## Consent and care

- Ask the user before anything that spends money, sends a message or email, posts publicly, deletes data, changes account or security settings, or accepts terms. Show what you're about to submit.
- Stay in the tabs you were given. Don't go looking through the user's accounts beyond the task.
- Don't paste the user's cookies, tokens or personal data into your replies or into other sites unless the task needs it and they asked.
- If a site shows a CAPTCHA or a login wall, or asks for a 2FA code, pause and ask the user to handle it in the window, then continue.
- The user sees a pill on each page you control, with your latest action and a Stop button. If a tab disappears from `list_tabs`, they stopped it. Don't try to get it back without asking.
- When you're done with a window you opened, call `end_session`. To give back a tab the user shared, call `end_session` with that `tab`.

## Common errors

| Message | What to do |
| --- | --- |
| No tab is shared yet | `start_session` |
| No browser is connected | Ask the user to open their browser with Tether paired |
| Several tabs are shared. Pass "tab" | Pass `tab` with a handle from `list_tabs` |
| Element eN is gone | `snapshot` again and use the new refs |
| A tool this skill names isn't in your list | `load_tools` with its group, then `call_tool` if it still isn't listed |
| Take a screenshot of this tab first | `click_at` needs a `screenshot` (with `max_side: 1280`) to take its coordinates from |
| A flow stopped at step N | Finish from the page returned; fix the step with `save_flow` |
| That tab is not shared | The user stopped it, or it was never shared. Ask, or `start_session` |
| …security policy blocks run_js | Firefox: reload the tab once and retry. Chromium: the user turned off real input in Tether settings |
| … timed out | The page is slow or stuck. `screenshot` to see why |
| The user paused this tab | `wait_for_user` without a message |
| The user hasn't answered yet | Repeat the same call to keep waiting for Allow |
| The user declined | Don't retry; ask in chat |
| The user shared this tab read only | Read only; ask them for full control if you need to act |
| The user is still deciding | Repeat the call that asked, or wait for it to return |
| Anything about setup | Ask the user to run `tether doctor`, and `tether setup` for what it reports |
