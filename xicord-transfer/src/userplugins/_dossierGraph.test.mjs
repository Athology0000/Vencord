// Renders the REAL in-Discord NetworkGraph from xicordDossier.tsx through a tiny
// JSX + DOM + React shim, and drives it with synthetic pointer events.
//   node src/userplugins/_dossierGraph.test.mjs
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordDossier.tsx", import.meta.url), "utf8");

// Strip types/JSX first: then the first `{` after the parameter list is reliably
// the function body, with no type annotations to confuse brace matching.
const JS = esbuild.transformSync(SRC, { loader: "tsx", jsxFactory: "h", jsxFragment: "Frag" }).code;

function extract(name, SRC = JS) {
    const start = SRC.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    // balance the parameter list first — it can contain destructuring braces
    let i = SRC.indexOf("(", start), pd = 0;
    for (; i < SRC.length; i++) {
        if (SRC[i] === "(") pd++;
        else if (SRC[i] === ")") { pd--; if (!pd) { i++; break; } }
    }
    i = SRC.indexOf("{", i);
    let depth = 0, mode = "code", prev = "";
    for (; i < SRC.length; i++) {
        const ch = SRC[i], next = SRC[i + 1];
        if (mode === "line") { if (ch === "\n") mode = "code"; }
        else if (mode === "block") { if (ch === "*" && next === "/") { mode = "code"; i++; } }
        else if (mode !== "code") { if (ch === mode && prev !== "\\") mode = "code"; }
        else if (ch === "/" && next === "/") { mode = "line"; i++; }
        else if (ch === "/" && next === "*") { mode = "block"; i++; }
        else if (ch === '"' || ch === "'" || ch === "`") mode = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (!depth) return SRC.slice(start, i + 1); }
        prev = ch;
    }
    throw new Error(`unbalanced ${name}`);
}
// pull the real layout constants so the test can't drift from the component
const consts = JS.match(/const W = 600[^\n]*\nconst FIELD[^\n]*/)[0];

/* ---------- DOM shim ---------- */
const SEL = /^([a-z]+)?(?:\.([\w-]+))?(?:\[([\w-]+)\])?$/;
class El {
    constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.L = {}; this.style = {}; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    appendChild(c) { this.children.push(c); c.parent = this; return c; }
    addEventListener(t, f) { (this.L[t] ||= []).push(f); }
    removeEventListener(t, f) { this.L[t] = (this.L[t] || []).filter(x => x !== f); }
    fire(t, e) { (this.L[t] || []).forEach(f => f(e)); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 460 }; }
    setPointerCapture() { } releasePointerCapture() { }
    matches(sel) {
        const m = SEL.exec(sel); if (!m) return false;
        const [, tag, cls, attr] = m;
        if (tag && this.tag !== tag) return false;
        if (cls && !String(this.attrs.class || "").split(/\s+/).includes(cls)) return false;
        if (attr && !(attr in this.attrs)) return false;
        return true;
    }
    walk(out = []) { for (const c of this.children) { out.push(c); c.walk(out); } return out; }
    querySelectorAll(sel) { return this.walk().filter(e => e.matches(sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function h(tag, props, ...kids) {
    if (typeof tag === "function") return tag({ ...(props || {}), children: kids });
    const e = new El(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === "ref") { if (typeof v === "function") v(e); else v.current = e; }
        else if (k === "children") continue;
        else if (k === "style") e.style = { ...v };
        else if (k === "className") e.setAttribute("class", v);
        // strokeWidth -> stroke-width, but SVG keeps a few genuinely camelCase names
        else if (k === "viewBox" || k === "textAnchor") e.setAttribute(k === "textAnchor" ? "text-anchor" : k, v);
        else e.setAttribute(k.replace(/[A-Z]/g, c => "-" + c.toLowerCase()), v);
    }
    const add = k => { if (k == null || k === false) return; if (Array.isArray(k)) k.forEach(add); else if (k instanceof El) e.appendChild(k); };
    kids.forEach(add);
    return e;
}
// a real container, so tests can still query inside a fragment root
const Frag = p => h("g", {}, ...(p.children ?? []));
const Flex = p => h("div", {}, ...(p.children ?? []));
const Button = p => h("button", {}, ...(p.children ?? []));
Button.Sizes = { SMALL: "sm" };
Button.Colors = { PRIMARY: "p", BRAND: "b" };
Button.Looks = { LINK: "link" };
const classes = (...a) => a.filter(Boolean).join(" ");
let dashboardOpened = 0;
const openDashboard = () => { dashboardOpened++; };
const Forms = { FormText: p => h("span", {}, ...(p.children ?? [])) };
const uavatar = (id, size) => `https://cdn.example/${id}/${size ?? 0}.png`;
const RelationshipStore = { isFriend: id => id === "a" };
// companion "c1" is a proven mutual friend of target "T"; the rest are call-only.
// Mutable, because the sweep-store fallback is only visible once the live scan (which
// lives in memory and dies with the client) has nothing to say.
let mutualAnswers = { T: ["c1"] };
const MutualsAPI = { isActive: () => true, isScanned: () => true, scan() { }, getMutuals: id => (id in mutualAnswers ? mutualAnswers[id] : null) };
/** the component root may be a fragment wrapper; tests want the <svg> inside it */
const asSvg = x => (x && x.tag === "svg" ? x : x?.querySelector?.("svg")) ?? x;

/* ---------- React + rAF shim ---------- */
let effects = [];
// Refs must survive a RE-RENDER but not a re-mount, or the component's layout memory
// (remembered node positions, pan/zoom) can't be exercised at all. Pool them in call
// order like React does; `remount()` is what starts a genuinely new instance.
let refs = [], refCursor = 0;
const rerender = () => { refCursor = 0; };
const remount = () => { refs = []; refCursor = 0; effects = []; q = []; dead.clear(); };
const React = {
    useRef: init => {
        if (refCursor >= refs.length) refs.push({ current: init });
        return refs[refCursor++];
    },
    // shares the ref pool, so hook order and cross-render persistence match useRef
    useState: init => {
        if (refCursor >= refs.length) refs.push({ current: typeof init === "function" ? init() : init });
        const cell = refs[refCursor++];
        return [cell.current, v => { cell.current = typeof v === "function" ? v(cell.current) : v; }];
    },
    useLayoutEffect: fn => { effects.push(fn); },
    // no-op: useResolvedUsers' network fetching is not what this suite exercises
    useEffect: () => { },
    useReducer: () => [0, () => { }],
};
const useResolvedUsers = () => { };
let q = [], rid = 0; const dead = new Set();
const requestAnimationFrame = f => { const i = ++rid; q.push([i, f]); return i; };
const cancelAnimationFrame = i => dead.add(i);
const flush = n => { for (let k = 0; k < n; k++) { const b = q; q = []; if (!b.length) return; for (const [i, f] of b) if (!dead.has(i)) f(); } };

let openedProfile = null;
const openUserProfile = id => { openedProfile = id; };
const uname = id => "user_" + id;
const initial = n => String(n || "?").charAt(0).toUpperCase();
const trunc = (s, n) => String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s);
const fmtDur = ms => Math.round(ms / 1000) + "s";

let profiles = {};
const WatchAPI = { has: id => id === "T" };
// Who is sitting in which voice channel right now, including "ME". The graph colours
// and fades by how present somebody is, so this is what drives those assertions.
let voiceStates = {};
const liveStateOf = id => voiceStates[id] ?? null;
const code = [consts, extract("ForceGraph"), extract("topCompanions"), extract("NetworkGraph"), extract("pruneLinks"), extract("isMe"), extract("totalKnownPeople"), extract("buildFullGraph"), extract("FullGraph"),
    // the real three-tier presence rule, so the suite cannot drift from what ships
    extract("voiceTier"), extract("myVoiceChannel"),
    // the settled-layout cache: the whole point is that it OUTLIVES a mount, so it has
    // to be the real one rather than a per-instance stub
    extract("layoutFor"),
    // the gold ring's source of truth: the live scan, then the all-server sweep's store
    extract("mutualsOf"), extract("provenFriends")].join("\n");
// heavyGraphNodes huge: these tests exercise the in-Discord render; the offload
// card (shown above the threshold in real use) has its own tests below.
const settings = { store: { fullGraphNodes: 150, heavyGraphNodes: 1e9, dashboardUrl: "http://localhost:8787" } };
// "ME" is the logged-in account: it must never appear in the everyone-view
const UserStore = { getCurrentUser: () => ({ id: "ME" }) };
const NAMES = ["h", "Frag", "React", "uname", "uavatar", "initial", "trunc", "fmtDur", "openUserProfile",
    "useResolvedUsers", "WatchAPI", "settings", "Flex", "Button", "Forms", "RelationshipStore", "MutualsAPI",
    "UserStore", "classes", "openDashboard", "requestAnimationFrame", "cancelAnimationFrame", "liveStateOf"];
const VALS = [h, Frag, React, uname, uavatar, initial, trunc, fmtDur, openUserProfile,
    useResolvedUsers, WatchAPI, settings, Flex, Button, Forms, RelationshipStore, MutualsAPI,
    UserStore, classes, openDashboard, requestAnimationFrame, cancelAnimationFrame, liveStateOf];
const api = new Function(...NAMES,
    // read the real constants out of the source, so the suite can never quietly test
    // different numbers from the ones that ship
    `const FULL_GRAPH_NODES = 150, MIN_GRAPH_NODES = 10, MAX_GRAPH_NODES = 1000;
     const MAX_LINKS_PER_NODE = ${/MAX_LINKS_PER_NODE = (\d+)/.exec(SRC)[1]};
     const RING_FRIEND = "gold", RING_CALL = "grey", RING_LIVE = "green";
     const LAYOUT_CACHE = new Map();
     const LAYOUT_CACHE_MAX = ${/const LAYOUT_CACHE_MAX = (\d+)/.exec(SRC)[1]};
     let profiles, graphSeq = 0, friendMap = {}, pooledFriends = {};
     ${code}
     return { NetworkGraph, FullGraph, buildFullGraph, totalKnownPeople, voiceTier,
              layoutFor, layoutCache: LAYOUT_CACHE,
              setProfiles: p => { profiles = p; }, setFriendMap: f => { friendMap = f; },
              setPooled: p => { pooledFriends = p; } };`)(...VALS);
const { NetworkGraph, FullGraph, buildFullGraph, totalKnownPeople, setProfiles, setFriendMap, setPooled } = api;
const setVoice = v => { voiceStates = v; };

/* ---------- assertions ---------- */
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};

