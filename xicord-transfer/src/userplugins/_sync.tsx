/*
MIT License — Copyright (c) 2026 Xicord

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software, subject to the MIT terms. THE SOFTWARE IS PROVIDED "AS IS",
WITHOUT WARRANTY OF ANY KIND.
*/

/**
 * Talking to the Xicord Sync service.
 *
 * Two stores, because they behave differently:
 *
 *   POOL     objective — who shared a voice channel with whom, where, for how long.
 *            True whoever observed it, so it pools across every contributor.
 *   PRIVATE  account-relative — the friend graph, the watchlist, the notes. Discord
 *            answers "mutual friends" from whoever is asking, so this is only ever
 *            meaningful from one vantage point and is never pooled.
 *
 * The merge on the far side is highest-wins, which is only correct because every client
 * PULLS BEFORE IT PUSHES: after a pull, a machine's counters already include what every
 * other machine contributed, so the maximum is the running total rather than one
 * machine's partial view. Do not reorder those two steps.
 */

export interface PoolCall { ms: number; count: number; last: number; guilds: string[]; }
export interface PoolPerson { guilds: string[]; first: number; last: number; }
// `about` is the richer opened-profile capture (bio, pronouns, connections, badges,
// Nitro/boost, banner, decoration) — see the About type in xicordDossier. Optional and
// sparse: it rides on a user record only for people whose profile was actually opened.
export interface PoolAbout { bio?: string; pronouns?: string; conns?: Array<{ t: string; n: string; id?: string; v?: 1; }>; flags?: number; premium?: number; since?: number; boost?: number; banner?: string; deco?: string; at: number; }
export interface PoolUser { username: string; avatar: string; at: number; about?: PoolAbout; }
/** One observed voice transition. `ch`/`old` are channel ids; either may be null. */
export interface PoolVoiceEvent { act: "joined" | "left" | "moved"; ch: string | null; old: string | null; at: number; }
export interface PoolVoicePerson { events: PoolVoiceEvent[]; last: number; }
export interface PoolPayload {
    people: Record<string, PoolPerson>;
    calls: Record<string, PoolCall>;
    // Names are objective — the same whoever looks them up — so they pool with the rest.
    // Without them a shared view is a list of snowflakes and nothing else.
    users: Record<string, PoolUser>;
    /**
     * Voice TIMELINE, as opposed to `calls`, which is voice ARITHMETIC.
     *
     * `calls` answers "how long have these two been in a room together, in total" — a
     * running sum, so it merges by taking the maximum and any client can be behind
     * without being wrong. This answers "when did they join, and where", which a maximum
     * cannot express: two joins an hour apart are two facts, not a bigger version of one.
     * So it merges as a SET.
     *
     * Pooled for the same reason calls are: a join is objective. It happened whoever was
     * watching, and only one contributor has to have been online to see it.
     */
    voice?: Record<string, PoolVoicePerson>;
}
export interface PrivatePayload {
    friends: Record<string, { friends: string[]; guilds: string[]; at: number; }>;
    watching: string[];
    notes: Record<string, { text: string; at: number; }>;
    /** People this machine can no longer prove anything about — explicit tombstones. */
    retracted?: string[];
}

/** Sorted, so a pair has exactly one key however the two ids arrive. */
export function pairKey(a: string, b: string) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

const isId = (s: any) => typeof s === "string" && /^\d{5,25}$/.test(s);

/**
 * Local dossier profiles into the wire shape.
 *
 * `since` keeps a routine push to the handful of people who actually changed; pass 0 for
 * the full re-sync. Your own accounts are dropped: you are in every call you join, so
 * including yourself would make you a hub joined to everyone and say nothing.
 */
