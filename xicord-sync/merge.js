/*
 * Merge rules for the pooled Xicord dossier.
 *
 * The dossier stores running TALLIES, not events: "3× together, 2h in call". Two PCs that
 * both witnessed the same call each hold count:1 for it, so adding them gives 2 — wrong.
 * Highest-wins is the only safe combination.
 *
 * Max is correct ONLY because every client pulls before it pushes: after a pull, a PC's
 * counters already include what every other PC contributed, so its number is the pooled
 * running total rather than one machine's partial view. Break that coupling and max
 * silently discards whichever PC was used least. Do not "optimise" the pull away.
 */

/**
 * A number if it can be one, otherwise null for "absent".
 *
 * Coerces numeric strings, because a client that sends "5" means 5 and silently storing 0
 * would lose real history. Everything that is not a finite number — null, "", booleans,
 * "abc", "1e999" — is absent, not zero, so it can never beat a real value.
 */
function num(v) {
    if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

/** Larger wins; absent counts as absent rather than as zero. */
function maxNum(a, b) {
    const x = num(a), y = num(b);
    if (x === null) return y === null ? 0 : y;
    if (y === null) return x;
    return x > y ? x : y;
}

/**
 * Earliest wins, but 0/absent means "unknown" and must never beat a real timestamp —
 * otherwise one device that never recorded a first sighting would zero the field for
 * everyone.
 */
function minStamp(a, b) {
    const x = num(a), y = num(b);
    const xs = x !== null && x > 0 ? x : Infinity;
    const ys = y !== null && y > 0 ? y : Infinity;
    const out = xs < ys ? xs : ys;
    return out === Infinity ? 0 : out;
}

function mergeCompanion(a = {}, b = {}) {
    return {
        count: maxNum(a.count, b.count),
        ms: maxNum(a.ms, b.ms),
        last: maxNum(a.last, b.last)
    };
}

function mergeGame(a = {}, b = {}) {
    return {
        ms: maxNum(a.ms, b.ms),
        sessions: maxNum(a.sessions, b.sessions),
        last: maxNum(a.last, b.last)
    };
}

/** Combine one person's dossier record from two devices. */
function mergeProfile(a = {}, b = {}) {
    const out = {
        companions: {},
        guilds: {},
        firstSeen: minStamp(a.firstSeen, b.firstSeen),
        updated: maxNum(a.updated, b.updated)
    };
    for (const key of new Set([...Object.keys(a.companions || {}), ...Object.keys(b.companions || {})])) {
        out.companions[key] = mergeCompanion((a.companions || {})[key], (b.companions || {})[key]);
    }
    for (const key of new Set([...Object.keys(a.guilds || {}), ...Object.keys(b.guilds || {})])) {
        out.guilds[key] = maxNum((a.guilds || {})[key], (b.guilds || {})[key]);
    }
    const games = new Set([...Object.keys(a.games || {}), ...Object.keys(b.games || {})]);
    if (games.size) {
        out.games = {};
        for (const key of games) out.games[key] = mergeGame((a.games || {})[key], (b.games || {})[key]);
    }
    return out;
}

/** Newer resolution wins, so a rename eventually propagates everywhere. */
function mergeUser(a, b) {
    if (!a) return b;
    if (!b) return a;
    return (b.at ?? 0) > (a.at ?? 0) ? b : a;
}

/**
 * Combine two whole payloads: `{ dossiers, users }`. Commutative and idempotent, so the
 * order devices are folded in never changes the result and re-pushing changes nothing.
 */
function mergeSnapshot(a = {}, b = {}) {
    const out = { dossiers: {}, users: {} };
    const da = a.dossiers || {}, db = b.dossiers || {};
    for (const id of new Set([...Object.keys(da), ...Object.keys(db)])) {
        out.dossiers[id] = mergeProfile(da[id], db[id]);
    }
    const ua = a.users || {}, ub = b.users || {};
    for (const id of new Set([...Object.keys(ua), ...Object.keys(ub)])) {
        out.users[id] = mergeUser(ua[id], ub[id]);
    }
    return out;
}

/** Fold every device's slice into the pooled view. */
function mergeAll(slices) {
    let out = { dossiers: {}, users: {} };
    for (const s of slices) out = mergeSnapshot(out, s);
    return out;
}

/**
 * Reject anything that isn't the shape we store. A malformed push must not be able to
 * write junk keys, prototype pollution, or unbounded nesting into the pooled data.
 */
function sanitize(payload) {
    const out = { dossiers: {}, users: {} };
    if (!payload || typeof payload !== "object") return out;

    const dossiers = payload.dossiers;
    if (dossiers && typeof dossiers === "object") {
        for (const [id, p] of Object.entries(dossiers)) {
            if (!/^\d{5,25}$/.test(id) || !p || typeof p !== "object") continue;
            const prof = { companions: {}, guilds: {}, firstSeen: 0, updated: 0 };
            for (const [c, rec] of Object.entries(p.companions || {})) {
                if (!/^\d{5,25}$/.test(c) || !rec || typeof rec !== "object") continue;
                prof.companions[c] = {
                    count: maxNum(rec.count, 0),
                    ms: maxNum(rec.ms, 0),
                    last: maxNum(rec.last, 0)
                };
            }
            for (const [g, n] of Object.entries(p.guilds || {})) {
                if (!/^\d{5,25}$/.test(g)) continue;
                prof.guilds[g] = maxNum(n, 0);
            }
            if (p.games && typeof p.games === "object") {
                const games = {};
                for (const [n, rec] of Object.entries(p.games)) {
                    if (typeof n !== "string" || n.length > 200 || !rec || typeof rec !== "object") continue;
                    games[n] = { ms: maxNum(rec.ms, 0), sessions: maxNum(rec.sessions, 0), last: maxNum(rec.last, 0) };
                }
                if (Object.keys(games).length) prof.games = games;
            }
            prof.firstSeen = minStamp(p.firstSeen, 0);
            prof.updated = maxNum(p.updated, 0);
            out.dossiers[id] = prof;
        }
    }

    const users = payload.users;
    if (users && typeof users === "object") {
        for (const [id, u] of Object.entries(users)) {
            if (!/^\d{5,25}$/.test(id) || !u || typeof u !== "object") continue;
            const username = typeof u.username === "string" ? u.username.slice(0, 128) : "";
            if (!username) continue;
            const avatar = typeof u.avatar === "string" && /^https?:\/\//.test(u.avatar) ? u.avatar.slice(0, 512) : "";
            out.users[id] = { username, avatar, at: maxNum(u.at, 0) };
        }
    }
    return out;
}

module.exports = { mergeSnapshot, mergeAll, mergeProfile, mergeUser, sanitize, maxNum, minStamp };
