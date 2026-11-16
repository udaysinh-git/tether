// Link-preview cards (Open Graph 1200x630, GitHub social preview 1280x640) from a demo frame.
// Run after demo/record.mjs: node demo/make-cards.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const b64 = (f) => fs.readFileSync(path.join(root, f)).toString("base64");
const frame = `data:image/jpeg;base64,${b64("demo/out/card-frame.jpg")}`;
const font = (f) => `data:font/woff2;base64,${b64("extension/fonts/" + f)}`;
const MARK = `<svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2d2d2d"/><g fill="none" stroke="#fffbf0" stroke-width="3" stroke-linecap="round"><path d="M12.5 6.5V19.5a5 5 0 0 0 5 5h1.5"/><path d="M8 12.5h10"/></g><circle cx="23" cy="12.5" r="2.6" fill="#d4af37"/></svg>`;
const html = (w, h) => `<!doctype html><style>
@font-face { font-family: I; src: url(${font("inter.woff2")}); font-weight: 100 900; }
@font-face { font-family: J; src: url(${font("jakarta.woff2")}); font-weight: 200 800; }
* { margin: 0; box-sizing: border-box; }
body { width: ${w}px; height: ${h}px; background: #1a1a1a; color: #fffbf0; font-family: I; overflow: hidden; position: relative; -webkit-font-smoothing: antialiased; }
.copy { position: absolute; left: 64px; top: 0; bottom: 0; width: 470px; display: grid; align-content: center; gap: 26px; }
.brand { display: flex; gap: 14px; align-items: center; font: 700 30px J; letter-spacing: -.02em; }
.brand svg { width: 44px; height: 44px; }
h1 { font: 700 50px/1.06 J; letter-spacing: -.03em; }
p { color: #a9a6a0; font-size: 21px; line-height: 1.45; }
code { justify-self: start; font: 400 19px "Cascadia Mono", Consolas, monospace; background: #2d2d2d; padding: 10px 16px; border-radius: 10px; }
code b { color: #d4af37; font-weight: 400; }
.shot { position: absolute; left: 590px; top: 50%; width: 720px; transform: translateY(-50%); border-radius: 16px; overflow: hidden; box-shadow: 0 0 0 1px rgb(255 251 240 / .12), 0 30px 70px rgb(0 0 0 / .5); }
.shot img { display: block; width: 100%; }
</style><body>
<div class="shot"><img src="${frame}"></div>
<div class="copy">
  <div class="brand">${MARK}Tether</div>
  <h1>Let your coding agent use your own browser</h1>
  <p>Claude Code, Codex and any MCP agent, on the tabs you share, signed in as you.</p>
  <code><b>$</b> npm i -g tether-browser</code>
</div></body>`;
const b = await chromium.launch();
for (const [file, w, h] of [["demo/out/og.png", 1200, 630], ["demo/out/github-social.png", 1280, 640]]) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.setContent(html(w, h));
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: path.join(root, file) });
  await p.close();
}
await b.close();
console.log("cards in demo/out");
