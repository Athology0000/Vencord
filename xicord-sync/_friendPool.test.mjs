// Exercises the REAL mergeFriendGraphs() from pool.js — the friend graph becoming
// readable by every contributor rather than only its owner.
//   node xicord-sync/_friendPool.test.mjs
//
// Why this is sound, when the note at the top of pool.js says account-relative data
// cannot be pooled: getMutuals(X) returns friends(asker) ∩ friends(X), so every name it
// yields is one X genuinely added. Two accounts see two different SLICES of the same true
// set. Their union is still entirely true — just less incomplete. What stays forbidden is
// merging by count, and reading a missing name as "X has not added them".
//
// The property that must not regress: retraction. The union is computed over the
// per-owner blobs, so an unfriending removes a name from its owner's slice and leaves the
// union as soon as nobody is left vouching for it — not before, and not never.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { mergeFriendGraphs, mergePrivate } = require("./pool.js");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};
const A = "111111111111111111", B = "222222222222222222", C = "333333333333333333";
const X = "444444444444444444", G = "555555555555555555", G2 = "666666666666666666";
const blob = friends => ({ friends });
const of = (out, id) => (out[id] ? out[id].friends.slice().sort().join(",") : "");

console.log("\n-- two contributors' slices union into a fuller picture --");
let out = mergeFriendGraphs([
    blob({ [X]: { friends: [A], guilds: [G], at: 10 } }),
    blob({ [X]: { friends: [B], guilds: [G2], at: 20 } }),
]);
ok("both contributors' names are present", of(out, X) === [A, B].sort().join(","), of(out, X));
ok("neither slice alone would have said that", out[X].friends.length === 2);
ok("servers union too", out[X].guilds.sort().join(",") === [G, G2].sort().join(","));
ok("the freshest timestamp wins", out[X].at === 20, String(out[X].at));
ok("and it records how many contributors vouch for the person", out[X].sources === 2, String(out[X].sources));

console.log("\n-- the same fact from two contributors is not counted twice --");
out = mergeFriendGraphs([
    blob({ [X]: { friends: [A], guilds: [G], at: 1 } }),
    blob({ [X]: { friends: [A], guilds: [G], at: 2 } }),
]);
ok("one name, not two", of(out, X) === A, of(out, X));
ok("one server, not two", out[X].guilds.length === 1);

console.log("\n-- retraction survives pooling --");
// The union is taken over the per-owner blobs, so an unfriend has to remove the name from
// its owner's slice first. mergePrivate is what does that, and it is fresher-wins.
let ownerSlice = mergePrivate(
    blob({ [X]: { friends: [A, B], guilds: [G], at: 10 } }),
    blob({ [X]: { friends: [A], guilds: [G], at: 20 } }));
ok("the owner's own slice drops the unfriended name",
    ownerSlice.friends[X].friends.join(",") === A, JSON.stringify(ownerSlice.friends[X].friends));
out = mergeFriendGraphs([ownerSlice]);
ok("with nobody else vouching, it leaves the pooled view too", of(out, X) === A, of(out, X));
out = mergeFriendGraphs([ownerSlice, blob({ [X]: { friends: [B], guilds: [], at: 5 } })]);
ok("but it survives while another contributor can still prove it",
    of(out, X) === [A, B].sort().join(","), of(out, X));

console.log("\n-- a stale slice cannot outvote a fresher one within one owner --");
ownerSlice = mergePrivate(
    blob({ [X]: { friends: [A], guilds: [], at: 100 } }),
    blob({ [X]: { friends: [A, B], guilds: [], at: 50 } }));
ok("the older push does not re-add a dropped name",
    ownerSlice.friends[X].friends.join(",") === A, JSON.stringify(ownerSlice.friends[X].friends));

console.log("\n-- only real ids get in --");
out = mergeFriendGraphs([blob({
    [X]: { friends: [A, "", null, "notanid", 12345], guilds: [G, "nope"], at: 1 },
    "not-a-snowflake": { friends: [A], at: 1 },
})]);
ok("junk names are dropped", of(out, X) === A, of(out, X));
ok("junk servers are dropped", out[X].guilds.join(",") === G);
ok("a junk person id is dropped entirely", !out["not-a-snowflake"], Object.keys(out).join(","));

console.log("\n-- nothing to merge --");
ok("no blobs at all", Object.keys(mergeFriendGraphs([])).length === 0);
ok("undefined is survivable", Object.keys(mergeFriendGraphs(undefined)).length === 0);
ok("a blob with no friends section", Object.keys(mergeFriendGraphs([{}, null, blob(null)])).length === 0);
ok("a person with an empty friend list still appears, and says so", (() => {
    const o = mergeFriendGraphs([blob({ [X]: { friends: [], guilds: [G], at: 3 } })]);
    return o[X] && o[X].friends.length === 0;
})());

console.log("\n-- many contributors --");
out = mergeFriendGraphs(Array.from({ length: 25 }, (_, i) =>
    blob({ [X]: { friends: [A], guilds: [], at: i } })));
ok("25 contributors asserting the same name give one name", of(out, X) === A);
ok("but the source count reflects all of them", out[X].sources === 25, String(out[X].sources));
ok("and the newest timestamp wins", out[X].at === 24, String(out[X].at));

console.log("\n-- the merge does not mutate its inputs --");
const input = blob({ [X]: { friends: [A], guilds: [G], at: 1 } });
mergeFriendGraphs([input, blob({ [X]: { friends: [B], guilds: [G2], at: 2 } })]);
ok("the caller's blob is untouched",
    input.friends[X].friends.join(",") === A && input.friends[X].guilds.join(",") === G,
    JSON.stringify(input.friends[X]));

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
