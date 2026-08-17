// Exercises the REAL xicord-crypto.js — the at-rest encryption both Discord's main
// process and the standalone dashboard server share.
//   node xicord-crypto.test.mjs
//
// The properties that matter, and why:
//   * plaintext must pass through untouched, or upgrading would strand every existing
//     install behind a file it suddenly cannot read;
//   * a sealed blob that CANNOT be opened must throw, never return empty — the caller's
//     next move is to write, and "no data" would overwrite the real thing;
//   * the key file's contents are interpolated into a PowerShell command, so a tampered
//     key file must be rejected as malformed rather than executed.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { createCipheriv, randomBytes } from "crypto";
import { gzipSync } from "zlib";

// Build a sealed blob the way a chosen build would, so a test can forge one exactly:
//   header "XIC1", gzip=false  -> the pre-compression format still on disk in the wild
//   header "XIC2", gzip=false  -> decrypts fine but is not gzip; open() must fail loud
function forge(plaintext, key, header, gzip) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const input = gzip ? gzipSync(Buffer.from(String(plaintext), "utf8")) : Buffer.from(String(plaintext), "utf8");
    const body = Buffer.concat([c.update(input), c.final()]);
    return [header, iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

const require_ = createRequire(import.meta.url);
const X = require_("./xicord-crypto.js");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};
const throws = fn => { try { fn(); return false; } catch { return true; } };

const dir = mkdtempSync(join(tmpdir(), "xicord-crypto-"));
const KEY = join(dir, "xicord-key.bin");

console.log("\n-- the key is created once, sealed, and reopened --");
const key = X.getKey(KEY);
if (!X.isWindows) {
    console.log("  (not Windows — DPAPI unavailable, so only the pass-through paths run)");
    ok("degrades to plaintext rather than failing", key === null);
    ok("sealing without a key returns the input untouched", X.seal("hello", key) === "hello");
} else {
    ok("a key is produced", Buffer.isBuffer(key) && key.length === 32, String(key && key.length));
    ok("it is stored sealed, not raw", (() => {
        const onDisk = readFileSync(KEY, "utf8");
        return onDisk.length > 44 && Buffer.from(onDisk, "base64").compare(key) !== 0;
    })());
    ok("the raw key is nowhere in the file", readFileSync(KEY, "utf8").indexOf(key.toString("base64")) < 0);

    console.log("\n-- asking twice does not mint a second key --");
    // Two keys would mean files written by one process that the other can never open.
    const before = readFileSync(KEY, "utf8");
    const again = X.getKey(KEY);
    ok("the same key comes back", again.equals(key));
    ok("and the file is untouched", readFileSync(KEY, "utf8") === before);
}

console.log("\n-- sealing and opening --");
const payload = JSON.stringify({ users: { u1: { username: "mara" } }, secret: "voice sessions" });
const blob = X.seal(payload, key);
ok("a sealed blob is recognisable as ours", X.isSealed(blob), blob.slice(0, 24));
ok("it round-trips exactly", X.open(blob, key) === payload);
if (X.isWindows) {
    ok("the plaintext is not visible in it", blob.indexOf("mara") < 0 && blob.indexOf("username") < 0);
    ok("sealing twice gives different bytes (fresh IV, no pattern leak)", X.seal(payload, key) !== blob);
}

