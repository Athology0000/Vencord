// Exercises the REAL all-server friend-sweep functions from xicordDossier.tsx, plus
// the dossier picker's keyword search.
//   node src/userplugins/_friendMap.test.mjs
//
// The distinction the whole feature rests on: "we have not looked this person up yet"
// (null) is NOT "this person has added nobody" ([]). Mutuals paces itself at one fetch
// every 2.5s, so a sweep of a few thousand people is unfinished for hours — and if
// unfinished read as answered, the panel would confidently report that almost nobody
// in your servers has added anyone, which is the opposite of what it exists to say.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
// Normalised: an editor converted the source to CRLF, and every multi-line marker below
// silently stopped matching. Line endings are not something a test should be sensitive to.
const SRC = readFileSync(new URL("./xicordDossier.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Source between two markers, so the test runs the shipped code, not a copy. */
function span(from, to) {
    const a = SRC.indexOf(from);
    if (a < 0) throw new Error(`marker not found: ${from}`);
    const b = SRC.indexOf(to, a);
    if (b < 0) throw new Error(`end marker not found: ${to}`);
    return SRC.slice(a, b);
}
/**
 * Real constant values, so a change to the caps shows up here rather than silently.
 * A cap may be a literal or the shared `NO_LIMIT` sentinel, which is 0 — and 0 is a
 * meaningful value here, not an absence, so it is resolved rather than defaulted.
 */
function num(name) {
    const m = new RegExp(`const ${name} = (\\d+|NO_LIMIT)`).exec(SRC);
    if (!m) throw new Error(`constant not found: ${name}`);
    if (m[1] === "NO_LIMIT") {
        const lim = /const NO_LIMIT = (\d+)/.exec(SRC);
        if (!lim) throw new Error("NO_LIMIT is referenced but not defined");
        return Number(lim[1]);
    }
    return Number(m[1]);
}

const MEMBER_SWEEP_CAP = num("MEMBER_SWEEP_CAP");
const SWEEP_TOTAL_CAP = num("SWEEP_TOTAL_CAP");
const MAX_FRIEND_MAP = num("MAX_FRIEND_MAP");

const ts = [
    `const NO_LIMIT = 0;`,
    `const uncapped = n => !(n > 0);`,
    `const MEMBER_SWEEP_CAP = ${MEMBER_SWEEP_CAP};`,
    `const SWEEP_TOTAL_CAP = ${SWEEP_TOTAL_CAP};`,
    `const MAX_FRIEND_MAP = ${MAX_FRIEND_MAP};`,
    span("export interface FriendRow", "const FRIENDS_KEY"),
    span("export function pickerMatches(", "/**\n * Everyone across every server"),
    span("export function sweepableGuilds(", "function guildName("),
    span("export function newMembers(", "/** Which servers the run in progress covers"),
    span("export function addToRoster(", "/** Sweep the currently-loaded members"),
].join("\n").replace(/^export /gm, "");

const js = esbuild.transformSync(ts, { loader: "ts" }).code;
const {
    collectAllMembers, buildFriendMap, sortFriendRows,
    mergeFriendMap, storedFriendRows, filterFriendRows, pickerMatches, sweepableGuilds, addToRoster, unscannedRoster, newMembers, buildFriendGraph
} = new Function(`${js}; return { collectAllMembers, buildFriendMap, sortFriendRows, mergeFriendMap, storedFriendRows, filterFriendRows, pickerMatches, sweepableGuilds, addToRoster, unscannedRoster, newMembers, buildFriendGraph };`)();

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};
/** members-per-guild from a plain object */
const members = map => g => map[g];
/** mutuals lookup; anything absent is "not scanned yet" (null), as MutualsAPI reports */
const lookup = map => id => (id in map ? map[id] : null);
const shape = rows => rows.map(r => `${r.id}[${r.friends.join("+")}]@${r.guilds.join("/")}`).join(" ");

console.log("\n-- collectAllMembers: one entry per person, remembering every server --");
let seen = collectAllMembers(["g1", "g2"], members({ g1: ["a", "b"], g2: ["b", "c"] }), "ME");
ok("three distinct people across two servers", seen.size === 3, [...seen.keys()].join(","));
ok("someone in both servers keeps both", seen.get("b").join("/") === "g1/g2", String(seen.get("b")));
ok("someone in one server keeps one", seen.get("a").join("/") === "g1", String(seen.get("a")));

console.log("\n-- you and bots are never swept --");
seen = collectAllMembers(["g1"], members({ g1: ["ME", "bot1", "a"] }), "ME", id => id === "bot1");
ok("you are dropped", !seen.has("ME"), [...seen.keys()].join(","));
ok("bots are dropped — a bot has no friend list to prove", !seen.has("bot1"), [...seen.keys()].join(","));
ok("everyone else survives", seen.size === 1 && seen.has("a"), [...seen.keys()].join(","));

console.log("\n-- a server with nothing loaded is skipped, not a crash --");
seen = collectAllMembers(["g1", "gEmpty", ""], members({ g1: ["a"] }), "ME");
ok("an unloaded member list is survivable", seen.size === 1 && seen.has("a"), [...seen.keys()].join(","));

console.log("\n-- caps --");
seen = collectAllMembers(["g1", "g2"], members({ g1: ["a", "b", "c"], g2: ["d"] }), "ME", () => false, 2);
ok("the per-server cap only bounds that server", seen.size === 3, [...seen.keys()].join(","));
ok("and it counts KEPT people, not raw list positions",
    seen.has("a") && seen.has("b") && !seen.has("c") && seen.has("d"), [...seen.keys()].join(","));
// the per-guild cap must not be spent on people that were filtered out
seen = collectAllMembers(["g1"], members({ g1: ["ME", "ME", "a", "b"] }), "ME", () => false, 2);
ok("skipped people do not eat the per-server cap", seen.has("a") && seen.has("b"), [...seen.keys()].join(","));

seen = collectAllMembers(["g1", "g2"], members({ g1: ["a", "b"], g2: ["b", "c"] }), "ME", () => false, 99, 2);
ok("the total cap bounds distinct people (the fetch queue)", seen.size === 2, [...seen.keys()].join(","));
ok("someone already seen still gains a second server past the cap",
    seen.get("b").join("/") === "g1/g2", String(seen.get("b")));
ok("but nobody new is admitted", !seen.has("c"), [...seen.keys()].join(","));

console.log("\n-- buildFriendMap: unscanned is not the same as 'added nobody' --");
seen = collectAllMembers(["g1"], members({ g1: ["a", "b", "c"] }), "ME");
let r = buildFriendMap(seen, lookup({ a: ["f1"] }), "ME"); // b, c absent -> null
ok("only the answered person is reported", shape(r.rows) === "a[f1]@g1", shape(r.rows));
ok("the unanswered are pending, not zeroes", r.pending === 2, `${r.scanned}/${r.total} pending=${r.pending}`);
ok("scanned counts only real answers", r.scanned === 1, String(r.scanned));
ok("total counts everyone swept", r.total === 3, String(r.total));

r = buildFriendMap(seen, lookup({ a: ["f1"], b: [], c: [] }), "ME");
ok("a genuine empty answer counts as scanned", r.scanned === 3, String(r.scanned));
ok("but adds no row — they have added nobody we can see", shape(r.rows) === "a[f1]@g1", shape(r.rows));
ok("and nothing is left pending", r.pending === 0, String(r.pending));
ok("an empty answer is reported as CLEARED, so a stored claim can be retracted",
    r.cleared.sort().join(",") === "b,c", r.cleared.join(","));
ok("someone we never got an answer for is not cleared — that would delete a real finding",
    buildFriendMap(seen, lookup({ a: ["f1"] }), "ME").cleared.length === 0);

console.log("\n-- you never appear, in either column --");
seen = new Map([["ME", ["g1"]], ["a", ["g1"]]]);
r = buildFriendMap(seen, lookup({ ME: ["f1"], a: ["f1", "ME"] }), "ME");
ok("you are not a row", !r.rows.some(x => x.id === "ME"), shape(r.rows));
ok("you are not counted in the sweep total", r.total === 1, String(r.total));
ok("and 'they added you' is dropped — it is true of everyone here",
    shape(r.rows) === "a[f1]@g1", shape(r.rows));

console.log("\n-- ordering: most additions first, then most servers, then stable --");
seen = new Map([["a", ["g1"]], ["b", ["g1", "g2"]], ["c", ["g1"]], ["d", ["g1"]]]);
r = buildFriendMap(seen, lookup({ a: ["f1"], b: ["f1"], c: ["f1", "f2", "f3"], d: ["f1"] }), "ME");
ok("most friends wins", r.rows[0].id === "c", r.rows.map(x => x.id).join(","));
ok("then most servers", r.rows[1].id === "b", r.rows.map(x => x.id).join(","));
ok("then a stable tiebreak", r.rows.map(x => x.id).join(",") === "c,b,a,d", r.rows.map(x => x.id).join(","));

const input = [{ id: "b", friends: ["f"], guilds: [] }, { id: "a", friends: ["f", "g"], guilds: [] }];
sortFriendRows(input);
ok("sortFriendRows does not reorder its argument", input[0].id === "b", input.map(x => x.id).join(","));

console.log("\n-- mergeFriendMap: findings survive the restart the scan cache does not --");
let store = mergeFriendMap({}, [{ id: "a", friends: ["f1"], guilds: ["g1"] }], 1000);
ok("a finding is stored", store.a.friends.join("+") === "f1", JSON.stringify(store.a));
store = mergeFriendMap(store, [{ id: "a", friends: ["f1", "f2"], guilds: ["g2"] }], 2000);
ok("servers accumulate — a sweep only sees what Discord happened to load",
    store.a.guilds.join("/") === "g1/g2", JSON.stringify(store.a));
ok("friends are replaced by the newer answer, not merged",
    store.a.friends.join("+") === "f1+f2", JSON.stringify(store.a));
store = mergeFriendMap(store, [{ id: "a", friends: ["f1"], guilds: ["g1"] }], 3000);
ok("so an unfriending actually disappears", store.a.friends.join("+") === "f1", JSON.stringify(store.a));
ok("and the timestamp moves", store.a.at === 3000, String(store.a.at));
ok("a repeated server is not duplicated", store.a.guilds.join("/") === "g1/g2", JSON.stringify(store.a));

const before = { a: { friends: ["f1"], guilds: ["g1"], at: 1 } };
mergeFriendMap(before, [{ id: "a", friends: ["f9"], guilds: ["g9"] }], 2);
ok("the previous store is not mutated", before.a.friends.join("+") === "f1", JSON.stringify(before.a));

console.log("\n-- a finding is retractable: an unfriending must not stand forever --");
// The store outlives the scan cache, and the graph falls back to it for the gold
// "proven friendship" ring — so a claim that can only ever be added is a claim that
// can never be corrected.
store = { x: { friends: ["f1"], guilds: ["g1"], at: 1 }, y: { friends: ["f2"], guilds: ["g1"], at: 1 } };
store = mergeFriendMap(store, [], 2, 9, ["x"]);
ok("someone who now scans as having nobody is dropped", !store.x, Object.keys(store).join(","));
ok("and everyone else is untouched", store.y.friends.join("+") === "f2", Object.keys(store).join(","));

store = { x: { friends: ["f1"], guilds: ["g1"], at: 1 } };
store = mergeFriendMap(store, [{ id: "x", friends: ["f2"], guilds: ["g2"] }], 2, 9, ["x"]);
ok("a row wins over a clear for the same person — the newer answer is the row",
    store.x?.friends.join("+") === "f2", JSON.stringify(store.x));

const beforeClear = { x: { friends: ["f1"], guilds: [], at: 1 } };
mergeFriendMap(beforeClear, [], 2, 9, ["x"]);
ok("clearing does not mutate the previous store either", !!beforeClear.x, JSON.stringify(beforeClear));
ok("clearing an unknown person is harmless",
    Object.keys(mergeFriendMap({ a: { friends: ["f"], guilds: [], at: 1 } }, [], 2, 9, ["zz"])).join(",") === "a");

console.log("\n-- the map is bounded, and drops the stalest first --");
store = mergeFriendMap(
    { old1: { friends: ["f"], guilds: [], at: 1 }, old2: { friends: ["f"], guilds: [], at: 2 } },
    [{ id: "fresh", friends: ["f"], guilds: [] }], 9, 2);
ok("the cap is honoured", Object.keys(store).length === 2, Object.keys(store).join(","));
ok("the newest survive", store.fresh && store.old2, Object.keys(store).join(","));
ok("the oldest is evicted", !store.old1, Object.keys(store).join(","));

console.log("\n-- storedFriendRows --");
let rows = storedFriendRows({
    a: { friends: ["f1", "f2"], guilds: ["g1"], at: 1 },
    b: { friends: [], guilds: ["g1"], at: 1 },
    c: { friends: ["f1"], guilds: ["g1", "g2"], at: 1 },
});
ok("only people with a proven addition are rows", shape(rows) === "a[f1+f2]@g1 c[f1]@g1/g2", shape(rows));
ok("a malformed entry does not throw", storedFriendRows({ x: {}, y: null }).length === 0);
ok("an absent store does not throw", storedFriendRows(undefined).length === 0);

console.log("\n-- filterFriendRows: search the additions too, not just the person --");
rows = storedFriendRows({
    "111": { friends: ["222"], guilds: ["g1"], at: 1 },
    "333": { friends: ["444"], guilds: ["g1"], at: 1 },
});
const names = { 111: "Alice", 222: "Bob", 333: "Carol", 444: "Dave" };
const nameOf = id => names[id] ?? id;
ok("an empty query keeps everything", filterFriendRows(rows, "  ", nameOf).length === 2);
ok("matches the person by name", filterFriendRows(rows, "ali", nameOf).map(r => r.id).join(",") === "111");
ok("matches the person by ID", filterFriendRows(rows, "333", nameOf).map(r => r.id).join(",") === "333");
ok("matches by WHO THEY ADDED — the question this view answers",
    filterFriendRows(rows, "bob", nameOf).map(r => r.id).join(",") === "111");
ok("and by the added person's ID", filterFriendRows(rows, "444", nameOf).map(r => r.id).join(",") === "333");
ok("case is ignored", filterFriendRows(rows, "BOB", nameOf).length === 1);
ok("no match is empty, not everything", filterFriendRows(rows, "zzz", nameOf).length === 0);

// The scan is rows x their friends with a user-store lookup at every step, and it runs on
// every keystroke. Your friends are what the rows have in COMMON, so the same few ids were
// being looked up over and over. Names must still be read fresh on each CALL, though —
// they resolve in the background, and caching them across calls would mean a name that
// arrives late never starts matching.
console.log("\n-- filterFriendRows: a name is looked up once per call, not once per row --");
{
    const wide = storedFriendRows(Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`9${i}`, { friends: ["222", "444"], guilds: ["g1"], at: 1 }])));
    let lookups = 0;
    const counting = id => { lookups++; return names[id] ?? id; };
    const hit = filterFriendRows(wide, "bob", counting);
    ok("every row still matches on the friend they share", hit.length === 200, String(hit.length));
    // 200 rows x (1 self + up to 2 friends) would be ~600 without the per-call cache.
    ok(`distinct ids are looked up once each (${lookups} lookups for 200 rows)`,
        lookups <= 202, String(lookups));

    lookups = 0;
    filterFriendRows(wide, "bob", counting);
    ok("and the next call looks them up again, so late-resolving names start matching",
        lookups > 0, String(lookups));
}

