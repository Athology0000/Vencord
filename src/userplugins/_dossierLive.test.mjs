// Exercises the REAL liveCall() from xicordDossier.tsx — the one line on a dossier that
// describes NOW rather than the past.
//   node src/userplugins/_dossierLive.test.mjs
//
// Everything else in the "Calls with" list is history: a count, a total, a "3d ago".
// This is read straight off Discord's live voice store, so it is the only row content
// that can be acted on this second — which is why it is the thing coloured green, and
// why it names who is in there rather than just saying "online".
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordDossier.tsx", import.meta.url), "utf8");

const start = SRC.indexOf("export function liveCall(");
if (start < 0) throw new Error("liveCall not found");
let i = SRC.indexOf("(", start), pd = 0;
for (; i < SRC.length; i++) {
    if (SRC[i] === "(") pd++;
    else if (SRC[i] === ")") { pd--; if (!pd) { i++; break; } }
}
// the return type carries its own braces; step over the annotation first
if (SRC.slice(i, SRC.indexOf("{", i)).includes(":")) {
    let k = SRC.indexOf("{", i), bd = 0;
    for (; k < SRC.length; k++) {
        if (SRC[k] === "{") bd++;
        else if (SRC[k] === "}") { bd--; if (!bd) { i = k + 1; break; } }
    }
}
let j = SRC.indexOf("{", i), depth = 0, end = -1;
for (; j < SRC.length; j++) {
    if (SRC[j] === "{") depth++;
    else if (SRC[j] === "}") { depth--; if (!depth) { end = j + 1; break; } }
}
const liveCall = new Function(
    `${esbuild.transformSync(SRC.slice(start, end).replace(/^export /, ""), { loader: "ts" }).code}; return liveCall;`)();

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};

/** voice states keyed by user, and channel occupancy derived from them */
function world(states) {
    const stateOf = id => states[id] || null;
    const occupantsOf = (channelId) => {
        const out = {};
        for (const u in states) if (states[u] && states[u].channelId === channelId) out[u] = states[u];
        return out;
    };
    return { stateOf, occupantsOf };
}

console.log("\n-- somebody sitting in a channel with other people --");
let w = world({
    them: { channelId: "vc1", guildId: "g1" },
    alice: { channelId: "vc1", guildId: "g1" },
    bob: { channelId: "vc1", guildId: "g1" },
    elsewhere: { channelId: "vc2", guildId: "g1" },
});
let r = liveCall("them", w.stateOf, w.occupantsOf, "ME");
ok("they are reported as live", !!r);
ok("the channel comes back", r.channelId === "vc1", String(r.channelId));
ok("the guild comes back, so the row can name the server", r.guildId === "g1");
ok("everyone else in that channel is listed", r.others.sort().join(",") === "alice,bob", r.others.join(","));
ok("someone in a DIFFERENT channel is not", !r.others.includes("elsewhere"), r.others.join(","));
ok("they are not listed as being in there with themselves", !r.others.includes("them"));

console.log("\n-- you are never counted as company --");
// Sitting in the call yourself must not make the row say "in a call with you"
w = world({ them: { channelId: "vc1" }, ME: { channelId: "vc1" }, alice: { channelId: "vc1" } });
r = liveCall("them", w.stateOf, w.occupantsOf, "ME");
ok("your own presence is filtered out", r.others.join(",") === "alice", r.others.join(","));

console.log("\n-- alone in a channel is still live --");
w = world({ them: { channelId: "vc1", guildId: "g1" } });
r = liveCall("them", w.stateOf, w.occupantsOf, "ME");
ok("being alone does not read as being offline", !!r);
ok("with nobody to name", r.others.length === 0, r.others.join(","));

console.log("\n-- not in voice at all --");
w = world({ them: { channelId: null }, alice: { channelId: "vc1" } });
ok("a null channel is not a call", liveCall("them", w.stateOf, w.occupantsOf, "ME") === null);
ok("no voice state at all is not a call", liveCall("ghost", w.stateOf, w.occupantsOf, "ME") === null);
ok("an undefined state object is survivable",
    liveCall("x", () => undefined, w.occupantsOf, "ME") === null);

