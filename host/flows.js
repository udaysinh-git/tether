// Flows: a task on a site saved as steps, so doing it again is one call.
//
//   ~/.tether/sites/<host>/flows/<id>.json
//
// A step names its element the way the recorder does (CSS selector, role and
// visible name), and the page finds it again at run time: in the page, inside
// its shadow roots, and inside frames, including ones from another site. Values can hold
// {{inputs}} that the caller fills in. Steps run through the same click, type
// and navigate calls an agent makes by hand, so read-only tabs, pausing and
// the Allow question before risky clicks all still apply.
import fs from "node:fs";
import path from "node:path";
import { SITES_DIR } from "./config.js";
import { safe, eventsOf } from "./sites.js";
import { resolveFiles, payload } from "./files.js";

export const STEP_KINDS = ["open", "click", "type", "select", "check", "press", "wait", "upload", "ask_user"];
const TEXT_FIELDS = ["url", "selector", "name", "value", "text", "message", "key", "frame"];
const HOLE = /\{\{\s*([\w-]+)\s*\}\}/g;

const slug = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "flow";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = JSON.stringify;

function dirOf(host) {
  return path.join(SITES_DIR, safe(host), "flows");
}

export function listFlows(host) {
  const hosts = host ? [safe(host)] : fs.existsSync(SITES_DIR) ? fs.readdirSync(SITES_DIR) : [];
  const out = [];
  for (const h of hosts) {
    const d = dirOf(h);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".json"))) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(d, f), "utf8"))); } catch {}
    }
  }
  return out.sort((a, b) => (b.lastRun || b.updated || 0) - (a.lastRun || a.updated || 0));
}

export function getFlow(name, host) {
  const id = slug(name);
  const hits = listFlows(host).filter((f) => f.id === id || f.name.toLowerCase() === String(name).toLowerCase());
  if (!hits.length) {
    const all = listFlows(host);
    throw new Error(`No flow called ${name}${host ? ` for ${host}` : ""}.${all.length ? ` Saved flows: ${all.map((f) => `${f.name} (${f.site})`).join(", ")}.` : " None are saved yet."}`);
  }
  if (hits.length > 1) throw new Error(`Several sites have a flow called ${name}: ${hits.map((f) => f.site).join(", ")}. Pass site.`);
  return hits[0];
}

export function holesIn(steps) {
  const names = new Set();
  for (const s of steps) for (const k of TEXT_FIELDS) if (typeof s[k] === "string") for (const m of s[k].matchAll(HOLE)) names.add(m[1]);
  return [...names];
}

function checkStep(s, i) {
  const n = `Step ${i + 1} (${s.do})`;
  const target = s.selector || s.name;
  if (s.do === "open" && !s.url) throw new Error(`${n} needs url.`);
  if (["click", "type", "select", "check", "upload"].includes(s.do) && !target) throw new Error(`${n} needs selector or name to find its element.`);
  if (["type", "select", "upload"].includes(s.do) && typeof s.value !== "string") throw new Error(`${n} needs value as a string.`);
  if (s.do === "check" && typeof s.value !== "boolean") throw new Error(`${n} needs value true or false.`);
  if (s.do === "press" && !s.key) throw new Error(`${n} needs key.`);
  if (s.do === "wait" && !s.text && !s.ms) throw new Error(`${n} needs text or ms.`);
  if (s.do === "ask_user" && !s.message) throw new Error(`${n} needs message.`);
}

