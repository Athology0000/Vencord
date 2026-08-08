# xicord-sync

Pooled dossier storage so several PCs share one dataset.

Each device pushes what it has observed into its **own slice**; a pull merges every slice
into one picture. Storing slices separately is what makes re-pushing idempotent and lets a
device be revoked without unpicking merged numbers.

Two kinds of data live here:

- **The shared pool** (`/v1/pool`) — facts that are true regardless of who saw them: a
  person exists, is in these guilds, shared this much voice time with someone. These pool
  across every contributor by taking the highest value, never by adding (two PCs that
  watched the same call each hold the whole of it; summing would double it).
- **The private blob** (`/v1/me`) — account-relative data (mutual friends, watchlists,
  notes) that is never merged across accounts, because asking two accounts about the same
  person yields two different true answers. The one exception is the friend *graph*, which
  is unioned into the shared pull so every contributor sees the complete picture.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/v1/health` | none | liveness; reports version and device count |
| `GET` | `/v1/pool` | bearer | the shared pool, all slices merged, plus the unioned friend graph |
| `GET` | `/v1/pool?since=<ms>` | bearer | **incremental**: only records whose own timestamp is newer than `<ms>` |
| `POST` | `/v1/pool` | bearer | merge a (partial) pool snapshot into the caller's slice |
| `GET` | `/v1/me` | bearer + user | the caller's private blob (friends, watching, notes) |
| `POST` | `/v1/me` | bearer + user | merge into the private blob; `{ "retracted": [ids] }` deletes friendships |
| `GET` | `/v1/pull` | bearer | v1 legacy pooled view, kept until every device migrates |
| `POST` | `/v1/push` | bearer | v1 legacy push |

The device id is derived from the token, never sent by the client, so one device cannot
write into another's slice. Routes marked "+ user" need a token bound to a Discord id
(the `token:name:discordId` form below); a token without one still works for the pool.

### Incremental pulls

A full `/v1/pool` is tens of MB and clients poll it, so pass the `syncedAt` from your last
pull back as `?since=`:

```
GET /v1/pool                 -> { people, calls, users, friends, syncedAt, counts, ... }
GET /v1/pool?since=<syncedAt> -> only what changed since then; same syncedAt-as-watermark contract
```

- **`syncedAt` is the watermark.** It is the server's clock at build time (minus 1ms to
  cover the strict-`>` boundary). Send it back verbatim as the next `since`; never
  substitute your own clock.
- **Deltas key on arrival, not on when the thing happened.** Every record carries `sat`,
  stamped by the server when it accepted the push, and that is what `since` is compared
  against. This matters: a call that ended at 12:00 but syncs at 12:07 (sync lag, or a
  device that was offline) would otherwise be filtered out by a 12:05 watermark on that
  pull *and every later one*, because its event time never becomes newer. `sat` and the
  watermark are two readings of one clock. A record with no `sat` (written before this
  field existed) is sent every time until someone pushes it again.
- **Any non-sane `since` degrades to a full pull** — NaN, negative, or a timestamp in the
  future all return everything with `since: 0`, so a skewed client clock can never cause a
  silent delta that skips records.
- **`friends` is always sent whole** and flagged `friendsComplete: true`, even in a delta.
  A retraction *removes* a name from the union rather than restamping it, so under a
  timestamp filter it would be indistinguishable from "unchanged" and would keep a
  withdrawn name alive forever. Sending the whole set lets a client delete what has vanished.
- `counts` reports both the delta sizes (`people`/`calls`/`users`) and the pool totals
  (`totalPeople`/`totalCalls`), so a delta still tells you how big the whole thing is.

### Retracting a friendship

Omission never means delete (a blob can be shared by several accounts, so no single push is
the complete set). To withdraw a friendship, name it explicitly:

```
POST /v1/me   { "retracted": ["444444444444444444"] }
```

The tombstone is **kept**, stamped with the server's clock, and stored as
`retracted: { id: whenRetracted }`. It has to outlive the push that created it: another
account on the same blob may not have observed the unfriending, and its next routine push
still carries that name with the old `at` it has always had. A retraction beats any claim
not strictly newer than it, so a stale re-assertion loses — while genuinely re-adding
someone later (a fresh `at`) still works.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `XICORD_TOKENS` | yes | `token:deviceName` or `token:deviceName:discordUserId`, comma-separated. Tokens under 16 chars are refused. Without this, every push and pull is rejected. |
| `XICORD_ALIASES` | no | `from=to,from=to`; maps several accounts (or an old blob name) onto one blob. See the header comment in `server.js`. |
| `DATA_DIR` | no | where slices live; default `/data`, the Railway volume mount |
| `PORT` | no | provided by Railway; default 8080 |
| `MAX_BODY_BYTES` | no | upload cap, default 32MB |
| `XICORD_SMALL_SLICE_BYTES` | no | a slice at or below this size is rewritten whole on push; above it, pushes are appended to a `.log`. Default 2MB. |
| `XICORD_MAX_LOG_BYTES` | no | when a slice's `.log` grows past this, it is folded back into the slice on the next cold read. Default 4MB. |
| `XICORD_POOL_TTL_MS` | no | how long a built view and serialised body may be served before a rebuild. A backstop, not the mechanism — writes are applied into the view as they land. Default 10 min. |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | no | enable the OAuth2 sign-in flow at `/login` |

### How a push is stored (and why)

The main contributor's slice *is* most of the pool. Reading it back, re-merging, and
rewriting it to absorb a few hundred pairs was hundreds of MB of live objects per push —
the container is capped at 1GB and was being OOM-killed. So:

- **Small slice** (≤ `XICORD_SMALL_SLICE_BYTES`): merged and rewritten in place. One file
  per contributor, always current.
- **Large slice**: the push is **appended** to `<slice>.json.log` — cost is the size of the
  push, not the slice. Durable before the response returns. Replaying the log over the
  slice gives exactly the same result because the merge is highest-wins (order-independent),
  which is the same property that lets a client push in batches.
- **Compaction**: on a cold read, if the log has passed `XICORD_MAX_LOG_BYTES`, it is folded
  back into the slice and deleted. This runs **under the owner's push lock** and re-reads
  inside it: compacting from a copy read outside the lock would delete every line appended
  while the slice was being written out — pushes already answered `200`, which no client
  has any reason to send again.

A push response reports `accepted` (what was in this push), `slice` (the caller's own slice
after the merge — `null` on the append path, where counting it would mean replaying the
whole slice per push), and `pool` (the pooled totals, `null` until something has pulled and
built the view).

The pooled view is cached as a finished string and each push is applied into it in place, so
a pull almost never pays a cold re-merge. A torn last log line (process died mid-append) is
skipped on replay; the client re-sends anything a failed sync did not bank.

## Tests

    node _regressions.test.mjs   # the ten defects the 2026-08-08 review confirmed
    node _sync.test.mjs          # v1 merge maths, auth, sanitising, oversize, isolation
    node _pool.test.mjs          # v2 pool merge + pull shape
    node _incremental.test.mjs   # ?since= deltas lose nothing across chained pulls
    node _poolcache.test.mjs     # cached view stays correct under concurrent push/pull
    node _pushlog.test.mjs       # append-log durability, replay, torn-line tolerance
    node _stream.test.mjs        # a pull concurrent with a write is still valid JSON
    node _friendPool.test.mjs    # friend-graph union + retraction
    node _aliasing.test.mjs _adopt.test.mjs   # account aliasing and blob rename/adoption

Run the lot:

    for f in _*.test.mjs; do node "$f"; done

## Merge rule

Highest-wins per field; `first` takes the **earliest** (0 means unknown and never wins);
names prefer the more recently resolved.

**This is only correct because clients pull before they push.** After a pull, a PC's
counters already include what every other PC contributed, so the maximum is the pooled
running total rather than one machine's partial view. Remove the pull and the maximum
silently discards whichever PC was used least.