console.log("\n-- a broken store must not take the dossier down --");
// This runs inside a render, once per visible row. A throw here would blank the modal.
ok("a throwing state lookup yields null, not an exception", (() => {
    try { return liveCall("them", () => { throw new Error("store gone"); }, w.occupantsOf, "ME") === null; }
    catch { return false; }
})());
ok("a throwing occupants lookup still reports the call itself", (() => {
    try {
        const x = liveCall("them", () => ({ channelId: "vc1", guildId: "g1" }),
            () => { throw new Error("nope"); }, "ME");
        return !!x && x.channelId === "vc1" && x.others.length === 0;
    } catch { return false; }
})());
ok("occupants returning nothing is treated as an empty room", (() => {
    const x = liveCall("them", () => ({ channelId: "vc1" }), () => null, "ME");
    return !!x && x.others.length === 0;
})());
ok("a blank id inside the occupancy map is dropped", (() => {
    const x = liveCall("them", () => ({ channelId: "vc1" }), () => ({ "": {}, alice: {} }), "ME");
    return x.others.join(",") === "alice";
})());

console.log("\n-- a locked or hidden channel still counts --");
// getVoiceStatesForChannel comes back empty for a channel you cannot join; the caller
// falls back to the guild map, so liveCall must not require a populated room.
r = liveCall("them", () => ({ channelId: "secret", guildId: "g9" }), () => ({}), "ME");
ok("an unreadable room is still a live call", !!r && r.channelId === "secret");
ok("it just has nobody named in it", r.others.length === 0);

/* ------------------------------------------------------------------ voiceTier */
// Being in a voice channel AT ALL used to be the whole test, so someone three servers
// away came out the same green as someone sitting in your own channel. Green is worth
// spending on exactly one state — they are here, with you, now — so the tier splits
// three ways and the two "in voice" cases must not collapse back into one.
const tierSrc = (() => {
    const s = SRC.indexOf("export function voiceTier(");
    if (s < 0) throw new Error("voiceTier not found");
    // the return annotation is a bare type name, so the first brace IS the body
    let k = SRC.indexOf("{", SRC.indexOf(")", SRC.indexOf("(", s))), d = 0;
    for (let m = k; m < SRC.length; m++) {
        if (SRC[m] === "{") d++;
        else if (SRC[m] === "}") { d--; if (!d) return SRC.slice(s, m + 1); }
    }
    throw new Error("unbalanced voiceTier");
})();
const voiceTier = new Function(
    `${esbuild.transformSync(tierSrc.replace(/^export /, ""), { loader: "ts" }).code}; return voiceTier;`)();

console.log("\n-- how present is somebody, exactly --");
ok("in YOUR channel is the green one", voiceTier({ channelId: "vc1" }, "vc1") === "with-me");
ok("a different channel is not green", voiceTier({ channelId: "vc2" }, "vc1") === "elsewhere");
ok("out of voice entirely is neither", voiceTier(null, "vc1") === "away");
ok("and the three tiers stay distinct",
    new Set([voiceTier({ channelId: "vc1" }, "vc1"), voiceTier({ channelId: "vc2" }, "vc1"),
        voiceTier(null, "vc1")]).size === 3);

console.log("\n-- when YOU are not in a call --");
// the regression to avoid: no channel of your own must not make everyone "with-me"
ok("nobody is in your channel if you have none", voiceTier({ channelId: "vc2" }, null) === "elsewhere");
ok("not even on an undefined channel", voiceTier({ channelId: "vc2" }, undefined) === "elsewhere");
ok("an empty-string channel is not a match either", voiceTier({ channelId: "" }, "") === "away");

console.log("\n-- a liveCall result feeds straight in --");
w = world({ them: { channelId: "vc1", guildId: "g1" }, ME: { channelId: "vc1", guildId: "g1" } });
ok("sharing a channel reads as with-me",
    voiceTier(liveCall("them", w.stateOf, w.occupantsOf, "ME"), "vc1") === "with-me");
w = world({ them: { channelId: "vc9", guildId: "g1" }, ME: { channelId: "vc1", guildId: "g1" } });
ok("a separate channel reads as elsewhere",
    voiceTier(liveCall("them", w.stateOf, w.occupantsOf, "ME"), "vc1") === "elsewhere");
ok("and somebody with no state at all is away",
    voiceTier(liveCall("nobody", w.stateOf, w.occupantsOf, "ME"), "vc1") === "away");

console.log("\n-- junk cannot make somebody look present --");
ok("undefined is away", voiceTier(undefined, "vc1") === "away");
ok("a state with no channel is away", voiceTier({}, "vc1") === "away");
ok("a null channel is away", voiceTier({ channelId: null }, "vc1") === "away");

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
