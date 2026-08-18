// Extracts the REAL mutual-friends scanner (enqueue + startPump + MutualsAPI) from
// xicordMutuals.tsx and drives it against a fake REST endpoint that can fail.
//   node src/userplugins/_mutualsScan.test.mjs
//
// The bug this pins down: a failed fetch used to be stored exactly like a successful
// empty one, so isScanned() said "yes, scanned" and getMutuals() said "[] — no mutual
// friends". Consumers (Xicord Circles most of all) filter on isScanned() BEFORE
// queueing, so one 429 retired a user for the rest of the session: they looked
// scanned, so nobody ever asked for them again, and the UI reported a confident
// "no mutual-friend connections found" that could never correct itself.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordMutuals.tsx", import.meta.url), "utf8");

/** Comment- and string-aware brace matcher (same approach as the sibling suites). */
function extract(name, kind = "function") {
    const needle = kind === "function" ? `function ${name}(`
        : kind === "arrow" ? `const ${name} = () => {`
            : `const ${name} = {`;
    const start = SRC.indexOf(needle);
    if (start < 0) throw new Error(`${name} not found`);
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

// the ScanResult shape plus the scanner's module state (results/queue/queued/pump/
// listeners), stopping before `sleep`, which the test shims to keep the run instant
const stateSrc = SRC.slice(SRC.indexOf("interface ScanResult"), SRC.indexOf("const sleep ="));
const src = [
    "let active = false;",
    stateSrc,
    // the adaptive pacing the pump calls into, plus the live cadence it mutates —
    // without these startPump() dies on its first iteration with a ReferenceError,
    // which reads as "the scanner stopped after one person" rather than as a broken test
    `const MIN_DELAY=${/const MIN_DELAY = (\d+)/.exec(SRC)[1]}, MAX_DELAY=${/const MAX_DELAY = (\d+)/.exec(SRC)[1]};`,
    `const SPEEDUP_AFTER=${/const SPEEDUP_AFTER = (\d+)/.exec(SRC)[1]}, SPEEDUP_FACTOR=${/const SPEEDUP_FACTOR = ([\d.]+)/.exec(SRC)[1]}, BACKOFF_FACTOR=${/const BACKOFF_FACTOR = (\d+)/.exec(SRC)[1]};`,
    SRC.slice(SRC.indexOf("export interface Beat"), SRC.indexOf("function startPump()")).replace(/^export /gm, ""),
    extract("notify"), extract("getMatched"), extract("enqueue"), extract("startPump"),
    // account-switch handling: `scannedAs` is declared alongside it in the source
    SRC.slice(SRC.indexOf("let scannedAs"), SRC.indexOf("const onConnectionOpen")),
    extract("onConnectionOpen", "arrow"),
    extract("profileUserId"),
    extract("MutualsAPI", "const")
].join("\n");
const js = esbuild.transformSync(src, { loader: "ts" }).code;

/* ---------- shims ---------- */
let now = 1_000_000;
const realNow = Date.now;
Date.now = () => now;

let failIds = new Set();      // ids whose fetch rejects (a plain error: 403/404/network)
let limitIds = new Set();     // ids whose fetch is REFUSED for rate limiting (a real 429)
let fetched = [];             // every id the endpoint was actually asked for
const RestAPI = {
    get: async ({ url }) => {
        const id = url.split("/")[2];
        fetched.push(id);
        // A 429 carries a status Discord actually sets; the generic failures above do
        // not, and the pump must tell them apart — only one of them is about speed.
        if (limitIds.has(id)) { const e = new Error("429"); e.status = 429; e.body = { retry_after: 0 }; throw e; }
        if (failIds.has(id)) throw new Error("429 rate limited");
        return { body: (mutualsFor[id] ?? []).map(x => ({ id: x })) };
    }
};
let mutualsFor = {};
let bots = new Set();
let loggedInAs = "ME"; // the account switch tests change this
const UserStore = { getCurrentUser: () => ({ id: loggedInAs }), getUser: id => ({ bot: bots.has(id) }) };
let traitCleared = 0;
const clearManagedMutualTrait = () => { traitCleared++; };
let rescans = 0;
const scanAllVoiceStates = () => { rescans++; };
// Stands in for IndexedDB. Deliberately module-level: building a SECOND harness over
// the same disk is how a restart is simulated, which is the only way to test something
// that depends on an in-memory cache dying.
let disk = {};
const DataStore = {
    get: async k => (k in disk ? JSON.parse(JSON.stringify(disk[k])) : undefined),
    set: async (k, v) => { disk[k] = JSON.parse(JSON.stringify(v)); },
    del: async k => { delete disk[k]; }
};
let targets = ["T"];
const getTargets = () => targets.slice();
const syncMutualTrait = () => { };

// Run the pump without real 2.5s waits: sleep resolves on the microtask queue, and
// `settle` drains it. Time is advanced explicitly by the tests instead.
const sleep = () => Promise.resolve();
const settle = async (turns = 400) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };

