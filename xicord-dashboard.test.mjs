// Extracts the REAL network() from xicord-dashboard.html (by brace matching, so it
// can't drift from the shipped code) and drives it against a minimal SVG/DOM shim.
import { readFileSync } from "fs";

const HTML = readFileSync("C:/Users/aeare/Desktop/Vencord/xicord-dashboard.html", "utf8");

// Brace-matches a function out of the HTML. Must skip comments as well as
// strings: an apostrophe in a `// don't` comment would otherwise look like the
// start of a string literal and swallow the rest of the file.
function extract(name) {
    const start = HTML.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    let i = HTML.indexOf("{", start), depth = 0, mode = "code", prev = "";
    for (; i < HTML.length; i++) {
        const ch = HTML[i], next = HTML[i + 1];
        if (mode === "line") { if (ch === "\n") mode = "code"; }
        else if (mode === "block") { if (ch === "*" && next === "/") { mode = "code"; i++; } }
        else if (mode !== "code") { if (ch === mode && prev !== "\\") mode = "code"; }
        else if (ch === "/" && next === "/") { mode = "line"; i++; }
        else if (ch === "/" && next === "*") { mode = "block"; i++; }
        else if (ch === '"' || ch === "'" || ch === "`") mode = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (!depth) return HTML.slice(start, i + 1); }
        prev = ch;
    }
    throw new Error(`unbalanced ${name}`);
}

/* ---------- DOM shim ---------- */
let idSeq = 0;
class FakeEl {
    constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.listeners = {}; this._id = ++idSeq; this.classList = new Set(); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") { this.classList = new Set(String(v).split(/\s+/).filter(Boolean)); } }
    getAttribute(k) { return this.attrs[k]; }
    appendChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); this.children.push(c); c.parent = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
    get firstChild() { return this.children[0] || null; }
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
    fire(t, ev) { (this.listeners[t] || []).forEach(fn => fn(ev)); }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.W || 600, height: this.H || 400 }; }
    setPointerCapture() { } releasePointerCapture() { }
    set innerHTML(v) { this._html = v; this.children = []; }
    get innerHTML() { return this._html || ""; }
    // classList shim with the API the code uses
    get classListApi() { return this.classList; }
    all(pred, acc = []) { if (pred(this)) acc.push(this); this.children.forEach(c => c.all(pred, acc)); return acc; }
}
// give classList add/remove/contains
Object.defineProperty(FakeEl.prototype, "classList", {
    get() { return this._cl ||= { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } }; },
    set(v) { /* from setAttribute("class") */ const s = this._cl ||= { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } }; s._s = v instanceof Set ? v : new Set(); }
});

/* ---------- rAF under our control ---------- */
let rafQ = [], rafId = 0, cancelled = new Set();
const requestAnimationFrame = fn => { const id = ++rafId; rafQ.push([id, fn]); return id; };
const cancelAnimationFrame = id => cancelled.add(id);
function flush(n) {
    for (let k = 0; k < n; k++) {
        const q = rafQ; rafQ = [];
        if (!q.length) return k;
        for (const [id, fn] of q) if (!cancelled.has(id)) fn();
    }
    return n;
}

/* ---------- deps the extracted function closes over ---------- */
const el = (name, attrs) => { const e = new FakeEl(name); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const clear = node => { while (node.firstChild) node.removeChild(node.firstChild); };
const svgRoot = (host, w, h) => { clear(host); const s = el("svg", { viewBox: `0 0 ${w} ${h}`, role: "img" }); s.W = w; s.H = h; host.appendChild(s); return s; };
const widthOf = () => 600;
const uname = id => "user_" + id;
const initial = n => String(n || "?").trim().charAt(0).toUpperCase() || "?";
const trunc = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const esc = s => String(s);
const fmtDur = ms => Math.round(ms / 1000) + "s";
const ago = () => "1h ago";
const showTip = () => { tipShown++; };
const hideTip = () => { };
let tipShown = 0;
let reducedMotion = false;
const getComputedStyle = () => ({ getPropertyValue: () => reducedMotion ? "1" : "" });

const src = extract("network");
const makeNetwork = new Function(
    "el", "clear", "svgRoot", "widthOf", "uname", "initial", "trunc", "esc", "fmtDur", "ago",
    "showTip", "hideTip", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
    // `netStop` lives in the dashboard's outer closure; declare it here so the
    // extracted function keeps its real cancel-previous-simulation behaviour.
    `var netStop=null; ${src}; return {network:network, getStop:function(){return netStop;}};`
);
const api = makeNetwork(el, clear, svgRoot, widthOf, uname, initial, trunc, esc, fmtDur, ago,
    showTip, hideTip, getComputedStyle, requestAnimationFrame, cancelAnimationFrame);
const network = api.network;
const getStop = api.getStop;

/* ---------- assertions ---------- */
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};

