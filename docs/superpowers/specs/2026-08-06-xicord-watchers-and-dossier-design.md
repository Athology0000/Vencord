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
  pairing; the stronger count wins), node size tracks total connection strength,
  and Target-trait members are drawn in brand blue.
- Size is a setting (`fullGraphNodes`, default 150, up to 400) rather than a hard
  cap. **Measured**: the simulation costs 0.38ms/frame at 400 nodes against a
  16.7ms 60fps budget, so the physics was never the constraint — SVG paint and
  readability are.
- The layout adapts to density: canvas grows taller (504px at 60 nodes → 1100px
  at 300), dot radius scales `8/√n`, and only the best-connected carry labels
  (60 labels at 60 nodes, 42 at 300) since `ids` is sorted strongest-first.
- **Repulsion has a distance cutoff** of `2.6 × link length`. Without it, pairs far
  enough apart to be individually negligible summed across hundreds of nodes into
  a force that inflated the web off-canvas — 21 of 300 nodes escaped the frame.
  The cutoff fixed that *and* made the sim 5× faster (1.90ms → 0.38ms at 400).
  The inward centring pull also scales with `√n` to balance the extra outward push.

## Dossier graph: zoom, avatars, hover pill, friend rings (2026-08-06)
- **Zoom**: scroll wheel plus −/+/Reset buttons. The root group's transform became
  `translate(pan) scale(z)`, clamped to 0.35–4×. Wheel zoom is anchored at the
  cursor (solve for the pan that keeps the graph point under it fixed), and the
  pointer→graph conversion divides by `z`.
- **Avatars**: each node is a `<clipPath>`ed `<image>` over the coloured disc, with
  a stroked ring on top. The disc and initial sit underneath, so a failed avatar
  load degrades to the old look with no error handling. Requested at 64px (128 for
  the ego centre) because a full graph can ask for hundreds.
- **Hover pill**: username plus time-in-call, drawn *outside* the panned/zoomed
  group so it stays a constant size at any zoom. Hover is resolved in the sim loop
  (nearest node within its hit radius) rather than with per-node listeners. Width
  is approximated from character count — SVG has no text metrics without a reflow.

### Friends vs call-only — and the hard limit
A **gold ring** marks a proven friendship, a plain ring means "only ever seen in a
call together".

**Discord does not expose another account's friend list.** The only friendship
provable for someone else is a *mutual* one — via `/users/{id}/relationships`,
which returns people who are friends with **both you and them**. So:

- Ego view: gold = a mutual friend of that target (needs Xicord Mutuals enabled and
  scanned; it triggers a scan on open).
- Full view: gold = **your** own friend, since there is no single subject.
- Anyone the target added who is *not also your friend* is invisible to the client
  and stays plain. This cannot be fixed by more code — the data is not served.

## Spacing regression, and automatic mutual scanning (2026-08-06)
**Regression fixed.** Making link length adapt to node count (for the 300-node full
view) also shrank the one-person view: its spokes fell from ~150px to ~70px and the
companions bunched around the target. `ForceGraph` now takes a `spread` multiplier
(2.1 for the ego view), clamped so a sparse graph still fits the canvas
(`min(W,HH)/2 - 40`). Collision padding went 6 → 14px for general breathing room.
Regression test asserts the nearest companion sits ≥80px out — the strongest bond
rests closest *by design*, and the pre-regression code put it at 82.5px.

**Automatic mutual scanning.** Opening the Dossier now queues a mutual-friend scan
for every person in it, and (setting `scanMembers`, default on) for the current
server's loaded member list, capped at `MEMBER_SCAN_CAP = 200` per open. Xicord
Mutuals throttles to one fetch every 2.5s and caches, so this is a slow background
fill; an uncapped member sweep would otherwise run for hours.

## Avatars were invisible (2026-08-06)
The `<clipPath>` elements were emitted in a `<defs>` block at the top of the SVG,
but the simulation looks up its per-node handles with
`nodeGroup.querySelector("circle.xd-clip")`. That returned `null` for every node,
so the clip circles were never moved off `(0,0)` — and every avatar was clipped
against a circle at the origin, i.e. clipped away entirely. Only the coloured disc
and initial underneath showed, which is exactly the intended fallback, so it looked
like the images had simply failed to load.

Fix: emit each `<clipPath>` **inside its own node group** (a `clipPath` renders
nothing itself, so it is free to live there) and set `xlinkHref` alongside `href`
for older SVG handling.

**The test that should have caught this was vacuous**: it asserted
`Number.isFinite(+clip.getAttribute("cx"))`, and `+null` is `0`, which is finite —
so it passed against a null element. Replaced with assertions that each clip circle
exists, is not at the origin, and sits exactly on its node's centre, plus one that
each avatar image is placed over its node.

## Editable max, and the opening-clump fix (2026-08-06)
- `fullGraphNodes` became a NUMBER setting with a live input in the modal
  (clamped 10–1000), shown as "Max people … of N recorded".
- **Centre bug**: every node was seeded on one ring (~214px around), so a big graph
  opened as a solid pile — measured 1144 overlapping pairs at 300 nodes — that then
  visibly exploded outward. Fixed with a phyllotaxis (sunflower) seed on an
  elliptical field matching the canvas, a deterministic jitter (no `Math.random`,
  so a reset reproduces the layout), and a collision-only pre-warm before the first
  paint. Result: 60 and 150 nodes open with zero overlaps; 300 (the cap's extreme)
  opens ~50× better and settles quickly.

## Locked calls + one-time member sweep (2026-08-06)
**Locked/hidden channels were missed.** `reconcile` derived the guild id only from
`ChannelStore.getChannel(channelId)?.guild_id`, but a channel you can't view/join
is often not in `ChannelStore`, so `guildId` came back undefined, `inPublic` was
false, and the call was skipped entirely — even though the client can see who's in
it. Two fixes: take the guild id from the **voice state** (`vs.guildId ??
channel?.guild_id`), and a new `channelOccupants()` that falls back from the
per-channel voice map (which can be empty for a locked channel) to the guild-wide
`getAllVoiceStates()[guildId]` filtered by channel. Result: companions in locked
calls are now recorded. A call with no derivable guild anywhere is still treated as
a DM/group call and ignored, as before.

**Member sweep is now once-per-guild + incremental.** Previously each modal open
re-sliced 200 of the current guild's members. Now `sweepGuildMembers(guildId)`
queues the whole loaded list a single time (tracked in `sweptGuilds`), and a
`GUILD_MEMBER_ADD` subscription scans each newcomer as they join. Still gated by
the `scanMembers` setting and Mutuals' 2.5s throttle/cache, so it's a slow
background fill. `MEMBER_SWEEP_CAP` (5000) is just a pathological-guild guard.
Limit unchanged from before: `getMemberIds` only returns members Discord has
actually loaded into the client, not the full roster of a large guild.

## Known limits
- Watchers only fire for what Discord tells your client (shared servers, visible
  channels, cached presence).
- Dossier co-presence is observational and public-VC only; it grows only while
  the plugin runs and you can see the target's channel.
- Live Watch `selfStream`/`selfVideo` field names are the one pair not proven
  against an existing repo reader — verify in a real client.
