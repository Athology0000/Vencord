// "First in / last out" — the room census, run against the REAL functions in xicordHistory.tsx.
//   node src/userplugins/_roomRole.test.mjs
//
// A session is marked `firstIn` when its owner walked into an empty channel and `lastOut`
// when they left it empty. That is a claim about everyone ELSE in the room, which the
// existing `open` map cannot answer — it is keyed by user, so it knows where somebody is
// and not who is with them. Hence a separate census, and hence this suite.
//
// The cases that actually bite: a bot idling in a channel (it must not take "first in"
// from the person who started the call, nor keep the room occupied so that nobody is ever
// last out), a repeated voice-state update, and a restart part-way through a call.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordHistory.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

/** Comment- and string-aware brace matcher, as the sibling suites use. */
function extract(name) {
    const needle = `function ${name}(`;
    let start = SRC.indexOf(needle);
    if (start < 0) throw new Error(`${name} not found`);
    if (SRC.slice(start - 7, start) === "export ") start -= 7;
    // Walk the parameter list to its closing paren FIRST. `roomRole(s: { firstIn?... })`
    // has braces in its type, and searching for the body's `{` naively lands inside them.
    let p = SRC.indexOf("(", start), pd = 0;
    for (; p < SRC.length; p++) {
        if (SRC[p] === "(") pd++;
        else if (SRC[p] === ")") { pd--; if (!pd) break; }
    }
    let i = SRC.indexOf("{", p), depth = 0, mode = "code", prev = "";
    for (; i < SRC.length; i++) {
        const ch = SRC[i], next = SRC[i + 1];
        if (mode === "line") { if (ch === "\n") mode = "code"; }
        else if (mode === "block") { if (ch === "*" && next === "/") { mode = "code"; i++; } }
        else if (mode !== "code") { if (ch === mode && prev !== "\\") mode = "code"; }
        else if (ch === "/" && next === "/") { mode = "line"; i++; }
        else if (ch === "/" && next === "*") { mode = "block"; i++; }
        else if (ch === '"' || ch === "'" || ch === "`") mode = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (!depth) return SRC.slice(start, i + 1); }
        prev = ch;
    }
    throw new Error(`unbalanced ${name}`);
}

const ts = [extract("enterRoom"), extract("leaveRoom"), extract("roomRole")]
    .join("\n").replace(/^export /gm, "");
const js = esbuild.transformSync(ts, { loader: "ts" }).code;
const { enterRoom, leaveRoom, roomRole } =
    new Function(`${js}; return { enterRoom, leaveRoom, roomRole };`)();

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => {
    if (c) { pass++; console.log(`  PASS  ${n}`); }
    else { fail++; console.log(`  FAIL  ${n}${extra ? ` — ${extra}` : ""}`); }
};

console.log("-- opening and closing a room --");
let rooms = new Map();
ok("the first arrival opens the room", enterRoom(rooms, "c1", "a") === true);
ok("the second does not", enterRoom(rooms, "c1", "b") === false);
ok("the third does not either", enterRoom(rooms, "c1", "c") === false);
ok("someone leaving a room with others in it has not closed it", leaveRoom(rooms, "c1", "b") === false);
ok("nor the next", leaveRoom(rooms, "c1", "c") === false);
ok("the last one out closes it", leaveRoom(rooms, "c1", "a") === true);
ok("and the empty room is not kept around", rooms.has("c1") === false, [...rooms.keys()].join(","));
ok("so the next arrival opens it again", enterRoom(rooms, "c1", "d") === true);

console.log("\n-- rooms are independent --");
rooms = new Map();
enterRoom(rooms, "c1", "a");
ok("a different channel opens on its own", enterRoom(rooms, "c2", "b") === true);
ok("leaving one does not close the other", leaveRoom(rooms, "c2", "b") === true && rooms.has("c1"));

