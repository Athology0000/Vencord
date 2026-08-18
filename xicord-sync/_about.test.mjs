// The pooled About layer: sanitizeAbout / pickAbout / mergeUser / sanitizePool carrying
// the richer opened-profile fields (bio, pronouns, connections, badges) through the pool.
//   node xicord-sync/_about.test.mjs
process.env.XICORD_POOL_MIN_MS = "0";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { sanitizeAbout, pickAbout, mergeUser, mergeGuild, sanitizePool, mergePoolInto } = require("./pool.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL:", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}\n   got ${JSON.stringify(a)}\n   want ${JSON.stringify(b)}`);

/* ---- sanitizeAbout ---- */
{
    const a = sanitizeAbout({
        bio: "x".repeat(1000), pronouns: "p".repeat(80),
        conns: [{ t: "steam", n: "gaben", id: "76561", v: 1 }, { t: "spotify", n: "m" }, { n: "noType" }, null],
        flags: 256, premium: 2, since: 111, boost: 222, banner: "bh", deco: "dh", at: 999
    });
    eq(a.bio.length, 600, "bio capped to 600");
    eq(a.pronouns.length, 40, "pronouns capped to 40");
    eq(a.conns, [{ t: "steam", n: "gaben", id: "76561", v: 1 }, { t: "spotify", n: "m" }], "conns kept, junk dropped");
    eq(a.flags, 256, "flags kept");
    eq(a.premium, 2, "premium kept");
    eq([a.since, a.boost], [111, 222], "since/boost kept");
    eq([a.banner, a.deco], ["bh", "dh"], "banner/deco kept");
    eq(a.at, 999, "at kept");
}
{
    ok(sanitizeAbout(null) === null, "null in -> null");
    ok(sanitizeAbout({}) === null, "empty -> null");
    ok(sanitizeAbout({ at: 5 }) === null, "only a timestamp -> null (nothing of substance)");
    ok(sanitizeAbout({ bio: "   " }) === null, "whitespace bio -> null");
    const many = sanitizeAbout({ conns: Array.from({ length: 40 }, (_, i) => ({ t: "t" + i, n: "n" + i })) });
    eq(many.conns.length, 12, "conns capped to 12");
    const nf = sanitizeAbout({ flags: "not a number", bio: "hi" });
    ok(nf.flags === undefined, "non-numeric flags dropped");
}

/* ---- pickAbout ---- */
{
    const older = { bio: "old", at: 100 }, newer = { bio: "new", at: 200 };
    eq(pickAbout(older, newer), newer, "fresher about wins");
    eq(pickAbout(newer, older), newer, "order-independent");
    eq(pickAbout(older, null), older, "one-sided (a)");
    eq(pickAbout(null, newer), newer, "one-sided (b)");
    ok(pickAbout(null, null) === null, "neither -> null");
}

/* ---- mergeUser: About is chosen independently of the name ---- */
{
    // record A: fresh About, stale name. record B: fresh name, no About.
    const A = { username: "old-name", avatar: "a1", at: 100, sat: 100, about: { bio: "kept bio", at: 500 } };
    const B = { username: "new-name", avatar: "a2", at: 300, sat: 300 };
    const m = mergeUser(A, B);
    eq(m.username, "new-name", "name: the fresher resolution wins");
    eq(m.about && m.about.bio, "kept bio", "about: a name-only newer record does NOT drop the bio");
}
{
    // both have About; the fresher About (by its own clock) wins even if its record's name is older
    const A = { username: "n", avatar: "a1", at: 400, sat: 400, about: { bio: "newer bio", at: 900 } };
    const B = { username: "n", avatar: "a2", at: 600, sat: 600, about: { bio: "older bio", at: 200 } };
    const m = mergeUser(A, B);
    eq(m.avatar, "a2", "name/avatar: the fresher record (B) wins those");
    eq(m.about.bio, "newer bio", "about: the fresher About (A's) wins independently");
}

/* ---- sanitizePool carries a sanitized About on the user record ---- */
{
    const clean = sanitizePool({
        users: {
            "123456789012345678": { username: "someone", avatar: "https://cdn/x.png", at: 5, about: { bio: "hello", flags: 64, at: 7 } },
            "223456789012345678": { username: "plain", avatar: "https://cdn/y.png", at: 5 },
            "323456789012345678": { username: "junkabout", avatar: "https://cdn/z.png", at: 5, about: { nonsense: true } }
        }
    });
    eq(clean.users["123456789012345678"].about, { bio: "hello", flags: 64, at: 7 }, "about survives sanitize on the user record");
    ok(clean.users["223456789012345678"].about === undefined, "a user with no about has none");
    ok(clean.users["323456789012345678"].about === undefined, "a junk-only about is dropped");
}

/* ---- server names pool like user names ---- */
{
    const older = { name: "Old Name", at: 100 }, newer = { name: "New Name", at: 200 };
    eq(mergeGuild(older, newer).name, "New Name", "guild: fresher name wins");
    eq(mergeGuild(newer, older).name, "New Name", "guild: order-independent");
    eq(mergeGuild(null, newer), newer, "guild: one-sided");
    const clean = sanitizePool({ guilds: { "753384735236948018": { name: "  My Server  ", at: 5 }, "999": { name: "bad id" }, "823384735236948018": { name: "" } } });
    eq(clean.guilds["753384735236948018"], { name: "My Server", at: 5 }, "guild sanitize: trims, keeps valid");
    ok(!clean.guilds["999"], "guild sanitize: rejects a non-snowflake id");
    ok(!clean.guilds["823384735236948018"], "guild sanitize: drops an empty name");
    // merges into a base pool
    const base = { people: {}, calls: {}, users: {}, voice: {}, guilds: { "753384735236948018": { name: "My Server", at: 5 } } };
    mergePoolInto(base, { guilds: { "753384735236948018": { name: "Renamed", at: 9 } } });
    eq(base.guilds["753384735236948018"].name, "Renamed", "guild: mergePoolInto takes the rename");
}

console.log(`\n${fail ? "" : "OK - "}${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
