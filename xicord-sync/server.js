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

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || "/data";
const DEVICES_DIR = path.join(DATA_DIR, "devices");
// A full re-sync is ~6MB today; leave room to grow. Overridable so the tests can drive
// the oversize path at a size that doesn't take a second to transfer.
const MAX_BODY = Number(process.env.MAX_BODY_BYTES) || 32 * 1024 * 1024;
const VERSION = "1.0.0";

/* ---------------- tokens ---------------- */
// token -> deviceId. The device is derived from the token, never sent by the client, so
// one device physically cannot write into another's slice.
let tokens = new Map();

function loadTokens() {
    const raw = process.env.XICORD_TOKENS || "";
    const map = new Map();
    for (const pair of raw.split(",")) {
        const trimmed = pair.trim();
        if (!trimmed) continue;
        const idx = trimmed.indexOf(":");
        const token = (idx === -1 ? trimmed : trimmed.slice(0, idx)).trim();
        const name = (idx === -1 ? "" : trimmed.slice(idx + 1).trim()) || "device";
        if (token.length < 16) {
            console.warn(`refusing a token shorter than 16 chars for "${name}"`);
            continue;
        }
        // filename-safe, stable, and not the token itself — the token never hits disk
        const deviceId = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48)
            + "-" + crypto.createHash("sha256").update(token).digest("hex").slice(0, 8);
        map.set(token, deviceId);
    }
    tokens = map;
    console.log(`loaded ${tokens.size} token(s): ${[...tokens.values()].join(", ") || "none"}`);
}

/** Constant-time lookup: comparing tokens with === leaks length and prefix by timing. */
function deviceFor(token) {
    if (!token) return null;
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

    if (url === "/v1/health" || url === "/") {
        const slices = await readAllSlices().catch(() => []);
        return send(res, 200, { ok: true, service: "xicord-sync", version: VERSION, devices: slices.length });
    }

    const device = deviceFor(bearer(req));
    if (!device) return send(res, 401, { error: "unauthorized" });   // no detail, ever

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

if (require.main === module) {
    loadTokens();
    if (!tokens.size) console.warn("XICORD_TOKENS is empty — every push and pull will be rejected");
    ensureDirs()
        .then(() => server.listen(PORT, () => console.log(`xicord-sync ${VERSION} listening on ${PORT}, data in ${DATA_DIR}`)))
        .catch(e => { console.error("could not prepare", DATA_DIR, e); process.exit(1); });
}

module.exports = { server, loadTokens, deviceFor, readSlice, writeSlice, readAllSlices, ensureDirs };
