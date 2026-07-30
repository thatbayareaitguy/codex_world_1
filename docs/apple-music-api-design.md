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

Response schemas retain only identity and comparison metadata. Artwork, preview properties, and
descriptive Apple sharing URLs are discarded. Unknown properties are ignored. API request targets,
top-level resource `href` values, followed view paths, relationship pagination, and `next` values
use the strict catalog allowlist. Non-followed relationship `href` values and reference `href`
values are discarded. An absolute `next` value is accepted only for HTTPS on the exact Apple API
host and is reduced to its allowed relative path before use or caching. Pagination continues to
terminal, rejects repeated pages, deduplicates resources, and sorts releases and tracks locally.

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
