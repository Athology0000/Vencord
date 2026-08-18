/*
 * Merge rules for the SHARED pool: facts that are true regardless of who saw them.
 *
 * A person exists, is in these servers, and shared a voice channel with someone for this
 * long, most recently then. Every client that witnessed it recorded the same thing, so
 * these pool across contributors — and, as in v1, combine by taking the highest rather
 * than by adding, because two clients that watched the same call each hold the whole of
 * it and summing would double it.
 *
 * Account-relative data (mutual friends, watchlists, notes) is NOT here. It lives in the
 * per-user blob, because asking two accounts about the same person yields two different
 * true answers and merging them produces one false one.
 */

/** A finite number, or null for absent. Coerces "5"; rejects "", booleans, "1e999". */
function num(v) {
    if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}
function maxNum(a, b) {
    const x = num(a), y = num(b);
    if (x === null) return y === null ? 0 : y;
    if (y === null) return x;
    return x > y ? x : y;
}
/** Earliest wins; 0/absent means "unknown" and must never beat a real timestamp. */
function minStamp(a, b) {
    const x = num(a), y = num(b);
    const xs = x !== null && x > 0 ? x : Infinity;
    const ys = y !== null && y > 0 ? y : Infinity;
    const out = xs < ys ? xs : ys;
    return out === Infinity ? 0 : out;
}
const isSnowflake = s => typeof s === "string" && /^\d{5,25}$/.test(s);
// Minimum call duration POOLED (ms). Sub-threshold overlaps stay local only. Env-overridable
// so storage/merge tests exercise the pool with tiny fixtures; production default is 1 minute.
function poolMinMs() { return process.env.XICORD_POOL_MIN_MS != null ? Number(process.env.XICORD_POOL_MIN_MS) : 60000; }

/** Sorted so a pair has exactly one key however the two ids arrive. */
function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

function unionIds(a = [], b = []) {
    const out = [];
    for (const v of [...a, ...b]) if (isSnowflake(v) && !out.includes(v)) out.push(v);
    return out;
}

/**
 * `sat` — when the SERVER accepted this record, stamped on arrival and merged by highest.
 *
 * Every other stamp here is a client's account of when something happened out in the
 * world. That is the wrong clock to answer "what is new to you?" with: a call that ended
 * at 12:00 and syncs at 12:07 has last=12:00, so a puller holding a 12:05 watermark would
 * filter it out — on that pull and on every pull after, because 12:00 never becomes newer.
 * A record can arrive long after it happened; a delta has to key on the arrival.
 *
 * It also covers the merges that change something OTHER than `last` — a newly unioned
 * guild, an earlier `first` — which would otherwise never appear in a delta at all.
 */
function mergePerson(a = {}, b = {}) {
    return {
        guilds: unionIds(a.guilds, b.guilds),
        first: minStamp(a.first, b.first),
        last: maxNum(a.last, b.last),
        sat: maxNum(a.sat, b.sat)
    };
}

function mergeCall(a = {}, b = {}) {
    return {
        ms: maxNum(a.ms, b.ms),
        count: maxNum(a.count, b.count),
        last: maxNum(a.last, b.last),
        guilds: unionIds(a.guilds, b.guilds),
        sat: maxNum(a.sat, b.sat)
    };
}

/**
 * A name is objective — the same whoever looks it up — so it pools like everything else
 * here. The fresher resolution wins, which is how a rename eventually reaches everyone.
 * Without this the shared view is nothing but snowflakes.
 */
// A server's name pools like a user's: objective, and the freshest resolution wins so a
// rename eventually reaches everyone. The arrival stamp is the later of the two regardless.
function mergeGuild(a, b) {
    if (!a) return b;
    if (!b) return a;
    const win = (b.at ?? 0) > (a.at ?? 0) ? b : a;
    const sat = maxNum(a.sat, b.sat);
    return sat === (win.sat ?? 0) ? win : { ...win, sat };
}

