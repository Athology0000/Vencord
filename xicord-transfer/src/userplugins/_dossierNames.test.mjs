// Extracts the REAL name-resolution layer from xicordDossier.tsx and checks that a
// resolved username survives a restart.
//   node src/userplugins/_dossierNames.test.mjs
//
// The bug: Discord's UserStore is memory-only and starts EMPTY every launch, and the
// Xicord Cache snapshot built its name map straight from it. So every name the resolver
// ever fetched was thrown away on restart, and the dashboard — which falls back to
// ("user " + id.slice(0,6)) — showed thousands of people as "user 1a2b3c" despite
// having plenty of recorded history on them.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordDossier.tsx", import.meta.url), "utf8");

// the whole resolver + name-cache block, verbatim
const slice = SRC.slice(SRC.indexOf("const RESOLVE_DELAY"), SRC.indexOf("function initial(name: string)"))
    .replace(/^export /gm, "");   // evaluated as a plain function body, not a module
const js = esbuild.transformSync(slice, { loader: "ts" }).code;

/* ---------- shims ---------- */
let store = {};                       // stands in for IndexedDB
const DataStore = {
    get: async k => store[k],
    set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    del: async k => { delete store[k]; }
};
let liveUsers = {};                   // what UserStore currently knows (wiped on "restart")
const mkUser = (id, name) => ({ id, username: name, getAvatarURL: () => `https://cdn/${id}.png` });
const UserStore = { getUser: id => liveUsers[id] || null, getCurrentUser: () => ({ id: "ME" }) };
let fetchable = {};                   // what the API would return
let fetches = [];
let failWith = {};   // id -> error to throw (an object mimicking Discord's REST errors)
const UserUtils = {
    getUser: async id => {
        fetches.push(id);
        if (failWith[id]) {
            const e = typeof failWith[id] === "function" ? failWith[id](fetches.filter(f => f === id).length) : failWith[id];
            if (e) throw e;
        }
        if (!fetchable[id]) { const e = new Error("no such user"); e.status = 404; e.body = { code: 10013 }; throw e; }
        return fetchable[id];
    }
};
const notFound = () => Object.assign(new Error("404"), { status: 404, body: { code: 10013 } });
const rateLimited = () => Object.assign(new Error("429"), { status: 429, body: { retry_after: 0.001 } });
const blip = () => Object.assign(new Error("network"), { status: 500 });
const IconUtils = { getDefaultAvatarURL: id => `default:${id}` };
const React = { useReducer: () => [0, () => { }], useEffect: () => { } };
let profiles = {};
const settings = { store: {} };

const build = new Function("DataStore", "UserStore", "UserUtils", "IconUtils", "React", "getProfiles", "setTimeoutFn", "acct",
    `let active = true, loaded = true;
     // The name cache is account-scoped now; the resolver's flush keys on this.
     let accountId = acct;
     let profiles = getProfiles();
     const setTimeout = setTimeoutFn;
     ${js}
     return { rememberUser, getResolvedUsers, nameCacheSize, known, requestUsers, sweepNames,
              nameSweepProgress, uname, uavatar, stopResolving, flushNames,
              namesKeyFor,
              loadNames: async () => { const n = await DataStore.get(namesKeyFor(accountId)); if (n) knownUsers = n; },
              setProfiles: p => { profiles = p; },
              drain: async () => { for (let i = 0; i < 4000; i++) await Promise.resolve(); } };`);

// no real 220ms waits
const setTimeoutFn = fn => { Promise.resolve().then(fn); return 1; };

let api;
function boot(acct = "ME") { api = build(DataStore, UserStore, UserUtils, IconUtils, React, () => profiles, setTimeoutFn, acct); }

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};

