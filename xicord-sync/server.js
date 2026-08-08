/*
 * Xicord Sync — pooled dossier storage.
 *
 * Several PCs push what they have observed; any of them can pull the combined picture.
 * Each device's contribution is stored as its OWN slice and the slices are merged on
 * read, which makes re-pushing idempotent and lets a device be revoked without unpicking
 * merged numbers.
 *
 * Env:
 *   XICORD_TOKENS  "token:deviceName,token:deviceName"  (required — no tokens, no writes)
 *   DATA_DIR       where slices live (default /data, the Railway volume mount)
 *   PORT           provided by Railway
 */
const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { mergeAll, mergeSnapshot, sanitize } = require("./merge");
const { mergeAllPools, mergePool, mergePoolInto, sanitizePool, sanitizePrivate, mergePrivate, mergeFriendGraphs } = require("./pool");
const auth = require("./auth");
const pages = require("./pages");

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || "/data";
const DEVICES_DIR = path.join(DATA_DIR, "devices");   // v1, kept until every device migrates
const POOL_DIR = path.join(DATA_DIR, "pool");         // shared observations, one slice per contributor
const USERS_DIR = path.join(DATA_DIR, "users");       // private blobs, never merged across users
const AUTH_FILE = path.join(DATA_DIR, "auth", "tokens.json");  // tokens issued by sign-in
// A full re-sync is ~6MB today; leave room to grow. Overridable so the tests can drive
// the oversize path at a size that doesn't take a second to transfer.
const MAX_BODY = Number(process.env.MAX_BODY_BYTES) || 32 * 1024 * 1024;
const VERSION = "1.0.0";

/* ---------------- tokens ---------------- */
// token -> deviceId. The device is derived from the token, never sent by the client, so
// one device physically cannot write into another's slice.
let tokens = new Map();
// token -> the Discord user id that owns it. Derived here, never read from a request,
// so no client can address another user's blob.
let owners = new Map();
// Tokens issued by signing in, persisted so they survive a redeploy.
// token -> { user, username, at }
let issued = {};

// Several Discord accounts can be one person. XICORD_ALIASES maps account ids onto the
// blob they belong to — "from=to,from=to".
//
// The right-hand side is a BLOB NAME, not another account. Pointing one account at
// another made whichever account happened to be named the owner, and the other one a
// second-class attachment to somebody else's storage — so the identity of the data
// depended on which account you happened to set up first. A blob named `lab-a` is its own
// thing: accounts attach to it, none of them owns it, and an account can be swapped out
// without the store changing hands.
//
// A bare snowflake on the right is still accepted, so the older account=account form
// keeps working.
const BLOB_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const ACCOUNT_ID = /^\d{5,25}$/;

function aliasMap() {
    const out = new Map();
    for (const pair of (process.env.XICORD_ALIASES || "").split(",")) {
        const [from, to] = pair.split("=").map(x => (x || "").trim());
        // A blob name is allowed on the LEFT too, which is how a blob gets renamed:
        // `lab-a=4has` points the old name at the new one, and the boot-time adoption
        // folds the old files in and removes them. Without it a rename would strand the
        // old blob under a name nothing resolves to any more.
        if (!ACCOUNT_ID.test(from) && !BLOB_NAME.test(from)) continue;
        if (!BLOB_NAME.test(to) && !ACCOUNT_ID.test(to)) continue;
        if (from === to) continue;   // a self-alias is a no-op, and canonical() would loop on it
        out.set(from, to);
    }
    return out;
}

/**
 * Whether a resolved owner is safe to use as a FILENAME.
 *
 * Until now every owner was a snowflake, so `path.join(USERS_DIR, id + ".json")` could not
 * escape the directory. Blob names are operator-supplied, and `../../something` in an env
 * var would write wherever it liked — so the pattern is checked here rather than trusted,
 * and anything that fails is refused rather than sanitised into a surprising path.
 */
function storageKey(owner) {
    if (typeof owner !== "string") return null;
    if (ACCOUNT_ID.test(owner) || BLOB_NAME.test(owner)) return owner;
    return null;
}
/**
 * The Discord accounts attached to a blob.
 *
 * The binding only existed in an env var, so "is the third account actually wired to the
 * right blob?" could only be answered by reading the deployment's configuration. Reporting
 * it back on /v1/me makes a mis-typed id visible from the client that is affected by it.
 * Only real account ids are listed — a rename entry like `lab-a=4has` is plumbing, not a
 * member.
 */
function accountsOn(blob) {
    const out = [];
    for (const [from] of aliasMap()) {
        if (ACCOUNT_ID.test(from) && canonical(from) === blob) out.push(from);
    }
    // an account with no alias entry IS its own blob, and belongs to itself
    if (ACCOUNT_ID.test(blob) && !out.includes(blob)) out.push(blob);
    return out.sort();
}