/** The fresher About by its OWN clock, or whichever side has one. See mergeUser. */
function pickAbout(x, y) {
    if (!x) return y || null;
    if (!y) return x;
    return (y.at ?? 0) >= (x.at ?? 0) ? y : x;
}
function mergeUser(a, b) {
    if (!a) return b;
    if (!b) return a;
    const win = (b.at ?? 0) > (a.at ?? 0) ? b : a;
    // The name that wins is the fresher RESOLUTION; the arrival stamp is the later of the
    // two regardless, or re-sending an old name would hide the record from deltas.
    const sat = maxNum(a.sat, b.sat);
    // About carries its OWN timestamp and is chosen INDEPENDENTLY of the name: a name gets
    // re-resolved without re-opening the profile, and an About re-captured without the name
    // changing. Tying them would let a name-only update silently drop a bio. So merge the
    // two separately and reunite them.
    const about = pickAbout(a.about, b.about);
    const out = sat === (win.sat ?? 0) ? { ...win } : { ...win, sat };
    if (about) out.about = about; else delete out.about;
    return out;
}

// ---------------------------------------------------------------------------
// The voice timeline
// ---------------------------------------------------------------------------
// `calls` is voice ARITHMETIC — how long two people have shared a room, in total. It
// merges by maximum, because a running sum from a client that is behind is still not
// wrong, just smaller. This is voice HISTORY, and a maximum cannot express it: two joins
// an hour apart are two facts, not a bigger version of one. So it merges as a SET.
//
// Every contributor stamps a transition with its own clock as the dispatch arrives, so
// the same join is recorded at slightly different instants by each machine watching it.
// Identity is therefore the event floored into a fixed bucket — a pure function of the
// record, so every contributor and this server derive it independently and agree. A
// tolerance window would have been kinder to events near a boundary and is not available
// here: it depends on which record arrives first, and this merge has to be commutative
// and associative or mergePoolInto() is invalid. Must stay in step with voiceKey() in the
// client's _sync.tsx — the two are one wire format described twice.
const VOICE_BUCKET_MS = 5000;
const MAX_VOICE_EVENTS = 100;
const VOICE_ACTS = new Set(["joined", "left", "moved"]);

function voiceKey(e) {
    return `${e.act}|${e.ch || ""}|${e.old || ""}|${Math.floor((e.at || 0) / VOICE_BUCKET_MS)}`;
}

/** One wire event, or null. The shape has to describe something, or it is not storable. */
function cleanVoiceEvent(e) {
    if (!e || typeof e !== "object") return null;
    const act = String(e.act);
    if (!VOICE_ACTS.has(act)) return null;
    const at = num(e.at);
    if (!(at > 0)) return null;
    const ch = isSnowflake(e.ch) ? e.ch : null;
    const old = isSnowflake(e.old) ? e.old : null;
    if (act === "joined" && !ch) return null;
    if (act === "left" && !old) return null;
    if (act === "moved" && (!ch || !old)) return null;
    return { act, ch, old, at };
}

/**
 * Union two people's timelines, newest first, capped.
 *
 * The EARLIER stamp wins a collision: `min` is commutative and associative, so which
 * contributor's slice folded in first cannot change the stored record.
 */
function mergeVoicePerson(a = {}, b = {}) {
    const byKey = new Map();
    for (const raw of [...(a.events || []), ...(b.events || [])]) {
        const e = cleanVoiceEvent(raw);
        if (!e) continue;
        const k = voiceKey(e);
        const have = byKey.get(k);
        if (!have || e.at < have.at) byKey.set(k, e);
    }
    const events = [...byKey.values()].sort((x, y) => y.at - x.at).slice(0, MAX_VOICE_EVENTS);
    return {
        events,
        last: maxNum(a.last, b.last),
        sat: maxNum(a.sat, b.sat)
    };
}