export function toPool(
    profiles: Record<string, any>,
    mine: string[],
    since = 0,
    names: Record<string, { username: string; avatar: string; at?: number; }> = {}
): PoolPayload {
    const people: Record<string, PoolPerson> = {};
    const calls: Record<string, PoolCall> = {};
    const skip = new Set(mine.filter(Boolean));

    const touch = (id: string, guilds: string[], last: number, first = 0) => {
        const p = people[id] || (people[id] = { guilds: [], first: 0, last: 0 });
        for (const g of guilds) if (isId(g) && !p.guilds.includes(g)) p.guilds.push(g);
        if (last > p.last) p.last = last;
        if (first > 0 && (p.first === 0 || first < p.first)) p.first = first;
    };

    for (const [id, prof] of Object.entries(profiles || {})) {
        if (!isId(id) || skip.has(id)) continue;
        if ((prof?.updated ?? 0) <= since) continue;          // unchanged since the last push
        const guilds = Object.keys(prof?.guilds ?? {}).filter(isId);
        // Only calls of at least a minute are SHARED; briefer overlaps stay in the local
        // dossier but never reach the pool — the long tail of one-off pairs is exactly what
        // bloats a memory-bounded server past what it can serve, and is noise there anyway.
        const SYNC_MIN_MS = 60_000;
        let anyKept = false;
        for (const [c, rec] of Object.entries<any>(prof?.companions ?? {})) {
            if (!isId(c) || c === id || skip.has(c)) continue;
            if ((rec?.ms ?? 0) < SYNC_MIN_MS) continue;       // brief call — stays local only
            if (!anyKept) { touch(id, guilds, prof?.updated ?? 0, prof?.firstSeen ?? 0); anyKept = true; }
            touch(c, guilds, rec?.last ?? 0);
            const k = pairKey(id, c);
            const cur = calls[k] || (calls[k] = { ms: 0, count: 0, last: 0, guilds: [] });
            cur.ms = Math.max(cur.ms, rec?.ms ?? 0);
            cur.count = Math.max(cur.count, rec?.count ?? 0);
            cur.last = Math.max(cur.last, rec?.last ?? 0);
            // A call's guilds are where it ACTUALLY happened (the VC's server), so the pool
            // can categorise relationships by server. Older records predating that capture
            // fall back to the pair's shared memberships, which is the best proxy we have.
            const callGuilds = (rec?.guilds && rec.guilds.length) ? rec.guilds : guilds;
            for (const g of callGuilds) if (isId(g) && !cur.guilds.includes(g)) cur.guilds.push(g);
        }
    }
    // only the names of people actually in this payload, so a delta stays small
    const users: Record<string, PoolUser> = {};
    for (const id of Object.keys(people)) {
        const n = names[id];
        if (!n?.username) continue;
        const rec: PoolUser = { username: n.username, avatar: n.avatar || "", at: n.at ?? 0 };
        // Carry the opened-profile capture if we have one, so the pooled dossier can show
        // this person's bio / pronouns / connections, not just their name and call graph.
        const about = profiles?.[id]?.about;
        if (about && typeof about === "object") rec.about = about;
        users[id] = rec;
    }
    return { people, calls, users };
}

/**
 * The pool back into local profiles, highest-wins.
 *
 * A pair is symmetric, so both ends gain the record — which is the point: a person this
 * machine has never watched still arrives with their whole call history, because some
 * other machine watched them. Returns how many profiles were touched.
 */
export function fromPool(
    pool: PoolPayload,
    profiles: Record<string, any>,
    mine: string[],
    now: number
): number {
    const skip = new Set(mine.filter(Boolean));
    let touched = 0;

    const ensure = (id: string) => {
        let p = profiles[id];
        if (!p) { p = profiles[id] = { companions: {}, guilds: {}, updated: 0, firstSeen: 0 }; touched++; }
        if (!p.companions) p.companions = {};
        if (!p.guilds) p.guilds = {};
        return p;
    };

    for (const [id, meta] of Object.entries(pool?.people ?? {})) {
        if (!isId(id) || skip.has(id)) continue;
        const p = ensure(id);
        // firstSeen takes the EARLIEST; 0 means unknown and must never win
        const first = meta?.first ?? 0;
        if (first > 0 && (p.firstSeen === 0 || first < p.firstSeen)) p.firstSeen = first;
        if ((meta?.last ?? 0) > (p.updated ?? 0)) p.updated = meta.last;
    }

    for (const [key, rec] of Object.entries(pool?.calls ?? {})) {
        const [a, b] = String(key).split("|");
        if (!isId(a) || !isId(b) || a === b) continue;
        if (skip.has(a) || skip.has(b)) continue;
        for (const [x, y] of [[a, b], [b, a]]) {
            const p = ensure(x);
            const cur = p.companions[y] || (p.companions[y] = { count: 0, ms: 0, last: 0 });
            cur.count = Math.max(cur.count ?? 0, rec?.count ?? 0);
            cur.ms = Math.max(cur.ms ?? 0, rec?.ms ?? 0);
            cur.last = Math.max(cur.last ?? 0, rec?.last ?? 0);
            for (const g of rec?.guilds ?? []) {
                if (isId(g)) p.guilds[g] = Math.max(p.guilds[g] ?? 0, 1);
            }
            if ((rec?.last ?? 0) > (p.updated ?? 0)) p.updated = rec.last;
        }
    }
    return touched;
}

