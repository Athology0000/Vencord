// Collect everything a fresh PC needs that `git clone` will NOT give it.
//   node xicord-bundle.mjs [destination]
//
// src/userplugins is in .gitignore and the crypto/server/launcher files were never added,
// so a clone of this repo produces a Vencord with no Xicord in it at all. That is the
// single thing most likely to go wrong on a new machine: the build succeeds, Discord
// launches, and nothing is there. This copies the missing pieces into one folder to move
// across, and then says exactly what to do with it.
//
// What is deliberately NOT copied:
//   xicord-key.bin       DPAPI-sealed to one Windows account; useless elsewhere and the
//                        new PC mints its own on first snapshot.
//   xicord-cache.json    that machine's observations. The new PC builds its own and the
//                        two meet in the pool, which is the entire point.
//   settings.json        carries the sync token, which must be one per account.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEST = resolve(process.argv[2] || join(ROOT, "xicord-transfer"));

// Everything here is either gitignored or was never `git add`ed. Verified against
// `git status --short --ignored`, not from memory.
const ITEMS = [
    ["src/userplugins", "dir", "every Xicord plugin — gitignored, so a clone has none of them"],
    ["xicord-crypto.js", "file", "at-rest encryption, shared by the plugin and the dashboard server"],
    ["xicord-dashboard-server.js", "file", "the local dashboard server"],
    ["xicord-dashboard.html", "file", "the dashboard page (this one IS in git, copied anyway so the folder is self-contained)"],
    ["start.bat", "file", "launcher for the dashboard"],
    ["xicord-cache-sample.json", "file", "sample export, so the dashboard has something to show before the first sync"],
];

let copied = 0, missing = [];
mkdirSync(DEST, { recursive: true });

for (const [rel, kind, why] of ITEMS) {
    const from = join(ROOT, rel);
    if (!existsSync(from)) { missing.push(rel); continue; }
    const to = join(DEST, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: kind === "dir" });
    const n = kind === "dir" ? countFiles(from) : 1;
    copied += n;
    console.log(`  ${String(n).padStart(3)} file(s)  ${rel.padEnd(28)} ${why}`);
}

function countFiles(dir) {
    let n = 0;
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        n += statSync(p).isDirectory() ? countFiles(p) : 1;
    }
    return n;
}

// A plugin that imports a repo-root file the bundle forgot fails at BUILD time on the new
// machine, which is a baffling place to discover a packaging mistake. Catch it here.
// xicordCache/native.ts importing ../../../xicord-crypto is exactly this case.
const unresolved = [];
for (const file of walk(join(DEST, "src/userplugins"))) {
    if (!/\.tsx?$/.test(file)) continue;
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const m of text.matchAll(/from\s+"((?:\.\.\/)+[^"./][^"]*)"/g)) {
        const target = m[1].replace(/^(\.\.\/)+/, "");
        // only repo-root escapes matter; anything still inside src/ travels with the tree
        if (m[1].split("../").length - 1 < 3) continue;
        const packaged = ITEMS.some(([rel]) => rel === target || rel === `${target}.js` || rel === `${target}.mjs`);
        if (!packaged) unresolved.push(`${file.slice(DEST.length + 1)} imports ${m[1]}`);
    }
}

function* walk(dir) {
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) yield* walk(p);
        else yield p;
    }
}

writeFileSync(join(DEST, "READ-ME-FIRST.txt"),
    `Xicord transfer bundle\n` +
    `======================\n\n` +
    `Copy the contents of this folder over a fresh Vencord checkout, keeping the paths:\n\n` +
    `  src/userplugins/            -> <vencord>/src/userplugins/\n` +
    `  xicord-*.js / .html / .bat  -> <vencord>/\n\n` +
    `Then, in the Vencord folder:\n\n` +
    `  pnpm install\n` +
    `  pnpm build\n` +
    `  pnpm inject\n\n` +
    `Not included, on purpose:\n` +
    `  xicord-key.bin    sealed to one Windows account; the new PC mints its own\n` +
    `  xicord-cache.json that machine's own observations\n` +
    `  settings.json     holds the sync token, which must be one per account\n`);

console.log(`\n${copied} files -> ${DEST}`);
if (missing.length) console.log(`MISSING (not on this machine): ${missing.join(", ")}`);
if (unresolved.length) console.log(`UNRESOLVED IMPORTS:\n  ${unresolved.join("\n  ")}`);
console.log(missing.length || unresolved.length ? "\nBundle is INCOMPLETE." : "\nBundle looks complete.");
process.exit(missing.length || unresolved.length ? 1 : 0);