/** Combine two pool slices. Commutative and idempotent. */
function mergePool(a = {}, b = {}) {
    const out = { people: {}, calls: {}, users: {}, voice: {}, guilds: {} };
    const ga = a.guilds || {}, gb = b.guilds || {};
    for (const id of new Set([...Object.keys(ga), ...Object.keys(gb)])) out.guilds[id] = mergeGuild(ga[id], gb[id]);
    const pa = a.people || {}, pb = b.people || {};
    for (const id of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
        out.people[id] = mergePerson(pa[id], pb[id]);
    }
    const ca = a.calls || {}, cb = b.calls || {};
    for (const k of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
        out.calls[k] = mergeCall(ca[k], cb[k]);
    }
    const ua = a.users || {}, ub = b.users || {};
    for (const id of new Set([...Object.keys(ua), ...Object.keys(ub)])) {
        out.users[id] = mergeUser(ua[id], ub[id]);
    }
    const va = a.voice || {}, vb = b.voice || {};
    for (const id of new Set([...Object.keys(va), ...Object.keys(vb)])) {
        out.voice[id] = mergeVoicePerson(va[id], vb[id]);
    }
    return out;
}

function mergeAllPools(slices) {
    // A single slice IS already the merged pool — re-keying it into a fresh accumulator
    // would hold a whole second copy for no change in the answer. On this deployment one
    // contributor's slice is the bulk of the pool, so that copy was a big share of the
    // per-request peak that OOM-killed a 1GB container. Use it directly. (sliceWithLog has
    // already ensured the {people,calls,users,voice} shape, so nothing is missing.)
    if (slices.length === 1) return slices[0];
    const out = { people: {}, calls: {}, users: {}, voice: {} };
    // Folded IN PLACE. `mergePool` allocates a fresh result and re-keys the union of both
    // sides, so accumulating with it costs the size of the whole pool once per slice — on
    // the cold rebuild, which is the path that was exhausting the container. Merging into
    // the accumulator costs the size of each SLICE instead, for the same answer: the merge
    // is highest-wins on every field, so it does not care how the records are grouped.
    for (const s of slices) mergePoolInto(out, s);
    return out;
}

/**
 * Apply one slice INTO an already-merged pool, in place.
 *
 * mergePool() rebuilds the whole thing to combine two pools, which is what you want for a
 * cold merge and badly wrong for absorbing a push: the cost is the size of the POOL, not
 * of the push, so a client sending a few hundred pairs made the server re-key 118k of
 * them. Doing it in place is the size of the push instead.
 *
 * Equivalent to re-merging from disk because the merge is highest-wins on every field —
 * associative and commutative, so the order slices arrive in cannot change the result.
 * That is the same property that lets clients push in batches. If it ever stops holding,
 * this optimisation stops being valid with it.
 */
function mergePoolInto(base, delta) {
    const pb = delta.people || {};
    for (const id in pb) base.people[id] = mergePerson(base.people[id], pb[id]);
    const cb = delta.calls || {};
    for (const k in cb) base.calls[k] = mergeCall(base.calls[k], cb[k]);
    const ub = delta.users || {};
    if (!base.users) base.users = {};
    for (const id in ub) base.users[id] = mergeUser(base.users[id], ub[id]);
    const vb = delta.voice || {};
    if (!base.voice) base.voice = {};
    for (const id in vb) base.voice[id] = mergeVoicePerson(base.voice[id], vb[id]);
    const gb = delta.guilds || {};
    if (!base.guilds) base.guilds = {};
    for (const id in gb) base.guilds[id] = mergeGuild(base.guilds[id], gb[id]);
    return base;
}

/**
 * The opened-profile capture, re-validated on the way in. Every field is bounded exactly
 * as the client bounds it, because a bio is user-controlled free text and a third-party or
 * older client cannot be trusted to have capped it. Returns null when nothing survives, so
 * an empty About is never stored.
 */
