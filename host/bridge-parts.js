// A browser drops any message from a native host over 1 MB, so a bigger one
// (a file being uploaded, a long outline) goes out in numbered parts that the
// extension joins back together (NativeSocket in background.js). Each part
// carries a base64 slice of the UTF-8 body, about 800 KB on the wire.
export const PART_BYTES = 600 * 1024;
let seq = 0;

export function parts(body) {
  if (body.length <= PART_BYTES) return [body];
  const id = ++seq;
  const n = Math.ceil(body.length / PART_BYTES);
  const out = [];
  for (let i = 0; i < n; i++) {
    const data = body.subarray(i * PART_BYTES, (i + 1) * PART_BYTES).toString("base64");
    out.push(Buffer.from(JSON.stringify({ type: "bridge", part: { id, i, n, data } })));
  }
  return out;
}

// The extension's side, here so the unit test can check a round trip.
export function joinParts(list) {
  const bufs = [...list].sort((a, b) => a.i - b.i).map((p) => Buffer.from(p.data, "base64"));
  return JSON.parse(Buffer.concat(bufs).toString("utf8"));
}
