# Apple Music Recent-Release MVP

Date: 2026-08-03

## Authorization and boundary

The full-watchlist identity onboarding path is now implemented credential-free and awaiting its
separate Stage A checkpoint. It vendors the exact sanitized 593-artist artifact from the isolated
iTunes branch, verifies its approved hashes and classifications, and treats all supplied catalog
IDs as candidates until Apple returns the same ID with a compatible canonical name or alias.

The Stage A plan reuses 27 durable mappings and forecasts 293 validations in 12 multiple-artist
requests. Its hard limits are 40 starts, ten minutes, concurrency one, at least 1,100 milliseconds
between starts, no search, no pagination, and no release discovery. The remaining 272 ambiguous
artists are plan-only. Their existing catalog-evidence scoring thresholds are unchanged, and no
Stage B request is authorized by this checkpoint. The durable campaign and its one new migration
make the work restart-safe without changing the recent-release request behavior.

The narrow discovery scope for the five newly confirmed seed artists is complete. It accepted
only the tracked `apple-music-recent-seed-discovery-manifest.json`, fixed evaluation time,
`optimized_four_source`, and confirmation `APPLE_RECENT_SEED_DISCOVERY_5`. The manifest contains
names, frozen release counts, selection reason, snapshot hash, and evaluation time. It contains no
Apple catalog identifier.

The scope prevalidated all five durable mappings before creating the run or HTTP client and
persisted no mapping. It reused the existing optimized collection path for first-page `singles`,
`full-albums`, `top-songs`, and one bounded remix search per artist. A new run identity forced all
20 operations to refresh. There was no pagination or detail request. The run completed in 21,528
milliseconds with 19 HTTP 200 responses and one nonterminal SISTO `full-albums` HTTP 404. It had
zero retries, cache hits, mapping requests, or other-provider requests. Historical starts are now 222.

All eight frozen releases for these artists matched exactly. Combined 25-artist evidence is now
17 of 21 full-cohort exact recall and 17 of 20 mapped-artist exact recall. Primary recall is 12 of 13. The selected thresholds were met, but production integration and merge remain unauthorized.

The completed live form was:

```powershell
pnpm apple:recent -- --execute-live --confirm-live APPLE_RECENT_SEED_DISCOVERY_5 --seed-discovery-manifest apps/scanner/src/apple-music-recent-seed-discovery-manifest.json --snapshot <external-snapshot-path> --profile optimized_four_source --evaluation-as-of 2026-07-29T23:59:59Z
```

### Mapping bootstrap history

The mapping-only bootstrap execution path is implemented and its authorized 13-artist run is
complete. It reuses the existing catalog-evidence resolver for the exact two-candidate ambiguity
case and adds the same resolver to the one-time `apple:recent` cold-start path. Recurring scans
return an existing durable confirmed mapping before any search or evidence lookup.

Mapping precedence is: durable confirmed mapping, future manually confirmed evidence, approved
public-ID seed validated by an Apple artist lookup, unique exact normalized-name search result,
multiple exact-name candidates resolved by catalog evidence, then manual review. Seed values are
not confirmation. A seed must resolve to the same public ID and an exact canonical name or stored
alias. Ambiguous, weak, unavailable, and conflicting evidence cannot replace a durable confirmed
mapping.

The bootstrap live form is:

```powershell
pnpm apple:recent -- --execute-live --confirm-live APPLE_RECENT_MAPPING_BOOTSTRAP_13 --mapping-bootstrap --snapshot <external-snapshot-path> --identity-seeds apps/scanner/src/apple-music-identity-bootstrap.json
```

It is limited to the exact 13 artifact artists, five seed lookups, sixteen fixed-candidate Top
Songs first pages, 21 planned starts, a 25-start hard ceiling, 60 seconds, concurrency one, and a
1,100 millisecond pacing floor. Search, release discovery, pagination, retries, and other providers
are unreachable from the bootstrap client interface. Unresolved results retain only sanitized
candidate counts, scores, score gaps, overlap counts, conflict counts, classifications, and
manual-review reasons in reports.

The live run made exactly 21 starts, all HTTP 200, in 24,383 milliseconds. Five seeded IDs were
confirmed. No two-candidate case met the unchanged evidence threshold, leaving eight manual
reviews. There was no artist search, release discovery, pagination, retry, catalog persistence,
comparison persistence, or other-provider request. The lease was released and the provider
remains disabled. This raises safe mapping for the frozen 25-artist validation cohort from 12 to
17, which is not production-ready evidence.

This branch implements a separate, disabled-by-default Apple public-catalog experiment named
`apple:recent`. It does not change `apple:pilot`, the production scanner, scheduler, feed,
playlists, or provider enablement. Persistent `APPLE_MUSIC_ENABLED=false` is required.

