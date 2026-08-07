# Xicord Sync v2 — shared pool + per-user private blobs

**Status:** design, supersedes the v1 storage model
**Date:** 2026-08-07
**Live v1:** https://xicord-sync-production.up.railway.app

## The split

Two kinds of data, and conflating them is what v1 got wrong.

**Objective** — true no matter who observed it. Person X exists, is in servers A and B, and
shared a voice channel with person Y for two hours, most recently on Tuesday. Any client
that saw it recorded the same fact. **Pools across everyone.**

**Account-relative** — only meaningful from one vantage point. "Mutual friends" comes from
`/users/{id}/relationships`, which returns people who are friends with *both you and them*;
run it from a different account and you get a different answer about the same person. Your
watchlist and your notes are yours in the same way. **Never pooled, never shared.**

This is not a preference. Pooling account-relative data would make the friend graph wrong
for everyone in it.

## Storage

```
/data/pool/<discordUserId>.json     one contributor's slice of the shared observations
/data/users/<discordUserId>.json    that user's private blob — never merged, never served
                                    to anyone else
/data/auth/sessions.json            OAuth sessions and issued device tokens
```

Pool slices stay per-contributor and merge on read, exactly as v1 does today. That is what
makes re-pushing idempotent and lets one contributor be removed without unpicking merged
numbers — the merge code and its tests carry over unchanged.

### Shared pool record

```jsonc
{
  "people": {
    "<userId>": { "guilds": ["<guildId>"], "first": 0, "last": 0 }
  },
  "calls": {
    "<idA>|<idB>": {          // ids sorted, so a pair has one key
      "ms": 0,                // time together
      "count": 0,             // times seen together
      "last": 0,              // most recent
      "guilds": ["<guildId>"] // where it happened
    }
  }
}
```

Merge rules are v1's: `ms`/`count`/`last` take the max, `first` takes the earliest, guild
lists union. Correct only because clients pull before they push — see the v1 spec.

### Private blob

```jsonc
{
  "friends":  { "<userId>": { "friends": ["<userId>"], "guilds": [], "at": 0 } },
  "watching": ["<userId>"],
  "notes":    { "<userId>": { "text": "", "at": 0 } },
  "devices":  [{ "id": "", "name": "", "boundAt": 0, "lastSeen": 0 }]
}
```

Served only to the authenticated owner. Never merged with anything.

## Authentication

Discord OAuth2, so identity is asserted by Discord rather than self-reported.

| Route | Purpose |
|---|---|
| `GET /auth/login` | redirect to Discord's consent screen (`identify` scope only) |
| `GET /auth/callback` | exchange the code, read the Discord user id, create a session |
| `POST /auth/bind` | session-authenticated; mints a device token and a short bind code |
| `POST /v1/bind` | the plugin exchanges a bind code for its long-lived device token |

`identify` is the only scope needed — the server wants the user id and nothing else. It
must not request `guilds`, `email`, or anything that widens what a compromise exposes.

**Binding a plugin:** sign in on the web, get a short code, paste it into the plugin. The
plugin exchanges it once for a device token tied to that Discord id. Codes are single-use
and expire in 10 minutes; tokens are revocable per device from the web page.

Every `/v1/*` route takes `Authorization: Bearer <deviceToken>`. The Discord id is derived
from the token server-side and never taken from the request body, so no client can write
into another user's blob.

## API

| Method | Path | Reads/writes |
|---|---|---|
| `GET` | `/v1/pool` | the merged shared pool |
| `POST` | `/v1/pool` | merge a delta into the caller's pool slice |
| `GET` | `/v1/me` | the caller's private blob |
| `POST` | `/v1/me` | merge a delta into the caller's private blob |
| `GET` | `/v1/health` | liveness, no auth |

Deltas both ways, as v1: push only what changed since the last successful sync, with a full
re-sync on start and hourly.

## Migration from v1

v1 slices are keyed by device token, not Discord id, and mix both kinds of data. On first
authenticated push from a device that has a v1 slice, split it: co-call records into that
user's pool slice, everything else into their private blob, then delete the v1 slice. One
pass, and the v1 routes stay up until every device has been through it.

## Decisions taken by default

**Any signed-in user can read the whole pool.** That follows from "this will have everyone",
and it is what makes the shared blob worth having. It also means each user's observations
about third parties are visible to every other user, so one compromised account exposes the
combined set rather than one person's slice. Narrowing it later is a filter on `GET /v1/pool`
and does not change the storage layout — worth revisiting before the user list grows beyond
people who would vouch for each other.

## Risks

**Scope.** This turns a personal tool into a multi-tenant service holding behavioural
records about a large number of people who are not its users. That is a different thing to
operate, and a different thing to be responsible for, than a local dossier — the failure
mode is no longer "I lose my data" but "someone else obtains everyone's".

**Secrets.** The Discord client secret and the session signing key are the keys to the whole
thing. They belong in Railway environment variables, never in the repo, and the client
secret cannot be recovered if leaked — only rotated.

**Blast radius.** One pool file per contributor bounds a bad push to that contributor.
Keep it that way; a single combined file would make a corrupt write everyone's problem.

## What I cannot do

Registering the Discord application is yours: <https://discord.com/developers/applications>
→ New Application → OAuth2. I need the **client id** and **client secret**, and the redirect
URI must be set to `https://xicord-sync-production.up.railway.app/auth/callback`. Put the
secret straight into Railway rather than pasting it in chat — anything pasted here is in the
transcript, as the earlier token was.
