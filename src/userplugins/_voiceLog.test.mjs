// Drives the REAL voice timeline: the capture logic out of xicordVoiceLog.tsx and the
// wire transforms out of _sync.tsx, plus the one contract that spans the whole feature —
// that the client and the SERVER agree, independently, on what makes two observations the
// same event.
//   node src/userplugins/_voiceLog.test.mjs
//
// The bugs it guards:
//   * two contributors both watching the same join, so the shared timeline shows it twice
//     (or N times, once per person online) — the thing that would make pooling worse than
//     not pooling at all;
//   * a merge whose answer depends on which slice folded in first, which would quietly
//     invalidate the server's whole append-and-replay design;
//   * the reconcile tick re-logging a transition the live dispatch already caught;
//   * pooled events being pushed back out, making every contributor a source for
//     everyone else's findings;
//   * a person already sitting in a call when you launch never being recorded at all.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");

const SYNC = readFileSync(new URL("./_sync.tsx", import.meta.url), "utf8");
const syncJs = esbuild.transformSync(SYNC.replace(/^export /gm, ""), { loader: "tsx" }).code;
const { toVoice, fromVoice, mergeVoiceEvents, voiceKey, cleanVoiceEvent, VOICE_BUCKET_MS, chunkPool } =
    new Function(`${syncJs}; return { toVoice, fromVoice, mergeVoiceEvents, voiceKey, cleanVoiceEvent, VOICE_BUCKET_MS, chunkPool };`)();

// The server's half of the same wire format, loaded as-is.
const serverPool = require(join(ROOT, "xicord-sync", "pool.js"));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};

const A = "900000000000000001", B = "900000000000000002", ME = "100000000000000001";
const CH1 = "700000000000000001", CH2 = "700000000000000002";
const T = 1_700_000_000_000;

const ev = (act, ch, old, at) => ({ act, ch, old, at });
const entry = (userId, action, channelId, oldChannelId, at) => ({ userId, action, channelId, oldChannelId, at });

console.log("\n-- a local log out to the wire --");
let v = toVoice([
    entry(A, "joined", CH1, null, T),
    entry(A, "moved", CH2, CH1, T + 60_000),
    entry(B, "joined", CH1, null, T + 10_000),
], [ME]);
ok("each person gets their own timeline", Object.keys(v).sort().join(",") === `${A},${B}`, Object.keys(v).join(","));
ok("newest first", v[A].events[0].act === "moved", JSON.stringify(v[A].events.map(e => e.act)));
ok("last is the most recent observation", v[A].last === T + 60_000, String(v[A].last));

console.log("\n-- your own accounts are never pooled --");
v = toVoice([entry(ME, "joined", CH1, null, T), entry(A, "joined", CH1, null, T)], [ME]);
ok("you are not in the payload", !v[ME], Object.keys(v).join(","));
ok("but everyone else still is", !!v[A], Object.keys(v).join(","));

console.log("\n-- a delta carries only what is new --");
const three = [entry(A, "joined", CH1, null, T), entry(A, "left", null, CH1, T + 100_000)];
ok("the old event is skipped", toVoice(three, [ME], T + 50_000)[A].events.length === 1);
ok("a full re-send carries both", toVoice(three, [ME], 0)[A].events.length === 2);

console.log("\n-- an unreadable observation is not storable --");
ok("an unknown action is dropped", cleanVoiceEvent(ev("vanished", CH1, null, T)) === null);
ok("a join with nowhere joined is dropped", cleanVoiceEvent(ev("joined", null, null, T)) === null);
ok("a leave from nowhere is dropped", cleanVoiceEvent(ev("left", null, null, T)) === null);
ok("a move missing an end is dropped", cleanVoiceEvent(ev("moved", CH2, null, T)) === null);
ok("a timestamp of zero is dropped", cleanVoiceEvent(ev("joined", CH1, null, 0)) === null);
ok("a real one survives", !!cleanVoiceEvent(ev("joined", CH1, null, T)));

