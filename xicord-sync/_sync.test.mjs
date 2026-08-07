// Drives the REAL xicord-sync server and merge rules over a temp data dir.
//   node _sync.test.mjs
import { createRequire } from "module";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const require = createRequire(import.meta.url);

const DATA = mkdtempSync(join(tmpdir(), "xicord-sync-"));
process.env.DATA_DIR = DATA;
process.env.XICORD_TOKENS = "tok-alpha-0123456789abcdef:desktop,tok-beta-0123456789abcdef:laptop";
// small cap so the oversize path is exercised in milliseconds rather than at 32MB
process.env.MAX_BODY_BYTES = "65536";

const { mergeSnapshot, mergeAll, sanitize, minStamp } = require(join(here, "merge.js"));
const srv = require(join(here, "server.js"));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};
const comp = (count, ms, last = 1) => ({ count, ms, last });
const snap = (id, comps, extra = {}) => ({
    dossiers: { [id]: { companions: comps, guilds: {}, firstSeen: 0, updated: 0, ...extra } },
    users: {}
});

/* ---------------- merge maths ---------------- */
console.log("\n-- the double-count trap --");
// Both PCs watched the SAME call. Adding gives 2, which would be a lie.
let m = mergeSnapshot(snap("A", { b: comp(1, 1000) }), snap("A", { b: comp(1, 1000) }));
ok("the same call seen by two devices stays 1×", m.dossiers.A.companions.b.count === 1,
    JSON.stringify(m.dossiers.A.companions.b));
ok("and its duration is not doubled either", m.dossiers.A.companions.b.ms === 1000);

// The pull-before-push contract: the busier device carries the pooled total.
m = mergeSnapshot(snap("A", { b: comp(7, 9000) }), snap("A", { b: comp(3, 2000) }));
ok("the further-along device wins", m.dossiers.A.companions.b.count === 7);
ok("per field, not per record", m.dossiers.A.companions.b.ms === 9000);

console.log("\n-- order and repetition must not matter --");
const s1 = snap("A", { b: comp(2, 50), c: comp(9, 10) });
const s2 = snap("A", { b: comp(5, 10), d: comp(1, 1) });
// compare by value: JSON.stringify is key-order sensitive, and the two folds insert
// keys in different orders while holding identical data
const canon = o => JSON.stringify(o, (k, v) =>
    (v && typeof v === "object" && !Array.isArray(v))
        ? Object.fromEntries(Object.keys(v).sort().map(kk => [kk, v[kk]]))
        : v);
const ab = canon(mergeSnapshot(s1, s2)), ba = canon(mergeSnapshot(s2, s1));
ok("merging is order-independent", ab === ba, `${ab}
          ${ba}`);
ok("merging is idempotent", canon(mergeSnapshot(mergeSnapshot(s1, s2), s2)) === ab);
ok("everyone survives the merge",
    Object.keys(mergeSnapshot(s1, s2).dossiers.A.companions).sort().join(",") === "b,c,d");

console.log("\n-- firstSeen takes the EARLIEST, and 0 means unknown --");
m = mergeSnapshot(snap("A", { b: comp(1, 1) }, { firstSeen: 5000 }), snap("A", { b: comp(1, 1) }, { firstSeen: 3000 }));
ok("the earlier first sighting wins", m.dossiers.A.firstSeen === 3000, String(m.dossiers.A.firstSeen));
m = mergeSnapshot(snap("A", { b: comp(1, 1) }, { firstSeen: 5000 }), snap("A", { b: comp(1, 1) }, { firstSeen: 0 }));
ok("a device with no first sighting does not zero it for everyone",
    m.dossiers.A.firstSeen === 5000, String(m.dossiers.A.firstSeen));
ok("minStamp ignores 0 on both sides", minStamp(0, 0) === 0);
m = mergeSnapshot(snap("A", { b: comp(1, 1) }, { updated: 10 }), snap("A", { b: comp(1, 1) }, { updated: 99 }));
ok("updated takes the most recent", m.dossiers.A.updated === 99);

console.log("\n-- names: the fresher resolution wins --");
m = mergeSnapshot(
    { dossiers: {}, users: { "1": { username: "old", avatar: "", at: 100 } } },
    { dossiers: {}, users: { "1": { username: "new", avatar: "", at: 200 } } });
