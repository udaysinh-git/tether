# Store listings

Everything the Chrome Web Store and Firefox Add-ons (AMO) ask for, ready to paste. Images are in [`images/`](images); regenerate them with `node store/make-images.mjs` after `npm run shots`.

## Basics

| Field | Value |
| --- | --- |
| Name | Tether |
| Short name | Tether |
| Version | from `package.json` |
| Category (Chrome) | Developer Tools |
| Category (AMO) | Web Development |
| Language | English |
| Homepage | https://tether.udaysinh.me |
| Firefox listing | https://addons.mozilla.org/firefox/addon/tether/ |
| Support | https://github.com/udaysinh-git/tether/issues |
| Community | https://discord.gg/UcB8z8u4JP |
| Privacy policy | https://tether.udaysinh.me/privacy/ |
| Source code | https://github.com/udaysinh-git/tether |
| Licence | MIT |
| Contact | through GitHub issues or the Discord |

## Short description

Chrome allows 132 characters; this is 126. The same line is the manifest `description`.

> Let Claude Code, Codex and any MCP agent use the browser tabs you share, signed in as you. Local, with a cursor you can pause.

AMO summary (250 characters max):

> Let Claude Code, Codex, Cursor and any MCP agent use the browser tabs you share, signed in as you. Fill forms, debug with the network log, restyle sites. Runs on your machine, with a visible cursor you can pause.

## Full description

> Tether lets the coding agent you already use work in your own browser, signed in as you, on the tabs you choose.
>
> Agents like Claude Code, Codex, Cursor and Gemini CLI usually get a fresh headless browser with no logins. Tether connects them to the browser you already use instead. Nothing on a tab is visible to an agent until you click Share this tab or approve its request.
>
> What your agent can do in a shared tab
> • Read the page as an outline of headings, text and controls, then click, type, fill forms, choose options and upload files
> • Work inside embedded forms and payment frames
> • Read network requests with their bodies, console errors and cookies, which makes it good at debugging your own web apps while signed in
> • Save images, video and streams, and wait for downloads the site produces
> • Restyle a site or change how it behaves, saved as UserCSS or userscripts that also work in Stylus and Tampermonkey
> • Record how you use a site so later tasks start with that knowledge
> • Watch a page on a schedule and tell you when something changes
>
> You stay in charge
> • Share one tab at a time; tabs a shared page opens come along, your other tabs stay private
> • An agent can ask for its own window in your browser, and you approve it first
> • A gold cursor with the agent's name shows every click before it happens
> • Pause holds every click and keystroke until you resume
> • When the agent reaches a CAPTCHA, a code from your phone or a payment, it hands the tab to you and waits
>
> How it works
> Tether has two parts: this extension and a small local program you install with npm (npm install -g tether-browser). Your agents talk to that program over the Model Context Protocol, and it talks to the extension. Both run on your computer. There is no Tether server and Tether collects no data.
>
> Free and open source under the MIT licence: https://github.com/udaysinh-git/tether
> Setup guide: https://tether.udaysinh.me/guide/

## Single purpose (Chrome)

> Tether lets a coding agent running on the user's own computer read and operate the browser tabs the user chooses to share, so the agent can do browser tasks while signed in as the user.

## Permission justifications (Chrome)

| Permission | Why Tether needs it |
| --- | --- |
| Host access to all sites (`<all_urls>`) | The user decides which site to share, so Tether can't know the sites in advance. Access is only used on tabs the user shared or approved, or on every tab while the user has turned on bypass mode. |
| `debugger` | Delivers clicks and key presses as real input, runs the agent's scripts on pages with strict security policies, and reads network response bodies and console output for shared tabs only. Chrome shows its "started debugging" bar while this is active. |
| `scripting` | Injects the content script that reads the page outline, performs actions and shows the status panel and cursor on shared tabs. |
| `tabs` | Lists and tracks shared tabs, opens tabs and windows the agent asks for after approval, and shows the shared state on each tab. |
| `activeTab` | Shares the tab the user is on when they click Share this tab. |
| `webNavigation` | Notices when a shared page opens a new tab, so that tab is shared too, and follows navigation within shared tabs. |
| `webRequest` | Records the network log of shared tabs for the agent's debugging tools. |
| `cookies` | Lets the agent read the cookies of a shared site when the user asks it to debug a login or session. |
| `storage`, `unlimitedStorage` | Keeps settings, the pairing key, saved styles and scripts, and recordings until they reach the local program. |
| `userScripts` | Runs the userscripts the user saved, on the sites they match. |
| `downloads` | Tells the agent where a file it downloaded on a shared site was saved. |
| `notifications` | Shows watcher alerts the user set up. |
| `alarms` | Reconnects to the local program after the browser suspends the extension, and runs scheduled watchers. |
| `offscreen` | Plays short alert sounds, such as when an agent asks for the user's help, which a service worker cannot do. |
| `nativeMessaging` | Connects the extension to the Tether program the user installed on their own computer, through the native messaging host that `tether setup` registers. It replaces copying a pairing key into the extension, and the extension talks to no other native program. |

Remote code: **No.** All code ships in the package. Scripts the agent runs come from the user's own local program on their machine, at the user's request, and only in tabs the user shared.

## Data usage (Chrome privacy practices)

Tether does not collect or transmit user data to the developer or any third party. Answers for the form:

- Personally identifiable information, health, financial, authentication, personal communications, location, web history, user activity, website content: **not collected**.
- Tether passes the content of tabs the user shares to the local program on the user's own computer (127.0.0.1), which hands it to the AI agent the user runs. That happens on the user's device at the user's request, and the developer receives none of it.
- Certify: data is not sold, not used for purposes unrelated to the single purpose, not used for creditworthiness or lending.

## Firefox (AMO) extras

- Data collection: none (`data_collection_permissions: { required: ["none"] }` in the manifest).
- `nativeMessaging`: Firefox upgrades an extension's connection to `ws://127.0.0.1` to `wss://`, which can't reach a local server, so Tether uses a native messaging bridge to talk to the local program.
- `webRequestBlocking`: lifts a shared page's Content Security Policy on shared tabs only, so the agent's scripts can run where the user asked.
- `webRequestFilterResponse`: reads the response bodies of requests made by shared tabs for the agent's network log, and holds a shared page's first bytes for at most 0.3 s so console output from the start of a page load is captured. Nothing is modified.
- Notes for reviewers: the extension does nothing until it's paired with the local program from the open source repository (`npm install -g tether-browser`, then `tether setup`). Source: https://github.com/udaysinh-git/tether, build with `npm install && npm run build`; the Firefox build is `dist/firefox`.

## Images

| File | Size | Use |
| --- | --- | --- |
| `images/icon-128.png` | 128 x 128 | Store icon |
| `images/screenshot-1.png` to `screenshot-5.png` | 1280 x 800 | Screenshots, in order |
| `images/promo-small.png` | 440 x 280 | Chrome small promo tile |
| `images/promo-marquee.png` | 1400 x 560 | Chrome marquee promo tile |

Screenshot captions:
1. Share a tab with your coding agent
2. Watch every step and pause at any time
3. Agents ask before they get more access
4. Ask for changes to any site
5. Settings, sounds and saved changes