const cache = JSON.parse(readFileSync("C:/Users/aeare/Desktop/Vencord/xicord-cache-sample.json", "utf8"));
const targetId = Object.keys(cache.dossiers)[0];
const view = cache.dossiers[targetId];
const nComp = Object.keys(view.companions).length;

const host = new FakeEl("div");
network(host, targetId, view);
const svg = host.children[0];
const circles = svg.all(e => e.tag === "circle");
const lines = svg.all(e => e.tag === "line");
const hits = svg.all(e => e.classList.contains("net-node"));

console.log(`\n-- structure (${nComp} companions) --`);
ok("one edge per companion", lines.length === nComp, `got ${lines.length}`);
ok("one dot + one hit per node, plus nothing stray", circles.length === (nComp + 1) * 2, `got ${circles.length}`);
ok("every node is draggable", hits.length === nComp + 1, `got ${hits.length}`);
ok("svg is marked interactive", svg.getAttribute("class") === "net" && svg.getAttribute("role") === "application");

console.log("\n-- settles to a spread layout --");
flush(600);
const pos = () => hits.map(h => ({ x: +h.getAttribute("cx"), y: +h.getAttribute("cy") }));
let p = pos();
ok("no NaN anywhere", p.every(q => Number.isFinite(q.x) && Number.isFinite(q.y)),
    JSON.stringify(p.slice(0, 3)));
const centre = p[p.length - 1];
const dists = p.slice(0, nComp).map(q => Math.hypot(q.x - centre.x, q.y - centre.y));
ok("companions pushed off the centre", Math.min(...dists) > 30, `min dist ${Math.min(...dists).toFixed(1)}`);
let minPair = Infinity;
for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) minPair = Math.min(minPair, Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y));
ok("no two nodes overlap", minPair > 12, `closest pair ${minPair.toFixed(1)}`);
ok("simulation stops once settled", rafQ.length === 0, `${rafQ.length} frames still queued`);

console.log("\n-- dragging a node moves it and the others react --");
const before = pos();
const dragged = 0;
hits[dragged].fire("pointerdown", { preventDefault() { }, stopPropagation() { }, pointerId: 1, clientX: 0, clientY: 0 });
ok("drag reheats the simulation", rafQ.length > 0);
ok("cursor switches to grabbing", svg.classList.contains("dragging"));
// drag it to a far corner
for (let k = 0; k < 12; k++) {
    svg.fire("pointermove", { pointerId: 1, clientX: 40, clientY: 40 });
    flush(1);
}
const after = pos();
const movedDragged = Math.hypot(after[dragged].x - before[dragged].x, after[dragged].y - before[dragged].y);
ok("the dragged node follows the pointer", movedDragged > 100, `moved ${movedDragged.toFixed(1)}`);
const others = after.map((q, i) => i === dragged ? 0 : Math.hypot(q.x - before[i].x, q.y - before[i].y));
const reacted = others.filter(d => d > 0.5).length;
ok("other points react to the drag", reacted >= 2, `${reacted} of ${nComp} others moved`);
ok("the target node itself is pulled", others[others.length - 1] > 0.5, `centre moved ${others[others.length - 1].toFixed(2)}`);
ok("tooltip suppressed while dragging", (tipShown === 0));

console.log("\n-- release settles again, then stops --");
svg.fire("pointerup", { pointerId: 1 });
ok("cursor released", !svg.classList.contains("dragging"));
flush(900);
ok("loop stops after release", rafQ.length === 0, `${rafQ.length} queued`);
const rest = pos();
ok("still no NaN after a drag", rest.every(q => Number.isFinite(q.x) && Number.isFinite(q.y)));

console.log("\n-- panning the background --");
const root = svg.children[1];
svg.all(e => e.classList.contains("net-bg"))[0].fire("pointerdown", { preventDefault() { }, pointerId: 2, clientX: 0, clientY: 0 });
svg.fire("pointermove", { pointerId: 2, clientX: 50, clientY: 25 });
ok("background drag pans the graph", /translate\(5[0-9.]*,\s*2[0-9.]*\)/.test(root.getAttribute("transform") || ""), `transform=${root.getAttribute("transform")}`);
svg.fire("pointerup", { pointerId: 2 });

console.log("\n-- re-render cancels the previous simulation --");
flush(5);
const host2 = new FakeEl("div");
network(host2, targetId, view);   // should call the stored netStop first
const queuedAfterRebuild = rafQ.length;
flush(3);
ok("old loop cancelled, exactly one sim running", queuedAfterRebuild >= 1 && rafQ.length <= 1, `queued ${queuedAfterRebuild} -> ${rafQ.length}`);