/* ---------- tests ---------- */
console.log("\n-- a resolved name is written down, not just held in memory --");
store = {}; liveUsers = {}; fetches = [];
boot();
fetchable = { u1: mkUser("u1", "alice") };
api.requestUsers(["u1"]);
await api.drain();
ok("the missing user was fetched", fetches.includes("u1"), fetches.join(","));
ok("and remembered", api.getResolvedUsers().u1?.username === "alice", JSON.stringify(api.getResolvedUsers()));
api.flushNames();
await api.drain();
ok("it reached the store, under this account's own key",
    !!store["XicordResolvedUsers:ME"]?.u1, JSON.stringify(store));

console.log("\n-- ...and survives a restart, which is the whole point --");
// restart: UserStore is empty again, exactly as Discord starts every launch
liveUsers = {}; fetches = [];
boot();
ok("a fresh session starts with no names in memory", api.nameCacheSize() === 0);
await api.loadNames();
ok("the cache loads from disk", api.nameCacheSize() === 1, String(api.nameCacheSize()));
ok(`uname() gives the real name, not the raw id (${api.uname("u1")})`, api.uname("u1") === "alice", api.uname("u1"));
ok("uavatar() gives the remembered avatar, not the default",
    api.uavatar("u1") === "https://cdn/u1.png", api.uavatar("u1"));
ok("and it is NOT re-fetched, so a restart costs nothing", api.known("u1") === true);
api.requestUsers(["u1"]);
await api.drain();
ok("re-requesting a known user issues no network call", fetches.length === 0, fetches.join(","));

console.log("\n-- the live store still wins when it has someone --");
liveUsers.u1 = mkUser("u1", "alice_renamed");
ok("a rename in the live store is preferred over the cached copy",
    api.uname("u1") === "alice_renamed", api.uname("u1"));
api.known("u1"); // capturing from the live store is free — no fetch
ok("and the newer name is captured back into the cache",
    api.getResolvedUsers().u1.username === "alice_renamed", JSON.stringify(api.getResolvedUsers().u1));

console.log("\n-- the sweep asks for everyone the dossier knows about --");
store = {}; liveUsers = {}; fetches = [];
boot();
const prof = comps => ({ companions: Object.fromEntries(Object.entries(comps).map(([k, v]) => [k, { count: v, ms: 1000 }])) });
profiles = { A: prof({ b: 2, c: 1 }), b: prof({ A: 2 }), d: prof({}) };
api.setProfiles(profiles);
fetchable = { A: mkUser("A", "aa"), b: mkUser("b", "bb"), c: mkUser("c", "cc"), d: mkUser("d", "dd") };
let p = api.nameSweepProgress();
ok(`it counts everyone referenced, subjects and companions (${p.total})`, p.total === 4, JSON.stringify(p));
ok("all of them start unnamed", p.missing === 4, JSON.stringify(p));
api.sweepNames();
await api.drain();
ok(`every one of them was fetched (${fetches.length})`, fetches.length === 4, fetches.join(","));
p = api.nameSweepProgress();
ok("and nothing is left missing", p.missing === 0, JSON.stringify(p));
ok("all four names are cached", api.nameCacheSize() === 4, String(api.nameCacheSize()));

console.log("\n-- a second sweep costs nothing --");
fetches = [];
api.sweepNames();
await api.drain();
ok("no repeat lookups for people already named", fetches.length === 0, fetches.join(","));

