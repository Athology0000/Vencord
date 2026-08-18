// Drives the REAL all-server sweep ENGINE from xicordDossier.tsx end to end — not the
// pure helpers (those are _friendMap.test.mjs), but the wiring: startServerSweep →
// MutualsAPI queue → harvestSweep → the persisted store → a restart → retraction.
//   node src/userplugins/_friendSweep.test.mjs
//
// The bugs it guards, all of which a helper-only suite sails straight past:
//   * the run never reporting itself finished, because the people Discord rate-limited
//     stay pending forever and the Mutuals queue is shared with the voice scanner —
//     so the button sat on "Sweeping…" for the rest of the session;
//   * findings evaporating on restart, because the Mutuals cache is memory-only;
//   * a finding that could only ever be ADDED, so an unfriending left a "proven
//     friendship" claim standing for good;
//   * disabling the plugin mid-sweep leaving Mutuals fetching for hours with nobody
//     left to read a single answer.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordDossier.tsx", import.meta.url), "utf8");
const JS = esbuild.transformSync(SRC, { loader: "tsx" }).code;

function span(from, to, src = JS) {
    const a = src.indexOf(from);
    if (a < 0) throw new Error(`marker not found: ${from}`);
    const b = src.indexOf(to, a);
    if (b < 0) throw new Error(`end marker not found: ${to}`);
    return src.slice(a, b);
}
function num(name) {
    const m = new RegExp(`const ${name} = (\\d+|NO_LIMIT)`).exec(SRC);
    if (!m) throw new Error(`constant not found: ${name}`);
    // A cap may be the shared NO_LIMIT sentinel, which is 0 — a meaningful value here
    // ("no limit"), not an absence, so it is resolved rather than defaulted.
    if (m[1] === "NO_LIMIT") return Number(/const NO_LIMIT = (\d+)/.exec(SRC)[1]);
    return Number(m[1]);
}
/** Brace-match a named function out of a source, skipping strings and comments. */
function extract(name, src) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    let i = src.indexOf("{", src.indexOf(")", start)), depth = 0, mode = "code", prev = "";
    for (; i < src.length; i++) {
        const ch = src[i], next = src[i + 1];
        if (mode === "line") { if (ch === "\n") mode = "code"; }
        else if (mode === "block") { if (ch === "*" && next === "/") { mode = "code"; i++; } }
        else if (mode !== "code") { if (ch === mode && prev !== "\\") mode = "code"; }
        else if (ch === "/" && next === "/") { mode = "line"; i++; }
        else if (ch === "/" && next === "*") { mode = "block"; i++; }
        else if (ch === '"' || ch === "'" || ch === "`") mode = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (!depth) return src.slice(start, i + 1); }
        prev = ch;
    }
    throw new Error(`unbalanced ${name}`);
}
// The whole sweep engine, verbatim: every constant, module-level variable and function
// from collectAllMembers down to the end of flushFriends. Sliced out of the TRANSPILED
// source, so the markers have to be code — esbuild drops the comments.
const ENGINE = span("function collectAllMembers(", 'const PROFILES_KEY = "XicordDossierProfiles"')
    .replace(/^export /gm, "");
const FLUSH_DELAY = num("FLUSH_DELAY");
const SWEEP_STALL = Number(/const SWEEP_STALL = ([^;]+);/.exec(SRC)[1].replace(/[^\d*]/g, "").split("*").reduce((a, b) => a * b, 1));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};

/**
 * One "client": a fresh copy of the engine's module state, with the stores stubbed.
 * `disk` is shared between clients on purpose — that is what a restart looks like.
 */
