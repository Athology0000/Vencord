// Exercises the REAL scope gate that decides what leaves this machine.
//   node src/userplugins/_syncScope.test.mjs
//
// The sync used to send the watchlist unconditionally, bundled in with the friend graph.
// Calls and friendships are records of what HAPPENED — true whoever observed them, and
// the reason to sync at all. A watchlist is a record of what YOU are doing, and it is the
// one field that tells another machine's owner something about the operator rather than
// about the people being recorded. So it is now gated, and the gate has to fail closed:
// every way of being unsure must resolve to "keep it here".
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
// Normalised: an editor converted the sources to CRLF, and every multi-line marker below
// silently stopped matching. Line endings are not something a test should be sensitive to.
const DOSSIER = readFileSync(new URL("./xicordDossier.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const SYNC = readFileSync(new URL("./_sync.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
// Strip the types off the WHOLE file first, then brace-match. Matching against the .tsx
// meant guessing where a return-type annotation ended, and `: PrivatePayload` — a type
// with no braces of its own — sent the matcher straight through the body and into the
// next function.
const jsOf = src => esbuild.transformSync(src, { loader: "tsx" }).code;
const DOSSIER_JS = jsOf(DOSSIER), SYNC_JS = jsOf(SYNC);

function fn(src, name) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    let j = src.indexOf("{", src.indexOf(")", start)), depth = 0;
    for (; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
    }
    throw new Error(`unbalanced ${name}`);
}
// The factory takes the `Settings` the extracted function closes over, so each test can
// hand it a different fake settings object.
const build = (src, name, extra = "") => new Function("Settings", `${extra}${fn(src, name)}; return ${name};`);

const gateWith = settings => build(DOSSIER_JS, "syncShareWatchlist")(settings);
// toPrivate leans on a module-level id validator; carry it across with the function.
const isIdSrc = /const isId = [^;]+;/.exec(SYNC_JS)[0];
const toPrivate = build(SYNC_JS, "toPrivate", isIdSrc + ";\n")(null);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};
const withPlugins = plugins => gateWith({ plugins })();

console.log("\n-- the watchlist only leaves on an explicit, deliberate yes --");
ok("both enabled and opted in -> sent",
    withPlugins({ "Xicord Sync": { enabled: true, shareWatchlist: true } }) === true);
ok("plugin on but not opted in -> kept",
    withPlugins({ "Xicord Sync": { enabled: true, shareWatchlist: false } }) === false);
ok("opted in but the plugin is disabled -> kept",
    withPlugins({ "Xicord Sync": { enabled: false, shareWatchlist: true } }) === false);
ok("plugin not installed at all -> kept",
    withPlugins({}) === false);

console.log("\n-- every way of being unsure fails closed --");
ok("no settings object at all", gateWith(undefined)() === false);
ok("no plugins map", gateWith({})() === false);
ok("a truthy-but-not-true enabled is not consent",
    withPlugins({ "Xicord Sync": { enabled: 1, shareWatchlist: true } }) === false);
ok("a truthy-but-not-true opt-in is not consent",
    withPlugins({ "Xicord Sync": { enabled: true, shareWatchlist: "yes" } }) === false);
ok("a settings object that throws on access", (() => {
    const hostile = { get plugins() { throw new Error("boom"); } };
    try { return gateWith(hostile)() === false; } catch { return false; }
})());

console.log("\n-- and the payload honours it --");
const friendMap = { "111111111111111111": { friends: ["222222222222222222"], guilds: ["333333333333333333"], at: 5 } };
const watching = ["444444444444444444"];
let out = toPrivate(friendMap, []);
ok("with the gate shut, no watchlist is in the payload", out.watching.length === 0, JSON.stringify(out.watching));
ok("but the friendships still are", Object.keys(out.friends).join(",") === "111111111111111111");
ok("and the friend graph is intact", out.friends["111111111111111111"].friends.join(",") === "222222222222222222");
out = toPrivate(friendMap, watching);
ok("with the gate open, the watchlist is included", out.watching.join(",") === "444444444444444444");

console.log("\n-- notes never go, gate or no gate --");

console.log("\n-- the push site is actually wired to the gate --");
// A gate nothing calls is decoration, and the payload tests above would still pass.
// `/v1/me` is called TWICE — once to pull (no body) and once to push. Anchoring on the
// path alone found the pull and reported the gate missing from a line that never had it.
// The trailing comma is what distinguishes the PUSH from the pull, which calls the same
// path with no body. The call has since wrapped onto two lines, so match only the head.
const PUSH = 'syncCall(url, token, "/v1/me",';
const pushAt = DOSSIER.indexOf(PUSH);
if (pushAt < 0) throw new Error("the /v1/me push site moved — this suite is asserting nothing");
const pushSite = DOSSIER.slice(pushAt, pushAt + 220);
ok("notes are empty when none are passed", Object.keys(toPrivate(friendMap, []).notes).length === 0);
ok("the push site passes no notes at all", !/toPrivate\([^)]*notes/i.test(pushSite),
    "the /v1/me push has started sending notes");
ok("the /v1/me push consults syncShareWatchlist", /syncShareWatchlist\(\)/.test(pushSite), pushSite.trim());
ok("and passes an empty list when it says no", /\?\s*WatchAPI\.list\(\)\s*:\s*\[\]/.test(pushSite), pushSite.trim());

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
