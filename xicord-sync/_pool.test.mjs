// Drives the v2 pool/private split against the REAL server over a temp data dir.
//   node _pool.test.mjs
//
// The split exists because the two kinds of data behave differently:
//   * co-call facts are true whoever saw them, so they POOL across contributors;
//   * mutual friends are what Discord reports FROM one account, so pooling them would
//     produce one false graph out of several true ones.
// These tests hold that line: pool merges across users, private never does.
import { createRequire } from "module";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const require = createRequire(import.meta.url);

const DATA = mkdtempSync(join(tmpdir(), "xicord-pool-"));
process.env.DATA_DIR = DATA;
// token : name : discordUserId
process.env.XICORD_TOKENS = [
    "tok-ana-0123456789abcdef:anaPC:100000000000000001",
    "tok-ana2-0123456789abcdef:anaPhone:100000000000000001",   // same user, second device
    "tok-ben-0123456789abcdef:benPC:200000000000000002",
    "tok-nobody-0123456789abcdef:orphan"                        // no user bound
].join(",");

const pool = require(join(here, "pool.js"));
const srv = require(join(here, "server.js"));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};
const A = "100000000000000001", B = "200000000000000002";
const P = "900000000000000001", Q = "900000000000000002", R = "900000000000000003";
const G1 = "500000000000000001", G2 = "500000000000000002";

/* ---------------- merge rules ---------------- */
console.log("\n-- the pool combines, it does not add up --");
let m = pool.mergePool(
    { people: {}, calls: { [`${P}|${Q}`]: { ms: 3600000, count: 1, last: 10, guilds: [G1] } } },
    { people: {}, calls: { [`${P}|${Q}`]: { ms: 3600000, count: 1, last: 20, guilds: [G1] } } });
ok("the same call seen twice stays one call", m.calls[`${P}|${Q}`].count === 1, JSON.stringify(m.calls));
ok("and its duration is not doubled", m.calls[`${P}|${Q}`].ms === 3600000);
ok("but the most recent sighting wins", m.calls[`${P}|${Q}`].last === 20);

m = pool.mergePool(
    { people: { [P]: { guilds: [G1], first: 500, last: 10 } } },
    { people: { [P]: { guilds: [G2], first: 300, last: 90 } } });
ok("servers union", m.people[P].guilds.slice().sort().join(",") === [G1, G2].sort().join(","), JSON.stringify(m.people[P]));
ok("first seen takes the EARLIEST", m.people[P].first === 300, String(m.people[P].first));
ok("last seen takes the most recent", m.people[P].last === 90);
m = pool.mergePool({ people: { [P]: { first: 500 } } }, { people: { [P]: { first: 0 } } });
ok("a contributor with no first-seen does not zero it", m.people[P].first === 500, String(m.people[P].first));

console.log("\n-- a pair has exactly one key, however it arrives --");
const dirty = pool.sanitizePool({
    calls: {
        [`${Q}|${P}`]: { ms: 100, count: 1, last: 1, guilds: [G1] },   // unsorted
        [`${P}|${Q}`]: { ms: 500, count: 2, last: 9, guilds: [G2] },   // sorted
        [`${P}|${P}`]: { ms: 1 },                                      // self-pair
        "not|ids": { ms: 1 }
    },
    people: { [P]: { guilds: [G1, "junk"], first: 5, last: 6 }, bad: { guilds: [] } }
});
ok("both orderings collapse into one record", Object.keys(dirty.calls).length === 1, Object.keys(dirty.calls).join(","));
ok("and their values are combined, not overwritten",
    dirty.calls[`${P}|${Q}`].ms === 500 && dirty.calls[`${P}|${Q}`].count === 2, JSON.stringify(dirty.calls));
ok("with both servers kept", dirty.calls[`${P}|${Q}`].guilds.slice().sort().join(",") === [G1, G2].sort().join(","));
ok("a self-pair is dropped", !Object.keys(dirty.calls).some(k => k === `${P}|${P}`));
ok("non-snowflake ids are dropped", !Object.keys(dirty.people).includes("bad"));
ok("junk guild ids are dropped", dirty.people[P].guilds.join(",") === G1);

console.log("\n-- private data: a newer answer REPLACES, so an unfriending sticks --");
let pv = pool.mergePrivate(
    { friends: { [P]: { friends: [Q, R], guilds: [], at: 100 } } },
    { friends: { [P]: { friends: [Q], guilds: [], at: 200 } } });
ok("the fresher list wins wholesale, dropping the removed name",
    pv.friends[P].friends.join(",") === Q, JSON.stringify(pv.friends[P]));
pv = pool.mergePrivate(
    { friends: { [P]: { friends: [Q], guilds: [], at: 200 } } },
    { friends: { [P]: { friends: [Q, R], guilds: [], at: 100 } } });
ok("a stale list does not resurrect a removed name", pv.friends[P].friends.join(",") === Q);
pv = pool.mergePrivate({ watching: [P, Q] }, { watching: [P] });
ok("the watchlist follows the newer push, so removals stick", pv.watching.join(",") === P, pv.watching.join(","));
pv = pool.mergePrivate({ notes: { [P]: { text: "old", at: 1 } } }, { notes: { [P]: { text: "new", at: 2 } } });
ok("the newer note wins", pv.notes[P].text === "new");
const longNote = pool.sanitizePrivate({ notes: { [P]: { text: "x".repeat(9000), at: 1 } } });
ok("notes are length-capped", longNote.notes[P].text.length === 4000, String(longNote.notes[P].text.length));