// THE bug this whole identity scheme exists for. Every contributor stamps the event with
// its own Date.now() as the dispatch lands, so the same join is never recorded at exactly
// the same millisecond twice.
console.log("\n-- two contributors watching the same join record it ONCE --");
const mine = [ev("joined", CH1, null, T)];
const theirs = [ev("joined", CH1, null, T + 800)];      // same event, a different clock
ok("the two observations collapse to one", mergeVoiceEvents(mine, theirs).length === 1,
    JSON.stringify(mergeVoiceEvents(mine, theirs)));
ok("and the earlier stamp is what is kept", mergeVoiceEvents(mine, theirs)[0].at === T);
ok("whichever order they merge in", mergeVoiceEvents(theirs, mine)[0].at === T);

// The property the SERVER's storage design rests on: slices are appended and replayed in
// whatever order they land, so a merge that cared about order would corrupt the pool.
console.log("\n-- the merge is commutative, associative and idempotent --");
const s1 = [ev("joined", CH1, null, T)];
const s2 = [ev("moved", CH2, CH1, T + 60_000)];
const s3 = [ev("left", null, CH2, T + 120_000)];
const abc = mergeVoiceEvents(mergeVoiceEvents(s1, s2), s3);
const cba = mergeVoiceEvents(s3, mergeVoiceEvents(s2, s1));
ok("order of folding cannot change the result",
    JSON.stringify(abc) === JSON.stringify(cba), `${JSON.stringify(abc)}\n          ${JSON.stringify(cba)}`);
ok("merging something already present changes nothing",
    JSON.stringify(mergeVoiceEvents(abc, s2)) === JSON.stringify(abc));
ok("two genuinely different events both survive", abc.length === 3, String(abc.length));

// Deliberately a bucket, not a tolerance window — so this is the accepted cost, pinned so
// nobody "fixes" it into an order-dependent merge by accident.
console.log("\n-- the accepted cost of a bucket: a boundary can double an event --");
const edge = VOICE_BUCKET_MS * Math.ceil(T / VOICE_BUCKET_MS);
ok("either side of a bucket edge reads as two events",
    mergeVoiceEvents([ev("joined", CH1, null, edge - 1)], [ev("joined", CH1, null, edge)]).length === 2);
ok("which is the price of an order-independent answer — same both ways round",
    mergeVoiceEvents([ev("joined", CH1, null, edge)], [ev("joined", CH1, null, edge - 1)]).length === 2);

// One wire format, described twice — once in TypeScript for the client, once in
// CommonJS for the server. Nothing but this connects them.
console.log("\n-- contract: the client and the server derive the SAME identity --");
const cases = [
    ev("joined", CH1, null, T),
    ev("moved", CH2, CH1, T + 1),
    ev("left", null, CH2, T + VOICE_BUCKET_MS),
    ev("joined", CH1, null, T + 4999),
];
ok("voiceKey agrees on every shape",
    cases.every(e => voiceKey(e) === serverPool.voiceKey(e)),
    cases.map(e => `${voiceKey(e)} vs ${serverPool.voiceKey(e)}`).join("\n          "));
ok("the bucket width is the same number on both sides",
    VOICE_BUCKET_MS === serverPool.VOICE_BUCKET_MS,
    `${VOICE_BUCKET_MS} vs ${serverPool.VOICE_BUCKET_MS}`);
ok("and the same two observations collapse on both sides",
    mergeVoiceEvents(mine, theirs).length === serverPool.mergeVoicePerson({ events: mine }, { events: theirs }).events.length);
ok("client and server reject the same malformed events",
    [ev("vanished", CH1, null, T), ev("joined", null, null, T), ev("left", null, null, T)]
        .every(e => (cleanVoiceEvent(e) === null) === (serverPool.cleanVoiceEvent(e) === null)));

console.log("\n-- the wire back into a local log --");
let local = [entry(A, "joined", CH1, null, T)];
let added = fromVoice({ [A]: { events: [ev("joined", CH1, null, T + 500), ev("left", null, CH1, T + 90_000)], last: T + 90_000 } }, local);
ok("the one we already had is not duplicated", added === 1, String(added));
ok("the one we had not is taken", local.length === 2, String(local.length));
ok("newest first", local[0].at === T + 90_000, String(local[0].at));
ok("and it is marked as someone else's observation", local[0].pooled === true, JSON.stringify(local[0]));
ok("our own entry is left unflagged", local.find(e => e.at === T).pooled !== true);

