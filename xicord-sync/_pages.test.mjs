// The browser-facing pages: do they render, is the inline script valid, and does the data
// page stay cheap on a realistically large pool?
//   node xicord-sync/_pages.test.mjs
//
// The data page derives everything it shows from ~11k people and ~114k call pairs. It used
// to walk every call pair for every card it drew — roughly seven million iterations per
// keystroke — so the index built on load is the thing worth guarding.
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn, execFileSync } from "child_process";
import { createRequire } from "module";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pages = require(join(HERE, "pages.js"));

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ALL = {
    "login (configured)": pages.loginPage({ configured: true, devices: 2, people: 11000 }),
    "login (unconfigured)": pages.loginPage({ configured: false, devices: 0, people: 0 }),
    token: pages.tokenPage({ username: "ana", userId: "123456789012345678", token: "xic-abc" }),
    error: pages.errorPage("Nope", "something went wrong"),
    app: pages.appPage(),
};

console.log("-- every page is a well-formed document --");
for (const [name, html] of Object.entries(ALL)) {
    ok(`${name}: has a doctype, lang and title`,
        /^<!doctype html>/i.test(html) && html.includes('<html lang="en"') && /<title>[^<]+<\/title>/.test(html));
    ok(`${name}: tags are balanced`, balanced(html), unbalanced(html));
    ok(`${name}: no unescaped interpolation left behind`, !html.includes("${"));
}

console.log("\n-- the inline scripts actually parse --");
for (const [name, html] of Object.entries(ALL)) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    if (!scripts.length) { ok(`${name}: (no script)`, true); continue; }
    let err = null;
    for (const s of scripts) {
        const f = join(tmpdir(), `xic-script-${name.replace(/\W/g, "")}.js`);
        writeFileSync(f, s, "utf8");
        try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); }
        catch (e) { err = String(e.stderr || e.message).split("\n").slice(0, 3).join(" "); }
        rmSync(f, { force: true });
    }
    ok(`${name}: inline script is valid JavaScript`, !err, err);
}

