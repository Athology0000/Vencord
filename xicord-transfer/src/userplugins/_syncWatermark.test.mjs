// Exercises the REAL sync watermark persistence from xicordDossier.tsx.
//   node src/userplugins/_syncWatermark.test.mjs
//
// The watermarks used to be plain module variables, so every Discord start reset them to
// zero — and a zero pull watermark means "send me everything". On this pool that is ~50MB
// the server has to merge and serialise in one piece, and it fails often enough that the
// watermark frequently never advanced at all, so the next tick asked for the whole thing
// again. A loop that could only break by winning a coin flip, on a payload that grows
// every day. Persisting them is what makes the incremental path the normal case.
//
// The dangerous direction is the opposite one: a watermark that is too HIGH tells the
// server "I already have everything up to T" about records this store never received, and
// nothing ever offers them again. Every guard here fails towards a full pull, which is
// slow but cannot lose anything.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordDossier.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const JS = esbuild.transformSync(SRC, { loader: "tsx" }).code;

function fn(name, src = JS) {
    let start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    if (src.slice(start - 6, start) === "async ") start -= 6;
    let j = src.indexOf("{", src.indexOf(")", start)), depth = 0;
    for (; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
    }
    throw new Error(`unbalanced ${name}`);
}

const KEY = /const SYNC_KEY = "([^"]+)"/.exec(JS)[1];

/** A fresh module instance over a fake IndexedDB. */
function mk(ds, account) {
    const api = new Function("DataStore", "console", `
        let accountId = ${JSON.stringify(account)};
        let pullWatermark = 0, syncWatermark = 0, syncFullAt = 0;
        const SYNC_KEY = ${JSON.stringify(KEY)};
        const syncKeyFor = id => (id ? \`\${SYNC_KEY}:\${id}\` : SYNC_KEY);
        ${fn("sane")}
        ${fn("loadSyncState")}
        ${fn("saveSyncState")}
        return {
            loadSyncState, saveSyncState, sane,
            get: () => ({ pull: pullWatermark, push: syncWatermark, fullAt: syncFullAt }),
            set: (p, q, f) => { pullWatermark = p; syncWatermark = q; syncFullAt = f; },
            switchTo: id => { accountId = id; }
        };`)(ds, { error() { } });
    return api;
}

function fakeDS(initial = {}) {
    const data = { ...initial };
    const ds = {
        fail: false, getFail: false,
        async get(k) { if (ds.getFail) throw new Error("read blew up"); return data[k]; },
        async set(k, v) { if (ds.fail) throw new Error("write blew up"); data[k] = v; return v; },
        data
    };
    return ds;
}

const settle = () => new Promise(r => setTimeout(r, 0));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};

const A = "1131085517967081544", B = "1239350611800231956";
const past = Date.now() - 60000;

console.log("\n-- a watermark has to be a real past instant --");
{
    const { sane } = mk(fakeDS(), A);
    ok("a recent timestamp survives", sane(past) === past, String(sane(past)));
    ok("zero stays zero", sane(0) === 0);
    ok("a negative is refused", sane(-5) === 0, String(sane(-5)));
    // the one that loses data silently: anything ahead of now would skip real records
    ok("a FUTURE timestamp degrades to a full pull", sane(Date.now() + 600000) === 0);
    ok("junk degrades to a full pull", sane("soon") === 0, String(sane("soon")));
    ok("null degrades to a full pull", sane(null) === 0);
    ok("undefined degrades to a full pull", sane(undefined) === 0);
    ok("Infinity degrades to a full pull", sane(Infinity) === 0);
}

console.log("\n-- across a restart --");
{
    const ds = fakeDS();
    const first = mk(ds, A);
    await first.loadSyncState();
    ok("a fresh install starts at zero — one full pull is correct",
        first.get().pull === 0 && first.get().push === 0, JSON.stringify(first.get()));

    first.set(past, past + 1, past + 2);
    first.saveSyncState();
    await settle();
    ok("the watermarks reach the store", !!ds.data[`${KEY}:${A}`], Object.keys(ds.data).join(","));

    const second = mk(ds, A);          // same disk, new module state — a restart
    await second.loadSyncState();
    ok("the pull watermark survives the restart", second.get().pull === past, String(second.get().pull));
    ok("so does the push watermark", second.get().push === past + 1, String(second.get().push));
    ok("and the last-full-pull clock", second.get().fullAt === past + 2, String(second.get().fullAt));
}

