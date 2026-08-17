// Extracts the REAL voice-session store from xicordHistory.tsx and drives it against a
// fake DataStore and a fake settings.json.
//   node src/userplugins/_history.test.mjs
//
// What this pins down: the log used to be a JSON string inside settings.json, re-parsed
// and re-stringified in full on EVERY closed session, and capped at 500 so that cost
// stayed bounded. Raising the cap without moving the store would have made both the
// per-event work and the settings.json corruption blast radius grow with the history —
// and settings.json has already been damaged once in this project.
//
// So the properties that matter are: the cap is honoured and clamped, the oldest go
// first, an unread store never overwrites a real one, and the migration out of
// settings.json cannot lose the log if the new write fails.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordHistory.tsx", import.meta.url), "utf8");

/** Comment- and string-aware brace matcher (same approach as the sibling suites). */
function extract(name) {
    const needle = `function ${name}(`;
    let start = SRC.indexOf(needle);
    if (start < 0) throw new Error(`${name} not found`);
    // keep an `async` modifier: slicing from `function` turns an async body's `await`
    // into a syntax error, which reads as a broken test rather than a broken store
    if (SRC.slice(start - 6, start) === "async ") start -= 6;
    let i = SRC.indexOf("{", start + needle.length - 1), depth = 0, mode = "code", prev = "";
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

const num = n => {
    const m = new RegExp(`const ${n} = (\\d+)`).exec(SRC);
    if (!m) throw new Error(`${n} not found`);
    return Number(m[1]);
};
const DEFAULT_MAX = num("DEFAULT_MAX_SESSIONS");
const MIN_MAX = num("MIN_MAX_SESSIONS");
const MAX_MAX = num("MAX_MAX_SESSIONS");
const SLACK = num("TRIM_SLACK");
const KEY = "XicordHistorySessions";

const body = [
    `const DEFAULT_MAX_SESSIONS=${DEFAULT_MAX}, MIN_MAX_SESSIONS=${MIN_MAX}, MAX_MAX_SESSIONS=${MAX_MAX};`,
    `const TRIM_SLACK=${SLACK}, FLUSH_DELAY=${num("FLUSH_DELAY")}, SESSIONS_KEY=${JSON.stringify(KEY)};`,
    "let sessions = []; let loaded = false; let dirty = false; let flushTimer = null;",
    // account-scoping deps: default account is null, which keys the global SESSIONS_KEY —
    // so the existing tests are unchanged. setAccount() drives the per-account path.
    "let accountId = null; let loadSeq = 0; let __acct = null;",
    `const sessionsKeyFor = id => id ? SESSIONS_KEY + ":" + id : SESSIONS_KEY;`,
    "const currentAccount = () => __acct;",
    "const open = new Map(); const listeners = new Set();",
    "function notify(){ listeners.forEach(l => { try { l(); } catch {} }); }",
    extract("sessionCap"),
    extract("trimSessions"),
    extract("parseLegacy"),
    extract("load"),
    extract("scheduleFlush"),
    extract("flush"),
    extract("getSessions"),
    extract("clearSessions"),
    extract("closeSession"),
    `return { load, flush, scheduleFlush, closeSession, clearSessions, getSessions,
              sessionCap, trimSessions, parseLegacy, open, sessionsKeyFor,
              setAccount: a => { __acct = a; },
              state: () => ({ loaded, dirty, timer: flushTimer, len: sessions.length, acct: accountId }),
              seed: s => { sessions = s; loaded = true; } };`
].join("\n");

const js = esbuild.transformSync(body, { loader: "ts" }).code;

/** A fresh module instance over a given fake disk + settings. */
function mk(ds, store) {
    let now = 0;
    const timers = new Map();
    let nextId = 1;
    const setTimeout_ = (fn, ms) => { const id = nextId++; timers.set(id, fn); return id; };
    const clearTimeout_ = id => timers.delete(id);
    const api = new Function("DataStore", "settings", "console", "setTimeout", "clearTimeout", js)(
        ds, { store }, { error() { }, log() { } }, setTimeout_, clearTimeout_);
    api.fire = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(f => f()); };
    api.pending = () => timers.size;
    return api;
}