/* ---------------- over http ---------------- */
console.log("\n-- the service --");
srv.loadTokens();
await srv.ensureDirs();
await new Promise(r => srv.server.listen(0, "127.0.0.1", r));
const port = srv.server.address().port;
const base = `http://127.0.0.1:${port}`;
const H = t => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
const ANA = "tok-ana-0123456789abcdef", ANA2 = "tok-ana2-0123456789abcdef";
const BEN = "tok-ben-0123456789abcdef", ORPHAN = "tok-nobody-0123456789abcdef";
const call = (p, o = {}) => fetch(base + p, o);

const anaPool = { people: { [P]: { guilds: [G1], first: 50, last: 100 } }, calls: { [`${P}|${Q}`]: { ms: 1000, count: 2, last: 100, guilds: [G1] } } };
const benPool = { people: { [R]: { guilds: [G2], first: 10, last: 20 } }, calls: { [`${P}|${Q}`]: { ms: 9000, count: 1, last: 50, guilds: [G2] } } };

let r = await call("/v1/pool", { method: "POST", headers: H(ANA), body: JSON.stringify(anaPool) });
ok("ana can contribute to the pool", r.status === 200 && (await r.json()).user === A);
r = await call("/v1/pool", { method: "POST", headers: H(BEN), body: JSON.stringify(benPool) });
ok("ben can too", r.status === 200 && (await r.json()).user === B);

r = await call("/v1/pool", { headers: H(ANA) });
let got = await r.json();
ok("the pool holds both contributors' people", !!got.people[P] && !!got.people[R], Object.keys(got.people).join(","));
ok("and combines a shared pair per field",
    got.calls[`${P}|${Q}`].ms === 9000 && got.calls[`${P}|${Q}`].count === 2, JSON.stringify(got.calls[`${P}|${Q}`]));
ok("with both servers", got.calls[`${P}|${Q}`].guilds.length === 2, JSON.stringify(got.calls[`${P}|${Q}`].guilds));

console.log("\n-- one user's two devices share a slice; two users do not --");
const files = require("fs").readdirSync(join(DATA, "pool")).sort();
ok(`one pool file per USER, not per device (${files.join(", ")})`, files.length === 2, files.join(","));
await call("/v1/pool", { method: "POST", headers: H(ANA2), body: JSON.stringify({ people: { [Q]: { guilds: [G1], first: 1, last: 2 } }, calls: {} }) });
const files2 = require("fs").readdirSync(join(DATA, "pool")).filter(f => f.endsWith(".json"));
ok("ana's second device writes into ana's slice, not a third file", files2.length === 2, files2.join(","));

console.log("\n-- private blobs never leak between users --");
r = await call("/v1/me", { method: "POST", headers: H(ANA), body: JSON.stringify({ friends: { [P]: { friends: [Q], guilds: [G1], at: 5 } }, watching: [R], notes: { [P]: { text: "ana's note", at: 1 } } }) });
ok("ana can write her private blob", r.status === 200);
r = await call("/v1/me", { headers: H(BEN) });
let ben = await r.json();
ok("ben's blob is empty — he sees nothing of ana's",
    Object.keys(ben.friends || {}).length === 0 && (ben.watching || []).length === 0, JSON.stringify(ben.counts));
r = await call("/v1/me", { headers: H(ANA2) });
let ana2 = await r.json();
ok("but ana's OTHER device sees her own blob", Object.keys(ana2.friends).length === 1 && ana2.notes[P].text === "ana's note",
    JSON.stringify(ana2.counts));

console.log("\n-- a token with no user owns nothing --");
r = await call("/v1/me", { headers: H(ORPHAN) });
ok("it cannot read a private blob", r.status === 403, String(r.status));
r = await call("/v1/pool", { method: "POST", headers: H(ORPHAN), body: JSON.stringify(anaPool) });
ok("nor contribute to the pool", r.status === 403, String(r.status));
r = await call("/v1/pool", { headers: H(ORPHAN) });
ok("but it can still READ the pool", r.status === 200, String(r.status));

console.log("\n-- auth is still required --");
ok("no token is 401", (await call("/v1/pool")).status === 401);
ok("wrong token is 401", (await call("/v1/pool", { headers: H("nope-nope-nope-nope") })).status === 401);

console.log("\n-- re-pushing changes nothing --");
// Everything except `sat`, the moment the server accepted the record. That one field is
// SUPPOSED to move: it is what a delta keys on, and it records when we were last told a
// thing rather than when the thing happened. The observation is new even when the fact is
// not. What must not move is the pooled content — no counter creeps, no duration doubles.
const stripSat = txt => JSON.stringify(JSON.parse(txt), (k, v) => (k === "sat" ? undefined : v));
const sliceOf = () => require("fs").readFileSync(join(DATA, "pool", `${A}.json`), "utf8");
const before = stripSat(sliceOf());
await call("/v1/pool", { method: "POST", headers: H(ANA), body: JSON.stringify(anaPool) });
ok("the slice is identical apart from the arrival stamp", stripSat(sliceOf()) === before);

console.log("\n-- v1 routes still work while devices migrate --");
r = await call("/v1/pull", { headers: H(ANA) });
ok("v1 pull still answers", r.status === 200, String(r.status));

await new Promise(r2 => srv.server.close(r2));
rmSync(DATA, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
