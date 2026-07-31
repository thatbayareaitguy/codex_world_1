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
- [Artists Top Songs view](https://developer.apple.com/documentation/applemusicapi/artists/views/artiststopsongsview?changes=la_6_5)
- [Relationship-view response](https://developer.apple.com/documentation/applemusicapi/relationshipviewresponse?changes=_2_4)
- [Catalog artist relationship](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-5akdm)
- [Apple Music catalog search](https://developer.apple.com/documentation/applemusicapi/search?changes=_3)

The `appears-on-albums` view is supplemental, not proof of complete history.

### Experimental optimized profile

The optional `optimized_four_source` profile leaves the existing Arm A, Arm B, and Arm C
implementation unchanged. Its recurring discovery shape is exactly four first-page operations
per confirmed artist:

1. `singles`
2. `full-albums`
3. `top-songs`
4. one catalog search for the canonical artist name plus `Remix`, requesting albums and songs
   together

It never calls `latest-release`, the generic artist albums relationship, or
`appears-on-albums`, and it never follows pagination. `top-songs` uses the minimal direct-view
route with no query parameters. A returned top-level `next` is reduced to a boolean observation
and is not followed. HTTP 200 empty and HTTP 404 unavailable remain distinct.

The bounded optimization experiment does not refetch the already measured `singles` or
`full-albums` pages. It verifies all ten persisted mappings before creating the run or HTTP
client, then makes one fresh run-scoped `top-songs` request and one fresh widened search for each
artist. The ceiling is 25 HTTP starts, five minutes, concurrency one, and at least 1,100
milliseconds between starts. The fixed comparison window remains 30 days ending
`2026-07-29T23:59:59Z`.

Apple documents `top-songs` as a supported direct artist view whose response contains song
resources ordered by popularity for the storefront. Apple documents a maximum catalog-search
limit of 25 results for each requested type. The earlier search request omitted `limit`, so it
used the documented default of five per type. The optimized request sets `limit=25` while
remaining one request per artist. Album and song search results remain separate collections.
Existing sanitized evidence shows the MUST DIE! target was absent from the prior returned
collections, rather than returned and rejected or incorrectly deduplicated.

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
pnpm apple:recent -- --plan --snapshot <external-snapshot-path> --sample --profile optimized_four_source
pnpm apple:recent -- --execute-live --confirm-live APPLE_RECENT_MVP_SAMPLE --snapshot <external-snapshot-path> --sample --evaluation-as-of 2026-07-29T23:59:59Z --profile optimized_four_source
```

Plan mode validates the pinned snapshot and exact sample without credentials, private-key access,
token generation, HTTP initialization, database initialization, or writes. The current
conservative plan is 93 of 100 requests: 60 shallow discovery starts, up to 13 mapping starts, 10
targeted-detail starts, and 10 retry starts.

The optimized plan reports the 20 fresh requests authorized for this experiment, a five-request
temporary-5xx reserve, no mapping or detail requests, and the 25-request ceiling. A later normal
recurring run of all four sources would use 40 starts for ten confirmed artists before retries.

## Optimization experiment result

The source checkpoint was committed and pushed at
`5089359cf5a3205af18b41d7366eb7037b326db9` before live execution. The exact ten-artist
supplement experiment then completed with 20 new HTTP starts: ten fresh `top-songs` requests and
ten fresh searches using `limit=25`. All returned HTTP 200. There were no cache hits, retries,
pagination requests, mapping requests, detail requests, or requests to another provider.

Every `top-songs` page contained ten resources and reported a next cursor, which was not
followed. Top Songs recovered the remaining known release, `LOL OK (Axel Boy Remix)` for
MUST DIE!, and the directional classifier correctly recorded
`remix_of_watched_artist_by_other`. The widened generic search did not return that release and
added no newly accepted in-window candidate compared with the earlier default-size search. It
continued to find the known NURKO remix.

Combining prior `singles` and `full-albums` evidence with fresh `top-songs` and widened search
evidence gives 7 of 7 primary releases, 3 of 3 remixes, and 10 of 10 combined discovery recall.
The stored comparison still labels the recovered MUST DIE! song as Apple-only because it compares
the parent album title instead of the song title. This is one matcher miss, not a discovery miss
or invalid remix direction, and must be corrected credential-free before a representative live
test.

The provisional representative-pilot strategy is therefore `optimized_four_source`. It costs
four first-page discovery requests per confirmed artist, or 2,372 starts for 593 mapped artists.
The minimum start-to-start pacing time is about 43.5 minutes before processing and retry
headroom. Production behavior and the default recent profile remain unchanged.