function makeClient(disk, {
    guilds = { g1: ["a", "b", "c", "d"], g2: ["b", "e"] },
    answers = {},        // userId -> array of mutual friends, or absent = never answered
    me = "ME",
    bots = [],
} = {}) {
    let now = 1_000_000;
    const scanned = [];      // every id handed to MutualsAPI.scan
    const cancelled = [];
    const writes = [];       // every DataStore.set that actually happened
    const timers = new Map();
    let nextTimer = 1;

    // The real queue is FIFO, shared with the voice scanner, and paced — so what the
    // batching is actually about is how DEEP it gets, not how fast it drains.
    let pending = 0;
    const MutualsAPI = {
        isActive: () => true,
        // A person with no entry has never been answered for; that is null, not []
        getMutuals: id => (id in answers ? answers[id] : null),
        isScanned: id => id in answers,
        scan: id => { scanned.push(id); pending++; },
        cancel: ids => { cancelled.push(...ids); pending = Math.max(0, pending - ids.length); },
        pendingCount: () => pending,
        subscribe() { }, unsubscribe() { },
    };
    const UserStore = {
        getCurrentUser: () => ({ id: me }),
        getUser: id => ({ id, bot: bots.includes(id) }),
    };
    const GuildStore = { getGuilds: () => Object.fromEntries(Object.keys(guilds).map(g => [g, { id: g }])) };
    const GuildMemberStore = { getMemberIds: g => guilds[g] };
    const DataStore = {
        get: async k => disk[k],
        set: async (k, v) => { disk[k] = JSON.parse(JSON.stringify(v)); writes.push(k); },
    };
    const guildMemberIds = g => { try { return GuildMemberStore.getMemberIds(g) ?? []; } catch { return []; } };
    const FakeDate = { now: () => now };
    const setTimeoutShim = (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: now + ms }); return id; };
    const clearTimeoutShim = id => { timers.delete(id); };

    const NAMES = ["MutualsAPI", "UserStore", "GuildStore", "DataStore", "guildMemberIds",
        "Date", "setTimeout", "clearTimeout", "console"];
    const VALS = [MutualsAPI, UserStore, GuildStore, DataStore, guildMemberIds,
        FakeDate, setTimeoutShim, clearTimeoutShim, console];

    const api = new Function(...NAMES, `
        const NO_LIMIT = 0;
        const uncapped = n => !(n > 0);
        const MEMBER_SWEEP_CAP = ${num("MEMBER_SWEEP_CAP")};
        const SWEEP_TOTAL_CAP = ${num("SWEEP_TOTAL_CAP")};
        const MAX_FRIEND_MAP = ${num("MAX_FRIEND_MAP")};
        const FLUSH_DELAY = ${FLUSH_DELAY};
        // load() sets these; the harness drives them directly so the migration paths
        // (which are not part of this feature) stay out of the way.
        let loaded = false, accountId = null;
        // Declared outside the engine's span in the real file: the plugin-alive flag and
        // the settings object autoSweepTick reads before restarting a run.
        let active = true;
        const settings = { store: { alwaysSweep: true, scanMembers: true } };
        ${ENGINE}
        ${extract("getFriendMap", JS).replace(/^export /, "")}
        return {
            startServerSweep, stopServerSweep, harvestSweep, flushFriends, provenFriends,
            storedFriendRows, sweepListeners, getFriendMap, freshAnswers, harvestRosterAnswers,
            autoSweepTick, feedSweep, nextSweepBatch, SWEEP_BATCH,
            state: () => ({ sweeping, sweepSeen, friendMap, friendsDirty, folded, autoSweepPaused, sweepHanded }),
            setAlwaysSweep: v => { settings.store.alwaysSweep = v; },
            // What the panel's Stop button does, and what disabling the plugin does.
            pressStop: () => { autoSweepPaused = true; stopServerSweep(); },
            setActive: v => { active = v; },
            signIn: (id, stored) => { accountId = id; friendMap = stored ?? {}; loaded = true; },
        };`)(...VALS);

    return {
        ...api, scanned, cancelled, writes,
        // Mutuals answering (or being told to) is what frees capacity for the next batch
        drain: () => { pending = 0; },
        setPending: n => { pending = n; },
        pending: () => pending,
        advance: ms => { now += ms; },
        runTimers: () => {
            for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
        },
        answer: (id, friends) => { answers[id] = friends; },
        forget: id => { delete answers[id]; },
        rows: () => api.storedFriendRows(api.state().friendMap)
            .map(r => `${r.id}[${r.friends.join("+")}]`).join(" "),
    };
}

const KEY = "XicordDossierFriendMap:acct1";

console.log("\n-- a sweep queues every member of every server, once --");
const disk = {};
let c = makeClient(disk, { bots: ["e"] });
c.signIn("acct1");
ok("the sweep starts", c.startServerSweep() === true);
ok("everyone real is queued exactly once",
    [...c.scanned].sort().join(",") === "a,b,c,d", c.scanned.join(","));
ok("you are never queued", !c.scanned.includes("ME"), c.scanned.join(","));
ok("bots are never queued — they have no friend list to prove", !c.scanned.includes("e"), c.scanned.join(","));
ok("the run is marked as going", c.state().sweeping === true);
ok("someone in two servers is remembered as being in both",
    c.state().sweepSeen.get("b").join("/") === "g1/g2", String(c.state().sweepSeen.get("b")));