ok("a rename propagates", m.users["1"].username === "new");
m = mergeSnapshot(
    { dossiers: {}, users: { "1": { username: "new", avatar: "", at: 200 } } },
    { dossiers: {}, users: { "1": { username: "old", avatar: "", at: 100 } } });
ok("a stale copy does not clobber it", m.users["1"].username === "new");

console.log("\n-- three devices fold into one picture --");
const pooled = mergeAll([
    snap("A", { b: comp(3, 10) }),
    snap("A", { b: comp(1, 99), c: comp(4, 4) }),
    snap("A", { d: comp(2, 2) })
]);
ok("highest per field across all three",
    pooled.dossiers.A.companions.b.count === 3 && pooled.dossiers.A.companions.b.ms === 99,
    JSON.stringify(pooled.dossiers.A.companions.b));
ok("union of everyone seen anywhere",
    Object.keys(pooled.dossiers.A.companions).sort().join(",") === "b,c,d");

console.log("\n-- a malformed push cannot write junk --");
const dirty = sanitize({
    dossiers: {
        "123456789012345": { companions: { "987654321098765": { count: "5", ms: 10, last: 3 }, "bad-id": { count: 9 } }, guilds: { "111111111111": 2 }, firstSeen: 7, updated: 9 },
        "__proto__": { companions: {} },
        "not-a-snowflake": { companions: {} }
    },
    users: { "123456789012345": { username: "x".repeat(500), avatar: "javascript:alert(1)", at: 5 } },
    somethingElse: "ignored"
});
ok("non-snowflake ids are dropped", Object.keys(dirty.dossiers).join(",") === "123456789012345",
    Object.keys(dirty.dossiers).join(","));
ok("__proto__ is not a key on the output", !Object.prototype.hasOwnProperty.call(dirty.dossiers, "__proto__"));
ok("prototype is untouched", ({}).companions === undefined);
ok("bad companion ids are dropped",
    Object.keys(dirty.dossiers["123456789012345"].companions).join(",") === "987654321098765");
ok("a string count is coerced, not trusted", dirty.dossiers["123456789012345"].companions["987654321098765"].count === 5);
ok("usernames are length-capped", dirty.users["123456789012345"].username.length === 128);
ok("a non-http avatar is discarded", dirty.users["123456789012345"].avatar === "");
ok("unknown top-level keys are dropped", Object.keys(dirty).sort().join(",") === "dossiers,users");

/* ---------------- http ---------------- */
console.log("\n-- the server --");
srv.loadTokens();
await srv.ensureDirs();
await new Promise(r => srv.server.listen(0, "127.0.0.1", r));
const port = srv.server.address().port;
const base = `http://127.0.0.1:${port}`;
const call = (path, opts = {}) => fetch(base + path, opts);
const AUTH = t => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
const ALPHA = "tok-alpha-0123456789abcdef", BETA = "tok-beta-0123456789abcdef";
// real snowflakes: sanitize() drops anything that is not one, which is the point
const P = "100000000000000001", Q = "200000000000000002", R = "300000000000000003";
const S = "400000000000000004", T = "500000000000000005";

let r = await call("/v1/health");
ok("health needs no token", r.status === 200 && (await r.json()).ok === true);

r = await call("/v1/pull");
ok("pull without a token is refused", r.status === 401);
r = await call("/v1/pull", { headers: AUTH("wrong-token-aaaaaaaaaaaa") });
ok("pull with the wrong token is refused", r.status === 401);
ok("and the refusal leaks nothing", JSON.stringify(await r.json()) === '{"error":"unauthorized"}');

r = await call("/v1/push", { method: "POST", headers: AUTH(ALPHA), body: JSON.stringify(snap(P, { [Q]: comp(2, 500) })) });
ok("desktop can push", r.status === 200 && (await r.clone().json()).ok === true);
ok("the slice is attributed to that device", (await r.json()).device.startsWith("desktop-"));

r = await call("/v1/push", { method: "POST", headers: AUTH(BETA), body: JSON.stringify(snap(P, { [Q]: comp(5, 100), [R]: comp(1, 1) })) });
ok("laptop can push too", r.status === 200);

r = await call("/v1/pull", { headers: AUTH(ALPHA) });
let pulled = await r.json();
ok("pull merges both devices", pulled.dossiers[P].companions[Q].count === 5, JSON.stringify(pulled.dossiers[P]));
ok("taking the best of each field", pulled.dossiers[P].companions[Q].ms === 500);
ok("and the union of people", Object.keys(pulled.dossiers[P].companions).sort().join(",") === [Q,R].sort().join(","));
ok("pull reports what it holds", pulled.people === 1 && pulled.names === 0, JSON.stringify({ p: pulled.people, n: pulled.names }));

