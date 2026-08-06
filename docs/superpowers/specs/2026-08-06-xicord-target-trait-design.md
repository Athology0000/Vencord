# Xicord Target trait — one trait that drives every watcher

Date: 2026-08-06
Status: implemented

## Goal
Give a user the reserved **"Target"** trait and every Xicord watcher applies to
them at once — no separate watch list to maintain.

## Why it's a one-line change in spirit
All six watchers (Profile / Live / Post / Server / Game Watch) and Dossier
already gate on Orbit's exported `WatchAPI.has(id)` / `.list()`. So there is
exactly one place that defines "watched". Redefining it to mean "holds the
Target trait" makes every watcher follow, and **none of the watcher plugins were
touched**.

## `_targetTrait.tsx` (new helper)
Underscore-prefixed so the plugin loader skips it, same as `_watchShared.tsx`.
It is the only module that knows how Traits stores membership.

- Reads `Settings.plugins["Xicord Traits"].tasks`, finds the trait whose name
  matches `Target` (case-insensitively), and splits its `/id1/id2` `users`
  string. Talks to Traits **through the settings store, not an import** — the
  same technique Xicord Watchlist already uses. That keeps the dependency
  one-way and avoids a cycle (Traits imports Mutuals; every watcher imports
  Orbit).
- Parse is cached and keyed on the **raw settings string identity**, so a write
  from anywhere — Orbit, the Traits modal, the Traits context menu —
  invalidates it for free. This matters because `PRESENCE_UPDATES` fires
  near-continuously; the hot path is reduced to a property read plus a string
  compare.
- Change notification via `SettingsStore.addChangeListener("plugins.Xicord
  Traits.tasks", …)`, so subscribers see edits made by any plugin.
- Exports `targetIds`, `hasTarget`, `toggleTarget`, `addTargets`,
  `ensureTargetTrait`, `isTargetTrait`, `subscribeTargets`/`unsubscribeTargets`.

## Xicord Orbit
- `getWatched` / `isWatched` / `toggleWatched` now resolve through the helper;
  `WatchAPI` is unchanged in shape, so every consumer keeps working.
- `dependencies` gains `"Xicord Traits"`.
- The old `watched` setting survives **only as a one-time migration**: on start,
  any IDs still in it are merged into the Target trait and the array is cleared,
  so an existing watch list carries over rather than being lost.
- Modal explains that the list is the Target trait and can be edited from either
  place. "Watch User" in the user context menu keeps its label and now toggles
  the trait.

## Xicord Traits
- `ensureTargetTrait()` on start, so the row always exists to drop people into.
- The Target row is **locked**: name field disabled, delete button replaced by an
  eye badge, with a note explaining why. This closes the failure mode the
  reserved-name approach otherwise carries (rename it and watching silently
  stops).
- `audio()` now no-ops on an empty URL instead of letting `play()` reject — the
  auto-created Target trait starts with no clip.

## Xicord Mutuals folded into the same list
Mutuals used to keep its own `targets` setting — confusingly described as "Mutual
target user IDs", a second thing called *target*. It now reads its scan seeds
from the same reserved trait, so there is **one list of people**: everyone on it
is watched by every watcher *and* used as a seed for mutual-friend scanning.

- `getTargets()` resolves to `targetIds()`. The `targets` setting survives only
  as a one-time migration (on start, and on write so a Cache restore of a
  pre-merge backup lands in the trait rather than sitting there until restart).
- Mutuals' "Mutual Targets" editor now edits the shared trait and is relabelled
  accordingly. It was kept rather than deleted because it is the only way to add
  a target **by ID** — the Traits row and the context menu can only tick users
  you can right-click.
- `toggleTarget` delegates to the helper, keeping its "they must be a friend to
  match" toast.

