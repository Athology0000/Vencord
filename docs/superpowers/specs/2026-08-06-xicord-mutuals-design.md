# Xicord Mutuals — design

Date: 2026-08-06
Status: approved (user selected all options interactively)

## What it does

A new Xicord userplugin (`src/userplugins/xicordMutuals.tsx`) with two features:

### 1. Mutual detection (approved choices: mutual **friends**, shown **both** ways, scope **any visible VC**)

- You maintain a list of **targets** (multiple). A target must be on your friends
  list to ever match, because detection uses Discord's mutual-friends data
  (`GET /users/{id}/relationships` returns people who are friends with both you
  and `{id}`).
- A central scanner watches `VOICE_STATE_UPDATES` plus an initial sweep of
  `VoiceStateStore.getAllVoiceStates()`, and enqueues every human user seen in
  any visible voice channel.
- A throttled queue (1 request / 2.5 s) fetches each user's mutual friends and
  caches the result for 30 minutes. A user "matches" if any target appears in
  their mutual-friends list.
- Display, both:
  - **VC row tag**: a small "Mutual" pill next to the name in voice channel
    member lists (patch on the VoiceUser module, `#{intl::GUEST_NAME_SUFFIX}`),
    tooltip "Mutual with: <target names>".
  - **Traits sync**: an auto-managed trait named `Mutual` in Xicord Traits
    (via `Settings.plugins["Xicord Traits"].tasks`), so the existing VC-join
    audio alert fires for matched users.

### 2. Hidden users (added mid-session by user)

A **hidden** list. Hidden users are filtered, best-effort via runtime store
wraps (restored on plugin stop):

- **Searching**: quick switcher / "Find or start a conversation" results
  (`QuickSwitcherStore.getState().results`).
- **Friends tab incl. pending**: `RelationshipStore.getFriendIDs`,
  `getMutableRelationships`, `getRelationships` (filtered copies) and
  `getPendingCount` (subtract hidden incoming).
- **Someone's mutual friends**: `UserProfileStore.getMutualFriends` filtered,
  so when you open a profile's Mutual Friends tab, hidden users don't show.

`getRelationshipType` / `isFriend` are NOT wrapped, so per-user logic elsewhere
keeps working; only enumerations are filtered.

## Managing targets/hidden (approved: **both** surfaces)

- **Right-click user menu**: "Mutual Target" and "Hide User" checkboxes in an
  own group (same pattern as Xicord Traits' menu).
- **Xicord Traits window**: a "Mutuals" section (exported component
  `MutualsSection`, rendered by xicordTraits.tsx only when the plugin is
  enabled) listing targets (with a non-friend warning) and hidden users, with
  add-by-ID input and remove buttons.

## Conventions

MIT header, author Xicord, `dependencies: ["Xicord Mod Menu", "Xicord Traits"]`,
settings stored as JSON strings via `definePluginSettings` like the other
Xicord plugins. All injected UI wrapped in ErrorBoundary; store wraps guarded
so a missing method is skipped silently.

## Known limits

- Search/friends-tab hiding depends on Discord internals; wraps are
  best-effort and fail open (nothing breaks, users just show again).
- One mutual-friends request per scanned user: big servers take a while to
  fully tag on purpose (rate-limit safety).
- Wrapping `getMutableRelationships` returns a filtered copy, which conflicts
  with plugins that mutate that map (e.g. ImplicitRelationships) while enabled.