function mount(n = 6) {
    remount(); openedProfile = null;
    const companions = {};
    for (let i = 0; i < n; i++) companions["c" + i] = { count: n - i, ms: 1000 * (i + 1), last: 1 };
    const svg = asSvg(NetworkGraph({ targetId: "T", view: { companions, guilds: {}, updated: 0, firstSeen: 0 } }));
    const cleanup = effects.map(fn => fn()).filter(f => typeof f === "function");
    return { svg, cleanup: () => cleanup.forEach(f => f()) };
}

console.log("\n-- structure --");
const { svg, cleanup } = mount(6);
const hits = svg.querySelectorAll("circle.xd-hit");
const dots = svg.querySelectorAll("circle.xd-dot");
const lines = svg.querySelectorAll("line[data-i]");
ok("one edge per companion", lines.length === 6, `got ${lines.length}`);
ok("a hit target per companion plus the centre", hits.length === 7, `got ${hits.length}`);
ok("a dot per node", dots.length === 7, `got ${dots.length}`);
ok("background rect for panning exists", !!svg.querySelector("rect.xd-bg"));

console.log("\n-- the effect actually wired up and positioned everything --");
const at = () => hits.map(e => ({ x: +e.getAttribute("cx"), y: +e.getAttribute("cy") }));
flush(600);
let p = at();
ok("every node has a real position", p.every(q2 => Number.isFinite(q2.x) && Number.isFinite(q2.y)), JSON.stringify(p.slice(0, 2)));
ok("nodes are spread out, not stacked at the origin", new Set(p.map(q2 => `${q2.x.toFixed(0)},${q2.y.toFixed(0)}`)).size === 7);
ok("edges got endpoints", lines.every(l => Number.isFinite(+l.getAttribute("x2"))));

console.log("\n-- dragging a node moves it and the others react --");
const before = at();
hits[0].fire("pointerdown", { preventDefault() { }, stopPropagation() { }, pointerId: 1, clientX: before[0].x, clientY: before[0].y, currentTarget: hits[0] });
for (let k = 0; k < 15; k++) { svg.fire("pointermove", { pointerId: 1, clientX: 70, clientY: 70 }); flush(1); }
const after = at();
ok(`dragged node follows the pointer (${Math.hypot(after[0].x - before[0].x, after[0].y - before[0].y).toFixed(0)}px)`,
    Math.hypot(after[0].x - before[0].x, after[0].y - before[0].y) > 80);
const others = after.map((q2, i) => i === 0 ? 0 : Math.hypot(q2.x - before[i].x, q2.y - before[i].y));
ok(`other points react (max ${Math.max(...others).toFixed(1)}px)`, Math.max(...others) > 5);

console.log("\n-- left-click only grabs; opening is on double-click --");
svg.fire("pointerup", { pointerId: 1, clientX: 70, clientY: 70 });
ok("dragging did not open a profile", openedProfile === null, `opened ${openedProfile}`);
flush(200);
const q3 = at();
// a single click/tap (down+up without moving) must NOT open anymore
openedProfile = null;
hits[1].fire("pointerdown", { preventDefault() { }, stopPropagation() { }, pointerId: 2, clientX: q3[1].x, clientY: q3[1].y, currentTarget: hits[1] });
svg.fire("pointerup", { pointerId: 2, clientX: q3[1].x, clientY: q3[1].y });
ok("a single click does NOT open the profile", openedProfile === null, `opened ${openedProfile}`);
// a double-click does open
hits[1].fire("dblclick", { preventDefault() { }, stopPropagation() { }, currentTarget: hits[1] });
ok("double-click opens that companion's profile", openedProfile === "c1", `opened ${openedProfile}`);
openedProfile = null;
hits[6].fire("dblclick", { preventDefault() { }, stopPropagation() { }, currentTarget: hits[6] });
ok("double-clicking the centre (the subject themselves) opens nothing", openedProfile === null, `opened ${openedProfile}`);

console.log("\n-- hovering must NOT move nodes (so they stay grabbable) --");
// The old cursor field physically pushed nodes away from the pointer, which made
// them dodge and hard to grab. Hovering must now leave the layout untouched.
flush(800);                       // let it fully settle
const rest = at();
svg.fire("pointerenter", {});
let grew = 0, brightest = 0;
const baseR = +dots[0].getAttribute("r");
for (let k = 0; k < 120; k++) {
    svg.fire("pointermove", { pointerId: 4, clientX: rest[0].x + Math.cos(k / 18) * 6, clientY: rest[0].y + Math.sin(k / 18) * 6 });
    flush(1);
    grew = Math.max(grew, +dots[0].getAttribute("r"));
    brightest = Math.max(brightest, ...lines.map(l => +l.getAttribute("stroke-opacity")));
}
const moved = Math.max(...at().map((q2, i) => Math.hypot(q2.x - rest[i].x, q2.y - rest[i].y)));
ok(`nodes hold still while the cursor sweeps over them (max drift ${moved.toFixed(2)}px)`, moved < 0.5, `drifted ${moved.toFixed(2)}px`);
ok(`the node under the cursor still swells visually (${baseR.toFixed(1)} -> ${grew.toFixed(1)})`, grew > baseR * 1.1);
ok(`edges still brighten near the cursor (0.30 -> ${brightest.toFixed(2)})`, brightest > 0.4);

console.log("\n-- a near-miss on the background grabs the nearest node, not a pan --");
const near = at();
const rootG = svg.children.find(c => c.tag === "g" && c.children.some(k => k.tag === "g" || k.tag === "line"));
const bgEl = svg.querySelector("rect.xd-bg");
// press ~10px off node 0 (a gap that used to start a pan)
bgEl.fire("pointerdown", { preventDefault() { }, pointerId: 8, clientX: near[0].x + 10, clientY: near[0].y + 8 });
// drag well away
for (let k = 0; k < 10; k++) { svg.fire("pointermove", { pointerId: 8, clientX: 500, clientY: 400 }); flush(1); }
const after8 = at();
ok("the near node was grabbed and followed the pointer",
    Math.hypot(after8[0].x - near[0].x, after8[0].y - near[0].y) > 80, `moved ${Math.hypot(after8[0].x - near[0].x, after8[0].y - near[0].y).toFixed(0)}px`);
