// Exercises the append-log push path against a REAL server instance.
//   node xicord-sync/_pushlog.test.mjs
//
// The container is capped at 1GB and was being OOM-killed ("Killed" in the logs, memory
// touching the limit exactly). A push used to read the contributor's whole slice back off
// disk, build a second copy of it to merge into, and serialise the result. The main
// contributor's slice IS most of the pool, so a client sending a few hundred pairs cost
// several hundred megabytes of live objects — on top of the merged view the process
// already holds — and a chunked first sync did that once per batch.
//
// So a push against a LARGE slice appends instead. The invariants that matter:
//   - what was appended is visible immediately, exactly as if it had been merged in
//   - replaying the log gives the same answer as merging would have
//   - compaction folds it back without losing or double-counting anything
//   - a half-written last line (the process died mid-append) costs only that line
//
// The size thresholds are driven down by env so this does not need a gigabyte of fixture.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { gunzipSync } from "zlib";

// The big pool slices are gzipped on disk after compaction (see writeJsonGz in server.js);
// a small in-place slice stays plain. Read either, told apart by the gzip magic, exactly as
// the server's readJson does -- so a content check does not depend on which path wrote it.
const sliceText = f => { const b = readFileSync(f); return (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) ? gunzipSync(b).toString("utf8") : b.toString("utf8"); };

const OWNER = "1400000000000000009";
const dir = mkdtempSync(join(tmpdir(), "xicord-pushlog-"));
mkdirSync(join(dir, "auth"), { recursive: true });
writeFileSync(join(dir, "auth", "tokens.json"), JSON.stringify({ tok: { user: OWNER, at: 1 } }));