function fakeDS(initial = {}) {
    const data = { ...initial };
    const ds = {
        fail: false, writes: 0,
        async get(k) { if (ds.getFail) throw new Error("read blew up"); return data[k]; },
        async set(k, v) { if (ds.fail) throw new Error("write blew up"); ds.writes++; data[k] = v; return v; },
        async del(k) { delete data[k]; },
        data
    };
    return ds;
}

const sess = (id, join) => ({ userId: String(id), channelId: "c1", join, leave: join + 1000 });
const many = n => Array.from({ length: n }, (_, i) => sess(i, n - i)); // newest first

const settle = () => new Promise(r => globalThis.setTimeout(r, 0));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};

console.log("\n-- the cap is whatever you set, within reason --");
{
    const cap = v => mk(fakeDS(), { maxSessions: v }).sessionCap();
    ok(`the default is ${DEFAULT_MAX.toLocaleString()}`, cap(DEFAULT_MAX) === DEFAULT_MAX, String(cap(DEFAULT_MAX)));
    ok("a bigger number is honoured", cap(1000000) === 1000000, String(cap(1000000)));
    ok("above the ceiling clamps down", cap(99999999) === MAX_MAX, String(cap(99999999)));
    ok("below the floor clamps up", cap(1) === MIN_MAX, String(cap(1)));
    ok("a blank box does not wipe the log", cap("") === DEFAULT_MAX, String(cap("")));
    ok("nor does junk", cap("lots") === DEFAULT_MAX, String(cap("lots")));
    ok("a fraction is floored", cap(5000.9) === 5000, String(cap(5000.9)));
}

console.log("\n-- trimming drops the OLDEST, never the newest --");
{
    const { trimSessions } = mk(fakeDS(), {});
    const list = many(100);
    ok("under the cap nothing is touched", trimSessions(list, 50, 60).length === 100, String(list.length));

    const over = many(100);
    trimSessions(over, 50, 0);
    ok("past the cap it cuts to exactly the cap", over.length === 50, String(over.length));
    ok("and the survivors are the newest", over[0].userId === "0" && over[49].userId === "49",
        `${over[0].userId}..${over[49].userId}`);

    // the slack is what makes the trim amortised instead of once per session
    const slack = many(50 + SLACK);
    trimSessions(slack, 50);
    ok("a list inside the slack is left alone", slack.length === 50 + SLACK, String(slack.length));
    const past = many(50 + SLACK + 1);
    trimSessions(past, 50);
    ok("one past the slack cuts back to the cap", past.length === 50, String(past.length));
}

console.log("\n-- recording a session --");
{
    const ds = fakeDS();
    const h = mk(ds, { maxSessions: DEFAULT_MAX });
    await h.load();
    h.open.set("u1", { channelId: "c9", guildId: "g1", join: 500 });
    h.closeSession("u1", 1500);
    const got = h.getSessions();
    ok("it lands at the front", got.length === 1 && got[0].userId === "u1", JSON.stringify(got));
    ok("with the times it was open", got[0].join === 500 && got[0].leave === 1500);
    ok("closing an unknown user records nothing", (h.closeSession("nobody", 9), h.getSessions().length === 1));
    ok("nothing was written to disk yet", ds.writes === 0, String(ds.writes));
    ok("but a write is pending", h.pending() === 1, String(h.pending()));
}