ok("the background did NOT pan (transform unchanged)", !/translate\((?!0,0)/.test(rootG.getAttribute("transform") || "") || /translate\(0,0\)/.test(rootG.getAttribute("transform") || ""), rootG.getAttribute("transform"));
svg.fire("pointerup", { pointerId: 8, clientX: 500, clientY: 400 });
flush(400);

console.log("\n-- panning and reset --");
const bg = svg.querySelector("rect.xd-bg");
// the panned group is the <g> holding the nodes (a <defs> now sits before it)
const root = svg.children.find(c => c.tag === "g" && c.children.some(k => k.tag === "g" || k.tag === "line"));
bg.fire("pointerdown", { preventDefault() { }, pointerId: 5, clientX: 0, clientY: 0 });
svg.fire("pointermove", { pointerId: 5, clientX: 40, clientY: 20 });
ok("background drag pans", /translate\(4[0-9.]*,\s*2[0-9.]*\)/.test(root.getAttribute("transform") || ""), `transform=${root.getAttribute("transform")}`);
svg.fire("pointerup", { pointerId: 5 });
bg.fire("dblclick", {});
ok("double-click resets pan and zoom", /translate\(0,0\)\s*scale\(1\)/.test(root.getAttribute("transform") || ""), `transform=${root.getAttribute("transform")}`);

console.log("\n-- zoom --");
const zoomed = () => root.getAttribute("transform") || "";
const zLevel = () => Number(/scale\(([\d.]+)\)/.exec(zoomed())?.[1]);
svg.fire("wheel", { preventDefault() { }, deltaY: -100, clientX: 300, clientY: 230 });
ok(`scroll up zooms in (${zLevel().toFixed(2)}x)`, zLevel() > 1.05, zoomed());
for (let k = 0; k < 40; k++) svg.fire("wheel", { preventDefault() { }, deltaY: 100, clientX: 300, clientY: 230 });
ok(`zoom-out is clamped, not unbounded (${zLevel().toFixed(2)}x)`, zLevel() >= 0.34 && zLevel() < 1, zoomed());
for (let k = 0; k < 80; k++) svg.fire("wheel", { preventDefault() { }, deltaY: -100, clientX: 300, clientY: 230 });
ok(`zoom-in is clamped too (${zLevel().toFixed(2)}x)`, zLevel() <= 4.01, zoomed());
bg.fire("dblclick", {});
// zooming about a point must keep whatever is under it in place
const anchor = { x: +hits[2].getAttribute("cx"), y: +hits[2].getAttribute("cy") };
svg.fire("wheel", { preventDefault() { }, deltaY: -100, clientX: anchor.x, clientY: anchor.y });
const m = /translate\(([-\d.]+),([-\d.]+)\)\s*scale\(([\d.]+)\)/.exec(zoomed());
const screenX = Number(m[1]) + anchor.x * Number(m[3]);
ok(`the point under the cursor stays put while zooming (drift ${Math.abs(screenX - anchor.x).toFixed(2)}px)`,
    Math.abs(screenX - anchor.x) < 0.6, zoomed());
bg.fire("dblclick", {});

console.log("\n-- avatars --");
const imgs = svg.querySelectorAll("image.xd-img");
const clips = svg.querySelectorAll("circle.xd-clip");
ok("an avatar image per node", imgs.length === 7, `got ${imgs.length}`);
ok("each avatar is clipped to a circle", clips.length === 7, `got ${clips.length}`);
ok("avatars request a small size", imgs.every(i2 => /\/(64|128)\.png$/.test(i2.getAttribute("href") || "")), imgs[0]?.getAttribute("href"));
// Regression: the clipPaths used to sit in a <defs> at the top of the SVG, so the
// sim's g.querySelector never found them, they stayed at the origin, and every
// avatar was clipped away to nothing. `+null` is 0 and Number.isFinite(0) is true,
// so the old assertion passed against null — compare to the real dot position.
const dots2 = svg.querySelectorAll("circle.xd-dot");
ok("every node group actually contains its clip circle", clips.length === dots2.length, `${clips.length} clips vs ${dots2.length} dots`);
ok("clip circles are positioned, not left at the origin",
    clips.every(c2 => c2.getAttribute("cx") !== null && (+c2.getAttribute("cx") !== 0 || +c2.getAttribute("cy") !== 0)),
    clips.map(c2 => c2.getAttribute("cx")).join(","));
ok("each clip circle sits exactly on its node",
    clips.every((c2, i2) => Math.abs(+c2.getAttribute("cx") - +dots2[i2].getAttribute("cx")) < 0.01
        && Math.abs(+c2.getAttribute("cy") - +dots2[i2].getAttribute("cy")) < 0.01));
ok("avatar images are placed over their node",
    imgs.every((im, i2) => {
        const r2 = +dots2[i2].getAttribute("r");
        return Math.abs(+im.getAttribute("x") + r2 - +dots2[i2].getAttribute("cx")) < 0.02;
    }));

console.log("\n-- hover pill --");
const pill = svg.querySelector("g.xd-pill");
// settle first: the reset above re-seeded positions, so read them after the sim runs
svg.fire("pointerleave", {});
flush(1200);
ok("pill hidden while nothing is hovered", pill.getAttribute("opacity") === "0", pill.getAttribute("opacity"));
const cur = { x: +hits[0].getAttribute("cx"), y: +hits[0].getAttribute("cy") };
svg.fire("pointerenter", {});
svg.fire("pointermove", { pointerId: 7, clientX: cur.x, clientY: cur.y });
flush(1);
const pname = () => pill.querySelector("text.xd-pill-name").textContent || "";
const psub = () => pill.querySelector("text.xd-pill-sub").textContent || "";
ok("hovering a node shows the pill", pill.getAttribute("opacity") === "1");
ok(`pill names the user (${pname()})`, pname() === "user_c0", pname());
ok(`pill shows time in call (${psub()})`, /in call/.test(psub()), psub());
ok("pill says friends or call-only", /friends|call only/.test(psub()), psub());
svg.fire("pointerleave", {});
flush(2);
ok("leaving the graph hides the pill", pill.getAttribute("opacity") === "0", pill.getAttribute("opacity"));

console.log("\n-- friend vs call-only rings --");
const rings = svg.querySelectorAll("circle.xd-ring");
ok("a ring per node", rings.length === 7, `got ${rings.length}`);
// the shim reports only "b" as a mutual friend of target "T"
ok("a proven mutual friend gets the friend ring", rings[1].getAttribute("stroke") === "gold", rings[1].getAttribute("stroke"));
ok("a call-only companion gets the plain ring", rings[0].getAttribute("stroke") === "grey", rings[0].getAttribute("stroke"));

console.log("\n-- unmount stops the loop --");
svg.fire("pointerleave", {});
flush(50);
cleanup();
const queuedAfter = q.length;
flush(5);
ok("cleanup cancels the animation loop", q.length === 0, `${queuedAfter} -> ${q.length}`);
const frozen = at();
svg.fire("pointermove", { pointerId: 9, clientX: 10, clientY: 10 });
flush(10);
ok("no listeners left after unmount", JSON.stringify(at()) === JSON.stringify(frozen));

console.log("\n-- empty dossier renders nothing --");
remount();
ok("no companions -> null", NetworkGraph({ targetId: "T", view: { companions: {}, guilds: {}, updated: 0, firstSeen: 0 } }) === null);

console.log("\n-- one-person view keeps its companions well clear of the centre --");
// Regression: making link length adapt to node count for the big full-graph view
// also shrank the ego view's spokes, bunching everyone on top of the target.
for (const count of [4, 8, 16]) {
    const m2 = mount(count);
    const sv2 = m2.svg;
    const hh2 = sv2.querySelectorAll("circle.xd-hit");
    flush(1500);
    const pts2 = hh2.map(e => ({ x: +e.getAttribute("cx"), y: +e.getAttribute("cy") }));
    const centre2 = pts2[pts2.length - 1];
    const radii = pts2.slice(0, count).map(p2 => Math.hypot(p2.x - centre2.x, p2.y - centre2.y));
    const minR = Math.min(...radii);
    // 82.5px is what the pre-regression code gave the STRONGEST companion (they rest
    // closest on purpose); the bug had them bunched at roughly half that.
    ok(`${count} companions sit clear of the target (nearest ${minR.toFixed(0)}px, pre-regression floor 82)`,
        minR > 80, `nearest ${minR.toFixed(0)}px`);
    let near = Infinity;
    for (let i = 0; i < pts2.length; i++) for (let j = i + 1; j < pts2.length; j++) near = Math.min(near, Math.hypot(pts2[i].x - pts2[j].x, pts2[i].y - pts2[j].y));
    ok(`${count} companions do not crowd each other (closest ${near.toFixed(0)}px)`, near > 24, `closest ${near.toFixed(0)}px`);
    ok(`${count} companions stay on canvas`, pts2.every(p2 => p2.x > -40 && p2.x < 640 && p2.y > -40 && p2.y < 500));
    m2.cleanup();
}

console.log("\n-- full dossier: everyone, wired together --");
const prof = (comps) => ({ companions: Object.fromEntries(Object.entries(comps).map(([k, v]) => [k, { count: v, ms: 1000, last: 1 }])), guilds: {}, updated: 0, firstSeen: 0 });
setProfiles({
    T: prof({ a: 5, b: 3 }),
    a: prof({ T: 5, b: 2, c: 1 }),   // 'a' also records T — the pair must not double up
    b: prof({ T: 3, a: 2 }),
    c: prof({ a: 1 })
});
let g2 = buildFullGraph(60);
ok("every recorded person becomes a node", g2.ids.sort().join(",") === "T,a,b,c", g2.ids.join(","));
const pairs = g2.links.map(l => [g2.ids[l.a], g2.ids[l.b]].sort().join("-")).sort();
ok("each pair appears exactly once", pairs.join(",") === "T-a,T-b,a-b,a-c", pairs.join(","));
ok("the stronger of two records of a pair wins", g2.links.find(l => [g2.ids[l.a], g2.ids[l.b]].sort().join("-") === "T-a").w === 5);
ok("link indices are all in range", g2.links.every(l => g2.ids[l.a] && g2.ids[l.b]));
ok("connection strength counts both directions", (g2.strength.get("a") ?? 0) > (g2.strength.get("c") ?? 0));

g2 = buildFullGraph(2);
ok("the cap keeps only the best-connected", g2.ids.length === 2, g2.ids.join(","));
ok("no link points outside the capped set", g2.links.every(l => l.a < 2 && l.b < 2));

setProfiles({ x: prof({}) });
ok("nobody with recorded calls -> empty", buildFullGraph().ids.length === 0);
setProfiles({});
remount();
ok("no profiles at all -> FullGraph renders nothing", FullGraph() === null);

console.log("\n-- full graph renders and simulates --");
setProfiles({ T: prof({ a: 5, b: 3 }), a: prof({ b: 2, c: 4 }), b: prof({ c: 1 }), c: prof({}) });
remount();
const fsvg = asSvg(FullGraph());
const fclean = effects.map(fn => fn()).filter(f => typeof f === "function");
const fhits = fsvg.querySelectorAll("circle.xd-hit");
const flines = fsvg.querySelectorAll("line[data-i]");
ok("a node per person", fhits.length === 4, `got ${fhits.length}`);
ok("a line per unique pair", flines.length === 5, `got ${flines.length}`);
flush(800);
const fp = fhits.map(e => ({ x: +e.getAttribute("cx"), y: +e.getAttribute("cy") }));
ok("all positions finite", fp.every(p2 => Number.isFinite(p2.x) && Number.isFinite(p2.y)), JSON.stringify(fp));
let closest = Infinity;
for (let i = 0; i < fp.length; i++) for (let j = i + 1; j < fp.length; j++) closest = Math.min(closest, Math.hypot(fp[i].x - fp[j].x, fp[i].y - fp[j].y));
ok(`nodes don't overlap (closest ${closest.toFixed(1)}px)`, closest > 12);
ok("stays on canvas", fp.every(p2 => p2.x > -60 && p2.x < 660 && p2.y > -60 && p2.y < 520), JSON.stringify(fp));
ok("edges got endpoints from both ends", flines.every(l => Number.isFinite(+l.getAttribute("x1")) && Number.isFinite(+l.getAttribute("x2"))));
fclean.forEach(f => f());

console.log("\n-- big webs: the node cap is honoured and stays legible --");
function bigWeb(people) {
    const p = {};
    for (let i = 0; i < people; i++) {
        const comps = {};
        for (let k = 1; k <= 3; k++) comps["p" + ((i + k * 7) % people)] = 1 + (i % 5);
        p["p" + i] = prof(comps);
    }
    return p;
}
function renderFull(people, limit) {
    settings.store.fullGraphNodes = limit;
    setProfiles(bigWeb(people));
    remount();
    const sv = asSvg(FullGraph());
    const cl = effects.map(f => f()).filter(f => typeof f === "function");
    flush(1400);
    const hh = sv.querySelectorAll("circle.xd-hit");
    const pts = hh.map(e => ({ x: +e.getAttribute("cx"), y: +e.getAttribute("cy"), r: +e.getAttribute("r") }));
    const vb = sv.getAttribute("viewBox").split(" ").map(Number);
    let close = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) close = Math.min(close, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    const labels = sv.querySelectorAll("text.xd-label").length;
    cl.forEach(f => f());
    return { n: pts.length, pts, vb, close, labels };
}

const r60 = renderFull(400, 60);
ok(`limit 60 draws 60 (was the old hard cap)`, r60.n === 60, `got ${r60.n}`);
const r150 = renderFull(400, 150);
ok(`limit 150 draws 150`, r150.n === 150, `got ${r150.n}`);
const r300 = renderFull(400, 300);
ok(`limit 300 draws 300`, r300.n === 300, `got ${r300.n}`);
ok(`a bigger web gets a taller canvas (${r60.vb[3]} -> ${r300.vb[3]}px)`, r300.vb[3] > r60.vb[3]);
ok(`300 nodes still do not overlap (closest ${r300.close.toFixed(1)}px)`, r300.close > 6, `closest ${r300.close.toFixed(1)}`);
ok("300 nodes all finite", r300.pts.every(p2 => Number.isFinite(p2.x) && Number.isFinite(p2.y)));
const inFrame = r300.pts.filter(p2 => p2.x > -80 && p2.x < r300.vb[2] + 80 && p2.y > -80 && p2.y < r300.vb[3] + 80).length;
ok(`300 nodes stay on canvas (${inFrame}/300)`, inFrame >= 295, `${inFrame}/300 in frame`);
// labels are hover-only now (persistent text removed), so no node carries one
ok(`no persistent labels are rendered (${r60.labels} at 60, ${r300.labels} at 300)`, r60.labels === 0 && r300.labels === 0);
ok("dots shrink as the web grows", Math.max(...r300.pts.map(p2 => p2.r)) < Math.max(...r60.pts.map(p2 => p2.r)));
ok("asking for more than exists is capped by reality", renderFull(25, 300).n === 25);

console.log("\n-- big graphs offload to the dashboard instead of lagging Discord --");
// Above heavyGraphNodes, FullGraph must NOT render the animated svg; it shows a
// card with an "Open in dashboard" button instead.
settings.store.heavyGraphNodes = 40;
settings.store.fullGraphNodes = 150;
setProfiles(bigWeb(400));
remount();
const offloadRoot = FullGraph();
const cl2 = effects.map(fn => fn()).filter(f => typeof f === "function");
const offSvg = offloadRoot?.querySelector?.("svg") ?? (offloadRoot?.tag === "svg" ? offloadRoot : null);
const offHits = offloadRoot?.querySelectorAll?.("circle.xd-hit") ?? [];
ok("no animated graph is rendered above the threshold", !offSvg && offHits.length === 0);
// the card offers buttons (Open in dashboard / render here) instead of a graph
const offBtns = offloadRoot?.querySelectorAll?.("button") ?? [];
ok("the offload card shows action buttons instead of a graph", offBtns.length >= 1, `${offBtns.length} buttons`);
ok("no animation loop was started (nothing to lag)", q.length === 0, `${q.length} frames queued`);
cl2.forEach(f => f());
// ...and just under the threshold it still renders in Discord
settings.store.heavyGraphNodes = 1e9;
ok("below the threshold it still renders the graph in Discord", renderFull(30, 30).n === 30);
settings.store.heavyGraphNodes = 1e9;
settings.store.fullGraphNodes = 150;

console.log("\n-- the graph must not open as a pile in the middle --");
// Regression: every node was seeded on ONE ring, so a big graph started as a solid
// clump (measured 401 overlapping pairs at 150 nodes) that visibly exploded outward.
function pileAfter(people, limit, frames) {
    settings.store.fullGraphNodes = limit;
    setProfiles(bigWeb(people));
    remount();
    const sv = asSvg(FullGraph());
    const cl = effects.map(f => f()).filter(f => typeof f === "function");
    flush(frames);
    const pts = sv.querySelectorAll("circle.xd-hit").map(e => ({ x: +e.getAttribute("cx"), y: +e.getAttribute("cy") }));
    let piled = 0;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++)
        if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < 16) piled++;
    cl.forEach(f => f());
    return piled;
}
// The bug: a single seed ring opened every graph as a solid clump (measured 1144
// overlapping pairs at 300 nodes) that visibly exploded outward.
ok(`60 nodes open completely clean (${pileAfter(400, 60, 1)} piled)`, pileAfter(400, 60, 1) === 0);
ok(`150 nodes open completely clean (${pileAfter(400, 150, 1)} piled)`, pileAfter(400, 150, 1) === 0);
// 300 is the extreme cap; its dense core needs a moment but is a fraction of the old clump...
const p300open = pileAfter(400, 300, 1);
ok(`300 nodes open ~50x better than the old 1144-pair clump (${p300open} piled)`, p300open < 40, `${p300open} piled`);
// ...and it clears as the sim runs, so the user never sees a lasting clump
ok(`300 nodes fully separate as it settles (${pileAfter(400, 300, 200)} piled)`, pileAfter(400, 300, 200) === 0);
settings.store.fullGraphNodes = 150;
settings.store.fullGraphNodes = 150;

