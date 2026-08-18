// Gzip-at-rest for the big pool slices, exercised against the REAL server.
//   node _atrest.test.mjs
//
// A 100MB slice compresses to ~10MB on disk: 10x less disk (the Railway volume was
// hitting ENOSPC) and 10x less write I/O. The slice is stored gzipped; a legacy plain
// slice still reads, told apart by the gzip magic bytes rather than any side channel.
//
// The threshold envs are driven to 1 byte so a tiny fixture takes the append-log +
// compaction path (that is where writeJsonGz fires), and the on-disk slice is then
// asserted to actually be gzip and to read back through the real HTTP pull.
import { createRequire } from "module";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync, gunzipSync } from "zlib";

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const require = createRequire(import.meta.url);

const DATA = mkdtempSync(join(tmpdir(), "xicord-atrest-"));
process.env.DATA_DIR = DATA;
process.env.XICORD_POOL_MIN_MS = "0";          // tiny fixtures, no 60s floor
process.env.XICORD_SMALL_SLICE_BYTES = "1";    // second push goes to the log, not a rewrite
process.env.XICORD_MAX_LOG_BYTES = "1";        // the next read compacts -> writeJsonGz
process.env.XICORD_TOKENS = "tok-ana-0123456789abcdef:anaPC:100000000000000001";

const srv = require(join(here, "server.js"));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};

const A = "100000000000000001";
const P = "900000000000000001", Q = "900000000000000002", R = "900000000000000003";
const G1 = "500000000000000001", G2 = "500000000000000002";

/* ---------------- unit: the magic-byte logic, mirrored exactly ---------------- */
// Same test server.js's readJson/readSlice use: a gzip member always starts 0x1f 0x8b,
// which no JSON text ever does. If this ever drifts from server.js it is a real bug.
const looksGzipped = buf => buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;

console.log("\n-- the gzip magic tells a compressed slice from a plain one --");
const sample = { people: { [P]: { guilds: [G1], first: 1, last: 2 } }, calls: {}, users: {}, voice: {} };
const gz = gzipSync(JSON.stringify(sample));
const plain = Buffer.from(JSON.stringify(sample), "utf8");
ok("a gzipped buffer is recognised", looksGzipped(gz), gz.slice(0, 2).toString("hex"));
ok("plain JSON text is not", !looksGzipped(plain), plain.slice(0, 2).toString("hex"));
ok("an empty buffer is not", !looksGzipped(Buffer.alloc(0)));

console.log("\n-- gzip round-trips the exact object ---");
const back = JSON.parse((looksGzipped(gz) ? gunzipSync(gz) : gz).toString("utf8"));
ok("write-gz then read-gz is identity", JSON.stringify(back) === JSON.stringify(sample));
const backPlain = JSON.parse((looksGzipped(plain) ? gunzipSync(plain) : plain).toString("utf8"));
ok("a legacy plain file still reads through the same path", JSON.stringify(backPlain) === JSON.stringify(sample));

/* ---------------- integration: through the real server ---------------- */
srv.loadTokens();
await srv.ensureDirs();
await new Promise(r => srv.server.listen(0, "127.0.0.1", r));
const port = srv.server.address().port;
const base = `http://127.0.0.1:${port}`;
const H = { Authorization: "Bearer tok-ana-0123456789abcdef", "Content-Type": "application/json" };
const call = (p, o = {}) => fetch(base + p, o);
const sliceFile = join(DATA, "pool", `${A}.json`);

console.log("\n-- a push, then a second push that lands on the log --");
let r = await call("/v1/pool", { method: "POST", headers: H, body: JSON.stringify({ people: { [P]: { guilds: [G1], first: 50, last: 100 } }, calls: {} }) });
ok("first push accepted (writes a small plain slice)", r.status === 200, String(r.status));
ok("and the first slice is plain JSON on disk", existsSync(sliceFile) && !looksGzipped(readFileSync(sliceFile)));

r = await call("/v1/pool", { method: "POST", headers: H, body: JSON.stringify({ people: { [R]: { guilds: [G2], first: 10, last: 20 } }, calls: {} }) });
ok("second push accepted (appended to the log)", r.status === 200, String(r.status));
ok("its log exists", existsSync(sliceFile + ".log"));

console.log("\n-- the pull compacts the log into a GZIPPED slice and reads it back --");
r = await call("/v1/pool", { headers: H });
const got = await r.json();
ok("the pull returns both pushes, merged", !!got.people[P] && !!got.people[R], Object.keys(got.people).join(","));
ok("the compacted slice on disk is now GZIP (1f 8b)", looksGzipped(readFileSync(sliceFile)), readFileSync(sliceFile).slice(0, 2).toString("hex"));
ok("the log was dropped by compaction", !existsSync(sliceFile + ".log"));

// Prove the bytes on disk really are a gzip of the slice content, and that the same
// records survive a raw inflate -- i.e. readJson would recover them on the next cold read.
const raw = readFileSync(sliceFile);
let inflated = null;
try { inflated = JSON.parse(gunzipSync(raw).toString("utf8")); } catch { }
ok("the gzip on disk inflates to valid slice JSON", !!inflated && !!inflated.people, inflated ? "ok" : "inflate/parse failed");
ok("and holds both people after inflation", !!inflated && !!inflated.people[P] && !!inflated.people[R], inflated ? Object.keys(inflated.people).join(",") : "n/a");
ok("the gzip is smaller than its own JSON", raw.length < Buffer.byteLength(JSON.stringify(inflated || {})), `${raw.length} vs ${Buffer.byteLength(JSON.stringify(inflated || {}))}`);

await new Promise(r2 => srv.server.close(r2));
rmSync(DATA, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