console.log("\n-- writes are batched, not one per session --");
{
    const ds = fakeDS();
    const h = mk(ds, { maxSessions: DEFAULT_MAX });
    await h.load();
    for (let i = 0; i < 500; i++) {
        h.open.set("u" + i, { channelId: "c1", join: i });
        h.closeSession("u" + i, i + 10);
    }
    ok("500 sessions schedule ONE flush", h.pending() === 1, String(h.pending()));
    h.fire();
    await settle();
    ok("and produce one write", ds.writes === 1, String(ds.writes));
    ok("carrying all 500", ds.data[KEY].length === 500, String(ds.data[KEY]?.length));
    // the old store kept 500 and this is the whole point of the change
    ok("well past the old 500-session cap", ds.data[KEY].length > 0 && (() => {
        for (let i = 0; i < 4600; i++) { h.open.set("x" + i, { channelId: "c", join: i }); h.closeSession("x" + i, i); }
        h.fire();
        return h.getSessions().length === 5100;
    })(), String(h.getSessions().length));
}

console.log("\n-- an unread store must never overwrite a real one --");
{
    // the failure this guards: load() is async, so a flush racing it would write the
    // still-empty array over a full log on disk
    const ds = fakeDS({ [KEY]: many(40) });
    const h = mk(ds, { maxSessions: DEFAULT_MAX });
    h.scheduleFlush();          // dirty, but the read has not landed
    h.fire();
    await settle();
    ok("the flush refuses to run before the read", ds.writes === 0, String(ds.writes));
    ok("and the log on disk is intact", ds.data[KEY].length === 40, String(ds.data[KEY].length));
    await h.load();
    ok("the read then brings it back", h.getSessions().length === 40, String(h.getSessions().length));
}

console.log("\n-- a failed write is retried, not silently dropped --");
{
    const ds = fakeDS();
    const h = mk(ds, { maxSessions: DEFAULT_MAX });
    await h.load();
    h.seed(many(5));
    ds.fail = true;
    h.scheduleFlush(); h.fire();
    await settle();
    ok("the failure leaves it dirty", h.state().dirty === true, JSON.stringify(h.state()));
    ds.fail = false;
    h.scheduleFlush(); h.fire();
    await settle();
    ok("so the next flush lands it", ds.data[KEY]?.length === 5, String(ds.data[KEY]?.length));
}

console.log("\n-- what gets written is a snapshot, not the live array --");
{
    const ds = fakeDS();
    const h = mk(ds, { maxSessions: DEFAULT_MAX });
    await h.load();
    h.seed(many(3));
    h.scheduleFlush(); h.fire();
    h.open.set("late", { channelId: "c", join: 1 });
    h.closeSession("late", 2);   // mutates `sessions` while the write is in flight
    await settle();
    ok("the write carries what existed when it was made", ds.data[KEY].length === 3, String(ds.data[KEY].length));
}

console.log("\n-- migrating out of settings.json --");
{
    const legacy = JSON.stringify(many(7));
    const store = { maxSessions: DEFAULT_MAX, sessions: legacy };
    const ds = fakeDS();
    const h = mk(ds, store);
    await h.load();
    ok("the old log is picked up", h.getSessions().length === 7, String(h.getSessions().length));
    ok("and copied to the new store", ds.data[KEY]?.length === 7, String(ds.data[KEY]?.length));
    ok("only THEN is settings.json let go of", store.sessions === "[]", store.sessions.slice(0, 40));
}

console.log("\n-- a migration that cannot write keeps the old copy --");
{
    const legacy = JSON.stringify(many(7));
    const store = { maxSessions: DEFAULT_MAX, sessions: legacy };
    const ds = fakeDS();
    ds.fail = true;
    const h = mk(ds, store);
    await h.load();
    ok("settings.json still holds the log", store.sessions === legacy, store.sessions.slice(0, 40));
    ok("and it is still in memory", h.getSessions().length === 7, String(h.getSessions().length));
}

console.log("\n-- the new store wins once it exists --");
{
    const store = { maxSessions: DEFAULT_MAX, sessions: JSON.stringify(many(7)) };
    const ds = fakeDS({ [KEY]: many(3) });
    const h = mk(ds, store);
    await h.load();
    ok("the migrated store is used, not the stale setting", h.getSessions().length === 3,
        String(h.getSessions().length));
    ok("and the stale setting is not merged back in", store.sessions !== "[]" && h.getSessions().length === 3);
}

