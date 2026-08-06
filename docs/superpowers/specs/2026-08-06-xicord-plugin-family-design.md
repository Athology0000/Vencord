# Xicord plugin family (Orbit, Circles, Ghost, Watchlist, History)

Date: 2026-08-06
Status: implemented

Five sibling userplugins that reuse the conventions of Xicord Mutuals / Traits
(MIT header, author Xicord, `xicordButton` auto-rendered by Xicord Mod Menu,
JSON-string settings, context-menu patches, ErrorBoundary-wrapped UI).

## Xicord Orbit
Watch specific users. Right-click → "Watch User". Subscribes to
`VOICE_STATE_UPDATES` and `PRESENCE_UPDATES`; toasts + an in-memory activity
log (jump-to-channel, DM-aware) when a watched user joins/leaves a VC or comes
online. Watched set + presence baseline are cached to keep the presence path
cheap.

## Xicord Circles
Modal (guild context menu "Show Circles" or Mod Menu button on the selected
guild) that maps a server's loaded members by which of *your* friends they are
mutual friends with. Reuses `Xicord Mutuals`'s exported `MutualsAPI` scanner
rather than duplicating the throttled fetcher. Caps at 200 newly-queued
members per open, drains its queue on close, and warns when Mutuals hasn't
started yet (restart-required window).

## Xicord Ghost
Right-click → "Ghost User". Suppresses `MESSAGE_CREATE`, `TYPING_START`, and
`MESSAGE_REACTION_ADD` from ghosted users via a single
`FluxDispatcher.addInterceptor` (guarded by an `active` flag since Flux has no
public remove). Live-only and undetectable; the modal documents that history
still loads and unread badges can lag.

## Xicord Watchlist
Rules built on `Xicord Traits`: "gather" (alert when N trait-holders share a
VC) and "join" (alert when any trait-holder joins a VC). Plays the trait's
audio + toast, per-rule/channel/user cooldown to avoid spam.

## Xicord History
Records per-user VC sessions (join/leave timestamps, channel, guild) to a
capped (500) settings JSON. Searchable modal by user or channel. Handles the
local-user channel-move quirk (channelId === oldChannelId) with a tracked
`myLastChannelId`, seeds in-progress sessions from `getAllVoiceStates()`
(correctly keyed by guild), and closes open sessions on stop.

## Known limits
- Circles only sees members Discord has loaded into the list; scroll to load more.
- Ghost can't remove already-rendered/historical messages and may leave stale
  unread markers.
- History lives in a settings string (fine at 500 cap; DataStore would scale
  better) and loses in-progress sessions on a hard crash (saved on clean stop).
- Circles depends on Xicord Mutuals being enabled AND started (needs a restart
  after first enable because Mutuals ships a webpack patch).