function sanitizeAbout(a) {
    if (!a || typeof a !== "object") return null;
    const out = {};
    if (typeof a.bio === "string" && a.bio.trim()) out.bio = a.bio.slice(0, 600);
    if (typeof a.pronouns === "string" && a.pronouns.trim()) out.pronouns = a.pronouns.slice(0, 40);
    if (Array.isArray(a.conns) && a.conns.length) {
        const conns = [];
        for (const c of a.conns) {
            if (!c || typeof c !== "object") continue;
            const t = typeof c.t === "string" ? c.t.slice(0, 32) : "";
            const n = typeof c.n === "string" ? c.n.slice(0, 100) : "";
            if (!t || !n) continue;
            const rec = { t, n };
            if (typeof c.id === "string" && c.id) rec.id = c.id.slice(0, 100);
            if (c.v === 1 || c.v === true) rec.v = 1;
            conns.push(rec);
            if (conns.length >= 12) break;
        }
        if (conns.length) out.conns = conns;
    }
    const flags = num(a.flags); if (flags) out.flags = flags;
    const premium = num(a.premium); if (premium) out.premium = premium;
    const since = num(a.since); if (since && since > 0) out.since = since;
    const boost = num(a.boost); if (boost && boost > 0) out.boost = boost;
    if (typeof a.banner === "string" && a.banner) out.banner = a.banner.slice(0, 64);
    if (typeof a.deco === "string" && a.deco) out.deco = a.deco.slice(0, 64);
    const has = out.bio || out.pronouns || out.conns || out.flags || out.premium || out.since || out.boost || out.banner || out.deco;
    if (!has) return null;
    const at = num(a.at); out.at = at && at > 0 ? at : 0;
    return out;
}

/** Reject anything that is not the shape we store. */
function sanitizePool(payload) {
    const out = { people: {}, calls: {}, users: {}, voice: {}, guilds: {} };
    if (!payload || typeof payload !== "object") return out;

    for (const [id, p] of Object.entries(payload.people || {})) {
        if (!isSnowflake(id) || !p || typeof p !== "object") continue;
        out.people[id] = {
            guilds: unionIds(Array.isArray(p.guilds) ? p.guilds : [], []),
            first: minStamp(p.first, 0),
            last: maxNum(p.last, 0)
        };
    }
    for (const [k, c] of Object.entries(payload.calls || {})) {
        if (typeof k !== "string" || !c || typeof c !== "object") continue;
        const [a, b] = k.split("|");
        // rebuild the key rather than trusting it: an unsorted or malformed one would
        // silently create a second record for a pair that already has one
        if (!isSnowflake(a) || !isSnowflake(b) || a === b) continue;
        // Only relationships of at least a minute are POOLED. Enforced server-side, not
        // just in the client, so an old or third-party client cannot refill the pool with
        // the long tail of one-off sub-minute overlaps — which is what grew it past what a
        // 1GB container can build and OOM-crash-looped it. Briefer calls stay purely local.
        if (maxNum(c.ms, 0) < poolMinMs()) continue;
        const key = pairKey(a, b);
        const rec = {
            ms: maxNum(c.ms, 0),
            count: maxNum(c.count, 0),
            last: maxNum(c.last, 0),
            guilds: unionIds(Array.isArray(c.guilds) ? c.guilds : [], [])
        };
        out.calls[key] = out.calls[key] ? mergeCall(out.calls[key], rec) : rec;
    }
    for (const [id, u] of Object.entries(payload.users || {})) {
        if (!isSnowflake(id) || !u || typeof u !== "object") continue;
        const username = typeof u.username === "string" ? u.username.slice(0, 128) : "";
        if (!username) continue;
        const avatar = typeof u.avatar === "string" && /^https?:\/\//.test(u.avatar) ? u.avatar.slice(0, 512) : "";
        const rec = { username, avatar, at: maxNum(u.at, 0) };
        const about = sanitizeAbout(u.about);
        if (about) rec.about = about;
        out.users[id] = rec;
    }
    for (const [id, v] of Object.entries(payload.voice || {})) {
        if (!isSnowflake(id) || !v || typeof v !== "object") continue;
        // Through the merge rather than straight in, so one push carrying the same
        // transition twice is already deduped and capped by the time it is stored.
        const rec = mergeVoicePerson({ events: Array.isArray(v.events) ? v.events : [] }, {});
        if (!rec.events.length) continue;
        // `last` is recomputed rather than trusted: a client claiming a future one would
        // otherwise sit permanently at the top of every timeline.
        rec.last = rec.events[0].at;
        delete rec.sat;
        out.voice[id] = rec;
    }
    for (const [id, g] of Object.entries(payload.guilds || {})) {
        if (!isSnowflake(id) || !g || typeof g !== "object") continue;
        const name = (typeof g.name === "string" ? g.name : "").slice(0, 100).trim();
        if (!name) continue;
        out.guilds[id] = { name, at: maxNum(g.at, 0) };
    }
    return out;
}

