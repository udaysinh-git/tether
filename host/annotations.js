// MCP tool annotations. Hosts read these to decide which calls need a
// confirmation, and directories reject tools that leave any hint out, so every
// tool declares all four explicitly. tools.js refuses to register a tool that
// has no entry here.
//
//   readOnlyHint     the tool changes nothing (in the browser, on disk or on a site)
//   destructiveHint  it can delete something or trigger an action on a site that
//                    can't be undone (a click or key press may submit, buy, send)
//   idempotentHint   calling it again with the same arguments changes nothing more
//   openWorldHint    it reaches live web pages or the network, not only Tether's
//                    own local state

const read = (title, openWorld = false) => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: openWorld });
const write = (title, { destructive = false, idempotent = false, openWorld = false } = {}) => ({ title, readOnlyHint: false, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: openWorld });

export const ANNOTATIONS = {
  // tabs and sessions
  list_tabs: read("List shared tabs"),
  open_tab: write("Open a tab", { openWorld: true }),
  close_tab: write("Close a tab", { destructive: true, idempotent: true }),
  navigate: write("Navigate a tab", { openWorld: true }),
  start_session: write("Start a browser session", { openWorld: true }),
  end_session: write("End a browser session", { destructive: true, idempotent: true }),
  request_bypass: write("Ask for access to all tabs", { idempotent: true }),
  wait_for_user: write("Hand the tab to the user"),

  // reading pages
  snapshot: read("Read page outline", true),
  read_text: read("Read page text", true),
  wait_for: read("Wait for text", true),
  screenshot: read("Take a screenshot", true),

  // acting on pages: clicks, keys and scripts can submit forms or trigger site actions
  click: write("Click an element", { destructive: true, openWorld: true }),
  hover: write("Hover an element", { idempotent: true, openWorld: true }),
  type: write("Type text", { destructive: true, openWorld: true }),
  fill_form: write("Fill form fields", { idempotent: true, openWorld: true }),
  select_option: write("Choose a select option", { idempotent: true, openWorld: true }),
  press_key: write("Press a key", { destructive: true, openWorld: true }),
  scroll: write("Scroll the page", { openWorld: true }),
  run_js: write("Run JavaScript in the page", { destructive: true, openWorld: true }),
  upload_file: write("Attach files to an input", { idempotent: true, openWorld: true }),

  // devtools (the log tools can clear their buffer, so they aren't read-only)
  network_requests: write("List network requests", { idempotent: true }),
  network_request: read("Show a network request"),
  console_messages: write("Read console messages", { idempotent: true }),
  cookies: read("List cookies"),

  // media and downloads
  list_media: read("List media on the page", true),
  save_media: write("Save media to disk", { openWorld: true }),
  video_frame: read("Capture a video frame", true),
  wait_for_download: read("Wait for a download", true),
  download_file: write("Download a file", { openWorld: true }),
  list_downloads: read("List downloads"),

  // watchers
  save_watcher: write("Save a page watcher", { idempotent: true, openWorld: true }),
  list_watchers: read("List watchers"),
  run_watcher: write("Run a watcher now", { openWorld: true }),
  delete_watcher: write("Delete a watcher", { destructive: true, idempotent: true }),

  // userscripts
  list_scripts: read("List userscripts"),
  save_script: write("Save a userscript", { idempotent: true }),
  get_script: read("Read a userscript"),
  run_script: write("Run a userscript", { destructive: true, openWorld: true }),
  install_userscript: write("Install a userscript or style", { idempotent: true, openWorld: true }),
  delete_script: write("Delete a userscript", { destructive: true, idempotent: true }),

  // styles
  apply_css: write("Preview CSS", { idempotent: true, openWorld: true }),
  clear_preview: write("Remove the CSS preview", { idempotent: true, openWorld: true }),
  save_style: write("Save a site style", { idempotent: true }),
  list_styles: read("List site styles"),
  get_style: read("Read a site style"),
  delete_style: write("Delete a site style", { destructive: true, idempotent: true }),

  // change requests from the popup
  get_requests: read("Read change requests"),
  resolve_request: write("Resolve a change request", { idempotent: true }),

  // recorded site knowledge
  site_list: read("List recorded sites"),
  site_map: read("Summarise a recorded site"),
  site_sessions: read("Read recorded sessions"),
  site_notes: write("Read or write site notes", { idempotent: true }),
};

export function annotationsFor(name) {
  const a = ANNOTATIONS[name];
  if (!a) throw new Error(`Tool ${name} has no annotations in host/annotations.js`);
  const { title, ...hints } = a;
  return { title, ...hints };
}