console.log("\n-- interconnected friend groups: the EDGE count must stay bounded --");
// Regression: the cap bounds how many NODES are drawn, but in a friend group where
// everyone knows everyone the EDGE count grows with the SQUARE of the group size.
// 1000 people in two 500-person cliques is 249,501 edges. Nothing bounded that, so
// the view tried to draw a quarter of a million <line>s, and
// `Math.max(...links.map(l => l.w), 1)` spread them all as function arguments —
// past ~125k that throws RangeError and the whole graph renders as nothing.
function cliques(groups, size) {
    const p = {};
    for (let g = 0; g < groups; g++) {
        for (let i = 0; i < size; i++) {
            const comps = {};
            for (let j = 0; j < size; j++) if (j !== i) comps[`g${g}u${j}`] = 1 + ((i + j) % 4);
            if (i === 0 && g + 1 < groups) comps[`g${g + 1}u0`] = 1; // one bridge, so it's one web
            p[`g${g}u${i}`] = prof(comps);
        }
    }
    return p;
}

setProfiles(cliques(2, 500));
const dense = buildFullGraph(1000);
ok(`1000 people in dense groups all become nodes (${dense.ids.length})`, dense.ids.length === 1000, `${dense.ids.length}`);
ok(`edges stay bounded rather than quadratic (${dense.links.length}, was 249501)`,
    dense.links.length <= dense.ids.length * 8, `${dense.links.length} edges for ${dense.ids.length} nodes`);
ok("the prune leaves nobody stranded without a single edge",
    new Set(dense.links.flatMap(l => [l.a, l.b])).size === dense.ids.length,
    `${new Set(dense.links.flatMap(l => [l.a, l.b])).size}/${dense.ids.length} nodes still connected`);
// Pruning must keep what matters: whoever you share the most calls with.
{
    const full = new Map(); // node -> strongest edge weight available to it
    setProfiles(cliques(2, 500));
    for (const [id, p2] of Object.entries(cliques(2, 500))) {
        for (const [c, rec] of Object.entries(p2.companions)) {
            full.set(id, Math.max(full.get(id) ?? 0, rec.count));
            full.set(c, Math.max(full.get(c) ?? 0, rec.count));
        }
    }
    const kept = new Map();
    for (const l of dense.links) {
        kept.set(dense.ids[l.a], Math.max(kept.get(dense.ids[l.a]) ?? 0, l.w));
        kept.set(dense.ids[l.b], Math.max(kept.get(dense.ids[l.b]) ?? 0, l.w));
    }
    const lost = [...full.keys()].filter(id => (kept.get(id) ?? 0) < full.get(id));
    ok(`everyone keeps their strongest connection (${lost.length} lost it)`, lost.length === 0, lost.slice(0, 5).join(","));
}

// The real symptom: this used to throw and blank the graph.
settings.store.fullGraphNodes = 1000;
setProfiles(cliques(2, 500));
remount();
let denseThrew = null, denseSvg = null;
try {
    denseSvg = asSvg(FullGraph());
    const dcl = effects.map(f => f()).filter(f => typeof f === "function");
    flush(30);
    dcl.forEach(f => f());
} catch (e) { denseThrew = `${e.name}: ${e.message}`; }
ok("a dense 1000-person web renders without throwing", denseThrew === null, denseThrew);
if (!denseThrew) {
    const dLines = denseSvg.querySelectorAll("line[data-i]").length;
    const dNodes = denseSvg.querySelectorAll("circle.xd-hit").length;
    ok(`it draws a bounded number of edges (${dLines} for ${dNodes} nodes)`, dLines <= dNodes * 8, `${dLines} lines`);
    const dp = denseSvg.querySelectorAll("circle.xd-hit").map(e => ({ x: +e.getAttribute("cx"), y: +e.getAttribute("cy") }));
    ok("every node in the dense web has a real position", dp.every(p2 => Number.isFinite(p2.x) && Number.isFinite(p2.y)));
}
settings.store.fullGraphNodes = 150;

console.log("\n-- your own account must not be the hub of the everyone-view --");
// Regression: you are in every call you join, so you get recorded as a companion of
// nearly everyone. That made your own account a node wired to the whole cast — one
// node carrying hundreds of springs, which visibly exploded the layout outward.
setProfiles({
    ME: prof({ A: 9, B: 9, C: 9, D: 9 }),
    A: prof({ ME: 9, B: 2 }),
    B: prof({ ME: 9, A: 2, C: 1 }),
    C: prof({ ME: 9, B: 1 }),
    D: prof({ ME: 9 })
});
const noMe = buildFullGraph(150);
ok("you are not drawn as a node", !noMe.ids.includes("ME"), noMe.ids.join(","));
ok("no edge touches you", noMe.links.every(l => noMe.ids[l.a] !== "ME" && noMe.ids[l.b] !== "ME"));
ok("everyone else is still drawn", noMe.ids.slice().sort().join(",") === "A,B,C", noMe.ids.join(","));
// D only ever appeared alongside you, so with you gone it has no connection left
ok("your call-partners keep only their real links to each other",
    noMe.links.map(l => [noMe.ids[l.a], noMe.ids[l.b]].sort().join("-")).sort().join(",") === "A-B,B-C",
    noMe.links.map(l => [noMe.ids[l.a], noMe.ids[l.b]].sort().join("-")).sort().join(","));
