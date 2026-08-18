/*
 * Graph + relationship intelligence over the merged pool. Pure functions, so the whole file
 * is unit-tested without a server. The heavy, whole-graph pieces (centrality, clusters, the
 * server index) are folded into ONE buildIntel() that a caller runs once per merged view and
 * caches; the per-person pieces (closeness, active-hours, alt scoring) are cheap and run per
 * request. Nothing here is stored in the pool - it is all derived from what is already there.
 */

// ---------------------------------------------------------------------------
// Centrality - who the network runs THROUGH
// ---------------------------------------------------------------------------
// A hub is someone connected to many DISTINCT people. Distinct connections dominate the
// score (a real connector knows many people, not one person for a long time); total voice
// time is a gentle log-scaled tie-breaker, and a proven friendship counts as half a
// connection so a well-linked person with few calls still surfaces.
function centrality(idx, friends) {
    const score = {};
    for (const id in idx.deg) {
        const fr = friends[id] && friends[id].friends ? friends[id].friends.length : 0;
        score[id] = idx.deg[id] + fr * 0.5 + Math.log10((idx.ms[id] || 0) + 1);
    }
    for (const id in friends) {
        if (id in score) continue;
        const fr = (friends[id].friends || []).length;
        if (fr) score[id] = fr * 0.5;
    }
    return score;
}

// ---------------------------------------------------------------------------
// Clusters - the tight groups
// ---------------------------------------------------------------------------
// Communities without a heavyweight solver: weighted label propagation. Every node starts
// as its own label, then repeatedly adopts the label its neighbours hold the most VOICE TIME
// with. Made deterministic - neighbours summed per label, ties broken by the smallest label
// id, ids walked in a fixed order - so the same pool always yields the same grouping, and
// bounded to a few passes so it stays cheap on a big graph.
function clusters(by, opts) {
    const maxIter = (opts && opts.maxIter) || 6;
    const ids = Object.keys(by).sort();
    const label = {};
    for (const id of ids) label[id] = id;
    for (let iter = 0; iter < maxIter; iter++) {
        let changed = 0;
        for (const id of ids) {
            const nb = by[id];
            const weight = {};
            for (const o in nb) { const l = label[o]; weight[l] = (weight[l] || 0) + ((nb[o].ms || 0) + 1); }
            let best = label[id], bestW = -1;
            for (const l in weight) { const w = weight[l]; if (w > bestW || (w === bestW && l < best)) { best = l; bestW = w; } }
            if (best !== label[id]) { label[id] = best; changed++; }
        }
        if (!changed) break;
    }
    const size = {};
    for (const id of ids) size[label[id]] = (size[label[id]] || 0) + 1;
    return { label, size };
}

// ---------------------------------------------------------------------------
// Server connections - people linked THROUGH a shared server
// ---------------------------------------------------------------------------
function serverIndex(people) {
    const members = {};
    for (const id in people) for (const g of (people[id].guilds || [])) (members[g] || (members[g] = [])).push(id);
    return members;
}
// Servers that link the most pooled people - the rooms worth watching. A server with one
// pooled member connects nobody, so those are dropped.
function topServers(members, n) {
    return Object.keys(members).filter(g => members[g].length >= 2)
        .sort((a, b) => members[b].length - members[a].length).slice(0, n || 30)
        .map(g => ({ guild: g, count: members[g].length }));
}
// The servers two people share - the concrete "linked through" answer for a pair.
function sharedServers(ga, gb) {
    const set = new Set(gb || []); const out = [];
    for (const g of (ga || [])) if (set.has(g)) out.push(g);
    return out;
}

// ---------------------------------------------------------------------------
// Relationship strength - a single 0..100 closeness score
// ---------------------------------------------------------------------------
// Interpretable on purpose: mostly time-together (log-scaled against the busiest pair on
// record so it is relative to THIS pool), lifted by how recently the last call was and how
// often they talk. A long-standing near-daily contact scores high; one marathon call a year
// ago does not get to masquerade as a close tie.
function closeness(rec, now, maxMs) {
    if (!rec) return 0;
    const ms = rec.ms || 0, count = rec.count || 0, last = rec.last || 0;
    const DAY = 86400000;
    const dur = maxMs > 0 ? Math.log10(ms + 1) / Math.log10(maxMs + 1) : 0;
    const age = last > 0 ? now - last : Infinity;
    const rc = age <= 7 * DAY ? 1 : age >= 90 * DAY ? 0.1 : 1 - 0.9 * (age - 7 * DAY) / (83 * DAY);
    const fr = Math.min(1, count / 40);
    return Math.max(0, Math.min(100, Math.round(100 * (0.55 * dur + 0.30 * rc + 0.15 * fr))));
}

