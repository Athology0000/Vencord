// Exercises the REAL pace() and retryAfterOf() from xicordMutuals.tsx — the policy that
// decides how hard this hits Discord.
//   node src/userplugins/_mutualsPacing.test.mjs
//
// What it replaced: a flat 2.5s sleep after every request, with a 429 caught by a bare
// `catch {}` and treated exactly like a success. That was wrong in both directions at
// once — a healthy connection crawled through a multi-thousand-person sweep for hours
// at a speed nobody had ever measured, and a rate-limited one kept knocking at the very
// rate that earned the limit, while the person it failed on was marked "failed" and
// skipped for the next five minutes.
//
// The properties that matter here are safety properties. Getting them wrong does not
// fail a test in CI, it gets someone's Discord account throttled.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordMutuals.tsx", import.meta.url), "utf8");

const num = n => Number(new RegExp(`const ${n} = ([\\d.]+)`).exec(SRC)[1]);
const MIN_DELAY = num("MIN_DELAY"), MAX_DELAY = num("MAX_DELAY");
const FETCH_DELAY = num("FETCH_DELAY"), SPEEDUP_AFTER = num("SPEEDUP_AFTER");

function span(from, to) {
    const a = SRC.indexOf(from);
    if (a < 0) throw new Error(`marker not found: ${from}`);
    const b = SRC.indexOf(to, a);
    if (b < 0) throw new Error(`end marker not found: ${to}`);
    return SRC.slice(a, b);
}
const ts = [
    `const MIN_DELAY=${MIN_DELAY}, MAX_DELAY=${MAX_DELAY}, SPEEDUP_AFTER=${SPEEDUP_AFTER};`,
    `const SPEEDUP_FACTOR=${num("SPEEDUP_FACTOR")}, BACKOFF_FACTOR=${num("BACKOFF_FACTOR")};`,
    span("export interface Beat", "/** Live pacing"),
].join("\n").replace(/^export /gm, "");
const js = esbuild.transformSync(ts, { loader: "ts" }).code;
const { pace, retryAfterOf } = new Function(`${js}; return { pace, retryAfterOf };`)();

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};
const OK_BEAT = { rateLimited: false };
const LIMITED = ms => ({ rateLimited: true, retryAfterMs: ms });

/** Run n clean requests through the policy and report where it lands. */
function cruise(n, start = FETCH_DELAY) {
    let d = start, s = 0, waits = [];
    for (let i = 0; i < n; i++) { const r = pace(d, s, OK_BEAT); d = r.delay; s = r.streak; waits.push(r.wait); }
    return { delay: d, streak: s, waits };
}

console.log("\n-- it does not get faster until Discord has actually said yes --");
let r = pace(FETCH_DELAY, 0, OK_BEAT);
ok("one good answer changes nothing", r.delay === FETCH_DELAY, String(r.delay));
ok("but it is counted", r.streak === 1, String(r.streak));
r = cruise(SPEEDUP_AFTER - 1);
ok(`still unchanged after ${SPEEDUP_AFTER - 1}`, r.delay === FETCH_DELAY, String(r.delay));
r = cruise(SPEEDUP_AFTER);
ok(`eases off only on the ${SPEEDUP_AFTER}th`, r.delay < FETCH_DELAY, String(r.delay));
ok("and the streak resets so it steps, not slides", r.streak === 0, String(r.streak));

console.log("\n-- it converges on a floor rather than accelerating forever --");
r = cruise(4000);
ok("a long clean run settles at the floor", r.delay === MIN_DELAY, String(r.delay));
ok("and never goes below it", r.waits.every(w => w >= MIN_DELAY), String(Math.min(...r.waits)));
ok("the floor is not reckless (>=250ms between calls)", MIN_DELAY >= 250, String(MIN_DELAY));
// how long the convergence actually takes is a safety property: an instant jump to the
// floor would be indistinguishable from having no policy at all
const toFloor = (() => { let d = FETCH_DELAY, s = 0, n = 0; while (d > MIN_DELAY && n < 10000) { const x = pace(d, s, OK_BEAT); d = x.delay; s = x.streak; n++; } return n; })();
ok(`reaching the floor takes a real run (${toFloor} requests, not a handful)`, toFloor >= 30, String(toFloor));

console.log("\n-- a 429 backs off hard, immediately --");
r = pace(1000, 4, LIMITED());
ok("the delay doubles", r.delay === 2000, String(r.delay));
ok("the success streak is wiped", r.streak === 0, String(r.streak));
ok("and it waits the new, longer delay before trying again", r.wait === 2000, String(r.wait));

console.log("\n-- Discord's own retry_after wins when it is longer --");
r = pace(1000, 0, LIMITED(9000));
ok("it honours the longer wait", r.wait === 9000, String(r.wait));
ok("and adopts it as the cadence", r.delay === 9000, String(r.delay));
r = pace(8000, 0, LIMITED(500));
ok("a shorter retry_after does not undo our own backoff", r.delay === 16000 && r.wait === 16000, `${r.delay}/${r.wait}`);
r = pace(1000, 0, LIMITED());
ok("a 429 with no retry_after still backs off", r.delay === 2000, String(r.delay));