// strength counts a pairing from both ends (see "counts both directions" above), so
// A is 2+2 and B is 2+2+1+1. The point here is that your own 9s are nowhere in them —
// unfiltered, A would carry 9+9 of pure you.
ok("your own inflated call counts do not size other people",
    (noMe.strength.get("A") ?? 0) === 4 && (noMe.strength.get("B") ?? 0) === 6,
    `A=${noMe.strength.get("A")} B=${noMe.strength.get("B")}`);
ok("the 'of N recorded' count excludes you too", totalKnownPeople() === 3, String(totalKnownPeople()));

console.log("\n-- swapping which edges survive must restart the simulation --");
// Regression (introduced by edge pruning, caught in review): simKey used to be
// "node ids + edge COUNT". Pruning keeps each person's strongest few links, so a
// single recorded call can swap which edge is kept while the count stays identical.
// React then unmounts one <line> and mounts another, but the layout effect — the only
// code that ever writes x1/y1/x2/y2 — would not re-run, leaving the new line at the
// origin as a stray dot with the physics still pulling on the detached old one.
{
    // a clique with well-separated weights, so one bump reorders somebody's top-6
    const mk = bump => {
        const p = {};
        for (let i = 0; i < 20; i++) {
            const comps = {};
            for (let j = 0; j < 20; j++) if (j !== i) comps["q" + j] = 1 + ((i * 7 + j * 13) % 40);
            p["q" + i] = prof(comps);
        }
        if (bump) p.q5.companions.q0 = { count: 999, ms: 1000, last: 1 };
        return p;
    };
    const keyOf = g => g.links.map(l => `${l.a}-${l.b}`).join(",");
    settings.store.fullGraphNodes = 150;
    setProfiles(mk(false));
    const g1 = buildFullGraph(150);
    setProfiles(mk(true));
    const g2 = buildFullGraph(150);
    ok(`one extra call swaps the kept edges without changing the count (${g1.links.length} vs ${g2.links.length})`,
        g1.links.length === g2.links.length && keyOf(g1) !== keyOf(g2),
        `counts ${g1.links.length}/${g2.links.length}, sets ${keyOf(g1) === keyOf(g2) ? "identical" : "differ"}`);
    // the real assertion: simKey must distinguish them, so the effect re-runs
    const simKeyOf = g => {
        let sig = g.links.length;
        for (const l of g.links) sig = (Math.imul(sig, 31) + Math.imul(l.a, 7919) + l.b) | 0;
        return g.ids.join(",") + "#" + g.links.length + "#" + sig;
    };
    ok("the simulation key notices the swap", simKeyOf(g1) !== simKeyOf(g2));
    // and prove the shipped component agrees with that formula
    const shipped = JS.slice(JS.indexOf("const simKey ="), JS.indexOf("const simKey =") + 200);
    ok("the component's simKey really does hash the edge pairs, not just count them",
        /linkSig/.test(shipped), shipped.split("\n")[0]);
}

console.log("\n-- a dense clique must be thinned even when the graph total looks modest --");
// Regression: the prune used to skip entirely when total edges <= nodes * 6, measured
// across the WHOLE graph. One 41-person everyone-knows-everyone group sitting among
// sparser people slipped under that total and kept all 820 of its edges (every node at
// degree 40), and adding one more person tipped it over and vanished hundreds at once.
{
    const withClique = size => {
        const p = {};
        for (let i = 0; i < size; i++) {
            const comps = {};
            for (let j = 0; j < size; j++) if (j !== i) comps["k" + j] = 2 + ((i + j) % 9);
            p["k" + i] = prof(comps);
        }
        for (let i = 0; i < 55; i++) p["s" + i] = prof({ ["s" + ((i + 1) % 55)]: 1 }); // sparse filler
        return p;
    };
    const degrees = g => {
        const d = new Map();
        for (const l of g.links) { d.set(l.a, (d.get(l.a) || 0) + 1); d.set(l.b, (d.get(l.b) || 0) + 1); }
        return d;
    };
    settings.store.fullGraphNodes = 150;
    setProfiles(withClique(41));
    const g41 = buildFullGraph(150);
    setProfiles(withClique(42));
    const g42 = buildFullGraph(150);
    const max41 = Math.max(...degrees(g41).values()), max42 = Math.max(...degrees(g42).values());
    ok(`a 41-person clique is thinned too (busiest node ${max41} edges, was 40)`, max41 < 25, `${max41}`);
    // no cliff: one more person must not make the picture lurch
    const ratio = g42.links.length / Math.max(1, g41.links.length);
    ok(`adding one person does not make the web lurch (${g41.links.length} -> ${g42.links.length} edges)`,
        ratio > 0.7 && ratio < 1.4, `${g41.links.length} -> ${g42.links.length}`);
    ok(`degree stays comparable across that step (${max41} vs ${max42})`, Math.abs(max41 - max42) <= 6);
    settings.store.fullGraphNodes = 150;
}

console.log("\n-- sparse, star-shaped dossiers must survive pruning untouched --");
// Pruning now always runs, so prove it is a no-op on the shape a normal user has:
// a few busy people, each surrounded by companions who know nobody else.
{
    const star = {};
    star.HOST = prof(Object.fromEntries(Array.from({ length: 30 }, (_, i) => ["m" + i, 3 + i])));
    for (let i = 0; i < 30; i++) star["m" + i] = prof({ HOST: 3 + i });
    setProfiles(star);
    const sg = buildFullGraph(150);
    ok(`a 30-spoke star keeps every spoke (${sg.links.length}/30)`, sg.links.length === 30, `${sg.links.length}`);
    ok("no companion is stranded", new Set(sg.links.flatMap(l => [l.a, l.b])).size === sg.ids.length);
}

console.log("\n-- one heavily-connected person must not blow the layout apart --");
// Regression: a node wired to everyone sums that many spring forces per frame, which
// feeds back and runs away. Measured before the per-frame step cap: coordinates in the
// billions (x reached -1.0e10) and 0/201 nodes left anywhere near the canvas. Removing
// your own account fixes the usual trigger; this makes the layout unable to diverge at
// all, for any shape of web.
{
    const p = { HUB: prof({}) };
    for (let i = 0; i < 200; i++) {
        // HUB is everyone's single strongest link, so it survives the edge prune and
        // keeps its full degree — exactly the runaway case.
        p["n" + i] = prof({ HUB: 9, ["n" + ((i + 7) % 200)]: 2 });
        p.HUB.companions["n" + i] = { count: 9, ms: 1000, last: 1 };
    }
    settings.store.fullGraphNodes = 300;
    setProfiles(p);
    const hg = buildFullGraph(300);
    const deg = new Map();
    for (const l of hg.links) { deg.set(l.a, (deg.get(l.a) || 0) + 1); deg.set(l.b, (deg.get(l.b) || 0) + 1); }
    const busiest = Math.max(...deg.values());
    ok(`the hub really is a hub (${busiest} edges on one node)`, busiest >= 100, `busiest ${busiest}`);
    remount();
    const hsvg = asSvg(FullGraph());
    const hcl = effects.map(f => f()).filter(f => typeof f === "function");
    flush(600);
    const hpts = hsvg.querySelectorAll("circle.xd-hit").map(e => ({ x: +e.getAttribute("cx"), y: +e.getAttribute("cy") }));
    const hvb = hsvg.getAttribute("viewBox").split(" ").map(Number);
    hcl.forEach(f => f());
    ok("every position stays finite", hpts.every(p2 => Number.isFinite(p2.x) && Number.isFinite(p2.y)));
    const worst = Math.max(...hpts.map(p2 => Math.max(Math.abs(p2.x), Math.abs(p2.y))));
    ok(`nothing runs away to infinity (furthest coordinate ${Math.round(worst)}, was ~1e10)`, worst < 5000, `worst ${worst}`);
    const onCanvas = hpts.filter(p2 => p2.x > -80 && p2.x < hvb[2] + 80 && p2.y > -80 && p2.y < hvb[3] + 80).length;
    ok(`the web stays on the canvas (${onCanvas}/${hpts.length}, was 0/201)`, onCanvas === hpts.length, `${onCanvas}/${hpts.length}`);
    settings.store.fullGraphNodes = 150;
}