// ---------------------------------------------------------------------------
// Active hours + timezone guess
// ---------------------------------------------------------------------------
// Voice JOINS cluster around a person's waking evening. Bucket them by UTC hour, take the
// peak, and guess the offset by assuming that peak sits near ~21:00 local. Deliberately
// rough and flagged as a guess; only offered once there are enough samples to mean anything.
function activeHours(events, minSamples) {
    const hist = new Array(24).fill(0); let n = 0;
    for (const e of (events || [])) {
        if (!e || e.act !== "joined") continue;
        const h = new Date(e.at).getUTCHours();
        if (h >= 0 && h < 24) { hist[h]++; n++; }
    }
    const min = minSamples || 8;
    if (n < min) return { samples: n, hist, peakHour: null, tzGuess: null, active: [] };
    let peak = 0; for (let h = 1; h < 24; h++) if (hist[h] > hist[peak]) peak = h;
    let off = 21 - peak; if (off > 12) off -= 24; if (off < -11) off += 24;
    const tzGuess = "UTC" + (off >= 0 ? "+" : "") + off;
    const mean = n / 24; const active = [];
    for (let h = 0; h < 24; h++) if (hist[h] > mean) active.push(h);
    return { samples: n, hist, peakHour: peak, tzGuess, active };
}

// ---------------------------------------------------------------------------
// Alt-account linking - a ranked hunch, with reasons
// ---------------------------------------------------------------------------
// The same linked account (Steam/Spotify id) is nearly dispositive; then the classic
// "shares many contacts but was never in a call with them", shared servers, and overlapping
// active hours. Returns a score AND the reasons, so the UI says WHY instead of just asserting.
function sharedConnLabels(a, b) {
    if (!a || !b) return [];
    const B = {}; for (const c of b) B[(c.t || "") + ":" + (c.id || c.n || "")] = c;
    const out = [];
    for (const c of a) { const k = (c.t || "") + ":" + (c.id || c.n || ""); if (B[k]) out.push(c.t + " " + (c.n || c.id)); }
    return out;
}
function altScore(ctx) {
    // ctx: { byA, byB, guildsA, guildsB, connsA, connsB, peakA, peakB }
    if (ctx.byA && ctx.byA[ctx.b] || ctx.calledEachOther) return { score: 0, reasons: [] };
    const reasons = []; let score = 0;
    let sh = 0; const B = ctx.byB || {}; for (const o in (ctx.byA || {})) if (B[o]) sh++;
    if (sh >= 3) { score += Math.min(30, sh * 4); reasons.push(sh + " shared contacts, never together"); }
    const conn = sharedConnLabels(ctx.connsA, ctx.connsB);
    if (conn.length) { score += 45; reasons.push("same linked account: " + conn.join(", ")); }
    const sg = sharedServers(ctx.guildsA, ctx.guildsB).length;
    if (sg >= 3) { score += Math.min(15, sg * 2); reasons.push(sg + " shared servers"); }
    if (ctx.peakA != null && ctx.peakB != null) {
        const d = Math.abs(ctx.peakA - ctx.peakB); const dd = Math.min(d, 24 - d);
        if (dd <= 1) { score += 10; reasons.push("active at the same hours"); }
    }
    return { score: Math.min(100, score), reasons };
}

// ---------------------------------------------------------------------------
// The one build the server caches per merged view
// ---------------------------------------------------------------------------
function buildIntel(P, idx, friends) {
    let maxMs = 0; for (const k in P.calls) { const m = P.calls[k].ms || 0; if (m > maxMs) maxMs = m; }
    const cen = centrality(idx, friends);
    const cl = clusters(idx.by, { maxIter: 6 });
    const members = serverIndex(P.people);
    return { centrality: cen, cluster: cl.label, clusterSize: cl.size, guildMembers: members, maxMs };
}

module.exports = {
    centrality, clusters, serverIndex, topServers, sharedServers,
    closeness, activeHours, altScore, sharedConnLabels, buildIntel
};