console.log("\n-- pickerMatches: 'watched' lists who you chose, not who contains the word --");
const all = ["t1", "t2", "p1", "p2", "p3"];
const targets = new Set(["t1", "t2"]);
const pname = id => ({ t1: "Tara", t2: "Tom", p1: "Peter", p2: "Paula", p3: "watchdog" })[id];
const isTarget = id => targets.has(id);

let p = pickerMatches("watched", all, pname, isTarget);
ok("only Target-trait people come back", p.ids.join(",") === "t1,t2", p.ids.join(","));
ok("the keyword is reported, so the UI can explain itself", p.keyword === "watched", String(p.keyword));
ok("someone merely NAMED 'watchdog' is not included", !p.ids.includes("p3"), p.ids.join(","));
ok("matched is the true total", p.matched === 2, String(p.matched));

for (const word of ["Watched", "  watched  ", "watching", "targets", "target"]) {
    p = pickerMatches(word, all, pname, isTarget);
    ok(`"${word}" is the same keyword`, p.keyword === "watched" && p.ids.join(",") === "t1,t2", p.ids.join(","));
}

p = pickerMatches("all", all, pname, isTarget);
ok("'all' lists the whole dossier", p.ids.length === 5 && p.keyword === "all", p.ids.join(","));
p = pickerMatches("everyone", all, pname, isTarget);
ok("'everyone' is the same", p.ids.length === 5 && p.keyword === "all", p.ids.join(","));