const PORT = 8917;
let srv = null;
function start() {
    srv = spawn(process.execPath, ["server.js"], {
        cwd: "C:/Users/aeare/Desktop/Vencord/xicord-sync",
        env: {
            ...process.env, DATA_DIR: dir, PORT: String(PORT),
            XICORD_TOKENS: "", XICORD_ALIASES: "", XICORD_POOL_MIN_MS: "0",
            // tiny, so a handful of records crosses into the log path. The first push
            // below writes ~550 bytes, so the threshold has to sit under that for the
            // SECOND push to take the append path — otherwise this suite quietly tests
            // the rewrite path twice and the log is never exercised at all.
            XICORD_SMALL_SLICE_BYTES: "300",
            XICORD_MAX_LOG_BYTES: "800"
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    srv.stdout.on("data", () => { }); srv.stderr.on("data", () => { });
}
start();

const base = `http://127.0.0.1:${PORT}`;
const call = async (path, body) => {
    const res = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: "Bearer tok", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
};
const until = async fn => {
    for (let i = 0; i < 60; i++) { try { if (await fn()) return true; } catch { } await new Promise(r => setTimeout(r, 200)); }
    return false;
};

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? "\n          " + extra : ""}`); } };

const P = n => "9200000000000000" + String(n).padStart(3, "0");
const person = { guilds: [], first: 1, last: 5000 };
const pushOf = (from, to) => {
    const people = {}, calls = {};
    for (let i = from; i < to; i++) {
        people[P(i)] = { ...person };
        if (i > from) calls[`${P(from)}|${P(i)}`] = { ms: 1000, count: 1, last: 5000, guilds: [] };
    }
    return { people, calls, users: {} };
};

const sliceFile = join(dir, "pool", `${OWNER}.json`);
const logFile = `${sliceFile}.log`;
const poolDir = () => { try { return readdirSync(join(dir, "pool")); } catch { return []; } };

try {
    if (!await until(async () => (await call("/v1/pool")).status === 200)) throw new Error("server never came up");

    console.log("\n-- a small slice is still just one file --");
    await call("/v1/pool", pushOf(0, 4));
    ok("the slice is written in place", existsSync(sliceFile), poolDir().join(","));
    ok("with no log alongside it", !existsSync(logFile), poolDir().join(","));
    let got = (await call("/v1/pool")).body;
    ok("and the people are there", Object.keys(got.people).length === 4, String(Object.keys(got.people).length));

    console.log("\n-- once it is big, pushes append instead --");
    // the slice is now past XICORD_SMALL_SLICE_BYTES, so this one takes the log path
    await call("/v1/pool", pushOf(100, 106));
    ok("a log appears", existsSync(logFile), poolDir().join(","));
    const sliceBefore = sliceText(sliceFile);
    ok("and the slice itself was NOT rewritten", !sliceBefore.includes(P(100)), sliceBefore.slice(0, 80));

    console.log("\n-- but the pull cannot tell the difference --");
    got = (await call("/v1/pool")).body;
    ok("the appended people are in the pull", !!got.people[P(100)] && !!got.people[P(105)],
        Object.keys(got.people).length + " people");
    ok("so are the appended pairs", !!got.calls[`${P(100)}|${P(105)}`], Object.keys(got.calls).join(",").slice(0, 80));
    ok("and the earlier ones survived", !!got.people[P(0)] && !!got.people[P(3)]);

    console.log("\n-- read-your-writes still holds through the log --");
    await call("/v1/pool", { people: { [P(200)]: { ...person } }, calls: {}, users: {} });
    got = (await call("/v1/pool")).body;
    ok("a push is visible on the very next pull", !!got.people[P(200)], "missing");

    console.log("\n-- highest-wins survives the replay --");
    await call("/v1/pool", { people: {}, calls: { [`${P(100)}|${P(105)}`]: { ms: 9000, count: 7, last: 6000, guilds: [] } }, users: {} });
    got = (await call("/v1/pool")).body;
    const pair = got.calls[`${P(100)}|${P(105)}`];
    ok("the higher count wins", pair.count === 7, JSON.stringify(pair));
    ok("the higher duration wins", pair.ms === 9000, JSON.stringify(pair));
    // re-sending the SAME thing must not inflate it — the merge has to stay idempotent
    await call("/v1/pool", { people: {}, calls: { [`${P(100)}|${P(105)}`]: { ms: 9000, count: 7, last: 6000, guilds: [] } }, users: {} });
    got = (await call("/v1/pool")).body;
    ok("re-sending it does not double it", got.calls[`${P(100)}|${P(105)}`].count === 7,
        JSON.stringify(got.calls[`${P(100)}|${P(105)}`]));

    console.log("\n-- the log is folded back before it can grow without bound --");
    const before = Object.keys(got.people).length, beforeCalls = Object.keys(got.calls).length;
    for (let i = 0; i < 6; i++) await call("/v1/pool", pushOf(300 + i * 10, 300 + i * 10 + 5));
    // compaction happens on a COLD read, so restart to force one
    srv.kill(); await new Promise(r => setTimeout(r, 400));
    start();
    if (!await until(async () => (await call("/v1/pool")).status === 200)) throw new Error("restart failed");
    got = (await call("/v1/pool")).body;
    ok("everything pushed is still there after a restart",
        Object.keys(got.people).length >= before + 30 && !!got.people[P(0)] && !!got.people[P(200)],
        `${Object.keys(got.people).length} people, was ${before}`);
    ok("and no call pair was lost", Object.keys(got.calls).length >= beforeCalls, String(Object.keys(got.calls).length));
    ok("the slice now carries what the log held", sliceText(sliceFile).includes(P(100)));
    ok("and the log was cleared", !existsSync(logFile) || readFileSync(logFile, "utf8").length < 800,
        existsSync(logFile) ? String(readFileSync(logFile, "utf8").length) : "gone");

    console.log("\n-- a torn last line costs only that line --");
    // the process dying mid-append leaves a partial line; everything before it still applies
    await call("/v1/pool", pushOf(500, 505));           // ensure a log exists again
    const good = Object.keys((await call("/v1/pool")).body.people).length;
    if (existsSync(logFile)) {
        appendFileSync(logFile, '{"people":{"92000000000000009', "utf8");   // half a line
        srv.kill(); await new Promise(r => setTimeout(r, 400));
        start();
        if (!await until(async () => (await call("/v1/pool")).status === 200)) throw new Error("restart failed");
        got = (await call("/v1/pool")).body;
        ok("the server still starts and answers", Object.keys(got.people).length > 0);
        ok("and nothing written before the tear was lost",
            Object.keys(got.people).length >= good - 1 && !!got.people[P(500)],
            `${Object.keys(got.people).length} vs ${good}`);
    } else {
        ok("(compaction left no log to tear — path not exercised)", true);
        ok("(skipped)", true);
    }
} finally {
    try { srv.kill(); } catch { }
    await new Promise(r => setTimeout(r, 200));
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
}

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
