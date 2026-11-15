// Injected only into tabs the user has shared. Builds the page outline the
// agent reads, performs DOM actions, and shows the small "shared" pill.
(() => {
  "use strict";
  if (window.__tetherContent) return;
  // Non-enumerable and only in the isolated world, so pages can't see it.
  Object.defineProperty(window, "__tetherContent", { value: true });

  const api = globalThis.browser ?? globalThis.chrome;

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

  function snapshot({ maxLines = 400 } = {}) {
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
        } else {
          emit(`frame ${q(clip(el.src, 80))} (cross-origin, not readable here)`);
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

    walk(document.body || document.documentElement);
    flush();

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
    flash(el);
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
    const note = `${verb} ${label(el)}` + (covered ? ` (note: ${label(top)} was on top of it)` : "");
    setActivity(note);
    return { x, y, note };
  }

  async function focusFor({ ref, append }) {
    const el = byRef(ref);
    await reveal(el);
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
    pickOptions(el, values);
    const note = `Picked ${values.join(", ")} in ${label(el)}`;
    setActivity(note);
    return { note };
  }

  async function fill({ fields }) {
    const done = [];
    for (const { ref, value } of fields) {
      const el = byRef(ref);
      el.scrollIntoView({ block: "center", behavior: "instant" });
      flash(el);
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
    if (pillHost?.isConnected) return;
    pillHost = document.createElement("div");
    pillHost.style.cssText = "all:initial;position:fixed;inset:auto 16px 16px auto;z-index:2147483647;";
    pillRoot = pillHost.attachShadow({ mode: "closed" });
    pillRoot.innerHTML = `
      <style>
        :host { all: initial; }
        .pill {
          display: flex; align-items: center; gap: 10px;
          max-width: 340px; padding: 8px 8px 8px 12px;
          background: #1e1d1a; color: #ece8e1;
          border: 1px solid rgb(236 232 225 / .1); border-radius: 12px;
          box-shadow: 0 8px 24px rgb(0 0 0 / .28);
          font: 400 12.5px/1.35 system-ui, "Segoe UI Variable Text", "Segoe UI", -apple-system, sans-serif;
          -webkit-font-smoothing: antialiased;
        }
        .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #e8a33d; }
        .dot.rec { background: #e0806b; }
        .lines { min-width: 0; }
        .t { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .s { color: #a9a49b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .s:empty { display: none; }
        button {
          flex: none; margin-left: 4px; padding: 5px 10px;
          background: #2a2825; color: #ece8e1; border: 0; border-radius: 8px;
          font: inherit; cursor: pointer;
        }
        button:hover { background: #34312d; }
        button:focus-visible { outline: 2px solid #e8a33d; outline-offset: 1px; }
        .hl {
          position: fixed; pointer-events: none; border-radius: 6px;
          box-shadow: 0 0 0 2px #e8a33d; opacity: 0;
          transition: opacity .5s ease-out;
        }
        .hl.on { opacity: 1; transition: none; }
        @media (prefers-reduced-motion: reduce) { .hl { transition: none; } }
      </style>
      <div class="hl"></div>
      <div class="pill" role="status">
        <span class="dot" aria-hidden="true"></span>
        <div class="lines"><div class="t"></div><div class="s"></div></div>
        <button type="button" title="Stop sharing this tab">Stop</button>
      </div>`;
    pillText = pillRoot.querySelector(".t");
    pillSub = pillRoot.querySelector(".s");
    hl = pillRoot.querySelector(".hl");
    pillRoot.querySelector("button").addEventListener("click", () => api.runtime.sendMessage({ type: "stop" }));
    pillRoot.querySelector("button").title = "Stop sharing and recording this tab";
    (document.body || document.documentElement).appendChild(pillHost);
    renderPill();
  }

  let shared = false;
  let recording = false;

  function renderPill() {
    if (!pillText) return;
    if (shared) {
      pillText.textContent = (agents.length ? `Shared with ${agents.join(" and ")}` : "Shared, waiting for an agent") + (recording ? " · recording" : "");
      pillSub.textContent = lastActivity;
    } else {
      pillText.textContent = "Recording this visit";
      pillSub.textContent = "Clicks, typing and page structure, for your agent";
    }
    pillRoot.querySelector(".dot").classList.toggle("rec", recording && !shared);
  }

  function setActivity(text) {
    lastActivity = text;
    renderPill();
  }

  function flash(el) {
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

  // ------------------------------------------------------------ wiring

  const handlers = { snapshot, readText, locate, focusFor, click, hover, type, fill, select, press, scroll, waitFor, upload };

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
      case "unshared":
        shared = false;
        updatePill();
        sendResponse({ ok: true });
        return;
      case "record":
        msg.on ? startRecording(msg) : stopRecording();
        sendResponse({ ok: true });
        return;
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

  // Heartbeat keeps the background awake while this tab is shared or recorded.
  const beat = setInterval(() => {
    try {
      api.runtime.sendMessage({ type: "heartbeat" }).then?.(
        (r) => {
          if (!r) return;
          if (!r.shared && shared) { shared = false; updatePill(); }
          if (!r.recording && recording) stopRecording();
        },
        () => clearInterval(beat)
      );
    } catch {
      clearInterval(beat);
    }
  }, 20000);

  api.runtime.sendMessage({ type: "pillState" }).then?.((s) => {
    if (!s) return;
    agents = s.agents || [];
    if (s.activity) lastActivity = `${s.activity.agent} ${s.activity.summary}`;
    shared = !!s.shared;
    if (s.recording) startRecording(s.recording);
    else updatePill();
  });
})();
