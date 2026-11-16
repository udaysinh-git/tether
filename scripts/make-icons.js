// Draws the toolbar icon, no deps: a lowercase "t" on a Jet tile whose
// crossbar points at a gold dot, the tether. Same geometry as logo.svg
// (a 32-unit grid), drawn with 4x4 supersampling.
import fs from "node:fs";
import zlib from "node:zlib";

const TILE = [45, 45, 45], INK = [255, 251, 240], GOLD = [212, 175, 55];

const seg = (x, y, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
};
// quarter arc centred (17.5, 19.5), radius 5, from the stem's foot round to the bottom
const arc = (x, y) => {
  const a = Math.atan2(y - 19.5, x - 17.5);
  if (a >= Math.PI / 2 && a <= Math.PI) return Math.abs(Math.hypot(x - 17.5, y - 19.5) - 5);
  return Math.min(Math.hypot(x - 12.5, y - 19.5), Math.hypot(x - 17.5, y - 24.5));
};

function render(size) {
  const ss = 4, N = size * ss, k = 32 / N;
  const px = new Float32Array(size * size * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x + 0.5) * k, v = (y + 0.5) * k; // in the 32 grid
    const r = 8, qx = Math.max(r - u, 0, u - (32 - r)), qy = Math.max(r - v, 0, v - (32 - r));
    if (Math.hypot(qx, qy) > r) continue;
    let c = TILE;
    const d = Math.min(seg(u, v, 12.5, 6.5, 12.5, 19.5), arc(u, v), seg(u, v, 17.5, 24.5, 19, 24.5), seg(u, v, 8, 12.5, 18, 12.5));
    if (d < 1.5) c = INK;
    if (Math.hypot(u - 23, v - 12.5) < 2.6) c = GOLD;
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
