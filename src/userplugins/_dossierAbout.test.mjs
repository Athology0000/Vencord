// Extracts the REAL profile-enrichment layer (buildAbout / mergeAbout / bannerHashOf /
// toMs) from xicordDossier.tsx and checks that the richer opened-profile fields Discord
// returns (bio, pronouns, connected accounts, badges, Nitro/boost) are captured, capped
// and merged correctly, from BOTH the normalised store shape and the raw dispatch shape.
//   node src/userplugins/_dossierAbout.test.mjs
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordDossier.tsx", import.meta.url), "utf8");

// the pure block: toMs / bannerHashOf / buildAbout / mergeAbout / aboutSig, verbatim.
// Stops before captureAbout, which touches the live Discord stores.
const start = SRC.indexOf("// A timestamp Discord may hand back");
const end = SRC.indexOf("/** Read the live stores");
if (start < 0 || end < 0) { console.error("markers not found - did the source move?"); process.exit(1); }
const slice = SRC.slice(start, end).replace(/^export /gm, "");
const js = esbuild.transformSync(slice, { loader: "ts" }).code;

const build = new Function(`
    const MAX_BIO = 600, MAX_PRONOUNS = 40, MAX_CONNS = 12;
    ${js}
    return { toMs, bannerHashOf, buildAbout, mergeAbout, aboutSig };
`);
const { toMs, bannerHashOf, buildAbout, mergeAbout, aboutSig } = build();

/* ---------- tiny harness ---------- */
let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("FAIL:", msg); } }
function eq(a, b, msg) { const A = JSON.stringify(a), B = JSON.stringify(b); ok(A === B, `${msg}\n   got ${A}\n   want ${B}`); }

const NOW = 1_700_000_000_000;

/* ---------- 1. normalised store shape ---------- */
{
    const user = { publicFlags: 256, avatarDecorationData: { asset: "deco_asset_1" }, banner: "userbannerhash" };
    const profile = {
        bio: "hello world",
        pronouns: "they/them",
        connectedAccounts: [
            { type: "steam", name: "gaben", id: "76561", verified: true },
            { type: "spotify", name: "musiclover" }
        ],
        premiumType: 2,
        premiumSince: "2021-01-01T00:00:00.000Z",
        premiumGuildSince: "2022-06-01T00:00:00.000Z"
    };
    const a = buildAbout(user, profile, NOW);
    ok(a, "normalised: returns a capture");
    eq(a.bio, "hello world", "normalised: bio");
    eq(a.pronouns, "they/them", "normalised: pronouns");
    eq(a.conns, [{ t: "steam", n: "gaben", id: "76561", v: 1 }, { t: "spotify", n: "musiclover" }], "normalised: conns (verified->v:1, unverified omitted)");
    eq(a.flags, 256, "normalised: flags from user.publicFlags");
    eq(a.premium, 2, "normalised: premium tier");
    eq(a.since, Date.parse("2021-01-01T00:00:00.000Z"), "normalised: nitro since -> ms");
    eq(a.boost, Date.parse("2022-06-01T00:00:00.000Z"), "normalised: boost since -> ms");
    eq(a.deco, "deco_asset_1", "normalised: avatar decoration asset");
    eq(a.banner, "userbannerhash", "normalised: bare banner hash kept");
    eq(a.at, NOW, "normalised: timestamp");
}

/* ---------- 2. raw dispatch shape (snake_case, nested user_profile) ---------- */
{
    const raw = {
        connected_accounts: [{ type: "github", name: "octocat", id: "1" }],
        premium_type: 1,
        premium_since: "2020-05-05T00:00:00.000Z",
        user_profile: { bio: "raw bio", pronouns: "she/her", flags: 64 }
    };
    const a = buildAbout(null, raw, NOW);
    ok(a, "raw: returns a capture");
    eq(a.bio, "raw bio", "raw: nested bio");
    eq(a.pronouns, "she/her", "raw: nested pronouns");
    eq(a.conns, [{ t: "github", n: "octocat", id: "1" }], "raw: connected_accounts");
    eq(a.premium, 1, "raw: premium_type");
    eq(a.flags, 64, "raw: nested flags");
    eq(a.since, Date.parse("2020-05-05T00:00:00.000Z"), "raw: premium_since -> ms");
}