console.log("\n-- the watermarks belong to ONE account --");
{
    // sharing them would tell the server "I have everything up to T" about a store that
    // holds none of it, and those records are never offered again
    const ds = fakeDS();
    const a = mk(ds, A);
    await a.loadSyncState();
    a.set(past, past, past);
    a.saveSyncState();
    await settle();

    const b = mk(ds, B);
    await b.loadSyncState();
    ok("a different account does not inherit them", b.get().pull === 0, String(b.get().pull));
    ok("it gets its own key", !ds.data[`${KEY}:${B}`] || ds.data[`${KEY}:${B}`].pull === 0);

    b.set(past + 500, past + 500, past + 500);
    b.saveSyncState();
    await settle();
    ok("and writing B leaves A's alone", ds.data[`${KEY}:${A}`].pull === past,
        JSON.stringify(ds.data[`${KEY}:${A}`]));

    const backToA = mk(ds, A);
    await backToA.loadSyncState();
    ok("switching back finds A's own watermark", backToA.get().pull === past, String(backToA.get().pull));
}

console.log("\n-- a switch mid-write cannot land under the wrong key --");
{
    const ds = fakeDS();
    const a = mk(ds, A);
    await a.loadSyncState();
    a.set(past, past, past);
    a.saveSyncState();     // key captured up front...
    a.switchTo(B);         // ...and the account changes while it is in flight
    await settle();
    ok("the write lands under the account it came from", ds.data[`${KEY}:${A}`]?.pull === past,
        Object.keys(ds.data).join(","));
    ok("and not under the incoming one", !ds.data[`${KEY}:${B}`], Object.keys(ds.data).join(","));
}

console.log("\n-- a damaged store must not skip records --");
{
    for (const [label, stored] of [
        ["junk in the store", { pull: "tomorrow", push: {}, fullAt: [] }],
        ["a future watermark", { pull: Date.now() + 3600000, push: 0, fullAt: 0 }],
        ["not an object at all", "corrupted"],
        ["null", null]
    ]) {
        const ds = fakeDS({ [`${KEY}:${A}`]: stored });
        const h = mk(ds, A);
        await h.loadSyncState();
        ok(`${label} falls back to a full pull`, h.get().pull === 0, JSON.stringify(h.get()));
    }

    const ds = fakeDS();
    ds.getFail = true;
    const h = mk(ds, A);
    await h.loadSyncState();
    ok("a read that throws falls back to a full pull", h.get().pull === 0, JSON.stringify(h.get()));
}

console.log("\n-- a load always resets first --");
{
    // otherwise a missing record leaves the PREVIOUS account's watermark in place
    const ds = fakeDS();
    const h = mk(ds, A);
    h.set(past, past, past);
    h.switchTo(B);
    await h.loadSyncState();
    ok("stale values are cleared even when the store has nothing",
        h.get().pull === 0 && h.get().push === 0 && h.get().fullAt === 0, JSON.stringify(h.get()));
}

console.log("\n-- a failed write is not mistaken for a saved one --");
{
    const ds = fakeDS();
    ds.fail = true;
    const h = mk(ds, A);
    await h.loadSyncState();
    h.set(past, past, past);
    h.saveSyncState();
    await settle();
    ok("nothing is stored", !ds.data[`${KEY}:${A}`], Object.keys(ds.data).join(","));
    const after = mk(ds, A);
    await after.loadSyncState();
    ok("so the next start does a full pull rather than skipping the window",
        after.get().pull === 0, String(after.get().pull));
}

console.log("\n-- the pull watermark is banked before the push is attempted --");
{
    // the push is a separate failure; losing a good pull to it sends the next start
    // back to the ~50MB request that is the whole problem
    const body = fn("syncOnce");
    const pullSave = body.indexOf("saveSyncState");
    // anchor on code, not a comment: the source is read post-transpile and esbuild
    // strips comments, so a marker like "---- then push ----" is simply not there
    const pushStart = body.indexOf("toPool(");
    ok("saveSyncState is called before the push begins",
        pullSave > 0 && pushStart > 0 && pullSave < pushStart, `${pullSave} vs ${pushStart}`);
    ok("and again after everything lands",
        body.lastIndexOf("saveSyncState") > pushStart, String(body.lastIndexOf("saveSyncState")));
    ok("the pull still only advances on a real server timestamp",
        /pool\?\.syncedAt === "number" && pool\.syncedAt > 0/.test(body));
}

console.log("\n-- an account switch clears them in memory too --");
{
    const un = fn("unloadAccount");
    // each assignment separately: the transpiler is free to reformat the statements
    ok("unloadAccount resets all three",
        ["pullWatermark = 0", "syncWatermark = 0", "syncFullAt = 0"].every(s => un.includes(s)),
        un.slice(0, 200));
}

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