console.log("\n-- a device only ever writes its own slice --");
const files = require("fs").readdirSync(join(DATA, "devices")).sort();
ok(`one file per device (${files.join(", ")})`, files.length === 2);
const desktopFile = files.find(f => f.startsWith("desktop-"));
const before = readFileSync(join(DATA, "devices", desktopFile), "utf8");
await call("/v1/push", { method: "POST", headers: AUTH(BETA), body: JSON.stringify(snap(S, { [Q]: comp(1, 1) })) });
ok("a laptop push leaves the desktop slice byte-identical",
    readFileSync(join(DATA, "devices", desktopFile), "utf8") === before);

console.log("\n-- a delta adds to the slice, it does not replace it --");
await call("/v1/push", { method: "POST", headers: AUTH(ALPHA), body: JSON.stringify(snap(T, { [Q]: comp(1, 1) })) });
pulled = await (await call("/v1/pull", { headers: AUTH(ALPHA) })).json();
ok("the earlier person is still there", !!pulled.dossiers[P], Object.keys(pulled.dossiers).join(","));
ok("and the new one arrived", !!pulled.dossiers[T], Object.keys(pulled.dossiers).join(","));

console.log("\n-- re-pushing the same thing changes nothing --");
const sliceBefore = readFileSync(join(DATA, "devices", desktopFile), "utf8");
await call("/v1/push", { method: "POST", headers: AUTH(ALPHA), body: JSON.stringify(snap(P, { [Q]: comp(2, 500) })) });
ok("the slice is unchanged", readFileSync(join(DATA, "devices", desktopFile), "utf8") === sliceBefore);

console.log("\n-- bad input --");
r = await call("/v1/push", { method: "POST", headers: AUTH(ALPHA), body: "{not json" });
ok("invalid json is a 400, not a crash", r.status === 400);
// declared oversize: refused on Content-Length alone, before a byte is buffered
r = await call("/v1/push", { method: "POST", headers: AUTH(ALPHA), body: "x".repeat(64) , });
ok("a normal small body is still fine", r.status === 200 || r.status === 400, String(r.status));
// Declared oversize: refused on Content-Length alone, before a byte is buffered.
r = await call("/v1/push", { method: "POST", headers: AUTH(ALPHA), body: "x".repeat(70000) });
ok(`an oversized declared body is refused with 413 (${r.status})`, r.status === 413, String(r.status));

// Undeclared oversize (chunked): the streaming guard has to catch it, and the client must
// still receive the 413 rather than a bare connection reset.
const httpMod = require("http");
const overStatus = await new Promise(resolve => {
    const rq = httpMod.request(
        { host: "127.0.0.1", port, path: "/v1/push", method: "POST",
          headers: { Authorization: `Bearer ${ALPHA}`, "Content-Type": "application/json" } },
        rs => { rs.resume(); resolve(rs.statusCode); });
    rq.on("error", () => resolve(-1));
    const chunk = Buffer.alloc(16 * 1024, 120);
    for (let i = 0; i < 8; i++) rq.write(chunk);   // 128KB, no content-length
    rq.end();
});
ok(`a chunked body over the cap is refused with 413 (got ${overStatus})`, overStatus === 413, String(overStatus));

r = await call("/v1/nope", { headers: AUTH(ALPHA) });
ok(`unknown route is a 404 (got ${r.status})`, r.status === 404, String(r.status));

console.log("\n-- a half-written slice can never be read --");
// writeSlice goes temp-file-then-rename, so a reader sees the old file or the new one
mkdirSync(join(DATA, "devices"), { recursive: true });
writeFileSync(join(DATA, "devices", "torn-00000000.json.tmp"), "{ this is not valid json");
r = await call("/v1/pull", { headers: AUTH(ALPHA) });
ok("a stray .tmp file is ignored by pull", r.status === 200);
const stray = require("fs").readdirSync(join(DATA, "devices")).filter(f => f.endsWith(".json"));
ok("only .json files count as slices", !stray.some(f => f.includes(".tmp")));

await new Promise(r2 => srv.server.close(r2));
rmSync(DATA, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