export function saveFlow({ site, name, description = "", inputs = [], steps }) {
  if (!steps?.length) throw new Error("A flow needs at least one step.");
  steps.forEach(checkStep);
  const host = safe(String(site).replace(/^https?:\/\//, "").split("/")[0]);
  if (!host) throw new Error("Pass the site's host, e.g. erp.example.com.");
  const declared = new Map(inputs.map((x) => [x.name, x]));
  for (const h of holesIn(steps)) if (!declared.has(h)) declared.set(h, { name: h });
  const d = dirOf(host);
  fs.mkdirSync(d, { recursive: true });
  const id = slug(name);
  const file = path.join(d, id + ".json");
  let old = null;
  try { old = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const flow = { id, name, site: host, description, inputs: [...declared.values()], steps, created: old?.created || Date.now(), updated: Date.now(), runs: old?.runs || 0, lastRun: old?.lastRun };
  fs.writeFileSync(file, JSON.stringify(flow, null, 2));
  return flow;
}

export function deleteFlow(name, host) {
  const f = getFlow(name, host);
  fs.rmSync(path.join(dirOf(f.site), f.id + ".json"));
  return f;
}

function ran(flow) {
  const file = path.join(dirOf(flow.site), flow.id + ".json");
  try {
    const f = JSON.parse(fs.readFileSync(file, "utf8"));
    f.runs = (f.runs || 0) + 1;
    f.lastRun = Date.now();
    fs.writeFileSync(file, JSON.stringify(f, null, 2));
  } catch {}
}

export const signature = (f) => `${f.name}(${f.inputs.map((x) => x.name).join(", ")})`;

export function describeFlow(f) {
  const ins = f.inputs.length ? "\nInputs:\n" + f.inputs.map((x) => `  ${x.name}${x.description ? `: ${x.description}` : ""}${x.example ? ` (e.g. ${q(x.example)})` : ""}`).join("\n") : "\nNo inputs.";
  return `${f.name} on ${f.site}${f.description ? `\n${f.description}` : ""}${ins}\nRun ${f.runs || 0} time${f.runs === 1 ? "" : "s"}${f.lastRun ? `, last ${new Date(f.lastRun).toISOString().slice(0, 10)}` : ""}.\nSteps:\n${JSON.stringify(f.steps, null, 2)}`;
}

// ---- drafting from a recording

const target = (t) => (t ? { selector: t.selector, scope: t.scope, role: t.role, name: t.name || undefined } : {});

// Turns a recorded session into steps. It is a first draft: the agent trims
// it, swaps the values that change from run to run for {{inputs}}, and saves it.
export function draftSteps(host, session, { from = 0, limit = 400 } = {}) {
  const events = eventsOf(host, session).slice(from, from + limit);
  if (!events.length) throw new Error(`No session ${session} for ${host}.`);
  const steps = [];
  let opened = false;
  for (const e of events) {
    const last = steps.at(-1);
    switch (e.kind) {
      case "nav":
        // Later page loads are the result of a click; only the first is a step.
        if (!opened) { steps.push({ do: "open", url: e.url }); opened = true; }
        break;
      case "click":
        if (e.target) steps.push({ do: "click", ...target(e.target) });
        break;
      case "input": {
        if (!e.target) break;
        if (e.target.role === "file") {
          // The click that opened the file dialog becomes the upload itself,
          // so a replay never opens the dialog.
          const opener = last?.do === "click" ? steps.pop() : null;
          steps.push({ do: "upload", ...(opener ? { selector: opener.selector, scope: opener.scope, role: opener.role, name: opener.name } : target(e.target)), value: "{{file}}" });
          break;
        }
        const again = last && ["type", "ask_user"].includes(last.do) && last.selector === e.target.selector;
        if (again) steps.pop();
        // Passwords, card numbers and codes are never recorded: the user types them.
        if (e.value === undefined || e.value === "(hidden)") steps.push({ do: "ask_user", selector: e.target.selector, message: `Fill in ${e.target.name ? q(e.target.name) : "the highlighted field"} yourself, then press Done.` });
        else steps.push({ do: "type", ...target(e.target), value: e.value });
        break;
      }
      case "select":
        if (e.target) steps.push({ do: "select", ...target(e.target), value: String(e.value).split(", ")[0] });
        break;
      case "toggle":
        if (e.target) steps.push({ do: "check", ...target(e.target), value: !!e.value });
        break;
      case "key":
        steps.push({ do: "press", key: e.key, ...(e.target ? target(e.target) : {}) });
        break;
      // "submit" always follows the click or Enter that caused it; "page" and
      // "net" describe what happened, not what the user did.
    }
  }
  return steps;
}

// ---- running

const fill = (s, inputs) => {
  const out = { ...s };
  for (const k of TEXT_FIELDS) if (typeof out[k] === "string") out[k] = out[k].replace(HOLE, (_, n) => String(inputs[n]));
  return out;
};

const OLD_EXTENSION = "The Tether extension in this browser is older than the host and can't run flows yet. Update the extension.";

// Finds the step's element on the page, waiting for it to appear.
async function locate(hub, handle, s) {
  const end = Date.now() + (s.timeout_seconds ?? 8) * 1000;
  for (;;) {
    try {
      const r = await hub.callTab(handle, "find", { selector: s.selector, role: s.role, name: s.name, scope: s.scope, frame: s.frame });
      if (!r?.ref) throw new Error(OLD_EXTENSION);
      return r.ref;
    } catch (e) {
      if (!/^No element/.test(e.message) || Date.now() > end) throw e;
    }
    await sleep(400);
  }
}

async function runStep(hub, handle, s, agent, leftMs) {
  // An Allow question may only wait as long as this call has left.
  const p = { agent, askWaitMs: Math.max(5000, leftMs) };
  const call = (method, params, timeout = 150000) => hub.callTab(handle, method, { ...params, ...p }, timeout);
  switch (s.do) {
    case "open":
      return (await call("navigate", { url: s.url })).note;
    case "click":
      return (await call("click", { ref: await locate(hub, handle, s) })).note;
    case "type":
      return (await call("type", { ref: await locate(hub, handle, s), text: s.value, submit: s.submit })).note;
    case "select":
      return (await call("select", { ref: await locate(hub, handle, s), values: [s.value] })).note;
    case "check":
      return (await call("fill", { fields: [{ ref: await locate(hub, handle, s), value: s.value }] })).note;
    case "press":
      return (await call("press", { key: s.key, ref: s.selector || s.name ? await locate(hub, handle, s) : undefined })).note;
    case "wait": {
      const timeout = (s.timeout_seconds ?? 15) * 1000;
      return (await hub.callTab(handle, "waitFor", { text: s.text, gone: s.gone, ms: s.ms, timeout }, timeout + (s.ms ?? 0) + 5000)).note;
    }
    case "upload": {
      const files = await resolveFiles(String(s.value).split(/\s*\|\s*/).filter(Boolean));
      return (await call("upload", { ref: await locate(hub, handle, s), files: payload(files) })).note;
    }
    case "ask_user": {
      const timeout = Math.max(5000, leftMs);
      const r = await hub.callTab(handle, "waitUser", { agent, message: s.message, timeout, keep: true }, timeout + 10000);
      if (!r.resumed) throw Object.assign(new Error(r.note), { askedUser: true });
      return `Asked the user: ${s.message} They pressed Done.`;
    }
  }
  throw new Error(`Unknown step kind ${s.do}`);
}

// Runs steps from `from` until the end, a failure, or the time one tool call
// can take (MCP clients give up after about a minute). Returns what ran and,
// when it stopped early, the step to continue from.
export async function runFlow(hub, handle, flow, inputs = {}, { from = 0, agent, budgetMs = 40000 } = {}) {
  if (from < 0 || from >= flow.steps.length) throw new Error(`from_step must be between 1 and ${flow.steps.length}.`);
  const need = holesIn(flow.steps.slice(from)).filter((n) => inputs[n] === undefined || inputs[n] === "");
  if (need.length) {
    const about = (n) => { const x = flow.inputs.find((i) => i.name === n) || {}; return `${n}${x.description ? ` (${x.description}${x.example ? `, e.g. ${q(x.example)}` : ""})` : x.example ? ` (e.g. ${q(x.example)})` : ""}`; };
    throw new Error(`${flow.name} needs these inputs: ${need.map(about).join("; ")}. Pass them in inputs.`);
  }
  const started = Date.now();
  const done = [];
  for (let i = from; i < flow.steps.length; i++) {
    const left = budgetMs - (Date.now() - started);
    if (left <= 0) return { done, next: i, why: "time" };
    try {
      done.push(`${i + 1}. ${(await runStep(hub, handle, fill(flow.steps[i], inputs), agent, left)) || flow.steps[i].do}`);
    } catch (e) {
      const msg = e.message || String(e);
      if (e.askedUser) return { done, next: i + 1, why: "user", note: `Step ${i + 1} asked the user: ${q(flow.steps[i].message)} They haven't pressed Done yet.` };
      if (/Repeat (that|the) same call/.test(msg)) return { done, next: i, why: "allow", note: msg };
      return { done, next: i, why: "failed", note: msg };
    }
  }
  ran(flow);
  return { done, next: null };
}
