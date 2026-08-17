// The avatar-hash round trip, both ends of it.
//   node xicord-avatar.test.mjs
//
// The snapshot stores a bare avatar HASH instead of the full CDN URL. Two functions have
// to agree for that to be lossless: avatarHash() in xicordDossier.tsx reduces a stored URL
// to its hash on the way OUT, and uavatar() in xicord-dashboard.html rebuilds the URL on
// the way IN. This drives the REAL bodies of both, so a change to either that breaks the
// contract — or the old-cache passthrough that keeps a pre-change file rendering — fails here.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require("./node_modules/esbuild");

let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}${extra ? "\n          " + extra : ""}`)); };

/** Brace-match a named function out of a source, skipping strings and comments. */
function extract(name, src) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    let i = src.indexOf("{", src.indexOf(")", start)), depth = 0, mode = "code", prev = "";
    for (; i < src.length; i++) {
        const ch = src[i], next = src[i + 1];
        if (mode === "line") { if (ch === "\n") mode = "code"; }
        else if (mode === "block") { if (ch === "*" && next === "/") { mode = "code"; i++; } }
        else if (mode !== "code") { if (ch === mode && prev !== "\\") mode = "code"; }
        else if (ch === "/" && next === "/") { mode = "line"; i++; }
        else if (ch === "/" && next === "*") { mode = "block"; i++; }
        else if (ch === '"' || ch === "'" || ch === "`") mode = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (!depth) return src.slice(start, i + 1); }
        prev = ch;
    }
    throw new Error(`unbalanced ${name}`);
}

const ID = "1399298764195500103";
const HASH = "dd7ee4af92963400e098b77023c7543a";
const ANIM = "a_1b2c3d4e5f6071829304a5b6c7d8e9f";

// ---- READ side: uavatar() from the dashboard html ----
console.log("\n-- uavatar() rebuilds the URL from id + hash --");
const html = readFileSync(join(HERE, "xicord-dashboard.html"), "utf8");
const uavatar = new Function("cache", `${extract("uavatar", html)}; return uavatar;`)({
    users: {
        [ID]: { username: "x", avatar: HASH },
        anim: { username: "a", avatar: ANIM },
        legacy: { username: "l", avatar: "https://cdn.discordapp.com/avatars/" + ID + "/oldhash.webp?size=160" },
        blank: { username: "b", avatar: "" },
    }
});
ok("a bare hash becomes a full webp CDN URL",
    uavatar(ID) === `https://cdn.discordapp.com/avatars/${ID}/${HASH}.webp?size=128`, uavatar(ID));
ok("an animated (a_) hash becomes a gif", uavatar("anim").endsWith(`/${ANIM}.gif?size=128`), uavatar("anim"));
ok("a full URL from an OLD cache passes straight through", uavatar("legacy").startsWith("https://") && uavatar("legacy").includes("oldhash"), uavatar("legacy"));
ok("an empty avatar yields empty", uavatar("blank") === "");
ok("an unknown id yields empty, never a broken URL", uavatar("nope") === "");

// ---- WRITE side: avatarHash() from the Dossier tsx ----
console.log("\n-- avatarHash() reduces whatever we hold to a bare hash --");
const tsx = readFileSync(join(HERE, "src/userplugins/xicordDossier.tsx"), "utf8");
const js = esbuild.transformSync(extract("avatarHash", tsx).replace(/^export /, ""), { loader: "tsx" }).code;
const avatarHash = new Function(`${js}; return avatarHash;`)();

ok("a real avatar URL reduces to its hash",
    avatarHash(`https://cdn.discordapp.com/avatars/${ID}/${HASH}.webp?size=160`) === HASH);
ok("an animated URL keeps its a_ prefix",
    avatarHash(`https://cdn.discordapp.com/avatars/${ID}/${ANIM}.gif`) === ANIM);
ok("a default-avatar embed URL has no per-user hash -> empty",
    avatarHash("https://cdn.discordapp.com/embed/avatars/3.png") === "");
ok("an already-bare hash passes through unchanged (idempotent)", avatarHash(HASH) === HASH);
ok("empty / missing stays empty", avatarHash("") === "" && avatarHash(undefined) === "");

// ---- the contract: OUT then IN is a faithful round trip ----
console.log("\n-- write-then-read is lossless for a real avatar --");
const rebuilt = new Function("cache", `${extract("uavatar", html)}; return uavatar;`)({
    users: { [ID]: { username: "x", avatar: avatarHash(`https://cdn.discordapp.com/avatars/${ID}/${HASH}.webp?size=160`) } }
})(ID);
ok("hash out, URL back in, same avatar", rebuilt === `https://cdn.discordapp.com/avatars/${ID}/${HASH}.webp?size=128`, rebuilt);

console.log(`\n${fail ? "FAILED" : "OK"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