/**
 * Tombstones as `{ id: whenRetracted }`.
 *
 * Accepts the wire form (an array of ids, stamped `now` because the client is telling us
 * about it as it happens) and the stored form (already a map), so a blob written by an
 * older build still reads.
 */
function stampRetractions(value, now) {
    const out = {};
    if (Array.isArray(value)) {
        for (const id of value) if (isSnowflake(id)) out[id] = now;
    } else if (value && typeof value === "object") {
        for (const [id, at] of Object.entries(value)) {
            if (!isSnowflake(id)) continue;
            // an unparseable stamp still retracts; it just cannot outrank anything
            out[id] = maxNum(at, 0);
        }
    }
    return out;
}

/**
 * The private blob: account-relative, never merged across users, but a device still
 * pushes deltas of it, so it merges with ITS OWN previous state.
 */
function sanitizePrivate(payload, now = Date.now()) {
    const out = { friends: {}, watching: [], notes: {}, retracted: {} };
    if (!payload || typeof payload !== "object") return out;
    // Explicit tombstones. A push carries the client's whole friend map, but a BLOB can be
    // shared by several accounts, so the server cannot treat any one push as the complete
    // set and replace — that would wipe the other account's findings. Omission therefore
    // cannot mean "delete", and a retraction needs to be said out loud.
    //
    // Stamped with the SERVER's clock on arrival and kept, rather than applied once and
    // forgotten. A tombstone that does not outlive its own push is not a tombstone: the
    // other account on the blob still holds the name, and its next routine push — carrying
    // an OLD `at` it has no reason to have changed — would put the retracted name straight
    // back. Keeping the stamp lets a genuine re-friend (a newer `at`) win while a stale
    // re-assertion loses.
    out.retracted = stampRetractions(payload.retracted, now);

    for (const [id, f] of Object.entries(payload.friends || {})) {
        if (!isSnowflake(id) || !f || typeof f !== "object") continue;
        out.friends[id] = {
            friends: unionIds(Array.isArray(f.friends) ? f.friends : [], []),
            guilds: unionIds(Array.isArray(f.guilds) ? f.guilds : [], []),
            at: maxNum(f.at, 0)
        };
    }
    if (Array.isArray(payload.watching)) out.watching = unionIds(payload.watching, []);
    for (const [id, n] of Object.entries(payload.notes || {})) {
        if (!isSnowflake(id) || !n || typeof n !== "object") continue;
        const text = typeof n.text === "string" ? n.text.slice(0, 4000) : "";
        if (!text) continue;
        out.notes[id] = { text, at: maxNum(n.at, 0) };
    }
    return out;
}

/**
 * Merge a private delta into the owner's existing blob.
 *
 * `friends` takes the FRESHER entry wholesale rather than unioning the lists: an
 * unfriending has to be able to remove a name, and a union could never delete one.
 */
