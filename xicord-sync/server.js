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
const { mergeAllPools, mergePool, sanitizePool, sanitizePrivate, mergePrivate, mergeFriendGraphs } = require("./pool");
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

async function readAllPools() {
    let names = [];
    try { names = await fsp.readdir(POOL_DIR); } catch { return []; }
    const out = [];
    for (const n of names) {
        if (!n.endsWith(".json")) continue;
        out.push(await readJson(path.join(POOL_DIR, n), { people: {}, calls: {}, users: {} }));
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
        const pool = mergeAllPools(await readAllPools().catch(() => []));
        let devices = 0;
        try { devices = (await fsp.readdir(POOL_DIR)).filter(f => f.endsWith(".json")).length; } catch { }
        return sendHtml(res, 200, pages.loginPage({
            configured: auth.configured(),
            devices,
            people: Object.keys(pool.people).length
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
        const pooled = mergeAllPools(await readAllPools());
        // The friend graph is pooled too: every contributor sees only their own slice of
        // any given person's friends, so the union is the only complete picture available.
        // Read from the private blobs rather than duplicated into the pool files, so an
        // unfriending still retracts through the existing fresher-wins merge.
        const friends = mergeFriendGraphs(await readAllUserBlobs());
        // counts go under `counts`: spreading `pooled` and then setting `people`/`calls`
        // replaced the records with their own lengths, so a pull returned two numbers
        return send(res, 200, {
            ...pooled,
            friends,
            syncedAt: Date.now(),
            counts: {
                people: Object.keys(pooled.people).length,
                calls: Object.keys(pooled.calls).length,
                users: Object.keys(pooled.users || {}).length,
                friends: Object.keys(friends).length
            }
        });
    }
    if (url === "/v1/pool" && req.method === "POST") {
        if (!owner) return send(res, 403, { error: "this token is not bound to a user" });
        let parsed;
        try { parsed = JSON.parse(await readBody(req)); }
        catch (e) {
            if (e && e.tooLarge) { res.setHeader("Connection", "close"); return send(res, 413, { error: "payload too large" }); }
            return send(res, 400, { error: "invalid json" });
        }
        const clean = sanitizePool(parsed);
        const merged = await withLock(`pool:${owner}`, async () => {
            const next = mergePool(await readJson(poolFile(owner), { people: {}, calls: {}, users: {} }), clean);
            await writeJson(poolFile(owner), next);
            return next;
        });
        return send(res, 200, {
            ok: true, user: owner,
            accepted: { people: Object.keys(clean.people).length, calls: Object.keys(clean.calls).length, users: Object.keys(clean.users || {}).length },
            slice: { people: Object.keys(merged.people).length, calls: Object.keys(merged.calls).length, users: Object.keys(merged.users || {}).length }
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