console.log("\n-- ordinary searching still works --");
p = pickerMatches("pa", all, pname, isTarget);
ok("substring match on the name", p.ids.join(",") === "p2", p.ids.join(","));
ok("no keyword flag for a plain search", p.keyword === null, String(p.keyword));
p = pickerMatches("t1", all, pname, isTarget);
ok("substring match on the ID", p.ids.join(",") === "t1", p.ids.join(","));
p = pickerMatches("watchdog", all, pname, isTarget);
ok("the full name 'watchdog' is a plain search, not the keyword",
    p.keyword === null && p.ids.join(",") === "p3", `${p.keyword} ${p.ids.join(",")}`);
p = pickerMatches("   ", all, pname, isTarget);
ok("an empty query shows nobody — the list stays hidden until you type",
    p.ids.length === 0 && p.matched === 0, p.ids.join(","));

console.log("\n-- limits: asking for the whole list may exceed a name search's cap --");
const many = Array.from({ length: 400 }, (_, i) => `u${i}`);
p = pickerMatches("u", many, id => id, () => false, 60, 300);
ok("a name search is capped", p.ids.length === 60, String(p.ids.length));
ok("but reports how many it really found", p.matched === 400, String(p.matched));
p = pickerMatches("all", many, id => id, () => false, 60, 300);
ok("a keyword list gets the bigger cap", p.ids.length === 300, String(p.ids.length));
ok("and still reports the true total", p.matched === 400, String(p.matched));
p = pickerMatches("watched", many, id => id, () => true, 60, 300);
ok("'watched' uses the keyword cap too", p.ids.length === 300, String(p.ids.length));