console.log("\n-- the body is compressed before it is sealed --");
if (X.isWindows) {
    // The real snapshot is one enormous, extremely repetitive JSON document. A payload
    // shaped like it — thousands of near-identical records — is the case the whole change
    // exists for, so the test measures the thing that matters: the sealed blob is far
    // SMALLER than the plaintext, which the old raw-then-base64 format could never be
    // (base64 alone inflates by a third).
    const bulky = JSON.stringify({ users: Array.from({ length: 20000 }, (_, i) => ({ id: i, username: "mara", avatar: "https://cdn.discordapp.com/avatars/1/abc.webp" })) });
    const sealed = X.seal(bulky, key);
    ok("the current writer stamps XIC2", sealed.startsWith("XIC2."), sealed.slice(0, 8));
    ok("the sealed blob is much smaller than the plaintext, not larger",
        sealed.length < bulky.length / 2, `${sealed.length} vs ${bulky.length}`);
    ok("and it still round-trips byte-for-byte", X.open(sealed, key) === bulky);

    console.log("\n-- a file written by the pre-compression build still opens --");
    // The crux for the 298MB cache already on disk: it is a XIC1 blob (raw UTF-8, no gzip)
    // and the new reader must open it without gunzipping.
    const legacy = forge(payload, key, "XIC1", false);
    ok("a XIC1 blob is still recognised as ours", X.isSealed(legacy));
    ok("and opens to the original, no decompression applied", X.open(legacy, key) === payload);

    console.log("\n-- a XIC2 blob whose body is not gzip fails loud, never returns junk --");
    // Decrypts cleanly (valid GCM tag) but the plaintext is not gzip. gunzip must throw
    // rather than hand back garbage that a caller would try to JSON.parse.
    const mislabelled = forge(payload, key, "XIC2", false);
    ok("a XIC2 body that is not gzip throws", throws(() => X.open(mislabelled, key)));
}

console.log("\n-- plaintext from an older build still passes through --");
ok("a plain JSON string is not treated as sealed", !X.isSealed(payload));
ok("and opening it returns it unchanged", X.open(payload, key) === payload);
ok("opening plaintext works even with no key at all", X.open(payload, null) === payload);
ok("an empty string survives", X.open("", key) === "");
ok("something that merely starts with X is not mistaken for ours", !X.isSealed("XICORD stuff"));

if (X.isWindows) {
    console.log("\n-- a sealed blob that cannot be opened must FAIL, never look empty --");
    // Returning "" here would read as "you have no data", and the caller would then
    // write over the real file with an empty one.
    ok("no key -> throws", throws(() => X.open(blob, null)));
    ok("wrong key -> throws", throws(() => X.open(blob, Buffer.alloc(32, 7))));
    ok("a flipped byte in the body is caught by the GCM tag",
        throws(() => X.open(blob.slice(0, -8) + "AAAAAAA=", key)));
    ok("a swapped auth tag is caught", throws(() => {
        const p = blob.split("."); p[2] = Buffer.alloc(16, 1).toString("base64"); return X.open(p.join("."), key);
    }));
    ok("a truncated blob is caught", throws(() => X.open("XIC1.abc.def", key)));
    ok("a blob with junk where base64 belongs is caught", throws(() => X.open("XIC1.@@@.@@@.@@@", key)));
}

console.log("\n-- a tampered key file must be rejected, not executed --");
// getKey() interpolates the file's contents into a PowerShell command. Anything that is
// not pure base64 has to be refused before it gets near a shell.
for (const evil of [
    "'; Write-Output PWNED; '",
    "abc'); Start-Process calc.exe; ('",
    "abc$(whoami)def",
    "abc`ndef",
]) {
    const bad = join(dir, "evil-" + Buffer.from(evil).toString("hex").slice(0, 8) + ".bin");
    writeFileSync(bad, evil, "utf8");
    const got = X.getKey(bad, { create: false });
    ok(`rejected: ${JSON.stringify(evil.slice(0, 28))}`, got === null, String(got));
}
ok("a valid-looking but wrong-length key is rejected", (() => {
    const short = join(dir, "short.bin");
    writeFileSync(short, Buffer.from("too short").toString("base64"), "utf8");
    return X.getKey(short, { create: false }) === null;
})());
ok("an absent key file with create:false yields nothing rather than making one",
    X.getKey(join(dir, "nope.bin"), { create: false }) === null);

console.log("\n-- the shape the dashboard server looks for --");
ok("the current envelope version is XIC2", X.HEADER === "XIC2");
ok("a sealed blob has exactly four dot-separated parts", X.seal("x", key).split(".").length === (key ? 4 : 1));
if (X.isWindows) {
    ok("a big payload survives (the real snapshot is ~0.5MB)", (() => {
        const big = "x".repeat(600000);
        return X.open(X.seal(big, key), key) === big;
    })());
    ok("unicode survives the round-trip", (() => {
        const u = JSON.stringify({ n: "мара 日本 🎧 — em-dash" });
        return X.open(X.seal(u, key), key) === u;
    })());
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