const build = new Function("RestAPI", "UserStore", "getTargets", "syncMutualTrait", "sleep",
    "CACHE_TTL", "ERROR_RETRY", "FETCH_DELAY", "clearManagedMutualTrait", "scanAllVoiceStates",
    "DataStore", "syncMutualTraitAll",
    `${js}
     return { MutualsAPI, enqueue, results, queue, listeners, onConnectionOpen, profileUserId,
              loadResults, flushResults,
              setActive: v => { active = v; },
              setScannedAs: v => { scannedAs = v; } };`);

let api;
/** `keepDisk` builds a fresh scanner over the SAME fake disk — i.e. a restart. */
function reset(keepDisk = false) {
    if (!keepDisk) disk = {};
    fetched = []; failIds = new Set(); limitIds = new Set(); mutualsFor = {}; bots = new Set(); targets = ["T"];
    loggedInAs = 'ME'; traitCleared = 0; rescans = 0;
    api = build(RestAPI, UserStore, getTargets, syncMutualTrait, sleep,
        30 * 60 * 1000, 5 * 60 * 1000, 2500, clearManagedMutualTrait, scanAllVoiceStates,
        DataStore, () => { });
    api.setActive(true);
    // start() records which account the cache belongs to; mirror that here so the
    // first CONNECTION_OPEN reads as a reconnect rather than a switch
    api.setScannedAs(loggedInAs);
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};

/* ---------- tests ---------- */
console.log("\n-- a successful scan --");
reset();
mutualsFor.alice = ["f1", "f2"];
api.MutualsAPI.scan("alice");
await settle();
ok("the endpoint was called", fetched.includes("alice"), fetched.join(","));
ok("mutual friends are cached", JSON.stringify(api.MutualsAPI.getMutuals("alice")) === '["f1","f2"]',
    JSON.stringify(api.MutualsAPI.getMutuals("alice")));
ok("and it counts as scanned", api.MutualsAPI.isScanned("alice") === true);

console.log("\n-- a genuinely empty result is NOT the same as a failure --");
reset();
mutualsFor.bob = [];
api.MutualsAPI.scan("bob");
await settle();
ok("an empty list is a real answer", JSON.stringify(api.MutualsAPI.getMutuals("bob")) === "[]",
    JSON.stringify(api.MutualsAPI.getMutuals("bob")));
ok("and bob counts as scanned", api.MutualsAPI.isScanned("bob") === true);

console.log("\n-- a FAILED scan must not masquerade as 'no mutual friends' --");
reset();
failIds.add("carol");
api.MutualsAPI.scan("carol");
await settle();
ok("carol was actually attempted", fetched.includes("carol"));
ok("a failure reads as 'don't know', not as an empty list",
    api.MutualsAPI.getMutuals("carol") === null, JSON.stringify(api.MutualsAPI.getMutuals("carol")));
ok("a failure does NOT count as scanned, so consumers keep offering her",
    api.MutualsAPI.isScanned("carol") === false);

console.log("\n-- ...and the retry actually happens once the backoff expires --");
// This is the loop Circles depends on: it filters on isScanned() before queueing, so
// the retry only works if isScanned() stays false AND enqueue() paces it.
const before = fetched.filter(f => f === "carol").length;
api.MutualsAPI.scan("carol");
await settle();
ok(`too soon: the backoff suppresses an immediate refetch (${fetched.filter(f => f === "carol").length} calls)`,
    fetched.filter(f => f === "carol").length === before, `${fetched.filter(f => f === "carol").length} vs ${before}`);
now += 5 * 60 * 1000 + 1000; // past ERROR_RETRY
failIds.delete("carol");
mutualsFor.carol = ["f9"];
api.MutualsAPI.scan("carol");
await settle();
ok("after the backoff she is retried", fetched.filter(f => f === "carol").length > before);
ok("and the good result finally lands",
    JSON.stringify(api.MutualsAPI.getMutuals("carol")) === '["f9"]', JSON.stringify(api.MutualsAPI.getMutuals("carol")));
ok("now she counts as scanned", api.MutualsAPI.isScanned("carol") === true);