console.log("\n-- picking a server to sweep --");
// "Sweep every server only did 1300 but I'm in 130k-member servers" is not a cap being
// hit: Discord only sends the client the members it has actually delivered, a few
// hundred per big server. These counts have to report THAT, so aiming the sweep at one
// server is an informed choice rather than a guess.
{
    const members = {
        huge: ["1", "2", "3", "bot1", "me"],   // 130k members, 5 delivered
        small: ["4", "5"],
        empty: [],
        botsOnly: ["bot1", "bot2"]
    };
    const names = { huge: "Massive Server", small: "Small Server", empty: "Nobody Loaded", botsOnly: "Bots" };
    const g = sweepableGuilds(Object.keys(members), id => members[id], id => names[id], "me",
        id => id.startsWith("bot"));

    ok(`only servers with real loaded members are offered (${g.map(x => x.name).join(", ")})`,
        g.length === 2, JSON.stringify(g));
    ok("busiest first", g[0].id === "huge" && g[1].id === "small", g.map(x => x.id).join(","));
    ok("the count is loaded members, not the server's size", g[0].loaded === 3, String(g[0].loaded));
    ok("you are not counted", !g.some(x => x.loaded > 3));
    ok("bots are not counted", !g.some(x => x.id === "botsOnly"));
    ok("a server with nothing loaded is not offered", !g.some(x => x.id === "empty"));
    ok("names come through for the picker", g[0].name === "Massive Server", g[0].name);

    // the picker total must agree with what an all-server sweep would actually queue
    const swept = collectAllMembers(Object.keys(members), id => members[id], "me", id => id.startsWith("bot"));
    ok(`the offered total matches what a sweep queues (${g.reduce((a, x) => a + x.loaded, 0)} vs ${swept.size})`,
        g.reduce((a, x) => a + x.loaded, 0) === swept.size, `${g.reduce((a, x) => a + x.loaded, 0)} vs ${swept.size}`);

    // aiming at one server must queue only that server's people
    const one = collectAllMembers(["small"], id => members[id], "me", id => id.startsWith("bot"));
    ok("sweeping one server queues only its members", [...one.keys()].sort().join(",") === "4,5",
        [...one.keys()].join(","));
    ok("and records which server they came from", one.get("4").join(",") === "small");

    ok("no guilds at all -> nothing offered, no crash", sweepableGuilds([], () => [], () => "", "me").length === 0);
    ok("a guild the store knows nothing about is skipped",
        sweepableGuilds(["ghost"], () => undefined, () => "Ghost", "me").length === 0);
}

