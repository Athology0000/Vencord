// Extracts the REAL syncMutualTraitAll() from xicordMutuals.tsx (brace-matched, so
// it can't drift from shipped code) and checks the properties the Target/Mutuals
// merge depends on: one write per reconcile, never clobbering the Target trait.
//   node src/userplugins/_mutualsTarget.test.mjs
import { readFileSync } from "fs";

const SRC = readFileSync(new URL("./xicordMutuals.tsx", import.meta.url), "utf8");

function extract(name) {
    const start = SRC.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    let i = SRC.indexOf("{", start), depth = 0, inStr = null, prev = "";
    for (; i < SRC.length; i++) {
        const ch = SRC[i];
        if (inStr) { if (ch === inStr && prev !== "\\") inStr = null; }
        else if (ch === '"' || ch === "'" || ch === "`") inStr = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (!depth) return SRC.slice(start, i + 1); }
        prev = ch;
    }
    throw new Error(`unbalanced ${name}`);
}

const MUTUAL_TRAIT = "Mutual";
let store = [];          // the Traits `tasks` array
let corrupt = false;
let writes = 0;

const readTraits = () => corrupt ? null : JSON.parse(JSON.stringify(store));
const writeTraits = data => { writes++; store = JSON.parse(JSON.stringify(data)); };
const results = new Map();
let matched = new Set();
const getMatched = id => matched.has(id) ? ["someone"] : [];

const build = new Function("readTraits", "writeTraits", "results", "getMatched", "MUTUAL_TRAIT", "console",
    `${extract("syncMutualTraitAll")}; return syncMutualTraitAll;`);
const syncMutualTraitAll = build(readTraits, writeTraits, results, getMatched, MUTUAL_TRAIT, console);

let pass = 0, fail = 0;
const eq = (name, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}\n          got  ${g}\n          want ${w}`); }
};
const mutual = () => store.find(t => t.name === MUTUAL_TRAIT);
const target = () => store.find(t => t.name === "Target");
const setup = (traits, ids, match) => {
    store = JSON.parse(JSON.stringify(traits));
    results.clear(); ids.forEach(id => results.set(id, {}));
    matched = new Set(match); writes = 0; corrupt = false;
};

console.log("\n-- one write rebuilds the whole trait --");
setup([{ name: "Target", url: "", users: "/t1/t2" }], ["a", "b", "c", "d"], ["a", "c"]);
syncMutualTraitAll();
eq("exactly one settings write", writes, 1);
eq("only matched users are in the Mutual trait", mutual().users, "/a/c");
eq("it is flagged managed", mutual().managed, true);
eq("the Target trait is untouched", target(), { name: "Target", url: "", users: "/t1/t2" });

console.log("\n-- idempotent: no write when already correct --");
writes = 0;
syncMutualTraitAll();
eq("second reconcile writes nothing", writes, 0);
eq("...and changes nothing", mutual().users, "/a/c");

console.log("\n-- removals are handled in the same single write --");
matched = new Set(["c"]); writes = 0;
syncMutualTraitAll();
eq("one write to drop a user", writes, 1);
eq("dropped user is gone", mutual().users, "/c");
matched = new Set(); writes = 0;
syncMutualTraitAll();
eq("clearing everyone is one write", writes, 1);
eq("trait emptied, not deleted", mutual().users, "");

console.log("\n-- a hand-made Mutual trait is never touched --");
setup([{ name: "Target", url: "", users: "/t1" }, { name: "Mutual", url: "mine.mp3", users: "/keep" }], ["a"], ["a"]);
syncMutualTraitAll();
eq("no write against an unmanaged trait", writes, 0);
eq("hand-made members preserved", mutual().users, "/keep");
eq("hand-made audio preserved", mutual().url, "mine.mp3");

console.log("\n-- corrupt settings must not wipe the Target trait --");
setup([{ name: "Target", url: "", users: "/t1/t2" }], ["a"], ["a"]);
corrupt = true;
syncMutualTraitAll();
eq("no write when traits are unreadable", writes, 0);
eq("Target trait survives intact", target().users, "/t1/t2");

console.log("\n-- nothing matched and no trait yet: stays absent --");
setup([{ name: "Target", url: "", users: "/t1" }], ["a", "b"], []);
syncMutualTraitAll();
eq("no empty Mutual trait created", writes, 0);
eq("trait list unchanged", store.length, 1);

console.log("\n-- other plugins' traits and extra fields survive --");
setup([
    { name: "Friend", url: "f.mp3", users: "/9", note: { by: "me" } },
    { name: "Target", url: "", users: "/t1" }
], ["a"], ["a"]);
syncMutualTraitAll();
eq("unrelated trait untouched", store[0], { name: "Friend", url: "f.mp3", users: "/9", note: { by: "me" } });
eq("Target untouched", store[1], { name: "Target", url: "", users: "/t1" });
eq("Mutual appended last", store[2].name, MUTUAL_TRAIT);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
