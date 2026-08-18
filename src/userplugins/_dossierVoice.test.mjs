// Extracts the REAL voice/occupant + member-sweep functions from xicordDossier.tsx
// and drives them with mock stores.  node src/userplugins/_dossierVoice.test.mjs
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

// ---- mock stores, controllable per test ----
const store = {
    channels: {},            // ChannelStore.getChannel
    voiceForUser: {},        // VoiceStateStore.getVoiceStateForUser
    voiceForChannel: {},     // VoiceStateStore.getVoiceStatesForChannel (empty for locked)
    allVoice: {},            // VoiceStateStore.getAllVoiceStates (guild -> uid -> vs)
    members: {},             // GuildMemberStore.getMemberIds
    selectedGuild: null,
    scanned: new Set(),
    users: {}
};
let scanCalls = [];
const ChannelStore = { getChannel: id => store.channels[id] ?? null };
const VoiceStateStore = {
    getVoiceStateForUser: id => store.voiceForUser[id] ?? null,
    getVoiceStatesForChannel: id => store.voiceForChannel[id] ?? {},
    getAllVoiceStates: () => store.allVoice
};
const GuildMemberStore = { getMemberIds: g => store.members[g] ?? [] };
const SelectedGuildStore = { getGuildId: () => store.selectedGuild };
const UserStore = { getCurrentUser: () => ({ id: "ME" }), getUser: id => store.users[id] ?? null };
const MutualsAPI = {
    isActive: () => true,
    isScanned: id => store.scanned.has(id),
    scan: id => { store.scanned.add(id); scanCalls.push(id); }
};
const Toasts = { show() { }, Type: {}, Position: {} };
const settings = { store: { announceNew: false, scanMembers: true } };

// module state the extracted fns close over
const preamble = `
    let profiles = {}, dirty = false, trackedDirty = false;
    const open = new Map();
    // MEMBER_SWEEP_CAP is 0 in the source now (no limit); sweepGuildMembers branches on
    // uncapped() because slice(0, 0) would otherwise sweep nobody.
    const MAX_COMPANIONS = 300, MEMBER_SWEEP_CAP = 0;
    const uncapped = n => !(n > 0);
    const sweptGuilds = new Set();
    let active = true, retrackWanted = false;
    function scheduleFlush(){ dirty = true; }
    function noteCallGraphGrew(){ retrackWanted = true; }
`;
// arrow const: `const name = (...) => { ... }` — brace-match its body
function extractConst(name) {
    const start = JS.indexOf(`const ${name} = `);
    if (start < 0) throw new Error(`const ${name} not found`);
    let i = JS.indexOf("{", start), depth = 0, mode = "code", prev = "";
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
    throw new Error(`unbalanced const ${name}`);
}
const fns = ["profileFor", "tagCallGuild", "channelOccupants", "reconcile", "scanForMutuals", "guildMemberIds", "sweepGuildMembers"]
    .map(extract).concat([extractConst("onGuildMemberAdd")]).join("\n");
