// Extracts the REAL recomputeTracked() from xicordDossier.tsx (brace-matched, then
// TS-stripped with esbuild) and exercises the propagation walk.
//   node src/userplugins/_dossierPropagate.test.mjs
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordDossier.tsx", import.meta.url), "utf8");

// Comment- and string-aware brace matcher: an apostrophe inside a `// don't`
// comment would otherwise look like a string and swallow the rest of the file.
function extract(name) {
    const start = SRC.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    let i = SRC.indexOf("{", start), depth = 0, mode = "code", prev = "";
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

const js = esbuild.transformSync(extract("recomputeTracked"), { loader: "ts" }).code;

let profiles = {};
let targets = [];
const settings = { store: { propagate: true, maxTracked: 150 } };
const WatchAPI = { list: () => targets.slice() };
const UserStore = { getCurrentUser: () => ({ id: "ME" }) };

const build = new Function("settings", "WatchAPI", "UserStore", "getProfiles",
    `let profiles, tracked=new Set(), trackedDirty=true;
     ${js}
     return function(p){ profiles=p; recomputeTracked(); return tracked; };`);
const run = build(settings, WatchAPI, UserStore, () => profiles);
const tracked = () => [...run(profiles)];

let pass = 0, fail = 0;
const eq = (name, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}\n          got  ${g}\n          want ${w}`); }
};
// graph helper: who(id) called with [ [id, count], ... ]
const graph = spec => {
    profiles = {};
    for (const [id, comps] of Object.entries(spec)) {
        profiles[id] = { companions: {}, guilds: {}, updated: 0, firstSeen: 0 };
        for (const [c, count] of Object.entries(comps)) profiles[id].companions[c] = { count, ms: 0, last: 0 };
    }
};

console.log("\n-- propagation off: only the real targets --");
settings.store.propagate = false;
targets = ["A"];
graph({ A: { B: 5, C: 3 } });
eq("just the target", tracked(), ["A"]);

console.log("\n-- one hop --");
settings.store.propagate = true;
eq("target plus everyone it called with", tracked().sort(), ["A", "B", "C"]);

console.log("\n-- keeps spreading, hop after hop --");
graph({ A: { B: 5 }, B: { D: 4 }, D: { E: 3 }, E: { F: 2 } });
eq("reaches the far end of the chain", tracked().sort(), ["A", "B", "D", "E", "F"]);

console.log("\n-- cycles terminate --");
graph({ A: { B: 5 }, B: { A: 5, C: 4 }, C: { B: 4 } });
eq("A<->B<->C resolves without looping", tracked().sort(), ["A", "B", "C"]);

console.log("\n-- the cap bounds it, targets first --");
graph({ A: { B: 9, C: 8, D: 7, E: 6 }, B: { F: 5 }, C: { G: 4 } });
settings.store.maxTracked = 3;
const capped = tracked();
eq("exactly the cap", capped.length, 3);
eq("the target is never dropped", capped[0], "A");
eq("strongest call-links win the remaining slots", capped.slice(1).sort(), ["B", "C"]);

console.log("\n-- nearer hops beat stronger distant ones --");
graph({ A: { B: 1 }, B: { Z: 99 } });
settings.store.maxTracked = 2;
eq("hop-1 B beats hop-2 Z despite Z's higher count", tracked().sort(), ["A", "B"]);

console.log("\n-- several targets --");
settings.store.maxTracked = 150;
targets = ["A", "X"];
graph({ A: { B: 5 }, X: { Y: 5 } });
eq("both trees are walked", tracked().sort(), ["A", "B", "X", "Y"]);

console.log("\n-- you are never tracked, even if you show up in calls --");
targets = ["A"];
graph({ A: { ME: 20, B: 5 } });
eq("self excluded", tracked().sort(), ["A", "B"]);
targets = ["ME", "A"];
graph({ A: { B: 1 } });
eq("self excluded even as a target", tracked().sort(), ["A", "B"]);

console.log("\n-- targets alone can fill the cap --");
targets = ["A", "B", "C", "D"];
graph({ A: { Z: 9 } });
settings.store.maxTracked = 2;
eq("cap applies to targets too", tracked(), ["A", "B"]);

console.log("\n-- degenerate input --");
settings.store.maxTracked = 150;
targets = [];
graph({ A: { B: 1 } });
eq("no targets, nothing tracked", tracked(), []);
targets = ["A"];
profiles = {};
eq("no recorded calls yet, just the target", tracked(), ["A"]);
targets = ["A"];
graph({ A: {} });
eq("target with an empty companion map", tracked(), ["A"]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
