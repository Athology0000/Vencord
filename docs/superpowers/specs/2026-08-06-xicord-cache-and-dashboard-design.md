# Xicord Cache + Dashboard

Date: 2026-08-06
Status: implemented

## Xicord Cache (plugin)
`src/userplugins/xicordCache.tsx`. Bundles every Xicord plugin's data into one
portable JSON snapshot, resolving user IDs → {username, avatar}, channel IDs →
{name, guildId}, guild IDs → {name} so the dashboard renders fully offline.

Sources:
- History `sessions` (the main dataset), Traits `tasks` (normalized users to
  arrays), Mutuals `targets`/`hidden`, Orbit `watched`, Ghost `ghosted`,
  Watchlist `rules`.
- In-memory data via new exports: `MutualsAPI.dump()` (scan results) and Orbit
  `getActivityLog()`.

Output shape: `{ xicordCache:1, exportedAt, self, users, channels, guilds,
history, traits, targets, hidden, watched, ghosted, watchlistRules, orbitLog,
mutuals }`. Delivered via a modal (Copy JSON / Download .json) and a
`/xicord-cache` command. Nothing is sent anywhere.

## Xicord Dashboard (offline HTML)
A self-contained page (`xicord-dashboard.html`, also published as an Artifact)
that loads a cache by drag-drop / file-picker / paste and graphs it. No network
calls; all computation is client-side.

Design: validated dataviz palette (data hue indigo `#3457d5`/`#6f88ff`, teal
secondary, cool-slate neutrals), system sans + monospace, light/dark theme with
a toggle. Charts are single-series (sequential + emphasis) with hover tooltips,
direct labels and a table fallback:
- KPI tiles (hero = total voice time), sessions-over-time area with crosshair,
  top people & channels by voice time (horizontal bars), activity by hour and
  weekday (columns), co-presence "seen together" duos (interval sweep),
  traits, and a searchable/sortable session table.
- A date-range filter (All / 90 / 30 / 7 days) drives every time-based view.

## Verification
- Plugin: `pnpm build` succeeds, `tsc --noEmit` clean, plugin present in bundle.
- Dashboard: JS passes `node --check`; the full render path was exercised
  against a generated 116-session sample cache through a DOM shim (KPIs, all
  charts, and the session table render without throwing).

## Xicord Collector (added)
`src/userplugins/xicordCollector.tsx`. A background collector that enriches the
dataset beyond voice, bounded and privacy-conscious:
- **Message activity** — counts only (no content): per-day totals, per-user and
  per-channel counts, for authors in a "followed" set (friends ∪ Traits users ∪
  Mutuals targets ∪ Orbit watched), recomputed every 30s.
- **Presence sessions** — friends' online/offline sessions {userId, start, end}.
- Persisted (debounced) to settings, day-buckets pruned past 60 days, presence
  capped at 1000. Exposes `CollectorAPI.dump()` for the cache.

The cache now embeds `messages` and `presence`; the dashboard gained a
"Messages & presence" section: messages over time (area, range-aware), top
people & channels by messages, and most time online — shown only when the
collector has data.

## Cache import / restore (added)
The Cache modal gained **Import / Restore…**: it reads a cache JSON and writes
`targets`, `hidden`, `ghosted`, `watched`, `watchlistRules` and `traits` back
into the plugins (their onChange handlers pick it up; Traits/Watchlist read
live). Makes Cache a backup + machine-migration tool. Overwrites those lists.

## Local multi-account correlation (2026-08-06)
Purely local, over exports **you own** — nothing is uploaded, no server, no API,
no third-party data ingestion. (A hosted, credential'd, multi-contributor
ingestion service was explicitly declined; this is the local-only version the
user then asked for.)

- The dashboard now **accumulates** accounts instead of replacing: dropping /
  choosing several exports adds them all, re-loading the same account (same
  `self.id`) refreshes in place. A chip row switches the active per-account view.
- **"Your accounts, cross-referenced"** section (shown once ≥2 are loaded), built
  from pure functions so it is testable headlessly:
  - `crossAccountLinks(accounts)` — people appearing in ≥2 accounts' data, guilds
    shared across accounts, and *direct* links where one account has actually
    recorded another (matched by `self.id`).
  - `lookupAcross(accounts, query)` — type a username (substring, case-insensitive)
    or an id; returns every account that has data on them and a `footprint`
    (voice sessions + time, messages, online time, dossier companions, shared
    guilds, and whether that id is one of your own accounts).
- Tested by `xicord-correlate.test.mjs` (22 assertions, extracts the real
  functions by brace-matching) and dogfooded on a sample-derived pair of accounts.

## Known limits
- The cache is a point-in-time snapshot; re-export to refresh.
- Dashboard only knows the users/channels present in the cache (IDs Discord had
  cached at export time render with names; others show truncated IDs).
- Co-presence needs overlapping sessions in the same channel; sparse History
  yields few duos.