/**
 * The pooled friend graph into a LOCAL POOLED store — deliberately not into your own
 * friendMap.
 *
 * Two reasons they stay apart, and both matter:
 *
 *  1. Your friendMap is what you PROVED, and it is what gets pushed back. Folding other
 *     people's findings into it would re-push them as your own, so every contributor
 *     would end up vouching for everything and `sources` would stop meaning anything.
 *  2. Retraction is per-slice. When your own scan stops seeing a friendship, that removes
 *     YOUR claim; it does not falsify someone else's. Keeping the layers separate lets
 *     both be true at once, which is the actual state of the world.
 *
 * Returns how many entries changed, so the caller knows whether to persist.
 */
export function fromPooledFriends(
    pool: { friends?: Record<string, any>; friendsComplete?: boolean; } | null,
    store: Record<string, { friends: string[]; guilds: string[]; at: number; sources: number; }>,
    now: number
): number {
    let changed = 0;
    // When the server says this is the whole set, anything missing from it has left the
    // pool entirely — every contributor retracted it. Under an incremental pull that
    // absence would otherwise be indistinguishable from "unchanged", and a withdrawn name
    // would live on here forever.
    if (pool?.friendsComplete) {
        const present = new Set(Object.keys(pool.friends ?? {}));
        for (const id of Object.keys(store)) {
            if (!present.has(id)) { delete store[id]; changed++; }
        }
    }
    for (const [id, rec] of Object.entries(pool?.friends ?? {})) {
        if (!isId(id) || !rec) continue;
        const friends = (Array.isArray(rec.friends) ? rec.friends : []).filter(isId);
        if (!friends.length) {
            // the pool no longer has anyone vouching for them — drop ours too, or a
            // finding retracted by every contributor would live on forever here
            if (store[id]) { delete store[id]; changed++; }
            continue;
        }
        const guilds = (Array.isArray(rec.guilds) ? rec.guilds : []).filter(isId);
        const prev = store[id];
        const next = {
            friends, guilds,
            at: typeof rec.at === "number" ? rec.at : now,
            sources: typeof rec.sources === "number" ? rec.sources : 1
        };
        if (!prev
            || prev.friends.join(",") !== next.friends.join(",")
            || prev.guilds.join(",") !== next.guilds.join(",")
            || prev.sources !== next.sources) {
            store[id] = next;
            changed++;
        }
    }
    return changed;
}

// ---------------------------------------------------------------------------
// The voice timeline
// ---------------------------------------------------------------------------
/**
 * How close two observations have to be to count as the same event.
 *
 * Every contributor stamps a transition with its OWN Date.now() as the dispatch arrives,
 * so the same person joining the same channel is recorded at slightly different instants
 * by each machine watching. Dedupe on the exact millisecond and the shared timeline shows
 * one join per observer, which is a worse view than not pooling at all.
 *
 * Deliberately a BUCKET and not a tolerance window. A window ("within 5s of an event
 * already here") depends on which record arrives first, and this merge has to be
 * commutative and associative — the entire server design rests on slices being
 * foldable in any order (see mergePoolInto). Flooring into a fixed bucket is a pure
 * function of the event, so every contributor derives the same identity independently.
 * The cost is that a transition landing either side of a bucket edge is counted twice;
 * that is rare, harmless, and preferable to a merge whose answer depends on arrival order.
 */
export const VOICE_BUCKET_MS = 5000;
/** Events kept per person. The log is a recent history, not an archive. */
export const MAX_VOICE_EVENTS = 100;

const VOICE_ACTS = new Set(["joined", "left", "moved"]);

/** Identity of an observation, agreed independently by every contributor. */
export function voiceKey(e: { act: string; ch: string | null; old: string | null; at: number; }): string {
    return `${e.act}|${e.ch ?? ""}|${e.old ?? ""}|${Math.floor((e.at || 0) / VOICE_BUCKET_MS)}`;
}

/** A wire event, or null if it is not one. */
export function cleanVoiceEvent(e: any): PoolVoiceEvent | null {
    if (!e || typeof e !== "object") return null;
    const act = String(e.act);
    if (!VOICE_ACTS.has(act)) return null;
    const at = Number(e.at);
    if (!Number.isFinite(at) || at <= 0) return null;
    const ch = isId(e.ch) ? e.ch : null;
    const old = isId(e.old) ? e.old : null;
    // "joined" with nowhere to have joined, "left" from nowhere: not describable, so not
    // storable. Without this a malformed push becomes a permanent unreadable row.
    if (act === "joined" && !ch) return null;
    if (act === "left" && !old) return null;
    if (act === "moved" && (!ch || !old)) return null;
    return { act: act as PoolVoiceEvent["act"], ch, old, at };
}