/* ---------- 3. caps and hygiene ---------- */
{
    const longBio = "x".repeat(1000);
    const manyConns = Array.from({ length: 40 }, (_, i) => ({ type: "t" + i, name: "n" + i }));
    const a = buildAbout({}, { bio: longBio, pronouns: "p".repeat(200), connectedAccounts: manyConns }, NOW);
    eq(a.bio.length, 600, "cap: bio truncated to MAX_BIO");
    eq(a.pronouns.length, 40, "cap: pronouns truncated to MAX_PRONOUNS");
    eq(a.conns.length, 12, "cap: conns truncated to MAX_CONNS");
}

/* ---------- 4. skips junk / empties ---------- */
{
    ok(buildAbout(null, null, NOW) === null, "empty: null when nothing to store");
    ok(buildAbout({}, {}, NOW) === null, "empty: null for empty objects");
    const a = buildAbout({}, { connectedAccounts: [{ type: "steam" }, { name: "noType" }, null, { type: "x", name: "y" }] }, NOW);
    eq(a.conns, [{ t: "x", n: "y" }], "conns: entries missing type or name are dropped");
    ok(buildAbout({}, { bio: "   " }, NOW) === null, "empty: whitespace-only bio is not stored");
}

/* ---------- 5. banner hash extraction ---------- */
{
    eq(bannerHashOf("https://cdn.discordapp.com/banners/123/abc123def.png?size=480"), "abc123def", "banner: hash pulled from URL");
    eq(bannerHashOf("barehash"), "barehash", "banner: bare hash kept");
    eq(bannerHashOf(""), "", "banner: empty -> empty");
    eq(bannerHashOf(null), "", "banner: non-string -> empty");
}

/* ---------- 6. toMs ---------- */
{
    eq(toMs(1700), 1700, "toMs: positive number kept");
    eq(toMs(0), 0, "toMs: zero -> 0");
    eq(toMs(-5), 0, "toMs: negative -> 0");
    eq(toMs("2021-01-01T00:00:00.000Z"), Date.parse("2021-01-01T00:00:00.000Z"), "toMs: ISO string parsed");
    eq(toMs("not a date"), 0, "toMs: garbage -> 0");
    eq(toMs(undefined), 0, "toMs: undefined -> 0");
}

/* ---------- 7. mergeAbout: partial capture must not erase ---------- */
{
    const prev = { bio: "old bio", pronouns: "they/them", flags: 8, at: NOW - 1000 };
    // a later capture where the profile fetch had not landed (no bio/pronouns), only user flags
    const next = { flags: 16, at: NOW };
    const m = mergeAbout(prev, next);
    eq(m.bio, "old bio", "merge: missing bio backfilled from prev");
    eq(m.pronouns, "they/them", "merge: missing pronouns backfilled from prev");
    eq(m.flags, 16, "merge: present field takes the newer value");
    eq(m.at, NOW, "merge: timestamp is the newer capture's");
}
{
    const next = { bio: "fresh", at: NOW };
    eq(mergeAbout(undefined, next), next, "merge: no prev -> next as-is");
}

/* ---------- 8. aboutSig ignores the timestamp ---------- */
{
    const a = { bio: "b", pronouns: "p", flags: 1, at: 111 };
    const b = { bio: "b", pronouns: "p", flags: 1, at: 999 };
    ok(aboutSig(a) === aboutSig(b), "sig: two captures differing only in `at` are equal");
    const c = { bio: "different", pronouns: "p", flags: 1, at: 111 };
    ok(aboutSig(a) !== aboutSig(c), "sig: a real content change is not equal");
}

/* ---------- report ---------- */
console.log(`\n${failed ? "" : "OK - "}${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