console.log("\n-- answers land one at a time and are banked as they arrive --");
c.answer("a", ["f1", "f2"]);
c.harvestSweep();
ok("the first finding is stored immediately", c.rows() === "a[f1+f2]", c.rows());
ok("the run is still going — three people are unanswered", c.state().sweeping === true);
ok("nothing is written to disk yet; the write is batched", c.writes.length === 0, c.writes.join(","));

c.advance(FLUSH_DELAY); c.runTimers();
// `includes`, not equality: the engine flushes a roster store alongside this one, and
// pinning the exact write list would break every time a neighbouring store is added
// without saying anything true about the friend map.
ok("the batched write lands after the flush delay", c.writes.includes(KEY), c.writes.join(","));
ok("and it is keyed to the signed-in account", !!disk[KEY], Object.keys(disk).join(","));

c.answer("b", []); // scanned, but nobody we can see
c.answer("d", ["f1"]);
c.harvestSweep();
ok("a person with no visible additions is not listed", c.rows() === "a[f1+f2] d[f1]", c.rows());
ok("the run is STILL going — c has never answered", c.state().sweeping === true);

console.log("\n-- a rate-limited lookup never answers, and must not hang the run forever --");
// c is the one Discord refused. It has left the queue, so no further notification will
// ever arrive for it; only the passage of time can end the run.
c.advance(SWEEP_STALL - 1000); c.harvestSweep();
ok("shortly after the last answer, the run is still considered live", c.state().sweeping === true);
c.advance(2000); c.harvestSweep();
ok("once nothing has been answered for a long while, the run ends", c.state().sweeping === false);
ok("the unanswered person is NOT recorded as having nobody",
    !c.rows().includes("c["), c.rows());

console.log("\n-- a fresh answer restarts the clock rather than ending the run early --");
let c2 = makeClient({}, { answers: {} });
c2.signIn("acct1");
c2.startServerSweep();
c2.advance(SWEEP_STALL - 1000);
c2.answer("a", ["f1"]);
c2.harvestSweep();               // progress! clock resets
c2.advance(SWEEP_STALL - 1000);
c2.harvestSweep();
ok("progress keeps a long sweep alive past the stall window", c2.state().sweeping === true);
c2.advance(2000); c2.harvestSweep();
ok("and it still ends once progress genuinely stops", c2.state().sweeping === false);

console.log("\n-- a sweep of nothing is a finished sweep, not a stuck one --");
const c3 = makeClient({}, { guilds: {} });
c3.signIn("acct1");
c3.startServerSweep();
ok("no loaded members means the run is over immediately", c3.state().sweeping === false);

c.runTimers(); // bank the later findings; the stall advance already passed the delay
ok("every finding reached disk, not just the first batch",
    Object.keys(disk[KEY]).sort().join(",") === "a,d", JSON.stringify(disk[KEY]));

console.log("\n-- RESTART: the scan cache is memory-only, the findings are not --");
// Same disk, brand new client, and Mutuals knows nothing at all this session.
const restarted = makeClient(disk, { answers: {} });
restarted.signIn("acct1", disk[KEY]);
ok("the previous session's findings are still there",
    restarted.rows() === "a[f1+f2] d[f1]", restarted.rows());
ok("and they still prove a friendship for the graph's gold ring",
    [...(restarted.provenFriends("a") ?? [])].join("+") === "f1+f2", String(restarted.provenFriends("a")));
ok("someone never found is still not claimed as anyone's friend",
    restarted.provenFriends("zz") === null, String(restarted.provenFriends("zz")));

console.log("\n-- a live answer always beats the stored one --");
const live = makeClient(disk, { answers: { a: ["f9"] } });
live.signIn("acct1", disk[KEY]);
ok("this session's scan wins", [...live.provenFriends("a")].join("+") === "f9", String(live.provenFriends("a")));

console.log("\n-- RETRACTION: an unfriending must not stand forever --");
const later = makeClient(disk, { answers: { a: [], d: ["f1"] } });
later.signIn("acct1", disk[KEY]);
later.startServerSweep();
later.harvestSweep();
ok("the person who now has nobody is dropped from the findings",
    later.rows() === "d[f1]", later.rows());
