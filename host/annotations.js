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
  upload_file: write("Upload files from this computer", { openWorld: true }),
  drag: write("Drag an element onto another", { destructive: true, openWorld: true }),
  click_at: write("Click at a point", { destructive: true, openWorld: true }),

  // tools that stay out of the agent's context until it asks for them
  load_tools: read("Load more Tether tools"),
  call_tool: write("Call a loaded Tether tool by name", { destructive: true, openWorld: true }),

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

  // flows: a recorded task saved as steps, replayed in one call
  save_flow: write("Save a flow", { idempotent: true }),
  run_flow: write("Run a saved flow", { destructive: true, openWorld: true }),
  list_flows: read("List saved flows"),
  delete_flow: write("Delete a flow", { destructive: true, idempotent: true }),
};

// Agents start with the core group. The other groups are listed to them in one
// line each (the `about` text) and load when the task needs them, so a session
// that only reads and clicks doesn't carry sixty tool definitions.
export const GROUPS = {
  core: {
    about: "tabs and sessions, reading pages, clicking, typing, screenshots, running JavaScript",
    tools: ["list_tabs", "open_tab", "close_tab", "navigate", "start_session", "end_session", "request_bypass", "wait_for_user", "snapshot", "read_text", "wait_for", "screenshot", "click", "hover", "type", "fill_form", "select_option", "press_key", "scroll", "run_js", "upload_file", "drag", "click_at"],
  },
  devtools: {
    about: "the network log with request and response bodies, console output and errors, cookies",
    tools: ["network_requests", "network_request", "console_messages", "cookies"],
  },
  media: {
    about: "list and save images, video, audio and streams, grab a video frame, wait for and list downloads",
    tools: ["list_media", "save_media", "video_frame", "wait_for_download", "download_file", "list_downloads"],
  },
  watchers: {
    about: "check a page on a schedule and notify the user when something changes",
    tools: ["save_watcher", "list_watchers", "run_watcher", "delete_watcher"],
  },
  customize: {
    about: "restyle a site with saved CSS, save userscripts that run on it, read and resolve change requests the user sends from the Tether popup",
    tools: ["apply_css", "clear_preview", "save_style", "list_styles", "get_style", "delete_style", "list_scripts", "save_script", "get_script", "run_script", "install_userscript", "delete_script", "get_requests", "resolve_request"],
  },
  sites: {
    about: "what Tether recorded about how the user uses a site, notes kept between sessions, and flows that replay a recorded task in one call",
    tools: ["site_list", "site_map", "site_sessions", "site_notes", "save_flow", "run_flow", "list_flows", "delete_flow"],
  },
};

// The two tools that load the rest; on only while some group is still unloaded.
export const LOADERS = ["load_tools", "call_tool"];

const GROUP_OF = new Map();
for (const [g, { tools }] of Object.entries(GROUPS)) for (const t of tools) GROUP_OF.set(t, g);

export function groupOf(name) {
  if (LOADERS.includes(name)) return "loader";
  const g = GROUP_OF.get(name);
  if (!g) throw new Error(`Tool ${name} is in no group in host/annotations.js`);
  return g;
}

export function annotationsFor(name) {
  const a = ANNOTATIONS[name];
  if (!a) throw new Error(`Tool ${name} has no annotations in host/annotations.js`);
  const { title, ...hints } = a;
  return { title, ...hints };
}