ok("folding the same pull again adds nothing",
    fromVoice({ [A]: { events: [ev("left", null, CH1, T + 90_000)], last: 0 } }, local) === 0);

console.log("\n-- a pull about people this client has never seen --");
local = [];
fromVoice({ [B]: { events: [ev("joined", CH2, null, T)], last: T } }, local);
ok("a stranger's timeline arrives whole", local.length === 1 && local[0].userId === B, JSON.stringify(local));

console.log("\n-- garbage on the wire cannot poison the log --");
local = [];
added = fromVoice({
    "not-an-id": { events: [ev("joined", CH1, null, T)], last: T },
    [A]: { events: [ev("joined", CH1, null, T), null, "nonsense", ev("bogus", CH1, null, T)], last: T },
}, local);
ok("a non-snowflake person is refused", !local.some(e => e.userId === "not-an-id"), JSON.stringify(local));
ok("only the readable event of the real person lands", added === 1 && local.length === 1, JSON.stringify(local));
ok("a null payload is a no-op", fromVoice(null, local) === 0 && fromVoice(undefined, local) === 0);

console.log("\n-- the log is capped, newest kept --");
local = [];
const many = Array.from({ length: 50 }, (_, i) => ev("joined", CH1, null, T + i * VOICE_BUCKET_MS * 2));
fromVoice({ [A]: { events: many, last: 0 } }, local, 10);
ok("the cap holds", local.length === 10, String(local.length));
ok("and it is the newest that survive", local[0].at === T + 49 * VOICE_BUCKET_MS * 2, String(local[0].at));

console.log("\n-- a timeline rides the push batching --");
// Someone with a timeline and no calls at all is the normal case here: the Voice Log
// records people this client has never once seen share a channel with anybody.
const batches = chunkPool({
    people: {}, calls: {}, users: {},
    voice: Object.fromEntries(Array.from({ length: 9 }, (_, i) =>
        [`90000000000000010${i}`, { events: [ev("joined", CH1, null, T)], last: T }]))
}, 2);
const sent = batches.flatMap(b => Object.keys(b.voice || {}));
ok("every timeline is in exactly one batch", sent.length === 9 && new Set(sent).size === 9,
    `${sent.length} sent, ${new Set(sent).size} distinct across ${batches.length} batches`);
ok("nobody is dropped for having no calls", batches.length > 1, String(batches.length));

// ---------------------------------------------------------------------------
// The plugin's own capture logic, extracted from the real file
// ---------------------------------------------------------------------------
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

const PLUGIN = readFileSync(new URL("./xicordVoiceLog.tsx", import.meta.url), "utf8");
const pluginJs = esbuild.transformSync(PLUGIN, { loader: "tsx" }).code;

/** The capture half of the plugin, with the stores stubbed. */
function makeLogger({ voice = {}, me = ME, watchEveryone = true, watched = "" } = {}) {
    let now = T;
    const toasts = [];
    const states = { ...voice };   // channelId -> { userId: { userId, channelId } }

    const settings = { store: { watchEveryone, watched, toastOnEvent: true, sync: true } };
    const UserStore = { getCurrentUser: () => ({ id: me }), getUser: id => ({ id, username: `name-${id}` }) };
    const VoiceStateStore = { getAllVoiceStates: () => states };
    const Toasts = { show: t => toasts.push(t), genId: () => 1, Type: { SUCCESS: 1, FAILURE: 2 } };
    const ChannelStore = { getChannel: id => ({ name: `ch-${id}` }) };

    const NAMES = ["settings", "UserStore", "VoiceStateStore", "Toasts", "ChannelStore", "Date", "console"];
    const VALS = [settings, UserStore, VoiceStateStore, Toasts, ChannelStore, { now: () => now }, console];

    const api = new Function(...NAMES, `
        const log = [];
        let nextId = 0, active = true;
        const listeners = new Set();
        function notify() { }
        function scheduleFlush() { }
        const lastKnown = new Map();
        ${extract("rememberName", pluginJs)}
        ${extract("pushEntry", pluginJs)}
        ${extract("getWatched", pluginJs)}
        ${extract("isWatched", pluginJs)}
        ${extract("shouldLog", pluginJs)}
        ${extract("channelName", pluginJs)}
        ${extract("describe", pluginJs)}
        ${extract("record", pluginJs)}
        ${extract("currentVoice", pluginJs)}
        ${extract("reconcile", pluginJs)}
        const MAX_ENTRIES = 2000;
        return { log, record, reconcile, lastKnown, currentVoice };
    `)(...VALS);

    return {
        ...api, toasts,
        advance: ms => { now += ms; },
        // What Discord's store looks like once somebody joins or leaves
        put: (userId, channelId) => {
            for (const ch of Object.keys(states)) delete states[ch][userId];
            if (channelId) (states[channelId] ||= {})[userId] = { userId, channelId };
        },
        acts: () => api.log.map(e => `${e.userId}:${e.action}`).join(" "),
    };
}