/** Resolve an id through the alias map, guarding against a chain that loops. */
function canonical(id) {
    if (!id) return id;
    const map = aliasMap();
    let cur = id;
    for (let i = 0; i < 5 && map.has(cur); i++) cur = map.get(cur);
    return cur;
}

/** Env tokens first (bootstrap/admin), then anything sign-in has handed out. */
function ownerFor(token) {
    if (!token) return null;
    const fromEnv = owners.get(token);
    if (fromEnv !== undefined && fromEnv !== null) return canonical(fromEnv);
    const rec = issued[token];
    return rec ? canonical(rec.user) : null;
}

function loadTokens() {
    const raw = process.env.XICORD_TOKENS || "";
    const map = new Map();
    owners = new Map();
    for (const pair of raw.split(",")) {
        const trimmed = pair.trim();
        if (!trimmed) continue;
        const idx = trimmed.indexOf(":");
        const token = (idx === -1 ? trimmed : trimmed.slice(0, idx)).trim();
        const rest = idx === -1 ? "" : trimmed.slice(idx + 1);
        // `token:name` (v1) or `token:name:discordUserId` (v2). Without an id the token
        // still works for the v1 routes but owns no user, so it cannot touch /v1/me.
        const bits = rest.split(":");
        const name = (bits[0] || "").trim() || "device";
        const discordId = (bits[1] || "").trim();
        if (token.length < 16) {
            console.warn(`refusing a token shorter than 16 chars for "${name}"`);
            continue;
        }
        // filename-safe, stable, and not the token itself — the token never hits disk
        const deviceId = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48)
            + "-" + crypto.createHash("sha256").update(token).digest("hex").slice(0, 8);
        map.set(token, deviceId);
        owners.set(token, /^\d{5,25}$/.test(discordId) ? discordId : null);
    }
    tokens = map;
    console.log(`loaded ${tokens.size} token(s): ${[...tokens.values()].join(", ") || "none"}`);
}

/** Constant-time lookup: comparing tokens with === leaks length and prefix by timing. */
function deviceFor(token) {
    if (!token) return null;
    const rec = issued[token];
    if (rec) return `u${rec.user}-${crypto.createHash("sha256").update(token).digest("hex").slice(0, 8)}`;
    const given = Buffer.from(token);
    let found = null;
    for (const [known, deviceId] of tokens) {
        const mine = Buffer.from(known);
        // timingSafeEqual throws on length mismatch, so pad both to a fixed width
        const a = Buffer.alloc(64), b = Buffer.alloc(64);
        given.copy(a, 0, 0, Math.min(given.length, 64));
        mine.copy(b, 0, 0, Math.min(mine.length, 64));
        if (crypto.timingSafeEqual(a, b) && given.length === mine.length) found = deviceId;
    }
    return found;
}

/* ---------------- storage ---------------- */
async function ensureDirs() {
    await fsp.mkdir(DEVICES_DIR, { recursive: true });
    await fsp.mkdir(POOL_DIR, { recursive: true });
    await fsp.mkdir(USERS_DIR, { recursive: true });
    await fsp.mkdir(path.dirname(AUTH_FILE), { recursive: true });
    issued = await readJson(AUTH_FILE, {});
}

/** Read a JSON file, or `fallback` if it is missing or unreadable. */
async function readJson(file, fallback) {
    try {
        const data = JSON.parse(await fsp.readFile(file, "utf8"));
        return data && typeof data === "object" ? data : fallback;
    } catch { return fallback; }
}
/** Temp file + rename: a concurrent reader must never see a half-written file. */
async function writeJson(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data), "utf8");
    await fsp.rename(tmp, file);
}
// Both throw rather than returning a path built from an unvalidated key: a blob name
// comes from an env var, and quietly writing to a path outside the data directory is the
// one failure here that would not look like a failure.
const poolFile = id => {
    const key = storageKey(id);
    if (!key) throw new Error(`unsafe storage key: ${JSON.stringify(id)}`);
    return path.join(POOL_DIR, `${key}.json`);
};
const userFile = id => {
    const key = storageKey(id);
    if (!key) throw new Error(`unsafe storage key: ${JSON.stringify(id)}`);
    return path.join(USERS_DIR, `${key}.json`);
};

/**
 * Every contributor.s private blob. Only the friend graph is ever taken from these —
 * watchlists and notes stay private — and the caller unions them for the shared pull.
 */
async function readAllUserBlobs() {
    let names = [];
    try { names = await fsp.readdir(USERS_DIR); } catch { return []; }
    const out = [];
    for (const n of names) {
        if (!n.endsWith(".json")) continue;
        out.push(await readJson(path.join(USERS_DIR, n), { friends: {} }));
    }
    return out;
}

/**
 * Fold a slice's log back into the slice and drop the log.
 *
 * Under the owner's push lock, and re-reading inside it, because this deletes a file that
 * pushes are actively appending to. Compacting from a copy read outside the lock would
 * delete every line that arrived while the slice was being written out — pushes already
 * answered 200, which a client has no reason to ever send again.
 *
 * The lock is the same one POST /v1/pool takes, so a push either lands entirely before the
 * re-read (and is written into the slice) or entirely after the rm (and starts a fresh log).
 */
