// Proves the account binding the production service is configured for: two Discord
// accounts writing into ONE blob, and a third keeping its own.
//   node xicord-sync/_aliasing.test.mjs
//
// XICORD_ALIASES attaches account ids to a NAMED BLOB. Neither account owns the store:
// pointing one account at another made whichever was named the owner and the other a
// tenant, so the identity of the data depended on setup order. A blob named `lab-a` is its
// own thing, and an account can be swapped out without the store changing hands.
//
// The friend graph is what makes this matter: accounts on one blob pool their lenses into
// a single slice, while a genuinely separate blob must stay separate — that separation is
// the control arm of the experiment, and silently merging it would destroy the result
// rather than fail loudly.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";

const ACC_A = "1239350611800231956";   // ghostphantom1
const ACC_B = "1131085517967081544";   // 4has — same person, same blob
const ACC_C = "1400000000000000009";   // the third account, its own blob
const BLOB_1 = "lab-a";                // the blob both of the first two attach to
const BLOB_2 = "lab-b";                // the third account's own blob

const dir = mkdtempSync(join(tmpdir(), "xicord-alias-"));
mkdirSync(join(dir, "auth"), { recursive: true });
writeFileSync(join(dir, "auth", "tokens.json"), JSON.stringify({
    tokA: { user: ACC_A, at: 1 },
    tokB: { user: ACC_B, at: 1 },
    tokC: { user: ACC_C, at: 1 },
}));