console.log("\n-- right-click re-centres, and the person you came from stays as a ghost --");
{
    const viewOf = comps => ({
        companions: Object.fromEntries(Object.entries(comps).map(([k, v]) => [k, { count: v, ms: 1000 * v, last: 1 }])),
        guilds: {}, updated: 0, firstSeen: 0
    });
    // OLD is the person we started on; NEW is one of their companions, and the two
    // share companion "shared" — exactly the overlap the dedupe has to survive.
    const oldView = viewOf({ NEW: 9, o1: 5, o2: 3, shared: 4 });
    const newView = viewOf({ n1: 7, n2: 6, shared: 2 });

    remount();
    let recentred = null;
    const sv = asSvg(NetworkGraph({
        targetId: "NEW", view: newView,
        ghostId: "OLD", ghostView: oldView,
        onRecentre: id => { recentred = id; }
    }));
    const cl = effects.map(f => f()).filter(f => typeof f === "function");
    flush(600);

    const groups = sv.querySelectorAll("g[data-i]");
    const idOf = g => g.querySelector("circle.xd-hit");
    // NEW + n1/n2/shared solid; OLD + o1/o2 faded. "NEW" and "shared" appear in BOTH
    // networks and must be drawn once, solid — they are live companions, not history.
    ok(`both networks are drawn together (${groups.length} nodes)`, groups.length === 7, `${groups.length}`);
    const dimmed = groups.filter(g => g.getAttribute("opacity") === "0.3");
    const solid = groups.filter(g => g.getAttribute("opacity") !== "0.3");
    ok(`the old subject's side is faded (${dimmed.length} dim, ${solid.length} solid)`,
        dimmed.length === 3 && solid.length === 4, `${dimmed.length}/${solid.length}`);

    // nobody may be drawn twice, however much the two networks overlap
    const dots = sv.querySelectorAll("circle.xd-dot");
    ok("one node per person, despite the shared companion", dots.length === groups.length, `${dots.length} vs ${groups.length}`);

    // the ghost's edges are faded, the live ones are not
    const lines = sv.querySelectorAll("line[data-i]");
    const ops = lines.map(l => +l.getAttribute("stroke-opacity"));
    // 3 live spokes (n1/n2/shared -> NEW) + 4 ghost spokes (NEW/o1/o2/shared -> OLD)
    ok(`edges exist for both networks (${lines.length})`, lines.length === 7, `${lines.length}`);
    ok(`ghost edges are drawn fainter (min ${Math.min(...ops).toFixed(2)} vs max ${Math.max(...ops).toFixed(2)})`,
        Math.min(...ops) < Math.max(...ops) * 0.5, ops.map(o => o.toFixed(2)).join(","));

    // right-clicking a node asks to re-centre on them
    const hits = sv.querySelectorAll("circle.xd-hit");
    let prevented = false;
    hits[0].fire("contextmenu", {
        preventDefault() { prevented = true; }, stopPropagation() { }, currentTarget: hits[0]
    });
    ok(`right-click re-centres on that person (${recentred})`, recentred !== null, `got ${recentred}`);
    ok("and it suppresses the browser menu", prevented);

    // REGRESSION: the FULL right-click sequence (pointerdown button:2 + contextmenu +
    // pointerup) used to also open the profile, because the pointerdown started a drag
    // and the pointerup opened it. Right-click must re-centre ONLY.
    openedProfile = null; recentred = null;
    const rp = { x: +hits[0].getAttribute("cx"), y: +hits[0].getAttribute("cy") };
    hits[0].fire("pointerdown", { button: 2, preventDefault() { }, stopPropagation() { }, pointerId: 30, clientX: rp.x, clientY: rp.y, currentTarget: hits[0] });
    hits[0].fire("contextmenu", { preventDefault() { }, stopPropagation() { }, currentTarget: hits[0] });
    sv.fire("pointerup", { button: 2, pointerId: 30, clientX: rp.x, clientY: rp.y });
    ok(`right-click does NOT open the profile (opened=${openedProfile})`, openedProfile === null, `opened ${openedProfile}`);
    ok("right-click still re-centres", recentred !== null);

    // and a right-click on the background must not pan or open anything either
    openedProfile = null;
    const bgEl = sv.querySelector("rect.xd-bg");
    const rootG2 = sv.children.find(c => c.tag === "g" && c.children.some(k => k.tag === "g" || k.tag === "line"));
    const tf0 = rootG2.getAttribute("transform") || "";
    bgEl.fire("pointerdown", { button: 2, preventDefault() { }, pointerId: 31, clientX: 500, clientY: 400 });
    sv.fire("pointermove", { pointerId: 31, clientX: 300, clientY: 200 });
    sv.fire("pointerup", { button: 2, pointerId: 31, clientX: 300, clientY: 200 });
    ok("right-click on the background does not pan", (rootG2.getAttribute("transform") || "") === tf0, `${rootG2.getAttribute("transform")}`);
    ok("right-click on the background opens nothing", openedProfile === null);

    // a single left-click only grabs (no open); double-click opens, not re-centre
    openedProfile = null; recentred = null;
    flush(200);
    const p0 = { x: +hits[0].getAttribute("cx"), y: +hits[0].getAttribute("cy") };
    hits[0].fire("pointerdown", { preventDefault() { }, stopPropagation() { }, pointerId: 21, clientX: p0.x, clientY: p0.y, currentTarget: hits[0] });
    sv.fire("pointerup", { pointerId: 21, clientX: p0.x, clientY: p0.y });
    ok(`a single left-click does not open (${openedProfile})`, openedProfile === null, `opened=${openedProfile}`);
    hits[0].fire("dblclick", { preventDefault() { }, stopPropagation() { }, currentTarget: hits[0] });
    ok(`double-click opens the profile, not re-centre (${openedProfile})`, openedProfile !== null && recentred === null,
        `opened=${openedProfile} recentred=${recentred}`);

    // you can right-click the faded person to walk back
    recentred = null;
    const ghostHit = groups.filter(g => g.getAttribute("opacity") === "0.3").map(idOf)[0];
    ghostHit.fire("contextmenu", { preventDefault() { }, stopPropagation() { }, currentTarget: ghostHit });
    ok("the faded side is still interactive, so you can walk back", recentred !== null, `${recentred}`);
    cl.forEach(f => f());
}

console.log("\n-- re-centring onto someone with no history must clear the graph --");
// Regression: the ghost alone was enough to keep drawing. Right-clicking someone with
// nothing recorded left the PREVIOUS person's faded web on screen with a lone dot for
// the new subject — which reads as "here is their network" when it is the opposite.
{
    const viewOf = comps => ({
        companions: Object.fromEntries(Object.entries(comps).map(([k, v]) => [k, { count: v, ms: 1000 * v, last: 1 }])),
        guilds: {}, updated: 0, firstSeen: 0
    });
    remount();
    const empty = NetworkGraph({
        targetId: "NOHISTORY", view: viewOf({}),
        ghostId: "OLD", ghostView: viewOf({ o1: 5, o2: 3 }),
        onRecentre: () => { }
    });
    ok("a subject with nothing recorded draws nothing at all, ghost or not", empty === null,
        empty === null ? "" : `${asSvg(empty).querySelectorAll("g[data-i]").length} nodes still drawn`);

    // and with no ghost either
    remount();
    ok("still nothing when there is no ghost to fall back on",
        NetworkGraph({ targetId: "NOHISTORY", view: viewOf({}) }) === null);

    // but the moment the subject has even one companion, it draws again — with the ghost
    remount();
    const one = NetworkGraph({
        targetId: "NEW", view: viewOf({ n1: 2 }),
        ghostId: "OLD", ghostView: viewOf({ o1: 5, o2: 3 }),
        onRecentre: () => { }
    });
    ok("one real companion is enough to bring the graph back", one !== null);
    if (one) {
        const g = asSvg(one).querySelectorAll("g[data-i]");
        effects.map(f => f()).filter(f => typeof f === "function");
        ok(`and the ghost comes with it (${g.length} nodes: NEW, n1, OLD, o1, o2)`, g.length === 5, `${g.length}`);
        ok("with the old side still faded", g.filter(x => x.getAttribute("opacity") === "0.3").length === 3,
            `${g.filter(x => x.getAttribute("opacity") === "0.3").length} dim`);
    }
}

console.log("\n-- with no ghost it is exactly the old single-person view --");
{
    remount();
    const plain = asSvg(NetworkGraph({
        targetId: "T",
        view: { companions: { a: { count: 3, ms: 10, last: 1 }, b: { count: 2, ms: 5, last: 1 } }, guilds: {}, updated: 0, firstSeen: 0 }
    }));
    effects.map(f => f()).filter(f => typeof f === "function").forEach(f => f());
    ok("just the subject and their companions", plain.querySelectorAll("g[data-i]").length === 3);
    ok("nothing is faded", plain.querySelectorAll("g[data-i]").every(g => g.getAttribute("opacity") !== "0.3"));
}

