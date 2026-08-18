// Bundles the REAL src/userplugins/_targetTrait.tsx against a stubbed @api/Settings
// and exercises it, so the trait-string handling is tested as shipped rather than
// re-implemented here.
import { createRequire } from "module";
import { pathToFileURL } from "url";
import { writeFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const { build } = require("esbuild");
const dir = mkdtempSync(join(tmpdir(), "tt-"));

const stub = join(dir, "settingsStub.mjs");
writeFileSync(stub, `
export const Settings = { plugins: { "Xicord Traits": { enabled: true, tasks: "[]" } } };
export const SettingsStore = {
    _l: [],
    addChangeListener(path, cb) { this._l.push([path, cb]); },
    removeChangeListener() {},
    fire(path) { for (const [p, cb] of this._l) if (p === path) cb(); }
};
`);

const out = join(dir, "bundle.mjs");
await build({
    entryPoints: [join(ROOT, "src/userplugins/_targetTrait.tsx")],
    bundle: true, format: "esm", outfile: out, platform: "node",
    plugins: [{
        name: "alias",
        setup(b) {
            // external, so the bundle and this test share ONE stub instance
            b.onResolve({ filter: /^@api\/Settings$/ }, () => ({ path: pathToFileURL(stub).href, external: true }));
        }
    }]
});

const M = await import(pathToFileURL(out).href);
const S = (await import(pathToFileURL(stub).href)).Settings;
const Store = (await import(pathToFileURL(stub).href)).SettingsStore;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}\n          got  ${g}\n          want ${w}`); }
};
const setTasks = v => { S.plugins["Xicord Traits"].tasks = JSON.stringify(v); };
const tasks = () => JSON.parse(S.plugins["Xicord Traits"].tasks);

console.log("\n-- reading the Target trait --");
setTasks([{ name: "Friend", url: "", users: "/1/2" }, { name: "Target", url: "a.mp3", users: "/10/20/30" }]);
eq("targetIds reads only the Target trait", M.targetIds(), ["10", "20", "30"]);
eq("hasTarget true for member", M.hasTarget("20"), true);
eq("hasTarget false for a Friend-only member", M.hasTarget("1"), false);
eq("hasTarget false for unknown", M.hasTarget("999"), false);

console.log("\n-- cache invalidates on external writes --");
setTasks([{ name: "Target", url: "", users: "/77" }]);
eq("re-reads after another plugin rewrites tasks", M.targetIds(), ["77"]);

console.log("\n-- prefix collision (the bug the old split-removal guarded) --");
setTasks([{ name: "Target", url: "", users: "/123/1234/12" }]);
M.toggleTarget("12");
eq("removing '12' leaves '123' and '1234' intact", M.targetIds(), ["123", "1234"]);
eq("stored string keeps Traits' /id format", tasks()[0].users, "/123/1234");

console.log("\n-- toggle round trip --");
setTasks([{ name: "Target", url: "", users: "" }]);
eq("toggle on returns true", M.toggleTarget("55"), true);
eq("...and is now targeted", M.hasTarget("55"), true);
eq("toggle off returns false", M.toggleTarget("55"), false);
eq("...and users is empty again", tasks()[0].users, "");

console.log("\n-- toggle creates Target when absent, preserving other traits --");
setTasks([{ name: "Friend", url: "f.mp3", users: "/9" }]);
M.toggleTarget("42");
eq("Friend survives", tasks()[0], { name: "Friend", url: "f.mp3", users: "/9" });
eq("Target created with the member", tasks()[1], { name: "Target", url: "", users: "/42" });

console.log("\n-- ensureTargetTrait is idempotent and non-destructive --");
setTasks([{ name: "Target", url: "keep.mp3", users: "/7" }]);
M.ensureTargetTrait(); M.ensureTargetTrait();
eq("does not duplicate or clobber", tasks(), [{ name: "Target", url: "keep.mp3", users: "/7" }]);
setTasks([]);
M.ensureTargetTrait();
eq("creates it when missing", tasks(), [{ name: "Target", url: "", users: "" }]);

console.log("\n-- addTargets (Orbit's legacy migration) --");
setTasks([{ name: "Target", url: "", users: "/1" }]);
M.addTargets(["1", "2", "3"]);
eq("merges without duplicating existing", M.targetIds(), ["1", "2", "3"]);
M.addTargets([]);
eq("empty migration is a no-op", M.targetIds(), ["1", "2", "3"]);

console.log("\n-- case-insensitive match --");
setTasks([{ name: "target", url: "", users: "/5" }]);
eq("lowercase 'target' still drives watching", M.hasTarget("5"), true);
eq("isTargetTrait('TARGET')", M.isTargetTrait("TARGET"), true);
eq("isTargetTrait('Targets') is false", M.isTargetTrait("Targets"), false);
eq("isTargetTrait(undefined) is false", M.isTargetTrait(undefined), false);

console.log("\n-- malformed / missing data --");
S.plugins["Xicord Traits"].tasks = "not json";
eq("corrupt JSON yields no targets", M.targetIds(), []);
S.plugins["Xicord Traits"].tasks = "";
eq("empty string yields no targets", M.targetIds(), []);
setTasks([{ name: "Target", users: 12345 }]);
eq("non-string users yields no targets", M.targetIds(), []);
delete S.plugins["Xicord Traits"];
eq("Traits plugin absent yields no targets", M.targetIds(), []);
M.ensureTargetTrait();
eq("ensureTargetTrait no-ops when Traits absent", S.plugins["Xicord Traits"], undefined);

console.log("\n-- change notification --");
S.plugins["Xicord Traits"] = { enabled: true, tasks: "[]" };
let fired = 0;
const fn = () => fired++;
M.subscribeTargets(fn);
setTasks([{ name: "Target", url: "", users: "/1" }]);
Store.fire("plugins.Xicord Traits.tasks");
eq("subscriber fires on the tasks path", fired, 1);
M.unsubscribeTargets(fn);
Store.fire("plugins.Xicord Traits.tasks");
eq("unsubscribed subscriber stops firing", fired, 1);

console.log("\n-- writes must not clobber other plugins' data --");
// Xicord Mutuals keeps an auto-managed trait with EXTRA fields in this same array.
setTasks([
    { name: "Mutual", url: "m.mp3", users: "/8", managed: true, note: { by: "mutuals" } },
    { name: "Target", url: "", users: "" },
    { name: "Friend", url: "f.mp3", users: "/9" }
]);
M.toggleTarget("99");
eq("Mutuals' extra fields survive a toggle", tasks()[0], { name: "Mutual", url: "m.mp3", users: "/8", managed: true, note: { by: "mutuals" } });
eq("unrelated traits survive a toggle", tasks()[2], { name: "Friend", url: "f.mp3", users: "/9" });
eq("trait order is preserved", tasks().map(t => t.name), ["Mutual", "Target", "Friend"]);

setTasks([{ nameless: true }, { name: "Target", url: "", users: "/1" }]);
M.toggleTarget("2");
eq("entries without a name are not dropped", tasks()[0], { nameless: true });
eq("...and the toggle still applied", M.targetIds(), ["1", "2"]);
M.ensureTargetTrait();
eq("ensureTargetTrait doesn't drop them either", tasks().length, 2);

console.log("\n-- cross-plugin format contract --");
// Mirrors of the OTHER plugins' code, so a format drift fails here.
// Xicord Traits, MenuItem() context-menu toggle:
const traitsToggle = (entry, id) => {
    const index = entry.users.split("/").indexOf(id);
    if (index === -1) entry.users += `/${id}`;
    else entry.users = entry.users.split("/").filter(u => u && u !== id).map(u => `/${u}`).join("");
};
// Xicord Traits, cb() / checkbox state:
const traitsHas = (entry, id) => entry.users.split("/").includes(id);
// Xicord Watchlist, traitUserIds():
const watchlistIds = entry => entry.users.split("/").filter(Boolean);

// Traits writes -> _targetTrait must read
S.plugins["Xicord Traits"] = { enabled: true, tasks: "[]" };
const viaTraits = { name: "Target", url: "", users: "" };
traitsToggle(viaTraits, "111");
traitsToggle(viaTraits, "222");
setTasks([viaTraits]);
eq("Traits' context-menu writes are read by _targetTrait", M.targetIds(), ["111", "222"]);
traitsToggle(viaTraits, "111");
setTasks([viaTraits]);
eq("Traits' removal is read by _targetTrait", M.targetIds(), ["222"]);

// _targetTrait writes -> Traits and Watchlist must read
setTasks([{ name: "Target", url: "", users: "" }]);
M.toggleTarget("333");
M.toggleTarget("444");
const written = tasks()[0];
eq("_targetTrait's write is read by Traits' checkbox", traitsHas(written, "333"), true);
eq("_targetTrait's write is read by Watchlist", watchlistIds(written), ["333", "444"]);
M.toggleTarget("333");
eq("...and after removal too", watchlistIds(tasks()[0]), ["444"]);
eq("Traits no longer sees the removed id", traitsHas(tasks()[0], "333"), false);

console.log("\n-- dry run of THIS install's first start (tasks unset, 3 legacy watched) --");
// Mirrors the live Vencord settings: "Xicord Traits".tasks absent, Orbit.watched has 3 ids.
S.plugins["Xicord Traits"] = { enabled: true };          // tasks genuinely unset
const legacy = ["111111111111111111", "222222222222222222", "333333333333333333"];
let watchedSetting = JSON.stringify(legacy);

// Orbit.start(): ensureTargetTrait() then migrateLegacyWatched()
M.ensureTargetTrait();
eq("Target trait is created on a fresh install", tasks(), [{ name: "Target", url: "", users: "" }]);
const parsed = JSON.parse(watchedSetting).filter(x => typeof x === "string");
M.addTargets(parsed);
watchedSetting = "[]";
eq("all 3 legacy watched users carried over", M.targetIds(), legacy);
eq("every one of them is watched", legacy.every(id => M.hasTarget(id)), true);
eq("legacy setting is cleared", watchedSetting, "[]");
// second start must be a no-op, not a duplicate
M.ensureTargetTrait();
const again = JSON.parse(watchedSetting).filter(x => typeof x === "string");
M.addTargets(again);
eq("a second start changes nothing", tasks(), [{ name: "Target", url: "", users: "/111111111111111111/222222222222222222/333333333333333333" }]);

console.log("\n-- Mutuals/Target merge: no write-feedback loop --");
// Mutuals now READS targets from the Target trait while still WRITING the
// auto-managed "Mutual" trait into the same blob. Its guard bails when target
// membership is unchanged; if a Mutual write perturbed targetIds(), that guard
// would never trip and syncMutualTrait would recurse forever.
const MUTUAL = "Mutual";
// mirror of xicordMutuals.syncMutualTrait
const syncMutual = (userId, matched) => {
    const list = M.readTraits();
    let e = list.find(t => t?.name === MUTUAL);
    if (!e) { if (!matched) return; e = { name: MUTUAL, url: "", users: "", managed: true }; list.push(e); }
    const has = e.users.split("/").includes(userId);
    if (matched && !has) e.users += `/${userId}`;
    else if (!matched && has) e.users = e.users.split("/").filter(u => u && u !== userId).map(u => `/${u}`).join("");
    else return;
    S.plugins["Xicord Traits"].tasks = JSON.stringify(list);
};

setTasks([{ name: "Target", url: "", users: "/aaa/bbb" }]);
const keyOf = () => M.targetIds().join(",");
const key0 = keyOf();
for (let i = 0; i < 25; i++) syncMutual("m" + i, true);   // scanner flags 25 mutuals
eq("25 Mutual writes leave targets untouched", keyOf(), key0);
eq("...so the recursion guard trips every time", keyOf() === key0, true);
eq("the Mutual trait really was written", M.readTraits().find(t => t.name === MUTUAL).users.split("/").filter(Boolean).length, 25);
for (let i = 0; i < 25; i++) syncMutual("m" + i, false);  // and cleared again
eq("clearing mutuals also leaves targets untouched", keyOf(), key0);
eq("Target membership survived 50 Mutual writes", M.targetIds(), ["aaa", "bbb"]);

// a real target change MUST be seen (guard must not be over-eager)
M.toggleTarget("ccc");
eq("adding a target does change the key", keyOf() !== key0, true);
eq("...to the new membership", M.targetIds(), ["aaa", "bbb", "ccc"]);

console.log("\n-- both legacy lists migrate into one trait --");
S.plugins["Xicord Traits"] = { enabled: true, tasks: "[]" };
M.ensureTargetTrait();
M.addTargets(["orbit1", "shared"]);          // Orbit.watched
M.addTargets(["mutual1", "shared"]);         // Mutuals.targets, overlapping
eq("union of both legacy lists, no duplicates", M.targetIds(), ["orbit1", "shared", "mutual1"]);
eq("one Target trait, not two", M.readTraits().filter(t => M.isTargetTrait(t?.name)).length, 1);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
