/*
 * The handful of pages this service serves to a browser.
 *
 * Mobile-first on purpose: the reason a hosted sync exists at all is to reach the data
 * from a phone, so that is the screen these are laid out for.
 *
 * No framework and no build step — these are strings. Everything below is plain DOM, which
 * is also what keeps the data page quick: see the index built in appPage().
 */

const esc = t => String(t ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CSS = `
:root{
  color-scheme:dark;
  --bg:#0d0d0f; --surface:#141418; --surface-2:#1c1c21; --line:#2a2a32;
  --text:#ececed; --text-2:#b6b6bf; --text-3:#9a9aa4;
  --accent:#5865f2; --accent-hover:#4752c4; --focus:#a9b4ff;
  --good:#8be9a0; --warn-line:#5a4715; --warn-bg:#1e1808; --warn-text:#f0d590;
  --bad:#ff9b9b;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:28px 20px 48px;
  font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;
  background:var(--bg);color:var(--text)}
.wrap{max-width:560px;margin:0 auto}

/* One visible focus treatment everywhere. Without this a keyboard user cannot tell
   where they are — the single biggest accessibility failure on a page of buttons. */
:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:6px}

h1{font-size:26px;line-height:1.2;margin:0 0 6px;letter-spacing:-.01em}
h2{font-size:16px;margin:28px 0 8px;color:var(--text-2)}
p{margin:0 0 14px;color:var(--text-2)}
.lead{color:var(--text-2)}
.muted{color:var(--text-3);font-size:13.5px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:22px}
.dot{width:11px;height:11px;border-radius:50%;background:var(--accent);flex:none}
.brand span{font-weight:650;letter-spacing:.2px}

.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;
  padding:15px 18px;border-radius:11px;border:1px solid transparent;cursor:pointer;
  text-decoration:none;background:var(--accent);color:#fff;font:inherit;font-weight:600;
  font-size:17px;transition:background .12s ease}
.btn:hover{background:var(--accent-hover)}
.btn:active{background:var(--accent-hover);transform:translateY(1px)}
.btn[disabled]{opacity:.6;cursor:progress}
.btn.ghost{background:var(--surface-2);color:var(--text);border-color:var(--line);
  font-weight:500;margin-top:10px}
.btn.ghost:hover{background:#25252c}

.field{width:100%;padding:13px;border-radius:9px;border:1px solid var(--line);
  background:#0a0a0c;color:var(--text);font:15px inherit}
.field::placeholder{color:#7b7b85}
.field.mono{font:14px ui-monospace,SFMono-Regular,Menlo,monospace}

.card{background:var(--surface);border:1px solid #24242b;border-radius:12px;
  padding:16px;margin:16px 0}
pre{margin:0;padding:13px;background:#0a0a0c;border:1px solid #24242b;border-radius:9px;
  overflow-x:auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
  user-select:all;color:var(--good);white-space:pre-wrap;word-break:break-all}
code{background:var(--surface-2);padding:2px 6px;border-radius:5px;font-size:14px}
ol{padding-left:20px;color:var(--text-2)}
li{margin-bottom:7px}
.warn{border-color:var(--warn-line);background:var(--warn-bg)}
.warn p{color:var(--warn-text)}
.err{border-color:#5c2626;background:#1e0d0d;color:var(--bad);padding:12px 14px;
  border-radius:9px;border-width:1px;border-style:solid;margin:12px 0}
footer{margin-top:32px;color:var(--text-3);font-size:12.5px}

/* Announced to screen readers, invisible on screen. Used for input labels that the
   surrounding copy already explains visually. */
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}

.row{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.name{font-weight:650}
.sub{color:var(--text-3);font-size:13px;margin-top:3px}
.partner{display:flex;justify-content:space-between;gap:10px;color:var(--text-3);
  font-size:13px;padding:3px 0 0 12px}
.tag{font-variant-numeric:tabular-nums}

@media (prefers-reduced-motion:reduce){
  *{transition:none!important;animation:none!important}
  .btn:active{transform:none}
}
`;

function shell(title, body) {
    return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><style>${CSS}</style>
<body>
<div class="wrap">
<header class="brand"><div class="dot" aria-hidden="true"></div><span>Xicord Sync</span></header>
<main>
${body}
</main>
<footer>Your data stays in this instance. Nothing is sent anywhere else.</footer>
</div>`;
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
  <p class="muted" id="copystate" role="status" aria-live="polite" style="margin:10px 0 0"></p>
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
  var el = document.getElementById("tok"), state = document.getElementById("copystate");
  try {
    await navigator.clipboard.writeText(el.textContent);
    // Announced rather than only shown: the button label changing is invisible to a
    // screen reader unless something live says so.
    state.textContent = "Token copied to the clipboard.";
    this.textContent = "Copied";
    setTimeout(function () { document.getElementById("copy").textContent = "Copy token"; }, 1600);
  } catch (e) {
    // The clipboard API needs a secure context and permission. Selecting the text is a
    // reliable fallback and still leaves the user one keystroke from copying.
    var r = document.createRange(); r.selectNode(el);
    getSelection().removeAllRanges(); getSelection().addRange(r);
    state.textContent = "Selected the token — press Ctrl+C (or Cmd+C) to copy.";
  }
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
 *
 * The pool is big — ~11k people against ~114k call pairs — so everything derived from it is
 * computed ONCE into an index when it loads. Searching then costs a scan of the names and
 * nothing else. (It used to walk every call pair for every card it drew, so a single
 * keystroke did roughly seven million iterations before painting.)
 */
function appPage() {
    return shell("Your data — Xicord Sync", `
<h1>Your data</h1>

<div id="gate">
  <p class="lead">Paste the token you were given after signing in.</p>
  <form class="card" id="gateform">
    <label class="sr-only" for="tok">Sync token</label>
    <input id="tok" class="field mono" type="password" autocomplete="off" autocapitalize="off"
      spellcheck="false" placeholder="xic-…" aria-describedby="gateerr">
    <button class="btn" id="go" type="submit" style="margin-top:10px">Load my data</button>
  </form>
  <p id="gateerr" class="err" role="alert" hidden></p>
  <a class="btn ghost" href="/">Need a token? Sign in</a>
</div>

<div id="app" hidden>
  <div class="card"><p id="stats" style="margin:0"></p></div>
  <label class="sr-only" for="q">Search people by name or id</label>
  <input id="q" class="field" type="search" placeholder="Search by name or id…"
    autocomplete="off" aria-describedby="count">
  <p id="count" class="muted" role="status" aria-live="polite" style="margin:10px 0 0"></p>
  <div id="list"></div>
  <button class="btn ghost" id="more" type="button" hidden>Show more</button>
  <button class="btn ghost" id="out" type="button" style="margin-top:18px">Forget token</button>
</div>

<script>
var K="xicord-sync-token", PAGE=40;
var pool=null, idx=null, shown=PAGE, matches=[];
var $=function(i){return document.getElementById(i)};
var esc2=function(t){return String(t).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]})};

