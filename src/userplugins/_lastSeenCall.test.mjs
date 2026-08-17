// Extracts the REAL last-seen store from xicordLastSeenCall.tsx and drives it against a
// fake DataStore.
//   node src/userplugins/_lastSeenCall.test.mjs
//
// What this pins down: every voice-state update we can see is evidence that a person is
// in a call RIGHT NOW — including mute/deafen updates where channelId === oldChannelId,
// and leaves, where the old channel is where they were last seen. The map is capped so
// "record everyone visible" cannot grow without bound, the newest survive a trim, and
// the persistence rules match the sibling stores: an unread store never overwrites the
// disk, a failed write stays dirty, and many observations batch into one write.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordLastSeenCall.tsx", import.meta.url), "utf8");

/** Comment- and string-aware brace matcher (same approach as the sibling suites). */
function extract(name) {
    const needle = `function ${name}(`;
    let start = SRC.indexOf(needle);
    if (start < 0) throw new Error(`${name} not found`);
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
const MAX_USERS = num("MAX_USERS");
const TRIM_SLACK = num("TRIM_SLACK");
const FLUSH_DELAY = num("FLUSH_DELAY");
const RELOAD_DELAY = num("RELOAD_DELAY");
const KEY = "XicordLastSeenCall";

const body = [
    `const MAX_USERS=${MAX_USERS}, TRIM_SLACK=${TRIM_SLACK}, FLUSH_DELAY=${FLUSH_DELAY}, RELOAD_DELAY=${RELOAD_DELAY};`,
    `const SEEN_KEY=${JSON.stringify(KEY)};`,
    "let seen = {}; let loaded = false; let dirty = false; let flushTimer = null; let reloadTimer = null;",
    // account-scoping deps: default account null keys the global SEEN_KEY, so the existing
    // tests are unchanged; setAccount() drives the per-account path.
    "let accountId = null; let loadSeq = 0; let __acct = null;",
    `const seenKeyFor = id => id ? SEEN_KEY + ":" + id : SEEN_KEY;`,
    "const currentAccount = () => __acct;",
    extract("markDirty"),
    extract("trimSeen"),
    extract("applyVoiceStates"),
    extract("sweepAllVoiceStates"),
    extract("scheduleReload"),
    extract("load"),
    extract("scheduleFlush"),
    extract("flush"),
    extract("getSeen"),
    extract("formatAgo"),
    `return { load, flush, scheduleFlush, applyVoiceStates, sweepAllVoiceStates,
              trimSeen, getSeen, formatAgo, seenKeyFor,
              setAccount: a => { __acct = a; },
              reset: () => { seen = {}; loaded = false; },
              state: () => ({ loaded, dirty, timer: flushTimer, size: Object.keys(seen).length, acct: accountId }),
              seed: s => { seen = s; loaded = true; } };`
].join("\n");

const js = esbuild.transformSync(body, { loader: "ts" }).code;

/** A fresh module instance over a given fake disk. */
function mk(ds) {
    const timers = new Map();
    let nextId = 1;
    const setTimeout_ = (fn, ms) => { const id = nextId++; timers.set(id, fn); return id; };
    const clearTimeout_ = id => timers.delete(id);
    const api = new Function("DataStore", "console", "setTimeout", "clearTimeout", js)(
        ds, { error() { }, log() { } }, setTimeout_, clearTimeout_);
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

const rec = at => ({ at, channelId: "c1" });
const many = n => Object.fromEntries(Array.from({ length: n }, (_, i) => ["u" + i, rec(i + 1)]));

const settle = () => new Promise(r => globalThis.setTimeout(r, 0));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};

console.log("\n-- every kind of voice-state update counts as being seen --");
{
    const h = mk(fakeDS());
    h.seed({});
    const n = h.applyVoiceStates([
        { userId: "join", channelId: "c1", oldChannelId: null, guildId: "g1" },
        { userId: "move", channelId: "c2", oldChannelId: "c1", guildId: "g1" },
        { userId: "mute", channelId: "c3", oldChannelId: "c3", guildId: "g1" }
    ], "me", 1000);
    ok("join, move and same-channel updates all record", n === 3, String(n));
    ok("a join is placed in its channel", h.getSeen("join")?.channelId === "c1", JSON.stringify(h.getSeen("join")));
    ok("a move is placed in the NEW channel", h.getSeen("move")?.channelId === "c2", JSON.stringify(h.getSeen("move")));
    ok("with the time of the event", h.getSeen("mute")?.at === 1000, JSON.stringify(h.getSeen("mute")));
}

console.log("\n-- a leave is still a sighting, in the channel they left --");
{
    const h = mk(fakeDS());
    h.seed({});
    h.applyVoiceStates([{ userId: "u1", channelId: null, oldChannelId: "c9", guildId: "g1" }], "me", 2000);
    const got = h.getSeen("u1");
    ok("the leave records", !!got, JSON.stringify(got));
    ok("in the old channel", got?.channelId === "c9", JSON.stringify(got));
    ok("at the leave time", got?.at === 2000, JSON.stringify(got));
}

console.log("\n-- what never records --");
{
    const h = mk(fakeDS());
    h.seed({});
    h.applyVoiceStates([
        { userId: "me", channelId: "c1", oldChannelId: null, guildId: "g1" },
        { userId: null, channelId: "c1", oldChannelId: null },
        { userId: "ghost", channelId: null, oldChannelId: null }
    ], "me", 1000);
    ok("yourself is skipped", h.getSeen("me") === null, JSON.stringify(h.getSeen("me")));
    ok("a state with no channel at all is skipped", h.getSeen("ghost") === null, JSON.stringify(h.getSeen("ghost")));
    ok("nothing scheduled a write", h.pending() === 0, String(h.pending()));
}

console.log("\n-- a newer sighting replaces an older one --");
{
    const h = mk(fakeDS());
    h.seed({ u1: { at: 100, channelId: "old", guildId: "g0" } });
    h.applyVoiceStates([{ userId: "u1", channelId: "new", oldChannelId: null, guildId: "g1" }], "me", 5000);
    const got = h.getSeen("u1");
    ok("the record moved on", got?.at === 5000 && got?.channelId === "new", JSON.stringify(got));
}

console.log("\n-- the startup sweep seeds everyone already in a call --");
{
    const h = mk(fakeDS());
    h.seed({});
    const n = h.sweepAllVoiceStates({
        g1: {
            a: { channelId: "c1" },
            b: { channelId: "c2" },
            me: { channelId: "c1" },
            idle: { channelId: null }
        },
        g2: { c: { channelId: "c3" } }
    }, "me", 7000);
    ok("everyone in a channel is seeded", n === 3, String(n));
    ok("in the channel they are sitting in",
        h.getSeen("a")?.channelId === "c1" && h.getSeen("c")?.channelId === "c3",
        JSON.stringify([h.getSeen("a"), h.getSeen("c")]));
    ok("yourself is skipped", h.getSeen("me") === null);
    ok("someone with no channel is skipped", h.getSeen("idle") === null);
}

console.log("\n-- the map cannot grow without bound --");
{
    const h = mk(fakeDS());
    const inside = many(MAX_USERS + TRIM_SLACK);
    h.trimSeen(inside, MAX_USERS, TRIM_SLACK);
    ok("inside the slack nothing is touched", Object.keys(inside).length === MAX_USERS + TRIM_SLACK,
        String(Object.keys(inside).length));

    const past = many(MAX_USERS + TRIM_SLACK + 1);
    h.trimSeen(past, MAX_USERS, TRIM_SLACK);
    ok("one past the slack cuts back to the cap", Object.keys(past).length === MAX_USERS,
        String(Object.keys(past).length));
    ok("the OLDEST were dropped", !past.u0 && !!past["u" + (MAX_USERS + TRIM_SLACK)],
        JSON.stringify(Object.keys(past).slice(0, 3)));
}

console.log("\n-- writes are batched, not one per sighting --");
{
    const ds = fakeDS();
    const h = mk(ds);
    await h.load();
    for (let i = 0; i < 300; i++)
        h.applyVoiceStates([{ userId: "u" + i, channelId: "c1", oldChannelId: null, guildId: "g1" }], "me", i);
    ok("300 sightings schedule ONE flush", h.pending() === 1, String(h.pending()));
    h.fire();
    await settle();
    ok("and produce one write", ds.writes === 1, String(ds.writes));
    ok("carrying all 300", Object.keys(ds.data[KEY] ?? {}).length === 300,
        String(Object.keys(ds.data[KEY] ?? {}).length));
}

console.log("\n-- an unread store must never overwrite a real one --");
{
    const ds = fakeDS({ [KEY]: many(40) });
    const h = mk(ds);
    h.applyVoiceStates([{ userId: "early", channelId: "c1", oldChannelId: null, guildId: "g1" }], "me", 999);
    h.fire();
    await settle();
    ok("the flush refuses to run before the read", ds.writes === 0, String(ds.writes));
    ok("and the map on disk is intact", Object.keys(ds.data[KEY]).length === 40,
        String(Object.keys(ds.data[KEY]).length));
    await h.load();
    ok("the read merges the disk copy in", h.getSeen("u5")?.at === 6, JSON.stringify(h.getSeen("u5")));
    ok("without losing what was seen before it landed", h.getSeen("early")?.at === 999,
        JSON.stringify(h.getSeen("early")));
    ok("and the held-back write is rescheduled", h.pending() === 1, String(h.pending()));
}

console.log("\n-- a failed write is retried, not silently dropped --");
{
    const ds = fakeDS();
    const h = mk(ds);
    await h.load();
    h.applyVoiceStates([{ userId: "u1", channelId: "c1", oldChannelId: null, guildId: "g1" }], "me", 1);
    ds.fail = true;
    h.fire();
    await settle();
    ok("the failure leaves it dirty", h.state().dirty === true, JSON.stringify(h.state()));
    ok("and re-arms a retry on its own, without a fresh sighting", h.pending() === 1, String(h.pending()));
    ds.fail = false;
    h.fire();          // fire the auto-scheduled retry — no manual re-arm
    await settle();
    ok("so the next flush lands it", Object.keys(ds.data[KEY] ?? {}).length === 1,
        String(Object.keys(ds.data[KEY] ?? {}).length));
}

console.log("\n-- damaged inputs cannot take the store down --");
{
    const h1 = mk(fakeDS({ [KEY]: "not an object" }));
    await h1.load();
    ok("junk on disk yields an empty map, not a throw", h1.state().size === 0, String(h1.state().size));

    const h2 = mk(fakeDS({ [KEY]: [1, 2, 3] }));
    await h2.load();
    ok("an array is junk too", h2.state().size === 0, String(h2.state().size));

    const h3 = mk(fakeDS({ [KEY]: { good: rec(5), bad: { at: "yesterday" }, worse: null, nan: { at: NaN, channelId: "c" } } }));
    await h3.load();
    ok("bad entries are dropped, good ones kept", h3.state().size === 1 && h3.getSeen("good")?.at === 5,
        JSON.stringify(h3.getSeen("good")));
    ok("a non-finite timestamp is rejected, never admitted", h3.getSeen("nan") === null,
        JSON.stringify(h3.getSeen("nan")));
}

console.log("\n-- a read that throws must NOT overwrite the disk it could not read --");
{
    // the data-loss the load guard exists to prevent: the disk holds a full map, the
    // read blows up transiently, and a sighting arrives before it is retried
    const ds = fakeDS({ [KEY]: many(5000) });
    ds.getFail = true;
    const h = mk(ds);
    await h.load();
    ok("a failed read leaves the store UNloaded", h.state().loaded === false, JSON.stringify(h.state()));
    h.applyVoiceStates([{ userId: "live", channelId: "c1", oldChannelId: null }], "me", 42);
    h.fire();
    await settle();
    ok("so the near-empty memory is never flushed over the disk", ds.writes === 0, String(ds.writes));
    ok("and the 5000 records on disk are intact", Object.keys(ds.data[KEY]).length === 5000,
        String(Object.keys(ds.data[KEY]).length));

    ds.getFail = false;
    h.fire();          // the auto-scheduled reload retry
    await settle();
    ok("the retried read brings the disk back", h.getSeen("u5")?.at === 6, JSON.stringify(h.getSeen("u5")));
    ok("without dropping the sighting seen while it was down", h.getSeen("live")?.at === 42,
        JSON.stringify(h.getSeen("live")));
    ok("and the deferred write now lands", h.pending() === 1, String(h.pending()));
}

console.log("\n-- restart --");
{
    const ds = fakeDS();
    const first = mk(ds);
    await first.load();
    first.applyVoiceStates([{ userId: "u1", channelId: "c1", oldChannelId: null, guildId: "g1" }], "me", 123);
    first.fire();
    await settle();

    const second = mk(ds);
    await second.load();
    ok("a sighting survives a restart", second.getSeen("u1")?.at === 123, JSON.stringify(second.getSeen("u1")));
}

console.log("\n-- the pill text --");
{
    const { formatAgo } = mk(fakeDS());
    const MIN = 60000, H = 60 * MIN, D = 24 * H;
    ok("under a minute is 'just now'", formatAgo(30 * 1000) === "just now", formatAgo(30 * 1000));
    ok("minutes", formatAgo(5 * MIN) === "5m", formatAgo(5 * MIN));
    ok("hours", formatAgo(3 * H) === "3h", formatAgo(3 * H));
    ok("days", formatAgo(2 * D) === "2d", formatAgo(2 * D));
    ok("months", formatAgo(65 * D) === "2mo", formatAgo(65 * D));
    ok("a clock skewed into the future still reads 'just now'", formatAgo(-5000) === "just now", formatAgo(-5000));
}

console.log("\n-- sightings are per-account --");
{
    const ds = fakeDS({ [KEY]: { u1: { at: 5, channelId: "c" } } });   // pre-existing GLOBAL store
    const a = mk(ds);
    a.setAccount("ACCT_A");
    await a.load();
    ok("account A adopts the old global store", !!a.getSeen("u1"), JSON.stringify(a.getSeen("u1")));
    ok("the global key is removed once adopted", !(KEY in ds.data), Object.keys(ds.data).join(","));
    ok("A's data lives under A's key", !!ds.data[KEY + ":ACCT_A"]?.u1, Object.keys(ds.data).join(","));

    const b = mk(ds);
    b.setAccount("ACCT_B");
    await b.load();
    ok("account B sees none of A's sightings", b.state().size === 0 && !b.getSeen("u1"), String(b.state().size));
    b.sweepAllVoiceStates({ g1: { z: { userId: "z", channelId: "c9" } } }, null, 10);
    b.flush(); await new Promise(r => globalThis.setTimeout(r, 0));
    ok("B's own sighting lands under B's key", !!ds.data[KEY + ":ACCT_B"]?.z, JSON.stringify(Object.keys(ds.data)));
    ok("A's store is untouched by B", !!ds.data[KEY + ":ACCT_A"]?.u1 && !ds.data[KEY + ":ACCT_A"]?.z);
}

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
