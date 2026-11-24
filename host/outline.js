// Works out what changed between two outlines of the same page, so an action
// can hand back the difference instead of the whole page again. Refs are stable
// while a page stays loaded, so lines that didn't change keep working refs.

const split = (text) => {
  const i = text.indexOf("\n\n");
  return i < 0 ? [text.split("\n"), []] : [text.slice(0, i).split("\n"), text.slice(i + 2).split("\n")];
};
const urlOf = (head) => head.find((l) => l.startsWith("URL: ")) || "";
const indentOf = (line) => line.length - line.trimStart().length;

// Longest common subsequence over lines, as a list of = + - steps.
function diff(a, b) {
  const n = a.length, m = b.length, w = m + 1;
  const t = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: "=", line: b[j] }); i++; j++; }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) ops.push({ t: "-", line: a[i++] });
    else ops.push({ t: "+", line: b[j++] });
  }
  while (i < n) ops.push({ t: "-", line: a[i++] });
  while (j < m) ops.push({ t: "+", line: b[j++] });
  return ops;
}

// Returns the short form, or null when the whole outline is the better answer:
// another page, a small page, or most of it changed.
export function outlineDelta(prev, next, { minLines = 40, maxChanged = 0.4 } = {}) {
  if (!prev || !next || prev === next) return prev && prev === next ? same(next) : null;
  const [prevHead, prevBody] = split(prev);
  const [head, body] = split(next);
  if (!urlOf(head) || urlOf(prevHead) !== urlOf(head)) return null;
  if (body.length < minLines || body.length * prevBody.length > 4_000_000) return null;

  const ops = diff(prevBody, body);
  const added = ops.filter((o) => o.t === "+").length;
  const removed = ops.filter((o) => o.t === "-").length;
  if (!added && !removed) return same(next);
  if (added + removed > body.length * maxChanged) return null;

  // Each change is shown under the landmark lines it sits inside (form, dialog,
  // nav), so a new button still says where on the page it is.
  const out = [];
  const stack = [];
  let gap = false;
  for (const op of ops) {
    const indent = indentOf(op.line);
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    if (op.t === "=") gap = true;
    else {
      if (gap && out.length) out.push("  …");
      gap = false;
      for (const a of stack) if (!a.shown) { out.push("  " + a.line); a.shown = true; }
      out.push((op.t === "+" ? "+ " : "- ") + op.line);
    }
    if (op.t !== "-") stack.push({ indent, line: op.line, shown: op.t === "+" });
  }
  const kept = body.length - added;
  return `${head.join("\n")}\n\nChanged since the outline you last got for this tab (+ added, - removed; the other ${kept} line${kept === 1 ? " is" : "s are"} the same and their refs still work):\n${out.join("\n")}\nCall snapshot for the whole outline.`;
}

function same(next) {
  const [head, body] = split(next);
  return `${head.join("\n")}\n\nThe outline is the same as the one you last got for this tab (${body.length} lines); refs still work. Call snapshot to read it again.`;
}
