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

## Known limits
- The cache is a point-in-time snapshot; re-export to refresh.
- Dashboard only knows the users/channels present in the cache (IDs Discord had
  cached at export time render with names; others show truncated IDs).
- Co-presence needs overlapping sessions in the same channel; sparse History
  yields few duos.
