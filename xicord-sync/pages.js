/*
 * The handful of pages this service serves to a browser.
 *
 * Mobile-first on purpose: the reason a hosted sync exists at all is to reach the data
 * from a phone, so that is the screen these are laid out for.
 */

const esc = t => String(t ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;padding:28px 20px 48px;font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;
  background:#0d0d0f;color:#e8e8ea;-webkit-text-size-adjust:100%}
.wrap{max-width:560px;margin:0 auto}
h1{font-size:26px;line-height:1.2;margin:0 0 6px}
h2{font-size:16px;margin:28px 0 8px;color:#c9c9ce}
p{margin:0 0 14px;color:#a8a8b0}
p.lead{color:#c9c9ce}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:22px}
.dot{width:11px;height:11px;border-radius:50%;background:#5865f2;flex:none}
.brand span{font-weight:650;letter-spacing:.2px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;
  padding:15px 18px;border-radius:11px;border:0;cursor:pointer;text-decoration:none;
  background:#5865f2;color:#fff;font:inherit;font-weight:600;font-size:17px}
.btn:active{background:#4752c4}
.btn.ghost{background:#1c1c21;color:#e8e8ea;border:1px solid #2c2c33;font-weight:500;margin-top:10px}
.card{background:#141418;border:1px solid #24242b;border-radius:12px;padding:16px;margin:16px 0}
pre{margin:0;padding:13px;background:#0a0a0c;border:1px solid #24242b;border-radius:9px;
  overflow-x:auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;user-select:all;color:#8be9a0}
code{background:#1c1c21;padding:2px 6px;border-radius:5px;font-size:14px}
.muted{color:#75757e;font-size:13.5px}
ol{padding-left:20px;color:#a8a8b0}li{margin-bottom:7px}
.warn{border-color:#4a3a12;background:#1c1707}
.warn p{color:#e8c97a}
.ok{color:#8be9a0;font-weight:600}
footer{margin-top:32px;color:#5a5a63;font-size:12.5px}
`;

function shell(title, body) {
    return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><style>${CSS}</style>
<div class="wrap"><div class="brand"><div class="dot"></div><span>Xicord Sync</span></div>
${body}
<footer>Your data stays in this instance. Nothing is sent anywhere else.</footer></div>`;
}

/** The landing page: what this is, and one button. */
function loginPage({ configured, devices, people }) {
    const stats = people
        ? `<p class="muted">Currently holding <b>${people.toLocaleString("en")}</b> people across
           <b>${devices}</b> contributing ${devices === 1 ? "device" : "devices"}.</p>`
        : "";
    const action = configured
        ? `<a class="btn" href="/auth/login">
             <svg width="21" height="21" viewBox="0 0 24 18" fill="currentColor" aria-hidden="true"><path d="M20.3 1.5A19.8 19.8 0 0 0 15.4.1l-.2.5c-1.6-.2-3.2-.2-4.7 0L10.2.1a19.7 19.7 0 0 0-4.9 1.4C2.2 6.1 1.4 10.6 1.8 15c1.9 1.4 3.7 2.2 5.5 2.8l1.2-2c-.7-.2-1.3-.5-1.9-.9l.5-.4c3.6 1.7 7.5 1.7 11 0l.5.4c-.6.4-1.2.7-1.9.9l1.2 2c1.8-.6 3.6-1.4 5.5-2.8.5-5.1-.8-9.6-3.1-13.5ZM8.5 12.3c-1.1 0-2-1-2-2.3s.9-2.3 2-2.3 2 1 2 2.3-.9 2.3-2 2.3Zm7 0c-1.1 0-2-1-2-2.3s.9-2.3 2-2.3 2 1 2 2.3-.9 2.3-2 2.3Z"/></svg>
             Sign in with Discord</a>
           <p class="muted" style="margin-top:12px">Only <code>identify</code> is requested — this reads your
           Discord user id and nothing else. No email, no servers, no linked accounts.</p>`
        : `<div class="card warn"><p><b>Not configured yet.</b> The service is missing its Discord
           credentials, so sign-in is unavailable.</p>
           <p class="muted">Set <code>DISCORD_CLIENT_ID</code> and <code>DISCORD_CLIENT_SECRET</code>
           on the service, then reload this page.</p></div>`;

    return shell("Sign in — Xicord Sync", `
<h1>Sign in to sync</h1>
<p class="lead">Connect a device so its records join your account and stay in step across every
machine you use.</p>
${action}
${stats}
<h2>How it works</h2>
<ol>
  <li>Sign in with Discord — that is what proves which account is yours.</li>
  <li>You get a token. Paste it into the plugin's <b>Sync token</b> setting.</li>
  <li>The plugin syncs from then on, and any other device you sign in joins the same account.</li>
</ol>
<p class="muted">Shared observations — who was in a call with whom, and where — pool across
everyone. Your friend graph, watchlist and notes stay private to you, because they only mean
anything measured from your own account.</p>`);
}

/** Shown once, straight after a successful sign-in. */
function tokenPage({ username, userId, token }) {
    return shell("Signed in — Xicord Sync", `
<h1>Signed in as ${esc(username || userId)}</h1>
<p class="lead">Here is this device's token. <b>It is shown once</b> — copy it now.</p>
<div class="card">
  <pre id="tok">${esc(token)}</pre>
  <button class="btn ghost" id="copy" type="button">Copy token</button>
</div>
<h2>Next</h2>
<ol>
  <li>Open the plugin's settings in Discord.</li>
  <li>Paste this into <b>Sync token</b>.</li>
  <li>Set the sync URL if it is not already filled in.</li>
</ol>
<p class="muted">Your Discord id is <code>${esc(userId)}</code>. Signing in again on another
device issues that device its own token, joined to this same account.</p>
<a class="btn ghost" href="/">Done</a>
<script>
document.getElementById("copy").addEventListener("click", async function () {
  var t = document.getElementById("tok").textContent, b = this;
  try { await navigator.clipboard.writeText(t); }
  catch (e) {
    // clipboard API needs a secure context and permission; selecting the text is a
    // reliable fallback and still leaves the user one tap from copying
    var r = document.createRange(); r.selectNode(document.getElementById("tok"));
    getSelection().removeAllRanges(); getSelection().addRange(r);
  }
  b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy token"; }, 1600);
});
</script>`);
}

function errorPage(title, detail) {
    return shell(title, `<h1>${esc(title)}</h1>
${detail ? `<p class="lead">${esc(detail)}</p>` : ""}
<a class="btn ghost" href="/">Back</a>`);
}

module.exports = { loginPage, tokenPage, errorPage, esc };
