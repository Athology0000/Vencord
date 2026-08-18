// Exercises the REAL recordIdentity() from xicordDossier.tsx — the one line that turns
// "we noticed they renamed" into a kept record.
//   node src/userplugins/_identityHistory.test.mjs
//
// The name cache always spotted the change; it overwrote the old value and moved on.
// People rename and re-avatar precisely to leave the old identity behind, so this store
// is the only place it survives. It also only ever grows forward: nothing here can
// reconstruct a change that happened before the plugin was watching.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordDossier.tsx", import.meta.url), "utf8");

function span(from, to) {
    const a = SRC.indexOf(from);
    if (a < 0) throw new Error(`marker not found: ${from}`);
    const b = SRC.indexOf(to, a);
    if (b < 0) throw new Error(`end marker not found: ${to}`);
    return SRC.slice(a, b);
}
const cap = Number(/const MAX_IDENTITY_PER_USER = (\d+)/.exec(SRC)[1]);
const ts = [
    `const MAX_IDENTITY_PER_USER = ${cap};`,
    span("export function recordIdentity(", "/** The identity history, for the Xicord Cache"),
].join("\n").replace(/^export /gm, "");
const { recordIdentity, identityChanges } = new Function(
    `${esbuild.transformSync(ts, { loader: "ts" }).code}; return { recordIdentity, identityChanges };`)();

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};
const names = s => (s.u1 || []).map(e => e.username).join(",");

console.log("\n-- a rename banks the name being replaced --");
let store = {};
ok("the OLD name is what gets kept, not the new one",
    recordIdentity(store, "u1", { username: "old", at: 100 }, { username: "new" }, 500) && names(store) === "old",
    names(store));
ok("with the window it was in use for", store.u1[0].from === 100 && store.u1[0].until === 500,
    JSON.stringify(store.u1[0]));
recordIdentity(store, "u1", { username: "new", at: 500 }, { username: "newer" }, 900);
ok("successive renames stack oldest-first", names(store) === "old,new", names(store));

console.log("\n-- re-seeing the same person is not a change --");
store = {};
ok("identical name and avatar records nothing",
    recordIdentity(store, "u1", { username: "same", avatar: "a" }, { username: "same", avatar: "a" }, 1) === false);
ok("and the store stays empty", Object.keys(store).length === 0);

console.log("\n-- avatars and banners count too --");
store = {};
ok("a new avatar is a change", recordIdentity(store, "u1", { username: "n", avatar: "a1" }, { username: "n", avatar: "a2" }, 1));
ok("the old avatar is what is kept", store.u1[0].avatar === "a1", JSON.stringify(store.u1[0]));
store = {};
ok("a new banner is a change", recordIdentity(store, "u1", { username: "n", banner: "b1" }, { username: "n", banner: "b2" }, 1));
ok("the old banner is kept", store.u1[0].banner === "b1");

console.log("\n-- 'we had never seen one' is not 'they removed it' --");
// Discord hands out avatars and banners inconsistently; an absent previous value means
// we simply had not observed it, and logging that as a change would fill the history
// with phantom edits every time a field arrived late.
store = {};
ok("gaining an avatar we had never seen is not a change",
    recordIdentity(store, "u1", { username: "n", avatar: "" }, { username: "n", avatar: "a1" }, 1) === false);
ok("gaining a banner we had never seen is not a change",
    recordIdentity(store, "u1", { username: "n" }, { username: "n", banner: "b1" }, 1) === false);
ok("but a rename alongside it still is",
    recordIdentity(store, "u1", { username: "a", avatar: "" }, { username: "b", avatar: "x" }, 1) === true);

console.log("\n-- nothing to record from --");
store = {};
ok("no previous value at all records nothing",
    recordIdentity(store, "u1", undefined, { username: "n" }, 1) === false);
ok("a previous entry with no username records nothing",
    recordIdentity(store, "u1", { username: "" }, { username: "n" }, 1) === false);
ok("a blank id records nothing", recordIdentity(store, "", { username: "a" }, { username: "b" }, 1) === false);

console.log("\n-- the same old look twice extends the period, it does not duplicate --");
store = {};
recordIdentity(store, "u1", { username: "old", at: 1 }, { username: "new" }, 100);
recordIdentity(store, "u1", { username: "old", at: 1 }, { username: "other" }, 200);
ok("still one entry", store.u1.length === 1, JSON.stringify(store.u1));
ok("but its end moves forward", store.u1[0].until === 200, String(store.u1[0].until));

console.log("\n-- a person who edits constantly cannot grow forever --");
store = {};
for (let i = 0; i < cap + 25; i++) recordIdentity(store, "u1", { username: "n" + i, at: i }, { username: "n" + (i + 1) }, i + 1);
ok(`capped at ${cap}`, store.u1.length === cap, String(store.u1.length));
ok("the OLDEST are the ones dropped", store.u1[0].username === "n25", store.u1[0].username);
ok("the most recent is kept", store.u1[cap - 1].username === "n" + (cap + 24), store.u1[cap - 1].username);

console.log("\n-- the reader agrees with the writer --");
store = {};
recordIdentity(store, "u1", { username: "first", at: 1 }, { username: "second" }, 10);
recordIdentity(store, "u1", { username: "second", at: 10 }, { username: "third" }, 20);
const rows = identityChanges(store, { u1: { username: "third" } });
ok("one row for the person", rows.length === 1);
ok("naming who they are now", rows[0].now === "third");
ok("and every name they have used, newest first", rows[0].was.join(",") === "second,first", rows[0].was.join(","));
ok("timestamped by the latest change", rows[0].changedAt === 20, String(rows[0].changedAt));

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
