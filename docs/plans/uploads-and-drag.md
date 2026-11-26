# Plan: uploads, file drops and drag and drop

Status: built and released as 0.6.0 on 2026-11-27. Where the build differs from the plan below:

- An element that is neither a file input, a text box, a button nor a drop area is not clicked as a last try; clicking something not meant to be clicked could toggle or open anything. `via: "picker"` forces it.
- The outline gives drop areas (`drop area "Drag files here"`) and `draggable="true"` items a ref, and either end of `drag` can be visible text instead of a ref (a column heading, "Delete").
- A drag clears the page's text selection first: pressing on selected text starts a text drag instead of the element's.
- The detail about path forms moved from the tool description into the skill and the parameter text, to keep the starting tool list under 45% of the full one.
- No `find_files` tool: `upload_file` without `ref` lists matches.
- Tests: `test/uploads.mjs` (three modes), `test/drag.mjs` (two modes), upload checks in `test/firefox.mjs`, unit checks for bridge parts, path handling and the drafted upload step.

## Goal

Wherever a page takes a file, an agent that knows which file to use puts it there by itself. No file dialog opens and the user does not pick anything.

- Bypass mode on: the upload happens with no question.
- Bypass mode off: the agent prepares everything (finds the file, finds the control), then the user presses Allow once on the page and the file goes in. A site can be set to allow uploads from then on.

The same work adds real drag and drop for moving things on a page.

## Where Tether is today

`upload_file` (host/tools.js:279) reads each path, base64s it and calls `upload` in the content script (extension/content.js:840). That function refuses anything that is not an `<input type=file>`, then sets `input.files` from a `DataTransfer` and fires `input` and `change`. What falls through:

1. The site's "Upload" button creates a hidden or detached input and calls `input.click()` or `showPicker()`. The input is not in the outline, so the agent clicks the button, the OS file dialog opens and the agent hands over to the user. This is the common case.
2. Drop zones with no input. They listen for `dragover` and `drop` and read `event.dataTransfer.files`.
3. Paste targets (chat boxes that take an image from the clipboard).
4. Moving elements. `cdpDrag` (extension/background.js:1898) sends 10 mouse moves 12 ms apart, which never starts an HTML5 drag (`draggable=true`) and is too fast for libraries that wait before starting a drag.
5. The agent has to know the exact absolute path. A wrong path gives a bare ENOENT.

And one bug in what exists: `host/native.js` `write()` sends each message whole, and a browser drops any native message from the host over 1 MB. Since 0.5.0 Firefox and keyless Chrome both connect through that bridge, so an upload over roughly 750 KB fails there today.

## What the tests showed

Probes are in `C:\tmp\tether-research` (`probe.mjs` drives the built extension in Playwright Chromium, `probe-firefox.mjs` runs the page-side code in Firefox 161).

| Route | Chromium, debugger on | Chromium, debugger off | Firefox |
| --- | --- | --- | --- |
| Catch the file dialog (`Page.setInterceptFileChooserDialog`) | works, also for inputs never added to the page and for `showPicker()` | n/a | n/a |
| Fill the caught input by path (`DOM.setFileInputFiles`) | works only with "Allow access to file URLs" on; otherwise `Not allowed` | n/a | n/a |
| Fill the caught input with bytes (`DOM.resolveNode` + `Runtime.callFunctionOn`) | works with no extra setting | n/a | n/a |
| Trusted file drop (`Input.dispatchDragEvent` with files) | works only with file access on; otherwise `Not allowed` | n/a | n/a |
| Page-world hook on `input.click()` / `showPicker()` | works | works | works |
| Synthetic drop with a `DataTransfer` | works | works | works |
| Telling a drop zone from a plain element (does it cancel `dragover`?) | works | works | works |
| Synthetic paste | works | works | works, but the constructor ignores `clipboardData`; the file has to be added to the event's own `clipboardData` |

What follows from that:

- Every route has a version that works for a store install with default settings, in both browsers. The agent can always upload without the dialog.
- "Allow access to file URLs" is off for store installs and is a switch on Tether's Details page, not a manifest permission. With it on, Chromium reads the file from disk itself: no size limit and the page sees trusted events. It is an upgrade for large files and for the few sites that check `isTrusted`, never a requirement. Tether checks it with `chrome.extension.isAllowedFileSchemeAccess()`.
- With the path route the `change` and `drop` events are trusted; with bytes they are not. Most sites do not check.
- Others have hit the same `Not allowed` error from `DOM.setFileInputFiles` in extensions (UI.Vision, Claude in Chrome), so the bytes route has to be the default and not the fallback.

## Design

### 1. Getting at the file

The host runs as the user, so it can read what the user can. What is missing is help finding the file.