The original exact live sample is NURKO, G-Space,
BUNT., SampliFire, Vibe Chemistry, BARELY ALIVE, Habstrakt, MUST DIE!, 1788-L, and 3LAU. The
ceiling is 100 HTTP starts, 15 minutes, concurrency one, and at least 1,100 milliseconds between
starts.

The separate 25-artist validation scope requires the tracked deterministic manifest, confirmation
`APPLE_RECENT_MVP_VALIDATION_25`, `optimized_four_source`, a 175-start ceiling, 20 minutes,
concurrency one, and the same pacing floor. Its conservative forecast is 100 fresh discovery
starts, up to 25 mapping starts, 10 targeted-detail starts, 25 bounded-retry starts, and 15 starts
of safety headroom. Plan mode performs no writes, credential access, token generation, or HTTP.

That validation and its credential-free normalization replay are complete. Twelve artists mapped
safely, 13 remained ambiguous, and the live run made 71 network starts. Corrected full-cohort
exact recall is 9 of 21 and mapped-artist exact recall is 9 of 12. Matcher misses are zero.
Mapping and recall do not support production integration. The result and mapping-only follow-up
are recorded in `docs/apple-music-recent-validation-25.md`.

## Catalog-evidence resolver call graph

`resolveAppleMusicArtistFromCatalogEvidence` accepts a canonical name and aliases, frozen release
and track evidence, and candidate artist catalogs containing normalized album and song evidence.
It returns the existing mapping decision and classifications. Exact release-title overlap scores
three points, exact track-title overlap contributes up to two points, and a same-title release-date
conflict beyond 30 days blocks confirmation. Confirmation requires a score of at least three, no
conflict, and a lead of at least two points over the runner-up.

Before this checkpoint, direct callers existed only in credential-free core tests. The original
exhaustive pilot and recent runner did not call it, and the bootstrap was plan-only. The shared
Top Songs adapter now derives parent-album evidence from each song while retaining track evidence,
then calls this resolver. The normal recent cold-start path does so only when exactly two exact
canonical-name or alias candidates remain. The bootstrap does so only for the two fixed artifact
candidates. No parallel scoring implementation was added.

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

## Candidate granularity and comparison

Album resources retain their release title as the comparison title. Song resources retain the
song title as the comparison title and the parent album title as separate context. Song candidates
may compare against a frozen single or remix release title or track title, but a parent album title
cannot establish a song match.

Cross-source deduplication preserves every source and uses compatible resource identity before a
fallback of normalized artist, comparison title, version markers, and release date. It does not
merge remix and original, live and studio, different named remixers, materially distinct content
ratings, or releases with different dates absent stronger identity. The existing schema already
stores album title and song title separately, so no migration is required.

Release-title comparison canonicalizes `Ft.`, `Ft`, `Feat.`, `Feat`, bracketed `feat.`, and
`Featuring` to one feature marker after Unicode normalization. The credited artist tokens remain
in the comparison. Remix, live, VIP, edit, clean, explicit, and named-remixer markers remain
available to the existing compatibility checks.

A terminal `EP` marker is removed only when the candidate or frozen release is explicitly typed as
an EP. Internal `EP` text and suffixes followed by deluxe, remix, live, anniversary, or edition
markers are retained. Original Apple titles remain stored separately from comparison titles.

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
pnpm apple:recent -- --plan --mapping-bootstrap --snapshot <external-snapshot-path> --identity-seeds apps/scanner/src/apple-music-identity-bootstrap.json
```

Plan mode validates the pinned snapshot and exact sample without credentials, private-key access,
token generation, HTTP initialization, database initialization, or writes. The current
conservative plan is 93 of 100 requests: 60 shallow discovery starts, up to 13 mapping starts, 10
targeted-detail starts, and 10 retry starts.

The optimized plan reports the 20 fresh requests authorized for this experiment, a five-request
temporary-5xx reserve, no mapping or detail requests, and the 25-request ceiling. A later normal
recurring run of all four sources would use 40 starts for ten confirmed artists before retries.

The mapping-bootstrap plan is credential-free and separate from release discovery. It validates
the artifact self-hash, frozen snapshot hash, exact canonical names, frozen-release counts, numeric
public candidate IDs, evidence sources, uniqueness, and the two-candidate maximum. It does not
open a database, read runtime credentials, initialize a token or HTTP client, or write state.
A public-ID seed remains unconfirmed until a separately authorized Apple artist lookup validates
the ID and compatible name. A later ambiguous or failed attempt cannot replace a prior durable
confirmed mapping.

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
A credential-free replay with explicit song granularity now gives 10 of 10 automated exact
matches, zero matcher misses, zero invalid directional matches, and four unconfirmed Apple-only
candidates. No historical request telemetry was rewritten.

The provisional representative-pilot strategy is therefore `optimized_four_source`. It costs
four first-page discovery requests per confirmed artist, or 2,372 starts for 593 mapped artists.
The minimum start-to-start pacing time is about 43.5 minutes before processing and retry
headroom. Production behavior and the default recent profile remain unchanged.
