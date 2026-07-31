# Apple Music Recent-Release MVP

Date: 2026-07-30

## Authorization and boundary

This branch implements a separate, disabled-by-default Apple public-catalog experiment named
`apple:recent`. It does not change `apple:pilot`, the production scanner, scheduler, feed,
playlists, or provider enablement. Persistent `APPLE_MUSIC_ENABLED=false` is required.

The exact live sample, if separately gated after credential-free verification, is NURKO, G-Space,
BUNT., SampliFire, Vibe Chemistry, BARELY ALIVE, Habstrakt, MUST DIE!, 1788-L, and 3LAU. The
ceiling is 100 HTTP starts, 15 minutes, concurrency one, and at least 1,100 milliseconds between
starts.

## Window

The first successful scan uses a maximum 30-day lookback. A later scan begins at the later of the
previous successful completion minus 48 hours and the current time minus 30 days. Failed and
partial runs do not advance the successful timestamp. Full dates are required, future releases
are excluded, and all comparisons use UTC.

The bounded comparison uses `2026-07-29T23:59:59Z`. Releases after that point do not affect the
frozen comparison.

## Discovery arms

- Arm A fetches one fresh `latest-release` page and one fresh artist `albums` relationship page.
- Arm B reuses Arm A's `latest-release` result and fetches one fresh `singles` page and one fresh
  `full-albums` page.
- Arm C fetches one fresh `appears-on-albums` page and performs one catalog search for the
  canonical artist name plus `Remix`, requesting album and song results together.

No arm follows pagination. Every discovery request has a run-scoped cache identity. This keeps
historical cache evidence intact, prevents an old row from satisfying a later scan, and permits
duplicate reuse only within the same run.

Apple documents the direct artist view, generic artist relationship, and catalog search
operations used here:

- [Catalog artist relationship view](https://developer.apple.com/documentation/applemusicapi/fetch-a-view-on-this-resource-by-name-4kow5)
- [Catalog artist relationship](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-5akdm)
- [Apple Music catalog search](https://developer.apple.com/documentation/applemusicapi/search)

The `appears-on-albums` view is supplemental, not proof of complete history.

## Candidate scope

Ordinary eligible releases are primary-artist singles, explicitly marked EPs, and albums.
Track count alone never establishes an EP. Compilations, live releases, feature-only releases,
future releases, incomplete dates, and unsupported resources are excluded.

Both explicit remix directions are eligible:

- `remix_by_watched_artist`
- `remix_of_watched_artist_by_other`

Direction requires a named Remix marker and watched-artist association evidence. Matching is
case-insensitive, Unicode-normalized, alias-aware, and exact at the artist-name level. Generic
`Remix` wording, search rank, genre, popularity, remix collections, and partial name collisions
cannot confirm direction.

NURKO's fixed 30-day ground truth contains two releases: one remix made by NURKO and one remix of
NURKO's work made by another named remixer. The two June releases remain outside the fixed
window. No catalog identifier is seeded from this evaluation rule.

## Persistence and safety

Recent runs reuse the existing bounded run, lease, request gate, cooldown, mapping, normalized
cache, and telemetry structures. One new table stores stable recent candidate identity,
first-seen and last-seen timestamps, watched artist, catalog album or song identity, titles,
release date, original Apple artist name, named remixer, classification, evidence strength,
source arms, candidate status, and comparison status.

Artwork, previews, sharing URLs, raw responses, authorization data, credentials, and complete
request URLs are not retained. HTTP 401, 403, and 429 stop the complete run. One artist-specific
HTTP 400, a supported endpoint HTTP 404, and one bounded 5xx failure remain local to that artist
or arm. Two HTTP 400 responses for the same endpoint shape stop the sample.

## Command

```powershell
pnpm apple:recent -- --plan --snapshot <external-snapshot-path> --sample
pnpm apple:recent -- --execute-live --confirm-live APPLE_RECENT_MVP_SAMPLE --snapshot <external-snapshot-path> --sample --evaluation-as-of 2026-07-29T23:59:59Z
```

Plan mode validates the pinned snapshot and exact sample without credentials, private-key access,
token generation, HTTP initialization, database initialization, or writes. The current
conservative plan is 93 of 100 requests: 60 shallow discovery starts, up to 13 mapping starts, 10
targeted-detail starts, and 10 retry starts.
