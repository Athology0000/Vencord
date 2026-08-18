// The bug that crash-looped the live service, reproduced against a REAL server under a
// tight heap.
//   node xicord-sync/_streamlog.test.mjs
//
// The pool slice was a healthy ~50MB, but the append log had grown to ~274MB because the
// process kept getting OOM-killed BEFORE it could compact — and serving a request meant
// `readFile(wholeLog)` + `split("\n")`, two ~274MB copies at once, which is what blew past
// the 1GB container and killed it, so the log never shrank. A death spiral.
//
// sliceWithLog now STREAMS the log line by line, so peak memory is the merged slice plus
// one line, not the whole log. This proves it: a log far larger than a deliberately tiny
// server heap is served (and compacted away) without OOM, where reading it whole cannot.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, createWriteStream, statSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, spawnSync } from "child_process";

const CWD = "C:/Users/aeare/Desktop/Vencord/xicord-sync";
let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${extra ? "\n          " + extra : ""}`)); };

// ---- fixture: a small slice + a LARGE, mostly-redundant log ----
// Redundant on purpose: a client re-pushes overlapping records, so the MERGED result is
// small (a few hundred pairs) while the log text is huge — the real shape, and the case
// where streaming wins: the whole-file read holds all of it, the stream never does.
const OWNER = "1400000000000000123";
const dir = mkdtempSync(join(tmpdir(), "xicord-streamlog-"));
mkdirSync(join(dir, "auth"), { recursive: true });
mkdirSync(join(dir, "pool"), { recursive: true });
writeFileSync(join(dir, "auth", "tokens.json"), JSON.stringify({ tok: { user: OWNER, at: 1 } }));
const slice = join(dir, "pool", `${OWNER}.json`);
const logFile = join(dir, "pool", `${OWNER}.json.log`);
writeFileSync(slice, JSON.stringify({ people: {}, calls: {}, users: {}, voice: {} }));

const P = n => "9200000000000000" + String(n).padStart(3, "0");
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
function pushLine(seed) {
    const people = {}, calls = {};
    for (let i = 0; i < 300; i++) {
        const a = P(i), b = P(i + 1);
        people[a] = { guilds: [], first: 1, last: 5000 + seed };
        people[b] = { guilds: [], first: 1, last: 5000 + seed };
        calls[pairKey(a, b)] = { ms: 1000 + seed, count: 1 + (seed % 5), last: 5000 + seed, guilds: [] };
    }
    return JSON.stringify({ people, calls, users: {}, voice: {} });
}
const TARGET_MB = 140;
{
    const ws = createWriteStream(logFile);
    let bytes = 0, seed = 0;
    while (bytes < TARGET_MB * 1048576) { const l = "\n" + pushLine(seed++) + "\n"; ws.write(l); bytes += Buffer.byteLength(l); }
    ws.end(); await new Promise(r => ws.on("finish", r));
}
const logMB = statSync(logFile).size / 1048576;
console.log(`\n-- fixture: ${logMB.toFixed(0)}MB log over ~300 distinct pairs --`);
ok("the log is genuinely large", logMB > 100, `${logMB.toFixed(0)}MB`);

// ---- prove the fix is load-bearing: the OLD sliceWithLog body (read-whole + split +
// parse + merge) OOMs at the SAME 220MB heap the server below runs and survives on ----
console.log("\n-- the old read-whole path OOMs at 128MB where streaming survives --");
const oldBody = `
const fs=require("fs"); const { mergePoolInto }=require(${JSON.stringify(CWD + "/pool.js")});
const pool={people:{},calls:{},users:{},voice:{}};
const text=fs.readFileSync(${JSON.stringify(logFile)},"utf8");   // the whole 140MB at once
for(const line of text.split("\\n")){ if(!line) continue; try{ mergePoolInto(pool, JSON.parse(line)); }catch{} }
console.log("survived "+Object.keys(pool.calls).length);
`;
const whole = spawnSync(process.execPath, ["--max-old-space-size=128", "-e", oldBody], { encoding: "utf8", maxBuffer: 1 << 20 });
ok("the old read-whole path OOMs at 128MB (proves the fix carries the weight)",
    whole.status !== 0 || /heap out of memory/i.test(whole.stderr || ""),
    `status=${whole.status} out=${(whole.stdout || "").trim()} — if it 'survived', bump TARGET_MB`);

// ---- the real server, tiny heap, serves + compacts the huge log ----
console.log("\n-- the real server serves /v1/pool under a 128MB heap and compacts the log --");
const PORT = 8934;
const srv = spawn(process.execPath, ["server.js"], {
    cwd: CWD,
    env: {
        ...process.env, DATA_DIR: dir, PORT: String(PORT), XICORD_TOKENS: "", XICORD_ALIASES: "",
        NODE_OPTIONS: "--max-old-space-size=128",   // far under the 140MB log read-whole
        XICORD_MAX_LOG_BYTES: String(1 * 1024 * 1024),   // force compaction on the cold read
    },
    stdio: ["ignore", "pipe", "pipe"],
});
let sawKilled = false, log = "";
srv.stdout.on("data", d => { log += d; }); srv.stderr.on("data", d => { log += d; if (/heap out of memory|Killed/i.test(String(d))) sawKilled = true; });

const base = `http://127.0.0.1:${PORT}`;
const call = async (p) => {
    const res = await fetch(base + p, { headers: { Authorization: "Bearer tok" } });
    return { status: res.status, body: await res.json().catch(() => null) };
};
const until = async fn => { for (let i = 0; i < 80; i++) { try { if (await fn()) return true; } catch { } await new Promise(r => setTimeout(r, 250)); } return false; };

try {
    const up = await until(async () => (await fetch(base + "/v1/health")).ok);
    ok("the server comes up", up, log.slice(-200));

    const pull = await call("/v1/pool");
    ok("GET /v1/pool RESPONDS 200 — no OOM building the view from the huge log",
        pull.status === 200, `status=${pull.status} killed=${sawKilled}`);
    ok("and returns the correctly merged ~300 pairs",
        pull.body && pull.body.calls && Object.keys(pull.body.calls).length >= 300 && Object.keys(pull.body.calls).length <= 301,
        pull.body && pull.body.calls ? String(Object.keys(pull.body.calls).length) : "no calls");
    ok("the process was never OOM-killed", !sawKilled);

    // compaction runs on the cold read (logBytes > MAX_LOG_BYTES); give it a beat to land
    await until(async () => !existsSync(logFile));
    ok("the oversized log is compacted away", !existsSync(logFile), "log still present");
    if (existsSync(slice)) {
        const sliceMB = statSync(slice).size / 1048576;
        ok("and the slice holds the merged result, not the log", sliceMB < 5, `${sliceMB.toFixed(2)}MB`);
    }
} finally {
    srv.kill();
    rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