console.log("\n-- a repeated event is not a second arrival --");
// Voice-state updates can repeat, and counting a repeat as an arrival would report the
// same room opening twice — and, worse, leave a phantom occupant behind on the way out.
rooms = new Map();
ok("the first says it opened the room", enterRoom(rooms, "c1", "a") === true);
ok("saying it again does not", enterRoom(rooms, "c1", "a") === false);
ok("and one leave still empties it", leaveRoom(rooms, "c1", "a") === true);

console.log("\n-- leaving somewhere you were never counted --");
rooms = new Map();
ok("an unknown room is not a closure", leaveRoom(rooms, "nope", "a") === false);
enterRoom(rooms, "c1", "a");
ok("an unknown person is not a closure", leaveRoom(rooms, "c1", "ghost") === false);
ok("and the real occupant is still there", leaveRoom(rooms, "c1", "a") === true);

console.log("\n-- a bot must not take the credit, or hold the room forever --");
// The plugin filters bots before calling these, so the census simply never sees them.
// This pins the CONSEQUENCE of that: a human arriving after a bot still opened the room,
// and leaving before the bot still closed it.
rooms = new Map();
// (a music bot joins — not counted)
ok("the human who arrives after a bot still opened the room", enterRoom(rooms, "c1", "human") === true);
ok("and leaving before the bot still closes it", leaveRoom(rooms, "c1", "human") === true);
ok("the source really does filter bots out",
    /const human = !isBot\(userId\)/.test(SRC) && /human && enterRoom\(/.test(SRC) && /human && leaveRoom\(/.test(SRC));

console.log("\n-- a restart mid-call must not fake a closure --");
// Seeding the census from the voice states already on screen is what stops the first
// person to leave after a restart looking like they emptied a full channel.
rooms = new Map();
["a", "b", "c"].forEach(u => enterRoom(rooms, "c1", u));   // stands in for the seed walk
ok("the first to leave after a restart has not closed the room", leaveRoom(rooms, "c1", "a") === false);
ok("only the genuine last one has", leaveRoom(rooms, "c1", "b") === false && leaveRoom(rooms, "c1", "c") === true);
ok("the plugin seeds the census on start", /if \(!isBot\(userId\)\) enterRoom\(occupants, channelId, userId\)/.test(SRC));

console.log("\n-- how a session describes itself --");
ok("neither is nothing", roomRole({}) === "", roomRole({}));
ok("first in", roomRole({ firstIn: true }) === "first in", roomRole({ firstIn: true }));
ok("last out", roomRole({ lastOut: true }) === "last out", roomRole({ lastOut: true }));
ok("both is its own claim, not the two glued together",
    roomRole({ firstIn: true, lastOut: true }) === "held the room",
    roomRole({ firstIn: true, lastOut: true }));

console.log("\n-- it is recorded, and it is shown --");
ok("the session carries the flags", /firstIn\?: boolean;/.test(SRC) && /lastOut\?: boolean;/.test(SRC));
ok("they are stored, not just computed",
    /firstIn: o\.firstIn \|\| undefined/.test(SRC) && /lastOut: lastOut \|\| undefined/.test(SRC));
// `false` on every one of tens of thousands of stored sessions is dead weight in a file
// read back on every start, so absent means "no".
ok("and absent rather than false when they do not apply",
    /\|\| undefined/.test(SRC) && !/firstIn: false/.test(SRC));
ok("the history rows show it", /roomRole\(s\)/.test(SRC));
ok("the alert is off for strangers by default",
    /roomAlertsWatchedOnly[\s\S]{0,220}default: true/.test(SRC));
ok("and it can be turned off entirely", /roomAlerts:[\s\S]{0,200}OptionType\.BOOLEAN/.test(SRC));
ok("it goes to the shared watch log, not only a toast",
    /WatchAPI\.log\(\{ userId, text, channelId/.test(SRC) && /Toasts\.show/.test(SRC));

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