console.log("\n-- a deleted account is given up on, not retried forever --");
store = {}; liveUsers = {}; fetches = []; failWith = {};
boot();
profiles = { X: prof({ gone: 1 }) };
api.setProfiles(profiles);
fetchable = { X: mkUser("X", "xx") };   // "gone" 404s
api.sweepNames();
await api.drain();
ok("the deleted account was attempted", fetches.includes("gone"), fetches.join(","));
ok("it reads as Unknown rather than a bare id", /^Unknown \(/.test(api.uname("gone")), api.uname("gone"));
ok("a 404 is decided in ONE attempt, not retried",
    fetches.filter(f => f === "gone").length === 1, `${fetches.filter(f => f === "gone").length} attempts`);
fetches = [];
api.sweepNames();
await api.drain();
ok("and it is not retried on the next sweep", fetches.length === 0, fetches.join(","));
const pg = api.nameSweepProgress();
ok("it stops counting against the progress readout", pg.missing === 0, JSON.stringify(pg));

console.log("\n-- THE BUG: a rate limit must not permanently condemn a real person --");
// Any thrown error used to mean "this account is gone". A big sweep trips Discord's
// rate limiter, so hundreds of perfectly real people were written off as "Unknown"
// and never asked for again — which is exactly what stalled the sweep.
store = {}; liveUsers = {}; fetches = []; failWith = {};
boot();
profiles = { P: prof({ limited: 1 }) };
api.setProfiles(profiles);
fetchable = { P: mkUser("P", "pp"), limited: mkUser("limited", "realperson") };
// 429 on the first attempt only, then it succeeds
failWith = { limited: n => (n === 1 ? rateLimited() : null) };
api.sweepNames();
await api.drain();
ok("a 429 does not immediately write the person off",
    api.nameSweepProgress().unresolvable === 0 && !/^Unknown/.test(api.uname("limited")), api.uname("limited"));
// a 429 deliberately pauses the pump before retrying (that is the point — not hammering
// a rate limiter), so the retry only lands after real time has passed
await new Promise(r => setTimeout(r, 2600));
await api.drain();
ok(`the rate-limited person was retried (${fetches.filter(f => f === "limited").length} attempts)`,
    fetches.filter(f => f === "limited").length >= 2, fetches.join(","));
ok("and ends up with their REAL name, not Unknown",
    api.uname("limited") === "realperson", api.uname("limited"));
ok("nothing was permanently written off", api.nameSweepProgress().unresolvable === 0,
    JSON.stringify(api.nameSweepProgress()));

console.log("\n-- a transient blip is retried too, but not forever --");
store = {}; liveUsers = {}; fetches = []; failWith = {};
boot();
profiles = { Q: prof({ flaky: 1, broken: 1 }) };
api.setProfiles(profiles);
fetchable = { Q: mkUser("Q", "qq"), flaky: mkUser("flaky", "flakyname"), broken: mkUser("broken", "never") };
failWith = { flaky: n => (n <= 2 ? blip() : null), broken: () => blip() };  // broken always fails
api.sweepNames();
await api.drain();
ok(`a flaky lookup recovers (${fetches.filter(f => f === "flaky").length} attempts)`,
    api.uname("flaky") === "flakyname", api.uname("flaky"));
const brokenTries = fetches.filter(f => f === "broken").length;
ok(`a permanently failing lookup stops after a few tries (${brokenTries})`,
    brokenTries >= 2 && brokenTries <= 4, `${brokenTries} attempts`);
ok("and is then treated as unresolvable", /^Unknown \(/.test(api.uname("broken")), api.uname("broken"));
fetches = [];
api.sweepNames();
await api.drain();
ok("it is not retried again on the next sweep", fetches.length === 0, fetches.join(","));

console.log("\n-- names are per-account: one account's cache is not another's --");
// Whatever ghostphantom resolved must land under ghostphantom's key and be invisible to
// the other account, whose cache is its own.
store = {}; liveUsers = {}; fetches = [];
boot("ACCT_A");
fetchable = { u9: mkUser("u9", "mara") };
api.requestUsers(["u9"]);
await api.drain();
api.flushNames();
await api.drain();
ok("account A's name lands under A's key", !!store["XicordResolvedUsers:ACCT_A"]?.u9, JSON.stringify(Object.keys(store)));
ok("and NOT under a shared/global key", !store.XicordResolvedUsers, JSON.stringify(Object.keys(store)));
// switch to B: a fresh boot with B's account id, same disk
liveUsers = {}; fetches = [];
boot("ACCT_B");
await api.loadNames();
ok("account B starts with an empty name cache — A's names are not visible", api.nameCacheSize() === 0, String(api.nameCacheSize()));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