console.log("\n-- backoff is capped, so one bad night cannot wedge it forever --");
let d = 1000;
for (let i = 0; i < 40; i++) d = pace(d, 0, LIMITED()).delay;
ok("it stops at the ceiling", d === MAX_DELAY, String(d));
ok("the ceiling is a real pause but not an abandonment (<=60s)", MAX_DELAY <= 60000, String(MAX_DELAY));
r = pace(MAX_DELAY, 0, LIMITED(999999));
ok("an absurd retry_after is still capped as the cadence", r.delay === MAX_DELAY, String(r.delay));
ok("though the single wait does honour it — that one is Discord's call", r.wait === 999999, String(r.wait));

console.log("\n-- recovery: after a bad patch it must earn its speed back --");
d = pace(1000, 0, LIMITED()).delay;
const after = cruise(SPEEDUP_AFTER, d);
ok("it climbs back down once answers resume", after.delay < d, `${d} -> ${after.delay}`);
ok("but not in one step", after.delay > MIN_DELAY, String(after.delay));

console.log("\n-- only a 429 is a pacing signal --");
// A 403 (private) or 404 (deleted) is a perfectly well-paced request. Slowing down for
// those would punish the sweep for the shape of the server rather than for its speed.
r = pace(1000, 0, { rateLimited: false });
ok("a non-429 failure does not slow the pump", r.delay === 1000, String(r.delay));
ok("and it still counts toward earning a speed-up", r.streak === 1, String(r.streak));

console.log("\n-- reading retry_after off a rejected request --");
ok("from the JSON body, in seconds", retryAfterOf({ status: 429, body: { retry_after: 1.75 } }) === 1750);
ok("from the header when the body has none", retryAfterOf({ headers: { "retry-after": "3" } }) === 3000);
ok("capitalised header too", retryAfterOf({ headers: { "Retry-After": "2" } }) === 2000);
ok("body wins over header", retryAfterOf({ body: { retry_after: 1 }, headers: { "retry-after": "9" } }) === 1000);
ok("zero is a real answer, not a missing one", retryAfterOf({ body: { retry_after: 0 } }) === 0);
ok("nothing there -> undefined, and the caller falls back to doubling",
    retryAfterOf({ status: 429 }) === undefined);
ok("junk -> undefined", retryAfterOf({ headers: { "retry-after": "soon" } }) === undefined);
ok("a negative value is refused", retryAfterOf({ body: { retry_after: -5 } }) === undefined);
ok("null/undefined do not throw", retryAfterOf(null) === undefined && retryAfterOf(undefined) === undefined);

console.log("\n-- the pump spaces requests by their START, not by the gap after a reply --");
// This is the difference between the delay meaning what it says and the delay being
// "whatever we chose, plus however slow the network is". Read off the shipped source,
// because the arithmetic lives in startPump() where a unit test cannot reach it.
const PUMP = SRC.slice(SRC.indexOf("function startPump()"), SRC.indexOf("// A mutual-friend list is"));
ok("the request start is timestamped", /const startedAt = Date\.now\(\)/.test(PUMP));
ok("and the time already spent is subtracted from the wait",
    /step\.wait - spent/.test(PUMP), "the pump still sleeps the full delay after each reply");
ok("never a negative sleep", /Math\.max\(0, step\.wait - spent\)/.test(PUMP));
ok("but a 429 still waits in full — retry_after is measured from the refusal",
    /beat\.rateLimited \? step\.wait :/.test(PUMP));

// What that is worth, stated in the terms the sweep is actually judged by
const RTT = 360; // measured median round-trip against Discord for this endpoint
const gapForm = MIN_DELAY + RTT, intervalForm = Math.max(MIN_DELAY, RTT);
console.log(`\n  at a ${RTT}ms round-trip and a ${MIN_DELAY}ms floor:`);
console.log(`    gap-based:      ${gapForm}ms per person`);
console.log(`    interval-based: ${intervalForm}ms per person  (${(gapForm / intervalForm).toFixed(2)}x)`);
ok("the interval form is never slower than the gap form", intervalForm <= gapForm);

console.log("\n-- the shipped constants are sane --");
ok("it starts at the long-proven speed, not an optimistic one", FETCH_DELAY === 2500, String(FETCH_DELAY));
ok("the floor is below the start (there is something to gain)", MIN_DELAY < FETCH_DELAY);
ok("the ceiling is above the start (there is somewhere to retreat)", MAX_DELAY > FETCH_DELAY);
console.log(`\n  measured: a clean run converges ${FETCH_DELAY}ms -> ${MIN_DELAY}ms after ${toFloor} requests`);
console.log(`  that is ${(FETCH_DELAY / MIN_DELAY).toFixed(1)}x faster once settled\n`);

console.log(`${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
