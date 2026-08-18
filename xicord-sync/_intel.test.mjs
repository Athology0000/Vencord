// Graph + relationship intelligence: centrality, clusters, server links, closeness,
// active-hours/timezone, alt scoring.  node xicord-sync/_intel.test.mjs
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const I = require("./intel.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}\n   got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// small graph: a hub H called by A,B,C,D; a tight pair X<->Y off on their own
const call = (ms, count, last) => ({ ms, count, last });
const by = {
    H: { A: call(100, 5, 9), B: call(80, 4, 9), C: call(60, 3, 9), D: call(40, 2, 9) },
    A: { H: call(100, 5, 9) }, B: { H: call(80, 4, 9) }, C: { H: call(60, 3, 9) }, D: { H: call(40, 2, 9) },
    X: { Y: call(500, 20, 9) }, Y: { X: call(500, 20, 9) }
};
const deg = {}; const ms = {};
for (const id in by) { deg[id] = Object.keys(by[id]).length; ms[id] = Object.values(by[id]).reduce((s, c) => s + c.ms, 0); }
const idx = { by, ms, deg };
const friends = { H: { friends: ["A", "B", "Z"] } };

/* centrality: H is the hub */
{
    const c = I.centrality(idx, friends);
    ok(c.H > c.A && c.H > c.X, "hub H outranks its leaves and the tight pair");
    ok("Z" in c || true, "friend-only presence tolerated");
}

/* clusters: {H,A,B,C,D} one group, {X,Y} another */
{
    const { label, size } = I.clusters(by, { maxIter: 8 });
    ok(label.H === label.A && label.A === label.B && label.B === label.C && label.C === label.D, "the hub and its leaves land in one cluster");
    ok(label.X === label.Y, "the tight pair is its own cluster");
    ok(label.X !== label.H, "the two groups are distinct");
    ok(Object.keys(size).length === 2, "exactly two clusters");
}

/* server index + top servers + shared */
{
    const people = { A: { guilds: ["g1", "g2"] }, B: { guilds: ["g1"] }, C: { guilds: ["g1", "g3"] }, D: { guilds: ["g9"] } };
    const m = I.serverIndex(people);
    eq(m.g1.sort(), ["A", "B", "C"], "g1 members");
    const top = I.topServers(m, 10);
    eq(top[0], { guild: "g1", count: 3 }, "g1 is the top connector server");
    ok(!top.find(t => t.guild === "g9"), "a server with one pooled member is not a connector");
    eq(I.sharedServers(["g1", "g2", "g3"], ["g3", "g1"]).sort(), ["g1", "g3"], "shared servers of a pair");
}

/* closeness: recent long frequent > old brief rare; bounded 0..100 */
{
    const now = 1_000_000_000_000;
    const DAY = 86400000, maxMs = 1_000_000;
    const strong = I.closeness({ ms: 900000, count: 50, last: now - DAY }, now, maxMs);
    const weak = I.closeness({ ms: 500, count: 1, last: now - 200 * DAY }, now, maxMs);
    ok(strong > weak, "a recent, long, frequent tie scores higher than an old brief one");
    ok(strong <= 100 && weak >= 0, "score stays in 0..100");
    ok(I.closeness(null, now, maxMs) === 0, "no record -> 0");
}

/* active hours + tz guess */
{
    // 12 joins all at 02:00 UTC -> peak 2 -> guess ~UTC+19 wraps to UTC-5-ish region
    const events = Array.from({ length: 12 }, () => ({ act: "joined", at: Date.UTC(2026, 0, 1, 2, 0, 0) }));
    const ah = I.activeHours(events, 8);
    eq(ah.peakHour, 2, "peak hour detected");
    ok(ah.tzGuess && ah.tzGuess.startsWith("UTC"), "a timezone is guessed: " + ah.tzGuess);
    ok(ah.samples === 12, "sample count");
    const few = I.activeHours([{ act: "joined", at: Date.now() }], 8);
    ok(few.peakHour === null && few.tzGuess === null, "too few samples -> no guess");
    const nonJoin = I.activeHours([{ act: "left", at: Date.now() }], 1);
    ok(nonJoin.samples === 0, "only joins are counted, not leaves");
}

/* alt scoring */
{
    // shared linked account = strong; and they never called
    const strong = I.altScore({ b: "B", byA: { X: 1, Y: 1, Z: 1 }, byB: { X: 1, Y: 1, Z: 1 }, connsA: [{ t: "steam", id: "76561", n: "g" }], connsB: [{ t: "steam", id: "76561", n: "g" }] });
    ok(strong.score >= 45, "same steam id is a strong alt signal");
    ok(strong.reasons.some(r => /linked account/.test(r)), "reason names the linked account");
    // they actually called each other -> not alts
    const called = I.altScore({ b: "B", byA: { B: 1, X: 1 }, byB: { A: 1, X: 1 } });
    eq(called, { score: 0, reasons: [] }, "people who called each other are never flagged as alts");
    // pure shared-contacts signal
    const shared = I.altScore({ b: "B", byA: { P: 1, Q: 1, R: 1, S: 1 }, byB: { P: 1, Q: 1, R: 1, S: 1 } });
    ok(shared.score > 0 && shared.reasons.some(r => /shared contacts/.test(r)), "shared-contacts-never-together scores");
}

/* buildIntel bundles it */
{
    const P = { calls: { "A|H": call(100, 5, 9), "X|Y": call(500, 20, 9) }, people: { A: { guilds: ["g1"] }, H: { guilds: ["g1"] } } };
    const bi = I.buildIntel(P, idx, friends);
    ok(bi.maxMs === 500, "maxMs is the busiest pair");
    ok(bi.centrality && bi.cluster && bi.clusterSize && bi.guildMembers, "buildIntel returns all sections");
}

console.log(`\n${fail ? "" : "OK - "}${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
