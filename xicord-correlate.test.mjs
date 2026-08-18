// Extracts the REAL multi-account correlation functions from xicord-dashboard.html
// (brace-matched, so they can't drift from shipped code) and tests them.
//   node xicord-correlate.test.mjs
import { readFileSync } from "fs";

const HTML = readFileSync(new URL("./xicord-dashboard.html", import.meta.url), "utf8");

function extract(name) {
    const start = HTML.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    let i = HTML.indexOf("(", start), pd = 0;
    for (; i < HTML.length; i++) { if (HTML[i] === "(") pd++; else if (HTML[i] === ")") { pd--; if (!pd) { i++; break; } } }
    i = HTML.indexOf("{", i);
    let depth = 0, mode = "code", prev = "";
    for (; i < HTML.length; i++) {
        const ch = HTML[i], next = HTML[i + 1];
        if (mode === "line") { if (ch === "\n") mode = "code"; }
        else if (mode === "block") { if (ch === "*" && next === "/") { mode = "code"; i++; } }
        else if (mode !== "code") { if (ch === mode && prev !== "\\") mode = "code"; }
        else if (ch === "/" && next === "/") { mode = "line"; i++; }
        else if (ch === "/" && next === "*") { mode = "block"; i++; }
        else if (ch === '"' || ch === "'" || ch === "`") mode = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (!depth) return HTML.slice(start, i + 1); }
        prev = ch;
    }
    throw new Error(`unbalanced ${name}`);
}

const src = ["footprint", "hasData", "crossAccountLinks", "lookupAcross"].map(extract).join("\n");
const api = new Function(`${src}; return { footprint, hasData, crossAccountLinks, lookupAcross };`)();
const { crossAccountLinks, lookupAcross, footprint } = api;

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? "\n          " + extra : ""}`); }
};

// Two of YOUR OWN accounts. alt1 (id A1) and alt2 (id A2).
// - both saw stranger S in voice          -> a person-link between the accounts
// - both are in guild G1                    -> a shared-server link
// - alt2's data actually recorded alt1      -> a DIRECT link
const alt1 = {
    self: { id: "A1", username: "alt-one" },
    users: { S: { username: "stranger" }, X: { username: "solo-x" } },
    guilds: { G1: { name: "Shared Guild" }, G9: { name: "Only A1 Guild" } },
    channels: { c1: { guildId: "G1" }, c9: { guildId: "G9" } },
    history: [
        { userId: "S", channelId: "c1", join: 1000, leave: 4000 },
        { userId: "X", channelId: "c9", join: 1000, leave: 2000 }
    ],
    messages: { byUser: { S: 12 } },
    presence: [{ userId: "S", start: 0, end: 60000 }],
    dossiers: {}
};
const alt2 = {
    self: { id: "A2", username: "alt-two" },
    users: { S: { username: "stranger" }, A1: { username: "alt-one" } },
    guilds: { G1: { name: "Shared Guild" } },
    channels: { c1: { guildId: "G1" } },
    history: [
        { userId: "S", channelId: "c1", join: 5000, leave: 9000 },
        { userId: "A1", channelId: "c1", join: 5000, leave: 8000 }   // alt2 saw alt1 in voice
    ],
    messages: { byUser: { A1: 3 } },
    presence: [],
    dossiers: { A2: { companions: { S: { count: 2, ms: 4000, last: 1 } } } }
};

console.log("\n-- cross-account links --");
const L = crossAccountLinks([alt1, alt2]);
ok("stranger S is flagged as seen by both accounts",
    L.people.some(p => p.id === "S" && p.accts.length === 2), JSON.stringify(L.people));
ok("solo-x (only in alt1) is NOT a cross link",
    !L.people.some(p => p.id === "X"));
ok("shared guild G1 is a cross link",
    L.guilds.some(g => g.id === "G1" && g.accts.length === 2));
ok("A1-only guild G9 is not shared",
    !L.guilds.some(g => g.id === "G9"));

console.log("\n-- direct account-to-account link --");
ok("alt2 is detected as having recorded alt1",
    L.direct.some(d => d.id === "A1" && d.seenIn === 1 && d.selfAcct === 0), JSON.stringify(L.direct));
ok("the direct link carries what was seen (voice sessions)",
    L.direct.find(d => d.id === "A1")?.fp.sessions === 1);
ok("no phantom direct link for A2 (nobody recorded it in voice/msgs)",
    !L.direct.some(d => d.id === "A2"));

console.log("\n-- self-account is never its own cross-link noise --");
// A single account must produce no cross links at all
const solo = crossAccountLinks([alt1]);
ok("one account alone yields no people links", solo.people.length === 0);
ok("one account alone yields no direct links", solo.direct.length === 0);

console.log("\n-- lookup by username, across accounts --");
const byName = lookupAcross([alt1, alt2], "stranger");
ok("username query resolves to S", byName.length === 1 && byName[0].id === "S", JSON.stringify(byName.map(r => r.id)));
ok("S is reported as present in both accounts", byName[0].per.length === 2);
const a1fp = byName[0].per.find(x => x.acct === 0).fp;
ok("alt1's footprint for S has the voice session", a1fp.sessions === 1 && a1fp.voiceMs === 3000, JSON.stringify(a1fp));
ok("alt1's footprint for S has the messages", a1fp.messages === 12);
ok("alt1's footprint for S counts online time", a1fp.online === 60000);
const a2fp = byName[0].per.find(x => x.acct === 1).fp;
ok("alt2 saw S as a dossier companion", a2fp.seenAsCompanion === true, JSON.stringify(a2fp));

console.log("\n-- lookup by id --");
const byId = lookupAcross([alt1, alt2], "A1");
ok("id query finds alt-one", byId.length === 1 && byId[0].id === "A1");
ok("alt-one is flagged as being one of your own accounts",
    byId[0].per.some(x => x.fp.isSelf), JSON.stringify(byId[0].per.map(x => x.fp.isSelf)));
ok("alt-one was also recorded by alt2", byId[0].per.some(x => x.acct === 1 && x.fp.sessions === 1));

console.log("\n-- lookup misses and edge cases --");
ok("empty query returns null", lookupAcross([alt1, alt2], "") === null);
ok("unknown name returns nothing", lookupAcross([alt1, alt2], "nobody-here").length === 0);
ok("partial/case-insensitive username matches", lookupAcross([alt1, alt2], "STRANGE").length === 1);
// a totally empty account must not throw
ok("degenerate empty account is handled",
    Array.isArray(crossAccountLinks([{}, alt1]).people));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
