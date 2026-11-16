// Store images: five 1280x800 screenshots and the Chrome promo tiles, built
// from the extension screenshots in test/shots (run `npm run shots` first).
// Usage: node store/make-images.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const shots = path.join(root, "test", "shots");
const out = path.join(root, "store", "images");
fs.mkdirSync(out, { recursive: true });
const img = (f) => `data:image/png;base64,${fs.readFileSync(path.join(shots, f)).toString("base64")}`;
const font = (f) => `data:font/woff2;base64,${fs.readFileSync(path.join(root, "extension", "fonts", f)).toString("base64")}`;

const MARK = `<svg viewBox="0 0 32 32" width="56" height="56"><rect width="32" height="32" rx="8" fill="#2d2d2d"/><g fill="none" stroke="#fffbf0" stroke-width="3" stroke-linecap="round"><path d="M12.5 6.5V19.5a5 5 0 0 0 5 5h1.5"/><path d="M8 12.5h10"/></g><circle cx="23" cy="12.5" r="2.6" fill="#d4af37"/></svg>`;
const CSS = `
@font-face { font-family: I; src: url(${font("inter.woff2")}); font-weight: 100 900; }
@font-face { font-family: J; src: url(${font("jakarta.woff2")}); font-weight: 200 800; }
* { box-sizing: border-box; margin: 0; }
body { width: var(--w); height: var(--h); background: #1a1a1a; color: #fffbf0; font-family: I, sans-serif; overflow: hidden; -webkit-font-smoothing: antialiased; }
.wrap { position: relative; width: 100%; height: 100%; display: grid; grid-template-columns: 1fr 1fr; align-items: center; gap: 48px; padding: 64px 72px; }
.copy { display: grid; gap: 18px; align-content: center; }
.kick { color: #d4af37; font: 600 18px/1 I; letter-spacing: .02em; }
h1 { font: 700 52px/1.08 J; letter-spacing: -.025em; }
p { color: #a9a6a0; font-size: 21px; line-height: 1.55; max-width: 26em; }
.art { position: relative; display: grid; place-items: center; height: 100%; }
.frame { border-radius: 22px; overflow: hidden; box-shadow: 0 0 0 1px rgb(255 251 240 / .1); background: #222; }
.frame img { display: block; width: 100%; }
.brand { position: absolute; left: 72px; bottom: 48px; display: flex; gap: 12px; align-items: center; font: 700 22px J; color: #fffbf0; }
.brand svg { width: 32px; height: 32px; }
`;
const page = (w, h, body) => `<!doctype html><html><head><style>:root{--w:${w}px;--h:${h}px}${CSS}</style></head><body>${body}</body></html>`;
const brand = `<div class="brand">${MARK.replace('width="56" height="56"', "")}Tether</div>`;

const SHOTS = [
  {
    kick: "Your browser, your agent",
    h: "Share a tab with your coding agent",
    p: "Claude Code, Codex and any MCP agent use the tabs you choose, already signed in. Nothing is visible until you share it.",
    art: `<div class="frame" style="width:330px;height:660px"><img src="${img("popup-shared.png")}" style="height:100%;object-fit:cover;object-position:top"></div>`,
  },
  {
    kick: "Stay in control",
    h: "Watch every step, pause at any time",
    p: "A gold cursor with the agent's name shows each click before it happens. Pause holds everything until you resume.",
    art: `<div style="display:grid;gap:18px;width:540px"><div class="frame"><img src="${img("cursor.png")}"></div><div class="frame"><img src="${img("page-pill-ask.png")}"></div></div>`,
  },
  {
    kick: "Consent first",
    h: "Agents ask before they get more access",
    p: "An agent asks for its own window, or for every tab, and says why. Nothing changes until you allow it.",
    art: `<div class="frame" style="width:480px"><img src="${img("prompt.png")}"></div>`,
  },
  {
    kick: "Change any site",
    h: "Ask for changes, point at what you mean",
    p: "Send a screenshot or pick an element. Your agent saves a style or userscript that also works in Stylus and Tampermonkey.",
    art: `<div style="position:relative;width:560px;height:520px"><div class="frame" style="position:absolute;left:0;top:40px;width:470px"><img src="${img("picker.png")}"></div><div class="frame" style="position:absolute;right:0;top:0;width:220px"><img src="${img("popup-composer.png")}"></div></div>`,
  },
  {
    kick: "Built for developers",
    h: "Devtools, recordings, watchers and sounds",
    p: "Network bodies, console and cookies for debugging, recordings so agents learn your sites, watchers that alert you, and quiet sounds you can turn off.",
    art: `<div class="frame" style="width:480px;height:640px"><img src="${img("options.png")}" style="width:100%;object-fit:cover;object-position:top"></div>`,
  },
];

const b = await chromium.launch();
const shot = async (file, w, h, html) => {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await p.setContent(html);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(out, file) });
  await p.close();
};
for (const [i, s] of SHOTS.entries()) {
  await shot(`screenshot-${i + 1}.png`, 1280, 800, page(1280, 800, `<div class="wrap"><div class="copy"><span class="kick">${s.kick}</span><h1>${s.h}</h1><p>${s.p}</p></div><div class="art">${s.art}</div></div>${brand}`));
}
await shot("promo-small.png", 440, 280, page(440, 280, `<div style="height:100%;display:grid;align-content:center;gap:14px;padding:0 34px">${MARK}<div style="font:700 34px/1 J;letter-spacing:-.02em">Tether</div><div style="color:#a9a6a0;font-size:16px;line-height:1.45">Let your coding agent use your own browser</div></div>`));
await shot("promo-marquee.png", 1400, 560, page(1400, 560, `<div style="height:100%;display:grid;grid-template-columns:1.1fr 1fr;align-items:center;gap:40px;padding:0 90px"><div style="display:grid;gap:22px">${MARK.replace('width="56" height="56"', 'width="72" height="72"')}<div style="font:700 64px/1.05 J;letter-spacing:-.03em">Let your coding agent use your own browser</div><div style="color:#a9a6a0;font-size:22px">Claude Code, Codex and any MCP agent, signed in as you.</div></div><div class="frame" style="width:300px;height:440px;justify-self:center"><img src="${img("popup-shared.png")}" style="height:100%;object-fit:cover;object-position:top"></div></div>`));
fs.copyFileSync(path.join(root, "extension", "icons", "icon128.png"), path.join(out, "icon-128.png"));
await b.close();
console.log("store images in", out);