console.log("\n-- the roster: a backlog that outlives the click and the session --");
// The button can only ever queue what Discord happened to have delivered at that moment,
// which is why a 130k-member server yields a few hundred. The roster accumulates instead
// — every member the client is handed, across sessions — and is worked through quietly.
{
    const now = 1000;
    const store = {};
    let added = addToRoster(store, new Map([["a", ["g1"]], ["b", ["g1"]]]), now);
    ok("new people are added", added === 2 && Object.keys(store).length === 2, JSON.stringify(store));

    added = addToRoster(store, new Map([["a", ["g1"]], ["c", ["g2"]]]), now + 1);
    ok("re-seeing someone is not a new person", added === 1, String(added));
    ok("and does not reset when they were first seen", store.a.at === now, String(store.a.at));

    addToRoster(store, new Map([["a", ["g2", "g3"]]]), now + 2);
    ok("but it does record the extra servers", store.a.guilds.join(",") === "g1,g2,g3", store.a.guilds.join(","));
    addToRoster(store, new Map([["a", ["g2"]]]), now + 3);
    ok("without duplicating one", store.a.guilds.join(",") === "g1,g2,g3", store.a.guilds.join(","));

    // the cap must evict the STALEST, so a long-lived client drifts towards the people
    // it is actually seeing rather than freezing on whoever it met first
    const capped = {};
    addToRoster(capped, new Map([["old", ["g1"]]]), 1, 2);
    addToRoster(capped, new Map([["mid", ["g1"]]]), 2, 2);
    addToRoster(capped, new Map([["new", ["g1"]]]), 3, 2);
    ok(`the cap holds (${Object.keys(capped).join(",")})`, Object.keys(capped).length === 2, Object.keys(capped).join(","));
    ok("the oldest entry is the one dropped", !capped.old && capped.mid && capped.new, Object.keys(capped).join(","));

    // scanning order: oldest first, so the backlog drains rather than churning the tail
    const q = {};
    addToRoster(q, new Map([["first", ["g"]]]), 10);
    addToRoster(q, new Map([["second", ["g"]]]), 20);
    addToRoster(q, new Map([["third", ["g"]]]), 30);
    ok("unscanned come out oldest-first", unscannedRoster(q, () => false, 10).join(",") === "first,second,third",
        unscannedRoster(q, () => false, 10).join(","));
    ok("already-answered people are skipped, so a restart costs nothing",
        unscannedRoster(q, id => id === "first", 10).join(",") === "second,third",
        unscannedRoster(q, id => id === "first", 10).join(","));
    ok("the batch limit is honoured, so Mutuals is topped up not flooded",
        unscannedRoster(q, () => false, 2).join(",") === "first,second",
        unscannedRoster(q, () => false, 2).join(","));
    ok("everyone answered -> nothing to do", unscannedRoster(q, () => true, 10).length === 0);
    ok("an empty roster is not a crash", unscannedRoster({}, () => false, 10).length === 0);

    // the roster is the union of repeated sweeps — the whole point of persisting it
    const grow = {};
    addToRoster(grow, collectAllMembers(["g1"], members({ g1: ["a", "b"] }), "ME"), 1);
    addToRoster(grow, collectAllMembers(["g1"], members({ g1: ["b", "c", "d"] }), "ME"), 2);
    ok(`two partial loads union into one roster (${Object.keys(grow).sort().join(",")})`,
        Object.keys(grow).sort().join(",") === "a,b,c,d", Object.keys(grow).sort().join(","));
}


