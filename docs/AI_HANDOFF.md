# AI Handoff

Updated: 2026-07-30

## Repository state

The isolated `pnpm apple:recent` MVP and its `optimized_four_source` supplement are implemented
and live-tested on the original ten-artist sample. Song-level comparison is corrected
credential-free, and a deterministic 25-artist validation gate is prepared but not yet
live-executed. The exhaustive `apple:pilot`, existing default recent profile, and all production
behavior remain unchanged.

- Worktree: `C:\Users\taysh\Documents\Codex\codex_world_1_apple`
- Branch: `codex/apple-music-discovery`
- Optimization milestone starting checkpoint: `121c948459f3d166472f1aa44f67ba9596192a4b`
- Pre-live source checkpoint: `5089359cf5a3205af18b41d7366eb7037b326db9`
- Upstream: `origin/codex/apple-music-discovery`
- Latest live run: `completed/recent_optimized_sample_completed`
- Current historical Apple HTTP-start total: 110
- Provider state: disabled, no active run, lease, cooldown, or queue

The credential-free replay of the prior sanitized evidence produces 7 of 7 primary releases, 3 of
3 remixes, 10 of 10 combined and automated exact matches, zero matcher misses, zero invalid
directional matches, and four unconfirmed Apple-only candidates. The validation manifest contains
10 positive, 10 negative, and 5 identity/catalog-stress artists. Its no-pagination plan forecasts
160 of 175 starts with 15 starts of headroom and a 20-minute ceiling.

The exact sample remained NURKO, G-Space, BUNT., SampliFire, Vibe Chemistry, BARELY ALIVE,
Habstrakt, MUST DIE!, 1788-L, and 3LAU. All ten confirmed mappings were required before the
client and run were created. The experiment made only ten fresh `top-songs` requests and ten
fresh generic album-and-song searches widened from Apple's default five to the documented
maximum 25 results per type.

All 20 requests returned HTTP 200. There were zero mapping, detail, pagination, retry,
cache-hit, or other-provider requests. Concurrency was one, the minimum start interval was 1,108
milliseconds, and runtime was 21,678 milliseconds. Every Top Songs page returned ten resources
and a next cursor, which was not followed.

Top Songs recovered `LOL OK (Axel Boy Remix)` for MUST DIE! and correctly classified it
`remix_of_watched_artist_by_other`. The widened search did not recover it and added no newly
accepted in-window candidate compared with the earlier default-size search. It continued to
find the known NURKO remix. The stored comparison used the recovered song's parent album title
and therefore marked it Apple-only. This is one matcher miss after successful discovery, not a
catalog miss or invalid remix direction.

Combining frozen `singles` and `full-albums` evidence with fresh Top Songs and widened-search
evidence produced 7 of 7 primary recall, 3 of 3 remix recall, and 10 of 10 combined discovery
recall. There were zero false directional matches and zero directionally uncertain in-window
candidates. Four prior Apple-only candidates remain unconfirmed.

The provisional representative-pilot strategy is `singles`, `full-albums`, `top-songs`, and one
widened generic remix search, all first page only. It costs four requests per confirmed artist:
2,372 starts and about 43.5 minutes of minimum pacing time for 593 mapped artists. A
representative 25-artist live test is justified after a credential-free song-title matcher
correction, but it is not authorized by this handoff.

See [apple-music-recent-mvp-evaluation.md](apple-music-recent-mvp-evaluation.md) for the complete
sanitized result.

## Runtime isolation

- Compose project: `codex_world_1_apple`
- Compose file: `docker-compose.apple.yml`
- Web port: `3002`
- Development database: `radar_apple` on loopback port `55435`
- Test database: `radar_apple_test` on loopback port `55436`
- PostgreSQL application name: `release-radar-apple`
- Provider default: disabled

The Apple containers, network, volume, database names, ports, request gate, telemetry, cache,
mappings, and comparison rows are separate from Spotify and free-iTunes runtime state. The frozen
iTunes pilot snapshot is immutable input only.