console.log("\n-- every real target, plus the 24-companion cap --");
const cases = Object.keys(cache.dossiers).map(id => [id, cache.dossiers[id]]);
// synthetic worst case: more companions than the slice(0,24) cap
const big = { companions: {} };
for (let i = 0; i < 40; i++) big.companions["syn" + i] = { count: 1 + (i % 9), ms: 1e6, last: 1 };
cases.push(["synthetic-40", big]);

for (const [id, v] of cases) {
    const h = new FakeEl("div");
    network(h, id, v);
    const sv = h.children[0];
    const hh = sv.all(e => e.classList.contains("net-node"));
    flush(900);
    const q = hh.map(e => ({ x: +e.getAttribute("cx"), y: +e.getAttribute("cy") }));
    const expected = Math.min(Object.keys(v.companions).length, 24) + 1;
    let closest = Infinity;
    for (let i = 0; i < q.length; i++) for (let j = i + 1; j < q.length; j++) closest = Math.min(closest, Math.hypot(q[i].x - q[j].x, q[i].y - q[j].y));
    const inFrame = q.every(t => t.x > -80 && t.x < 680 && t.y > -80 && t.y < 540);
    ok(`${id}: capped at ${expected} nodes`, q.length === expected, `got ${q.length}`);
    ok(`${id}: finite + non-overlapping (closest ${closest.toFixed(1)}px)`, q.every(t => Number.isFinite(t.x)) && closest > 10);
    ok(`${id}: stays roughly on canvas`, inFrame);
    ok(`${id}: settles (no runaway loop)`, rafQ.length === 0, `${rafQ.length} queued`);
    const st = getStop(); if (st) st();
}

console.log("\n-- cursor field: the graph reacts to pointer movement --");
function freshGraph() {
    const h = new FakeEl("div");
    network(h, targetId, view);
    const sv = h.children[0];
    const hh = sv.all(e => e.classList.contains("net-node"));
    const dd = sv.all(e => e.tag === "circle" && !e.classList.contains("net-node") && !e.classList.contains("net-bg"));
    flush(1200);
    return { sv, hh, dd, at: () => hh.map(e => ({ x: +e.getAttribute("cx"), y: +e.getAttribute("cy") })) };
}
const g = freshGraph();
const rest0 = g.at();
const cxp = rest0[0].x, cyp = rest0[0].y;
g.sv.fire("pointerenter", {});
let peakPush = 0, dodged = false, maxEdge = 0, maxDot = 0;
const baseDot = +g.dd[0].getAttribute("r");
for (let k = 0; k < 200; k++) {
    const ang = k / 18;
    const mx = cxp + Math.cos(ang) * 6, my = cyp + Math.sin(ang) * 6;
    g.sv.fire("pointermove", { pointerId: 1, clientX: mx, clientY: my });
    flush(1);
    const now = g.at();
    peakPush = Math.max(peakPush, ...now.map((p, i) => Math.hypot(p.x - rest0[i].x, p.y - rest0[i].y)));
    if (Math.hypot(now[0].x - mx, now[0].y - my) > +g.hh[0].getAttribute("r")) dodged = true;
    maxDot = Math.max(maxDot, +g.dd[0].getAttribute("r"));
    maxEdge = Math.max(maxEdge, ...g.sv.all(e => e.tag === "line").map(e => +e.getAttribute("stroke-opacity")));
}
ok(`moving the cursor visibly displaces nodes (${peakPush.toFixed(1)}px)`, peakPush > 8, `only ${peakPush.toFixed(1)}px`);
ok("a node never dodges out of its own hit circle", !dodged);
ok(`nodes swell near the cursor (${baseDot.toFixed(1)} -> ${maxDot.toFixed(1)})`, maxDot > baseDot * 1.1);
ok(`edges brighten near the cursor (0.28 -> ${maxEdge.toFixed(2)})`, maxEdge > 0.4);

console.log("\n-- it idles when the cursor stops, and unwinds when it leaves --");
let spun = 0;
for (let k = 0; k < 500 && rafQ.length; k++) { flush(1); spun++; }
ok(`loop goes idle with the cursor parked (after ${spun} frames)`, rafQ.length === 0);
g.sv.fire("pointerenter", {});
g.sv.fire("pointermove", { pointerId: 1, clientX: cxp + 3, clientY: cyp });
ok("moving again wakes it back up", rafQ.length > 0);
g.sv.fire("pointerleave", {});
flush(1500);
const home = g.at();
const back = Math.max(...home.map((p, i) => Math.hypot(p.x - rest0[i].x, p.y - rest0[i].y)));
ok(`nodes settle back near rest after the cursor leaves (${back.toFixed(1)}px)`, back < 25, `drifted ${back.toFixed(1)}px`);
ok("loop stops once the cursor is gone", rafQ.length === 0, `${rafQ.length} queued`);
const st0 = getStop(); if (st0) st0();

