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

## Known limits
- Watchers only fire for what Discord tells your client (shared servers, visible
  channels, cached presence).
- Dossier co-presence is observational and public-VC only; it grows only while
  the plugin runs and you can see the target's channel.
- Live Watch `selfStream`/`selfVideo` field names are the one pair not proven
  against an existing repo reader — verify in a real client.
