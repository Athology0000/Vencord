// Exercises the REAL snapshot-resolution functions from xicord-dashboard-server.js
// against a throwaway settings folder.
//   node xicord-dashboard-server.test.mjs
//
// The snapshot used to be a field inside Vencord's settings.json, where it grew past
// 2MB and made Vencord rewrite the whole file for every unrelated setting change
// anywhere in the client. It now lives in its own xicord-cache.json beside it. The
// server has to read the new file, still fall back to the old field (older plugin
// build, or the web build which has no main process to write files with), and survive
// either one being missing or corrupt.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as fsMod from "fs";
import * as pathMod from "path";
import { join } from "path";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const xcrypto = require_("./xicord-crypto.js");

const SRC = readFileSync(new URL("./xicord-dashboard-server.js", import.meta.url), "utf8");

// Lift the pure resolution helpers out of the server and inject a fake settingsPath()
const body = SRC.slice(SRC.indexOf("function snapshotFilePath()"), SRC.indexOf("function serve("));
if (!body.includes("readSnapshot")) throw new Error("could not extract the resolution helpers");

const root = mkdtempSync(join(tmpdir(), "xicord-srv-"));
const dir = join(root, "Vencord", "settings");
mkdirSync(dir, { recursive: true });
const SETTINGS = join(dir, "settings.json");
const SNAP = join(dir, "xicord-cache.json");

const build = new Function("fs", "path", "settingsPath", "xcrypto",
    `${body}; return { readSnapshot, readSnapshotFile, readSnapshotFromSettings, snapshotFilePath, decryptSnapshot, keyFilePath };`);
const api = build(fsMod, pathMod, () => (existsSync(SETTINGS) ? SETTINGS : null), xcrypto);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};
const settingsWith = snapshot => writeFileSync(SETTINGS, JSON.stringify({ plugins: { "Xicord Cache": { snapshot } } }));
const snap = from => JSON.stringify({ xicordCache: 1, from });
const read = () => { try { return JSON.parse(api.readSnapshot()); } catch (e) { return { parseError: e.message }; } };

console.log("\n-- where the dashboard reads its data from --");
settingsWith("");
ok("nothing anywhere -> says so instead of crashing",
    read().empty === true && /No snapshot yet/.test(read().reason), JSON.stringify(read()));

settingsWith(snap("legacy"));
ok("an older plugin build still works off settings.json", read().from === "legacy", JSON.stringify(read()).slice(0, 80));

writeFileSync(SNAP, snap("file"));
ok("the dedicated file wins while both exist", read().from === "file", JSON.stringify(read()).slice(0, 80));

settingsWith("");
ok("and keeps working once the legacy copy is cleared", read().from === "file", JSON.stringify(read()).slice(0, 80));

console.log("\n-- it must not break on a half-written or damaged file --");
// the snapshot is written atomically (temp file + rename), but a truncated leftover
// from an older build, or a wiped file, must not take the dashboard down
writeFileSync(SNAP, "");
settingsWith(snap("legacy"));
ok("an empty snapshot file falls back rather than serving nothing", read().from === "legacy", JSON.stringify(read()).slice(0, 80));

writeFileSync(SNAP, snap("file"));
writeFileSync(SETTINGS, "{ not json at all");
ok("a corrupt settings.json cannot stop the snapshot file being served", read().from === "file", JSON.stringify(read()).slice(0, 80));

writeFileSync(SNAP, "{ truncated json");
ok("a truncated snapshot file is still served verbatim (the page reports the parse error)",
    api.readSnapshotFile() === "{ truncated json", String(api.readSnapshotFile()));

console.log("\n-- the file is looked for next to settings.json --");
rmSync(SNAP, { force: true });
settingsWith("");
ok("path is derived from the settings location",
    api.snapshotFilePath() === SNAP, `${api.snapshotFilePath()} vs ${SNAP}`);

