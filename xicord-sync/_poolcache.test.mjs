// Exercises the pooled-view cache against a REAL server instance.
//   node xicord-sync/_poolcache.test.mjs
//
// Why this exists: /v1/pool re-read every slice, re-merged the lot and re-serialised it on
// every pull. At 11k people and 113k call pairs that is tens of megabytes of parsing per
// request, and clients poll it — two overlapping pulls exhausted the container, the
// platform killed it, and it came back to the same load. A crash loop, with every request
// timing out at 15s.
//
// Caching a merged view trades one failure for another though: serving data that is no
// longer true. So the tests that matter are the invalidation ones — a push must be visible
// on the very next pull, with no sleep and no TTL wait.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";

const OWNER = "1400000000000000001";
const P1 = "900000000000000001", P2 = "900000000000000002";
const F1 = "800000000000000001", F2 = "800000000000000002";

const dir = mkdtempSync(join(tmpdir(), "xicord-cache-"));
mkdirSync(join(dir, "auth"), { recursive: true });
writeFileSync(join(dir, "auth", "tokens.json"), JSON.stringify({ tok: { user: OWNER, at: 1 } }));

const PORT = 8903;
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

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? "\n          " + extra : ""}`); } };

try {
    if (!await until(async () => (await fetch(base + "/v1/health")).ok)) throw new Error("no server:\n" + log);

    console.log("\n-- a push is visible on the very next pull --");
    // The whole risk of caching, in one assertion. No sleep: if this needs the TTL to
    // expire, invalidation is broken.
    await call("/v1/pool", { people: { [P1]: { guilds: [], first: 1, last: 2 } }, calls: {}, users: {} });
    let a = await call("/v1/pool");
    ok("the pushed person is in the pull", !!a.body.people[P1], Object.keys(a.body.people).join(","));

    await call("/v1/pool", { people: { [P2]: { guilds: [], first: 1, last: 2 } }, calls: {}, users: {} });
    a = await call("/v1/pool");
    ok("and so is the next one, immediately", !!a.body.people[P2], Object.keys(a.body.people).join(","));

    console.log("\n-- a private push invalidates it too --");
    // the friend graph is merged from the user blobs, so /v1/me writes change /v1/pool
    await call("/v1/me", { friends: { [P1]: { friends: [F1], guilds: [], at: 5 } }, watching: [], notes: {} });
    a = await call("/v1/pool");
    ok("the friend finding appears at once", !!a.body.friends[P1], JSON.stringify(Object.keys(a.body.friends || {})));
    await call("/v1/me", { friends: { [P1]: { friends: [F1, F2], guilds: [], at: 6 } }, watching: [], notes: {} });
    a = await call("/v1/pool");
    ok("and an update to it does too",
        (a.body.friends[P1].friends || []).length === 2, JSON.stringify(a.body.friends[P1]));

    console.log("\n-- a retraction is not masked by the cache --");
    // the failure that would be worst: a name that has been withdrawn still being served
    await call("/v1/me", { friends: { [P1]: { friends: [F1], guilds: [], at: 9 } }, watching: [], notes: {} });
    a = await call("/v1/pool");
    ok("the withdrawn name is gone from the very next pull",
        !(a.body.friends[P1].friends || []).includes(F2), JSON.stringify(a.body.friends[P1]));

    console.log("\n-- repeated pulls are consistent --");
    const one = await call("/v1/pool");
    const two = await call("/v1/pool");
    ok("two pulls with no write between agree",
        JSON.stringify(one.body.people) === JSON.stringify(two.body.people));
    ok("the counts agree too", JSON.stringify(one.body.counts) === JSON.stringify(two.body.counts),
        JSON.stringify([one.body.counts, two.body.counts]));

    console.log("\n-- a burst of concurrent pulls is served once and correctly --");
    // This is the shape of the original crash: overlapping pulls each merging the world.
    const burst = await Promise.all(Array.from({ length: 12 }, () => call("/v1/pool")));
    ok("every one of them succeeded", burst.every(r => r.status === 200),
        burst.map(r => r.status).join(","));
    ok("and they all agree",
        new Set(burst.map(r => JSON.stringify(r.body.counts))).size === 1,
        JSON.stringify([...new Set(burst.map(r => JSON.stringify(r.body.counts)))]));

    console.log("\n-- a push during a burst still lands --");
    const [, ...rest] = await Promise.all([
        call("/v1/pool", { people: { "900000000000000009": { guilds: [], first: 1, last: 2 } }, calls: {}, users: {} }),
        ...Array.from({ length: 6 }, () => call("/v1/pool")),
    ]);
    ok("the burst did not error", rest.every(r => r.status === 200));
    const after = await call("/v1/pool");
    ok("and the write is visible afterwards", !!after.body.people["900000000000000009"],
        Object.keys(after.body.people).join(","));
} finally {
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
