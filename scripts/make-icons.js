// Draws the toolbar icon (a ring tethered to an amber dot) as PNGs, no deps.
import fs from "node:fs";
import zlib from "node:zlib";

const BG = [30, 29, 26], INK = [236, 232, 225], AMBER = [232, 163, 61];

function render(size) {
  const ss = 4, N = size * ss;
  const px = new Float32Array(size * size * 4);
  const r = N * 0.22; // corner radius
  const ring = { x: N * 0.33, y: N * 0.67, r: N * 0.13, w: N * 0.065 };
  const dot = { x: N * 0.68, y: N * 0.32, r: N * 0.15 };
  const segDist = (x, y, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const cx = x + 0.5, cy = y + 0.5;
    const qx = Math.max(r - cx, 0, cx - (N - r)), qy = Math.max(r - cy, 0, cy - (N - r));
    if (Math.hypot(qx, qy) > r) continue;
    let c = BG;
    const dRing = Math.abs(Math.hypot(cx - ring.x, cy - ring.y) - ring.r);
    const ang = Math.atan2(dot.y - ring.y, dot.x - ring.x);
    const sx = ring.x + Math.cos(ang) * ring.r, sy = ring.y + Math.sin(ang) * ring.r;
    if (dRing < ring.w / 2 || segDist(cx, cy, sx, sy, dot.x, dot.y) < ring.w / 2) c = INK;
    if (Math.hypot(cx - dot.x, cy - dot.y) < dot.r) c = AMBER;
    const i = (Math.floor(y / ss) * size + Math.floor(x / ss)) * 4;
    px[i] += c[0]; px[i + 1] += c[1]; px[i + 2] += c[2]; px[i + 3] += 255;
  }
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, a = px[i + 3];
    const o = y * (size * 4 + 1) + 1 + x * 4;
    if (a) { raw[o] = px[i] / (a / 255); raw[o + 1] = px[i + 1] / (a / 255); raw[o + 2] = px[i + 2] / (a / 255); }
    raw[o + 3] = a / (ss * ss);
  }
  return png(size, raw);
}

function png(size, raw) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

for (const s of [16, 32, 48, 128]) fs.writeFileSync(`extension/icons/icon${s}.png`, render(s));
console.log("icons written");
