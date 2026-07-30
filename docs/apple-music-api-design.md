# Apple Music Catalog Provider Design

Date: 2026-07-29

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

Response schemas retain only identity and comparison metadata. Artwork and preview properties are
discarded. Unknown properties are ignored. Returned API `href` and `next` paths are validated
before use. Pagination continues to terminal, rejects repeated pages, deduplicates resources, and
sorts releases and tracks locally.

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

Apple tables are separate from Spotify and free-iTunes runtime state. The only iTunes-linked input
is the immutable frozen comparison snapshot. No authorization header, developer token, private
credential, artwork, preview URL, or raw full response is stored.

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

## Verification boundary

All implementation tests use generated synthetic EC keys, injected HTTP responses, fake time, and
the isolated Apple test database. This milestone makes zero live Apple requests. The exact next
milestone is a bounded 25-artist Apple Music live completeness test, which requires separate
authorization.