console.log("\n-- the dashboard's full-dossier graph builder --");
// The everyone-view the plugin hands off to. Same rules as the in-Discord version:
// each pair counted once, you left out, and the edges thinned so a dense friend group
// doesn't become a solid block of colour.
{
    const HTML = readFileSync(new URL("./xicord-dashboard.html", import.meta.url), "utf8");
    const start = HTML.indexOf("function fullGraphData(");
    if (start < 0) throw new Error("fullGraphData not found in the dashboard");
    let i = HTML.indexOf("{", start), depth = 0, end = -1;
    for (; i < HTML.length; i++) {
        if (HTML[i] === "{") depth++;
        else if (HTML[i] === "}") { depth--; if (!depth) { end = i + 1; break; } }
    }
    const fn = HTML.slice(start, end);
    const perNode = /FULL_LINKS_PER_NODE\s*=\s*(\d+)/.exec(HTML)[1];
    let cache = null;
    const build = new Function("getCache", `var FULL_LINKS_PER_NODE=${perNode};
        Object.defineProperty(this,'cache',{get:getCache});
        ${fn}; return fullGraphData;`);
    const fullGraphData = build(() => cache);

    const prof = comps => ({
        companions: Object.fromEntries(Object.entries(comps).map(([k, v]) => [k, { count: v, ms: 1000 * v }]))
    });

    cache = { self: { id: "ME" } };
    let g = fullGraphData({
        ME: prof({ a: 9, b: 9, c: 9 }),
        a: prof({ ME: 9, b: 2 }),
        b: prof({ ME: 9, a: 2, c: 1 }),
        c: prof({ ME: 9, b: 1 })
    }, 300);
    ok("your own account is left out of the web", !g.ids.includes("ME"), g.ids.join(","));
    ok("everyone else is drawn", g.ids.slice().sort().join(",") === "a,b,c", g.ids.join(","));
    ok("no edge touches you", g.links.every(l => g.ids[l.a] !== "ME" && g.ids[l.b] !== "ME"));
    ok("a pair recorded by both people is counted once",
        g.links.filter(l => [g.ids[l.a], g.ids[l.b]].sort().join("-") === "a-b").length === 1,
        JSON.stringify(g.links.map(l => [g.ids[l.a], g.ids[l.b]].sort().join("-"))));
    ok("the stronger of two records of a pair wins",
        g.links.find(l => [g.ids[l.a], g.ids[l.b]].sort().join("-") === "a-b").w === 2);

    // dense group: edges must be thinned, not left to grow with the square of the size
    const dense = {};
    for (let x = 0; x < 60; x++) {
        const comps = {};
        for (let y = 0; y < 60; y++) if (y !== x) comps["d" + y] = 1 + ((x + y) % 5);
        dense["d" + x] = prof(comps);
    }
    cache = { self: { id: "nobody" } };
    g = fullGraphData(dense, 300);
    ok(`a 60-person clique is thinned (${g.links.length} edges, not 1770)`,
        g.links.length <= g.ids.length * 8, `${g.links.length} for ${g.ids.length} nodes`);
    ok("nobody is stranded without an edge",
        new Set(g.links.flatMap(l => [l.a, l.b])).size === g.ids.length,
        `${new Set(g.links.flatMap(l => [l.a, l.b])).size}/${g.ids.length}`);
    ok("the node cap is honoured", fullGraphData(dense, 25).ids.length === 25);
    ok("it reports the true total so the UI can say 'N of M'", g.total === 60, String(g.total));
    ok("all link indices are in range", g.links.every(l => g.ids[l.a] && g.ids[l.b]));

    cache = { self: { id: "ME" } };
    ok("no dossiers -> empty, not a crash", fullGraphData({}, 300).ids.length === 0);
}

// The snapshot is written by Discord's main process and read by this separate Node
// process, so "can the reader open what the writer sealed" is the whole question — and
// it can only be answered against a real DPAPI key, not a stub.
console.log("\n-- reading an encrypted snapshot --");
const KEYF = join(dir, "xicord-key.bin");
const realKey = xcrypto.getKey(KEYF);
if (!realKey) {
    console.log("  (no DPAPI on this platform — the encrypted paths cannot be exercised here)");
} else {
    const secret = JSON.stringify({ xicordCache: 1, from: "sealed", users: { u1: { username: "mara" } } });
    writeFileSync(SNAP, xcrypto.seal(secret, realKey));
    settingsWith("");

    ok("the file on disk really is encrypted",
        readFileSync(SNAP, "utf8").indexOf("mara") < 0 && xcrypto.isSealed(readFileSync(SNAP, "utf8")));
    ok("the server serves it decrypted", read().from === "sealed", JSON.stringify(read()).slice(0, 120));
    ok("and the payload is intact", read().users.u1.username === "mara");

    console.log("\n-- an unopenable snapshot must explain itself, not serve junk --");
    // What a user hits if they sign in as a different Windows account, or restore the
    // data folder onto another machine: the file is fine, the key simply is not theirs.
    writeFileSync(SNAP, xcrypto.seal(secret, Buffer.alloc(32, 9)));
    const r = read();
    ok("it reports empty rather than crashing the page", r.empty === true, JSON.stringify(r).slice(0, 100));
    ok("and says why, in terms a person can act on",
        /encrypted/.test(r.reason) && /Windows user/.test(r.reason), r.reason);
    ok("it does not leak ciphertext into the page", !/XIC1/.test(JSON.stringify(r)));

    console.log("\n-- an older, unencrypted snapshot still works --");
    // Upgrading must not strand anyone: the first sealed write is what migrates a file.
    writeFileSync(SNAP, snap("plain"));
    ok("plaintext is served untouched", read().from === "plain", JSON.stringify(read()));
    ok("a legacy settings.json copy is still read too", (() => {
        rmSync(SNAP, { force: true });
        settingsWith(snap("legacy"));
        return read().from === "legacy";
    })());
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