## Implementation

- `AppleDeveloperTokenManager` generates ES256 developer tokens from an external P-256 key, caches
  them only in memory, and refreshes before expiration.
- `AppleMusicClient` permits only exact-host public catalog GET requests and implements artist
  search, single and maximum-25 artist lookup, six artist views, album lookup, paginated album
  tracks, and song batches.
- Every request-capable path is allowlisted. Relative and same-host absolute pagination is reduced
  to an allowed relative path. Pagination is terminal, duplicate-safe, and locally sorted.
- Descriptive Apple sharing URLs, non-followed relationship links, resource-reference links, and
  unknown URL-bearing fields are discarded and never become transport targets or cached data.
- Embedded relationship `href` and `next` fields are inert. Only explicit artist-view and
  album-track operations own pagination, with operation, route, storefront, resource identity,
  view, query-key, redirect, and duplicate-page enforcement.
- A response enters the cache only after schema validation, request-capable URL validation, and
  complete normalization succeed. Unsafe URL, schema, and normalization failures create no cache
  entry.
- The Apple-only database gate enforces concurrency one, at least 1,100 milliseconds between
  starts, request/runtime budgets, safe telemetry, normalized cache reuse, and persisted 429
  cooldowns.
- Mapping and comparison logic is deterministic, evidence-based, and supports the frozen
  50-artist evaluation model.
- `pnpm apple:pilot` provides a file-only plan mode and a separately double-confirmed future live
  mode. The production scanner still explicitly rejects the Apple provider. There is no production
  scheduler, feed mutation, UI, or playlist path.
- `--stop-after-canary` binds a live run to 75 requests and 15 minutes, records
  `canary_completed` only after success, and never creates the full-phase client.
- The tracked manifest pins the exact snapshot shape, 25 artists, three known public IDs, BUNT.
  authentication probe, and the deterministic five-artist canary.
- The live controller uses the existing request gate, cache, mapping, catalog, and comparison
  persistence. It adds a run-scoped lease without changing the schema, reuses canary work, batches
  only confirmed IDs, records sanitized terminal evidence, and releases the lease in a finally-safe
  path.

The focused command/controller suite has 33 passing injected tests. The Apple PostgreSQL file has
8 passing tests. The real plan command validated the frozen snapshot with credential variables
and database configuration removed, and all isolated Apple database counts remained zero.

The prior campaign-fixture leak did not reproduce in the latest pre-live attempt. One fresh
aggregate run had two Spotify rate-gate timeouts, its focused rerun passed 11 of 11, and the second
fresh aggregate run passed 90 of 90. No Spotify source or test correction was required.

Final command-checkpoint verification passed formatting, zero-warning lint, strict TypeScript, 409
unit tests, 92 aggregate integration tests against a fresh Apple test database, clean and upgrade
migration coverage, no-drift migration generation, production build, 23 mock-only Playwright
tests, and Apple doctor `READY`.

The canary-only checkpoint passed 410 unit tests, 33 focused pilot tests, 7 Apple database tests,
92 canonical aggregate integration tests, formatting, zero-warning lint, strict TypeScript, the
production build, and Apple doctor `READY` with 20 migrations.

The corrective checkpoint passed formatting, zero-warning lint, strict TypeScript, 417 unit
tests, 33 focused pilot-command tests, 8 focused Apple database tests, 93 canonical aggregate
integration tests on the isolated Apple test database, the production build, 23 mock-only
Playwright tests, migration drift checks, and Apple doctor `READY` with 20 migrations.

The embedded-pagination corrective checkpoint passed 425 unit tests, 80 focused Apple tests, 9
Apple PostgreSQL tests, 94 aggregate integration tests, formatting, zero-warning lint, strict
TypeScript, the production build, 23 mock-only Playwright tests, migration drift checks, and Apple
doctor `READY` with 20 migrations.

## Live authentication evidence