console.log("\n-- a failure after a good result keeps the good result --");
reset();
mutualsFor.dave = ["f3"];
api.MutualsAPI.scan("dave");
await settle();
now += 31 * 60 * 1000;           // past CACHE_TTL, so it will refetch
failIds.add("dave");
api.MutualsAPI.scan("dave");
await settle();
ok("the known-good list survives the failure",
    JSON.stringify(api.MutualsAPI.getMutuals("dave")) === '["f3"]', JSON.stringify(api.MutualsAPI.getMutuals("dave")));
ok("and he still counts as scanned", api.MutualsAPI.isScanned("dave") === true);

console.log("\n-- consumers are told about failures, not just successes --");
// Circles renders "Scanned x/y ... n still queued"; with no notify on the failure path
// that display froze on its opening numbers while the queue silently drained.
reset();
let pings = 0;
api.MutualsAPI.subscribe(() => pings++);
failIds.add("e1"); failIds.add("e2");
api.MutualsAPI.scan("e1"); api.MutualsAPI.scan("e2");
await settle();
ok(`a run of failures still re-renders consumers (${pings} notifications)`, pings >= 2, `${pings} pings`);

console.log("\n-- a whole rate-limited sweep stays recoverable --");
reset();
const ids = Array.from({ length: 25 }, (_, i) => "u" + i);
ids.forEach(i => failIds.add(i));
ids.forEach(i => api.MutualsAPI.scan(i));
await settle(2000);
ok("every one was attempted", ids.every(i => fetched.includes(i)));
ok("none of them is stuck as permanently scanned", ids.every(i => api.MutualsAPI.isScanned(i) === false));
ok("none of them reports a bogus empty mutual list", ids.every(i => api.MutualsAPI.getMutuals(i) === null));
// the whole point: a later sweep can still recover them
now += 5 * 60 * 1000 + 1000;
ids.forEach(i => { failIds.delete(i); mutualsFor[i] = ["f1"]; });
ids.forEach(i => api.MutualsAPI.scan(i));
await settle(2000);
ok("a later pass recovers the entire sweep", ids.every(i => api.MutualsAPI.isScanned(i) === true),
    ids.filter(i => !api.MutualsAPI.isScanned(i)).join(","));

console.log("\n-- a real 429 is not an answer about the person --");
// The old pump caught every rejection identically, so being rate-limited on someone
// marked THEM failed and skipped them for the next five minutes. A sweep that hit its
// limit therefore came back with holes in it that looked like completed lookups.
reset();
limitIds.add("rl1");
mutualsFor.rl1 = ["f1"];
api.MutualsAPI.scan("rl1");
await settle(300);
ok("the person is retried, not written off", fetched.filter(i => i === "rl1").length > 1,
    `attempts: ${fetched.filter(i => i === "rl1").length}`);
ok("and is never recorded as scanned on the strength of a 429",
    api.MutualsAPI.isScanned("rl1") === false);
ok("nor given a bogus empty mutual list", api.MutualsAPI.getMutuals("rl1") === null);

limitIds.delete("rl1");
await settle(300);
ok("once the limit lifts, the real answer lands", api.MutualsAPI.getMutuals("rl1")?.join(",") === "f1",
    JSON.stringify(api.MutualsAPI.getMutuals("rl1")));
ok("and the sweep has no hole where they were", api.MutualsAPI.isScanned("rl1") === true);

console.log("\n-- being rate-limited slows the pump down, a plain failure does not --");
reset();
const paceOf = () => api.MutualsAPI.pacing().delayMs;
const startPace = paceOf();
failIds.add("f_a");
api.MutualsAPI.scan("f_a");
await settle(300);
ok("a 403/404-style failure leaves the cadence alone", paceOf() === startPace, String(paceOf()));

reset();
limitIds.add("rl2");
api.MutualsAPI.scan("rl2");
await settle(300);
ok("a 429 backs the cadence off", paceOf() > startPace, `${startPace} -> ${paceOf()}`);
ok("and it is counted for the UI to report", api.MutualsAPI.pacing().rateLimitHits > 0,
    String(api.MutualsAPI.pacing().rateLimitHits));

console.log("\n-- a clean run earns its way to a faster cadence --");
reset();
for (let i = 0; i < 40; i++) { mutualsFor["ok" + i] = []; api.MutualsAPI.scan("ok" + i); }
await settle(4000);
ok("after a long run of clean answers it is quicker than it started",
    paceOf() < 2500, `${2500} -> ${paceOf()}`);
