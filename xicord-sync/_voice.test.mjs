// The voice timeline, end to end against a REAL server instance.
//   node xicord-sync/_voice.test.mjs
//
// `calls` is voice ARITHMETIC — a running total that merges by maximum. This is voice
// HISTORY, and it merges as a SET, which is a different kind of record with different
// ways to be wrong:
//
//   * two contributors both watching the same join, so the pooled timeline shows it once
//     per person who happened to be online — the outcome that would make pooling the
//     timeline worse than not pooling it;
//   * a merge that depends on which slice folded in first, which would quietly invalidate
//     the append-and-replay storage the whole server is built on;
//   * a timeline that never reaches a delta, so a contributor who joined late never
//     learns anything that happened before their first full pull;
//   * a client stamping its own `sat` or a future `last` and pinning itself to the top of
//     everybody's timeline forever.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { spawn } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { mergeVoicePerson, sanitizePool, mergePool, mergePoolInto, voiceKey, MAX_VOICE_EVENTS }
    = require("./pool.js");

// The CLIENT's half of the wire format, so the round trip below is the real path rather
// than hand-written payloads that happen to agree with the server.
const esbuild = require("C:/Users/aeare/Desktop/Vencord/node_modules/esbuild");
const CLIENT_SRC = readFileSync("C:/Users/aeare/Desktop/Vencord/src/userplugins/_sync.tsx", "utf8");
const clientJs = esbuild.transformSync(CLIENT_SRC.replace(/^export /gm, ""), { loader: "tsx" }).code;
const { toVoice, fromVoice } = new Function(`${clientJs}; return { toVoice, fromVoice };`)();

