// The network graph's keyboard navigation, run against the REAL mapping in xicordDossier.tsx.
//   node src/userplugins/_dossierKeys.test.mjs
//
// The graph is an SVG laid out by a physics simulation: its nodes have no document order,
// and nothing about it can be exercised in a browser from here. So the decision — what a
// keypress MEANS — is a pure function, and this is what checks it.
//
// The thing being protected: before this, every interaction the graph offered (open
// someone's profile, centre the view on them) was pointer-only. The on-screen help
// advertised double-click and right-click and there was no keyboard path to either.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const ROOT = "C:/Users/aeare/Desktop/Vencord";
const require = createRequire(join(ROOT, "package.json"));
const esbuild = require("esbuild");
const SRC = readFileSync(new URL("./xicordDossier.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function span(from, to) {
    const a = SRC.indexOf(from);
    if (a < 0) throw new Error(`marker not found: ${from}`);
    const b = SRC.indexOf(to, a);
    if (b < 0) throw new Error(`end marker not found: ${to}`);
    return SRC.slice(a, b);
}

const ts = span("export type GraphKeyAction", "function ForceGraph(").replace(/^export /gm, "");
const js = esbuild.transformSync(ts, { loader: "ts" }).code;
const { graphKeyAction } = new Function(`${js}; return { graphKeyAction };`)();

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`); }
};
const j = v => JSON.stringify(v);

console.log("-- moving between people --");
ok("right steps forward", j(graphKeyAction("ArrowRight", 0, 5)) === j({ kind: "move", to: 1 }));
ok("down does the same, so either axis works",
    j(graphKeyAction("ArrowDown", 0, 5)) === j({ kind: "move", to: 1 }));
ok("left steps back", j(graphKeyAction("ArrowLeft", 3, 5)) === j({ kind: "move", to: 2 }));
ok("up does the same", j(graphKeyAction("ArrowUp", 3, 5)) === j({ kind: "move", to: 2 }));

console.log("\n-- the ends wrap, so neither is a dead end --");
ok("past the last is the first", j(graphKeyAction("ArrowRight", 4, 5)) === j({ kind: "move", to: 0 }),
    j(graphKeyAction("ArrowRight", 4, 5)));
ok("before the first is the last", j(graphKeyAction("ArrowLeft", 0, 5)) === j({ kind: "move", to: 4 }),
    j(graphKeyAction("ArrowLeft", 0, 5)));
ok("Home is the first", j(graphKeyAction("Home", 3, 5)) === j({ kind: "move", to: 0 }));
ok("End is the last", j(graphKeyAction("End", 0, 5)) === j({ kind: "move", to: 4 }));
ok("a single node stays put rather than dividing by zero",
    j(graphKeyAction("ArrowRight", 0, 1)) === j({ kind: "move", to: 0 }));

console.log("\n-- the two actions the pointer had --");
ok("Enter opens, as double-click does", j(graphKeyAction("Enter", 2, 5)) === j({ kind: "open" }));
ok("Space opens too", j(graphKeyAction(" ", 2, 5)) === j({ kind: "open" }));
ok("and the old Spacebar name is honoured", j(graphKeyAction("Spacebar", 2, 5)) === j({ kind: "open" }));
ok("C re-centres, as right-click does", j(graphKeyAction("c", 2, 5)) === j({ kind: "recentre" }));
ok("capital C too, so caps lock is not a trap", j(graphKeyAction("C", 2, 5)) === j({ kind: "recentre" }));

console.log("\n-- keys that are not ours are left alone --");
// Swallowing these inside a modal is how you break Escape, Tab and copy-paste.
ok("Ctrl+C stays a copy", graphKeyAction("c", 2, 5, { ctrl: true }) === null);
ok("Cmd+C stays a copy", graphKeyAction("c", 2, 5, { meta: true }) === null);
ok("Alt+C is not ours either", graphKeyAction("c", 2, 5, { alt: true }) === null);
ok("Tab is not intercepted, so focus can leave the graph", graphKeyAction("Tab", 2, 5) === null);
ok("Escape is not intercepted, so the modal still closes", graphKeyAction("Escape", 2, 5) === null);
ok("an ordinary letter does nothing", graphKeyAction("q", 2, 5) === null);

console.log("\n-- an empty graph has nothing to navigate --");
ok("no nodes, no action", graphKeyAction("ArrowRight", 0, 0) === null);
ok("not even Enter", graphKeyAction("Enter", 0, 0) === null);

console.log("\n-- the component actually wires it up --");
// The mapping being right is worthless if the graph never calls it, or if the nodes are
// not reachable in the first place.
ok("nodes are buttons", /<g key=\{n\.id\}[\s\S]{0,400}role="button"/.test(SRC));
ok("exactly one node is tabbable at a time (roving tabindex)",
    /tabIndex=\{i === cursor \? 0 : -1\}/.test(SRC));
ok("every node carries a name", /aria-label=\{`\$\{n\.label\}`/.test(SRC));
ok("the keypress handler is attached to the svg", /onKeyDown=\{onGraphKey\}/.test(SRC));
ok("the handler goes through the mapping tested above", /graphKeyAction\(e\.key/.test(SRC));
ok("focus moves the view, so it cannot land off-canvas", /centreOn\(i\)/.test(SRC));
// The focus marker must reuse the ring the SIMULATION already positions. Adding a circle
// of its own passed every existence check while sitting at the graph's origin, nowhere near
// the person — the sim writes cx/cy per shape and never transforms the node group, so an
// element React adds is simply never placed. Caught by looking at a screenshot, not by a test.
ok("focus restyles the positioned ring rather than adding an unplaced circle",
    /className="xd-ring"[\s\S]{0,400}i === focusIdx && ringVisible/.test(SRC)
    && !/className="xd-focus"/.test(SRC));
ok("and it is distinguishable from the meaning-carrying ring colours",
    /strokeDasharray=\{i === focusIdx && ringVisible \? "4 3" : undefined\}/.test(SRC));
// The cursor must track focus however it arrived, or clicking a node and then pressing an
// arrow does nothing — the ring is the only part that is keyboard-only.
ok("the cursor follows any focus, while only the ring is keyboard-only",
    /onFocus=\{[\s\S]{0,400}setFocusIdx\(i\);[\s\S]{0,300}setRingVisible\(keyboard\)/.test(SRC));
ok("the keyboard controls are stated on screen", /keyboard:<\/b> tab into the web/.test(SRC));
ok("the graph is no longer announced as one flat image",
    !/role="img"[\s\S]{0,200}Network/.test(SRC));

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