// An empty LIVE answer is an answer — it must beat the stored one and produce no ring.
// What matters to every caller is "is there anything to draw", not whether that is spelled
// as an empty set or as null; since the pooled layer arrived it is null, because the union
// of your scan and the pool's is genuinely empty.
ok("and stops proving a friendship the graph would draw in gold",
    !(later.provenFriends("a")?.size), String(later.provenFriends("a")));
later.advance(FLUSH_DELAY); later.runTimers();
ok("the retraction is persisted, not just forgotten in memory",
    !JSON.parse(JSON.stringify(disk[KEY])).a, JSON.stringify(disk[KEY]));
ok("the person who is still a proven friend survives the same pass", !!disk[KEY].d, JSON.stringify(disk[KEY]));

// harvestSweep runs on EVERY Mutuals answer (debounced 2s) against a set that stays
// populated for the rest of the session, and harvestRosterAnswers runs every 20s and on
// every profile you open. Both used to re-derive their whole set each time and hand the
// result to mergeFriendMap, which stamps `at: now` on every row — so the entire friend map
// was rewritten to IndexedDB every 30 seconds, forever, for a sweep that finished hours
// ago. What must NOT break in fixing that: a later answer still lands, and a person who
// turns up in a second server still gains it.
console.log("\n-- the harvest only re-examines people whose answer is new --");
const seenTwo = new Map([["a", ["g1"]], ["b", ["g1", "g2"]], ["u", ["g1"]]]);
const done = new Map([["a", 1], ["b", 1]]);
const fresh = makeClient({}, {}).freshAnswers(seenTwo, done);
ok("someone fully folded in is skipped", !fresh.has("a"), [...fresh.keys()].join(","));
ok("someone folded from ONE of their two servers comes back", fresh.has("b"), [...fresh.keys()].join(","));
ok("someone with no answer yet is never skipped", fresh.has("u"), [...fresh.keys()].join(","));
ok("an empty done-map skips nobody", makeClient({}, {}).freshAnswers(seenTwo, new Map()).size === 3);

const quiet = makeClient({}, { guilds: { g1: ["a", "b"] }, answers: { a: ["f1"] } });
quiet.signIn("acct1");
quiet.startServerSweep();
quiet.harvestSweep();
quiet.advance(FLUSH_DELAY); quiet.runTimers();
const wrote = quiet.writes.length;
ok("the first answer is written once", wrote > 0, String(wrote));
quiet.harvestSweep(); quiet.harvestSweep(); quiet.harvestRosterAnswers();
quiet.advance(FLUSH_DELAY); quiet.runTimers();
ok("further passes with no new answer rewrite nothing",
    quiet.writes.length === wrote, `${wrote} -> ${quiet.writes.length}`);
ok("and the finding is still there", quiet.rows() === "a[f1]", quiet.rows());

quiet.answer("b", ["f2"]);
quiet.harvestSweep();
ok("an answer that arrives later still lands", quiet.rows() === "a[f1] b[f2]", quiet.rows());
quiet.advance(FLUSH_DELAY); quiet.runTimers();
ok("and is persisted", quiet.writes.length > wrote, `${wrote} -> ${quiet.writes.length}`);

// The reason the skip is keyed by server COUNT and not by a plain "already seen" flag.
const moving = { g1: ["a"], g2: [] };
const roam = makeClient({}, { guilds: moving, answers: { a: ["f1"] } });
roam.signIn("acct1");
roam.startServerSweep(); roam.harvestSweep();
ok("found in one server first", roam.state().friendMap.a.guilds.join("/") === "g1",
    JSON.stringify(roam.state().friendMap.a));
moving.g2 = ["a"];                       // the same person turns up somewhere else
roam.startServerSweep(); roam.harvestSweep();
ok("a folded-in person still gains a newly-discovered server",
    roam.state().friendMap.a.guilds.sort().join("/") === "g1/g2",
    JSON.stringify(roam.state().friendMap.a));

console.log("\n-- stopping mid-run releases the queue instead of fetching for hours --");
const stopped = makeClient({}, { answers: {} });
stopped.signIn("acct1");
stopped.startServerSweep();
stopped.stopServerSweep();
ok("the run is marked stopped", stopped.state().sweeping === false);
ok("every one of our queued people is handed back to Mutuals to drop",
    [...stopped.cancelled].sort().join(",") === "a,b,c,d,e", stopped.cancelled.join(","));