ok("but never below the floor", paceOf() >= Number(/const MIN_DELAY = (\d+)/.exec(SRC)[1]), String(paceOf()));

console.log("\n-- swapping accounts must throw the cache away --");
// A mutual-friend list means "friends with BOTH you and them", so it is measured from
// whoever is logged in. Nothing watched for account switches, so the second account was
// served the first account's answers: wrong "Mutual" tags, wrong friendship rings, and
// a dossier full of people the new account has never met (hence the unnamed "user"
// entries in the dashboard).
reset();
mutualsFor.alice = ["f1"]; mutualsFor.bob = ["f2"];
api.MutualsAPI.scan("alice"); api.MutualsAPI.scan("bob");
await settle();
ok("cache is warm before the switch",
    api.MutualsAPI.isScanned("alice") && api.MutualsAPI.isScanned("bob"));

// a plain reconnect on the SAME account must not throw the cache away
const fetchesBefore = fetched.length;
api.onConnectionOpen();
ok("a reconnect on the same account keeps the cache", api.MutualsAPI.isScanned("alice") === true);
ok("and does not refetch everything", fetched.length === fetchesBefore, `${fetched.length} vs ${fetchesBefore}`);

// now actually swap
loggedInAs = "OTHER";
api.onConnectionOpen();
ok("the previous account's answers are gone", api.MutualsAPI.isScanned("alice") === false);
ok("and nothing is served from them", api.MutualsAPI.getMutuals("alice") === null,
    JSON.stringify(api.MutualsAPI.getMutuals("alice")));
ok("the queue is emptied too, so nothing in flight lands under the new account",
    api.MutualsAPI.pendingCount() === 0, String(api.MutualsAPI.pendingCount()));
ok("the auto-managed Mutual trait is cleared", traitCleared > 0, `cleared ${traitCleared}x`);
ok("and the new account starts its own sweep", rescans > 0, `rescans ${rescans}`);

// the same person can now be re-answered for the NEW account, differently
mutualsFor.alice = ["different-friend"];
api.MutualsAPI.scan("alice");
await settle();
ok("re-scanning under the new account gives the new account's answer",
    JSON.stringify(api.MutualsAPI.getMutuals("alice")) === '["different-friend"]',
    JSON.stringify(api.MutualsAPI.getMutuals("alice")));

// switching back must not resurrect stale data either
loggedInAs = "ME";
api.onConnectionOpen();
ok("switching back also starts clean rather than restoring stale answers",
    api.MutualsAPI.getMutuals("alice") === null);

console.log("\n-- finding the user id in a profile dispatch --");
// The bug that made the whole free-answer path a no-op: the dispatch is
// `{ type, userProfile: body }` with the id at userProfile.user.id, and the first
// version never looked there — so it bailed out on every profile and the feature
// appeared simply not to work. Every shape Discord actually sends must resolve.
ok("USER_PROFILE_FETCH_SUCCESS: userProfile.user.id",
    api.profileUserId({ userProfile: { user: { id: "111" } } }) === "111",
    String(api.profileUserId({ userProfile: { user: { id: "111" } } })));
ok("a profile body that carries userId instead",
    api.profileUserId({ userProfile: { userId: "222" } }) === "222");
ok("USER_PROFILE_MODAL_OPEN: a bare userId",
    api.profileUserId({ userId: "333" }) === "333");
ok("a dispatch carrying the user directly", api.profileUserId({ user: { id: "444" } }) === "444");
ok("nothing usable -> null, not undefined or a crash", api.profileUserId({}) === null);
ok("a null dispatch is survivable", api.profileUserId(null) === null);
ok("the profile shape wins over a stale outer id",
    api.profileUserId({ userId: "outer", userProfile: { user: { id: "inner" } } }) === "inner");

console.log("\n-- a free answer from an opened profile --");
// Opening someone's profile makes Discord compute their mutual friends with you and hand
// them to the client. Not taking that meant a person you had literally just looked at sat
// behind a thousand others in the queue, and the panel kept saying it knew nothing about
// them while their profile showed the mutual plainly.
reset();
ok("unknown before the profile is opened", api.MutualsAPI.isScanned("vip") === false);
api.MutualsAPI.record("vip", ["f1", "f2"]);
ok("recorded straight away", api.MutualsAPI.isScanned("vip") === true);
ok("with the right mutuals", JSON.stringify(api.MutualsAPI.getMutuals("vip")) === '["f1","f2"]',
    JSON.stringify(api.MutualsAPI.getMutuals("vip")));
ok("and it cost no request", fetched.length === 0, fetched.join(","));