function compact(owner, file) {
    return withLock(`pool:${owner}`, async () => {
        try {
            const { pool } = await sliceWithLog(file, `${file}.log`);
            await writeJson(file, pool);
            await fsp.rm(`${file}.log`, { force: true });
        } catch (e) { console.error("compaction failed:", file, e.message); }
    });
}

async function readAllPools() {
    let names = [];
    try { names = await fsp.readdir(POOL_DIR); } catch { names = []; }
    const out = [];
    const seen = new Set();
    for (const n of names) {
        if (!n.endsWith(".json")) continue;
        const file = path.join(POOL_DIR, n);
        seen.add(file);
        const { pool, logBytes } = await sliceWithLog(file, `${file}.log`);
        // Fold the log back in once it has grown, so replay cost stays bounded. This is
        // the one place that already holds the whole slice, so it is the cheap place.
        if (logBytes > MAX_LOG_BYTES) await compact(n.slice(0, -5), file);
        out.push(pool);
    }
    // A contributor whose first push has not been compacted yet has a log but no slice.
    for (const n of names) {
        if (!n.endsWith(".json.log")) continue;
        const file = path.join(POOL_DIR, n.slice(0, -4));
        if (seen.has(file)) continue;
        out.push((await sliceWithLog(file, `${file}.log`)).pool);
    }
    return out;
}

async function readSlice(deviceId) {
    try {
        const txt = await fsp.readFile(path.join(DEVICES_DIR, `${deviceId}.json`), "utf8");
        const data = JSON.parse(txt);
        return data && typeof data === "object" ? data : { dossiers: {}, users: {} };
    } catch { return { dossiers: {}, users: {} }; }
}

