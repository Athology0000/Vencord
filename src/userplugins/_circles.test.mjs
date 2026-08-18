// Exercises the REAL buildCircles() from xicordCircles.tsx.
//   node src/userplugins/_circles.test.mjs
//
// The bug it guards: mutualsOf(member) already returns mutual friends *with you*, so
// every id it yields is one of your friends by construction. The old code intersected
// that against RelationshipStore.getFriendIDs() anyway — so any moment that store came
// back empty (timing, an API rename, the plugin's own hidden-user filtering) every
// circle was filtered to nothing and the modal claimed "no connections found" even
// though the scans had all succeeded.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordCircles.tsx", import.meta.url), "utf8");

const start = SRC.indexOf("export function buildCircles(");
if (start < 0) throw new Error("buildCircles not found");
// balance the PARAMETER list first — it contains an arrow type with its own parens,
// and the return type annotation has braces that would otherwise look like the body
let i = SRC.indexOf("(", start), pd = 0;
for (; i < SRC.length; i++) {
    if (SRC[i] === "(") pd++;
    else if (SRC[i] === ")") { pd--; if (!pd) { i++; break; } }
}
// now skip the `: {...}` return type, if present, to the real body brace
if (SRC.slice(i, SRC.indexOf("{", i)).includes(":")) {
    let j = SRC.indexOf("{", i), bd = 0;
    for (; j < SRC.length; j++) {
        if (SRC[j] === "{") bd++;
        else if (SRC[j] === "}") { bd--; if (!bd) { i = j + 1; break; } }
    }
}
let body = SRC.indexOf("{", i), depth = 0, end = -1;
for (i = body; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (!depth) { end = i + 1; break; } }
}
// circleRows() feeds the graph view. It is a two-liner over buildFriendMap, and the whole
// point of it is that it is the SWEEP's row builder rather than a second one — so the
// dossier's real function is pulled in here too, from the other file, and a change to
// either side shows up as a failure rather than as two views quietly disagreeing.
const DOSSIER = readFileSync(new URL("./xicordDossier.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
function span(src, from, to) {
    const a = src.indexOf(from);
    if (a < 0) throw new Error(`marker not found: ${from}`);
    const b = src.indexOf(to, a);
    if (b < 0) throw new Error(`end marker not found: ${to}`);
    return src.slice(a, b);
}
const rowsTs = [
    span(DOSSIER, "export interface FriendRow", "interface FriendEntry"),
    span(DOSSIER, "export function buildFriendMap(", "/**\n * Fold a sweep's rows"),
    span(SRC, "export function circleRows(", "function CirclesModal("),
].join("\n").replace(/^export /gm, "");

const js = esbuild.transformSync(
    `${SRC.slice(start, end).replace(/^export /, "")}\n${rowsTs}`, { loader: "ts" }).code;
const { buildCircles, circleRows } =
    new Function(`${js}; return { buildCircles, circleRows };`)();

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};
/** mutuals lookup from a plain map; anything absent is "not scanned yet" (null) */
const lookup = map => id => (id in map ? map[id] : null);
const shape = r => r.circles.map(([f, m]) => f + ":" + m.join("+")).join(" ");

console.log("\n-- grouping members by the friend they share --");
let r = buildCircles(["m1", "m2", "m3"], lookup({ m1: ["f1"], m2: ["f1", "f2"], m3: ["f2"] }), "ME");
ok(`two circles, busiest first (${shape(r)})`, shape(r) === "f1:m1+m2 f2:m2+m3", shape(r));
ok("everyone scanned is counted", r.scanned === 3, String(r.scanned));

console.log("\n-- 'not scanned yet' is not the same as 'no mutual friends' --");
r = buildCircles(["m1", "m2"], lookup({ m1: ["f1"] }), "ME"); // m2 absent -> null
ok("an unscanned member is skipped entirely", shape(r) === "f1:m1", shape(r));
ok("and is not counted as scanned", r.scanned === 1, String(r.scanned));
r = buildCircles(["m1", "m2"], lookup({ m1: ["f1"], m2: [] }), "ME");
ok("a scanned member with genuinely no mutuals still counts as scanned", r.scanned === 2, String(r.scanned));
ok("but adds no circle", shape(r) === "f1:m1", shape(r));

console.log("\n-- you are never a member or a circle of your own --");
r = buildCircles(["ME", "m1"], lookup({ ME: ["f1"], m1: ["f1", "ME"] }), "ME");
ok("you are skipped as a member", shape(r) === "f1:m1", shape(r));
ok("you never appear as a circle head", !r.circles.some(([f]) => f === "ME"), shape(r));
ok("and you are not counted in the scanned tally", r.scanned === 1, String(r.scanned));

console.log("\n-- the regression: results are not intersected against a friend list --");
// Every id mutualsOf returns is already a friend of yours. The output must depend only
// on the scan results, so no empty/stale friend list can silently erase every circle.
r = buildCircles(["m1", "m2"], lookup({ m1: ["f_unknown"], m2: ["f_unknown"] }), "ME");
ok("a mutual that no separate friend list mentions still forms a circle",
    shape(r) === "f_unknown:m1+m2", shape(r));
ok("both members land in it", r.circles[0][1].length === 2, shape(r));

console.log("\n-- ordering and edge cases --");
r = buildCircles(["a", "b", "c", "d"], lookup({ a: ["big"], b: ["big"], c: ["big"], d: ["small"] }), "ME");
ok(`the busiest circle comes first (${r.circles[0][0]} with ${r.circles[0][1].length})`,
    r.circles[0][0] === "big" && r.circles[0][1].length === 3, shape(r));
ok("no members -> nothing, no crash", shape(buildCircles([], lookup({}), "ME")) === "");
ok("nobody scanned -> nothing, no crash", buildCircles(["m1"], () => null, "ME").circles.length === 0);
r = buildCircles(["m1"], lookup({ m1: ["f1", "f2", "f3"] }), "ME");
ok("one member can belong to several circles", r.circles.length === 3, shape(r));
ok("an undefined 'me' does not wipe the results",
    buildCircles(["m1"], lookup({ m1: ["f1"] }), undefined).circles.length === 1);

console.log("\n-- circleRows: the same scans, shaped for the graph --");
// The reason the graph exists: in the circle list a member who shares friends with three
// of your friends is printed three times, in three unconnected blocks. Here they are ONE
// row with three friends, which is what lets the layout put them between those circles.
let g = circleRows(["m1", "m2"], lookup({ m1: ["f1", "f2", "f3"], m2: ["f1"] }), "ME", "g1");
const rowShape = rows => rows.map(r => `${r.id}[${r.friends.join("+")}]@${r.guilds.join("/")}`).join(" ");
ok("a member in several circles is one row, not several",
    rowShape(g) === "m1[f1+f2+f3]@g1 m2[f1]@g1", rowShape(g));
ok("and the busiest member sorts first", g[0].id === "m1", rowShape(g));
ok("every row is tagged with the server it was found in",
    g.every(r => r.guilds.length === 1 && r.guilds[0] === "g1"), rowShape(g));

// The same pending/answered distinction the list view depends on. A row is a CLAIM that
// this person added someone, so an unanswered lookup must not produce one.
g = circleRows(["m1", "m2"], lookup({ m1: ["f1"] }), "ME", "g1");
ok("an unscanned member produces no row", rowShape(g) === "m1[f1]@g1", rowShape(g));
g = circleRows(["m1", "m2"], lookup({ m1: ["f1"], m2: [] }), "ME", "g1");
ok("a scanned member with no mutuals produces no row either", rowShape(g) === "m1[f1]@g1", rowShape(g));
g = circleRows(["ME", "m1"], lookup({ ME: ["f1"], m1: ["f1", "ME"] }), "ME", "g1");
ok("you are never a row", !g.some(r => r.id === "ME"), rowShape(g));
ok("and never one of your own friends on someone else's row",
    g.every(r => !r.friends.includes("ME")), rowShape(g));
ok("an empty server is an empty graph, not a crash", circleRows([], lookup({}), "ME", "g1").length === 0);

// The two views must agree about who was found — same scans, same people, different shape.
const scans = { a: ["f1"], b: ["f1", "f2"], c: [], d: null };
const list = buildCircles(["a", "b", "c", "d"], lookup(scans), "ME");
const graph = circleRows(["a", "b", "c", "d"], lookup(scans), "ME", "g1");
const inList = new Set(list.circles.flatMap(([, m]) => m));
ok("the graph draws exactly the members the circle list shows",
    inList.size === graph.length && graph.every(r => inList.has(r.id)),
    `${[...inList].join(",")} vs ${graph.map(r => r.id).join(",")}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