One separately authorized public-catalog artist lookup returned HTTP 200, showing that Apple
accepted the developer credential. Resource URL metadata then failed the existing safe-URL
validation before artist identity confirmation. The controller stopped `failed/unsafe_url` after
one request with zero retries. The canary and full phase did not start.

The run used the canary-only 75-request and 15-minute database limits. The lease was released,
there is no cooldown, and Apple remains persistently disabled. A single parsed-response cache row
created before normalization failed was removed after the audit. Sanitized request telemetry and
the terminal run record remain. No raw response remains.

The retained telemetry cannot recover the rejected value or exact field. The throwing code path
rules out artist `attributes.url`. The failure category was response navigation metadata handled
by `assertAllowedAppleMusicPath` and `assertAllowedAppleMusicUrl`, with
`data[].relationships.albums.href` the strongest exact-path match. Credential-free injected HTTP
tests now complete the same response shape successfully, discard descriptive and non-followed URL
metadata, and cache only after normalization. Unsafe pagination produces zero cache rows,
sanitized telemetry, a released lease, and no subsequent request.

A separately authorized retry then made one BUNT. artist lookup. HTTP 200 again confirmed
developer-token acceptance. The non-followed `href` correction worked, but normalization stopped
on the exact request-capable field `relationships.albums.next`. Sanitized telemetry classified it
as relative HTTPS pagination on the allowed Apple API host with an `outside_allowlist` rejection.
No URL value or response body was retained.

The retry ended `failed/unsafe_url` after one request and 201 ms. BUNT. identity comparison did not
run, and the five-artist canary did not start. Searches, direct views, followed pagination, album
details, tracks, retries, and cache hits were all zero. Cache ordering succeeded live with zero
cache, mapping, album, song, and comparison rows. The lease was released, no cooldown was created,
and the real Apple request-event total is two. No source change was made after the live request.

Credential-free reconstruction confirmed the runner never follows the embedded albums
relationship because it retrieves the six approved views explicitly. Artist normalization no
longer treats embedded `href` or `next` metadata as executable. Explicit artist-view and
album-track pagination is now bound to the owning operation, route family, storefront, resource
identity, and view. Synthetic HTTP 200 identity normalization and sanitized cache persistence
pass, while unsafe cursor substitution creates zero cache or result rows and releases the lease.
No live request occurred during this correction.

See `docs/apple-music-api-canary-evaluation.md`.

## Credential and provider boundaries

- Local credentials remain in the ignored runtime file.
- The private key remains outside every repository.
- Credential identifiers and secret material, including Team ID, Key ID, Media ID, developer
  tokens, authorization values, private-key paths, key contents, and signatures, must never appear
  in source control, logs, telemetry, reports, or terminal output.
- Public Apple catalog artist, album, and song IDs are non-secret operational values. They may
  exist in the tracked pilot manifest, isolated Apple database, process memory, and local plan
  output. They remain excluded from committed evaluation reports, long-retained application logs,
  and sanitized request telemetry unless represented by a deterministic hash or fixed
  placeholder.
- Public catalog IDs are not equivalent to credential identifiers, tokens, authorization values,
  or key material.
- No additional live Apple request is authorized by this checkpoint.
- No Spotify, iTunes, or other-provider request occurred.
- Music User Tokens, personal libraries, playback, playlists, Apple Music Feed, artwork and
  preview handling, production integration, and merge into `codex/release-radar-hardening` remain
  prohibited.

See `docs/apple-music-api-design.md`, `docs/apple-music-pilot-handoff.md`,
`docs/apple-music-pilot-authorization.md`, `docs/apple-music-runtime.md`, and
`docs/provider-capabilities.md`.

## Historical retry and probe record

The operation-scoped live retry started from
`12ec1a4910fea9557549b13c6a3c358720306284`. BUNT. returned HTTP 200, normalized successfully,
discarded embedded navigation before normalized caching, and was identity-confirmed. Neither
prior `unsafe_url` failure recurred.

