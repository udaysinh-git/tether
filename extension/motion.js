// Motion for the popup and settings page. The springs and the press feel
// follow the micro-interactions in Bencho (bencho.dev, MIT): one spring for
// anything that settles, a quick press-in and an overshooting release, and
// content that changes by crossfading through a small blur rather than
// jumping. The pages are rendered as HTML strings, so `patch` updates the
// DOM in place: elements that survive a render keep their CSS transitions,
// and only what really changed animates.

import "./toast-stack.js";
import "./sounds.js";

// Sounds are on unless the user turned them off in settings.
const api = globalThis.browser ?? globalThis.chrome;
let soundsOn = true;
api.storage.local.get("sounds").then((v) => { soundsOn = v.sounds !== false; }, () => {});
api.storage.onChanged.addListener((c) => { if (c.sounds) soundsOn = c.sounds.newValue !== false; });
export function sound(name, opts) {
  if (soundsOn) globalThis.tetherSound.play(name, opts);
}

const reduce = matchMedia("(prefers-reduced-motion: reduce)");

// stiffness 380, damping 34, mass 0.6, sampled (see the curves in ui.css)
export const SPRING = "linear(0, 0.051, 0.15, 0.264, 0.375, 0.464, 0.553, 0.63, 0.695, 0.742, 0.788, 0.826, 0.857, 0.883, 0.901, 0.919, 0.934, 0.946, 0.954, 0.963, 0.969, 0.975, 0.979, 0.983, 0.986, 0.988, 0.99, 0.992, 0.993, 0.995, 0.996, 0.996, 0.997, 0.998, 0.998, 0.998, 0.999, 0.999, 0.999, 0.999, 1)";
// stiffness 380, damping 26, mass 0.9: a little give at the end
export const ISLAND = "linear(0, 0.046, 0.137, 0.252, 0.377, 0.501, 0.616, 0.717, 0.804, 0.874, 0.93, 0.976, 1.005, 1.024, 1.035, 1.04, 1.041, 1.04, 1.036, 1.031, 1.026, 1.02, 1.015, 1.011, 1.008, 1.005, 1.003, 1.001, 1, 0.999, 0.999, 0.998, 0.998, 0.998, 0.999, 0.999, 0.999, 0.999, 0.999, 1, 1)";

const sameNode = (a, b) =>
  a.nodeType === b.nodeType && a.nodeName === b.nodeName && (a.nodeType !== 1 || (a.dataset.k || a.id || "") === (b.dataset.k || b.id || ""));

function patchAttrs(from, to) {
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
}

function patchChildren(from, to, changed) {
  const a = [...from.childNodes];
  const b = [...to.childNodes];
  let i = 0;
  for (; i < b.length; i++) {
    const old = a[i];
    const neu = b[i];
    if (old && sameNode(old, neu)) {
      if (old.nodeType === 3 || old.nodeType === 8) {
        if (old.nodeValue !== neu.nodeValue) { old.nodeValue = neu.nodeValue; changed.text.add(old.parentElement); }
        continue;
      }
      // Leave what the user is typing in alone.
      if ((old.tagName === "INPUT" || old.tagName === "TEXTAREA") && old === document.activeElement) continue;
      patchAttrs(old, neu);
      if (old.tagName === "INPUT" && old.value !== neu.value && neu.hasAttribute("value")) old.value = neu.value;
      patchChildren(old, neu, changed);
    } else {
      const node = neu.cloneNode(true);
      if (old) from.replaceChild(node, old); else from.appendChild(node);
      if (node.nodeType === 1) changed.added.push(node);
      else if (node.nodeType === 3 && node.parentElement) changed.text.add(node.parentElement);
    }
  }
  for (; i < a.length; i++) a[i].remove();
}

// Replace `root`'s contents with `html`, animating what changed.
export function patch(root, html) {
  const morphs = [...root.querySelectorAll("[data-morph]")].map((el) => [el.dataset.morph, el.getBoundingClientRect().height]);
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const first = !root.firstChild;
  const changed = { text: new Set(), added: [] };
  patchChildren(root, tpl.content, changed);
  if (first || reduce.matches) return;

  // Cards that changed size grow or shrink on the spring instead of jumping.
  for (const [key, h] of morphs) {
    const el = root.querySelector(`[data-morph="${key}"]`);
    if (!el) continue;
    const now = el.getBoundingClientRect().height;
    if (Math.abs(now - h) < 1) continue;
    el.animate([{ height: `${h}px`, overflow: "hidden" }, { height: `${now}px`, overflow: "hidden" }], { duration: 540, easing: ISLAND });
  }

  // Lines whose words changed rise into place.
  for (const el of changed.text) {
    if (!el || el.closest("[data-ago]")) continue;
    const line = el.closest("[data-rise]");
    if (line) rise(line);
  }

  // New pieces arrive one after another.
  let n = 0;
  for (const el of changed.added) {
    if (el.closest("[data-rise]") && !el.matches("[data-rise]")) continue;
    if (!el.getClientRects().length) continue;
    el.animate(
      [{ opacity: 0, transform: "translateY(6px) scale(0.985)", filter: "blur(4px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }],
      { duration: 420, delay: Math.min(n++, 6) * 40, easing: SPRING, fill: "backwards" }
    );
  }
}

export function rise(el) {
  if (reduce.matches) return;
  el.animate(
    [{ opacity: 0, transform: "translateY(7px)", filter: "blur(5px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }],
    { duration: 380, easing: SPRING }
  );
}

// Toasts go into one stack per page (toast-stack.js, after Bencho's).
let stack = null;
export function toast(title, { tone = "", body = "", kind } = {}) {
  if (!stack) {
    const host = document.createElement("div");
    host.id = "toasts";
    document.body.appendChild(host);
    stack = globalThis.createToastStack(host);
  }
  const k = kind || (tone === "bad" ? "error" : "success");
  sound(k === "error" ? "buzz" : "plop");
  return stack.show({ kind: k, title, body });
}

// Switches: when one flips, the droplet lengthens along its travel and thins
// across it (area kept), then settles, instead of sliding as a rigid dot.
export function liquidSwitches(root = document) {
  if (reduce.matches) return;
  new MutationObserver((list) => {
    for (const m of list) {
      const el = m.target;
      if (m.attributeName !== "aria-checked" || !el.classList?.contains("switch")) continue;
      if (m.oldValue === el.getAttribute("aria-checked")) continue;
      sound("latch", { pitch: el.getAttribute("aria-checked") === "true" ? 1.12 : 0.89 });
      el.animate(
        [{ scale: "1 1" }, { scale: "1.32 0.76", offset: 0.28 }, { scale: "0.94 1.06", offset: 0.62 }, { scale: "1 1" }],
        { duration: 560, easing: "ease-out", pseudoElement: "::after" }
      );
    }
  }).observe(root, { subtree: true, attributes: true, attributeFilter: ["aria-checked"], attributeOldValue: true });
}