const api = new Function(
    "ChannelStore", "VoiceStateStore", "GuildMemberStore", "SelectedGuildStore", "UserStore",
    "MutualsAPI", "Toasts", "settings",
    `${preamble}\nconst MAX_CALL_GUILDS = 8;\n${fns}
     return { channelOccupants, reconcile, sweepGuildMembers, onGuildMemberAdd,
              getProfiles: () => profiles, getOpen: () => open, getSwept: () => sweptGuilds,
              setActive: v => { active = v; } };`
)(ChannelStore, VoiceStateStore, GuildMemberStore, SelectedGuildStore, UserStore, MutualsAPI, Toasts, settings);

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${e ? "\n          " + e : ""}`); } };
const reset = () => { store.channels = {}; store.voiceForUser = {}; store.voiceForChannel = {}; store.allVoice = {}; store.members = {}; store.selectedGuild = null; store.scanned = new Set(); scanCalls = []; api.getOpen().clear(); Object.keys(api.getProfiles()).forEach(k => delete api.getProfiles()[k]); api.getSwept().clear(); api.setActive(true); };

console.log("\n-- channelOccupants: normal channel --");
reset();
store.voiceForChannel["c1"] = { A: { userId: "A", channelId: "c1" }, B: { userId: "B", channelId: "c1" } };
let occ = api.channelOccupants("c1", "g1");
ok("returns the per-channel occupants directly", Object.keys(occ).sort().join(",") === "A,B");

console.log("\n-- channelOccupants: LOCKED channel (per-channel map empty) --");
reset();
// direct map is empty (locked), but the guild-wide map still has them
store.voiceForChannel["locked"] = {};
store.allVoice["g1"] = {
    A: { userId: "A", channelId: "locked" },
    B: { userId: "B", channelId: "locked" },
    C: { userId: "C", channelId: "other" } // different channel, must be excluded
};
occ = api.channelOccupants("locked", "g1");
ok("falls back to the guild map for a locked channel", Object.keys(occ).sort().join(",") === "A,B", JSON.stringify(Object.keys(occ)));
ok("does not pull in people from other channels", !occ.C);
ok("without a guildId, empty fallback is safe", Object.keys(api.channelOccupants("locked")).length === 0);

console.log("\n-- reconcile records a companion inside a LOCKED channel --");
reset();
// target T is in a locked guild VC: channel NOT in ChannelStore, but the voice
// state carries guildId, and occupants are only in the guild-wide map.
store.voiceForUser["T"] = { channelId: "locked", guildId: "g1" };
// channel deliberately absent from ChannelStore.getChannel
store.voiceForChannel["locked"] = {};
store.allVoice["g1"] = {
    T: { userId: "T", channelId: "locked", guildId: "g1" },
    F: { userId: "F", channelId: "locked", guildId: "g1" }
};
api.reconcile("T");                    // opens the overlap
ok("a locked-channel target opens an overlap", api.getOpen().has("T"), "open=" + [...api.getOpen().keys()]);
ok("companion F was counted despite the channel being locked",
    (api.getProfiles()["T"]?.companions?.F?.count ?? 0) === 1,
    JSON.stringify(api.getProfiles()["T"]));
ok("the locked guild is recorded on the profile", !!api.getProfiles()["T"]?.guilds?.g1);
ok("the call is categorised by the server it happened in",
    (api.getProfiles()["T"]?.companions?.F?.guilds || []).includes("g1"),
    JSON.stringify(api.getProfiles()["T"]?.companions?.F));
// old code path: guildId came only from ChannelStore, so this whole call was skipped

console.log("\n-- reconcile with NO guild anywhere is treated as non-guild (DM/group call) --");
reset();
store.voiceForUser["T"] = { channelId: "dm1" }; // no guildId, not in ChannelStore
api.reconcile("T");
ok("a call with no derivable guild is not tracked", !api.getOpen().has("T"));

console.log("\n-- member sweep: once per guild --");
reset();
store.members["g1"] = ["m1", "m2", "m3", "ME"]; // ME must be skipped by scanForMutuals
api.sweepGuildMembers("g1");
ok("sweep queues the loaded members", scanCalls.sort().join(",") === "m1,m2,m3", scanCalls.join(","));
ok("the current user is never scanned", !scanCalls.includes("ME"));
scanCalls = [];
api.sweepGuildMembers("g1");
ok("a second sweep of the same guild is a no-op", scanCalls.length === 0);
ok("the guild is marked swept", api.getSwept().has("g1"));
api.sweepGuildMembers(null);
ok("sweeping a null guild is safe", scanCalls.length === 0);

console.log("\n-- new member joined updates incrementally --");
reset();
store.scanned = new Set();
api.onGuildMemberAdd({ guildId: "g1", userId: "newbie" });
ok("GUILD_MEMBER_ADD scans the newcomer", scanCalls.includes("newbie"));
scanCalls = [];
api.onGuildMemberAdd({ guildId: "g1", user: { id: "newbie2" } }); // nested user shape
ok("handles the nested {user:{id}} shape too", scanCalls.includes("newbie2"));
scanCalls = [];
settings.store.scanMembers = false;
api.onGuildMemberAdd({ guildId: "g1", userId: "ignored" });
ok("respects the scanMembers=off setting", scanCalls.length === 0);
settings.store.scanMembers = true;
api.setActive(false);
api.onGuildMemberAdd({ guildId: "g1", userId: "ignored2" });
ok("does nothing while the plugin is stopped", scanCalls.length === 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