/**
 * Union two observation lists, newest first, capped.
 *
 * Where two observations share an identity the EARLIER stamp wins — `min` is commutative
 * and associative, so the surviving record does not depend on which contributor's slice
 * was folded in first.
 */
export function mergeVoiceEvents(a: PoolVoiceEvent[] = [], b: PoolVoiceEvent[] = [], cap = MAX_VOICE_EVENTS): PoolVoiceEvent[] {
    const byKey = new Map<string, PoolVoiceEvent>();
    for (const raw of [...(a || []), ...(b || [])]) {
        const e = cleanVoiceEvent(raw);
        if (!e) continue;
        const k = voiceKey(e);
        const have = byKey.get(k);
        if (!have || e.at < have.at) byKey.set(k, e);
    }
    const out = [...byKey.values()].sort((x, y) => y.at - x.at);
    return out.length > cap ? out.slice(0, cap) : out;
}

/**
 * A local voice log into the wire shape.
 *
 * `since` keeps a routine push to what has happened since the last one. Your own accounts
 * are dropped for the same reason they are dropped from `toPool`: you are present at
 * everything you observe, so pooling yourself says nothing and identifies you to every
 * other contributor.
 */
export function toVoice(
    entries: Array<{ userId: string; action: string; channelId: string | null; oldChannelId: string | null; at: number; }>,
    mine: string[] = [],
    since = 0
): Record<string, PoolVoicePerson> {
    const skip = new Set((mine || []).filter(Boolean));
    const out: Record<string, PoolVoicePerson> = {};
    for (const raw of entries || []) {
        if (!raw || !isId(raw.userId) || skip.has(raw.userId)) continue;
        if (!((raw.at ?? 0) > since)) continue;
        const e = cleanVoiceEvent({ act: raw.action, ch: raw.channelId, old: raw.oldChannelId, at: raw.at });
        if (!e) continue;
        const p = out[raw.userId] || (out[raw.userId] = { events: [], last: 0 });
        p.events.push(e);
        if (e.at > p.last) p.last = e.at;
    }
    for (const id of Object.keys(out)) out[id].events = mergeVoiceEvents(out[id].events, []);
    return out;
}

/**
 * The pooled timeline into a local flat log, newest first.
 *
 * Returns how many entries are genuinely new, so a caller knows whether to persist and
 * redraw. The log stays one chronological list rather than becoming per-person, because
 * that is what it is read as — "what happened, in order" — and re-deriving that from a
 * per-person map on every render is work for no gain.
 */
export function fromVoice(
    voice: Record<string, PoolVoicePerson> | undefined | null,
    entries: Array<{ userId: string; action: string; channelId: string | null; oldChannelId: string | null; at: number; pooled?: boolean; }>,
    cap = 2000
): number {
    if (!voice || typeof voice !== "object") return 0;
    const have = new Set<string>();
    for (const raw of entries) {
        const e = cleanVoiceEvent({ act: raw.action, ch: raw.channelId, old: raw.oldChannelId, at: raw.at });
        if (e) have.add(`${raw.userId}#${voiceKey(e)}`);
    }
    let added = 0;
    for (const [id, rec] of Object.entries(voice)) {
        if (!isId(id) || !rec) continue;
        for (const raw of rec.events ?? []) {
            const e = cleanVoiceEvent(raw);
            if (!e) continue;
            const k = `${id}#${voiceKey(e)}`;
            if (have.has(k)) continue;
            have.add(k);
            // Flagged, so the UI can say this came from another contributor rather than
            // implying this client was watching at the time.
            entries.push({ userId: id, action: e.act, channelId: e.ch, oldChannelId: e.old, at: e.at, pooled: true });
            added++;
        }
    }
    if (added) {
        entries.sort((x, y) => y.at - x.at);
        if (entries.length > cap) entries.length = cap;
    }
    return added;
}

