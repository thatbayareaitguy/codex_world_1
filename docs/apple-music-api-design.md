# Apple Music Catalog Provider Design

Date: 2026-07-30

## Recent-release MVP checkpoint

The isolated branch now also contains a separate `pnpm apple:recent` experimental command. It
does not alter the exhaustive `apple:pilot` workflow. The new command compares two shallow
primary-release arms and a bidirectional remix supplement on an exact 10-artist sample. Every
discovery first page is fresh per run, no pagination is followed, and persistent
`APPLE_MUSIC_ENABLED=false` remains mandatory.

See [apple-music-recent-mvp-design.md](apple-music-recent-mvp-design.md) for the window,
classification, cache, persistence, request-budget, and command contract. Production integration
and live access outside the separately bounded sample remain unauthorized.

## Scope and boundary

This branch contains a disabled-by-default Apple Music public catalog client for the isolated
pilot. It is not connected to the production scanner, feed, playlist code, web application, or
scheduler. The production scanner explicitly rejects `apple_music`.

The client permits only HTTPS requests to the exact host `api.music.apple.com` and allowlisted
`/v1/catalog/{storefront}/...` paths. It has no Music User Token, `/v1/me`, personal library,
playback, playlist, Apple Music Feed, artwork download, preview, browser automation, or scraping
support.

## Authentication

`AppleDeveloperTokenManager` reads an external private key only when a token is needed. It requires
an EC P-256 private key and generates an ES256 JWT containing only `iss`, `iat`, and `exp`, with the
Key ID in the JWT header. The default lifetime is one hour. The token is cached in memory and
regenerated before expiration.

The provider API accepts only a `getToken` function. Tokens, authorization headers, Team IDs, Key
IDs, Media IDs, key paths, and key contents are not part of persistence or telemetry interfaces.
The repository contains only synthetic placeholders.

## Catalog operations

The typed client supports:

- artist search;
- one artist by ID;
- multiple artists by ID, with duplicate removal and a hard maximum of 25;
- direct `latest-release`, `singles`, `full-albums`, `live-albums`,
  `compilation-albums`, and `appears-on-albums` views;
- embedded view parsing;
- one album by ID;
- complete album-track pagination;
- up to 25 songs by ID.

Response schemas retain only identity and comparison metadata. Artwork, preview properties, and
descriptive Apple sharing URLs are discarded. Unknown properties are ignored. Resource `href`
values and embedded relationship `href` and `next` values are inert metadata and are removed
unless the client is executing the collection that owns pagination. Search-result pagination is
also discarded because this pilot does not follow it.

Executable routes are classified by operation: artist search, one artist, artist batch, one of the
six approved artist views, album detail, album tracks, or song batch. Only artist-view and
album-track operations currently own pagination. Each cursor must retain the originating
storefront, route family, resource identity, and artist view where applicable. Query keys are
operation-specific, parameter order is canonicalized before duplicate detection, and HTTP
redirects are rejected. An absolute cursor is accepted only for HTTPS on the exact Apple API host
and is reduced to its allowed relative path before use or caching.

The grammar does not permit genres, playlists, stations, music videos, recommendations, charts,
library or user routes, arbitrary artist relationships, or unknown resource families. Pagination
continues to terminal, rejects repeated pages, deduplicates resources, and sorts releases and
tracks locally.

## Artist-view contract audit and diagnostic mode

The current official Apple endpoint is
`GET /v1/catalog/{storefront}/artists/{id}/view/{view}`. The six configured pilot names are valid:
`latest-release`, `singles`, `full-albums`, `live-albums`, `compilation-albums`, and
`appears-on-albums`. Apple documents `extend`, `include`, `l`, `limit`, and `with` as optional
query keys for the endpoint, and explicitly documents `with=attributes`. A successful direct
relationship-view response has a required top-level `data` collection and may have a top-level
`next` cursor.