// an empty list is a real finding, not "we did not look"
reset();
api.MutualsAPI.record("nobody", []);
ok("no mutual friends is an answer, not a gap", api.MutualsAPI.isScanned("nobody") === true);
ok("and reads as an empty list", JSON.stringify(api.MutualsAPI.getMutuals("nobody")) === "[]",
    JSON.stringify(api.MutualsAPI.getMutuals("nobody")));

// duplicates from the different record shapes Discord uses must collapse
reset();
api.MutualsAPI.record("dupe", ["f1", "f1", "f2", ""]);
ok("duplicates and blanks are dropped", JSON.stringify(api.MutualsAPI.getMutuals("dupe")) === '["f1","f2"]',
    JSON.stringify(api.MutualsAPI.getMutuals("dupe")));

// recording must pull them OUT of the queue: spending a request on a known answer is
// pure waste at the head of a long backlog
reset();
mutualsFor.queuedPerson = ["f9"];
api.MutualsAPI.scan("queuedPerson");
const before2 = api.MutualsAPI.pendingCount();
api.MutualsAPI.record("queuedPerson", ["f1"]);
ok(`the pending fetch is cancelled (${before2} -> ${api.MutualsAPI.pendingCount()})`,
    api.MutualsAPI.pendingCount() < before2 || before2 === 0, `${before2} -> ${api.MutualsAPI.pendingCount()}`);
await settle();
ok("and the free answer is the one kept, not overwritten by a later fetch",
    JSON.stringify(api.MutualsAPI.getMutuals("queuedPerson")) === '["f1"]',
    JSON.stringify(api.MutualsAPI.getMutuals("queuedPerson")));

// consumers must be told, or an open panel keeps showing the stale "unknown"
reset();
let pinged = 0;
api.MutualsAPI.subscribe(() => pinged++);
api.MutualsAPI.record("seen", ["f1"]);
ok("subscribers are notified", pinged > 0, String(pinged));

console.log("\n-- answers must survive a restart --");
// The cache was memory-only, so every launch reported "nobody has been scanned" and the
// whole roster was re-fetched from zero. Measured live: scanned went 490 -> 292 across a
// restart while the roster GREW. A person could sit in the queue for days, always being
// overtaken by a fresh re-scan of people already answered for.
reset();
mutualsFor.alice = ["f1"]; mutualsFor.bob = [];
api.MutualsAPI.scan("alice"); api.MutualsAPI.scan("bob");
await settle();
ok("two answers before the restart", api.MutualsAPI.isScanned("alice") && api.MutualsAPI.isScanned("bob"));
api.flushResults();
await settle();
ok("they reached the disk", !!disk["XicordMutualsResults:ME"], Object.keys(disk).join(","));

// ---- restart: a brand-new scanner over the same disk ----
reset(true);
ok("a fresh session starts knowing nothing", api.MutualsAPI.isScanned("alice") === false);
await api.loadResults("ME");
ok("the cache is restored", api.MutualsAPI.isScanned("alice") === true);
ok("with the right mutuals", JSON.stringify(api.MutualsAPI.getMutuals("alice")) === '["f1"]',
    JSON.stringify(api.MutualsAPI.getMutuals("alice")));
ok("and a genuine empty answer survives as an answer, not a gap",
    api.MutualsAPI.isScanned("bob") === true && JSON.stringify(api.MutualsAPI.getMutuals("bob")) === "[]",
    JSON.stringify(api.MutualsAPI.getMutuals("bob")));

fetched = [];
api.MutualsAPI.scan("alice"); api.MutualsAPI.scan("bob");
await settle();
ok("nobody is re-fetched, so the sweep resumes instead of restarting",
    fetched.length === 0, fetched.join(","));

console.log("\n-- but one account's answers must not leak into another --");
reset();
mutualsFor.x = ["f1"];
api.MutualsAPI.scan("x");
await settle();
api.flushResults();
await settle();
loggedInAs = "OTHER";
api.onConnectionOpen();          // account switch
await settle();
ok("the new account starts blank", api.MutualsAPI.isScanned("x") === false);
await api.loadResults("OTHER");
ok("and loading ITS key finds nothing of the first account's",
    api.MutualsAPI.isScanned("x") === false, JSON.stringify(Object.keys(disk)));
ok("the first account's answers are still on disk under its own key",
    !!disk["XicordMutualsResults:ME"], Object.keys(disk).join(","));
await api.loadResults("ME");
ok("and switching back restores them", api.MutualsAPI.isScanned("x") === true);

Date.now = realNow;
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
