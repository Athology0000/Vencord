// Exercises the REAL orderCompanions() from xicordDossier.tsx — the ordering of the
// "Calls with" list on a single person's dossier.
//   node src/userplugins/_dossierOrder.test.mjs
//
// What it is for: when you open someone's dossier, the people THEY have added should be
// at the top, most recently in a call with them first. Underneath, the list goes back to
// weight (times seen together, then time spent) — because for someone with no provable
// friendship, one recent hello should not outrank a hundred hours.
//
// The trap this guards: "nobody has scanned this person yet" (null) is not "they have
// added nobody" (an empty set). If those were conflated, an unscanned subject's list
// would silently reorder and quietly assert they have no friends in it.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordDossier.tsx", import.meta.url), "utf8");

const start = SRC.indexOf("export function orderCompanions(");
if (start < 0) throw new Error("orderCompanions not found");
// balance the parameter list, then skip the return-type annotation to the real body
let i = SRC.indexOf("(", start), pd = 0;
for (; i < SRC.length; i++) {
    if (SRC[i] === "(") pd++;
    else if (SRC[i] === ")") { pd--; if (!pd) { i++; break; } }
}
// The return type is `Array<{ ... }>`, whose braces would otherwise look like the body.
// Skip past the annotation first, exactly as the sibling suites do.
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
const js = esbuild.transformSync(SRC.slice(start, end).replace(/^export /, ""), { loader: "ts" }).code;
const orderCompanions = new Function(`${js}; return orderCompanions;`)();

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};
/** compact fixture: [id, count, ms, last] */
const c = (id, count, ms, last) => [id, { count, ms, last }];
const order = r => r.map(x => x.id).join(",");
const flags = r => r.map(x => x.id + (x.added ? "*" : "")).join(",");

console.log("\n-- people the subject has added come first --");
// heavy on calls but not a friend, vs a friend barely seen: the friend still leads
let r = orderCompanions([
    c("stranger", 100, 999999, 5000),
    c("friend", 1, 10, 1000),
], new Set(["friend"]));
ok("a proven friend outranks a much heavier stranger", order(r) === "friend,stranger", order(r));
ok("and is flagged so the row can say why", flags(r) === "friend*,stranger", flags(r));

console.log("\n-- among the added, most recently in a call wins --");
r = orderCompanions([
    c("old", 50, 50000, 1000),
    c("newest", 1, 5, 9000),
    c("middle", 20, 20000, 5000),
], new Set(["old", "newest", "middle"]));
ok("recency decides, not weight", order(r) === "newest,middle,old", order(r));
ok("even though 'old' has by far the most call time", r[2].id === "old");

console.log("\n-- below them, the old weight ordering is untouched --");
r = orderCompanions([
    c("light", 1, 10, 9000),
    c("heavy", 90, 100, 1000),
    c("medium", 40, 40, 5000),
], null);
ok("times-seen-together still leads for non-friends", order(r) === "heavy,medium,light", order(r));
r = orderCompanions([c("a", 5, 10, 1), c("b", 5, 999, 2)], null);
ok("time in call breaks a tie on count", order(r) === "b,a", order(r));

console.log("\n-- the two halves keep their own sort keys --");
r = orderCompanions([
    c("f_old", 1, 1, 2000),
    c("f_new", 1, 1, 8000),
    c("s_heavy", 99, 99, 1000),
    c("s_light", 2, 2, 9999),
], new Set(["f_old", "f_new"]));
ok("friends by recency, then strangers by weight",
    order(r) === "f_new,f_old,s_heavy,s_light", order(r));
ok("a stranger's recent call does not lift them into the added group", r[3].id === "s_light");

console.log("\n-- 'not scanned yet' must not be read as 'has added nobody' --");
// null means the sweep has not reached this person. The list must simply stay as it was.
const same = [c("heavy", 90, 90, 1000), c("recent", 1, 1, 9000)];
ok("null leaves the weight order alone", order(orderCompanions(same, null)) === "heavy,recent");
ok("undefined behaves the same", order(orderCompanions(same, undefined)) === "heavy,recent");
ok("nobody is flagged as added", orderCompanions(same, null).every(x => !x.added));
// an EMPTY set is a real answer — scanned, and they have added nobody visible
ok("an empty set is also just the weight order", order(orderCompanions(same, new Set())) === "heavy,recent");

console.log("\n-- edge cases --");
ok("no companions -> empty, not a crash", orderCompanions([], new Set(["x"])).length === 0);
ok("a friend who is not in the call list adds nothing",
    order(orderCompanions([c("a", 1, 1, 1)], new Set(["ghost"]))) === "a");
r = orderCompanions([c("z", 1, 1, 5), c("a", 1, 1, 5)], new Set(["z", "a"]));
ok("identical records tie-break stably on id", order(r) === "a,z", order(r));
r = orderCompanions([["x", { count: 3, ms: 3 }], c("y", 1, 1, 100)], new Set(["x", "y"]));
ok("a missing 'last' is treated as oldest, not as NaN", order(r) === "y,x", order(r));
ok("a record with no fields at all does not throw",
    orderCompanions([["p", {}], c("q", 1, 1, 1)], null).length === 2);

console.log("\n-- the input is not mutated --");
const input = [c("a", 1, 1, 1), c("b", 2, 2, 2)];
const before = input.map(x => x[0]).join(",");
orderCompanions(input, new Set(["a"]));
ok("the caller's array keeps its order", input.map(x => x[0]).join(",") === before, input.map(x => x[0]).join(","));

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
