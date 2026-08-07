// Exercises the REAL adoptOrphanedBlobs() from server.js — the only code here that
// DELETES a user's data.
//   node xicord-sync/_adopt.test.mjs
//
// Re-pointing an account at a named blob orphans whatever it had already stored: nothing
// reads users/<accountId>.json once the account resolves to `lab-a`. Adopting folds it in
// and removes the leftover, so the canonical blob is right immediately instead of looking
// empty until the client next pushes.
//
// The property under test is the ORDER. The merged blob must be written and read back
// before the original is unlinked, so a crash or a full disk leaves the source intact and
// the adoption just runs again. Nothing may be deleted on the strength of a write nobody
// confirmed — get that wrong and it is not a failing test, it is somebody's data.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";

const ACC = "1239350611800231956";
const BLOB = "lab-a";
const P1 = "900000000000000001", P2 = "900000000000000002";
const F1 = "800000000000000001", F2 = "800000000000000002";

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${extra ? "\n          " + extra : ""}`); } };

/** A fresh data dir plus a freshly-required server module bound to it. */
function bed({ aliases = `${ACC}=${BLOB}`, orphan, existing } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "xicord-adopt-"));
    for (const d of ["users", "pool", "auth", "devices"]) mkdirSync(join(dir, d), { recursive: true });
    if (orphan) writeFileSync(join(dir, "users", `${ACC}.json`), JSON.stringify(orphan));
    if (existing) writeFileSync(join(dir, "users", `${BLOB}.json`), JSON.stringify(existing));
    process.env.DATA_DIR = dir;
    process.env.XICORD_ALIASES = aliases;
    process.env.XICORD_TOKENS = "";
    const require = createRequire(import.meta.url);
    delete require.cache[require.resolve("./server.js")];
    const mod = require("./server.js");
    return { dir, mod };
}
const readBlob = (dir, name) => {
    try { return JSON.parse(readFileSync(join(dir, "users", `${name}.json`), "utf8")); } catch { return null; }
};

console.log("\n-- the orphan is folded in and then removed --");
let { dir, mod } = bed({ orphan: { friends: { [P1]: { friends: [F1], guilds: [], at: 10 } }, watching: [], notes: {} } });
await mod.adoptOrphanedBlobs();
let blob = readBlob(dir, BLOB);
ok("the blob now holds what the orphan had", !!blob && Object.keys(blob.friends).join(",") === P1,
    JSON.stringify(blob && blob.friends));
ok("and the orphan file is gone", !existsSync(join(dir, "users", `${ACC}.json`)));
rmSync(dir, { recursive: true, force: true });

console.log("\n-- an existing blob is merged with, never replaced --");
({ dir, mod } = bed({
    orphan: { friends: { [P1]: { friends: [F1], guilds: [], at: 10 } }, watching: [], notes: {} },
    existing: { friends: { [P2]: { friends: [F2], guilds: [], at: 20 } }, watching: [], notes: {} },
}));
await mod.adoptOrphanedBlobs();
blob = readBlob(dir, BLOB);
ok("both sets of findings survive", Object.keys(blob.friends).sort().join(",") === [P1, P2].sort().join(","),
    Object.keys(blob.friends).join(","));
rmSync(dir, { recursive: true, force: true });

console.log("\n-- running it twice changes nothing --");
({ dir, mod } = bed({ orphan: { friends: { [P1]: { friends: [F1], guilds: [], at: 10 } }, watching: [], notes: {} } }));
await mod.adoptOrphanedBlobs();
const after1 = JSON.stringify(readBlob(dir, BLOB));
await mod.adoptOrphanedBlobs();
ok("the second run is a no-op", JSON.stringify(readBlob(dir, BLOB)) === after1);
ok("and does not resurrect the orphan", !existsSync(join(dir, "users", `${ACC}.json`)));
rmSync(dir, { recursive: true, force: true });

console.log("\n-- nothing to adopt is not an error --");
({ dir, mod } = bed({}));
let threw = false;
try { await mod.adoptOrphanedBlobs(); } catch { threw = true; }
ok("no orphan, no throw", !threw);
ok("and no blob is conjured out of nothing", !existsSync(join(dir, "users", `${BLOB}.json`)));
rmSync(dir, { recursive: true, force: true });

console.log("\n-- an account that is not aliased is left completely alone --");
({ dir, mod } = bed({ aliases: "", orphan: { friends: { [P1]: { friends: [F1], guilds: [], at: 1 } }, watching: [], notes: {} } }));
await mod.adoptOrphanedBlobs();
ok("its blob is untouched", existsSync(join(dir, "users", `${ACC}.json`)));
rmSync(dir, { recursive: true, force: true });

console.log("\n-- an alias pointing at itself is not a migration --");
({ dir, mod } = bed({ aliases: `${ACC}=${ACC}`, orphan: { friends: { [P1]: { friends: [F1], guilds: [], at: 1 } }, watching: [], notes: {} } }));
await mod.adoptOrphanedBlobs();
ok("the file is not deleted by folding it into itself", existsSync(join(dir, "users", `${ACC}.json`)),
    "self-adoption would delete the source after merging it with itself");
rmSync(dir, { recursive: true, force: true });

console.log("\n-- an unreadable orphan is kept, not silently dropped --");
({ dir, mod } = bed({}));
writeFileSync(join(dir, "users", `${ACC}.json`), "{ this is not json");
await mod.adoptOrphanedBlobs();
ok("corrupt input is left on disk for a human to look at", existsSync(join(dir, "users", `${ACC}.json`)));
rmSync(dir, { recursive: true, force: true });

console.log("\n-- if the write cannot land, the original stays --");
// The whole ordering exists for this case. Make the destination undeletable/unwritable by
// putting a DIRECTORY where the blob file belongs: the write fails, so the source must
// survive for the next attempt.
({ dir, mod } = bed({ orphan: { friends: { [P1]: { friends: [F1], guilds: [], at: 10 } }, watching: [], notes: {} } }));
mkdirSync(join(dir, "users", `${BLOB}.json`), { recursive: true });
let blew = false;
try { await mod.adoptOrphanedBlobs(); } catch { blew = true; }
ok("a failed write does not take the process down", !blew);
ok("and the orphan is still there to retry from", existsSync(join(dir, "users", `${ACC}.json`)),
    "the source was deleted despite the destination write failing");
rmSync(dir, { recursive: true, force: true });

console.log("\n-- pool slices are adopted the same way --");
({ dir, mod } = bed({}));
writeFileSync(join(dir, "pool", `${ACC}.json`),
    JSON.stringify({ people: { [P1]: { guilds: [], first: 1, last: 2 } }, calls: {}, users: {} }));
await mod.adoptOrphanedBlobs();
ok("the call slice moves to the blob", existsSync(join(dir, "pool", `${BLOB}.json`)));
ok("and the orphaned slice is removed", !existsSync(join(dir, "pool", `${ACC}.json`)));
rmSync(dir, { recursive: true, force: true });


console.log("\n-- renaming a blob: the old name is folded into the new one --");
// A rename cannot be done by editing the account entries alone: that leaves users/lab-a
// under a name nothing resolves to. `lab-a=4has` on the left is what makes it migratable.
{
    const dir2 = mkdtempSync(join(tmpdir(), "xicord-rename-"));
    for (const d of ["users", "pool", "auth", "devices"]) mkdirSync(join(dir2, d), { recursive: true });
    writeFileSync(join(dir2, "users", "lab-a.json"),
        JSON.stringify({ friends: { [P1]: { friends: [F1], guilds: [], at: 10 } }, watching: ["700000000000000001"], notes: {} }));
    writeFileSync(join(dir2, "pool", "lab-a.json"),
        JSON.stringify({ people: { [P1]: { guilds: [], first: 1, last: 2 } }, calls: {}, users: {} }));
    process.env.DATA_DIR = dir2;
    process.env.XICORD_ALIASES = `${ACC}=4has,lab-a=4has`;
    const require2 = createRequire(import.meta.url);
    delete require2.cache[require2.resolve("./server.js")];
    const mod2 = require2("./server.js");
    await mod2.adoptOrphanedBlobs();

    const moved = (() => { try { return JSON.parse(readFileSync(join(dir2, "users", "4has.json"), "utf8")); } catch { return null; } })();
    ok("the new blob exists", !!moved);
    ok("with the old blob's findings", moved && Object.keys(moved.friends).join(",") === P1,
        JSON.stringify(moved && moved.friends));
    ok("and everything else it held", moved && (moved.watching || []).length === 1, JSON.stringify(moved && moved.watching));
    ok("the old private blob is gone", !existsSync(join(dir2, "users", "lab-a.json")));
    ok("the old pool slice moved too", existsSync(join(dir2, "pool", "4has.json")));
    ok("and its old file is gone", !existsSync(join(dir2, "pool", "lab-a.json")));
    rmSync(dir2, { recursive: true, force: true });
}

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
