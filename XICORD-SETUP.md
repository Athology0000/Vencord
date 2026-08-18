# Setting up Xicord on a fresh PC, and merging a third account

Written against the running system, not from memory: the file list comes from
`git status --ignored`, the endpoints from `xicord-sync/server.js`, and the sign-in flow
from `xicord-sync/auth.js`.

## The thing that will bite you first

**A `git clone` of this repo gives you no Xicord at all.** `src/userplugins/` is in
`.gitignore`, and `xicord-crypto.js`, `xicord-dashboard-server.js`, `start.bat` and
`xicord-cache-sample.json` were never committed. Clone, build, inject, and you get a
clean Vencord with none of this in it — and nothing tells you why.

So the first step is not cloning. It is:

```
node xicord-bundle.mjs            # on THIS PC -> ./xicord-transfer
```

That collects the 54 files a clone will not carry, checks that no plugin imports a
repo-root file the bundle forgot, and writes a `READ-ME-FIRST.txt` next to them. Move
that folder to the new machine on a USB stick or however you like.

## On the fresh PC

```
git clone https://github.com/Vendicated/Vencord    # or your fork
cd Vencord
# copy the bundle over the top, keeping paths:
#   xicord-transfer/src/userplugins/  ->  Vencord/src/userplugins/
#   xicord-transfer/xicord-*.*        ->  Vencord/
pnpm install
pnpm build
pnpm inject          # pick your Discord install, then restart Discord
```

Then in Discord: **User Settings → Vencord → Plugins**, and enable at least

| Plugin | Why |
|---|---|
| Xicord Dossier | the engine — recording, the sweep, and the sync loop itself |
| Xicord Mutuals | the mutual-friend scanner the sweep is built on |
| Xicord Cache | owns the native module that HTTP is routed through, and writes the snapshot |
| Xicord Orbit / Mod Menu | the watch list and the toolbar the buttons live on |
| Xicord Sync | the sync control panel |

## Getting that account its own token

Each account needs **its own** token — that is what tells the pool whose slice a push
belongs to. Sharing one token between accounts makes them a single contributor and throws
away the entire benefit.

1. Open <https://xicord-sync-production.up.railway.app/> in a browser **signed into the
   Discord account you are setting up**.
2. Click **Sign in with Discord**. The scope is `identify` — it reads your user id and
   nothing else.
3. Copy the token (`xic-…`) from the page that follows.

Sign-in links are single-use and last ten minutes, so do this on the machine you are
setting up rather than emailing yourself a link.

## Wiring it up

**Xicord Dossier** settings:

| Setting | Value |
|---|---|
| `syncUrl` | `https://xicord-sync-production.up.railway.app` |
| `syncToken` | the `xic-…` token for **this** account |
| `syncEnabled` | on |
| `syncMyIds` | **every** account id you run, comma separated |

That last one matters more than it looks. `myAccountIds()` drops these from the pool
before pushing, because you are in every call you join — leave an id out and that account
becomes a hub wired to everyone, which is noise in the exact graph you are measuring. So
all three accounts get the *same* `syncMyIds` list, each with its own token.

**Xicord Sync** settings: leave `shareWatchlist` **off** unless you mean it. Calls and
proven friendships sync; the watchlist is a record of what you are doing rather than of
anything that happened.

## Checking it worked

Toolbar → the **Xicord Sync** button. You want:

```
Status    up · N device(s) in the pool
Token     set
Syncing   on
```

Then press **Sync now** and watch `Last run`. It pulls before it pushes — after a pull
the local counters already include what everyone else contributed, so the highest-wins
merge is a running total rather than one machine's partial view.

From this PC you can confirm the merge without touching Discord:

```
curl -s -H "Authorization: Bearer xic-…" \
  https://xicord-sync-production.up.railway.app/v1/pool | \
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);console.log(d.counts)})"
```

`counts.friends` climbing after the new account's first sweep is the third arm landing.

## How the three accounts actually merge

Nothing to configure — this is what the service does.

- Each account pushes into **its own slice**, keyed by the Discord id its token is bound to.
- `/v1/pool` returns the **union of every slice**, so all three see one picture.
- Friendships union across accounts. You can only ever see `friends(you) ∩ friends(them)`,
  so three lenses see three different slices of the same true set — that union is the
  whole point of running more than one account.
- Each pooled entry carries `sources`: how many accounts still vouch for it. A name two
  accounts independently prove is stronger evidence than one that only one asserts.
- **Retraction still works.** An unfriending removes the name from the slice that claimed
  it, and it leaves the pooled view once nobody is left vouching. A name survives exactly
  as long as somebody can still prove it.

Because 75% of findings on the first account came via a *single* specific friend, a third
account with a different friend list should surface a largely disjoint set of people. If
the union barely moves, the lenses overlap more than expected — which is a real result
about the group, not a bug.

## What does not travel, and why

| File | Why it stays put |
|---|---|
| `xicord-key.bin` | DPAPI-sealed to one Windows account. Useless elsewhere; the new PC mints its own on the first snapshot. |
| `xicord-cache.json` | That machine's own observations. The new PC builds its own, and they meet in the pool. |
| `settings.json` | Holds the sync token, which must be one per account. |

Copying the key or the cache across does not "share" anything — the sync is what shares
things. It just produces two machines that disagree about what they have seen.

## If it does not work

| Symptom | Cause |
|---|---|
| No Xicord buttons after a build | The bundle was not copied. `src/userplugins/` is gitignored — check it exists and is not empty. |
| `sync needs the Xicord Cache plugin (desktop only)` | Xicord Cache is disabled, or this is the web build. HTTP is routed through its native module because the renderer cannot get past Discord's CSP. |
| `403 this token is not bound to a user` | The token came from an env-var list rather than the sign-in flow. Only OAuth-issued `xic-…` tokens carry an owner, and only those may push. |
| `up · N devices` but `counts.friends` never moves | That account has not swept yet. The friend graph only exists after Xicord Mutuals has actually answered for people. |
| Sweep runs but finds nobody | The account has too few friends. Your friend list is the lens — servers only decide who you can ask about. |