console.log("\n-- new call data must slot in, not restart the layout --");
// The whole complaint: sitting with the Dossier open, someone gets seen in a call, the
// cast changes, the layout effect restarts — and the entire web was re-seeded from a
// cold spiral while your zoom snapped back to default. New people should be fitted in
// beside whoever they call with, leaving everything else exactly where it was.
{
    const web = extra => {
        const p = {};
        for (let i = 0; i < 40; i++) {
            const comps = {};
            for (let k = 1; k <= 3; k++) comps["w" + ((i + k * 7) % 40)] = 2 + (i % 4);
            p["w" + i] = prof(comps);
        }
        // a newcomer, seen with an existing person
        if (extra) { p.NEWBIE = prof({ w3: 5 }); p.w3.companions.NEWBIE = { count: 5, ms: 1000, last: 1 }; }
        return p;
    };
    settings.store.fullGraphNodes = 150;
    remount();
    setProfiles(web(false));
    let svg1 = asSvg(FullGraph());
    let cl = effects.map(f => f()).filter(f => typeof f === "function");
    flush(900);
    const posOf = sv => {
        const m = new Map();
        sv.querySelectorAll("g[data-i]").forEach(g => {
            const hit = g.querySelector("circle.xd-hit");
            if (hit) m.set(g.attrs["data-i"], { x: +hit.getAttribute("cx"), y: +hit.getAttribute("cy") });
        });
        return m;
    };
    const g1ids = buildFullGraph(150).ids;
    const before = posOf(svg1);
    // pan and zoom somewhere deliberate, as a user reading a corner of the web would
    const bg1 = svg1.querySelector("rect.xd-bg");
    bg1.fire("pointerdown", { preventDefault() { }, pointerId: 1, clientX: 0, clientY: 0 });
    svg1.fire("pointermove", { pointerId: 1, clientX: 60, clientY: 35 });
    svg1.fire("pointerup", { pointerId: 1 });
    svg1.fire("wheel", { preventDefault() { }, deltaY: -100, clientX: 300, clientY: 230 });
    const rootOf = sv => sv.children.find(c => c.tag === "g" && c.children.some(k => k.tag === "g" || k.tag === "line"));
    const viewBefore = rootOf(svg1).getAttribute("transform");

    // ---- new call data arrives; same component instance re-renders ----
    cl.forEach(f => f());                    // React cleanup for the old effect
    setProfiles(web(true));
    effects = []; rerender();                 // NOT remount: same instance, new data
    const svg2 = asSvg(FullGraph());
    const cl2 = effects.map(f => f()).filter(f => typeof f === "function");
    const g2ids = buildFullGraph(150).ids;
    ok("the newcomer really did join the cast", g2ids.includes("NEWBIE") && !g1ids.includes("NEWBIE"));

    const after = posOf(svg2);
    // compare by person, since indices shift when the cast changes
    let moved = 0, worst = 0, compared = 0;
    for (const [i1, p1] of before) {
        const id = g1ids[+i1];
        const i2 = g2ids.indexOf(id);
        if (i2 < 0) continue;
        const p2 = after.get(String(i2));
        if (!p2) continue;
        compared++;
        const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (d > worst) worst = d;
        if (d > 1) moved++;
    }
    ok(`existing people were compared (${compared})`, compared > 30, `${compared}`);
    ok(`nobody already on screen jumped (worst move ${worst.toFixed(2)}px)`, worst < 1, `worst ${worst.toFixed(2)}px`);
    ok(`the layout is not re-seeded (${moved} of ${compared} moved at all)`, moved === 0, `${moved} moved`);
    ok("your pan and zoom survived the update",
        rootOf(svg2).getAttribute("transform") === viewBefore,
        `${viewBefore} -> ${rootOf(svg2).getAttribute("transform")}`);

    // the newcomer must land beside the person they call with, not at a spiral slot
    const nIdx = g2ids.indexOf("NEWBIE"), w3Idx = g2ids.indexOf("w3");
    const nPos = after.get(String(nIdx)), w3Pos = after.get(String(w3Idx));
    const gap = Math.hypot(nPos.x - w3Pos.x, nPos.y - w3Pos.y);
    ok(`the newcomer is dropped beside their contact (${gap.toFixed(0)}px away)`, gap < 140, `${gap.toFixed(0)}px`);
    ok("the newcomer has a real position", Number.isFinite(nPos.x) && Number.isFinite(nPos.y));

    // and it must still settle rather than sit frozen
    flush(400);
    const settled = posOf(svg2);
    ok("the graph is still live after an incremental update",
        [...settled.values()].every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
    cl2.forEach(f => f());
}

console.log("\n-- 'Reset view' is still a real reset --");
{
    remount();
    setProfiles({ T: prof({ a: 5, b: 3 }), a: prof({ b: 2, c: 4 }), b: prof({ c: 1 }), c: prof({}) });
    const sv = asSvg(FullGraph());
    const cl = effects.map(f => f()).filter(f => typeof f === "function");
    flush(600);
    const bg = sv.querySelector("rect.xd-bg");
    const root = sv.children.find(c => c.tag === "g" && c.children.some(k => k.tag === "g" || k.tag === "line"));
    bg.fire("pointerdown", { preventDefault() { }, pointerId: 2, clientX: 0, clientY: 0 });
    sv.fire("pointermove", { pointerId: 2, clientX: 50, clientY: 25 });
    sv.fire("pointerup", { pointerId: 2 });
    ok("panned away from the origin", /translate\(5[0-9.]*,\s*2[0-9.]*\)/.test(root.getAttribute("transform")), root.getAttribute("transform"));
    bg.fire("dblclick", {});
    ok("reset still returns the view to default",
        /translate\(0,0\)\s*scale\(1\)/.test(root.getAttribute("transform")), root.getAttribute("transform"));
    cl.forEach(f => f());
}

console.log("\n-- dragging a node must not fling the web apart --");
// Reported: in the full dossier, grabbing someone and moving them makes the whole graph
// explode outward. The spring force is (distance - rest) * k, which is UNBOUNDED in
// distance — drag a node a thousand pixels and every spring on it applies forty times
// its normal pull, and that energy propagates through the web.
{
    // DENSE, like the real data: tight friend groups rather than the sparse
    // 3-companion fixture. A dense web has many more springs per node, so an unbounded
    // spring force has far more paths along which to propagate.
    settings.store.fullGraphNodes = 140;
    setProfiles(cliques(4, 40));
    remount();
    const sv = asSvg(FullGraph());
    const cl = effects.map(f => f()).filter(f => typeof f === "function");
    flush(600);                                   // let it settle first
    const hits = sv.querySelectorAll("circle.xd-hit");
    const vb = sv.getAttribute("viewBox").split(" ").map(Number);
    const at = () => hits.map(e => ({ x: +e.getAttribute("cx"), y: +e.getAttribute("cy") }));
    const spread = pts => {
        const xs = pts.map(p2 => p2.x), ys = pts.map(p2 => p2.y);
        return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    };
    const settled = at();
    const before = spread(settled);
    ok(`the web is compact before the drag (${Math.round(before)}px across)`, before < 2000, String(Math.round(before)));

    // Zoom OUT first, as anyone looking at a 140-node web does. local() divides the
    // pointer position by the zoom, so at 0.35x a short finger movement becomes a jump
    // ~3x larger in graph space — and the spring force is unbounded in distance.
    for (let k = 0; k < 14; k++) sv.fire("wheel", { preventDefault() { }, deltaY: 100, clientX: 300, clientY: 230 });
    flush(80);

    // grab one and haul it a long way, as a real drag across the canvas does
    const start = settled[0];
    hits[0].fire("pointerdown", {
        preventDefault() { }, stopPropagation() { }, pointerId: 71,
        clientX: start.x, clientY: start.y, currentTarget: hits[0]
    });
    for (let k = 0; k < 40; k++) {
        sv.fire("pointermove", { pointerId: 71, clientX: 40 + k * 12, clientY: 30 + k * 9 });
        flush(1);
    }
    sv.fire("pointerup", { pointerId: 71, clientX: 520, clientY: 400 });
    flush(400);

    const after = at();
    const now = spread(after);
    ok("every node still has a real position", after.every(p2 => Number.isFinite(p2.x) && Number.isFinite(p2.y)));
    ok(`the web does not blow up while dragging (${Math.round(before)} -> ${Math.round(now)}px across)`,
        now < before * 3 + 600, `${Math.round(before)} -> ${Math.round(now)}`);
    const worst = Math.max(...after.map(p2 => Math.max(Math.abs(p2.x), Math.abs(p2.y))));
    ok(`nothing is flung off to nowhere (furthest ${Math.round(worst)})`, worst < 6000, String(Math.round(worst)));
    const onCanvas = after.filter(p2 => p2.x > -400 && p2.x < vb[2] + 400 && p2.y > -400 && p2.y < vb[3] + 400).length;
    ok(`most of the web stays near the canvas (${onCanvas}/${after.length})`,
        onCanvas >= after.length * 0.9, `${onCanvas}/${after.length}`);
    cl.forEach(f => f());
    settings.store.fullGraphNodes = 150;
}

console.log("\n-- a data update must not tear down the layout mid-drag --");
// This is what "it flings apart when I drag someone" was: the modal re-renders every
// four seconds and sync changes the cast constantly, so simKey changed DURING a drag,
// the layout effect tore down, the new closure had no `drag`, the node stopped following
// the pointer, and a freshly re-warmed simulation reshuffled under the user's finger.
{
    const src = extract("ForceGraph", SRC).replace(/\/\/[^\n]*/g, "");
    ok("the layout is keyed off liveKey, not simKey directly",
        /\}, \[liveKey\]\)/.test(src) && !/\}, \[simKey\]\)/.test(src), "still keyed on simKey");
    ok("a drag sets the freeze", /draggingRef\.current = true/.test(src));
    ok("and pointerup always clears it, drag or not",
        /if \(draggingRef\.current\) \{\s*draggingRef\.current = false;/.test(src),
        "the flag is only cleared inside `if (drag)`, so a click would freeze it forever");
    ok("the deferred key is applied when the drag ends",
        /setLiveKey\(latestKey\.current\)/.test(src));
    // the guard must not stop ordinary updates when nothing is being dragged
    ok("an update with no drag in progress still applies immediately",
        /if \(draggingRef\.current\) return;/.test(src) && /setLiveKey\(simKey\)/.test(src));
}

console.log("\n-- a new companion asks for a wider set, it does not force a rebuild --");
// The propagation walk is breadth-first over the whole call graph, and trackedSet() runs
// on EVERY voice-state update — so forcing a rebuild the moment a new companion appeared
// made it churn nonstop in a busy group. Marking it never, though, strands newly-seen
// people: they stay a line in someone else's profile and never get a log of their own.
// The settled design is "request a refresh, walk at most once a minute".
// Comments stripped, so prose about trackedDirty can't satisfy or trip these checks.
const reconcileSrc = extract("reconcile", SRC).replace(/\/\/[^\n]*/g, "");
ok("reconcile() never forces a rebuild itself",
    !/trackedDirty/.test(reconcileSrc), "reconcile still writes trackedDirty directly");
ok("but it does flag that the call graph grew",
    /noteCallGraphGrew\(\)/.test(reconcileSrc), "reconcile no longer asks for a refresh at all");
ok("and a new companion is still recorded, and can still toast",
    /rec\.count\s*\+=\s*1/.test(reconcileSrc) && /isNew/.test(reconcileSrc));

const trackedSetSrc = extract("trackedSet", SRC).replace(/\/\/[^\n]*/g, "");
ok("trackedSet() throttles the requested rebuild rather than ignoring it",
    /retrackWanted/.test(trackedSetSrc) && /RETRACK_INTERVAL/.test(trackedSetSrc), trackedSetSrc.trim());
ok("an urgent rebuild (trait/settings change) still happens immediately",
    /if\s*\(trackedDirty\)\s*recomputeTracked\(\)/.test(trackedSetSrc));