- `paths` accepts absolute paths, `~`, environment variables (`%USERPROFILE%`, `$HOME`), globs (`~/Downloads/invoice-*.pdf`) and a folder (every file in it, for multi-file inputs and `webkitdirectory`). Relative paths are refused with a hint, because the host is one shared process and has no idea of the agent's working folder.
- `paths` also accepts `download:<id>` for a download Tether tracked (the background's `downloads` map already holds each file's full path), so "download this, upload it there" needs no path.
- `upload_file` with `paths` and no `ref` uploads nothing and lists what matched: path, size, modified time, newest first. That is the search for agents with no shell of their own, without adding a tool.
- A path that does not exist returns help in the error: similar names in the same folder, then matches for the file name in Desktop, Downloads, Documents and Pictures.
- Always refused: `~/.ssh`, `~/.tether`, browser profile folders, and files named like key stores (`id_rsa`, `*.pem`, `.env`).

### 2. One `upload_file` for every kind of target

`ref` may be a file input, the button the user would click, a drop area or a text box. Auto picks the delivery by what the element is:

1. A file input; an element with one inside it; a `<label>` for one; or an element with an invisible file input lying over it (a common trick, found with `elementsFromPoint` at its centre): set the files directly.
2. Something clickable (button, link, menu item): arm the picker catch, click it, fill the picker when it opens. If the click opens a menu instead ("From computer / From Drive"), the returned outline shows it and the agent calls `upload_file` again on the menu item.
3. A text box or contenteditable: paste the files.
4. Anything else: send `dragenter` and `dragover`. If the page cancels `dragover` it is a drop zone, so drop the files.
5. If none of that took, the error says what was tried and lists the page's file inputs and elements whose text reads like a drop area.

Optional `via: "input" | "picker" | "drop" | "paste"` forces one route. The note says what happened: "Filled the file picker that 'Attach' opened with report.pdf", "Dropped 2 files on 'Drag files here'".

### 3. Catch the file picker instead of letting it open

Chromium, debugger attached, element in the top frame or a same-site frame:

- `Page.setInterceptFileChooserDialog({ enabled: true })`, click the ref with `cdpMouse`, wait up to 2 s for `Page.fileChooserOpened` (a new case in the `debugger.onEvent` listener at background.js:1496), fill the input it names, then turn the intercept off in a `finally` so the user's own clicks keep getting the normal dialog.
- Fill by path with `DOM.setFileInputFiles` when file access is on. Otherwise `DOM.resolveNode` on the `backendNodeId` and `Runtime.callFunctionOn` to build the `File` objects in the page and fire `input` and `change`; the bytes go in as pieces of a few MB so no single debugger message is huge.
- `mode: "selectSingle"` takes the first file and the note says the rest were left out.

Everywhere else (Firefox, debugger off, and frames from another site, whose debugger events the tab session never receives):

- A page-world hook injected with `scripting.executeScript({ world: "MAIN", frameIds })`, the way `consoleHook` already is (background.js:1389). It wraps `HTMLInputElement.prototype.click` and `showPicker` for the length of the call; a call on a file input gets our files plus `input` and `change` instead of a dialog. The originals go back when the call ends or after 2 s.
- `window.showOpenFilePicker` (Chromium only) returns handles whose `getFile()` gives our files. Handles that need write access are out of scope.

### 4. Drop and paste

- Drop, Chromium with file access on: `Input.dispatchDragEvent` (`dragEnter`, `dragOver`, `drop`) with the paths. Trusted, read from disk.
- Drop, everywhere else: one `DataTransfer` with the files, then `dragenter`, `dragover`, `drop`, `dragleave` at the element's centre.
- Paste: focus the element and fire `paste`. Chromium takes `clipboardData` in the constructor; for Firefox, create the event first and add the files to `event.clipboardData`. The user's real clipboard is never touched.

### 5. Fix the 1 MB bridge limit

- `host/native.js` `write()`: a body over 600 KB goes out as `{ type: "bridge", part: { id, i, n, data } }` messages, each a base64 slice.
- `NativeSocket` in background.js collects the parts by `id`, joins them and calls `onmessage` as if one message had arrived. Nothing above the socket changes.
- Bytes route cap goes from 25 MB to 50 MB. The path route has no cap.

### 6. Who is asked, and when

Today `gate()` only asks about an upload when the site is set to "ask for every action", and bypass mode does not change what is asked. New rule for `upload` in `gate()`:

1. `state.bypass` is on: no question.
2. The site is set to "never ask", or the user chose "Always allow uploads here" before: no question.
3. Otherwise one card on the page: "Claude wants to attach payslip-oct.pdf (212 KB) to mail.google.com", with Allow, Deny and "Always allow uploads here".

By the time the card shows, the host has already found and checked the files, so Allow is the only thing left for the user. The question comes before the click that opens the picker, which keeps the existing behaviour where a repeated identical call picks up an answer given late.

Considered and left out: attach the file first and hold the site's upload request until Allow (`Fetch.enable` in Chromium, blocking `webRequest` in Firefox). It cannot hold uploads sent over WebSocket, pages time out while a request is held, chunked uploads announce the file name before the first held request, and on Deny the page is left half way through. One Allow before attaching costs the user the same single click.

A separate `siteUploads` map in storage holds "always allow" per site, so the `siteAsk` values the popup already shows stay as they are.

### 7. New `drag` tool for moving things

`drag({ from: ref, to: ref, position?: "before" | "after" | "inside" })` in core. `click_at` keeps the coordinate form for canvas pages.

