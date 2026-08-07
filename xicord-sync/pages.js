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
<a class="btn ghost" href="/app">View my data</a>
<p class="muted" style="margin-top:18px">Shared observations — who was in a call with whom, and
where — pool across everyone. Your friend graph, watchlist and notes stay private to you, because
they only mean anything measured from your own account.</p>`);
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

/**
 * The data itself, on a phone.
 *
 * Reads /v1/pool with a token kept in localStorage — the local dashboard is bound to
 * 127.0.0.1 and cannot be reached from a phone at all, which is the whole reason this
 * page exists. Rendering happens client-side so the server stays a plain JSON store.
 */
function appPage() {
    return shell("Your data — Xicord Sync", `
<h1>Your data</h1>
<div id="gate">
  <p class="lead">Paste the token you were given after signing in.</p>
  <div class="card">
    <input id="tok" type="text" inputmode="text" autocomplete="off" autocapitalize="off"
      spellcheck="false" placeholder="xic-…"
      style="width:100%;padding:13px;border-radius:9px;border:1px solid #2c2c33;background:#0a0a0c;color:#e8e8ea;font:14px ui-monospace,monospace">
    <button class="btn" id="go" style="margin-top:10px">Load my data</button>
  </div>
  <a class="btn ghost" href="/">Need a token? Sign in</a>
</div>

<div id="app" hidden>
  <div class="card"><div id="stats"></div></div>
  <input id="q" type="search" placeholder="Search by name or id…" autocomplete="off"
    style="width:100%;padding:13px;border-radius:9px;border:1px solid #2c2c33;background:#141418;color:#e8e8ea;font:15px inherit">
  <div id="list"></div>
  <button class="btn ghost" id="out" style="margin-top:18px">Forget token</button>
</div>

<script>
var K="xicord-sync-token", pool=null;
var $=function(i){return document.getElementById(i)};
var esc2=function(t){return String(t).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]})};
function fmt(ms){var s=Math.round(ms/1000);if(s<60)return s+"s";var m=Math.round(s/60);
  if(m<60)return m+"m";var h=Math.floor(m/60);return h<48?(h+"h "+(m%60)+"m"):(Math.round(h/24)+"d")}
function ago(t){if(!t)return"—";var s=Math.floor((Date.now()-t)/1000);
  if(s<3600)return Math.floor(s/60)+"m ago";if(s<86400)return Math.floor(s/3600)+"h ago";return Math.floor(s/86400)+"d ago"}

async function load(tok){
  var r=await fetch("/v1/pool",{headers:{Authorization:"Bearer "+tok}});
  if(!r.ok) throw new Error(r.status===401?"That token was not accepted.":"Server said "+r.status);
  return r.json();
}
function render(){
  var people=pool.people||{}, calls=pool.calls||{}, users=pool.users||{};
  var nm=function(id){var u=users[id];return (u&&u.username)||id};
  // rank by total time in call, which is the most useful single ordering on a small screen
  var tot={};
  for(var k in calls){var p=k.split("|");var c=calls[k];
    tot[p[0]]=(tot[p[0]]||0)+(c.ms||0); tot[p[1]]=(tot[p[1]]||0)+(c.ms||0);}
  $("stats").innerHTML="<b>"+Object.keys(people).length.toLocaleString()+"</b> people · <b>"
    +Object.keys(calls).length.toLocaleString()+"</b> call pairs · <b>"
    +Object.keys(users).length.toLocaleString()+"</b> named";
  var q=($("q").value||"").trim();
  var lq=q.toLowerCase();
  var ids=Object.keys(people).filter(function(id){
    return !q || id.indexOf(q)>=0 || nm(id).toLowerCase().indexOf(lq)>=0;})
    .sort(function(a,b){return (tot[b]||0)-(tot[a]||0)}).slice(0,60);
  $("list").innerHTML = ids.length? ids.map(function(id){
    var partners=[];
    for(var k in calls){var p=k.split("|");
      if(p[0]===id)partners.push([p[1],calls[k]]); else if(p[1]===id)partners.push([p[0],calls[k]]);}
    partners.sort(function(a,b){return (b[1].ms||0)-(a[1].ms||0)});
    var top=partners.slice(0,5).map(function(x){
      return '<div class="muted" style="margin-left:12px">'+esc2(nm(x[0]))+" · "+fmt(x[1].ms||0)+" · "+(x[1].count||0)+"×</div>";
    }).join("");
    return '<div class="card"><div><b>'+esc2(nm(id))+'</b> <span class="muted">'+id+"</span></div>"
      +'<div class="muted">'+fmt(tot[id]||0)+" in call · "+partners.length+" "
      +(partners.length===1?"partner":"partners")+" · "+(people[id].guilds||[]).length+" servers · last "
      +ago(people[id].last)+"</div>"+top+"</div>";
  }).join("") : '<p class="muted">Nobody matches that.</p>';
}
$("go").addEventListener("click", async function(){
  var t=$("tok").value.trim(); if(!t) return;
  this.textContent="Loading…"; this.disabled=true;
  try{ pool=await load(t); localStorage.setItem(K,t); $("gate").hidden=true; $("app").hidden=false; render(); }
  catch(e){ alert(e.message); this.textContent="Load my data"; this.disabled=false; }
});
$("q").addEventListener("input", function(){ if(pool) render(); });
$("out").addEventListener("click", function(){ localStorage.removeItem(K); location.reload(); });
(async function(){
  var t=localStorage.getItem(K); if(!t) return;
  try{ pool=await load(t); $("gate").hidden=true; $("app").hidden=false; render(); }catch(e){}
})();
</script>`);
}

module.exports = { loginPage, tokenPage, errorPage, appPage, esc };
