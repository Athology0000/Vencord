// The per-account settings coordinator, driven exactly as the Dossier drives it.
//   node src/userplugins/_accountConfig.test.mjs
//
// The invariant: the LIVE settings field always holds the CURRENT account's value, so
// every reader and change-listener across the plugins keeps working untouched. This
// module is the only thing that moves values in and out. The cases that matter:
//   * two accounts never see each other's targets/watchlists/traits;
//   * a never-seen account starts at DEFAULTS, not the previous account's config;
//   * changing config then switching banks it — nothing is lost;
//   * the logged-in account being changed while Discord is CLOSED does not misattribute
//     one account's config to another (the `owner` marker earns its keep here).
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");

// A fake Vencord settings tree + DataStore, injected in place of the real imports.
let plugins = {};
const Settings = { plugins };
let disk = {};
const DataStore = {
    get: async k => disk[k],
    set: async (k, v) => { disk[k] = JSON.parse(JSON.stringify(v)); },
    del: async k => { delete disk[k]; },
};

const SRC = readFileSync(new URL("./_accountConfig.tsx", import.meta.url), "utf8");
// strip the two imports and the `export` keywords, run the body as a module in our scope
const body = SRC
    .replace(/^import[^\n]*\n/gm, "")
    .replace(/^export /gm, "");
const js = esbuild.transformSync(body, { loader: "ts" }).code;
const api = new Function("Settings", "DataStore", "setTimeout",
    `${js}; return { loadAccountConfig, initAccountConfig, swapAccountConfig, snapshotFields, _reset, _data };`
)(Settings, DataStore, (fn) => { /* swallow the debounced persist timer; we persist manually */ return 1; });

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${extra ? "\n          " + extra : ""}`)); };

// helpers to read/set the live "settings.json" fields
const setField = (plugin, key, val) => { (plugins[plugin] ||= {})[key] = val; };
const getField = (plugin, key) => plugins[plugin]?.[key];
const TARGETS = ["Xicord Traits", "tasks"];
const HIDDEN = ["Xicord Mutuals", "hidden"];

function fresh(fields = {}) {
    plugins = {}; Settings.plugins = plugins;
    // every plugin present, at its default, unless overridden
    for (const [p, k, v] of [
        ["Xicord Traits", "tasks", ""], ["Xicord Mutuals", "targets", "[]"], ["Xicord Mutuals", "hidden", "[]"],
        ["Xicord Orbit", "watched", "[]"], ["Xicord Ghost", "ghosted", "[]"], ["Xicord Watchlist", "rules", "[]"],
        ["Xicord Notes", "notes", "{}"], ["Xicord Keyword Alerts", "keywords", ""], ["Xicord Voice Log", "watched", ""],
    ]) setField(p, k, v);
    for (const [pk, val] of Object.entries(fields)) { const [p, k] = pk.split("|"); setField(p, k, val); }
    api._reset();
}

console.log("\n-- first run adopts the existing (account-agnostic) config as this account's --");
disk = {};
fresh({ "Xicord Traits|tasks": '[{"name":"Target","users":"/111"}]' });
await api.loadAccountConfig();
api.initAccountConfig("A");
ok("the live field is untouched on first run for the primary account",
    getField(...TARGETS) === '[{"name":"Target","users":"/111"}]', getField(...TARGETS));
ok("and it is banked under A", api._data().accounts.A["Xicord Traits tasks"] === '[{"name":"Target","users":"/111"}]');
ok("A is recorded as the field owner", api._data().owner === "A");

console.log("\n-- switching to a never-seen account B gives it DEFAULTS, not A's config --");
api.swapAccountConfig("A", "B");
ok("B's tasks field is the default (empty), not A's targets", getField(...TARGETS) === "", getField(...TARGETS));
ok("A's config is safely banked", api._data().accounts.A["Xicord Traits tasks"] === '[{"name":"Target","users":"/111"}]');
ok("the owner is now B", api._data().owner === "B");

console.log("\n-- B builds its OWN config; switching back restores each account's --");
setField(...TARGETS, '[{"name":"Target","users":"/222"}]');
setField(...HIDDEN, '["999"]');
api.swapAccountConfig("B", "A");
ok("back on A, A's targets are restored", getField(...TARGETS) === '[{"name":"Target","users":"/111"}]', getField(...TARGETS));
ok("A's hidden is its own default, untouched by B", getField(...HIDDEN) === "[]", getField(...HIDDEN));
api.swapAccountConfig("A", "B");
ok("back on B, B's targets are restored", getField(...TARGETS) === '[{"name":"Target","users":"/222"}]', getField(...TARGETS));
ok("and B's hidden too", getField(...HIDDEN) === '["999"]', getField(...HIDDEN));

console.log("\n-- a change made just before a switch is banked, not lost --");
setField(...TARGETS, '[{"name":"Target","users":"/222/333"}]');   // add someone while on B
api.swapAccountConfig("B", "A");
api.swapAccountConfig("A", "B");
ok("the last-second change is still there after a round trip", getField(...TARGETS) === '[{"name":"Target","users":"/222/333"}]', getField(...TARGETS));

console.log("\n-- restart on the SAME account preserves unsaved-since-bank changes --");
// simulate persistence: the side store and the live fields both survive a restart
const persisted = JSON.parse(JSON.stringify(api._data()));
const liveTasks = getField(...TARGETS);           // B's, with the change
// restart: fresh module, disk carries the side store, fields carry B's config, owner=B
disk = { XicordAccountConfig: persisted };
fresh({ "Xicord Traits|tasks": liveTasks });
await api.loadAccountConfig();
api.initAccountConfig("B");
ok("a same-account restart keeps the live field", getField(...TARGETS) === liveTasks, getField(...TARGETS));
ok("owner stays B", api._data().owner === "B");

console.log("\n-- account changed while Discord was CLOSED: neither account's config is lost --");
// Shut down on B (fields hold B's config, owner=B). Reopen logged in as A instead.
// The fields still hold B's config; startup must preserve B and restore A.
disk = { XicordAccountConfig: persisted };   // owner: B, accounts: {A:..., B:...}
fresh({ "Xicord Traits|tasks": '[{"name":"Target","users":"/222/333"}]' });  // B's leftover in the field
await api.loadAccountConfig();
api.initAccountConfig("A");
ok("A's own config is restored, not B's leftover", getField(...TARGETS) === '[{"name":"Target","users":"/111"}]', getField(...TARGETS));
ok("B's config is preserved in its slice", api._data().accounts.B["Xicord Traits tasks"] === '[{"name":"Target","users":"/222/333"}]');
ok("owner is now A", api._data().owner === "A");

console.log("\n-- a missing/disabled plugin field is simply skipped, not crashed on --");
plugins = { "Xicord Traits": { tasks: '[{"name":"Target","users":"/1"}]' } }; Settings.plugins = plugins;  // only Traits present
api._reset(); disk = {};
await api.loadAccountConfig();
api.initAccountConfig("A");
api.swapAccountConfig("A", "C");
ok("switching does not throw with most plugins absent", getField(...TARGETS) === "", getField(...TARGETS));
ok("and an absent plugin's field is not conjured into existence", plugins["Xicord Mutuals"] === undefined);

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