console.log("\n-- accessibility basics --");
const app = ALL.app, token = ALL.token;
ok("every input has a label", labelled(app), "an input has no <label for>");
// Comments stripped first — the page explains in prose why it does not use alert(), and
// matching that sentence would be the test failing on its own documentation.
const appCode = app.replace(/^\s*\/\/.*$/gm, "");
ok("errors are announced, not alert()ed",
    app.includes('role="alert"') && !/\balert\(/.test(appCode));
ok("the result count is a live region", app.includes('id="count"') && app.includes('aria-live="polite"'));
ok("the copy button reports what happened", token.includes('id="copystate"') && token.includes('role="status"'));
ok("focus is visible for keyboard users", app.includes(":focus-visible"));
ok("decorative marks are hidden from screen readers", ALL["login (configured)"].includes('aria-hidden="true"'));
ok("motion can be turned down", app.includes("prefers-reduced-motion"));
ok("the token field is a form, so Enter submits", app.includes('id="gateform"') && app.includes('type="submit"'));
ok("landmarks are present", app.includes("<main>") && app.includes("<header") && app.includes("<footer>"));

console.log("\n-- the data page stays cheap on a real-sized pool --");
// Run the page's own index + render against a pool the size of the live one, in a DOM
// stub. This is the guard against the O(people x calls) render coming back.
const PEOPLE = 11000, PAIRS = 114000;
const pool = { people: {}, calls: {}, users: {} };
const pid = i => `9${String(100000000000000000 + i)}`.slice(0, 19);
for (let i = 0; i < PEOPLE; i++) pool.people[pid(i)] = { guilds: ["1"], first: 1, last: Date.now() - i * 1000 };
for (let i = 0; i < PAIRS; i++) {
    const a = pid(i % PEOPLE), b = pid((i * 7 + 3) % PEOPLE);
    if (a !== b) pool.calls[a < b ? `${a}|${b}` : `${b}|${a}`] = { ms: (i % 900) * 1000, count: i % 30, last: 1, guilds: [] };
}
for (let i = 0; i < 4000; i++) pool.users[pid(i)] = { username: `person-${i}`, avatar: "", at: 1 };

const timing = runAppScript(pages.appPage(), pool);
console.log(`     index ${timing.index}ms · first render ${timing.first}ms · search keystroke ${timing.search}ms`);
ok(`the one-off index is built in well under a second (${timing.index}ms)`, timing.index < 1500, `${timing.index}ms`);
ok(`the first render is quick (${timing.first}ms)`, timing.first < 250, `${timing.first}ms`);
// The regression that matters: a keystroke must not re-walk the call pairs.
ok(`a search keystroke stays interactive (${timing.search}ms)`, timing.search < 120, `${timing.search}ms`);
ok("the list is paged rather than dumping every match", timing.rendered <= 40, String(timing.rendered));
ok("searching actually narrows the list", timing.searchMatches < PEOPLE && timing.searchMatches > 0,
    String(timing.searchMatches));

/* ------------------------------------------------------------------ */

function balanced(html) { return unbalanced(html) === null; }
/** Which container tag, if any, is left open. Ignores void and self-closing elements. */
function unbalanced(html) {
    const VOID = new Set(["meta", "link", "br", "hr", "img", "input", "path", "source", "area", "col"]);
    const body = html.replace(/<script>[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
    const stack = [];
    for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
        const [, closing, tag, selfClose] = m;
        const t = tag.toLowerCase();
        if (VOID.has(t) || selfClose) continue;
        // these are legitimately left open in an HTML document
        if (["html", "body", "doctype"].includes(t)) continue;
        if (closing) {
            if (stack[stack.length - 1] === t) stack.pop();
            else return `</${t}> closed while <${stack[stack.length - 1] || "nothing"}> was open`;
        } else stack.push(t);
    }
    return stack.length ? `<${stack[stack.length - 1]}> never closed` : null;
}

function labelled(html) {
    for (const m of html.matchAll(/<input\b[^>]*>/g)) {
        const tag = m[0];
        const id = (tag.match(/id="([^"]+)"/) || [])[1];
        const hasAria = /aria-label(?:ledby)?=/.test(tag);
        if (!hasAria && !(id && html.includes(`for="${id}"`))) return false;
    }
    return true;
}

/**
 * Execute the page's own script with just enough DOM for the index and render paths, so the
 * thing being timed is the shipped code rather than a copy of it.
 */
function runAppScript(html, data) {
    const src = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
    const els = {};
    const el = id => (els[id] ||= {
        id, value: "", textContent: "", innerHTML: "", hidden: false,
        _on: {}, addEventListener(k, f) { this._on[k] = f; }, focus() { }
    });
    const stub = {
        document: { getElementById: el, addEventListener() { } },
        localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
        requestAnimationFrame: fn => fn(),
        setTimeout: () => 0,
        fetch: async () => ({ ok: true, status: 200, json: async () => data }),
        location: { reload() { } },
        getSelection: () => ({ removeAllRanges() { }, addRange() { } }),
        console,
    };
    stub.window = stub; stub.globalThis = stub;
    const fn = new Function(...Object.keys(stub), `${src}\nreturn {open:open,render:render,idx:function(){return idx},list:function(){return matches}};`);
    const api = fn(...Object.values(stub));

    let t = Date.now(); api.open(data, "tok"); const total = Date.now() - t;
    // open() = buildIndex + first render; time a render on its own to split them
    t = Date.now(); api.render(); const first = Date.now() - t;
    el("q").value = "person-1";
    t = Date.now(); api.render(); const search = Date.now() - t;
    return {
        index: Math.max(0, total - first), first, search,
        rendered: (el("list").innerHTML.match(/class="card"/g) || []).length,
        searchMatches: api.list().length,
    };
}

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