console.log("\n-- auto-widen: only the members that are genuinely new --");
// Discord streams a big server's member list in ranges as you scroll. Widening on that
// is only worth it if it costs the arrivals, not a re-walk of the whole list.
const roster = { known1: { guilds: ["g1"], at: 1 }, known2: { guilds: ["g1"], at: 1 } };
let fresh = newMembers(roster, ["known1", "new1", "known2", "new2"], "ME");
ok("already-rostered people are not re-offered", fresh.join(",") === "new1,new2", fresh.join(","));
ok("you are never in the list", newMembers(roster, ["ME", "new3"], "ME").join(",") === "new3");
ok("bots are dropped", newMembers(roster, ["b1", "new4"], "ME", id => id === "b1").join(",") === "new4");
ok("a repeated id inside one update is only offered once",
    newMembers(roster, ["dup", "dup", "dup"], "ME").join(",") === "dup");
ok("an empty or absent list is survivable",
    newMembers(roster, [], "ME").length === 0 && newMembers(roster, undefined, "ME").length === 0);
ok("blank ids are skipped", newMembers(roster, ["", null, "ok1"], "ME").join(",") === "ok1");
ok("nothing new means no work at all", newMembers(roster, ["known1", "known2"], "ME").length === 0);
ok("the roster is not mutated by asking", Object.keys(roster).join(",") === "known1,known2");


