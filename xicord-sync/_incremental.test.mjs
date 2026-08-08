// Exercises incremental pulls against a REAL server instance.
//   node xicord-sync/_incremental.test.mjs
//
// A full pull is ~49MB of JSON — 114k call pairs and 11k names — and clients poll it.
// `?since=<ms>` returns only records whose own timestamp is newer.
//
// Every test here is about the failure mode that makes deltas dangerous: a record that is
// silently NOT sent and never asked for again. A delta that is merely slow is a nuisance;
// a delta with a hole in it is wrong forever, and no client can detect it.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";

const OWNER = "1400000000000000001";
const P1 = "900000000000000001", P2 = "900000000000000002", P3 = "900000000000000003";
const P4 = "900000000000000004";
const F1 = "800000000000000001", F2 = "800000000000000002";

const dir = mkdtempSync(join(tmpdir(), "xicord-inc-"));
mkdirSync(join(dir, "auth"), { recursive: true });
writeFileSync(join(dir, "auth", "tokens.json"), JSON.stringify({ tok: { user: OWNER, at: 1 } }));

const PORT = 8905;
const srv = spawn(process.execPath, ["server.js"], {
    cwd: "C:/Users/aeare/Desktop/Vencord/xicord-sync",
    env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), XICORD_TOKENS: "", XICORD_ALIASES: "" },
    stdio: ["ignore", "pipe", "pipe"],
});
let log = ""; srv.stdout.on("data", d => { log += d; }); srv.stderr.on("data", d => { log += d; });

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
const person = (id, last) => ({ [id]: { guilds: [], first: 1, last } });

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? "\n          " + extra : ""}`); } };

try {
    if (!await until(async () => (await fetch(base + "/v1/health")).ok)) throw new Error("no server:\n" + log);

    console.log("\n-- a delta carries only what changed --");
    await call("/v1/pool", { people: person(P1, 1000), calls: {}, users: {} });
    const first = await call("/v1/pool");
    ok("a full pull has the record", !!first.body.people[P1]);
    ok("and hands back a watermark", first.body.syncedAt > 0, String(first.body.syncedAt));

    // nothing new since: the delta should be empty of people
    let d = await call(`/v1/pool?since=${first.body.syncedAt}`);
    ok("an unchanged pool yields an empty delta", Object.keys(d.body.people).length === 0,
        JSON.stringify(Object.keys(d.body.people)));
    ok("but still reports the true totals", d.body.counts.totalPeople === 1, JSON.stringify(d.body.counts));

    await call("/v1/pool", { people: person(P2, Date.now() + 5000), calls: {}, users: {} });
    d = await call(`/v1/pool?since=${first.body.syncedAt}`);
    ok("a new record appears in the delta", !!d.body.people[P2], Object.keys(d.body.people).join(","));
    ok("and the unchanged one does not", !d.body.people[P1], Object.keys(d.body.people).join(","));

    console.log("\n-- a record the client gave no timestamp is still delivered --");
    // The delta keys on when the SERVER accepted a record, not on the client's account of
    // when the thing happened, so a record carrying no usable stamp of its own is still
    // placed correctly in time. "Unknown" must never be read as "unchanged": that would
    // drop it permanently, and no client could ever notice the hole.
    const beforeP3 = (await call("/v1/pool")).body.syncedAt;
    await call("/v1/pool", { people: { [P3]: { guilds: [], first: 0, last: 0 } }, calls: {}, users: {} });
    d = await call(`/v1/pool?since=${beforeP3}`);
    ok("it reaches a client whose watermark predates the push",
        !!d.body.people[P3], Object.keys(d.body.people).join(","));

    console.log("\n-- a record that HAPPENED long ago but arrives now is still delivered --");
    // The bug this guards: filtering on the client's event time meant a call that ended at
    // 12:00 and synced at 12:07 was invisible to a watermark of 12:05 — on that pull and on
    // every pull after it, because 12:00 never becomes newer. An offline device syncing
    // hours of backlog hit this every time.
    const beforeOld = (await call("/v1/pool")).body.syncedAt;
    await call("/v1/pool", { people: { [P4]: { guilds: [], first: 1, last: 1000 } }, calls: {}, users: {} });
    d = await call(`/v1/pool?since=${beforeOld}`);
    ok("an ancient event pushed just now appears in the delta",
        !!d.body.people[P4], Object.keys(d.body.people).join(","));

    console.log("\n-- a nonsense `since` degrades to a FULL pull, never to a silent hole --");
    for (const bad of ["abc", "-1", "0", "", String(Date.now() + 86400000)]) {
        const r = await call(`/v1/pool?since=${encodeURIComponent(bad)}`);
        ok(`since=${JSON.stringify(bad)} returns everything`,
            Object.keys(r.body.people).length === 4, `${bad} -> ${Object.keys(r.body.people).length}`);
    }

    console.log("\n-- friends are always complete, because omission there is ambiguous --");
    // A retracted friendship LEAVES the union rather than being restamped, so a timestamp
    // filter would stop sending it — indistinguishable from "unchanged".
    await call("/v1/me", { friends: { [P1]: { friends: [F1, F2], guilds: [], at: 10 } }, watching: [], notes: {} });
    const mark = (await call("/v1/pool")).body.syncedAt;
    d = await call(`/v1/pool?since=${mark}`);
    ok("the delta still carries the whole friend graph", !!d.body.friends[P1], JSON.stringify(d.body.friends));
    ok("and says so, so a client can delete what is missing", d.body.friendsComplete === true);

    await call("/v1/me", { friends: { [P1]: { friends: [F1], guilds: [], at: 20 } }, watching: [], notes: {} });
    d = await call(`/v1/pool?since=${mark}`);
    ok("a retraction is visible in a DELTA, not just a full pull",
        !(d.body.friends[P1].friends || []).includes(F2), JSON.stringify(d.body.friends[P1]));

    // Deleting needs a TOMBSTONE, not an omission. A blob can be shared by several
    // accounts, so no single push is the complete set for it — treating an absent key as
    // "delete" would let one account silently wipe another's findings.
    await call("/v1/me", { friends: {}, watching: [], notes: {} });
    d = await call(`/v1/pool?since=${mark}`);
    ok("merely omitting someone does NOT delete them", !!d.body.friends[P1], JSON.stringify(d.body.friends));

    await call("/v1/me", { friends: {}, watching: [], notes: {}, retracted: [P1] });
    d = await call(`/v1/pool?since=${mark}`);
    ok("but an explicit retraction removes them from the delta",
        !d.body.friends[P1], JSON.stringify(d.body.friends));
    const fullAfter = await call("/v1/pool");
    ok("and from a full pull too", !fullAfter.body.friends[P1], JSON.stringify(fullAfter.body.friends));

    console.log("\n-- the delta is dramatically smaller --");
    // Build its own bulk rather than relying on what earlier tests happened to leave:
    // by this point the tombstone cases have emptied the pool, and a delta of nothing is
    // legitimately the same size as a full pull of nothing.
    const bulk = {};
    for (let i = 0; i < 200; i++) bulk[`9100000000000000${String(i).padStart(3, "0")}`] = { guilds: [], first: 1, last: 1000 };
    await call("/v1/pool", { people: bulk, calls: {}, users: {} });
    const full = await call("/v1/pool");
    const fullLen = JSON.stringify(full.body).length;
    // The watermark from that very pull, which is how a client actually gets one. Asking
    // with an arbitrary recent instant instead would only look right because of a bug:
    // these records are stamped `last: 1000`, and a delta that excluded them for that
    // reason would also exclude a genuinely new record that happened to describe an old
    // event. What must be small is the delta for a client that has ALREADY seen the bulk.
    const deltaLen = JSON.stringify((await call(`/v1/pool?since=${full.body.syncedAt}`)).body).length;
    ok(`delta (${deltaLen}b) is a fraction of full (${fullLen}b)`, deltaLen * 10 < fullLen,
        `${deltaLen} vs ${fullLen}`);

    console.log("\n-- chained deltas lose nothing --");
    // walk the watermark forward the way a client does, and check the union of everything
    // received equals the full pull
    let mark2 = (await call("/v1/pool")).body.syncedAt;
    const seen = new Set(Object.keys((await call("/v1/pool")).body.people));
    for (let i = 0; i < 3; i++) {
        const id = `90000000000000001${i}`;
        await call("/v1/pool", { people: person(id, Date.now() + 10000), calls: {}, users: {} });
        const step = await call(`/v1/pool?since=${mark2}`);
        Object.keys(step.body.people).forEach(k => seen.add(k));
        mark2 = step.body.syncedAt;
    }
    const finalFull = await call("/v1/pool");
    ok("everything in the full pull was seen across the deltas",
        Object.keys(finalFull.body.people).every(k => seen.has(k)),
        `missed: ${Object.keys(finalFull.body.people).filter(k => !seen.has(k)).join(",")}`);
} finally {
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