### The loop this had to avoid
Mutuals also *writes* the auto-managed "Mutual" trait into the same `tasks` blob
it now *reads* targets from, and `subscribeTargets` fires on any write to that
path. Left alone: scanner writes Mutual → listener fires → `onTargetsChanged` →
`clearManagedMutualTrait` + N× `syncMutualTrait` → listener fires → forever.

`onTargetTraitChanged` compares target membership against `lastTargetKey` and
bails when unchanged, which a Mutual-trait write always is. `lastTargetKey` is
assigned *before* calling `onTargetsChanged`, so the writes that handler makes
re-enter against the already-updated key. Start-up order matters too: migration
runs *before* subscribing, so the migration's own write can't re-enter.

## Defects found in review and fixed
- **Two "Target" traits could diverge.** The Traits context menu matched trait
  names *exactly* while `_targetTrait` matches case-insensitively, so with both
  `target` and `Target` present the checkbox wrote one entry while the watchers
  read the other — two checkboxes in one menu disagreeing, with the visible one
  doing nothing. The submenu now routes the reserved trait through
  `toggleTarget()`, and the add form rejects duplicate names (case-insensitively)
  rather than creating a second, permanently locked and unremovable row.
  Renaming a trait *onto* "Target" is rejected for the same reason.
- **The Traits modal clobbered concurrent writes.** It snapshotted the traits
  JSON at mount and serialised that snapshot on every edit. Since Xicord Mutuals
  rewrites the same JSON from a background scanner (`xicordMutuals.tsx:259`, via
  `syncMutualTrait`), editing any field could revert Target membership and
  silently un-watch people. The modal now subscribes to the settings path and
  every write is read-modify-write against live settings.
- **Writes dropped other plugins' data.** `parseTraits` filtered out entries it
  didn't understand and then wrote that filtered array back, so a single toggle
  would delete Mutuals' auto-managed trait. Parsing now preserves unknown
  entries and extra fields verbatim.
- **Stale checkbox.** Traits' submenu snapshotted checked state in `useState`, so
  clicking Orbit's "Watch User" in the same menu left the "Target" checkbox
  showing the opposite. Checked state is now derived live.
- **Renaming a trait dropped keystrokes.** Moving writes to read-modify-write made
  the row lookup (`find(t => t.name === task.name)`) miss whenever two edits
  landed before a re-render, because `task.name` came from the render snapshot
  that was no longer being mutated. Rows are now keyed and edited **by position**,
  which also stops the row remounting (and losing input focus) on every keystroke,
  and makes deleting one of two same-named traits remove exactly one.
- **Presence seeding was bypassed.** Targeting someone from the Traits menu
  skipped Orbit's `lastPresence` seed and fired a spurious "is now online" toast.
  Seeding moved into Orbit's change subscriber, so it now happens for *every*
  writer — the modal, the context menu, and a Cache restore — instead of only
  Orbit's own toggle.
- **Cache restore could wipe targets.** `restoreFromCache` wrote Orbit's legacy
  `watched` before overwriting `tasks`, so a restored pre-Target backup lost its
  targets. Restore order is now traits-then-watched, the `watched` setting
  migrates on write (not just at start), and the restore preserves extra trait
  fields instead of stripping them.
- **Conditional hook.** Traits' context-menu patch returned early for your own
  user *after* the hook; the self-check moved into the patch callback, matching
  Orbit's shape.

### From the merge review
- **Cache export dropped `managed`.** The export mapped traits to
  `{name, url, users}`, discarding the flag that marks the Mutual trait as
  auto-managed. After any export→restore round-trip `clearManagedMutualTrait`
  would no-op forever while syncing kept appending, so the trait grew
  monotonically and never reset. The export now spreads the original entry, as
  the restore already did.
- **Hundreds of writes per target toggle.** `onTargetsChanged` did a clear plus
  one `syncMutualTrait` per cached user, each a full settings stringify *and* a
  synchronous disk IPC, re-rendering every subscriber each time. Replaced with
  `syncMutualTraitAll()`, which reconciles the whole trait in one write and
  writes nothing when already correct.