// A run used to fire its ENTIRE scope at Mutuals in one loop. Nothing arrived any sooner
// for it — Mutuals paces itself — but the queue is FIFO and shared with the voice
// scanner, so everything queued after a sweep sat behind hours of backlog. These pin the
// batching that replaced it: the run's SCOPE and the run's QUEUE are different things.
console.log("\n-- a run is fed to Mutuals a batch at a time, not all at once --");
const many = Object.fromEntries([["g1", Array.from({ length: 200 }, (_, i) => `u${i}`)]]);
const batched = makeClient({}, { guilds: many, answers: {} });
batched.signIn("acct1");
batched.startServerSweep();
const BATCH = batched.SWEEP_BATCH;
ok("the whole server is still the run's SCOPE", batched.state().sweepSeen.size === 200,
    String(batched.state().sweepSeen.size));
ok("but only one batch is actually in front of Mutuals",
    batched.scanned.length === BATCH, `${batched.scanned.length} queued, batch is ${BATCH}`);
ok("and it is the first of them, in the order they were found",
    batched.scanned[0] === "u0" && batched.scanned[BATCH - 1] === `u${BATCH - 1}`,
    `${batched.scanned[0]}..${batched.scanned[BATCH - 1]}`);

// A top-up while the queue is still deep would defeat the whole point: the bound that
// matters is how long anything queued BEHIND the sweep waits.
batched.feedSweep();
ok("a top-up with the queue still full hands over nothing",
    batched.scanned.length === BATCH, String(batched.scanned.length));
batched.setPending(BATCH / 2);
batched.feedSweep();
ok("nor does a half-drained queue — it tops up at the low-water mark, not before",
    batched.scanned.length === BATCH, String(batched.scanned.length));

// Mutuals works through them; capacity frees up.
for (let i = 0; i < BATCH; i++) batched.answer(`u${i}`, []);
batched.drain();
batched.feedSweep();
ok("once it drains, the NEXT slice goes over — not the same one again",
    batched.scanned.length === BATCH * 2 && batched.scanned[BATCH] === `u${BATCH}`,
    `${batched.scanned.length}, next was ${batched.scanned[BATCH]}`);
ok("nobody is offered twice", new Set(batched.scanned).size === batched.scanned.length,
    `${batched.scanned.length} handed, ${new Set(batched.scanned).size} distinct`);

// The batch skips people already answered for, or a restart would re-offer thousands of
// people whose answers are already on disk and starve the ones that are not.
const resumed = makeClient({}, { guilds: many, answers: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`u${i}`, []])) });
resumed.signIn("acct1");
resumed.startServerSweep();
ok("a resumed run offers only the people with no answer yet",
    resumed.scanned.every(id => Number(id.slice(1)) >= 150), resumed.scanned.slice(0, 3).join(","));

// Stop has to release in one go — with batching there is simply less to release.
const held = makeClient({}, { guilds: many, answers: {} });
held.signIn("acct1");
held.startServerSweep();
held.stopServerSweep();
ok("stopping still hands the run's whole scope back to Mutuals to drop",
    held.cancelled.length === 200, String(held.cancelled.length));
ok("and the run forgets what it handed over, so a retry re-offers it",
    held.state().sweepHanded.size === 0, String(held.state().sweepHanded.size));

// The sweep used to exist only while a modal was open. These pin the thing that replaced
// that: a run that re-arms itself forever, without ever restarting a healthy one.
console.log("\n-- the sweep runs forever on its own, with nothing open --");
const auto = makeClient({}, { answers: {} });
auto.signIn("acct1");
auto.autoSweepTick();
ok("a tick with no run in flight starts one — no button, no modal",
    auto.state().sweeping === true);
ok("and it queued everyone, exactly as a pressed sweep would",
    [...auto.scanned].sort().join(",") === "a,b,c,d,e", auto.scanned.join(","));

// Restarting a live run would reset lastSweepProgress, and the stall detector is the ONLY
// thing that ever ends a run — so a tick that kicked unconditionally would mean no run is
// ever finished, and the panel sits on "Sweeping…" until Discord restarts.
const before = auto.scanned.length;
auto.advance(60_000); auto.autoSweepTick();
ok("a tick during a live run leaves it alone", auto.scanned.length === before, String(auto.scanned.length));