function mergePrivate(a = {}, b = {}) {
    const out = { friends: {}, watching: [], notes: {}, retracted: {} };
    const fa = a.friends || {}, fb = b.friends || {};
    // Every tombstone this blob has ever been told about, newest stamp winning. These are
    // KEPT in the blob, not consumed by the merge that first saw them — see sanitizePrivate.
    const ra = stampRetractions(a.retracted, 0), rb = stampRetractions(b.retracted, 0);
    for (const id of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
        out.retracted[id] = maxNum(ra[id], rb[id]);
    }
    for (const id of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
        const x = fa[id], y = fb[id];
        const winner = !x ? y : !y ? x : ((y.at ?? 0) >= (x.at ?? 0) ? y : x);
        // A retraction beats any claim that is not strictly newer than it. Re-adding
        // someone genuinely (a fresh `at`) still works; re-asserting a name the pusher
        // simply has not noticed is gone does not.
        const tomb = out.retracted[id] ?? 0;
        if (tomb > 0 && (winner?.at ?? 0) <= tomb) continue;
        out.friends[id] = winner;
    }
    // the watchlist is whatever the newer push says, so removals stick
    out.watching = Array.isArray(b.watching) && b.watching.length ? unionIds(b.watching, [])
        : unionIds(a.watching || [], []);
    const na = a.notes || {}, nb = b.notes || {};
    for (const id of new Set([...Object.keys(na), ...Object.keys(nb)])) {
        const x = na[id], y = nb[id];
        out.notes[id] = !x ? y : !y ? x : ((y.at ?? 0) >= (x.at ?? 0) ? y : x);
    }
    return out;
}

/**
 * Every contributor's friend graph, unioned into one.
 *
 * The note at the top of this file says account-relative data cannot be pooled, because
 * two accounts give two different answers about the same person. That is right about
 * merging by COUNT and right about reading absence as denial — but not about this union.
 * `getMutuals(X)` returns `friends(asker) ∩ friends(X)`, so every name it yields is one X
 * genuinely added. Two accounts see two different SLICES of the same true set, and their
 * union is still entirely true, just less incomplete.
 *
 * So: union across owners, never max or sum. What you must NOT do is read a missing name
 * as "X has not added them" — it only ever means nobody who could see it has looked.
 *
 * Retraction still works, and this is why the per-owner blobs stay the storage: an
 * unfriending removes the name from that owner's slice (mergePrivate, fresher-wins), and
 * it leaves the union as soon as no remaining contributor still vouches for it. A name
 * survives exactly as long as somebody can still prove it, which is the correct answer.
 */
function mergeFriendGraphs(blobs) {
    const out = {};
    for (const blob of blobs || []) {
        for (const [id, f] of Object.entries((blob && blob.friends) || {})) {
            if (!isSnowflake(id) || !f) continue;
            const friends = Array.isArray(f.friends) ? f.friends.filter(isSnowflake) : [];
            const guilds = Array.isArray(f.guilds) ? f.guilds.filter(isSnowflake) : [];
            const prev = out[id];
            if (!prev) {
                // `sources` is what makes a claim auditable: a name in here is only as
                // good as the number of contributors still standing behind it.
                out[id] = { friends: unionIds(friends, []), guilds: unionIds(guilds, []), at: maxNum(f.at, 0), sources: 1 };
                continue;
            }
            prev.friends = unionIds(prev.friends, friends);
            prev.guilds = unionIds(prev.guilds, guilds);
            prev.at = maxNum(prev.at, f.at);
            prev.sources++;
        }
    }
    return out;
}

module.exports = {
    mergePool, mergeAllPools, mergePoolInto, mergeCall, mergePerson, mergeUser, mergeGuild, sanitizePool, sanitizeAbout, pickAbout,
    sanitizePrivate, mergePrivate, mergeFriendGraphs, stampRetractions,
    mergeVoicePerson, cleanVoiceEvent, voiceKey, VOICE_BUCKET_MS, MAX_VOICE_EVENTS,
    pairKey, isSnowflake, maxNum, minStamp
};
