/*
 * Xicord at-rest encryption — the shared core.
 *
 * One random AES-256-GCM "data key" protects every Xicord file. The data key itself is
 * sealed with Windows DPAPI (CurrentUser), so it can only be unwrapped while logged in
 * as you, on this machine, with nothing to type and nothing to remember.
 *
 * Why not Electron's safeStorage, which is right there in Discord's main process: on
 * Windows it is Chromium's OSCrypt, whose master key lives inside Discord's own
 * "Local State". The standalone dashboard server is plain Node and cannot follow that
 * trail, and the whole point of the snapshot file is that a separate process reads it.
 * Raw DPAPI is the one mechanism both sides can reach without a native module.
 *
 * What this protects against, stated honestly:
 *   - the files being copied off this machine (a synced backup, a stolen drive, a
 *     support upload) — they are useless anywhere else, under any other account;
 *   - another Windows account on this PC reading them.
 * What it does NOT protect against: anything running AS you can ask DPAPI to unwrap the
 * key exactly as we do. Defeating that needs a passphrase, which was the trade-off
 * deliberately not taken here.
 */
"use strict";

const { execFileSync } = require("child_process");
const { randomBytes, createCipheriv, createDecipheriv } = require("crypto");
const { readFileSync, writeFileSync } = require("fs");
const { gzipSync, gunzipSync } = require("zlib");

// The envelope version is the format marker, so the file is self-describing and no
// separate schema flag is needed.
//   XIC1 — AES-256-GCM over raw UTF-8. Written by every build before compression existed.
//   XIC2 — AES-256-GCM over gzipped UTF-8. The snapshot is ~220MB of JSON that gzips to
//          about a fifth of that, and the file was previously the plaintext base64'd
//          under the tag — so this is the difference between a ~300MB file and a ~70MB one
//          for the same data. Reads of an existing XIC1 file must keep working, so the
//          reader recognises both and only the current writer emits XIC2.
const HEADER = "XIC2";
const SEALED_HEADERS = new Set(["XIC1", "XIC2"]);
const KEY_BYTES = 32;
const IV_BYTES = 12;
// base64 and nothing else. These strings are interpolated into a PowerShell command, so
// a tampered key file must not be able to smuggle one in.
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

const isWindows = process.platform === "win32";

function assertB64(s, what) {
    if (typeof s !== "string" || !s.length || !B64.test(s)) throw new Error(`Xicord crypto: malformed ${what}`);
    return s;
}

function powershell(script) {
    // stderr is captured, not inherited: a rejected key makes PowerShell print a
    // multi-line .NET stack trace, and that would land in Discord's console looking like
    // a crash. The failure is reported by us, in one line, by the caller.
    try {
        return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
            { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 20, stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (e) {
        // The thrown Error carries the whole command and the whole .NET stack. Reduce it
        // to the one line that says what went wrong, so the caller can log it as such.
        const first = String((e && e.stderr) || "").split("\n").map(s => s.trim()).filter(Boolean)[0];
        throw new Error(first || (e && e.message ? String(e.message).split("\n")[0] : "PowerShell failed"));
    }
}

/** DPAPI-seal raw bytes for the current Windows user. */
function dpapiProtect(buf) {
    return powershell(`Add-Type -AssemblyName System.Security;
        $b=[Convert]::FromBase64String('${buf.toString("base64")}');
        [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))`);
}
function dpapiUnprotect(b64) {
    assertB64(b64, "key file");
    return Buffer.from(powershell(`Add-Type -AssemblyName System.Security;
        $b=[Convert]::FromBase64String('${b64}');
        [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))`), "base64");
}

// Unwrapping costs a PowerShell launch (~200ms), so it happens once per process.
let cachedKey = null;
let cachedFrom = null;

/**
 * The data key for `keyPath`, creating and sealing one on first use.
 * Returns null when encryption is unavailable (non-Windows, or DPAPI refused) — callers
 * must treat that as "carry on in plaintext", never as a reason to lose data.
 */
function getKey(keyPath, { create = true } = {}) {
    if (cachedKey && cachedFrom === keyPath) return cachedKey;
    if (!isWindows) return null;
    try {
        let sealed = null;
        try { sealed = readFileSync(keyPath, "utf8").trim(); } catch { /* not created yet */ }

        if (!sealed) {
            if (!create) return null;
            const fresh = randomBytes(KEY_BYTES);
            // wx: if Discord and the dashboard both start cold at once, exactly one wins
            // and the loser re-reads the winner's key instead of overwriting it — two
            // keys would mean files nobody can open.
            try {
                writeFileSync(keyPath, dpapiProtect(fresh), { encoding: "utf8", flag: "wx" });
            } catch (e) {
                if (e && e.code !== "EEXIST") throw e;
            }
            sealed = readFileSync(keyPath, "utf8").trim();
        }

        const key = dpapiUnprotect(sealed);
        if (key.length !== KEY_BYTES) throw new Error("wrong key length");
        cachedKey = key;
        cachedFrom = keyPath;
        return key;
    } catch (e) {
        console.error("Xicord crypto: key unavailable, continuing unencrypted —", e.message);
        return null;
    }
}

/** The envelope version if a blob is one of ours, else null (plaintext from an old build). */
function sealedHeader(text) {
    if (typeof text !== "string") return null;
    const dot = text.indexOf(".");
    if (dot < 0) return null;
    const h = text.slice(0, dot);
    return SEALED_HEADERS.has(h) ? h : null;
}

/** Whether a blob is one of ours, rather than plaintext JSON from an older build. */
function isSealed(text) {
    return sealedHeader(text) !== null;
}

function seal(plaintext, key) {
    if (!key) return plaintext;
    const iv = randomBytes(IV_BYTES);
    const c = createCipheriv("aes-256-gcm", key, iv);
    // Compressed BEFORE encryption: ciphertext is incompressible, so it has to be this
    // order. The plaintext here is one large, extremely repetitive JSON document, which is
    // exactly what gzip is best at.
    const gz = gzipSync(Buffer.from(String(plaintext), "utf8"));
    const body = Buffer.concat([c.update(gz), c.final()]);
    return [HEADER, iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

/**
 * Open a blob. Plaintext passes straight through, so an existing install keeps working
 * and the very first sealed write is what actually migrates a file.
 * Throws only when a blob IS ours and cannot be opened — silently returning nothing
 * there would look exactly like "you have no data", and the caller would overwrite it.
 */
function open(blob, key) {
    const header = sealedHeader(blob);
    if (!header) return blob;
    if (!key) throw new Error("this file is encrypted and the key could not be unwrapped");
    const parts = String(blob).split(".");
    if (parts.length !== 4) throw new Error("malformed sealed blob");
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(assertB64(parts[1], "iv"), "base64"));
    d.setAuthTag(Buffer.from(assertB64(parts[2], "tag"), "base64"));
    const buf = Buffer.concat([d.update(Buffer.from(assertB64(parts[3], "body"), "base64")), d.final()]);
    // XIC1 bodies are raw UTF-8; XIC2 bodies are gzipped. A XIC2 body that decrypts (so the
    // GCM tag was valid) but is not valid gzip makes gunzipSync throw — the same fail-loud
    // contract this function already promises for a bad tag.
    return (header === "XIC2" ? gunzipSync(buf) : buf).toString("utf8");
}

module.exports = { getKey, seal, open, isSealed, HEADER, isWindows, _dpapiProtect: dpapiProtect, _dpapiUnprotect: dpapiUnprotect };