// Nobody ever answers: the run stalls out, which is the normal end on a rate-limited pool.
auto.advance(SWEEP_STALL + 1000); auto.harvestSweep();
ok("the stalled run ends, as it always did", auto.state().sweeping === false);
auto.autoSweepTick();
ok("and the next tick immediately starts a fresh one — that is 'always running'",
    auto.state().sweeping === true);

console.log("\n-- Stop still means stop, and a sweep press resumes it --");
const paused = makeClient({}, { answers: {} });
paused.signIn("acct1");
paused.autoSweepTick();
paused.pressStop();
ok("Stop ends the run", paused.state().sweeping === false);
paused.advance(60_000); paused.autoSweepTick();
ok("and the automatic restart respects it, instead of undoing the click a minute later",
    paused.state().sweeping === false);
paused.startServerSweep();
ok("pressing sweep again resumes the automatic runs",
    paused.state().autoSweepPaused === false && paused.state().sweeping === true);
paused.advance(SWEEP_STALL + 1000); paused.harvestSweep();
paused.autoSweepTick();
ok("proven by the next tick re-arming once it drains", paused.state().sweeping === true);

console.log("\n-- the setting and the plugin's own lifecycle both gate it --");
const off = makeClient({}, { answers: {} });
off.signIn("acct1");
off.setAlwaysSweep(false);
off.autoSweepTick();
ok("with continuous sweeping off, a tick starts nothing", off.state().sweeping === false);
ok("and queues nobody", off.scanned.length === 0, off.scanned.join(","));
off.setAlwaysSweep(true);
off.setActive(false);
off.autoSweepTick();
ok("a disabled plugin never restarts a sweep behind its own back",
    off.state().sweeping === false && off.scanned.length === 0);

console.log("\n-- nothing is written before the stores have been read --");
const early = makeClient({}, { answers: { a: ["f1"] } });
// deliberately NOT signed in: `loaded` is false, exactly as during the async load
early.startServerSweep();
early.harvestSweep();
early.advance(FLUSH_DELAY); early.runTimers();
ok("an unloaded client never persists an empty map over a real one",
    early.writes.length === 0, early.writes.join(","));

// The plugin exports the sweep through Xicord Cache and the dashboard reads it back.
// Those are two files that never import each other, so nothing but a test connects
// them — rename a field on one side and the dashboard just silently shows nothing.
console.log("\n-- contract: what the plugin exports is what the dashboard reads --");
const DASH = readFileSync(join(ROOT, "xicord-dashboard.html"), "utf8");
const dash = new Function(`${extract("idList", DASH)}${extract("friendMapRows", DASH)}
    ${extract("filterFriendMapRows", DASH)}${extract("topAddedFriends", DASH)}
    return { friendMapRows, filterFriendMapRows, topAddedFriends };`)();

const exporting = makeClient({}, { answers: { a: ["f1", "f2"], b: ["f1"], c: [] } });
exporting.signIn("acct1");
exporting.startServerSweep();
exporting.harvestSweep();
const exported = exporting.getFriendMap();
ok("the export carries only people with a proven addition",
    Object.keys(exported).sort().join(",") === "a,b", Object.keys(exported).join(","));
ok("each entry has the three fields the dashboard reads",
    Object.values(exported).every(e => Array.isArray(e.friends) && Array.isArray(e.guilds) && typeof e.at === "number"),
    JSON.stringify(exported));
ok("it survives the JSON round-trip the snapshot file makes it take",
    JSON.stringify(JSON.parse(JSON.stringify(exported))) === JSON.stringify(exported));

const dashRows = dash.friendMapRows(JSON.parse(JSON.stringify(exported)));
ok("the dashboard lists exactly the people the plugin exported",
    dashRows.map(r => r.id).join(",") === "a,b", dashRows.map(r => r.id).join(","));
ok("in the same order the in-Discord panel uses — most additions first",
    dashRows[0].id === "a" && dashRows[0].friends.length === 2, JSON.stringify(dashRows[0]));
ok("the servers each person was found in come across too",
    dashRows[0].guilds.join("/") === "g1", dashRows[0].guilds.join("/"));
ok("and the friend-ranking chart agrees with the rows",
    dash.topAddedFriends(dashRows, 5).map(e => e[0] + ":" + e[1]).join(" ") === "f1:2 f2:1",
    JSON.stringify(dash.topAddedFriends(dashRows, 5)));
ok("both sides answer 'who added f1?' identically",
    dash.filterFriendMapRows(dashRows, "f1", id => id).map(r => r.id).join(",") === "a,b");

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