/** Temp file + rename: a concurrent pull must never read a half-written slice. */
async function writeSlice(deviceId, data) {
    const target = path.join(DEVICES_DIR, `${deviceId}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data), "utf8");
    await fsp.rename(tmp, target);
}

async function readAllSlices() {
    let names = [];
    try { names = await fsp.readdir(DEVICES_DIR); } catch { return []; }
    const out = [];
    for (const n of names) {
        if (!n.endsWith(".json")) continue;
        out.push(await readSlice(n.slice(0, -5)));
    }
    return out;
}

// One writer at a time per device: two overlapping pushes from the same device would
// otherwise read-modify-write over each other and lose the earlier one.
const locks = new Map();
function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(key, next.catch(() => { }));
    return next;
}

/* ---------------- http ---------------- */
function send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store"
    });
    res.end(body);
}

const esc = t => String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** Send an already-serialised body, so a cached response is not re-stringified. */
function sendRaw(res, code, body) {
    res.writeHead(code, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store"
    });
    res.end(body);
}

/**
 * The pooled view, built at most once per change.
 *
 * This used to re-read every slice, re-merge the lot and re-serialise it on EVERY pull.
 * At 11k people and 113k call pairs that is tens of megabytes of parsing and object
 * building per request — and clients poll it. Two overlapping pulls were enough to
 * exhaust the container, which the platform then killed and restarted, into a loop.
 *
 * The merge is a pure function of what is on disk, so it is cached as the finished
 * STRING and thrown away whenever anything is written. Holding one copy is what makes
 * this survivable; holding one copy per concurrent request is what did not.
 *
 * The TTL is a backstop, not the mechanism: if an invalidation is ever missed, the pool
 * goes stale for a minute rather than forever.
 */
let mergedCache = null;        // { pooled, friends, at, builtAt, friendsStale }
let fullBodyCache = null;      // { body, at, builtAt } — the serialised full response
// A backstop only. The view is kept current by applying each write into it, so this is
// what catches drift if that ever fails to happen — not the mechanism. Overridable so the
// tests can prove the backstop actually fires without waiting ten minutes for it.
const POOL_TTL = Number(process.env.XICORD_POOL_TTL_MS) || 10 * 60_000;
let poolBuilding = null;       // in-flight build, shared so a burst does the work once
/**
 * Writes that landed while a build was reading, replayed onto its result.
 *
 * A build reads every slice off disk and then REPLACES the view with what it found. A push
 * that lands after the build has already read its owner's slice is on disk but not in that
 * result — and applying it to the live cache does not help, because the cache it patched is
 * the object about to be thrown away (or, on a cold build, is still null and swallows the
 * write entirely). Either way the client is told 200 and the record is not in the view.
 *
 * So while a build is in flight every delta is also recorded here and re-applied to the
 * finished pool. Re-applying one that the build happened to catch is free: the merge is
 * highest-wins, so absorbing the same record twice is the same as absorbing it once.
 */
let buildDeltas = null;        // array while a build is in flight, else null
let friendsDirtyDuringBuild = false;

/**
 * Absorb a push into the cached view instead of discarding it.
 *
 * This used to null the caches, and clients push on the same tick they pull on — so the
 * next pull always paid a cold rebuild: re-merge every slice into 12k people and 118k
 * call pairs, then serialise ~50MB of it. That rebuild is what kept killing the
 * container, and a client polling every five minutes hit it every single time.
 *
 * The merge is highest-wins, so applying the slice in place gives exactly what
 * re-reading everything from disk would, at the cost of the PUSH rather than the pool.
 * Read-your-writes still holds: the write is in the view before this returns.
 */
function applyPoolDelta(clean) {
    // Queued for replay onto whatever the in-flight build produces. See buildDeltas.
    if (buildDeltas) buildDeltas.push(clean);
    if (mergedCache) {
        mergePoolInto(mergedCache.pooled, clean);
        mergedCache.at = Date.now();
    }
    // The serialised body no longer describes the view. Rebuilt on the next FULL pull,
    // which is rare now that clients keep a watermark and ask for deltas.
    fullBodyCache = null;
}

/**
 * The friend graph is rebuilt whole rather than patched: it is ~800 entries against 118k
 * calls, so re-merging it costs almost nothing, and it is the one section where a
 * retraction has to be able to REMOVE a name — which an in-place highest-wins merge
 * cannot express.
 */
function invalidateFriends() {
    if (mergedCache) mergedCache.friendsStale = true;
    // Same race as a pool delta: a build in flight is about to install a friend graph it
    // read BEFORE this write, so the new view has to start out knowing it is behind.
    if (buildDeltas) friendsDirtyDuringBuild = true;
    fullBodyCache = null;
}

/** Everything, from scratch. Only on a cold start or the TTL backstop. */
function invalidatePool() { mergedCache = null; fullBodyCache = null; }

/**
 * Each contributor's own slice, held in memory.
 *
 * A push used to read the whole slice back off disk, merge into a fresh copy of it and
 * write the lot out again. The main contributor's slice IS most of the pool, so that was
 * ~50MB parsed, ~50MB rebuilt and ~50MB serialised to absorb a few hundred pairs — once
 * per batch of a chunked push. Keeping it in memory makes a push cost the size of the
 * push; the disk write is debounced so a burst of batches settles into one.
 */
/**
 * A push is APPENDED, not merged into the whole slice and rewritten.
 *
 * The container is capped at 1GB and was being OOM-killed. The old push read the owner's
 * whole slice back off disk, built a second copy of it to merge into, and serialised the
 * result — and the main contributor's slice IS most of the pool, so that was several
 * hundred megabytes of live objects on top of the merged view this process already holds.
 * Holding the slice in memory instead removed the parse and the rebuild but kept a second
 * full copy resident, which is no better.
 *
 * Appending costs the size of the PUSH. It is durable before the response goes out, and
 * replaying the log on top of the slice gives exactly the same result because the merge
 * is highest-wins — the same property that lets a client push in batches at all.
 */
const poolLog = id => `${poolFile(id)}.log`;
const counts = p => ({
    people: Object.keys(p.people || {}).length,
    calls: Object.keys(p.calls || {}).length,
    users: Object.keys(p.users || {}).length
});

/**
 * Stamp every record in a push with the moment this server accepted it.
 *
 * Applied AFTER sanitising, so a client cannot set its own arrival time — the stamp has to
 * mean "when the server saw it" or a delta cannot be trusted to key on it. See newerThan().
 */
function stampArrival(clean, now) {
    for (const id in clean.people) clean.people[id].sat = now;
    for (const k in clean.calls) clean.calls[k].sat = now;
    for (const id in clean.users || {}) clean.users[id].sat = now;
    return clean;
}
// Compacted when the log passes this, so replay stays bounded. Only ever done on a cold
// read, which already has the whole slice in hand.
// Overridable so the tests can drive the log path at a size that does not take a
// gigabyte of fixture to reach.
const MAX_LOG_BYTES = Number(process.env.XICORD_MAX_LOG_BYTES) || 4 * 1024 * 1024;
// Below this a slice is just rewritten in place, which keeps the common case to exactly
// one file per contributor. The log only earns its complexity against a slice big enough
// that rewriting it per push is what breaks the process.
const SMALL_SLICE_BYTES = Number(process.env.XICORD_SMALL_SLICE_BYTES) || 2 * 1024 * 1024;

/**
 * Append one push to a slice's log, leaving the file safe to append to again.
 *
 * Newline-delimited on BOTH sides, which is not redundant — the two guard opposite halves
 * of the same accident. A process killed mid-append leaves a partial line with no
 * terminator: the LEADING newline stops the next record being glued onto that fragment
 * into one line that cannot parse, which would drop both and lose a push already answered
 * 200. The TRAILING newline is what makes this record whole the instant it lands, so it is
 * never the thing a later partial write destroys. Blank lines are skipped on replay, so
 * the cost of the pair is two bytes.
 */
function appendPush(logFile, clean) {
    return fsp.appendFile(logFile, "\n" + JSON.stringify(clean) + "\n", "utf8");
}

/** Slice + everything appended since it was written. */
async function sliceWithLog(file, logFile) {
    const pool = await readJson(file, { people: {}, calls: {}, users: {} });
    if (!pool.people) pool.people = {};
    if (!pool.calls) pool.calls = {};
    if (!pool.users) pool.users = {};
    let text = "";
    try { text = await fsp.readFile(logFile, "utf8"); } catch { return { pool, logBytes: 0 }; }
    for (const line of text.split("\n")) {
        if (!line) continue;
        // A torn last line is possible if the process died mid-append. Everything before
        // it still applies, and the client re-sends anything a failed sync did not bank.
        try { mergePoolInto(pool, JSON.parse(line)); } catch { }
    }
    return { pool, logBytes: Buffer.byteLength(text) };
}

/** Read every slice and merge. Cached, and never run twice concurrently. */
async function mergedView() {
    const expired = mergedCache && Date.now() - mergedCache.builtAt >= POOL_TTL;
    if (mergedCache && !expired) {
        if (mergedCache.friendsStale) {
            mergedCache.friends = mergeFriendGraphs(await readAllUserBlobs());
            mergedCache.friendsStale = false;
            mergedCache.at = Date.now();
        }
        return mergedCache;
    }
    if (poolBuilding) return poolBuilding;
    // Anything written from here until the build installs its result is recorded and
    // replayed onto it, so a push can never fall down the gap between the read and the swap.
    const mine = buildDeltas = [];
    friendsDirtyDuringBuild = false;
    poolBuilding = (async () => {
        try {
            const pooled = mergeAllPools(await readAllPools());
            // The friend graph is pooled too: every contributor sees only their own slice
            // of any given person's friends, so the union is the only complete picture.
            // Read from the private blobs rather than duplicated into the pool files, so
            // an unfriending still retracts through the existing fresher-wins merge.
            const friends = mergeFriendGraphs(await readAllUserBlobs());
            // Replay before publishing, so the view is never observably missing a write
            // that has already been acknowledged.
            for (const d of mine) mergePoolInto(pooled, d);
            const now = Date.now();
            mergedCache = { pooled, friends, at: now, builtAt: now, friendsStale: friendsDirtyDuringBuild };
            return mergedCache;
        } finally {
            // Only clear the buffer if it is still ours: invalidatePool() can start a
            // newer build, and stealing its buffer would lose that build's writes instead.
            if (buildDeltas === mine) { buildDeltas = null; friendsDirtyDuringBuild = false; }
            poolBuilding = null;
        }
    })();
    return poolBuilding;
}

/**
 * Entries this server accepted after `since`.
 *
 * Keyed on `sat` — the arrival stamp — and NOT on the record's own `last`/`at`, which are
 * a client's account of when something happened out in the world. Those two clocks answer
 * different questions, and a delta must key on arrival: a call that ended at 12:00 and
 * syncs at 12:07 has last=12:00, so a puller holding a 12:05 watermark would drop it from
 * that delta and from every later one, since 12:00 never becomes newer than a watermark
 * that only moves forward. `sat` and the watermark are both this server's clock, so the
 * comparison is between two readings of one clock. See mergePerson() in pool.js.
 */
function newerThan(map, since) {
    const out = {};
    for (const k in map) {
        const v = map[k];
        const at = v && v.sat;
        // An unstamped record is sent every time: it predates this field, and guessing
        // "unchanged" would drop it permanently with no way for a client to notice the
        // hole. They pick up a `sat` the next time anyone pushes them.
        if (!(at > 0) || at > since) out[k] = v;
    }
    return out;
}

/**
 * The pooled view, whole or only what has changed.
 *
 * A full pull is 49MB of JSON — 114k call pairs and 11k names — and clients poll it. Almost
 * none of that changes between two pulls a few minutes apart, so `?since=<ms>` returns only
 * the records whose own timestamp is newer.
 *
 * `friends` is deliberately NOT filtered. It is ~800 entries against 114k calls, so sending
 * it whole costs almost nothing — and it is the one section where omission is ambiguous.
 * A retracted friendship LEAVES the union rather than being restamped, so under a
 * timestamp filter it would simply stop appearing, which is indistinguishable from
 * "unchanged" and would keep a withdrawn name alive on every client forever. Sending the
 * whole set, flagged complete, lets a client delete what is no longer there.
 */
async function pooledBody(since) {
    if (!(since > 0)) {
        // Buffered, not streamed, and MEASURED that way round.
        //
        // Streaming this looked obviously right — nothing large held in memory — and was
        // 14x worse on the wire: the platform's edge only gzips buffered responses and
        // does not forward `gzip` in Accept-Encoding to the origin, so a chunked reply
        // goes out raw. 51MB in 9s streamed against 3.6MB in 1.2s buffered, measured
        // against production both ways.
        //
        // The OOM this was meant to prevent came from re-merging and re-serialising per
        // REQUEST; one shared cached string is what fixed that, not streaming. And with
        // incremental pulls a full one is now rare.
        // The same TTL backstop the merged view gets. Without it this cache is held only
        // by its explicit invalidations — which is exactly the mechanism a backstop exists
        // to cover for — so one missed invalidation would serve a stale body forever, and
        // a full pull is the request a client makes precisely to heal drift.
        if (fullBodyCache && Date.now() - fullBodyCache.builtAt < POOL_TTL) return fullBodyCache.body;
        const view = await mergedView();
        const body = JSON.stringify(payload(view.pooled, view.friends,
            view.pooled.people, view.pooled.calls, view.pooled.users || {}, 0, view.at));
        // stamped with the VIEW's own time, not now: the body describes the pool as it
        // was then, and the client turns this into its watermark
        fullBodyCache = { body, at: view.at, builtAt: Date.now() };
        return body;
    }
    const view = await mergedView();
    const { pooled, friends } = view;
    return JSON.stringify(payload(
        pooled, friends,
        newerThan(pooled.people, since),
        newerThan(pooled.calls, since),
        newerThan(pooled.users || {}, since),
        since, view.at
    ));
}


function payload(pooled, friends, people, calls, users, since, builtAt) {
    return {
        people, calls, users, friends,
        // Complete every time, so a client can drop what has vanished. See pooledBody().
        friendsComplete: true,
        since: since || 0,
        // The client sends this back as its next `since`, so the watermark is the
        // SERVER's clock throughout and a skewed client cannot skip records.
        //
        // It is when the data was BUILT, not when it was sent. A cached answer can be a
        // little behind, and stamping it "now" would advance the client past records
        // written after the build but before the send — a hole nothing would ever offer
        // again. The extra millisecond back covers the boundary: newerThan() is a strict
        // `>`, so a record stamped exactly at the build instant would otherwise be
        // filtered out of the next delta too. Erring this way can only resend, never skip.
        syncedAt: (builtAt || Date.now()) - 1,
        counts: {
            people: Object.keys(people).length,
            calls: Object.keys(calls).length,
            users: Object.keys(users).length,
            friends: Object.keys(friends).length,
            // what the whole pool holds, so a delta still reports the real totals
            totalPeople: Object.keys(pooled.people).length,
            totalCalls: Object.keys(pooled.calls).length
        }
    };
}

function sendHtml(res, code, doc) {
    res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(doc);
}

function bearer(req) {
    const h = req.headers.authorization || "";
    return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        // Refuse oversized uploads on the declared length before buffering anything
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > MAX_BODY) return reject({ tooLarge: true });
        let size = 0, over = false;
        const chunks = [];
        req.on("data", c => {
            if (over) return;                      // already refused; discard the rest
            size += c.length;
            if (size > MAX_BODY) {
                // Do NOT destroy the socket here: the response has not been written yet,
                // and killing it now means the client sees a connection reset instead of
                // the 413. The handler destroys it after replying.
                over = true;
                chunks.length = 0;                 // release what we buffered
                reject({ tooLarge: true });
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

const server = http.createServer(async (req, res) => {
    const url = (req.url || "/").split("?")[0];

    if (url === "/v1/health") {
        const slices = await readAllSlices().catch(() => []);
        return send(res, 200, { ok: true, service: "xicord-sync", version: VERSION, devices: slices.length });
    }
    if (url === "/app" || url === "/data") {
        return sendHtml(res, 200, pages.appPage());
    }
    if (url === "/" || url === "/login") {
        // Through the shared cached view, never a direct re-merge. This route needs no
        // token, and re-reading and re-merging every slice per hit — tens of MB of parsing
        // and object building — is precisely the overlapping-full-merge that exhausted the
        // container and had the platform restart it into a loop. Concurrent callers share
        // one build here, and the answer is a single number off a view that is already held.
        let people = 0;
        try { people = Object.keys((await mergedView()).pooled.people).length; } catch { }
        let devices = 0;
        try { devices = (await fsp.readdir(POOL_DIR)).filter(f => f.endsWith(".json")).length; } catch { }
        return sendHtml(res, 200, pages.loginPage({
            configured: auth.configured(),
            devices,
            people
        }));
    }

    /* ---- sign-in ---- */
    if (url === "/auth/login") {
        if (!auth.configured()) {
            return sendHtml(res, 503, pages.errorPage("Not configured", "DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET must be set on the service."));
        }
        res.writeHead(302, { Location: auth.authorizeUrl(), "Cache-Control": "no-store" });
        return res.end();
    }
    if (url === "/auth/callback") {
        const qs = new URLSearchParams((req.url || "").split("?")[1] || "");
        if (!auth.configured()) return sendHtml(res, 503, pages.errorPage("Not configured", "The service is missing its Discord credentials."));
        if (qs.get("error")) return sendHtml(res, 400, pages.errorPage("Sign-in cancelled", qs.get("error_description") || qs.get("error")));
        // Single-use state: without it, someone could hand you a callback URL of their
        // choosing and bind YOUR plugin to THEIR account.
        if (!auth.takeState(qs.get("state"))) return sendHtml(res, 400, pages.errorPage("That sign-in expired", "Sign-in links are single-use and last ten minutes. Start again."));
        let who;
        try { who = await auth.exchange(qs.get("code") || ""); }
        catch (e) { console.error("oauth:", e.message); return sendHtml(res, 502, pages.errorPage("Discord refused the sign-in", "Check the client secret and that the redirect URI matches exactly.")); }

        const tokenNew = auth.mintToken();
        issued[tokenNew] = { user: who.id, username: who.username, at: Date.now() };
        await writeJson(AUTH_FILE, issued);
        console.log(`issued a device token to ${who.username || "?"} (${who.id})`);
        return sendHtml(res, 200, pages.tokenPage({ username: who.username, userId: who.id, token: tokenNew }));
    }

    const token = bearer(req);
    const device = deviceFor(token);
    if (!device) return send(res, 401, { error: "unauthorized" });   // no detail, ever
    const owner = ownerFor(token);   // the Discord id this token belongs to

    /* ---- v2: the shared pool ---- */
    if (url === "/v1/pool" && req.method === "GET") {
        const q = new URLSearchParams((req.url || "").split("?")[1] || "");
        const raw = Number(q.get("since"));
        // Anything not a sane past timestamp means "give me everything": a NaN, a negative
        // or a client clock running fast must degrade to a full pull, never to a silent
        // delta that skips records.
        const since = Number.isFinite(raw) && raw > 0 && raw <= Date.now() ? raw : 0;
        return sendRaw(res, 200, await pooledBody(since));
    }
    if (url === "/v1/pool" && req.method === "POST") {
        if (!owner) return send(res, 403, { error: "this token is not bound to a user" });
        let parsed;
        try { parsed = JSON.parse(await readBody(req)); }
        catch (e) {
            if (e && e.tooLarge) { res.setHeader("Connection", "close"); return send(res, 413, { error: "payload too large" }); }
            return send(res, 400, { error: "invalid json" });
        }
        const clean = stampArrival(sanitizePool(parsed), Date.now());
        const empty = !Object.keys(clean.people).length && !Object.keys(clean.calls).length
            && !Object.keys(clean.users || {}).length;
        let slice = null;
        await withLock(`pool:${owner}`, async () => {
            // A push with nothing in it used to cost the same full read-merge-write as a
            // real one, and clients send them routinely when a delta finds no changes.
            if (empty) return;
            const file = poolFile(owner);
            let sliceBytes = 0;
            try { sliceBytes = (await fsp.stat(file)).size; } catch { sliceBytes = 0; }
            if (sliceBytes <= SMALL_SLICE_BYTES) {
                // Small enough that rewriting it costs nothing, and it keeps the on-disk
                // shape as simple as possible: one file per contributor, always current.
                const next = mergePool(await readJson(file, { people: {}, calls: {}, users: {} }), clean);
                await writeJson(file, next);
                // Free here — this path already holds the whole merged slice.
                slice = counts(next);
            } else {
                // Durable before the response goes out, and the size of the push rather
                // than the size of the slice. See appendPush().
                await appendPush(poolLog(owner), clean);
            }
            // Absorbed into the merged view rather than throwing it away: the merge is
            // highest-wins, so this costs the size of the PUSH instead of a re-merge of
            // the whole pool on the next pull.
            applyPoolDelta(clean);
        });
        const view = mergedCache ? mergedCache.pooled : null;
        return send(res, 200, {
            ok: true, user: owner,
            accepted: counts(clean),
            // This contributor's own slice, for a caller confirming its write landed.
            // Null on the append path: counting it there would mean reading and replaying
            // the whole slice on every push, which is the cost this route exists to avoid.
            slice,
            // The POOL's totals. Null until something has pulled, because nothing has
            // built the merged view yet.
            pool: view ? counts(view) : null
        });
    }

    /* ---- v2: the caller's own private blob ---- */
    if (url === "/v1/me" && req.method === "GET") {
        if (!owner) return send(res, 403, { error: "this token is not bound to a user" });
        const mine = await readJson(userFile(owner), { friends: {}, watching: [], notes: {} });
        return send(res, 200, {
            ...mine, user: owner,
            // `blob` and `accounts` say what this store IS and who writes to it. `user` is
            // kept as-is so existing clients keep working; it now names the blob rather
            // than a Discord account, which is the whole point of the change.
            blob: owner,
            accounts: accountsOn(owner),
            counts: {
                friends: Object.keys(mine.friends || {}).length,
                watching: (mine.watching || []).length,
                notes: Object.keys(mine.notes || {}).length
            }
        });
    }
    if (url === "/v1/me" && req.method === "POST") {
        if (!owner) return send(res, 403, { error: "this token is not bound to a user" });
        let parsed;
        try { parsed = JSON.parse(await readBody(req)); }
        catch (e) {
            if (e && e.tooLarge) { res.setHeader("Connection", "close"); return send(res, 413, { error: "payload too large" }); }
            return send(res, 400, { error: "invalid json" });
        }
        const clean = sanitizePrivate(parsed);
        const merged = await withLock(`user:${owner}`, async () => {
            const next = mergePrivate(await readJson(userFile(owner), { friends: {}, watching: [], notes: {} }), clean);
            await writeJson(userFile(owner), next);
            // the pooled friend graph is read from these blobs, so it is stale now —
            // only that section, which is cheap to redo on its own
            invalidateFriends();
            return next;
        });
        return send(res, 200, {
            ok: true, user: owner,
            counts: {
                friends: Object.keys(merged.friends).length,
                watching: merged.watching.length,
                notes: Object.keys(merged.notes).length
            }
        });
    }

    if (url === "/v1/pull" && req.method === "GET") {
        const pooled = mergeAll(await readAllSlices());
        return send(res, 200, {
            ...pooled,
            syncedAt: Date.now(),
            people: Object.keys(pooled.dossiers).length,
            names: Object.keys(pooled.users).length
        });
    }

    if (url === "/v1/push" && req.method === "POST") {
        let text;
        try { text = await readBody(req); }
        catch (e) {
            if (e && e.tooLarge) {
                // Close the connection after replying: that stops the upload without
                // draining it, and without tearing the socket down before the client has
                // had a chance to read the 413.
                res.setHeader("Connection", "close");
                return send(res, 413, { error: "payload too large" });
            }
            return send(res, 400, { error: "bad request" });
        }
        let parsed;
        try { parsed = JSON.parse(text); } catch { return send(res, 400, { error: "invalid json" }); }

        const clean = sanitize(parsed);
        const result = await withLock(device, async () => {
            // merge into this device's own slice, so a delta adds without erasing
            const merged = mergeSnapshot(await readSlice(device), clean);
            await writeSlice(device, merged);
            return merged;
        });
        return send(res, 200, {
            ok: true, device,
            accepted: { people: Object.keys(clean.dossiers).length, names: Object.keys(clean.users).length },
            slice: { people: Object.keys(result.dossiers).length, names: Object.keys(result.users).length }
        });
    }

    return send(res, 404, { error: "not found" });
});

/**
 * Fold a blob left behind by an aliasing change into the blob its account now points at,
 * then remove the original.
 *
 * Re-pointing an account at a named blob orphans whatever it had already stored: nothing
 * reads `users/<accountId>.json` once the account resolves to `lab-a`. The pooled friend
 * graph still counts it, because that reads every file on disk — so the data is not lost,
 * but the same facts arrive from two slices and the account's own view looks empty until
 * it next pushes.
 *
 * Adopting is strictly better than waiting for that push: the canonical blob is correct
 * immediately, and there is no window where a client could be told it has nothing.
 *
 * ORDER MATTERS. The merged blob is written and read back before the original is removed,
 * so a crash or a full disk leaves the source intact and the adoption simply runs again
 * next boot. Nothing is deleted on the strength of a write we did not confirm.
 */
async function adoptOrphanedBlobs() {
    const map = aliasMap();
    for (const [from, to] of map) {
        if (from === to) continue;
        const target = canonical(from);
        if (target === from) continue;
        for (const [dir, read, merge, empty] of [
            [USERS_DIR, userFile, mergePrivate, { friends: {}, watching: [], notes: {} }],
            [POOL_DIR, poolFile, mergePool, { people: {}, calls: {}, users: {} }],
        ]) {
            const src = path.join(dir, `${from}.json`);
            try { await fsp.access(src); } catch { continue; }   // nothing to adopt
            try {
                const orphan = await readJson(src, null);
                if (!orphan) { console.warn(`adopt: ${src} unreadable, leaving it alone`); continue; }
                const dst = read(target);
                const merged = merge(await readJson(dst, empty), orphan);
                await writeJson(dst, merged);
                // read back before deleting: the point of the whole ordering
                const check = await readJson(dst, null);
                if (!check) { console.error(`adopt: ${dst} did not read back, keeping ${src}`); continue; }
                await fsp.unlink(src);
                console.log(`adopt: folded ${from} into ${target} (${path.basename(dir)}) and removed the orphan`);
            } catch (e) {
                console.error(`adopt: ${from} -> ${target} failed, original kept:`, e.message);
            }
        }
    }
}

if (require.main === module) {
    loadTokens();
    if (!tokens.size) console.warn("XICORD_TOKENS is empty — every push and pull will be rejected");
    ensureDirs()
        .then(adoptOrphanedBlobs)
        .then(() => server.listen(PORT, () => console.log(`xicord-sync ${VERSION} listening on ${PORT}, data in ${DATA_DIR}`)))
        .catch(e => { console.error("could not prepare", DATA_DIR, e); process.exit(1); });
}

module.exports = { server, loadTokens, deviceFor, readSlice, writeSlice, readAllSlices, ensureDirs, adoptOrphanedBlobs };
