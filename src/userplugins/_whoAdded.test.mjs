// Extracts the REAL whoAdded() inversion from xicordDossier.tsx and drives it against
// fake proven-friend and guild lookups.
//   node src/userplugins/_whoAdded.test.mjs
//
// What this pins down: the friend sweep stores, per swept person, the friends we can
// PROVE they added (people who are friends with both you and them). whoAdded inverts
// that — "who, among everyone swept, has TARGET added" — which is the whole point of the
// "Find Who Added Them" menu item.
//
// The properties that matter: a person the scanner has not answered for yet is PENDING,
// never "did not add them" (a half-finished sweep must not read as a confident no); the
// target and yourself are never listed; results are deduped and ordered; and — a real
// consequence of how mutual friends are computed — TARGET can only ever appear in
// someone's proven list if TARGET is also YOUR friend, so a non-friend target yields an
// honest empty answer rather than a wrong one.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordDossier.tsx", import.meta.url), "utf8");

/** Comment- and string-aware brace matcher (same approach as the sibling suites). */
function extract(name) {
    const needle = `function ${name}(`;
    let start = SRC.indexOf(needle);
    if (start < 0) throw new Error(`${name} not found`);
    if (SRC.slice(start - 6, start) === "async ") start -= 6;
    // keep an `export` modifier off — we slice from `function`, callers get the raw fn
    let i = SRC.indexOf("{", start + needle.length - 1), depth = 0, mode = "code", prev = "";
    for (; i < SRC.length; i++) {
        const ch = SRC[i], next = SRC[i + 1];
        if (mode === "line") { if (ch === "\n") mode = "code"; }
        else if (mode === "block") { if (ch === "*" && next === "/") { mode = "code"; i++; } }
        else if (mode !== "code") { if (ch === mode && prev !== "\\") mode = "code"; }
        else if (ch === "/" && next === "/") { mode = "line"; i++; }
        else if (ch === "/" && next === "*") { mode = "block"; i++; }
        else if (ch === '"' || ch === "'" || ch === "`") mode = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (!depth) return SRC.slice(start, i + 1); }
        prev = ch;
    }
    throw new Error(`unbalanced ${name}`);
}

const body = [
    extract("sortWhoAddedRows"),
    extract("whoAdded"),
    "return { whoAdded, sortWhoAddedRows };"
].join("\n");

const js = esbuild.transformSync(body, { loader: "ts" }).code;
const { whoAdded } = new Function(js)();

// A world where proven-friend lists are simple sets. `null` means "not scanned yet".
function world(map, guilds = {}) {
    const provenOf = id => (id in map ? (map[id] === null ? null : new Set(map[id])) : null);
    const guildsOf = id => guilds[id] ?? [];
    return { provenOf, guildsOf };
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};
const ids = r => r.rows.map(x => x.id);

console.log("\n-- the inversion: who, among the swept, has TARGET added --");
{
    // a, b added target; c added someone else; d not scanned
    const { provenOf, guildsOf } = world({
        a: ["target", "x"],
        b: ["target"],
        c: ["y"],
        d: null
    });
    const r = whoAdded("target", ["a", "b", "c", "d"], provenOf, guildsOf, "me");
    ok("only the people who added target are listed", ids(r).sort().join() === "a,b", ids(r).join());
    ok("everyone scanned is counted", r.scanned === 3, String(r.scanned));
    ok("the unscanned one is pending, not a 'no'", r.pending === 1, String(r.pending));
    ok("total spans every candidate", r.total === 4, String(r.total));
}

console.log("\n-- a half-finished sweep never reads as a confident nobody --");
{
    const { provenOf, guildsOf } = world({ a: null, b: null, c: null });
    const r = whoAdded("target", ["a", "b", "c"], provenOf, guildsOf, "me");
    ok("nobody answered yet means an empty list", r.rows.length === 0, ids(r).join());
    ok("but all three are pending", r.pending === 3 && r.scanned === 0, JSON.stringify(r));
}

console.log("\n-- the target and yourself are never in their own answer --");
{
    const { provenOf, guildsOf } = world({
        target: ["target", "me"],  // self-referential junk
        me: ["target"],
        a: ["target"]
    });
    const r = whoAdded("target", ["target", "me", "a"], provenOf, guildsOf, "me");
    ok("target is excluded", !ids(r).includes("target"), ids(r).join());
    ok("you are excluded", !ids(r).includes("me"), ids(r).join());
    ok("a real third party remains", ids(r).join() === "a", ids(r).join());
}

console.log("\n-- candidates are deduped --");
{
    const { provenOf, guildsOf } = world({ a: ["target"] });
    const r = whoAdded("target", ["a", "a", "a"], provenOf, guildsOf, "me");
    ok("a repeated id appears once", ids(r).join() === "a", ids(r).join());
    ok("and is counted once", r.total === 1 && r.scanned === 1, JSON.stringify(r));
}

console.log("\n-- rows carry the servers each was seen in, most-servers first --");
{
    const { provenOf, guildsOf } = world(
        { a: ["target"], b: ["target"], c: ["target"] },
        { a: ["g1"], b: ["g1", "g2", "g3"], c: ["g1", "g2"] });
    const r = whoAdded("target", ["a", "b", "c"], provenOf, guildsOf, "me");
    ok("ordered by how many servers they were found in", ids(r).join() === "b,c,a", ids(r).join());
    ok("the guild list rides along", r.rows[0].guilds.join() === "g1,g2,g3", r.rows[0].guilds.join());
}

console.log("\n-- a non-friend target yields an HONEST empty answer --");
{
    // target is nobody's proven friend because target is not on your friends list, so no
    // mutual computation ever contains them. The function cannot know that directly, but
    // the data reflects it, and whoAdded reports empty rather than inventing anyone.
    const { provenOf, guildsOf } = world({ a: ["x"], b: ["y"], c: ["z"] });
    const r = whoAdded("target", ["a", "b", "c"], provenOf, guildsOf, "me");
    ok("nobody is listed", r.rows.length === 0, ids(r).join());
    ok("yet the sweep is fully accounted for", r.scanned === 3 && r.pending === 0, JSON.stringify(r));
}

console.log("\n-- empty and degenerate inputs do not throw --");
{
    const { provenOf, guildsOf } = world({});
    const r = whoAdded("target", [], provenOf, guildsOf, "me");
    ok("no candidates is a clean zero", r.total === 0 && r.rows.length === 0, JSON.stringify(r));
    const r2 = whoAdded("target", ["", null, undefined, "a"], provenOf, guildsOf, "me");
    ok("blank/nullish candidate ids are skipped", r2.total === 1, JSON.stringify(r2));
}

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