console.log("\n-- everyone already in a call when you launch is recorded --");
// The old plugin only ever saw live transitions, so a person sitting in a channel before
// you started was invisible until they happened to move — on a quiet server, for days.
const seeded = makeLogger({ voice: { [CH1]: { [A]: { userId: A, channelId: CH1 }, [B]: { userId: B, channelId: CH1 } } } });
seeded.reconcile(true);
ok("both of them are logged as joined", seeded.acts().split(" ").sort().join(" ") === `${A}:joined ${B}:joined`, seeded.acts());
ok("but seeding is silent — no forty toasts because the client woke up", seeded.toasts.length === 0, String(seeded.toasts.length));
ok("and their names are captured while the cache still has them",
    seeded.log.every(e => e.name === `name-${e.userId}`), JSON.stringify(seeded.log.map(e => e.name)));

console.log("\n-- you are never logged --");
const selfie = makeLogger({ voice: { [CH1]: { [ME]: { userId: ME, channelId: CH1 } } } });
selfie.reconcile(true);
ok("your own presence is not an event", selfie.log.length === 0, selfie.acts());

console.log("\n-- the reconcile tick catches what Discord never dispatched --");
const missed = makeLogger();
missed.reconcile(true);
ok("nothing to see yet", missed.log.length === 0);
missed.put(A, CH1);            // joined while we were not told
missed.advance(30_000);
missed.reconcile();
ok("the join is noticed on the next tick", missed.acts() === `${A}:joined`, missed.acts());
missed.put(A, CH2);            // moved, again silently
missed.advance(30_000);
missed.reconcile();
ok("so is the move", missed.log[0].action === "moved" && missed.log[0].oldChannelId === CH1, JSON.stringify(missed.log[0]));
missed.put(A, null);           // and gone
missed.advance(30_000);
missed.reconcile();
ok("and the leave, which the store shows only by absence", missed.log[0].action === "left", missed.log[0].action);
missed.advance(30_000);
missed.reconcile();
ok("a quiet tick logs nothing", missed.log.length === 3, String(missed.log.length));

console.log("\n-- a reconcile does not double what the live dispatch already caught --");
const both = makeLogger();
both.record(A, CH1, null);     // the live event
both.put(A, CH1);              // ...and the store now agrees
both.advance(1000);
both.reconcile();
ok("one join, not two", both.log.length === 1, both.acts());
both.advance(20_000);          // past the dedupe bucket
both.reconcile();
ok("and still one after the bucket has passed — the state matches, so there is no event",
    both.log.length === 1, both.acts());

console.log("\n-- watching narrows the TOASTS, not the recording --");
// Filtering at capture time cannot be undone: a person you start watching tomorrow would
// have no history, forever.
const narrow = makeLogger({ watchEveryone: true, watched: A });
narrow.record(A, CH1, null);
narrow.record(B, CH1, null);
ok("both are recorded", narrow.log.length === 2, narrow.acts());
ok("only the watched one is announced", narrow.toasts.length === 1, String(narrow.toasts.length));

const only = makeLogger({ watchEveryone: false, watched: A });
only.record(A, CH1, null);
only.record(B, CH1, null);
ok("with 'everyone' off, only the watched are recorded at all", only.acts() === `${A}:joined`, only.acts());

console.log(`\n${fail === 0 ? "OK" : "FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
