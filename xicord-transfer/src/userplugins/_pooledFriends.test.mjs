// Exercises the REAL fromPooledFriends() from _sync.tsx — the client half of sharing the
// mutual-friend scanner between users.
//   node src/userplugins/_pooledFriends.test.mjs
//
// The server has served a unioned friend graph for a while; the client threw it away. This
// is what consumes it, and the whole design turns on one rule: pooled findings go in their
// OWN store, never into your friendMap.
//
// Two things break the moment they are mixed:
//   * friendMap is what gets pushed back, so other people's findings would be re-pushed as
//     yours. Every contributor would end up vouching for everything and `sources` — the
//     only measure of how well corroborated a claim is — would degenerate to "everyone".
//   * Retraction is per-slice. Your scan losing a name retracts YOUR claim; it does not
//     falsify a contributor who can still prove it. Separate layers let both be true.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./_sync.tsx", import.meta.url), "utf8");
const JS = esbuild.transformSync(SRC, { loader: "tsx" }).code;

function fn(name) {
    const start = JS.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    let j = JS.indexOf("{", JS.indexOf(")", start)), depth = 0;
    for (; j < JS.length; j++) {
        if (JS[j] === "{") depth++;
        else if (JS[j] === "}") { depth--; if (!depth) return JS.slice(start, j + 1); }
    }
    throw new Error(`unbalanced ${name}`);
}
const isIdSrc = /const isId = [^;]+;/.exec(JS)[0];
const { fromPooledFriends, toPrivate } = new Function(
    `${isIdSrc}\n${fn("fromPooledFriends")}\n${fn("toPrivate")}\nreturn { fromPooledFriends, toPrivate };`)();

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? "\n          " + extra : ""}`); } };
const X = "444444444444444444", Y = "555555555555555555";
const A = "111111111111111111", B = "222222222222222222";
const G = "333333333333333333";
const pool = friends => ({ friends });

console.log("\n-- another contributor's findings land in the pooled store --");
let store = {};
let n = fromPooledFriends(pool({ [X]: { friends: [A, B], guilds: [G], at: 10, sources: 2 } }), store, 1);
ok("something changed", n === 1, String(n));
ok("the names came across", store[X].friends.join(",") === [A, B].join(","), JSON.stringify(store[X]));
ok("so did the servers", store[X].guilds.join(",") === G);
ok("and how many contributors vouch for it", store[X].sources === 2, String(store[X].sources));

console.log("\n-- a second identical pull is not a change --");
n = fromPooledFriends(pool({ [X]: { friends: [A, B], guilds: [G], at: 10, sources: 2 } }), store, 1);
ok("nothing to persist", n === 0, String(n));

console.log("\n-- corroboration moving is a change worth storing --");
n = fromPooledFriends(pool({ [X]: { friends: [A, B], guilds: [G], at: 10, sources: 3 } }), store, 1);
ok("a third contributor vouching is recorded", n === 1 && store[X].sources === 3, String(store[X].sources));

console.log("\n-- when the pool drops a finding, we drop it too --");
// The server removes a name once nobody vouches for it. Keeping it here would resurrect a
// claim every contributor has already retracted.
n = fromPooledFriends(pool({ [X]: { friends: [], guilds: [], at: 20, sources: 0 } }), store, 1);
ok("the entry is removed", !store[X], JSON.stringify(store));
ok("and that counts as a change", n === 1, String(n));
ok("dropping something we never had is not a change",
    fromPooledFriends(pool({ [Y]: { friends: [] } }), {}, 1) === 0);

console.log("\n-- rubbish from the wire is refused --");
store = {};
fromPooledFriends(pool({
    "not-an-id": { friends: [A] },
    [X]: { friends: [A, "", null, "nope", 12345], guilds: [G, "bad"], at: 1, sources: 1 },
    [Y]: null,
}), store, 1);
ok("a junk person id is skipped", !store["not-an-id"], Object.keys(store).join(","));
ok("junk names are filtered", store[X].friends.join(",") === A, JSON.stringify(store[X].friends));
ok("junk servers are filtered", store[X].guilds.join(",") === G);
ok("a null record is skipped", !store[Y]);
ok("an empty pool is survivable", fromPooledFriends(null, {}, 1) === 0 && fromPooledFriends({}, {}, 1) === 0);
{
    const s2 = {};
    fromPooledFriends(pool({ [X]: { friends: [A] } }), s2, 7);
    ok("a missing timestamp falls back to now", s2[X].at === 7, JSON.stringify(s2[X]));
    ok("and a missing sources count reads as a single contributor", s2[X].sources === 1, String(s2[X].sources));
}

console.log("\n-- THE invariant: pooled findings are never pushed back as ours --");
// toPrivate is what goes up. It is handed friendMap, and the pooled store is a different
// object entirely — if these were ever merged, this is the assertion that would fail.
const friendMap = { [X]: { friends: [A], guilds: [], at: 5 } };
const pooledStore = {};
fromPooledFriends(pool({ [X]: { friends: [A, B], guilds: [], at: 9, sources: 4 }, [Y]: { friends: [B], guilds: [], at: 9, sources: 2 } }), pooledStore, 1);
const payload = toPrivate(friendMap, []);
ok("the push still carries only what this machine proved",
    Object.keys(payload.friends).join(",") === X, Object.keys(payload.friends).join(","));
ok("a person known ONLY to the pool is not in the push",
    !payload.friends[Y], Object.keys(payload.friends).join(","));
ok("and a name only the pool has is not claimed as ours",
    payload.friends[X].friends.join(",") === A, JSON.stringify(payload.friends[X].friends));
ok("the pooled store is untouched by the push",
    pooledStore[X].friends.length === 2 && !!pooledStore[Y], JSON.stringify(Object.keys(pooledStore)));
ok("and friendMap was not modified by the pull",
    friendMap[X].friends.join(",") === A, JSON.stringify(friendMap[X]));

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
