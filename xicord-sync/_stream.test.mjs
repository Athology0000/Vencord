// Exercises the FULL pull against a real server instance — that it is well-formed, whole,
// and agrees with the delta path.
//   node xicord-sync/_stream.test.mjs
//
// Written for a streamed implementation that has since been reverted. Streaming looked
// obviously right — never hold 49MB — and measured 14x worse on the wire, because the
// platform's edge only gzips buffered responses and does not forward `gzip` in
// Accept-Encoding to the origin: 51MB in 9s streamed against 3.6MB in 1.2s buffered. The
// OOM it was meant to prevent came from re-merging per REQUEST, which one shared cached
// string already fixed.
//
// The suite outlived the implementation because none of it was about streaming: it checks
// that a full pull parses, survives quotes and unicode, holds every record, stays whole
// under concurrent requests and a concurrent write, and matches what the delta path says.
// Those are properties of the response, whoever builds it.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";

const OWNER = "1400000000000000001";
const dir = mkdtempSync(join(tmpdir(), "xicord-stream-"));
mkdirSync(join(dir, "auth"), { recursive: true });
writeFileSync(join(dir, "auth", "tokens.json"), JSON.stringify({ tok: { user: OWNER, at: 1 } }));

const PORT = 8907;
const srv = spawn(process.execPath, ["server.js"], {
    cwd: "C:/Users/aeare/Desktop/Vencord/xicord-sync",
    env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), XICORD_TOKENS: "", XICORD_ALIASES: "", XICORD_POOL_MIN_MS: "0" },
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
    const text = await res.text();
    return { status: res.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};
const until = async fn => {
    for (let i = 0; i < 60; i++) { try { if (await fn()) return true; } catch { } await new Promise(r => setTimeout(r, 200)); }
    return false;
};

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? "\n          " + extra : ""}`); } };

try {
    if (!await until(async () => (await fetch(base + "/v1/health")).ok)) throw new Error("no server:\n" + log);

    console.log("\n-- an empty pool still streams valid JSON --");
    // the easiest shape to get wrong: every map empty, and the comma placement with it
    let r = await call("/v1/pool");
    ok("it parses", r.body !== null, r.text.slice(0, 120));
    ok("with all four sections present",
        !!r.body.people && !!r.body.calls && !!r.body.users && !!r.body.friends,
        Object.keys(r.body || {}).join(","));
    ok("and the trailing scalars", r.body.syncedAt > 0 && r.body.friendsComplete === true,
        JSON.stringify(r.body.counts));

    console.log("\n-- with real content --");
    const people = {}, calls = {}, users = {};
    for (let i = 0; i < 250; i++) {
        const id = `9000000000000000${String(i).padStart(3, "0")}`;
        people[id] = { guilds: ["800000000000000001"], first: 1, last: 1000 + i };
        users[id] = { username: `user "${i}" \\ ~ ünïcødé 😀`, avatar: "https://x/y.png", at: 5 };
        if (i) calls[`9000000000000000000|${id}`] = { ms: i, count: i, last: 1000 + i, guilds: [] };
    }
    await call("/v1/pool", { people, calls, users });
    await call("/v1/me", { friends: { "900000000000000001": { friends: ["800000000000000002"], guilds: [], at: 9 } }, watching: [], notes: {} });

    r = await call("/v1/pool");
    ok("a populated stream parses", r.body !== null, r.text.slice(0, 200));
    ok("every person survives", Object.keys(r.body.people).length === 250, String(Object.keys(r.body.people).length));
    ok("every call survives", Object.keys(r.body.calls).length === 249, String(Object.keys(r.body.calls).length));
    ok("the friend graph rides along", Object.keys(r.body.friends).length === 1, JSON.stringify(r.body.friends));
    ok("counts match what was actually written",
        r.body.counts.people === 250 && r.body.counts.calls === 249, JSON.stringify(r.body.counts));

    console.log("\n-- quotes, backslashes and unicode survive the hand-rolled encoding --");
    // the classic hand-rolled-JSON bug: a name with a quote in it splitting the document
    const one = r.body.users["9000000000000000007"];
    ok("a username with quotes and a backslash is intact",
        one && one.username === 'user "7" \\ ~ ünïcødé 😀', JSON.stringify(one));
    ok("no key was mangled", Object.keys(r.body.people).every(k => /^\d+$/.test(k)));

    console.log("\n-- the streamed full pull agrees with the built delta --");
    // since=1 asks for everything with a timestamp above 1, i.e. the same content, built
    // the ordinary way. The two paths must not disagree.
    const d = await call("/v1/pool?since=1");
    ok("the delta path returns the same people",
        JSON.stringify(Object.keys(d.body.people).sort()) === JSON.stringify(Object.keys(r.body.people).sort()));
    ok("and the same calls",
        JSON.stringify(Object.keys(d.body.calls).sort()) === JSON.stringify(Object.keys(r.body.calls).sort()));
    ok("and the same friends", JSON.stringify(d.body.friends) === JSON.stringify(r.body.friends));
    ok("both are flagged friendsComplete", d.body.friendsComplete === true && r.body.friendsComplete === true);

    console.log("\n-- concurrent full pulls all come back whole --");
    // the original crash shape: several full pulls at once
    const burst = await Promise.all(Array.from({ length: 8 }, () => call("/v1/pool")));
    ok("all succeeded", burst.every(x => x.status === 200), burst.map(x => x.status).join(","));
    ok("all parsed", burst.every(x => x.body !== null));
    ok("all identical in size", new Set(burst.map(x => Object.keys(x.body.people).length)).size === 1,
        JSON.stringify(burst.map(x => Object.keys(x.body.people).length)));

    console.log("\n-- a write during a stream does not corrupt it --");
    const [streamed] = await Promise.all([
        call("/v1/pool"),
        call("/v1/pool", { people: { "900000000000000999": { guilds: [], first: 1, last: 9999 } }, calls: {}, users: {} }),
    ]);
    ok("the concurrent stream is still valid JSON", streamed.body !== null, streamed.text.slice(0, 160));
    const after = await call("/v1/pool");
    ok("and the write landed", !!after.body.people["900000000000000999"]);
} finally {
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
