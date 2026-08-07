# Xicord watcher family + Dossier

Date: 2026-08-06
Status: implemented

## Shared watch list
Orbit now exports `WatchAPI { list, has, toggle, subscribe, unsubscribe, log }`
and `_watchShared.tsx` (underscore-prefixed so the plugin loader skips it)
provides `feedRing`, `useWatchFeed`, `WatchModalShell`. All new watchers read
Orbit's single watched list (managed via Orbit's "Watch User" context item) and
append events to Orbit's activity feed, so there's one list of people and one
log with many signals. Each watcher also fires its own optional toast.

## Watchers (each: dependency on Orbit, own toast toggle, recent-events modal)
- **Xicord Profile Watch** — USER_UPDATE + custom status: username / display name
  / avatar / custom-status changes. (Reads raw `global_name`; emoji-only status
  handled.)
- **Xicord Live Watch** — VOICE_STATE_UPDATES `selfStream`/`selfVideo`: went live
  / turned on camera, with channel. Baseline seeded from VoiceStateStore.
- **Xicord Post Watch** — MESSAGE_CREATE: posted a message (per user+channel 45s
  cooldown; DM inclusion toggle; skips bots and self).
- **Xicord Server Watch** — GUILD_MEMBER_ADD/REMOVE/UPDATE: joined/left a shared
  server, nickname changes. (Reads `guild_id` fallback.)
- **Xicord Game Watch** — PRESENCE_UPDATES activities: started a game / rich
  presence (music optional). Baseline seeded only for currently-online users.

## Xicord Dossier
Builds, over time, a persistent per-target profile of who each watched person
shares **public-server** voice channels with — never DMs or group calls.

- On VOICE_STATE_UPDATES it reconciles each affected/open target: looks up the
  target's current guild VC and its occupants (minus bots), tracks an open
  overlap per companion, increments a co-call `count` when a companion first
  appears and accumulates overlap `ms` when they leave / the target leaves.
- Persists `{ [targetId]: { companions:{id:{count,ms,last}}, guilds:{id:n},
  firstSeen, updated } }` (debounced, companions capped at 300, pruned by count).
- UI: a Dossier modal with a target picker, ranked "calls with" list (times +
  total overlap + last seen) and a servers breakdown; a "View Dossier" user
  context item. Optional toast on a brand-new companion (off by default).
- Exposed as `getDossiers()` and embedded in the Xicord Cache export.

## Verification
- `pnpm build` succeeds; `tsc --noEmit` clean; all six plugins present in bundle.
- Two field-name bugs found by adversarial review were fixed before ship
  (USER_UPDATE `global_name`, GUILD_MEMBER_* `guild_id`), plus Game Watch seed
  gating and emoji-status handling.

## Dossier: propagation (2026-08-06)
The Dossier no longer tracks only the Target trait. It walks **outward through the
recorded call graph** — targets, then everyone they called with, then everyone
*those* people called with — with no depth limit, stopping at a cap.

- `propagate` toggle (default on) and a `maxTracked` slider (default 150).
- Breadth-first, so nearer hops always win a contested cap slot; within a hop the
  strongest call-links win. Real targets are never dropped.
- **Dossier-only**: nobody reached by propagation is added to the Target trait, so
  no watcher toasts for them and Xicord Mutuals never scans them.
- Because depth is unbounded, stored profiles are capped (`MAX_PROFILES = 600`,
  least-recently-updated pruned first, never a target) — otherwise `settings.json`
  would grow forever, and it is written synchronously to disk.
- The modal's picker lists propagated people alongside targets, marked `↳`.

## Dossier: the in-Discord graph is live (2026-08-06)
`NetworkGraph` was a static ring. It is now a force layout: drag a node and the
rest respond through springs + repulsion, drag the background to pan,
double-click to reset, and the graph parts around the cursor as it moves (nodes
swell, edges brighten).

- Positions are deliberately **not** in the JSX. React renders the structure once
  and a `requestAnimationFrame` loop writes `cx`/`cy` straight to the DOM, so a
  parent re-render can't stomp the live layout and 20 nodes never re-render at
  60fps. The effect is keyed on the cast (target + companion ids), not on
  `viewProfile`'s output, which is a fresh object every render.
- A node's invisible hit target grows with the cursor field, so a node nudged
  aside stays grabbable rather than dodging the pointer.
- Click still opens a profile, but only when the pointer moved < 4px — otherwise
  every drag would open someone's profile on release.

## Dossier: unknown users, and the full view (2026-08-06)
Propagation surfaces people you have never interacted with, so `UserStore` had no
record of them and the UI rendered raw snowflake IDs with broken avatars.

- Missing users are fetched with `UserUtils.getUser`, one every 220ms so the
  endpoint isn't hammered, with failures remembered so a deleted account isn't
  retried forever. The visible graph jumps the queue ahead of the picker list.
- Avatars fall back to `IconUtils.getDefaultAvatarURL(id)` instead of rendering a
  broken image, and an unresolvable name shows as `Unknown (123456…)`.

`NetworkGraph` was generalised into **`ForceGraph`**, which takes a node list and
an explicit link list rather than assuming a single hub. Springs run along links,
so the same component drives both views:

- **One person** — the previous ego network (target anchored in the middle).
- **Full dossier** — everyone with a record, wired to everyone they have shared a
  call with. Pairs are deduplicated (both people hold a record of the same
  pairing; the stronger count wins), nodes are capped at the best-connected 60 to
  keep the O(n²) repulsion pass cheap and the picture legible, node size tracks
  total connection strength, and Target-trait members are drawn in brand blue.
- Link rest length scales with node count (`620/√n`, clamped), otherwise a large
  web sprawls straight off the canvas.

## Known limits
- Watchers only fire for what Discord tells your client (shared servers, visible
  channels, cached presence).
- Dossier co-presence is observational and public-VC only; it grows only while
  the plugin runs and you can see the target's channel.
- Live Watch `selfStream`/`selfVideo` field names are the one pair not proven
  against an existing repo reader — verify in a real client.