The request that previously returned HTTP 400 used the correct GET method, API host, US
storefront, artist-ID path position, `/view/` segment, and `latest-release` spelling. It added
`limit=100` and `with=attributes`. It did not add `offset`, `include`, `extend`, or `l`; it had no
undocumented, empty, or duplicated query key, encoded path separator, or trailing component.
Because the prior error body was intentionally discarded, credential-free evidence cannot prove
which optional parameter or value Apple rejected. The endpoint documentation confirms
`with=attributes` is valid but does not establish that 100 is valid for this view's `limit`.

All normal artist-view first pages now use the minimal documented request with no optional query
parameters. Normal operation may still follow a validated top-level `next`. The diagnostic
first-page method records only whether `next` was present, stores no cursor, and cannot issue a
second request.

The command adds an exact NURKO `latest-release` view-probe mode with a one-request budget, zero
retries, no authentication lookup, no search, no other artist, and no pagination. It reads the
existing confirmed mapping from isolated Apple state and stops with zero requests if that mapping
is unavailable.

Official contract references:

- [Get a Catalog Artist's Relationship View Directly by Name](https://developer.apple.com/documentation/applemusicapi/fetch-a-view-on-this-resource-by-name-4kow5)
- [RelationshipViewResponse](https://developer.apple.com/documentation/applemusicapi/relationshipviewresponse)
- [Handling Requests and Responses](https://developer.apple.com/documentation/applemusicapi/handling-requests-and-responses)
- [Error](https://developer.apple.com/documentation/applemusicapi/error)

## Request safety and persistence

The Apple-specific database gate provides:

- one active request globally;
- a minimum 1,100 millisecond request-start interval;
- per-run request and runtime budgets;
- bounded retries for temporary 5xx responses;
- request timeout and bounded response size;
- safe HTTP classifications and `Retry-After` parsing;
- immediate persisted cooldown on HTTP 429, including an indefinite cooldown when no usable
  `Retry-After` is returned;
- sanitized request telemetry and cache-hit events;
- normalized, sanitized response cache reuse.

The response lifecycle is bounded body read, defensive JSON parse, schema validation, request and
pagination URL validation, complete normalization, removal of unnecessary metadata, and then
cache persistence. A parse, schema, URL-safety, or normalization failure records sanitized
terminal telemetry but creates no cache entry. URL diagnostics contain only a fixed field path,
role, relative or absolute form, scheme class, host class, and rejection reason. They never
contain the URL value, query, identifier, token, authorization header, or response body.

Apple tables are separate from Spotify and free-iTunes runtime state. The only iTunes-linked input
is the immutable frozen comparison snapshot. No authorization header, developer token, private
credential, artwork, preview URL, or raw full response is stored.

Non-success bodies receive the same bounded body read and are never persisted. When an Apple
`errors` array is valid, diagnostics retain only HTTP status, a bounded machine code, a fixed
title category, an allowlisted `source.parameter`, a fixed pointer classification, whether detail
was present, endpoint category, view name, and query-key names. Error occurrence IDs, raw titles,
raw details, pointer values, complete paths or URLs, query values, artist IDs, headers, and bodies
are discarded. Malformed or non-Apple error bodies receive a fixed body-format classification.
HTTP 400 is not retried and creates no successful cache entry.

Future Apple request and cache identities are deterministic hashes prefixed only with operation
and initial-or-pagination classification. They no longer persist a request path or catalog
identifier. Existing historical evidence is not rewritten.

## Pilot command and bounded controller

`pnpm apple:pilot` is the only repository-native Apple execution surface. It is not imported by
the production scanner or scheduler.

The tracked pilot manifest pins the sanitized snapshot hash and properties, the exact 25-artist
cohort, three known public artist IDs, BUNT. as the authentication probe, and the canary of 1991,
Alok, NURKO, G-Space, and BUNT. A machine-specific snapshot path is never tracked.

Plan mode is file-only. It validates the snapshot and manifest, builds human-readable and
machine-readable summaries, calculates conservative budgets, and creates no run, lease, request
event, cache row, mapping, album, song, comparison, token manager, private-key read, HTTP
transport, or database connection.

Future live execution requires two independent command confirmations and rejects any persistent
`APPLE_MUSIC_ENABLED` value other than `false`. Only after those checks does it create a
command-scoped authorization. The controller then:

1. validates the snapshot, cohort, US storefront, cooldown, lease, and conservative forecast;
2. imports the immutable snapshot into the isolated Apple database and creates a bounded run;
3. claims one run-scoped Apple lease;
4. validates BUNT. as the authentication request;
5. executes the five-artist canary within 75 requests and 15 minutes;
6. reuses canary mappings, views, and cache entries;
7. validates known IDs and uses evidence-safe searches for missing IDs;
8. batches only the confirmed subset, up to 25;
9. retrieves the six direct views with terminal, same-host pagination;
10. retrieves bounded album and track evidence only where appearance matching requires it;
11. persists normalized mappings, catalog evidence, comparisons, and sanitized metrics;
12. records an explicit terminal status and releases the lease in a finally-safe path.

The complete run remains bounded to 225 actual HTTP starts, 45 minutes, concurrency one, and a
minimum 1,100 millisecond request-start interval. Retries count against the request budget and
cache hits do not. No live execution occurred in the command-implementation milestone.

### Confirmed artist-view availability

For a safely confirmed artist, HTTP 404 from one of the six supported direct artist views is an
operation-specific availability result named `unavailable_404`. It is nonretryable, counts as one
request start, creates no successful cache row or fabricated empty response, and does not stop
later views or later artists. HTTP 200 with an empty `data` collection remains the distinct
`available_empty` result. Successful view resources already collected remain eligible for
evaluation, but an unavailable view marks coverage incomplete and suppresses catalog-miss
classification for that artist.

This exception does not apply to artist lookup, search, album detail, album tracks, unsupported
views, authentication failures, throttling, unsafe pagination, or other provider operations.

The forecast reports base first-page views, six known pagination requests observed for one prior
NURKO view, an unknown-pagination contingency using that worst-known measured behavior for each
remaining artist, and remaining headroom. It does not raise either immutable request ceiling.

## Mapping and comparison

Artist mapping supports `existing_id_confirmed`, `search_confirmed`, `evidence_confirmed`,
`ambiguous`, `no_match`, and `rejected`. An inherited numeric iTunes artist ID is not trusted until
the Apple catalog resolves it to a compatible identity. Search rank and genre never confirm a
mapping. Exact normalized names, stored aliases, release-title overlap, track-title overlap, and
release-date compatibility provide deterministic evidence.

The comparison layer reuses the frozen Spotify ground-truth evaluation logic without reusing
iTunes request or cache state. It can measure mapping rate, 7, 14, 30, and 60 day recall; singles,
EPs, albums, remixes, live releases, compilations, and appearances; batch versus direct-view
completeness; and request pacing.

## Corrective verification boundary

The prior live authentication lookup returned HTTP 200, establishing developer-token acceptance,
then stopped on `unsafe_url` before identity confirmation. The retained telemetry does not contain
the rejected value or exact field path. Code-path reconstruction proves that artist
`attributes.url` could not throw that classification. The failure category was request-like
response navigation metadata, with `data[].relationships.albums.href` the strongest exact-path
match. That relationship `href` was not followed and did not need request-target validation.

Credential-free synthetic HTTP 200 coverage now reproduces the response shape, completes artist
identity normalization, and writes one sanitized cache entry only after success. Unsafe
pagination produces `unsafe_url`, zero cache entries, sanitized telemetry, a released lease, and
no subsequent request. All implementation tests use generated synthetic EC keys, injected HTTP
responses, fake time, and the isolated Apple test database. This correction made zero live Apple
requests. The exact next milestone is a separately authorized authentication recheck and
five-artist canary retry.

The second authorized lookup also returned HTTP 200, then stopped on the exact embedded field
`relationships.albums.next`. The runner does not follow that embedded albums relationship because
it retrieves the six approved views explicitly. The execution-driven correction now discards the
embedded cursor without validating or persisting it. Credential-free tests prove identity remains
available, cache ordering succeeds, explicit view and album-track pagination still execute, and
cross-operation or cross-identity cursor substitution fails before transport. The real Apple
request count remained two during this correction.
