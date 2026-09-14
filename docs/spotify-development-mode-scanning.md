# Spotify Development Mode Scanning

Verified: 2026-07-17

## Official Constraints

- Spotify calculates its general Web API limit over a rolling 30-second window. A 429 normally includes `Retry-After` in seconds. Spotify does not publish the Development Mode threshold: https://developer.spotify.com/documentation/web-api/concepts/rate-limits
- Development Mode requires the app owner to have Premium and is intended for small, single-account applications: https://developer.spotify.com/documentation/web-api/concepts/quota-modes
- `GET /artists/{id}/albums` has a maximum page size of 10. Its current documentation does not guarantee newest-first ordering: https://developer.spotify.com/documentation/web-api/reference/get-an-artists-albums
- The February 2026 Development Mode migration removes batch-fetch assumptions and reiterates conservative API use: https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide

## 2026-07-17 Incident Evidence

The YUSSI scan run started at `2026-07-17T18:30:31.476Z`. Its first catalog request was the artist-albums path, so the 429 endpoint is inferred as `GET /v1/artists/{artist-id}/albums?include_groups=album,single,appears_on,compilation&limit=10&offset=0`. The old telemetry stored a 47,260,000 ms wait but did not store the raw header, response body, endpoint event, or request ledger. Therefore:

- `47,260` cannot be verified as Spotify's raw `Retry-After` value.
- The old parser treated a numeric header as integer seconds and multiplied by 1,000. No second conversion, concatenation, overflow, or fallback that would independently manufacture `47,260` was found.
- The derived cooldown is `2026-07-18T07:38:31.454Z`, or `2026-07-18 00:38:31 PDT`.
- The response-body explanation and preceding request counts by endpoint and minute are unrecoverable.
- No safe evidence shows that another scanner, route, test, or retry timer continued requesting Spotify after the 429.

The current database preserves this incident as `legacy_unverified_derived_wait`, with a null raw header. New request events retain only safe endpoint categories, timestamps, status, raw `Retry-After`, parsed seconds, cooldown, queue wait, and redacted classifications.

## Request Gate

All scanner, server API, OAuth token, playlist, and explicit live-test Web API calls acquire the same database-backed client-ID gate. Separate processes may construct gate objects, but they contend on one PostgreSQL lease and state row. Defaults are:

```text
SPOTIFY_MAX_CONCURRENCY=1
SPOTIFY_MIN_REQUEST_INTERVAL_MS=10000
SPOTIFY_ARTISTS_PER_BATCH=15
SPOTIFY_BATCH_PAUSE_SECONDS=60
```

A 429 immediately ends the request path and persists a global cooldown. No probe requests occur during the cooldown. Restart and local cancellation do not remove it. Missing, malformed, or explicitly unsupported HTTP-date headers use a conservative 60-second local fallback. A valid integer is always seconds. Values above one year create an indefinite block for manual investigation rather than being ignored.

## Scan Modes And Pagination

- Initial staged: 60-day backfill, at most two artist-album pages per artist, 15 artists per persisted batch. The first batch is paused until explicitly confirmed.
- Daily incremental: at most one page per artist. Candidates are ranked by never completed, partial, then oldest completion and distributed over 24 hours.
- Deep reconciliation: explicit confirmed action, at most ten pages per artist, pausable and resumable.

Page limits are configuration boundaries, not completeness claims. Because Spotify does not document newest-first artist-album ordering, normal scans never stop solely after seeing an old release. Reaching a page limit records `partial`. Deep reconciliation is the explicit higher-volume path.

For an unchanged artist, a normal daily scan costs one artist-albums request. For a page containing ten new releases, the conservative estimate is eleven requests: one artist-albums request and one full-album request per new release. More requests are possible when an album's embedded tracks page is incomplete. Known release IDs skip full album and track reads. The scanner does not call Get Artist, Search, Get Track, the user profile, or playlist endpoints during release discovery.

The prior algorithm had unbounded artist-album pagination, fetched full album and album tracks for every selected release, then fetched every track individually with concurrency four. That fan-out, combined with attempting the full watchlist as one operation, was the request-burst defect.

## Live Validation Gate

Do not run YUSSI before the persisted cooldown expires. Then run one artist, one page, no MusicBrainz, no playlist sync, and no concurrency. Only after that succeeds should testing advance to 5 artists and then 15 artists. Any 429 stops staged validation. The remaining watchlist must not start automatically; the first full staged batch requires explicit confirmation.
