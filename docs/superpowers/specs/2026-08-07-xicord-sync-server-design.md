# Xicord Sync — shared dossier storage on Railway

**Status:** approved design, not yet implemented
**Date:** 2026-08-07

## Problem

The dossier lives on one machine. `xicord-cache.json` sits beside `settings.json` on
whichever PC recorded it, so a second PC starts from nothing: no companion history, and
none of the ~4,400 resolved usernames that took hours of throttled lookups to gather.
There is also no copy anywhere if that machine dies.

We want one pooled dataset that several PCs contribute to and read back, hosted somewhere
persistent, reachable from any of them.

## Scope

**Synced:** dossiers (who calls with whom, how often, how long) and the resolved name
cache (id → username + avatar).

**Not synced:** session history, orbit log, traits, targets, hidden/ghosted lists,
collector data, plugin settings. These are either machine-local preferences or bulk event
logs whose merge semantics are a separate problem. They stay on each PC.

The dossier and the name cache are the expensive, hard-won data and the only parts whose
absence makes a second PC useless. Everything else can follow later if it earns its place.

## Architecture

Three pieces:

1. **`xicord-sync` service** — a small Node HTTP server on Railway with a mounted volume.
2. **Plugin sync client** — inside Xicord Dossier: pull on start, push deltas thereafter.
3. **Dashboard source switch** — the dashboard can read the pooled data instead of the
   local file.

### Service

No framework; Node's `http` is enough for three routes.

| Method | Path | Auth | Body | Purpose |
|---|---|---|---|---|
| `GET` | `/v1/health` | none | — | liveness; returns version and device count |
| `GET` | `/v1/pull` | bearer | — | the pooled view, all device slices merged |
| `POST` | `/v1/push` | bearer | partial snapshot | merge into the caller's device slice |

Auth is `Authorization: Bearer <token>`. Tokens are compared with a constant-time
comparison. An unknown or missing token gets a flat `401` with no detail. Request bodies
are capped at 32 MB; anything larger is rejected with `413` before being read into memory.

### Storage

A Railway volume mounted at `/data`:

```
/data/devices/<deviceId>.json    one slice per device
/data/tokens.json                token -> { name, deviceId }
```

`deviceId` is derived from the token, not sent by the client, so a device cannot write
into another's slice. Slices are written atomically (temp file then rename) because a
concurrent `GET /v1/pull` must never observe a half-written file.

Tokens are seeded from the `XICORD_TOKENS` environment variable on boot
(`token:name,token:name`) and written to `/data/tokens.json` if absent. The env var is the
source of truth; editing it and redeploying replaces the set. Revoking a device means
removing its token — its slice stays on disk but stops being written to, and can be
deleted by hand if you want its contribution gone.

### Why per-device slices

Storing each device's contribution separately, and merging only on read, buys three
things:

- **Idempotency.** Re-uploading the same data changes nothing.
- **Revocability.** Removing a device removes its influence, without unpicking merged
  numbers.
- **Correct maxima.** A device's slice is its own running total, which is exactly what the
  merge rule below expects.

## Merge rules

The dossier stores running tallies, not events. Two PCs that watched the same call each
hold `count: 1` for it; adding them gives 2, which is wrong. So:

| Field | Rule |
|---|---|
| `companions[x].count` | max |
| `companions[x].ms` | max |
| `companions[x].last` | max (most recent) |
| `guilds[g]` | max |
| `games[n].ms`, `.sessions` | max |
| `games[n].last` | max |
| `firstSeen` | **min** — earliest sighting wins |
| `updated` | max |
| name cache entry | the one with the newer `at` |

**Max is only correct because every client pulls before it pushes.** After a pull, a PC's
counters already include what every other PC contributed, so its number is the running
pooled total rather than one machine's partial view. Without the pull step, max would
silently discard whichever PC was used less. This coupling is the single most important
property of the design and must be preserved by any future change.

`firstSeen` is the one field that takes the minimum: the earliest time anyone saw that
person is the true first sighting. Zero means "unknown" and must not win the comparison.

## Plugin client

Lives in Xicord Dossier, which already owns the profile store and the name cache.

**Settings:** `syncUrl` (default empty — sync off), `syncToken`, `syncEnabled`.

**On start**, after the local store loads: `GET /v1/pull`, merge the response into local
data with the same rules, then persist. A failed pull is logged and retried on the next
cycle; it never blocks recording.

**Push cycle**, every 5 minutes: send only people whose `updated` is newer than the last
successful push. Typically a handful of records, a few KB. Because merging is additive and
idempotent, a partial upload is always safe.

**Full re-sync** on start and hourly: push everything, so a dropped or failed delta cannot
cause permanent drift.

**Failure policy:** all sync work is fire-and-forget with a retry on the next cycle. The
sync being unreachable, slow, or misconfigured must never disturb recording, the UI, or
the local snapshot. Push failures leave the delta watermark unmoved so the same records
are retried.

### Dashboard

A source toggle: local file (default) or the sync URL. Reading from sync requires the
token, which the dashboard takes from a field and keeps in `localStorage`. This is what
lets a second PC — or a phone — see the pooled picture without running the plugin.

## Testing

Mirrors the existing suites: extract the real functions, drive them with fakes, no
network.

**Service** (`xicord-sync/_sync.test.mjs`):
- merge maths per field, including the double-count trap (same call on two devices stays
  `count: 1`) and `firstSeen` taking the earliest, with zero not winning
- merging is idempotent and order-independent
- a device slice replaces itself, never another device's
- auth: no token, wrong token, and valid token; 401 body leaks nothing
- oversized body rejected with 413 without buffering
- atomic write: a pull during a push never sees partial JSON

**Plugin** (`src/userplugins/_dossierSync.test.mjs`):
- delta selection sends only changed records, and the watermark advances only on success
- a failed push retries the same records rather than skipping them
- pull merges into local without double-counting
- sync disabled, unreachable, or unauthorised leaves local recording untouched

## Risks

**Privacy.** This puts detailed records about real people — who they talk to, when, for
how long — on a third-party host with a publicly reachable URL. The tokens are the only
thing between that data and anyone who finds it. Keep the token list short, treat the URL
as sensitive, and prefer deleting a device slice over leaving a revoked one in place.

**Cost.** Railway usage pricing puts an idle service at roughly $1–5/month; the volume is
pennies. Delta uploads keep bandwidth negligible; a full re-sync is ~6 MB and happens
hourly at most.

**Growth.** Slices grow with the dataset. At the current 6.3 MB per device and a handful
of devices this is comfortable. If it ever approaches the volume size, the fix is pruning
old propagated profiles server-side, not a bigger volume.