const OWNER = "1400000000000000001";
const A = "900000000000000001", B = "900000000000000002";
const CH1 = "700000000000000001", CH2 = "700000000000000002";
const T = 1_700_000_000_000;
const ev = (act, ch, old, at) => ({ act, ch, old, at });
const tl = (...events) => ({ events, last: Math.max(...events.map(e => e.at)) });

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? "\n          " + extra : ""}`); } };

console.log("\n-- the merge is a SET, not a maximum --");
let m = mergeVoicePerson(tl(ev("joined", CH1, null, T)), tl(ev("left", null, CH1, T + 60_000)));
ok("two different events both survive", m.events.length === 2, JSON.stringify(m.events));
ok("newest first", m.events[0].act === "left", m.events[0].act);

console.log("\n-- two contributors watching the same join record it once --");
m = mergeVoicePerson(tl(ev("joined", CH1, null, T)), tl(ev("joined", CH1, null, T + 900)));
ok("the two observations collapse", m.events.length === 1, JSON.stringify(m.events));
ok("and the earlier clock wins", m.events[0].at === T, String(m.events[0].at));
ok("whichever order the slices arrive in",
    mergeVoicePerson(tl(ev("joined", CH1, null, T + 900)), tl(ev("joined", CH1, null, T))).events[0].at === T);

console.log("\n-- commutative, associative, idempotent: what append-and-replay needs --");
const s1 = tl(ev("joined", CH1, null, T));
const s2 = tl(ev("moved", CH2, CH1, T + 60_000));
const s3 = tl(ev("left", null, CH2, T + 120_000));
const fwd = mergeVoicePerson(mergeVoicePerson(s1, s2), s3);
const rev = mergeVoicePerson(s3, mergeVoicePerson(s2, s1));
ok("folding order cannot change the answer",
    JSON.stringify(fwd.events) === JSON.stringify(rev.events),
    `${JSON.stringify(fwd.events)}\n          ${JSON.stringify(rev.events)}`);
ok("replaying a slice already applied changes nothing",
    JSON.stringify(mergeVoicePerson(fwd, s2).events) === JSON.stringify(fwd.events));

console.log("\n-- a timeline is capped, newest kept --");
const flood = { events: Array.from({ length: MAX_VOICE_EVENTS + 40 }, (_, i) => ev("joined", CH1, null, T + i * 10_000)), last: 0 };
m = mergeVoicePerson(flood, {});
ok("the cap holds", m.events.length === MAX_VOICE_EVENTS, String(m.events.length));
ok("and it is the newest that survive",
    m.events[0].at === T + (MAX_VOICE_EVENTS + 39) * 10_000, String(m.events[0].at));

console.log("\n-- a push cannot describe itself --");
let clean = sanitizePool({ voice: { [A]: { events: [ev("joined", CH1, null, T)], last: 9e15, sat: 5 } } });
ok("a claimed `last` is recomputed from the events", clean.voice[A].last === T, String(clean.voice[A].last));
ok("a claimed arrival stamp is stripped — only the server sets that",
    clean.voice[A].sat === undefined, JSON.stringify(clean.voice[A]));

console.log("\n-- garbage is refused at the door --");
clean = sanitizePool({
    voice: {
        "not-an-id": tl(ev("joined", CH1, null, T)),
        [A]: { events: [ev("joined", CH1, null, T), ev("bogus", CH1, null, T), null, ev("joined", null, null, T)], last: T },
        [B]: { events: [] },
        "900000000000000009": "nonsense",
    }
});
ok("a non-snowflake person is dropped", !clean.voice["not-an-id"], Object.keys(clean.voice).join(","));
ok("unreadable events are dropped, readable ones kept", clean.voice[A].events.length === 1, JSON.stringify(clean.voice[A]));
ok("a person with nothing left is not stored", !clean.voice[B], Object.keys(clean.voice).join(","));
ok("a non-object timeline is dropped", !clean.voice["900000000000000009"], Object.keys(clean.voice).join(","));
ok("a payload with no voice at all is still a valid pool",
    JSON.stringify(sanitizePool({ people: {}, calls: {}, users: {} }).voice) === "{}");

console.log("\n-- slices written before the timeline existed still merge --");
const legacy = { people: {}, calls: {}, users: {} };   // no `voice` key at all
ok("mergePool tolerates it", JSON.stringify(mergePool(legacy, { voice: { [A]: tl(ev("joined", CH1, null, T)) } }).voice[A].events.length) === "1");
const base = { people: {}, calls: {}, users: {} };
mergePoolInto(base, { voice: { [A]: tl(ev("joined", CH1, null, T)) } });
ok("and so does the in-place fold, creating the section", !!base.voice?.[A], JSON.stringify(base.voice));

// ---------------------------------------------------------------------------
// Against a real server
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "xicord-voice-"));
mkdirSync(join(dir, "auth"), { recursive: true });
writeFileSync(join(dir, "auth", "tokens.json"), JSON.stringify({ tok: { user: OWNER, at: 1 } }));

const PORT = 8912;
const srv = spawn(process.execPath, ["server.js"], {
    cwd: "C:/Users/aeare/Desktop/Vencord/xicord-sync",
    env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), XICORD_TOKENS: "", XICORD_ALIASES: "" },
    stdio: ["ignore", "pipe", "pipe"],
});
let srvLog = ""; srv.stdout.on("data", d => { srvLog += d; }); srv.stderr.on("data", d => { srvLog += d; });

const url = `http://127.0.0.1:${PORT}`;
const call = async (path, body) => {
    const res = await fetch(url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: "Bearer tok", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
};
const until = async fn => {
    for (let i = 0; i < 60; i++) { try { if (await fn()) return true; } catch { } await new Promise(r => setTimeout(r, 200)); }
    return false;
};

try {
    if (!await until(async () => (await fetch(url + "/v1/health")).ok)) throw new Error("no server:\n" + srvLog);

    console.log("\n-- a pushed timeline comes back on a pull --");
    let r = await call("/v1/pool", { people: {}, calls: {}, users: {}, voice: { [A]: tl(ev("joined", CH1, null, T)) } });
    ok("the push is accepted", r.status === 200 && r.body.ok, JSON.stringify(r.body));
    ok("and counted as a timeline", r.body.accepted.voice === 1, JSON.stringify(r.body.accepted));

    let full = await call("/v1/pool");
    ok("a full pull carries it", full.body.voice?.[A]?.events?.length === 1, JSON.stringify(full.body.voice));

    console.log("\n-- a push of ONLY a timeline is not treated as empty --");
    // The empty-push shortcut skips the whole read-merge-write. A timeline arriving with
    // no people and no calls is the normal case here — it would have been silently dropped.
    r = await call("/v1/pool", { people: {}, calls: {}, users: {}, voice: { [B]: tl(ev("joined", CH2, null, T + 1000)) } });
    full = await call("/v1/pool");
    ok("the second person's timeline landed too", !!full.body.voice?.[B], Object.keys(full.body.voice || {}).join(","));

    console.log("\n-- a second contributor's view of the same join does not double it --");
    await call("/v1/pool", { people: {}, calls: {}, users: {}, voice: { [A]: tl(ev("joined", CH1, null, T + 700)) } });
    full = await call("/v1/pool");
    ok("still one event", full.body.voice[A].events.length === 1, JSON.stringify(full.body.voice[A]));
    ok("stamped with the earlier observation", full.body.voice[A].events[0].at === T, String(full.body.voice[A].events[0].at));

    console.log("\n-- a genuinely later event extends the timeline --");
    await call("/v1/pool", { people: {}, calls: {}, users: {}, voice: { [A]: tl(ev("left", null, CH1, T + 300_000)) } });
    full = await call("/v1/pool");
    ok("now two events", full.body.voice[A].events.length === 2, JSON.stringify(full.body.voice[A].events));
    ok("newest first", full.body.voice[A].events[0].act === "left");

    console.log("\n-- deltas: a timeline reaches a client that pulls incrementally --");
    const mark = full.body.syncedAt;
    let d = await call(`/v1/pool?since=${mark}`);
    ok("an unchanged pool yields no timelines", Object.keys(d.body.voice || {}).length === 0,
        JSON.stringify(Object.keys(d.body.voice || {})));

    // The event itself is OLD — a client observed it hours ago and is only syncing now.
    // Keyed on the record's own clock this would be filtered out of this delta and every
    // later one; keyed on arrival, it lands.
    await call("/v1/pool", { people: {}, calls: {}, users: {}, voice: { [A]: tl(ev("moved", CH2, CH1, T - 3_600_000)) } });
    d = await call(`/v1/pool?since=${mark}`);
    ok("a long-past event that has only just arrived is still delivered",
        !!d.body.voice?.[A], JSON.stringify(Object.keys(d.body.voice || {})));
    ok("and the whole capped history rides along, not just the new event",
        d.body.voice[A].events.length === 3, JSON.stringify(d.body.voice[A].events.map(e => e.act)));
    ok("the untouched person is NOT in the delta", !d.body.voice[B], Object.keys(d.body.voice).join(","));

    console.log("\n-- chained deltas lose nothing --");
    let mark2 = (await call("/v1/pool")).body.syncedAt;
    const seen = new Set();
    for (let i = 0; i < 3; i++) {
        const id = `90000000000000002${i}`;
        await call("/v1/pool", { people: {}, calls: {}, users: {}, voice: { [id]: tl(ev("joined", CH1, null, T + i * 60_000)) } });
        const step = await call(`/v1/pool?since=${mark2}`);
        Object.keys(step.body.voice || {}).forEach(k => seen.add(k));
        mark2 = step.body.syncedAt;
    }
    const finalFull = await call("/v1/pool");
    ok("every timeline in the full pull was seen across the deltas",
        Object.keys(finalFull.body.voice).every(k => seen.has(k) || k === A || k === B),
        `missed: ${Object.keys(finalFull.body.voice).filter(k => !seen.has(k) && k !== A && k !== B).join(",")}`);

    // Everything above pushes payloads written by hand in this file, which only proves the
    // server agrees with the test. This is the actual path: a client's own log, through
    // the client's own transform, over the wire, and back into a DIFFERENT client's log.
    console.log("\n-- round trip: one client's log arrives in another client's --");
    const MINE = "100000000000000009";
    const W = "900000000000000031";
    const observed = [
        { userId: W, action: "joined", channelId: CH1, oldChannelId: null, at: T + 1_000_000 },
        { userId: W, action: "moved", channelId: CH2, oldChannelId: CH1, at: T + 1_600_000 },
        { userId: MINE, action: "joined", channelId: CH1, oldChannelId: null, at: T + 1_000_000 },
    ];
    const mark3 = (await call("/v1/pool")).body.syncedAt;
    r = await call("/v1/pool", { people: {}, calls: {}, users: {}, voice: toVoice(observed, [MINE]) });
    ok("the client's own transform is accepted by the server", r.status === 200 && r.body.ok, JSON.stringify(r.body));

    const delta = await call(`/v1/pool?since=${mark3}`);
    const otherClient = [];
    const gained = fromVoice(delta.body.voice, otherClient);
    ok("a second client gains both events", gained === 2, `${gained}: ${JSON.stringify(otherClient)}`);
    ok("in order, newest first", otherClient[0].action === "moved", otherClient[0].action);
    ok("flagged as somebody else's observation", otherClient.every(e => e.pooled === true), JSON.stringify(otherClient));
    ok("and the pushing client's OWN account never made it into the pool",
        !otherClient.some(e => e.userId === MINE), JSON.stringify(otherClient.map(e => e.userId)));

    // The second client syncs again a minute later and must not re-add what it has.
    const again = fromVoice((await call(`/v1/pool?since=${mark3}`)).body.voice, otherClient);
    ok("pulling the same delta twice adds nothing", again === 0, String(again));

    console.log("\n-- a malformed push cannot break the pool --");
    r = await call("/v1/pool", { voice: { [A]: { events: [{ act: "exploded" }] }, bad: 5 } });
    ok("it is accepted and ignored rather than failing the sync", r.status === 200, String(r.status));
    full = await call("/v1/pool");
    ok("the real history is untouched", full.body.voice[A].events.length === 3, JSON.stringify(full.body.voice[A].events.map(e => e.act)));
    ok("the identity of every stored event is still derivable",
        full.body.voice[A].events.every(e => typeof voiceKey(e) === "string" && voiceKey(e).length > 4));
} finally {
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
