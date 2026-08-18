// Exercises the REAL sync transforms from _sync.tsx.
//   node src/userplugins/_syncClient.test.mjs
//
// The property that matters: a round trip must not invent, lose, or double anything.
// The far side merges highest-wins, which is only correct because clients pull before
// they push — so a pushed number is a running total, not one machine's share of one.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./_sync.tsx", import.meta.url), "utf8");
const js = esbuild.transformSync(SRC.replace(/^export /gm, ""), { loader: "tsx" }).code;
const { toPool, fromPool, toPrivate, fromPrivate, pairKey, chunkPool } =
    new Function(`${js}; return { toPool, fromPool, toPrivate, fromPrivate, pairKey, chunkPool };`)();

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};

const ME = "100000000000000001", ALT = "100000000000000002";
const A = "900000000000000001", B = "900000000000000002", C = "900000000000000003";
const G = "500000000000000001";
const comp = (count, ms, last) => ({ count, ms, last });
const prof = (comps, guilds = [G], updated = 100, firstSeen = 5) => ({
    companions: comps, guilds: Object.fromEntries(guilds.map(g => [g, 1])), updated, firstSeen
});

console.log("\n-- local profiles out to the wire --");
let p = toPool({ [A]: prof({ [B]: comp(3, 65000, 90) }) }, [ME]);
ok("the pair gets one key", Object.keys(p.calls).length === 1 && p.calls[pairKey(A, B)], Object.keys(p.calls).join(","));
ok("with the recorded numbers", p.calls[pairKey(A, B)].count === 3 && p.calls[pairKey(A, B)].ms === 65000);
ok("both people are listed", !!p.people[A] && !!p.people[B], Object.keys(p.people).join(","));
ok("the server is carried", p.calls[pairKey(A, B)].guilds.join(",") === G);

console.log("-- only calls of >=1 minute are shared; briefer stay local --");
// The pool on a memory-bounded server cannot hold the long tail of one-off overlaps, and
// they are noise there. The local dossier still keeps them; toPool is the gate.
p = toPool({ [A]: prof({ [B]: comp(2, 59999, 90), [C]: comp(9, 60000, 90) }) }, [ME]);
ok("a sub-minute call is NOT pushed", !p.calls[pairKey(A, B)], Object.keys(p.calls).join(","));
ok("a >=1min call IS pushed", !!p.calls[pairKey(A, C)], Object.keys(p.calls).join(","));
ok("and its person comes with it", !!p.people[C]);
ok("a person with ONLY brief calls is not pushed at all",
   Object.keys(toPool({ [A]: prof({ [B]: comp(2, 100, 90) }) }, [ME]).people).length === 0);

console.log("\n-- your own accounts never go into the shared pool --");
p = toPool({ [ME]: prof({ [A]: comp(9, 9, 9) }), [A]: prof({ [ME]: comp(9, 9, 9), [B]: comp(1, 65000, 1) }) }, [ME, ALT]);
ok("you are not a person in the pool", !p.people[ME], Object.keys(p.people).join(","));
ok("and no pair touches you", !Object.keys(p.calls).some(k => k.includes(ME)), Object.keys(p.calls).join(","));
ok("but everyone else's pair survives", !!p.calls[pairKey(A, B)], Object.keys(p.calls).join(","));

console.log("\n-- a delta only carries what changed --");
const two = { [A]: prof({ [B]: comp(1, 65000, 1) }, [G], 50), [C]: prof({ [B]: comp(2, 66000, 2) }, [G], 500) };
p = toPool(two, [ME], 100);
ok("the stale profile is skipped", !p.calls[pairKey(A, B)], Object.keys(p.calls).join(","));
ok("the changed one is sent", !!p.calls[pairKey(C, B)], Object.keys(p.calls).join(","));
ok("a full re-sync (since 0) carries both", Object.keys(toPool(two, [ME], 0).calls).length === 2);

console.log("\n-- the wire back into local profiles --");
let local = {};
const pool = {
    people: { [A]: { guilds: [G], first: 20, last: 900 }, [B]: { guilds: [G], first: 0, last: 900 } },
    calls: { [pairKey(A, B)]: { ms: 7000, count: 4, last: 900, guilds: [G] } }
};
fromPool(pool, local, [ME], 1000);
ok("both ends of the pair gain a profile", !!local[A] && !!local[B], Object.keys(local).join(","));
ok("and each lists the other", local[A].companions[B].count === 4 && local[B].companions[A].count === 4);
ok("the server comes with it", !!local[A].guilds[G]);
ok("firstSeen takes the earliest real value", local[A].firstSeen === 20, String(local[A].firstSeen));
ok("a zero firstSeen does not overwrite", local[B].firstSeen === 0, String(local[B].firstSeen));

console.log("\n-- pulling must never LOWER a local number --");
local = { [A]: prof({ [B]: comp(10, 99999, 5000) }, [G], 5000) };
fromPool({ people: {}, calls: { [pairKey(A, B)]: { ms: 10, count: 1, last: 10, guilds: [] } } }, local, [ME], 1);
ok("a smaller remote count loses", local[A].companions[B].count === 10, String(local[A].companions[B].count));
ok("a smaller remote duration loses", local[A].companions[B].ms === 99999);
ok("and a smaller remote timestamp loses", local[A].companions[B].last === 5000);

console.log("\n-- the round trip neither invents nor doubles --");
const start = { [A]: prof({ [B]: comp(3, 65000, 90), [C]: comp(1, 61000, 20) }) };
const wire = toPool(start, [ME]);
const back = {};
fromPool(wire, back, [ME], 1);
ok("A keeps both companions", Object.keys(back[A].companions).sort().join(",") === [B, C].sort().join(","),
    Object.keys(back[A].companions).join(","));