console.log("\n-- prefers-reduced-motion opts out of the field --");
reducedMotion = true;
const gr = freshGraph();
const restR = gr.at();
gr.sv.fire("pointerenter", {});
for (let k = 0; k < 120; k++) {
    gr.sv.fire("pointermove", { pointerId: 1, clientX: restR[0].x + Math.cos(k / 18) * 6, clientY: restR[0].y + Math.sin(k / 18) * 6 });
    flush(1);
}
const movedR = Math.max(...gr.at().map((p, i) => Math.hypot(p.x - restR[i].x, p.y - restR[i].y)));
ok(`reduced motion: cursor does not shove nodes (${movedR.toFixed(2)}px)`, movedR < 1);
ok("reduced motion: no runaway loop", rafQ.length === 0, `${rafQ.length} queued`);
reducedMotion = false;
const st1 = getStop(); if (st1) st1();

/* ---------- full dossier: grid-binned physics scales to thousands ---------- */
console.log("\n-- full dossier: grid physics is ~O(n), not O(n^2) --");
const fullSrc = extract("fullGraphData");
const fullNetSrc = extract("fullNetwork");
const fullApi = new Function(
    "cache", "el", "svgRoot", "widthOf", "uname", "esc", "fmtDur", "showTip", "hideTip",
    "requestAnimationFrame", "cancelAnimationFrame",
    `var fullStop=null; var FULL_LINKS_PER_NODE=6; ${fullSrc}; ${fullNetSrc};
     return {fullGraphData:fullGraphData, fullNetwork:fullNetwork, getStop:function(){return fullStop;}};`
)(cache, el, svgRoot, widthOf, uname, esc, fmtDur, showTip, hideTip, requestAnimationFrame, cancelAnimationFrame);

// a sparse "everyone" dataset: each person linked to a handful of others
function synthDossiers(N) {
    const D = {};
    for (let i = 0; i < N; i++) {
        const comps = {};
        for (let k = 1; k <= 5; k++) { const j = (i + k * 7 + 1) % N; if (j !== i) comps["p" + j] = { count: 1 + k, ms: 1e5 }; }
        D["p" + i] = { companions: comps };
    }
    return D;
}
// build the graph + run a fixed number of physics frames, return {ms, positions}
function timeRun(N, frames) {
    const data = fullApi.fullGraphData(synthDossiers(N), N);
    const h = new FakeEl("div");
    const t0 = Date.now();
    fullApi.fullNetwork(h, data);   // includes the synchronous pre-warm that used to freeze
    flush(frames);
    const ms = Date.now() - t0;
    const svg = h.children[0];
    const hits = svg.all(e => e.classList.contains("net-node"));
    const pos = hits.map(e => ({ x: +e.getAttribute("cx"), y: +e.getAttribute("cy") }));
    const stop = fullApi.getStop(); if (stop) stop();
    return { ms, data, nodes: hits.length, pos };
}

const bigData = fullApi.fullGraphData(synthDossiers(3391), 3391);
ok("keeps every one of 3391 people", bigData.ids.length === 3391, `got ${bigData.ids.length}`);
ok("edges thinned to <=3/node on a big graph", bigData.links.length <= 3391 * 3, `got ${bigData.links.length}`);

const bigRun = timeRun(3391, 40);
ok("3391 nodes all render", bigRun.nodes === 3391, `got ${bigRun.nodes}`);
ok("no NaN positions at 3391 nodes", bigRun.pos.every(q => Number.isFinite(q.x) && Number.isFinite(q.y)));
ok(`3391 nodes: build + 40 frames stays responsive (${bigRun.ms}ms)`, bigRun.ms < 6000, `took ${bigRun.ms}ms — expected grid physics, got something quadratic?`);

// scaling: 4x the nodes should cost ~4x (linear), not ~16x (quadratic).
const small = timeRun(800, 30), large = timeRun(3200, 30);
const ratio = large.ms / Math.max(1, small.ms);
// linear ~4x; quadratic ~16x. Bar at 12 separates the two with headroom for timer noise
// on a small baseline (the 800-node run is only tens of ms).
ok(`4x nodes costs ~linear, not quadratic (${small.ms}ms -> ${large.ms}ms, ${ratio.toFixed(1)}x)`,
    ratio < 12, `${ratio.toFixed(1)}x looks quadratic (O(n^2) would be ~16x)`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
