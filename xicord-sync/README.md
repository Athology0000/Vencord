# xicord-sync

Pooled dossier storage so several PCs share one dataset.

Each device pushes what it has observed into its **own slice**; a pull merges every slice
into one picture. Storing slices separately is what makes re-pushing idempotent and lets a
device be revoked without unpicking merged numbers.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/v1/health` | none | liveness; reports version and device count |
| `GET` | `/v1/pull` | bearer | the pooled view, all devices merged |
| `POST` | `/v1/push` | bearer | merge a (partial) snapshot into the caller's slice |

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `XICORD_TOKENS` | yes | `token:deviceName,token:deviceName`. Tokens under 16 chars are refused. Without this, every push and pull is rejected. |
| `DATA_DIR` | no | where slices live; default `/data`, the Railway volume mount |
| `PORT` | no | provided by Railway |
| `MAX_BODY_BYTES` | no | upload cap, default 32MB |

The device id is derived from the token, never sent by the client, so one device cannot
write into another's slice.

## Merge rule

Highest-wins per field; `firstSeen` takes the **earliest** (0 means unknown and never
wins); names prefer the more recently resolved.

**This is only correct because clients pull before they push.** After a pull, a PC's
counters already include what every other PC contributed, so the maximum is the pooled
running total rather than one machine's partial view. Remove the pull and the maximum
silently discards whichever PC was used least.

## Tests

    node _sync.test.mjs

Covers the merge maths (including the double-count trap), order-independence and
idempotency, auth rejection, payload sanitising, oversize refusal on both the declared and
chunked paths, and slice isolation between devices.
