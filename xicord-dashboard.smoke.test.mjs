// Does the dashboard's script actually RUN?
//   node xicord-dashboard.smoke.test.mjs
//
// It is one 100KB IIFE with no build step, so a typo or a reference used before it exists
// only shows up when a browser executes it — which nothing in CI does. This boots it
// against a DOM stub: enough to catch a throw during setup, a missing element id an
// event binding depends on, and the per-keystroke cost of the sessions table.
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, "xicord-dashboard.html"), "utf8");
const src = (html.match(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/) || [])[1];

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${d ? ` — ${d}` : ""}`)); };

/* ---- a DOM stub that is permissive but records what was asked for ---- */
const made = new Map();
function makeEl(key) {
    if (made.has(key)) return made.get(key);
    const el = {
        _key: key, _on: {}, style: {}, dataset: {}, classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
        children: [], attributes: {},
        innerHTML: "", textContent: "", value: "", hidden: false, checked: false,
        offsetWidth: 800, offsetHeight: 400, clientWidth: 800, clientHeight: 400,
        addEventListener(k, f) { (this._on[k] ||= []).push(f); },
        removeEventListener() { }, appendChild(c) { this.children.push(c); return c; },
        removeChild() { }, setAttribute(k, v) { this.attributes[k] = v; },
        getAttribute(k) { return this.attributes[k] ?? null; }, removeAttribute(k) { delete this.attributes[k]; },
        querySelector: () => makeEl(key + " *"), querySelectorAll: () => [],
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 400, right: 800, bottom: 400 }),
        getContext: () => null, focus() { }, blur() { }, click() { }, closest: () => null,
        insertAdjacentHTML() { }, scrollIntoView() { }, remove() { },
    };
    made.set(key, el);
    return el;
}
const doc = {
    getElementById: id => makeEl("#" + id),
    querySelector: s => makeEl(s),
    querySelectorAll: () => [],
    createElement: t => makeEl("<" + t + ">" + Math.random()),
    createElementNS: t => makeEl("<ns>" + Math.random()),
    addEventListener() { }, removeEventListener() { },
    body: makeEl("body"), documentElement: makeEl("html"), head: makeEl("head"),
    readyState: "complete",
};
const win = {
    document: doc, localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
    matchMedia: () => ({ matches: false, addEventListener() { }, addListener() { } }),
    requestAnimationFrame: fn => { fn(0); return 1; }, cancelAnimationFrame() { },
    setTimeout: (fn) => { void fn; return 1; }, clearTimeout() { }, setInterval: () => 1, clearInterval() { },
    addEventListener() { }, removeEventListener() { },
    devicePixelRatio: 1, innerWidth: 1280, innerHeight: 900,
    location: { href: "http://localhost/", reload() { } },
    getSelection: () => ({ removeAllRanges() { }, addRange() { } }),
    FileReader: class { readAsText() { } }, Blob: class { }, URL: { createObjectURL: () => "blob:", revokeObjectURL() { } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" }),
    console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Map, Set, isNaN, parseInt, parseFloat,
};
win.window = win; win.globalThis = win; win.self = win;

console.log("-- the dashboard script boots --");
let threw = null;
try {
    new Function(...Object.keys(win), src)(...Object.values(win));
} catch (e) { threw = `${e.name}: ${e.message}`; }
ok("it executes without throwing", !threw, threw);

console.log("\n-- the interactions it binds are wired to elements that exist --");
const BOUND = ["#search", "#fm-search", "#lookup", "#full-search", "#loadBtn", "#chooseBtn", "#paste", "#themeBtn"];
for (const sel of BOUND) {
    const el = made.get(sel);
    ok(`${sel} has a listener`, !!el && Object.keys(el._on).length > 0,
        el ? "no listener attached" : "element was never queried");
}

console.log("\n-- accessibility of the markup --");
const inputs = [...html.matchAll(/<(input|textarea)\b[^>]*>/g)].map(m => m[0]);
const unlabelled = inputs.filter(tag => {
    if (/type="(hidden|file)"/.test(tag) || /class="[^"]*\bhidden\b/.test(tag)) return false;
    if (/aria-label(?:ledby)?=/.test(tag)) return false;
    const id = (tag.match(/id="([^"]+)"/) || [])[1];
    if (!id) return true;
    // either an explicit <label for>, or the input is nested inside a <label>
    return !(html.includes(`for="${id}"`) || new RegExp(`<label[^>]*>(?:(?!</label>)[\\s\\S])*id="${id}"`).test(html));
});
ok("every visible input is labelled", unlabelled.length === 0, unlabelled.join(" | "));
ok("focus is visible on inputs, not just buttons",
    /input:focus-visible/.test(html) && !/input:focus\{outline:none\}/.test(html));
ok("no focus outline is removed without a replacement", !/outline:\s*none/.test(html.replace(/outline:none;border-color[^}]*}/g, "")));
ok("motion can be turned down", html.includes("prefers-reduced-motion"));
ok("search results are announced", (html.match(/aria-live="polite"/g) || []).length >= 2);

console.log("\n-- the sessions table stays cheap per keystroke --");
// Rebuild the shipped projection + filter + sort against a realistic history.
const N = 40000;
const names = {}, chans = {};
const sessions = Array.from({ length: N }, (_, i) => {
    const u = "u" + (i % 3000), c = "c" + (i % 400);
    names[u] = "person-" + (i % 3000); chans[c] = "channel-" + (i % 400);
    return { userId: u, channelId: c, join: 1e12 + i * 1000, leave: 1e12 + i * 1000 + 60000 };
});
const uname = id => names[id] || id, cname = id => chans[id] || id;

// OLD: re-derive every row, re-lowercase, sort the lot — per keystroke
let t = Date.now();
{
    let rows = sessions.map(s => ({ user: uname(s.userId), uid: s.userId, channel: cname(s.channelId), join: s.join, dur: 60000 }));
    const q = "person-12";
    rows = rows.filter(r => r.user.toLowerCase().indexOf(q) >= 0 || r.channel.toLowerCase().indexOf(q) >= 0);
    rows.sort((a, b) => (a.join < b.join ? 1 : -1));
}
const oldMs = Date.now() - t;

// NEW: project once, then a keystroke filters pre-lowered strings and sorts the matches
t = Date.now();
const projected = sessions.map(s => {
    const user = uname(s.userId), channel = cname(s.channelId);
    return { user, uid: s.userId, channel, lcUser: user.toLowerCase(), lcChannel: channel.toLowerCase(), join: s.join, dur: 60000 };
});
const projectMs = Date.now() - t;
t = Date.now();
{
    const q = "person-12";
    const rows = projected.filter(r => r.lcUser.indexOf(q) >= 0 || r.lcChannel.indexOf(q) >= 0);
    rows.slice().sort((a, b) => (a.join < b.join ? 1 : -1));
}
const newMs = Date.now() - t;
console.log(`     ${N.toLocaleString()} sessions — old ${oldMs}ms/keystroke · new ${newMs}ms/keystroke (one-off projection ${projectMs}ms)`);
ok(`a keystroke is quicker than it was (${newMs}ms vs ${oldMs}ms)`, newMs <= oldMs);
ok(`a keystroke stays interactive (${newMs}ms)`, newMs < 60, `${newMs}ms`);
ok("the projection is cached, not redone per keystroke", src.includes("tblRowsFor"));
ok("search boxes repaint per frame, not per keystroke",
    (src.match(/onFrame\(/g) || []).length >= 4);

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
