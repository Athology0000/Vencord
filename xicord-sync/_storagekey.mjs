// Lifts the REAL storageKey() out of server.js so its validation can be tested without
// starting a server. Extracted rather than copied: a second copy of a security check is
// a second thing to forget to update.
import { readFileSync } from "fs";
const SRC = readFileSync(new URL("./server.js", import.meta.url), "utf8");
function fn(name) {
    const start = SRC.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found in server.js`);
    let j = SRC.indexOf("{", SRC.indexOf(")", start)), depth = 0;
    for (; j < SRC.length; j++) {
        if (SRC[j] === "{") depth++;
        else if (SRC[j] === "}") { depth--; if (!depth) return SRC.slice(start, j + 1); }
    }
    throw new Error(`unbalanced ${name}`);
}
const consts = /const BLOB_NAME = [^\n]+\nconst ACCOUNT_ID = [^\n]+/.exec(SRC);
if (!consts) throw new Error("BLOB_NAME/ACCOUNT_ID not found in server.js");
export const storageKeyProbe = new Function(`${consts[0]}\n${fn("storageKey")}; return storageKey;`)();