ok("the throttle window is a sane length (>=10s, <=5min)", (() => {
    const ms = Number(/RETRACK_INTERVAL\s*=\s*([\d_]+)/.exec(SRC)?.[1].replace(/_/g, ""));
    return ms >= 10_000 && ms <= 300_000;
})(), /RETRACK_INTERVAL\s*=\s*([\d_]+)/.exec(SRC)?.[1]);
// The set must still be rebuilt promptly by the things that genuinely reseed it
ok("the Target trait and the propagation settings still rebuild it at once",
    /onWatchChanged\s*=\s*\(\)\s*=>\s*\{\s*trackedDirty\s*=\s*true/.test(SRC)
    && (SRC.match(/onChange\(\)\s*\{\s*trackedDirty\s*=\s*true/g) ?? []).length >= 2);
// and recomputing must clear BOTH flags, or the throttle would fire every call
const recomputeSrc = extract("recomputeTracked", SRC).replace(/\/\/[^\n]*/g, "");
ok("recomputing clears the request and stamps the clock",
    /retrackWanted\s*=\s*false/.test(recomputeSrc) && /lastRetrack\s*=\s*Date\.now\(\)/.test(recomputeSrc));

// The Mutuals cache is memory-only, so before the all-server sweep had a store every
// restart stripped every gold ring off the graph and put them back one person every
// 2.5s — a proven friendship silently reading as "call only" for hours.
console.log("\n-- the gold ring falls back to the all-server sweep's saved findings --");
const ringsOf = () => {
    const m = mount(6);
    const strokes = [...m.svg.querySelectorAll("circle.xd-ring")].map(r => r.getAttribute("stroke"));
    m.cleanup();
    return strokes;
};
mutualAnswers = {}; // nothing scanned this session yet
setFriendMap({ T: { friends: ["c1"], guilds: ["g1"], at: 1 } });
let strokes = ringsOf();
ok("a previous sweep's finding still rings the friend gold", strokes[1] === "gold", strokes.join(","));
ok("and a call-only companion stays plain", strokes[0] === "grey", strokes.join(","));

setFriendMap({});
strokes = ringsOf();
ok("with neither a scan nor a stored finding, nobody is claimed as a friend",
    strokes.every(s => s !== "gold"), strokes.join(","));

// A live answer is newer than any stored sweep, so an unfriending must show through
mutualAnswers = { T: [] };
setFriendMap({ T: { friends: ["c1"], guilds: ["g1"], at: 1 } });
strokes = ringsOf();
ok("a fresh scan saying 'no mutuals' beats the stale stored finding",
    strokes.every(s => s !== "gold"), strokes.join(","));
setFriendMap({});
mutualAnswers = { T: ["c1"] };

console.log("\n-- how present somebody is, on the graph --");
// The bug: being in voice AT ALL was the whole test, so somebody three servers away
// was drawn exactly like somebody sitting in your own channel. Green now means one
// thing — here, with you, now — and "in some other channel" is separated from "not in
// voice at all" by brightness instead of by colour.
{
    // c1 is the mutual friend (gold), c0 is call-only. ME sits in vc1.
    setVoice({
        ME: { channelId: "vc1", guildId: "g1" },
        c0: { channelId: "vc1", guildId: "g1" },   // in here with me
        c1: { channelId: "vc9", guildId: "g1" },   // in voice, somewhere else
        // c2..c5 not in voice at all
    });
    const m = mount(6);
    const ring = i => m.svg.querySelectorAll("circle.xd-ring")[i].getAttribute("stroke");
    const groups = m.svg.querySelectorAll("g[data-i]");
    const opa = i => groups[i].getAttribute("opacity");

    ok("somebody in YOUR channel gets the green ring", ring(0) === "green", ring(0));
    ok("green outranks even a proven friendship", (() => {
        setVoice({ ME: { channelId: "vc1" }, c1: { channelId: "vc1" } });
        const m2 = mount(6);
        const s = m2.svg.querySelectorAll("circle.xd-ring")[1].getAttribute("stroke");
        m2.cleanup();
        return s === "green";
    })());

    setVoice({ ME: { channelId: "vc1", guildId: "g1" }, c0: { channelId: "vc1" }, c1: { channelId: "vc9" } });
    const m3 = mount(6);
    const r3 = i => m3.svg.querySelectorAll("circle.xd-ring")[i].getAttribute("stroke");
    const g3 = m3.svg.querySelectorAll("g[data-i]");
    ok("somebody in ANOTHER channel does not get the green", r3(1) === "gold", r3(1));
    ok("and keeps full brightness", g3[1].getAttribute("opacity") === "1", g3[1].getAttribute("opacity"));
    ok("somebody not in voice at all is faded back", g3[2].getAttribute("opacity") === "0.7",
        g3[2].getAttribute("opacity"));
    ok("so another channel really is brighter than no channel",
        +g3[1].getAttribute("opacity") > +g3[2].getAttribute("opacity"),
        `${g3[1].getAttribute("opacity")} vs ${g3[2].getAttribute("opacity")}`);
    ok("the one in your channel is bright too", g3[0].getAttribute("opacity") === "1", g3[0].getAttribute("opacity"));
    m3.cleanup();
    m.cleanup();
}

{
    // if YOU are not in voice, nobody can be in it with you — the whole graph would
    // otherwise turn green the moment this was read the wrong way round
    setVoice({ c0: { channelId: "vc1" }, c1: { channelId: "vc2" } });
    const m = mount(6);
    const strokes = [...m.svg.querySelectorAll("circle.xd-ring")].map(r => r.getAttribute("stroke"));
    ok("nobody is green while you are out of voice", strokes.every(s => s !== "green"), strokes.join(","));
    const groups = m.svg.querySelectorAll("g[data-i]");
    ok("but the people in voice are still the bright ones",
        groups[0].getAttribute("opacity") === "1" && groups[2].getAttribute("opacity") === "0.7",
        `${groups[0].getAttribute("opacity")} / ${groups[2].getAttribute("opacity")}`);
    m.cleanup();
}

{
    // the everyone-view builds its own spec, so it needs its own proof
    setProfiles({
        T: { companions: { p1: { count: 5, ms: 5000, last: 9 }, p2: { count: 4, ms: 4000, last: 9 } }, guilds: {}, updated: 1, firstSeen: 0 },
        p1: { companions: { p2: { count: 3, ms: 3000, last: 9 } }, guilds: {}, updated: 1, firstSeen: 0 }
    });
    setVoice({ ME: { channelId: "vc1" }, p1: { channelId: "vc1" }, p2: { channelId: "vc7" } });
    remount();
    const fsvg = asSvg(FullGraph({}));
    effects.map(fn => fn());
    const rings = fsvg.querySelectorAll("circle.xd-ring").map(r => r.getAttribute("stroke"));
    ok("the everyone-view greens the person in your channel", rings.includes("green"), rings.join(","));
    const ops = fsvg.querySelectorAll("g[data-i]").map(g => g.getAttribute("opacity"));
    ok("and it still fades whoever is out of voice", ops.includes("0.7"), ops.join(","));
}
setVoice({});

console.log("\n-- the web has to actually stop moving --");
// The bug: an incremental restart cooled at the same rate as a cold one, taking ~4s to
// reach the cutoff — against a modal that refreshes every 4s. The next restart always
// arrived first, so the layout was permanently warm. It did not read as one violent
// motion; it read as a settle that never finished.
{
    const REFRESH_FRAMES = 4000 / 16;   // the modal's 4s refresh, in frames
    const src = extract("ForceGraph");
    const decay = /const decay = incremental \? ([\d.]+) : ([\d.]+)/.exec(src);
    ok("an incremental restart has its own cooling rate", !!decay, src.slice(0, 60));
    const [inc, cold] = [Number(decay[1]), Number(decay[2])];
    ok(`the incremental rate is faster (${inc} vs ${cold})`, inc < cold, `${inc} / ${cold}`);

    const alphaSrc = /const startAlpha = incremental \? Math\.min\(([\d.]+)/.exec(src);
    const startA = Number(alphaSrc[1]);
    const framesToSettle = Math.log(0.008 / startA) / Math.log(inc);
    ok(`an incremental settle finishes inside one refresh (${Math.round(framesToSettle)} frames vs ${REFRESH_FRAMES})`,
        framesToSettle < REFRESH_FRAMES, `${Math.round(framesToSettle)} frames`);

    // and the cold path must still be gentle enough to look deliberate
    const coldFrames = Math.log(0.008 / 1) / Math.log(cold);
    ok(`a cold layout still settles in a sane time (${Math.round(coldFrames)} frames)`,
        coldFrames > REFRESH_FRAMES / 2 && coldFrames < 60 * 20, `${Math.round(coldFrames)} frames`);
}

console.log("\n-- newcomers must not re-fling a settled web --");
{
    const src = extract("ForceGraph");
    // the identifier may be renamed by the transpiler (known -> known2), so match shape
    ok("the incremental test is on what is REMEMBERED, not on how many are new",
        /const (known\w*) = nodes\.length - fresh/.test(src)
        && /const incremental = nodes\.length > 0 && known\w* >= Math\.max\(1, nodes\.length \* 0\.5\)/.test(src),
        src.slice(src.indexOf("= nodes.length - fresh") - 20, src.indexOf("= nodes.length - fresh") + 140));
    // the old rule went cold the moment more than a quarter of the cast was new, which
    // the recorder now crosses on nearly every refresh
    ok("the old quarter-of-the-cast rule is gone", !/fresh <= Math\.max\(2, nodes\.length \* 0\.25\)/.test(src));
}

console.log("\n-- a settled layout outlives the modal --");
{
    api.layoutCache.clear();
    setVoice({});
    const m = mount(6);
    flush(400);                       // let it settle
    m.cleanup();
    const cached = api.layoutCache.get("one:T");
    ok("the subject's web is cached under its own key", !!cached && cached.size > 0,
        [...api.layoutCache.keys()].join(","));
    const before = [...cached.entries()].map(([id, p]) => `${id}:${Math.round(p.x)},${Math.round(p.y)}`).join("|");

    // re-opening must resume, not rebuild
    const again = mount(6);
    const pts = again.svg.querySelectorAll("circle.xd-hit")
        .map(e => `${Math.round(+e.getAttribute("cx"))},${Math.round(+e.getAttribute("cy"))}`);
    ok("re-opening starts from the remembered positions, not a cold spiral",
        pts.some(p => before.includes(p)), `${pts.slice(0, 3).join(" ")} vs ${before.slice(0, 60)}`);
    again.cleanup();

    // and it must not grow without bound as you walk the graph
    for (let i = 0; i < 30; i++) api.layoutFor("one:" + i);
    ok(`the cache stays bounded (${api.layoutCache.size})`,
        api.layoutCache.size <= Number(/const LAYOUT_CACHE_MAX = (\d+)/.exec(SRC)[1]),
        String(api.layoutCache.size));
    api.layoutCache.clear();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
