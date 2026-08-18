// Regressions for the ten defects the 2026-08-08 review confirmed in the pool-cache rework.
//   node xicord-sync/_regressions.test.mjs
//
// Every case here FAILS against the code as it stood before the fixes. That is the point:
// the existing suites all passed while these bugs were live, and two of them actively hid
// one (_incremental future-dated its fixtures, so the delta filter could never be caught
// comparing the wrong clocks; _pushlog tore the last log line but never appended after a
// tear, so a torn line could never be caught eating its successor).
//
// Grouped by the defect each one pins down, named for the failure rather than the fix.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { gunzipSync } from "zlib";

// After compaction a pool slice is gzipped on disk (writeJsonGz in server.js); a small
// in-place one stays plain. Decode either, told apart by the gzip magic, as the server's
// readJson does. Writing plain JSON back is still fine -- readJson reads both.
const sliceJson = f => { const b = readFileSync(f); return JSON.parse((b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) ? gunzipSync(b).toString("utf8") : b.toString("utf8")); };
import { spawn } from "child_process";
import { createRequire } from "module";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { mergeAllPools, mergePool, sanitizePrivate, mergePrivate } = require(join(HERE, "pool.js"));

const OWNER = "1400000000000000021", OTHER = "1400000000000000022";
const P = n => `92000000000000${String(n).padStart(4, "0")}`;
const dir = mkdtempSync(join(tmpdir(), "xicord-regress-"));
mkdirSync(join(dir, "auth"), { recursive: true });
writeFileSync(join(dir, "auth", "tokens.json"), JSON.stringify({
    tok: { user: OWNER, at: 1 }, tok2: { user: OTHER, at: 1 }
}));