- **Corrupt settings could wipe the Target trait.** Mutuals' `readTraits`
  returned `[]` on a JSON parse failure, and the next write would persist that
  empty array over the single source of truth for all six watchers. It returns
  `null` now, matching its own disabled-plugin path.
- **A restored stale Mutual trait was never reconciled.** The guard keyed only on
  target membership, so a Cache restore that changed just the Mutual trait was
  ignored. The key now covers both, and `writeTraits` raises a `suppress` counter
  for the duration of our own writes (settings listeners fire synchronously) and
  refreshes the key afterwards — so we react to everyone else's writes but never
  to our own.
- **Orbit re-rendered on every Mutuals write.** Mutuals rewrites its trait every
  few seconds while scanning, and Orbit's subscriber ran unconditionally. It now
  compares the target list first.
- **Inconsistent hand-made-trait handling.** The new bulk reconcile skipped a
  user-made trait named "Mutual" while the incremental path still appended to it;
  both now leave it alone, which is what the original `managed` flag intended.

Not fixed (pre-existing, unrelated to this change): renaming any trait loses
input focus because the row `key` is its name; the context-menu patches call
their item functions directly so hook counts vary; Orbit's activity log is
index-keyed. These predate the change and are noted for a later pass.

## Verification
- `tsc --noEmit` clean; `pnpm build` succeeds; the bundle shows
  `dependencies:["Xicord Mod Menu","Xicord Traits"]` on Orbit.
- 45-assertion harness (`src/userplugins/_targetTrait.test.mjs`, run with
  `node src/userplugins/_targetTrait.test.mjs`) exercises the **real**
  `_targetTrait` module — esbuild-bundles it against a stubbed settings store,
  kept *external* so the bundle and the test share one instance rather than
  silently mutating separate copies. Covers reads, cache invalidation, toggle
  round-trips, migration merge, malformed/missing data, change notification, and
  that writes preserve other plugins' traits, extra fields and ordering.
- Migration dry-run against **this install's actual settings shape** (Traits'
  `tasks` unset, 3 IDs in Orbit's `watched`): all three carry into the Target
  trait, the legacy setting clears, and a second start is a no-op.
- Feedback-loop test: 50 simulated `syncMutualTrait` writes (mirroring Mutuals'
  real write path) leave `targetIds()` byte-identical, so the recursion guard
  trips every time — while a genuine target change still moves the key. Plus a
  test that Orbit's and Mutuals' legacy lists merge into one trait as a union,
  without duplicates or a second Target row.
- 20-assertion harness at `src/userplugins/_mutualsTarget.test.mjs` extracts the
  real `syncMutualTraitAll()` and pins the properties the merge relies on: one
  write per reconcile and none when already correct, removals in the same single
  write, a hand-made "Mutual" trait left untouched, unreadable settings producing
  no write at all (Target survives), and other plugins' traits and extra fields
  preserved.
- Cross-plugin **format contract** is tested against mirrors of the other
  plugins' actual parsers: Traits' context-menu writes are readable by
  `_targetTrait`, and its writes are readable by both Traits' checkbox
  (`split("/").includes`) and Watchlist's `traitUserIds`
  (`split("/").filter(Boolean)`).
- Lint: no new errors. The Xicord family's pre-existing `simple-header/header`
  failures (MIT headers vs Vencord's GPL header) remain, as does Traits'
  pre-existing duplicate `@webpack` import.

## Known limits
- The trait name is reserved by convention. Locking the row prevents renaming it
  from the modal, but editing `settings.json` by hand still can.
- If a trait named "Target" (any casing) already existed for some other purpose,
  it is adopted as the watch list on first start — everyone already in it becomes
  watched, and the row can no longer be renamed to opt out. Inherent to the
  reserved-name approach; rename the old trait before upgrading if that matters.
- Watching is only as good as what Discord tells your client — unchanged from
  the existing watcher limits.