console.log("\n-- damaged inputs cannot take the log down --");
{
    const h1 = mk(fakeDS({ [KEY]: "not an array" }), { maxSessions: DEFAULT_MAX, sessions: "{{{" });
    await h1.load();
    ok("junk on both sides yields an empty log, not a throw", h1.getSessions().length === 0);

    const ds = fakeDS();
    ds.getFail = true;
    const h2 = mk(ds, { maxSessions: DEFAULT_MAX, sessions: JSON.stringify(many(4)) });
    await h2.load();
    ok("a read that throws falls back to the old setting", h2.getSessions().length === 4,
        String(h2.getSessions().length));
}

console.log("\n-- a load applies the cap to whatever it found --");
{
    // lowering the setting has to actually take effect, including on the stored log
    const ds = fakeDS({ [KEY]: many(5000) });
    const h = mk(ds, { maxSessions: MIN_MAX });
    await h.load();
    ok("an over-cap stored log is cut on read", h.getSessions().length === MIN_MAX, String(h.getSessions().length));
    ok("keeping the newest", h.getSessions()[0].userId === "0", h.getSessions()[0].userId);
}

console.log("\n-- restart --");
{
    const ds = fakeDS();
    const store = { maxSessions: DEFAULT_MAX, sessions: JSON.stringify(many(6)) };
    const first = mk(ds, store);
    await first.load();
    first.open.set("u", { channelId: "c", join: 1 });
    first.closeSession("u", 2);
    first.fire();
    await settle();

    const second = mk(ds, store);           // same disk, same settings — a restart
    await second.load();
    ok("the log survives a restart", second.getSessions().length === 7, String(second.getSessions().length));
    ok("and is not duplicated by re-reading the legacy setting",
        second.getSessions().filter(s => s.userId === "u").length === 1);
}

console.log("\n-- clearing --");
{
    const ds = fakeDS();
    const h = mk(ds, { maxSessions: DEFAULT_MAX });
    await h.load();
    h.seed(many(9));
    h.clearSessions();
    await settle();
    ok("the log empties", h.getSessions().length === 0, String(h.getSessions().length));
    ok("and the empty is written through", ds.data[KEY]?.length === 0, JSON.stringify(ds.data[KEY]));

    // clearing before the read lands must not be swallowed by the unread-store guard
    const ds2 = fakeDS({ [KEY]: many(4) });
    const h2 = mk(ds2, { maxSessions: DEFAULT_MAX });
    h2.clearSessions();
    ok("a clear before the read is left pending, not lost", h2.pending() === 1, String(h2.pending()));
}

console.log("\n-- the log is per-account --");
{
    // An account with its own key keeps its own sessions; a different account sees none of
    // them, and the old global blob is adopted by whoever loads first.
    const ds = fakeDS({ [KEY]: many(3) });    // a pre-existing GLOBAL log
    const a = mk(ds, { maxSessions: DEFAULT_MAX });
    a.setAccount("ACCT_A");
    await a.load();
    ok("account A adopts the old global log on first load", a.getSessions().length === 3, String(a.getSessions().length));
    ok("and the global key is removed once adopted", !(KEY in ds.data), Object.keys(ds.data).join(","));
    ok("the data now lives under A's own key", Array.isArray(ds.data[KEY + ":ACCT_A"]), Object.keys(ds.data).join(","));

    const b = mk(ds, { maxSessions: DEFAULT_MAX });
    b.setAccount("ACCT_B");
    await b.load();
    ok("account B sees NONE of A's sessions", b.getSessions().length === 0, String(b.getSessions().length));
    b.open.set("z", { channelId: "c", join: 1 });
    b.closeSession("z", 2);
    b.flush(); await settle();
    ok("B's own session lands under B's key", ds.data[KEY + ":ACCT_B"]?.length === 1, JSON.stringify(Object.keys(ds.data)));
    ok("and A's log is untouched by B", ds.data[KEY + ":ACCT_A"]?.length === 3, String(ds.data[KEY + ":ACCT_A"]?.length));
}

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