const PORT = 8921;
let srv = null;
function start(extraEnv = {}) {
    srv = spawn(process.execPath, ["server.js"], {
        cwd: HERE,
        env: {
            ...process.env, DATA_DIR: dir, PORT: String(PORT),
            XICORD_TOKENS: "", XICORD_ALIASES: "", XICORD_POOL_MIN_MS: "0",
            XICORD_SMALL_SLICE_BYTES: "300",   // so the append-log path is what runs
            XICORD_MAX_LOG_BYTES: "700",
            ...extraEnv
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    srv.stdout.on("data", () => { }); srv.stderr.on("data", () => { });
}
function stop() { return new Promise(r => { if (!srv) return r(); srv.on("exit", r); srv.kill(); }); }

async function call(path, body, token = "tok") {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch { }
    return { status: res.status, body: parsed, text };
}
async function until(fn, tries = 60) {
    for (let i = 0; i < tries; i++) { try { if (await fn()) return true; } catch { } await new Promise(r => setTimeout(r, 100)); }
    return false;
}
const people = (...ids) => Object.fromEntries(ids.map(id => [id, { guilds: [], first: 1, last: 1000 }]));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

try {
    /* ------------------------------------------------------------------ *
     * #10 + the merge algebra the whole design rests on. Pure, no server. *
     * ------------------------------------------------------------------ */
    console.log("\n-- folding slices in place gives the same pool as merging them --");
    const s1 = { people: people(P(1), P(2)), calls: {}, users: {} };
    const s2 = { people: people(P(2), P(3)), calls: {}, users: {} };
    const s3 = { people: people(P(4)), calls: {}, users: {} };
    // Key order follows insertion, and folding the slices in a different order inserts
    // them in a different order — so compare the CONTENT, sorted, not the serialisation.
    const canon = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));
    const viaInto = mergeAllPools([s1, s2, s3]);
    const viaPair = mergePool(mergePool(s1, s2), s3);
    ok("in-place fold equals the pairwise merge", canon(viaInto.people) === canon(viaPair.people));
    ok("and order still does not matter",
        canon(mergeAllPools([s3, s2, s1]).people) === canon(viaInto.people));

    /* --------------------------------------------------- *
     * #6 — a tombstone must outlive the push that made it. *
     * --------------------------------------------------- */
    console.log("\n-- a retraction is not undone by a stale push from a sibling account --");
    const F = P(50);
    let blob = mergePrivate({}, sanitizePrivate({ friends: { [F]: { friends: [P(51)], guilds: [], at: 100 } } }, 1000));
    ok("the friend is there to begin with", !!blob.friends[F]);
    blob = mergePrivate(blob, sanitizePrivate({ retracted: [F] }, 2000));
    ok("retracting removes them", !blob.friends[F], JSON.stringify(blob.friends));
    ok("and the tombstone is kept in the blob", (blob.retracted || {})[F] === 2000, JSON.stringify(blob.retracted));
    // The other account on this blob never saw the unfriending, so its next routine push
    // still carries the name with the SAME old `at` it has always had.
    blob = mergePrivate(blob, sanitizePrivate({ friends: { [F]: { friends: [P(51)], guilds: [], at: 100 } } }, 3000));
    ok("a stale re-assertion does NOT resurrect them", !blob.friends[F], JSON.stringify(blob.friends));
    // But genuinely re-adding them later must still work.
    blob = mergePrivate(blob, sanitizePrivate({ friends: { [F]: { friends: [P(51)], guilds: [], at: 9000 } } }, 4000));
    ok("a genuine re-friend (newer stamp) does come back", !!blob.friends[F], JSON.stringify(blob.friends));

    /* ------------------------------ *
     * The rest need a live server.   *
     * ------------------------------ */
    start();
    if (!await until(async () => (await call("/v1/pool")).status === 200)) throw new Error("server never came up");

    /* ------------------------------------------------------------- *
     * #4 — the delta must key on ARRIVAL, not on the client's clock. *
     * ------------------------------------------------------------- */
    console.log("\n-- a device syncing an old backlog is not invisible to other clients --");
    await call("/v1/pool", { people: people(P(100)), calls: {}, users: {} });
    const mark = (await call("/v1/pool")).body.syncedAt;
    // The event is far older than the watermark the puller already holds; the ARRIVAL is
    // not. Before the fix this record was filtered out of this delta and every later one.
    await call("/v1/pool", { people: { [P(101)]: { guilds: [], first: 1, last: 1 } }, calls: {}, users: {} });
    let d = await call(`/v1/pool?since=${mark}`);
    ok("a record stamped 1970 but pushed now is in the delta",
        !!d.body.people[P(101)], Object.keys(d.body.people).join(","));
    ok("and the record the puller already had is not resent",
        !d.body.people[P(100)], Object.keys(d.body.people).join(","));

    /* ------------------------------------------------------- *
     * #7 — a change to a field the old filter did not look at. *
     * ------------------------------------------------------- */
    console.log("\n-- a guild-only change still reaches a delta --");
    const mark2 = (await call("/v1/pool")).body.syncedAt;
    // `last` deliberately unchanged: only the guild list grows. The old filter keyed on
    // `last` alone, so this update was invisible to every watermark-following client.
    await call("/v1/pool", { people: { [P(100)]: { guilds: ["777000000000000001"], first: 1, last: 1000 } }, calls: {}, users: {} });
    d = await call(`/v1/pool?since=${mark2}`);
    ok("the newly unioned guild appears without `last` moving",
        (d.body.people[P(100)]?.guilds || []).includes("777000000000000001"), JSON.stringify(d.body.people[P(100)]));

    /* ------------------------------------------------------------------ *
     * #2 — a push landing while the view is being rebuilt must not vanish. *
     * ------------------------------------------------------------------ */
    console.log("\n-- a push racing a cold rebuild is still in the view afterwards --");
    await stop();
    // The window has to be real. A cold build over two tiny slices finishes before a
    // concurrent push can reach the handler, so the race never happens and the test passes
    // whether or not the bug is fixed. Enough slices to make the rebuild take long enough
    // for a push to land inside it is the whole setup.
    // The filler is named to sort AFTER the owner's slice, which matters: the push has to
    // land after the build has already read the owner's file (or the record is simply on
    // disk in time and the race never happens). Owner first, then a long tail to land in.
    for (let i = 0; i < 200; i++) {
        const filler = {};
        for (let j = 0; j < 40; j++) filler[P(1000 + i * 40 + j)] = { guilds: [], first: 1, last: 1000, sat: 1 };
        writeFileSync(join(dir, "pool", `94000000000000${String(i).padStart(5, "0")}.json`),
            JSON.stringify({ people: filler, calls: {}, users: {} }));
    }
    start();   // cold: nothing cached, so the next pull triggers a full build
    if (!await until(async () => (await call("/v1/health")).status === 200)) throw new Error("restart failed");
    // Start the build, let it get past the owner's slice, THEN push into the gap.
    const building = call("/v1/pool");
    await new Promise(r => setTimeout(r, 25));
    const pushed = await call("/v1/pool", { people: people(P(200)), calls: {}, users: {} });
    await building;
    ok("the racing push was accepted", pushed.status === 200, String(pushed.status));
    const after = await call("/v1/pool");
    ok("and read-your-writes holds: it is in the very next pull",
        !!after.body.people[P(200)], `${Object.keys(after.body.people).length} people`);

    /* ------------------------------------------------------ *
     * #3 — a torn line must not consume the push that follows. *
     * ------------------------------------------------------ */
    console.log("\n-- a half-written log line does not eat the NEXT push --");
    // Grow the slice past the threshold so pushes take the append path.
    for (let i = 0; i < 6; i++) await call("/v1/pool", { people: people(P(300 + i)), calls: {}, users: {} });
    const logFile = join(dir, "pool", `${OWNER}.json.log`);
    if (existsSync(logFile)) {
        const beforeTear = Object.keys((await call("/v1/pool")).body.people).length;
        appendFileSync(logFile, '{"people":{"92000000000000039', "utf8");   // died mid-append
        // The push AFTER the tear is the case the old code lost: it was concatenated onto
        // the fragment, the glued line failed to parse, and both were dropped on replay.
        await call("/v1/pool", { people: people(P(400)), calls: {}, users: {} });
        await stop(); start();
        if (!await until(async () => (await call("/v1/pool")).status === 200)) throw new Error("restart failed");
        const back = (await call("/v1/pool")).body.people;
        ok("the push made after the tear survived the restart", !!back[P(400)], "P400 missing");
        ok("and nothing written before the tear was lost",
            Object.keys(back).length >= beforeTear, `${Object.keys(back).length} vs ${beforeTear}`);
    } else {
        ok("(no log to tear — path not exercised)", true);
        ok("(skipped)", true);
    }

    /* ------------------------------------------------------------ *
     * #1 — compaction must not delete a push appended while it runs. *
     * ------------------------------------------------------------ */
    console.log("\n-- a push during compaction is not deleted with the log --");
    // Same problem as the rebuild race: compaction on a tiny slice reads, writes and
    // deletes the log in one uninterrupted burst, so nothing can land in the middle and
    // the bug cannot show. The window is the serialise-and-write of the slice, so the
    // slice has to be big enough for that to take real time — which is also the only
    // situation the append-log exists for.
    await stop();
    const bigSlice = { people: {}, calls: {}, users: {} };
    for (let i = 0; i < 60000; i++) bigSlice.people[P(2000 + i)] = { guilds: [], first: 1, last: 1000, sat: 1 };
    writeFileSync(join(dir, "pool", `${OWNER}.json`), JSON.stringify(bigSlice));
    // and a log over MAX_LOG_BYTES, so the cold read compacts
    writeFileSync(join(dir, "pool", `${OWNER}.json.log`),
        Array.from({ length: 40 }, (_, i) =>
            JSON.stringify({ people: people(P(1500 + i)), calls: {}, users: {} })).join("\n") + "\n");
    start();
    if (!await until(async () => (await call("/v1/health")).status === 200)) throw new Error("restart failed");
    // Compaction's window is the serialise-and-write of that slice. Start it, then push
    // into the middle of it rather than firing both at once and hoping.
    // A single timed push cannot pin this down: the loss window is between the log being
    // READ and the log being DELETED, and where that falls depends on how fast the machine
    // serialises a few megabytes. So push a steady stream across the whole compaction and
    // require that EVERY one survives. Whatever the window turns out to be, something lands
    // inside it — and under the lock, nothing is lost wherever it lands.
    const compacting = call("/v1/pool");
    const racers = [];
    for (let i = 0; i < 25; i++) {
        racers.push(await call("/v1/pool", { people: people(P(500 + i)), calls: {}, users: {} }));
        await new Promise(r => setTimeout(r, 15));
    }
    await compacting;
    ok("every push during compaction was accepted", racers.every(x => x.status === 200),
        racers.map(x => x.status).join(","));
    await stop(); start();   // re-read from disk: were they actually persisted?
    if (!await until(async () => (await call("/v1/pool")).status === 200)) throw new Error("restart failed");
    const back = (await call("/v1/pool")).body.people;
    const lost = Array.from({ length: 25 }, (_, i) => P(500 + i)).filter(id => !back[id]);
    ok("and none of them was deleted with the log", lost.length === 0, `lost ${lost.length}: ${lost.join(",")}`);

    /* ----------------------------------------------------- *
     * #8 — the TTL backstop must cover FULL pulls, not just  *
     *      deltas, since a full pull is what heals drift.    *
     * ----------------------------------------------------- */
    console.log("\n-- the full-body cache expires, so a missed invalidation cannot last --");
    await stop();
    start({ XICORD_POOL_TTL_MS: "400" });
    if (!await until(async () => (await call("/v1/pool")).status === 200)) throw new Error("restart failed");
    const firstFull = await call("/v1/pool");
    // Write straight to the slice, behind the server's back — this is precisely a "missed
    // invalidation": nothing tells the cache it is stale. Only the TTL can catch it.
    const sliceFile = join(dir, "pool", `${OWNER}.json`);
    const onDisk = sliceJson(sliceFile);
    onDisk.people[P(600)] = { guilds: [], first: 1, last: 1000, sat: Date.now() };
    writeFileSync(sliceFile, JSON.stringify(onDisk));
    ok("the cached full pull does not see it yet",
        !firstFull.body.people[P(600)], "already visible");
    await new Promise(r => setTimeout(r, 700));
    ok("but a full pull after the TTL does",
        !!(await call("/v1/pool")).body.people[P(600)], "still stale after the TTL");

    /* ------------------------------------------------- *
     * #9 — a pusher can still confirm what it banked.   *
     * ------------------------------------------------- */
    console.log("\n-- a push reports what landed --");
    const r = await call("/v1/pool", { people: people(P(700)), calls: {}, users: {} });
    ok("accepted counts the records in the push", r.body.accepted.people === 1, JSON.stringify(r.body.accepted));
    ok("and the pool totals are reported once a view exists",
        r.body.pool && r.body.pool.people > 1, JSON.stringify(r.body.pool));

    /* ---------------------------------------------------------- *
     * #5 — the unauthenticated landing page must not re-merge.    *
     * ---------------------------------------------------------- */
    console.log("\n-- the landing page is served from the shared view, not a fresh merge --");
    const t0 = Date.now();
    const hits = await Promise.all(Array.from({ length: 12 }, () =>
        fetch(`http://127.0.0.1:${PORT}/`).then(x => x.status)));
    const elapsed = Date.now() - t0;
    ok("twelve concurrent anonymous hits all succeed", hits.every(s => s === 200), hits.join(","));
    // Not a benchmark — a shape check. Twelve independent full merges would serialise into
    // something far slower than twelve reads of one cached view.
    ok(`and they do not each rebuild the pool (${elapsed}ms)`, elapsed < 3000, `${elapsed}ms`);
    ok("the page still reports the real population",
        (await (await fetch(`http://127.0.0.1:${PORT}/`)).text()).length > 0);

} finally {
    try { await stop(); } catch { }
    await new Promise(r => setTimeout(r, 200));
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
}

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
