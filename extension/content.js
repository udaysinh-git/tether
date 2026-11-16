// Injected only into tabs the user has shared. Builds the page outline the
// agent reads, performs DOM actions, and shows the small "shared" pill.
(() => {
  "use strict";
  if (window.__tetherContent) return;
  // Non-enumerable and only in the isolated world, so pages can't see it.
  Object.defineProperty(window, "__tetherContent", { value: true });

  const api = globalThis.browser ?? globalThis.chrome;
  // Content runs in every frame of a shared tab; only the top frame shows UI.
  const IS_TOP = window === window.top;

  // Cross-origin child frames introduce themselves to this frame, so the
  // outline can say where each one sits and clicks can be offset correctly.
  const frameIds = new WeakMap(); // iframe element -> browser frameId
  window.addEventListener("message", (e) => {
    const id = e.data?.__tetherFrameHello;
    if (id == null) return;
    for (const f of document.querySelectorAll("iframe, frame")) {
      if (f.contentWindow === e.source) { frameIds.set(f, id); break; }
    }
  });

  // ------------------------------------------------------------ refs

  const refs = new Map(); // "e12" -> WeakRef(element)
  const elRef = new WeakMap();
  let nextRef = 1;

  function refFor(el) {
    let r = elRef.get(el);
    if (!r) {
      r = "e" + nextRef++;
      elRef.set(el, r);
    }
    refs.set(r, new WeakRef(el));
    return r;
  }

  function byRef(ref) {
    const el = refs.get(String(ref).replace(/^\[|\]$/g, ""))?.deref();
    if (!el || !el.isConnected) throw new Error(`Element ${ref} is gone. Take a new snapshot.`);
    return el;
  }

  // ------------------------------------------------------------ outline

  const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "switch", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem", "listbox"]);
  const LANDMARKS = { NAV: "nav", MAIN: "main", HEADER: "header", FOOTER: "footer", ASIDE: "aside", FORM: "form", DIALOG: "dialog", TABLE: "table" };
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD", "META", "LINK"]);

  const clip = (s, n = 120) => {
    s = String(s ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
  const q = (s) => JSON.stringify(s);

  function role(el) {
    const r = el.getAttribute("role");
    if (r) return r.split(" ")[0];
    const t = el.tagName;
    if (t === "A") return el.hasAttribute("href") ? "link" : null;
    if (t === "BUTTON" || t === "SUMMARY") return "button";
    if (t === "SELECT") return el.multiple ? "listbox" : "combobox";
    if (t === "TEXTAREA") return "textbox";
    if (t === "INPUT") {
      const ty = (el.type || "text").toLowerCase();
      if (ty === "hidden") return null;
      if (["button", "submit", "reset", "image"].includes(ty)) return "button";
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      if (ty === "range") return "slider";
      if (ty === "number") return "spinbutton";
      if (ty === "search") return "searchbox";
      if (ty === "file") return "file";
      return "textbox";
    }
    if (el.isContentEditable && (el.getAttribute("contenteditable") ?? "") !== "false" && !el.parentElement?.isContentEditable) return "textbox";
    if (/^H[1-6]$/.test(t)) return "heading";
    return null;
  }

  function nameOf(el) {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.innerText || "").join(" ");
      if (t.trim()) return clip(t);
    }
    const aria = el.getAttribute("aria-label");
    if (aria) return clip(aria);
    if (el.labels?.length) {
      const t = [...el.labels].map((l) => l.innerText).join(" ");
      if (t.trim()) return clip(t);
    }
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) return clip(el.value);
    const ph = el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt");
    if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return clip(ph || el.name || el.id || "");
    const txt = el.innerText;
    if (txt && txt.trim()) return clip(txt);
    const img = el.querySelector?.("img[alt], svg[aria-label], [title]");
    return clip(ph || img?.getAttribute("alt") || img?.getAttribute("aria-label") || img?.getAttribute("title") || "");
  }

  function visible(el, style) {
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function describe(el, r) {
    const ref = refFor(el);
    let line = `${r === "file" ? "file input" : r} ${q(nameOf(el))} [${ref}]`;
    const t = el.tagName;
    if (r === "link") {
      const href = el.getAttribute("href") || "";
      if (href && !href.startsWith("javascript:")) line += ` -> ${clip(href, 100)}`;
    }
    if (t === "INPUT" || t === "TEXTAREA") {
      const ty = (el.type || "").toLowerCase();
      if (ty === "checkbox" || ty === "radio") line += el.checked ? " checked" : "";
      else if (ty === "password") line += el.value ? " value=(hidden, filled)" : " value=(empty)";
      else if (ty !== "file" && !["button", "submit", "reset"].includes(ty)) line += ` value=${q(clip(el.value, 200))}`;
      if (ty && !["text", "textarea", "checkbox", "radio", "password", "button", "submit"].includes(ty)) line += ` type=${ty}`;
    } else if (t === "SELECT") {
      const sel = [...el.selectedOptions].map((o) => clip(o.text, 60));
      const opts = [...el.options].slice(0, 12).map((o) => clip(o.text, 40));
      line += ` selected=${q(sel.join(", "))} options: ${opts.join(" | ")}${el.options.length > 12 ? ` (+${el.options.length - 12} more)` : ""}`;
    } else if (r === "textbox") {
      line += ` value=${q(clip(el.innerText, 200))}`;
    }
    const aria = (a) => el.getAttribute(a);
    if (aria("aria-checked") === "true" && !/checked/.test(line)) line += " checked";
    if (aria("aria-selected") === "true") line += " selected";
    if (aria("aria-expanded") === "true") line += " expanded";
    if (aria("aria-expanded") === "false") line += " collapsed";
    if (el.disabled || aria("aria-disabled") === "true") line += " disabled";
    if (el.required || aria("aria-required") === "true") line += " required";
    if (el.getAttribute("aria-invalid") === "true") line += " invalid";
    return line;
  }

  function snapshot({ maxLines = 400, root } = {}) {
    const lines = [];
    let truncated = false;
    let buf = "";
    let depth = 0;

    const emit = (s) => {
      if (lines.length >= maxLines) { truncated = true; return; }
      lines.push("  ".repeat(depth) + s);
    };
    const flush = () => {
      const t = clip(buf, 300);
      buf = "";
      if (t && t.length > 1) emit(`text: ${t}`);
    };

    function kids(node) {
      if (node.shadowRoot) return node.shadowRoot.childNodes;
      if (node.tagName === "SLOT") {
        const a = node.assignedNodes({ flatten: true });
        return a.length ? a : node.childNodes;
      }
      return node.childNodes;
    }

    function walk(node) {
      if (truncated) return;
      if (node.nodeType === 3) {
        buf += node.nodeValue;
        return;
      }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 11) { for (const c of node.childNodes) walk(c); return; }
      const el = node;
      if (SKIP.has(el.tagName) || el === pillHost) return;
      if (el.getAttribute("aria-hidden") === "true") return;

      const style = getComputedStyle(el);
      const r = role(el);

      // Hidden file inputs still matter: sites hide them behind a styled button.
      if (r === "file") { flush(); emit(describe(el, r) + (visible(el, style) ? "" : " (hidden; use upload_file)")); return; }
      if (!visible(el, style) && style.display !== "contents") {
        if (style.display === "none" || el.tagName === "DETAILS") return;
      }

      const inline = style.display.startsWith("inline") || style.display === "contents";

      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        flush();
        let doc = null;
        try { doc = el.contentDocument; } catch {}
        if (doc?.body) {
          emit(`frame ${q(clip(el.title || el.name || new URL(el.src || "about:blank", location.href).host))}:`);
          depth++; walk(doc.body); flush(); depth--;
        } else if (frameIds.has(el)) {
          // The background splices that frame's own outline in here.
          let host = "";
          try { host = new URL(el.src, location.href).host; } catch {}
          emit(`frame ${q(clip(el.title || el.name || host, 80))}:`);
          emit(`  @@frame:${frameIds.get(el)}@@`);
        } else {
          emit(`frame ${q(clip(el.src, 80))} (cross-origin, not loaded yet)`);
        }
        return;
      }

      if (r === "heading") {
        flush();
        const level = Number(el.getAttribute("aria-level")) || Number(el.tagName[1]) || 2;
        const t = clip(el.innerText, 160);
        if (t) emit(`${"#".repeat(level)} ${t}`);
        // headings can contain links
        if (!el.querySelector("a[href],button,input")) return;
      }

      const interactive =
        (r && INTERACTIVE_ROLES.has(r)) ||
        (r !== "heading" && el.hasAttribute("onclick")) ||
        (!r && style.cursor === "pointer" && el.parentElement && getComputedStyle(el.parentElement).cursor !== "pointer" && el.tabIndex >= 0);

      if (interactive && r !== "heading") {
        if (!visible(el, style)) return;
        if (!inline) flush();
        else if (buf.trim()) flush();
        emit(describe(el, r || "clickable"));
        // Selects, inputs and plain buttons have nothing else worth reading inside.
        if (["SELECT", "INPUT", "TEXTAREA"].includes(el.tagName) || r === "textbox" || !el.querySelector("a[href],button,input,select,textarea,[role=button],[role=link]")) return;
      } else if (el.tagName === "IMG") {
        const alt = el.getAttribute("alt");
        if (alt && alt.trim() && visible(el, style)) { flush(); emit(`img ${q(clip(alt))}`); }
        return;
      }

      const lm = LANDMARKS[el.tagName] || (["navigation", "main", "dialog", "alertdialog", "form", "search", "banner", "contentinfo", "complementary"].includes(el.getAttribute("role")) ? el.getAttribute("role") : null);
      if (lm && r !== "heading") {
        flush();
        const label = el.getAttribute("aria-label") || el.getAttribute("name") || "";
        emit(`${lm}${label ? " " + q(clip(label)) : ""}:`);
        depth++;
        for (const c of kids(el)) walk(c);
        flush();
        depth--;
        return;
      }

      if (r === "heading") return;
      if (!inline) flush();
      for (const c of kids(el)) walk(c);
      if (!inline) flush();
      else buf += " ";
    }

    walk(root || document.body || document.documentElement);
    flush();
    if (root) return { text: lines.join("\n") };

    const head = [`Page: ${document.title}`, `URL: ${location.href}`];
    const sel = window.getSelection()?.toString();
    if (sel) head.push(`Selected text: ${q(clip(sel, 200))}`);
    const sx = Math.round(scrollY), max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    head.push(`Scroll: ${max ? Math.round((sx / max) * 100) + "% down" : "page fits the window"}`);
    if (truncated) lines.push(`… cut at ${maxLines} lines. Use snapshot with a higher maxLines, read_text, or scroll.`);
    return { text: head.join("\n") + "\n\n" + lines.join("\n") };
  }

  // ------------------------------------------------------------ actions

  async function reveal(el) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await moveCursor(el);
    flash(el);
  }

  // ------------------------------------------------------------ agent cursor
  // A visible pointer with the agent's name glides to each element before the
  // agent acts on it, so the user can follow along. Off in settings, and it
  // jumps instead of gliding when the user prefers reduced motion.

  let showPill = true;
  let pillPos = null; // { x, y } top-left, when the user has dragged it
  api.storage.local.get(["showPill", "pillPos"]).then((v) => {
    showPill = v.showPill !== false;
    pillPos = v.pillPos || null;
    placePill();
    renderPill();
  }, () => {});
  api.storage.onChanged.addListener((c) => {
    if (c.showPill) { showPill = c.showPill.newValue !== false; renderPill(); }
    if (c.pillPos) { pillPos = c.pillPos.newValue || null; placePill(); }
  });

  function placePill() {
    if (!pillHost) return;
    if (!pillPos) { pillHost.style.inset = "auto 16px 16px auto"; return; }
    const x = Math.max(4, Math.min(innerWidth - 120, pillPos.x));
    const y = Math.max(4, Math.min(innerHeight - 48, pillPos.y));
    pillHost.style.inset = `${y}px auto auto ${x}px`;
  }

  // Drag the pill anywhere; double-click puts it back in the corner.
  function makeDraggable(pill) {
    let start = null;
    pill.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      const r = pillHost.getBoundingClientRect();
      start = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
      pill.setPointerCapture(e.pointerId);
    });
    pill.addEventListener("pointermove", (e) => {
      if (!start) return;
      start.moved = true;
      pillPos = { x: Math.round(e.clientX - start.dx), y: Math.round(e.clientY - start.dy) };
      placePill();
    });
    const end = () => {
      if (start?.moved && pillPos) api.storage.local.set({ pillPos });
      start = null;
    };
    pill.addEventListener("pointerup", end);
    pill.addEventListener("pointercancel", end);
    pill.addEventListener("dblclick", (e) => {
      if (e.target.closest("button")) return;
      pillPos = null;
      placePill();
      api.storage.local.remove("pillPos");
    });
  }

  let showCursor = true;
  api.storage.local.get("showCursor").then((v) => { showCursor = v.showCursor !== false; }, () => {});
  api.storage.onChanged.addListener((c) => {
    if (c.showCursor) {
      showCursor = c.showCursor.newValue !== false;
      if (!showCursor) pillRoot?.querySelector(".cur")?.classList.remove("on");
    }
  });
  let cur = { x: null, y: null, hideTimer: null };
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  async function moveCursor(el) {
    if (!IS_TOP || !showCursor || !shared) return;
    ensurePill();
    const c = pillRoot?.querySelector(".cur");
    if (!c) return;
    const r = el.getBoundingClientRect();
    // Aim a little left of centre on wide fields, where people actually click.
    const x = Math.round(r.left + Math.min(r.width / 2, r.width > 240 ? 60 : r.width / 2));
    const y = Math.round(r.top + r.height / 2);
    c.querySelector(".name").textContent = agents[0] || "Agent";
    const from = cur.x == null ? { x: Math.min(innerWidth - 40, x + 160), y: Math.min(innerHeight - 40, y + 120) } : cur;
    const dist = Math.hypot(x - from.x, y - from.y);
    const ms = reduceMotion() ? 0 : Math.round(Math.min(650, Math.max(220, dist * 0.55)));
    c.style.transition = "none";
    c.style.transform = `translate(${from.x}px, ${from.y}px)`;
    c.classList.add("on");
    c.getBoundingClientRect();
    c.style.transition = ms ? `transform ${ms}ms cubic-bezier(.22, 1, .36, 1), opacity .2s ease-out` : "opacity .2s ease-out";
    c.style.transform = `translate(${x}px, ${y}px)`;
    cur.x = x;
    cur.y = y;
    clearTimeout(cur.hideTimer);
    cur.hideTimer = setTimeout(() => c.classList.remove("on"), 4000);
    if (ms) await new Promise((res) => setTimeout(res, ms + 40));
  }

  let lastTick = 0;
  function cursorClick() {
    if (!IS_TOP || !showCursor || !pillRoot || cur.x == null) return;
    // A soft tick per click, never more than a few a second.
    if (Date.now() - lastTick > 250) { lastTick = Date.now(); api.runtime.sendMessage({ type: "ring", name: "tick", opts: { volume: 0.55, pitch: 1.5 } }).catch(() => {}); }
    const ring = document.createElement("div");
    ring.className = "ripple";
    ring.style.left = cur.x + "px";
    ring.style.top = cur.y + "px";
    pillRoot.appendChild(ring);
    setTimeout(() => ring.remove(), 600);
    // The pointer recoils as it clicks.
    if (!reduceMotion()) pillRoot.querySelector(".cur .body")?.animate([{ scale: 1 }, { scale: 0.82, offset: 0.22 }, { scale: 1.1, offset: 0.55 }, { scale: 1 }], { duration: 380, easing: "ease-out" });
  }

  function label(el) {
    const r = role(el) || el.tagName.toLowerCase();
    const n = nameOf(el);
    return n ? `${r} “${clip(n, 60)}”` : r;
  }

  // Viewport point for the debugger to click, adjusted for same-origin frames.
  async function locate({ ref, verb }) {
    const el = byRef(ref);
    await reveal(el);
    const r = el.getBoundingClientRect();
    let x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    let win = el.ownerDocument.defaultView;
    while (win && win !== window && win.frameElement) {
      const fr = win.frameElement.getBoundingClientRect();
      x += fr.left;
      y += fr.top;
      win = win.parent;
    }
    const top = document.elementFromPoint(x, y);
    const covered = top && top !== el && !el.contains(top) && !top.contains(el);
    if (verb === "Clicked") cursorClick();
    const note = `${verb} ${label(el)}` + (covered ? ` (note: ${label(top)} was on top of it)` : "");
    setActivity(note);
    return { x, y, note };
  }

  async function focusFor({ ref, append }) {
    const el = byRef(ref);
    await reveal(el);
    cursorClick();
    el.focus();
    let clear = false;
    if ("value" in el && typeof el.select === "function" && el.tagName !== "SELECT") {
      if (append) { try { el.setSelectionRange(el.value.length, el.value.length); } catch {} }
      else if (el.value) { el.select(); clear = true; }
    } else if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      if (append) range.collapse(false);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(range);
      clear = !append && !!el.innerText.trim();
    }
    const note = `Typed into ${label(el)}`;
    setActivity(note);
    return { clear, note };
  }

  function mouse(el, type, extra = {}) {
    const r = el.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, ...extra };
    const E = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    return el.dispatchEvent(new E(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, ...init }));
  }

  async function click({ ref, double }) {
    const el = byRef(ref);
    await reveal(el);
    cursorClick();
    mouse(el, "pointerover"); mouse(el, "mouseover");
    mouse(el, "pointerdown", { buttons: 1 }); mouse(el, "mousedown", { buttons: 1 });
    el.focus?.({ preventScroll: true });
    mouse(el, "pointerup"); mouse(el, "mouseup");
    el.click();
    if (double) { el.click(); mouse(el, "dblclick", { detail: 2 }); }
    const note = `Clicked ${label(el)}`;
    setActivity(note);
    return { note };
  }

  async function hover({ ref }) {
    const el = byRef(ref);
    await reveal(el);
    for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) mouse(el, t);
    const note = `Hovered ${label(el)}`;
    setActivity(note);
    return { note };
  }

  // Sets a value the way frameworks (React, Vue) notice it.
  function setValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function type({ ref, text, append, submit }) {
    const el = byRef(ref);
    await reveal(el);
    cursorClick();
    el.focus();
    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      if (append) range.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.execCommand("insertText", false, text);
    } else if ("value" in el) {
      setValue(el, append ? el.value + text : text);
    } else throw new Error(`${label(el)} is not a text field.`);
    if (submit) pressKey(el, "Enter");
    const note = `Typed into ${label(el)}`;
    setActivity(note);
    return { note };
  }

  function pickOptions(el, values) {
    if (el.tagName !== "SELECT") throw new Error(`${label(el)} is not a native select. Click it to open it, then click the option.`);
    const want = values.map((v) => String(v).toLowerCase().trim());
    let hit = 0;
    for (const o of el.options) {
      const on = want.includes(o.value.toLowerCase()) || want.includes(o.text.toLowerCase().trim());
      if (on) hit++;
      if (el.multiple) o.selected = on;
      else if (on) { setValue(el, o.value); return 1; }
    }
    if (!hit) throw new Error(`No option matching ${values.join(", ")}. Options: ${[...el.options].map((o) => o.text.trim()).join(" | ")}`);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return hit;
  }

  async function select({ ref, values }) {
    const el = byRef(ref);
    await reveal(el);
    cursorClick();
    pickOptions(el, values);
    const note = `Picked ${values.join(", ")} in ${label(el)}`;
    setActivity(note);
    return { note };
  }

  async function fill({ fields }) {
    const done = [];
    for (const { ref, value } of fields) {
      const el = byRef(ref);
      await reveal(el);
      cursorClick();
      const ty = (el.type || "").toLowerCase();
      if (ty === "checkbox" || ty === "radio" || role(el) === "checkbox" || role(el) === "switch") {
        const want = value === true || value === "true" || value === "on" || value === 1;
        const cur = "checked" in el ? el.checked : el.getAttribute("aria-checked") === "true";
        if (cur !== want) el.click();
      } else if (el.tagName === "SELECT") {
        pickOptions(el, [String(value)]);
      } else if (el.isContentEditable) {
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        document.execCommand("insertText", false, String(value));
      } else {
        el.focus();
        setValue(el, String(value));
        el.dispatchEvent(new Event("blur"));
      }
      done.push(label(el));
    }
    const note = `Filled ${done.join(", ")}`;
    setActivity(`Filled ${fields.length} field${fields.length === 1 ? "" : "s"}`);
    return { note };
  }

  function pressKey(target, combo) {
    const parts = combo.split("+");
    const key = parts.pop();
    const mods = { ctrlKey: parts.includes("Control") || parts.includes("Ctrl"), shiftKey: parts.includes("Shift"), altKey: parts.includes("Alt"), metaKey: parts.includes("Meta") || parts.includes("Cmd") };
    const k = key === "Space" ? " " : key;
    const init = { key: k, code: k.length === 1 ? (/\d/.test(k) ? "Digit" + k : "Key" + k.toUpperCase()) : k, bubbles: true, cancelable: true, composed: true, ...mods };
    const ok = target.dispatchEvent(new KeyboardEvent("keydown", init));
    if (k.length === 1) target.dispatchEvent(new KeyboardEvent("keypress", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    if (!ok) return;
    if (k === "Enter" && target.form && target.tagName === "INPUT") target.form.requestSubmit?.();
    else if (k === "Enter" && (target.tagName === "BUTTON" || target.tagName === "A")) target.click();
    else if (k === "Tab") {
      const all = [...document.querySelectorAll("a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])")].filter((e) => !e.disabled && e.offsetParent);
      const i = all.indexOf(document.activeElement);
      all[(i + (mods.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
    }
  }

  async function press({ key, ref }) {
    const el = ref ? byRef(ref) : document.activeElement || document.body;
    if (ref) { await reveal(el); el.focus(); }
    pressKey(el, key);
    setActivity(`Pressed ${key}`);
    return { note: `Pressed ${key}` };
  }

  async function scroll({ ref, dy }) {
    if (ref) {
      const el = byRef(ref);
      await reveal(el);
      return { note: `Scrolled to ${label(el)}` };
    }
    const amount = dy ?? Math.round(innerHeight * 0.85);
    // Pages that scroll an inner container instead of the window.
    const root = document.scrollingElement;
    const before = root.scrollTop;
    window.scrollBy({ top: amount, behavior: "instant" });
    if (root.scrollTop === before) {
      const box = [...document.querySelectorAll("main, [role=main], div")].find((d) => d.scrollHeight > d.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(d).overflowY) && d.clientHeight > innerHeight * 0.4);
      box?.scrollBy({ top: amount, behavior: "instant" });
    }
    setActivity("Scrolled");
    return { note: `Scrolled ${amount > 0 ? "down" : "up"} ${Math.abs(amount)}px` };
  }

  async function waitFor({ text, gone, ms, timeout = 15000 }) {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    if (!text) return { note: `Waited ${ms || 0}ms` };
    const end = Date.now() + timeout;
    const needle = text.toLowerCase();
    while (Date.now() < end) {
      const has = (document.body?.innerText || "").toLowerCase().includes(needle);
      if (has !== !!gone) return { note: gone ? `“${text}” is gone` : `Found “${text}”` };
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out after ${timeout}ms waiting for “${text}” to ${gone ? "disappear" : "appear"}.`);
  }

  async function upload({ ref, files }) {
    const el = byRef(ref);
    if (el.tagName !== "INPUT" || el.type !== "file") throw new Error(`${label(el)} is not a file input. Look for a "file input" line in the snapshot.`);
    const dt = new DataTransfer();
    for (const f of files) {
      const bin = atob(f.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    el.files = dt.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    const note = `Attached ${files.map((f) => f.name).join(", ")}`;
    setActivity(note);
    return { note };
  }

  function readText({ ref, maxChars = 20000 }) {
    const el = ref ? byRef(ref) : document.body;
    let t = (el.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    if (t.length > maxChars) t = t.slice(0, maxChars) + `\n… (${t.length - maxChars} more characters)`;
    return { text: t || "(no visible text)" };
  }

  // ------------------------------------------------------------ pill + highlight

  let pillHost, pillRoot, pillText, pillSub, hl;
  let agents = [];
  let lastActivity = "";

  function ensurePill() {
    if (!IS_TOP || pillHost?.isConnected) return;
    // A pill left by this script's previous copy (the extension was reloaded) goes first.
    for (const old of document.querySelectorAll("[data-tether-pill]")) old.remove();
    pillHost = document.createElement("div");
    pillHost.setAttribute("data-tether-pill", "");
    pillHost.style.cssText = "all:initial;position:fixed;inset:auto 16px 16px auto;z-index:2147483647;";
    pillRoot = pillHost.attachShadow({ mode: "closed" });
    pillRoot.innerHTML = `
      <style>
        :host { all: initial; }
        /* The status panel behaves like Bencho's dynamic island: one spring
           carries its size and corners between states, the words crossfade
           through a small blur, and it nudges when something new happens.
           The shape (.pill) and the content (.in) are separate: while the
           shape springs, the content is already laid out at its final size
           and the shape clips it, so nothing reflows or wraps mid-move. */
        .pill {
          cursor: grab; user-select: none; touch-action: none;
          display: flex; justify-content: flex-end; align-items: flex-start;
          background: #1a1a1a; color: #fffbf0;
          border-radius: 999px;
          box-shadow: 0 0 0 1px rgb(255 251 240 / .08), 0 12px 32px rgb(0 0 0 / .38), 0 2px 6px rgb(0 0 0 / .25);
          font: 400 12.5px/1.35 Inter, system-ui, "Segoe UI Variable Text", "Segoe UI", -apple-system, sans-serif;
          -webkit-font-smoothing: antialiased;
          transform-origin: 100% 100%;
        }
        .in { flex: none; display: flex; align-items: center; gap: 10px; max-width: 360px; padding: 7px 7px 7px 14px; box-sizing: border-box; }
        .dot { position: relative; flex: none; width: 8px; height: 8px; border-radius: 50%; background: #d4af37; }
        .dot::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: inherit; animation: tether-beat 2.2s cubic-bezier(.22, 1, .36, 1) infinite; }
        .dot.rec { background: #e0806b; }
        @keyframes tether-beat { 0% { opacity: .5; scale: 1; } 70%, 100% { opacity: 0; scale: 2.8; } }
        .lines { min-width: 0; }
        .t { font-weight: 600; letter-spacing: -0.005em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .s { color: #a9a6a0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .s:empty { display: none; }
        .pill.ask { border-radius: 22px; }
        .pill.ask .in { max-width: 400px; align-items: flex-start; padding: 12px 10px 12px 16px; }
        .pill.ask .s { white-space: normal; color: #fffbf0; margin-top: 3px; }
        .pill.ask .dot { margin-top: 5px; }
        .pill.ask button.act { background: #d4af37; color: #1a1a1a; font-weight: 600; }
        .pill.ask button.act:hover { background: #e0bf55; }
        button[hidden] { display: none; }
        .pill.off { display: none; }
        .pill:active { cursor: grabbing; }
        .btns { flex: none; display: flex; gap: 6px; margin-left: 2px; }
        button {
          flex: none; padding: 6px 12px; min-width: 52px; white-space: nowrap;
          background: #2d2d2d; color: #fffbf0; border: 0; border-radius: 999px;
          font: inherit; font-weight: 500; cursor: pointer;
          transition: background-color .15s, scale .2s cubic-bezier(.28, 1.4, .36, 1);
        }
        button:hover { background: #363636; }
        button:active { scale: .94; transition-duration: .15s, .09s; }
        button:focus-visible { outline: 2px solid #d4af37; outline-offset: 1px; }
        .hl {
          position: fixed; pointer-events: none; border-radius: 10px;
          box-shadow: 0 0 0 2px #d4af37, 0 0 0 6px rgb(212 175 55 / .18); opacity: 0;
          transition: opacity .6s cubic-bezier(.22, 1, .36, 1);
        }
        .hl.on { opacity: 1; transition: none; }
        .cur { position: fixed; left: 0; top: 0; pointer-events: none; opacity: 0; z-index: 2; will-change: transform; transition: opacity .2s; }
        .cur.on { opacity: 1; }
        .cur .body { transform-origin: 2px 2px; transition: scale .5s cubic-bezier(.28, 1.4, .36, 1); }
        .cur:not(.on) .body { scale: .5; }
        .cur svg { display: block; filter: drop-shadow(0 2px 4px rgb(0 0 0 / .4)); }
        .cur .name {
          position: absolute; left: 12px; top: 17px; padding: 3px 9px; border-radius: 999px;
          background: #d4af37; color: #1a1a1a; white-space: nowrap;
          font: 600 11.5px/1.4 Inter, system-ui, "Segoe UI Variable Text", "Segoe UI", sans-serif;
          box-shadow: 0 4px 12px rgb(0 0 0 / .3);
        }
        .ripple {
          position: fixed; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%;
          background: rgb(212 175 55 / .22); box-shadow: 0 0 0 2px #d4af37; pointer-events: none; z-index: 1;
          animation: tether-ripple .55s cubic-bezier(.22, 1, .36, 1) forwards;
        }
        @keyframes tether-ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
        @media (prefers-reduced-motion: reduce) { .hl, .pill, button, .cur .body { transition: none; } .ripple { animation-duration: .01s; } .dot::after { animation: none; } }
      </style>
      <div class="hl"></div>
      <div class="cur" aria-hidden="true">
        <div class="body">
          <svg width="18" height="22" viewBox="0 0 18 22"><path d="M1.5 1.5 L1.5 17.5 L5.8 13.6 L8.9 20.5 L11.8 19.2 L8.8 12.5 L14.6 12.5 Z" fill="#d4af37" stroke="#1a1a1a" stroke-width="1.4" stroke-linejoin="round"/></svg>
          <span class="name"></span>
        </div>
      </div>
      <div class="pill" role="status">
        <div class="in">
          <span class="dot" aria-hidden="true"></span>
          <div class="lines"><div class="t"></div><div class="s"></div></div>
          <div class="btns">
            <button type="button" class="act" hidden></button>
            <button type="button" class="stop" title="Stop sharing and recording this tab">Stop</button>
          </div>
        </div>
      </div>`;
    pillText = pillRoot.querySelector(".t");
    pillSub = pillRoot.querySelector(".s");
    hl = pillRoot.querySelector(".hl");
    const ring = (name, opts) => api.runtime.sendMessage({ type: "ring", name, opts }).catch(() => {});
    pillRoot.querySelector("button.stop").addEventListener("click", () => { ring("hush"); api.runtime.sendMessage({ type: "stop" }); });
    makeDraggable(pillRoot.querySelector(".pill"));
    pillRoot.querySelector(".pill").title = "Drag to move. Double-click to put it back in the corner.";
    // Pause, Resume, or Done when the agent asked for help.
    pillRoot.querySelector("button.act").addEventListener("click", () => {
      ring(!paused ? "drape" : paused.by === "agent" ? "paid" : "float");
      api.runtime.sendMessage({ type: paused ? "resume" : "pause" });
    });
    (document.body || document.documentElement).appendChild(pillHost);
    placePill();
    renderPill();
  }

  let shared = false;
  let recording = false;
  let paused = null; // { by: "user" | "agent", agent, message }

  const ISLAND = "linear(0, 0.046, 0.137, 0.252, 0.377, 0.501, 0.616, 0.717, 0.804, 0.874, 0.93, 0.976, 1.005, 1.024, 1.035, 1.04, 1.041, 1.04, 1.036, 1.031, 1.026, 1.02, 1.015, 1.011, 1.008, 1.005, 1.003, 1.001, 1, 0.999, 0.999, 0.998, 0.998, 0.998, 0.999, 0.999, 0.999, 0.999, 0.999, 1, 1)";
  const POP = "linear(0, 0.096, 0.292, 0.534, 0.774, 0.977, 1.137, 1.22, 1.248, 1.233, 1.188, 1.13, 1.064, 1.012, 0.973, 0.949, 0.939, 0.941, 0.951, 0.966, 0.981, 0.994, 1.005, 1.012, 1.015, 1.015, 1.013, 1.009, 1.006, 1.002, 0.999, 0.997, 0.996, 0.996, 0.997, 0.998, 0.998, 0.999, 1, 1.001, 1)";
  let pillWords = "";

  function renderPill() {
    if (!pillText) return;
    const act = pillRoot.querySelector("button.act");
    const pill = pillRoot.querySelector(".pill");
    const before = pill.classList.contains("off") || !pill.getClientRects().length ? null : pill.getBoundingClientRect();
    const beforeRadius = getComputedStyle(pill).borderTopLeftRadius;
    const wasAsk = pill.classList.contains("ask");
    pill.classList.toggle("off", !showPill && !(shared && paused?.by === "agent"));
    pill.classList.toggle("ask", !!(paused && paused.by === "agent"));
    act.hidden = !shared;
    if (shared && paused?.by === "agent") {
      pillText.textContent = `${paused.agent || "Your agent"} needs you`;
      pillSub.textContent = paused.message || "Take care of this page, then press Done.";
      act.textContent = "Done";
      act.title = "Hand the tab back to the agent";
    } else if (shared && paused) {
      pillText.textContent = "Paused";
      pillSub.textContent = `${agents.length ? agents.join(" and ") : "The agent"} will wait until you resume`;
      act.textContent = "Resume";
      act.title = "Let the agent continue";
    } else if (shared) {
      pillText.textContent = (agents.length ? `Shared with ${agents.join(" and ")}` : "Shared, waiting for an agent") + (recording ? " · recording" : "");
      pillSub.textContent = lastActivity;
      act.textContent = "Pause";
      act.title = "Hold the agent while you do something here";
    } else {
      pillText.textContent = "Recording this visit";
      pillSub.textContent = "Clicks, typing and page structure, for your agent";
    }
    pillRoot.querySelector(".dot").classList.toggle("rec", recording && !shared);

    const words = `${pillText.textContent}\n${pillSub.textContent}\n${act.textContent}`;
    const changed = words !== pillWords;
    pillWords = words;
    if (reduceMotion() || pill.classList.contains("off")) return;
    if (!before) {
      // Arriving: it grows out of its corner.
      pill.animate([{ opacity: 0, scale: 0.6, filter: "blur(6px)" }, { opacity: 1, scale: 1, filter: "blur(0)" }], { duration: 540, easing: ISLAND });
      return;
    }
    if (!changed) return;
    const after = pill.getBoundingClientRect();
    const inner = pill.querySelector(".in");
    const lines = pill.querySelector(".lines");
    if (Math.abs(after.width - before.width) > 1 || Math.abs(after.height - before.height) > 1 || wasAsk !== pill.classList.contains("ask")) {
      // The content holds its final layout; the shape springs around it.
      const afterRadius = getComputedStyle(pill).borderTopLeftRadius;
      inner.style.width = `${after.width}px`;
      inner.style.height = `${after.height}px`;
      const run = pill.animate(
        [
          { width: `${before.width}px`, height: `${before.height}px`, borderRadius: beforeRadius, overflow: "hidden" },
          { width: `${after.width}px`, height: `${after.height}px`, borderRadius: afterRadius, overflow: "hidden" },
        ],
        { duration: 540, easing: ISLAND }
      );
      inner.animate([{ opacity: 0, filter: "blur(6px)" }, { opacity: 1, filter: "blur(0)" }], { duration: 300, delay: 40, easing: "ease-out", fill: "backwards" });
      run.finished.then(() => { inner.style.width = ""; inner.style.height = ""; }, () => {});
    } else {
      // Same size, new words: they rise in and the island gives a small nudge.
      lines.animate([{ opacity: 0, transform: "translateY(5px)", filter: "blur(4px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], { duration: 320, easing: "cubic-bezier(.22, 1, .36, 1)" });
      pill.animate([{ scale: 1 }, { scale: 1.035 }, { scale: 1 }], { duration: 420, easing: POP });
    }
  }

  function setActivity(text) {
    lastActivity = text;
    renderPill();
  }

  function flash(el) {
    if (!IS_TOP) return;
    ensurePill();
    const r = el.getBoundingClientRect();
    Object.assign(hl.style, { left: r.left - 3 + "px", top: r.top - 3 + "px", width: r.width + 6 + "px", height: r.height + 6 + "px" });
    hl.classList.add("on");
    requestAnimationFrame(() => requestAnimationFrame(() => hl.classList.remove("on")));
  }

  function updatePill() {
    if (shared || recording) {
      ensurePill();
      renderPill();
    } else {
      pillHost?.remove();
      pillHost = null;
      pillText = null;
    }
  }

  // ------------------------------------------------------------ recorder
  // Records what the user does (not video): clicks, typing, choices, submits,
  // shortcut keys, and the page outline when it changes. Sensitive fields are
  // masked. Events go to the background, which files them per site.

  const rec = { values: true, queue: [], flushTimer: null, obs: null, mut: 0, snapTimer: null, lastHash: "" };
  const SENSITIVE = /pass|card|cvv|cvc|csc|otp|\bpin\b|ssn|secret|token|iban|account.?num|security.?code/i;

  function isSensitive(el) {
    const ty = (el.type || "").toLowerCase();
    if (ty === "password") return true;
    if (/cc-|one-time-code|password/.test(el.getAttribute?.("autocomplete") || "")) return true;
    const hay = [el.name, el.id, el.getAttribute?.("aria-label"), el.getAttribute?.("placeholder"), el.labels?.[0]?.innerText].filter(Boolean).join(" ");
    return SENSITIVE.test(hay);
  }

  function uniqueIn(root, sel) {
    try { return root.querySelectorAll(sel).length === 1; } catch { return false; }
  }

  const stableId = (id) => id && id.length < 60 && !/\d{3,}|^[a-f0-9-]{10,}$|:|^ember|^react|^radix|^headlessui|^mui-/i.test(id);
  const attrSel = (tag, a, v) => `${tag}[${a}="${v.replace(/["\\]/g, "\\$&")}"]`;

  function selectorFor(el) {
    const root = el.getRootNode().querySelectorAll ? el.getRootNode() : document;
    const tag = el.tagName.toLowerCase();
    if (stableId(el.id) && uniqueIn(root, "#" + CSS.escape(el.id))) return "#" + CSS.escape(el.id);
    for (const a of ["data-testid", "data-test", "data-qa", "data-cy", "name", "aria-label", "title", "placeholder", "href"]) {
      const v = el.getAttribute(a);
      if (v && v.length < 100 && !v.startsWith("javascript:")) {
        const s = attrSel(tag, a, v);
        if (uniqueIn(root, s)) return s;
      }
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      if (cur !== el && stableId(cur.id)) { parts.unshift("#" + CSS.escape(cur.id)); break; }
      let part = cur.tagName.toLowerCase();
      const sibs = cur.parentElement ? [...cur.parentElement.children].filter((c) => c.tagName === cur.tagName) : [];
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      parts.unshift(part);
      if (uniqueIn(root, parts.join(" > "))) break;
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function contextOf(el) {
    const box = el.closest("form,dialog,[role=dialog],fieldset,section,article,nav,aside,header,footer,li,tr,[role=row],[role=listitem],[role=menu]");
    if (!box) return "";
    const label = box.getAttribute("aria-label") || box.querySelector("h1,h2,h3,h4,legend,[role=heading]")?.innerText || (box.tagName === "TR" ? box.cells?.[0]?.innerText : "");
    return clip(label || "", 60);
  }

  function describeTarget(el) {
    const r = el.getBoundingClientRect();
    // A form's text is all of its fields; name it by its label or heading instead.
    const name = el.tagName === "FORM" ? el.getAttribute("aria-label") || el.getAttribute("name") || el.querySelector("h1,h2,h3,legend")?.innerText || contextOf(el) || el.id || "" : nameOf(el);
    const d = { role: role(el) || el.getAttribute("role") || el.tagName.toLowerCase(), name: clip(name, 80), tag: el.tagName.toLowerCase(), selector: selectorFor(el) };
    const href = el.getAttribute("href");
    if (href && !href.startsWith("javascript:")) d.href = clip(href, 200);
    const ctx = contextOf(el);
    if (ctx) d.context = ctx;
    d.rect = [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)];
    return d;
  }

  const ACTIONABLE = "a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[onclick],[contenteditable=''],[contenteditable=true]";

  function fromPill(e) {
    return pillHost && e.composedPath().includes(pillHost);
  }

  function push(ev) {
    if (!recording) return;
    rec.queue.push({ ...ev, t: Date.now(), url: location.href });
    clearTimeout(rec.flushTimer);
    rec.flushTimer = setTimeout(flushRec, rec.queue.length > 50 ? 0 : 800);
  }

  function flushRec() {
    if (!rec.queue.length) return;
    const events = rec.queue.splice(0);
    try { api.runtime.sendMessage({ type: "rec", events }).catch?.(() => {}); } catch {}
  }

  function onClick(e) {
    if (fromPill(e) || !e.isTrusted) return;
    const t = e.composedPath()[0];
    const el = (t.nodeType === 1 ? t : t.parentElement)?.closest(ACTIONABLE) || (t.nodeType === 1 ? t : t.parentElement);
    if (!el) return;
    if (el.tagName === "INPUT" && /^(checkbox|radio|text|email|search|password|number|tel|url)$/.test(el.type)) return; // change covers these
    push({ kind: "click", target: describeTarget(el) });
    expectChange();
  }

  function onChange(e) {
    if (fromPill(e)) return;
    const el = e.composedPath()[0];
    if (!el || el.nodeType !== 1) return;
    const ty = (el.type || "").toLowerCase();
    if (ty === "checkbox" || ty === "radio") return push({ kind: "toggle", target: describeTarget(el), value: el.checked });
    if (el.tagName === "SELECT") return push({ kind: "select", target: describeTarget(el), value: [...el.selectedOptions].map((o) => o.text.trim()).join(", ") });
    if (ty === "file") return push({ kind: "input", target: describeTarget(el), value: [...(el.files || [])].map((f) => f.name).join(", ") });
    if ("value" in el) push({ kind: "input", target: describeTarget(el), value: !rec.values ? undefined : isSensitive(el) ? "(hidden)" : clip(el.value, 500) });
  }

  function onFocusOut(e) {
    const el = e.composedPath()[0];
    if (el?.nodeType === 1 && el.isContentEditable && !el.parentElement?.isContentEditable) {
      push({ kind: "input", target: describeTarget(el), value: rec.values ? clip(el.innerText, 500) : undefined });
    }
  }

  function onSubmit(e) {
    const form = e.composedPath()[0];
    if (form?.tagName === "FORM") push({ kind: "submit", target: describeTarget(form) });
    expectChange();
  }

  function onKey(e) {
    if (!e.isTrusted || fromPill(e)) return;
    const special = ["Enter", "Escape"].includes(e.key);
    const combo = (e.ctrlKey || e.metaKey || e.altKey) && e.key.length === 1;
    if (!special && !combo) return;
    const mods = [e.ctrlKey && "Control", e.metaKey && "Meta", e.altKey && "Alt", e.shiftKey && combo && "Shift"].filter(Boolean);
    const el = e.composedPath()[0];
    push({ kind: "key", key: [...mods, e.key].join("+"), target: el?.nodeType === 1 && el !== document.body ? describeTarget(el) : undefined });
    if (e.key === "Enter") expectChange();
  }

  function hashText(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return String(h);
  }

  function recordPage() {
    if (!recording || !document.body) return;
    rec.mut = 0;
    const { text } = snapshot({ maxLines: 800 });
    const outline = text.replace(/^Scroll: .*$/m, "");
    const h = hashText(outline);
    if (h === rec.lastHash) return;
    rec.lastHash = h;
    push({ kind: "page", title: document.title, outline });
  }

  // After an action, look again once the page has had time to react.
  function expectChange() {
    clearTimeout(rec.snapTimer);
    rec.snapTimer = setTimeout(() => { rec.snapTimer = null; if (rec.mut > 15) recordPage(); }, 1200);
  }

  function startRecording(opts = {}) {
    rec.values = opts.values !== false;
    if (recording) return;
    recording = true;
    for (const [t, fn] of [["click", onClick], ["change", onChange], ["submit", onSubmit], ["keydown", onKey], ["focusout", onFocusOut]]) document.addEventListener(t, fn, true);
    addEventListener("pagehide", flushRec);
    document.addEventListener("visibilitychange", flushRec);
    rec.obs = new MutationObserver((list) => {
      for (const m of list) if (!pillHost || !pillHost.contains(m.target)) rec.mut++;
      // Big changes without a click (live updates, lazy loading) still get captured, at most every 3s.
      if (rec.mut > 300 && !rec.snapTimer) rec.snapTimer = setTimeout(() => { rec.snapTimer = null; recordPage(); }, 3000);
    });
    if (document.body) rec.obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    push({ kind: "nav", title: document.title, referrer: document.referrer || undefined });
    if (document.readyState === "complete") setTimeout(recordPage, 300);
    else addEventListener("load", () => setTimeout(recordPage, 300), { once: true });
    updatePill();
  }

  function stopRecording() {
    if (!recording) return;
    flushRec();
    recording = false;
    for (const [t, fn] of [["click", onClick], ["change", onChange], ["submit", onSubmit], ["keydown", onKey], ["focusout", onFocusOut]]) document.removeEventListener(t, fn, true);
    rec.obs?.disconnect();
    clearTimeout(rec.snapTimer);
    rec.snapTimer = null;
    updatePill();
  }

  // ------------------------------------------------------------ media
  // Images, video, audio, canvases and CSS background images on the page.
  // blob: URLs are read here, where the page's origin can still fetch them,
  // and handed over in chunks.

  function listMedia({ limit = 300 } = {}) {
    const items = [];
    const seen = new Set();
    const add = (o) => {
      const key = o.kind + (o.url || o.ref);
      if (items.length >= limit || seen.has(key)) return;
      seen.add(key);
      items.push(o);
    };
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    for (const v of document.querySelectorAll("video, audio")) {
      const url = v.currentSrc || v.src || "";
      add({
        kind: v.tagName.toLowerCase(), url, ref: refFor(v),
        sources: [...v.querySelectorAll("source")].map((x) => x.src).filter(Boolean),
        duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
        time: Math.round(v.currentTime || 0), paused: v.paused,
        w: v.videoWidth || undefined, h: v.videoHeight || undefined,
        streamed: url.startsWith("blob:") || !!v.srcObject, visible: vis(v),
        name: clip(nameOf(v) || v.title || "", 80),
      });
    }
    for (const img of document.images) {
      const url = img.currentSrc || img.src;
      if (!url) continue;
      add({ kind: "image", url, ref: refFor(img), alt: clip(img.alt || "", 80), w: img.naturalWidth, h: img.naturalHeight, visible: vis(img) });
    }
    for (const c of document.querySelectorAll("canvas")) {
      if (c.width * c.height < 4096) continue;
      add({ kind: "canvas", ref: refFor(c), w: c.width, h: c.height, visible: vis(c) });
    }
    let n = 0;
    for (const el of document.querySelectorAll("body *")) {
      if (++n > 4000 || items.length >= limit) break;
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === "none" || !bg.includes("url(")) continue;
      for (const m of bg.matchAll(/url\(["']?(.*?)["']?\)/g)) {
        if (m[1].startsWith("data:image/svg")) continue;
        try { add({ kind: "background", url: new URL(m[1], location.href).href, ref: refFor(el), visible: vis(el) }); } catch {}
      }
    }
    return { items };
  }

  const blobCache = new Map(); // url -> { buf, type }

  async function mediaRead({ url, ref, offset = 0, size = 4 * 1024 * 1024 }) {
    let entry = blobCache.get(url || ref);
    if (!entry) {
      if (ref && !url) {
        const el = byRef(ref);
        if (el.tagName !== "CANVAS") throw new Error(`${label(el)} has no file to save.`);
        let dataUrl;
        try { dataUrl = el.toDataURL("image/png"); } catch { throw new Error("This canvas shows content from another site, so the browser won't let it be read. Use screenshot instead."); }
        const bin = atob(dataUrl.split(",")[1]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        entry = { buf: bytes.buffer, type: "image/png" };
      } else {
        let res;
        try { res = await fetch(url); } catch {
          throw new Error("This blob can't be read. Video that streams through MediaSource has no single file behind it: save the stream (the .m3u8 or .mpd in list_media) instead.");
        }
        const blob = await res.blob();
        entry = { buf: await blob.arrayBuffer(), type: blob.type || res.headers.get("content-type") || "application/octet-stream" };
      }
      blobCache.set(url || ref, entry);
      setTimeout(() => blobCache.delete(url || ref), 120000);
    }
    const bytes = new Uint8Array(entry.buf, offset, Math.max(0, Math.min(size, entry.buf.byteLength - offset)));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { total: entry.buf.byteLength, type: entry.type, data: btoa(bin) };
  }

  // The current frame of a video. Cross-origin video can't be read this way;
  // then the caller crops a screenshot instead.
  async function videoFrame({ ref }) {
    const v = byRef(ref);
    if (v.tagName !== "VIDEO") throw new Error(`${label(v)} is not a video.`);
    await reveal(v);
    const r = v.getBoundingClientRect();
    const viewport = { x: r.left, y: r.top, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight };
    try {
      const c = document.createElement("canvas");
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d").drawImage(v, 0, 0);
      return { dataUrl: c.toDataURL("image/jpeg", 0.9), time: v.currentTime, viewport };
    } catch {
      return { blocked: true, time: v.currentTime, viewport };
    }
  }

  // ------------------------------------------------------------ element picker
  // The user points at something on the page and sends it to the agent with a
  // note. The agent gets the element's details and a cropped screenshot.

  let picker = null;

  function startPicker() {
    if (!IS_TOP || picker) return;
    const host = document.createElement("div");
    host.setAttribute("data-tether-pill", "");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .box { position: fixed; border-radius: 4px; box-shadow: 0 0 0 2px #d4af37, 0 0 0 9999px rgb(0 0 0 / .18); pointer-events: none; }
        .tag { position: fixed; padding: 3px 8px; border-radius: 6px; background: #232323; color: #fffbf0; font: 400 12px/1.3 system-ui, "Segoe UI", sans-serif; pointer-events: none; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
        .hint { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); padding: 8px 12px; border-radius: 10px; background: #232323; color: #fffbf0; font: 400 12.5px/1.35 system-ui, "Segoe UI", sans-serif; box-shadow: 0 8px 24px rgb(0 0 0 / .28); pointer-events: none; }
        .panel { position: fixed; width: 320px; padding: 12px; border-radius: 12px; background: #232323; color: #fffbf0; box-shadow: 0 8px 24px rgb(0 0 0 / .3); border: 1px solid rgb(255 251 240 / .1); font: 400 13px/1.4 system-ui, "Segoe UI", sans-serif; pointer-events: auto; display: grid; gap: 10px; }
        .panel p { margin: 0; color: #a9a6a0; font-size: 12.5px; }
        textarea { width: 100%; box-sizing: border-box; min-height: 72px; resize: vertical; font: inherit; color: #fffbf0; background: #1a1a1a; border: 1px solid rgb(255 251 240 / .1); border-radius: 8px; padding: 8px 10px; }
        textarea:focus { outline: none; border-color: #d4af37; }
        .row { display: flex; gap: 8px; justify-content: flex-end; }
        button { font: inherit; border: 0; border-radius: 8px; padding: 7px 12px; cursor: pointer; background: #2d2d2d; color: #fffbf0; }
        button.primary { background: #d4af37; color: #1a1a1a; font-weight: 500; }
        button:focus-visible { outline: 2px solid #d4af37; outline-offset: 2px; }
      </style>
      <div class="box" hidden></div><div class="tag" hidden></div>
      <div class="hint">Click the part of the page you mean. Esc to cancel.</div>`;
    (document.body || document.documentElement).appendChild(host);
    const box = root.querySelector(".box"), tag = root.querySelector(".tag"), hint = root.querySelector(".hint");
    picker = { host, root, target: null, chosen: null };

    const show = (el) => {
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: r.left - 2 + "px", top: r.top - 2 + "px", width: r.width + 4 + "px", height: r.height + 4 + "px" });
      box.hidden = false;
      tag.textContent = label(el);
      tag.hidden = false;
      Object.assign(tag.style, { left: Math.max(8, r.left) + "px", top: (r.top > 32 ? r.top - 28 : r.bottom + 6) + "px" });
    };
    const under = (e) => {
      host.style.display = "none";
      const el = document.elementFromPoint(e.clientX, e.clientY);
      host.style.display = "";
      return el && el !== document.documentElement ? el : null;
    };
    const onMove = (e) => {
      if (picker.chosen) return;
      const el = under(e);
      if (el && el !== picker.target) { picker.target = el; show(el); }
    };
    const onClick = (e) => {
      if (picker.chosen || e.composedPath().includes(host)) return;
      e.preventDefault();
      e.stopPropagation();
      const el = under(e);
      if (!el) return;
      picker.chosen = el;
      show(el);
      hint.remove();
      openPanel(el);
    };
    const onKey = (e) => { if (e.key === "Escape") stopPicker(); };
    const swallow = (e) => { if (!picker.chosen && !e.composedPath().includes(host)) { e.preventDefault(); e.stopPropagation(); } };
    picker.off = () => {
      removeEventListener("mousemove", onMove, true);
      removeEventListener("click", onClick, true);
      removeEventListener("keydown", onKey, true);
      for (const t of ["mousedown", "mouseup", "pointerdown", "pointerup"]) removeEventListener(t, swallow, true);
    };
    addEventListener("mousemove", onMove, true);
    addEventListener("click", onClick, true);
    addEventListener("keydown", onKey, true);
    for (const t of ["mousedown", "mouseup", "pointerdown", "pointerup"]) addEventListener(t, swallow, true);

    function openPanel(el) {
      const r = el.getBoundingClientRect();
      const panel = document.createElement("div");
      panel.className = "panel";
      panel.innerHTML = `<textarea placeholder="What about this? “Make this bigger”, “watch this price”, “why is this broken?”"></textarea>
        <p>Sends this element, its details and a screenshot to your agent, and shares the tab.</p>
        <div class="row"><button type="button" class="cancel">Cancel</button><button type="button" class="primary send">Send</button></div>`;
      const left = Math.min(Math.max(8, r.left), innerWidth - 336);
      const below = r.bottom + 12 + 190 < innerHeight;
      Object.assign(panel.style, { left: left + "px", top: (below ? r.bottom + 12 : Math.max(8, r.top - 202)) + "px" });
      root.appendChild(panel);
      const ta = panel.querySelector("textarea");
      ta.focus();
      panel.querySelector(".cancel").addEventListener("click", stopPicker);
      panel.querySelector(".send").addEventListener("click", async () => {
        const text = ta.value.trim();
        const rect = el.getBoundingClientRect();
        const element = {
          ...describeTarget(el),
          text: clip(el.innerText || "", 400),
          html: (el.outerHTML || "").slice(0, 4000),
          outline: snapshot({ root: el, maxLines: 80 }).text,
          viewport: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight },
        };
        stopPicker();
        await new Promise((r2) => requestAnimationFrame(() => requestAnimationFrame(r2)));
        api.runtime.sendMessage({ type: "pickSend", text, element });
      });
    }
  }

  function stopPicker() {
    if (!picker) return;
    picker.off();
    picker.host.remove();
    picker = null;
  }

  // ------------------------------------------------------------ wiring

  const handlers = { snapshot, readText, locate, focusFor, click, hover, type, fill, select, press, scroll, waitFor, upload, listMedia, mediaRead, videoFrame };

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.agents) agents = msg.agents;
    switch (msg.cmd) {
      case "ping":
        sendResponse({ ok: true });
        return;
      case "agents":
        shared = true;
        updatePill();
        sendResponse({ ok: true });
        return;
      case "activity":
        shared = true;
        updatePill();
        if (msg.summary) setActivity(`${msg.agent ? msg.agent + " " : ""}${msg.summary}`);
        sendResponse({ ok: true });
        return;
      case "pill":
        if (pillHost) pillHost.style.display = msg.hidden ? "none" : "";
        sendResponse({ ok: true });
        return;
      case "paused":
        paused = msg.paused || null;
        shared = true;
        updatePill();
        sendResponse({ ok: true });
        return;
      case "unshared":
        shared = false;
        paused = null;
        updatePill();
        sendResponse({ ok: true });
        return;
      case "record":
        msg.on ? startRecording(msg) : stopRecording();
        sendResponse({ ok: true });
        return;
      case "pick":
        startPicker();
        sendResponse({ ok: true });
        return;
      case "frameHello":
        // Tell the parent frame which iframe element is this frame.
        if (!IS_TOP) window.parent.postMessage({ __tetherFrameHello: msg.frameId }, "*");
        sendResponse({ ok: true });
        return;
      case "frameRect": {
        // Where a child frame's content starts, in this frame's viewport.
        let rect = null;
        for (const f of document.querySelectorAll("iframe, frame")) {
          if (frameIds.get(f) === msg.childFrameId) {
            const r = f.getBoundingClientRect();
            rect = { x: r.left + f.clientLeft, y: r.top + f.clientTop };
            break;
          }
        }
        sendResponse({ rect });
        return;
      }
      case "recNav":
        // Single-page apps change the URL without a load.
        if (recording) {
          push({ kind: "nav", title: document.title });
          setTimeout(recordPage, 800);
        }
        sendResponse({ ok: true });
        return;
    }
    const fn = handlers[msg.cmd];
    if (!fn) return;
    shared = true;
    Promise.resolve()
      .then(() => fn(msg))
      .then(
        (r) => sendResponse(r),
        (e) => sendResponse({ error: e?.message || String(e) })
      );
    return true;
  });

  // Console mirror from the page-world hook (used where the debugger isn't available).
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data?.__tetherConsole) return;
    api.runtime.sendMessage({ type: "console", entry: e.data.__tetherConsole }).catch?.(() => {});
  });

  // When the extension is reloaded or updated, this copy is cut off from it.
  // Take the pill and listeners down so the new copy is the only one.
  function orphaned() {
    clearInterval(beat);
    if (recording) { try { stopRecording(); } catch {} }
    shared = false;
    recording = false;
    pillHost?.remove();
    pillHost = null;
    pillText = null;
  }

  // Heartbeat keeps the background awake while this tab is shared or recorded,
  // and notices when this copy has been orphaned. Faster while the pill is up.
  let beatCount = 0;
  const beat = setInterval(() => {
    if (!(shared || recording) && ++beatCount % 4) return;
    try {
      if (!api.runtime?.id) return orphaned();
      api.runtime.sendMessage({ type: "heartbeat" }).then?.(
        (r) => {
          if (!r) return;
          if (!r.shared && shared) { shared = false; updatePill(); }
          if (!r.recording && recording) stopRecording();
        },
        (e) => { if (/context invalidated/i.test(String(e?.message || e))) orphaned(); }
      );
    } catch {
      orphaned();
    }
  }, 5000);

  api.runtime.sendMessage({ type: "pillState" }).then?.((s) => {
    if (!s) return;
    agents = s.agents || [];
    if (s.activity) lastActivity = `${s.activity.agent} ${s.activity.summary}`;
    shared = !!s.shared;
    paused = s.paused || null;
    if (!IS_TOP) return;
    if (s.recording) startRecording(s.recording);
    else updatePill();
  });
})();
