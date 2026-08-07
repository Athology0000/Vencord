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

/** Sorted so a pair has exactly one key however the two ids arrive. */
function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

function unionIds(a = [], b = []) {
    const out = [];
    for (const v of [...a, ...b]) if (isSnowflake(v) && !out.includes(v)) out.push(v);
    return out;
}

function mergePerson(a = {}, b = {}) {
    return {
        guilds: unionIds(a.guilds, b.guilds),
        first: minStamp(a.first, b.first),
        last: maxNum(a.last, b.last)
    };
}

function mergeCall(a = {}, b = {}) {
    return {
        ms: maxNum(a.ms, b.ms),
        count: maxNum(a.count, b.count),
        last: maxNum(a.last, b.last),
        guilds: unionIds(a.guilds, b.guilds)
    };
}

/**
 * A name is objective — the same whoever looks it up — so it pools like everything else
 * here. The fresher resolution wins, which is how a rename eventually reaches everyone.
 * Without this the shared view is nothing but snowflakes.
 */
function mergeUser(a, b) {
    if (!a) return b;
    if (!b) return a;
    return (b.at ?? 0) > (a.at ?? 0) ? b : a;
}

/** Combine two pool slices. Commutative and idempotent. */
function mergePool(a = {}, b = {}) {
    const out = { people: {}, calls: {}, users: {} };
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
    return out;
}

function mergeAllPools(slices) {
    let out = { people: {}, calls: {}, users: {} };
    for (const s of slices) out = mergePool(out, s);
    return out;
}

/** Reject anything that is not the shape we store. */
function sanitizePool(payload) {
    const out = { people: {}, calls: {}, users: {} };
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
        out.users[id] = { username, avatar, at: maxNum(u.at, 0) };
    }
    return out;
}

/**
 * The private blob: account-relative, never merged across users, but a device still
 * pushes deltas of it, so it merges with ITS OWN previous state.
 */
function sanitizePrivate(payload) {
    const out = { friends: {}, watching: [], notes: {} };
    if (!payload || typeof payload !== "object") return out;

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
    const out = { friends: {}, watching: [], notes: {} };
    const fa = a.friends || {}, fb = b.friends || {};
    for (const id of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
        const x = fa[id], y = fb[id];
        if (!x) { out.friends[id] = y; continue; }
        if (!y) { out.friends[id] = x; continue; }
        out.friends[id] = (y.at ?? 0) >= (x.at ?? 0) ? y : x;
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

module.exports = {
    mergePool, mergeAllPools, mergeCall, mergePerson, mergeUser, sanitizePool,
    sanitizePrivate, mergePrivate, pairKey, isSnowflake, maxNum, minStamp
};