const PORT = 8901;
const srv = spawn(process.execPath, ["server.js"], {
    cwd: "C:/Users/aeare/Desktop/Vencord/xicord-sync",
    env: {
        ...process.env, DATA_DIR: dir, PORT: String(PORT), XICORD_TOKENS: "",
        // both accounts attach to one named blob; the third gets its own
        XICORD_ALIASES: `${ACC_A}=${BLOB_1},${ACC_B}=${BLOB_1},${ACC_C}=${BLOB_2}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
srv.stdout.on("data", d => { log += d; });
srv.stderr.on("data", d => { log += d; });

const base = `http://127.0.0.1:${PORT}`;
const call = async (token, path, body) => {
    const res = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
};
const until = async fn => {
    for (let i = 0; i < 60; i++) {
        try { if (await fn()) return true; } catch { }
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
};

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? "\n          " + extra : ""}`); } };
const P1 = "900000000000000001", P2 = "900000000000000002", P3 = "900000000000000003";
const F1 = "800000000000000001", F2 = "800000000000000002", F3 = "800000000000000003";

try {
    if (!await until(async () => (await fetch(base + "/v1/health")).ok)) throw new Error("server never came up:\n" + log);

    console.log("\n-- both accounts resolve to the BLOB, not to each other --");
    let a = await call("tokA", "/v1/me");
    let b = await call("tokB", "/v1/me");
    ok("the first account reports the blob", a.body.user === BLOB_1, a.body.user);
    ok("the second reports the same blob", b.body.user === BLOB_1, b.body.user);
    ok("neither account is reported as owning the other",
        a.body.user !== ACC_A && a.body.user !== ACC_B, a.body.user);
    let c = await call("tokC", "/v1/me");
    ok("the third account is on its own blob", c.body.user === BLOB_2, c.body.user);

    console.log("\n-- so their friend findings land in the same blob --");
    await call("tokA", "/v1/me", { friends: { [P1]: { friends: [F1], guilds: [], at: 10 } }, watching: [], notes: {} });
    await call("tokB", "/v1/me", { friends: { [P2]: { friends: [F2], guilds: [], at: 20 } }, watching: [], notes: {} });
    a = await call("tokA", "/v1/me");
    ok("the first account sees what the second pushed",
        Object.keys(a.body.friends).sort().join(",") === [P1, P2].sort().join(","), Object.keys(a.body.friends).join(","));
    b = await call("tokB", "/v1/me");
    ok("and the second sees the same blob back", JSON.stringify(b.body.friends) === JSON.stringify(a.body.friends));

    console.log("\n-- while the third account stays genuinely separate --");
    await call("tokC", "/v1/me", { friends: { [P3]: { friends: [F3], guilds: [], at: 30 } }, watching: [], notes: {} });
    c = await call("tokC", "/v1/me");
    ok("its blob holds only its own finding", Object.keys(c.body.friends).join(",") === P3, Object.keys(c.body.friends).join(","));
    a = await call("tokA", "/v1/me");
    ok("and the shared blob is untouched by it",
        !Object.keys(a.body.friends).includes(P3), Object.keys(a.body.friends).join(","));

    console.log("\n-- on disk that is two blobs, not three --");
    const files = readdirSync(join(dir, "users")).filter(f => f.endsWith(".json")).sort();
    ok("exactly two private blobs exist", files.length === 2, files.join(","));
    ok("named for the BLOBS, never for any Discord account",
        files.includes(`${BLOB_1}.json`) && files.includes(`${BLOB_2}.json`)
        && !files.some(f => f.startsWith(ACC_A) || f.startsWith(ACC_B) || f.startsWith(ACC_C)),
        files.join(","));

    console.log("\n-- and all three still pool into one shared friend graph --");
    const pool = await call("tokC", "/v1/pool");
    const ids = Object.keys(pool.body.friends || {}).sort();
    ok("every finding from both blobs is in the union",
        ids.join(",") === [P1, P2, P3].sort().join(","), ids.join(","));
    ok("the separation is about ownership, not visibility", pool.body.counts.friends === 3, JSON.stringify(pool.body.counts));

    console.log("\n-- pool slices follow the same binding --");
    await call("tokB", "/v1/pool", { people: { [P1]: { guilds: [], first: 1, last: 2 } }, calls: {}, users: {} });
    const poolFiles = readdirSync(join(dir, "pool")).filter(f => f.endsWith(".json"));
    ok("call data lands under the blob's slice too",
        poolFiles.includes(`${BLOB_1}.json`) && !poolFiles.some(f => f.startsWith(ACC_B)), poolFiles.join(","));
    console.log("\n-- the blob reports which accounts are attached to it --");
    // The binding lived only in an env var, so a mis-typed id was invisible from the client
    // it affected. Reporting it back is what makes a wrong setup findable.
    a = await call("tokA", "/v1/me");
    ok("the blob names itself", a.body.blob === BLOB_1, a.body.blob);
    ok("and lists BOTH attached accounts",
        (a.body.accounts || []).sort().join(",") === [ACC_A, ACC_B].sort().join(","),
        JSON.stringify(a.body.accounts));
    ok("the same answer from the other account", (await call("tokB", "/v1/me")).body.blob === BLOB_1);
    c = await call("tokC", "/v1/me");
    ok("a separate blob lists only its own account",
        (c.body.accounts || []).join(",") === ACC_C, JSON.stringify(c.body.accounts));
    ok("a rename entry is plumbing, not a member",
        !(a.body.accounts || []).some(x => !/^\d+$/.test(x)), JSON.stringify(a.body.accounts));
    ok("`user` still answers, so existing clients keep working", a.body.user === BLOB_1, a.body.user);
} finally {
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
}

console.log("\n-- a blob name is a FILENAME, so it is validated not sanitised --");
// Until now every owner was a snowflake, so joining it onto a directory could not escape
// it. Blob names come from an env var, and "../../x" would write wherever it liked.
const { storageKeyProbe } = await import("./_storagekey.mjs");
for (const bad of ["../escape", "a/b", "..", ".", "", "with space", "x".repeat(40), "a.json", "\\unc"]) {
    ok(`refused: ${JSON.stringify(bad)}`, storageKeyProbe(bad) === null, String(storageKeyProbe(bad)));
}
for (const good of ["lab-a", "lab_b", "Lab1", "1239350611800231956", "a"]) {
    ok(`accepted: ${JSON.stringify(good)}`, storageKeyProbe(good) === good, String(storageKeyProbe(good)));
}
ok("a non-string is refused", storageKeyProbe(null) === null && storageKeyProbe(7) === null);


console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