function fmt(ms){var s=Math.round(ms/1000);if(s<60)return s+"s";
  var m=Math.round(s/60);if(m<60)return m+"m";
  var h=Math.floor(m/60);return h<48?(h+"h "+(m%60)+"m"):(Math.round(h/24)+"d")}
function ago(t){if(!t)return"never";var s=Math.floor((Date.now()-t)/1000);
  if(s<3600)return Math.max(1,Math.floor(s/60))+"m ago";
  if(s<86400)return Math.floor(s/3600)+"h ago";return Math.floor(s/86400)+"d ago"}
function n(x){return (x||0).toLocaleString()}

async function load(tok){
  var r=await fetch("/v1/pool",{headers:{Authorization:"Bearer "+tok}});
  if(!r.ok) throw new Error(r.status===401
    ? "That token was not accepted. Check you copied all of it."
    : "The server returned "+r.status+".");
  return r.json();
}

/* One pass over the pool. Everything the list needs is derived here so that typing in the
   search box only ever filters a prepared array. */
function buildIndex(){
  var people=pool.people||{}, calls=pool.calls||{}, users=pool.users||{};
  var tot={}, partners={}, hay={}, name={};
  for(var k in calls){
    var i=k.indexOf("|"); if(i<0) continue;
    var a=k.slice(0,i), b=k.slice(i+1), c=calls[k], ms=c.ms||0;
    tot[a]=(tot[a]||0)+ms; tot[b]=(tot[b]||0)+ms;
    (partners[a]||(partners[a]=[])).push([b,c]);
    (partners[b]||(partners[b]=[])).push([a,c]);
  }
  for(var id in partners) partners[id].sort(function(x,y){return (y[1].ms||0)-(x[1].ms||0)});
  var order=Object.keys(people);
  for(var j=0;j<order.length;j++){
    var pid=order[j], u=users[pid];
    name[pid]=(u&&u.username)||pid;
    // lower-cased once, so a keystroke is a substring test and not 11k toLowerCase calls
    hay[pid]=(name[pid]+" "+pid).toLowerCase();
  }
  order.sort(function(x,y){return (tot[y]||0)-(tot[x]||0)});
  idx={tot:tot,partners:partners,hay:hay,name:name,order:order,
       nPeople:order.length,nCalls:Object.keys(calls).length,nNamed:Object.keys(users).length};
}