console.log("\n-- caps switched off: 0 means unlimited, not zero --");
// The trap this guards: slice(0, 0) returns an EMPTY array, and `size >= 0` is always
// true. Read naively, "no limit" would sweep nobody and roster nobody — a total failure
// that looks exactly like a quiet, well-behaved run.
{
    const capIds = Array.from({ length: 60 }, (_, i) => "u" + i);
    const capMany = { g1: capIds };
    let all = collectAllMembers(["g1"], members(capMany), "ME", () => false, 0, 0);
    ok("an uncapped per-guild sweep takes everyone", all.size === 60, String(all.size));
    all = collectAllMembers(["g1"], members(capMany), "ME", () => false, 10, 0);
    ok("a real per-guild cap still bites", all.size === 10, String(all.size));
    all = collectAllMembers(["g1"], members(capMany), "ME", () => false, 0, 10);
    ok("a real total cap still bites", all.size === 10, String(all.size));

    const capRoster = {};
    addToRoster(capRoster, collectAllMembers(["g1"], members(capMany), "ME", () => false, 0, 0), 1, 0);
    ok("an uncapped roster keeps everyone", Object.keys(capRoster).length === 60, String(Object.keys(capRoster).length));
    const capSmall = {};
    addToRoster(capSmall, collectAllMembers(["g1"], members(capMany), "ME", () => false, 0, 0), 1, 5);
    ok("a real roster cap still evicts", Object.keys(capSmall).length === 5, String(Object.keys(capSmall).length));

    const capRows = capIds.map(id => ({ id, friends: ["f1"], guilds: [] }));
    ok("an uncapped friend map keeps everyone", Object.keys(mergeFriendMap({}, capRows, 1, 0)).length === 60,
        String(Object.keys(mergeFriendMap({}, capRows, 1, 0)).length));
    ok("a real friend-map cap still trims", Object.keys(mergeFriendMap({}, capRows, 1, 7)).length === 7);
}

console.log("\n-- the friend map as a network --");
// The list answers "who added someone". The graph answers "who clusters around whom",
// which a list physically cannot show: two people who added the same three friends sit
// together here and are fifty rows apart there.
{
    const gRows = [
        { id: "p1", friends: ["fA", "fB"], guilds: [] },
        { id: "p2", friends: ["fA"], guilds: [] },
        { id: "p3", friends: ["fB"], guilds: [] },
    ];
    let g = buildFriendGraph(gRows, 100);
    ok("your friends become the hubs", g.hubs.sort().join(",") === "fA,fB", g.hubs.join(","));
    ok("everyone who added them is a node", g.people.sort().join(",") === "p1,p2,p3", g.people.join(","));
    ok("one edge per proven friendship", g.edges.length === 4, String(g.edges.length));
    ok("the busiest hub is listed first", g.hubs[0] === "fA" || g.hubs[0] === "fB", g.hubs.join(","));

    // the cap must never drop a hub: doing so silently orphans everyone who added them
    g = buildFriendGraph(gRows, 1);
    ok("a tight cap keeps only the best-connected person", g.people.length === 1, g.people.join(","));
    ok("but both hubs survive the cap", g.hubs.sort().join(",") === "fA,fB", g.hubs.join(","));
    ok("and it reports how many were left out", g.total === 3, String(g.total));
    ok("every edge still has both ends present",
        g.edges.every(([a, b]) => g.people.includes(a) || g.hubs.includes(a)),
        JSON.stringify(g.edges));

    ok("no rows means no graph", buildFriendGraph([], 100).edges.length === 0);
    ok("a zero cap keeps the hubs but no orbit", buildFriendGraph(gRows, 0).people.length === 0);
    // somebody who is BOTH your friend and someone who added a friend must not be
    // duplicated as a hub and an orbiter
    g = buildFriendGraph([{ id: "fA", friends: ["fB"], guilds: [] }, { id: "p1", friends: ["fA"], guilds: [] }], 100);
    ok("a person who is both a hub and an adder appears once",
        !g.people.includes("fA") && g.hubs.includes("fA"), JSON.stringify([g.hubs, g.people]));
}
console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