/** The account-relative half, for POST /v1/me. */
export function toPrivate(
    friendMap: Record<string, any>,
    watching: string[],
    notes: Record<string, any> = {},
    retracted: string[] = []
): PrivatePayload {
    const friends: PrivatePayload["friends"] = {};
    for (const [id, f] of Object.entries<any>(friendMap || {})) {
        if (!isId(id)) continue;
        friends[id] = {
            friends: (f?.friends ?? []).filter(isId),
            guilds: (f?.guilds ?? []).filter(isId),
            at: f?.at ?? 0
        };
    }
    // Said out loud, because omission cannot mean "delete": a blob can be shared by
    // several accounts, so no single push is the complete set for it. Without these, a
    // friendship this machine has stopped being able to prove stays in the pool forever.
    const out: PrivatePayload = {
        friends, watching: (watching || []).filter(isId), notes: {},
        retracted: (retracted || []).filter(isId)
    };
    for (const [id, n] of Object.entries<any>(notes || {})) {
        if (!isId(id) || !n?.text) continue;
        out.notes[id] = { text: String(n.text).slice(0, 4000), at: n?.at ?? 0 };
    }
    return out;
}

/**
 * A pulled private blob into the local friend map.
 *
 * The FRESHER entry wins outright rather than the two being unioned: an unfriending has
 * to be able to remove a name, and a union could never delete one.
 */
export function fromPrivate(
    blob: PrivatePayload,
    friendMap: Record<string, any>
): number {
    let changed = 0;
    for (const [id, f] of Object.entries(blob?.friends ?? {})) {
        if (!isId(id)) continue;
        const cur = friendMap[id];
        if (!cur || (f?.at ?? 0) > (cur.at ?? 0)) {
            friendMap[id] = { friends: (f?.friends ?? []).filter(isId), guilds: (f?.guilds ?? []).filter(isId), at: f?.at ?? 0 };
            changed++;
        }
    }
    return changed;
}

/** Anything with a real body is a real answer; everything else throws. */
export async function call(
    base: string, token: string, path: string, body?: any
): Promise<any> {
    const url = base.replace(/\/+$/, "") + path;
    const res = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
}

/**
 * Split a pool payload into batches small enough to post.
 *
 * A full re-sync outgrew the server's body limit and came back 413, which stopped the
 * whole sync rather than part of it. Chunking is safe here precisely because the merge is
 * additive and idempotent: each batch is a valid payload on its own, order does not
 * matter, and a batch that fails is simply re-sent next time.
 *
 * People and names ride along with the batch that mentions them, so no batch references
 * anyone it does not also describe.
 */
export function chunkPool(pool: PoolPayload, perChunk = 4000): PoolPayload[] {
    const keys = Object.keys(pool.calls || {});
    const voiceIds = Object.keys(pool.voice || {});
    if (keys.length <= perChunk) {
        // still worth splitting if it is all people and no calls (a first sync)
        const ids = Object.keys(pool.people || {});
        if (ids.length <= perChunk * 2 && voiceIds.length <= perChunk * 2) return [pool];
    }
    const out: PoolPayload[] = [];
    const used = new Set<string>();

    for (let i = 0; i < keys.length; i += perChunk) {
        const slice = keys.slice(i, i + perChunk);
        const calls: Record<string, PoolCall> = {};
        const people: Record<string, PoolPerson> = {};
        const users: Record<string, PoolUser> = {};
        const voice: Record<string, PoolVoicePerson> = {};
        for (const k of slice) {
            calls[k] = pool.calls[k];
            for (const id of k.split("|")) {
                if (pool.people?.[id]) people[id] = pool.people[id];
                if (pool.users?.[id]) users[id] = pool.users[id];
                if (pool.voice?.[id]) voice[id] = pool.voice[id];
                used.add(id);
            }
        }
        out.push({ people, calls, users, voice });
    }

    // anyone with no calls at all still has to be sent, or they vanish from the pool —
    // and a voice timeline is exactly that case: it exists for people this client has
    // never once seen share a channel with anybody.
    const orphans = [...new Set([...Object.keys(pool.people || {}), ...voiceIds])].filter(id => !used.has(id));
    for (let i = 0; i < orphans.length; i += perChunk * 2) {
        const people: Record<string, PoolPerson> = {};
        const users: Record<string, PoolUser> = {};
        const voice: Record<string, PoolVoicePerson> = {};
        for (const id of orphans.slice(i, i + perChunk * 2)) {
            if (pool.people?.[id]) people[id] = pool.people[id];
            if (pool.users?.[id]) users[id] = pool.users[id];
            if (pool.voice?.[id]) voice[id] = pool.voice[id];
        }
        out.push({ people, calls: {}, users, voice });
    }
    return out.length ? out : [pool];
}