function card(id){
  var people=pool.people||{}, ps=idx.partners[id]||[], p=people[id]||{};
  var top="";
  for(var i=0;i<ps.length && i<5;i++){
    top+='<div class="partner"><span>'+esc2(idx.name[ps[i][0]])+'</span>'
       + '<span class="tag">'+fmt(ps[i][1].ms||0)+" · "+n(ps[i][1].count)+"\\u00d7</span></div>";
  }
  return '<div class="card"><div class="row"><span class="name">'+esc2(idx.name[id])+"</span>"
    + '<span class="tag muted">'+fmt(idx.tot[id]||0)+"</span></div>"
    + '<div class="sub">'+n(ps.length)+" "+(ps.length===1?"partner":"partners")
    + " · "+n((p.guilds||[]).length)+" servers · last seen "+ago(p.last)+"</div>"
    + top+"</div>";
}

function render(){
  var q=($("q").value||"").trim().toLowerCase();
  matches = q ? idx.order.filter(function(id){return idx.hay[id].indexOf(q)>=0}) : idx.order;
  shown=Math.min(shown,Math.max(PAGE,matches.length));
  var slice=matches.slice(0,shown);
  $("list").innerHTML = slice.length ? slice.map(card).join("")
    : '<p class="muted">Nobody matches that.</p>';
  $("count").textContent = matches.length
    ? n(matches.length)+(q?" matching":"")+" "+(matches.length===1?"person":"people")
      +(slice.length<matches.length?" · showing "+n(slice.length):"")
    : "No matches.";
  $("more").hidden = slice.length>=matches.length;
}

function open(data,tok){
  pool=data; buildIndex();
  try{ localStorage.setItem(K,tok); }catch(e){}
  $("stats").innerHTML="<b>"+n(idx.nPeople)+"</b> people · <b>"+n(idx.nCalls)
    +"</b> call pairs · <b>"+n(idx.nNamed)+"</b> named";
  $("gate").hidden=true; $("app").hidden=false;
  render();
}

$("gateform").addEventListener("submit", async function(e){
  e.preventDefault();
  var t=$("tok").value.trim(); if(!t) return;
  var b=$("go"), err=$("gateerr");
  err.hidden=true; b.textContent="Loading…"; b.disabled=true;
  try{ open(await load(t), t); }
  catch(ex){
    // Inline and announced, rather than an alert() a screen reader may never surface and
    // a phone renders as a modal you have to dismiss before you can fix the typo.
    err.textContent=ex.message; err.hidden=false;
    b.textContent="Load my data"; b.disabled=false; $("tok").focus();
  }
});

/* Coalesced to one paint per frame: holding a key down otherwise re-filters and re-renders
   per keystroke, which is what makes a search box feel heavy. */
var queued=false;
$("q").addEventListener("input", function(){
  if(!idx||queued) return;
  queued=true; requestAnimationFrame(function(){ queued=false; shown=PAGE; render(); });
});
$("more").addEventListener("click", function(){ shown+=PAGE; render(); $("more").focus(); });
$("out").addEventListener("click", function(){
  try{ localStorage.removeItem(K); }catch(e){}
  location.reload();
});

(async function(){
  var t=null; try{ t=localStorage.getItem(K); }catch(e){}
  if(!t) return;
  try{ open(await load(t), t); }
  catch(e){ try{ localStorage.removeItem(K); }catch(_){} }
})();
</script>`);
}

module.exports = { loginPage, tokenPage, errorPage, appPage, esc };
