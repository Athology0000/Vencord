/*
 * Discord OAuth2 sign-in, and the device tokens it issues.
 *
 * Identity comes from Discord rather than from the client: the plugin never states who
 * it is, it presents a token, and the server looks up which Discord id that token was
 * issued to. That is what makes it impossible to write into someone else's blob.
 *
 * Env:
 *   DISCORD_CLIENT_ID      the application's client id
 *   DISCORD_CLIENT_SECRET  set this in Railway, never in the repo — it cannot be
 *                          recovered if it leaks, only rotated
 *   PUBLIC_URL             defaults to the Railway domain; must match the redirect URI
 *                          registered on the application
 */
const crypto = require("crypto");

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://xicord-sync-production.up.railway.app").replace(/\/$/, "");
const REDIRECT_URI = `${PUBLIC_URL}/auth/callback`;

// `identify` alone. The server wants a user id and nothing else, so anything wider only
// enlarges what a compromise hands over — email, linked accounts, or the ability to add
// people to servers are not things this needs to be able to do.
const SCOPE = "identify";

// Short-lived, single-use CSRF state. In memory on purpose: a restart invalidating a
// half-finished login is the correct outcome, and it never needs to outlive one.
const states = new Map();
const STATE_TTL = 10 * 60 * 1000;

function newState() {
    const s = crypto.randomBytes(24).toString("base64url");
    states.set(s, Date.now() + STATE_TTL);
    // opportunistic sweep, so a stream of abandoned logins cannot grow it forever
    for (const [k, exp] of states) if (exp < Date.now()) states.delete(k);
    return s;
}
function takeState(s) {
    if (!s || !states.has(s)) return false;
    const exp = states.get(s);
    states.delete(s);              // single use, even if expired
    return exp >= Date.now();
}

function configured() { return !!(CLIENT_ID && CLIENT_SECRET); }

function authorizeUrl() {
    const p = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state: newState()
    });
    return `https://discord.com/oauth2/authorize?${p}`;
}

/** Exchange the callback code for the signed-in user's id and name. */
async function exchange(code) {
    const body = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI
    });
    const tr = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
    });
    if (!tr.ok) throw new Error(`token exchange failed: ${tr.status} ${await tr.text()}`);
    const tok = await tr.json();

    const ur = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${tok.access_token}` }
    });
    if (!ur.ok) throw new Error(`identify failed: ${ur.status}`);
    const user = await ur.json();
    if (!user?.id) throw new Error("no user id in the identify response");
    return { id: user.id, username: user.username || user.global_name || "" };
}

/** A device token. Prefixed so it is recognisable in a log or a settings field. */
function mintToken() { return "xic-" + crypto.randomBytes(24).toString("base64url"); }

module.exports = { configured, authorizeUrl, takeState, exchange, mintToken, CLIENT_ID, REDIRECT_URI, PUBLIC_URL, SCOPE };