ok("counts survive exactly", back[A].companions[B].count === 3 && back[A].companions[C].count === 1);
// pushing the pulled state back must be a no-op, or every sync would inflate
const again = toPool(back, [ME]);
ok("re-pushing the pulled state changes nothing",
    JSON.stringify(again.calls[pairKey(A, B)]) === JSON.stringify(wire.calls[pairKey(A, B)]),
    JSON.stringify(again.calls[pairKey(A, B)]));
fromPool(again, back, [ME], 2);
ok("and re-pulling does not double it", back[A].companions[B].count === 3, String(back[A].companions[B].count));

console.log("\n-- your own account is filtered on the way IN too --");
local = {};
fromPool({ people: { [ME]: { guilds: [G], first: 1, last: 2 } }, calls: { [pairKey(ME, A)]: { ms: 1, count: 1, last: 1, guilds: [] } } }, local, [ME], 1);
ok("nothing about you is imported", !local[ME] && !local[A], Object.keys(local).join(","));

console.log("\n-- junk on the wire cannot corrupt the local store --");
local = {};
fromPool({ people: { "not-an-id": { guilds: [] } }, calls: { "bad|key": { ms: 1 }, [`${A}|${A}`]: { ms: 1 } } }, local, [ME], 1);
ok("non-snowflake ids are dropped", Object.keys(local).length === 0, Object.keys(local).join(","));

console.log("\n-- the private half --");
const priv = toPrivate({ [A]: { friends: [B, "junk"], guilds: [G], at: 10 } }, [C, "nope"], { [A]: { text: "x".repeat(9000), at: 1 } });
ok("junk friend ids are dropped", priv.friends[A].friends.join(",") === B, priv.friends[A].friends.join(","));
ok("junk watch ids are dropped", priv.watching.join(",") === C, priv.watching.join(","));
ok("notes are capped", priv.notes[A].text.length === 4000, String(priv.notes[A].text.length));

const fm = { [A]: { friends: [B, C], guilds: [], at: 100 } };
fromPrivate({ friends: { [A]: { friends: [B], guilds: [], at: 200 } } }, fm);
ok("a fresher remote entry replaces, so an unfriending sticks", fm[A].friends.join(",") === B, fm[A].friends.join(","));
fromPrivate({ friends: { [A]: { friends: [B, C], guilds: [], at: 50 } } }, fm);
ok("a stale remote entry does not resurrect a removed name", fm[A].friends.join(",") === B, fm[A].friends.join(","));

console.log("\n-- a big first sync has to go up in pieces --");
// One request for everything exceeded the server's body limit and came back 413, which
// failed the WHOLE sync rather than part of it. Batching is safe because the far side
// merges additively: each batch is a valid payload and order does not matter.
{
    const big = { people: {}, calls: {}, users: {} };
    // ids built as STRINGS: 9e17 is past Number.MAX_SAFE_INTEGER, so arithmetic on
    // snowflake-sized numbers silently collides and the fixture quietly tests nothing
    const mk = n => "90000000000" + String(n).padStart(7, "0");
    for (let i = 0; i < 9000; i++) {
        const a = mk(i * 2), b = mk(i * 2 + 1);
        big.people[a] = { guilds: [G], first: 1, last: 2 };
        big.people[b] = { guilds: [G], first: 1, last: 2 };
        big.calls[pairKey(a, b)] = { ms: 10, count: 1, last: 2, guilds: [G] };
        big.users[a] = { username: "u" + i, avatar: "", at: 1 };
    }
    const parts = chunkPool(big, 4000);
    ok(`it splits (${parts.length} batches)`, parts.length >= 3, String(parts.length));
    ok("no batch exceeds the chunk size", parts.every(x => Object.keys(x.calls).length <= 4000),
        parts.map(x => Object.keys(x.calls).length).join(","));

    const seenCalls = new Set(), seenPeople = new Set();
    let dupes = 0;
    for (const part of parts) {
        for (const k of Object.keys(part.calls)) { if (seenCalls.has(k)) dupes++; seenCalls.add(k); }
        for (const id of Object.keys(part.people)) seenPeople.add(id);
    }
    ok("every call pair survives exactly once",
        seenCalls.size === Object.keys(big.calls).length && dupes === 0,
        `${seenCalls.size}/${Object.keys(big.calls).length}, ${dupes} duplicated`);
    ok("every person survives", seenPeople.size === Object.keys(big.people).length,
        `${seenPeople.size}/${Object.keys(big.people).length}`);

    // a batch must describe everyone it mentions, or the server stores a dangling pair
    let dangling = 0;
    for (const part of parts) {
        for (const k of Object.keys(part.calls)) {
            for (const id of k.split("|")) if (!part.people[id]) dangling++;
        }
    }
    ok("no batch references someone it does not also describe", dangling === 0, String(dangling));

    const named = parts.reduce((n, x) => n + Object.keys(x.users).length, 0);
    ok(`names travel with their batch (${named})`, named === Object.keys(big.users).length,
        `${named}/${Object.keys(big.users).length}`);

    // someone with no calls at all must still be sent, or they vanish from the pool
    const lonely = chunkPool({ people: { [A]: { guilds: [], first: 1, last: 1 } }, calls: {}, users: {} }, 10);
    ok("a person with no calls is still sent", lonely.some(x => x.people[A]), JSON.stringify(lonely));
    ok("a small payload is not split at all", chunkPool({ people: {}, calls: {}, users: {} }, 4000).length === 1);
}

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