- Chromium: `Input.setInterceptDrags({ enabled: true })`, press on `from`, move 8 to 10 px. If the page starts an HTML5 drag, `Input.dragIntercepted` gives the drag data; replay it over `to` with `Input.dispatchDragEvent` and release. No files are involved, so this needs no file access. If no HTML5 drag starts it is a pointer library, so continue with mouse moves.
- Timing for pointer libraries (dnd-kit, react-beautiful-dnd, SortableJS): after the first few pixels wait 150 ms, then 15 to 20 steps a frame apart, rest over the target for 100 ms, release. `cdpDrag` gets this timing too, which also fixes `click_at` drags.
- Fallback: pointer and mouse events along the path plus the HTML5 set (`dragstart`, `drag`, `dragenter`, `dragover`, `drop`, `dragend`) sharing one `DataTransfer`.
- `from` and `to` must be in the same frame in the first version.
- Returns the outline diff. A drop onto something that reads as delete or trash asks first.

## Fit with the rest of Tether

Checked against the code as of 1c30492 (0.5.0).

- Permissions: nothing new in either manifest. `debugger`, `scripting`, `nativeMessaging` and `downloads` are already there, so Chrome shows no new permission prompt on update and the store listings need no new justification. Firefox's minimum version (153) already supports `world: "MAIN"`.
- Read only tabs: `upload` is already in `ACTING`; `drag` joins it, so both are refused on a read only tab.
- Asking: `upload` is already in `ASKABLE`; `drag` joins it. `describeAction` gets the file names and a `drag` line. The confirm card gains a third button, which touches the pill (content.js), the side panel and the popup, all of which render `confirm`.
- Activity feed: add `drag` to `FEED_METHODS` and `FEED_FROM_RESULT`.
- Frames: refs like `f12.e5` keep working. Frames from another site use the page-world hook, because the tab's debugger session gets no events from them.
- Shadow roots: refs already reach into open shadow roots, and the picker catch does not care where the input lives.
- Lazy tools: one new core tool (`drag`), so 23 core tools. It needs an entry in `host/annotations.js` (registration throws without one) and in the core list there; `test/tools.mjs` checks both.
- Flows: `STEP_KINDS` has no upload step. Add `upload` with the path as a flow parameter (`{{file}}`), so a saved "submit my expense" flow can take the receipt. Recordings already log a file input's change with the file names.
- Recording: the fill fires a normal `change`, which the recorder already handles. Passwords and other masking are untouched.
- Version skew: the host learns the extension's version in `hello`. It only sends chunked messages, paths-only uploads and `drag` to 0.6.0 or newer, and otherwise answers the way `click_at` does today: update the extension.
- Client timeouts: one call still waits at most 45 s for an answer. Reading a large file happens before the question, and with the path route the call returns as soon as the files are set; the agent watches the site's own progress with `wait_for`.
- Footprint: the hook lives on the page for at most 2 s per upload and restores the originals. Nothing is left behind.
- Tests: an unpacked extension has file access on by default, so the path route is what the current suites would exercise. A second run with it off works by switching it off, closing the browser and starting the same profile again (switching it while running kills a command-line-loaded extension).
- Docs and release: README tool table, the `tether-browser` skill, CHANGELOG, the site's changelog page and `store/amo-version.json`. Settings and `tether doctor` mention the file access switch as optional, for big files.

## Order of work

1. Bridge chunking. Small, and it fixes uploads that fail today.
2. Host side of `upload_file`: path forms, the list-only call, the not-found help, refusals.
3. Picker catch: debugger route with bytes, then by path when file access is on, then the page-world hook.
4. Drop, paste, the auto order and `via`.
5. The new asking rule, bypass, "Always allow uploads here".
6. Flow `upload` step.
7. `drag` and the `cdpDrag` timing.
8. Docs, skill, annotations, changelog.

Steps 1 to 6 are one release (0.6.0); `drag` can follow.

## Tests

New `test/uploads.mjs`, run in both modes like the other browser suites, with the upload cases repeated in `test/firefox.mjs`:

- Visible input, hidden input, an invisible input over a button, an input created and clicked on demand, a detached input, `showPicker`, `showOpenFilePicker`.
- A button that opens a menu whose item opens the picker.
- A drop zone with no input; a page that cancels `dragover` everywhere but takes no files (auto must not report success); a zone that checks `isTrusted`, with file access on and off.
- Paste into a contenteditable, in both browsers.
- An upload inside a frame from another site.
- A 5 MB file through the native bridge (also in `test/native.mjs`), and a 300 MB file by path with file access on.
- Path forms: `~`, a glob, a folder, `download:<id>`, the list-only call, a wrong name that returns suggestions, a refused path, a relative path.
- Asking: bypass on uploads with no card; bypass off shows the card with the file name; Deny leaves the input empty; "Always allow uploads here" skips the next one; a read only tab refuses.
- After a Tether upload, the user's own click on the same button still opens the real dialog.
- `drag`: an HTML5 sortable list, a board whose library waits 150 ms before a drag starts, a range slider, `position` before and after.
- `test/unit.mjs`: chunk split and join, path expansion. `test/tools.mjs`: `drag` carries a title and hints.
