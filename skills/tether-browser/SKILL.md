---
name: tether-browser
description: Use the user's own browser (their real logins, cookies and extensions) through the Tether MCP tools instead of Playwright, Puppeteer or a headless browser. Use it whenever a task means opening a website, reading a page, clicking, filling or submitting a form, logging in, checking an account, downloading or uploading through a site, testing or debugging a web app in a real browser, reading a site's network calls or console, restyling a site, or writing a userscript or user style for it. Also use it when the user says "my browser", "this tab", "the page I'm on", "Tether", or asks for something only possible while signed in. Covers starting a session (own window or the user's current tab), the snapshot-and-ref loop, devtools, styles and scripts, recorded site knowledge, and the consent rules.
---

# Using the user's browser with Tether

Tether connects you to the browser the user is already using, through a small extension. You get their real sessions: logged-in accounts, saved cookies, their extensions, their region. That is why you use it instead of Playwright. A fresh automated browser starts signed out, trips bot checks and can't see what the user sees.

The tools come from the `tether` MCP server (in Claude Code they are named `mcp__tether__<tool>`). If they aren't available, Tether isn't set up for this agent: tell the user to run `node host/cli.js setup` in the tether repo and add the printed line to their agent, then stop. Don't fall back to Playwright silently.

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
2. Act by ref: `click`, `type`, `fill_form` (several fields in one call, checkboxes take true/false, selects take the option label), `select_option`, `press_key`, `hover`, `scroll`, `upload_file`.
3. Every action returns a fresh snapshot. Read it to confirm the result before the next step. Don't call `snapshot` again right after an action.
4. Refs belong to the snapshot they came from. After navigation or a big page change, use the refs in the newest snapshot. "Element e14 is gone" means take a new one.

More tools:
- `wait_for` text to appear or disappear after something slow (search results, a save, a toast). Prefer it to fixed waits.
- `read_text` for long content: articles, tables, results. It's cheaper than reading a big outline.
- `screenshot` when layout or visuals matter, or the outline isn't enough (canvas apps, charts, image-heavy pages). Don't screenshot after every step.
- `run_js` to read data the outline doesn't show or call the page's own APIs. The value of the last expression comes back. Prefer the normal tools for clicking and typing so the user sees what happens.
- `navigate` (url, back, forward, reload), `open_tab`, `close_tab`.

Cross-origin iframes (payment forms, embedded Google Forms, widgets) are part of the outline. Their refs look like `[f12.e5]` and work in every tool.

Clicks and keys arrive as real input in Chromium browsers, so sites treat them like the user's own. Firefox gets ordinary DOM events, which a few strict sites ignore. If a click seems to do nothing there, try `press_key` Enter on the element, or tell the user.

## When the user has to act

- A CAPTCHA, a login, a 2FA or OTP code, a payment confirmation, or any choice that is theirs: call `wait_for_user` with a one-sentence `message`. The tab comes to the front with your message and a Done button, and the call returns when they press it (default wait 5 minutes). Then continue from the snapshot it returns.
- If an action fails with "The user paused this tab", they pressed Pause to do something themselves. Call `wait_for_user` without a message to wait for Resume. Don't retry the action in a loop.

## Files, media and downloads

- After clicking something that downloads (an invoice, a CSV export, a PDF), call `wait_for_download` right away. It returns the file's path on disk. `download_file` fetches a URL on a shared site with the user's cookies.
- `list_media` lists images, video, audio, canvases, background images and the HLS/DASH streams the page loaded, each with an id like `m3`. `save_media` saves one to `~/.tether/media/<site>/`. Streams need the video to have started playing so they appear in the list; a video whose source is a MediaSource `blob:` has no file, so save its stream entry instead.
- `video_frame` returns the frame a video is showing.

## Watching a page for the user

When the user wants to hear about something later ("tell me when the price drops", "when results come out", "if this slot opens"), save a watcher instead of polling yourself:
1. Find the cheapest source. Check `network_requests` for a JSON API behind the page; if there is one, use `mode: "fetch"` on that URL and read `response.json` in `check`. Otherwise use `mode: "tab"` with DOM code.
2. `check` is a function body. Return the value to track (they're notified when it changes), or `{ notify: price < 2000, message: "Now " + price, value: price }` for a threshold.
3. `save_watcher` with a sensible `every_minutes` (30 by default; don't go under 5 for normal sites), then `run_watcher` once to show the user the current value.
4. Use `notify: ["browser", "ntfy"]` when they want it on their phone. The ntfy topic is set in Tether's settings.

## Debugging a site or web app

- `console_messages` (filter `level: "error"`) for errors and logs.
- `network_requests` to list calls (filter by URL text, `type: "xhr"`, or `failedOnly`), then `network_request` with an id for headers and both bodies.
- `cookies` for the current page's cookies, including httpOnly.

Logs start when the tab is shared. To catch a page load, share or open the tab first, then `navigate` with `action: "reload"`.

## Learning a site before you work on it

The user can record how they use a site. Before automating or restyling a site, call `site_list`, and if the site is there, `site_map`. It summarises the pages, the buttons and links the user actually uses (with CSS selectors), the fields they fill, the APIs behind them and the usual paths. `site_map` with `page: "/path"` gives one page in detail, and `site_sessions` replays a recording step by step. When you work out something useful about a site, save it with `site_notes` (`append: true`) for next time.

## Changing how a site looks or works

The user can send requests from the Tether popup ("Request a change") with text and images: screenshots, mockups, sketches. They can also **Pick** an element on the page and attach a note; then the request carries that element's selector, text, HTML and outline, a cropped screenshot of it and one of the page. When they say they sent something, or ask you to check Tether, call `get_requests`. The tab they sent it from is shared with you.

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
| That tab is not shared | The user stopped it, or it was never shared. Ask, or `start_session` |
| …security policy blocks run_js | Firefox: reload the tab once and retry. Chromium: the user turned off real input in Tether settings |
| … timed out | The page is slow or stuck. `screenshot` to see why |
| The user paused this tab | `wait_for_user` without a message |
| Anything about setup | Ask the user to run `node host/cli.js doctor` in the tether folder |
