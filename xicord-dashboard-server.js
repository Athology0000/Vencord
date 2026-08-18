/*
 * Xicord Dashboard server — started by start.bat.
 * Reads the live snapshot that the "Xicord Cache" plugin writes into Vencord's
 * settings.json, serves the dashboard on localhost, and opens your browser.
 * The dashboard auto-loads and refreshes from /data. Nothing leaves your PC.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const xcrypto = require("./xicord-crypto");

const PORT_START = 8787;
const HTML_PATH = path.join(__dirname, "xicord-dashboard.html");

// Where Vencord stores its settings (the plugins write their data here).
function settingsCandidates() {
    const list = [];
    if (process.env.APPDATA) list.push(path.join(process.env.APPDATA, "Vencord", "settings", "settings.json"));
    if (process.env.HOME) {
        list.push(path.join(process.env.HOME, ".config", "Vencord", "settings", "settings.json")); // linux
        list.push(path.join(process.env.HOME, "Library", "Application Support", "Vencord", "settings", "settings.json")); // mac
    }
    return list;
}
function settingsPath() {
    for (const p of settingsCandidates()) { try { if (fs.existsSync(p)) return p; } catch { } }
    return null;
}

// The snapshot now lives in its own file beside settings.json. It used to be a field
// inside settings.json, where it grew past 1.6MB and made Vencord rewrite the lot on
// every unrelated setting change. Both are still read, newest wins, so an older plugin
// build (or the web build, which has no main process to write files with) keeps working.
function snapshotFilePath() {
    const s = settingsPath();
    return s ? path.join(path.dirname(s), "xicord-cache.json") : null;
}

/** The DPAPI-sealed data key lives beside the data it protects. */
function keyFilePath() {
    const s = settingsPath();
    return s ? path.join(path.dirname(s), "xicord-key.bin") : null;
}

/**
 * Decrypt a snapshot if it is sealed. Plaintext passes through untouched, so this keeps
 * working against an older plugin build. `create:false` matters: the server must never
 * mint the key — Discord owns that, and a server-made key would seal nothing while
 * leaving a file Discord then refuses to overwrite.
 */
function decryptSnapshot(text) {
    if (!xcrypto.isSealed(text)) return text;
    const kp = keyFilePath();
    try {
        return xcrypto.open(text, kp ? xcrypto.getKey(kp, { create: false }) : null);
    } catch (e) {
        console.error("  Could not decrypt the snapshot:", e.message);
        return JSON.stringify({
            xicordCache: 1, empty: true,
            reason: "The snapshot is encrypted and could not be opened on this account. "
                + "DPAPI keys are tied to the Windows user that created them — sign in as that user, "
                + "or delete xicord-key.bin and xicord-cache.json to start fresh."
        });
    }
}

/** The dedicated file, or null if it isn't there / isn't readable. */
function readSnapshotFile() {
    const p = snapshotFilePath();
    if (!p) return null;
    try {
        if (!fs.existsSync(p)) return null;
        const txt = fs.readFileSync(p, "utf8");
        return txt && txt.length > 2 ? txt : null;
    } catch { return null; }
}

/** The legacy copy embedded in settings.json. */
function readSnapshotFromSettings() {
    const p = settingsPath();
    if (!p) return null;
    try {
        const s = JSON.parse(fs.readFileSync(p, "utf8"));
        const cache = s.plugins && s.plugins["Xicord Cache"];
        const snap = cache && cache.snapshot;
        return snap && typeof snap === "string" && snap.length > 2 ? snap : null;
    } catch { return null; }
}

function readSnapshot() {
    if (!settingsPath()) {
        return JSON.stringify({ xicordCache: 1, empty: true, reason: "Vencord settings folder not found" });
    }
    const fromFile = readSnapshotFile();
    if (fromFile) return decryptSnapshot(fromFile);
    const legacy = readSnapshotFromSettings();
    if (legacy) return decryptSnapshot(legacy);
    return JSON.stringify({
        xicordCache: 1, empty: true,
        reason: "No snapshot yet — enable the Xicord Cache plugin (Auto snapshot) and wait ~2 minutes"
    });
}

function serve(port) {
    const server = http.createServer((req, res) => {
        const url = (req.url || "/").split("?")[0];
        if (url === "/data") {
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(readSnapshot());
            return;
        }
        // everything else -> the dashboard page
        fs.readFile(HTML_PATH, (err, buf) => {
            if (err) {
                res.writeHead(500, { "Content-Type": "text/plain" });
                res.end("xicord-dashboard.html not found next to this script.\nExpected at: " + HTML_PATH);
                return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(buf);
        });
    });
    server.on("error", e => {
        if (e.code === "EADDRINUSE" && port < PORT_START + 10) { serve(port + 1); return; }
        console.error("Server error:", e.message);
        process.exit(1);
    });
    server.listen(port, "127.0.0.1", () => {
        // report the file actually being read, not just where settings live
        const dataUrl = (readSnapshotFile() ? snapshotFilePath() : settingsPath())
            || "(Vencord settings folder not found)";
        const url = "http://localhost:" + port;
        const raw = readSnapshotFile();
        const enc = raw && xcrypto.isSealed(raw)
            ? "encrypted (DPAPI, this Windows account only)"
            : xcrypto.isWindows ? "NOT encrypted yet — reload Discord to seal it" : "not encrypted (Windows only)";
        console.log("");
        console.log("  Xicord Dashboard running at  " + url);
        console.log("  Reading live data from       " + dataUrl);
        console.log("  Snapshot at rest             " + enc);
        console.log("");
        console.log("  Leave this window open. Close it to stop. The dashboard");
        console.log("  refreshes automatically every 30s.");
        console.log("");
        if (process.platform === "win32") exec('start "" "' + url + '"');
        else if (process.platform === "darwin") exec('open "' + url + '"');
        else exec('xdg-open "' + url + '"');
    });
}

serve(PORT_START);
