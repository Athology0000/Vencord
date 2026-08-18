// Extracts the REAL game-tracking functions from xicordDossier.tsx and checks that
// play time accumulates.  node src/userplugins/_dossierGames.test.mjs
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordDossier.tsx", import.meta.url), "utf8");
const JS = esbuild.transformSync(SRC, { loader: "tsx", jsx: "preserve" }).code;

function extract(name) {
    const start = JS.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    let i = JS.indexOf("(", start), pd = 0;
    for (; i < JS.length; i++) { if (JS[i] === "(") pd++; else if (JS[i] === ")") { pd--; if (!pd) { i++; break; } } }
    i = JS.indexOf("{", i);
    let depth = 0, mode = "code", prev = "";
    for (; i < JS.length; i++) {
        const ch = JS[i], next = JS[i + 1];
        if (mode === "line") { if (ch === "\n") mode = "code"; }
        else if (mode === "block") { if (ch === "*" && next === "/") { mode = "code"; i++; } }
        else if (mode !== "code") { if (ch === mode && prev !== "\\") mode = "code"; }
        else if (ch === "/" && next === "/") { mode = "line"; i++; }
        else if (ch === "/" && next === "*") { mode = "block"; i++; }
        else if (ch === '"' || ch === "'" || ch === "`") mode = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (!depth) return JS.slice(start, i + 1); }
        prev = ch;
    }
    throw new Error(`unbalanced ${name}`);
}

// A controllable clock (shared ref), so elapsed play time is deterministic. The
// extracted functions call Date.now(); we shadow Date inside the sandbox.
const fns = ["profileFor", "currentGame", "closeGame", "reconcileGame", "viewProfile"].map(extract).join("\n");
const G = new Function("ref",
    `const Date = { now: () => ref.v };
     let profiles = {}, dirty = false;
     const openGame = new Map();
     const open = new Map();          // voice overlaps — not exercised here
     const MAX_GAMES = 60;
     function scheduleFlush(){ dirty = true; }
     ${fns}
     return { currentGame, reconcileGame, closeGame, viewProfile,
              getProfiles: () => profiles, getOpen: () => openGame,
              advance: ms => { ref.v += ms; } };`
)({ v: 1_000_000 });

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? "\n          " + e : ""}`); } };
const pres = name => ({ user: { id: "T" }, activities: name ? [{ type: 0, name }] : [] });

console.log("\n-- currentGame parses activities --");
ok("finds a Playing activity", G.currentGame({ activities: [{ type: 4, name: "custom" }, { type: 0, name: "Halo" }] }) === "Halo");
ok("ignores non-game activities", G.currentGame({ activities: [{ type: 2, name: "Spotify" }] }) === null);
ok("no activities -> null", G.currentGame({ activities: [] }) === null);

console.log("\n-- play time accumulates across a session --");
G.reconcileGame("T", pres("Halo"));                 // starts playing
ok("an open game session is tracked", G.getOpen().get("T")?.name === "Halo");
ok("a session is counted immediately", G.getProfiles()["T"]?.games?.Halo?.sessions === 1);
G.advance(30_000);                                   // 30s later, still on Halo
G.reconcileGame("T", pres("Halo"));
ok("staying on the same game does not restart the session", G.getProfiles()["T"].games.Halo.sessions === 1);
let live = G.viewProfile("T").games.Halo;
ok("viewProfile shows the live 30s even before it closes", live.ms === 30_000, "ms=" + live.ms);
G.advance(30_000);                                   // total 60s
G.reconcileGame("T", pres(null));                    // stopped playing
ok("stopping banks the full 60s", G.getProfiles()["T"].games.Halo.ms === 60_000, "ms=" + G.getProfiles()["T"].games.Halo.ms);
ok("the open session is cleared on stop", !G.getOpen().has("T"));

console.log("\n-- switching games banks the old and opens the new --");
G.reconcileGame("T", pres("Halo"));                  // play Halo again
G.advance(10_000);
G.reconcileGame("T", pres("Doom"));                  // switch to Doom
ok("Halo gained another 10s (now 70s total)", G.getProfiles()["T"].games.Halo.ms === 70_000, "ms=" + G.getProfiles()["T"].games.Halo.ms);
ok("Halo now has 2 sessions", G.getProfiles()["T"].games.Halo.sessions === 2);
ok("Doom session opened", G.getOpen().get("T")?.name === "Doom");
G.advance(5_000);
G.reconcileGame("T", pres(null));
ok("Doom banked 5s", G.getProfiles()["T"].games.Doom.ms === 5_000);

console.log("\n-- viewProfile merges an in-progress session live --");
G.reconcileGame("T", pres("Doom"));
G.advance(12_000);
const v = G.viewProfile("T").games;
ok("Doom shows 17s live (5 banked + 12 open)", v.Doom.ms === 17_000, "ms=" + v.Doom.ms);
ok("persisted store still only has the 5s banked (live time isn't written yet)",
    G.getProfiles()["T"].games.Doom.ms === 5_000);

console.log("\n-- untracked / empty --");
ok("viewProfile on someone with no games returns an empty games map",
    Object.keys(G.viewProfile("nobody").games).length === 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