The run mapped 1991 and Alok as ambiguous and NURKO as search-confirmed. NURKO's first explicit
`latest-release` view returned HTTP 400, so the runner stopped `failed/http_error` without a
source change. G-Space, BUNT.'s six-view catalog pass, and every remaining cohort artist were not
reached. The run made five starts: one artist lookup, three searches, and one artist-view request.
It recorded four HTTP 200 responses and one HTTP 400 response, no retries or pagination, a
1,109 ms minimum interval, concurrency one, and a 4,609 ms duration.

The lease is released, cooldown is inactive, Apple remains disabled, and four valid normalized
cache rows remain. They contain no embedded navigation, artwork, previews, authorization data,
token data, or evidence URLs. No album, song, or comparison result was persisted. No other
provider or production state was touched.

The credential-free artist-view contract audit found that the failed request had the correct
method, host, storefront, route, artist placement, and view spelling but appended `limit=100` and
`with=attributes`. Both keys are documented as optional, and Apple explicitly permits
`with=attributes`; the retained prior evidence cannot prove which optional parameter or value
caused HTTP 400. All six normal artist-view first pages now use the documented minimal request
with no query parameters.

The direct-view parser accepts the official top-level `data` collection and optional top-level
`next`. The one-page diagnostic parser retains only a cursor-presence boolean and cannot follow or
persist the cursor. Apple HTTP errors now retain bounded safe status, code, title category,
parameter name, pointer classification, detail presence, endpoint, view, and query-key evidence.
Occurrence IDs, raw titles and details, pointer values, paths, URLs, query values, identifiers,
headers, tokens, and bodies are discarded. HTTP 400 is not retried and creates no cache or result
row.

The exact NURKO `latest-release` probe mode reads the existing confirmed mapping, has a
one-request budget and zero retries, cannot search, cannot request BUNT. or another artist, and
cannot follow pagination. Future request identities are hashed and contain no request path or
catalog identifier. No schema change was required.

The next authorized action, only after a clean committed and pushed verification checkpoint, is
one NURKO `latest-release` request through this probe mode. The five-artist canary, complete
25-artist cohort, representative cohort, production integration, and merge remain unauthorized.

## Live artist-view probe result

The source and test checkpoint was committed and pushed before live execution. The diagnostic
then made exactly one Apple request using the existing confirmed NURKO mapping:

`GET /v1/catalog/us/artists/<artist_id>/view/latest-release`

It used no optional query parameters, retries, searches, other artists, or pagination. Apple
returned HTTP 200. The official direct-view response shape parsed successfully with one resource
in the top-level `data` collection and no top-level `next` cursor.

The real Apple request-event count increased from seven to eight. The run completed with
`view_probe_completed`; one sanitized normalized probe cache row was created, while no mapping,
album, song, or comparison row was created. The lease is released, no cooldown is active, the
queue is empty, and Apple remains persistently disabled.

The prior HTTP 400 request used the same documented route but added the optional `limit` and
`with` query keys. The new minimal first-page builder removed both. Because the earlier raw error
was intentionally discarded, retained evidence cannot prove which parameter or value Apple
rejected.

No other artist, provider, runtime database, or production state was contacted or modified. No
credential, identifier, raw response, complete URL, header value, query value, or raw error was
recorded. The next recommended milestone is a separately authorized decision about the bounded
five-artist canary. No further live request, complete cohort, representative cohort, production
integration, merge, or scheduler activation is authorized.

## Next milestone

Perform a credential-free design and test update for a bounded comparison of Arm B with and
without `latest-release`, plus a targeted first-page remix-discovery correction for the known
MUST DIE! miss. Any subsequent live comparison requires separate authorization and a clean,
committed, pushed pre-live checkpoint.

The representative 25-artist sample, other 583 watchlist artists, production integration,
scheduling, playlists, Music User Tokens, personal libraries, playback, Apple Music Feed, and
merge remain unauthorized.
